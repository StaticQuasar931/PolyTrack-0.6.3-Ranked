import {assemblePublishedSnapshotPages} from './published-snapshot-pages.mjs';

// Replace previews only after every immutable page agrees on generation and coverage.
export async function completeRankedSnapshot(value,{saved,kind,trackId='',endpoint,fetchImpl=fetch}={}){
  if(!value?.pagination)return value;
  const p=value.pagination,s=saved?.pagination;
  const reusable=saved?.paginatedSource===true&&s?.complete===true&&p.complete===true&&
    p.version===1&&p.pageSize===100&&p.pageCount===Math.ceil(p.totalEntries/100)&&
    s.generation===p.generation&&s.totalEntries===p.totalEntries&&saved.sourceRevision===value.sourceRevision&&
    Array.isArray(saved.entries)&&saved.entries.length===p.totalEntries;
  return assemblePublishedSnapshotPages(value,{maxPages:100,fetchPage:async(page,generation)=>{
    if(reusable)return {generation,page,pageSize:100,pageCount:p.pageCount,totalEntries:p.totalEntries,
      complete:true,sourceComplete:saved.sourceComplete!==false,sourceRevision:saved.sourceRevision,entries:saved.entries.slice(page*100,(page+1)*100)};
    if(!['overall','track','event','event-totals'].includes(kind))throw Error('Invalid live snapshot kind');
    if(kind==='event'&&!/^[A-Za-z0-9_-]{1,64}$/.test(trackId))throw Error('Invalid event snapshot id');
    const path=kind==='event'?'/v1/events/'+encodeURIComponent(trackId)+'/snapshot/page':kind==='event-totals'?'/v1/events/totals/page':'/v1/snapshot/'+kind+'/page';
    const url=new URL(path,endpoint);
    if(kind==='track')url.searchParams.set('trackId',trackId);
    url.searchParams.set('generation',generation);url.searchParams.set('page',String(page));
    const response=await fetchImpl(url.href,{headers:{Accept:'application/json'},cache:'default',credentials:'omit',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(5000)});
    if(!response.ok){const error=Error('Ranked page check failed ('+response.status+')');error.status=response.status;error.retryAfter=response.headers.get('Retry-After');throw error;}
    if(!response.headers.get('Content-Type')?.toLowerCase().includes('application/json'))throw Error('Invalid ranked page response');
    return response.json();
  }});
}
