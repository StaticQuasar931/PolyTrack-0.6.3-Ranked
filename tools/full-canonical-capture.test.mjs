import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {captureFullCanonical, FULL_CANONICAL_FIELDS, FULL_CANONICAL_LIMITS} from './full-canonical-capture.mjs';
import {rankTrustedTrackEntries} from '../workers/ranked/src/index.js';
import {createFirestoreCaller} from './verifier/firestore.mjs';
import {loadCapturedNativeJobs} from './verifier/local-snapshot-capture.mjs';
import {buildProfileSnapshotResults} from './build-profile-snapshot-results.mjs';
import {buildTrackStatistics} from './snapshot-package.mjs';
import {snapshotConfirmationTime} from './snapshot-confirmation-time.mjs';
import {readCapturedNormalLedgerRows} from './public-snapshot-backup.mjs';
import {ledgerBinding, ledgerKey} from './native-verification-ledger.mjs';

const id = n => n.toString(16).padStart(64, '0');
const track = id(900), secondTrack = id(901);
const point = '2026-11-07T08:00:00.123456789Z';
const ingested = '2026-11-06T07:01:02.123456789Z';
const prefix = 'projects/fixture/databases/(default)/documents/0.6.2_race_results/';
const sha = text => createHash('sha256').update(text).digest('hex');
const replay = deflateSync(Buffer.alloc(15)).toString('base64url');
const source = (n = 1, extra = {}) => ({accountId: id(n), trackId: track, uploadId: n, timeMs: 2000,
  frames: 1000, raceTimeFrames: 1000, replay, replayHash: sha(replay), name: 'Racer', carStyle: '',
  verified: false, verifiedState: 0, pbAt: ingested, ingestedAt: ingested, ...extra});
const encode = value => value === null ? {nullValue: null} : typeof value === 'string' ? {stringValue: value} : typeof value === 'boolean'
  ? {booleanValue: value} : {integerValue: String(value)};
function document(row) {
  const fields = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, encode(value)]));
  if (typeof row.ingestedAt === 'string') fields.ingestedAt = {timestampValue: row.ingestedAt};
  return {name: prefix + `${row.accountId}_${row.trackId}`, fields};
}
const page = (rows, time = point) => rows.length ? rows.map(row => ({document: document(row), readTime: time})) : [{readTime: time}];
function transport(rows) {
  const docs = rows.map(document).sort((a, b) => a.name.localeCompare(b.name)), calls = [];
  return {calls, async call(route, body, options) {
    assert.equal(route, ':runQuery'); calls.push(structuredClone(body));
    assert.equal(typeof options.onRetry, 'function');
    const cursor = body.structuredQuery.startAt?.values[0].referenceValue;
    const result = docs.filter(doc => !cursor || doc.name > cursor).slice(0, body.structuredQuery.limit);
    return result.length ? result.map(document => ({document, readTime: point})) : [{readTime: point}];
  }};
}
async function tree(root) {
  const output = {};
  async function walk(relative = '') {
    for (const entry of await fs.readdir(path.join(root, relative), {withFileTypes: true})) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) output[name] = {link: await fs.readlink(path.join(root, name))};
      else if (entry.isDirectory()) { output[name + '/'] = null; await walk(name); }
      else output[name] = await fs.readFile(path.join(root, name), 'utf8');
    }
  }
  await walk(); return output;
}
async function fixture(t) {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Live network forbidden'));
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'full-canonical-offline-'));
  t.after(async () => {
    const resolved = await fs.realpath(parent), temp = await fs.realpath(os.tmpdir());
    assert.ok(path.relative(temp, resolved).startsWith('full-canonical-offline-'));
    await fs.rm(resolved, {recursive: true, force: true});
  });
  const root = path.join(parent, 'stage'), checkpoint = path.join(parent, 'private');
  await fs.mkdir(root); await fs.mkdir(checkpoint);
  const put = async (relative, value) => {
    await fs.mkdir(path.dirname(path.join(root, relative)), {recursive: true});
    await fs.writeFile(path.join(root, relative), JSON.stringify(value) + '\n');
  };
  const read = async relative => JSON.parse(await fs.readFile(path.join(root, relative), 'utf8'));
  const run = (rows, options = {}) => captureFullCanonical({directory: root, db: transport(rows), ...options});
  return {root, parent, checkpoint, put, read, run};
}
function saved(row, extra = {}) {
  const {replay: _, ...rest} = row;
  return {...rest, runVerified: false, integrityVerified: true, playbackPending: true,
    verificationStatus: 'pending', eventRpEligible: false, ingestedAtSource: 'firestore-server-timestamp', ...extra};
}
async function baseline(f, rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.trackId)) groups.set(row.trackId, []);
    groups.get(row.trackId).push(row);
  }
  for (const [trackId, entries] of groups) await f.put(`tracks/${trackId}.json`, {
    trackId, updatedAt: 123, entries: rankTrustedTrackEntries(entries, trackId)});
}

test('imports new accounts and tracks absent from old boards; persists audited frozen watermark', async t => {
  const f = await fixture(t), old = saved(source(1)), fresh = source(2, {trackId: secondTrack});
  await baseline(f, [old]);
  const result = await f.run([source(1), fresh], {checkpointDirectory: f.checkpoint});
  assert.equal(result.complete, true); assert.equal(result.rows, 2); assert.equal(result.newRows, 1);
  assert.equal(result.newAccounts, 1); assert.equal(result.newTracks, 1); assert.equal(result.repaired, 1);
  assert.equal(result.fullScanReadPoint, point); assert.equal(result.watermark, point);
  assert.equal(result.ingestedAt.allServerTimestamps, true); assert.equal(result.incrementalEligible, false);
  const canonical = await f.read(`canonical/${secondTrack}/${id(2)}.json`);
  assert.equal(canonical.ingestedAt, ingested); assert.equal(canonical.ingestedAtSource, 'firestore-server-timestamp');
  assert.equal(canonical.verified, false); assert.equal(canonical.runVerified, false);
  assert.equal((await f.read('recordings/2.json')).recording, replay);
  assert.equal((await f.read(`tracks/${secondTrack}.json`)).totalEntries, 1);
  assert.equal((await f.read('full-canonical-capture.json')).watermark, point);
  assert.ok(result.peakAccountedBytes <= FULL_CANONICAL_LIMITS.memoryBytes);
  assert.equal(Object.keys(await tree(f.root)).some(name => name.includes('page-') || name.includes('blob-')), false);
  assert.ok(Object.keys(await tree(f.checkpoint)).some(name => name.includes('page-')));
});

