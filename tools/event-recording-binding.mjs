import {hasPlayablePublicReplayStatus} from './public-replay-playback.mjs';

const HASH=/^[a-f0-9]{64}$/;
export function normalEventRecordingState(entry){
  if(!entry||!hasPlayablePublicReplayStatus(entry)||!HASH.test(entry.accountId||'')||!HASH.test(entry.trackId||'')||
    !HASH.test(entry.replayHash||'')||!Number.isSafeInteger(entry.uploadId)||entry.uploadId<1||
    !Number.isSafeInteger(entry.timeMs)||entry.timeMs<1||!Number.isSafeInteger(entry.frames)||entry.frames<1||entry.frames>4000000||
    entry.raceTimeFrames!==undefined&&entry.raceTimeFrames!==entry.frames)return null;
  if(entry.runVerified===true&&entry.integrityVerified===true)return 1;
  return entry.runVerified===false&&entry.verified===false&&entry.integrityVerified===true&&entry.verifiedState===0?0:null;
}

export function eventRecordingCandidateMatches(record,entry){
  return normalEventRecordingState(entry)!==null&&!!record&&record.accountId===entry.accountId&&
    record.timeMs===entry.timeMs&&record.replayHash===entry.replayHash&&
    (record.trackId===undefined||record.trackId===entry.trackId)&&(record.frames===undefined||record.frames===entry.frames);
}

// Binding conversion only. The consumer must still hash, parse and authorize playback.
// Event verification/status fields never become normal-recording authority.
export function eventRecordingToNormal(payload,entry){
  const verifiedState=normalEventRecordingState(entry);
  if(verifiedState===null||!eventRecordingCandidateMatches(payload,entry)||payload.trackId!==entry.trackId||
    payload.frames!==entry.frames||!/^[A-Za-z0-9_-]{1,64}$/.test(payload.periodId||'')||!HASH.test(payload.runId||'')||
    typeof payload.replay!=='string'||!payload.replay.length||payload.replay.length>65536||
    typeof payload.carStyle!=='string'||payload.carStyle.length>256)return null;
  return {accountId:entry.accountId,trackId:entry.trackId,uploadId:entry.uploadId,timeMs:entry.timeMs,
    frames:entry.frames,replayHash:entry.replayHash,recording:payload.replay,carStyle:payload.carStyle,verifiedState};
}
