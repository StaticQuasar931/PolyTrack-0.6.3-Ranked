import {COMPETITIVE_REVIEW_REASON, isCompetitiveReviewHold, hasMatchingCompetitiveReviewHold, strongNearCloneEvidence} from '../../workers/ranked/src/competitive-review.js';
import {queueDocumentId} from '../../workers/ranked/src/verification-shards.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {similarityEvidence,verifiedControlProof} from './similarity.mjs';
import {reviewInboxWrite} from './review-inbox.mjs';
import {queueState, reconciledSlot, completedSlot} from './queue.mjs';
import {VERIFICATION_COLLECTION, EXTRA_VERIFICATION_COLLECTION, VERIFIER_ENGINE_DIGEST, VERIFIER_VERSION, verificationCollectionForTrack, verificationKey, legacyTimingFrames, hasAcceptedVerifiedProof} from '../../workers/ranked/src/verification.js';

export const QUEUE_CANDIDATE_LIMIT = 8;
export const TRACK_AGING_MS = 3600000;
const OVERALL_COLLECTION = '0.6.2_s1_leaderboards_overall';
const NORMAL_SELECTION_LIMIT = 16;
const PER_TRACK_SELECTION_LIMIT = 8;
const selectionQueuePreimages = new WeakMap();
let trackNames;

export function verifiedControlReference(slot, trackId) {
  const proof=slot?.controlProof;
  let key;
  try { key=JSON.parse(slot?.key); } catch { return null; }
  if(slot.status!=='verified'||slot.trackId!==trackId||slot.engineDigest!==VERIFIER_ENGINE_DIGEST||
    slot.verifierVersion!==VERIFIER_VERSION||!proof||proof.version!==1||proof.engineDigest!==VERIFIER_ENGINE_DIGEST||
    proof.verifierVersion!==VERIFIER_VERSION||proof.key!==slot.key||proof.accountId!==slot.accountId||
    proof.trackId!==trackId||!Number.isSafeInteger(proof.timeMs)||proof.timeMs<=0||
    !/^[a-f0-9]{64}$/.test(proof.replayHash||'')||!/^[a-f0-9]{64}$/.test(proof.signature||'')||
    !Number.isSafeInteger(proof.transitions)||proof.transitions<20||proof.informative!==true||
    !Array.isArray(key)||key.length!==8||key[0]!==VERIFIER_VERSION||key[1]!==VERIFIER_ENGINE_DIGEST||
    key[2]!==slot.accountId||key[3]!==trackId||key[4]!==proof.timeMs||key[7]!==proof.replayHash||
    slot.resultId!==`${slot.accountId}_${trackId}`) return null;
  return {accountId:proof.accountId,trackId,timeMs:proof.timeMs,replayHash:proof.replayHash,
    signature:proof.signature,transitions:proof.transitions,informative:true};
}

async function overallPriority(db, cache) {
  try {
    const key=OVERALL_COLLECTION+'/main';
    let pending;
    if(cache instanceof Map) {
      if(!cache.has(key)) cache.set(key,db.get(OVERALL_COLLECTION,'main').catch(()=>null));
      pending=cache.get(key);
    } else pending=db.get(OVERALL_COLLECTION,'main');
    const overall=await pending;
    return Array.isArray(overall?.data?.trackSummaries)?overall.data.trackSummaries:[];
  } catch { return []; }
}

export async function highestPriorityTrack(db, cache) {
  const rows=await overallPriority(db,cache);
  return rows.map(row=>({trackId:String(row?.trackId||''),weight:Number(row?.weight)}))
    .filter(row=>/^[A-Za-z0-9_-]{1,80}$/.test(row.trackId)&&Number.isFinite(row.weight)&&row.weight>=0)
    .sort((a,b)=>b.weight-a.weight||a.trackId.localeCompare(b.trackId))[0]?.trackId||null;
}

