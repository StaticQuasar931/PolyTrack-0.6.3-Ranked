import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import {createHash} from 'node:crypto';
import {rebuildSnapshotOverall} from './rebuild-snapshot-overall.mjs';
import {buildOfflineOverall} from './offline-overall.mjs';
import {computeOverall, rankTrustedTrackEntries} from '../workers/ranked/src/index.js';
import {decodeOverallProjectionBundle, decodeProjectionResults} from './overall-projection-bundle.mjs';

const ids = ['5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038',
  '7eac4fee1111152cfba4d3737410264ca0f22c7f5a2211e79f0099589b8b48c0',
  '148826aa16ffaa23dbc453b32cff05e025ddbce1773fc7733cc13d218926515a'];
const model = {algorithmVersion:'participation-v8-s1', schemaVersion:6,
  revision:10, sourceRevision:10, builtRevision:10, updatedAt:1000};
const backendCapture = {source:'authenticated-backend-fixture', publishedRevision:10,
  readTime:'2026-10-27T00:00:00Z', estimatedReads:5};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = async (directory, name) => JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
const write = (directory, name, value) => fs.writeFile(path.join(directory, name), JSON.stringify(value) + '\n');

function denyNetwork(t) {
  const calls = [];
  const deny = label => () => {calls.push(label); throw Error('Network forbidden in offline wrapper test: ' + label);};
  t.mock.method(globalThis, 'fetch', deny('fetch'));
  for (const [object, names] of [[http, ['request', 'get']], [https, ['request', 'get']],
    [net, ['connect', 'createConnection']], [tls, ['connect']]]) {
    for (const name of names) t.mock.method(object, name, deny(name));
  }
  t.after(() => assert.deepEqual(calls, [], 'the wrapper must not attempt any network access'));
}

async function fixture(t, {capture = backendCapture} = {}) {
  denyNetwork(t);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'polytrack-wrapper-test-'));
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('polytrack-wrapper-test-'));
  t.after(() => fs.rm(resolved, {recursive:true, force:true}));
  await fs.mkdir(path.join(directory, 'tracks'));
  const tracks = ids.map(trackId => ({...model, trackId, complete:true, sourceComplete:true,
    totalEntries:5, entries:rankTrustedTrackEntries(Array.from({length:5}, (_, i) => ({
      accountId:String(i + 1).repeat(64), trackId, timeMs:10000 + i * 1000,
      pbAt:100, pbCount:2, totalPlaytimeMs:500, accountCreatedAt:10,
      name:'Racer ' + i, runVerified:true, integrityVerified:true
    })), trackId)}));
  const entries = computeOverall(tracks);
  for (const row of entries) {row.rankSince = 900; row.movementAt = 0;}
  const previousOverall = {...model, entries, complete:true, totalEntries:entries.length,
    trackSummaries:[], trackCatalog:tracks.map(board => ({trackId:board.trackId, updatedAt:board.updatedAt}))};
  const baseline = await buildOfflineOverall({tracks, previousOverall, expectedTrackIds:ids, now:1000});
  for (const [name, value] of baseline.files) await write(directory, name, value);
  await write(directory, 'overall-calculation.json', baseline.calculation);
  for (const board of tracks) await write(directory, 'tracks/' + board.trackId + '.json', board);
  const manifest = {schemaVersion:1, tracks:Object.fromEntries(tracks.map(board => [board.trackId, {
    path:'tracks/' + board.trackId + '.json', updatedAt:board.updatedAt,
    sourceUpdatedAt:board.updatedAt, revision:board.revision, checkedAt:1500
  }])), events:{preserved:{path:'events/preserved.json'}}, eventReplays:{preserved:{available:true}},
    overall:{path:'overall.json'}, overallResults:{path:'overall-results.json', available:true},
    overallProjection:{path:'projection-source.json', available:true}};
  if (capture !== undefined) manifest.overallCapture = capture;
  await write(directory, 'manifest.json', manifest);
  await write(directory, 'untouched.json', {sentinel:'preserve unrelated snapshot content'});
  return {directory, tracks, manifest, baseline};
}

async function bytesIn(directory) {
  const result = {};
  async function visit(relative = '') {
    for (const item of (await fs.readdir(path.join(directory, relative), {withFileTypes:true})).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? relative + '/' + item.name : item.name;
      if (item.isDirectory()) await visit(name);
      else result[name] = (await fs.readFile(path.join(directory, name))).toString('base64');
    }
  }
  await visit();
  return result;
}

