import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {generateKeyPairSync} from 'node:crypto';
const fixtureKey = generateKeyPairSync('rsa', {modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'});
const exportAuth = {serviceAccount:{type:'service_account',project_id:'polytrack-052',client_email:'fixture@polytrack-052.iam.gserviceaccount.com',private_key:fixtureKey},
  oauthFetch:async()=>Response.json({access_token:'fixture-token',token_type:'Bearer',expires_in:3600})};

import { decodeSnapshot } from './snapshot-package.mjs';
import { updatePublicSnapshot, reportCaptureOutcome } from './update-public-snapshot.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'update-public-snapshot-'));
  await mkdir(path.join(root, 'local-reports', 'snapshot-staging'), { recursive: true });
  await writeFile(path.join(root, 'index.html'), '<!doctype html><html><head></head><body></body></html>\n');
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('replay-only refresh has a 100-document cap and does not restart profile scans',async t=>{
 const root=await fixture(t);let options;
 await updatePublicSnapshot({root,capture:async()=>({}),refreshReplays:true,exportPublic:async value=>{
  options=value;return {complete:false,coverage:{complete:false},counts:{recordings:0}};
 },log:()=>{}});
 assert.equal(options.maxDocuments,100);assert.equal(options.includeProfiles,false);assert.equal(options.fullSnapshot,false);
});

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
  assert.deepEqual(Object.keys(index.files).sort(), ['cosmetic-directory.json', 'coverage.json', 'manifest.json', 'overall.json', 'racer-directory.json', 'track-statistics.json']);
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
  const result = await updatePublicSnapshot({ root, capture: runPublicSnapshotBackup, captureOverall: null,
    captureOptions: { fetchImpl: async () => { throw new Error('test network disabled'); } },
    captureTotals: async () => { totalsCalls++; }, log: () => {} });
  assert.equal(result.deferred, true);
  assert.equal(result.published, false);
  assert.equal(totalsCalls, 0);
  assert.equal(await readFile(path.join(root, 'snapshot-current.json')).then(() => true, () => false), false);
});

async function publishFixture(root, staging, overall) {
  await mkdir(staging, { recursive: true });
  await writeFile(path.join(staging, 'overall.json'), JSON.stringify(overall));
  const { publishSnapshot } = await import('./snapshot-package.mjs');
  return publishSnapshot({ root, stagingDirectory: staging });
}

test('rebases a retained A stage onto externally published B before bounded capture', async t => {
  const root = await fixture(t);
  const stage = path.join(root, 'local-reports', 'snapshot-staging');
  const publishedA = await publishFixture(root, stage, { generationData: 'A', entries: [] });
  await writeFile(path.join(root, 'local-reports', 'snapshot-staging-base.json'), JSON.stringify({ schemaVersion: 1, generation: publishedA.generation }));
  await writeFile(path.join(stage, 'user-result.json'), JSON.stringify({ retained: true }));
  await writeFile(path.join(stage, 'export-progress.json'), JSON.stringify({ fullSnapshotPending: true, raceExport: { pending: ['same-replay'] } }));

  const newer = path.join(root, 'external-stage');
  const publishedB = await publishFixture(root, newer, { generationData: 'B', entries: [] });
  assert.equal(publishedB.generation, publishedA.generation + 1);

  let observed;
  let exportedProgress;
  let exportOptions;
  const result = await updatePublicSnapshot({ root,
    capture: async ({ directory }) => {
      observed = JSON.parse(await readFile(path.join(directory, 'overall.json'), 'utf8'));
      assert.equal(JSON.parse(await readFile(path.join(directory, 'user-result.json'), 'utf8')).retained, true);
      return {};
    },
    exportPublic: async options => {
      exportOptions = options;
      const { directory } = options;
      exportedProgress = JSON.parse(await readFile(path.join(directory, 'export-progress.json'), 'utf8'));
      return { complete: false, coverage: { complete: false }, counts: {} };
    },
    refreshReplays: true, log: () => {},
  });

  assert.equal(observed.generationData, 'B');
  assert.equal(exportedProgress.fullSnapshotPending, true);
  assert.equal(exportOptions.maxDocuments, 100);
  const archiveNames = await readdir(path.join(root, 'local-reports', 'snapshot-history'));
  const archivedStage = archiveNames.find(name => name.startsWith(`staging-public-snapshots${publishedA.generation}-before-public-snapshots${publishedB.generation}-`));
  assert.ok(archivedStage);
  const archived = path.join(root, 'local-reports', 'snapshot-history', archivedStage);
  assert.equal(JSON.parse(await readFile(path.join(archived, 'overall.json'), 'utf8')).generationData, 'A');
  assert.equal(JSON.parse(await readFile(path.join(archived, 'export-progress.json'), 'utf8')).fullSnapshotPending, true);
  assert.ok(await readFile(path.join(archived, 'snapshot-rebase.json'), 'utf8'));

  const index = JSON.parse(await readFile(path.join(root, result.directory, 'index.json'), 'utf8'));
  const overall = await readFile(path.join(root, result.directory, index.files['overall.json'].path));
  assert.equal(JSON.parse(Buffer.from(await decodeSnapshot(overall)).toString('utf8')).generationData, 'B');
  const userResult = await readFile(path.join(root, result.directory, index.files['user-result.json'].path));
  assert.deepEqual(JSON.parse(Buffer.from(await decodeSnapshot(userResult)).toString('utf8')), { retained: true });
});

