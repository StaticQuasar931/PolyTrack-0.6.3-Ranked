import assert from 'node:assert/strict';
import test from 'node:test';
import {generateKeyPairSync, verify, webcrypto} from 'node:crypto';
import {CAPTURE_HEADER_NAME, CAPTURE_AUDIENCE, createWorkerCaptureFetch,
  classifyWorkerCaptureRequest, resolveWorkerCaptureFetch} from './worker-capture-fetch.mjs';
import {createCaptureReadVerifier, CAPTURE_HEADER_NAME as WORKER_HEADER} from '../workers/ranked/src/capture-read-auth.js';

const origin = 'https://polytrack-ranked-worker.staticquasar931.workers.dev';
const at = 1800000000000;
const pair = generateKeyPairSync('rsa', {modulusLength: 2048});
const account = {type: 'service_account', client_email: 'capture@fixture-project.iam.gserviceaccount.com',
  private_key_id: 'fixture_key', private_key: pair.privateKey.export({format: 'pem', type: 'pkcs8'})};
const decode = segment => JSON.parse(Buffer.from(segment, 'base64url'));

test('resolver preserves every explicit injected fixture and only wraps an omitted production fetch', async () => {
  let calls = 0;
  const fixture = async (url, options) => {
    calls++;
    assert.equal(url, 'https://fixture.invalid/unrelated');
    assert.equal(options, undefined);
    return new Response('{}');
  };
  assert.equal(resolveWorkerCaptureFetch(fixture, {serviceAccount: null}), fixture);
  assert.equal(resolveWorkerCaptureFetch(globalThis.fetch, {serviceAccount: null}), globalThis.fetch);
  await resolveWorkerCaptureFetch(fixture)('https://fixture.invalid/unrelated');
  assert.equal(calls, 1);
  await assert.rejects(resolveWorkerCaptureFetch(undefined, {serviceAccount: null})(origin + '/v1/status'), /FIREBASE_VERIFIER_SERVICE_ACCOUNT/);
  assert.throws(() => resolveWorkerCaptureFetch(null), /Invalid injected/);
});

test('already-admin-authenticated archive GETs bypass signing but not host, method or route boundaries', async () => {
  let calls = 0;
  const capture = createWorkerCaptureFetch({serviceAccount: null, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(options.headers.get('X-Admin-Token'), 'fixture-admin-secret');
    assert.equal(options.headers.has(CAPTURE_HEADER_NAME), false);
    assert.equal(options.redirect, 'error');
    assert.equal(options.method, 'GET');
    return new Response('{}');
  }});
  const headers = {'X-Admin-Token': 'fixture-admin-secret'};
  const paths = ['/v1/events/admin/archive-export/a/snapshot', '/v1/events/admin/archive-export/a/track',
    '/v1/events/admin/archive-export/a/replays/' + 'a'.repeat(64), '/v1/events/admin/archive-export/archives/202610',
    '/v1/events/admin/archive-export/a/snapshot/page?generation=' + 'a'.repeat(64) + '&page=1'];
  for (const path of paths) {
    assert.equal(classifyWorkerCaptureRequest(origin + path, {headers}), 'admin-archive');
    await capture(origin + path, {headers});
  }
  assert.equal(calls, paths.length);
  for (const url of ['https://foreign.invalid' + paths[0], origin + '/v1/admin/rebuild',
    origin + '/v1/events/admin/archive-export/a/snapshot?unexpected=1',
    origin + '/v1/events/admin/archive-export/a/snapshot/page?generation=a&page=1',
    origin + '/v1/events/admin/archive-export/archives/202613']) {
    assert.equal(classifyWorkerCaptureRequest(url, {headers}), 'denied');
    await assert.rejects(capture(url, {headers}), /outside authorized read boundary/);
  }
  await assert.rejects(capture(origin + paths[0]), /outside authorized read boundary/);
  await assert.rejects(capture(origin + paths[0], {method: 'POST', headers}), /outside authorized read boundary/);
  assert.equal(classifyWorkerCaptureRequest(origin + '/v1/status'), 'capture');
  assert.equal(classifyWorkerCaptureRequest('https://unrelated.invalid/file.js'), 'denied');
  assert.equal(calls, paths.length);
});

