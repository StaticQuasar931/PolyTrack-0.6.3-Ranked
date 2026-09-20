import { createEventService, EVENT_COLLECTIONS as C, EVENT_LIMITS as L, eventPeriod } from './events.js';
import { createEventFirestoreStore, eventDecode } from './events-store.js';

export function eventRuntime(request, { projectId = 'polytrack-052', now = Date.now } = {}) {
  const store = createEventFirestoreStore({ request, projectId, retries: 0 });
  return { store, service: createEventService({ store, now }), request, projectId, now };
}
const decode = doc => eventDecode({ mapValue: { fields: doc.fields || {} } });
const post = (runtime, path, body) => runtime.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
export const eventReceiptRetry = code => ['event_queue_capacity', 'event_replay_capacity'].includes(code);
export async function cleanupEvents(runtime) {
  const doc = await runtime.request('/' + C.catalog + '/main');
  const periods = doc ? decode(doc).periods || [] : [], at = runtime.now();
  const target = periods.find(p => p.archived && (p.cleaned && p.extrasCleaned ? at >= p.endsAt + L.retentionMs : at >= p.endsAt + p.graceMs + 7 * 86400000));
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
  return target ? runtime.service.cleanupPeriod(target.id) : { idle: true };
}
export async function inboxPage(runtime, { projected = false, limit = 1 } = {}) {
  if (limit !== 1) throw Error('Event inbox page must be one');
  const raw = await runtime.request('/' + C.cursors + '/scan');
  const cursor = raw ? decode(raw) : null;
  const query = { from: [{ collectionId: C.inbox }], orderBy: [
    { field: { fieldPath: 'receivedAt' }, direction: 'ASCENDING' },
    { field: { fieldPath: '__name__' }, direction: 'ASCENDING' }], limit };
  if (cursor) query.startAt = { before: false, values: [
    { timestampValue: cursor.receivedAt.__firestoreTimestamp }, { referenceValue: cursor.name }] };
  if (projected) query.select = { fields: [{ fieldPath: 'receivedAt' }] };
  const result = await post(runtime, ':runQuery', { structuredQuery: query });
  if (!Array.isArray(result)) throw Error('Unexpected event inbox query response');
  return { cursor, documents: result.filter(row => row.document).map(row => row.document) };
}
export async function consumeEventInbox(runtime, { preferRetry = false } = {}) {
  const { cursor, documents } = await inboxPage(runtime);
  let retryDoc = preferRetry ? await dueRetry(runtime) : null;
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
  let result;
  try { result = await runtime.service.consumeInbox(data); }
  catch (error) {
    // Infrastructure errors leave the scan cursor untouched for retry. Terminal
    // receipt rejection is recorded privately, never by modifying the client PB.
    const retry = eventReceiptRetry(error.code);
    if (![400, 403, 404, 409, 429].includes(error.status) && error.code !== 'events_disabled') throw error;
    result = { status: error.code, rejected: !retry, retry };
  }
  await runtime.store.transaction(async tx => {
    const path = C.cursors + '/scan', current = await tx.get(path);
    const receiptPath = C.cursors + '/' + inboxId, receipt = await tx.get(receiptPath);
    const statusPath = C.receipts + '/' + inboxId, previousStatus = await tx.get(statusPath);
    const retryPath = C.retries + '/' + inboxId, previousRetry = await tx.get(retryPath);
    const currentInbox = await tx.get(C.inbox + '/' + inboxId);
    const same = currentInbox?.attemptId === data.attemptId &&
      currentInbox.receivedAt?.__firestoreTimestamp === data.receivedAt?.__firestoreTimestamp;
    if (same && result.retry) await tx.set(retryPath, { inboxId, attemptId: data.attemptId,
      receivedAt: data.receivedAt, notBefore: runtime.now() + 60000 });
    else if (previousRetry && (!retryDoc || previousRetry.attemptId === decode(retryDoc).attemptId)) await tx.delete(retryPath);
    if (same && result.rejected && receipt?.attemptId !== data.attemptId) await tx.set(receiptPath,
      { attemptId: data.attemptId, receivedAt: data.receivedAt, status: result.status, runId: null });
    if (same && (result.rejected || result.retry) && (!previousStatus || data.timeMs <= previousStatus.timeMs)) await tx.set(statusPath,
      { ownerUid: data.ownerUid, accountId: data.accountId, periodId: data.periodId, attemptId: data.attemptId,
        timeMs: data.timeMs, status: result.retry ? 'waiting' : 'rejected', reason: result.status, updatedAt: runtime.now() });
    if (!retryDoc && JSON.stringify(current) === JSON.stringify(cursor)) await tx.set(path, { name: doc.name, receivedAt: data.receivedAt });
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

export async function eventWork(runtime, { projectedInbox = true } = {}) {
  const raw = await runtime.request('/' + C.catalog + '/main');
  const periods = raw ? decode(raw).periods || [] : [];
  const at = runtime.now();
  // Daily+weekly generate at most eleven live or draining periods in this window.
  const active = periods.filter(p => p.enabled === true && !p.cleaned && p.startsAt <= at && at < p.endsAt + p.graceMs + 7 * 86400000).slice(0, 16);
  const due = [];
  for (const p of active) {
    const queue = await runtime.request('/' + C.queues + '/' + p.id);
    if (queue && (decode(queue).slots || []).some(s => s.notBefore <= at && s.leaseUntil <= at && s.attempts < L.verificationAttempts)) due.push(p.id);
  }
  const inbox = await inboxPage(runtime, { projected: projectedInbox });
  const retry = inbox.documents.length ? null : await dueRetry(runtime);
  const closing = periods.find(p => !p.archived && at >= p.endsAt + p.graceMs);
  if (due.length) { const rotation = Math.floor(at / 900000) % due.length; due.push(...due.splice(0, rotation)); }
  return { hasWork: !!(due.length || inbox.documents.length || retry || closing), periodIds: due, inbox: inbox.documents.length > 0 || !!retry, archiveId: closing?.id || null };
}

export function utcEventCandidates(at, officialIds, allIds) {
  if (!Number.isSafeInteger(at) || at < 0 || !officialIds.length || !allIds.length) throw Error('Invalid event registry/clock');
  const day = Math.floor(at / 86400000) * 86400000;
  const monday = day - ((new Date(day).getUTCDay() + 6) % 7) * 86400000;
  const key = ms => new Date(ms).toISOString().slice(0, 10).replaceAll('-', '');
  const communityIds=allIds.filter(id=>!officialIds.includes(id));
  return [
    ...(communityIds.length ? [{ id: 'd_' + key(day), kind: 'daily', startsAt: day, endsAt: day + 86400000, maxRp: 100, trackId: communityIds[Number(key(day)) % communityIds.length] }] : []),
    { id: 'w_' + key(monday), kind: 'weekly', startsAt: monday, endsAt: monday + 7 * 86400000, maxRp: 500, trackId: officialIds[(Number(key(monday)) * 17 + 11) % officialIds.length] }
  ];
}

// Provision at most one period per invocation. Target is frozen from a
// physics-verified registered leaderboard entry, never a client-supplied score.
export async function provisionEvent(runtime, { officialIds, allIds, capacity, targetForTrack }) {
  const candidates = utcEventCandidates(runtime.now(), officialIds, allIds);
  if (Math.floor(runtime.now() / 300000) % 2) candidates.reverse();
  for (const candidate of candidates) {
    if (await runtime.request('/' + C.periods + '/' + candidate.id)) continue;
    const registry = candidate.kind === 'daily' ? allIds.filter(id=>!officialIds.includes(id)) : officialIds;
    const cursorPath = C.cursors + '/provision_' + candidate.id;
    const raw = await runtime.request('/' + cursorPath), prior = raw ? decode(raw) : null;
    const offset = prior?.offset || 0, start = registry.indexOf(candidate.trackId);
    for (let i = 0; i < Math.min(2, registry.length); i++) {
      const trackId = registry[(start + offset + i) % registry.length];
      const targetMs = await targetForTrack(trackId);
      if (!Number.isSafeInteger(targetMs) || targetMs < 1 || targetMs > L.timeMs) continue;
      const period = eventPeriod({ ...candidate, trackId, enabled: true, targetMs, capacity, graceMs: 86400000, eligibility: 'best-submitted-during-period' });
      await runtime.service.createPeriod(period, { currentUtc: true });
      return { created: period.id };
    }
    await runtime.store.transaction(async tx => {
      const current = await tx.get(cursorPath);
      if (JSON.stringify(current) === JSON.stringify(prior)) await tx.set(cursorPath, { offset: (offset + 2) % registry.length });
    });
    return { created: null, reason: 'no_verified_target_in_bounded_scan', kind: candidate.kind };
  }
  return { created: null };
}
