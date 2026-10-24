export async function readKodubPracticeTrack(record,{fetcher=globalThis.fetch,decode,baseUrl=globalThis.location?.href,isCurrent=()=>true,crypto=globalThis.crypto}={}){
  if(!/^[a-f0-9]{64}$/.test(record?.id||'')||!/^[a-f0-9]{64}$/.test(record?.codeHash||''))throw Error('Saved weekly track identity is unavailable.');
  const url=new URL(record.trackUrl,baseUrl);
  if(baseUrl&&url.origin!==new URL(baseUrl).origin)throw Error('Saved weekly track must be same-origin.');
  if(!url.pathname.endsWith('/assets/'+record.codeHash+'.track')||url.search||url.hash)throw Error('Invalid saved weekly track path.');
  const response=await fetcher(url,{cache:'default',redirect:'error',signal:AbortSignal.timeout(8000)});
  if(!response.ok||Number(response.headers.get('content-length'))>262144)throw Error('Saved weekly track file is unavailable.');
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>262144)throw Error('Saved weekly track file is too large.');chunks.push(value);}}
  finally{await reader.cancel();reader.releaseLock();}
  if(!isCurrent())return null;
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(value=>value.toString(16).padStart(2,'0')).join('');
  if(hash!==record.codeHash)throw Error('Saved weekly track file failed its integrity check.');
  const code=new TextDecoder('utf-8',{fatal:true}).decode(bytes).trim();
  if(!/^PolyTrack[0-9A-Za-z+/_=-]+$/.test(code)||String(decode(code)?.trackData?.getId?.()||'')!==record.id)throw Error('Saved weekly track does not match the selected track.');
  return isCurrent()?code:null;
}
