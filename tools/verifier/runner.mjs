import crypto from 'node:crypto';
import {queueState, reconciledSlot, completedSlot} from './queue.mjs';
import {VERIFICATION_COLLECTION, verificationKey, legacyTimingFrames} from '../../workers/ranked/src/verification.js';

export function isConflict(error) {
  return ['ABORTED', 'FAILED_PRECONDITION', 'ALREADY_EXISTS'].includes(error.code) || [409, 412].includes(Number(error.status)) || /(?:^|\s)(409|412)(?:$|\s)/.test(String(error.message));
}

export async function selectJobs(db, docs, now = Date.now()) {
  const jobs = [];
  let canonicalAttempts = 0, selectionConflicts = 0;
  for (const doc of docs.slice(0, 2)) {
    const slots = {...doc.data.slots};
    const selected = [];
    let changed = false, attempts = 0;
    for (const slot of Object.values(slots)) {
      if (selected.length >= 8 || attempts >= 8 || canonicalAttempts >= 16) break;
      if (!['waiting', 'unavailable'].includes(slot.status) || Number(slot.retryAt || 0) > now) continue;
      attempts++; canonicalAttempts++;
      const canonical = await db.get('0.6.2_race_results', slot.resultId);
      const updated = reconciledSlot(slot, canonical?.data);
      if (updated !== slot) { slots[slot.accountId] = updated; changed = true; }
      if (!canonical || updated.reason === 'canonical_missing') continue;
      const frames = legacyTimingFrames(canonical.data);
      // This marker is generated here, never trusted from stored canonical fields.
      selected.push({...canonical.data, resultId: slot.resultId, queueKey: updated.key,
        timeMs: frames ?? canonical.data.timeMs,
        correctionCandidate: frames === null ? null : {frames, originalTimeMs: canonical.data.timeMs}});
    }
    if (changed || selected.length === 0) {
      try {
        await db.call(':commit', {writes: [db.write(VERIFICATION_COLLECTION, doc.data.trackId,
          {...doc.data, ...queueState(slots, now)}, doc)]});
      } catch (error) {
        if (!isConflict(error)) throw error;
        selectionConflicts++;
        continue;
      }
    }
    jobs.push(...selected);
  }
  return {jobs, canonicalAttempts, selectionConflicts};
}

export async function publishResults(db, jobs, results) {
  const totals = {verified: 0, mismatch: 0, unavailable: 0, superseded: 0, deferred: 0, corrected: 0, reasons: {}};
  for (const result of results) {
    const job = jobs.find(j => j.resultId === result.resultId);
    if (!job) throw Error('Verifier returned unknown job');
    for (let attempt = 0; attempt < 3; attempt++) {
      const queue = await db.get(VERIFICATION_COLLECTION, job.trackId);
      const current = await db.get('0.6.2_race_results', job.resultId);
      if (!queue || !current || verificationKey(current.data) !== job.queueKey ||
          queue.data.slots?.[job.accountId]?.key !== job.queueKey) {totals.superseded++; break;}
      const frames = legacyTimingFrames(current.data);
      const candidate = job.correctionCandidate;
      const candidateValid = candidate && frames !== null && candidate.frames === frames &&
        candidate.originalTimeMs === current.data.timeMs && job.timeMs === frames &&
        job.trackId === current.data.trackId && job.replayHash === current.data.replayHash &&
        job.resultId === String(current.data.accountId || current.data.userId) + '_' + current.data.trackId;
      if ((candidate && !candidateValid) || (frames !== null && result.status === 'verified' && !candidateValid)) {
        totals.superseded++; break;
      }
      const unconfirmed = Boolean(candidateValid && result.status === 'mismatch');
      const publication = unconfirmed ? {...result, status: 'unavailable', reason: 'legacy_time_unconfirmed'} : result;
      const correct = Boolean(candidateValid && result.status === 'verified');
      if (correct && (result.timeMs !== frames || result.trackId !== job.trackId || result.replayHash !== job.replayHash)) {
        totals.superseded++; break;
      }
      const corrected = correct ? {...current.data, timeMs: frames, timingVersion: 2} : null;
      const publishedKey = corrected ? verificationKey(corrected) : job.queueKey;
      const state = await db.get('0.6.2_s1_worker_jobs', 'canonical_reconcile_v2');
      const {nativeReason: previousNativeReason, ...priorSlot} = queue.data.slots[job.accountId];
      const slots = {...queue.data.slots, [job.accountId]: {...completedSlot(
        {...priorSlot, key: publishedKey}, publication),
        ...(unconfirmed ? {nativeReason: String(result.reason || '').slice(0, 100)} : {})}};
      const auditId = crypto.createHash('sha256').update(publishedKey).digest('hex');
      const audit = await db.get('0.6.2_s1_verification_audit', auditId);
      const writes = [
        db.write(VERIFICATION_COLLECTION, job.trackId, {...queue.data, ...queueState(slots)}, queue),
        db.write('0.6.2_s1_worker_jobs', 'canonical_reconcile_v2', {...state?.data,
          pendingTrackIds: [...new Set([...(state?.data?.pendingTrackIds || []), job.trackId])]}, state),
        db.write('0.6.2_s1_verification_audit', auditId, {resultId: job.resultId,
          accountId: job.accountId, trackId: job.trackId, key: publishedKey, ...slots[job.accountId],
          ...(correct ? {correctedFromKey: job.queueKey, correctedFromTimeMs: current.data.timeMs, correctedTimeMs: frames} : {})}, audit)
      ];
      if (correct) {
        // A field mask preserves every other field, including sub-millisecond Firestore timestamps.
        writes.push({...db.write('0.6.2_race_results', job.resultId, {timeMs: frames, timingVersion: 2}, current),
          updateMask: {fieldPaths: ['timeMs', 'timingVersion']}});
      }
      try {
        await db.call(':commit', {writes});
        totals[publication.status]++;
        const reason = String(publication.reason || '').slice(0, 100);
        totals.reasons[reason] = (totals.reasons[reason] || 0) + 1;
        if (correct) totals.corrected++;
        break;
      }
      catch (error) {
        if (!isConflict(error)) throw error;
        if (attempt === 2) totals.deferred++;
      }
    }
  }
  return totals;
}
