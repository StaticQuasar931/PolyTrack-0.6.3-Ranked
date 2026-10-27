import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildTrackStatistics, decodeSnapshot, encodeSnapshot, MAX_DECODED_BYTES, publishSnapshot, restoreSnapshotArchive } from './snapshot-package.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'snapshot-package-'));
  const staging = path.join(root, 'staging');
  await mkdir(staging);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, staging, stagingDirectory: staging, history: path.join(root, 'private-history'), historyDirectory: path.join(root, 'private-history') };
}

test('publishes immutable numbered generations and archives the previous generation', async (t) => {
  const paths = await fixture(t);
  await writeFile(path.join(paths.staging, 'tracks.json'), JSON.stringify({ tracks: ['a'] }));
  const first = await publishSnapshot(paths);
  assert.equal(first.generation, 1);
  assert.equal(first.directory, 'public-snapshots1');
  const firstFiles = await readdir(path.join(paths.root, first.directory));
  const firstIndex = JSON.parse(await readFile(path.join(paths.root, first.directory, 'index.json'), 'utf8'));
  assert.deepEqual(firstFiles.sort(), ['index.json', firstIndex.files['tracks.json'].path, firstIndex.files['track-statistics.json'].path].sort());
  assert.deepEqual(JSON.parse(await readFile(path.join(paths.root, 'snapshot-current.json'), 'utf8')), { currentdir: 'public-snapshots1' });

  const unchanged = await publishSnapshot(paths);
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.generation, 1);
  await writeFile(path.join(paths.staging, 'tracks.json'), JSON.stringify({ tracks: ['b'] }));
  const second = await publishSnapshot(paths);
  assert.equal(second.generation, 2);
  assert.equal(second.archivePath, path.join(paths.history, 'generation-1.snapshot.gz'));
  assert.deepEqual((await readdir(path.join(paths.root, 'public-snapshots1'))).sort(), firstFiles.sort());

  const restored = path.join(paths.root, 'restored');
  await restoreSnapshotArchive(second.archivePath, restored);
  const archiveIndex = JSON.parse(await readFile(path.join(restored, 'index.json'), 'utf8'));
  const archivedPayload = await readFile(path.join(restored, archiveIndex.files['tracks.json'].path));
  assert.equal(Buffer.from(await decodeSnapshot(archivedPayload)).toString('utf8'), '{"tracks":["a"]}');
});

test('codec round-trips JSON bytes and explicitly exposes non-security metadata', async () => {
  const encoded = await encodeSnapshot({ label: 'public' });
  assert.equal(Buffer.from(await decodeSnapshot(encoded)).toString('utf8'), '{"label":"public"}');
  assert.match((await import('./snapshot-package.mjs')).SNAPSHOT_CODEC.security, /not|non-security/i);
});

test('rejects staging files larger than the decoded limit', async (t) => {
  const paths = await fixture(t);
  await writeFile(path.join(paths.staging, 'too-large.json'), `{"data":"${'x'.repeat(MAX_DECODED_BYTES)}"}`);
  await assert.rejects(publishSnapshot(paths), /exceeds decoded limit/);
  assert.deepEqual(await readdir(paths.root), ['staging']);
});

test('omits export-progress checkpoint files', async (t) => {
  const paths = await fixture(t);
  await writeFile(path.join(paths.staging, 'overall.json'), '{"ok":true}');
  await writeFile(path.join(paths.staging, 'export-progress.json'), '{"checkpoint":true}');
  const result = await publishSnapshot(paths);
  const index = JSON.parse(await readFile(path.join(paths.root, result.directory, 'index.json'), 'utf8'));
  assert.deepEqual(Object.keys(index.files).sort(), ['overall.json', 'track-statistics.json']);
  assert.equal(index.encoding, 'gzip-xor-a7-v1');
});

