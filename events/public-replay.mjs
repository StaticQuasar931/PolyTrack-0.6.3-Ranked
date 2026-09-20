import {prepareOwnEventGhost} from './native-replay.mjs';
// Published event PB payloads are bound to the selected snapshot before native parsing.
export async function preparePublishedEventGhost({require,row,period,entry,viewer}){
  if(typeof row?.runId!=='string'||!row.runId.length||row.runId.length>128||row.frames!==row.timeMs||row?.periodId!==period.id||row.trackId!==period.trackId||row.accountId!==entry.accountId||row.timeMs!==entry.timeMs||typeof row.replay!=='string'||row.replay.length>65536||!/^[a-f0-9]{64}$/.test(row.replayHash||''))throw Error('Event replay changed. Refresh standings.');
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(row.replay));
  const hash=Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
  if(hash!==row.replayHash)throw Error('Event replay integrity check failed.');
  const input={...row,frames:row.timeMs,attemptId:row.runId,source:'local-event-recording'};
  const ghost=prepareOwnEventGhost({require,row:input,session:{periodId:period.id,trackId:period.trackId,accountId:entry.accountId},best:{attemptId:row.runId,timeMs:row.timeMs}});
  return Object.freeze({...ghost,nickname:entry.name||'Event racer',isSelf:entry.accountId===viewer});
}
