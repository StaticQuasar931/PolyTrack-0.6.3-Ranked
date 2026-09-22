import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { createEventService, createEventHandler, eventPeriod, eventRp, eventLeaderboard, publicEventPeriod,
  EVENT_COLLECTIONS as C, EVENT_LIMITS as L } from '../src/events.js';
import { createEventFirestoreStore, eventEncode, eventDecode } from '../src/events-store.js';
import { VERIFIER_ENGINE_DIGEST as engine, VERIFIER_VERSION as version } from '../src/verification.js';
import { utcEventCandidates, inboxPage, consumeEventInbox, cleanupEvents, eventReceiptRetry, eventWork, provisionEvent } from '../src/events-runtime.js';

const account = 'b'.repeat(64), track = 'a'.repeat(64);
const hash = value => createHash('sha256').update(value).digest('hex');
const replay = deflateSync(Buffer.alloc(15)).toString('base64url');
const capacity = { policyVersion: 'test-reviewed-v1', entrants: 200, admissionsPerPeriod: 512,
  replayBytesPerPeriod: 8388608, minIntervalMs: 1000, verificationsPerDay: 128 };
const inputPeriod = { id: 'day1', enabled: true, trackId: track, startsAt: 1000, endsAt: 86401000,
  graceMs: 3600000, targetMs: 10000, maxRp: 1000, capacity, eligibility: 'best-submitted-during-period' };
const p = eventPeriod(inputPeriod);
test('only temporary outstanding queue/storage pressure retries fixed receipts', () => {
  assert(eventReceiptRetry('event_queue_capacity'));
  assert(eventReceiptRetry('event_replay_capacity'));
  for (const code of ['event_submit_rate', 'event_admission_capacity', 'event_entrant_capacity', 'event_closed']) {
    assert.equal(eventReceiptRetry(code), false);
  }
});
test('disabled periods do not wake verifier and malformed query fails closed', async () => {
  const calls = [];
  const runtime = { now: () => 2000, request: async path => {
    calls.push(path);
    if (path.endsWith('/main')) return { fields: eventEncode({ periods: [{ ...p, enabled: false }] }).mapValue.fields };
    if (path.endsWith('/scan')) return null;
    return [];
  }};
  assert.equal((await eventWork(runtime)).hasWork, false);
  assert.equal(calls.some(path => path.includes(C.queues)), false);
  await assert.rejects(inboxPage({ request: async () => null }), /Unexpected/);
});
test('UTC daily uses community and weekly uses official without overlap', () => {
  const at = Date.UTC(2026, 8, 13, 23, 59);
  const official = ['a', 'b', 'c'], all = ['z', 'x', 'a', 'b', 'c'];
  const [day, week] = utcEventCandidates(at, official, all);
  assert.equal(day.id, 'd_20260913'); assert.equal(week.id, 'w_20260907');
  assert.equal(day.trackId, ['z','x'][20260913 % 2]);
  assert.equal(week.trackId, official[(20260907 * 17 + 11) % 3]);
  assert.equal(day.maxRp, 100); assert.equal(week.maxRp, 500);
  assert.equal(day.endsAt - day.startsAt, 86400000);
  assert.equal(week.endsAt - week.startsAt, 7 * 86400000);
});
test('UTC daily rotation avoids consecutive community track repeats when alternatives exist', () => {
  const community = ['community-a', 'community-b', 'community-c'];
  let previous = null;
  for (let day = 1; day <= 365; day += 1) {
    const at = Date.UTC(2026, 0, day);
    const [daily] = utcEventCandidates(at, ['official'], [...community, 'official']);
    assert(community.includes(daily.trackId));
    if (previous !== null) assert.notEqual(daily.trackId, previous, new Date(at).toISOString());
    previous = daily.trackId;
  }
  const [singleTrack] = utcEventCandidates(Date.UTC(2026, 0, 2), ['official'], ['community', 'official']);
  assert.equal(singleTrack.trackId, 'community');
});
test('inbox projection scans strictly after timestamp plus document name, bounded to one', async () => {
  const cursor = { receivedAt: { __firestoreTimestamp: '2026-09-12T00:00:00.123456Z' }, name: 'projects/test/documents/inbox/a' };
  let query;
  const runtime = { request: async (path, init) => {
    if (path.endsWith('/scan')) return { fields: eventEncode(cursor).mapValue.fields };
    query = JSON.parse(init.body).structuredQuery; return [];
  }};
  await inboxPage(runtime, { projected: true });
  assert.equal(query.limit, 1); assert.equal(query.startAt.before, false);
  assert.deepEqual(query.select.fields, [{ fieldPath: 'receivedAt' }]);
  assert.equal(query.startAt.values[0].timestampValue, cursor.receivedAt.__firestoreTimestamp);
  assert.equal(query.startAt.values[1].referenceValue, cursor.name);
});
function verdict(job, override = {}) {
  return { resultId: job.resultId, timeMs: job.timeMs, trackId: job.trackId,
    replayHash: job.replayHash, status: 'verified', reason: 'native_exact_finish', engineDigest: engine,
    binding: { resultId: job.resultId, timeMs: job.timeMs, trackId: job.trackId, nativeTrackId: job.trackId,
      replayHash: job.replayHash, actualReplayHash: job.replayHash, engineDigest: engine, verifierVersion: version }, ...override };
}
function kodubVerdict(job, trackContentHash) {
  const result = verdict(job);
  result.binding.trackContentHash = trackContentHash;
  return result;
}
function memoryStore() {
  const data = new Map(), counts = []; let serial = Promise.resolve(), failPath = null;
  return { data, counts, fail: value => { failPath = value; }, transaction(fn) {
    const operation = serial.then(async () => {
      const copy = structuredClone(data), reads = new Set(); let writing = false, writes = 0;
      const write = (k, v, mode) => {
        if (k === failPath) throw Error('simulated_write_failure');
        writing = true;
        assert(++writes <= 16, 'bounded transaction writes');
        if (mode !== 'create') assert(reads.has(k), 'write requires a read');
        if (mode === 'create' && copy.has(k)) throw Error('already_exists');
        if (mode === 'delete') copy.delete(k);
        else copy.set(k, structuredClone(mode === 'patch' ? { ...copy.get(k), ...v } : v));
      };
      const result = await fn({ get: async k => { assert(!writing, 'all reads before writes'); reads.add(k); assert(reads.size <= 16, 'bounded transaction reads'); return structuredClone(copy.get(k) || null); },
        create: (k, v) => write(k, v, 'create'), set: (k, v) => write(k, v, 'set'),
        patch: (k, v) => write(k, v, 'patch'), delete: k => write(k, null, 'delete') });
      counts.push({ reads: reads.size, writes });
      data.clear(); for (const [k, v] of copy) data.set(k, v); return result;
    });
    serial = operation.catch(() => {}); return operation;
  }};
}
function fixture() {
  const store = memoryStore(); let time = 0, nonce = 0;
  store.data.set(`${C.profiles}/${account}`, { accountId: account, ownerUid: 'user1', name: 'Native Racer' });
  const service = createEventService({ store, now: () => time, hash, randomId: () => `lease_${nonce++}` });
  return { service, store, data: store.data, time: t => { time = t; }, advance: () => { time += 1000; },
    async start() { await service.bindOwner('user1', account); await service.createPeriod(inputPeriod); time = 1000; },
    submit: (ms = 20402, attemptId = 'run1', extra = {}) => service.submit('day1', 'user1', {
      accountId: account, trackId: track, attemptId, timeMs: ms, frames: ms, replay, carStyle: 'test', ...extra }),
    run: runId => store.data.get(`${C.runs}/${runId}`),
    canonical: () => store.data.get(`${C.canonical}/${account}_${track}`),
    async publish() { return service.processBatch('day1', async jobs => jobs.map(j => verdict(j))); }
  };
}

