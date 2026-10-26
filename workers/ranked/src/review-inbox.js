export const REVIEW_COLLECTION = '0.6.2_s1_review_inbox';

export function reviewRecord(auditId, job, verdict, evidence) {
  if (!evidence && verdict.status !== 'mismatch') return null;
  const exactDuplicate = verdict.reason === 'exact_duplicate_run' || evidence?.kind === 'identical_replay';
  return {
    auditId, accountId:job.accountId, trackId:job.trackId, resultId:job.resultId || job.runId,
    ...(typeof job.periodId === 'string' ? {periodId:job.periodId} : {}),
    timeMs:Number.isSafeInteger(job.timeMs)?job.timeMs:null,
    category:exactDuplicate?'exact_duplicate':evidence?.kind==='rapid_input'?'input_rate':evidence?'input_similarity':'verification_mismatch',
    status:'open', detectedAt:Number.isFinite(verdict.checkedAt)?verdict.checkedAt:Date.now(), addedAt:Date.now(), verdict:verdict.status,
    reason:String(verdict.reason || '').slice(0,100),
    ...(evidence?.trackName ? {trackName:String(evidence.trackName).slice(0,100)} : {}),
    ...(evidence?{evidence}:{}),
    notice:exactDuplicate
      ? 'Duplicate input and finish time rejected. This is not an account penalty or cheating verdict.'
      : 'Needs manual review. This is not a cheating verdict.'
  };
}

