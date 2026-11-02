import test from 'node:test';
import assert from 'node:assert/strict';
import {featuredPicks} from './featured-picks.mjs';
import {snapshotPopularity} from './snapshot-popularity.mjs';
const entries = Array.from({length: 20}, (_, n) => ({id: 'track-' + n, trackId: n.toString(16).padStart(64, '0'), trackPath: 'extra-tracks/track-data/test/' + n + '.track', tier: 'Curated'}));
const now = Date.parse('2026-11-02T12:34:56Z');

test('UTC creator/discovery choices are deterministic, reorder-safe, unique and immutable', () => {
  const before = JSON.stringify(entries), picks = featuredPicks(entries, new Map(), now);
  assert.deepEqual(picks, featuredPicks([...entries].reverse(), new Map(), now));
  assert.notEqual(picks[0].entry.trackId, picks[1].entry.trackId);
  assert.deepEqual(picks.map(p => new Date(p.endsAt).toISOString()), ['2026-11-03T00:00:00.000Z', '2026-11-09T00:00:00.000Z']);
  assert.deepEqual(picks, featuredPicks(entries, new Map(), now + 1000));
  assert.equal(JSON.stringify(entries), before);
});

test('weekly discovery holds within a UTC week and rolls on Monday', () => {
  const weekly = time => featuredPicks(entries, new Map(), Date.parse(time))[1];
  assert.deepEqual(weekly('2026-11-02T00:00:00Z'), weekly('2026-11-08T23:59:59Z'));
  assert.notEqual(weekly('2026-11-09T00:00:00Z').startsAt, weekly('2026-11-08T23:59:59Z').startsAt);
});

test('discovery selects the lower exact-count quarter including real zero, never unknown as zero', () => {
  const counts = new Map([[entries[1].trackId, 0], [entries[2].trackId, 2], [entries[3].trackId, 10], [entries[4].trackId, 100]]);
  const discovery = featuredPicks(entries, counts, now)[1];
  assert.equal(discovery.entry, entries[1]); assert.equal(discovery.players, 0); assert.equal(discovery.underplayed, true);
  assert.notEqual(discovery.entry, entries[0], 'missing count does not compete with zero');
});

test('positive underplayed counts work without zero and invalid map counts stay unknown', () => {
  const counts = new Map([[entries[0].trackId, -1], [entries[1].trackId, '0'], [entries[2].trackId, NaN], [entries[3].trackId, 3], [entries[4].trackId, 900]]);
  const discovery = featuredPicks(entries, counts, now)[1];
  assert.equal(discovery.entry, entries[3]); assert.equal(discovery.players, 3); assert.equal(discovery.underplayed, true);
  const fallback = featuredPicks(entries, new Map(), now)[1];
  assert.equal(fallback.underplayed, false); assert.equal(fallback.players, null);
  assert.equal(fallback.fallbackReason, 'coverage-unavailable');
});

test('partial snapshot coverage cannot establish zero or underplayed status', () => {
  const counts = snapshotPopularity({schemaVersion: 1, tracks: {
    [entries[0].trackId]: {complete: false, count: 0, players: 0, totalEntries: 0},
    [entries[1].trackId]: {complete: true, totalEntriesExact: false, count: 0, players: 0, totalEntries: 0}
  }});
  assert.equal(featuredPicks(entries, counts, now)[1].underplayed, false);
});

test('published poor grades are excluded even from editorial entries; local/self-claimed grades cannot feature a track', () => {
  const poor = entries[0], good = entries[1];
  const claims = {...entries[2], tier: 'Community', rating: 10, quality: 10, difficulty: 1};
  const picks = featuredPicks([poor, good, claims], new Map([[poor.trackId, 0], [good.trackId, 7], [claims.trackId, 0]]), now,
    entry => ({quality: entry === poor ? 2 : entry === good ? 8 : null}));
  assert.ok(picks.every(pick => pick.entry === good));
  assert.deepEqual(featuredPicks([claims], new Map([[claims.trackId, 0]]), now), []);
});

test('reviewed-only fallback requires a published worthy grade, and creator credit does not depend on popularity', () => {
  const good = {...entries[0], tier: 'Community'}, other = {...entries[1], tier: 'Community'};
  const picks = featuredPicks([good, other], new Map([[other.trackId, 10000]]), now, entry => ({quality: entry === good ? 9 : null}));
  assert.ok(picks.every(pick => pick.entry === good && pick.pool === 'reviewed' && pick.fallback));
  assert.equal(picks[0].quality, 9);
});

test('empty, unranked, single-candidate and duplicate identities remain safe', () => {
  assert.deepEqual(featuredPicks([], new Map(), now), []);
  assert.deepEqual(featuredPicks([{...entries[0], ranked: false}], new Map(), now), []);
  assert.deepEqual(featuredPicks(entries, new Map(), NaN), []);
  assert.equal(featuredPicks([entries[0]], new Map(), now).length, 2);
  const duplicate = {...entries[0], id: 'alternate'};
  assert.deepEqual(featuredPicks([entries[0], duplicate], new Map(), now), featuredPicks([duplicate, entries[0]], new Map(), now));
});