async function clockRejectedFixture() {
  const f = fixture(); await f.start(); f.time(10000);
  const key = 'day1_' + account;
  const inbox = { periodId: 'day1', ownerUid: 'user1', accountId: account, trackId: track,
    attemptId: 'clock-rejected', timeMs: 20402, frames: 20402, replay, carStyle: '',
    receivedAt: { __firestoreTimestamp: new Date(2000).toISOString() } };
  f.data.set(`${C.inbox}/${key}`, inbox);
  f.data.set(`${C.cursors}/${key}`, { attemptId: inbox.attemptId, receivedAt: inbox.receivedAt, status: 'inbox_receipt_expired', runId: null });
  f.data.set(`${C.receipts}/${key}`, { periodId: 'day1', ownerUid: 'user1', accountId: account,
    attemptId: inbox.attemptId, timeMs: inbox.timeMs, status: 'rejected', reason: 'inbox_receipt_expired', updatedAt: 1000 });
  return { f, inbox, key };
}
test('clock recovery preserves exact attempt/time/receipt and charges admission once', async () => {
  const { f, inbox, key } = await clockRejectedFixture();
  const result = await f.service.consumeInbox(inbox);
  assert.equal(result.status, 'waiting'); assert.equal(result.duplicate, false);
  assert.equal(f.run(result.runId).receivedAt, 2000);
  assert.equal(f.run(result.runId).timeMs, 20402);
  assert.equal(f.run(result.runId).attemptId, inbox.attemptId);
  assert.deepEqual(f.run(result.runId).clockRecovery, { rejectedAt: 1000, recoveredAt: 10000 });
  assert.deepEqual(f.data.get(`${C.inbox}/${key}`), inbox);
  assert.equal(f.data.get(`${C.receipts}/${key}`).status, 'waiting');
  assert.equal(f.data.get(`${C.receipts}/${key}`).reason, '');
  assert.equal(f.canonical(), undefined); assert.deepEqual((await f.service.totals()).entries, []);
  assert.equal((await f.service.consumeInbox(inbox)).duplicate, true);
  assert.equal(f.data.get(`${C.queues}/day1`).admitted, 1);
});
test('genuinely expired or unrelated terminal cursors cannot be resurrected', async () => {
  for (const change of ['rejection-time', 'reason', 'cursor-status', 'attempt']) {
    const { f, inbox, key } = await clockRejectedFixture();
    const receipt = f.data.get(`${C.receipts}/${key}`);
    if (change === 'rejection-time') receipt.updatedAt = 3000;
    if (change === 'reason') receipt.reason = 'event_entrant_capacity';
    if (change === 'cursor-status') f.data.get(`${C.cursors}/${key}`).status = 'mismatch';
    if (change === 'attempt') receipt.attemptId = 'newer';
    assert.equal((await f.service.consumeInbox(inbox)).duplicate, true);
    assert.equal(f.data.get(`${C.queues}/day1`).admitted, 0);
  }
});
test('clock recovery still enforces original window, settlement, archive, quota and ownership', async () => {
  for (const change of ['closed', 'archived', 'rate', 'capacity', 'owner', 'superseded', 'outside-window']) {
    const { f, inbox, key } = await clockRejectedFixture();
    if (change === 'closed') f.time(p.endsAt + p.graceMs);
    if (change === 'archived') f.data.set(`${C.archives}/day1`, { immutable: true });
    if (change === 'rate') f.data.set(`${C.quotas}/day1_${hash('user1')}`, { accountId: account, lastAt: 1999, count: 1 });
    if (change === 'capacity') f.data.get(`${C.queues}/day1`).admitted = p.capacity.admissionsPerPeriod;
    if (change === 'owner') f.data.get(`${C.profiles}/${account}`).ownerUid = 'someone-else';
    if (change === 'superseded') f.data.set(`${C.inbox}/${key}`, { ...inbox, attemptId: 'newer', timeMs: 15000, frames: 15000 });
    if (change === 'outside-window') f.data.set(`${C.periods}/day1`, eventPeriod({ ...inputPeriod, startsAt: 3000 }));
    const before = structuredClone(f.data);
    await assert.rejects(f.service.consumeInbox(inbox));
    assert.deepEqual(f.data, before, change);
  }
});
test('clock recovery transaction conflict cannot half-clear receipt or charge quota', async () => {
  const { f, inbox } = await clockRejectedFixture();
  const before = structuredClone(f.data);
  f.store.fail(`${C.queues}/day1`);
  await assert.rejects(f.service.consumeInbox(inbox), /simulated_write_failure/);
  assert.deepEqual(f.data, before);
});
test('inbox exact receipt is guarded, newer PB preserved, private cursor idempotent', async () => {
  const f = fixture(); await f.start(); f.time(10000);
  const key = `${C.inbox}/day1_${account}`;
  const inbox = { periodId: 'day1', accountId: account, ownerUid: 'user1', trackId: track,
    attemptId: 'school1', timeMs: 20402, frames: 20402, replay, carStyle: '',
    receivedAt: { __firestoreTimestamp: new Date(2000).toISOString() } };
  f.data.set(key, inbox);
  const accepted = await f.service.consumeInbox(inbox);
  assert.equal(accepted.status, 'waiting'); assert.deepEqual(f.data.get(key), inbox);
  assert.equal((await f.service.consumeInbox(inbox)).duplicate, true);
  const next = { ...inbox, attemptId: 'school2', timeMs: 15000, frames: 15000,
    receivedAt: { __firestoreTimestamp: new Date(8000).toISOString() } };
  f.data.set(key, next);
  await assert.rejects(f.service.consumeInbox(inbox), /superseded/);
  assert.deepEqual(f.data.get(key), next);
  await f.service.consumeInbox(next);
  assert.deepEqual(f.data.get(key), next);
  assert.equal(f.data.get(`${C.cursors}/day1_${account}`).attemptId, 'school2');
});
test('disabled periods reject both direct and fallback intake', async () => {
  const f = fixture(); await f.start();
  f.data.set(`${C.periods}/day1`, { ...p, enabled: false });
  await assert.rejects(f.submit(), /events_disabled/);
});
test('cumulative event RP is delta-only and repeated runs never stack', async () => {
  const f = fixture(); await f.start(); await f.submit(20000); await f.publish();
  assert.equal((await f.service.totals()).entries[0].rp, 500);
  f.advance(); await f.submit(10000, 'faster'); await f.publish();
  const total = (await f.service.totals()).entries[0];
  assert.equal(total.rp, 1000); assert.equal(total.events, 1);
  await f.publish(); assert.deepEqual((await f.service.totals()).entries[0], total);
});
test('owner receipt explains verdict and older completion cannot replace latest attempt', async () => {
  const f = fixture(); await f.start(); await f.submit(20000, 'first'); f.advance(); await f.submit(15000, 'latest');
  const jobs = await f.service.leaseJobs('day1');
  await f.service.completeJob('day1', jobs[0], verdict(jobs[0], { status: 'mismatch', reason: 'finish_mismatch' }));
  let receipt = await f.service.ownReceipt('day1', 'user1', account);
  assert.equal(receipt.attemptId, 'latest'); assert.equal(receipt.status, 'waiting');
  await f.service.completeJob('day1', jobs[1], verdict(jobs[1]));
  receipt = await f.service.ownReceipt('day1', 'user1', account);
  assert.equal(receipt.status, 'verified'); assert.equal(receipt.reason, 'native_exact_finish');
  assert.equal(receipt.timeMs, 15000);
  await assert.rejects(f.service.ownReceipt('day1', 'intruder', account), /not_owned/);
  assert.equal('replay' in receipt, false);
  assert(f.store.counts.some(count => count.writes >= 10));
  assert(f.store.counts.every(count => count.writes <= 16));
});
test('due retry progresses even with an unending fresh inbox page', async () => {
  const store = memoryStore(), freshId = 'day1_' + account, retryId = 'day1_' + 'c'.repeat(64);
  const data = id => ({ periodId: 'day1', accountId: id, attemptId: id.slice(0, 4),
    receivedAt: { __firestoreTimestamp: '2026-09-12T00:00:00Z' } });
  store.data.set(`${C.inbox}/${freshId}`, data(account));
  store.data.set(`${C.inbox}/${retryId}`, data('c'.repeat(64)));
  store.data.set(`${C.retries}/${retryId}`, { inboxId: retryId, attemptId: 'cccc', notBefore: 0 });
  const doc = path => ({ name: 'projects/test/databases/(default)/documents/' + path, fields: eventEncode(store.data.get(path)).mapValue.fields });
  const consumed = [], runtime = { store, now: () => 1000,
    service: { consumeInbox: async row => { consumed.push(row.accountId); return { status: 'waiting' }; } },
    request: async (path, init) => {
      if (path === ':runQuery') {
        const collection = JSON.parse(init.body).structuredQuery.from[0].collectionId;
        return collection === C.inbox ? [{ document: doc(`${C.inbox}/${freshId}`) }] :
          store.data.has(`${C.retries}/${retryId}`) ? [{ document: doc(`${C.retries}/${retryId}`) }] : [];
      }
      const key = path.slice(1); return store.data.has(key) ? doc(key) : null;
    } };
  await consumeEventInbox(runtime, { preferRetry: true });
  await consumeEventInbox(runtime, { preferRetry: false });
  assert.deepEqual(consumed, ['c'.repeat(64), account]);
  assert.equal(store.data.has(`${C.retries}/${retryId}`), false);
});
test('waiting runs can drain after archive without changing event RP or archive', async () => {
  const f = fixture(); await f.start(); await f.submit(20402);
  f.time(p.endsAt + p.graceMs); await f.service.archivePeriod('day1');
  const archive = structuredClone(await f.service.snapshot('day1'));
  const [job] = await f.service.leaseJobs('day1'); assert(job);
  const result = await f.service.completeJob('day1', job, verdict(job));
  assert.equal(result.eventImproved, false); assert.equal(result.canonicalImproved, true);
  assert.equal(f.canonical().timeMs, 20402);
  assert.deepEqual(await f.service.snapshot('day1'), archive);
  assert.deepEqual((await f.service.totals()).entries, []);
  f.time(p.endsAt + p.graceMs + 7 * 86400000);
  assert.deepEqual(await f.service.leaseJobs('day1'), []);
});
test('cleanup is bounded; public archives and monthly indexes remain permanent', async () => {
  const f = fixture(); await f.start();
  for (let i = 0; i < 10; i++) { await f.submit(30000 - i, 'cleanup' + i); await f.publish(); f.advance(); }
  const canonical = structuredClone(f.canonical()), totals = await f.service.totals();
  f.time(p.endsAt + p.graceMs); await f.service.archivePeriod('day1');
  await assert.rejects(f.service.cleanupPeriod('day1'), /retention_open/);
  f.time(p.endsAt + p.graceMs + 7 * 86400000);
  let result;
  for (let i = 0; i < 5; i++) { result = await f.service.cleanupPeriod('day1'); assert((result.deleted || 0) <= 8); if (result.cleaned) break; }
  assert.equal(result.cleaned, true);
  assert.equal(f.data.has(`${C.replays}/day1_${account}`), true, 'verified replay outlives transient cleanup');
  assert.equal(f.data.has(`${C.queues}/day1`), false);
  assert.equal(f.data.get(`${C.public}/day1`).archived, true);
  assert.deepEqual(f.canonical(), canonical); assert.deepEqual(await f.service.totals(), totals);
  f.time(p.endsAt + 90 * 86400000);
  assert.equal((await f.service.cleanupPeriod('day1')).extrasPending, true);
  assert.equal(f.data.has(`${C.periods}/day1`), true);
  assert.equal(f.data.get(`${C.catalog}/main`).periods.some(row => row.id === 'day1'), true);
  // Only the completed bounded supplemental sweep unlocks metadata pruning.
  f.data.get(`${C.catalog}/main`).periods.find(row => row.id === 'day1').extrasCleaned = true;
  assert.equal((await f.service.cleanupPeriod('day1')).replaysPending, true);
  f.data.delete(`${C.replays}/day1_${account}`);
  f.data.get(`${C.catalog}/main`).periods.find(row => row.id === 'day1').replaysCleaned = true;
  assert.equal((await f.service.cleanupPeriod('day1')).purged, true);
  assert.equal(f.data.get(`${C.public}/day1`).archived, true);
  assert.deepEqual((await f.service.catalog()).archives, []);
  const month = new Date(p.endsAt).toISOString().slice(0, 7).replace('-', '');
  assert.deepEqual((await f.service.archiveMonth(month)).periods, [publicEventPeriod({ ...p, racerCount: 1 })]);
  assert.equal((await f.service.snapshot('day1')).period.id, 'day1');
  assert.equal(f.data.has(`${C.periods}/day1`), false);
  assert.deepEqual(f.canonical(), canonical); assert.deepEqual(await f.service.totals(), totals);
});
test('cleanup sweeps rejected inbox records absent from admitted subject registry', async () => {
  const store = memoryStore(), key = `${C.inbox}/day1_${account}`;
  store.data.set(key, { attemptId: 'never-admitted' });
  store.data.set(`${C.catalog}/main`, { periods: [{ ...p, archived: true, cleaned: true }] });
  let limit;
  const doc = path => ({ name: 'projects/polytrack-052/databases/(default)/documents/' + path,
    fields: eventEncode(store.data.get(path)).mapValue.fields });
  const runtime = { store, projectId: 'polytrack-052', now: () => p.endsAt + p.graceMs + 8 * 86400000,
    request: async (path, init) => {
      if (path === ':runQuery') { const query = JSON.parse(init.body).structuredQuery; limit = query.limit;
        return store.data.has(key) ? [{ document: doc(key) }] : []; }
      return doc(path.slice(1));
    } };
  assert.equal((await cleanupEvents(runtime)).deleted, 1); assert.equal(limit, 8);
  assert.equal(store.data.has(key), false);
  await cleanupEvents(runtime);
  assert.equal(store.data.get(`${C.catalog}/main`).periods[0].cleanupPhase, 1);
});
test('retained replay cleanup is bounded to eight documents per maintenance unit', async () => {
  const store = memoryStore(), endedAt = 1000;
  store.data.set(`${C.catalog}/main`, { periods: [{ id: 'old', archived: true, cleaned: true, extrasCleaned: true,
    endsAt: endedAt, graceMs: 0 }] });
  const replayKeys = Array.from({ length: 10 }, (_, i) => `${C.replays}/old_${String(i).padStart(64, '0')}`);
  for (const key of replayKeys) store.data.set(key, { replay: 'AAAA' });
  const document = key => ({ name: `projects/polytrack-052/databases/(default)/documents/${key}`,
    fields: eventEncode(store.data.get(key)).mapValue.fields });
  const runtime = { store, projectId: 'polytrack-052', now: () => endedAt + L.retentionMs,
    request: async (route, init) => {
      if (route === `/${C.catalog}/main`) return document(`${C.catalog}/main`);
      if (route === ':runQuery') {
        const query = JSON.parse(init.body).structuredQuery;
        assert.equal(query.from[0].collectionId, C.replays); assert.equal(query.limit, 8);
        return replayKeys.filter(key => store.data.has(key)).slice(0, 8).map(key => ({ document: document(key) }));
      }
      throw Error('unexpected request');
    } };
  assert.deepEqual(await cleanupEvents(runtime), { replayCleanup: true, deleted: 8 });
  assert.deepEqual(await cleanupEvents(runtime), { replayCleanup: true, deleted: 2 });
  assert.deepEqual(await cleanupEvents(runtime), { replayCleanup: true, deleted: 0 });
  assert.equal(store.data.get(`${C.catalog}/main`).periods[0].replaysCleaned, true);
});
test('target fallback performs at most two lookups and never invents a target', async () => {
  const at = Date.UTC(2026, 8, 12), officialIds = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];
  const lookups = [], store = memoryStore(); let created;
  const runtime = { now: () => at, store, request: async () => null,
    service: { createPeriod: async p => { created = p; } } };
  const options = { officialIds, allIds: officialIds, capacity, targetForTrack: async id => { lookups.push(id); return lookups.length === 2 ? 20402 : null; } };
  await provisionEvent(runtime, options);
  assert.equal(lookups.length, 2); assert.equal(created.targetMs, 20402); assert.equal(created.trackId, lookups[1]);
  created = null; lookups.length = 0;
  const result = await provisionEvent(runtime, { ...options, targetForTrack: async id => { lookups.push(id); return null; } });
  assert.equal(lookups.length, 2); assert.equal(created, null); assert.equal(result.created, null);
});
test('canonical event promotion uses receipt time, not delayed verifier time', async () => {
  const f = fixture(); await f.start(); await f.submit(); f.time(50000); await f.publish();
  assert.equal(f.canonical().pbAt, 1000); assert.equal(f.canonical().createdAt, 1000); assert.equal(f.canonical().updatedAt, 50000);
});
test('reviewed policy is mandatory, period is immutable, and RP is bounded with tied ranks', async () => {
  assert.throws(() => eventPeriod({ ...inputPeriod, capacity: undefined }), /reviewed_capacity/);
  assert.throws(() => eventPeriod({ ...inputPeriod, maxRp: 1001 }), /scoring/);
  assert.throws(() => eventPeriod({ ...inputPeriod, endsAt: 900000000 }), /window/);
  assert(Object.isFrozen(p)); assert(Object.isFrozen(p.capacity));
  assert.equal(eventRp(p, 20402), 490); assert.equal(eventRp(p, 1000), 1000);
  const rows = eventLeaderboard(p, [{ accountId: account, timeMs: 10000 }, { accountId: 'c'.repeat(64), timeMs: 10000 }, { accountId: 'd'.repeat(64), timeMs: 20000 }]);
  assert.deepEqual(rows.map(r => r.rank), [1, 1, 3]);
  const f = fixture(); await f.start();
  await assert.rejects(f.service.createPeriod(inputPeriod), /future/);
  f.time(0); await assert.rejects(f.service.createPeriod({ ...inputPeriod, maxRp: 1 }), /immutable/);
  await assert.rejects(f.service.createPeriod({ ...inputPeriod, id: 'overlap' }), /overlap/);
});

