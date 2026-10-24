import {preparePublicRecordingPlayback} from './public-replay-playback.mjs';
import {publicEventPlaybackProjection} from './public-event-playback.mjs';
// Public, same-origin backups never replace the authoritative PB submission path.
export function createPublicSnapshotReader({baseUrl,fetchImpl=fetch,now=Date.now,packed=false,bootstrap=false,optimizedIndex=false,byteCache,onRead,onGenerationChange}){
  const pending=new Map(),saved=new Map(),retryAt=new Map();
  const lookupCache=new Map(),lookupPending=new Map(),lookupRetryAt=new Map();let manifestValue=null;

  let byteCachePromise=null,byteCacheDisabled=false,byteCacheQueued=0,byteCacheWrites=Promise.resolve();
  async function compressedCache(){
    if(byteCacheDisabled)return null;
    if(!byteCachePromise)byteCachePromise=(async()=>{try{return await (byteCache??globalThis.caches)?.open('polytrack-snapshot-bytes-v1')||null;}catch{byteCacheDisabled=true;return null;}})();
    return byteCachePromise;
  }
  function rememberCompressed(key,bytes){
    if(bytes.length>128*1024||byteCacheQueued>=4)return;byteCacheQueued++;
    const copy=bytes.slice();
    // Serialize eviction/put, otherwise concurrent fetches could exceed the cap.
    byteCacheWrites=byteCacheWrites.catch(()=>{}).then(async()=>{
      const store=await compressedCache();if(!store)return;
      try{
        const keys=await store.keys();for(const key of keys.slice(0,Math.max(0,keys.length-63)))await store.delete(key);
        await store.put(key,new Response(copy,{headers:{'content-type':'application/octet-stream'}}));
      }catch{byteCacheDisabled=true;}
    }).finally(()=>{byteCacheQueued--;});
  }
  let generation=0,fastIndexDisabled=false;
  const generationChanged=Error('Snapshot generation changed');
  const transientFetchErrors=new WeakSet();
  const integrityErrors=new WeakSet(),badCacheUrls=new Set(),indexFailures=new Map();
  const SHORT_RETRY_MS=30_000,LONG_RETRY_MS=15*60_000;
  function markTransientFetchError(error){
    if(error&&typeof error==='object'&&(error instanceof TypeError||error.name==='AbortError'||error.name==='TimeoutError'))transientFetchErrors.add(error);
    return error;
  }
  function isTransientFailure(error){return Boolean(error&&(transientFetchErrors.has(error)||integrityErrors.has(error)||error.status===429||(error.status>=500&&error.status<=599)));}
  function integrityError(message){const error=Error(message);integrityErrors.add(error);return error;}
  async function retryIntegrity(url,cache,read){
    const attempts=badCacheUrls.has(url.href)?1:2;
    for(let attempt=0;attempt<attempts;attempt++){
      try{return await read(badCacheUrls.has(url.href)?'reload':cache);}
      catch(error){
        if(!integrityErrors.has(error))throw error;
        badCacheUrls.add(url.href);if(badCacheUrls.size>256)badCacheUrls.delete(badCacheUrls.values().next().value);
        if(attempt+1===attempts)throw error;
      }
    }
  }
  async function fetchSnapshot(url,options){try{return await fetchImpl(url,options);}catch(error){throw markTransientFetchError(error);}}
  async function responseBody(response,method){try{return await response[method]();}catch(error){throw markTransientFetchError(error);}}
  let packageBase=new URL(baseUrl),indexRequest=null,bootstrapRequest=null,preferBootstrap=bootstrap,pointerRecoveryRetryAt=0,manualPointerRetryAt=0,pointerRecoveryRequest=null,pointerRecoveryOutcome=null,pointerRecoveryFailure=null;
  const bootstrapPath=logical=>!/^(?:profiles|profile-results|canonical|recordings|event-replays|event-playbacks)\//.test(logical);
  async function loadPackageIndex(compact){
    const failure=indexFailures.get(compact);
    if(failure){if(now()<failure.retryAt)throw failure.error;indexFailures.delete(compact);}
    if(!(compact?bootstrapRequest:indexRequest)){
      const requestedBase=packageBase,requestedGeneration=generation;
      const url=new URL(compact&&optimizedIndex&&!fastIndexDisabled?'bootstrap-fast.json':compact?'bootstrap-index.json':'index.json',requestedBase);
      const request=retryIntegrity(url,'default',async cache=>{
        let response=await fetchSnapshot(url,{credentials:'omit',cache,signal:AbortSignal.timeout(5000)});
        if(compact&&optimizedIndex&&!fastIndexDisabled&&(response.status===404||response.status===410))response=await fetchSnapshot(new URL('bootstrap-index.json',requestedBase),{credentials:'omit',cache,signal:AbortSignal.timeout(5000)});
        if(compact&&(response.status===404||response.status===410))return null;
        if(!response.ok){const error=Error('Snapshot index unavailable');error.status=response.status;error.base=requestedBase.href;throw error;}
        const text=await responseBody(response,'text');if(text.length>(compact?2:20)*1024*1024)throw integrityError('Snapshot index too large');
        let index;try{index=JSON.parse(text);}catch{throw integrityError('Invalid snapshot index JSON');}
        if(index?.compactIndexVersion===1){
          const expected=/public-snapshots([1-9]\d*)\/$/.exec(requestedBase.pathname);
          if(expected&&index.generation!==Number(expected[1]))throw integrityError('Snapshot index generation mismatch');
          if(!compact||!optimizedIndex||!index.files||typeof index.files!=='object'||Array.isArray(index.files)||Object.values(index.files).some(row=>!Array.isArray(row)||row.length!==2||typeof row[0]!=='string'||!/^[a-f0-9]{64}$/.test(row[0])||!Number.isSafeInteger(row[1])||row[1]<1||row[1]>2*1024*1024))throw integrityError('Invalid compact snapshot index');
          index.files=Object.fromEntries(Object.entries(index.files).map(([logical,[hash,size]])=>[logical,{path:hash+'.bin',sha256:hash,decodedBytes:size}]));
        }
        if(!index||typeof index!=='object'||Array.isArray(index)||index.schemaVersion!==1||index.encoding!=='gzip-xor-a7-v1'||!index.files||typeof index.files!=='object'||Array.isArray(index.files)||
          compact&&(index.partial!==true||index.fallbackIndex!=='index.json'))throw integrityError('Unsupported snapshot encoding');
        if(Object.values(index.files).some(record=>!record||typeof record!=='object'||!/^[a-f0-9]{64}\.bin$/.test(record.path)||
          record.path!==`${record.sha256}.bin`||!Number.isSafeInteger(record.decodedBytes)||record.decodedBytes<1||record.decodedBytes>2*1024*1024))throw integrityError('Invalid snapshot index record');
        return {index,base:requestedBase,generation:requestedGeneration};
      });
      let tracked;
      tracked=request.catch(error=>{
        if(compact){if(bootstrapRequest===tracked)bootstrapRequest=null;}else if(indexRequest===tracked)indexRequest=null;
        if(compact&&optimizedIndex&&!fastIndexDisabled&&requestedGeneration===generation){fastIndexDisabled=true;return loadPackageIndex(true);}
        if(requestedGeneration===generation&&isTransientFailure(error))indexFailures.set(compact,{error,retryAt:now()+SHORT_RETRY_MS});
        throw error;
      });
      if(compact)bootstrapRequest=tracked;else indexRequest=tracked;
    }
    return compact?bootstrapRequest:indexRequest;
  }

  async function lookupIndex(pack,logical){
    const bytes=new TextEncoder().encode(logical);
    const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
    const bucket=Array.from(digest.slice(0,1),byte=>byte.toString(16).padStart(2,'0')).join('');
    if(pack.generation!==generation)throw generationChanged;
    const cached=lookupCache.get(bucket);
    if(cached){lookupCache.delete(bucket);lookupCache.set(bucket,cached);return cached;}
    if(now()<(lookupRetryAt.get(bucket)||0))return loadPackageIndex(false);
    if(lookupPending.has(bucket))return lookupPending.get(bucket);
    const request=(async()=>{
      try{
        const response=await fetchSnapshot(new URL('lookup-shards/'+bucket+'.json',pack.base),{credentials:'omit',cache:'force-cache',signal:AbortSignal.timeout(5000)});
        if(!response.ok)throw Error('Snapshot lookup unavailable');
        const text=await responseBody(response,'text');if(text.length>256*1024)throw Error('Snapshot lookup too large');
        const index=JSON.parse(text);
        if(index.schemaVersion!==1||index.lookupShardsVersion!==1||index.encoding!=='gzip-xor-a7-v1'||index.generation!==pack.index.generation||index.bucket!==bucket||
          !index.files||typeof index.files!=='object'||Array.isArray(index.files)||Object.keys(index.files).length>1024||
          Object.entries(index.files).some(([logical,record])=>bootstrapPath(logical)||!record||record.path!==record.sha256+'.bin'||!/^[a-f0-9]{64}$/.test(record.sha256)||!Number.isSafeInteger(record.decodedBytes)||record.decodedBytes<1||record.decodedBytes>2*1024*1024))throw Error('Invalid snapshot lookup');
        if(pack.generation!==generation)throw generationChanged;
        const result={index,base:pack.base,generation:pack.generation};
        lookupCache.set(bucket,result);while(lookupCache.size>32)lookupCache.delete(lookupCache.keys().next().value);
        return result;
      }catch(error){
        if(pack.generation!==generation)throw generationChanged;
        lookupRetryAt.set(bucket,now()+SHORT_RETRY_MS);while(lookupRetryAt.size>64)lookupRetryAt.delete(lookupRetryAt.keys().next().value);
        return loadPackageIndex(false);
      }
    })();
    lookupPending.set(bucket,request);
    request.finally(()=>{if(lookupPending.get(bucket)===request)lookupPending.delete(bucket);}).catch(()=>{});
    return request;
  }
  async function packageIndex(logical){
    if(preferBootstrap){
      const compact=await loadPackageIndex(true);
      if(compact){
        if(bootstrapPath(logical))return compact;
        if(compact.index.lookupShardsVersion===1)return lookupIndex(compact,logical);
      }
    }
    return loadPackageIndex(false);
  }
  async function recoverCurrentGeneration({manual=false}={}){
    const invalidPointer=message=>{const error=Error(message);outcome.error=error;if(manual)throw error;return false;};
    if(pointerRecoveryRequest){
      const joinedOutcome=pointerRecoveryOutcome;
      if(manual)manualPointerRetryAt=now()+2*60_000;
      const result=await pointerRecoveryRequest;
      if(manual&&joinedOutcome?.error)throw joinedOutcome.error;
      return result;
    }
    if(pointerRecoveryFailure){
      if(now()<pointerRecoveryFailure.retryAt)throw pointerRecoveryFailure.error;
      pointerRecoveryFailure=null;pointerRecoveryRetryAt=0;
    }
    if(now()<(manual?manualPointerRetryAt:pointerRecoveryRetryAt))return false;
    if(manual)manualPointerRetryAt=now()+2*60_000;
    // Bound pointer checks without permanently stranding a tab after another deployment.
    pointerRecoveryRetryAt=now()+LONG_RETRY_MS;
    const outcome={error:null};pointerRecoveryOutcome=outcome;
    pointerRecoveryRequest=(async()=>{
      try{
        const parent=new URL('../',packageBase),pointerUrl=new URL('snapshot-current.json',parent);
        if(pointerUrl.origin!==packageBase.origin)return invalidPointer('Invalid snapshot pointer origin');
        const response=await fetchSnapshot(pointerUrl,{credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(5000)});
        if(!response.ok){if(manual||response.status===429||response.status>=500&&response.status<=599){const error=Error('Snapshot pointer unavailable');error.status=response.status;throw error;}return invalidPointer('Snapshot pointer unavailable');}
        if(response.url){const finalUrl=new URL(response.url);if(finalUrl.origin!==pointerUrl.origin||finalUrl.href!==pointerUrl.href)return invalidPointer('Invalid snapshot pointer redirect');}
        const text=await responseBody(response,'text');if(text.length>16384)return invalidPointer('Invalid snapshot pointer size');
        const pointer=JSON.parse(text);
        if(typeof pointer?.currentdir!=='string'||!/^public-snapshots[1-9]\d*$/.test(pointer.currentdir))return invalidPointer('Invalid snapshot pointer directory');
        const nextBase=new URL(`${pointer.currentdir}/`,parent);
        if(nextBase.origin!==packageBase.origin||nextBase.pathname!==`${parent.pathname}${pointer.currentdir}/`)return invalidPointer('Invalid snapshot pointer path');
        if(nextBase.href===packageBase.href)return false;
        const previousBaseUrl=packageBase.href;
        packageBase=nextBase;
        generation++;fastIndexDisabled=false;
        indexRequest=null;bootstrapRequest=null;
        indexFailures.clear();badCacheUrls.clear();lookupCache.clear();lookupPending.clear();lookupRetryAt.clear();
        // Retired requests may finish later, but their epoch cannot write these caches.
        pending.clear();saved.clear();retryAt.clear();manifestValue=null;
        // Notify once after invalidation. Do not await callbacks that may read the new package.
        try{Promise.resolve(onGenerationChange?.({previousBaseUrl,baseUrl:packageBase.href,generation})).catch(()=>{});}catch{}
        return true;
      }catch(error){outcome.error=error;if(isTransientFailure(error)){pointerRecoveryFailure={error,retryAt:now()+SHORT_RETRY_MS};throw error;}if(manual)throw error;return false;}
    })();
    const request=pointerRecoveryRequest;
    request.then(()=>{if(pointerRecoveryRequest===request)pointerRecoveryRequest=null;},()=>{if(pointerRecoveryRequest===request)pointerRecoveryRequest=null;});
    return request;
  }
  async function packedTextAtCurrent(logical,requestedGeneration){
    const pack=await packageIndex(logical);
    if(requestedGeneration!==generation||pack.generation!==requestedGeneration)throw generationChanged;
    const record=pack.index.files[logical];
    if(!record)return null;
    if(!/^[a-f0-9]{64}\.bin$/.test(record.path)||!Number.isSafeInteger(record.decodedBytes)||record.decodedBytes<1||record.decodedBytes>2*1024*1024)throw Error('Invalid snapshot record');
    const url=new URL(record.path,pack.base);
    // Content hash, not generation: unchanged payloads survive snapshot updates.
    const diskKey=new URL('../__polytrack_snapshot_cache__/'+record.sha256+'.bin',pack.base).href;
    return retryIntegrity(url,'force-cache',async cache=>{
    let response=null,fromDisk=false;
    const disk=await compressedCache();
    if(disk&&cache!=='reload')try{response=await disk.match(diskKey);fromDisk=Boolean(response);}catch{byteCacheDisabled=true;}
    if(!response)response=await fetchSnapshot(url,{credentials:'omit',cache,signal:AbortSignal.timeout(5000)});
    if(!response.ok){const error=Error('Snapshot unavailable');error.status=response.status;error.base=pack.base.href;throw error;}
    const bytes=new Uint8Array(await responseBody(response,'arrayBuffer'));if(bytes.length>2*1024*1024)throw integrityError('Snapshot payload too large');
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
    if(hash!==record.sha256){if(fromDisk)await disk.delete(diskKey).catch(()=>{});throw integrityError('Snapshot checksum mismatch');}
    const originalBytes=disk&&!fromDisk&&bytes.length<=128*1024?bytes.slice():null;
    for(let i=0;i<bytes.length;i++)bytes[i]^=0xa7;
    const reader=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
    const chunks=[];let total=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>record.decodedBytes||total>2*1024*1024)throw integrityError('Snapshot decompression limit');chunks.push(value);}}
    catch(error){if(integrityErrors.has(error))throw error;throw integrityError('Invalid snapshot compression');}
    finally{await reader.cancel().catch(()=>{});}
    if(total!==record.decodedBytes)throw integrityError('Snapshot length mismatch');
    const output=new Uint8Array(total);let offset=0;for(const chunk of chunks){output.set(chunk,offset);offset+=chunk.length;}
    if(originalBytes)rememberCompressed(diskKey,originalBytes);
    return new TextDecoder().decode(output);
    });
  }
  async function packedText(logical,requestedGeneration){
    try{return await packedTextAtCurrent(logical,requestedGeneration);}
    catch(error){
      if(requestedGeneration!==generation)throw generationChanged;
      if(error.status===404||error.status===410){
        if(await recoverCurrentGeneration())throw generationChanged;
      }
      throw error;
    }
  }
  async function readAtGeneration(kind,id,accountId,requestedGeneration){
    if(requestedGeneration!==generation)return null;
    const overallPage=accountId===''?id:accountId;
    const path=kind==='snapshot-meta'?'public-export-summary.json':kind==='snapshot-paging'?'snapshot-paging.json':kind==='track-statistics'?'track-statistics.json':kind==='manifest'?'manifest.json':kind==='racer-directory'?'racer-directory.json':kind==='cosmetic-directory'?'cosmetic-directory.json':kind==='overall'?'overall.json':kind==='overall-manifest'?'overall-manifest.json':kind==='overall-preview'?'overall-preview.json':kind==='overall-results'?'overall-results.json':kind==='event-totals'?'event-totals.json':
      kind==='overall-page'&&/^[1-9]\d{0,15}$/.test(String(overallPage))&&Number.isSafeInteger(Number(overallPage))?`overall-pages/${Number(overallPage)}.json`:
      kind==='track'&&/^[a-f0-9]{64}$/.test(id)?`tracks/${id}.json`:
      kind==='track-manifest'&&/^[a-f0-9]{64}$/.test(id)?`track-manifests/${id}.json`:
      kind==='track-preview'&&/^[a-f0-9]{64}$/.test(id)?`track-previews/${id}.json`:
      kind==='track-page'&&/^[a-f0-9]{64}$/.test(id)&&/^[1-9]\d{0,15}$/.test(String(accountId))&&Number.isSafeInteger(Number(accountId))?`track-pages/${id}/${Number(accountId)}.json`:
      kind==='event'&&/^[A-Za-z0-9_-]{1,64}$/.test(id)?`events/${id}.json`:
      kind==='archive-month'&&/^\d{4}-(0[1-9]|1[0-2])$/.test(id)?`archives/${id}.json`:
      kind==='profile'&&/^[a-f0-9]{64}$/.test(id)?`profiles/${id}.json`:
      kind==='profile-results'&&/^[a-f0-9]{64}$/.test(id)?`profile-results/${id}.json`:
      kind==='recording'&&/^\d{1,16}$/.test(String(id))&&Number.isSafeInteger(Number(id))&&Number(id)>0?`recordings/${id}.json`:
      kind==='event-playback'&&/^[A-Za-z0-9_-]{1,64}$/.test(id)&&/^[a-f0-9]{64}$/.test(accountId)?`event-playbacks/${id}/${accountId}.json`:
      kind==='event-replay'&&/^[A-Za-z0-9_-]{1,64}$/.test(id)&&/^[a-f0-9]{64}$/.test(accountId)?`event-replays/${id}/${accountId}.json`:null;
    if(!path)return null;
    const readStarted=now();
    const measured=source=>{try{onRead?.({kind,source,durationMs:Math.max(0,now()-readStarted)});}catch{}};
    if(['track-preview','track-page','track-manifest','overall-preview','overall-page','overall-manifest','snapshot-paging'].includes(kind))preferBootstrap=true;
    if(kind==='manifest'&&manifestValue)return {...manifestValue,_dataSource:'cached'};
    const cached=saved.get(path);
    if(cached&&(packed||now()-cached.checkedAt<600000)){saved.delete(path);saved.set(path,cached);measured('memory');return {...cached.value,_dataSource:'cached'};}
    if(pending.has(path))return pending.get(path);
    if(now()<(retryAt.get(path)||0))return cached?.value||null;
    const request=(async()=>{
      // Fetch capture metadata alongside the board instead of adding another round trip.
        const knownTrack=kind==='track'?saved.get('track-statistics.json')?.value?.tracks?.[id]:null;
        const knownCapture=Date.parse(knownTrack?.capturedAt||'');
        const trackManifest=kind==='track'&&!Number.isFinite(knownCapture)?readAtGeneration('manifest','','',requestedGeneration):null;
      try{
        let body,materialized=null;
        if(packed){
          body=await packedText(path,requestedGeneration);
          if(requestedGeneration!==generation)return null;
          if(body===null&&(kind==='track'||kind==='overall'))materialized=await reconstructBoard(kind,id,requestedGeneration);
          if(body===null&&!materialized){retryAt.set(path,now()+LONG_RETRY_MS);if(retryAt.size>512)retryAt.delete(retryAt.keys().next().value);return null;}
        }
        else{
          const response=await fetchSnapshot(new URL(path,baseUrl),{credentials:'omit',cache:'default',signal:AbortSignal.timeout(5000)});
          if(!response.ok){const error=Error('Public backup unavailable');error.status=response.status;throw error;}
          if(!String(response.headers.get('content-type')||'').includes('application/json'))throw Error('Public backup unavailable');
          body=await responseBody(response,'text');
        }
        if(body!==null&&body.length>2*1024*1024)throw Error('Public backup exceeds size limit');
        let value=materialized||JSON.parse(body);
        if(!value||typeof value!=='object'||Array.isArray(value)||(!['event-replay','event-playback','snapshot-meta','manifest','track-statistics','snapshot-paging'].includes(kind)&&!Number.isFinite(value.updatedAt)))throw Error('Invalid public backup');
        if(kind==='event-playback'){
          const board=await readAtGeneration('event',id,'',requestedGeneration);
          const entry=board?.pendingPlaybacks?.find(row=>row.runId===accountId);
          if(!board||board.archived===true||board.period?.id!==id||!entry||value.periodId!==id||value.runId!==accountId)throw Error('Pending event playback no longer publicly listed');
          value=await publicEventPlaybackProjection(value,{periodId:id,trackId:board.period.trackId,entry});
        }
        if(kind==='snapshot-meta'&&(typeof value.capturedAt!=='string'||!Number.isFinite(Date.parse(value.capturedAt))||Date.parse(value.capturedAt)<=0))throw Error('Invalid snapshot capture date');
        if(kind==='track-statistics'&&(value.schemaVersion!==1||typeof value.complete!=='boolean'||!value.tracks||typeof value.tracks!=='object'||Array.isArray(value.tracks)||Object.entries(value.tracks).some(([id,row])=>!/^[a-f0-9]{64}$/.test(id)||!row||typeof row!=='object'||typeof row.complete!=='boolean'||!(row.count===null||Number.isSafeInteger(row.count)&&row.count>=0)||!(row.players===null||Number.isSafeInteger(row.players)&&row.players>=0)||!(row.totalEntries===null||Number.isSafeInteger(row.totalEntries)&&row.totalEntries>=0)||!(row.weight===null||Number.isFinite(row.weight)&&row.weight>=0)||!(row.revision===null||Number.isSafeInteger(row.revision))||!(row.updatedAt===null||Number.isSafeInteger(row.updatedAt))||!(row.capturedAt===null||typeof row.capturedAt==='string'&&Number.isFinite(Date.parse(row.capturedAt))))))throw Error('Invalid public track statistics');
        if(kind==='manifest'&&(value.schemaVersion!==1||!value.tracks||typeof value.tracks!=='object'||Array.isArray(value.tracks)))throw Error('Invalid public snapshot manifest');
        if(kind==='track'&&value.trackId!==id)throw Error('Public track identity mismatch');
        if(kind==='track-preview'||kind==='track-page')validateTrackSlice(value,kind,id,accountId);
        if(kind==='overall-preview'||kind==='overall-page')validateOverallSlice(value,kind,overallPage);
        if(kind==='track-manifest'||kind==='overall-manifest')validatePageManifest(value,kind,id);
        if(kind==='snapshot-paging'&&(value.schemaVersion!==1||value.pagingVersion!==1||value.pageSize!==100||typeof value.legacyMonolithCoverageComplete!=='boolean'||!Array.isArray(value.omittedMonoliths)||!value.tracks||typeof value.tracks!=='object'||Array.isArray(value.tracks)))throw Error('Invalid snapshot paging catalog');
        if(kind==='event'&&value.id!==id)throw Error('Public event identity mismatch');
        if(kind==='profile'&&value.accountId!==id)throw Error('Public profile identity mismatch');
        if(kind==='cosmetic-directory'&&(!value.entries||typeof value.entries!=='object'||Array.isArray(value.entries)||Object.entries(value.entries).some(([id,row])=>!/^[a-f0-9]{64}$/.test(id)||!row?.value||typeof row.value!=='object'||Array.isArray(row.value))))throw Error('Invalid snapshot cosmetics');
        if(kind==='racer-directory'&&(!value.entries||typeof value.entries!=='object'||Array.isArray(value.entries)||Object.entries(value.entries).some(([id,row])=>!/^[a-f0-9]{64}$/.test(id)||!row||typeof row!=='object'||Array.isArray(row)||!Number.isFinite(row.updatedAt)||Object.keys(row).some(key=>!['updatedAt','name','nickname','countryCode','carStyle','carId','carColors','profileCosmetics','cosmeticContext'].includes(key))||Object.hasOwn(row,'cosmeticContext')&&!validCosmeticContext(row.cosmeticContext))))throw Error('Invalid snapshot racer directory');
        if(kind==='profile-results'&&(value.accountId!==id||!Array.isArray(value.results)||value.results.length>2000||value.results.some(row=>!/^[a-f0-9]{64}$/.test(row?.trackId||''))))throw Error('Public profile results identity mismatch');
        if(kind==='recording'&&(typeof value.recording!=='string'||value.recording.length>850000||!Number.isSafeInteger(value.frames)||value.frames<1))throw Error('Invalid public recording');
        if(kind==='archive-month'&&(!Array.isArray(value.periods)||value.periods.length>500||value.periods.some(p=>typeof p?.id!=='string'||!Number.isSafeInteger(p.startsAt)||new Date(p.startsAt).toISOString().slice(0,7)!==id)))throw Error('Invalid archive month');
        if(kind==='event-replay'&&(value.periodId!==id||value.accountId!==accountId||typeof value.replay!=='string'||value.replay.length>65536))throw Error('Public replay identity mismatch');
        const result={...value,_publicBackup:true,_dataSource:'snapshot'};
        if((materialized||['track-preview','track-page','track-manifest','overall-preview','overall-page','overall-manifest'].includes(kind))&&typeof value.capturedAt==='string')result._snapshotCapturedAt=Date.parse(value.capturedAt);
        if(kind==='track'){
          // Reuse this generation's validated statistics instead of fetching a global manifest solely for capture age.
          const knownMatches=Number.isFinite(knownCapture)&&knownCapture>0&&knownTrack.revision===value.revision&&knownTrack.updatedAt===value.updatedAt&&knownTrack.complete===value.complete&&knownTrack.count===value.entries?.length;
          const manifest=knownMatches?null:await (trackManifest||readAtGeneration('manifest','','',requestedGeneration));
          const checkedAt=knownMatches?knownCapture:manifest?.tracks?.[id]?.checkedAt;
          if(Number.isSafeInteger(checkedAt)&&checkedAt>0)result._snapshotCapturedAt=checkedAt;
        }
        if(requestedGeneration!==generation)return null;
        if(kind==='manifest')manifestValue=result;
        else{
          saved.delete(path);saved.set(path,{value:result,checkedAt:now(),bytes:(body===null?JSON.stringify(value).length:body.length)*2});
          let bytes=0;for(const entry of saved.values())bytes+=entry.bytes;
          while(saved.size>128||bytes>8*1024*1024){const oldest=saved.keys().next().value;bytes-=saved.get(oldest).bytes;saved.delete(oldest);}
        }
        retryAt.delete(path);measured('snapshot');
        return result;
      }catch(error){
        if(requestedGeneration!==generation)return null;
        measured('failed');retryAt.set(path,now()+(isTransientFailure(error)?SHORT_RETRY_MS:LONG_RETRY_MS));if(retryAt.size>512)retryAt.delete(retryAt.keys().next().value);return cached?.value||null;
      }
    })();
    pending.set(path,request);
    request.finally(()=>{if(pending.get(path)===request)pending.delete(path);}).catch(()=>{});
    return request;
  }
  async function reconstructBoard(kind,id,requestedGeneration){
    const track=kind==='track',manifest=await readAtGeneration(track?'track-manifest':'overall-manifest',id,'',requestedGeneration);
    if(requestedGeneration!==generation)return null;
    if(!manifest)throw integrityError('Paged board manifest unavailable');
    const entries=[];
    // Explicit full-board consumers retain completeness without unbounded request fan-out.
    for(let offset=0;offset<manifest.pageCount;offset+=4){
      const batch=await Promise.all(Array.from({length:Math.min(4,manifest.pageCount-offset)},(_,index)=>
        readAtGeneration(track?'track-page':'overall-page',track?id:'',offset+index+1,requestedGeneration)));
      if(requestedGeneration!==generation)return null;
      for(let index=0;index<batch.length;index++){
        const page=batch[index],bound=manifest.pageBounds[offset+index];
        if(!page||['publishedEntries','totalEntries','totalEntriesExact','sourceComplete','ranksExact','pageSize','pageCount','capturedAt','updatedAt','revision','sourceRevision','algorithmVersion','schemaVersion'].some(key=>page[key]!==manifest[key])||
          Object.entries(bound).some(([key,value])=>key!=='path'&&page.bounds[key]!==value))throw integrityError('Incomplete or mixed-generation paged board');
        entries.push(...page.entries);
      }
    }
    if(entries.length!==manifest.publishedEntries)throw integrityError('Incomplete paged board');
    return {...manifest.boardMetadata,entries,complete:manifest.sourceComplete,sourceComplete:manifest.sourceComplete,
      totalEntries:manifest.totalEntries,totalEntriesExact:manifest.totalEntriesExact,publishedEntries:manifest.publishedEntries,
      ranksExact:manifest.ranksExact,capturedAt:manifest.capturedAt,_reconstructedFromPages:true};
  }
  function validCosmeticContext(context){
    if(!context||typeof context!=='object'||Array.isArray(context))return false;
    const counts=['rank','raceCount','pbCount','trackWins','extraCount','totalPlaytimeMs'];
    return Object.entries(context).every(([key,value])=>counts.includes(key)?Number.isSafeInteger(value)&&value>=0:
      key==='badges'?value&&typeof value==='object'&&!Array.isArray(value)&&Object.entries(value).every(([badge,enabled])=>badge==='betaTester'&&typeof enabled==='boolean'):
      key==='cosmeticUnlocks'?Array.isArray(value)&&value.length<=32&&value.every(unlock=>typeof unlock==='string'&&unlock.trim()===unlock&&/^[A-Za-z][A-Za-z0-9_-]{0,63}:[A-Za-z0-9_-]{1,64}$/.test(unlock)):false);
  }
  function validatePageManifest(value,kind,id){
    const track=kind==='track-manifest',nonnegative=n=>Number.isSafeInteger(n)&&n>=0;
    const sourcePath=track?`tracks/${id}.json`:'overall.json';
    if(value.kind!==kind||track&&value.trackId!==id||value.pagingVersion!==1||value.pageSize!==100||
      !nonnegative(value.publishedEntries)||value.pageCount!==Math.ceil(value.publishedEntries/100)||
      typeof value.sourceComplete!=='boolean'||value.complete!==value.sourceComplete||typeof value.totalEntriesExact!=='boolean'||typeof value.ranksExact!=='boolean'||
      !(value.totalEntries===null||nonnegative(value.totalEntries)&&value.totalEntries>=value.publishedEntries)||value.totalEntriesExact&&value.totalEntries===null||
      value.sourceComplete&&(value.totalEntries!==value.publishedEntries||!value.totalEntriesExact||track&&!value.ranksExact)||
      !(value.capturedAt===null||typeof value.capturedAt==='string'&&Number.isFinite(Date.parse(value.capturedAt))&&Date.parse(value.capturedAt)>0)||
      typeof value.monolithOmitted!=='boolean'||value.sourceLogicalPath!==sourcePath||value.fullBoardPath!==(value.monolithOmitted?null:sourcePath)||
      !value.boardMetadata||typeof value.boardMetadata!=='object'||Array.isArray(value.boardMetadata)||Object.hasOwn(value.boardMetadata,'entries')||
      track&&value.boardMetadata.trackId!==id||['updatedAt','schemaVersion','revision','sourceRevision','algorithmVersion'].some(key=>value[key]!==value.boardMetadata[key])||
      !Array.isArray(value.pageBounds)||value.pageBounds.length!==value.pageCount||value.pageBounds.some((bound,index)=>{
        const count=Math.min(100,value.publishedEntries-index*100);
        return !bound||bound.pageNumber!==index+1||bound.offset!==index*100||bound.count!==count||bound.startPosition!==index*100+1||bound.endPosition!==index*100+count||
          bound.path!==(track?`track-pages/${id}/${index+1}.json`:`overall-pages/${index+1}.json`)||
          track&&value.sourceComplete&&(bound.firstRank!==index*100+1||bound.lastRank!==index*100+count)||
          track&&(!nonnegative(bound.minTimeMs)||bound.minTimeMs<1||!nonnegative(bound.maxTimeMs)||bound.maxTimeMs<bound.minTimeMs||index>0&&bound.minTimeMs<value.pageBounds[index-1].maxTimeMs);
      }))throw Error('Invalid board page manifest');
  }
  function validateOverallSlice(value,kind,page){
    const nonnegative=n=>Number.isSafeInteger(n)&&n>=0,preview=kind==='overall-preview';
    const offset=preview?0:(Number(page)-1)*100;
    if(value.kind!==kind||value.pagingVersion!==1||value.pageSize!==100||!nonnegative(value.publishedEntries)||
      value.pageCount!==Math.ceil(value.publishedEntries/100)||typeof value.sourceComplete!=='boolean'||typeof value.ranksExact!=='boolean'||typeof value.totalEntriesExact!=='boolean'||
      !(value.totalEntries===null||nonnegative(value.totalEntries)&&value.totalEntries>=value.publishedEntries)||value.totalEntriesExact&&value.totalEntries===null||
      value.sourceComplete&&(value.totalEntries!==value.publishedEntries||!value.totalEntriesExact)||
      !(value.capturedAt===null||typeof value.capturedAt==='string'&&Number.isFinite(Date.parse(value.capturedAt))&&Date.parse(value.capturedAt)>0)||
      value.offset!==offset||value.pageNumber!==(preview?null:Number(page))||!preview&&(!nonnegative(value.pageNumber)||value.pageNumber<1||value.pageNumber>value.pageCount)||
      preview&&value.previewSize!==15||!Array.isArray(value.entries)||value.count!==value.entries.length||value.count!==Math.min(preview?15:100,value.publishedEntries-offset)||
      value.complete!==(value.sourceComplete&&value.count===value.totalEntries)||value.entries.some(row=>!row||typeof row!=='object'||Array.isArray(row)||
        (value.ranksExact?!nonnegative(row.rank)||row.globalRank!==row.rank:row.globalRank!==null)))throw Error('Invalid overall page');
    const validBounds=(bound,start,count,pageNumber)=>bound&&bound.pageNumber===pageNumber&&bound.offset===start&&bound.count===count&&
      bound.startPosition===(count?start+1:null)&&bound.endPosition===(count?start+count:null)&&
      (value.ranksExact&&count?nonnegative(bound.firstRank)&&nonnegative(bound.lastRank):bound.firstRank===null&&bound.lastRank===null);
    if(!validBounds(value.bounds,offset,value.count,value.pageNumber)||value.bounds.firstRank!==(value.entries[0]?.globalRank??null)||value.bounds.lastRank!==(value.entries.at(-1)?.globalRank??null)||
      preview&&(!Array.isArray(value.pageBounds)||value.pageBounds.length!==value.pageCount||value.pageBounds.some((bound,index)=>!validBounds(bound,index*100,Math.min(100,value.publishedEntries-index*100),index+1))))throw Error('Invalid overall page bounds');
  }
  function validateTrackSlice(value,kind,id,page){
    const nonnegative=n=>Number.isSafeInteger(n)&&n>=0,positive=n=>nonnegative(n)&&n>0;
    if(value.trackId!==id||value.kind!==kind||value.pagingVersion!==1||value.pageSize!==100||
      !nonnegative(value.publishedEntries)||value.pageCount!==Math.ceil(value.publishedEntries/100)||
      typeof value.complete!=='boolean'||typeof value.sourceComplete!=='boolean'||typeof value.totalEntriesExact!=='boolean'||typeof value.ranksExact!=='boolean'||
      !(value.totalEntries===null||nonnegative(value.totalEntries)&&value.totalEntries>=value.publishedEntries)||
      value.totalEntriesExact&&value.totalEntries===null||
      value.sourceComplete&&(value.totalEntries!==value.publishedEntries||!value.totalEntriesExact||!value.ranksExact)||
      !(value.capturedAt===null||typeof value.capturedAt==='string'&&Number.isFinite(Date.parse(value.capturedAt))&&Date.parse(value.capturedAt)>0)||
      !Array.isArray(value.entries)||value.count!==value.entries.length)throw Error('Invalid track paging metadata');
    const preview=kind==='track-preview',expectedOffset=preview?0:(Number(page)-1)*100;
    if(value.offset!==expectedOffset||value.pageNumber!==(preview?null:Number(page))||
      preview&&value.previewSize!==15||!preview&&(!positive(value.pageNumber)||value.pageNumber>value.pageCount)||
      value.count!==Math.min(preview?15:100,value.publishedEntries-expectedOffset)||
      value.complete!==(value.sourceComplete&&value.count===value.totalEntries))throw Error('Invalid track page bounds');
    if(value.entries.some((row,index)=>!positive(row?.timeMs)||index>0&&row.timeMs<value.entries[index-1].timeMs||
      (value.ranksExact? !positive(row.rank)||row.globalRank!==row.rank||value.totalEntries!==null&&row.rank>value.totalEntries||
        value.sourceComplete&&row.rank!==expectedOffset+index+1||index>0&&row.rank<=value.entries[index-1].rank:row.rank!==null||row.globalRank!==null)))throw Error('Invalid track page ranks');
    const validBounds=(bounds,offset,count,pageNumber)=>bounds&&bounds.offset===offset&&bounds.count===count&&bounds.pageNumber===pageNumber&&
      bounds.startPosition===(count?offset+1:null)&&bounds.endPosition===(count?offset+count:null)&&
      (count?positive(bounds.minTimeMs)&&positive(bounds.maxTimeMs)&&bounds.maxTimeMs>=bounds.minTimeMs:bounds.minTimeMs===null&&bounds.maxTimeMs===null)&&
      (value.ranksExact&&count?positive(bounds.firstRank)&&positive(bounds.lastRank)&&bounds.lastRank-bounds.firstRank>=count-1&&
        (!value.sourceComplete||bounds.firstRank===offset+1&&bounds.lastRank===offset+count):bounds.firstRank===null&&bounds.lastRank===null);
    if(!validBounds(value.bounds,expectedOffset,value.count,value.pageNumber)||
      value.bounds.minTimeMs!==(value.entries[0]?.timeMs??null)||value.bounds.maxTimeMs!==(value.entries.at(-1)?.timeMs??null)||
      value.bounds.firstRank!==(value.entries[0]?.globalRank??null)||value.bounds.lastRank!==(value.entries.at(-1)?.globalRank??null))throw Error('Invalid track page times');
    if(preview&&(!Array.isArray(value.pageBounds)||value.pageBounds.length!==value.pageCount||value.pageBounds.some((bounds,index)=>
      !validBounds(bounds,index*100,Math.min(100,value.publishedEntries-index*100),index+1)||index>0&&(bounds.minTimeMs<value.pageBounds[index-1].maxTimeMs||value.ranksExact&&bounds.firstRank<=value.pageBounds[index-1].lastRank))))throw Error('Invalid track page directory');
  }
  const read=async function read(kind,id='',accountId='',pageNumber){
    if((kind==='track-page'||kind==='overall-page')&&pageNumber!==undefined)accountId=pageNumber;
    for(;;){
      const requestedGeneration=generation;
      const value=await readAtGeneration(kind,id,accountId,requestedGeneration);
      // Rejoin the current generation even when a retired pending request succeeds or fails.
      if(requestedGeneration===generation)return kind==='recording'&&(value?.playbackPending===true||value?.verifiedState===0)?null:value;
    }
  };
  read.refresh=()=>recoverCurrentGeneration({manual:true});
  read.recordingPlayback=async(entry,{allowPending=false}={})=>{
    const epoch=generation;
    const row=await readAtGeneration('recording',entry?.uploadId,'',epoch);
    if(!row||epoch!==generation)return null;
    try{const result=await preparePublicRecordingPlayback(row,entry,{allowPending});return epoch===generation?result:null;}catch{return null;}
  };
  Object.defineProperty(read,'packageInfo',{value:()=>Object.freeze({
    generation:Number(/(?:^|\/)public-snapshots([1-9]\d*)\/$/.exec(packageBase.pathname)?.[1]||0),
    epoch:generation,baseUrl:packageBase.href
  }),writable:false,configurable:false});
  return read;
}
