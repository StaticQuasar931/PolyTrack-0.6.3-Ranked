import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {eventWorkerMaintenance} from '../src/events-worker.js';
import {consumeEventInbox, eventRuntime} from '../src/events-runtime.js';
import {EVENT_COLLECTIONS as C} from '../src/events.js';
import {eventEncode} from '../src/events-store.js';
import {recordFirestoreReads} from '../src/firestore-read-cost.js';
import {KODUB_METADATA_URL} from '../src/kodub-event.js';
import {maintenanceWindowAllows} from '../src/index.js';

const start = Date.UTC(2026, 9, 20), trackId = 'a'.repeat(64), endsAt = start + 3 * 86400000;
const code = 'PolyTrack2' + 'A'.repeat(128), hash = createHash('sha256').update(code).digest('hex');
const capacity = {policyVersion:'test', entrants:200, admissionsPerPeriod:2048,
  replayBytesPerPeriod:16777216, minIntervalMs:5000, verificationsPerDay:1536};
const env = {EVENTS_ENABLED:'true', EVENT_CAPACITY_JSON:JSON.stringify(capacity)};
const wire = (key, data) => ({name:'projects/polytrack-052/databases/(default)/documents/' + key,
  updateTime:'2026-10-20T00:00:00Z', fields:eventEncode(data).mapValue.fields});

function quietFixture() {
  const calls = [], audit = {documentReadEstimate:0, collections:{}};
  let now = start, upstream = 0, cursor = null;
  const request = async (path, init = {}) => {
    calls.push(path);
    let result = null;
    if (path === ':beginTransaction') result = {transaction:'quiet'};
    else if (path === ':commit') {
      assert.deepEqual(JSON.parse(init.body).writes, [], 'idle work must not write heartbeats');
      result = {};
    } else if (path === ':runQuery') result = [];
    else if (path === '/' + C.cursors + '/scan') result = cursor && wire(C.cursors + '/scan', cursor);
    else if (path === '/' + C.catalog + '/main') result = wire(C.catalog + '/main', {periods:[]});
    else if (path === '/' + C.public + '/totals') result = wire(C.public + '/totals', {publicationPending:false});
    else if (path.startsWith('/' + C.periods + '/')) {
      const key = path.slice(1).split('?')[0], id = key.split('/')[1];
      result = wire(key, id.startsWith('kodub_') ? {id, kind:'kodub', trackId, endsAt, targetMs:20402,
        kodub:{source:'kodub-v6-track-of-the-week', trackCode:code, trackCodeHash:hash,
          officialTrackAssetHash:hash, officialEndTime:endsAt, officialFastestVerifiedMs:20402}} : {id});
    } else assert.fail('unexpected request: ' + path);
    recordFirestoreReads(audit, path, init, result);
    return result;
  };
  const options = {request, officialIds:[trackId], allIds:[trackId, 'b'.repeat(64)], now:() => now,
    targetForTrack:() => assert.fail('existing periods must not rediscover targets'),
    fetch:async url => {
      assert.equal(url, KODUB_METADATA_URL); upstream++;
      return Response.json({serverTime:new Date(now).toISOString(), current:{trackId, name:'Fixture', author:'Kodub',
        lastModified:null, environment:0, endTime:new Date(endsAt).toISOString(),
        trackUrl:'https://vps.kodub.com/v6/trackOfTheWeek/track/' + hash,
        thumbnailUrl:'https://vps.kodub.com/v6/trackOfTheWeek/image/' + hash, coverUrl:null}});
    }};
  return {calls, audit, options, upstream:() => upstream, setCursor:value => {cursor = value;},
    run:async minute => {now = start + minute * 60000; return eventWorkerMaintenance(env, {...options, at:now});}};
}

test('24h quiet event cron: 2880 estimated reads, zero writes, bounded discovery', async () => {
  const f = quietFixture();
  for (let minute = 0; minute < 1440; minute++) {
    const result = await f.run(minute);
    assert.notEqual(result.kodub?.unavailable, true, JSON.stringify(result.kodub));
  }
  assert.equal(f.audit.documentReadEstimate, 2880);
  assert.equal(f.audit.writeEstimate || 0, 0);
  assert.equal(f.audit.deleteEstimate || 0, 0);
  assert.equal(f.calls.length, 3072, '96 read-only transactions add begin/commit requests, not writes');
  assert.equal(f.calls.filter(path => path === ':runQuery').length, 576);
  assert.equal(f.audit.collections[C.catalog], 288);
  assert.equal(f.audit.collections[C.periods], 288);
  assert.equal(f.audit.collections[C.public], 576);
  assert.equal(f.audit.collections[C.cursors], 1152);
  assert.equal(f.upstream(), 96);
});

test('four coordinated event windows bound quiet daily reads without heartbeat writes', async () => {
  const f=quietFixture();
  for(let minute=0;minute<1440;minute++) {
    if(maintenanceWindowAllows('* * * * *',start+minute*60000,'four-window'))await f.run(minute);
  }
  assert.equal(f.audit.writeEstimate||0,0);
  assert.equal(f.audit.documentReadEstimate,360);
});

test('off-cadence provisioning and invalid cron timestamps perform no I/O', async () => {
  const f = quietFixture();
  for (const minute of [5, 10, 20, 25]) assert.equal((await f.run(minute)).reason, 'provision_cadence');
  for (const at of [NaN, Infinity, -1, 1.5])
    assert.equal((await eventWorkerMaintenance(env, {...f.options, at})).reason, 'invalid_schedule');
  assert.deepEqual(f.calls, []); assert.equal(f.upstream(), 0);
});

test('guaranteed poll finds work without an activity hint; other idle slots only read the hint', async () => {
  const f = quietFixture();
  assert.equal((await f.run(6)).pollDeferred, true);
  assert.deepEqual(f.calls, ['/' + C.catalog + '/main', '/' + C.cursors + '/scan']);
  f.calls.length = 0;
  assert.deepEqual(await f.run(8), {consumed:0});
  assert.equal(f.calls.filter(path => path === ':runQuery').length, 2);
});

test('recent processing keeps the other intake slots active even for an old receipt', async () => {
  const f = quietFixture();
  f.setCursor({processedAt:start + 2 * 60000, receivedAt:{__firestoreTimestamp:'2020-01-01T00:00:00Z'}, name:'old'});
  for (const minute of [2, 4, 6]) {
    f.calls.length = 0;
    assert.deepEqual(await f.run(minute), {consumed:0});
    assert.equal(f.calls.filter(path => path === ':runQuery').length, 2);
    assert.equal(f.calls.filter(path => path === '/' + C.cursors + '/scan').length, 1);
  }
});

test('stale, missing, malformed and future activity hints cannot disable the guaranteed poll', async () => {
  for (const processedAt of [undefined, -1, 'recent', start, start + 7 * 60000]) {
    const f = quietFixture();
    f.setCursor({...(processedAt === undefined ? {} : {processedAt}),
      receivedAt:{__firestoreTimestamp:'2020-01-01T00:00:00Z'}, name:'old'});
    assert.equal((await f.run(6)).pollDeferred, true);
    f.calls.length = 0;
    assert.deepEqual(await f.run(8), {consumed:0});
    assert.equal(f.calls.filter(path => path === ':runQuery').length, 2);
  }
});

test('standalone verifier intake never opts into the Worker idle gate', async () => {
  const f = quietFixture();
  const result = await consumeEventInbox(eventRuntime(f.options.request, {now:() => start}));
  assert.deepEqual(result, {consumed:0});
  assert.equal(f.calls.filter(path => path === ':runQuery').length, 2);
});