test('signer emits exact standard RS256 claims, preserves query bytes, and never permits redirects', async () => {
  const path = '/v1/snapshot/track/page?trackId=a%20b&generation=abc&page=2';
  let time = at;
  const capture = createWorkerCaptureFetch({serviceAccount: JSON.stringify(account), now: () => time,
    fetchImpl: async (url, options) => {
      assert.equal(url, origin + path);
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.headers.get('Origin'), 'https://staticquasar931.github.io');
      assert.equal(options.headers.get('X-PolyTrack-Revision'), '239');
      assert.equal(options.body, undefined);
      const parts = options.headers.get(CAPTURE_HEADER_NAME).split('.');
      assert.deepEqual(decode(parts[0]), {alg: 'RS256', typ: 'JWT', kid: account.private_key_id});
      assert.deepEqual(decode(parts[1]), {iss: account.client_email, aud: CAPTURE_AUDIENCE,
        method: 'GET', path, iat: time / 1000, exp: time / 1000 + 60});
      assert.equal(verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), pair.publicKey,
        Buffer.from(parts[2], 'base64url')), true);
      return new Response('fixture');
    }});
  const options = {headers: {Origin: 'https://staticquasar931.github.io', 'X-PolyTrack-Revision': '239'}, redirect: 'follow'};
  assert.equal(await (await capture(origin + path, options)).text(), 'fixture');
  time += 1000;
  await capture(new URL(origin + path), options);
  assert.equal(options.headers[CAPTURE_HEADER_NAME], undefined);
});

test('all approved public GET capture families sign, including capture-auth and broad event exports', async () => {
  let calls = 0;
  const capture = createWorkerCaptureFetch({serviceAccount: account, now: () => at, fetchImpl: async () => {
    calls++; return new Response('{}');
  }});
  const paths = ['/v1/status', '/v1/capture-auth', '/v1/snapshot/overall', '/v1/snapshot/overall/page?page=0',
    '/v1/snapshot/track?trackId=a', '/v1/snapshot/track/page?page=0', '/v1/events/catalog', '/v1/events/current',
    '/v1/events/totals', '/v1/events/totals/page?page=0', '/v1/events/periods/a/export/all',
    '/v1/events/a/snapshot', '/v1/events/a/replays/' + 'a'.repeat(64), '/v1/events/archives/202610',
    '/v1/extra-tracks/unranked?trackId=a', '/v1/kodub-weekly'];
  for (const path of paths) await capture(origin + path);
  assert.equal(calls, paths.length);
});

test('unknown, admin, encoded bypass, credentials, fragment, foreign host and non-GET URLs never reach transport', async () => {
  let calls = 0;
  const capture = createWorkerCaptureFetch({serviceAccount: null, fetchImpl: async () => {calls++; throw Error('must not run');}});
  const denied = ['https://attacker.invalid/v1/status', origin + '.attacker.invalid/v1/status',
    'http://polytrack-ranked-worker.staticquasar931.workers.dev/v1/status', origin + ':444/v1/status',
    'https://user:pass@polytrack-ranked-worker.staticquasar931.workers.dev/v1/status', origin + '/v1/status#fragment',
    origin + '/v1/admin/export', origin + '/v1/events/admin/archive-export/archives/202610',
    origin + '/v1/events/periods/a/admin/export', origin + '/v1/events/%61dmin/export',
    origin + '/v1/events/a%2fadmin/export', origin + '/v1/events/a//export', origin + '/v1/events/a/export/',
    origin + '/v1/profile/group-code', origin + '/v1/snapshot/other', origin + '/v1/status?x=' + 'a'.repeat(2050)];
  for (const url of denied) await assert.rejects(capture(url), /outside authorized read boundary/);
  for (const method of ['POST', 'HEAD', 'OPTIONS', 'get'])
    await assert.rejects(capture(origin + '/v1/status', {method}), /outside authorized read boundary/);
  await assert.rejects(capture(origin + '/v1/status', {body: 'data'}), /outside authorized read boundary/);
  await assert.rejects(capture(origin + '/v1/status', {headers: {[CAPTURE_HEADER_NAME]: 'do-not-forward'}}), /Caller-supplied/);
  assert.equal(calls, 0);
});

