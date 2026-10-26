import {PLAYBACK_ENGINE_PIN} from './playback-engine-pin.mjs';

const sessions=new WeakMap();
const kind='polytrack-playback-capability-v1';
const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
// Match the verifier's JS normalization across Windows and static-CDN checkouts.
const digest=async bytes=>{
  const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes).replace(/\r\n?/g,'\n');
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))));
};

// This is a trusted consumer session, not public row metadata or a physics proof.
export async function confirmPlaybackEngine({worker,workerBytes,mainBytes,timeoutMs=2000}){
  if(!worker||typeof worker.postMessage!=='function'||typeof worker.addEventListener!=='function'||
    !(workerBytes instanceof Uint8Array)||!(mainBytes instanceof Uint8Array)||
    !Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw Error('Invalid playback engine session');
  if(await digest(workerBytes)!==PLAYBACK_ENGINE_PIN.workerSha256||await digest(mainBytes)!==PLAYBACK_ENGINE_PIN.mainSha256)
    throw Error('Playback engine asset mismatch');
  const nonce=hex(crypto.getRandomValues(new Uint8Array(16)));
  return new Promise((resolve,reject)=>{
    let timer;
    const cleanup=()=>{clearTimeout(timer);worker.removeEventListener('message',receive);worker.removeEventListener('error',fail);worker.removeEventListener('messageerror',fail);};
    const fail=()=>{cleanup();reject(Error('Playback engine handshake failed'));};
    const receive=event=>{
      const data=event.data;
      if(data?.messageType!==kind||data.nonce!==nonce)return;
      if(data.lookupVersion!==PLAYBACK_ENGINE_PIN.lookupVersion||data.lookupDigest!==PLAYBACK_ENGINE_PIN.lookupDigest){fail();return;}
      cleanup();
      const token=Object.freeze({lookupVersion:PLAYBACK_ENGINE_PIN.lookupVersion,engineDigest:PLAYBACK_ENGINE_PIN.engineDigest});
      const invalidate=()=>revokePlaybackEngine(token);
      sessions.set(token,{worker,invalidate});
      worker.addEventListener('error',invalidate);worker.addEventListener('messageerror',invalidate);
      resolve(token);
    };
    worker.addEventListener('message',receive);worker.addEventListener('error',fail);worker.addEventListener('messageerror',fail);
    timer=setTimeout(fail,timeoutMs);
    try{worker.postMessage({messageType:kind,nonce});}catch{fail();}
  });
}

export function revokePlaybackEngine(token){
  const session=sessions.get(token);if(!session)return;
  sessions.delete(token);
  session.worker.removeEventListener('error',session.invalidate);
  session.worker.removeEventListener('messageerror',session.invalidate);
}

export function playbackEngineMetadata(token){
  if(!sessions.has(token))return null;
  return Object.freeze({lookupVersion:PLAYBACK_ENGINE_PIN.lookupVersion,engineDigest:PLAYBACK_ENGINE_PIN.engineDigest,
    workModel:'cursor-forward-ticks-v1',scope:'public-playback-only'});
}

// Consumers must enforce this on the worker actually receiving the recording.
export function assertPlaybackEngineSession(token,worker,required){
  const session=sessions.get(token);
  if(!session||session.worker!==worker||required?.engineDigest!==PLAYBACK_ENGINE_PIN.engineDigest||
    required?.lookupVersion!==PLAYBACK_ENGINE_PIN.lookupVersion||required?.workModel!=='cursor-forward-ticks-v1')
    throw Error('Required playback engine is not active');
}

// Exact array-element probes for one cold, immutable forward pass: ticks 0..frames-1.
// Rewinds remain semantically supported, but are a separate playback pass budget.
export function indexedForwardWork(lists,frames){
  let probes=0;
  for(const a of lists){
    let lo=0,hi=a.length;
    while(lo<hi){const mid=Math.floor((lo+hi)/2);probes++;if(a[mid]<0)lo=mid+1;else hi=mid;}
    if(lo<a.length)probes++;
    for(let i=lo;i<a.length&&a[i]<frames-1;i++)probes++;
    if(a.length)probes+=Math.max(0,Math.min(frames-1,a[a.length-1]));
  }
  return frames*5+probes;
}
