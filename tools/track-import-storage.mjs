// Only downloaded leaderboard copies are disposable. Never clear saved runs or tracks.
export const disposableLeaderboardKeys=Object.freeze([
 'polytrack-0.6.2-overall-snapshot-v3','polytrack-0.6.2-overall-snapshot-v4',
 'polytrack-0.6.2-track-snapshots-v3','polytrack-0.6.2-s1-track-snapshots-v4',
 'polytrack-0.6.2-s1-overall-snapshot-v5'
]);
const probeKey='polytrack-0.6.3-import-space-probe';
export function reserveTrackSpace(storage,codeLength,{onEvict=()=>{}}={}){
 if(!Number.isSafeInteger(codeLength)||codeLength<1||codeLength>524288)throw Error('Invalid track size.');
 const value=' '.repeat(codeLength+65536);
 const probe=()=>{try{storage.setItem(probeKey,value);storage.removeItem(probeKey);return true;}catch(error){
  try{storage.removeItem(probeKey);}catch{}
  if(error?.name!=='QuotaExceededError'&&error?.code!==22&&error?.code!==1014)throw error;
  return false;
 }};
 if(probe())return [];
 const removed=[];
 for(const key of disposableLeaderboardKeys){
  const raw=storage.getItem(key);if(raw===null)continue;
  storage.removeItem(key);removed.push(key);onEvict(key,raw);
  if(probe())return removed;
 }
 throw Error('Browser storage is full. Export your saved tracks and replays before freeing space, then try again. Nothing saved by you was deleted.');
}