test('Request input headers and signals are preserved without mutating the original request', async () => {
  const controller = new AbortController();
  const original = new Request(origin + '/v1/status', {headers: {accept: 'application/json'}, signal: controller.signal});
  const capture = createWorkerCaptureFetch({serviceAccount: account, now: () => at, fetchImpl: async (_url, options) => {
    assert.equal(options.headers.get('accept'), 'application/json');
    assert.ok(options.headers.has(CAPTURE_HEADER_NAME));
    assert.equal(options.signal, original.signal);
    return new Response('{}');
  }});
  await capture(original);
  assert.equal(original.headers.has(CAPTURE_HEADER_NAME), false);
});

test('invalid credentials and signing time fail without any transport or secret-bearing diagnostics', async () => {
  let calls = 0;
  const fetchImpl = async () => {calls++; return new Response('{}');};
  for (const serviceAccount of [null, 'secret invalid JSON', {}, {...account, private_key_id: '../bad'},
    {...account, client_email: 'https://attacker.invalid'}, {...account, private_key: 'secret invalid key'}]) {
    const capture = createWorkerCaptureFetch({serviceAccount, fetchImpl, now: () => at});
    await assert.rejects(capture(origin + '/v1/status'), error => {
      assert.doesNotMatch(error.message, /secret invalid/);
      return /credential|FIREBASE_VERIFIER_SERVICE_ACCOUNT/.test(error.message);
    });
  }
  const invalidTime = createWorkerCaptureFetch({serviceAccount: account, fetchImpl, now: () => NaN});
  await assert.rejects(invalidTime(origin + '/v1/status'), /signing time/);
  assert.equal(calls, 0);
});

test('redirect responses and transport errors fail closed without reflecting the signed token', async () => {
  for (const fetchImpl of [async () => new Response(null, {status: 302, headers: {location: 'https://attacker.invalid'}}),
    async (_url, options) => {throw Error('leaked token ' + options.headers.get(CAPTURE_HEADER_NAME));}]) {
    const capture = createWorkerCaptureFetch({serviceAccount: account, fetchImpl, now: () => at});
    await assert.rejects(capture(origin + '/v1/status'), error => error.message === 'Worker capture transport failed');
  }
});

test('signer and verifier interoperate offline for exact URLs; authorization does not leak across requests', async () => {
  assert.equal(CAPTURE_HEADER_NAME, WORKER_HEADER);
  let google = 0, admitted = 0;
  const verifyRead = createCaptureReadVerifier({cryptoImpl: webcrypto, now: () => at, fetchImpl: async url => {
    google++;
    assert.equal(url, 'https://www.googleapis.com/service_accounts/v1/jwk/' + encodeURIComponent(account.client_email));
    return new Response(JSON.stringify({keys: [{...pair.publicKey.export({format: 'jwk'}), kid: account.private_key_id}]}),
      {headers: {'content-type': 'application/json'}});
  }});
  const capture = createWorkerCaptureFetch({serviceAccount: account, now: () => at, fetchImpl: async (url, options) => {
    const incoming = new Request(url, options);
    assert.equal(await verifyRead(incoming, {FIREBASE_CLIENT_EMAIL: account.client_email}), true);
    const other = new Request(origin + '/v1/status?changed=1', {headers: options.headers});
    assert.equal(await verifyRead(other, {FIREBASE_CLIENT_EMAIL: account.client_email}), false);
    admitted++;
    return new Response('{}');
  }});
  await capture(origin + '/v1/capture-auth');
  await capture(origin + '/v1/events/periods/a/export?x=%2f&x=%2F');
  assert.equal(admitted, 2);
  assert.equal(google, 1);
});

test('normalized URLs and the maximum accepted URL length interoperate with the Worker', async () => {
  const verifyRead = createCaptureReadVerifier({cryptoImpl: webcrypto, now: () => at, fetchImpl: async () =>
    new Response(JSON.stringify({keys: [{...pair.publicKey.export({format: 'jwk'}), kid: account.private_key_id}]}),
      {headers: {'content-type': 'application/json'}})});
  const capture = createWorkerCaptureFetch({serviceAccount: account, now: () => at, fetchImpl: async (url, options) => {
    assert.equal(await verifyRead(new Request(url, options), {CAPTURE_SERVICE_ACCOUNT_EMAIL: account.client_email}), true);
    return new Response('{}');
  }});
  await capture(origin + '/v1/events/periods/../catalog?x=%2f');
  await capture(origin + '/v1/status?q=' + 'a'.repeat(2048 - '/v1/status?q='.length));
});
