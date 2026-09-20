const HASH=/^[a-f0-9]{64}$/;
export function eventFinishPlace({board,periodId,trackId,accountId,timeMs}){
  if(!HASH.test(accountId||'')||!Number.isSafeInteger(timeMs)||timeMs<=0||!board||board.period?.id!==periodId||board.period?.trackId!==trackId||!Number.isSafeInteger(board.updatedAt)||!Array.isArray(board.entries))return null;
  const seen=new Set(),others=[];
  for(const row of board.entries){
    if(!HASH.test(row.accountId||'')||seen.has(row.accountId)||!Number.isSafeInteger(row.timeMs)||row.timeMs<=0)return null;
    seen.add(row.accountId);if(row.accountId!==accountId)others.push(row);
  }
  const published=board.entries.find(row=>row.accountId===accountId&&row.timeMs===timeMs);
  return {rank:1+others.filter(row=>row.timeMs<timeMs).length,fieldSize:others.length+1,provisional:!published,saved:board.saved===true};
}
