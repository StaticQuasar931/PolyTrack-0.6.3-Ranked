import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { archivePeriodCounts, normalizeArchivePeriods, paginateArchivePeriods, summarizeArchives } from './archive-view.mjs';

test('archive pagination is local, newest-first and clamps bounds', () => {
  const periods = normalizeArchivePeriods(Array.from({ length: 25 }, (_, index) => ({
    id: `event-${index}`,
    endsAt: 1000 - index
  })));
  assert.deepEqual(paginateArchivePeriods(periods).periods.map(period => period.id),
    Array.from({ length: 12 }, (_, index) => `event-${index}`));
  assert.equal(paginateArchivePeriods(periods, 0).page, 1);
  assert.equal(paginateArchivePeriods(periods, 99).page, 3);
  assert.equal(paginateArchivePeriods(periods, 2).periods.length, 12);
  assert.deepEqual(paginateArchivePeriods(periods, 3).periods.map(period => period.id), ['event-24']);
  assert.equal(paginateArchivePeriods(periods, 1, 0).pageSize, 12);
});

test('archive UI exposes local page controls and accurate practice label', () => {
  const source = fs.readFileSync(new URL('./archive-view.mjs', import.meta.url), 'utf8');
  assert.match(source, /className = 'sq-archive-pagination'/);
  assert.match(source, /appendText\(document, pagination, 'button', 'button', 'Previous'\)/);
  assert.match(source, /appendText\(document, pagination, 'button', 'button', 'Next'\)/);
  assert.match(source, /Page \$\{pageInfo\.page\} of \$\{pageInfo\.pageCount\}/);
  assert.match(source, /Track details \/ practice/);
});

test('archive periods are validated, deduplicated and newest-first', () => {
  const periods = normalizeArchivePeriods([
    null,
    { id: '', endsAt: 99 },
    { id: 'weekly-old', kind: 'weekly', endsAt: 100, maxRp: 500 },
    { id: 'daily-new', kind: 'daily', endsAt: 300, maxRp: 100 },
    { id: 'weekly-old', kind: 'weekly', endsAt: 200, maxRp: 500 },
    { id: 'odd', kind: 'unsupported', endsAt: 150, maxRp: -4 }
  ]);
  assert.deepEqual(periods.map(period => period.id), ['daily-new', 'weekly-old', 'odd']);
  assert.equal(periods[1].endsAt, 200);
  assert.equal(periods[2].kind, 'custom');
  assert.equal(periods[2].maxRp, 0);
});

test('archive summary reports event types and only loaded verified finishes', () => {
  const periods = [
    { id: 'd1', kind: 'daily', endsAt: 300 },
    { id: 'w1', kind: 'weekly', endsAt: 200 },
    { id: 'k1', kind: 'kodub', endsAt: 100 }
  ];
  const snapshots = new Map([
    ['d1', { entries: [
      { accountId: 'a', timeMs: 1000 },
      { accountId: 'b', timeMs: 1100, pending: true }
    ] }],
    ['w1', { entries: [
      { accountId: 'a', timeMs: 900 },
      { accountId: 'c', timeMs: 950, status: 'pending' },
      null
    ] }]
  ]);
  assert.deepEqual(summarizeArchives(periods, snapshots), {
    events: 3,
    loadedEvents: 2,
    verifiedFinishes: 2,
    uniqueRacers: 1,
    kindCounts: { daily: 1, weekly: 1, kodub: 1, custom: 0 }
  });
});

test('period counts prefer safe racer totals and exclude pending rows', () => {
  const period = { id: 'd1', racerCount: 9, entrantCount: 8 };
  const snapshot = { racerCount: Number.MAX_SAFE_INTEGER + 1, entrantCount: 7, entries: [
    { accountId: 'a' },
    { accountId: 'b', pending: true },
    { accountId: 'c', status: 'pending' }
  ] };
  const counts = archivePeriodCounts(period, snapshot);
  assert.equal(counts.racers, 7);
  assert.equal(counts.verified, 1);
  assert.deepEqual(counts.verifiedEntries.map(row => row.accountId), ['a']);
  assert.deepEqual(archivePeriodCounts({ racerCount: -1, entrantCount: 3 }), {
    racers: 3,
    verified: null,
    verifiedEntries: []
  });
});
