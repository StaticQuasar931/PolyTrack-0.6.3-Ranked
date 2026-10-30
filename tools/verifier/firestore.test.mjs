import test from 'node:test';
import assert from 'node:assert/strict';
import {boundedRetryAfter, createFirestoreCaller, firestoreQuotaMode, connect,
  firestoreDocumentLimits, FirestoreDocumentBudgetError} from './firestore.mjs';
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


test('latched calls keep admission reservations separate from actual HTTP attempts', async () => {
  let calls = 0;
  const raw = createFirestoreCaller({base:'https://offline.invalid',access:'fake',mode:'scheduled',
    fetchImpl:async()=>{calls++;return response(429);}});
  const bounded = budgetDatabase(raw, 3);
  for (let i=0;i<3;i++) await assert.rejects(bounded.call('/queue/one'), {code:'FIRESTORE_READ_THROTTLED'});
  await assert.rejects(bounded.call('/queue/one'), VerificationBudgetError);
  assert.equal(calls,1);assert.equal(raw.requests(),1);assert.equal(bounded.httpRequests(),1);
  assert.equal(bounded.requestReservations(),3);assert.equal(bounded.requests(),3);
  assert.equal(bounded.remainingRequests(),0);assert.equal(bounded.failedRequests(),1);
  assert.equal(bounded.unknownReadOutcomes(),0);
});

test('local serialization errors reserve admission without fabricating transport or read outcomes', async () => {
  const raw=createFirestoreCaller({base:'https://offline.invalid',access:'fake',fetchImpl:()=>assert.fail('No transport')});
  const bounded=budgetDatabase(raw,1), body={};body.circular=body;
  await assert.rejects(bounded.call(':runQuery',body),TypeError);
  assert.equal(bounded.requests(),1);assert.equal(bounded.httpRequests(),0);
  assert.equal(bounded.failedRequests(),0);assert.equal(bounded.unknownReadOutcomes(),0);
});

test('unreadable success bodies report unknown read or commit outcomes without exposing body errors', async () => {
  for (const path of ['/queue/one',':runQuery',':batchGet',':commit']) {
    let calls=0;
    const raw=createFirestoreCaller({base:'https://offline.invalid',access:'PRIVATE_TOKEN',
      fetchImpl:async()=>{calls++;return {status:200,ok:true,json:async()=>{throw Error('PRIVATE_RESPONSE');}};}});
    const bounded=budgetDatabase(raw,1);
    await assert.rejects(bounded.call(path,path.startsWith(':')?{writes:[{},{}]}:undefined),error=>{
      assert.equal(error.message,'Firestore response decoding failed');
      assert.doesNotMatch(JSON.stringify(error),/PRIVATE/);return true;
    });
    assert.equal(calls,1);assert.equal(bounded.httpRequests(),1);assert.equal(bounded.failedRequests(),1);
    assert.equal(bounded.estimatedDocumentReads(),0);
    assert.equal(bounded.unknownReadOutcomes(),path===':commit'?0:1);
    assert.equal(bounded.commitAttempts(),path===':commit'?1:0);
    assert.equal(bounded.writeAttempts(),path===':commit'?2:0);
    assert.equal(bounded.unknownCommitOutcomes(),path===':commit'?1:0);
  }
});

test('malformed successful read shapes never masquerade as empty-query minimums', async () => {
  for (const [path,body,result] of [
    [':runQuery',{},{}],[':runQuery',{},[{error:{status:'INTERNAL'}}]],
    [':batchGet',{documents:['one']},[]],[':batchGet',{},[{}]],['/queue/one',undefined,null]]) {
    const raw=createFirestoreCaller({base:'https://offline.invalid',access:'fake',fetchImpl:async()=>response(200,result)});
    assert.deepEqual(await raw.call(path,body),result);
    assert.equal(raw.unknownReadOutcomes(),1);assert.equal(raw.estimatedDocumentReads(),0);
    assert.equal(raw.emptyQueryMinimumReads(),0);assert.equal(raw.requests(),1);
  }
});

