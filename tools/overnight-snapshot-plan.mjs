export const OVERNIGHT_SNAPSHOT = Object.freeze({
  priorDirectReservations:17241,priorWorkerRequests:512,
  claimTag:'polytrack-oneoff-2026-11-07-replacement-4',priorClaimTag:'polytrack-oneoff-2026-11-07-replacement-3',priorSource:'8b28442932979460aa7dc369501a7b4b3f88e745',
  date:'2026-11-07', execution:'local', cron:'45 8 * * *', start:Date.parse('2026-11-07T08:05:00Z'),
  reset:Date.parse('2026-11-07T08:00:00Z'),
  localReservationEnd:Date.parse('2026-11-07T11:00:00Z'),
  latestFallback:Date.parse('2026-11-07T12:15:00Z'), deadline:Date.parse('2026-11-07T13:00:00Z'),
  // Explicitly authorized replacement after the guarded first attempt failed.
  // Later finishing/recovery is offline-only, never another fresh capture.
  latestCaptureStart:Date.parse('2026-11-07T10:00:00Z'),
  maxJobs:10000, maxRuntimeMs:1500000, packReserveMs:60000, jobTimeoutMinutes:50, replayDocumentLimit:1000
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
  return {mode:'snapshot-native',overnight:true,skip:false,reason:manualOvernight?'one-time-Nov7-explicit-kickoff':'one-time-Nov7-scheduled-capture',
    maxJobs:OVERNIGHT_SNAPSHOT.maxJobs,maxRuntimeMs:OVERNIGHT_SNAPSHOT.maxRuntimeMs,
    packReserveMs:OVERNIGHT_SNAPSHOT.packReserveMs,jobTimeoutMinutes:OVERNIGHT_SNAPSHOT.jobTimeoutMinutes,
    replayDocumentLimit:OVERNIGHT_SNAPSHOT.replayDocumentLimit};
}

export function localOvernightCapturePlan({now=Date.now(),receipt}={}){
  const n=OVERNIGHT_SNAPSHOT;
  if(n.execution!=='local'||!Number.isSafeInteger(now)||now<n.start||now>=n.latestCaptureStart||
    receipt?.ready!==true||receipt.targetDate!==n.date||receipt.execution!=='local'||
    receipt.oneOffAuthority!=='snapshot-native'||! /^[a-f0-9]{40}$/.test(receipt.testedCommit||'')||
    receipt.scheduledCaptureAt!==new Date(n.start).toISOString()||receipt.replayDocumentLimit!==n.replayDocumentLimit)
    throw Error('Local overnight capture requires exact tested readiness and the authorized time window');
  return {mode:'snapshot-native',maxJobs:n.maxJobs,maxRuntimeMs:n.maxRuntimeMs,
    replayDocumentLimit:n.replayDocumentLimit,deadline:n.deadline};
}

export function assertOvernightCapture({mode,now,runAttempt,previousCaptureStartedAt}={}){
  const plan=overnightSnapshotPlan({eventName:'schedule',schedule:OVERNIGHT_SNAPSHOT.cron,now,runAttempt,
    configuredMode:mode,previousCaptureStartedAt});
  if(mode!=='snapshot-native'||plan.skip||!plan.overnight)throw Error('One-time capture denied: '+plan.reason);
  return {maxJobs:plan.maxJobs,maxRuntimeMs:plan.maxRuntimeMs};
}
