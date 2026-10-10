import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { decodeSnapshot } from './snapshot-package.mjs';
import { updatePublicSnapshot } from './update-public-snapshot.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'update-public-snapshot-'));
  await mkdir(path.join(root, 'local-reports', 'snapshot-staging'), { recursive: true });
  await writeFile(path.join(root, 'index.html'), '<!doctype html><html><head></head><body></body></html>\n');
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('offline mode packages staging, excludes progress, writes honest coverage and updates meta', async t => {
  const root = await fixture(t);
  const staging = path.join(root, 'local-reports', 'snapshot-staging');
  await writeFile(path.join(staging, 'overall.json'), JSON.stringify({ complete: false, entries: [] }));
  await writeFile(path.join(staging, 'manifest.json'), JSON.stringify({ trackIdsKnown: 5, trackBackupsPresent: 3, trackBackupsMissing: 2 }));
  await writeFile(path.join(staging, 'export-progress.json'), JSON.stringify({ secretCheckpoint: 'private' }));
  let captureCalls = 0;
  const result = await updatePublicSnapshot({ root, offline: true, capture: async () => { captureCalls++; }, log: () => {} });
  assert.equal(captureCalls, 0);
  assert.equal(result.generation, 1);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.backup.overallComplete, false);
  assert.equal(result.coverage.profileReplay.requested, false);
  const index = JSON.parse(await readFile(path.join(root, result.directory, 'index.json'), 'utf8'));
  assert.deepEqual(Object.keys(index.files).sort(), ['cosmetic-directory.json', 'coverage.json', 'manifest.json', 'overall.json']);
  assert.match(await readFile(path.join(root, 'index.html'), 'utf8'), /name="polytrack-snapshot" content="\.\/public-snapshots1\/"/);
});

test('hydrates a missing staging directory from validated packed JSON and privately retires legacy raw files', async t => {
  const root = await fixture(t);
  const initial = path.join(root, 'initial-stage');
  await mkdir(initial);
  await writeFile(path.join(initial, 'overall.json'), '{"complete":true,"entries":[]}');
  await writeFile(path.join(initial, 'coverage.json'), JSON.stringify({ schemaVersion: 1, complete: false,
    profileReplay: { requested: true, complete: true, counts: { profiles: 37, recordings: 12 }, totalCoverage: { available: 12, complete: true }, budgetReached: false } }));
  await writeFile(path.join(initial, 'export-progress.json'), '{"private":true}');
  const { publishSnapshot } = await import('./snapshot-package.mjs');
  const first = await publishSnapshot({ root, stagingDirectory: initial });
  await rm(path.join(root, 'local-reports', 'snapshot-staging'), { recursive: true });
  await mkdir(path.join(root, 'public-snapshots'));
  await writeFile(path.join(root, 'public-snapshots', 'private-legacy.txt'), 'preserve me');
  const result = await updatePublicSnapshot({ root, offline: true, log: () => {} });
  assert.equal(result.generation, 2);
  assert.equal(result.coverage.profileReplay.counts.profiles, 37);
  assert.equal(result.coverage.profileReplay.counts.recordings, 12);
  assert.equal(result.coverage.profileReplay.complete, true);
  assert.equal(await readFile(path.join(root, 'local-reports', 'snapshot-history', 'legacy-public-snapshots', 'private-legacy.txt'), 'utf8'), 'preserve me');
  const hydratedOverall = JSON.parse(await readFile(path.join(root, 'local-reports', 'snapshot-staging', 'overall.json'), 'utf8'));
  assert.equal(hydratedOverall.complete, true);
  assert.equal(await readFile(path.join(root, 'local-reports', 'snapshot-staging', 'export-progress.json'), 'utf8').then(() => true, () => false), false);
  const archive = path.join(root, 'local-reports', 'snapshot-history', 'generation-1.snapshot.gz');
  assert.equal(await readFile(archive).then(() => true, () => false), true);
  assert.equal(await readFile(path.join(root, 'local-reports', 'snapshot-history', 'retired-public-snapshots1', 'index.json'), 'utf8').then(() => true, () => false), true);
  const secondIndex = JSON.parse(await readFile(path.join(root, result.directory, 'index.json'), 'utf8'));
  const encoded = await readFile(path.join(root, result.directory, secondIndex.files['overall.json'].path));
  assert.equal(Buffer.from(await decodeSnapshot(encoded)).toString('utf8'), '{"complete":true,"entries":[]}');
});

