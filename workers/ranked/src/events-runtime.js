import {utcEventCandidates} from '../../../events/schedule.mjs';
export {utcEventCandidates} from '../../../events/schedule.mjs';
import { createEventService, EVENT_COLLECTIONS as C, EVENT_LIMITS as L, eventPeriod, exhaustedEventLease } from './events.js';
import { createEventFirestoreStore, eventDecode } from './events-store.js';

export function eventRuntime(request, { projectId = 'polytrack-052', now = Date.now } = {}) {
  const store = createEventFirestoreStore({ request, projectId, retries: 0 });
  return { store, service: createEventService({ store, now }), request, projectId, now };
}
const decode = doc => eventDecode({ mapValue: { fields: doc.fields || {} } });
const post = (runtime, path, body) => runtime.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
export const eventReceiptRetry = code => ['event_queue_capacity', 'event_replay_capacity'].includes(code);
export const EVENT_INBOX_RETRY_MAX_MS = 15 * 60000;
function capacityRetry(previous, data, inboxId, at, retryUntil) {
  const same = previous?.attemptId === data.attemptId &&
    previous.receivedAt?.__firestoreTimestamp === data.receivedAt?.__firestoreTimestamp;
  const prior = same && Number.isSafeInteger(previous.attempts) && previous.attempts > 0 ? previous.attempts : 0;
  const attempts = Math.min(prior + 1, 16);
  const delay = Math.min(60000 * 2 ** Math.min(attempts - 1, 4), EVENT_INBOX_RETRY_MAX_MS);
  // The admission transaction supplies its already-read period deadline.
  const notBefore = Number.isSafeInteger(retryUntil) && retryUntil > 0 ? Math.min(at + delay, retryUntil) : at + delay;
  return { inboxId, attemptId: data.attemptId, receivedAt: data.receivedAt, attempts, notBefore };
}
export async function cleanupEvents(runtime) {
  const doc = await runtime.request('/' + C.catalog + '/main');
  const periods = doc ? decode(doc).periods || [] : [], at = runtime.now();
  const closing = periods.filter(p => !p.archived && at >= p.endsAt + p.graceMs)
    .sort((a, b) => a.endsAt - b.endsAt || a.id.localeCompare(b.id))[0];
  if (closing) return runtime.service.archivePeriod(closing.id);
  const target = periods.find(p => p.archived && (!p.cleaned ? at >= p.endsAt + p.graceMs + 7 * 86400000 :
    !p.extrasCleaned || at >= p.endsAt + L.retentionMs));
  if (target?.cleaned && !target.extrasCleaned) {
    // Rejected/non-admitted entrants are absent from queue.subjects. Sweep their
    // inbox/status/cursor/retry records too, one bounded collection page at a time.
    const phase = target.cleanupPhase || 0, collection = [C.inbox, C.receipts, C.cursors, C.retries][phase];
    const prefix = `projects/${runtime.projectId}/databases/(default)/documents/${collection}/${target.id}_`;
    const rows = await post(runtime, ':runQuery', { structuredQuery: { from: [{ collectionId: collection }],
      orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
      startAt: { before: true, values: [{ referenceValue: prefix }] },
      endAt: { before: true, values: [{ referenceValue: prefix + '~' }] }, limit: 8 } });
    if (!Array.isArray(rows)) throw Error('Unexpected event cleanup response');
    const docs = rows.filter(row => row.document).map(row => row.document);
    await runtime.store.transaction(async tx => {
      const catalogPath = C.catalog + '/main', catalog = await tx.get(catalogPath);
      const current = catalog.periods.find(p => p.id === target.id);
      if (!current || (current.cleanupPhase || 0) !== phase) return;
      const paths = docs.map(d => collection + '/' + d.name.split('/').at(-1));
      for (const path of paths) await tx.get(path);
      for (const path of paths) await tx.delete(path);
      if (!docs.length) await tx.set(catalogPath, { ...catalog, periods: catalog.periods.map(p => p.id === target.id ?
        { ...p, cleanupPhase: phase + 1, extrasCleaned: phase === 3 } : p) });
    });
    return { cleanup: true, deleted: docs.length };
  }
  if (target?.cleaned && target.extrasCleaned && !target.replaysCleaned) {
    const collection = C.replays;
    const prefix = `projects/${runtime.projectId}/databases/(default)/documents/${collection}/${target.id}_`;
    const rows = await post(runtime, ':runQuery', { structuredQuery: { from: [{ collectionId: collection }],
      orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
      startAt: { before: true, values: [{ referenceValue: prefix }] },
      endAt: { before: true, values: [{ referenceValue: prefix + '~' }] }, limit: 8 } });
    if (!Array.isArray(rows)) throw Error('Unexpected event replay cleanup response');
    const docs = rows.filter(row => row.document).map(row => row.document);
    await runtime.store.transaction(async tx => {
      const catalogPath = C.catalog + '/main', catalog = await tx.get(catalogPath);
      const current = catalog.periods.find(p => p.id === target.id);
      if (!current || !current.cleaned || !current.extrasCleaned || current.replaysCleaned) return;
      const paths = docs.map(d => collection + '/' + d.name.split('/').at(-1));
      for (const path of paths) await tx.get(path);
      for (const path of paths) await tx.delete(path);
      if (!docs.length) await tx.set(catalogPath, { ...catalog, periods: catalog.periods.map(p => p.id === target.id ?
        { ...p, replaysCleaned: true } : p) });
    });
    return { replayCleanup: true, deleted: docs.length };
  }
  return target ? runtime.service.cleanupPeriod(target.id) : { idle: true };
}
async function inboxCursor(runtime, { recentActivityOnly = false } = {}) {
  const raw = await runtime.request('/' + C.cursors + '/scan');
  const cursor = raw ? decode(raw) : null;
  // This is an activity hint, never proof of an empty queue. The Worker still
  // performs an unconditional poll every five minutes; verifier calls do not gate.
  if (recentActivityOnly) {
    const age = runtime.now() - cursor?.processedAt;
    if (!Number.isSafeInteger(cursor?.processedAt) || cursor.processedAt < 0 ||
        !Number.isFinite(age) || age < 0 || age >= 300000)
      return { cursor, pollDeferred: true };
  }
  return { cursor };
}
async function inboxDocuments(runtime, cursor, { projected = false } = {}) {
  const query = { from: [{ collectionId: C.inbox }], orderBy: [
    { field: { fieldPath: 'receivedAt' }, direction: 'ASCENDING' },
    { field: { fieldPath: '__name__' }, direction: 'ASCENDING' }], limit: 1 };
  if (cursor) query.startAt = { before: false, values: [
    { timestampValue: cursor.receivedAt.__firestoreTimestamp }, { referenceValue: cursor.name }] };
  if (projected) query.select = { fields: [{ fieldPath: 'receivedAt' }] };
  const result = await post(runtime, ':runQuery', { structuredQuery: query });
  if (!Array.isArray(result)) throw Error('Unexpected event inbox query response');
  return result.filter(row => row.document).map(row => row.document);
}
export async function inboxPage(runtime, { projected = false, limit = 1, recentActivityOnly = false } = {}) {
  if (limit !== 1) throw Error('Event inbox page must be one');
  const page = await inboxCursor(runtime, {recentActivityOnly});
  return { ...page, documents: page.pollDeferred ? [] : await inboxDocuments(runtime, page.cursor, {projected}) };
}
export async function consumeEventInbox(runtime, { preferRetry = false, recentActivityOnly = false } = {}) {
  const { cursor, pollDeferred } = await inboxCursor(runtime, {recentActivityOnly});
  if (pollDeferred) return { consumed: 0, pollDeferred: true };
  let retryDoc = preferRetry ? await dueRetry(runtime) : null;
  // A selected retry consumes this turn; do not fetch and discard a fresh receipt.
  const documents = retryDoc ? [] : await inboxDocuments(runtime, cursor);
  if (retryDoc || !documents.length) {
    if (!retryDoc && !preferRetry) retryDoc = await dueRetry(runtime);
    if (!retryDoc) return { consumed: 0 };
    const retry = decode(retryDoc);
    const current = await runtime.request('/' + C.inbox + '/' + retry.inboxId);
    if (!current) {
      await runtime.store.transaction(async tx => { const p = C.retries + '/' + retry.inboxId; if (await tx.get(p)) await tx.delete(p); });
      return { consumed: 1, rejected: true };
    }
    documents.splice(0, documents.length, current);
  }
  const doc = documents[0], data = decode(doc), inboxId = doc.name.split('/').at(-1);
  let result, retryUntil;
  try { result = await runtime.service.consumeInbox(data); }
  catch (error) {
    if (error?.deferred === true) throw error;
    // Infrastructure errors leave the scan cursor untouched for retry. Terminal
    // receipt rejection is recorded privately, never by modifying the client PB.
    const retry = eventReceiptRetry(error.code);
    if (retry) retryUntil = error.retryUntil;
    if (![400, 403, 404, 409, 429].includes(error.status) && error.code !== 'events_disabled') throw error;
    result = { status: error.code, rejected: !retry, retry };
  }
  await runtime.store.transaction(async tx => {
    // Admission already committed success. Only failures need receipt/status CAS guards;
    // retry turns never advance the fresh-inbox scan cursor.
    const failed = result.rejected || result.retry;
    const path = C.cursors + '/scan', current = retryDoc ? null : await tx.get(path);
    const receiptPath = C.cursors + '/' + inboxId, receipt = result.rejected ? await tx.get(receiptPath) : null;
    const statusPath = C.receipts + '/' + inboxId, previousStatus = failed ? await tx.get(statusPath) : null;
    const retryPath = C.retries + '/' + inboxId, previousRetry = await tx.get(retryPath);
    const currentInbox = failed ? await tx.get(C.inbox + '/' + inboxId) : null;
    const same = currentInbox?.attemptId === data.attemptId &&
      currentInbox.receivedAt?.__firestoreTimestamp === data.receivedAt?.__firestoreTimestamp;
    if (same && result.retry) await tx.set(retryPath,
      capacityRetry(previousRetry, data, inboxId, runtime.now(), retryUntil));
    else if (previousRetry && (!retryDoc || previousRetry.attemptId === decode(retryDoc).attemptId)) await tx.delete(retryPath);
    if (same && result.rejected && receipt?.attemptId !== data.attemptId) await tx.set(receiptPath,
      { attemptId: data.attemptId, receivedAt: data.receivedAt, status: result.status, runId: null });
    if (same && (result.rejected || result.retry) && (!previousStatus || data.timeMs <= previousStatus.timeMs)) await tx.set(statusPath,
      { ownerUid: data.ownerUid, accountId: data.accountId, periodId: data.periodId, attemptId: data.attemptId,
        timeMs: data.timeMs, status: result.retry ? 'waiting' : 'rejected', reason: result.status, updatedAt: runtime.now() });
    if (!retryDoc && JSON.stringify(current) === JSON.stringify(cursor)) await tx.set(path,
      { name: doc.name, receivedAt: data.receivedAt, processedAt: runtime.now() });
  });
  return { consumed: 1, ...result };
}