test('immutable ownership requires existing profile owner; client identity mismatch is rejected', async () => {
  const f = fixture(); await f.start();
  await assert.rejects(f.service.bindOwner('attacker', account), /immutable/);
  await assert.rejects(f.service.bindOwner('user1', 'e'.repeat(64)), /profile_not_owned/);
  await assert.rejects(f.service.submit('day1', 'attacker', { accountId: account, trackId: track, attemptId: 'r', timeMs: 1, frames: 1, replay }), /not_owned/);
  await assert.rejects(f.submit(100, 'r', { trackId: 'e'.repeat(64) }), /track_mismatch/);
  await assert.rejects(f.submit(100, 'r', { frames: 340033 }), /native_time/);
});

test('non-all-time PB receives separate verified event PB without changing canonical PB', async () => {
  const f = fixture(); await f.start();
  f.data.set(`${C.canonical}/${account}_${track}`, { ownerUid: 'user1', accountId: account, trackId: track, timeMs: 10000, frames: 10000, replay: 'old', custom: 'preserve' });
  const intake = await f.submit(20402, 'run1', { verified: true, rp: 999999, ownerUid: 'attacker' });
  assert.deepEqual(f.data.get(`${C.live}/day1`).entries, []);
  const [result] = await f.publish();
  assert.equal(result.eventImproved, true); assert.equal(result.canonicalImproved, false);
  assert.equal(f.canonical().replay, 'old');
  assert.equal(f.data.get(`${C.pbs}/day1_${account}`).timeMs, 20402);
  assert.equal((await f.service.snapshot('day1')).entries[0].rp, 490);
  assert.equal(f.run(intake.runId).status, 'verified');
  assert.equal(f.run(intake.runId).timeMs, 20402);
});

