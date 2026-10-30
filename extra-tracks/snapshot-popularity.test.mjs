import test from 'node:test';
import assert from 'node:assert/strict';
import {snapshotPopularity} from './snapshot-popularity.mjs';

const id = 'a'.repeat(64);
const exact = {complete: true, count: 3, players: 3, totalEntries: 3};
const statistics = row => ({schemaVersion: 1, complete: false, tracks: {[id]: row}});

test('an exact per-track racer count does not require complete catalog coverage', () => {
  assert.equal(snapshotPopularity(statistics(exact)).get(id), 3);
  assert.equal(snapshotPopularity(statistics({complete: true, count: 0, players: 0, totalEntries: 0})).get(id), 0);
});

test('absent, partial, invalid or contradictory metadata stays unknown rather than zero', () => {
  for (const row of [null, {}, {...exact, complete: false}, {...exact, totalEntriesExact: false},
    {...exact, players: null}, {...exact, players: '3'}, {...exact, players: -1}, {...exact, players: 3.5},
    {...exact, count: 2}, {...exact, totalEntries: 4}, {...exact, players: Number.MAX_SAFE_INTEGER + 1}])
    assert.equal(snapshotPopularity(statistics(row)).has(id), false, JSON.stringify(row));
  for (const data of [null, {}, {schemaVersion: 2, tracks: {[id]: exact}}, {schemaVersion: 1, tracks: []},
    {schemaVersion: 1, tracks: {slug: exact}}]) assert.equal(snapshotPopularity(data).size, 0);
});