test('new track and account are discovered through the committed manifest by native and profile consumers', async t => {
  const f = await fixture(t), manifest = {schemaVersion: 1, source: 'public-ranked-worker',
    tracks: {}, trackIdsKnown: 0, tracksFetched: 20, events: {}, eventReplays: {},
    overall: {path: 'overall.json', revision: 7, updatedAt: 123},
    overallCapture: {source: 'authenticated-published-overall', readTime: '2026-11-01T00:00:00Z'},
    ownerMetadata: {retain: true}, nativeVerificationLedger: {manifestHash: id(500)}};
  await f.put('manifest.json', manifest);
  await f.put('overall.json', {updatedAt: 123, revision: 7, entries: [], trackSummaries: []});
  const result = await f.run([source(1), source(2, {trackId: secondTrack})]);
  const updated = await f.read('manifest.json');
  for (const field of ['source', 'tracksFetched', 'events', 'eventReplays', 'overall', 'overallCapture', 'ownerMetadata', 'nativeVerificationLedger']) {
    assert.deepEqual(updated[field], manifest[field]);
  }
  assert.equal(updated.trackIdsKnown, 2); assert.equal(updated.trackBackupsPresent, 2);
  assert.equal(updated.trackBackupsMissing, 0); assert.equal(updated.tracksMissing, 0);
  assert.equal(updated.fullCanonicalCapture.fullScanReadPoint, result.fullScanReadPoint);
  for (const trackId of [track, secondTrack]) {
    const record = updated.tracks[trackId], board = await f.read(record.path);
    assert.equal(record.path, `tracks/${trackId}.json`); assert.equal(record.count, 1);
    assert.equal(record.checkedAt, Date.parse(point)); assert.notEqual(record.checkedAt, Date.parse(ingested));
    assert.equal(record.fullCanonicalCapture.fullScanReadPoint, point);
    assert.equal(record.sha256, sha(await fs.readFile(path.join(f.root, record.path))));
    assert.equal(record.updatedAt, board.updatedAt); assert.equal(record.sourceUpdatedAt, board.updatedAt);
    assert.equal(snapshotConfirmationTime('track', board, {manifest: updated}), Date.parse(point));
  }
  const inputs = await loadCapturedNativeJobs({directory: f.root});
  assert.equal(inputs.coverage.complete, true); assert.equal(inputs.jobs.length, 2);
  assert.deepEqual(inputs.normalBoards.map(board => board.trackId).sort(), [track, secondTrack]);
  const profiles = await buildProfileSnapshotResults(f.root);
  assert.equal(profiles.profiles, 2); assert.equal(profiles.results, 2);
  const profile = await f.read(`profile-results/${id(2)}.json`);
  assert.equal(profile.results[0].trackId, secondTrack); assert.equal(profile.results[0].snapshotCapturedAt, Date.parse(point));
  assert.equal(profile.coverage.allTracksCaptured, true);
});

test('all staged boards and statistics have shared deterministic ranks, weights and manifest bindings', async t => {
  const f = await fixture(t), thirdTrack = id(902);
  await baseline(f, [saved(source(1)), saved(source(2, {timeMs: 1800})), saved(source(3, {trackId: secondTrack}))]);
  const originalBoard = await f.read(`tracks/${track}.json`);
  await f.put(`tracks/${track}.json`, {...originalBoard, revision: 7, sourceRevision: 6, algorithmVersion: 'retain-version'});
  const overlay = {derivedSha256: id(600), ledgerManifestHash: id(500)};
  await f.put('manifest.json', {schemaVersion: 1, trackIdsKnown: 2, tracksFetched: 20, tracks: {
    [track]: {path: `tracks/${track}.json`, revision: 7, sourceUpdatedAt: 123, updatedAt: 123,
      checkedAt: 456, sha256: id(600), nativeLedgerOverlay: overlay, customMetadata: {keep: true}},
    [secondTrack]: {path: `tracks/${secondTrack}.json`, checkedAt: 456, updatedAt: 123}
  }});
  await f.put('overall.json', {revision: 11, updatedAt: 321});
  await f.put('public-export-summary.json', {capturedAt: '2026-11-01T00:00:00Z'});
  await f.put('track-statistics.json', {stale: true});
  const sources = [source(1, {uploadId: 10, timeMs: 1800}), source(2, {timeMs: 1800}),
    source(3, {trackId: secondTrack}), source(4, {timeMs: 1700}), source(5, {trackId: thirdTrack})];
  const result = await f.run(sources);
  assert.equal(result.scanInconsistency, false);
  const manifest = await f.read('manifest.json'), stats = await f.read('track-statistics.json');
  assert.equal(manifest.trackIdsKnown, 3); assert.equal(manifest.trackBackupsPresent, 3);
  assert.deepEqual(manifest.tracks[track].customMetadata, {keep: true});
  assert.deepEqual(manifest.tracks[track].previousNativeLedgerOverlay, overlay);
  assert.equal(manifest.tracks[track].nativeLedgerOverlay, undefined);
  assert.equal(manifest.tracks[track].previousConfirmation.checkedAt, 456);
  const files = [{logicalPath: 'manifest.json', value: manifest},
    {logicalPath: 'overall.json', value: await f.read('overall.json')},
    {logicalPath: 'public-export-summary.json', value: await f.read('public-export-summary.json')}];
  for (const [trackId, record] of Object.entries(manifest.tracks)) {
    const board = await f.read(record.path);
    assert.deepEqual(board.entries, rankTrustedTrackEntries(board.entries, trackId));
    assert.equal(record.count, board.entries.length); assert.equal(record.totalEntries, board.totalEntries);
    assert.equal(record.sha256, sha(await fs.readFile(path.join(f.root, record.path))));
    assert.equal(record.bytes, (await fs.stat(path.join(f.root, record.path))).size);
    assert.equal(record.sourceUpdatedAt, board.updatedAt); assert.equal(record.updatedAt, board.updatedAt);
    assert.equal(stats.tracks[trackId].count, board.entries.length);
    assert.equal(stats.tracks[trackId].weight, board.entries[0].weight);
    files.push({logicalPath: record.path, value: board});
  }
  assert.equal((await f.read(`tracks/${track}.json`)).algorithmVersion, 'retain-version');
  assert.equal((await f.read(`tracks/${track}.json`)).revision, 7);
  assert.equal(manifest.tracks[track].checkedAt, Date.parse(point));
  assert.deepEqual(stats, {...buildTrackStatistics(files), fullScanReadPoint: point});
  assert.equal((await f.run(sources)).scanInconsistency, false);
  const repeated = (await f.read('manifest.json')).tracks[track];
  assert.equal(repeated.nativeLedgerOverlay, undefined);
  assert.deepEqual(repeated.previousNativeLedgerOverlay, overlay);
  assert.equal(repeated.sha256, sha(await fs.readFile(path.join(f.root, repeated.path))));
});