test('only verified event PB replays are retained, replaced and publicly readable', async () => {
  const f = fixture(); await f.start();
  const pending = await f.submit();
  await assert.rejects(f.service.replay('day1', account), /event_replay_not_found/);
  await f.publish();
  const first = await f.service.replay('day1', account);
  assert.deepEqual(first, { periodId: 'day1', accountId: account, trackId: track, runId: pending.runId,
    timeMs: 20402, frames: 20402, replayHash: hash(replay), replay, carStyle: 'test', verifiedAt: 1000,
    verificationStatus: 'verified', verified: true, eventRpEligible: true, source: 'verified-event-recording' });
  assert.equal(f.run(pending.runId).replay, null, 'terminal candidate replay is still cleared');
  f.advance(); const faster = await f.submit(15000, 'faster');
  assert.equal((await f.service.replay('day1', account)).runId, pending.runId, 'pending run cannot replace replay');
  await f.publish();
  assert.equal((await f.service.replay('day1', account)).runId, faster.runId);
  let auth = 0;
  const handler = createEventHandler({ service: f.service, authenticate: async () => { auth++; return 'unused'; },
    allowedOrigins: new Set(['https://game.test']), allowRequest: async () => true, enabled: () => true });
  const response = await handler(new Request(`https://worker.test/v1/events/day1/replays/${account}`, { headers: { Origin: 'https://game.test' } }));
  assert.equal(response.status, 200); assert.equal(auth, 0);
  assert.deepEqual(await response.json(), await f.service.replay('day1', account));
});

