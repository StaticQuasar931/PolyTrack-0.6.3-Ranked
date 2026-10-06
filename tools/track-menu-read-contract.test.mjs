import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {trackMenuReadContract} from './track-menu-read-contract.mjs';

const loader = body => `async function loadTrackEntries(trackId){${body}} function computeOverallFromRaceRows(rows){}`;
const published = 'd.collection(COLLECTIONS.leaderboardsTrack).doc(safeTrackId)';
test('release guard accepts the current published-snapshot-only menu loader', async () => {
  assert.deepEqual(trackMenuReadContract(await fs.readFile(new URL('../polytrack_062_patch.js', import.meta.url), 'utf8')), []);
  assert.deepEqual(trackMenuReadContract(loader(published)), []);
});
test('release guard rejects missing published reads and canonical board scans in either order', () => {
  assert.ok(trackMenuReadContract(loader('return [];')).length);
  assert.ok(trackMenuReadContract(loader(`fetchCanonicalTrackEntries(id,500);${published}`)).length);
  assert.ok(trackMenuReadContract(loader(`${published};fetchCanonicalTrackEntries(id,500)`)).length);
  assert.ok(trackMenuReadContract(loader(`${published};d.collection(COLLECTIONS.raceResults).get()`)).length);
  assert.ok(trackMenuReadContract('').length);
});
