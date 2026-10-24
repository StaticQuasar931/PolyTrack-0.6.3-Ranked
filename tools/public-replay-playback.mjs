const HASH=/^[a-f0-9]{64}$/;
const MAX_FRAMES=4000000,MAX_BYTES=850000;
const PLAYABLE_STATUSES=new Set(['pending','waiting','unchecked','unverified','integrity','verified']);
export function hasPlayablePublicReplayStatus(row){
  return !!row&&['verificationStatus','validationState','status'].every(field=>
    !Object.hasOwn(row,field)||PLAYABLE_STATUSES.has(row[field]));
}
export async function validatePublicReplayStructure(recording,frames){
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
  let cursor=0,total=0,work=frames*5;
  const number=()=>{if(cursor+3>size)throw Error('Truncated public replay');const n=bytes[cursor]|bytes[cursor+1]<<8|bytes[cursor+2]<<16;cursor+=3;return n;};
  for(let channel=0;channel<5;channel++){
    const count=number();total+=count;if(count>20000||total>50000)throw Error('Public replay transition limit');
    let frame=0;
    for(let i=0;i<count;i++){const delta=number();if(i&&delta===0)throw Error('Unordered public replay');work+=Math.max(0,frames-(i?frame+1:0));frame+=delta;if(frame>frames||work>30000000)throw Error('Public replay work limit');}
  }
  if(cursor!==size)throw Error('Trailing public replay data');
}
// Public display data authorizes viewing only, never a physics verdict or RP.
export async function preparePublicRecordingPlayback(row,entry,{allowPending=false}={}){
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
  await validatePublicReplayStructure(row.recording,row.frames);
  // Native replay/car-style deserialization remains mandatory at the playback consumer.
  return Object.freeze({recording:row.recording,frames:row.frames,carStyle:typeof row.carStyle==='string'&&row.carStyle.length<=256?row.carStyle:'',
    accountId:entry.accountId,trackId:entry.trackId,uploadId:entry.uploadId,replayHash:hash,
    verifiedState:verified?1:0,playbackPending:!verified,verificationStatus:verified?'verified':'pending',
    eventRpEligible:false,_dataSource:'public-snapshot-playback'});
}
