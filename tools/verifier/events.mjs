import { createRequire } from 'node:module';
import { eventRuntime, eventWork, consumeEventInbox } from '../../workers/ranked/src/events-runtime.js';

export const EVENT_JOB_LIMIT = 16;
function runtime(db, now = Date.now) {
  if (typeof db?.call !== 'function') throw Error('Event Firestore connection required');
  return eventRuntime((path, init) => db.call(path, init?.body ? JSON.parse(init.body) : undefined), { now });
}
export async function checkEventWork(db, { now = Date.now } = {}) {
  return eventWork(runtime(db, typeof now === 'function' ? now : () => now));
}
export async function runEventVerification(db, root, { now = Date.now, verifyBatch, limit = EVENT_JOB_LIMIT, intakeLimit = 16, canSpend = () => true } = {}) {
  const r = runtime(db, typeof now === 'function' ? now : () => now);
  const verify = verifyBatch || createRequire(import.meta.url)('./verify.cjs').verifyBatch;
  return runEventCoordinator(r, root, { verifyBatch: verify, limit, intakeLimit, canSpend });
}
export async function runEventCoordinator(r, root, { verifyBatch, limit = EVENT_JOB_LIMIT, intakeLimit = 16,
  consumeInbox = consumeEventInbox, readWork = eventWork, canSpend = () => true } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > EVENT_JOB_LIMIT) throw Error('Event job limit');
  if (!Number.isInteger(intakeLimit) || intakeLimit < 1 || intakeLimit > 16) throw Error('Event intake limit');
  let consumed = 0, rejected = false, budgetDeferred = false;
  for (let i = 0; i < intakeLimit; i++) {
    // Two bounded intake transactions plus discovery and one leased batch must fit.
    if (!canSpend(48 + 24 + 128)) { budgetDeferred = true; break; }
    const intake = await consumeInbox(r, { preferRetry: i % 2 === 0 });
    consumed += intake.consumed;
    rejected ||= intake.rejected === true;
    if (!intake.consumed) break;
  }
  if (!canSpend(24)) return {checked:0,consumed,rejected,archived:null,results:[],budgetDeferred:true};
  const work = await readWork(r);
  let checked = 0;
  const results = [];
  const pending = [...work.periodIds];
  while (pending.length && checked < limit) {
    // Reserve before leasing: one lease and up to four completion transactions.
    // Existing adapter has no retries; each transaction uses at most sixteen reads.
    if (!canSpend(128)) { budgetDeferred = true; break; }
    const periodId = pending.shift();
    const published = await r.service.processBatch(periodId, jobs => verifyBatch(root, jobs), Math.min(4, limit - checked));
    checked += published.length; results.push(...published);
    if (published.some(result => result.reason === 'engine_unavailable')) break;
    if (published.length) pending.push(periodId);
  }
  let archived = null;
  if (work.archiveId && canSpend(24)) { await r.service.archivePeriod(work.archiveId); archived = work.archiveId; }
  else if (work.archiveId) budgetDeferred = true;
  return { checked, consumed, rejected, archived, results, budgetDeferred };
}
