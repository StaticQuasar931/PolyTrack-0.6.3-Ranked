import {OVERNIGHT_SNAPSHOT} from './overnight-snapshot-plan.mjs';

export const CAPTURE_REPAIR=Object.freeze({date:'2026-11-05',start:Date.parse('2026-11-05T13:20:00Z'),
  latestStart:Date.parse('2026-11-05T15:00:00Z'),deadline:Date.parse('2026-11-05T16:00:00Z'),
  priorFailureRunId:41996924548,priorSource:'6ec415591aaa104981f22ee11845ff2decaf2876',
  claimRef:'refs/tags/polytrack-oneoff-2026-11-05-repair-1',replayDocumentLimit:2000});
export const CAPTURE_REPAIR_SECOND=Object.freeze({date:'2026-11-05',start:Date.parse('2026-11-05T14:34:00Z'),
 latestStart:Date.parse('2026-11-05T17:00:00Z'),deadline:Date.parse('2026-11-05T18:00:00Z'),
 priorFailureRunId:42038203308,priorSource:'7bd4471b15da3fe04d74b56f535d688bc7211d73',
 priorClaimRef:'refs/tags/polytrack-oneoff-2026-11-05-repair-1',claimRef:'refs/tags/polytrack-oneoff-2026-11-05-repair-2',replayDocumentLimit:1000});
export function captureRepairPolicy(attempt='repair-1'){
 if(attempt==='repair-1')return CAPTURE_REPAIR;if(attempt==='repair-2')return CAPTURE_REPAIR_SECOND;
 throw Error('Unknown authorized capture attempt');
}

// This authorized replacement does not extend or remove the original claim.
export function assertCaptureRepair({eventName,now,runAttempt,previousCaptureStartedAt,attempt='repair-1'}={}){
  const policy=captureRepairPolicy(attempt);
  if(eventName!=='workflow_dispatch'||!Number.isSafeInteger(now)||runAttempt!==1||
    now<policy.start||now>=policy.latestStart)throw Error('Outside the authorized replacement capture window');
  if(Number.isSafeInteger(previousCaptureStartedAt)&&previousCaptureStartedAt>=Date.parse(policy.date+'T08:00:00Z'))
    throw Error('A post-midnight capture already exists; inspect it without repeating capture');
  return {mode:'snapshot-native',overnight:true,skip:false,reason:'explicitly-authorized-Nov5-'+attempt,
    maxJobs:OVERNIGHT_SNAPSHOT.maxJobs,maxRuntimeMs:OVERNIGHT_SNAPSHOT.maxRuntimeMs,
    packReserveMs:OVERNIGHT_SNAPSHOT.packReserveMs,jobTimeoutMinutes:OVERNIGHT_SNAPSHOT.jobTimeoutMinutes,
    replayDocumentLimit:policy.replayDocumentLimit??OVERNIGHT_SNAPSHOT.replayDocumentLimit};
}