test('network exceptions charge one attempt and retain explicit unknown read or commit outcomes', async () => {
  for (const path of [':runQuery',':commit']) {
    const failure=Error('PRIVATE_TRANSPORT');
    const raw=createFirestoreCaller({base:'https://offline.invalid',access:'fake',
      fetchImpl:async()=>{throw failure;},sleep:()=>assert.fail('No network retry')});
    await assert.rejects(raw.call(path,{writes:[{},{}]}),error=>error===failure);
    assert.equal(raw.requests(),1);assert.equal(raw.failedRequests(),1);
    assert.equal(raw.unknownReadOutcomes(),path===':runQuery'?1:0);
    assert.equal(raw.unknownCommitOutcomes(),path===':commit'?1:0);
    assert.equal(raw.writeAttempts(),path===':commit'?2:0);
  }
});


test('server and timeout responses mark potentially spent reads and ambiguous commits without retries', async () => {
  for(const status of [408,500,502,503,504]) for(const path of [':runQuery',':commit']) {
    let calls=0;
    const raw=createFirestoreCaller({base:'https://offline.invalid',access:'fake',
      fetchImpl:async()=>{calls++;return response(status);},sleep:()=>assert.fail('No retry')});
    await assert.rejects(raw.call(path,{writes:[{}]}),{status});
    assert.equal(raw.requests(),1);assert.equal(raw.failedRequests(),1);assert.equal(calls,1);
    assert.equal(raw.unknownReadOutcomes(),path===':runQuery'?1:0);
    assert.equal(raw.unknownCommitOutcomes(),path===':commit'?1:0);
    assert.equal(raw.estimatedDocumentReads(),0);
  }
});


test('unusable commit acknowledgements remain unknown rather than confirmed write counts', async () => {
  for (const result of [null,{}, {writeResults:[]}, {writeResults:[{},{}]}]) {
    const raw=createFirestoreCaller({base:'https://offline.invalid',access:'fake',fetchImpl:async()=>response(200,result)});
    assert.deepEqual(await raw.call(':commit',{writes:[{}]}),result);
    assert.equal(raw.commitAttempts(),1);assert.equal(raw.writeAttempts(),1);assert.equal(raw.unknownCommitOutcomes(),1);
  }
  const raw=createFirestoreCaller({base:'https://offline.invalid',access:'fake',fetchImpl:async()=>response(200,{writeResults:[{}]})});
  await raw.call(':commit',{writes:[{}]});
  assert.equal(raw.unknownCommitOutcomes(),0);assert.equal(raw.writeAttempts(),1);
});

const budgetQuery = limit => ({structuredQuery:{from:[{collectionId:'queue'}],limit}});
const queryRows = count => Array.from({length:count}, (_, i) => ({document:{name:'queue/' + i}}));
const budgetCaller = options => createFirestoreCaller({base:'https://offline.invalid/documents',access:'PRIVATE_ACCESS',
  documentReadLimit:1500,documentWriteLimit:1000,...options});
const pending = () => {
  let resolve;
  const promise = new Promise(done => {resolve = done;});
  return {promise,resolve};
};

test('100-document query reserves 100 document reads before one HTTP attempt, then settles actual documents', async () => {
  let db, calls = 0;
  db = budgetCaller({fetchImpl:async()=>{
    calls++;
    assert.equal(db.documentBudget().usedReads,100);
    assert.equal(db.httpRequests(),1);
    return response(200,queryRows(100));
  }});
  await db.call(':runQuery',budgetQuery(100));
  assert.equal(calls,1);
  assert.equal(db.estimatedDocumentReads(),100);
  assert.equal(db.returnedDocuments(),100);
  assert.equal(db.documentBudget().usedReads,100);
  assert.equal(db.documentBudget().remainingReads,1400);
});

test('successful empty and partial queries refund unused reservations, preserving empty minimum of one', async () => {
  let calls = 0;
  const db = budgetCaller({documentReadLimit:100,fetchImpl:async()=>response(200,++calls === 1 ? [] : queryRows(2))});
  await db.call(':runQuery',budgetQuery(100));
  assert.equal(db.documentBudget().usedReads,1);
  assert.equal(db.documentBudget().remainingReads,99);
  await db.call(':runQuery',budgetQuery(99));
  assert.equal(db.documentBudget().usedReads,3);
  assert.equal(db.estimatedDocumentReads(),3);
  assert.equal(db.emptyQueryMinimumReads(),1);
  assert.equal(db.httpRequests(),2);
});

