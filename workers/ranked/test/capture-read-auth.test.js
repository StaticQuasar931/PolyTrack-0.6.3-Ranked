import assert from 'node:assert/strict';
import test from 'node:test';
import {generateKeyPairSync, sign, webcrypto} from 'node:crypto';
import {CAPTURE_HEADER_NAME, CAPTURE_AUDIENCE, createCaptureReadVerifier, verifyCaptureRead, isCaptureReadRoute} from '../src/capture-read-auth.js';

const origin = 'https://polytrack-ranked-worker.staticquasar931.workers.dev';
const email = 'capture@fixture-project.iam.gserviceaccount.com';
const env = {CAPTURE_SERVICE_ACCOUNT_EMAIL: email};
const at = 1800000000000;
const pair = generateKeyPairSync('rsa', {modulusLength: 2048});
const other = generateKeyPairSync('rsa', {modulusLength: 2048});
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwk = (kid = 'known') => ({...pair.publicKey.export({format: 'jwk'}), kid, alg: 'RS256', use: 'sig'});
function token({header = {}, claims = {}, key = pair.privateKey, path = '/v1/status'} = {}) {
  const unsigned = encode({alg: 'RS256', typ: 'JWT', kid: 'known', ...header}) + '.' +
    encode({iss: email, aud: CAPTURE_AUDIENCE, method: 'GET', path, iat: at / 1000, exp: at / 1000 + 60, ...claims});
  return unsigned + '.' + sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url');
}
const request = (value = token(), path = '/v1/status', method = 'GET') =>
  new Request(origin + path, {method, headers: value === null ? {} : {[CAPTURE_HEADER_NAME]: value}});

test('route classifier includes every public GET family independent of spoofable Origin or host', () => {
  for (const path of ['/v1/status', '/v1/capture-auth', '/v1/snapshot/overall/page', '/v1/events/catalog',
    '/v1/events/periods/a/export', '/v1/events/a/playbacks/abc', '/v1/extra-tracks/unranked', '/v1/kodub-weekly']) {
    assert.equal(isCaptureReadRoute(new Request('https://foreign.invalid' + path)), true, path);
  }
  for (const path of ['/v1/admin/status', '/v1/events/admin/archive-export/a/snapshot', '/v1/profile/group-code', '/unknown'])
    assert.equal(isCaptureReadRoute(request(null, path)), false, path);
  assert.equal(isCaptureReadRoute(request(null, '/v1/status', 'POST')), false);
  assert.equal(isCaptureReadRoute(request(null, '/v1/status///')), true);
  assert.equal(isCaptureReadRoute(request(null, '/v1/snapshot/overall/')), true);
  assert.equal(isCaptureReadRoute({method: 'GET', url: 'invalid'}), false);
});
function fixture({transport, keys = [jwk()]} = {}) {
  let time = at, calls = 0, current = keys;
  const verify = createCaptureReadVerifier({cryptoImpl: webcrypto, now: () => time, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://www.googleapis.com/service_accounts/v1/jwk/' + encodeURIComponent(email));
    assert.equal(options.redirect, 'manual','Workers does not support redirect:error');
    assert.equal(options.method, 'GET');
    assert.equal(Object.hasOwn(options,'credentials'), false,'Workers has no browser credential mode');
    assert.ok(options.signal instanceof AbortSignal);
    if (transport) return transport(url, options);
    return new Response(JSON.stringify({keys: current}), {headers: {'content-type': 'application/json', 'cache-control': 'max-age=300'}});
  }});
  return {verify, calls: () => calls, advance: ms => {time += ms;}, keys: value => {current = value;}};
}