async function dueRetry(runtime) {
  const result = await post(runtime, ':runQuery', { structuredQuery: { from: [{ collectionId: C.retries }],
    where: { fieldFilter: { field: { fieldPath: 'notBefore' }, op: 'LESS_THAN_OR_EQUAL', value: { integerValue: String(runtime.now()) } } },
    orderBy: [{ field: { fieldPath: 'notBefore' }, direction: 'ASCENDING' }], limit: 1 } });
  if (!Array.isArray(result)) throw Error('Unexpected event retry query response');
  return result.find(row => row.document)?.document || null;
}

export async function eventWork(runtime, { projectedInbox = true, inspectInbox = true, existenceOnly = false } = {}) {
  const raw = await runtime.request('/' + C.catalog + '/main');
  const periods = raw ? decode(raw).periods || [] : [];
  const at = runtime.now();
  const closing = periods.find(p => !p.archived && at >= p.endsAt + p.graceMs);
  // A preflight only needs one work signal. Processing still performs full discovery.
  if (existenceOnly && closing) return { hasWork: true, periodIds: [], inbox: false, archiveId: closing.id };
  // Daily+weekly generate at most eleven live or draining periods in this window.
  const active = periods.filter(p => p.enabled === true && !p.cleaned && p.startsAt <= at && at < p.endsAt + p.graceMs + 7 * 86400000).slice(0, 16);
  const due = [];
  for (const p of active) {
    const queue = await runtime.request('/' + C.queues + '/' + p.id);
    if (queue && (decode(queue).slots || []).some(s => exhaustedEventLease(s, at) || s.notBefore <= at && s.leaseUntil <= at && s.attempts < L.verificationAttempts)) {
      due.push(p.id);
      if (existenceOnly) return { hasWork: true, periodIds: due, inbox: false, archiveId: null };
    }
  }
  let inbox = false;
  if (inspectInbox) {
    const page = await inboxPage(runtime, { projected: projectedInbox });
    inbox = page.documents.length > 0 || !!(await dueRetry(runtime));
  }
  if (due.length) { const rotation = Math.floor(at / 900000) % due.length; due.push(...due.splice(0, rotation)); }
  return { hasWork: !!(due.length || inbox || closing), periodIds: due, inbox, archiveId: closing?.id || null };
}


// Provision at most one period per invocation. Target is frozen from a
// physics-verified registered leaderboard entry, never a client-supplied score.
export async function provisionEvent(runtime, { officialIds, allIds, capacity, targetForTrack }) {
  const candidates = utcEventCandidates(runtime.now(), officialIds, allIds);
  if (Math.floor(runtime.now() / 300000) % 2) candidates.reverse();
  for (const candidate of candidates) {
    if (await runtime.request('/' + C.periods + '/' + candidate.id)) continue;
    // Do not change the date-selected track because a target is temporarily missing.
    // Clients use the same bundled rotation; only server-verified targets enable scoring.
    {
      const trackId = candidate.trackId;
      const targetMs = await targetForTrack(trackId);
      if (!Number.isSafeInteger(targetMs) || targetMs < 1 || targetMs > L.timeMs) continue;
      const period = eventPeriod({ ...candidate, trackId, enabled: true, targetMs, capacity, graceMs: 86400000, eligibility: 'best-submitted-during-period' });
      await runtime.service.createPeriod(period, { currentUtc: true });
      return { created: period.id };
    }
  }
  return { created: null, reason: 'no_verified_target_in_bounded_scan' };
}
