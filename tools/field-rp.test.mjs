import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {gzipSync, gunzipSync} from 'node:zlib';
import {FIELD_RP_MODEL, fieldRpComponent, scoreFieldRp, buildFieldRpRanking} from './field-rp.mjs';
import {buildPlannerScoringSourceFromManifest} from './planner-scoring-source.mjs';

const finish = (changes = {}) => ({trackId: 'track', rank: 1, fieldSize: 250, weight: 4, ...changes});
const score = (rows, options = {}) => scoreFieldRp(rows, {complete: true, expectedCount: rows.length, ...options});
function fixture() {
  const binding = {algorithmVersion: 'participation-v8-s1', schemaVersion: 6,
    sourceRevision: 12, builtRevision: 12, updatedAt: 1000};
  const metadata = {...binding, complete: true, sourceComplete: true, ranksExact: true, totalEntries: 3};
  const manifest = {...metadata, kind: 'overall-manifest', totalEntriesExact: true, boardMetadata: metadata};
  const rows = [
    {userId: 'a', resultData: JSON.stringify([[0, 1, 2, 3, 1, 100, 0]])},
    {userId: 'b', resultData: JSON.stringify([[0, 2, 2, 3, 1, 100, 0]])},
    {userId: 'empty', resultData: '[]'}
  ];
  const pack = () => ({...binding, resultBundleVersion: 1, resultBundleComplete: true,
    resultBundleEncoding: 'gzip-base64-json-v1',
    resultBundle: gzipSync(JSON.stringify({resultTracks: ['track'], entries: rows})).toString('base64')});
  return {manifest, rows, pack};
}

test('uses Overall placement contribution, not raw ranks or casual RP', () => {
  const row = fieldRpComponent(finish());
  assert.equal(row.populationMultiplier, 1);
  assert.equal(row.placementCost, 50 + 249 / 255 * -50);
  assert.equal(row.points, (100 - row.placementCost) * 4);
  assert.equal(fieldRpComponent(finish({weight: 0})).points, 0);
  assert.equal(FIELD_RP_MODEL.label, 'Field RP (experimental)');
});

test('rank improves points; population is monotonic and multiplier capped', () => {
  for (const n of [2, 5, 250, 2500]) {
    let previous = Infinity;
    for (let rank = 1; rank <= n; rank++) {
      const row = fieldRpComponent(finish({rank, fieldSize: n}));
      assert.ok(Number.isFinite(row.points) && row.points >= 0 && row.points <= previous);
      assert.ok(row.points <= 2 * row.contribution);
      previous = row.points;
    }
  }
  let previous = 0;
  for (const n of [2, 10, 50, 250, 1000, 10000, Number.MAX_SAFE_INTEGER]) {
    const row = fieldRpComponent(finish({rank: 2, fieldSize: n}));
    assert.ok(row.points >= previous);
    previous = row.points;
  }
  assert.equal(fieldRpComponent(finish({fieldSize: Number.MAX_SAFE_INTEGER})).populationMultiplier, 2);
});

test('bad, pending, duplicate and missing coverage never become fabricated entries', () => {
  for (const changes of [{rank: 0}, {rank: 3, fieldSize: 2}, {rank: 1.5}, {fieldSize: 1},
    {fieldSize: Infinity}, {weight: NaN}, {weight: Infinity}, {weight: -1}, {weight: null},
    {weight: '4'}, {weight: Number.MAX_VALUE}, {trackId: ''}, {local: true},
    {pending: true}, {localPending: true}, {sourceComplete: false}, {ranksExact: false},
    {runVerified: false}, {integrityVerified: false}, {totalEntriesExact: false}]) {
    assert.equal(fieldRpComponent(finish(changes)), null, JSON.stringify(changes));
  }
  assert.equal(fieldRpComponent(null), null);
  assert.equal(scoreFieldRp([finish()]).known, false);
  assert.equal(score([finish()], {expectedCount: 2}).reason, 'missing_coverage');
  assert.equal(score([finish(), finish()]).known, false);
  assert.equal(score([finish({pending: true})], {trackIds: []}).known, false);
  assert.equal(score([]).points, 0);
});

test('ties, deterministic ordering, track filters and no mutation', () => {
  assert.equal(fieldRpComponent(finish()).points, fieldRpComponent(finish()).points);
  const rows = [finish({trackId: 'z'}), finish({trackId: 'a', rank: 2})];
  const before = JSON.stringify(rows);
  assert.deepEqual(score(rows), score([...rows].reverse()));
  assert.equal(score(rows, {trackIds: ['z']}).points, score([rows[0]]).points);
  assert.equal(score(rows, {trackIds: []}).points, 0);
  assert.equal(score(rows, {trackIds: ['absent']}).trackCount, 0);
  assert.equal(JSON.stringify(rows), before);
  assert.throws(() => score(rows, {trackIds: 'track'}), /filter/);
});

