import {ledgerBinding,ledgerKey} from '../native-verification-ledger.mjs';

const time=value=>{
  if(Number.isSafeInteger(value)&&value>0)return value;
  if(typeof value==='string'&&/^\d{4}-\d\d-\d\dT/.test(value)){const parsed=Date.parse(value);if(Number.isSafeInteger(parsed)&&parsed>0)return parsed;}
  return 0;
};

/** Scheduling only: no proof, chronology/review exemption or filtered inventory.
 * Full allJobs stays in capture order. Ties use the exact stable ledger identity.
 */
export function prioritizeNativeTargets({jobs,eventBoards=[],canonicalRows=[],policy,entries=[],now}={}){
  if(!Array.isArray(jobs)||jobs.length>100000||!Number.isSafeInteger(now)||now<=0)throw Error('Invalid native priority inventory');
  const boards=new Map(eventBoards.map(board=>[board.id,board]));
  const known=new Set(policy?.knownTrackIds||Object.keys(policy?.trackContentHashes||{}));
  const proofs=new Set(entries.map(entry=>entry.key));
  const canonical=new Map(canonicalRows.map(row=>[ledgerKey(ledgerBinding(row,'normal')),row]));
  const ranked=jobs.map(job=>{
    const key=ledgerKey(ledgerBinding(job)),board=boards.get(job.periodId),p=board?.period;
    const pending=job.kind==='event-pending';
    const live=pending&&board?.archived!==true&&(['open','settling'].includes(board?.state)||
      time(p?.startsAt)<=now&&time(p?.endsAt)+(Number.isSafeInteger(p?.graceMs)?p.graceMs:0)>now);
    const source=canonical.get(key),accepted=source?.sourceBoardStatus?.runVerified===true&&source?.sourceBoardStatus?.integrityVerified===true;
    const priority=live?0:job.lane==='normal'&&!accepted&&!proofs.has(key)&&known.has(job.trackId)?1:pending?2:proofs.has(key)?3:4;
    const recent=time(job.ingestedAt)||time(source?.ingestedAt)||time(source?.pbAt)||time(job.submittedAt);
    return {job,key,priority,recent};
  });
  ranked.sort((a,b)=>a.priority-b.priority||b.recent-a.recent||(a.key<b.key?-1:a.key>b.key?1:0));
  return {jobs:ranked.map(row=>row.job),counts:Object.fromEntries([0,1,2,3,4].map(priority=>[
    ['liveEventPending','unverifiedKnownNormal','otherEventPending','exactPublicBinding','other'][priority],ranked.filter(row=>row.priority===priority).length]))};
}