test('hydrates before the default bounded capture runs', async t => {
  const root = await fixture(t);
  const initial = path.join(root, 'initial-stage');
  await mkdir(initial);
  await writeFile(path.join(initial, 'overall.json'), '{"complete":false,"entries":[]}');
  await writeFile(path.join(initial, 'coverage.json'), JSON.stringify({ schemaVersion: 1,
    profileReplay: { requested: true, complete: false, counts: { profiles: 8 }, totalCoverage: { available: 4 }, budgetReached: true } }));
  const { publishSnapshot } = await import('./snapshot-package.mjs');
  await publishSnapshot({ root, stagingDirectory: initial });
  await rm(path.join(root, 'local-reports', 'snapshot-staging'), { recursive: true });
  let sawHydrated = false;
  await updatePublicSnapshot({ root, capture: async ({ directory }) => {
    sawHydrated = JSON.parse(await readFile(path.join(directory, 'overall.json'), 'utf8')).complete === false;
    await writeFile(path.join(directory, 'manifest.json'), '{}');
    return {};
  }, log: () => {} });
  assert.equal(sawHydrated, true);
  const coverage = JSON.parse(await readFile(path.join(root, 'public-snapshots2', 'index.json'), 'utf8'));
  const coveragePayload = await readFile(path.join(root, 'public-snapshots2', coverage.files['coverage.json'].path));
  const publishedCoverage = JSON.parse(Buffer.from(await decodeSnapshot(coveragePayload)).toString('utf8'));
  assert.deepEqual(publishedCoverage.profileReplay.counts, { profiles: 8 });
  assert.equal(publishedCoverage.profileReplay.budgetReached, true);
});

test('full-public caps export at 2000 documents and cannot claim complete with incomplete overall', async t => {
  const root = await fixture(t);
  const staging = path.join(root, 'local-reports', 'snapshot-staging');
  await writeFile(path.join(staging, 'overall.json'), '{"complete":false,"entries":[]}');
  let exportOptions;
  const result = await updatePublicSnapshot({ root, fullPublic: true, capture: async () => ({}),
    exportPublic: async options => { exportOptions = options; return { complete: true, totalCoverage: { complete: true }, counts: {} }; }, log: () => {} });
  assert.equal(exportOptions.maxDocuments, 2000);
  assert.equal(exportOptions.fullSnapshot, true);
  assert.equal(result.coverage.profileReplay.complete, true);
  assert.equal(result.coverage.complete, false);
});

test('full-public resumes an export checkpoint instead of restarting its full scan', async t => {
  const root = await fixture(t);
  const staging = path.join(root, 'local-reports', 'snapshot-staging');
  await writeFile(path.join(staging, 'overall.json'), '{"complete":true,"entries":[]}');
  await writeFile(path.join(staging, 'export-progress.json'), JSON.stringify({ fullSnapshotPending: true }));
  let fullSnapshot;
  await updatePublicSnapshot({ root, fullPublic: true, capture: async () => ({}),
    exportPublic: async options => { fullSnapshot = options.fullSnapshot; return { complete: false, totalCoverage: { complete: false }, budgetReached: true }; }, log: () => {} });
  assert.equal(fullSnapshot, false);
});

test('offline coverage uses saved export summary and never claims complete with missing tracks or events', async t => {
  const root = await fixture(t);
  const staging = path.join(root, 'local-reports', 'snapshot-staging');
  await writeFile(path.join(staging, 'overall.json'), JSON.stringify({ complete: true, entries: [{}, {}] }));
  await writeFile(path.join(staging, 'manifest.json'), JSON.stringify({ trackIdsKnown: 7, trackBackupsMissing: 1,
    eventsMissing: 0, eventReplays: { runA: {}, runB: {} } }));
  await writeFile(path.join(staging, 'public-export-summary.json'), JSON.stringify({ complete: false, counts: { profiles: 292, recordings: 1283 },
    scanned: 1321, coverage: { available: 1283, missing: 0, invalid: 38 } }));
  const result = await updatePublicSnapshot({ root, offline: true, log: () => {} });
  assert.equal(result.coverage.profileReplay.counts.profiles, 292);
  assert.equal(result.coverage.profileReplay.counts.recordings, 1283);
  assert.equal(result.coverage.profileReplay.scanned, 1321);
  assert.deepEqual(result.coverage.profileReplay.coverage, { available: 1283, missing: 0, invalid: 38 });
  assert.equal(result.coverage.backup.overallEntries, 2);
  assert.equal(result.coverage.backup.eventReplays, 2);
  assert.equal(result.coverage.complete, false);
});

test('deferred capture skips event totals and preserves the current pointer', async t => {
  const root = await fixture(t);
  const { runPublicSnapshotBackup } = await import('./public-snapshot-backup.mjs');
  let totalsCalls = 0;
  await assert.rejects(updatePublicSnapshot({ root, capture: runPublicSnapshotBackup,
    captureOptions: { fetchImpl: async () => { throw new Error('test network disabled'); } },
    captureTotals: async () => { totalsCalls++; }, log: () => {} }), /Snapshot capture deferred/);
  assert.equal(totalsCalls, 0);
  assert.equal(await readFile(path.join(root, 'snapshot-current.json')).then(() => true, () => false), false);
});