test('direct GET misses and batchGet missing documents consume document reads, not just returned documents', async () => {
  const db = budgetCaller({documentReadLimit:4,fetchImpl:async url=>url.endsWith(':batchGet')
    ? response(200,[{found:{name:'queue/one'}},{missing:'queue/two'},{missing:'queue/three'}]) : response(404)});
  await db.call(':batchGet',{documents:['queue/one','queue/two','queue/three']});
  await db.call('/queue/missing');
  assert.equal(db.documentBudget().usedReads,4);
  assert.equal(db.returnedDocuments(),1);
  assert.equal(db.estimatedDocumentReads(),4);
  assert.equal(db.httpRequests(),2);
  await assert.rejects(db.call('/queue/extra'),{code:'FIRESTORE_DOCUMENT_BUDGET',reason:'read_limit',deferred:true});
  assert.equal(db.httpRequests(),2);
});

test('zero-document batch and transaction control calls do not fabricate document reads or writes', async () => {
  const db = budgetCaller({fetchImpl:async url=>url.endsWith(':batchGet') ? response(200,[]) :
    url.endsWith(':commit') ? response(200,{writeResults:[]}) : response(200,{transaction:'synthetic'})});
  await db.call(':batchGet',{documents:[]});
  await db.call(':beginTransaction',{});
  await db.call(':commit',{writes:[]});
  await db.call(':rollback',{transaction:'synthetic'});
  assert.equal(db.documentBudget().usedReads,0);
  assert.equal(db.documentBudget().usedWrites,0);
  assert.equal(db.httpRequests(),4);
});

test('concurrent read reservations cannot oversubscribe; a stopped in-flight result cannot escape for stale publication', async () => {
  const gate = pending();
  let calls = 0;
  const db = budgetCaller({documentReadLimit:100,fetchImpl:async()=>{calls++;return gate.promise;}});
  const inFlight = db.call(':runQuery',budgetQuery(100));
  assert.equal(db.documentBudget().usedReads,100);
  let failure;
  await assert.rejects(db.call('/queue/another'),error=>{
    failure = error;
    assert.ok(error instanceof FirestoreDocumentBudgetError);
    assert.equal(error.reason,'read_limit');
    return true;
  });
  const rejectedResult = assert.rejects(inFlight,error=>error===failure);
  gate.resolve(response(200,queryRows(2)));
  await rejectedResult;
  assert.equal(db.documentBudget().usedReads,2,'actual successful response still releases unused reservation');
  assert.equal(db.documentBudget().stopped,true,'refunds never reopen a stopped caller');
  await assert.rejects(db.call(':commit',{writes:[{proof:'MUST_NOT_PUBLISH_STALE_OUTPUT'}]}),error=>error===failure);
  await assert.rejects(db.call('/queue/fresh'),error=>error===failure);
  assert.equal(calls,1);
});

test('admitted concurrent calls reserve and refund independently', async () => {
  const gates = [pending(),pending()];
  let calls = 0;
  const db = budgetCaller({documentReadLimit:100,fetchImpl:async()=>gates[calls++].promise});
  const first = db.call(':runQuery',budgetQuery(60));
  const second = db.call(':runQuery',budgetQuery(40));
  assert.equal(db.documentBudget().usedReads,100);
  gates[1].resolve(response(200,[]));
  await second;
  assert.equal(db.documentBudget().usedReads,61);
  gates[0].resolve(response(200,queryRows(10)));
  await first;
  assert.equal(db.documentBudget().usedReads,11);
  assert.equal(db.documentBudget().stopped,false);
  assert.equal(calls,2);
});

test('retries retain a failed full reservation and reserve the full query upper bound again', async () => {
  const seen = [];
  let db, retries = 0;
  db = budgetCaller({documentReadLimit:200,fetchImpl:async()=>{
    seen.push(db.documentBudget().usedReads);
    return seen.length === 1 ? response(429) : response(200,queryRows(3));
  },sleep:quiet});
  await db.call(':runQuery',budgetQuery(100),{onRetry:()=>{retries++;}});
  assert.deepEqual(seen,[100,200]);
  assert.equal(retries,1);
  assert.equal(db.documentBudget().usedReads,103);
  assert.equal(db.estimatedDocumentReads(),3);
  assert.equal(db.httpRequests(),2);
});

