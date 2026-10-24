// Playback limits mirror tools/verifier/replay.cjs; parsing is not verification.
export const EVENT_REPLAY_LIMITS=Object.freeze({replayCharacters:65536,compressedBytes:49152,inflatedBytes:30015,transitionsPerChannel:4096,transitions:10000,frames:300000,scanWork:30000000});
export function prepareOwnEventGhost({require,row,session,best}){
  const fail=()=>{throw Error('Local event replay is invalid or outside playback limits');};
  if(!row||!session||!best||row.source!=='local-event-recording'||row.accountId!==session.accountId||row.periodId!==session.periodId||row.trackId!==session.trackId||row.attemptId!==best.attemptId||row.timeMs!==best.timeMs||row.frames!==row.timeMs)fail();
  if(!/^[a-f0-9]{64}$/.test(row.accountId)||!/^[a-f0-9]{64}$/.test(row.trackId)||!Number.isSafeInteger(row.frames)||row.frames<1||row.frames>EVENT_REPLAY_LIMITS.frames||typeof row.replay!=='string'||!row.replay.length||row.replay.length>EVENT_REPLAY_LIMITS.replayCharacters||!/^[A-Za-z0-9_-]+$/.test(row.replay)||typeof row.carStyle!=='string'||row.carStyle.length>256)fail();
  const base64=require(6551),compressed=base64.D(row.replay);
  if(!compressed||compressed.length>EVENT_REPLAY_LIMITS.compressedBytes||base64.l(compressed)!==row.replay)fail();
  const inflater=new (require(3075).Ay.Inflate)({chunkSize:16384});
  let length=0;const chunks=[];
  inflater.onData=chunk=>{length+=chunk.length;if(length>EVENT_REPLAY_LIMITS.inflatedBytes)fail();chunks.push(chunk);};
  inflater.push(compressed,true);
  if(inflater.err||!inflater.ended||inflater.strm.next_in!==compressed.length)fail();
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  let cursor=0,total=0,work=row.frames*5;const lists={};
  const number=()=>{if(cursor+3>bytes.length)fail();const n=bytes[cursor]|bytes[cursor+1]<<8|bytes[cursor+2]<<16;cursor+=3;return n;};
  for(const name of ['up','right','down','left','reset']){
    const count=number();total+=count;if(count>EVENT_REPLAY_LIMITS.transitionsPerChannel||total>EVENT_REPLAY_LIMITS.transitions||cursor+count*3>bytes.length)fail();
    const frames=[];let frame=0;
    for(let index=0;index<count;index++){const delta=number();if(index&&delta===0)fail();frame+=delta;if(frame>row.frames)fail();work+=Math.max(0,row.frames-(index?frames[index-1]+1:0));if(work>EVENT_REPLAY_LIMITS.scanWork)fail();frames.push(frame);}
    lists[name]=frames;
  }
  if(cursor!==bytes.length)fail();
  const Style=require(8724).A,styleBytes=base64.D(row.carStyle);if(!styleBytes)fail();
  const carStyle=Style.deserializeBinary(styleBytes);if(carStyle.serialize()!==row.carStyle)fail();
  return Object.freeze({recording:new (require(1754).A)(lists),carStyle,time:new (require(6146).A)(row.frames),nickname:'Your event PB (local)',isSelf:true});
}
