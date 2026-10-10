import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileCanonicalChanges } from '../src/index.js';

const encode = value => {
  if (value === null || value === undefined) return {nullValue: null};
  if (typeof value === 'string') return {stringValue: value};
  if (typeof value === 'boolean') return {booleanValue: value};
  if (typeof value === 'number') return Number.isInteger(value)
    ? {integerValue: String(value)} : {doubleValue: value};
  if (Array.isArray(value)) return {arrayValue: {values: value.map(encode)}};
  return {mapValue: {fields: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]))}};
};

const decode = value => {
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('nullValue' in value) return null;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decode);
  if ('mapValue' in value) return Object.fromEntries(Object.entries(value.mapValue.fields || {}).map(([key, item]) => [key, decode(item)]));
  return undefined;
};

function reconcileFixture({tracks, failingTracks = new Set(), initialFailures = {}, fullRebuildTracks = tracks, pendingResultIds = {}}) {
  let job = {
    backfillComplete: true,
    cursorIngestedAt: '2026-09-09T00:00:00Z',
    pendingTrackIds: [...tracks],
    pendingFullRebuildTrackIds: [...fullRebuildTracks],
    pendingResultIds,
    failedFullRebuilds: initialFailures
  };
  const canonicalQueries = new Map();
  const writtenBoards = new Set();
  let batchGets = 0;
  const env = {__TEST_FIRESTORE: async (path, init = {}) => {
    if (path === ':runQuery') {
      const query = JSON.parse(init.body).structuredQuery;
      if (query.from[0].collectionId !== '0.6.2_race_results'
        || query.where?.fieldFilter?.field?.fieldPath !== 'trackId') return [];
      const trackId = query.where.fieldFilter.value.stringValue;
      canonicalQueries.set(trackId, (canonicalQueries.get(trackId) || 0) + 1);
      if (failingTracks.has(trackId)) return Array.from({length: 501}, (_, index) => ({
        document: {name: `projects/polytrack-052/databases/(default)/documents/0.6.2_race_results/${trackId}-${index}`, fields: {}}
      }));
      return [];
    }
    if (path === ':batchGet') {
      batchGets++;
      const accountId = 'new-racer', trackId = 'targeted-track';
      return [{found: {
        name: `projects/polytrack-052/databases/(default)/documents/0.6.2_race_results/${accountId}_${trackId}`,
        fields: encode({accountId, trackId, timeMs: 12000, frames: 12000, raceTimeFrames: 12000, replay: 'r'}).mapValue.fields
      }}];
    }
    if (path === ':commit') {
      const writes = JSON.parse(init.body).writes;
      const stateWrite = writes.find(write => write.update.name.endsWith('/canonical_reconcile_v2'));
      if (stateWrite) job = decode({mapValue: {fields: stateWrite.update.fields}});
      for (const write of writes) {
        if (write.update?.name.includes('/0.6.2_s1_leaderboards_track/')) {
          writtenBoards.add(write.update.name.split('/').at(-1));
        }
      }
      return {};
    }
    if (path.includes('/canonical_reconcile_v2')) return {fields: encode(job).mapValue.fields, updateTime: 'job-v1'};
    if (path.includes('/0.6.2_s1_leaderboards_track/targeted-track')) return {fields: encode({
      trackId: 'targeted-track', entries: [], complete: true, totalEntries: 0, revision: 1,
      schemaVersion: 6, algorithmVersion: 'participation-v8-s1', signature: 'current-empty-track'
    }).mapValue.fields, updateTime: 'targeted-board-v1'};
    return null;
  }};
  return {env, canonicalQueries, writtenBoards, getJob: () => job, getBatchGets: () => batchGets,
    setFailing: (trackId, value) => value ? failingTracks.add(trackId) : failingTracks.delete(trackId)};
}

test('failed fallback rebuilds cool down, let other tracks progress, retry when due, and clear on success', async () => {
  const failed = 'failed-track';
  const healthy = 'healthy-track';
  const later = 'targeted-track';
  const fixture = reconcileFixture({tracks: [failed, healthy], failingTracks: new Set([failed])});
  const start = 1_800_000_000_000;

  await reconcileCanonicalChanges(fixture.env, {scanResults: false, now: start});
  assert.equal(fixture.canonicalQueries.get(failed), 1);
  assert.equal(fixture.writtenBoards.has(healthy), true);
  assert.deepEqual(fixture.getJob().pendingTrackIds, [failed]);
  const firstRetryAt = fixture.getJob().failedFullRebuilds[failed].retryAt;
  assert.ok(firstRetryAt > start);

  fixture.getJob().pendingTrackIds.push(later);
  fixture.getJob().pendingResultIds = {[later]: [`new-racer_${later}`]};
  await reconcileCanonicalChanges(fixture.env, {scanResults: false, now: start + 1});
  assert.equal(fixture.canonicalQueries.get(failed), 1, 'active cooldown avoids a second full canonical query');
  assert.equal(fixture.canonicalQueries.has(later), false, 'new targeted work does not fall back to a full canonical query');
  assert.equal(fixture.getBatchGets(), 1, 'new targeted canonical work progresses while another track cools down');
  assert.equal(fixture.writtenBoards.has(later), true);
  assert.deepEqual(fixture.getJob().pendingTrackIds, [failed]);

  await reconcileCanonicalChanges(fixture.env, {scanResults: false, now: firstRetryAt});
  assert.equal(fixture.canonicalQueries.get(failed), 2, 'the failed fallback becomes eligible at retryAt');
  const secondRetryAt = fixture.getJob().failedFullRebuilds[failed].retryAt;
  fixture.setFailing(failed, false);
  await reconcileCanonicalChanges(fixture.env, {scanResults: false, now: secondRetryAt});
  assert.equal(fixture.canonicalQueries.get(failed), 3);
  assert.equal(fixture.getJob().failedFullRebuilds[failed], undefined, 'successful rebuild clears the per-track failure');
  assert.deepEqual(fixture.getJob().pendingTrackIds, []);
});

