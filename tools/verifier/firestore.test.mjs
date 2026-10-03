import test from 'node:test';
import assert from 'node:assert/strict';
import {boundedRetryAfter, createFirestoreCaller} from './firestore.mjs';
import {budgetDatabase, VerificationBudgetError} from './throughput.mjs';

const response = (status, body = {}, headers = {}) => new Response(JSON.stringify(body), {status, headers});
const quiet = async () => {};

test('safe document reads retry HTTP 429 at most twice and cap Retry-After delays', async () => {
  const calls = [], waits = [];
  const db = createFirestoreCaller({base: 'https://firestore.test', access: 'token',
    fetchImpl: async (url, init) => {
      calls.push({url, init});
      return calls.length < 3 ? response(429, {}, {'Retry-After': calls.length === 1 ? '2' : '1'}) : response(200, {found: true});
    },
    sleep: async ms => waits.push(ms)});

  assert.deepEqual(await db.call('/collection/document'), {found: true});
  assert.equal(db.requests(), 3);
  assert.deepEqual(waits, [2000, 1000]);
  assert(calls.every(call => call.init.method === 'GET'));
});

test('runQuery retries safely and uses bounded fallback delay when Retry-After is absent', async () => {
  const waits = [];
  let calls = 0;
  const db = createFirestoreCaller({base: 'https://firestore.test', access: 'token',
    fetchImpl: async (_url, init) => {
      calls++;
      assert.equal(init.method, 'POST');
      return calls === 1 ? response(429) : response(200, [{document: {name: 'queue/one'}}]);
    },
    sleep: async ms => waits.push(ms)});

  assert.deepEqual(await db.call(':runQuery', {structuredQuery: {limit: 1}}), [{document: {name: 'queue/one'}}]);
  assert.equal(calls, 2);
  assert.equal(db.requests(), 2);
  assert.deepEqual(waits, [250]);
});

test('Retry-After parser supports HTTP dates and clamps negative or excessive delays', () => {
  const now = Date.parse('2026-10-02T00:00:00Z');
  assert.equal(boundedRetryAfter(new Response(null, {headers: {'Retry-After': 'Wed, 21 Oct 2015 07:28:00 GMT'}}), now), 0);
  assert.equal(boundedRetryAfter(new Response(null, {headers: {'Retry-After': 'Thu, 02 Oct 2026 00:00:01 GMT'}}), now), 1000);
  assert.equal(boundedRetryAfter(new Response(null, {headers: {'Retry-After': 'Thu, 02 Oct 2026 00:00:04 GMT'}}), now), null);
  assert.equal(boundedRetryAfter(new Response(null, {headers: {'Retry-After': 'invalid'}}), now), null);
});

test('a Retry-After beyond the bounded window defers instead of retrying early', async () => {
  let calls = 0, waits = 0;
  const db = createFirestoreCaller({base: 'https://firestore.test', access: 'token',
    fetchImpl: async () => { calls++; return response(429, {}, {'Retry-After': '30'}); },
    sleep: async () => { waits++; }});

  await assert.rejects(db.call('/collection/document'), error => {
    assert.equal(error.code, 'FIRESTORE_READ_THROTTLED');
    assert.equal(error.deferred, true);
    assert.equal(error.retryAfterMs, 30000);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(waits, 0);
});

test('commit 429 is typed for deferral and is never automatically replayed', async () => {
  let calls = 0;
  const db = createFirestoreCaller({base: 'https://firestore.test', access: 'token',
    fetchImpl: async () => { calls++; return response(429, {error: {status: 'RESOURCE_EXHAUSTED'}}); }, sleep: quiet});

  await assert.rejects(db.call(':commit', {writes: [{update: {name: 'one'}}]}), error => {
    assert.equal(error.status, 429);
    assert.equal(error.code, 'FIRESTORE_COMMIT_THROTTLED');
    assert.equal(error.deferred, true);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(db.requests(), 1);
});

test('unknown POST operations are not assumed safe to retry', async () => {
  let calls = 0;
  const db = createFirestoreCaller({base: 'https://firestore.test', access: 'token',
    fetchImpl: async () => { calls++; return response(429); }, sleep: quiet});
  await assert.rejects(db.call(':unknownOperation', {}), {status: 429});
  assert.equal(calls, 1);
  assert.equal(db.requests(), 1);
});

test('each retried HTTP attempt reserves against the shared drain budget', async () => {
  let calls = 0, waits = 0;
  const raw = createFirestoreCaller({base: 'https://firestore.test', access: 'token',
    fetchImpl: async () => ++calls === 1 ? response(429) : response(200, {document: 'ok'}),
    sleep: async () => { waits++; }});
  const bounded = budgetDatabase(raw, 2);

  assert.deepEqual(await bounded.call('/collection/document'), {document: 'ok'});
  assert.equal(calls, 2);
  assert.equal(waits, 1);
  assert.equal(bounded.requests(), 2);
  assert.equal(raw.requests(), 2);
});

test('retry stops before an HTTP call when the request budget has no retry slot', async () => {
  let calls = 0;
  const raw = createFirestoreCaller({base: 'https://firestore.test', access: 'token',
    fetchImpl: async () => { calls++; return response(429); }, sleep: quiet});
  const bounded = budgetDatabase(raw, 1);

  await assert.rejects(bounded.call('/collection/document'), VerificationBudgetError);
  assert.equal(calls, 1);
  assert.equal(bounded.requests(), 1);
  assert.equal(raw.requests(), 1);
});