test('only pre-verification recordings are public; rejected recordings disappear without entering RP', async () => {
  const f = fixture(); await f.start();
  const pending = await f.submit();
  const pendingPlayback = await f.service.playback('day1', pending.runId);
  assert.equal(pendingPlayback.verificationStatus, 'waiting');
  assert.equal(pendingPlayback.verified, false); assert.equal(pendingPlayback.eventRpEligible, false);
  assert.equal((await f.service.snapshot('day1')).entries.length, 0);
  assert.equal((await f.service.snapshot('day1')).pendingPlaybacks[0].runId, pending.runId);
  await f.service.processBatch('day1', async jobs => jobs.map(job => verdict(job, { status: 'mismatch' })));
  await assert.rejects(f.service.playback('day1', pending.runId), /event_playback_not_found/);
  assert.equal(f.data.get(`${C.replays}/day1_run_${pending.runId}`).verificationStatus, 'mismatch');
  assert.deepEqual((await f.service.totals()).entries, []);
  assert.deepEqual((await f.service.snapshot('day1')).entries, []);
  assert.deepEqual((await f.service.snapshot('day1')).pendingPlaybacks, []);
  for (const status of ['rejected','unavailable_final','expired']) {
    f.data.get(`${C.replays}/day1_run_${pending.runId}`).verificationStatus = status;
    await assert.rejects(f.service.playback('day1', pending.runId), /event_playback_not_found/);
  }
});

test('rejected and identity-inconsistent replay records fail closed', async () => {
  const rejected = fixture(); await rejected.start(); await rejected.submit();
  await rejected.service.processBatch('day1', async jobs => jobs.map(job => verdict(job, { status: 'mismatch' })));
  await assert.rejects(rejected.service.replay('day1', account), /event_replay_not_found/);
  const f = fixture(); await f.start(); await f.submit(); await f.publish();
  f.data.get(`${C.replays}/day1_${account}`).trackId = 'c'.repeat(64);
  await assert.rejects(f.service.replay('day1', account), /event_replay_corrupt/);
});

test('faster event promotes canonical atomically preserving metadata; no client score trust', async () => {
  const f = fixture(); await f.start();
  f.data.set(`${C.canonical}/${account}_${track}`, { ownerUid: 'user1', accountId: account, trackId: track, timeMs: 30000, frames: 30000,
    metadata: { untouched: true }, createdAt: { __firestoreTimestamp: '2026-01-01T00:00:00.123456789Z' } });
  await f.submit(); const [result] = await f.publish();
  assert(result.canonicalImproved); assert.equal(f.canonical().timeMs, 20402);
  assert.deepEqual(f.canonical().metadata, { untouched: true });
  assert.equal(f.canonical().createdAt, 1000); assert.equal(f.canonical().pbAt, 1000);
  assert.equal(f.canonical().verified, false, 'normal ranked verification remains independently derived');
  assert.equal(f.canonical().replayHash, hash(replay));
  assert.equal(f.canonical().ingestedAt.__eventServerTimestamp, true);
});

test('ambiguous legacy canonical timing is preserved rather than converted or replaced', async () => {
  const f = fixture(); await f.start();
  const row = { ownerUid: 'user1', accountId: account, trackId: track, timeMs: 340033, frames: 20402, replay: 'legacy' };
  f.data.set(`${C.canonical}/${account}_${track}`, row);
  await f.submit(10000); const [result] = await f.publish();
  assert(result.eventImproved); assert(result.canonicalDeferred); assert(!result.canonicalImproved);
  assert.deepEqual(f.canonical(), row);
});

test('same player can set more than eight event PBs; no-improvement capture causes no writes', async () => {
  const f = fixture(); await f.start();
  for (let n = 0; n < 12; n++) { f.advance(); await f.submit(25000 - n, `r${n}`); await f.publish(); }
  assert.equal(f.data.get(`${C.queues}/day1`).admitted, 12);
  assert.equal(f.data.get(`${C.pbs}/day1_${account}`).timeMs, 24989);
  const before = structuredClone(f.data);
  assert.equal((await f.submit(30000, 'slower')).status, 'no_improvement');
  assert.deepEqual(f.data, before);
});

test('idempotent concurrent retries charge once and conflicting attempt cannot overwrite', async () => {
  const f = fixture(); await f.start();
  const [a, b] = await Promise.all([f.submit(), f.submit()]);
  assert.equal(a.runId, b.runId); assert.equal(b.duplicate, true);
  assert.equal(f.data.get(`${C.queues}/day1`).admitted, 1);
  await assert.rejects(f.submit(20403), /attempt_conflict/);
  await f.publish(); f.time(p.endsAt + 1);
  assert.equal((await f.submit()).duplicate, true);
  await assert.rejects(f.submit(10000, 'late'), /closed/);
});

test('capacity is explicit, rate limited, replay bounded, and one account per owner per period', async () => {
  const f = fixture(); await f.start(); await f.submit();
  await assert.rejects(f.submit(10000, 'r2'), /submit_rate/);
  f.advance();
  const other = 'c'.repeat(64);
  f.data.set(`${C.profiles}/${other}`, { ownerUid: 'user1', accountId: other }); await f.service.bindOwner('user1', other);
  await assert.rejects(f.submit(10000, 'r2', { accountId: other }), /one_account/);
  await assert.rejects(f.submit(10000, 'r2', { replay: 'x'.repeat(65537) }), /invalid_replay/);
  f.data.get(`${C.queues}/day1`).replayBytes = p.capacity.replayBytesPerPeriod;
  await assert.rejects(f.submit(10000, 'r2'), /replay_capacity/);
});

