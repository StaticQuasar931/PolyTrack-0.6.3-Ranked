import crypto from 'node:crypto';
import {queueState, reconciledSlot, completedSlot} from './queue.mjs';
import {VERIFICATION_COLLECTION, EXTRA_VERIFICATION_COLLECTION, verificationCollectionForTrack, verificationKey, legacyTimingFrames} from '../../workers/ranked/src/verification.js';

export const QUEUE_CANDIDATE_LIMIT = 8;
export const TRACK_AGING_MS = 3600000;
const OVERALL_COLLECTION = '0.6.2_s1_leaderboards_overall';
const NORMAL_SELECTION_LIMIT = 16;
const PER_TRACK_SELECTION_LIMIT = 8;

export async function prioritizeQueueDocuments(db, docs, now = Date.now(), cache) {
  if (!Array.isArray(docs) || docs.length < 2) return Array.isArray(docs) ? docs : [];
  const trackIds = docs.map(doc => String(doc.data?.trackId || ''));
  if (trackIds.some(trackId => !/^[A-Za-z0-9_-]{1,80}$/.test(trackId))) return docs;
  let overall;
  try {
    if (cache instanceof Map) {
      const key = OVERALL_COLLECTION + '/main';
      if (!cache.has(key)) cache.set(key, db.get(OVERALL_COLLECTION, 'main').catch(() => null));
      overall = await cache.get(key);
    } else overall = await db.get(OVERALL_COLLECTION, 'main');
  } catch { return docs; }
  if (!overall?.data || !Array.isArray(overall.data.trackSummaries)) return docs;
  const weights = new Map(), records = new Map();
  for (const row of overall.data.trackSummaries) {
    const trackId = String(row?.trackId || ''), weight = Number(row?.weight);
    if (/^[A-Za-z0-9_-]{1,80}$/.test(trackId) && Number.isFinite(weight) && weight >= 0) {weights.set(trackId, weight);records.set(trackId, Number(row.recordMs || row.leader?.timeMs));}
  }
  const decorated = docs.map((doc, index) => ({doc, index, trackId: trackIds[index],
    dueAt: Number(doc.data?.notBefore || 0), weight: weights.get(trackIds[index]) || 0}));
  decorated.sort((a, b) => b.weight - a.weight || a.dueAt - b.dueAt || a.trackId.localeCompare(b.trackId));
  const oldest = docs[0], oldestDueAt = Number(oldest.data?.notBefore || 0);
  if (Number.isFinite(oldestDueAt) && now - oldestDueAt >= TRACK_AGING_MS) {
    const index = decorated.findIndex(row => row.doc === oldest);
    if (index > 0) decorated.unshift(...decorated.splice(index, 1));
  }
  return decorated.map(row => ({...row.doc,priorityWeight:row.weight,priorityRecordMs:records.get(row.trackId)}));
}

function schedulingTime(slot) {
  try {
    const value = JSON.parse(String(slot?.key || ''))?.[4];
    return Number.isSafeInteger(value) && value > 0 ? value : Number.MAX_SAFE_INTEGER;
  } catch { return Number.MAX_SAFE_INTEGER; }
}

function dueSlots(slots, now) {
  return Object.values(slots).filter(slot => ['waiting', 'unavailable'].includes(slot.status) && Number(slot.retryAt || 0) <= now);
}
function queuedAt(slot, doc, now) {
  const at=Number(slot.queuedAt ?? doc.data.notBefore ?? slot.checkedAt ?? now);
  return Number.isFinite(at) ? at : now;
}
// A scheduling estimate, never awarded RP: track weight multiplied by relative pace.
// Existing summary metadata is reused; no per-candidate leaderboard reads are needed.
function impact(slot, doc) {
  const time=schedulingTime(slot), reference=Number(doc.priorityRecordMs);
  const target=Number.isFinite(reference)&&reference>0 ? reference : doc.priorityFastestMs;
  const weight=Number.isFinite(doc.priorityWeight)?doc.priorityWeight:1;
  return weight*Math.min(2,target/time)**2;
}

export function isConflict(error) {
  return ['ABORTED', 'FAILED_PRECONDITION', 'ALREADY_EXISTS'].includes(error.code) || [409, 412].includes(Number(error.status)) || /(?:^|\s)(409|412)(?:$|\s)/.test(String(error.message));
}

