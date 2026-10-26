import {confirmPlaybackEngine,revokePlaybackEngine,assertPlaybackEngineSession,playbackEngineMetadata} from './playback-engine-session.mjs';
import {preparePublicRecordingPlayback,preparePublicRecordingForNativeDispatch,validatePublicReplayForPublication} from './public-replay-playback.mjs';

// Synchronous pre-main capture only. No fetch, queue, timer or handshake here.
export function installPlaybackWorkerCapture(scope=globalThis){
  const key=Symbol.for('polytrack.playback.workers.v2');if(scope[key])return scope[key];
  const main=[...scope.document.scripts].map(script=>script.src&&new URL(script.src,scope.document.baseURI)).find(url=>url&&/\/main\.bundle\.js$/.test(url.pathname));
  if(!main||!/^https?:$/.test(main.protocol))throw Error('Exact loaded main asset URL required');
  const expected=new URL('simulation_worker.bundle.js',main),Native=scope.Worker,records=new Set(),protectedRecordings=new Set();
  const registry={records,protectedRecordings,mainUrl:main.href,workerUrl:expected.href,onDispose:null,guard:null};
  class CapturedWorker extends Native{
    constructor(url,options){
      let target;
      try{target=new URL(String(url),scope.document.baseURI);}catch{}
      const matching=!!target&&target.origin===expected.origin&&target.pathname===expected.pathname;
      const revision=main.searchParams.get('v');
      let nativeUrl=url;
      if(matching&&main.origin===scope.location.origin&&/^\d{1,8}$/.test(revision||'')){
        target.searchParams.set('v',revision);nativeUrl=target.href;
      }
      super(nativeUrl,options);
      if(!matching)return;
      const worker=this,send=worker.postMessage.bind(worker),terminate=worker.terminate.bind(worker);
      const record={worker,url:target.href,alive:true,token:null,ready:null};records.add(record);
      // Own methods survive an embed Worker shim returning a native blob object.
      Object.defineProperty(worker,'postMessage',{configurable:true,writable:true,value:function(message,...args){
        if(message?.messageType===3&&typeof message.carRecording==='string'&&protectedRecordings.has(message.carRecording)){
          if(!registry.guard)throw Error('Indexed replay dispatch unavailable');registry.guard(record,message.carRecording);
        }
        return send(message,...args);
      }});
      Object.defineProperty(worker,'terminate',{configurable:true,writable:true,value:function(){
        record.alive=false;records.delete(record);registry.onDispose?.(record);return terminate();
      }});
    }
  }
  registry.wrapper=CapturedWorker;scope.Worker=CapturedWorker;scope[key]=registry;return registry;
}

