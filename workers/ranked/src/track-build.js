import {contentHash} from './paged-publication.js';
export const TRACK_BUILD_PAGE_SIZE = 100;
export const TRACK_BUILD_PAGES_PER_PASS = 2;
export const TRACK_BUILD_MAX_AGE_MS = 50 * 60000;
export const TRACK_BUILD_PARTS = '0.6.2_s1_track_build_parts';
export const TRACK_BUILD_JOBS = '0.6.2_s1_worker_jobs';
export const trackBuildId = trackId => `capacity_track_${trackId}`;

// Call before fetching the initial 501 rows. A new snapshot cannot fix insufficient
// throughput on the same published base, so expired work requires a base change.
export function trackBuildDisposition({prior, job, now = Date.now()}) {
  if (!Number.isSafeInteger(now) || now < 0) throw Error('TRACK_BUILD_CLOCK_INVALID');
  const state = job?.data;
  if (state?.complete !== false || state.baseVersion !== (prior?.updateTime || '')) return {action:'start'};
  if (state.blocked === true) return {action:'blocked', reason:state.blockedReason || 'snapshot_expired'};
  const time = Date.parse(state.readTime);
  if (!Number.isFinite(time) || time > now) return {action:'block', reason:'snapshot_time_invalid'};
  if (now - time >= TRACK_BUILD_MAX_AGE_MS) return {action:'block', reason:'snapshot_expired'};
  return {action:'resume'};
}

// Canonical data and proof reads share Firestore's fixed readTime. A checkpoint
// advances only after its normalized parts are durable; incomplete builds never score.
export async function advanceTrackBuild({trackId, prior, job, initial, readPage, normalize, read, readMany, commit,
  now = Date.now(), pagesPerPass = TRACK_BUILD_PAGES_PER_PASS}) {
  if (!Number.isSafeInteger(pagesPerPass) || pagesPerPass < 1 || pagesPerPass > TRACK_BUILD_PAGES_PER_PASS)
    throw Error('TRACK_BUILD_PAGE_BUDGET_INVALID');
  const baseVersion = prior?.updateTime || '';
  let state = job?.data ? {...job.data} : undefined;
  const disposition = trackBuildDisposition({prior, job, now});
  if (disposition.action === 'block' || disposition.action === 'blocked') {
    if (disposition.action === 'block') {
      state = {...state, blocked:true, blockedReason:disposition.reason, blockedAt:now, updatedAt:now};
      await commit([{collection:TRACK_BUILD_JOBS,id:trackBuildId(trackId),prior:job,data:state}]);
    }
    return {pending:true, blocked:true, reason:disposition.reason, changed:false,
      revision:prior?.data?.revision || 0, sourceReadTime:state.readTime};
  }
  const active = disposition.action === 'resume';
  if (!active) {
    if (!initial) return {restart:true};
    const time = Date.parse(initial.readTime);
    if (!initial.readTime || !Number.isFinite(time)) throw Error('TRACK_BUILD_SNAPSHOT_REQUIRED');
    if (time > now || now - time >= TRACK_BUILD_MAX_AGE_MS) throw Error('TRACK_BUILD_SNAPSHOT_EXPIRED');
    state = {trackId, generation:await contentHash([trackId,baseVersion,initial.readTime]), baseVersion,
      readTime:initial.readTime, afterName:'', parts:0, sourceCount:0, complete:false, startedAt:now};
  }
  let input = active ? null : initial;
  let ended = false, pages = 0;
  do {
    const page = input || await readPage(state.afterName, state.readTime, TRACK_BUILD_PAGE_SIZE);
    input = null;
    if (!Array.isArray(page.documents) || page.documents.length > (pages === 0 && !active ? 501 : TRACK_BUILD_PAGE_SIZE)) throw Error('TRACK_BUILD_PAGE_INVALID');
    const lastName = page.documents.at(-1)?.name;
    if (page.documents.length && (!lastName || lastName === state.afterName)) throw Error('TRACK_BUILD_CURSOR_INVALID');
    const rows = await normalize(page.documents.map(d => d.data), state.readTime);
    const writes = [];
    for (let offset = 0; offset < rows.length; offset += TRACK_BUILD_PAGE_SIZE) {
      writes.push({collection:TRACK_BUILD_PARTS,id:`${state.generation}_${state.parts + writes.length}`,
        data:{entries:rows.slice(offset,offset+TRACK_BUILD_PAGE_SIZE)},unconditional:true});
    }
    state = {...state, parts:state.parts + writes.length, afterName:lastName || state.afterName,
      sourceCount:state.sourceCount+page.documents.length, updatedAt:now};
    ended = page.documents.length < (pages === 0 && !active ? 501 : TRACK_BUILD_PAGE_SIZE);
    const committed = await commit([...writes,{collection:TRACK_BUILD_JOBS,id:trackBuildId(trackId),prior:job,data:state}]);
    const updateTime = committed?.writeResults?.at(-1)?.updateTime;
    job = updateTime ? {data:state,updateTime} : await read(TRACK_BUILD_JOBS,trackBuildId(trackId));
    pages++;
  // The 501-row initial normalization is already expensive. Only resumed passes
  // may process two 100-row pages; never add another page to the initial pass.
  } while (!ended && active && pages < pagesPerPass);
  if (!ended) return {pending:true,changed:false,revision:prior?.data?.revision||0,sourceReadTime:state.readTime};
  const entries = [];
  const ids = Array.from({length:state.parts}, (_, page) => `${state.generation}_${page}`);
  // The adapter returns a Map keyed by part id in one batchGet request. Preserve
  // part order ourselves; never turn a failed/missing batch into individual reads.
  const parts = readMany && ids.length ? await readMany(TRACK_BUILD_PARTS, ids) : null;
  if (readMany && ids.length && !(parts instanceof Map)) throw Error('TRACK_BUILD_PART_BATCH_INVALID');
  for (const id of ids) {
    const part = parts ? parts.get(id) : await read(TRACK_BUILD_PARTS,id);
    if (!Array.isArray(part?.data?.entries)) throw Error('TRACK_BUILD_PART_MISSING');
    entries.push(...part.data.entries);
  }
  return {entries,sourceReadTime:state.readTime,sourceCount:state.sourceCount,
    completionWrite:{collection:TRACK_BUILD_JOBS,id:trackBuildId(trackId),prior:job,data:{...state,complete:true,completedAt:now}}};
}
