import assert from 'node:assert/strict';
import test from 'node:test';
import {reconcileCanonicalChanges} from '../src/index.js';
import {eventEncode as encode, eventDecode as decode} from '../src/events-store.js';

const base = 'projects/polytrack-052/databases/(default)/documents/';
const jobPath = '0.6.2_s1_worker_jobs/canonical_reconcile_v2';
const results = '0.6.2_race_results';
const boards = '0.6.2_s1_leaderboards_track';
const now = 1_800_000_000_000;
const row = (trackId, accountId = 'current-racer') => ({accountId, trackId,
  timeMs: 12000, frames: 12000, raceTimeFrames: 12000, replay: 'r', uploadId: 1});
const resultId = r => `${r.accountId}_${r.trackId}`;
const board = trackId => ({trackId, entries: [], complete: true, totalEntries: 0,
  revision: 1, schemaVersion: 6, algorithmVersion: 'participation-v8-s1', signature: 'empty'});

function fixture({tracks, discover = false, failing = new Set()}) {
  const data = new Map(), calls = [], queries = [], commits = [];
  const versions = new Map();
  const wire = (key, value = data.get(key)) => ({name: base + key,
    fields: encode(value).mapValue.fields, updateTime: `v${versions.get(key) || 0}`});
  for (const track of tracks) {
    data.set(`${boards}/${track}`, board(track));
    for (const account of ['current-racer', 'legacy-racer']) {
      const r = row(track, account);
      data.set(`${results}/${resultId(r)}`, r);
    }
  }
  data.set(jobPath, {backfillComplete: !discover, schemaVersion: 2,
    cursorIngestedAt: '2026-10-13T00:00:00Z', pendingTrackIds: discover ? [] : tracks,
    pendingResultIds: discover ? {} : Object.fromEntries(tracks.map(t => [t, [resultId(row(t))]])),
    pendingFullRebuildTrackIds: [], failedFullRebuilds: {}});
  let discovered = false, backfilled = false;
  const env = {__TEST_FIRESTORE: async (path, init = {}) => {
    calls.push(path);
    if (path === ':runQuery') {
      const query = JSON.parse(init.body).structuredQuery;
      queries.push(query);
      assert.equal(query.from[0].collectionId, results);
      const field = query.where?.fieldFilter?.field.fieldPath;
      if (field === 'trackId') {
        const track = query.where.fieldFilter.value.stringValue;
        assert.equal(query.limit, 501, 'fallback scan remains bounded');
        if (failing.has(track)) return Array.from({length: 501}, (_, i) => ({
          document: wire(`${results}/overflow-${i}`, row(track, `overflow-${i}`))}));
        return [...data].filter(([key, value]) => key.startsWith(results + '/') && value.trackId === track)
          .map(([key, value]) => ({document: wire(key, value)}));
      }
      if (discover && field === 'ingestedAt' && !discovered) {
        discovered = true;
        return tracks.map(track => {
          const document = wire(`${results}/${resultId(row(track))}`);
          document.fields.ingestedAt = {timestampValue: '2026-10-14T00:00:00Z'};
          return {document};
        });
      }
      if (discover && !field && !backfilled) {
        backfilled = true;
        return tracks.map(track => ({document: wire(`${results}/${resultId(row(track, 'legacy-racer'))}`)}));
      }
      return [];
    }
    if (path === ':batchGet') return JSON.parse(init.body).documents.map(name => {
      const key = name.slice(base.length);
      return data.has(key) ? {found: wire(key)} : {missing: name};
    });
    if (path === ':commit') {
      const writes = JSON.parse(init.body).writes;
      for (const write of writes) {
        const key = write.update.name.slice(base.length);
        assert.deepEqual(write.currentDocument, data.has(key)
          ? {updateTime: `v${versions.get(key) || 0}`} : {exists: false});
      }
      commits.push(writes);
      for (const write of writes) {
        const key = write.update.name.slice(base.length);
        data.set(key, decode({mapValue: {fields: write.update.fields}}));
        versions.set(key, (versions.get(key) || 0) + 1);
      }
      return {};
    }
    assert.ok(path.startsWith('/'), `unexpected request ${path}`);
    return data.has(path.slice(1)) ? wire(path.slice(1)) : null;
  }};
  return {env, data, calls, queries, commits, failing, job: () => data.get(jobPath)};
}

