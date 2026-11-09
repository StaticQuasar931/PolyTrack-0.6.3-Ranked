import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {encodeSnapshot} from './snapshot-package.mjs';
import {reconcileSupersededPendingPlaybacks} from './reconcile-superseded-pending-playbacks.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = n => n.toString(16).padStart(64, '0');
const replay = deflateSync(Buffer.alloc(15)).toString('base64url');

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'superseded-pending-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const directory = path.join(root, 'candidate');
  const packageDirectory = path.join(root, 'public-snapshots78');
  await fs.mkdir(path.join(directory, 'events'), {recursive: true});
  await fs.mkdir(path.join(directory, 'event-replays'), {recursive: true});
  await fs.mkdir(packageDirectory);

  const period = {id: 'd_fixture', trackId: hash(100)};
  const oldRows = [], newRows = [], files = {};
  for (let i = 1; i <= 7; i++) {
    const accountId = hash(200 + i), runId = hash(300 + i), newRunId = hash(400 + i);
    const oldReplayHash = sha(replay), newReplayHash = sha(replay);
    const oldRow = {accountId, runId, timeMs: 2000 + i, submittedAt: 1000 + i, replayHash: oldReplayHash};
    const replacement = {accountId, trackId: period.trackId, runId: newRunId, timeMs: 1000 + i,
      submittedAt: 2000 + i, replayHash: newReplayHash, runVerified: options.holdIndex === i ? false : true,
      verified: true, eventRpEligible: true};
    oldRows.push(oldRow); newRows.push(replacement);
    const oldLogical = `event-playbacks/${period.id}/${runId}.json`;
    const oldValue = {...oldRow, periodId: period.id, trackId: period.trackId, frames: oldRow.timeMs,
      replay, carStyle: '', pending: true, verified: false, eventRpEligible: false};
    const bytes = Buffer.from(JSON.stringify(oldValue));
    let encoded = Buffer.from(await encodeSnapshot(oldValue));
    const digest = sha(encoded);
    await fs.writeFile(path.join(packageDirectory, `${digest}.bin`), encoded);
    files[oldLogical] = {path: `${digest}.bin`, sha256: digest, decodedBytes: bytes.length};

    const currentValue = {...replacement, periodId: period.id, trackId: period.trackId,
      frames: replacement.timeMs, replay, carStyle: '', pending: false, verified: true, eventRpEligible: true};
    await fs.mkdir(path.join(directory, `event-replays/${period.id}`), {recursive: true});
    await fs.writeFile(path.join(directory, `event-replays/${period.id}/${accountId}.json`), JSON.stringify(currentValue));
  }
  if (options.blockFlag) newRows[6][options.blockFlag] = true;
  if (options.missingReplacement) await fs.rm(path.join(directory, `event-replays/${period.id}/${hash(207)}.json`));
  if (options.notLater) newRows[6].submittedAt = oldRows[6].submittedAt;
  if (options.notLater) {
    const row = newRows[6];
    row.submittedAt = oldRows[6].submittedAt;
    const currentValue = {...row, periodId: period.id, trackId: period.trackId, frames: row.timeMs,
      replay, carStyle: '', pending: false, verified: true, eventRpEligible: true};
    await fs.writeFile(path.join(directory, `event-replays/${period.id}/${row.accountId}.json`), JSON.stringify(currentValue));
  }
  const priorBoard = {period, entries: [], pendingPlaybacks: oldRows};
  const priorBoardBytes = Buffer.from(JSON.stringify(priorBoard));
  const boardEncoded = Buffer.from(await encodeSnapshot(priorBoard));
  const boardDigest = sha(boardEncoded);
  await fs.writeFile(path.join(packageDirectory, `${boardDigest}.bin`), boardEncoded);
  files[`events/${period.id}.json`] = {path: `${boardDigest}.bin`, sha256: boardDigest, decodedBytes: priorBoardBytes.length};
  const indexBytes = Buffer.from(JSON.stringify({files}));
  await fs.writeFile(path.join(packageDirectory, 'index.json'), indexBytes);
  if (options.corruptMedia) {
    const first = Object.values(files)[1];
    await fs.appendFile(path.join(packageDirectory, first.path), 'tamper');
  }
  await fs.writeFile(path.join(root, 'snapshot-current.json'), JSON.stringify({currentdir: 'public-snapshots78'}));

  const currentBoard = {period, entries: newRows, pendingPlaybacks: options.coveredFirst ? [oldRows[0]] : []};
  await fs.writeFile(path.join(directory, `events/${period.id}.json`), JSON.stringify(currentBoard));
  const manifest = {eventPlaybacks: {}, pendingPlaybackCoverage: {known: 22, published: 15, missing: 7,
    failed: 0, deferred: 7, complete: false, scope: 'selected-saved-event-boards'}};
  if (options.coveredFirst) {
    const row = oldRows[0], logical = `event-playbacks/${period.id}/${row.runId}.json`;
    const value = {...row, periodId: period.id, trackId: period.trackId, frames: row.timeMs,
      replay, carStyle: '', pending: true, verified: false, eventRpEligible: false};
    await fs.mkdir(path.dirname(path.join(directory, logical)), {recursive: true});
    await fs.writeFile(path.join(directory, logical), JSON.stringify(value));
    manifest.eventPlaybacks[logical] = {path: logical, periodId: period.id, runId: row.runId,
      accountId: row.accountId, timeMs: row.timeMs, replayHash: row.replayHash};
    manifest.pendingPlaybackCoverage = {known: 22, published: 16, missing: 6,
      failed: 0, deferred: 6, complete: false, scope: 'selected-saved-event-boards'};
  }
  const manifestPath = path.join(directory, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  return {root, directory, manifestPath, indexBytes, expectedIndexSha256: options.badIndexHash ? '0'.repeat(64) : sha(indexBytes),
    oldRows, period};
}