test('builds compact statistics without claiming incomplete entry sets are complete', () => {
  const id = 'a'.repeat(64), other = 'b'.repeat(64);
  const stats = buildTrackStatistics([
    { logicalPath: 'manifest.json', value: { trackIdsKnown: 2, tracks: {
      [id]: { path: `tracks/${id}.json`, revision: 7, sourceUpdatedAt: 100, checkedAt: 200 },
      [other]: { path: null, revision: 3, sourceUpdatedAt: 50 },
    } } },
    { logicalPath: `tracks/${id}.json`, value: { trackId: id, complete: false, totalEntries: 3, updatedAt: 100, revision: 7,
      entries: [{ accountId: 'c'.repeat(64), weight: 0.5 }, { accountId: 'd'.repeat(64), weight: 0.5 }] } },
    { logicalPath: 'overall.json', value: { revision: 12, updatedAt: 300 } },
    { logicalPath: 'public-export-summary.json', value: { capturedAt: '2026-10-10T00:00:00.000Z' } },
  ]);
  assert.equal(stats.complete, false);
  assert.equal(stats.tracksKnown, 2);
  assert.equal(stats.tracksPresent, 1);
  assert.equal(stats.tracks[id].count, 2);
  assert.equal(stats.tracks[id].players, null);
  assert.equal(stats.tracks[id].totalEntries, 3);
  assert.equal(stats.tracks[id].weight, 0.5);
  assert.equal(stats.tracks[id].revision, 7);
  assert.equal(stats.tracks[id].updatedAt, 100);
  assert.equal(stats.tracks[id].capturedAt, new Date(200).toISOString());
  assert.equal(stats.tracks[other].count, null);
  assert.equal(stats.tracks[other].capturedAt, null);
  assert.equal(stats.revision, 12);
  assert.equal(stats.updatedAt, 300);
  assert.equal(stats.capturedAt, '2026-10-10T00:00:00.000Z');
});

test('reports exact players only for complete unique-entry snapshots', () => {
  const id = 'a'.repeat(64);
  const stats = buildTrackStatistics([
    { logicalPath: 'manifest.json', value: { trackIdsKnown: 1, tracks: { [id]: { path: `tracks/${id}.json` } } } },
    { logicalPath: `tracks/${id}.json`, value: { complete: true, totalEntries: 2, entries: [
      { accountId: 'b'.repeat(64), weight: 0.25 }, { accountId: 'c'.repeat(64), weight: 0.25 },
    ] } },
  ]);
  assert.equal(stats.complete, true);
  assert.equal(stats.tracks[id].players, 2);
  assert.equal(stats.tracks[id].count, 2);
});

test('regenerates hydrated track statistics once and preserves a valid zero weight', async (t) => {
  const paths = await fixture(t);
  const id = 'a'.repeat(64);
  await writeFile(path.join(paths.staging, 'manifest.json'), JSON.stringify({ trackIdsKnown: 1, tracks: {
    [id]: { path: `tracks/${id}.json`, revision: 4, checkedAt: 500 },
  } }));
  await mkdir(path.join(paths.staging, 'tracks'));
  await writeFile(path.join(paths.staging, 'tracks', `${id}.json`), JSON.stringify({ trackId: id, complete: true, totalEntries: 1,
    revision: 4, updatedAt: 400, entries: [{ accountId: 'b'.repeat(64), weight: 0 }] }));
  await writeFile(path.join(paths.staging, 'track-statistics.json'), JSON.stringify({ schemaVersion: 1, stale: true }));

  const result = await publishSnapshot(paths);
  const index = JSON.parse(await readFile(path.join(paths.root, result.directory, 'index.json'), 'utf8'));
  assert.equal(Object.keys(index.files).filter(name => name === 'track-statistics.json').length, 1);
  const statsBytes = await readFile(path.join(paths.root, result.directory, index.files['track-statistics.json'].path));
  const stats = JSON.parse(Buffer.from(await decodeSnapshot(statsBytes)).toString('utf8'));
  assert.equal(stats.stale, undefined);
  assert.equal(stats.complete, true);
  assert.equal(stats.tracks[id].players, 1);
  assert.equal(stats.tracks[id].weight, 0);
  assert.equal((await readdir(path.join(paths.root, result.directory))).length, 4);
});


test('package publication time is stable for no-op runs and changes only with content', async t => {
 const f=await fixture(t);await writeFile(path.join(f.staging,'sample.json'),'{"value":1}');
 const first=await publishSnapshot({...f,now:()=>1000});
 const load=async dir=>JSON.parse(await readFile(path.join(f.root,dir,'index.json'),'utf8'));
 assert.equal((await load(first.directory)).publishedAt,1000);
 const same=await publishSnapshot({...f,now:()=>{throw Error('no-op must not stamp time');}});
 assert.equal(same.changed,false);assert.equal((await load(first.directory)).publishedAt,1000);
 await writeFile(path.join(f.staging,'sample.json'),'{"value":2}');
 const changed=await publishSnapshot({...f,now:()=>2000});
 assert.equal((await load(changed.directory)).publishedAt,2000);
 assert.equal((await load(first.directory)).publishedAt,1000);
});
