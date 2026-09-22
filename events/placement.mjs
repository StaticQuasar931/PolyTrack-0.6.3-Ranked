const HASH=/^[a-f0-9]{64}$/;
export function eventFinishPlace({board,periodId,trackId,accountId,timeMs}){
  if(!HASH.test(accountId||'')||!Number.isSafeInteger(timeMs)||timeMs<=0)return null;
  const validBoard=board&&board.period?.id===periodId&&board.period?.trackId===trackId&&Number.isSafeInteger(board.updatedAt)&&Array.isArray(board.entries);
  if(board&&!validBoard)return null;
  const seen=new Set(),others=[];
  for(const row of validBoard?board.entries:[]){
    if(!HASH.test(row.accountId||'')||seen.has(row.accountId)||!Number.isSafeInteger(row.timeMs)||row.timeMs<=0)return null;
    seen.add(row.accountId);if(row.accountId!==accountId)others.push(row);
  }
  const pending=validBoard?board.pendingPlaybacks??[]:[];
  if(!Array.isArray(pending))return null;
  const pendingAccounts=new Set(),runIds=new Set();let ownPending=false;
  for(const row of pending){
    if(!HASH.test(row?.accountId||'')||pendingAccounts.has(row.accountId)||!HASH.test(row.runId||'')||runIds.has(row.runId)||!Number.isSafeInteger(row.timeMs)||row.timeMs<=0||row.verificationStatus!=='waiting'||row.pending!==true||row.verified!==false||row.eventRpEligible!==false||row.source!=='pending-event-playback')return null;
    pendingAccounts.add(row.accountId);runIds.add(row.runId);
    if(row.accountId===accountId){ownPending=true;continue;}
    others.push(row);
  }
  const published=validBoard&&board.entries.find(row=>row.accountId===accountId&&row.timeMs===timeMs);
  return {rank:1+others.filter(row=>row.timeMs<timeMs).length,fieldSize:validBoard?others.length+1:null,provisional:!published||ownPending||pending.length>0,saved:!!validBoard&&board.saved===true};
}
