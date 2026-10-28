import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { eventRuntime, eventWork, consumeEventInbox } from '../../workers/ranked/src/events-runtime.js';
import { VERIFIER_ENGINE_DIGEST, VERIFIER_VERSION } from '../../workers/ranked/src/verification.js';
import { createSimilarityReviewer, similarityEvidence } from './similarity.mjs';
import { reviewInboxWrite } from './review-inbox.mjs';
import { VerificationEventConflictError } from './throughput.mjs';
import { eventReviewJobs } from './event-review-jobs.mjs';

export const EVENT_JOB_LIMIT = 16;
const DISCOVERY_REQUEST_RESERVE = 24;
const BATCH_REQUEST_RESERVE = 136;
async function deferEventConflict(work) {
  try { return await work(); }
  catch (error) {
    if (error?.status !== 409 || error?.code !== 'ABORTED') throw error;
    // Only this transaction aborted; earlier leases/publications may be durable.
    throw new VerificationEventConflictError(error);
  }
}
function runtime(db, now = Date.now) {
  if (typeof db?.call !== 'function') throw Error('Event Firestore connection required');
  return eventRuntime((path, init) => db.call(path, init?.body ? JSON.parse(init.body) : undefined), { now });
}
export async function checkEventWork(db, { now = Date.now } = {}) {
  return eventWork(runtime(db, typeof now === 'function' ? now : () => now), {existenceOnly:true});
}
export async function runEventVerification(db, root, { now = Date.now, verifyBatch, limit = EVENT_JOB_LIMIT, intakeLimit = 16, canSpend = () => true, selectionState } = {}) {
  const r = runtime(db, typeof now === 'function' ? now : () => now);
  const verify = verifyBatch || createRequire(import.meta.url)('./verify.cjs').verifyBatch;
  const review = createSimilarityReviewer(root);
  return runEventCoordinator(r, root, {
    verifyBatch: verify,
    reviewSimilarity:async(jobs,results,period)=>review(await eventReviewJobs(db,jobs,period),results),
    limit, intakeLimit, canSpend, selectionState,
    writeFinding: async (periodId, job, verdict, evidence) => {
      const resultId = job.runId || job.resultId;
      const auditId = createHash('sha256').update(JSON.stringify([
        'event-review-v1', periodId, resultId, job.trackId, job.timeMs, job.replayHash,
      ])).digest('hex');
      const write = await reviewInboxWrite(db, auditId, { ...job, periodId }, verdict, evidence);
      if (!write) return false;
      await db.call(':commit', { writes: [write] });
      return true;
    },
  });
}
export async function runEventCoordinator(r, root, { verifyBatch, limit = EVENT_JOB_LIMIT, intakeLimit = 16,
  consumeInbox = consumeEventInbox, readWork = eventWork, canSpend = () => true, selectionState, reviewSimilarity,
  writeFinding } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > EVENT_JOB_LIMIT) throw Error('Event job limit');
  if (!Number.isInteger(intakeLimit) || intakeLimit < 1 || intakeLimit > 16) throw Error('Event intake limit');
  let consumed = 0, rejected = false, budgetDeferred = false;
  let eventFindingsAdded = 0, eventFindingWriteFailed = 0;
  // Do not pay to admit more receipts than this round can verify. Unread
  // receipts remain behind the durable cursor for the next bounded round.
  for (let i = 0; i < Math.min(intakeLimit, limit); i++) {
    // Two bounded intake transactions plus discovery and one leased batch must fit.
    if (!canSpend(48 + DISCOVERY_REQUEST_RESERVE + BATCH_REQUEST_RESERVE)) { budgetDeferred = true; break; }
    let intake;
    try { intake = await consumeInbox(r, { preferRetry: i % 2 === 0 }); }
    catch (error) {
      // ABORTED confirms this transaction did not commit. The event runtime
      // disables immediate retries to bound reads; reread next invocation instead.
      if (error?.status !== 409 || error?.code !== 'ABORTED') throw error;
      return {checked:0,consumed,rejected,archived:null,results:[],budgetDeferred:true,conflictDeferred:true};
    }
    consumed += intake.consumed;
    rejected ||= intake.rejected === true;
    if (!intake.consumed) break;
  }
  if (!canSpend(DISCOVERY_REQUEST_RESERVE + BATCH_REQUEST_RESERVE))
    return {checked:0,consumed,rejected,archived:null,results:[],budgetDeferred:true};
  // Intake has already checked the inbox. Only queue and archive discovery
  // affect this round; the standalone due gate still inspects inbox/retries.
  const work = await readWork(r, {inspectInbox:false});
  let checked = 0;
  const results = [];
  const pending = [...work.periodIds];
  // The clock-based discovery rotation may not change during a whole Catch-Up.
  // Continue after the last served period without another read or persisted cursor.
  const lastIndex = pending.indexOf(selectionState?.lastPeriodId);
  if (lastIndex >= 0) pending.push(...pending.splice(0, lastIndex + 1));
  while (pending.length && checked < limit) {
    // Reserve before leasing: one lease and up to four completion transactions.
    // Existing adapter has no retries; each transaction uses at most sixteen reads.
    // Four findings may each require one inbox read and one commit after publication.
    if (!canSpend(BATCH_REQUEST_RESERVE)) { budgetDeferred = true; break; }
    const periodId = pending.shift();
    const reviewCandidates = new Map();
    const published = await deferEventConflict(() => r.service.processBatch(periodId, (jobs,period)=>{
        const verifyAndReview = async (trustedJobs, trustedPeriod, trustedTracks) => {
          const verified = await verifyBatch(root,trustedJobs,trustedTracks);
          if (reviewSimilarity) {
            assertBoundEventResults(trustedJobs,trustedPeriod,verified);
            await reviewSimilarity(trustedJobs,verified,trustedPeriod);
            for (const job of trustedJobs) {
              const resultId = job.runId || job.resultId;
              const result = verified.find(row => row?.resultId === resultId);
              const evidence = result && similarityEvidence(result);
              if (evidence) {result.needsReview=true;result.reviewEvidence=evidence;}
              if (evidence) reviewCandidates.set(resultId, {
                job: { ...job, periodId: trustedPeriod.id || periodId },
                verdict: { status: result.status, reason: result.reason },
                evidence,
              });
            }
          }
          return verified;
        };
        if(period.kind!=='kodub')return verifyAndReview(jobs,period);
        if(!jobs.every(job=>job.trackId===period.trackId))throw Error('Kodub verifier period mismatch');
        return verifyAndReview(jobs,period,[{trackId:period.trackId,code:period.kodub.trackCode,codeHash:period.kodub.trackCodeHash}]);
      }, Math.min(4, limit - checked)));
    eventFindingsAdded += published.filter(result=>result.reviewFindingAdded===true).length;
    // Legacy/advisory fallback; held findings are committed atomically by the service.
    if (writeFinding) for (const result of published) {
      const candidate = reviewCandidates.get(result?.resultId);
      if (!candidate || candidate.verdict.status !== result.status || candidate.verdict.reason !== result.reason) continue;
      try {
        if (await writeFinding(periodId, candidate.job, candidate.verdict, candidate.evidence, result)) eventFindingsAdded++;
      } catch {
        eventFindingWriteFailed++;
      }
    }
    checked += published.length; results.push(...published);
    if (published.length && selectionState) selectionState.lastPeriodId = periodId;
    if (published.some(result => result.reason === 'engine_unavailable')) break;
    if (published.length) pending.push(periodId);
  }
  let archived = null;
  if (work.archiveId && canSpend(24)) { await deferEventConflict(() => r.service.archivePeriod(work.archiveId)); archived = work.archiveId; }
  else if (work.archiveId) budgetDeferred = true;
  return { checked, consumed, rejected, archived, results, budgetDeferred, eventFindingsAdded, eventFindingWriteFailed };
}