test('lease prevents duplicate verifier work; an expired/replaced lease cannot publish', async () => {
  const f = fixture(); await f.start(); await f.submit();
  const [first] = await f.service.leaseJobs('day1');
  assert.deepEqual(await f.service.leaseJobs('day1'), []);
  f.time(1000 + L.leaseMs);
  await assert.rejects(f.service.completeJob('day1', first, verdict(first)), /lease_lost/);
  const [second] = await f.service.leaseJobs('day1');
  await assert.rejects(f.service.completeJob('day1', first, verdict(first)), /lease_lost/);
  assert.equal((await f.service.completeJob('day1', second, verdict(second))).eventImproved, true);
});

test('stale engine, replay, native track or result identity cannot award RP', async () => {
  for (const mutate of [r => ({ ...r, resultId: 'd'.repeat(64) }), r => ({ ...r, timeMs: 1 }),
    r => ({ ...r, engineDigest: 'd'.repeat(64) }), r => ({ ...r, binding: { ...r.binding, actualReplayHash: 'd'.repeat(64) } }),
    r => ({ ...r, binding: { ...r.binding, nativeTrackId: 'd'.repeat(64) } })]) {
    const f = fixture(); await f.start(); await f.submit();
    const [job] = await f.service.leaseJobs('day1');
    await assert.rejects(f.service.completeJob('day1', job, mutate(verdict(job))), /verifier_/);
    assert.deepEqual(f.data.get(`${C.live}/day1`).entries, []); assert.equal(f.canonical(), undefined);
  }
});

test('mismatch never earns RP and unavailable retries have a finite budget', async () => {
  const f = fixture(); await f.start(); const first = await f.submit();
  await f.service.processBatch('day1', async jobs => jobs.map(j => verdict(j, { status: 'mismatch' })));
  assert.equal(f.run(first.runId).status, 'mismatch'); assert.equal(f.canonical(), undefined);
  f.advance(); const second = await f.submit(20000, 'second');
  for (let attempt = 0; attempt < 3; attempt++) {
    f.time(2000 + attempt * L.retryMs);
    await f.service.processBatch('day1', async jobs => jobs.map(j => verdict(j, { status: 'unavailable', engineDigest: null })));
  }
  assert.equal(f.run(second.runId).status, 'unavailable_final');
  assert.deepEqual(f.data.get(`${C.queues}/day1`).slots, []);
});

test('invalid batch is rejected before any result publication, even with valid first result', async () => {
  const f = fixture(); await f.start(); await f.submit(); f.advance(); await f.submit(20000, 'r2');
  await assert.rejects(f.service.processBatch('day1', async jobs => [verdict(jobs[0]), verdict(jobs[1], { timeMs: 1 })]), /verifier_input/);
  assert.deepEqual(f.data.get(`${C.live}/day1`).entries, []);
});

test('canonical promotion, event PB, snapshot and receipt roll back together on write failure', async () => {
  const f = fixture(); await f.start(); const intake = await f.submit();
  f.store.fail(`${C.live}/day1`);
  await assert.rejects(f.publish(), /simulated_write_failure/);
  assert.equal(f.canonical(), undefined); assert.equal(f.run(intake.runId).status, 'waiting');
  assert.equal(f.data.has(`${C.pbs}/day1_${account}`), false);
});

test('archive publishes only sanitized period and ranks; late verification only advances normal PB', async () => {
  const f = fixture(); await f.start(); await f.submit(20402); await f.publish();
  const retainedReplay = structuredClone(await f.service.replay('day1', account));
  f.time(p.endsAt - 1); await f.submit(15000, 'late-verification');
  f.time(p.endsAt + p.graceMs - 1); const [job] = await f.service.leaseJobs('day1');
  await assert.rejects(f.service.archivePeriod('day1'), /settlement_open/);
  f.time(p.endsAt + p.graceMs);
  await f.service.archivePeriod('day1');
  const archive = structuredClone(f.data.get(`${C.archives}/day1`));
  assert.equal('awardCursor' in archive, false);
  const result = await f.service.completeJob('day1', job, verdict(job));
  assert.equal(result.eventImproved, false); assert(result.canonicalImproved);
  assert.deepEqual(f.data.get(`${C.archives}/day1`), archive);
  assert.deepEqual(await f.service.replay('day1', account), retainedReplay);
  assert.equal((await f.service.archivePeriod('day1')).duplicate, true);
  assert.equal(f.data.get(`${C.live}/day1`).archived, true);
  const snapshot = await f.service.snapshot('day1');
  assert.equal(snapshot.archived, true);
  assert.deepEqual(snapshot.period, publicEventPeriod({ ...p, racerCount: 1 }));
  const catalog = await f.service.catalog();
  assert.deepEqual(catalog.archives, [publicEventPeriod({ ...p, racerCount: 1 })]);
  assert.deepEqual(f.data.get(`${C.public}/catalog`).archives, catalog.archives);
  for (const value of [snapshot, catalog]) {
    const serialized = JSON.stringify(value);
    for (const key of ['ownerUid', 'replay', 'unresolvedRunIds', 'capacity', 'awardCursor']) {
      assert.equal(serialized.includes('"' + key + '"'), false, key);
    }
  }
});