export async function selectJobs(db, docs, now = Date.now(), {jobLimit = NORMAL_SELECTION_LIMIT, lookupLimit = NORMAL_SELECTION_LIMIT, perTrackLimit = PER_TRACK_SELECTION_LIMIT} = {}) {
  let jobs = [];
  let canonicalAttempts = 0, selectionConflicts = 0;
  const contexts=docs.map((source,index)=>{const slots={...source.data.slots},due=dueSlots(slots,now);return {doc:{...source,priorityFastestMs:Math.min(...due.map(schedulingTime))},index,slots,due,changed:false,attempts:0};});
  const candidates=contexts.flatMap(context=>context.due.map(slot=>({context,slot,age:queuedAt(slot,context.doc,now),score:impact(slot,context.doc)})));
  const priority=[...candidates].sort((a,b)=>b.score-a.score||schedulingTime(a.slot)-schedulingTime(b.slot)||a.age-b.age||a.context.index-b.context.index||String(a.slot.accountId).localeCompare(String(b.slot.accountId)));
  const overdue=candidates.filter(c=>now-c.age>=TRACK_AGING_MS).sort((a,b)=>a.age-b.age||b.score-a.score);
  // One quarter for overdue work, with one slot even in the small Extra reservation.
  const capacity=Math.min(jobLimit,lookupLimit);
  const reserved=overdue.slice(0,capacity>0?Math.max(1,Math.floor(capacity/4)):0);
  const reservedSet=new Set(reserved),ordered=[...reserved,...priority.filter(c=>!reservedSet.has(c))];
  for(const {context,slot} of ordered){
    if(jobs.length>=jobLimit||canonicalAttempts>=lookupLimit)break;
    if(context.attempts>=perTrackLimit)continue;
    const {doc}=context,queueCollection=doc.queueCollection||verificationCollectionForTrack(doc.data.trackId);
    if(![VERIFICATION_COLLECTION,EXTRA_VERIFICATION_COLLECTION].includes(queueCollection))throw Error('Invalid verification queue collection');
    context.attempts++;canonicalAttempts++;
    const canonical=await db.get('0.6.2_race_results',slot.resultId),updated=reconciledSlot(slot,canonical?.data);
    if(updated!==slot){context.slots[slot.accountId]=updated;context.changed=true;}
    if(!canonical||updated.reason==='canonical_missing')continue;
    const frames=legacyTimingFrames(canonical.data);
    jobs.push({...canonical.data,resultId:slot.resultId,queueKey:updated.key,queueCollection,timeMs:frames??canonical.data.timeMs,
      correctionCandidate:frames===null?null:{frames,originalTimeMs:canonical.data.timeMs}});
  }
  for(const context of contexts){
    if(!context.attempts&&context.due.length||!context.changed&&jobs.some(job=>job.trackId===context.doc.data.trackId))continue;
    const {doc}=context,queueCollection=doc.queueCollection||verificationCollectionForTrack(doc.data.trackId);
    try{await db.call(':commit',{writes:[db.write(queueCollection,doc.data.trackId,{...doc.data,...queueState(context.slots,now)},doc)]});}
    catch(error){if(!isConflict(error))throw error;selectionConflicts++;jobs=jobs.filter(job=>job.trackId!==doc.data.trackId);}
  }
  return {jobs, canonicalAttempts, selectionConflicts};
}

