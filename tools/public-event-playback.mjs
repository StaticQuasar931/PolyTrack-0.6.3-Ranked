const HASH=/^[a-f0-9]{64}$/,PERIOD=/^[A-Za-z0-9_-]{1,64}$/;
const waiting=(row,source)=>row?.verificationStatus==='waiting'&&row.pending===true&&row.verified===false&&row.eventRpEligible===false&&row.source===source&&
  ['status','validationState'].every(key=>!Object.hasOwn(row,key)||['waiting','pending','unchecked','unverified','integrity'].includes(row[key]));
async function projectPublicEventPlayback(value,{periodId,trackId,entry},{playbackEngine,publicationOnly=false}={}){
  if(!PERIOD.test(periodId||'')||periodId==='permanent-rolling-hills'||!HASH.test(trackId||'')||!waiting(entry,'pending-event-playback')||
    !HASH.test(entry.accountId||'')||!HASH.test(entry.runId||'')||!Number.isSafeInteger(entry.timeMs)||entry.timeMs<1||entry.timeMs>300000||
    !waiting(value,'pending-event-recording')||value.periodId!==periodId||value.trackId!==trackId||
    value.accountId!==entry.accountId||value.runId!==entry.runId||value.timeMs!==entry.timeMs||value.frames!==entry.timeMs||
    entry.periodId!==undefined&&entry.periodId!==periodId||entry.trackId!==undefined&&entry.trackId!==trackId||
    entry.replayHash!==undefined&&entry.replayHash!==value.replayHash||!HASH.test(value.replayHash||'')||
    typeof value.carStyle!=='string'||value.carStyle.length>256||value.carStyle&&!/^[A-Za-z0-9_-]+$/.test(value.carStyle)||
    !Number.isSafeInteger(value.submittedAt)||value.submittedAt!==entry.submittedAt||
    typeof value.replay!=='string'||!value.replay.length||value.replay.length>65536||!/^[A-Za-z0-9_-]+$/.test(value.replay)||value.replay.length%4===1)
    throw Error('Invalid public pending event playback binding');
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value.replay))),b=>b.toString(16).padStart(2,'0')).join('');
  if(hash!==value.replayHash)throw Error('Public pending event replay hash mismatch');
  const binary=atob(value.replay.replace(/-/g,'+').replace(/_/g,'/'));
  if(binary.length>49152||btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')!==value.replay)throw Error('Invalid pending event encoding');
  const reader=new Blob([Uint8Array.from(binary,c=>c.charCodeAt(0))]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const chunks=[];let size=0;
  try{for(;;){const {value:chunk,done}=await reader.read();if(done)break;size+=chunk.length;if(size>30015)throw Error('Event playback inflate limit');chunks.push(chunk);}}
  finally{await reader.cancel().catch(()=>{});}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  let cursor=0,total=0,work=value.frames*5;const lists=[];
  const number=()=>{if(cursor+3>size)throw Error('Truncated event playback');const n=bytes[cursor]|bytes[cursor+1]<<8|bytes[cursor+2]<<16;cursor+=3;return n;};
  for(let channel=0;channel<5;channel++){
    const count=number();total+=count;if(count>4096||total>10000)throw Error('Event playback transition limit');
    let frame=0;const list=[];
    for(let i=0;i<count;i++){
      const delta=number();if(i&&delta===0)throw Error('Unordered event playback');
      work+=Math.max(0,value.frames-(i?frame+1:0));frame+=delta;
      if(frame>value.frames)throw Error('Event playback work limit');list.push(frame);
    }
    lists.push(list);
  }
  if(cursor!==size)throw Error('Trailing event playback bytes');
  // Public row metadata cannot attest a worker. Only a live WeakMap capability
  // enables indexed runtime validation; publication retains bytes, never authority.
  const engine=playbackEngineMetadata(playbackEngine);
  const indexedWork=indexedForwardWork(lists,value.frames);
  if(indexedWork>30000000||!publicationOnly&&!engine&&work>30000000)throw Error('Event playback work limit');
  const requiresIndexed=work>30000000;
  return {periodId,trackId,accountId:entry.accountId,runId:entry.runId,timeMs:entry.timeMs,frames:entry.timeMs,
    replay:value.replay,replayHash:hash,carStyle:value.carStyle,submittedAt:value.submittedAt,
    verificationStatus:'waiting',pending:true,verified:false,eventRpEligible:false,source:'pending-event-recording',
    ...(requiresIndexed?{requiredPlaybackEngine:{lookupVersion:PLAYBACK_ENGINE_PIN.lookupVersion,
      engineDigest:PLAYBACK_ENGINE_PIN.engineDigest,workModel:'cursor-forward-ticks-v1',scope:'public-playback-only'},
      playbackWork:indexedWork,runtimeCapability:false}: {})};
}
import {playbackEngineMetadata,indexedForwardWork} from './playback-engine-session.mjs';
import {PLAYBACK_ENGINE_PIN} from './playback-engine-pin.mjs';


// Runtime validation defaults to the safe legacy bound. Options come from the
// trusted consumer, never from the payload or selected public entry.
export async function publicEventPlaybackProjection(value,binding,options={}){
  return projectPublicEventPlayback(value,binding,{playbackEngine:options.playbackEngine});
}

// Offline/export validation for bounded immutable bytes. Not permission to dispatch
// to an old worker: high-work runtime use still requires a confirmed engine session.
export async function publicEventPlaybackForPublication(value,binding){
  return projectPublicEventPlayback(value,binding,{publicationOnly:true});
}