test('missing prior rows retain historical confirmation but never freshen an inexact board', async t => {
  const f = await fixture(t); await baseline(f, [saved(source(1)), saved(source(2))]);
  await f.put('manifest.json', {schemaVersion: 1, tracks: {[track]: {
    path: `tracks/${track}.json`, checkedAt: 456, sourceUpdatedAt: 123, updatedAt: 123, count: 2
  }}, trackIdsKnown: 1});
  const result = await f.run([source(1)]), manifest = await f.read('manifest.json');
  assert.equal(result.complete, true); assert.equal(result.imported, true); assert.equal(result.scanInconsistency, true);
  assert.equal(manifest.tracks[track].count, 2); assert.equal(manifest.tracks[track].checkedAt, undefined);
  assert.equal(manifest.tracks[track].previousConfirmation.checkedAt, 456);
  assert.equal(manifest.tracks[track].fullCanonicalCapture.complete, false);
  assert.equal(manifest.tracks[track].fullCanonicalCapture.retainedRows, 1);
  const board = await f.read(`tracks/${track}.json`), stats = await f.read('track-statistics.json');
  assert.equal(stats.complete, false); assert.equal(stats.tracks[track].capturedAt, null);
  assert.equal(snapshotConfirmationTime('track', board, {manifest, statistics: stats.tracks[track]}), null);
});

test('unavailable registry entries remain explicit gaps instead of being silently dropped', async t => {
  const f = await fixture(t);
  await f.put('manifest.json', {schemaVersion: 1, trackIdsKnown: 1, tracks: {
    [secondTrack]: {path: `tracks/${secondTrack}.json`, checkedAt: 456, updatedAt: 123, note: 'retained'}
  }});
  const report = await f.run([source(1)]), manifest = await f.read('manifest.json');
  assert.deepEqual(report.missingBoards, [secondTrack]); assert.equal(report.scanInconsistency, true);
  assert.equal(manifest.trackIdsKnown, 2); assert.equal(manifest.trackBackupsMissing, 1);
  assert.equal(manifest.tracks[secondTrack].path, null); assert.equal(manifest.tracks[secondTrack].note, 'retained');
  assert.equal(manifest.tracks[secondTrack].checkedAt, undefined);
  assert.equal((await f.read('track-statistics.json')).tracks[secondTrack].count, null);
  const inputs = await loadCapturedNativeJobs({directory: f.root});
  assert.equal(inputs.coverage.unavailableBoards, 1); assert.equal(inputs.coverage.complete, false);
  assert.equal(manifest.tracks[secondTrack].retainedBoardMissing, true);
  const repeated = await f.run([source(1)]);
  assert.deepEqual(repeated.missingBoards, [secondTrack]); assert.equal(repeated.scanInconsistency, true);
});

test('nullable manifest entry is unprovisioned, not missing retained standings', async t => {
  const f = await fixture(t), unprovisioned = {path: null, missing: true, checkedAt: 456, note: 'catalog only'};
  await f.put('manifest.json', {schemaVersion: 1, trackIdsKnown: 1, tracks: {[secondTrack]: unprovisioned}});
  const report = await f.run([source(1)]), manifest = await f.read('manifest.json');
  assert.equal(report.complete, true); assert.equal(report.imported, true); assert.equal(report.scanInconsistency, false);
  assert.deepEqual(report.missingBoards, []); assert.deepEqual(report.missingPrior, []);
  assert.deepEqual(report.unprovisionedTracks, [secondTrack]);
  assert.deepEqual(manifest.tracks[secondTrack], unprovisioned);
  assert.equal(manifest.trackIdsKnown, 2); assert.equal(manifest.trackBackupsPresent, 1); assert.equal(manifest.trackBackupsMissing, 1);
  assert.equal(manifest.fullCanonicalCapture.scanInconsistency, false);
  const stats = await f.read('track-statistics.json');
  assert.equal(stats.complete, false); assert.equal(stats.tracks[secondTrack].complete, false);
  assert.equal(stats.tracks[secondTrack].count, null);
  const repeated = await f.run([source(1)]);
  assert.equal(repeated.scanInconsistency, false); assert.deepEqual(repeated.unprovisionedTracks, [secondTrack]);
});

test('111 unprovisioned null-path tracks do not block a complete canonical import', async t => {
  const f = await fixture(t);
  const catalog = Object.fromEntries(Array.from({length: 111}, (_, i) => [id(20000 + i),
    {path: null, missing: true, checkedAt: 456, note: 'never provisioned'}]));
  await f.put('manifest.json', {schemaVersion: 1, trackIdsKnown: 112, tracks: {
    [track]: {path: null}, ...catalog
  }});
  const result = await f.run([source(1)]), manifest = await f.read('manifest.json');
  assert.equal(result.complete && result.imported && !result.scanInconsistency, true);
  assert.equal(result.unprovisionedTracks.length, 111);
  assert.deepEqual(result.unprovisionedTracks, Object.keys(catalog).sort());
  assert.deepEqual(result.missingBoards, []); assert.equal(result.missingPriorCount, 0);
  assert.equal(manifest.trackIdsKnown, 112); assert.equal(manifest.trackBackupsPresent, 1);
  assert.equal(manifest.trackBackupsMissing, 111);
  for (const [trackId, original] of Object.entries(catalog)) assert.deepEqual(manifest.tracks[trackId], original);
  const stats = await f.read('track-statistics.json');
  assert.equal(stats.complete, false); assert.equal(stats.tracksPresent, 1);
  assert.equal(Object.values(stats.tracks).filter(row => row.count === null).length, 111);
  assert.equal((await loadCapturedNativeJobs({directory: f.root})).jobs.length, 1);
});

test('nullable catalog entry never masks missing prior records on a retained board', async t => {
  const f = await fixture(t); await baseline(f, [saved(source(1)), saved(source(2))]);
  await f.put('manifest.json', {schemaVersion: 1, trackIdsKnown: 2, tracks: {
    [track]: {path: `tracks/${track}.json`, checkedAt: 456}, [secondTrack]: {path: null}
  }});
  const report = await f.run([source(1)]);
  assert.equal(report.complete, true); assert.equal(report.imported, true); assert.equal(report.scanInconsistency, true);
  assert.deepEqual(report.missingPrior, [`${id(2)}_${track}`]); assert.deepEqual(report.missingBoards, []);
  assert.deepEqual(report.unprovisionedTracks, [secondTrack]);
  const board = await f.read(`tracks/${track}.json`), manifest = await f.read('manifest.json');
  assert.equal(board.entries.length, 2); assert.equal(board.sourceComplete, false);
  assert.equal(manifest.tracks[track].checkedAt, undefined);
  assert.equal((await f.run([source(1)])).scanInconsistency, true);
});

