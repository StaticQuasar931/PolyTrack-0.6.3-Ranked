import assert from 'node:assert/strict';
import test from 'node:test';
import {generateKeyPairSync, sign} from 'node:crypto';

const at = 1_800_000_000_000;
const project = 'polytrack-052';
const origin = 'https://audit.invalid';
const pair = generateKeyPairSync('rsa', {modulusLength: 2048});
const jwk = kid => ({...pair.publicKey.export({format: 'jwk'}), kid, alg: 'RS256', use: 'sig'});
const token = (kid, overrides = {}) => {
  const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = b64({alg: 'RS256', kid}) + '.' + b64({sub: 'test-user', aud: project,
    iss: 'https://securetoken.google.com/' + project, iat: at / 1000, exp: at / 1000 + 7200, ...overrides});
  return body + '.' + sign('RSA-SHA256', Buffer.from(body), pair.privateKey).toString('base64url');
};
const request = (kid, overrides) => new Request(origin + '/v1/pb/notify', {
  method: 'POST', headers: {Origin: origin, Authorization: 'Bearer ' + token(kid, overrides)}, body: '{}'
});
let sequence = 0;
async function fixture(t) {
  const worker = await import('../src/index.js?jwks-test=' + sequence++);
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  let time = at, calls = 0, keys = [jwk('known')], failure = false, release = null;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
    calls++;
    if (release) await release.promise;
    if (failure) throw Error('offline simulated failure');
    return new Response(JSON.stringify({keys}), {headers: {'Cache-Control': 'max-age=300'}});
  };
  Date.now = () => time;
  t.after(() => {globalThis.fetch = originalFetch; Date.now = originalNow;});
  return {...worker, calls: () => calls, advance: ms => {time += ms;}, keys: value => {keys = value.map(jwk);},
    fail: value => {failure = value;}, hold() {
      let resolve;
      release = {promise: new Promise(r => {resolve = r;})};
      return () => {resolve(); release = null;};
    }};
}

test('repeated and distinct unknown kids share one refresh cooldown before UID admission', async t => {
  const f = await fixture(t);
  let rateChecks = 0;
  const env = {ALLOWED_ORIGINS: origin, PB_NOTIFY_RATE_LIMITER: {limit: async () => {
    rateChecks++; return {success: true};
  }}};
  for (const kid of ['missing', 'missing', 'other', 'another', 'last']) {
    assert.equal((await f.handleRequest(request(kid), env)).status, 401);
  }
  assert.equal(f.calls(), 1);
  assert.equal(rateChecks, 0);
  assert.equal(await f.verifyFirebaseUser(request('known'), {}), 'test-user');
  assert.equal(f.calls(), 1, 'invalid tokens do not disrupt known warm keys');
});

test('concurrent cold callers share one key request and validate normally', async t => {
  const f = await fixture(t), release = f.hold();
  const jobs = Array.from({length: 12}, () => f.verifyFirebaseUser(request('known'), {}));
  await new Promise(resolve => setImmediate(resolve));
  const calls = f.calls();
  release();
  assert.deepEqual(await Promise.all(jobs), Array(12).fill('test-user'));
  assert.equal(calls, 1);
});

test('genuine rotation refreshes after cooldown while warm keys bypass an in-flight forced refresh', async t => {
  const f = await fixture(t);
  assert.equal(await f.verifyFirebaseUser(request('known'), {}), 'test-user');
  f.keys(['known', 'rotated']);
  await assert.rejects(f.verifyFirebaseUser(request('rotated'), {}), /AUTH_KEY_UNKNOWN/);
  assert.equal(f.calls(), 1);
  f.advance(30_000);
  const release = f.hold();
  const rotated = f.verifyFirebaseUser(request('rotated'), {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await f.verifyFirebaseUser(request('known'), {}), 'test-user');
  assert.equal(f.calls(), 2);
  release();
  assert.equal(await rotated, 'test-user');
  assert.equal(await f.verifyFirebaseUser(request('rotated'), {}), 'test-user');
  assert.equal(f.calls(), 2);
});

test('failed refreshes are bounded and keep valid warm keys; expired keys fail closed', async t => {
  const f = await fixture(t);
  await f.verifyFirebaseUser(request('known'), {});
  f.advance(30_000); f.fail(true);
  await assert.rejects(f.verifyFirebaseUser(request('unknown'), {}));
  await assert.rejects(f.verifyFirebaseUser(request('other'), {}));
  assert.equal(f.calls(), 2);
  assert.equal(await f.verifyFirebaseUser(request('known'), {}), 'test-user');
  f.advance(300_000);
  await assert.rejects(f.verifyFirebaseUser(request('known'), {}));
  await assert.rejects(f.verifyFirebaseUser(request('known'), {}));
  assert.equal(f.calls(), 3);
  f.advance(30_000); f.fail(false); f.keys(['known', 'rotated']);
  assert.equal(await f.verifyFirebaseUser(request('rotated'), {}), 'test-user');
  assert.equal(f.calls(), 4);
});

for (const overrides of [{exp:undefined}, {exp:'forever'}, {exp:null}, {exp:1.5},
  {iat:undefined}, {iat:'0'}, {iat:-1}, {iat:at / 1000 + 31},
  {sub:['test-user']}, {sub:{id:'test-user'}}, {sub:123}, {aud:'other-project'}, {iss:'https://other.invalid'}]) {
  test('malformed signed claims reject before key transport: '+JSON.stringify(overrides), async t => {
    const f = await fixture(t);
    await assert.rejects(f.verifyFirebaseUser(request('known', overrides), {}), /AUTH_INVALID/);
    assert.equal(f.calls(), 0);
    assert.equal(await f.verifyFirebaseUser(request('known'), {}), 'test-user');
    assert.equal(f.calls(), 1, 'valid signed tokens still use the original key verification');
  });
}
test('claim preflight does not extend expiration across a delayed key refresh', async t => {
  const f = await fixture(t), release = f.hold();
  const pending = f.verifyFirebaseUser(request('known', {exp:at / 1000 + 1}), {});
  await new Promise(resolve=>setImmediate(resolve));
  f.advance(32000); release();
  await assert.rejects(pending, /AUTH_INVALID/);
  assert.equal(f.calls(), 1);
});