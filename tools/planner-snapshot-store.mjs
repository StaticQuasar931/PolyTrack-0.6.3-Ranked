/** Read a fixed package field set, never the browser's warmed standings cache. */
export async function buildPlannerStoreFromSnapshots({trackIds=[],read,isCurrent=()=>true,concurrency=4}={}){
  if(typeof read!=='function')return {};
  const ids=[...new Set(trackIds.filter(id=>typeof id==='string'&&id))].sort();
  const result=new Map();let next=0;
  const valid=(board,id)=>{
    if(!board||board.complete!==true||board.sourceComplete===false||board.ranksExact===false||
      board.totalEntriesExact===false||board.trackId&&board.trackId!==id||
      !Array.isArray(board.entries)||board.totalEntries!==board.entries.length)return false;
    const accounts=board.entries.map(row=>String(row?.accountId||row?.userId||''));
    return accounts.every(Boolean)&&new Set(accounts).size===accounts.length&&
      board.entries.every(row=>Number.isSafeInteger(row?.timeMs)&&row.timeMs>0&&
        row.pending!==true&&row.localPending!==true);
  };
  const worker=async()=>{
    while(next<ids.length&&isCurrent()){
      const id=ids[next++];let board=null;
      try{board=await read(id);}catch{}
      if(!isCurrent())return;
      if(valid(board,id))result.set(id,{...board,trackId:id,entries:[...board.entries].sort((a,b)=>
        a.timeMs-b.timeMs||String(a.accountId||a.userId).localeCompare(String(b.accountId||b.userId)))});
    }
  };
  await Promise.all(Array.from({length:Math.min(ids.length,Math.max(1,Math.min(8,Number(concurrency)||4)))},worker));
  return isCurrent()?Object.fromEntries([...result.entries()].sort(([a],[b])=>a.localeCompare(b))):null;
}