test('current generation base keeps the stage and its resumable export checkpoint', async t => {
  const root = await fixture(t);
  const stage = path.join(root, 'local-reports', 'snapshot-staging');
  const published = await publishFixture(root, stage, { generationData: 'same', entries: [] });
  await writeFile(path.join(stage, 'export-progress.json'), JSON.stringify({ fullSnapshotPending: true }));
  await writeFile(path.join(root, 'local-reports', 'snapshot-staging-base.json'), JSON.stringify({ schemaVersion: 1, generation: published.generation }));
  let fullSnapshot;
  await updatePublicSnapshot({ root, fullPublic: true, capture: async () => ({}),
    exportPublic: async options => { fullSnapshot = options.fullSnapshot; return { complete: false, coverage: { complete: false }, counts: {} }; }, log: () => {} });
  assert.equal(fullSnapshot, false);
  const history = await readdir(path.join(root, 'local-reports', 'snapshot-history')).catch(() => []);
  assert.equal(history.some(name => name.startsWith('staging-')), false);
});

test('invalid current baseline leaves the retained stage untouched and skips capture', async t => {
  const root = await fixture(t);
  const stage = path.join(root, 'local-reports', 'snapshot-staging');
  await writeFile(path.join(stage, 'overall.json'), '{"generationData":"A"}');
  await writeFile(path.join(root, 'snapshot-current.json'), JSON.stringify({ currentdir: 'public-snapshots2' }));
  await mkdir(path.join(root, 'public-snapshots2'));
  await writeFile(path.join(root, 'public-snapshots2', 'index.json'), JSON.stringify({ schemaVersion: 1, generation: 1, encoding: 'gzip-xor-a7-v1', files: {} }));
  let captureCalls = 0;
  await assert.rejects(updatePublicSnapshot({ root, capture: async () => { captureCalls++; return {}; }, log: () => {} }), /Current snapshot index is invalid/);
  assert.equal(captureCalls, 0);
  assert.equal(JSON.parse(await readFile(path.join(stage, 'overall.json'), 'utf8')).generationData, 'A');
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'snapshot-current.json'), 'utf8')), { currentdir: 'public-snapshots2' });
});

