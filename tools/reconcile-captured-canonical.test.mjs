import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {canonicalBindingSignature, reconcileCapturedCanonical} from './reconcile-captured-canonical.mjs';
import {snapshotReplayCompleteness} from './snapshot-replay-completeness.mjs';

const accountId = 'a'.repeat(64), trackId = 'b'.repeat(64), otherId = 'c'.repeat(64);
const sha = text => createHash('sha256').update(text).digest('hex');
const recording = deflateSync(Buffer.alloc(15)).toString('base64url');
const old = {accountId, trackId, uploadId: 10, frames: 1000, raceTimeFrames: 1000,
  timeMs: 2000, replayHash: 'd'.repeat(64), rank: 3, name: 'Synthetic', pbAt: '2025-01-01T00:00:00Z',
  runVerified: true, verified: true, verifiedState: 1, integrityVerified: true};
const source = {accountId, trackId, uploadId: 11, frames: 900, raceTimeFrames: 900, timeMs: 1500,
  replay: recording, replayHash: sha(recording), carStyle: '', verified: false, verifiedState: 0,
  pbAt: '2026-11-06T01:02:03.123456789Z', ingestedAt: '2026-11-06T01:02:04.123456789Z'};
const document = data => ({id: `${data.accountId}_${data.trackId}`, data});

async function fixture(t, entry = old) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canonical-reconcile-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const put = async (relative, value) => {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), {recursive: true});
    await fs.writeFile(file, JSON.stringify(value) + '\n');
  };
  const read = async relative => JSON.parse(await fs.readFile(path.join(root, relative)));
  const other = { ...old, accountId: otherId, uploadId: 20, timeMs: 1500, rank: 1, custom: {keep: true}};
  const third = {...old, accountId: 'e'.repeat(64), uploadId: 30, timeMs: 1700, rank: 2};
  await put(`tracks/${trackId}.json`, {trackId, count: 3, updatedAt: 123, entries: [other, third, entry]});
  await put(`accounts/${accountId}.json`, {untouched: true});
  const run = (documents = [document(source)], expectedBindings = [canonicalBindingSignature(entry)]) =>
    reconcileCapturedCanonical({directory: root, documents, expectedBindings});
  return {root, put, read, run, other, third};
}

async function tree(root) {
  const result = {};
  async function walk(relative = '') {
    for (const item of await fs.readdir(path.join(root, relative), {withFileTypes: true})) {
      const file = relative ? `${relative}/${item.name}` : item.name;
      if (item.isDirectory()) { result[file + '/'] = null; await walk(file); }
      else result[file] = (await fs.readFile(path.join(root, file))).toString('base64');
    }
  }
  await walk(); return result;
}

test('offline faster reconciliation retains exact evidence, dates, count and competition ties', async t => {
  const f = await fixture(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('No network allowed'));
  const result = await f.run();
  assert.equal(result.changed, 1); assert.equal(result.networkRequests, 0); assert.equal(result.verificationAttempts, 0);
  const board = await f.read(`tracks/${trackId}.json`);
  assert.equal(board.count, 3); assert.equal(board.entries.length, 3); assert.equal(board.updatedAt, 123);
  assert.deepEqual(board.entries.map(row => row.rank), [1, 1, 3]);
  assert.deepEqual(board.entries[0], f.other);
  assert.deepEqual(board.entries[2], {...f.third, rank: 3});
  const row = board.entries[1];
  assert.equal(row.originalTimeMs, 2000); assert.equal(row.originalRank, 3);
  for (const key of ['uploadId', 'timeMs', 'frames', 'replayHash', 'pbAt', 'ingestedAt']) assert.equal(row[key], source[key]);
  assert.equal(Object.hasOwn(row, 'updatedAt'), false);
  for (const value of [row, await f.read(`canonical/${trackId}/${accountId}.json`), await f.read('recordings/11.json')]) {
    for (const [key, expected] of Object.entries({verified: false, runVerified: false, verifiedState: 0,
      integrityVerified: true, playbackPending: true, verificationStatus: 'pending', eventRpEligible: false})) assert.equal(value[key], expected);
  }
  assert.equal(Object.hasOwn(await f.read(`canonical/${trackId}/${accountId}.json`), "sourceDocument"), false);
  assert.equal((await f.read('recordings/11.json')).recording, source.replay);
  assert.deepEqual(await f.read(`accounts/${accountId}.json`), {untouched: true});
});

