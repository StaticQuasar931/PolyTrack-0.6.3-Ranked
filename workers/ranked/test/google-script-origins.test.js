import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {handleRequest} from '../src/index.js';
import {encode} from '../../../tools/verifier/firestore.mjs';

const prefix = 'n-ubvj6uzey5gp44qz2gmscy7oux2l5p53a4jiw2q-';
const owned = [0, 1, 2, 3].map(i => `https://${prefix}${i}lu-script.googleusercontent.com`);
const existing = ['https://staticquasar931.github.io', 'http://localhost:8080', 'http://127.0.0.1:8080'];
const rejected = [
  `https://${prefix}4lu-script.googleusercontent.com`,
  `https://${prefix}0lu-script.googleusercontent.com.evil.test`,
  `https://other-${prefix}1lu-script.googleusercontent.com`,
  'https://other-script.googleusercontent.com',
  'https://script.googleusercontent.com', 'https://script.google.com',
  owned[1].replace('https:', 'http:'), owned[2] + ':8443',
  'https://fork.invalid', 'null'
];
const accountId = 'google-script-fixture';
const freshVars = () => JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')).vars;
function request(origin, method = 'POST', path = '/v1/profile/notify') {
  return new Request('https://ranked.example' + path, {
    method, headers: {Origin: origin, 'Content-Type': 'application/json',
      'CF-Connecting-IP': '192.0.2.9', 'X-PolyTrack-Revision': freshVars().MIN_CLIENT_REVISION,
      ...(method === 'OPTIONS' ? {'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type,x-polytrack-revision'} : {})},
    ...(method === 'POST' ? {body: JSON.stringify({accountId})} : {})
  });
}
function fixture({owner = 'owner', ipAllowed = true, userAllowed = true} = {}) {
  const calls = {auth: 0, storage: 0, writes: 0, ip: [], user: []};
  const env = {...freshVars(),
    __TEST_UID: {toString() {calls.auth++; return 'owner';}},
    WRITE_IP_RATE_LIMITER: {limit: async ({key}) => {calls.ip.push(key); return {success: ipAllowed};}},
    PB_NOTIFY_RATE_LIMITER: {limit: async ({key}) => {calls.user.push(key); return {success: userAllowed};}},
    __TEST_FIRESTORE: async (path, init = {}) => {
      calls.storage++;
      if (path === ':runQuery') return [];
      if (path === ':commit') {
        const writes = JSON.parse(init.body).writes;
        calls.writes += writes.length;
        return {writeResults: writes.map(() => ({updateTime: '2026-11-05T00:00:00.000Z'}))};
      }
      if (init.method === 'PATCH') {calls.writes++; return {updateTime: '2026-11-05T00:00:00.000Z'};}
      if (path.includes('/0.6.2_profiles_public/')) return {
        fields: encode({accountId, ownerUid: owner, nickname: 'Fixture Racer', profileUpdatedAt: 1000}).mapValue.fields,
        updateTime: '2026-11-05T00:00:00.000Z'
      };
      return null;
    }
  };
  return {env, calls};
}

// Fail closed if any fixture accidentally escapes the existing auth/storage hooks.
let previousFetch;
test.before(() => {previousFetch = globalThis.fetch; globalThis.fetch = async () => {throw Error('NETWORK_FORBIDDEN');};});
test.after(() => {globalThis.fetch = previousFetch;});

test('fresh production config contains only existing origins and the four exact owned script origins', () => {
  const vars = freshVars();
  assert.deepEqual(vars.ALLOWED_ORIGINS.split(',').sort(), [...existing, ...owned].sort());
  assert.equal(vars.PUBLIC_FIRESTORE_READ_MODE, 'capture-only');
  assert.equal(vars.WRITE_IP_RATE_LIMIT_REQUIRED, 'true');
  assert.equal(vars.PUBLIC_READ_RATE_LIMIT_REQUIRED, 'true');
});

for (const origin of [...existing, ...owned]) test('fresh-config preflight accepts ' + origin, async () => {
  const h = fixture();
  for (const path of ['/v1/profile/notify', '/v1/pb/notify', '/v1/events/catalog']) {
    const response = await handleRequest(request(origin, 'OPTIONS', path), h.env);
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
    for (const header of ['Authorization', 'Content-Type', 'X-PolyTrack-Revision'])
      assert.ok(response.headers.get('Access-Control-Allow-Headers').includes(header));
  }
  assert.equal(h.calls.auth, 0); assert.equal(h.calls.storage, 0);
  assert.deepEqual(h.calls.ip, []); assert.deepEqual(h.calls.user, []);
});

for (const origin of rejected) test('fresh-config preflight and notification reject ' + origin, async () => {
  const h = fixture();
  for (const method of ['OPTIONS', 'POST']) {
    const req = request(origin, method);
    const response = await handleRequest(req, h.env);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'origin_not_allowed');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
    assert.equal(req.bodyUsed, false);
  }
  assert.equal(h.calls.auth, 0); assert.equal(h.calls.storage, 0);
  assert.deepEqual(h.calls.ip, []); assert.deepEqual(h.calls.user, []);
});

for (const origin of owned) {
  test('owned embed authenticated notification reaches publication: ' + origin, async () => {
    const h = fixture(), tasks = [];
    const response = await handleRequest(request(origin), h.env, {waitUntil: task => tasks.push(task)});
    await Promise.all(tasks);
    assert.equal(response.status, 202);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
    assert.ok(h.calls.auth > 0); assert.ok(h.calls.storage > 0); assert.ok(h.calls.writes > 0);
    assert.deepEqual(h.calls.ip, ['ranked-write:192.0.2.9']); assert.deepEqual(h.calls.user, ['owner']);
  });
  test('owned embed still requires authentication, ownership, capture proof and rate admission: ' + origin, async () => {
    const unauth = fixture(); delete unauth.env.__TEST_UID;
    const unsigned = await handleRequest(request(origin), unauth.env);
    assert.equal(unsigned.status, 401); assert.equal(unauth.calls.storage, 0);
    const wrongOwner = fixture({owner: 'other-owner'});
    const denied = await handleRequest(request(origin), wrongOwner.env);
    assert.equal(denied.status, 403); assert.equal((await denied.json()).error, 'profile_not_owned');
    assert.equal(wrongOwner.calls.writes, 0);
    const capture = fixture();
    const read = await handleRequest(request(origin, 'GET', '/v1/snapshot/overall/page'), capture.env);
    assert.equal(read.status, 403); assert.equal((await read.json()).error, 'snapshot_capture_required');
    assert.equal(capture.calls.storage, 0);
    for (const options of [{ipAllowed: false}, {userAllowed: false}]) {
      const limited = fixture(options);
      const response = await handleRequest(request(origin), limited.env);
      assert.equal(response.status, 429); assert.equal(response.headers.get('Retry-After'), '60');
      assert.equal(limited.calls.storage, 0);
      if (options.ipAllowed === false) assert.equal(limited.calls.auth, 0);
    }
  });
}