test('deferred capture after rebase keeps the new baseline, old stage, and checkpoint', async t => {
  const root = await fixture(t);
  const stage = path.join(root, 'local-reports', 'snapshot-staging');
  const publishedA = await publishFixture(root, stage, { generationData: 'A', entries: [] });
  await writeFile(path.join(root, 'local-reports', 'snapshot-staging-base.json'), JSON.stringify({ schemaVersion: 1, generation: publishedA.generation }));
  await writeFile(path.join(stage, 'export-progress.json'), JSON.stringify({ checkpoint: 'keep' }));
  const publishedB = await publishFixture(root, path.join(root, 'external-stage'), { generationData: 'B', entries: [] });

  const result = await updatePublicSnapshot({ root, capture: async () => ({ deferred: true, reason: 'test budget' }), log: () => {} });
  assert.equal(result.deferred, true);
  assert.equal(result.published, false);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'snapshot-current.json'), 'utf8')), { currentdir: publishedB.directory });
  assert.equal(JSON.parse(await readFile(path.join(stage, 'overall.json'), 'utf8')).generationData, 'B');
  assert.equal(JSON.parse(await readFile(path.join(stage, 'export-progress.json'), 'utf8')).checkpoint, 'keep');
  const archivedStages = (await readdir(path.join(root, 'local-reports', 'snapshot-history'))).filter(name => name.startsWith('staging-'));
  assert.equal(archivedStages.length, 1);
  assert.equal(JSON.parse(await readFile(path.join(root, 'local-reports', 'snapshot-history', archivedStages[0], 'overall.json'), 'utf8')).generationData, 'A');
});

test('fresh hydration reconstructs omitted track and overall monoliths from verified pages', async t => {
  const root = await fixture(t);
  const staging = path.join(root, 'local-reports', 'snapshot-staging');
  const trackId = 'a'.repeat(64);
  const accountId = number => number.toString(16).padStart(64, '0');
  const track = { trackId, schemaVersion: 6, revision: 14, sourceRevision: 14, algorithmVersion: 'rank-v2',
    complete: true, totalEntries: 260, entries: Array.from({ length: 260 }, (_, index) => ({ accountId: accountId(index + 1),
      timeMs: 1000 + index, rank: index + 1, position: index + 1, name: 't'.repeat(9000) })) };
  const overall = { schemaVersion: 6, revision: 24, sourceRevision: 24, updatedAt: 500, complete: true,
    totalEntries: 260, trackSummaries: [{ trackId, fieldSize: 260 }], entries: Array.from({ length: 260 }, (_, index) =>
      ({ userId: accountId(index + 1), rank: index + 1, score: 5000 - index, name: 'o'.repeat(9000) })) };
  await mkdir(path.join(staging, 'tracks'), { recursive: true });
  await writeFile(path.join(staging, 'tracks', `${trackId}.json`), JSON.stringify(track));
  await writeFile(path.join(staging, 'overall.json'), JSON.stringify(overall));
  await writeFile(path.join(staging, 'manifest.json'), JSON.stringify({ schemaVersion: 1, tracks: { [trackId]: { checkedAt: '2026-10-12T00:00:00.000Z' } } }));
  await writeFile(path.join(staging, 'public-export-summary.json'), JSON.stringify({ capturedAt: '2026-10-13T00:00:00.000Z' }));
  const { publishSnapshot } = await import('./snapshot-package.mjs');
  const initial = await publishSnapshot({ root, stagingDirectory: staging });
  const index = JSON.parse(await readFile(path.join(root, initial.directory, 'index.json'), 'utf8'));
  assert.equal(index.files[`tracks/${trackId}.json`], undefined);
  assert.equal(index.files['overall.json'], undefined);

  await rm(staging, { recursive: true });
  const result = await updatePublicSnapshot({ root, offline: true, log: () => {} });
  const hydratedTrack = JSON.parse(await readFile(path.join(staging, 'tracks', `${trackId}.json`), 'utf8'));
  const hydratedOverall = JSON.parse(await readFile(path.join(staging, 'overall.json'), 'utf8'));
  assert.equal(hydratedTrack.entries.length, 260);
  assert.equal(hydratedTrack.entries[259].rank, 260);
  assert.equal(hydratedTrack.complete, true);
  assert.equal(hydratedTrack._reconstructedFromPages, true);
  assert.equal(hydratedOverall.entries.length, 260);
  assert.equal(hydratedOverall.entries[259].rank, 260);
  assert.equal(hydratedOverall.trackSummaries[0].fieldSize, 260);
  assert.equal(hydratedOverall.capturedAt, '2026-10-13T00:00:00.000Z');
  assert.equal(hydratedOverall._reconstructedFromPages, true);
  assert.equal(result.generation, initial.generation + 1);
});

