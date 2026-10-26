import {playbackEngineMetadata,indexedForwardWork} from './playback-engine-session.mjs';
import {PLAYBACK_ENGINE_PIN} from './playback-engine-pin.mjs';
const HASH=/^[a-f0-9]{64}$/;
const MAX_FRAMES=4000000,MAX_BYTES=850000;
const PLAYABLE_STATUSES=new Set(['pending','waiting','unchecked','unverified','integrity','verified']);
export function hasPlayablePublicReplayStatus(row){
  return !!row&&['verificationStatus','validationState','status'].every(field=>
    !Object.hasOwn(row,field)||PLAYABLE_STATUSES.has(row[field]));
}
async function parsePublicReplayStructure(recording,frames,{playbackEngine,publicationOnly=false}={}){
  if(typeof recording!=='string'||!recording.length||recording.length>262144||!/^[A-Za-z0-9_-]+$/.test(recording)||recording.length%4===1||
    !Number.isSafeInteger(frames)||frames<1||frames>MAX_FRAMES)throw Error('Invalid public replay structure');
  const binary=atob(recording.replace(/-/g,'+').replace(/_/g,'/'));
  if(binary.length>196608||btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')!==recording)throw Error('Invalid public replay encoding');
  const compressed=Uint8Array.from(binary,c=>c.charCodeAt(0));
  const reader=new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const chunks=[];let size=0;
  try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>150018)throw Error('Public replay inflate limit');chunks.push(value);}}
  finally{await reader.cancel().catch(()=>{});}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  const engine=playbackEngineMetadata(playbackEngine);
  const indexed=!!engine||publicationOnly;
  let cursor=0,total=0,work=frames*5;const lists=[];
  const number=()=>{if(cursor+3>size)throw Error('Truncated public replay');const n=bytes[cursor]|bytes[cursor+1]<<8|bytes[cursor+2]<<16;cursor+=3;return n;};
  for(let channel=0;channel<5;channel++){
    const count=number();total+=count;if(count>20000||total>50000)throw Error('Public replay transition limit');
    let frame=0;const list=[];
    for(let i=0;i<count;i++){const delta=number();if(i&&delta===0)throw Error('Unordered public replay');work+=Math.max(0,frames-(i?frame+1:0));frame+=delta;if(frame>frames)throw Error('Public replay work limit');if(!indexed&&work>30000000)throw Error('Public replay work limit');list.push(frame);}
    lists.push(list);
  }
  if(cursor!==size)throw Error('Trailing public replay data');
  const playbackWork=indexed?indexedForwardWork(lists,frames):work;
  if(!publicationOnly&&playbackWork>30000000)throw Error('Public replay work limit');
  if(publicationOnly)return Object.freeze({structureValid:true,runtimeCapability:false,indexedPlaybackWithinBudget:playbackWork<=30000000,
    inputSha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join(''),
    playbackWork,legacyWork:work,transitions:total,inflatedBytes:size,
    requiredPlaybackEngine:Object.freeze({lookupVersion:PLAYBACK_ENGINE_PIN.lookupVersion,engineDigest:PLAYBACK_ENGINE_PIN.engineDigest,
      workModel:'cursor-forward-ticks-v1',scope:'public-playback-only'})});
  return Object.freeze({playbackWork,legacyWork:work,transitions:total,inflatedBytes:size,
    workModel:engine?.workModel||'linear-scan-v1',requiredPlaybackEngine:engine});
}
export async function validatePublicReplayStructure(recording,frames,options={}){
  return parsePublicReplayStructure(recording,frames,{playbackEngine:options.playbackEngine});
}
// Publication retains valid bytes, not authority to run them in any browser.
export async function validatePublicReplayForPublication(recording,frames){
  return parsePublicReplayStructure(recording,frames,{publicationOnly:true});
}
// Public display data authorizes viewing only, never a physics verdict or RP.
async function preparePublicRecording(row,entry,{allowPending=false,playbackEngine,dispatchPreparation=false}={}){
  if(!hasPlayablePublicReplayStatus(row)||!hasPlayablePublicReplayStatus(entry))throw Error('Public recording status not eligible');
  if(!row||!entry||!HASH.test(entry.accountId||'')||!HASH.test(entry.trackId||'')||
    !HASH.test(entry.replayHash||'')||!Number.isSafeInteger(entry.uploadId)||entry.uploadId<1||
    !Number.isSafeInteger(entry.timeMs)||entry.timeMs<1||
    !Number.isSafeInteger(entry.frames)||entry.frames<1||entry.frames>MAX_FRAMES||
    entry.raceTimeFrames!==undefined&&entry.raceTimeFrames!==entry.frames||
    row.accountId!==entry.accountId||row.trackId!==entry.trackId||row.frames!==entry.frames||
    row.uploadId!==undefined&&row.uploadId!==entry.uploadId||row.replayHash!==entry.replayHash||
    typeof row.recording!=='string'||!row.recording.length||
    new TextEncoder().encode(row.recording).length>MAX_BYTES)throw Error('Public recording binding mismatch');
  const pending=entry.runVerified===false&&entry.verified===false&&entry.integrityVerified===true&&entry.verifiedState===0;
  const verified=entry.runVerified===true&&entry.integrityVerified===true&&row.verifiedState===1;
  if(!verified&&!(allowPending&&pending&&row.verifiedState===0))throw Error('Public recording playback not eligible');
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(row.recording))),b=>b.toString(16).padStart(2,'0')).join('');
  if(hash!==entry.replayHash)throw Error('Public recording hash mismatch');
  const structure=dispatchPreparation?await validatePublicReplayForPublication(row.recording,row.frames):await validatePublicReplayStructure(row.recording,row.frames,{playbackEngine});
  if(dispatchPreparation&&!structure.indexedPlaybackWithinBudget)throw Error('Public replay work limit');
  // Native replay/car-style deserialization remains mandatory at the playback consumer.
  return Object.freeze({recording:row.recording,frames:row.frames,carStyle:typeof row.carStyle==='string'&&row.carStyle.length<=256?row.carStyle:'',
    accountId:entry.accountId,trackId:entry.trackId,uploadId:entry.uploadId,replayHash:hash,
    verifiedState:verified?1:0,playbackPending:!verified,verificationStatus:verified?'verified':'pending',
    eventRpEligible:false,_dataSource:'public-snapshot-playback',
    ...(structure.requiredPlaybackEngine?{requiredPlaybackEngine:structure.requiredPlaybackEngine,playbackWork:structure.playbackWork}:{}),
    ...(dispatchPreparation?{runtimeCapability:false,nativeDispatchRequired:true}:{})});
}
export async function preparePublicRecordingPlayback(row,entry,options={}){
  return preparePublicRecording(row,entry,{allowPending:options.allowPending,playbackEngine:options.playbackEngine});
}
// Bound public data for a gated future worker, NOT permission to dispatch it.
export async function preparePublicRecordingForNativeDispatch(row,entry,{allowPending=false}={}){
  return preparePublicRecording(row,entry,{allowPending,dispatchPreparation:true});
}