test('retry admission exhaustion sends no second HTTP and permanently blocks read and write catch-and-continue', async () => {
  let calls = 0;
  const db = budgetCaller({documentReadLimit:100,fetchImpl:async()=>{calls++;return response(429);},sleep:quiet});
  await assert.rejects(db.call(':runQuery',budgetQuery(100)),{reason:'read_limit',deferred:true});
  assert.equal(db.documentBudget().usedReads,100);
  for (const [endpoint,body] of [['/queue/one'],[':runQuery',budgetQuery(1)],[':batchGet',{documents:[]}],
    [':commit',{writes:[{}]}],[':commit',{writes:[]}],[':beginTransaction',{}]]) {
    await assert.rejects(db.call(endpoint,body),FirestoreDocumentBudgetError);
  }
  assert.equal(calls,1);
  assert.equal(db.httpRequests(),1);
});

test('a concurrent stop during retry backoff prevents retry transport and publication from earlier successful output', async () => {
  const sleeping = pending(), release = pending();
  let calls = 0;
  const db = budgetCaller({documentReadLimit:11,fetchImpl:async()=>++calls === 1
    ? response(200,{name:'queue/previous'}) : response(429), sleep:async()=>{sleeping.resolve();await release.promise;}});
  const previous = await db.call('/queue/previous');
  const retrying = db.call(':runQuery',budgetQuery(10));
  await sleeping.promise;
  await assert.rejects(db.call('/queue/one'),{reason:'read_limit'});
  const stoppedRetry = assert.rejects(retrying,FirestoreDocumentBudgetError);
  release.resolve();
  await stoppedRetry;
  await assert.rejects(db.call(':commit',{writes:[{update:{name:previous.name,fields:{proof:'MUST_NOT_PUBLISH'}}}]}),FirestoreDocumentBudgetError);
  assert.equal(calls,2);
  assert.equal(db.httpRequests(),2);
});

test('failed HTTP, network and unreadable responses keep the full reservation', async () => {
  for (const fail of [()=>response(400),()=>response(503),()=>{throw Error('synthetic transport');},
    ()=>({ok:true,status:200,json:async()=>{throw Error('PRIVATE_RESPONSE');}})]) {
    const db = budgetCaller({documentReadLimit:100,fetchImpl:async()=>fail()});
    await assert.rejects(db.call(':runQuery',budgetQuery(100)));
    assert.equal(db.documentBudget().usedReads,100);
    assert.equal(db.estimatedDocumentReads(),0);
    await assert.rejects(db.call('/queue/another'),{reason:'read_limit'});
    assert.equal(db.httpRequests(),1);
  }
});

test('write budgets count every commit write including deletes/transforms, not one HTTP call', async () => {
  const writes = [{update:{name:'queue/one'}},{delete:'queue/two'},{transform:{document:'queue/three'}}];
  let db, calls = 0;
  db = budgetCaller({documentWriteLimit:3,fetchImpl:async()=>{
    calls++;
    assert.equal(db.documentBudget().usedWrites,3);
    return response(200,{writeResults:[{},{},{}]});
  }});
  await db.call(':commit',{writes});
  assert.equal(db.estimatedDocumentWrites(),3);
  assert.equal(db.documentBudget().usedWrites,3);
  assert.equal(db.documentBudget().usedReads,0);
  assert.equal(db.httpRequests(),1);
  await assert.rejects(db.call(':commit',{writes:[{}]}),{reason:'write_limit',deferred:true});
  await assert.rejects(db.call('/queue/fresh'),FirestoreDocumentBudgetError);
  assert.equal(calls,1);
});

test('concurrent commits reserve atomically and failed commits never release potential writes', async () => {
  const gate = pending();
  let calls = 0;
  const db = budgetCaller({documentWriteLimit:3,fetchImpl:async()=>{calls++;return gate.promise;}});
  const first = db.call(':commit',{writes:[{},{}]});
  assert.equal(db.documentBudget().usedWrites,2);
  await assert.rejects(db.call(':commit',{writes:[{},{}]}),{reason:'write_limit'});
  const failure = assert.rejects(first,{status:503});
  gate.resolve(response(503));
  await failure;
  assert.equal(db.documentBudget().usedWrites,2);
  assert.equal(db.estimatedDocumentWrites(),0);
  assert.equal(calls,1);
});