test('corrupt page payload safely aborts fresh hydration without creating a partial stage', async t => {
  const root = await fixture(t);
  const staging = path.join(root, 'local-reports', 'snapshot-staging');
  const trackId = 'b'.repeat(64);
  const entries = Array.from({ length: 260 }, (_, index) => ({ accountId: (index + 1).toString(16).padStart(64, '0'),
    timeMs: 1000 + index, rank: index + 1, name: 'x'.repeat(9000) }));
  await mkdir(path.join(staging, 'tracks'), { recursive: true });
  await writeFile(path.join(staging, 'tracks', `${trackId}.json`), JSON.stringify({ trackId, entries, complete: true, totalEntries: entries.length }));
  const { publishSnapshot } = await import('./snapshot-package.mjs');
  const published = await publishSnapshot({ root, stagingDirectory: staging });
  await rm(staging, { recursive: true });
  const indexPath = path.join(root, published.directory, 'index.json');
  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  const pageRecord = index.files[`track-pages/${trackId}/2.json`];
  const pagePath = path.join(root, published.directory, pageRecord.path);
  const bytes = await readFile(pagePath);
  bytes[0] ^= 0xff;
  await writeFile(pagePath, bytes);

  await assert.rejects(updatePublicSnapshot({ root, offline: true, log: () => {} }), /Snapshot payload hash mismatch: track-pages/);
  assert.equal(await readFile(staging).then(() => true, () => false), false);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'snapshot-current.json'), 'utf8')), { currentdir: published.directory });
});

async function replayCaptureFixture(t) {
  const root = await fixture(t), staging = path.join(root, 'local-reports', 'snapshot-staging');
  const accountId = 'a'.repeat(64), trackId = 'b'.repeat(64), replayHash = 'c'.repeat(64);
  await mkdir(path.join(staging, 'tracks'));
  await writeFile(path.join(staging, 'tracks', trackId + '.json'), JSON.stringify({trackId, complete: true, entries: [
    {accountId, trackId, uploadId: 42, frames: 900, raceTimeFrames: 900, timeMs: 15000,
      replayHash, runVerified: true, integrityVerified: true},
  ]}));
  await writeFile(path.join(staging, 'overall.json'), JSON.stringify({complete: true, entries: [], trackSummaries: []}));
  const published = await updatePublicSnapshot({root, offline: true, log: () => {}});
  const files = ['snapshot-current.json', 'index.html', ...
    (await readdir(path.join(root, published.directory), {recursive: true, withFileTypes: true}))
      .filter(entry => entry.isFile()).map(entry => path.relative(root, path.join(entry.parentPath, entry.name)))];
  const original = new Map();
  for (const file of files) original.set(file, await readFile(path.join(root, file)));
  const unchanged = async () => {
    for (const [file, bytes] of original) assert.deepEqual(await readFile(path.join(root, file)), bytes, file);
    assert.deepEqual((await readdir(root)).filter(name => /^public-snapshots\d+$/.test(name)), [published.directory]);
  };
  return {root, staging, unchanged};
}

