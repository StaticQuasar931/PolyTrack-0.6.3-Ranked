import {decode} from './firestore.mjs';

export const DRAIN_LIMITS = Object.freeze({rounds:4, requests:400, reserveRequests:128,
  admissionMs:360000, minimumRoundMs:30000, finishReserveMs:60000});
export class VerificationBudgetError extends Error {
  constructor() { super('verification_request_budget'); this.code='VERIFICATION_REQUEST_BUDGET'; }
}

// Counts HTTP requests, not billed document reads/writes. Never retries denied work.
export function budgetDatabase(db, limit=DRAIN_LIMITS.requests) {
  if (!Number.isInteger(limit) || limit<1 || limit>DRAIN_LIMITS.requests) throw Error('Invalid request budget');
  let used=0;
  const call=async (...args)=>{
    if (used>=limit) throw new VerificationBudgetError();
    used++;
    return db.call(...args);
  };
  return {call, requests:()=>used, remainingRequests:()=>limit-used, canSpend:count=>count<=limit-used, write:(...args)=>db.write(...args),
    get:async(collection,id)=>{
      const doc=await call('/'+collection+'/'+encodeURIComponent(id));
      return doc?{...doc,data:decode({mapValue:{fields:doc.fields||{}}})}:null;
    }};
}

export async function drainVerification({runRound,requests,now=()=>performance.now(),log=console.log}) {
  const started=now(), rounds=[];
  let longestRound=0, stop='round_limit', interruptedRound=false;
  for(let index=0;index<DRAIN_LIMITS.rounds;index++) {
    if(index && DRAIN_LIMITS.requests-requests()<DRAIN_LIMITS.reserveRequests) {stop='request_reserve';break;}
    if(index && now()-started+Math.max(longestRound,DRAIN_LIMITS.minimumRoundMs)+DRAIN_LIMITS.finishReserveMs>DRAIN_LIMITS.admissionMs) {
      stop='time_reserve';break;
    }
    const before=now();
    let round;
    try { round=await runRound(); }
    catch(error) {
      if(error?.code!=='VERIFICATION_REQUEST_BUDGET') throw error;
      // Earlier atomic publications may have succeeded; do not invent their counts.
      interruptedRound=true;stop='request_budget';break;
    }
    rounds.push(round);longestRound=Math.max(longestRound,now()-before);
    if(round.infrastructureFailure) {stop='infrastructure_failure';break;}
    const normalProgress=round.processed>Number(round.deferred||0)+Number(round.superseded||0);
    const eventProgress=round.events.checked>0||round.events.consumed>0;
    const pruned=round.processed===0&&round.canonicalAttempts>0&&round.selectionConflicts===0;
    if (round.events.budgetDeferred && !normalProgress && !eventProgress && !pruned) {stop='budget_deferred';break;}
    if(!normalProgress&&!eventProgress&&!pruned) {stop='no_progress';break;}
  }
  const summary={rounds:rounds.length,processed:rounds.reduce((n,r)=>n+r.processed,0),
    eventChecked:rounds.reduce((n,r)=>n+r.events.checked,0),
    verified:rounds.reduce((n,r)=>n+(r.verified||0),0),
    requests:requests(),elapsedMs:now()-started,stop,interruptedRound,
    countsComplete:!interruptedRound};
  log(JSON.stringify({drain:summary}));
  return summary;
}