test('valid signed reads and zero-database capture-auth probe verify; warm keys are reused', async () => {
  const f = fixture();
  for (const path of ['/v1/status', '/v1/capture-auth', '/v1/snapshot/overall', '/v1/snapshot/track/page?trackId=abc&page=2',
    '/v1/events/catalog', '/v1/events/totals/page?page=1', '/v1/events/periods/w_20261029/export',
    '/v1/events/w_20261029/snapshot/page?generation=abc&page=0', '/v1/events/archives/202610']) {
    assert.equal(await f.verify(request(token({path}), path), env), true, path);
  }
  assert.equal(f.calls(), 1);
  assert.equal(await f.verify(request(), {FIREBASE_CLIENT_EMAIL: email}), true);
});

test('missing/malformed/oversize tokens and wrong claims never fetch Google', async () => {
  const f = fixture();
  const invalid = [null, '', 'a.b.c', 'x'.repeat(7000), 'e30.e30.invalid', token({header: {alg: 'HS256'}}),
    token({header: {typ: 'JWS'}}), token({header: {kid: '../bad'}}), token({header: {jku: 'https://attacker.invalid'}}),
    token({claims: {iss: 'other@fixture-project.iam.gserviceaccount.com'}}), token({claims: {aud: ['polytrack-private-capture-v1']}}),
    token({claims: {aud: 'wrong'}}), token({claims: {method: 'POST'}}), token({claims: {path: '/v1/snapshot/overall'}}),
    token({claims: {iat: at / 1000 + 1}}), token({claims: {iat: '1800000000'}}),
    token({claims: {exp: at / 1000}}), token({claims: {exp: at / 1000 + 61}}),
    token({claims: {exp: at / 1000 - 1}}), token({claims: {sub: 'unexpected'}})];
  for (const value of invalid) assert.equal(await f.verify(request(value), env), false);
  assert.equal(await f.verify(request(), {}), false);
  assert.equal(await f.verify(request(), {CAPTURE_SERVICE_ACCOUNT_EMAIL: 'https://attacker.invalid'}), false);
  assert.equal(await f.verify(request(), {...env, CAPTURE_SERVICE_ACCOUNT_EMAIL: 'wrong', FIREBASE_CLIENT_EMAIL: email}), false);
  assert.equal(f.calls(), 0);
  assert.equal(await verifyCaptureRead(request(null), env), false);
});

test('different URL, query ordering/encoding, method, host and admin routes reject before keys', async () => {
  const f = fixture();
  const path = '/v1/snapshot/track?trackId=a%20b&page=1';
  const value = token({path});
  for (const altered of ['/v1/snapshot/track?trackId=a+b&page=1', '/v1/snapshot/track?page=1&trackId=a%20b',
    '/v1/snapshot/track?trackId=a%20b&page=2', '/v1/snapshot/overall'])
    assert.equal(await f.verify(request(value, altered), env), false);
  for (const method of ['POST', 'HEAD', 'OPTIONS']) assert.equal(await f.verify(request(token(), '/v1/status', method), env), false);
  for (const path of ['/v1/admin/export', '/v1/events/admin/archive-export/archives/202610', '/v1/profile/group-code',
    '/v1/events/periods/a/admin/export', '/v1/events/%61dmin/export', '/v1/events/a//snapshot', '/v1/events/a/snapshot/'])
    assert.equal(await f.verify(request(token({path}), path), env), false);
  for (const url of ['http://polytrack-ranked-worker.staticquasar931.workers.dev/v1/status', 'https://attacker.invalid/v1/status',
    origin + ':444/v1/status'])
    assert.equal(await f.verify(new Request(url, {headers: {[CAPTURE_HEADER_NAME]: token()}}), env), false);
  assert.equal(f.calls(), 0);
  assert.equal(await f.verify(request(value, path), env), true);
});

test('altered signatures and a different private key fail closed without refresh churn', async () => {
  const f = fixture();
  assert.equal(await f.verify(request(), env), true);
  assert.equal(await f.verify(request(token({key: other.privateKey})), env), false);
  const parts = token().split('.');
  const sig = Buffer.from(parts[2], 'base64url'); sig[0] ^= 1;
  parts[2] = sig.toString('base64url');
  assert.equal(await f.verify(request(parts.join('.')), env), false);
  const changed = token().split('.');
  changed[1] = encode({iss: email, aud: CAPTURE_AUDIENCE, method: 'GET', path: '/v1/capture-auth', iat: at / 1000, exp: at / 1000 + 60});
  assert.equal(await f.verify(request(changed.join('.'), '/v1/capture-auth'), env), false);
  assert.equal(f.calls(), 1);
});

