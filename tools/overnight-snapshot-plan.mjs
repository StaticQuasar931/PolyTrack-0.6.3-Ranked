export const ORIGINAL_OVERNIGHT_SNAPSHOT = Object.freeze({
  priorDirectReservations:0,priorWorkerRequests:0,
  claimTag:'polytrack-oneoff-2026-11-14',priorClaimTag:'polytrack-oneoff-2026-11-07-stored-publication-1',priorSource:'e11d4db3592ecc1d5964948a98884cc7a158e3c2',
  priorOutcome:'complete',priorPublicationCommit:'4f86fe80e81014534b467b6406f13d5cdcd81539',
  date:'2026-11-14',execution:'local',cron:'45 8 * * *',start:Date.parse('2026-11-14T08:00:00Z'),
  reset:Date.parse('2026-11-14T08:00:00Z'),localReservationEnd:Date.parse('2026-11-14T13:00:00Z'),
  latestFallback:Date.parse('2026-11-14T12:15:00Z'),deadline:Date.parse('2026-11-14T13:00:00Z'),
  latestCaptureStart:Date.parse('2026-11-14T08:15:00Z'),
  maxJobs:10000,maxRuntimeMs:1500000,packReserveMs:60000,jobTimeoutMinutes:50,replayDocumentLimit:1000
});

// One new human-authorized replacement, not a retry of the immutable failed attempt.
export const OVERNIGHT_SNAPSHOT = Object.freeze({...ORIGINAL_OVERNIGHT_SNAPSHOT,
  authorizationId:'nov14-pre-capture-admission-repair',publicationMode:'capture-first',
  privateDirectorySuffix:'2026-11-14/admission-repair-local',
  priorDirectReservations:37,priorWorkerRequests:88,
  claimTag:'polytrack-oneoff-2026-11-14-admission-repair',
  priorClaimTag:'polytrack-oneoff-2026-11-14-replacement-1',priorSource:'6bb2820834936592a1124171224d4b220498a182',priorOutcome:'failed',
  start:Date.parse('2026-11-14T08:15:00Z'),latestCaptureStart:Date.parse('2026-11-14T10:00:00Z')
});

export function overnightSnapshotPlan({eventName,schedule,now,runAttempt=1,configuredMode='firestore',previousCaptureStartedAt=null,manualOvernight=false}={}){
  if(!['firestore','snapshot-native'].includes(configuredMode)||!Number.isSafeInteger(now)||now<0||
    !Number.isSafeInteger(runAttempt)||runAttempt<1||typeof manualOvernight!=='boolean')throw Error('Invalid overnight planning input');
  if(manualOvernight&&eventName!=='workflow_dispatch')throw Error('Manual overnight flag requires workflow_dispatch');
  const ordinary={mode:configuredMode,overnight:false,skip:false,reason:'ordinary-configured-authority'};
  const day=new Date(now).toISOString().slice(0,10);
  if(OVERNIGHT_SNAPSHOT.execution==='local'&&day===OVERNIGHT_SNAPSHOT.date&&
    now>=OVERNIGHT_SNAPSHOT.reset&&now<OVERNIGHT_SNAPSHOT.localReservationEnd&&
    (eventName==='schedule'||eventName==='workflow_dispatch'))return {...ordinary,skip:true,reason:'reserved-for-local-capture'};
  const requested=eventName==='schedule'&&schedule===OVERNIGHT_SNAPSHOT.cron||eventName==='workflow_dispatch'&&manualOvernight;
  if(!requested)return ordinary;
  const skip=reason=>({...ordinary,skip:true,reason});
  if(day!==OVERNIGHT_SNAPSHOT.date)return manualOvernight?skip('outside-one-time-capture-date'):ordinary;
  if(OVERNIGHT_SNAPSHOT.execution==='local')return skip('reserved-for-local-capture');
  if(runAttempt!==1)return skip('one-time-scheduled-run-is-not-retryable');
  if(now<OVERNIGHT_SNAPSHOT.start)return skip('before-authorized-capture-window');
  if(now>=OVERNIGHT_SNAPSHOT.latestCaptureStart)return skip('fresh-capture-deadline-offline-fallback-only');
  if(Number.isSafeInteger(previousCaptureStartedAt)&&previousCaptureStartedAt>=OVERNIGHT_SNAPSHOT.reset&&previousCaptureStartedAt<=now)
    return skip('a-post-midnight-capture-is-already-recorded');
  return {mode:'snapshot-native',overnight:true,skip:false,reason:manualOvernight?'one-time-Nov14-explicit-kickoff':'one-time-Nov14-scheduled-capture',
    maxJobs:OVERNIGHT_SNAPSHOT.maxJobs,maxRuntimeMs:OVERNIGHT_SNAPSHOT.maxRuntimeMs,
    packReserveMs:OVERNIGHT_SNAPSHOT.packReserveMs,jobTimeoutMinutes:OVERNIGHT_SNAPSHOT.jobTimeoutMinutes,
    replayDocumentLimit:OVERNIGHT_SNAPSHOT.replayDocumentLimit};
}

export function localOvernightCapturePlan({now=Date.now(),receipt}={}){
  const n=OVERNIGHT_SNAPSHOT;
  if(receipt?.replacementAuthorization?.id!==n.authorizationId||receipt.replacementAuthorization.requestedBy!=='user'||
    receipt.replacementAuthorization.publicationMode!==n.publicationMode||receipt.replacementAuthorization.automaticRetry!==false||
    receipt.captureOnly!==true||receipt.claimTag!==n.claimTag||receipt.priorAccounting?.directDocumentReadReservations!==n.priorDirectReservations||
    receipt.priorAccounting?.workerRequests!==n.priorWorkerRequests)throw Error('Explicit replacement authorization and carried accounting required');
  if(n.execution!=='local'||!Number.isSafeInteger(now)||now<n.start||now>=n.latestCaptureStart||
    receipt?.ready!==true||receipt.targetDate!==n.date||receipt.execution!=='local'||
    receipt.oneOffAuthority!=='firestore'||! /^[a-f0-9]{40}$/.test(receipt.testedCommit||'')||
    receipt.scheduledCaptureAt!==new Date(n.start).toISOString()||receipt.replayDocumentLimit!==n.replayDocumentLimit)
    throw Error('Local overnight capture requires exact tested readiness and the authorized time window');
  return {mode:'firestore',maxJobs:n.maxJobs,maxRuntimeMs:n.maxRuntimeMs,
    replayDocumentLimit:n.replayDocumentLimit,deadline:n.deadline};
}

export function assertOvernightCapture({mode,now,runAttempt,previousCaptureStartedAt}={}){
  const plan=overnightSnapshotPlan({eventName:'schedule',schedule:OVERNIGHT_SNAPSHOT.cron,now,runAttempt,
    configuredMode:mode,previousCaptureStartedAt});
  if(mode!=='snapshot-native'||plan.skip||!plan.overnight)throw Error('One-time capture denied: '+plan.reason);
  return {maxJobs:plan.maxJobs,maxRuntimeMs:plan.maxRuntimeMs};
}
