// Public, same-origin backups never replace the authoritative PB submission path.
export function createPublicSnapshotReader({baseUrl,fetchImpl=fetch,now=Date.now,packed=false}){
  const pending=new Map(),saved=new Map(),retryAt=new Map();
  let indexRequest=null;
  async function packageIndex(){
    if(!indexRequest)indexRequest=(async()=>{
      const response=await fetchImpl(new URL('index.json',baseUrl),{credentials:'omit',cache:'default',signal:AbortSignal.timeout(5000)});
      if(!response.ok)throw Error('Snapshot index unavailable');
      const text=await response.text();if(text.length>8*1024*1024)throw Error('Snapshot index too large');
      const index=JSON.parse(text);
      if(index.schemaVersion!==1||index.encoding!=='gzip-xor-a7-v1'||!index.files||typeof index.files!=='object')throw Error('Unsupported snapshot encoding');
      return index;
    })().catch(error=>{indexRequest=null;throw error;});
    return indexRequest;
  }
  async function packedText(logical){
    const record=(await packageIndex()).files[logical];
    if(!record)return null;
    if(!/^[a-f0-9]{64}\.bin$/.test(record.path)||!Number.isSafeInteger(record.decodedBytes)||record.decodedBytes<1||record.decodedBytes>2*1024*1024)throw Error('Invalid snapshot record');
    const response=await fetchImpl(new URL(record.path,baseUrl),{credentials:'omit',cache:'force-cache',signal:AbortSignal.timeout(5000)});
    if(!response.ok)throw Error('Snapshot unavailable');
    const bytes=new Uint8Array(await response.arrayBuffer());if(bytes.length>2*1024*1024)throw Error('Snapshot payload too large');
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
    if(hash!==record.sha256)throw Error('Snapshot checksum mismatch');
    for(let i=0;i<bytes.length;i++)bytes[i]^=0xa7;
    const reader=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
    const chunks=[];let total=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>record.decodedBytes||total>2*1024*1024)throw Error('Snapshot decompression limit');chunks.push(value);}}
    finally{await reader.cancel().catch(()=>{});}
    if(total!==record.decodedBytes)throw Error('Snapshot length mismatch');
    const output=new Uint8Array(total);let offset=0;for(const chunk of chunks){output.set(chunk,offset);offset+=chunk.length;}
    return new TextDecoder().decode(output);
  }
  return async function read(kind,id='',accountId=''){
    const path=kind==='snapshot-meta'?'public-export-summary.json':kind==='overall'?'overall.json':kind==='overall-results'?'overall-results.json':kind==='event-totals'?'event-totals.json':
      kind==='track'&&/^[a-f0-9]{64}$/.test(id)?`tracks/${id}.json`:
      kind==='event'&&/^[A-Za-z0-9_-]{1,64}$/.test(id)?`events/${id}.json`:
      kind==='archive-month'&&/^\d{4}-(0[1-9]|1[0-2])$/.test(id)?`archives/${id}.json`:
      kind==='profile'&&/^[a-f0-9]{64}$/.test(id)?`profiles/${id}.json`:
      kind==='profile-results'&&/^[a-f0-9]{64}$/.test(id)?`profile-results/${id}.json`:
      kind==='recording'&&/^\d{1,16}$/.test(String(id))&&Number.isSafeInteger(Number(id))&&Number(id)>0?`recordings/${id}.json`:
      kind==='event-replay'&&/^[A-Za-z0-9_-]{1,64}$/.test(id)&&/^[a-f0-9]{64}$/.test(accountId)?`event-replays/${id}/${accountId}.json`:null;
    if(!path)return null;
    const cached=saved.get(path);
    if(cached&&(packed||now()-cached.checkedAt<600000))return {...cached.value,_dataSource:'cached'};
    if(pending.has(path))return pending.get(path);
    if(now()<(retryAt.get(path)||0))return cached?.value||null;
    const request=(async()=>{
      try{
        let body;
        if(packed){body=await packedText(path);if(body===null)return null;}
        else{
          const response=await fetchImpl(new URL(path,baseUrl),{credentials:'omit',cache:'default',signal:AbortSignal.timeout(5000)});
          if(!response.ok||!String(response.headers.get('content-type')||'').includes('application/json'))throw Error('Public backup unavailable');
          body=await response.text();
        }
        if(body.length>2*1024*1024)throw Error('Public backup exceeds size limit');
        const value=JSON.parse(body);
        if(!value||typeof value!=='object'||Array.isArray(value)||(!['event-replay','snapshot-meta'].includes(kind)&&!Number.isFinite(value.updatedAt)))throw Error('Invalid public backup');
        if(kind==='snapshot-meta'&&(typeof value.capturedAt!=='string'||!Number.isFinite(Date.parse(value.capturedAt))||Date.parse(value.capturedAt)<=0))throw Error('Invalid snapshot capture date');
        if(kind==='track'&&value.trackId!==id)throw Error('Public track identity mismatch');
        if(kind==='event'&&value.id!==id)throw Error('Public event identity mismatch');
        if(kind==='profile'&&value.accountId!==id)throw Error('Public profile identity mismatch');
        if(kind==='profile-results'&&(value.accountId!==id||!Array.isArray(value.results)||value.results.length>2000||value.results.some(row=>!/^[a-f0-9]{64}$/.test(row?.trackId||''))))throw Error('Public profile results identity mismatch');
        if(kind==='recording'&&(typeof value.recording!=='string'||value.recording.length>850000||!Number.isSafeInteger(value.frames)||value.frames<1))throw Error('Invalid public recording');
        if(kind==='archive-month'&&(!Array.isArray(value.periods)||value.periods.length>500||value.periods.some(p=>typeof p?.id!=='string'||!Number.isSafeInteger(p.startsAt)||new Date(p.startsAt).toISOString().slice(0,7)!==id)))throw Error('Invalid archive month');
        if(kind==='event-replay'&&(value.periodId!==id||value.accountId!==accountId||typeof value.replay!=='string'||value.replay.length>65536))throw Error('Public replay identity mismatch');
        const result={...value,_publicBackup:true,_dataSource:'snapshot'};
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
