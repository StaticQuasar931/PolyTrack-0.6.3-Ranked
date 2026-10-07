import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { decodeSnapshot, encodeSnapshot, MAX_DECODED_BYTES, publishSnapshot, restoreSnapshotArchive } from './snapshot-package.mjs';

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
  assert.deepEqual(firstFiles.sort(), ['index.json', firstIndex.files['tracks.json'].path].sort());
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
  assert.deepEqual(Object.keys(index.files), ['overall.json']);
  assert.equal(index.encoding, 'gzip-xor-a7-v1');
});