async function checkOutput(f, report) {
  const overall = await read(f.directory, 'overall.json');
  const results = await read(f.directory, 'overall-results.json');
  const projection = await read(f.directory, 'projection-source.json');
  const receipt = await read(f.directory, 'overall-calculation.json');
  const manifest = await read(f.directory, 'manifest.json');
  const decoded = await decodeProjectionResults(results);
  const boards = decodeOverallProjectionBundle(projection, {overall});
  const expected = computeOverall(f.tracks, f.baseline.files.get('overall.json').entries, new Set(), {includePlannerResults:true});
  assert.equal(overall.complete, true);
  assert.equal(overall.ranksExact, true);
  assert.equal(overall.catalogComplete, true);
  assert.equal(overall.entries.length, expected.length);
  assert.equal(decoded.entries.length, expected.length);
  for (let i = 0; i < expected.length; i++) {
    for (const key of ['userId', 'score', 'rank', 'raceCount', 'skillCost', 'coverageCost', 'consistencyCost', 'medals', 'provisional']) {
      assert.deepEqual(overall.entries[i][key], expected[i][key], 'authoritative ' + key);
    }
    const samples = JSON.parse(decoded.entries[i].resultData).map(tuple => [decoded.resultTracks[tuple[0]], ...tuple.slice(1)]);
    const wanted = expected[i].resultSamples.map(s => [s.trackId, s.rank, s.fieldSize, s.weight, s.competition, s.timeMs, s.pbAt]);
    assert.deepEqual(samples.sort((a, b) => a[0].localeCompare(b[0])), wanted.sort((a, b) => a[0].localeCompare(b[0])));
  }
  for (const companion of [results, projection]) for (const key of ['algorithmVersion', 'schemaVersion', 'sourceRevision', 'builtRevision', 'updatedAt']) {
    assert.equal(companion[key], overall[key], 'companion binding ' + key);
  }
  assert.equal(receipt.source, 'snapshot-computed-overall');
  assert.equal(receipt.sourceRevision, overall.sourceRevision);
  assert.equal(receipt.revision, overall.revision);
  assert.equal(receipt.updatedAt, overall.updatedAt);
  assert.match(receipt.inputDigest, /^[a-f0-9]{64}$/);
  assert.equal(report.publishedRevision, overall.revision);
  assert.equal(report.additionalFirestoreReads, 0);
  assert.equal(report.additionalFirestoreWrites, 0);
  assert.equal(report.networkRequests, 0);
  assert.equal(report.firestorePublished, false);
  assert.deepEqual(manifest.overallCapture, report);
  assert.equal(manifest.overall.path, 'overall.json');
  assert.equal(manifest.overall.revision, overall.revision);
  assert.equal(manifest.overall.updatedAt, overall.updatedAt);
  assert.equal(manifest.overall.checkedAt, report.updatedAt);
  assert.equal(manifest.overall.sha256, hash(await fs.readFile(path.join(f.directory, 'overall.json'))));
  assert.deepEqual(manifest.overallResults, {path:'overall-results.json', available:true});
  assert.equal(manifest.overallProjection.path, 'projection-source.json');
  assert.equal(manifest.overallProjection.available, true);
  assert.equal(manifest.overallProjection.sha256, hash(await fs.readFile(path.join(f.directory, 'projection-source.json'))));
  assert.deepEqual(manifest.trackSummaryMismatches, []);
  for (const key of ['tracks', 'events', 'eventReplays']) assert.deepEqual(manifest[key], f.manifest[key]);
  assert.deepEqual(await read(f.directory, 'untouched.json'), {sentinel:'preserve unrelated snapshot content'});
  for (const board of boards) {
    const selected = f.tracks.find(track => track.trackId === board.trackId);
    assert.equal(board.updatedAt, selected.updatedAt);
    assert.equal(board.sourceRevision, selected.sourceRevision);
  }
  return {overall, results, projection, receipt, manifest, boards};
}

test('offline wrapper writes coherent Overall/results/projection/receipt and zero-mismatch manifest', async t => {
  const f = await fixture(t);
  await checkOutput(f, await rebuildSnapshotOverall({directory:f.directory, now:() => 2000}));
});