export function verifiedTrackCounts(byTrack = {}) {
  if (!trackNames) {
    trackNames = new Map();
    for (const file of ['../../tracks/catalog.json', '../../extra-tracks/catalog.json']) {
      try {
        const catalog = JSON.parse(fs.readFileSync(new URL(file, import.meta.url), 'utf8'));
        for (const track of Array.isArray(catalog)?catalog:catalog.tracks||[]) {
          if (track.id) trackNames.set(track.id, track.name);
          if (track.trackId) trackNames.set(track.trackId, track.name);
        }
      } catch { /* Geometry names remain available if a catalog cannot be read. */ }
    }
    try {
      const history=JSON.parse(fs.readFileSync(new URL('../../events/kodub/history.json',import.meta.url),'utf8'));
      for(const row of Array.isArray(history)?history:[])if(/^[a-f0-9]{64}$/.test(row?.trackId||'')&&typeof row.name==='string'&&row.name.trim()&&!trackNames.has(row.trackId))
        trackNames.set(row.trackId,row.name.replace(/[\r\n]/g,' ').trim().slice(0,120));
      const current=JSON.parse(fs.readFileSync(new URL('../../events/kodub/current.json',import.meta.url),'utf8')).current;
      if(/^[a-f0-9]{64}$/.test(current?.trackId||'')&&typeof current.name==='string'&&current.name.trim())
        trackNames.set(current.trackId,current.name.replace(/[\r\n]/g,' ').trim().slice(0,120));
    } catch { /* An unavailable feed cannot block verification. */ }
    try {
      const geometry = JSON.parse(fs.readFileSync(new URL('./track-geometry.json', import.meta.url), 'utf8'));
      for (const track of geometry.tracks || []) if (!trackNames.has(String(track.id))) trackNames.set(String(track.id), String(track.displayName || track.name || '').split('/').at(-1).replace(/\.track$/i, '')
        .replace(/([a-z])([0-9])/gi, '$1 $2').replace(/[-_]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase()));
    } catch { /* Unknown IDs fall back to their raw ID. */ }
  }
  return Object.entries(byTrack).filter(([, count]) => Number.isSafeInteger(count) && count > 0)
    .sort(([a], [b]) => (trackNames.get(a) || a).localeCompare(trackNames.get(b) || b) || a.localeCompare(b))
    .map(([trackId, count]) => ({trackId, trackName: trackNames.get(trackId) || trackId, count}));
}

export async function prioritizeQueueDocuments(db, docs, now = Date.now(), cache) {
  if (!Array.isArray(docs) || docs.length < 2) return Array.isArray(docs) ? docs : [];
  const trackIds = docs.map(doc => String(doc.data?.trackId || ''));
  if (trackIds.some(trackId => !/^[A-Za-z0-9_-]{1,80}$/.test(trackId))) return docs;
  const summaries=await overallPriority(db,cache);
  if (!summaries.length) return docs;
  const weights = new Map(), records = new Map();
  for (const row of summaries) {
    const trackId = String(row?.trackId || ''), weight = Number(row?.weight);
    if (/^[A-Za-z0-9_-]{1,80}$/.test(trackId) && Number.isFinite(weight) && weight >= 0) {weights.set(trackId, weight);records.set(trackId, Number(row.recordMs || row.leader?.timeMs));}
  }
  const decorated = docs.map((doc, index) => ({doc, index, trackId: trackIds[index],
    dueAt: Number(doc.data?.notBefore || 0), weight: weights.get(trackIds[index]) ?? 1}));
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

export function orderSelectedJobsFastestFirst(jobs) {
  const byTrack=new Map();
  for(const job of jobs){
    if(!byTrack.has(job.trackId))byTrack.set(job.trackId,[]);
    byTrack.get(job.trackId).push(job);
  }
  for(const rows of byTrack.values()) rows.sort((a,b)=>a.timeMs-b.timeMs);
  const positions=new Map();
  return jobs.map(job=>{
    const index=positions.get(job.trackId)||0;
    positions.set(job.trackId,index+1);
    return byTrack.get(job.trackId)[index];
  });
}

export function isConflict(error) {
  return ['ABORTED', 'FAILED_PRECONDITION', 'ALREADY_EXISTS'].includes(error.code) || [409, 412].includes(Number(error.status)) || /(?:^|\s)(409|412)(?:$|\s)/.test(String(error.message));
}

export async function selectJobs(db, docs, now = Date.now(), {jobLimit = NORMAL_SELECTION_LIMIT, lookupLimit = NORMAL_SELECTION_LIMIT, perTrackLimit = PER_TRACK_SELECTION_LIMIT} = {}) {
  let jobs = [];
  let canonicalAttempts = 0, selectionConflicts = 0;
  const contexts=docs.map((source,index)=>{const slots={...source.data.slots},due=dueSlots(slots,now),controlReferences=Object.values(slots).map(slot=>verifiedControlReference(slot,source.data.trackId)).filter(Boolean);return {doc:{...source,priorityFastestMs:Math.min(...due.map(schedulingTime))},index,slots,due,controlReferences,changed:false,attempts:0};});
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
    const timeMs=frames??canonical.data.timeMs;
    const verifiedControlReferences=context.controlReferences.filter(reference=>reference.accountId!==slot.accountId&&reference.timeMs===timeMs);
    jobs.push({...canonical.data,resultId:slot.resultId,queueKey:updated.key,queueCollection,queueId:queueDocumentId(doc),timeMs,verifiedControlReferences,
      previouslyAccepted:hasAcceptedVerifiedProof(canonical.data,updated),
      correctionCandidate:frames===null?null:{frames,originalTimeMs:canonical.data.timeMs}});
  }
  for(const context of contexts){
    if(!context.attempts&&context.due.length||!context.changed&&jobs.some(job=>job.trackId===context.doc.data.trackId))continue;
    const {doc}=context,queueCollection=doc.queueCollection||verificationCollectionForTrack(doc.data.trackId);
    try{await db.call(':commit',{writes:[db.write(queueCollection,queueDocumentId(doc),{...doc.data,...queueState(context.slots,now)},doc)]});}
    catch(error){if(!isConflict(error))throw error;selectionConflicts++;jobs=jobs.filter(job=>job.trackId!==doc.data.trackId);}
  }
  const selected=orderSelectedJobsFastestFirst(jobs);
  for(const job of selected){
    const context=contexts.find(candidate=>queueDocumentId(candidate.doc)===job.queueId&&candidate.doc.data.trackId===job.trackId&&
      (candidate.doc.queueCollection||verificationCollectionForTrack(candidate.doc.data.trackId))===job.queueCollection);
    if(!context?.changed&&typeof context?.doc.updateTime==='string'&&context.doc.updateTime){
      selectionQueuePreimages.set(job,context.doc);
    }
  }
  return {jobs:selected, canonicalAttempts, selectionConflicts};
}

