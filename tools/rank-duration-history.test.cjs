const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../polytrack_062_patch.js'), 'utf8');
const FixedDate = class extends Date { static now() { return 10_000; } };

function sourceBlock(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `Expected source block ${startMarker}`);
  return source.slice(start, end);
}

function mergeContext() {
  const context = vm.createContext({
    Date: FixedDate,
    AVERAGE_FINISH_VERSION: 1,
    AVERAGE_PLACEMENT_VERSION: 1,
    RANK_MODEL: 'test-model',
    normalizeEntries: entries => (Array.isArray(entries) ? entries : []).map((entry, index) => ({
      ...entry,
      userId: String(entry.userId || entry.accountId || `user-${index}`),
      rank: Number(entry.rank || index + 1),
      score: Number(entry.score || 1),
      raceCount: Number(entry.raceCount || 0),
      provisional: entry.provisional === true,
      rankSince: Number(entry.rankSince || 0)
    }))
  });
  vm.runInContext(sourceBlock('  function mergeOverallSnapshots(', '  async function hydrateOverallProfiles('), context);
  return context;
}

test('overall snapshot merge preserves only valid server or same-rank timestamps', () => {
  const merge = mergeContext().mergeOverallSnapshots;
  assert.equal(merge([], [{ userId: 'new', score: 1 }])[0].rankSince, 0);
  assert.equal(merge([], [{ userId: 'server', score: 1, rankSince: 8_000 }])[0].rankSince, 8_000);
  assert.equal(merge([], [{ userId: 'provisional', score: 1, provisional: true, rankSince: 8_000 }])[0].rankSince, 0);
  assert.equal(merge([{ userId: 'same', rank: 1, score: 1, rankSince: 7_000 }], [{ userId: 'same', score: 1 }])[0].rankSince, 7_000);
  assert.equal(merge([{ userId: 'future', rank: 1, score: 1, rankSince: 11_000 }], [{ userId: 'future', score: 1 }])[0].rankSince, 0);
});

test('overall rank change clears stale rank age when the rebuilt row has no server timestamp', () => {
  const merge = mergeContext().mergeOverallSnapshots;
  const rows = merge([
    { userId: 'a', rank: 1, score: 1, rankSince: 8_000 },
    { userId: 'b', rank: 2, score: 2, rankSince: 9_000 }
  ], [
    { userId: 'a', score: 3 },
    { userId: 'b', score: 1 }
  ]);
  assert.equal(rows.find(row => row.userId === 'a').rank, 2);
  assert.equal(rows.find(row => row.userId === 'a').rankSince, 0);
  assert.equal(rows.find(row => row.userId === 'b').rank, 1);
  assert.equal(rows.find(row => row.userId === 'b').rankSince, 0);
});

test('category first observation stays unknown without captured board time and ignores legacy load-time values', () => {
  const key = 'polytrack-0.6.2-category-ranks-topTracks-v1';
  const storage = new Map([[key, { ranks: { track: 1 }, since: { track: 9_000 }, movements: { track: 0 } }]]);
  const context = vm.createContext({
    Date: FixedDate,
    cleanUserId: value => value,
    snapshotCaptureTimestamp: (value, now = FixedDate.now()) => Number.isSafeInteger(Number(value)) && Number(value) > 0 && Number(value) <= now ? Number(value) : 0,
    readJsonStorage: (name, fallback) => storage.get(name) || fallback,
    writeJsonStorage: (name, value) => storage.set(name, value)
  });
  vm.runInContext(sourceBlock('  function annotateCategoryRanks(', '  function sortedOverallEntries('), context);
  const row = context.annotateCategoryRanks([{ userId: 'track' }], 'topTracks')[0];
  assert.equal(row.categorySince, 0);
  assert.equal(storage.get(key).since.track, 0);
  assert.equal(storage.get(key).observationVersion, 2);
});

test('category observation uses captured board time, persists it across views, and resets on rank change', () => {
  const key = 'polytrack-0.6.2-category-ranks-topTracks-v1';
  const storage = new Map();
  const context = vm.createContext({
    Date: FixedDate,
    cleanUserId: value => value,
    snapshotCaptureTimestamp: (value, now = FixedDate.now()) => Number.isSafeInteger(Number(value)) && Number(value) > 0 && Number(value) <= now ? Number(value) : 0,
    readJsonStorage: (name, fallback) => storage.get(name) || fallback,
    writeJsonStorage: (name, value) => storage.set(name, value)
  });
  vm.runInContext(sourceBlock('  function annotateCategoryRanks(', '  function sortedOverallEntries('), context);
  const first = context.annotateCategoryRanks([{ userId: 'track', snapshotCapturedAt: 6_000 }], 'topTracks')[0];
  assert.equal(first.categorySince, 6_000);
  assert.equal(context.annotateCategoryRanks([{ userId: 'track', snapshotCapturedAt: 9_000 }], 'topTracks')[0].categorySince, 6_000);
  const changed = context.annotateCategoryRanks([{ userId: 'other', snapshotCapturedAt: 9_500 }, { userId: 'track', snapshotCapturedAt: 9_500 }], 'topTracks');
  assert.equal(changed[0].categorySince, 9_500);
  assert.equal(changed[1].categoryRank, 2);
  assert.equal(changed[1].categorySince, 9_500);
});

test('normalized finish summaries retain only valid per-board capture timestamps', () => {
  const context = vm.createContext({
    Date: FixedDate,
    rankedPlacementCost: () => 0,
    snapshotCaptureTimestamp: (value, now = FixedDate.now()) => Number.isSafeInteger(Number(value)) && Number(value) > 0 && Number(value) <= now ? Number(value) : 0
  });
  vm.runInContext(sourceBlock('  function normalizeFinishSummary(', '  function localTrackDisplayEntries('), context);
  assert.equal(context.normalizeFinishSummary({ trackId: 'track', snapshotCapturedAt: 8_000 }).snapshotCapturedAt, 8_000);
  assert.equal(context.normalizeFinishSummary({ trackId: 'track', snapshotCapturedAt: 11_000 }).snapshotCapturedAt, 0);
});

test('top-track timing is labeled as observation evidence, not time at rank', () => {
  const context = vm.createContext({
    Date: FixedDate,
    snapshotCaptureTimestamp: (value, now = FixedDate.now()) => Number.isSafeInteger(Number(value)) && Number(value) > 0 && Number(value) <= now ? Number(value) : 0,
    ageLabel: timestamp => `${Math.floor((FixedDate.now() - timestamp) / 1_000)}s ago`,
    escapeHtml: value => String(value),
    movementMarkup: movement => `<span>${movement > 0 ? `Up ${movement}` : 'No recent movement'}</span>`
  });
  vm.runInContext(sourceBlock('  function categoryTrackObservationMarkup(', '  function racerAgeDays('), context);
  const observed = context.categoryTrackObservationMarkup({ snapshotCapturedAt: 6_000, categoryMovement: 0 }, 1);
  assert.match(observed, /Snapshot age: 4s ago/);
  assert.doesNotMatch(observed, /at rank/);
  const unknown = context.categoryTrackObservationMarkup({ categorySince: 0, categoryMovement: 0 }, 1);
  assert.equal(unknown, '');
  assert.equal(context.categoryTrackObservationMarkup({ categorySince: 6_000, categoryMovement: 0 }, 1), '');
  assert.doesNotMatch(unknown, /at rank/);
});
