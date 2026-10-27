import {eventRecordingToNormal} from './event-recording-binding.mjs';
import {preparePublicRecordingForNativeDispatch} from './public-replay-playback.mjs';

// Reuse exact event inputs for normal boards, without a second database read.
// A board's normal eligibility remains authoritative; this never verifies a run.
export async function deriveEventRecordings(files){
  const existing=new Set(files.map(file=>file.logicalPath)),byBinding=new Map(),derived=[];
  const binding=row=>JSON.stringify([row.accountId,row.trackId,row.timeMs,row.frames,row.replayHash]);
  for(const {logicalPath,value} of files){
    const match=/^event-(replays|playbacks)\/([A-Za-z0-9_-]{1,64})\/([a-f0-9]{64})\.json$/.exec(logicalPath);
    if(!match||!value||value.periodId!==match[2]||(match[1]==='replays'?value.accountId:value.runId)!==match[3])continue;
    byBinding.set(binding(value),value);
  }
  for(const {logicalPath,value} of files){
    if(!/^tracks\/[a-f0-9]{64}\.json$/.test(logicalPath)||!Array.isArray(value?.entries))continue;
    for(const entry of value.entries){
      const target=`recordings/${entry?.uploadId}.json`;
      if(existing.has(target)||entry?.trackId!==value.trackId)continue;
      const payload=byBinding.get(binding(entry));if(!payload)continue;
      const recording=eventRecordingToNormal(payload,entry);if(!recording)continue;
      // Unknown metadata is not a new capture date. The static reader requires a numeric field.
      recording.updatedAt=Number.isFinite(entry.updatedAt)?entry.updatedAt:0;
      try{await preparePublicRecordingForNativeDispatch(recording,entry,{allowPending:true});}catch{continue;}
      derived.push({logicalPath:target,value:recording});existing.add(target);
    }
  }
  return derived;
}
