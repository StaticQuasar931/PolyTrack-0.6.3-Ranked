import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {reconcileCanonicalChanges, computeTrackEntries} from '../../workers/ranked/src/index.js';
import {verificationKey, VERIFIER_VERSION, VERIFIER_ENGINE_DIGEST} from '../../workers/ranked/src/verification.js';
import {encode, decode} from './firestore.mjs';

const TRACK = '5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038';
const document = data => ({fields: encode(data).mapValue.fields, updateTime: 'v1'});

function fixture({badCount = 4, staleProof = false, pendingCount = 1} = {}) {
  const failed = Array.from({length: badCount}, (_, i) => `000-failed-${i}`);
  const replay = 'publication-fixture';
  const row = {accountId: 'racer', trackId: TRACK, timeMs: 22448, frames: 22448, raceTimeFrames: 22448,
    uploadId: 12, replay, replayHash: createHash('sha256').update(replay).digest('hex'), pbAt: 123};
  const canonical = new Map([...failed.map(trackId => [`racer_${trackId}`, {...row, trackId}]),
    ...Array.from({length: pendingCount}, (_, i) => [`racer${i}_${TRACK}`, {...row, accountId: `racer${i}`}])]);
  let job = {backfillComplete: true, pendingTrackIds: [...failed, TRACK], pendingFullRebuildTrackIds: [],
    pendingResultIds: Object.fromEntries([...failed.map(id => [id, [`racer_${id}`]]),
      [TRACK, [...canonical.keys()].filter(id => id.endsWith(`_${TRACK}`))]])};
  const slots = Object.fromEntries([...canonical.values()].filter(r => r.trackId === TRACK).map(r => [r.accountId, {
    key: verificationKey(staleProof ? {...r, uploadId: 11} : r), status: 'verified',
    verifierVersion: VERIFIER_VERSION, engineDigest: VERIFIER_ENGINE_DIGEST
  }]));
  let board = {trackId: TRACK, entries: computeTrackEntries([...canonical.values()].filter(r => r.trackId === TRACK)
    .map(r => ({...r, integrityVerified: true})), TRACK), complete: true, totalEntries: pendingCount,
    revision: 525, schemaVersion: 6, algorithmVersion: 'participation-v8-s1', signature: 'old'};
  let dirty = false, scans = 0;
  const selected = [];
  const env = {__TEST_FIRESTORE: async (path, init = {}) => {
    if (path === ':runQuery') { scans++; assert.fail('Targeted work must not scan canonical collections'); }
    if (path === ':batchGet') {
      const names = JSON.parse(init.body).documents;
      assert.ok(names.length <= 16);
      selected.push(names.map(name => name.split('/').at(-1)));
      return names.map(name => ({found: {name, ...document(canonical.get(name.split('/').at(-1)))}}));
    }
    if (path === ':commit') {
      for (const write of JSON.parse(init.body).writes) {
        const data = decode({mapValue: {fields: write.update.fields}});
        if (write.update.name.endsWith('/canonical_reconcile_v2')) {
          data.pendingResultIds = Object.fromEntries(Object.entries(data.pendingResultIds).sort(([a], [b]) => a.localeCompare(b)));
          job = data;
        }
        if (write.update.name.endsWith('/0.6.2_s1_leaderboards_track/' + TRACK)) board = data;
        if (write.update.name.endsWith('/0.6.2_s1_release_meta/current')) dirty = data.dirty;
        assert.ok(write.currentDocument, 'Publication and job writes remain CAS guarded');
      }
      return {};
    }
    if (path.endsWith('/canonical_reconcile_v2')) return document(job);
    if (failed.some(id => path.endsWith('/0.6.2_s1_leaderboards_track/' + id))) throw Error('persistent targeted publication failure');
    if (path.endsWith('/0.6.2_s1_leaderboards_track/' + TRACK)) return document(board);
    if (path.endsWith('/0.6.2_s1_verification/' + TRACK)) return document({slots});
    if (path.endsWith('/0.6.2_s1_release_meta/current')) return document({revision: 525, builtRevision: 525, dirty});
    return null;
  }};
  return {env, selected, get job() {return job;}, get board() {return board;}, get dirty() {return dirty;}, get scans() {return scans;}};
}