test('unknown commit outcomes keep all writes reserved and never automatically retry', async () => {
  for (const fail of [()=>response(429),()=>response(503),()=>{throw Error('Synthetic network failure');},
    ()=>({ok:true,status:200,json:async()=>{throw Error('PRIVATE_RESPONSE');}}),()=>response(200,{writeResults:[]})]) {
    let calls = 0;
    const db = budgetCaller({documentWriteLimit:2,fetchImpl:async()=>{calls++;return fail();},sleep:()=>assert.fail('No commit retry')});
    await assert.rejects(db.call(':commit',{writes:[{},{}]}));
    assert.equal(db.documentBudget().usedWrites,2);
    assert.equal(db.estimatedDocumentWrites(),0);
    await assert.rejects(db.call(':commit',{writes:[{}]}),FirestoreDocumentBudgetError);
    assert.equal(calls,1);
  }
});

test('only a proven zero-document rollback is allowed after a document-budget stop', async () => {
  let calls = 0;
  const db = budgetCaller({documentReadLimit:1,fetchImpl:async url=>{
    calls++; assert.ok(url.endsWith(':rollback')); return response(200,{});
  }});
  await assert.rejects(db.call(':runQuery',budgetQuery(2)),{reason:'read_limit'});
  assert.equal(calls,0);
  for (const body of [undefined,{}, {transaction:''},{transaction:'synthetic',writes:[{}]}]) {
    await assert.rejects(db.call(':rollback',body),FirestoreDocumentBudgetError);
  }
  await db.call(':rollback',{transaction:'synthetic'});
  assert.equal(calls,1);
  assert.equal(db.documentBudget().usedReads,0);
  assert.equal(db.documentBudget().usedWrites,0);
  await assert.rejects(db.call('/queue/one'),FirestoreDocumentBudgetError);
  assert.equal(calls,1);
});

test('scheduled 429 remains latched for all operations including otherwise-free rollback with document budgets enabled', async () => {
  let calls = 0;
  const db = budgetCaller({mode:'scheduled',fetchImpl:async()=>{calls++;return response(429);},sleep:()=>assert.fail('No retry')});
  await assert.rejects(db.call(':runQuery',budgetQuery(100)),{code:'FIRESTORE_READ_THROTTLED',deferred:true});
  await assert.rejects(db.call(':rollback',{transaction:'synthetic'}),{code:'FIRESTORE_READ_THROTTLED'});
  await assert.rejects(db.call(':commit',{writes:[{}]}),{code:'FIRESTORE_READ_THROTTLED'});
  assert.equal(db.documentBudget().usedReads,100);
  assert.equal(calls,1);
});

test('unbounded, offset, unsupported, and invalid requests latch without any network attempt', async () => {
  for (const [endpoint,body] of [
    [':runQuery',{}], [':runQuery',budgetQuery(0)], [':runQuery',budgetQuery(-1)],
    [':runQuery',budgetQuery('100')], [':runQuery',budgetQuery(Infinity)],
    [':runQuery',{structuredQuery:{limit:5,offset:0}}], [':runQuery',{structuredQuery:{limit:5,offset:10}}],
    [':runQuery',{structuredQuery:{limit:5,findNearest:{limit:100}}}],
    [':batchGet',{}], [':batchGet',{documents:'private'}], [':batchGet',{documents:[null]}],
    [':commit',{}], [':commit',{writes:{length:1}}], [':unknownOperation',{}], ['/queue'],
    ['/queue/id%2Fchild'], ['/queue/id:runQuery'], ['/queue/id/.././other/doc'],
    ['/queue/id/%2e%2e/./other/doc'], ['/queue/id\\child\\other'], ['/queue/id%5Cchild']]) {
    const db = budgetCaller({fetchImpl:()=>assert.fail('No transport allowed')});
    await assert.rejects(db.call(endpoint,body),{code:'FIRESTORE_DOCUMENT_BUDGET',reason:'unbounded_operation',deferred:true});
    await assert.rejects(db.call(':commit',{writes:[{proof:'MUST_NOT_PUBLISH'}]}),FirestoreDocumentBudgetError);
    assert.equal(db.httpRequests(),0);
    assert.equal(db.documentBudget().usedReads,0);
    assert.equal(db.documentBudget().usedWrites,0);
  }
});