test('source verified proof is retained as evidence but never grants local verification', async t => {
  const f = await fixture(t), data = {...source, verified: true, verifiedState: 1, proof: {status: 'passed'}};
  await f.run([document(data)]);
  const row = await f.read(`canonical/${trackId}/${accountId}.json`);
  assert.equal(Object.hasOwn(row, "sourceDocument"), false);
  assert.equal(row.verified, false); assert.equal(row.runVerified, false); assert.equal(row.verifiedState, 0);
});

test('full Firestore name is accepted with exact collection and matching optional ID', async t => {
  const f = await fixture(t), doc = document(source);
  doc.name = `projects/synthetic/databases/(default)/documents/0.6.2_race_results/${doc.id}`;
  await f.run([doc]);
});

const invalidCases = [
  ['wrong document ID', doc => {doc.id = `${otherId}_${trackId}`;}],
  ['wrong collection', doc => {doc.name = `projects/x/databases/(default)/documents/other/${doc.id}`;}],
  ['wrong source account', doc => {doc.data.accountId = otherId;}],
  ['wrong source track', doc => {doc.data.trackId = otherId;}],
  ['inconsistent false state', doc => {doc.data.verifiedState = 1;}],
  ['inconsistent true state', doc => {doc.data.verified = true;}],
  ['missing verified state', doc => {delete doc.data.verifiedState;}],
  ['rejected source', doc => {doc.data.verificationStatus = 'rejected';}],
  ['same time changed binding', doc => {doc.data.timeMs = old.timeMs;}],
  ['slower binding', doc => {doc.data.timeMs = old.timeMs + 1;}],
  ['bad time', doc => {doc.data.timeMs = 0;}],
  ['inconsistent frame aliases', doc => {doc.data.raceTimeFrames++;}],
  ['bad SHA256', doc => {doc.data.replayHash = 'f'.repeat(64);}],
  ['hash valid malformed replay', doc => {doc.data.replay = deflateSync(Buffer.alloc(16)).toString('base64url'); doc.data.replayHash = sha(doc.data.replay);}],
  ['transition beyond finish', doc => {
    const bytes = Buffer.alloc(18); bytes.writeUIntLE(1, 0, 3); bytes.writeUIntLE(901, 3, 3);
    doc.data.replay = deflateSync(bytes).toString('base64url'); doc.data.replayHash = sha(doc.data.replay);
  }],
  ['invalid car style', doc => {doc.data.carStyle = 12;}],
];
for (const [label, mutate] of invalidCases) test(`${label} rejects before any writes`, async t => {
  const f = await fixture(t), before = await tree(f.root), doc = document(structuredClone(source));
  mutate(doc);
  await assert.rejects(f.run([doc]));
  assert.deepEqual(await tree(f.root), before);
});

test('expected signature must match every existing binding field exactly', async t => {
  for (const change of [{accountId: otherId}, {trackId: otherId}, {uploadId: 12}, {frames: 999, raceTimeFrames: 999}, {replayHash: 'f'.repeat(64)}]) {
    const f = await fixture(t), before = await tree(f.root);
    await assert.rejects(f.run([document(source)], [{...old, ...change}]));
    assert.deepEqual(await tree(f.root), before);
  }
});

test('a later invalid response prevents writes for earlier valid responses', async t => {
  const f = await fixture(t), before = await tree(f.root);
  const second = {...source, accountId: otherId, uploadId: 21, timeMs: 1400, replayHash: 'f'.repeat(64)};
  await assert.rejects(f.run([document(source), document(second)], [old, f.other]));
  assert.deepEqual(await tree(f.root), before);
});

test('a later stale expected binding also prevents all earlier planned writes', async t => {
  const f = await fixture(t), before = await tree(f.root);
  const second = {...source, accountId: otherId, uploadId: 21, timeMs: 1400};
  await assert.rejects(f.run([document(source), document(second)], [old, {...f.other, uploadId: 999}]));
  assert.deepEqual(await tree(f.root), before);
});