test('unregistered catalog count alone does not claim lost prior standings', async t => {
  const f = await fixture(t);
  await f.put('manifest.json', {schemaVersion: 1, trackIdsKnown: 408, tracks: {[secondTrack]: {path: null}}});
  const report = await f.run([source(1)]), manifest = await f.read('manifest.json');
  assert.equal(report.scanInconsistency, false); assert.equal(report.unregisteredTrackCount, 406);
  assert.equal(manifest.trackIdsKnown, 408); assert.equal(manifest.trackBackupsMissing, 407);
  assert.equal((await f.read('track-statistics.json')).complete, false);
});

test('failure after manifest replacement rolls back manifest, statistics and every imported file', async t => {
  const f = await fixture(t); await baseline(f, [saved(source(1))]);
  await f.put('manifest.json', {schemaVersion: 1, tracks: {[track]: {path: `tracks/${track}.json`, checkedAt: 456}}, trackIdsKnown: 1});
  await f.put('track-statistics.json', {keepExactBytes: true});
  const before = await tree(f.root), rename = fs.rename; let replacedManifest = false;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === path.join(f.root, 'full-canonical-capture.json')) { assert.equal(replacedManifest, true); throw Error('synthetic audit commit failure'); }
    const result = await rename(from, to);
    if (to === path.join(f.root, 'manifest.json')) replacedManifest = true;
    return result;
  });
  await assert.rejects(f.run([source(1), source(2, {trackId: secondTrack})], {checkpointDirectory: f.checkpoint}));
  assert.deepEqual(await tree(f.root), before);
});

test('unsafe or malformed manifest paths reject before any query or staging writes', async t => {
  for (const record of [{path: '../outside.json'}, {path: `tracks/${secondTrack}.json`}, []]) {
    const f = await fixture(t); await f.put('manifest.json', {tracks: {[track]: record}});
    const before = await tree(f.root); let calls = 0;
    await assert.rejects(f.run([], {db: {call() {calls++; assert.fail('must not query');}}}), /invalid_manifest_track/);
    assert.equal(calls, 0); assert.deepEqual(await tree(f.root), before);
  }
});

test('faster PB receives only its own replay, pending flags and exact source dates; ranking uses shared helper', async t => {
  const f = await fixture(t), old = saved(source(1), {verified: true, runVerified: true, verifiedState: 1,
    verificationStatus: 'verified', nativeLedgerKey: 'old-proof', verifiedAt: 123});
  const other = saved(source(2, {timeMs: 1500}));
  await baseline(f, [old, other]);
  await f.put(`canonical/${track}/${id(1)}.json`, old);
  const bytes = Buffer.alloc(18); bytes.writeUIntLE(1, 0, 3); bytes.writeUIntLE(500, 3, 3);
  const newReplay = deflateSync(bytes).toString('base64url');
  const fresh = source(1, {uploadId: 3, timeMs: 1500, replay: newReplay, replayHash: sha(newReplay), verified: true, verifiedState: 1});
  const result = await f.run([fresh, source(2, {timeMs: 1500})]);
  assert.equal(result.changed, 1);
  const board = await f.read(`tracks/${track}.json`), row = board.entries.find(row => row.accountId === id(1));
  assert.equal(row.verified, false); assert.equal(row.runVerified, false); assert.equal(row.verifiedState, 0);
  assert.equal(row.originalTimeMs, 2000); assert.equal(row.nativeLedgerKey, undefined); assert.equal(row.verifiedAt, undefined);
  assert.equal(row.pbAt, ingested); assert.equal((await f.read('recordings/3.json')).recording, newReplay);
  assert.deepEqual(board.entries, rankTrustedTrackEntries(board.entries, track));
  assert.deepEqual(board.entries.map(row => row.accountId), [id(1), id(2)]);
});

test('same binding reuses public compact recording and local proof byte for byte, ignoring source positive flags', async t => {
  const f = await fixture(t), row = saved(source(1));
  await baseline(f, [row]); await f.put(`canonical/${track}/${id(1)}.json`, row);
  const compact = {recording: replay, accountId: id(1), trackId: track, frames: 1000, replayHash: sha(replay),
    verifiedState: 0, carStyle: '', updatedAt: 0, playbackPending: true, verificationStatus: 'pending', eventRpEligible: false};
  await f.put('recordings/1.json', compact);
  const before = await tree(f.root);
  const result = await f.run([source(1, {verified: true, verifiedState: 1, verificationStatus: 'verified'})]);
  assert.equal(result.reused, 1); assert.equal(result.changed, 0);
  const after = await tree(f.root);
  for (const relative of [`canonical/${track}/${id(1)}.json`, 'recordings/1.json']) assert.equal(after[relative], before[relative]);
  assert.equal((await f.read(`tracks/${track}.json`)).entries[0].verified, false);
});

test('generation-75 nullable country metadata passes prior inventory and exact-binding reuse', async t => {
  const f = await fixture(t), current = source(1, {countryCode: null}), row = saved(current);
  await baseline(f, [row]); await f.put(`canonical/${track}/${id(1)}.json`, row);
  await f.put('recordings/1.json', {...row, recording: replay});
  const before = await tree(f.root), result = await f.run([current]);
  assert.equal(result.complete, true); assert.equal(result.reused, 1); assert.equal(result.scanInconsistency, false);
  assert.equal((await f.read(`tracks/${track}.json`)).entries[0].countryCode, null);
  const after = await tree(f.root);
  for (const relative of [`canonical/${track}/${id(1)}.json`, 'recordings/1.json']) assert.equal(after[relative], before[relative]);
});

test('new source with explicit Firestore null country remains public pending metadata', async t => {
  const f = await fixture(t), result = await f.run([source(1, {countryCode: null})]);
  assert.equal(result.complete, true);
  for (const row of [(await f.read(`tracks/${track}.json`)).entries[0],
    await f.read(`canonical/${track}/${id(1)}.json`), await f.read('recordings/1.json')]) {
    assert.equal(row.countryCode, null); assert.equal(row.verified, false);
  }
});

test('nullable country support does not allow malformed Firestore null encoding', async t => {
  const f = await fixture(t), response = page([source(1, {countryCode: null})]);
  response[0].document.fields.countryCode = {nullValue: 'private-not-null'};
  await assert.rejects(f.run([], {db: {call: async () => response}}), /invalid_null/);
  assert.deepEqual(await tree(f.root), {});
});