test('HTTP is off by default and has no verifier/admin/archive endpoint', async () => {
  const f = fixture(); await f.start(); let auth = 0;
  const options = { service: f.service, authenticate: async () => { auth++; return 'user1'; },
    allowedOrigins: new Set(['https://game.test']), allowRequest: async () => true };
  const request = (route, init = {}) => new Request('https://worker.test' + route, { ...init, headers: { Origin: 'https://game.test', ...init.headers } });
  const off = createEventHandler(options);
  assert.equal((await off(request('/v1/events/day1/snapshot'))).status, 503); assert.equal(auth, 0);
  const handler = createEventHandler({ ...options, enabled: () => true });
  for (const route of ['archive', 'complete', 'bind-owner', 'create']) assert.equal((await handler(request('/v1/events/day1/' + route, { method: 'POST' }))).status, 404);
  const response = await handler(request('/v1/events/day1/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: account, trackId: track, attemptId: 'http', timeMs: 20402, frames: 20402, replay }) }));
  assert.equal(response.status, 202); const body = await response.json(); assert(body.runId);
  const status = await handler(request('/v1/events/day1/runs/' + body.runId));
  assert.equal(status.status, 200); assert.equal(status.headers.get('Cache-Control'), 'no-store');
  assert(!JSON.stringify(await status.json()).includes(replay));
  assert.equal((await handler(request('/v1/events/day1/replays/' + account))).status, 404);
  assert.equal((await handler(new Request('https://worker.test/v1/events/day1/snapshot', { headers: { Origin: 'https://evil.test' } }))).status, 403);
});

test('HTTP enforces auth, ingress limit and actual streamed byte count', async () => {
  const f = fixture(); await f.start();
  const options = { service: f.service, allowedOrigins: new Set(['https://game.test']), enabled: () => true,
    authenticate: async () => 'user1', allowRequest: async () => true };
  const make = body => new Request('https://worker.test/v1/events/day1/runs', { method: 'POST', headers: { Origin: 'https://game.test', 'Content-Type': 'application/json' }, body });
  assert.equal((await createEventHandler({ ...options, authenticate: async () => { throw Error('invalid'); } })(make('{}'))).status, 401);
  assert.equal((await createEventHandler({ ...options, allowRequest: async () => false })(make('{}'))).status, 429);
  assert.equal((await createEventHandler(options)(make('x'.repeat(L.requestBytes + 1)))).status, 413);
  assert.equal((await createEventHandler(options)(make('{invalid'))).status, 400);
});

test('Firestore adapter uses transaction on reads, commit and rollback, with masked timestamps', async () => {
  const calls = [];
  const request = async (route, init) => {
    const body = init?.body ? JSON.parse(init.body) : null; calls.push({ route, body });
    if (route === ':beginTransaction') return { transaction: 'test-token' };
    if (route.startsWith('/')) return { updateTime: '2026-01-01T00:00:00.123456789Z', fields: eventEncode({ frames: 30000, privateExtra: 'keep' }).mapValue.fields };
    return {};
  };
  const store = createEventFirestoreStore({ request, projectId: 'polytrack-052' });
  await store.transaction(async tx => { await tx.get('0.6.2_race_results/abc');
    await tx.patch('0.6.2_race_results/abc', { frames: 20402, ingestedAt: { __eventServerTimestamp: true } }); });
  assert(calls[1].route.endsWith('?transaction=test-token'));
  const commit = calls.find(c => c.route === ':commit').body;
  assert.equal(commit.transaction, 'test-token');
  assert.deepEqual(commit.writes[0].updateMask.fieldPaths, ['frames']);
  assert.deepEqual(commit.writes[0].updateTransforms, [{ fieldPath: 'ingestedAt', setToServerValue: 'REQUEST_TIME' }]);
  assert.equal(commit.writes[0].currentDocument.updateTime, '2026-01-01T00:00:00.123456789Z');
  await assert.rejects(store.transaction(async tx => { await tx.create('test/new', {}); await tx.get('test/other'); }), /read after write/);
  assert(calls.some(c => c.route === ':rollback'));
});

test('Firestore conflicts retry boundedly, never fall back to unsafe writes', async () => {
  let begins = 0, commits = 0, rollbacks = 0;
  const request = async route => {
    if (route === ':beginTransaction') return { transaction: `tx${++begins}` };
    if (route.startsWith('/')) return null;
    if (route === ':rollback') { rollbacks++; return {}; }
    if (route === ':commit') { commits++; throw Error('FIRESTORE_409'); }
    throw Error('Unexpected REST path');
  };
  const store = createEventFirestoreStore({ request, projectId: 'polytrack-052', pause: async () => {} });
  await assert.rejects(store.transaction(async tx => { await tx.get('test/a'); await tx.set('test/a', { x: 1 }); }), /409/);
  assert.equal(begins, 3); assert.equal(commits, 3); assert.equal(rollbacks, 3);
  const timestamp = { __firestoreTimestamp: '2026-01-01T00:00:00.123456789Z' };
  assert.deepEqual(eventDecode(eventEncode(timestamp)), timestamp);
});

import { PRE_EVENT_LAUNCH_ENGINE } from '../src/event-engine-compatibility.js';

test('launch-only repin preserves old period binding, event Play, pending runs and frozen archive scores', async () => {
  const f=fixture();await f.start();
  const oldPeriod={...f.data.get(`${C.periods}/day1`),engineDigest:PRE_EVENT_LAUNCH_ENGINE};
  f.data.set(`${C.periods}/day1`,oldPeriod);
  assert.equal((await f.service.snapshot('day1')).period.targetMs,oldPeriod.targetMs);
  const first=await f.submit();
  assert.equal(f.run(first.runId).periodBinding,JSON.stringify(oldPeriod));
  const originalBinding=f.run(first.runId).eventKey;
  await f.publish();
  assert.equal(f.run(first.runId).eventKey,originalBinding);
  assert.equal(f.run(first.runId).proof.engineDigest,engine);
  assert.deepEqual(f.data.get(`${C.periods}/day1`),oldPeriod);
  f.time(p.endsAt-1);await f.submit(15000,'late-repin');
  f.time(p.endsAt+p.graceMs-1);const [job]=await f.service.leaseJobs('day1');
  f.time(p.endsAt+p.graceMs);await f.service.archivePeriod('day1');
  const archive=structuredClone(f.data.get(`${C.archives}/day1`));
  const totals=structuredClone(f.data.get(`${C.public}/totals`));
  const result=await f.service.completeJob('day1',job,verdict(job));
  assert.equal(result.eventImproved,false);assert.equal(result.canonicalImproved,true);
  assert.deepEqual(f.data.get(`${C.archives}/day1`),archive);
  assert.deepEqual(f.data.get(`${C.public}/totals`),totals);
  assert.equal((await f.service.snapshot('day1')).archived,true);
});

test('period compatibility never accepts obsolete proofs, arbitrary engines or rewritten new periods',async()=>{
  assert.notEqual(engine,PRE_EVENT_LAUNCH_ENGINE,'repin must be applied with compatibility');
  const f=fixture();await f.start();
  f.data.get(`${C.periods}/day1`).engineDigest=PRE_EVENT_LAUNCH_ENGINE;
  await f.submit();const [job]=await f.service.leaseJobs('day1');
  const proof=verdict(job);proof.engineDigest=PRE_EVENT_LAUNCH_ENGINE;proof.binding.engineDigest=PRE_EVENT_LAUNCH_ENGINE;
  await assert.rejects(f.service.completeJob('day1',job,proof),/verifier_proof_mismatch/);
  assert.deepEqual(f.data.get(`${C.live}/day1`).entries,[]);
  f.data.get(`${C.periods}/day1`).engineDigest='d'.repeat(64);
  await assert.rejects(f.service.snapshot('day1'),/event_version_unavailable/);
  assert.equal(eventPeriod({...inputPeriod,engineDigest:PRE_EVENT_LAUNCH_ENGINE}).engineDigest,engine);
});

test('event public rows retain bounded car style but reject URLs and markup',()=>{for(const style of ['AAMBBG1XKg0UIhMTE2ZmZg','https://bad.test/car.png','<svg>','a'.repeat(257)]){const row=eventLeaderboard(p,[{accountId:account,timeMs:12000,name:'Racer',carStyle:style}])[0];assert.equal(row.carStyle,style==='AAMBBG1XKg0UIhMTE2ZmZg'?style:'');}});

test('own-ghost repin preserves old period binding, event Play, pending runs and frozen archive scores', async () => {
  const f=fixture();await f.start();
  const oldPeriod={...f.data.get(`${C.periods}/day1`),engineDigest:'895eeacbdfdd5f68b9db92c502af620709539c5211782809f610c1a76e60785d'};
  f.data.set(`${C.periods}/day1`,oldPeriod);
  assert.equal((await f.service.snapshot('day1')).period.targetMs,oldPeriod.targetMs);
  const first=await f.submit();
  assert.equal(f.run(first.runId).periodBinding,JSON.stringify(oldPeriod));
  const originalBinding=f.run(first.runId).eventKey;
  await f.publish();
  assert.equal(f.run(first.runId).eventKey,originalBinding);
  assert.equal(f.run(first.runId).proof.engineDigest,engine);
  assert.deepEqual(f.data.get(`${C.periods}/day1`),oldPeriod);
  f.time(p.endsAt-1);await f.submit(15000,'late-repin');
  f.time(p.endsAt+p.graceMs-1);const [job]=await f.service.leaseJobs('day1');
  f.time(p.endsAt+p.graceMs);await f.service.archivePeriod('day1');
  const archive=structuredClone(f.data.get(`${C.archives}/day1`));
  const totals=structuredClone(f.data.get(`${C.public}/totals`));
  const result=await f.service.completeJob('day1',job,verdict(job));
  assert.equal(result.eventImproved,false);assert.equal(result.canonicalImproved,true);
  assert.deepEqual(f.data.get(`${C.archives}/day1`),archive);
  assert.deepEqual(f.data.get(`${C.public}/totals`),totals);
  assert.equal((await f.service.snapshot('day1')).archived,true);
});

test('previous launch-engine period compatibility never accepts obsolete proofs, arbitrary engines or rewritten new periods',async()=>{
  assert.notEqual(engine,'895eeacbdfdd5f68b9db92c502af620709539c5211782809f610c1a76e60785d','repin must be applied with compatibility');
  const f=fixture();await f.start();
  f.data.get(`${C.periods}/day1`).engineDigest='895eeacbdfdd5f68b9db92c502af620709539c5211782809f610c1a76e60785d';
  await f.submit();const [job]=await f.service.leaseJobs('day1');
  const proof=verdict(job);proof.engineDigest='895eeacbdfdd5f68b9db92c502af620709539c5211782809f610c1a76e60785d';proof.binding.engineDigest='895eeacbdfdd5f68b9db92c502af620709539c5211782809f610c1a76e60785d';
  await assert.rejects(f.service.completeJob('day1',job,proof),/verifier_proof_mismatch/);
  assert.deepEqual(f.data.get(`${C.live}/day1`).entries,[]);
  f.data.get(`${C.periods}/day1`).engineDigest='d'.repeat(64);
  await assert.rejects(f.service.snapshot('day1'),/event_version_unavailable/);
  assert.equal(eventPeriod({...inputPeriod,engineDigest:'895eeacbdfdd5f68b9db92c502af620709539c5211782809f610c1a76e60785d'}).engineDigest,engine);
});

test('Kodub period keeps trusted code private and awards event points without normal PB promotion',async()=>{
 const f=fixture();await f.service.bindOwner('user1',account);
 const code='PolyTrack2'+'a'.repeat(40);
 const input={...inputPeriod,kind:'kodub',maxRp:700,kodub:{source:'kodub-v6-track-of-the-week',trackCode:code,trackCodeHash:hash(code),officialTrackAssetHash:'e'.repeat(64),officialEndTime:inputPeriod.endsAt,officialFastestVerifiedMs:inputPeriod.targetMs,name:'Weekly fixture',author:'Fixture',lastModified:null,environment:0}};
 await f.service.createPeriod(input);f.time(1000);await f.submit();
 let trusted;await f.service.processBatch('day1',async(jobs,period)=>{trusted=period;return jobs.map(job=>kodubVerdict(job,input.kodub.trackCodeHash));});
 assert.equal(trusted.kodub.trackCode,code);assert.equal(f.canonical(),undefined);
 const board=await f.service.snapshot('day1');assert.equal(board.period.kind,'kodub');assert.equal(board.period.trackName,'Weekly fixture');assert.equal(board.entries[0].rp,343);assert.equal('kodub' in board.period,false);
 assert(!JSON.stringify(await f.service.catalog()).includes(code));
 assert.throws(()=>eventPeriod({...input,maxRp:500}),/kodub_rp_cap/);
 assert.throws(()=>eventPeriod({...input,kodub:{...input.kodub,officialEndTime:1}}),/invalid_kodub_binding/);
});

test('Kodub verdicts require the frozen period track content hash',async()=>{
 const code='PolyTrack2'+'a'.repeat(40),trackCodeHash=hash(code);
 const input={...inputPeriod,kind:'kodub',maxRp:700,kodub:{source:'kodub-v6-track-of-the-week',trackCode:code,trackCodeHash,officialTrackAssetHash:trackCodeHash,officialEndTime:inputPeriod.endsAt,officialFastestVerifiedMs:inputPeriod.targetMs,name:'Weekly fixture',author:'Fixture',lastModified:null,environment:0}};
 const mutations=[
  proof=>proof,
  proof=>{proof.binding.trackContentHash='f'.repeat(64);return proof;},
  proof=>{proof.binding.trackContentHash=trackCodeHash;proof.trackContentHash=null;return proof;},
  proof=>{proof.binding.trackContentHash=trackCodeHash;proof.trackContentHash='f'.repeat(64);return proof;},
 ];
 for(const mutate of mutations){
  const f=fixture();await f.service.bindOwner('user1',account);await f.service.createPeriod(input);f.time(1000);await f.submit();
  const [job]=await f.service.leaseJobs('day1');
  await assert.rejects(f.service.completeJob('day1',job,mutate(verdict(job))),/verifier_proof_mismatch/);
  assert.equal(f.data.get(`${C.pbs}/day1_${account}`),undefined);
 }
});

test('archived Kodub track bytes are hash-bound and available only for explicitly unranked play',async()=>{
 const f=fixture(),code='PolyTrack2'+'a'.repeat(40),trackCodeHash=hash(code);
 const input={...inputPeriod,kind:'kodub',maxRp:700,kodub:{source:'kodub-v6-track-of-the-week',trackCode:code,
  trackCodeHash,officialTrackAssetHash:trackCodeHash,officialEndTime:inputPeriod.endsAt,
  officialFastestVerifiedMs:inputPeriod.targetMs,name:'Weekly fixture',author:'Fixture',lastModified:null,environment:2}};
 await f.service.createPeriod(input);
 await assert.rejects(f.service.archivedTrack('day1'),/event_track_not_found/);
 f.time(input.endsAt+input.graceMs);await f.service.archivePeriod('day1');
 assert.deepEqual(await f.service.archivedTrack('day1'),{periodId:'day1',trackId:track,trackCode:code,
  trackCodeHash,environment:2,playMode:'unranked',scoringDisabled:true,archived:true});
 const snapshot=await f.service.snapshot('day1');
 assert.equal(snapshot.racerCount,0);assert.equal(JSON.stringify(snapshot).includes(code),false);
});
