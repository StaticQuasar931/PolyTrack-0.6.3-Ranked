import test from 'node:test';
import assert from 'node:assert/strict';
import {featuredPicks} from './featured-picks.mjs';
import {snapshotPopularity} from './snapshot-popularity.mjs';
const entries = Array.from({length: 20}, (_, n) => ({id: 'track-' + n, trackId: n.toString(16).padStart(64, '0'), trackPath: 'extra-tracks/track-data/test/' + n + '.track'}));
const now = Date.parse('2026-11-02T12:34:56Z');
test('UTC choices are deterministic, reorder-safe, unique and do not mutate entries', () => {
  const before = JSON.stringify(entries);
  const picks = featuredPicks(entries, new Map(), now);
  assert.deepEqual(picks, featuredPicks([...entries].reverse(), new Map(), now));
  assert.notEqual(picks[0].entry.trackId, picks[1].entry.trackId);
  assert.deepEqual(picks.map(p => new Date(p.endsAt).toISOString()), ['2026-11-03T00:00:00.000Z', '2026-11-09T00:00:00.000Z']);
  assert.deepEqual(picks, featuredPicks(entries, new Map(), now + 1000));
  assert.equal(JSON.stringify(entries), before);
});
test('weekly pick holds within the UTC week and rolls on Monday', () => {
  const weekly = time => featuredPicks(entries, new Map(), Date.parse(time))[1];
  assert.deepEqual(weekly('2026-11-02T00:00:00Z'), weekly('2026-11-08T23:59:59Z'));
  assert.notEqual(weekly('2026-11-09T00:00:00Z').startsAt, weekly('2026-11-08T23:59:59Z').startsAt);
});
test('only complete exact snapshot counts establish racer coverage; fallback needs no fetch', () => {
  const counts = snapshotPopularity({schemaVersion: 1, tracks: {
    [entries[0].trackId]: {complete: true, count: 5, players: 5, totalEntries: 5},
    [entries[1].trackId]: {complete: false, count: 90, players: 90, totalEntries: 90},
    [entries[2].trackId]: {complete: true, totalEntriesExact: false, count: 90, players: 90, totalEntries: 90}
  }});
  const picks = featuredPicks(entries, counts, now);
  assert.equal(picks[1].entry, entries[0]); assert.equal(picks[1].fallback, true, 'counts alone do not imply curation');
  assert.equal(picks[0].fallback, true);
  assert.ok(featuredPicks(entries, new Map(), now).every(p => p.fallback));
});
test('empty, single-track, duplicate identities and explicitly unranked catalogs are safe', () => {
  assert.deepEqual(featuredPicks([], new Map(), now), []);
  assert.deepEqual(featuredPicks([{...entries[0], ranked: false}], new Map(), now), []);
  assert.deepEqual(featuredPicks(entries, new Map(), NaN), []);
  assert.equal(featuredPicks([entries[0]], new Map(), now).length, 2);
  const duplicate = {...entries[0], id: 'alternate'};
  assert.deepEqual(featuredPicks([entries[0], duplicate], new Map(), now), featuredPicks([duplicate, entries[0]], new Map(), now));
});


test('editorial candidates outrank unreviewed popularity and prefer known published grades', () => {
  const worthy = entries.slice(0, 3).map((entry, n) => ({...entry, tier: n === 0 ? 'Curated' : '', featuredSubmission: n === 1,
    ...(n === 2 ? {source: 'Kodub weekly', codeHash: 'f'.repeat(64), dateProvenance: 'events/kodub/selections.json', weeklyEndsAt: '2026-11-08T20:00:00Z'} : {})}));
  const unreviewed = entries[3];
  const counts = new Map([[unreviewed.trackId, 9000], [worthy[2].trackId, 25]]);
  const review = entry => ({quality: entry === worthy[1] ? 8 : null});
  const picks = featuredPicks([...worthy, unreviewed], counts, now, review);
  assert.ok(picks.every(pick => pick.pool === 'curated' && !pick.fallback && pick.entry !== unreviewed));
  assert.equal(picks[1].entry, worthy[1], 'a good published grade takes precedence over popularity alone');
  assert.equal(picks[1].quality, 8);
  assert.equal(picks[0].entry, worthy[2], 'the second editorial pick prefers known exact coverage');
});

test('a lone curated choice is reused rather than substituting an unreviewed popular track', () => {
  const worthy = {...entries[0], featuredSubmission: true};
  const picks = featuredPicks([worthy, entries[1]], new Map([[entries[1].trackId, 5000]]), now);
  assert.ok(picks.every(pick => pick.entry === worthy && pick.players === null && !pick.fallback));
});