test('local verified proof survives unchanged binding even when source is pending', async t => {
  const f = await fixture(t), row = saved(source(1), {verified: true, runVerified: true, verifiedState: 1,
    verificationStatus: 'verified', nativeLedgerManifestHash: id(60), verifiedAt: 99});
  const key = ledgerKey(ledgerBinding(row, 'normal'));
  row.nativeLedgerKey = key;
  row.nativeLedgerSource = {bindingKey: key, status: {verified: false, verifiedState: 0, runVerified: false}};
  row.nativeLedgerBoardSource = {bindingKey: key, status: {verified: true, verifiedState: 1, runVerified: true}};
  row.nativeLedger = {authority: 'native-verification-ledger', manifestHash: id(60), bindingKey: key, disposition: 'verified'};
  await baseline(f, [row]); await f.put(`canonical/${track}/${id(1)}.json`, row);
  await f.put('recordings/1.json', {...row, recording: replay});
  assert.equal((await f.run([source(1)])).reused, 1);
  const result = await f.read(`canonical/${track}/${id(1)}.json`);
  assert.equal(result.runVerified, true); assert.equal(result.nativeLedgerKey, key);
  for (const file of [`canonical/${track}/${id(1)}.json`, 'recordings/1.json']) {
    const value = await f.read(file);
    for (const field of ['nativeLedger', 'nativeLedgerSource', 'nativeLedgerBoardSource']) assert.deepEqual(value[field], row[field]);
  }
  const jobs = await loadCapturedNativeJobs({directory: f.root});
  assert.equal(jobs.jobs.length, 1);
  const ledgerRows = await readCapturedNormalLedgerRows({directory: f.root});
  assert.equal(ledgerRows.length, 1);
  assert.equal(ledgerRows[0].sourceCanonicalStatus.verified, false);
  assert.equal(ledgerRows[0].sourceBoardStatus.verified, true);
});

test('unchanged native pristine companions preserve current holds and exclude private companion fields', async t => {
  const f = await fixture(t), row = saved(source(1)), key = ledgerKey(ledgerBinding(row, 'normal'));
  Object.assign(row, {nativeLedgerKey: key, reviewHold: true,
    nativeLedgerSource: {bindingKey: key, private: 'PRIVATE_SENTINEL', status: {verified: true, runVerified: true,
      verifiedState: 1, reason: 'PRIVATE_SENTINEL'}},
    nativeLedgerBoardSource: {bindingKey: key, status: {verified: false, runVerified: false, verifiedState: 0}}});
  await baseline(f, [row]); await f.put(`canonical/${track}/${id(1)}.json`, row);
  await f.put('recordings/1.json', {...row, recording: replay});
  assert.equal((await f.run([source(1)])).reused, 1);
  const rows = await readCapturedNormalLedgerRows({directory: f.root});
  assert.equal(rows[0].reviewHold, true); assert.equal(rows[0].verificationStatus, 'held');
  assert.equal(rows[0].sourceCanonicalStatus.verified, true); assert.equal(rows[0].sourceBoardStatus.verified, false);
  assert.equal(JSON.stringify(await tree(f.root)).includes('PRIVATE_SENTINEL'), false);
});

for (const field of ['nativeLedgerKey', 'nativeLedgerSource', 'nativeLedgerBoardSource', 'nativeLedger']) {
  test(`mismatched saved ${field} fails before stage mutation`, async t => {
    const f = await fixture(t), row = saved(source(1)), key = ledgerKey(ledgerBinding(row, 'normal'));
    row.nativeLedgerKey = key;
    row.nativeLedgerSource = {bindingKey: key, status: {verified: false}};
    row[field] = field === 'nativeLedgerKey' ? id(77) : field === 'nativeLedger'
      ? {authority: 'native-verification-ledger', bindingKey: id(77), manifestHash: id(60), disposition: 'verified'}
      : {bindingKey: id(77), status: {verified: true}};
    await baseline(f, [row]); await f.put(`canonical/${track}/${id(1)}.json`, row);
    await f.put('recordings/1.json', {...row, recording: replay});
    const before = await tree(f.root);
    await assert.rejects(f.run([source(1)]), /saved_ledger/);
    assert.deepEqual(await tree(f.root), before);
  });
}

test('faster binding never inherits pristine or active ledger companions', async t => {
  const f = await fixture(t), row = saved(source(1)), key = ledgerKey(ledgerBinding(row, 'normal'));
  Object.assign(row, {nativeLedgerKey: key,
    nativeLedgerSource: {bindingKey: key, status: {verified: true}},
    nativeLedgerBoardSource: {bindingKey: key, status: {verified: true}},
    nativeLedger: {authority: 'native-verification-ledger', bindingKey: key, manifestHash: id(60), disposition: 'verified'}});
  await baseline(f, [row]); await f.put(`canonical/${track}/${id(1)}.json`, row);
  await f.run([source(1, {timeMs: 1000, uploadId: 2})]);
  for (const file of [`canonical/${track}/${id(1)}.json`, 'recordings/2.json']) {
    const value = await f.read(file);
    for (const field of ['nativeLedgerKey', 'nativeLedgerSource', 'nativeLedgerBoardSource', 'nativeLedger']) assert.equal(value[field], undefined);
  }
  const rows = await readCapturedNormalLedgerRows({directory: f.root});
  assert.equal(rows[0].verified, false);
});

test('streams oversized overall metadata from actual bytes, not stale manifest, without reading or copying rows', async t => {
  const f = await fixture(t);
  await f.put('manifest.json', {schemaVersion: 1, tracks: {}, overall: {revision: 1, updatedAt: 2}});
  // Cross chunk boundaries, escaped keys/strings, misleading nested metadata,
  // and duplicate top-level keys must match JSON.parse's last-key semantics.
  const text = '{"revision":3,"entries":[{"text":"' + 'x'.repeat(6762966) +
    '\\"\\u0061","revision":999}],"rev\\u0069sion":11,"sourceRevision":10,"updatedAt":321}';
  await fs.writeFile(path.join(f.root, 'overall.json'), text);
  const originalRead = fs.readFile;
  t.mock.method(fs, 'readFile', async (file, ...args) => {
    assert.notEqual(path.basename(String(file)), 'overall.json', 'overall must be streamed');
    return originalRead(file, ...args);
  });
  const result = await f.run([source(1)], {checkpointDirectory: f.checkpoint});
  assert.equal(result.complete, true); assert.equal(result.imported, true);
  assert.ok(result.peakAccountedBytes < 20 * 1024 * 1024);
  const statistics = await f.read('track-statistics.json');
  assert.equal(statistics.revision, 11); assert.equal(statistics.updatedAt, 321);
  assert.equal(await originalRead(path.join(f.root, 'overall.json'), 'utf8'), text);
  for (const bytes of Object.values(await tree(f.checkpoint)).filter(value => typeof value === 'string')) {
    assert.ok(Buffer.byteLength(bytes) <= FULL_CANONICAL_LIMITS.fileBytes);
  }
});