export async function publishResults(db, jobs, results) {
  const totals = {verified: 0, mismatch: 0, unavailable: 0, superseded: 0, deferred: 0, corrected: 0, reasons: {}};
  const queueCache = new Map();
  let stateCacheLoaded = false, stateCache = null;
  for (const result of results) {
    const job = jobs.find(j => j.resultId === result.resultId);
    if (!job) throw Error('Verifier returned unknown job');
    const queueCollection = job.queueCollection || verificationCollectionForTrack(job.trackId);
    if (![VERIFICATION_COLLECTION, EXTRA_VERIFICATION_COLLECTION].includes(queueCollection)) throw Error('Invalid verification queue collection');
    const queueCacheKey = queueCollection + '/' + job.trackId;
    for (let attempt = 0; attempt < 3; attempt++) {
      const queue = queueCache.has(queueCacheKey) ? queueCache.get(queueCacheKey) : await db.get(queueCollection, job.trackId);
      if (!queueCache.has(queueCacheKey)) queueCache.set(queueCacheKey, queue);
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
      const state = stateCacheLoaded ? stateCache : await db.get('0.6.2_s1_worker_jobs', 'canonical_reconcile_v2');
      if (!stateCacheLoaded) { stateCache = state; stateCacheLoaded = true; }
      const {nativeReason: previousNativeReason, ...priorSlot} = queue.data.slots[job.accountId];
      const slots = {...queue.data.slots, [job.accountId]: {...completedSlot(
        {...priorSlot, key: publishedKey}, publication),
        ...(unconfirmed ? {nativeReason: String(result.reason || '').slice(0, 100)} : {})}};
      let pendingResultIds = Object.fromEntries(Object.entries(state?.data?.pendingResultIds || {})
        .filter(([trackId, ids]) => /^[A-Za-z0-9_-]{1,80}$/.test(trackId) && Array.isArray(ids) && ids.length)
        .map(([trackId, ids]) => [trackId, [...new Set(ids.filter(id => typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,128}_[A-Za-z0-9_-]{1,80}$/.test(id)))]]));
      let pendingTrackIds = [...new Set([...(state?.data?.pendingTrackIds || []), job.trackId])];
      let pendingFullRebuildTrackIds = [...new Set((state?.data?.pendingFullRebuildTrackIds || [])
        .filter(trackId => typeof trackId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(trackId)))];
      let forceFullRebuildAll = state?.data?.forceFullRebuildAll === true;
      let pendingCount = Object.values(pendingResultIds).reduce((count, ids) => count + ids.length, 0);
      if (pendingCount > 200) {
        pendingTrackIds = [...new Set([...pendingTrackIds, ...Object.keys(pendingResultIds)])];
        pendingFullRebuildTrackIds = [...new Set([...pendingFullRebuildTrackIds, ...Object.keys(pendingResultIds)])];
        pendingResultIds = {};
        pendingCount = 0;
      }
      if (forceFullRebuildAll || pendingFullRebuildTrackIds.includes(job.trackId)) {
        delete pendingResultIds[job.trackId];
      } else if (pendingCount < 200) {
        const ids = pendingResultIds[job.trackId] || [];
        if (!ids.includes(job.resultId)) ids.push(job.resultId);
        pendingResultIds[job.trackId] = ids;
      } else {
        // Keep this track queued, but force the worker down its bounded full-rebuild fallback.
        delete pendingResultIds[job.trackId];
        pendingFullRebuildTrackIds.push(job.trackId);
      }
      pendingTrackIds = [...new Set([...pendingTrackIds, ...pendingFullRebuildTrackIds])];
      if (pendingFullRebuildTrackIds.length > 200) {
        forceFullRebuildAll = true;
        pendingFullRebuildTrackIds = [];
        pendingResultIds = {};
      }
      const auditId = crypto.createHash('sha256').update(publishedKey).digest('hex');
      const audit = await db.get('0.6.2_s1_verification_audit', auditId);
      const nextQueueData = {...queue.data, ...queueState(slots)};
      const nextStateData = {...state?.data, pendingTrackIds, pendingResultIds, pendingFullRebuildTrackIds, forceFullRebuildAll};
      const writes = [
        db.write(queueCollection, job.trackId, nextQueueData, queue),
        db.write('0.6.2_s1_worker_jobs', 'canonical_reconcile_v2', nextStateData, state),
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
        const committed = await db.call(':commit', {writes});
        const queueUpdateTime = committed?.writeResults?.[0]?.updateTime;
        const stateUpdateTime = committed?.writeResults?.[1]?.updateTime;
        if (typeof queueUpdateTime === 'string' && queueUpdateTime) {
          queueCache.set(queueCacheKey, {...queue, data: nextQueueData, updateTime: queueUpdateTime});
        } else queueCache.delete(queueCacheKey);
        if (typeof stateUpdateTime === 'string' && stateUpdateTime) {
          stateCache = {...state, data: nextStateData, updateTime: stateUpdateTime};
          stateCacheLoaded = true;
        } else {
          stateCache = null;
          stateCacheLoaded = false;
        }
        totals[publication.status]++;
        const reason = String(publication.reason || '').slice(0, 100);
        totals.reasons[reason] = (totals.reasons[reason] || 0) + 1;
        if (correct) totals.corrected++;
        break;
      }
      catch (error) {
        if (!isConflict(error)) throw error;
        // A competing writer may have changed either document; refresh both
        // before retrying rather than trusting an invocation-local snapshot.
        queueCache.delete(queueCacheKey);
        stateCache = null;
        stateCacheLoaded = false;
        if (attempt === 2) totals.deferred++;
      }
    }
  }
  return totals;
}
