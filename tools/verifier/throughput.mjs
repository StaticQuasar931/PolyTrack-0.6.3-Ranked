import {decode} from './firestore.mjs';

export const DRAIN_LIMITS = Object.freeze({rounds:4, requests:400, reserveRequests:128,
  minimumFinalRoundRequests:51, admissionMs:360000, minimumRoundMs:30000, finishReserveMs:60000});
export const CATCH_UP_LIMITS = Object.freeze({...DRAIN_LIMITS, rounds:12, requests:1200, admissionMs:720000});
function validateLimits(limits) {
  if (limits !== DRAIN_LIMITS && limits !== CATCH_UP_LIMITS) throw Error('Invalid drain limits');
}
export class VerificationBudgetError extends Error {
  constructor() { super('verification_request_budget'); this.code='VERIFICATION_REQUEST_BUDGET'; }
}

export class VerificationEventConflictError extends Error {
  constructor(cause) {
    super('verification_event_conflict', {cause});
    this.code='VERIFICATION_EVENT_CONFLICT';this.deferred=true;
  }
}

// Reservations enforce admission, including retries. Transport counters remain separate.
export function budgetDatabase(db, limit=DRAIN_LIMITS.requests, limits=DRAIN_LIMITS) {
  validateLimits(limits);
  if (!Number.isInteger(limit) || limit<1 || limit>limits.requests) throw Error('Invalid request budget');
  let used=0;
  const reserve=()=>{
    if (used>=limit) throw new VerificationBudgetError();
    used++;
  };
  const call=async (path, body)=>{
    reserve();
    return db.call(path, body, {onRetry:reserve});
  };
  return {call, requests:()=>used, requestReservations:()=>used,
    httpRequests:()=>typeof db.httpRequests === 'function' ? db.httpRequests() : db.requests?.() ?? null,
    failedRequests:()=>db.failedRequests?.() ?? null,
    unknownReadOutcomes:()=>db.unknownReadOutcomes?.() ?? null,
    commitAttempts:()=>db.commitAttempts?.() ?? null, writeAttempts:()=>db.writeAttempts?.() ?? null,
    unknownCommitOutcomes:()=>db.unknownCommitOutcomes?.() ?? null,
    returnedDocuments:()=>db.returnedDocuments?.() ?? null,
    queryCount:()=>db.queryCount?.() ?? null,
    emptyQueryMinimumReads:()=>db.emptyQueryMinimumReads?.() ?? null,
    estimatedDocumentReads:()=>db.estimatedDocumentReads?.() ?? null,
    remainingRequests:()=>limit-used, canSpend:count=>count<=limit-used, write:(...args)=>db.write(...args),
    get:async(collection,id)=>{
      const doc=await call('/'+collection+'/'+encodeURIComponent(id));
      return doc?{...doc,data:decode({mapValue:{fields:doc.fields||{}}})}:null;
    }};
}

export async function drainVerification({runRound,requests,now=()=>performance.now(),log=console.log,limits=DRAIN_LIMITS}) {
  validateLimits(limits);
  const started=now(), rounds=[];
  let longestRound=0, stop='round_limit', interruptedRound=false;
  for(let index=0;index<limits.rounds;index++) {
    const remainingRequests = limits.requests - requests();
    if(index && remainingRequests < limits.reserveRequests &&
      remainingRequests < limits.minimumFinalRoundRequests) {stop='request_reserve';break;}
    if(index && now()-started+Math.max(longestRound,limits.minimumRoundMs)+limits.finishReserveMs>limits.admissionMs) {
      stop='time_reserve';break;
    }
    const before=now();
    let round;
    try { round=await runRound(); }
    catch(error) {
      if(error instanceof VerificationEventConflictError && error.cause?.status===409 && error.cause?.code==='ABORTED') {
        // A batch may have committed a prefix. Keep only completed-round counts.
        interruptedRound=true;stop='event_conflict';break;
      }
      if(error?.deferred===true && /^FIRESTORE_(READ|COMMIT)_THROTTLED$/.test(String(error.code||''))) {
        interruptedRound=true;stop='firestore_throttled';break;
      }
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
  const reasons={};
  const eventReasons=new Map(),eventStatuses=new Map();
  for (const round of rounds) {
    for (const [reason,count] of Object.entries(round.events.reasons || {}))
      eventReasons.set(reason,(eventReasons.get(reason)||0)+count);
    for (const [status,count] of Object.entries(round.events.statuses || {}))
      eventStatuses.set(status,(eventStatuses.get(status)||0)+count);
  }
  const verifiedByTrack={};
  for (const round of rounds) for (const [reason,count] of Object.entries(round.reasons || {})) {
    reasons[reason]=(reasons[reason] || 0)+Number(count || 0);
  }
  for (const round of rounds) for (const [trackId,count] of Object.entries(round.verifiedByTrack || {})) {
    verifiedByTrack[trackId]=(verifiedByTrack[trackId] || 0)+Number(count || 0);
  }
  const summary={rounds:rounds.length,processed:rounds.reduce((n,r)=>n+r.processed,0),
    eventChecked:rounds.reduce((n,r)=>n+r.events.checked,0),
    eventReported:rounds.reduce((n,r)=>n+(r.events.reported||0),0),
    eventCountsComplete:!interruptedRound&&rounds.every(r=>r.events.checked===0||r.events.countsComplete===true),
    eventReasons:Object.fromEntries(eventReasons),eventStatuses:Object.fromEntries(eventStatuses),
    verified:rounds.reduce((n,r)=>n+(r.verified||0),0),
    unavailable:rounds.reduce((n,r)=>n+(r.unavailable||0),0),
    mismatch:rounds.reduce((n,r)=>n+(r.mismatch||0),0),
    deferred:rounds.reduce((n,r)=>n+(r.deferred||0),0),
    superseded:rounds.reduce((n,r)=>n+(r.superseded||0),0),reasons,verifiedByTrack,
    normalQueueReturnedDocuments:rounds.reduce((n,r)=>n+(r.normalQueueReturnedDocuments||0),0),
    unusedEventReservedSlots:rounds.reduce((n,r)=>n+(r.unusedEventReservedSlots||0),0),
    normalIdleSlots:rounds.reduce((n,r)=>n+(r.normalIdleSlots||0),0),
    idleNativeSlots:rounds.reduce((n,r)=>n+(r.idleNativeSlots||0),0),
    requests:requests(),elapsedMs:now()-started,stop,interruptedRound,
    countsComplete:!interruptedRound};
  log(JSON.stringify({drain:summary}));
  return summary;
}