for (const text of ['{"entries":[1,]}', '{"entries":[{"x":"\\q"}]}', '{"revision":5} {}',
  '{"revision":5,"entries":[', '{"entries":[],}', '{"revision":5,"x":01}']) {
  test(`streamed overall rejects malformed JSON ${text}`, async t => {
    const f = await fixture(t); await fs.writeFile(path.join(f.root, 'overall.json'), text);
    const before = await tree(f.root);
    await assert.rejects(f.run([source(1)]), /invalid_stage_json/);
    assert.deepEqual(await tree(f.root), before);
  });
}

test('streamed overall uses sourceRevision fallback and ignores noninteger metadata', async t => {
  const f = await fixture(t);
  await f.put('overall.json', {revision: '12', sourceRevision: 7, updatedAt: {bad: 1}, entries: []});
  await f.run([source(1)]);
  const stats = await f.read('track-statistics.json');
  assert.equal(stats.revision, 7); assert.equal(stats.updatedAt, null);
});

test('read-only overall has a fixed 16 MiB cap with zero staging mutation', async t => {
  const f = await fixture(t), file = path.join(f.root, 'overall.json');
  const handle = await fs.open(file, 'w'); await handle.truncate(16 * 1024 * 1024 + 1); await handle.close();
  const result = await f.run([source(1)]);
  assert.equal(result.reason, 'overall_input_cap'); assert.equal(result.imported, false);
  assert.deepEqual(await fs.readdir(f.root), ['overall.json']);
  assert.equal((await fs.stat(file)).size, 16 * 1024 * 1024 + 1);
});

test('streamed overall dependency change is detected before any stage rename', async t => {
  const f = await fixture(t); await f.put('overall.json', {revision: 1});
  const originalOpen = fs.open; let reads = 0;
  t.mock.method(fs, 'open', async (file, ...args) => {
    if (path.basename(String(file)) === 'overall.json' && ++reads === 2) await f.put('overall.json', {revision: 2});
    return originalOpen(file, ...args);
  });
  await assert.rejects(f.run([source(1)]), /stage_changed/);
  assert.equal(reads, 2); assert.deepEqual(await fs.readdir(f.root), ['overall.json']);
});

test('explicit prior holds survive a faster replacement and cannot be cleared by source flags', async t => {
  const f = await fixture(t), row = saved(source(1), {reviewHold: true, needsReview: true, verificationStatus: 'held'});
  await baseline(f, [row]); await f.put(`canonical/${track}/${id(1)}.json`, row);
  await f.run([source(1, {uploadId: 2, timeMs: 1000, verified: true, verifiedState: 1, reviewHold: false})]);
  for (const value of [(await f.read(`tracks/${track}.json`)).entries[0],
    await f.read(`canonical/${track}/${id(1)}.json`), await f.read('recordings/2.json')]) {
    assert.equal(value.reviewHold, true); assert.equal(value.verificationStatus, 'held'); assert.equal(value.runVerified, false);
  }
});

test('explicit reason-only local review hold is retained without publishing its private reason', async t => {
  const f = await fixture(t), row = saved(source(1), {reason: 'review PRIVATE_SENTINEL'});
  await baseline(f, [row]);
  await f.run([source(1, {uploadId: 2, timeMs: 1000})]);
  const board = await f.read(`tracks/${track}.json`);
  assert.equal(board.entries[0].reviewHold, true); assert.equal(board.entries[0].runVerified, false);
  assert.equal(JSON.stringify(await tree(f.root)).includes('PRIVATE_SENTINEL'), false);
});

test('absent prior rows remain present and explicitly report scan inconsistency', async t => {
  const f = await fixture(t), old = saved(source(1)); await baseline(f, [old]);
  const report = await f.run([source(2, {trackId: secondTrack})]);
  assert.equal(report.complete, true); assert.equal(report.scanInconsistency, true);
  assert.deepEqual(report.missingPrior, [`${id(1)}_${track}`]);
  const board = await f.read(`tracks/${track}.json`);
  assert.equal(board.entries[0].accountId, id(1)); assert.equal(board.sourceComplete, false); assert.equal(board.ranksExact, false);
});

test('pagination freezes first readTime, uses strict projection and exclusive name cursor, and needs terminal short page', async t => {
  const f = await fixture(t), rows = Array.from({length: 4}, (_, i) => source(i + 1)), db = transport(rows);
  const result = await f.run([], {db, pageSize: 2, documentLimit: 6});
  assert.equal(result.complete, true); assert.equal(db.calls.length, 3); assert.equal(result.reservedDocumentReads, 6);
  assert.equal(db.calls[0].readTime, undefined);
  for (const [i, body] of db.calls.entries()) {
    assert.deepEqual(body.structuredQuery.select.fields.map(field => field.fieldPath), [...FULL_CANONICAL_FIELDS, '__name__']);
    assert.deepEqual(body.structuredQuery.orderBy, [{field: {fieldPath: '__name__'}, direction: 'ASCENDING'}]);
    assert.equal(body.structuredQuery.offset, undefined);
    assert.equal(body.structuredQuery.limit, 2);
    if (i) { assert.equal(body.readTime, point); assert.equal(body.structuredQuery.startAt.before, false);
      assert.equal(body.structuredQuery.startAt.values[0].referenceValue, prefix + `${id(i * 2)}_${track}`); }
  }
});

test('explicit pinned readTime is used on first query too', async t => {
  const f = await fixture(t), db = transport([]);
  const result = await f.run([], {db, readTime: point});
  assert.equal(result.complete, true); assert.equal(db.calls[0].readTime, point);
});

test('full page at cap is deferred without a single staging mutation or false watermark', async t => {
  const f = await fixture(t); await f.put('sentinel.json', {keep: true}); const before = await tree(f.root);
  const db = transport([source(1), source(2)]);
  const result = await f.run([], {db, pageSize: 2, documentLimit: 2, checkpointDirectory: f.checkpoint});
  assert.equal(db.calls.length, 1); assert.equal(result.capDeferred, true); assert.equal(result.complete, false);
  assert.equal(result.watermark, null); assert.equal(result.fullScanReadPoint, null);
  assert.deepEqual(await tree(f.root), before);
});