test('bound source, user filters and deterministic ranking preserve source placements', async () => {
  const {manifest, rows, pack} = fixture(), packed = pack();
  const before = JSON.stringify({manifest, packed});
  const all = await buildFieldRpRanking(manifest, packed);
  assert.deepEqual(all.entries.map(row => [row.userId, row.rank]), [['a', 1], ['b', 2]]);
  assert.deepEqual(all.excluded, [{userId: 'empty', reason: 'no_selected_results'}]);
  assert.equal(all.published, false);
  const selected = await buildFieldRpRanking(manifest, packed, {userIds: ['b']});
  assert.equal(selected.entries[0].points, all.entries[1].points);
  assert.equal((await buildFieldRpRanking(manifest, packed, {trackIds: []})).entries.length, 0);
  assert.equal((await buildFieldRpRanking(manifest, packed, {userIds: []})).entries.length, 0);
  assert.equal(JSON.stringify({manifest, packed}), before);
  rows.reverse();
  assert.deepEqual(await buildFieldRpRanking(manifest, pack()), all);
  await assert.rejects(buildFieldRpRanking({...manifest, complete: false}, packed));
  await assert.rejects(buildFieldRpRanking(manifest, {...packed, sourceRevision: 13}));
  rows.pop();
  await assert.rejects(buildFieldRpRanking(manifest, pack()));
});

test('score ties share competition rank, ordered by ID without inventing placement ties', async () => {
  const {manifest, rows, pack} = fixture();
  // Distinct valid placements with a real zero weight are not allowed by the planner.
  // Use separate complete tracks with equal populations/weights instead.
  rows.splice(0, rows.length,
    {userId: 'b', resultData: JSON.stringify([[0, 1, 2, 3, 1, 100, 0], [1, 2, 2, 3, 1, 101, 0]])},
    {userId: 'a', resultData: JSON.stringify([[0, 2, 2, 3, 1, 101, 0], [1, 1, 2, 3, 1, 100, 0]])},
    {userId: 'empty', resultData: '[]'});
  const packed = pack();
  packed.resultBundle = gzipSync(JSON.stringify({resultTracks: ['track', 'other'], entries: rows})).toString('base64');
  assert.deepEqual((await buildFieldRpRanking(manifest, packed)).entries.map(r => [r.userId, r.rank]), [['a', 1], ['b', 1]]);
});

export async function frozenSource() {
  const root = new URL('../', import.meta.url);
  const folder = /<meta name="polytrack-snapshot" content="([^"]+)"/.exec(fs.readFileSync(new URL('index.html', root), 'utf8'))[1];
  const dir = new URL(folder, root), indexBytes = fs.readFileSync(new URL('index.json', dir));
  const index = JSON.parse(indexBytes), read = key => {
    const descriptor = index.files[key], bytes = fs.readFileSync(new URL(descriptor.path, dir));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), descriptor.sha256);
    return JSON.parse(gunzipSync(bytes.map(value => value ^ 0xa7)));
  };
  const manifest = read('overall-manifest.json'), packed = read('overall-results.json');
  const entries = Array.from({length: manifest.pageCount}, (_, i) => read(`overall-pages/${i + 1}.json`).entries).flat();
  return {folder, index, indexHash: createHash('sha256').update(indexBytes).digest('hex'), manifest, packed, entries};
}

test('complete frozen package supports every profile and matches published contribution samples', async () => {
  const {manifest, packed, entries} = await frozenSource();
  const source = await buildPlannerScoringSourceFromManifest(manifest, packed);
  const ranking = await buildFieldRpRanking(manifest, packed);
  assert.equal(ranking.entries.length + ranking.excluded.length, manifest.totalEntries);
  for (const entry of entries) {
    const finishes = source.profiles.get(entry.userId);
    assert.equal(finishes.length, entry.raceCount);
    for (const sample of entry.weightedResults || []) {
      const row = fieldRpComponent(finishes.find(f => f.trackId === sample.trackId));
      assert.ok(Math.abs(row.contribution - sample.contribution) < 1e-8);
      assert.ok(Math.abs(row.placementCost - sample.placementCost) < 1e-8);
    }
  }
});
