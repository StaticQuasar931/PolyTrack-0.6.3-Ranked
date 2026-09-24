import crypto from 'node:crypto';
import {queueState, reconciledSlot, completedSlot} from './queue.mjs';
import {VERIFICATION_COLLECTION, EXTRA_VERIFICATION_COLLECTION, verificationCollectionForTrack, verificationKey, legacyTimingFrames} from '../../workers/ranked/src/verification.js';

export const QUEUE_CANDIDATE_LIMIT = 8;
export const TRACK_AGING_MS = 3600000;
const OVERALL_COLLECTION = '0.6.2_s1_leaderboards_overall';
const NORMAL_SELECTION_LIMIT = 16;
const PER_TRACK_SELECTION_LIMIT = 8;

export async function prioritizeQueueDocuments(db, docs, now = Date.now()) {
  if (!Array.isArray(docs) || docs.length < 2) return Array.isArray(docs) ? docs : [];
  const trackIds = docs.map(doc => String(doc.data?.trackId || ''));
  if (trackIds.some(trackId => !/^[A-Za-z0-9_-]{1,80}$/.test(trackId))) return docs;
  let overall;
  try { overall = await db.get(OVERALL_COLLECTION, 'main'); }
  catch { return docs; }
  if (!overall?.data || !Array.isArray(overall.data.trackSummaries)) return docs;
  const weights = new Map();
  for (const row of overall.data.trackSummaries) {
    const trackId = String(row?.trackId || ''), weight = Number(row?.weight);
    if (/^[A-Za-z0-9_-]{1,80}$/.test(trackId) && Number.isFinite(weight) && weight >= 0) weights.set(trackId, weight);
  }
  const decorated = docs.map((doc, index) => ({doc, index, trackId: trackIds[index],
    dueAt: Number(doc.data?.notBefore || 0), weight: weights.get(trackIds[index]) || 0}));
  decorated.sort((a, b) => b.weight - a.weight || a.dueAt - b.dueAt || a.trackId.localeCompare(b.trackId));
  const oldest = docs[0], oldestDueAt = Number(oldest.data?.notBefore || 0);
  if (Number.isFinite(oldestDueAt) && now - oldestDueAt >= TRACK_AGING_MS) {
    const index = decorated.findIndex(row => row.doc === oldest);
    if (index > 0) decorated.unshift(...decorated.splice(index, 1));
  }
  return decorated.map(row => row.doc);
}

function schedulingTime(slot) {
  try {
    const value = JSON.parse(String(slot?.key || ''))?.[4];
    return Number.isSafeInteger(value) && value > 0 ? value : Number.MAX_SAFE_INTEGER;
  } catch { return Number.MAX_SAFE_INTEGER; }
}

function dueSlots(slots, now) {
  const due = Object.values(slots).filter(slot => ['waiting', 'unavailable'].includes(slot.status) &&
    Number(slot.retryAt || 0) <= now);
  const fastest = [...due].sort((a, b) => schedulingTime(a) - schedulingTime(b) ||
    String(a.accountId).localeCompare(String(b.accountId)));
  const oldest = [...due].sort((a, b) => Number(a.checkedAt || 0) - Number(b.checkedAt || 0) ||
    String(a.accountId).localeCompare(String(b.accountId)))[0];
  return oldest ? [oldest, ...fastest.filter(slot => slot !== oldest)] : fastest;
}

export function isConflict(error) {
  return ['ABORTED', 'FAILED_PRECONDITION', 'ALREADY_EXISTS'].includes(error.code) || [409, 412].includes(Number(error.status)) || /(?:^|\s)(409|412)(?:$|\s)/.test(String(error.message));
}

export async function selectJobs(db, docs, now = Date.now(), {jobLimit = NORMAL_SELECTION_LIMIT, lookupLimit = NORMAL_SELECTION_LIMIT, perTrackLimit = PER_TRACK_SELECTION_LIMIT} = {}) {
  const jobs = [];
  let canonicalAttempts = 0, selectionConflicts = 0;
  for (const doc of docs) {
    if (jobs.length >= jobLimit || canonicalAttempts >= lookupLimit) break;
    const queueCollection = doc.queueCollection || verificationCollectionForTrack(doc.data.trackId);
    if (![VERIFICATION_COLLECTION, EXTRA_VERIFICATION_COLLECTION].includes(queueCollection)) throw Error('Invalid verification queue collection');
    const slots = {...doc.data.slots};
    const selected = [];
    let changed = false, attempts = 0;
    for (const slot of dueSlots(slots, now)) {
      if (selected.length >= perTrackLimit || attempts >= perTrackLimit ||
          canonicalAttempts >= lookupLimit || jobs.length + selected.length >= jobLimit) break;
      attempts++; canonicalAttempts++;
      const canonical = await db.get('0.6.2_race_results', slot.resultId);
      const updated = reconciledSlot(slot, canonical?.data);
      if (updated !== slot) { slots[slot.accountId] = updated; changed = true; }
      if (!canonical || updated.reason === 'canonical_missing') continue;
      const frames = legacyTimingFrames(canonical.data);
      // This marker is generated here, never trusted from stored canonical fields.
      selected.push({...canonical.data, resultId: slot.resultId, queueKey: updated.key, queueCollection,
        timeMs: frames ?? canonical.data.timeMs,
        correctionCandidate: frames === null ? null : {frames, originalTimeMs: canonical.data.timeMs}});
    }
    if (changed || selected.length === 0) {
      try {
        await db.call(':commit', {writes: [db.write(queueCollection, doc.data.trackId,
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
    const queueCollection = job.queueCollection || verificationCollectionForTrack(job.trackId);
    if (![VERIFICATION_COLLECTION, EXTRA_VERIFICATION_COLLECTION].includes(queueCollection)) throw Error('Invalid verification queue collection');
    for (let attempt = 0; attempt < 3; attempt++) {
      const queue = await db.get(queueCollection, job.trackId);
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
        db.write(queueCollection, job.trackId, {...queue.data, ...queueState(slots)}, queue),
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
