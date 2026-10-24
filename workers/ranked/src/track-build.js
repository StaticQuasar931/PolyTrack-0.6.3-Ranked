import {contentHash} from './paged-publication.js';
export const TRACK_BUILD_PAGE_SIZE = 100;
export const TRACK_BUILD_PAGES_PER_PASS = 1;
export const TRACK_BUILD_PARTS = '0.6.2_s1_track_build_parts';
export const TRACK_BUILD_JOBS = '0.6.2_s1_worker_jobs';
export const trackBuildId = trackId => `capacity_track_${trackId}`;

// Canonical data and proof reads share Firestore's fixed readTime. A checkpoint
// advances only after its normalized parts are durable; incomplete builds never score.
export async function advanceTrackBuild({trackId, prior, job, initial, readPage, normalize, read, commit, now = Date.now()}) {
  const baseVersion = prior?.updateTime || '';
  let state = job?.data;
  const active = state?.complete === false && state.baseVersion === baseVersion &&
    Number.isFinite(Date.parse(state.readTime)) && now - Date.parse(state.readTime) < 50 * 60000;
  if (!active) {
    if (!initial) return {restart:true};
    if (!initial.readTime || !Number.isFinite(Date.parse(initial.readTime))) throw Error('TRACK_BUILD_SNAPSHOT_REQUIRED');
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
      writes.push({collection:TRACK_BUILD_PARTS,id:`${state.generation}_${state.parts++}`,
        data:{entries:rows.slice(offset,offset+TRACK_BUILD_PAGE_SIZE)},unconditional:true});
    }
    state = {...state, afterName:lastName || state.afterName,
      sourceCount:state.sourceCount+page.documents.length, updatedAt:now};
    ended = page.documents.length < (pages === 0 && !active ? 501 : TRACK_BUILD_PAGE_SIZE);
    const committed = await commit([...writes,{collection:TRACK_BUILD_JOBS,id:trackBuildId(trackId),prior:job,data:state}]);
    const updateTime = committed?.writeResults?.at(-1)?.updateTime;
    job = updateTime ? {data:state,updateTime} : await read(TRACK_BUILD_JOBS,trackBuildId(trackId));
    pages++;
  } while (!ended && pages < TRACK_BUILD_PAGES_PER_PASS);
  if (!ended) return {pending:true,changed:false,revision:prior?.data?.revision||0,sourceReadTime:state.readTime};
  const entries = [];
  for (let page = 0; page < state.parts; page++) {
    const part = await read(TRACK_BUILD_PARTS,`${state.generation}_${page}`);
    if (!Array.isArray(part?.data?.entries)) throw Error('TRACK_BUILD_PART_MISSING');
    entries.push(...part.data.entries);
  }
  return {entries,sourceReadTime:state.readTime,sourceCount:state.sourceCount,
    completionWrite:{collection:TRACK_BUILD_JOBS,id:trackBuildId(trackId),prior:job,data:{...state,complete:true,completedAt:now}}};
}