test('malformed or over-bound read results are never exposed as successful output under budgeting', async () => {
  for (const [endpoint,body,result] of [
    [':runQuery',budgetQuery(2),{}], [':runQuery',budgetQuery(2),[{error:{message:'PRIVATE_ERROR'}}]],
    [':runQuery',budgetQuery(2),queryRows(3)], [':runQuery',budgetQuery(2),[{readTime:'synthetic',skippedResults:1}]],
    [':batchGet',{documents:['queue/one']},[]], ['/queue/one',undefined,null],
    [':commit',{writes:[{}]},{writeResults:[]}], [':commit',{writes:[{}]},{writeResults:[null]}]]) {
    const db = budgetCaller({fetchImpl:async()=>response(200,result)});
    await assert.rejects(db.call(endpoint,body),error=>{
      assert.ok(error instanceof FirestoreDocumentBudgetError);
      assert.doesNotMatch(JSON.stringify(error),/PRIVATE/);
      return true;
    });
    await assert.rejects(db.call(':commit',{writes:[{}]}),FirestoreDocumentBudgetError);
    assert.equal(db.httpRequests(),1);
  }
});

test('serialized budget requests cannot grow through input mutation or retry callbacks; call options cannot override caps', async () => {
  const input = budgetQuery(10);
  let calls = 0;
  const db = budgetCaller({documentReadLimit:20,fetchImpl:async(_url,init)=>{
    calls++;
    assert.equal(JSON.parse(init.body).structuredQuery.limit,10);
    input.structuredQuery.limit = 10000;
    return calls === 1 ? response(429) : response(200,[]);
  },sleep:quiet});
  await db.call(':runQuery',input,{onRetry:()=>{input.structuredQuery.limit=20000;},documentReadLimit:999999});
  assert.equal(db.documentBudget().usedReads,11);
  assert.equal(calls,2);
  await assert.rejects(db.call(':runQuery',budgetQuery(10),{documentReadLimit:999999}),{reason:'read_limit'});
  assert.equal(calls,2);
});

test('local serialization failures do not reserve documents or fabricate HTTP attempts', async () => {
  const db = budgetCaller({fetchImpl:()=>assert.fail('No transport')});
  const body = budgetQuery(10); body.circular = body;
  await assert.rejects(db.call(':runQuery',body),TypeError);
  assert.equal(db.httpRequests(),0);
  assert.equal(db.documentBudget().usedReads,0);
  assert.equal(db.documentBudget().stopped,false);
});

test('document budget configuration accepts only finite positive safe-integer caps and unset defaults to Infinity', () => {
  assert.deepEqual(firestoreDocumentLimits({}),{documentReadLimit:Infinity,documentWriteLimit:Infinity});
  assert.deepEqual(firestoreDocumentLimits({VERIFIER_DOCUMENT_READ_LIMIT:'1500',VERIFIER_DOCUMENT_WRITE_LIMIT:'1000'}),
    {documentReadLimit:1500,documentWriteLimit:1000});
  assert.equal(createFirestoreCaller({base:'offline',access:'synthetic'}).documentBudget().readLimit,Infinity);
  for (const value of [null,0,-1,1.5,NaN,Infinity,'1500',true,Number.MAX_SAFE_INTEGER+1]) {
    for (const key of ['documentReadLimit','documentWriteLimit']) assert.throws(()=>budgetCaller({[key]:value}),/document .* limit/);
  }
  for (const value of ['', '0','-1','1.5','Infinity',' 1500','1500 ','1e3','0x10','001','9007199254740992',1500,true,null]) {
    for (const key of ['VERIFIER_DOCUMENT_READ_LIMIT','VERIFIER_DOCUMENT_WRITE_LIMIT']) {
      assert.throws(()=>firestoreDocumentLimits({[key]:value}),/document .* limit/);
    }
  }
});

