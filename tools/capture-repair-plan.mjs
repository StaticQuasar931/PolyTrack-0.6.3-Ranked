import {OVERNIGHT_SNAPSHOT} from './overnight-snapshot-plan.mjs';

export const CAPTURE_REPAIR=Object.freeze({date:'2026-11-05',start:Date.parse('2026-11-05T13:20:00Z'),
  latestStart:Date.parse('2026-11-05T15:00:00Z'),deadline:Date.parse('2026-11-05T16:00:00Z'),
  priorFailureRunId:41996924548,priorSource:'6ec415591aaa104981f22ee11845ff2decaf2876',
  claimRef:'refs/tags/polytrack-oneoff-2026-11-05-repair-1'});

// This authorized replacement does not extend or remove the original claim.
export function assertCaptureRepair({eventName,now,runAttempt,previousCaptureStartedAt}={}){
  if(eventName!=='workflow_dispatch'||!Number.isSafeInteger(now)||runAttempt!==1||
    now<CAPTURE_REPAIR.start||now>=CAPTURE_REPAIR.latestStart)throw Error('Outside the authorized replacement capture window');
  if(Number.isSafeInteger(previousCaptureStartedAt)&&previousCaptureStartedAt>=OVERNIGHT_SNAPSHOT.reset)
    throw Error('A post-midnight capture already exists; inspect it without repeating capture');
  return {mode:'snapshot-native',overnight:true,skip:false,reason:'explicitly-authorized-Nov5-repair-1',
    maxJobs:OVERNIGHT_SNAPSHOT.maxJobs,maxRuntimeMs:OVERNIGHT_SNAPSHOT.maxRuntimeMs,
    packReserveMs:OVERNIGHT_SNAPSHOT.packReserveMs,jobTimeoutMinutes:OVERNIGHT_SNAPSHOT.jobTimeoutMinutes,
    replayDocumentLimit:OVERNIGHT_SNAPSHOT.replayDocumentLimit};
}