test('failed targeted publications use durable track order even when Firestore map keys reorder', async () => {
  const f = fixture();
  const first = await reconcileCanonicalChanges(f.env, {scanResults: false});
  assert.equal(first.rebuilt, 0);
  assert.equal(f.job.pendingTrackIds[0], TRACK);
  await reconcileCanonicalChanges(f.env, {scanResults: false});
  assert.equal(f.board.entries[0].runVerified, true);
  assert.equal(f.board.revision, 526);
  assert.equal(f.dirty, true, 'Verified RP input must also dirty the overall board');
  assert.equal(f.scans, 0);
  assert.equal(f.job.pendingResultIds[TRACK], undefined);
  assert.equal(f.job.pendingTrackIds.includes(TRACK), false);
  assert.ok(f.selected.every(ids => ids.length <= 16));
});

test('targeted publication never gives a new PB credit for a stale proof', async () => {
  const f = fixture({badCount: 0, staleProof: true});
  await reconcileCanonicalChanges(f.env, {scanResults: false});
  assert.equal(f.board.entries[0].runVerified, false);
  assert.equal(f.board.entries[0].integrityVerified, true);
  assert.equal(f.dirty, false);
  assert.equal(f.scans, 0);
});

test('partial targeted batches retain every remaining result ID', async () => {
  const f = fixture({badCount: 0, pendingCount: 18});
  await reconcileCanonicalChanges(f.env, {scanResults: false});
  assert.equal(f.job.pendingResultIds[TRACK].length, 2);
  assert.equal(f.board.entries.filter(r => r.runVerified).length, 16);
  await reconcileCanonicalChanges(f.env, {scanResults: false});
  assert.equal(f.board.entries.filter(r => r.runVerified).length, 18);
  assert.deepEqual(f.job.pendingTrackIds, []);
  assert.equal(f.scans, 0);
});


function laneFixture({fullTracks = ['old-full-a', 'old-full-b'], targetedCount = 6, cooling = [], markerWithIds = false} = {}) {
  const targetedTracks = Array.from({length: targetedCount}, (_, i) => 'targeted-' + i);
  const allTracks = [...targetedTracks, ...fullTracks];
  const replay = 'lane-fairness-fixture';
  const rows = new Map(allTracks.map(trackId => ['racer_' + trackId, {
    accountId: 'racer', trackId, timeMs: 22448, frames: 22448, raceTimeFrames: 22448,
    uploadId: 1, replay, replayHash: createHash('sha256').update(replay).digest('hex')
  }]));
  const boards = new Map([...rows.values()].map(row => [row.trackId, {
    trackId: row.trackId, entries: computeTrackEntries([{...row, integrityVerified: true}], row.trackId),
    complete: true, totalEntries: 1, revision: 1, schemaVersion: 6,
    algorithmVersion: 'participation-v8-s1', signature: 'old'
  }]));
  const now = 1_800_000_000_000;
  let job = {backfillComplete: true, pendingTrackIds: allTracks,
    pendingFullRebuildTrackIds: fullTracks,
    pendingResultIds: Object.fromEntries((markerWithIds ? allTracks : targetedTracks).map(id => [id, ['racer_' + id]])),
    failedFullRebuilds: Object.fromEntries(cooling.map(id => [id, {attempts: 1, retryAt: now + 60000}]))};
  const fullQueries = [], targetBatches = [], published = [];
  const env = {__TEST_FIRESTORE: async (path, init = {}) => {
    if (path === ':runQuery') {
      const query = JSON.parse(init.body).structuredQuery;
      assert.equal(query.from[0].collectionId, '0.6.2_race_results');
      assert.equal(query.where.fieldFilter.field.fieldPath, 'trackId');
      assert.equal(query.limit, 100, 'Full rebuilds use the bounded 100-row initial page');
      const trackId = query.where.fieldFilter.value.stringValue;
      assert.ok(fullTracks.includes(trackId), 'No targeted track should need a full scan');
      fullQueries.push(trackId);
      return [{document: {name: 'projects/polytrack-052/databases/(default)/documents/0.6.2_race_results/racer_' + trackId,
        ...document(rows.get('racer_' + trackId))}}];
    }
    if (path === ':batchGet') {
      const names = JSON.parse(init.body).documents;
      assert.ok(names.length <= 16);
      targetBatches.push(names);
      return names.map(name => ({found: {name, ...document(rows.get(name.split('/').at(-1)))}}));
    }
    if (path === ':commit') {
      for (const write of JSON.parse(init.body).writes) {
        assert.ok(write.currentDocument, 'Existing CAS guards remain in force');
        const data = decode({mapValue: {fields: write.update.fields}});
        const key = write.update.name;
        if (key.endsWith('/canonical_reconcile_v2')) {
          data.pendingResultIds = Object.fromEntries(Object.entries(data.pendingResultIds).sort(([a], [b]) => a.localeCompare(b)));
          job = data;
        }
        if (key.includes('/0.6.2_s1_leaderboards_track/')) {
          const trackId = key.split('/').at(-1);
          boards.set(trackId, data);
          published.push(trackId);
          assert.equal(data.entries[0].runVerified, true, 'Every published credit has its exact private proof');
        }
      }
      return {};
    }
    if (path.endsWith('/canonical_reconcile_v2')) return document(job);
    const trackId = path.split('/').at(-1);
    if (path.includes('/0.6.2_s1_leaderboards_track/')) return document(boards.get(trackId));
    if (path.includes('/0.6.2_s1_verification/')) {
      const row = rows.get('racer_' + trackId);
      return document({slots: {racer: {key: verificationKey(row), status: 'verified',
        verifierVersion: VERIFIER_VERSION, engineDigest: VERIFIER_ENGINE_DIGEST}}});
    }
    if (path.endsWith('/0.6.2_s1_release_meta/current')) return document({revision: 1, builtRevision: 1});
    if(path.includes('/0.6.2_s1_worker_jobs/capacity_track_'))return null;
    assert.fail('Unexpected Firestore request: ' + path);
  }};
  return {env, now, fullQueries, targetBatches, published, get job() {return job;},
    replenishTargeted() {
      for (const trackId of targetedTracks) {
        if (!job.pendingTrackIds.includes(trackId)) job.pendingTrackIds.push(trackId);
        job.pendingResultIds[trackId] = ['racer_' + trackId];
      }
    }};
}