test('quota and later page failure stop without retries and leave the complete stage unchanged', async t => {
  for (const failAt of [1, 2]) {
    const f = await fixture(t); await f.put('sentinel.json', {keep: true}); const before = await tree(f.root);
    let calls = 0;
    const db = {async call() { if (++calls === failAt) throw Object.assign(Error('PRIVATE_TRANSPORT'), {status: 429}); return page([source(1)]); }};
    await assert.rejects(f.run([], {db, pageSize: 1}), error => {
      assert.equal(error.report.complete, false); assert.equal(error.report.imported, false);
      assert.equal(error.message.includes('PRIVATE_TRANSPORT'), false); return true;
    });
    assert.equal(calls, failAt); assert.deepEqual(await tree(f.root), before);
  }
});

test('existing retry-capable transport is fenced before a second HTTP attempt', async t => {
  const f = await fixture(t); let attempts = 0;
  const db = createFirestoreCaller({base: 'https://fixture.invalid', access: 'synthetic', sleep: async () => {},
    fetchImpl: async () => { attempts++; return new Response('{}', {status: 429}); }});
  await assert.rejects(f.run([], {db}), /query_failed/); assert.equal(attempts, 1);
  assert.deepEqual(await tree(f.root), {});
});

const invalidRows = [
  ['wrong account', row => {row.accountId = '../bad';}],
  ['invalid track', row => {row.trackId = 'bad';}],
  ['bad upload', row => {row.uploadId = 0;}],
  ['bad frame alias', row => {row.raceTimeFrames++;}],
  ['bad time', row => {row.timeMs = -1;}],
  ['hash mismatch', row => {row.replayHash = id(555);}],
  ['invalid structure with matching hash', row => {row.replay = deflateSync(Buffer.alloc(16)).toString('base64url'); row.replayHash = sha(row.replay);}],
  ['corrupt state', row => {row.verifiedState = 1;}],
  ['missing state', row => {delete row.verifiedState;}],
  ['rejected status', row => {row.verificationStatus = 'rejected';}],
  ['unknown status', row => {row.validationState = 'not-a-state';}],
  ['invalid date', row => {row.pbAt = '2026-02-30T00:00:00Z';}],
  ['invalid ingestion', row => {row.ingestedAt = 'tomorrow';}],
  ['future nanosecond ingestion', row => {row.ingestedAt = '2026-11-07T08:00:00.123456790Z';}],
  ['invalid car style', row => {row.carStyle = 12;}],
  ['null car style', row => {row.carStyle = null;}],
  ['null name', row => {row.name = null;}],
  ['null nickname', row => {row.nickname = null;}],
  ['numeric country', row => {row.countryCode = 12;}],
  ['null account', row => {row.accountId = null;}],
  ['null verification state', row => {row.verifiedState = null;}],
  ['invalid hold', row => {row.reviewHold = 'yes';}],
];
for (const [label, mutate] of invalidRows) test(`${label} prevents all staging writes including earlier valid rows`, async t => {
  const f = await fixture(t), bad = source(2); mutate(bad);
  const before = await tree(f.root);
  await assert.rejects(f.run([source(1), bad])); assert.deepEqual(await tree(f.root), before);
});

for (const [label, mutate] of [
  ['unstable point', rows => {rows[1].readTime = '2026-11-07T08:00:01Z';}],
  ['missing point', rows => {for (const row of rows) delete row.readTime;}],
  ['partial error', rows => {rows.push({error: {message: 'private'}});}],
  ['partial flag', rows => {rows[1].done = false;}],
  ['skipped results', rows => {rows[1].skippedResults = 1;}],
  ['unordered', rows => rows.reverse()],
  ['duplicate', rows => {rows[1] = rows[0];}],
  ['document identity mismatch', rows => {rows[1].document.name = prefix + `${id(3)}_${track}`;}],
  ['wrong collection', rows => {rows[1].document.name = rows[1].document.name.replace('race_results', 'private');}],
]) test(`${label} page is rejected with zero mutation`, async t => {
  const f = await fixture(t), response = page([source(1), source(2)]); mutate(response);
  await assert.rejects(f.run([], {db: {call: async () => response}})); assert.deepEqual(await tree(f.root), {});
});

test('private fields never enter public output, even if transport ignores projection', async t => {
  const f = await fixture(t), row = source(1, {ipAddress: 'PRIVATE_SENTINEL', accessToken: 'PRIVATE_SENTINEL',
    proof: 'PRIVATE_SENTINEL', sourceDocument: 'PRIVATE_SENTINEL'});
  await f.run([row], {checkpointDirectory: f.checkpoint});
  assert.equal(JSON.stringify(await tree(f.root)).includes('PRIVATE_SENTINEL'), false);
  assert.equal(JSON.stringify(await tree(f.checkpoint)).includes('PRIVATE_SENTINEL'), true);
});

test('ingestedAt audit distinguishes missing fields and unproven string timestamps without losing precision', async t => {
  const f = await fixture(t), first = source(1); delete first.ingestedAt;
  const response = page([first, source(2)]);
  response[1].document.fields.ingestedAt = {stringValue: ingested};
  const result = await f.run([], {db: {call: async () => response}});
  assert.deepEqual(result.ingestedAt, {present: 1, missing: 1, serverTimestamp: 0, allPopulated: false, allServerTimestamps: false});
  assert.equal(result.incrementalEligible, false);
  assert.equal((await f.read(`canonical/${track}/${id(2)}.json`)).ingestedAt, ingested);
  assert.equal((await f.read(`canonical/${track}/${id(2)}.json`)).ingestedAtSource, undefined);
});

test('non-faster replacement and upload collisions fail closed', async t => {
  for (const extra of [{uploadId: 3, timeMs: 2000}, {uploadId: 2, timeMs: 1000}]) {
    const f = await fixture(t); await baseline(f, [saved(source(1)), saved(source(2))]);
    const before = await tree(f.root);
    await assert.rejects(f.run([source(1, extra)])); assert.deepEqual(await tree(f.root), before);
  }
});

test('rename failure rolls back existing and newly created files and directories', async t => {
  const f = await fixture(t); await baseline(f, [saved(source(1))]);
  const before = await tree(f.root), rename = fs.rename; let count = 0;
  t.mock.method(fs, 'rename', async (...args) => { if (++count === 3) throw Error('synthetic write failure'); return rename(...args); });
  await assert.rejects(f.run([source(1, {uploadId: 3, timeMs: 1000}), source(2, {trackId: secondTrack})],
    {checkpointDirectory: f.checkpoint}));
  assert.deepEqual(await tree(f.root), before);
});

