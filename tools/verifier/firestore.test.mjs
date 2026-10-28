import test from 'node:test';
import assert from 'node:assert/strict';
import {boundedRetryAfter, createFirestoreCaller, firestoreQuotaMode, connect} from './firestore.mjs';
import {budgetDatabase, VerificationBudgetError} from './throughput.mjs';
import {generateKeyPairSync} from 'node:crypto';
import fs from 'node:fs';

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

test('Firestore runQuery array errors preserve only the safe status code', async () => {
  const message = 'private backend detail: query requires an index. ' + 'x'.repeat(400);
  let calls = 0;
  const db = createFirestoreCaller({base: 'https://firestore.test', access: 'token',
    fetchImpl: async () => {
      calls++;
      return response(400, [{error: {code: 9, status: 'FAILED_PRECONDITION', message}}]);
    }});

  await assert.rejects(db.call(':runQuery', {structuredQuery: {limit: 1}}), error => {
    assert.equal(error.status, 400);
    assert.equal(error.code, 'FAILED_PRECONDITION');
    assert.equal(error.message, 'Firestore request failed: 400');
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(db.requests(), 1);
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

test('Firestore read counters separate HTTP calls, returned documents, and empty-query minimums', async () => {
  const raw = createFirestoreCaller({base: 'https://firestore.test', access: 'token',
    fetchImpl: async (url, init) => {
      if (url.endsWith('/missing')) return response(404);
      if (init.method === 'GET') return response(200, {name: 'projects/p/databases/d/documents/c/x'});
      if (url.endsWith(':batchGet')) return response(200, [{found: {name: 'c/x'}}, {missing: 'c/missing'}]);
      if (url.endsWith(':commit')) return response(200, {});
      return response(200, init.body.includes('empty') ? [] : [{document: {name: 'c/x'}}]);
    }});
  const bounded = budgetDatabase(raw, 7);

  await bounded.get('c', 'x');
  await bounded.get('c', 'missing');
  await bounded.call(':batchGet', {});
  await bounded.call(':runQuery', {structuredQuery: {from: [{collectionId: 'full'}]}});
  await bounded.call(':runQuery', {structuredQuery: {from: [{collectionId: 'empty'}]}});
  await bounded.call(':commit', {writes: []});

  assert.equal(bounded.requests(), 6);
  assert.equal(bounded.returnedDocuments(), 3);
  assert.equal(bounded.queryCount(), 2);
  assert.equal(bounded.emptyQueryMinimumReads(), 1);
  assert.equal(bounded.estimatedDocumentReads(), 6);
});

test('read retries count HTTP attempts but only successful reads in read estimates', async () => {
  let calls = 0;
  const raw = createFirestoreCaller({base: 'https://firestore.test', access: 'token',
    fetchImpl: async () => ++calls === 1 ? response(429) : response(200, []), sleep: quiet});
  const bounded = budgetDatabase(raw, 2);
  await bounded.call(':runQuery', {});
  assert.equal(bounded.requests(), 2);
  assert.equal(bounded.queryCount(), 1);
  assert.equal(bounded.emptyQueryMinimumReads(), 1);
  assert.equal(bounded.estimatedDocumentReads(), 1);
});

test('unknown operations and failed commits add no estimated reads', async () => {
  const raw = createFirestoreCaller({base: 'https://firestore.test', access: 'token',
    fetchImpl: async () => response(429), sleep: quiet});
  const bounded = budgetDatabase(raw, 2);
  await assert.rejects(bounded.call(':unknownOperation', {}));
  await assert.rejects(bounded.call(':commit', {writes: []}));
  assert.equal(bounded.requests(), 2);
  assert.equal(bounded.returnedDocuments(), 0);
  assert.equal(bounded.queryCount(), 0);
  assert.equal(bounded.emptyQueryMinimumReads(), 0);
  assert.equal(bounded.estimatedDocumentReads(), 0);
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

test('scheduled quota mode rejects on the first 429 for every operation and latches further database access', async () => {
  for (const [path, body, code] of [['/queue/one', undefined, 'FIRESTORE_READ_THROTTLED'],
    [':runQuery', {}, 'FIRESTORE_READ_THROTTLED'], [':batchGet', {}, 'FIRESTORE_READ_THROTTLED'],
    [':commit', {writes: []}, 'FIRESTORE_COMMIT_THROTTLED'], [':beginTransaction', {}, 'FIRESTORE_COMMIT_THROTTLED']]) {
    for (const retryAfter of [undefined, '0', '1', '30', 'invalid']) {
      let calls = 0, sleeps = 0, retries = 0;
      const raw = createFirestoreCaller({base: 'https://firestore.test', access: 'token', mode: 'scheduled',
        maxReadRetries: 2, sleep: async () => {sleeps++;}, fetchImpl: async () => {
          calls++;
          return response(429, {error: {status: 'RESOURCE_EXHAUSTED', message: 'PRIVATE_BACKEND_DETAIL'}},
            retryAfter === undefined ? {} : {'Retry-After': retryAfter});
        }});
      let failure;
      await assert.rejects(raw.call(path, body, {onRetry: () => {retries++;}}), error => {
        failure = error;
        assert.equal(error.status, 429); assert.equal(error.code, code); assert.equal(error.deferred, true);
        assert.equal(error.message, 'Firestore request failed: 429');
        assert.doesNotMatch(JSON.stringify(error), /PRIVATE_BACKEND_DETAIL|token/);
        return true;
      });
      for (const [next, payload] of [['/queue/one'], ['/queue/two'], [':runQuery', {}], [':batchGet', {}],
        [':commit', {writes: [{proof: 'MUST_NOT_PUBLISH'}]}], [':rollback', {}]]) {
        await assert.rejects(raw.call(next, payload), error => error === failure);
      }
      assert.equal(calls, 1); assert.equal(sleeps, 0); assert.equal(retries, 0);
      assert.equal(raw.requests(), 1); assert.equal(raw.returnedDocuments(), 0);
      assert.equal(raw.queryCount(), 0); assert.equal(raw.estimatedDocumentReads(), 0);
      assert.equal(raw.emptyQueryMinimumReads(), 0);
    }
  }
});

test('scheduled 429 latches before an untrusted error body can delay or leak', async () => {
  let calls = 0;
  const raw = createFirestoreCaller({base: 'https://firestore.test', access: 'token', mode: 'scheduled',
    fetchImpl: async () => {calls++; return {status: 429, json: () => assert.fail('Quota body must not be read'), headers: new Headers()};}});
  await assert.rejects(raw.call('/queue/one'), {code: 'FIRESTORE_READ_THROTTLED', deferred: true});
  await assert.rejects(raw.call('/queue/two'), {code: 'FIRESTORE_READ_THROTTLED', deferred: true});
  assert.equal(calls, 1);
});

test('scheduled quota rejection preserves actual request/read accounting and shared budget reservations', async () => {
  let calls = 0;
  const raw = createFirestoreCaller({base: 'https://firestore.test', access: 'token', mode: 'scheduled',
    fetchImpl: async () => ++calls === 1 ? response(200, []) : response(429), sleep: () => assert.fail('No scheduled retry')});
  const bounded = budgetDatabase(raw, 3);
  await bounded.call(':runQuery', {});
  await assert.rejects(bounded.call('/queue/one'), {status: 429, code: 'FIRESTORE_READ_THROTTLED', deferred: true});
  assert.equal(calls, 2); assert.equal(raw.requests(), 2); assert.equal(bounded.requests(), 2);
  assert.equal(bounded.remainingRequests(), 1); assert.equal(bounded.returnedDocuments(), 0);
  assert.equal(bounded.queryCount(), 1); assert.equal(bounded.emptyQueryMinimumReads(), 1);
  assert.equal(bounded.estimatedDocumentReads(), 1);
});

test('manual exhausted read retries retain two bounded retries, accurate metrics and no permanent latch', async () => {
  let calls = 0, retries = 0;
  const waits = [];
  const raw = createFirestoreCaller({base: 'https://firestore.test', access: 'token', mode: 'manual',
    fetchImpl: async () => ++calls <= 3 ? response(429) : response(200, {name: 'queue/one'}), sleep: async ms => waits.push(ms)});
  await assert.rejects(raw.call('/queue/one', undefined, {onRetry: () => {retries++;}}), {status: 429, code: 'FIRESTORE_READ_THROTTLED', deferred: true});
  assert.equal(raw.requests(), 3); assert.equal(raw.estimatedDocumentReads(), 0);
  assert.equal(retries, 2); assert.deepEqual(waits, [250, 500]);
  assert.deepEqual(await raw.call('/queue/one'), {name: 'queue/one'});
  assert.equal(raw.requests(), 4); assert.equal(raw.estimatedDocumentReads(), 1);
});

test('manual and scheduled 400/auth/server errors fail safely without retry, quota classification or secret leakage', async () => {
  for (const mode of ['manual', 'scheduled']) {
    for (const [status, code] of [[400, 'FAILED_PRECONDITION'], [400, 'INVALID_ARGUMENT'], [401, 'UNAUTHENTICATED'],
      [403, 'PERMISSION_DENIED'], [500, 'INTERNAL'], [503, 'UNAVAILABLE']]) {
      for (const array of [false, true]) {
        let calls = 0;
        const raw = createFirestoreCaller({base: 'https://firestore.test', access: 'PRIVATE_TOKEN', mode,
          sleep: () => assert.fail('No retry for this failure'), fetchImpl: async () => {
            calls++; const body = {error: {status: code, message: 'PRIVATE_BACKEND_DETAIL'}};
            return calls === 1 ? response(status, array ? [body] : body) : response(200, []);
          }});
        await assert.rejects(raw.call(':runQuery', {}), error => {
          assert.equal(error.status, status); assert.equal(error.code, code); assert.equal(error.deferred, undefined);
          assert.equal(error.message, `Firestore request failed: ${status}`);
          assert.doesNotMatch(JSON.stringify(error), /PRIVATE_BACKEND_DETAIL|PRIVATE_TOKEN/); return true;
        });
        assert.equal(raw.requests(), 1); assert.equal(raw.estimatedDocumentReads(), 0);
        await raw.call(':runQuery', {});
        assert.equal(calls, 2, 'Nonquota failures must not permanently latch the connection');
      }
    }
  }
});

test('manual and scheduled network failures keep the existing fail-closed transport behavior', async () => {
  for (const mode of ['manual', 'scheduled']) {
    let calls = 0;
    const failure = new TypeError('Transient network failure');
    const raw = createFirestoreCaller({base: 'https://firestore.test', access: 'token', mode,
      sleep: () => assert.fail('Network exceptions were never retried here'),
      fetchImpl: async () => {if (++calls === 1) throw failure; return response(200, []);}});
    await assert.rejects(raw.call(':runQuery', {}), error => error === failure);
    await raw.call(':runQuery', {});
    assert.equal(calls, 2); assert.equal(raw.requests(), 2); assert.equal(raw.estimatedDocumentReads(), 1);
  }
});

test('quota mode is explicit, validated and not inherited by the caller used in offline tests', () => {
  assert.equal(firestoreQuotaMode({}), 'manual');
  assert.equal(firestoreQuotaMode({GITHUB_EVENT_NAME: 'schedule'}), 'manual');
  assert.equal(firestoreQuotaMode({VERIFIER_FIRESTORE_MODE: 'scheduled'}), 'scheduled');
  assert.equal(firestoreQuotaMode({VERIFIER_FIRESTORE_MODE: 'manual'}), 'manual');
  for (const mode of ['', 'SCHEDULED', 'typo', true, null]) {
    if (mode !== null) assert.throws(() => firestoreQuotaMode({VERIFIER_FIRESTORE_MODE: mode}), /quota mode/);
    assert.throws(() => createFirestoreCaller({base: 'https://firestore.test', access: 'token', mode}), /quota mode/);
  }
});

test('connect forwards scheduled env policy with mocked OAuth and rejects auth failures without DB access', async t => {
  const {privateKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
  const raw = JSON.stringify({project_id: 'polytrack-052', client_email: 'synthetic@example.invalid',
    private_key: privateKey.export({format: 'pem', type: 'pkcs8'})});
  const prior = process.env.VERIFIER_FIRESTORE_MODE;
  process.env.VERIFIER_FIRESTORE_MODE = 'scheduled';
  const calls = [];
  const fetchMock = t.mock.method(globalThis, 'fetch', async url => {
    calls.push(url);
    if (url === 'https://oauth2.googleapis.com/token') return response(200, {access_token: 'SYNTHETIC_ACCESS'});
    assert.ok(url.startsWith('https://firestore.googleapis.com/v1/projects/polytrack-052/'));
    return response(429);
  });
  try {
    const db = await connect(raw);
    await assert.rejects(db.call(':runQuery', {}), {code: 'FIRESTORE_READ_THROTTLED', deferred: true});
    await assert.rejects(db.call(':commit', {writes: []}), {deferred: true});
    assert.equal(calls.length, 2); assert.equal(db.requests(), 1);
    await assert.rejects(connect('NOT_CREDENTIALS', {mode: 'invalid'}), /quota mode/);
    assert.equal(calls.length, 2);
    for (const status of [400, 401, 403, 429, 503]) {
      const before = calls.length;
      fetchMock.mock.mockImplementation(async url => {
        calls.push(url); assert.equal(url, 'https://oauth2.googleapis.com/token');
        return response(status, {error: {message: 'PRIVATE_AUTH_DETAIL'}});
      });
      await assert.rejects(connect(raw), error => {
        assert.equal(error.message, `Firebase authentication failed: ${status}`);
        assert.equal(error.deferred, undefined); return true;
      });
      assert.equal(calls.length, before + 1);
    }
  } finally {
    if (prior === undefined) delete process.env.VERIFIER_FIRESTORE_MODE; else process.env.VERIFIER_FIRESTORE_MODE = prior;
  }
});

test('scheduled preflight/drain stop before simulation, proof publication or another quota probe', async () => {
  const {runVerifier} = await import('./run.mjs');
  const {needsSnapshot} = await import('../post-verification-run.mjs');
  for (const check of [true, false]) {
    let calls = 0;
    const db = createFirestoreCaller({base: 'https://firestore.test', access: 'token', mode: 'scheduled',
      fetchImpl: async () => {calls++; return response(429);}, sleep: () => assert.fail('No quota retry')});
    const result = await runVerifier({check, drain: !check,
      env: {GITHUB_EVENT_NAME: 'schedule', FIREBASE_VERIFIER_SERVICE_ACCOUNT: 'SYNTHETIC_ONLY'},
      connectDatabase: async () => db, validateEngine: quiet, log: quiet,
      eventCheck: () => assert.fail('Preflight must stop before another source'),
      eventRun: async db => {await db.call(':runQuery', {}); assert.fail('Quota must interrupt round');},
      verifyNormal: () => assert.fail('Failure must not become a native proof'),
      publishNormal: () => assert.fail('Failure must not publish any proof')});
    assert.equal(check ? result.reason : result.stop, check ? 'firestore_429' : 'firestore_throttled');
    if (check) assert.equal(result.hasWork, null);
    else {
      assert.equal(result.countsComplete, false); assert.equal(result.interruptedRound, true);
      assert.equal(result.firestoreHttpRequests, 1); assert.equal(result.firestoreEstimatedDocumentReads, 0);
    }
    assert.equal(needsSnapshot(result, 999), false, 'Interrupted quota work must never signal completed publication');
    assert.equal(calls, 1); assert.equal(db.requests(), 1);
  }
});

test('a simulated verified result cannot publish a proof when its fresh publication read hits scheduled quota', async () => {
  const {publishResults} = await import('./runner.mjs');
  const {verificationKey, VERIFICATION_COLLECTION} = await import('../../workers/ranked/src/verification.js');
  const row = {accountId: 'synthetic-racer', trackId: '5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038',
    timeMs: 20000, frames: 20000, uploadId: 7, replayHash: 'a'.repeat(64)};
  const job = {...row, resultId: row.accountId + '_' + row.trackId, queueKey: verificationKey(row), queueCollection: VERIFICATION_COLLECTION};
  let calls = 0, writes = 0;
  const raw = createFirestoreCaller({base: 'https://firestore.test', access: 'token', mode: 'scheduled',
    fetchImpl: async (_url, init) => {calls++; assert.equal(init.method, 'GET'); return response(429);}, sleep: () => assert.fail('No quota retry')});
  const db = budgetDatabase({...raw, write: () => {writes++; assert.fail('No proof write may be constructed');}}, 10);
  await assert.rejects(publishResults(db, [job], [{resultId: job.resultId, status: 'verified', reason: 'native_exact_finish'}]),
    {code: 'FIRESTORE_READ_THROTTLED', status: 429, deferred: true});
  assert.equal(calls, 1); assert.equal(writes, 0); assert.equal(db.requests(), 1);
  assert.equal(raw.requests(), 1); assert.equal(raw.estimatedDocumentReads(), 0);
});

test('workflow quota mode is scoped only to production preflight and verification env blocks', () => {
  const workflow = fs.readFileSync(new URL('../../.github/workflows/verify-runs.yml', import.meta.url), 'utf8');
  const steps = workflow.split(/(?=^      - )/m).filter(step => step.includes('VERIFIER_FIRESTORE_MODE:'));
  assert.equal(steps.length, 2);
  assert.ok(steps.some(step => step.includes('id: queue')));
  assert.ok(steps.some(step => step.includes('id: verification')));
  for (const step of steps) {
    assert.match(step, /VERIFIER_FIRESTORE_MODE: \$\{\{ github\.event_name == 'schedule' && 'scheduled' \|\| 'manual' \}\}/);
    assert.ok(step.includes('FIREBASE_VERIFIER_SERVICE_ACCOUNT:'));
    assert.doesNotMatch(step, /run: (?:node --test|npm test)/);
  }
});