test('all expected replay HTTP deferrals stop without publishing or retrying', async t => {
  const f = await replayCaptureFixture(t);
  for (const status of [408, 429, 500, 502, 503, 504]) {
    let requests = 0;
    const result = await updatePublicSnapshot({root: f.root, refreshReplays: true, capture: async () => ({}),
      exportAuth, exportFetch: async () => {requests++; return new Response('', {status});}, log: () => {}});
    assert.deepEqual(result, {deferred: true, published: false, phase: 'replays',
      reason: 'Replay export service temporarily unavailable', status, previousPackagePreserved: true});
    assert.equal(requests, 1);
    await f.unchanged();
    const progress = JSON.parse(await readFile(path.join(f.staging, 'export-progress.json'), 'utf8'));
    assert.equal(progress.raceExport.pending.length, 1);
    assert.equal(Object.keys(progress.raceExport.covered).length, 0);
  }
});

test('replay fetch and response-stream interruptions defer without publication', async t => {
  const f = await replayCaptureFixture(t);
  for (const exportFetch of [
    async () => {throw new TypeError('fetch failed');},
    async () => {throw new DOMException('timed out', 'TimeoutError');},
    async () => ({ok: true, status: 200, text: async () => {throw new TypeError('terminated');}}),
    async () => ({ok: true, status: 200, text: async () => {throw new DOMException('aborted', 'AbortError');}}),
  ]) {
    const result = await updatePublicSnapshot({root: f.root, refreshReplays: true,
      capture: async () => ({}), exportAuth, exportFetch, log: () => {}});
    assert.equal(result.deferred, true); assert.equal(result.published, false);
    await f.unchanged();
  }
});

test('authorization, malformed responses and unexpected export failures remain fatal', async t => {
  const f = await replayCaptureFixture(t);
  for (const [exportFetch, expected] of [
    [async () => new Response('', {status: 403}), /read permission denied \(403\)/],
    [async () => new Response('not JSON'), /Invalid Firestore batchGet JSON/],
    [async () => Response.json({invalid: true}), /Invalid Firestore batchGet response/],
    [async () => {throw new Error('unexpected implementation failure');}, /Snapshot export transport failed/],
    [async () => {throw new TypeError('invalid option');}, /Snapshot export transport failed/],
  ]) {
    await assert.rejects(updatePublicSnapshot({root: f.root, refreshReplays: true,
      capture: async () => ({}), exportAuth, exportFetch, log: () => {}}), expected);
    await f.unchanged();
  }
});

test('snapshot deferral preserves all published bytes and does not start replay export', async t => {
  const f = await replayCaptureFixture(t);
  let exported = 0;
  const result = await updatePublicSnapshot({root: f.root, refreshReplays: true,
    capture: async () => ({deferred: true, reason: 'quota', status: 429}),
    exportPublic: async () => {exported++; throw Error('must not export');}, log: () => {}});
  assert.equal(result.deferred, true); assert.equal(exported, 0);
  await f.unchanged();
});

test('malformed snapshot data remains fatal rather than reporting a deferral', async t => {
  const f = await replayCaptureFixture(t);
  await assert.rejects(updatePublicSnapshot({root: f.root, captureOverall: null,
    captureOptions: {fetchImpl: async () => new Response('not JSON')}, log: () => {}}), /Invalid public snapshot JSON/);
  await f.unchanged();
});

test('workflow reporting explicitly distinguishes complete from deferred and rejects invalid outcomes', async t => {
  const root = await fixture(t), env = {GITHUB_OUTPUT: path.join(root, 'output'), GITHUB_STEP_SUMMARY: path.join(root, 'summary')};
  const warnings = [];
  await reportCaptureOutcome({deferred: true, published: false}, {env, log: value => warnings.push(value)});
  assert.equal(await readFile(env.GITHUB_OUTPUT, 'utf8'), 'capture_status=deferred\n');
  assert.match(await readFile(env.GITHUB_STEP_SUMMARY, 'utf8'), /publication skipped/);
  assert.match(warnings[0], /^::warning::/);
  await writeFile(env.GITHUB_OUTPUT, '');
  await reportCaptureOutcome({deferred: false}, {env, log: value => warnings.push(value)});
  assert.equal(await readFile(env.GITHUB_OUTPUT, 'utf8'), 'capture_status=complete\n');
  assert.equal(warnings.length, 1);
  await assert.rejects(reportCaptureOutcome({}, {env}), /Invalid public capture outcome/);
});