test('either configured cap enables bounded-operation validation without consulting process env in the raw caller', async () => {
  const prior = process.env.VERIFIER_DOCUMENT_READ_LIMIT;
  process.env.VERIFIER_DOCUMENT_READ_LIMIT='INVALID';
  try {
    const readOnly = createFirestoreCaller({base:'offline',access:'synthetic',documentReadLimit:1,
      fetchImpl:async()=>response(200,{writeResults:[{},{}]})});
    await readOnly.call(':commit',{writes:[{},{}]});
    assert.equal(readOnly.documentBudget().writeLimit,Infinity);
    assert.equal(readOnly.documentBudget().usedWrites,2);
    const writeOnly = createFirestoreCaller({base:'offline',access:'synthetic',documentWriteLimit:1,
      fetchImpl:()=>assert.fail('Unbounded queries are not allowed')});
    assert.equal(writeOnly.documentBudget().readLimit,Infinity);
    await assert.rejects(writeOnly.call(':runQuery',{}),{reason:'unbounded_operation'});
    const legacy = createFirestoreCaller({base:'offline',access:'synthetic',fetchImpl:async()=>response(200,[])});
    await legacy.call(':runQuery',{});
    assert.equal(legacy.documentBudget().readLimit,Infinity);
  } finally {
    if (prior === undefined) delete process.env.VERIFIER_DOCUMENT_READ_LIMIT;
    else process.env.VERIFIER_DOCUMENT_READ_LIMIT=prior;
  }
});

test('connect validates document env/options before OAuth and explicit caps override trusted env defaults', async t => {
  const {privateKey} = generateKeyPairSync('rsa',{modulusLength:2048});
  const raw = JSON.stringify({project_id:'polytrack-052',client_email:'synthetic@example.invalid',
    private_key:privateKey.export({format:'pem',type:'pkcs8'})});
  let calls = 0;
  t.mock.method(globalThis,'fetch',async url=>{
    calls++;
    assert.equal(url,'https://oauth2.googleapis.com/token','No Firestore request should be admitted');
    return response(200,{access_token:'SYNTHETIC_ACCESS'});
  });
  await assert.rejects(connect(raw,{env:{VERIFIER_DOCUMENT_READ_LIMIT:'0'}}),/document read limit/);
  await assert.rejects(connect(raw,{env:{},documentWriteLimit:Infinity}),/document write limit/);
  assert.equal(calls,0);
  const configured = await connect(raw,{env:{VERIFIER_DOCUMENT_READ_LIMIT:'1500',VERIFIER_DOCUMENT_WRITE_LIMIT:'1000'}});
  assert.equal(configured.documentBudget().readLimit,1500);
  assert.equal(configured.documentBudget().writeLimit,1000);
  const explicit = await connect(raw,{env:{VERIFIER_DOCUMENT_READ_LIMIT:'INVALID',VERIFIER_DOCUMENT_WRITE_LIMIT:'INVALID'},
    documentReadLimit:2,documentWriteLimit:3});
  assert.equal(explicit.documentBudget().readLimit,2);
  assert.equal(explicit.documentBudget().writeLimit,3);
  await assert.rejects(explicit.call(':runQuery',budgetQuery(3)),{reason:'read_limit'});
  await assert.rejects(explicit.call(':commit',{writes:[{}]}),FirestoreDocumentBudgetError);
  assert.equal(calls,2);
  const keys = ['VERIFIER_DOCUMENT_READ_LIMIT','VERIFIER_DOCUMENT_WRITE_LIMIT'];
  const prior = keys.map(key=>process.env[key]);
  try {
    process.env.VERIFIER_DOCUMENT_READ_LIMIT='1500'; process.env.VERIFIER_DOCUMENT_WRITE_LIMIT='1000';
    const defaults = await connect(raw,{mode:'manual'});
    assert.equal(defaults.documentBudget().readLimit,1500);
    assert.equal(defaults.documentBudget().writeLimit,1000);
    const legacy = await connect(raw,{env:{}});
    assert.equal(legacy.documentBudget().readLimit,Infinity);
    assert.equal(legacy.documentBudget().writeLimit,Infinity);
  } finally {
    keys.forEach((key,i)=>{if(prior[i]===undefined)delete process.env[key];else process.env[key]=prior[i];});
  }
});