test('failure map stays capped without dropping queued full-rebuild work', async () => {
  const coolingTracks = Array.from({length: 199}, (_, index) => `cooling-${String(index).padStart(3, '0')}`);
  const targeted = 'targeted-track';
  const overflow = 'overflow-track';
  const tracks = [...coolingTracks, targeted, overflow];
  const now = 1_800_000_000_000;
  const initialFailures = Object.fromEntries([...coolingTracks, targeted].map(trackId => [trackId, {attempts: 1, retryAt: now + 60_000}]));
  const fixture = reconcileFixture({tracks, failingTracks: new Set([overflow]), initialFailures,
    fullRebuildTracks: [...coolingTracks, overflow], pendingResultIds: {[targeted]: [`new-racer_${targeted}`]}});

  await reconcileCanonicalChanges(fixture.env, {scanResults: false, now});
  assert.equal(Object.keys(fixture.getJob().failedFullRebuilds).length, 199, 'successful targeted work frees its per-track failure record');
  assert.equal(fixture.getJob().overflowRebuildCooldown, undefined, 'no shared cooldown is persisted');
  assert.equal(fixture.canonicalQueries.has(overflow), false, 'an untracked fallback is skipped when the bounded map is full');
  assert.equal(fixture.getBatchGets(), 1, 'targeted work still progresses at map capacity');
  assert.equal(fixture.writtenBoards.has(targeted), true);
  assert.ok(fixture.getJob().pendingTrackIds.includes(overflow), 'overflow fallback work remains queued');
  assert.equal(fixture.getJob().pendingTrackIds.length, 200);
});

test('cooling fallback-only tracks without explicit markers do not consume the four-track selection', async () => {
  const coolingTracks = Array.from({length: 4}, (_, index) => `cooling-${index}`);
  const healthy = 'healthy-full-rebuild';
  const now = 1_800_000_000_000;
  const initialFailures = Object.fromEntries(coolingTracks.map(trackId => [trackId, {attempts: 1, retryAt: now + 60_000}]));
  const fixture = reconcileFixture({tracks: [...coolingTracks, healthy], initialFailures, fullRebuildTracks: []});

  await reconcileCanonicalChanges(fixture.env, {scanResults: false, now});
  for (const trackId of coolingTracks) assert.equal(fixture.canonicalQueries.has(trackId), false);
  assert.equal(fixture.canonicalQueries.get(healthy), 1);
  assert.equal(fixture.writtenBoards.has(healthy), true);
  assert.deepEqual(fixture.getJob().pendingTrackIds, coolingTracks);
});

test('non-finite persisted retry times and supplied clocks cannot create an unbounded cooldown', async () => {
  const trackId = 'malformed-clock-track';
  const fixture = reconcileFixture({tracks: [trackId], failingTracks: new Set([trackId]),
    initialFailures: {[trackId]: {attempts: 1, retryAt: Infinity}}});

  await reconcileCanonicalChanges(fixture.env, {scanResults: false, now: NaN});
  const retryAt = fixture.getJob().failedFullRebuilds[trackId].retryAt;
  assert.equal(Number.isFinite(retryAt), true);
  assert.equal(fixture.getJob().failedFullRebuilds[trackId].attempts, 1, 'malformed persisted retry metadata is discarded');
});

test('far-future persisted retry times are clamped to the maximum backoff', async () => {
  const trackId = 'far-future-track';
  const now = 1_800_000_000_000;
  const fixture = reconcileFixture({tracks: [trackId], initialFailures: {
    [trackId]: {attempts: 8, retryAt: Number.MAX_SAFE_INTEGER}
  }});

  await reconcileCanonicalChanges(fixture.env, {scanResults: false, now});
  assert.equal(fixture.getJob().failedFullRebuilds[trackId].retryAt, now + 6 * 60 * 60 * 1000);
  assert.equal(fixture.canonicalQueries.has(trackId), false, 'clamped retry remains cooling until its bounded deadline');
});