export async function publishResults(db, jobs, results, {allowExtendedLocal = false} = {}) {
  for (const result of results) {
    const profile = result?.binding?.resourceProfile || 'standard';
    if (profile === 'extended-local') {
      const b = result.binding;
      if (!/^[a-f0-9]{64}$/.test(b?.verifierFingerprint || '') ||
          b.engineDigest !== VERIFIER_ENGINE_DIGEST || b.trackId !== result.trackId ||
          b.timeMs !== result.timeMs || b.replayHash !== result.replayHash ||
          b.actualReplayHash !== result.replayHash || result.deterministic !== true) {
        throw Error('Invalid extended verifier binding');
      }
    }
    if (!['standard', 'extended-local'].includes(profile) ||
        profile === 'extended-local' && allowExtendedLocal !== true) {
      throw Error('Verification resource profile is not authorized for publication');
    }
  }
  const totals = {verified: 0, verifiedByTrack: {}, mismatch: 0, unavailable: 0, superseded: 0, deferred: 0, corrected: 0, reviewFlagged:0, reviewInboxAdded:0, reasons: {}};
  const queueCache = new Map();
  const acquiredQueueKeys = new Set();
  let stateCacheLoaded = false, stateCache = null;
  for (const result of results) {
    const job = jobs.find(j => j.resultId === result.resultId);
    if (!job) throw Error('Verifier returned unknown job');
    const queueCollection = job.queueCollection || verificationCollectionForTrack(job.trackId);
    if (![VERIFICATION_COLLECTION, EXTRA_VERIFICATION_COLLECTION].includes(queueCollection)) throw Error('Invalid verification queue collection');
    const queueId = job.queueId || job.trackId;
    const queueCacheKey = queueCollection + '/' + queueId;
    const selectedPreimage=selectionQueuePreimages.get(job);
    selectionQueuePreimages.delete(job);
    const canUseSelectedPreimage=!acquiredQueueKeys.has(queueCacheKey)&&Boolean(selectedPreimage?.updateTime);
    acquiredQueueKeys.add(queueCacheKey);
    for (let attempt = 0; attempt < 3; attempt++) {
      let queue=queueCache.get(queueCacheKey);
      if(!queueCache.has(queueCacheKey)||result.status==='unavailable'){
        queue=result.status!=='unavailable'&&attempt===0&&canUseSelectedPreimage?selectedPreimage:await db.get(queueCollection,queueId);
        queueCache.set(queueCacheKey, queue);
      }
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
      const existingSlot=queue.data.slots[job.accountId];
      if(isCompetitiveReviewHold(result)&&!hasMatchingCompetitiveReviewHold(current.data,existingSlot)){
        const b=result.binding;
        if(!strongNearCloneEvidence(similarityEvidence(result))||result.trackId!==job.trackId||result.timeMs!==job.timeMs||
          result.replayHash!==job.replayHash||b?.resultId!==job.resultId||b.trackId!==job.trackId||b.nativeTrackId!==job.trackId||
          b.timeMs!==job.timeMs||b.replayHash!==job.replayHash||b.actualReplayHash!==job.replayHash||
          b.engineDigest!==VERIFIER_ENGINE_DIGEST||b.verifierVersion!==VERIFIER_VERSION)
          throw Error('Invalid competitive review hold binding');
      }
      // Receipt validity is independent of optional clone-comparison signatures.
      if(result.status==='unavailable'&&!isCompetitiveReviewHold(result)&&hasAcceptedVerifiedProof(current.data,existingSlot)&&
          existingSlot.accountId===job.accountId&&existingSlot.trackId===job.trackId&&existingSlot.resultId===job.resultId){
        totals.deferred++;
        totals.reasons.accepted_proof_preserved=(totals.reasons.accepted_proof_preserved||0)+1;
        break;
      }
      const unconfirmed = Boolean(candidateValid && result.status === 'mismatch');
      const priorHeld=hasMatchingCompetitiveReviewHold(current.data,existingSlot);
      const currentEvidence=similarityEvidence(result)||(priorHeld?existingSlot.reviewEvidence:null);
      const publication = priorHeld ? {...result,status:'unavailable',reason:COMPETITIVE_REVIEW_REASON} :
        unconfirmed ? {...result, status: 'unavailable', reason: 'legacy_time_unconfirmed'} : result;
      const correct = Boolean(candidateValid && publication.status === 'verified');
      if (correct && (result.timeMs !== frames || result.trackId !== job.trackId || result.replayHash !== job.replayHash)) {
        totals.superseded++; break;
      }
      const corrected = correct ? {...current.data, timeMs: frames, timingVersion: 2} : null;
      const publishedKey = corrected ? verificationKey(corrected) : job.queueKey;
      const state = stateCacheLoaded ? stateCache : await db.get('0.6.2_s1_worker_jobs', 'canonical_reconcile_v2');
      if (!stateCacheLoaded) { stateCache = state; stateCacheLoaded = true; }
      const {nativeReason: previousNativeReason,...priorSlot} = existingSlot;
      delete priorSlot.controlProof;
      const completed={...completedSlot({...priorSlot, key: publishedKey}, publication),
        resourceProfile: publication.binding?.resourceProfile || 'standard',
        ...(publication.binding?.verifierFingerprint ? {verifierFingerprint:publication.binding.verifierFingerprint} : {})};
      const nativeControlProof=verifiedControlProof(result);
      const controlProof=publication.status==='verified'&&result.status==='verified'&&nativeControlProof&&
        result.engineDigest===VERIFIER_ENGINE_DIGEST&&(result.verifierVersion||result.binding?.verifierVersion)===VERIFIER_VERSION&&
        result.trackId===job.trackId&&result.timeMs===job.timeMs&&result.replayHash===job.replayHash ? {
          ...nativeControlProof,accountId:job.accountId,trackId:job.trackId,timeMs:correct?frames:job.timeMs,
          replayHash:current.data.replayHash,key:publishedKey,engineDigest:result.engineDigest,verifierVersion:result.verifierVersion||result.binding?.verifierVersion,
        } : null;
      const slots = {...queue.data.slots, [job.accountId]: {...completed,
        ...(controlProof?{controlProof}:{}),
        ...(currentEvidence?{needsReview:true,reviewEvidence:currentEvidence}:{}),
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
      const previousAudit= audit?.data;
      const auditEvidence=currentEvidence || (previousAudit?.key===publishedKey&&previousAudit.resultId===job.resultId&&
        previousAudit.accountId===job.accountId&&previousAudit.trackId===job.trackId&&previousAudit.needsReview===true ? previousAudit.reviewEvidence : null);
      const reviewWrite = await reviewInboxWrite(db,auditId,job,publication,currentEvidence);
      const nextQueueData = {...queue.data, ...queueState(slots)};
      const nextStateData = {...state?.data, pendingTrackIds, pendingResultIds, pendingFullRebuildTrackIds, forceFullRebuildAll};
      const writes = [
        db.write(queueCollection, queueId, nextQueueData, queue),
        db.write('0.6.2_s1_worker_jobs', 'canonical_reconcile_v2', nextStateData, state),
        db.write('0.6.2_s1_verification_audit', auditId, {resultId: job.resultId,
          accountId: job.accountId, trackId: job.trackId, key: publishedKey, ...slots[job.accountId],
          ...(auditEvidence ? {needsReview:true, reviewEvidence:auditEvidence} : {}),
          ...(correct ? {correctedFromKey: job.queueKey, correctedFromTimeMs: current.data.timeMs, correctedTimeMs: frames} : {})}, audit)
      ];
      if (correct) {
        // A field mask preserves every other field, including sub-millisecond Firestore timestamps.
        writes.push({...db.write('0.6.2_race_results', job.resultId, {timeMs: frames, timingVersion: 2}, current),
          updateMask: {fieldPaths: ['timeMs', 'timingVersion']}});
      }
      if(reviewWrite) writes.push(reviewWrite);
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
        if (publication.status === 'verified') totals.verifiedByTrack[job.trackId] = (totals.verifiedByTrack[job.trackId] || 0) + 1;
        if(reviewWrite) totals.reviewInboxAdded++;
        if(similarityEvidence(result)) totals.reviewFlagged++;
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