test('rollback restores overwritten canonical and recording bytes, not just newly created files', async t => {
  const f = await fixture(t), old = saved(source(1)); await baseline(f, [old]);
  await f.put(`canonical/${track}/${id(1)}.json`, old);
  const fresh = source(1, {uploadId: 3, timeMs: 1000});
  await f.put('recordings/3.json', {...saved(fresh), verified: true, runVerified: true, verifiedState: 1, recording: replay});
  const before = await tree(f.root), rename = fs.rename; let count = 0;
  t.mock.method(fs, 'rename', async (...args) => { if (++count === 4) throw Error('synthetic write failure'); return rename(...args); });
  await assert.rejects(f.run([fresh, source(2, {trackId: secondTrack})], {checkpointDirectory: f.checkpoint}));
  assert.deepEqual(await tree(f.root), before);
});

test('corrupted saved replay cannot qualify for reuse', async t => {
  const f = await fixture(t), row = saved(source(1)); await baseline(f, [row]);
  await f.put(`canonical/${track}/${id(1)}.json`, row);
  await f.put('recordings/1.json', {...row, recording: 'corrupted'});
  const before = await tree(f.root);
  await assert.rejects(f.run([source(1)]), /recording_collision/);
  assert.deepEqual(await tree(f.root), before);
});

test('a changed read point on a later page cannot import any earlier page', async t => {
  const f = await fixture(t); let calls = 0;
  const db = {call: async () => ++calls === 1 ? page([source(1)]) : page([source(2)], '2026-11-07T08:00:01Z')};
  await assert.rejects(f.run([], {db, pageSize: 1}), /unstable_read_point/);
  assert.equal(calls, 2); assert.deepEqual(await tree(f.root), {});
});

test('an 8000-row prior inventory fits the fixed accounting cap without retaining parsed boards', async t => {
  const f = await fixture(t), rows = Array.from({length: 8000}, (_, i) => saved(source(i + 1,
    {trackId: id(10000 + Math.floor(i / 400))})));
  await baseline(f, rows); let calls = 0;
  await assert.rejects(f.run([], {db: {call: async () => {calls++; throw Error('offline stop after inventory');}}}), error => {
    assert.equal(error.report.reason, 'query_failed'); assert.equal(error.report.priorRows, 8000);
    assert.ok(error.report.peakAccountedBytes <= 64 * 1024 * 1024); return true;
  });
  assert.equal(calls, 1); assert.equal((await fs.readdir(f.root)).length, 1);
});

test('reranking cannot emit a board above the fixed 2 MiB cap', async t => {
  const f = await fixture(t), cosmetics = Object.fromEntries(['theme', 'accent', 'finish', 'plate', 'edge', 'stageTint',
    'stage', 'stageEffect', 'stripe', 'emblem', 'emblem2', 'emblem3', 'emblemBackdrop', 'nameFont', 'nameSize',
    'nameWeight', 'nameColor', 'baseSecondary', 'title', 'badge', 'favoriteTrackId', 'overridePodium'].map(key => [key, 'x'.repeat(256)]));
  const entries = [];
  for (let i = 1; ; i++) {
    const row = saved(source(i), {profileCosmetics: cosmetics});
    const next = {trackId: track, updatedAt: 123, entries: [...entries, row]};
    if (Buffer.byteLength(JSON.stringify(next) + '\n') > FULL_CANONICAL_LIMITS.fileBytes) break;
    entries.push(row);
  }
  await f.put(`tracks/${track}.json`, {trackId: track, updatedAt: 123, entries});
  const before = await tree(f.root), report = await f.run([]);
  assert.equal(report.capDeferred, true); assert.equal(report.reason, 'output_cap');
  assert.equal(report.complete, false); assert.deepEqual(await tree(f.root), before);
});

test('temporary write failure leaves the stage byte-identical and cleans created directories', async t => {
  const f = await fixture(t), before = await tree(f.root), write = fs.writeFile;
  t.mock.method(fs, 'writeFile', async (file, ...args) => {
    if (String(file).startsWith(f.root) && String(file).endsWith('.tmp')) throw Error('synthetic disk full');
    return write(file, ...args);
  });
  await assert.rejects(f.run([source(1)])); assert.deepEqual(await tree(f.root), before);
});

test('changed stage is detected before commit without overwriting the external change', async t => {
  const f = await fixture(t); await baseline(f, [saved(source(1))]);
  const db = {async call() { await f.put(`tracks/${track}.json`, {externallyChanged: true}); return page([source(1)]); }};
  await assert.rejects(f.run([], {db}), /stage_changed/);
  assert.deepEqual(await f.read(`tracks/${track}.json`), {externallyChanged: true});
  assert.deepEqual(Object.keys(await tree(f.root)).sort(), ['tracks/', `tracks/${track}.json`]);
});

test('caps cannot be raised and oversized stage files defer before querying', async t => {
  const f = await fixture(t); let calls = 0; const db = {call() {calls++; assert.fail('must not query');}};
  for (const options of [{documentLimit: 10001}, {pageSize: 101}, {documentLimit: 0}]) {
    await assert.rejects(f.run([], {db, ...options}), /invalid_limits/);
  }
  await fs.mkdir(path.join(f.root, 'tracks'));
  await fs.writeFile(path.join(f.root, 'tracks', `${track}.json`), ' '.repeat(FULL_CANONICAL_LIMITS.fileBytes + 1));
  const report = await f.run([], {db}); assert.equal(report.capDeferred, true); assert.equal(report.reason, 'file_cap');
  assert.equal(calls, 0);
});

test('oversized response memory defers without stage mutation', async t => {
  const f = await fixture(t), response = page([source(1)]);
  response[0].document.fields.privateData = {stringValue: 'x'.repeat(33 * 1024 * 1024)};
  const result = await f.run([], {db: {call: async () => response}});
  assert.equal(result.reason, 'memory_cap'); assert.equal(result.capDeferred, true);
  assert.deepEqual(await tree(f.root), {});
});

test('checkpoint cannot be staging, a child, an ancestor, or a symlink; stage files cannot be symlinks', async t => {
  const f = await fixture(t); let calls = 0; const db = {call() {calls++; assert.fail('must not query');}};
  await fs.mkdir(path.join(f.root, 'private'));
  for (const checkpointDirectory of [f.root, path.join(f.root, 'private'), f.parent]) {
    await assert.rejects(f.run([], {db, checkpointDirectory}), /checkpoint_must_be_private_and_disjoint/);
  }
  assert.equal(calls, 0);
  await fs.rmdir(path.join(f.root, 'private'));
  const target = path.join(f.parent, 'outside'); await fs.mkdir(target);
  const link = path.join(f.root, 'tracks');
  try { await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Symlink privilege unavailable'); return; } throw error; }
  await assert.rejects(f.run([], {db}), /unsafe_path/);
  assert.deepEqual(await fs.readdir(target), []); assert.equal(calls, 0);
});
