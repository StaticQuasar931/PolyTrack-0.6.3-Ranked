export const OVERNIGHT_SNAPSHOT = Object.freeze({
  cron:'45 8 * * *', start:Date.parse('2026-11-04T08:45:00Z'),
  latestFallback:Date.parse('2026-11-04T12:15:00Z'), deadline:Date.parse('2026-11-04T13:00:00Z'),
  // Fifty minutes plus five minutes of finishing reserve. The 12:15 fallback
  // is offline-only on an already captured source, never another fresh capture.
  latestCaptureStart:Date.parse('2026-11-04T12:05:00Z'),
  maxJobs:10000, maxRuntimeMs:1500000, packReserveMs:60000, jobTimeoutMinutes:50, replayDocumentLimit:2000
});

export function overnightSnapshotPlan({eventName,schedule,now,runAttempt=1,configuredMode='firestore',previousCaptureStartedAt=null}={}){
  if(!['firestore','snapshot-native'].includes(configuredMode)||!Number.isSafeInteger(now)||now<0||
    !Number.isSafeInteger(runAttempt)||runAttempt<1)throw Error('Invalid overnight planning input');
  const ordinary={mode:configuredMode,overnight:false,skip:false,reason:'ordinary-configured-authority'};
  const day=new Date(now).toISOString().slice(0,10);
  if(eventName!=='schedule'||schedule!==OVERNIGHT_SNAPSHOT.cron||day!=='2026-11-04')return ordinary;
  const skip=reason=>({...ordinary,skip:true,reason});
  if(runAttempt!==1)return skip('one-time-scheduled-run-is-not-retryable');
  if(now<OVERNIGHT_SNAPSHOT.start)return skip('before-authorized-capture-window');
  if(now>=OVERNIGHT_SNAPSHOT.latestCaptureStart)return skip('fresh-capture-deadline-offline-fallback-only');
  if(Number.isSafeInteger(previousCaptureStartedAt)&&previousCaptureStartedAt>=Date.parse('2026-11-04T08:00:00Z')&&previousCaptureStartedAt<=now)
    return skip('a-post-midnight-capture-is-already-recorded');
  return {mode:'snapshot-native',overnight:true,skip:false,reason:'one-time-Nov4-scheduled-capture',
    maxJobs:OVERNIGHT_SNAPSHOT.maxJobs,maxRuntimeMs:OVERNIGHT_SNAPSHOT.maxRuntimeMs,
    packReserveMs:OVERNIGHT_SNAPSHOT.packReserveMs,jobTimeoutMinutes:OVERNIGHT_SNAPSHOT.jobTimeoutMinutes,
    replayDocumentLimit:OVERNIGHT_SNAPSHOT.replayDocumentLimit};
}

export function assertOvernightCapture({mode,now,runAttempt,previousCaptureStartedAt}={}){
  const plan=overnightSnapshotPlan({eventName:'schedule',schedule:OVERNIGHT_SNAPSHOT.cron,now,runAttempt,
    configuredMode:mode,previousCaptureStartedAt});
  if(mode!=='snapshot-native'||plan.skip||!plan.overnight)throw Error('One-time capture denied: '+plan.reason);
  return {maxJobs:plan.maxJobs,maxRuntimeMs:plan.maxRuntimeMs};
}
