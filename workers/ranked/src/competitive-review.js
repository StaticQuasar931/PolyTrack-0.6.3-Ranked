export const COMPETITIVE_REVIEW_REASON = 'similar_replay_pending_manual_review';

export function isCompetitiveReviewHold(verdict) {
  return verdict?.status === 'unavailable' && verdict.reason === COMPETITIVE_REVIEW_REASON;
}

export function hasMatchingCompetitiveReviewHold(row, verdict) {
  if (!isCompetitiveReviewHold(verdict)) return false;
  let key;
  try { key = JSON.parse(verdict.key); } catch { return false; }
  // Bind the exact submission, but preserve review across native engine updates.
  return Array.isArray(key) && key.length === 8 && key[2] === String(row.accountId || row.userId || '') &&
    key[3] === row.trackId && key[4] === row.timeMs && key[5] === Number(row.raceTimeFrames || row.frames || 0) &&
    key[6] === Number(row.uploadId || row.id || 0) && key[7] === String(row.replayHash || '').toLowerCase();
}

export function strongNearCloneEvidence(evidence) {
  const e = evidence;
  return e?.kind === 'similar_top_inputs' && e.strongNearClone === true && e.policyVersion === 'strong-near-clone-v1' &&
    e.inputSimilarity >= .99 && e.inputSimilarity <= 1 && e.transitionSimilarity >= .98 && e.transitionSimilarity <= 1 && e.segmentInputSimilarity === 1 &&
    Number.isSafeInteger(e.comparedDurationMs) && e.comparedDurationMs > 0 &&
    Number.isSafeInteger(e.segmentDurationMs) && e.segmentDurationMs >= 10000 &&
    e.segmentDurationMs >= .9 * e.comparedDurationMs && e.segmentDurationMs <= e.comparedDurationMs &&
    Number.isSafeInteger(e.matchedChanges) && e.matchedChanges >= 80 &&
    Number.isSafeInteger(e.distinctSteeringChannels) && e.distinctSteeringChannels >= 2 && e.distinctSteeringChannels <= 4 && e.offsetTicks === 0 &&
    ['earlier_reference','later_reference','unknown'].includes(e.chronology);
}