export function createPlaybackWorkerBridge({scope=globalThis,fetchImpl=scope.fetch.bind(scope),timeoutMs=5000,serializeNative,now=Date.now}={}){
  const registry=scope[Symbol.for('polytrack.playback.workers.v2')];if(!registry)throw Error('Capture prelude must run before main');
  if(registry.bridge)return registry.bridge;
  const assets=new Map(),assetFailures=new Map(),attestFailures=new WeakMap(),authorizations=new Map();let protectedCharacters=0;
  const RETRY_COOLDOWN_MS=15000;
  const trusted=[new URL(registry.mainUrl),new URL(registry.workerUrl)];
  const asset=url=>{
    const target=new URL(url);
    if(!trusted.some(expected=>target.origin===expected.origin&&target.pathname===expected.pathname))return Promise.reject(Error('Untrusted playback asset URL'));
    const failure=assetFailures.get(url);
    if(failure&&now()<failure.retryAt)return Promise.reject(failure.error);
    if(failure)assetFailures.delete(url);
    if(!assets.has(url)){
      const request=(async()=>{
      const response=await fetchImpl(url,{method:'GET',credentials:'omit',cache:'force-cache',signal:AbortSignal.timeout(timeoutMs)});if(!response.ok)throw Error('Playback asset unavailable');
      const bytes=new Uint8Array(await response.arrayBuffer());if(bytes.length>4*1024*1024)throw Error('Playback asset size limit');return bytes;
      })();
      assets.set(url,request);
      request.then(()=>{if(assets.get(url)===request)assetFailures.delete(url);},error=>{
        if(assets.get(url)===request){assets.delete(url);assetFailures.set(url,{error,retryAt:now()+RETRY_COOLDOWN_MS});}
      });
    }
    return assets.get(url);
  };
  const attest=record=>{
    if(record.token&&playbackEngineMetadata(record.token))return Promise.resolve(record.token);
    if(record.ready)return record.ready;
    const failure=attestFailures.get(record);
    if(failure&&now()<failure.retryAt)return Promise.reject(failure.error);
    if(failure)attestFailures.delete(record);
    const request=(async()=>{
      const [workerBytes,mainBytes]=await Promise.all([asset(record.url),asset(registry.mainUrl)]);if(!record.alive)throw Error('Playback worker disposed');
      const token=await confirmPlaybackEngine({worker:record.worker,workerBytes,mainBytes,timeoutMs:Math.min(timeoutMs,10000)});
      if(!record.alive){revokePlaybackEngine(token);throw Error('Playback worker disposed');}record.token=token;return token;
    })();
    record.ready=request;
    request.then(()=>{
      if(record.ready===request){record.ready=null;attestFailures.delete(record);}
    },error=>{
      if(record.ready===request){record.ready=null;attestFailures.set(record,{error,retryAt:now()+RETRY_COOLDOWN_MS});}
    });
    return request;
  };
  registry.guard=(record,recording)=>{
    const token=authorizations.get(recording)?.get(record.worker);
    if(!record.alive||!token)throw Error('Indexed recording was not prepared for this native worker');
    assertPlaybackEngineSession(token,record.worker,playbackEngineMetadata(token));
  };
  registry.onDispose=record=>{if(record.token)revokePlaybackEngine(record.token);};
  const register=(keys,sessions)=>{
    const fresh=[...new Set(keys)].filter(key=>!registry.protectedRecordings.has(key));
    if(authorizations.size+fresh.length>512||protectedCharacters+fresh.reduce((n,key)=>n+key.length,0)>4*1024*1024)throw Error('Indexed replay registration limit');
    for(const key of fresh){registry.protectedRecordings.add(key);protectedCharacters+=key.length;}
    for(const key of keys)authorizations.set(key,new Map(sessions));
  };
  const prepareHighWork=async(recording,frames)=>{
    const stats=await validatePublicReplayForPublication(recording,frames);if(stats.legacyWork<=30000000)return null;
    if(!stats.indexedPlaybackWithinBudget)throw Error('Public replay work limit');
    if(typeof serializeNative!=='function')throw Error('Native serialization adapter required');
    const serialized=serializeNative(recording),aliasStats=await validatePublicReplayForPublication(serialized,frames);
    if(aliasStats.inputSha256!==stats.inputSha256)throw Error('Native serialization changed recording inputs');
    const records=[...registry.records].filter(record=>record.alive);if(!records.length)throw Error('Open native track before selecting indexed public replay');
    // Explicit public-loader demand only. Failure NEVER queues or kills Physics.
    const tokens=await Promise.all(records.map(attest));
    register([recording,serialized],records.map((record,index)=>[record.worker,tokens[index]]));return tokens[0];
  };
  const bridge={
    prepareRecording:async(row,entry,options={})=>{
      try{return await preparePublicRecordingPlayback(row,entry,options);}catch(error){if(error.message!=='Public replay work limit')throw error;}
      await preparePublicRecordingForNativeDispatch(row,entry,options); // Bind/hash/status before any asset read.
      const token=await prepareHighWork(row.recording,row.frames);
      return preparePublicRecordingPlayback(row,entry,{...options,playbackEngine:token});
    },
    prepareEventRecording:prepareHighWork,
    refreshPreparedRecording:async(recording,frames)=>{if(registry.protectedRecordings.has(recording))await prepareHighWork(recording,frames);},
    currentToken:()=>[...registry.records].map(record=>record.token).find(token=>playbackEngineMetadata(token))||null,
    dispose:()=>{for(const record of registry.records)if(record.token)revokePlaybackEngine(record.token);assets.clear();assetFailures.clear();}
  };
  registry.bridge=Object.freeze(bridge);return registry.bridge;
}
export function getPlaybackWorkerBridge(){return globalThis[Symbol.for('polytrack.playback.workers.v2')]?.bridge||null;}