test('same-URL token replay lasts only until expiry; this is not a one-time nonce protocol', async () => {
  const f = fixture(), value = token();
  assert.equal(await f.verify(request(value), env), true);
  assert.equal(await f.verify(request(value), env), true);
  f.advance(59000);
  assert.equal(await f.verify(request(value), env), true);
  f.advance(1000);
  assert.equal(await f.verify(request(value), env), false);
  assert.equal(f.calls(), 1);
});

test('unknown kids, including different random kids, share one cooldown and one refresh', async () => {
  const f = fixture();
  for (let i = 0; i < 100; i++)
    assert.equal(await f.verify(request(token({header: {kid: 'unknown_' + i}})), env), false);
  assert.equal(f.calls(), 1);
  assert.equal(await f.verify(request(), env), true);
  f.advance(30000);
  f.keys([jwk(), jwk('rotated')]);
  assert.equal(await f.verify(request(token({header: {kid: 'rotated'}})), env), true);
  assert.equal(f.calls(), 2);
  assert.equal(await f.verify(request(token({header: {kid: 'another'}})), env), false);
  assert.equal(f.calls(), 2);
});

test('concurrent cold requests share an in-flight fetch; warm keys bypass an unknown-kid refresh', async () => {
  let release;
  let hold = new Promise(resolve => {release = resolve;});
  const f = fixture({transport: async () => {
    await hold;
    return new Response(JSON.stringify({keys: [jwk()]}), {headers: {'content-type': 'application/json'}});
  }});
  const jobs = Array.from({length: 20}, () => f.verify(request(), env));
  assert.equal(f.calls(), 1);
  release();
  assert.deepEqual(await Promise.all(jobs), Array(20).fill(true));
  f.advance(30000);
  hold = new Promise(resolve => {release = resolve;});
  const unknown = f.verify(request(token({header: {kid: 'unknown'}})), env);
  assert.equal(await f.verify(request(), env), true);
  release();
  assert.equal(await unknown, false);
  assert.equal(f.calls(), 2);
});

test('failed refreshes, redirects, malformed/oversize bodies, and excessive or weak keys fail closed', async () => {
  const cases = [
    () => {throw Error('offline fixture');},
    () => new Response('{}', {status: 302, headers: {location: 'https://attacker.invalid'}}),
    () => new Response('no json', {headers: {'content-type': 'application/json'}}),
    () => new Response('{}', {headers: {'content-type': 'application/json', 'content-length': '20000'}}),
    () => new Response('x'.repeat(17000), {headers: {'content-type': 'application/json'}}),
    () => new Response(JSON.stringify({keys: Array.from({length: 5}, (_, i) => jwk('key_' + i))}), {headers: {'content-type': 'application/json'}}),
    () => new Response(JSON.stringify({keys: [jwk(), jwk()]}), {headers: {'content-type': 'application/json'}}),
    () => new Response(JSON.stringify({keys: [{...jwk(), kty: 'oct'}]}), {headers: {'content-type': 'application/json'}}),
    () => new Response(JSON.stringify({keys: [{...jwk(), n: 'AA'}]}), {headers: {'content-type': 'application/json'}})
  ];
  for (const transport of cases) {
    const f = fixture({transport});
    assert.equal(await f.verify(request(), env), false);
    assert.equal(await f.verify(request(), env), false);
    assert.equal(f.calls(), 1);
  }
});

