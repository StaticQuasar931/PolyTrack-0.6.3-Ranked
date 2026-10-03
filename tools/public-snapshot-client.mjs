// Public, same-origin backups never replace the authoritative PB submission path.
export function createPublicSnapshotReader({baseUrl,fetchImpl=fetch,now=Date.now}){
  const pending=new Map(),saved=new Map(),retryAt=new Map();
  return async function read(kind,id='',accountId=''){
    const path=kind==='overall'?'overall.json':kind==='overall-results'?'overall-results.json':
      kind==='track'&&/^[a-f0-9]{64}$/.test(id)?`tracks/${id}.json`:
      kind==='event'&&/^[A-Za-z0-9_-]{1,64}$/.test(id)?`events/${id}.json`:
      kind==='event-replay'&&/^[A-Za-z0-9_-]{1,64}$/.test(id)&&/^[a-f0-9]{64}$/.test(accountId)?`event-replays/${id}/${accountId}.json`:null;
    if(!path)return null;
    const cached=saved.get(path);
    if(cached&&now()-cached.checkedAt<600000)return cached.value;
    if(pending.has(path))return pending.get(path);
    if(now()<(retryAt.get(path)||0))return cached?.value||null;
    const request=(async()=>{
      try{
        const response=await fetchImpl(new URL(path,baseUrl),{credentials:'omit',cache:'default',signal:AbortSignal.timeout(5000)});
        if(!response.ok||!String(response.headers.get('content-type')||'').includes('application/json'))throw Error('Public backup unavailable');
        const body=await response.text();
        if(body.length>2*1024*1024)throw Error('Public backup exceeds size limit');
        const value=JSON.parse(body);
        if(!value||typeof value!=='object'||Array.isArray(value)||(kind!=='event-replay'&&!Number.isFinite(value.updatedAt)))throw Error('Invalid public backup');
        if(kind==='track'&&value.trackId!==id)throw Error('Public track identity mismatch');
        if(kind==='event-replay'&&(value.periodId!==id||value.accountId!==accountId||typeof value.replay!=='string'||value.replay.length>65536))throw Error('Public replay identity mismatch');
        const result={...value,_publicBackup:true};
        saved.delete(path);saved.set(path,{value:result,checkedAt:now(),bytes:body.length*2});retryAt.delete(path);
        let bytes=0;for(const entry of saved.values())bytes+=entry.bytes;
        while(saved.size>128||bytes>8*1024*1024){const oldest=saved.keys().next().value;bytes-=saved.get(oldest).bytes;saved.delete(oldest);}
        return result;
      }catch{retryAt.set(path,now()+15*60000);if(retryAt.size>512)retryAt.delete(retryAt.keys().next().value);return cached?.value||null;}
    })();
    pending.set(path,request);
    request.finally(()=>{if(pending.get(path)===request)pending.delete(path);}).catch(()=>{});
    return request;
  };
}
