import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import {eventEncode, eventDecode} from '../src/events-store.js';

const jobs = '0.6.2_s1_worker_jobs', boards = '0.6.2_s1_leaderboards_track';
const key = jobs + '/profile_racer';
const start = Date.UTC(2026, 10, 2, 0, 7);
function fixture(t, ids = ['blocked']) {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('network forbidden'));
  t.mock.method(console, 'log', () => {});
  let clock = start;
  t.mock.method(Date, 'now', () => clock);
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args));
  const data = new Map([[key, {kind:'profile', accountId:'racer', active:true,
    identity:{accountId:'racer', name:'Racer', identityUpdatedAt:123},
    pendingTrackIds:ids, trackDiscovery:{version:1, complete:true, cursor:''},
    processed:0, changed:0, updatedAt:123}]]);
  for (const id of ids) {
    data.set(boards + '/' + id, {entries:[], schemaVersion:0});
    data.set(jobs + '/capacity_track_' + id, {complete:false, blocked:true,
      blockedReason:'snapshot_expired', baseVersion:'v1', readTime:'2026-10-01T00:00:00Z'});
  }
  data.set(jobs + '/canonical_reconcile_v2', {activeFullRebuildTrackId:ids[0],
    pendingTrackIds:ids, pendingFullRebuildTrackIds:ids});
  let reads = 0, writes = 0;
  const wire = id => ({name:'projects/test-project/databases/(default)/documents/' + id,
    fields:eventEncode(data.get(id)).mapValue.fields, updateTime:'v1'});
  const env = {BACKGROUND_MAINTENANCE_MODE:'coordinated', __TEST_FIRESTORE:async (path, init = {}) => {
    if (path === ':commit') {
      const batch = JSON.parse(init.body).writes;
      assert.equal(batch.length, 1);
      assert.ok(batch[0].update.name.endsWith('/' + key));
      assert.deepEqual(batch[0].currentDocument, {updateTime:'v1'});
      writes++;
      data.set(key, eventDecode({mapValue:{fields:batch[0].update.fields}}));
      return {writeResults:[{updateTime:'v1'}]};
    }
    reads++;
    if (path === ':runQuery') {
      const query = JSON.parse(init.body).structuredQuery;
      assert.equal(query.from[0].collectionId, jobs);
      assert.equal(query.limit, 1);
      if(query.where.fieldFilter.field.fieldPath==='profileRetryAt')return Number.isSafeInteger(data.get(key).profileRetryAt)&&data.get(key).profileRetryAt<=clock?[{document:wire(key)}]:[];
      return data.get(key).active ? [{document:wire(key)}] : [];
    }
    assert.equal(init.method || 'GET', 'GET');
    const id = decodeURIComponent(path.slice(1));
    return data.has(id) ? wire(id) : null;
  }};
  return {data, errors, counts:() => ({reads, writes}), async turn(n = 0) {
    clock = start + n * 900000;
    let done;
    worker.scheduled({cron:'2-59/5 * * * *', scheduledTime:start + n * 900000}, env,
      {waitUntil:p => {done = p;}});
    await done;
  }};
}

test('96 blocked profile turns back off durably and complete after bounded recovery', async t => {
  const f = fixture(t), before = structuredClone(f.data.get(key));
  for (let i = 0; i < 96; i++) await f.turn(i);
  process.stdout.write('PROFILE_STALL_COST ' + JSON.stringify(f.counts()) + '\n');
  assert.deepEqual(f.counts(), {reads:296, writes:26});
  assert.deepEqual(f.data.get(key).identity, before.identity);
  assert.deepEqual(f.data.get(key).pendingTrackIds, before.pendingTrackIds);
  assert.deepEqual(f.errors, []);
  f.data.set(boards + '/blocked', {entries:[], complete:true, totalEntries:0, signature:'ready',
    schemaVersion:6, algorithmVersion:'participation-v8-s1'});
  for(let n=96;n<104&&f.data.get(key).pendingTrackIds.length;n++)await f.turn(n);
  assert.equal(f.counts().writes,27);
  assert.equal(f.data.get(key).active, false);
  assert.equal(f.data.get(key).processed, 1);
  assert.deepEqual(f.data.get(key).pendingTrackIds, []);
});

test('four blocked tracks still rotate so the untouched fourth track is checked next', async t => {
  const f = fixture(t, ['one', 'two', 'three', 'four']);
  await f.turn();
  assert.equal(f.counts().writes, 1);
  assert.deepEqual(f.data.get(key).pendingTrackIds, ['four', 'one', 'two', 'three']);
  await f.turn(1);
  assert.equal(f.counts().writes, 2);
  assert.deepEqual(f.data.get(key).pendingTrackIds, ['three', 'four', 'one', 'two']);
});

test('transient failed checks preserve work with bounded retry and recover on the next due turn', async t => {
  const f = fixture(t);
  f.data.set(boards + '/blocked', {entries:[], complete:true, signature:'ready', schemaVersion:6,
    algorithmVersion:'participation-v8-s1', sourceComplete:true, totalEntries:1,
    pagination:{version:0, complete:true, totalEntries:1}});
  await f.turn();
  assert.equal(f.errors.length, 1);
  assert.deepEqual(f.counts(), {reads:3, writes:1});
  assert.equal(f.data.get(key).active, false);
  assert.ok(Number.isSafeInteger(f.data.get(key).profileRetryAt));
  f.data.set(boards + '/blocked', {entries:[], complete:true, totalEntries:0, signature:'ready',
    schemaVersion:6, algorithmVersion:'participation-v8-s1'});
  await f.turn(1);
  assert.deepEqual(f.counts(), {reads:6, writes:2});
  assert.equal(f.data.get(key).active, false);
});