async function totalsUpdateFixture(t){
  const f=await replayCaptureFixture(t);
  const progress=path.join(f.staging,'export-progress.json');
  const ledger=JSON.stringify({schemaVersion:2,projectId:'polytrack-052',raceExport:{records:{prior:{available:false,reason:'missing',checkedAt:7}}}})+'\n';
  await writeFile(progress,ledger);
  return {...f,ledgerUnchanged:async()=>assert.equal(await readFile(progress,'utf8'),ledger)};
}

test('returned or typed totals deferral skips replay export and all package publication',async t=>{
  const f=await totalsUpdateFixture(t);
  const {PublicBackupDeferredError}=await import('./public-backup-fetch.mjs');
  for(const captureTotals of [async()=>({deferred:true,status:429,reason:'totals quota'}),async()=>{throw new PublicBackupDeferredError('totals quota',429);}]){
    const order=[];
    const result=await updatePublicSnapshot({root:f.root,refreshReplays:true,capture:async()=>{order.push('snapshot');return {};},
      captureTotals:async options=>{order.push('totals');return captureTotals(options);},
      exportPublic:async()=>assert.fail('Replay export must not start'),log:()=>{}});
    assert.deepEqual(result,{deferred:true,published:false,phase:'event-totals',reason:'totals quota',status:429,previousPackagePreserved:true});
    assert.deepEqual(order,['snapshot','totals']);await f.unchanged();await f.ledgerUnchanged();
    const output=path.join(f.root,'capture-output');await writeFile(output,'');
    await reportCaptureOutcome(result,{env:{GITHUB_OUTPUT:output},log:()=>{}});
    assert.equal(await readFile(output,'utf8'),'capture_status=deferred\n');
  }
});

test('totals correctness throws and invalid outcome contracts do not publish or export',async t=>{
  const f=await totalsUpdateFixture(t);
  const failure=new Error('Malformed totals generation');
  for(const captureTotals of [async()=>{throw failure;},async()=>undefined,async()=>({}),async()=>({deferred:'false'})]){
    await assert.rejects(updatePublicSnapshot({root:f.root,refreshReplays:true,capture:async()=>({}),captureTotals,
      exportPublic:async()=>assert.fail('Replay export must not start'),log:()=>{}}),error=>error===failure||/Invalid public event totals capture outcome/.test(error.message));
    await f.unchanged();await f.ledgerUnchanged();
  }
});

test('successful totals capture is included before publishing one complete package outcome',async t=>{
  const f=await totalsUpdateFixture(t),order=[];
  const {capturePublicEventTotals}=await import('./public-event-totals-backup.mjs');
  const totals={updatedAt:9,entries:[{accountId:'a'.repeat(64),name:'Racer',rp:3}],complete:true,totalEntries:1};
  const result=await updatePublicSnapshot({root:f.root,refreshReplays:true,
    capture:async()=>{order.push('snapshot');return {};},
    captureTotals:options=>capturePublicEventTotals({...options,fetchImpl:async()=>{order.push('totals');return Response.json(totals);}}),
    exportPublic:async()=>{order.push('replays');return {complete:true,coverage:{complete:true},counts:{}};},log:()=>{}});
  assert.deepEqual(order,['snapshot','totals','replays']);assert.equal(result.deferred,false);assert.equal(result.published,true);assert.equal(result.generation,2);
  const index=JSON.parse(await readFile(path.join(f.root,result.directory,'index.json'),'utf8'));
  const packed=await readFile(path.join(f.root,result.directory,index.files['event-totals.json'].path));
  assert.deepEqual(JSON.parse(Buffer.from(await decodeSnapshot(packed)).toString('utf8')),{...totals,entries:totals.entries.map(row=>({...row,identityUpdatedAt:0}))});
  await f.ledgerUnchanged();
});