test('newer standalone board replaces the older Overall baseline and changes authoritative scoring inputs', async t => {
  const f = await fixture(t), board = f.tracks[0];
  board.revision = board.sourceRevision = board.builtRevision = 11;
  board.updatedAt = 3000;
  board.entries = rankTrustedTrackEntries(board.entries.map((row, i) => ({...row, timeMs:i === 4 ? 9000 : row.timeMs})), board.trackId);
  const binding = f.manifest.tracks[board.trackId];
  Object.assign(binding, {revision:11, updatedAt:3000, sourceUpdatedAt:3000});
  await write(f.directory, 'tracks/' + board.trackId + '.json', board);
  await write(f.directory, 'manifest.json', f.manifest);
  const output = await checkOutput(f, await rebuildSnapshotOverall({directory:f.directory, now:() => 4000}));
  assert.notEqual(output.receipt.inputDigest, f.baseline.calculation.inputDigest);
  assert.ok(output.receipt.revision > f.baseline.calculation.revision);
  const selected = output.boards.find(track => track.trackId === board.trackId);
  assert.equal(selected.entries.find(row => row.accountId === '5'.repeat(64)).timeMs, 9000);
  assert.notDeepEqual(output.overall.entries.map(row => [row.userId, row.score]), f.baseline.files.get('overall.json').entries.map(row => [row.userId, row.score]));
});

const invalidInputs = [
  ['catalog track omitted from manifest', f => {delete f.manifest.tracks[ids[0]];}],
  ['catalog track has no path', f => {delete f.manifest.tracks[ids[0]].path;}],
  ['catalog track file absent', async f => {await fs.unlink(path.join(f.directory, 'tracks/' + ids[0] + '.json'));}],
  ['path traversal', f => {f.manifest.tracks[ids[0]].path = '../overall.json';}],
  ['path names a different track', f => {f.manifest.tracks[ids[0]].path = 'tracks/' + ids[1] + '.json';}],
  ['updatedAt mismatch', f => {f.manifest.tracks[ids[0]].updatedAt++;}],
  ['sourceUpdatedAt mismatch', f => {f.manifest.tracks[ids[0]].sourceUpdatedAt++;}],
  ['revision mismatch', f => {f.manifest.tracks[ids[0]].revision++;}],
  ['board identity mismatch', async f => {await write(f.directory, 'tracks/' + ids[0] + '.json', {...f.tracks[0], trackId:ids[1]});}]
];
for (const [label, mutate] of invalidInputs) test('rejects ' + label + ' before any output writes', async t => {
  const f = await fixture(t);
  await mutate(f);
  await write(f.directory, 'manifest.json', f.manifest);
  const before = await bytesIn(f.directory), writes = [], original = fs.writeFile.bind(fs);
  t.mock.method(fs, 'writeFile', async (...args) => {writes.push(String(args[0])); return original(...args);});
  await assert.rejects(rebuildSnapshotOverall({directory:f.directory, now:() => 4000}));
  assert.deepEqual(writes, [], 'preflight failures must not write any file');
  assert.deepEqual(await bytesIn(f.directory), before, 'every existing file must remain byte-identical');
});

for (const provenance of ['backend capture', 'absent', 'explicit null']) {
  test('repeated offline rebuilds do not recursively nest backendCapture: ' + provenance, async t => {
    const f = await fixture(t);
    if (provenance !== 'backend capture') {
      if (provenance === 'absent') delete f.manifest.overallCapture;
      else f.manifest.overallCapture = null;
      await write(f.directory, 'manifest.json', f.manifest);
    }
    const wanted = provenance === 'backend capture' ? backendCapture : null;
    let firstReceipt;
    for (let i = 0; i < 3; i++) {
      const report = await rebuildSnapshotOverall({directory:f.directory, now:() => 2000 + i * 1000});
      assert.deepEqual(report.backendCapture, wanted, 'original provenance must remain flat, including null');
      assert.deepEqual((await read(f.directory, 'manifest.json')).overallCapture.backendCapture, wanted);
      const receipt = await read(f.directory, 'overall-calculation.json');
      firstReceipt ??= receipt;
      assert.deepEqual(receipt, firstReceipt, 'unchanged inputs must retain stable calculation identity');
    }
  });
}