function assertBoundEventResults(jobs,period,results) {
  if(!Array.isArray(results)||results.length!==jobs.length||new Set(results.map(row=>row?.resultId)).size!==jobs.length)throw Error('Invalid event verifier result set');
  const seen=new Set();
  for(const job of jobs){
    const resultId=job.runId||job.resultId;
    const result=results.find(row=>row?.resultId===resultId);
    if(!result||seen.has(resultId)||!['verified','mismatch','unavailable'].includes(result.status))throw Error('Invalid event verifier result binding');
    seen.add(resultId);
    if(result.status==='unavailable')continue;
    if(result.trackId!==job.trackId||result.timeMs!==job.timeMs||result.replayHash!==job.replayHash)throw Error('Invalid event verifier result binding');
    const binding=result.binding;
    if(result.engineDigest!==VERIFIER_ENGINE_DIGEST||binding?.engineDigest!==VERIFIER_ENGINE_DIGEST||
      binding.verifierVersion!==VERIFIER_VERSION||binding.resultId!==resultId||binding.trackId!==job.trackId||
      binding.nativeTrackId!==job.trackId||binding.timeMs!==job.timeMs||binding.replayHash!==job.replayHash||
      binding.actualReplayHash!==job.replayHash||binding.trackContentHash!==result.trackContentHash||
      period.kind==='kodub'&&binding.trackContentHash!==period.kodub?.trackCodeHash)throw Error('Invalid event verifier proof');
  }
}