test('legacy backfill keeps full-publication work across one-full-build passes', async () => {
  const tracks = Array.from({length: 5}, (_, i) => `backfill-track-${i}`);
  const f = fixture({tracks, discover: true});
  await reconcileCanonicalChanges(f.env, {now});
  assert.equal(f.job().backfillComplete, true);
  assert.deepEqual(f.job().pendingTrackIds, tracks.slice(1));
  for(let pass=1;pass<tracks.length;pass++) await reconcileCanonicalChanges(f.env, {scanResults:false,now:now+pass});
  const published = f.data.get(`${boards}/${tracks[4]}`);
  assert.deepEqual(published.entries.map(r => r.accountId).sort(), ['current-racer', 'legacy-racer'],
    'the deferred track must include historical racers, not only the changed-result row');
  assert.deepEqual(f.job().pendingTrackIds, []);
  assert.deepEqual(f.job().pendingFullRebuildTrackIds, []);
  assert.deepEqual(f.job().pendingResultIds, {});
  assert.equal(f.queries.filter(q => q.where?.fieldFilter?.field.fieldPath === 'trackId').length, 5);
});

test('failed targeted fallback performs only the job read during cooldown and retries the full publication', async () => {
  const track = 'failed-targeted-track';
  const f = fixture({tracks: [track], failing: new Set([track])});
  f.data.get(`${boards}/${track}`).schemaVersion = 5;
  await reconcileCanonicalChanges(f.env, {scanResults: false, now});
  const retryAt = f.job().failedFullRebuilds[track].retryAt;
  assert.equal(retryAt, now + 15 * 60 * 1000);
  const callCount = f.calls.length, commitCount = f.commits.length;
  for (const delta of [1, 5 * 60 * 1000, 10 * 60 * 1000]) {
    await reconcileCanonicalChanges(f.env, {scanResults: false, now: now + delta});
  }
  assert.deepEqual(f.calls.slice(callCount), Array(3).fill('/' + jobPath),
    'cooling fallback must not batch-read canonical IDs or reread the stale board');
  assert.equal(f.commits.length, commitCount, 'no cooldown heartbeat writes');
  assert.deepEqual(f.job().pendingResultIds[track], [resultId(row(track))]);
  f.failing.delete(track);
  await reconcileCanonicalChanges(f.env, {scanResults: false, now: retryAt});
  assert.equal(f.data.get(`${boards}/${track}`).entries.length, 2);
  assert.deepEqual(f.job().pendingTrackIds, []);
  assert.deepEqual(f.job().pendingFullRebuildTrackIds, []);
  assert.deepEqual(f.job().failedFullRebuilds, {});
});

test('cooling targeted fallbacks yield all four selection slots to healthy publications', async () => {
  const cooling = Array.from({length: 4}, (_, i) => `cooling-track-${i}`);
  const f = fixture({tracks: cooling, failing: new Set(cooling)});
  for (const track of cooling) f.data.get(`${boards}/${track}`).schemaVersion = 5;
  await reconcileCanonicalChanges(f.env, {scanResults: false, now});
  const healthy = 'healthy-track';
  f.data.set(`${boards}/${healthy}`, board(healthy));
  f.data.set(`${results}/${resultId(row(healthy))}`, row(healthy));
  f.job().pendingTrackIds.push(healthy);
  f.job().pendingResultIds[healthy] = [resultId(row(healthy))];
  await reconcileCanonicalChanges(f.env, {scanResults: false, now: now + 1});
  assert.equal(f.data.get(`${boards}/${healthy}`).entries.length, 1);
  assert.deepEqual(f.job().pendingTrackIds, cooling);
});