test('sustained targeted traffic cannot starve the full-only lane within the four-track cap', async () => {
  const fullTracks = ['old-full-a', 'old-full-b', TRACK];
  const f = laneFixture({fullTracks});
  for (let i = 0; i < fullTracks.length; i++) {
    const result = await reconcileCanonicalChanges(f.env, {scanResults: false, now: f.now});
    assert.equal(result.rebuilt, 4);
    assert.equal(result.targeted, 3, 'Only one of the existing four slots is reserved for full work');
    assert.deepEqual(f.fullQueries, fullTracks.slice(0, i + 1));
    assert.equal(f.targetBatches.at(-1).length, 3);
    f.replenishTargeted();
  }
  assert.ok(f.published.includes(TRACK));
  assert.deepEqual(f.job.pendingFullRebuildTrackIds, []);
});

test('cooling full work is skipped before reserving a slot, including markers with targeted IDs', async () => {
  const f = laneFixture({cooling: ['old-full-a'], markerWithIds: true});
  const result = await reconcileCanonicalChanges(f.env, {scanResults: false, now: f.now});
  assert.equal(result.rebuilt, 4);
  assert.equal(result.targeted, 3);
  assert.deepEqual(f.fullQueries, ['old-full-b']);
  assert.ok(f.job.pendingFullRebuildTrackIds.includes('old-full-a'));
});

test('no eligible full work leaves all four slots available to targeted work', async () => {
  const f = laneFixture({cooling: ['old-full-a', 'old-full-b']});
  const result = await reconcileCanonicalChanges(f.env, {scanResults: false, now: f.now});
  assert.equal(result.rebuilt, 4);
  assert.equal(result.targeted, 4);
  assert.deepEqual(f.fullQueries, []);
  assert.equal(f.targetBatches[0].length, 4);
});

test('full-only work admits one bounded build and retains every remaining track', async () => {
  const fullTracks = Array.from({length: 6}, (_, i) => 'full-only-' + i);
  const f = laneFixture({fullTracks, targetedCount: 0});
  const result = await reconcileCanonicalChanges(f.env, {scanResults: false, now: f.now});
  assert.equal(result.rebuilt, 1);
  assert.equal(result.targeted, 0);
  assert.deepEqual(f.fullQueries, fullTracks.slice(0, 1));
  assert.deepEqual(f.job.pendingFullRebuildTrackIds, fullTracks.slice(1));
  assert.deepEqual(f.targetBatches, []);
});