test('unchanged saved valid files are reused byte for byte, without source reads or writes', async t => {
  const entry = {...old, ...source, runVerified: false, integrityVerified: true};
  delete entry.replay;
  const f = await fixture(t, entry);
  await f.put(`canonical/${trackId}/${accountId}.json`, entry);
  await f.put('recordings/11.json', {...entry, recording});
  const before = await tree(f.root);
  const result = await f.run([], [canonicalBindingSignature(entry)]);
  assert.equal(result.reused, 1); assert.equal(result.changed, 0); assert.deepEqual(result.files, []);
  assert.deepEqual(await tree(f.root), before);
  await f.run([document(source)], [entry]);
  assert.deepEqual(await tree(f.root), before);
});

test('same hash does not permit a changed upload or frame binding at equal time', async t => {
  const entry = {...old, replayHash: source.replayHash};
  const f = await fixture(t, entry), before = await tree(f.root);
  await assert.rejects(f.run([document({...source, timeMs: old.timeMs})], [entry]), /strictly faster/);
  assert.deepEqual(await tree(f.root), before);
});

test('duplicate responses, duplicate expectations and missing unavailable source reject without writes', async t => {
  const f = await fixture(t), before = await tree(f.root);
  await assert.rejects(f.run([document(source), document(source)]));
  await assert.rejects(f.run([document(source)], [old, old]));
  await assert.rejects(f.run([]));
  assert.deepEqual(await tree(f.root), before);
});

test('occupied upload IDs cannot be overwritten with another binding', async t => {
  const f = await fixture(t);
  await f.put('recordings/11.json', {...source, accountId: otherId, recording});
  const before = await tree(f.root);
  await assert.rejects(f.run(), /collision/);
  assert.deepEqual(await tree(f.root), before);
});

test('original metadata survives repeated faster reconciliations and absent dates stay absent', async t => {
  const f = await fixture(t);
  await f.run();
  const next = {...source, uploadId: 12, timeMs: 1400};
  delete next.pbAt; delete next.ingestedAt;
  await f.run([document(next)], [source]);
  const row = (await f.read(`tracks/${trackId}.json`)).entries[0];
  assert.equal(row.originalTimeMs, old.timeMs); assert.equal(row.originalRank, old.rank);
  for (const field of ['pbAt', 'ingestedAt', 'updatedAt', 'createdAt']) assert.equal(Object.hasOwn(row, field), false);
});

test('a reconciled standalone board passes the existing publication byte audit', async t => {
  const f = await fixture(t);
  await f.put(`tracks/${trackId}.json`, {trackId, entries: [old]});
  await f.run();
  const result = await snapshotReplayCompleteness(f.root);
  assert.equal(result.complete, true); assert.equal(result.normal.available, 1);
});

test('indexed work over the existing budget rejects before any writes', async t => {
  const f = await fixture(t), before = await tree(f.root);
  // More than 4096 transitions uses the 30M-work budget, not the compact-input allowance.
  const count = 1000, bytes = Buffer.alloc(15 + count * 5 * 3);
  for (let channel = 0; channel < 5; channel++) {
    const offset = channel * (3 + count * 3);
    bytes.writeUIntLE(count, offset, 3);
    for (let i = 0; i < count; i++) bytes.writeUIntLE(i ? 1 : 3999000, offset + 3 + i * 3, 3);
  }
  const replay = deflateSync(bytes).toString('base64url');
  await assert.rejects(f.run([document({...source, frames: 4000000, raceTimeFrames: 4000000,
    replay, replayHash: sha(replay)})]), /indexed playback budget/);
  assert.deepEqual(await tree(f.root), before);
});

test('indexed-valid replay is accepted even when the legacy linear work exceeds its budget', async t => {
  const f = await fixture(t), bytes = Buffer.alloc(15 + 300 * 3);
  bytes.writeUIntLE(300, 0, 3);
  for (let i = 0; i < 300; i++) bytes.writeUIntLE(1, 3 + i * 3, 3);
  const replay = deflateSync(bytes).toString('base64url');
  await f.run([document({...source, frames: 1000000, raceTimeFrames: 1000000, replay, replayHash: sha(replay)})]);
  assert.equal((await f.read('recordings/11.json')).recording, replay);
});

