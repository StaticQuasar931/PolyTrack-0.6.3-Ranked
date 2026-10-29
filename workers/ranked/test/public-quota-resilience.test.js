import test from 'node:test';
import assert from 'node:assert/strict';
import {handleRequest} from '../src/index.js';
import {eventEncode} from '../src/events-store.js';
import {recallPublicResponse, rememberPublicResponse} from '../src/public-response-memory.js';
import {EXTRA_TRACK_IDS} from '../src/extra-track-ids.js';

const origin = 'https://staticquasar931.github.io';
const request = path => new Request('https://quota.example' + path, {headers: {Origin: origin, 'CF-Connecting-IP': '192.0.2.8'}});
function fixture(overrides = {}) {
  let reads = 0, limits = 0;
  const env = {ALLOWED_ORIGINS: origin,
    PUBLIC_READ_RATE_LIMIT_REQUIRED: 'true',
    PUBLIC_READ_RATE_LIMITER: {limit: async () => {limits++; return {success: true};}},
    __TEST_FIRESTORE: async () => {reads++; return {fields: eventEncode({entries: [], revision: 1}).mapValue.fields};}, ...overrides};
  return {env, get reads() {return reads;}, get limits() {return limits;}};
}

test('required missing, broken and denied read limiter costs zero database reads', async () => {
  for (const limiter of [undefined, {limit: async () => {throw Error('offline');}}, {limit: async () => ({})}, {limit: async () => ({success: false})}]) {
    const f = fixture({PUBLIC_READ_RATE_LIMITER: limiter});
    for (const path of ['/v1/status', '/v1/snapshot/overall', '/v1/snapshot/track?trackId=dynamic_track', '/v1/extra-tracks/unranked?trackId=586fbb2ef6e638f8d22e050342896497f22da6302ff081e434aa17bf6f75cf87']) {
      assert.equal((await handleRequest(request(path), f.env)).status, 429);
    }
    assert.equal(f.reads, 0);
  }
});

test('successful public reads survive unavailable and throwing edge cache', async () => {
  const previous = globalThis.caches;
  try {
    for (const cache of [undefined, {default: {match: async () => {throw Error('cache down');}, put: async () => {throw Error('cache down');}}}]) {
      if (cache) globalThis.caches = cache; else delete globalThis.caches;
      const f = fixture();
      for (const path of ['/v1/status', '/v1/snapshot/overall', '/v1/snapshot/track?trackId=dynamic_track']) {
        for (let i = 0; i < 10; i++) {
          const suffix = (path.includes('?') ? '&' : '?') + 'noise=' + i;
          assert.equal((await handleRequest(request(path + suffix), f.env)).status, 200);
        }
      }
      assert.equal(f.reads, 3);
      assert.equal(f.limits, 3);
    }
  } finally {if (previous === undefined) delete globalThis.caches; else globalThis.caches = previous;}
});

test('memory expires without restarting freshness and does not cross environments', async () => {
  const env = {}, other = {}, key = 'test';
  await rememberPublicResponse(env, key, new Response('{}', {headers: {'Cache-Control': 'public, max-age=30'}}), 1000);
  assert.equal(recallPublicResponse(env, key, 2000).headers.get('Cache-Control'), 'public, max-age=29');
  assert.equal(recallPublicResponse(other, key, 2000), null);
  assert.equal(recallPublicResponse({__FIRESTORE_ROOT_ENV: env}, key, 2000).status, 200);
  assert.equal(recallPublicResponse(env, key, 31000), null);
});

test('memory excludes errors and is bounded to 64 entries and 2 MiB', async () => {
  const env = {};
  await rememberPublicResponse(env, 'error', new Response('{}', {status: 503, headers: {'Cache-Control': 'public, max-age=30'}}), 1000);
  assert.equal(recallPublicResponse(env, 'error', 1001), null);
  for (let i = 0; i < 65; i++) await rememberPublicResponse(env, String(i), new Response('{}', {headers: {'Cache-Control': 'public, max-age=30'}}), 1000);
  assert.equal(recallPublicResponse(env, '0', 1001), null);
  assert.equal(recallPublicResponse(env, '64', 1001).status, 200);
  await rememberPublicResponse(env, 'large', new Response('x'.repeat(2*1024*1024), {headers: {'Cache-Control': 'public, max-age=30'}}), 1000);
  assert.equal(recallPublicResponse(env, 'large', 1001), null);
});

test('official, community, legacy, extra and historical custom snapshots remain readable', async t => {
  t.mock.method(globalThis,'fetch',async()=>assert.fail('network forbidden'));
  t.mock.method(console,'log',()=>{});
  const previous=globalThis.caches;delete globalThis.caches;
  t.after(()=>{if(previous===undefined)delete globalThis.caches;else globalThis.caches=previous;});
  const f=fixture();
  for(const id of [
    '5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038',
    'fb769ac2ea77e8f19a21a9dd3071742f2342bd49c41e4748d7e8c7903d4f0778',
    '5aafb733c264d51b09beedc7bd7eabb5e65bdded338980fcb14ae5ce36955572',
    [...EXTRA_TRACK_IDS][0], 'registered_historical_custom'
  ]) assert.equal((await handleRequest(request('/v1/snapshot/track?trackId='+id),f.env)).status,200);
  assert.equal(f.reads,5);
});