test('resolves exactly seven superseded rows without adding them to the event board', async t => {
  const f = await fixture(t);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw Error('network access is forbidden'); };
  try {
    const result = await reconcileSupersededPendingPlaybacks(f);
    assert.equal(result.resolved, 7);
    assert.equal(result.coverage.known, 22);
    assert.equal(result.coverage.published, 22);
    assert.equal(result.coverage.missing, 0);
    assert.equal(result.coverage.complete, true);
    assert.equal(result.backendReads, 0);
    assert.equal(result.backendWrites, 0);
    const manifest = JSON.parse(await fs.readFile(f.manifestPath, 'utf8'));
    assert.equal(manifest.pendingPlaybackReconciliation.originalScope, 'selected-saved-event-boards');
    assert.equal(manifest.pendingPlaybackReconciliation.originalCoverage.missing, 7);
    assert.equal(manifest.pendingPlaybackReconciliation.resolved.length, 7);
    assert.equal(Object.keys(manifest.eventPlaybacks).length, 7);
    const board = JSON.parse(await fs.readFile(path.join(f.directory, `events/${f.period.id}.json`), 'utf8'));
    assert.equal(board.pendingPlaybacks.length, 0);
    for (const row of f.oldRows) assert.equal((await fs.stat(path.join(f.directory,
      `event-playbacks/${f.period.id}/${row.runId}.json`))).isFile(), true);
  } finally { globalThis.fetch = originalFetch; }
});

test('skips an exactly indexed and covered prior pending row', async t => {
  const f = await fixture(t, {coveredFirst: true});
  const result = await reconcileSupersededPendingPlaybacks(f);
  assert.equal(result.resolved, 6);
  assert.equal(result.coverage.known, 22);
  assert.equal(result.coverage.published, 22);
  const manifest = JSON.parse(await fs.readFile(f.manifestPath, 'utf8'));
  assert.equal(manifest.pendingPlaybackReconciliation.originalCoverage.missing, 6);
  assert.equal(Object.keys(manifest.eventPlaybacks).length, 7);
});

test('rejects candidate path symlinks before reading or writing through them', async t => {
  const f = await fixture(t);
  const outside = path.join(path.dirname(f.directory), 'redirected-events');
  await fs.mkdir(outside);
  await fs.copyFile(path.join(f.directory, `events/${f.period.id}.json`), path.join(outside, `${f.period.id}.json`));
  await fs.rm(path.join(f.directory, 'events'), {recursive: true});
  try { await fs.symlink(outside, path.join(f.directory, 'events'), 'junction'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'UNKNOWN'].includes(error.code)) return t.skip(`symlink creation unavailable: ${error.code}`);
    throw error;
  }
  const before = await fs.readFile(f.manifestPath);
  await assert.rejects(reconcileSupersededPendingPlaybacks(f), /Symlink path is not allowed/);
  assert.deepEqual(await fs.readFile(f.manifestPath), before);
  assert.deepEqual(await fs.readdir(outside), [`${f.period.id}.json`]);
});

for (const [label, options, pattern] of [
  ['invalid pinned index hash', {badIndexHash: true}, /index hash mismatch/],
  ['replacement has a review hold', {blockFlag: 'reviewHold'}, /No later faster verified replacement/],
  ['replacement is unscored', {blockFlag: 'unscored'}, /No later faster verified replacement/],
  ['replacement held from verification', {holdIndex: 7}, /No later faster verified replacement/],
  ['replacement is not later', {notLater: true}, /No later faster verified replacement/],
  ['replacement replay is missing', {missingReplacement: true}, /Replacement replay is unavailable/],
  ['source media is corrupt', {corruptMedia: true}, /payload hash mismatch/],
]) {
  test(`fails closed with no partial files when ${label}`, async t => {
    const f = await fixture(t, options);
    const before = await fs.readFile(f.manifestPath);
    await assert.rejects(reconcileSupersededPendingPlaybacks(f), pattern);
    assert.deepEqual(await fs.readFile(f.manifestPath), before);
    for (const row of f.oldRows) await assert.rejects(fs.stat(path.join(f.directory,
      `event-playbacks/${f.period.id}/${row.runId}.json`)), {code: 'ENOENT'});
  });
}