test('a stalled key fetch times out and cannot cause repeated immediate fetches', async () => {
  let signal;
  const f = fixture({transport: (_url, options) => {signal = options.signal; return new Promise(() => {});}});
  assert.equal(await f.verify(request(), env), false);
  assert.equal(signal.aborted, true);
  assert.equal(await f.verify(request(), env), false);
  assert.equal(f.calls(), 1);
});

test('issuer changes cannot grow or churn the single-issuer cache', async () => {
  const f = fixture();
  assert.equal(await f.verify(request(), env), true);
  const issuer = 'other@fixture-project.iam.gserviceaccount.com';
  assert.equal(await f.verify(request(token({claims: {iss: issuer}})), {CAPTURE_SERVICE_ACCOUNT_EMAIL: issuer}), false);
  assert.equal(f.calls(), 1);
});

test('refresh failure retains warm keys but never uses expired keys, and recovery respects cooldown', async () => {
  let failure = false;
  const f = fixture({transport: async () => {
    if (failure) throw Error('offline fixture');
    return new Response(JSON.stringify({keys: [jwk()]}), {headers: {'content-type': 'application/json', 'cache-control': 'max-age=45'}});
  }});
  assert.equal(await f.verify(request(), env), true);
  failure = true;
  f.advance(30000);
  assert.equal(await f.verify(request(token({header: {kid: 'unknown'}})), env), false);
  assert.equal(await f.verify(request(), env), true);
  f.advance(16000);
  assert.equal(await f.verify(request(), env), false);
  assert.equal(f.calls(), 2);
  failure = false;
  f.advance(14000);
  const fresh = token({claims: {iat: at / 1000 + 60, exp: at / 1000 + 120}});
  assert.equal(await f.verify(request(fresh), env), true);
  assert.equal(f.calls(), 3);
});

test('expiry is rechecked after key retrieval and after signature verification', async () => {
  let time = at;
  const transport = async () => {
    time += 60000;
    return new Response(JSON.stringify({keys: [jwk()]}), {headers: {'content-type': 'application/json'}});
  };
  const verifyRead = createCaptureReadVerifier({fetchImpl: transport, now: () => time, cryptoImpl: webcrypto});
  assert.equal(await verifyRead(request(), env), false);
  time = at;
  const slowCrypto = {subtle: {
    importKey: (...args) => webcrypto.subtle.importKey(...args),
    verify: async (...args) => {const valid = await webcrypto.subtle.verify(...args); time += 60000; return valid;}
  }};
  const verifySlow = createCaptureReadVerifier({now: () => time, cryptoImpl: slowCrypto, fetchImpl: async () =>
    new Response(JSON.stringify({keys: [jwk()]}), {headers: {'content-type': 'application/json'}})});
  assert.equal(await verifySlow(request(), env), false);
});

test('a key fetch that ignores cancellation cannot commit late cache state', async () => {
  let release;
  const pending = new Promise(resolve => {release = resolve;});
  const f = fixture({transport: async () => {
    await pending;
    return new Response(JSON.stringify({keys: [jwk()]}), {headers: {'content-type': 'application/json'}});
  }});
  assert.equal(await f.verify(request(), env), false);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await f.verify(request(), env), false);
  assert.equal(f.calls(), 1);
});

test('an admission gate calls no database operation for spoofed Origin or invalid signatures', async () => {
  const f = fixture();
  let reads = 0;
  const gated = async incoming => {
    if (!await f.verify(incoming, env)) return 403;
    if (new URL(incoming.url).pathname === '/v1/capture-auth') return 200;
    reads++;
    return 200;
  };
  const spoofed = new Request(origin + '/v1/status', {headers: {Origin: 'https://staticquasar931.github.io'}});
  assert.equal(await gated(spoofed), 403);
  assert.equal(await gated(request(token({key: other.privateKey}))), 403);
  assert.equal(await gated(request(token({path: '/v1/capture-auth'}), '/v1/capture-auth')), 200);
  assert.equal(reads, 0);
  assert.equal(await gated(request()), 200);
  assert.equal(reads, 1);
});