test('a new upload cannot collide with another board row even without a saved recording', async t => {
  const f = await fixture(t), before = await tree(f.root);
  await assert.rejects(f.run([document({...source, uploadId: f.other.uploadId})]), /collision/);
  assert.deepEqual(await tree(f.root), before);
});

test('a batch containing valid replacements for two accounts sorts the full board', async t => {
  const f = await fixture(t), second = {...source, accountId: otherId, uploadId: 21, timeMs: 1400};
  const result = await f.run([document(source), document(second)], [old, f.other]);
  assert.equal(result.changed, 2);
  const board = await f.read(`tracks/${trackId}.json`);
  assert.deepEqual(board.entries.map(row => row.timeMs), [1400, 1500, 1700]);
  assert.deepEqual(board.entries.map(row => row.rank), [1, 2, 3]);
  assert.deepEqual(board.entries.map(row => row.accountId), [otherId, accountId, f.third.accountId]);
});

test('rename failure restores committed file bytes and removes temporary files', async t => {
  const f = await fixture(t);
  await f.put(`canonical/${trackId}/${accountId}.json`, old);
  const before = await fs.readFile(path.join(f.root, `canonical/${trackId}/${accountId}.json`));
  const boardBefore = await fs.readFile(path.join(f.root, `tracks/${trackId}.json`));
  const rename = fs.rename;
  let count = 0;
  t.mock.method(fs, 'rename', async (...args) => {
    if (++count === 2) throw Error('Synthetic rename failure');
    return rename(...args);
  });
  await assert.rejects(f.run(), /Synthetic rename failure/);
  assert.deepEqual(await fs.readFile(path.join(f.root, `canonical/${trackId}/${accountId}.json`)), before);
  assert.deepEqual(await fs.readFile(path.join(f.root, `tracks/${trackId}.json`)), boardBefore);
  assert.equal(Object.keys(await tree(f.root)).some(file => file.endsWith('.tmp')), false);
  await assert.rejects(fs.stat(path.join(f.root, 'recordings/11.json')), {code: 'ENOENT'});
});

test('an unchanged saved pair still requires valid replay bytes', async t => {
  const entry = {...old, ...source, runVerified: false, integrityVerified: true};
  delete entry.replay;
  const f = await fixture(t, entry);
  await f.put(`canonical/${trackId}/${accountId}.json`, entry);
  await f.put('recordings/11.json', {...entry, recording: 'invalid'});
  const before = await tree(f.root);
  await assert.rejects(f.run([], [entry]), /SHA256/);
  assert.deepEqual(await tree(f.root), before);
});

test('old verification witnesses and verdict dates never follow a replacement', async t => {
  const entry = {...old, verifiedAt: 123, nativeLedgerKey: 'old-key', nativeLedgerManifestHash: 'old-manifest',
    physicsVerified: true, replayIntegrityVerified: true, validationState: 'verified', status: 'verified'};
  const f = await fixture(t, entry);
  await f.run();
  const row = (await f.read(`tracks/${trackId}.json`)).entries.find(row => row.accountId === accountId);
  for (const key of ['verifiedAt', 'nativeLedgerKey', 'nativeLedgerManifestHash', 'physicsVerified', 'replayIntegrityVerified']) {
    assert.equal(Object.hasOwn(row, key), false);
  }
  assert.equal(row.validationState, 'pending'); assert.equal(row.status, 'pending');
});

test('inconsistent saved verification flags do not qualify for reuse', async t => {
  const entry = {...old, ...source, runVerified: true, integrityVerified: true};
  delete entry.replay;
  const f = await fixture(t, entry);
  await f.put(`canonical/${trackId}/${accountId}.json`, entry);
  await f.put('recordings/11.json', {...entry, recording});
  const before = await tree(f.root);
  await assert.rejects(f.run([], [entry]), /saved status/);
  assert.deepEqual(await tree(f.root), before);
});
