const HASH=/^[a-f0-9]{64}$/;
export function projectEventDates(source){
  return Object.fromEntries(['submittedAt','verifiedAt','runCreatedAt','pbAt','createdAt'].filter(k=>Number.isSafeInteger(source?.[k])&&source[k]>0).map(k=>[k,source[k]]));
}
// Replay dates may enrich only the exact saved public event binding.
export function enrichPublicEventDates(board,replays){
  if(!board||!Array.isArray(board.entries))throw Error('Invalid public event board');
  const periodId=board.id,trackId=board.period?.trackId||board.trackId;
  const entries=board.entries.map(entry=>{
    const replay=replays.find(r=>r?.periodId===periodId&&r.trackId===trackId&&r.accountId===entry.accountId&&
      HASH.test(r.runId||'')&&HASH.test(r.replayHash||'')&&r.timeMs===entry.timeMs&&r.frames===entry.timeMs&&
      (!entry.runId||r.runId===entry.runId)&&(!entry.replayHash||r.replayHash===entry.replayHash));
    if(!replay||replay.playbackPending===true||replay.verified===false||replay.verificationStatus==='pending'||entry.pending===true||entry.physicsVerified===false||entry.replayIntegrityVerified===false)return {...entry};
    const dates=projectEventDates(replay);
    return {...entry,...Object.fromEntries(Object.entries(dates).filter(([k])=>!Object.hasOwn(entry,k)))};
  });
  return {...board,entries};
}
