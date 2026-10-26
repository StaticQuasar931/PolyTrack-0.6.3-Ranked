import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createRequire} from 'node:module';
import {encodeSnapshot} from '../snapshot-package.mjs';
import {VERIFIER_ENGINE_DIGEST, VERIFIER_VERSION} from '../../workers/ranked/src/verification.js';
import {auditSnapshot, loadSnapshotAuditInputs, renameCheckpointWithRetry} from './snapshot-audit.mjs';

const require = createRequire(import.meta.url);
const {verifierFingerprint} = require('./verify.cjs');
const TRACK = 'a'.repeat(64);
const ACCOUNTS = ['b', 'c', 'd', 'e'].map(char => char.repeat(64));
const RIGHT = Array.from({length: 24}, (_, index) => (index + 1) * 100);
const REPLAY = makeReplay(RIGHT);
const REPLAY_HASH = crypto.createHash('sha256').update(REPLAY).digest('hex');
const EMPTY_REPLAY = makeReplay([]);
const EMPTY_HASH = crypto.createHash('sha256').update(EMPTY_REPLAY).digest('hex');
const VARIANT_REPLAY = makeReplay(RIGHT.map((tick, index) => index === RIGHT.length - 1 ? tick + 1 : tick));
const VARIANT_HASH = crypto.createHash('sha256').update(VARIANT_REPLAY).digest('hex');

function makeReplay(rightTicks) {
  const lists = {up: [], right: rightTicks, down: [], left: [], reset: []};
  const chunks = [];
  for (const name of ['up', 'right', 'down', 'left', 'reset']) {
    const values = lists[name], count = Buffer.alloc(3); count.writeUIntLE(values.length, 0, 3); chunks.push(count);
    let previous = 0;
    for (const tick of values) { const delta = Buffer.alloc(3); delta.writeUIntLE(tick - previous, 0, 3); chunks.push(delta); previous = tick; }
  }
  return require('node:zlib').deflateSync(Buffer.concat(chunks)).toString('base64url');
}

async function fixture({missingRecording = false, lowInformation = false} = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'polytrack-snapshot-audit-'));
  const root = path.join(temp, 'repo'), output = path.join(temp, 'private');
  await fs.mkdir(path.join(root, 'public-snapshots1'), {recursive: true});
  await fs.mkdir(output);
  const generation = path.join(root, 'public-snapshots1'), files = {};
  const values = new Map();
  const replay = lowInformation ? EMPTY_REPLAY : REPLAY;
  const replayHash = lowInformation ? EMPTY_HASH : REPLAY_HASH;
  const boardEntries = [];
  for (let i = 0; i < 2; i++) {
    const accountId = ACCOUNTS[i], uploadId = 100 + i;
    const canonical = {accountId, trackId: TRACK, uploadId, timeMs: 5000, frames: 5000,
      replayHash, verified: false, integrityVerified: false};
    values.set(`canonical/${TRACK}/${accountId}.json`, canonical);
    boardEntries.push({...canonical, id: uploadId, userId: accountId, runVerified: false});
    if (!(missingRecording && i === 1)) values.set(`recordings/${uploadId}.json`, {accountId, trackId: TRACK,
      frames: 5000, verifiedState: i, replayHash, recording: replay});
  }
  values.set(`tracks/${TRACK}.json`, {trackId: TRACK, entries: boardEntries});
  const periodId = 'd_20261001';
  values.set(`events/${periodId}.json`, {id: periodId, period: {id: periodId, trackId: TRACK},
    entries: [ACCOUNTS[0], ACCOUNTS[3]].map(accountId => ({accountId, timeMs: 5000}))});
  for (const [index, accountId] of [ACCOUNTS[0], ACCOUNTS[3]].entries()) {
    const eventReplay = lowInformation ? EMPTY_REPLAY : index === 1 ? VARIANT_REPLAY : REPLAY;
    const eventHash = lowInformation ? EMPTY_HASH : index === 1 ? VARIANT_HASH : REPLAY_HASH;
    values.set(`event-replays/${periodId}/${accountId}.json`, {periodId, trackId: TRACK, accountId,
      runId: crypto.createHash('sha256').update(accountId).digest('hex'), timeMs: 5000, frames: 5000, replay: eventReplay, replayHash: eventHash});
  }
  for (const [logical, value] of values) {
    const bytes = Buffer.from(await encodeSnapshot(value));
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    await fs.writeFile(path.join(generation, `${sha256}.bin`), bytes);
    files[logical] = {path: `${sha256}.bin`, sha256, decodedBytes: Buffer.byteLength(JSON.stringify(value))};
  }
  await fs.writeFile(path.join(generation, 'index.json'), JSON.stringify({schemaVersion: 1, generation: 1,
    encoding: 'gzip-xor-a7-v1', files}));
  await fs.writeFile(path.join(root, 'snapshot-current.json'), JSON.stringify({currentdir: 'public-snapshots1'}));
  return {temp, root, report: path.join(output, 'audit.json')};
}

async function cleanup(item) { await fs.rm(item.temp, {recursive: true, force: true}); }

const ROLLING_TRACK = 'fb769ac2ea77e8f19a21a9dd3071742f2342bd49c41e4748d7e8c7903d4f0778';
function permanentBoard() {
  return {id: 'permanent-rolling-hills', kind: 'permanent', trackId: ROLLING_TRACK,
    scoreVersion: 'rolling-hills-live-verified-v1', targetPolicy: 'live-fastest-physics-verified',
    targetMs: 5000, maxRp: 1001, sourceRevision: 1, updatedAt: 10000, complete: true,
    totalEntries: 1, sourceTotalEntries: 1, sourceCompleteness: 'explicit-snapshot-metadata',
    contributions: {normalRp: true, eventRp: true}, entries: [{accountId: ACCOUNTS[0],
      timeMs: 5000, frames: 5000, replayHash: REPLAY_HASH, rank: 1, rp: 1001,
      eventRpContribution: 1001, normalRpEligible: true, physicsVerified: true, replayIntegrityVerified: true}]};
}
async function replacePayload(item, logical, value) {
  const directory = path.join(item.root, 'public-snapshots1');
  const index = JSON.parse(await fs.readFile(path.join(directory, 'index.json'), 'utf8'));
  const bytes = Buffer.from(await encodeSnapshot(value));
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  await fs.writeFile(path.join(directory, sha256 + '.bin'), bytes);
  index.files[logical] = {path: sha256 + '.bin', sha256, decodedBytes: Buffer.byteLength(JSON.stringify(value))};
  await fs.writeFile(path.join(directory, 'index.json'), JSON.stringify(index));
}

test('dedicated permanent validation accepts its public schema without adding replay jobs', async () => {
  const item = await fixture();
  try {
    const before = await loadSnapshotAuditInputs({root: item.root});
    await replacePayload(item, 'events/permanent-rolling-hills.json', permanentBoard());
    const after = await loadSnapshotAuditInputs({root: item.root});
    assert.deepEqual(after.issues, before.issues);
    assert.deepEqual(after.jobs, before.jobs);
    assert.equal(after.coverage.normalJobs, 2);
    assert.equal(after.coverage.eventReplays, 2);
  } finally { await cleanup(item); }
});

test('invalid permanent identity, completeness, source policy and rows remain audit issues', async () => {
  const item = await fixture();
  try {
    const base = permanentBoard();
    const invalids = [null, {...base, id: 'wrong'}, {...base, kind: 'weekly'}, {...base, trackId: TRACK},
      {...base, period: {id: base.id, trackId: ROLLING_TRACK}}, {...base, complete: false},
      {...base, totalEntries: 2}, {...base, sourceComplete: false}, {...base, sourceTotalEntries: 0},
      {...base, targetPolicy: 'other'}, {...base, maxRp: 999}, {...base, sourceRevision: 0},
      {...base, targetMs: 4999}, {...base, entries: [null]},
      ...[{accountId: 'bad'}, {frames: 4999}, {replayHash: 'bad'}, {physicsVerified: false},
        {replayIntegrityVerified: false}, {rp: 1002}, {eventRpContribution: 0}]
        .map(patch => ({...base, entries: [{...base.entries[0], ...patch}]})),
      {...base, totalEntries: 2, sourceTotalEntries: 2, entries: [base.entries[0], base.entries[0]]}];
    for (const value of invalids) {
      await replacePayload(item, 'events/permanent-rolling-hills.json', value);
      const audit = await loadSnapshotAuditInputs({root: item.root});
      assert.ok(audit.issues.some(issue => issue.kind === 'permanent_board_invalid'));
      assert.equal(audit.jobs.length, 4);
    }
  } finally { await cleanup(item); }
});

test('timed boards still require matching period and permanent replay files cannot duplicate jobs', async () => {
  const item = await fixture();
  try {
    await replacePayload(item, 'events/d_20261001.json', {id: 'd_20261001', kind: 'permanent',
      trackId: ROLLING_TRACK, entries: []});
    await replacePayload(item, 'events/permanent-rolling-hills.json', permanentBoard());
    await replacePayload(item, `event-replays/permanent-rolling-hills/${ACCOUNTS[0]}.json`, {
      periodId: 'permanent-rolling-hills', trackId: ROLLING_TRACK, accountId: ACCOUNTS[0],
      runId: 'f'.repeat(64), timeMs: 5000, replay: REPLAY, replayHash: REPLAY_HASH});
    const audit = await loadSnapshotAuditInputs({root: item.root});
    assert.ok(audit.issues.some(issue => issue.kind === 'event_board_invalid' && issue.source === 'events/d_20261001.json'));
    assert.ok(audit.issues.some(issue => issue.kind === 'permanent_replay_wrong_lane'));
    assert.equal(audit.jobs.length, 4);
    assert.ok(audit.jobs.every(job => job.periodId !== 'permanent-rolling-hills'));
  } finally { await cleanup(item); }
});

function fakeVerify(calls) {
  return async (_root, jobs) => {
    calls.push(jobs.length);
    return jobs.map(job => ({resultId: job.resultId, status: 'verified', trackId: job.trackId,
      timeMs: job.timeMs, replayHash: job.replayHash, engineDigest: VERIFIER_ENGINE_DIGEST,
      verifierVersion: VERIFIER_VERSION, binding: {verifierFingerprint, nativeTrackId: job.trackId,
        actualReplayHash: job.replayHash, trackContentHash: 'f'.repeat(64)}}));
  };
}

test('audit validates indexed payloads and enumerates normal, current, and separate event evidence', async () => {
  const item = await fixture({missingRecording: true});
  try {
    const audit = await loadSnapshotAuditInputs({root: item.root});
    assert.equal(audit.coverage.canonicalRecords, 2);
    assert.equal(audit.coverage.currentTrackBindings, 2);
    assert.equal(audit.coverage.normalRecordings, 1);
    assert.equal(audit.coverage.eventReplays, 2);
    assert.equal(audit.coverage.missingCanonicalRecordings, 1);
    assert.ok(audit.issues.some(issue => issue.kind === 'canonical_missing_recording'));
    assert.ok(audit.manifest.indexSha256);
    assert.ok(audit.manifest.engineFingerprint);
  } finally { await cleanup(item); }
});

test('all decoded same-track pairs are compared and results stay advisory', async () => {
  const item = await fixture();
  try {
    const calls = [];
    const summary = await auditSnapshot({report: item.report, root: item.root, validateEngine: async () => {},
      verify: fakeVerify(calls)});
    assert.equal(summary.complete, true);
    assert.equal(summary.physics.verified, 4);
    assert.equal(summary.physics.noAutoApproval, true);
    assert.equal(summary.pairAudit.totalPairs, 6);
    assert.equal(summary.pairAudit.exactPairs, 3);
    assert.equal(summary.pairAudit.sameAccountPairs, 1);
    assert.equal(summary.pairAudit.sameAccountExactPairs, 1);
    assert.equal(summary.pairAudit.crossAccountExactPairs, 2);
    assert.equal(summary.pairAudit.actionableCrossAccountExactPairs, 2);
    assert.equal(summary.pairAudit.informativeExactPairs, 3);
    assert.equal(summary.pairAudit.nearSimilarPairs, 3);
    assert.equal(summary.pairAudit.findingLines, 6);
    assert.deepEqual(calls, [4]);
    const pairs = (await fs.readFile(item.report + '.pairs.jsonl', 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(pairs.length, 6);
    assert.equal(pairs.filter(row => row.exactInput && row.informative).length, 3);
    assert.equal(pairs.filter(row => !row.exactInput && row.inputSimilarity >= .95).length, 3);
    assert.equal(pairs.filter(row => row.actionable).length, 2);
    assert.ok(pairs.filter(row => row.exactInput).every(row => row.actionable === !row.sameAccount));
    assert.equal(JSON.parse(await fs.readFile(item.report + '.state.json', 'utf8')).manifest.engineDigest, VERIFIER_ENGINE_DIGEST);
  } finally { await cleanup(item); }
});

test('low-information exact inputs are counted but do not create flagged findings', async () => {
  const item = await fixture({lowInformation: true});
  try {
    const summary = await auditSnapshot({report: item.report, root: item.root, validateEngine: async () => {},
      verify: fakeVerify([])});
    assert.equal(summary.pairAudit.totalPairs, 6);
    assert.equal(summary.pairAudit.exactPairs, 6);
    assert.equal(summary.pairAudit.lowInformationExactPairs, 6);
    assert.equal(summary.pairAudit.actionableCrossAccountExactPairs, 0);
    assert.equal(summary.pairAudit.findingLines, 0);
    assert.equal((await fs.readFile(item.report + '.pairs.jsonl', 'utf8')).length, 0);
  } finally { await cleanup(item); }
});

test('native audit checkpoints resume with batches no larger than sixteen', async () => {
  const item = await fixture();
  try {
    const calls = [], verify = fakeVerify(calls), options = {report: item.report, root: item.root,
      validateEngine: async () => {}, verify};
    const first = await auditSnapshot({...options, maxJobs: 1});
    assert.equal(first.complete, false);
    assert.equal(first.physics.verified, 1);
    const checkpoint = JSON.parse(await fs.readFile(item.report + '.state.json', 'utf8'));
    checkpoint.manifest.auditSourceSha256 = '72a1891fd54c0bdf157183a5973ff608f338d60e998b121912f5a0e56a2ec84a';
    checkpoint.manifestSha256 = crypto.createHash('sha256').update(JSON.stringify(checkpoint.manifest)).digest('hex');
    delete checkpoint.comparison.sameAccountPairs;
    delete checkpoint.comparison.crossAccountExactPairs;
    await fs.writeFile(item.report + '.state.json', JSON.stringify(checkpoint));
    const resumed = await auditSnapshot(options);
    assert.equal(resumed.complete, true);
    assert.equal(resumed.physics.verified, 4);
    assert.deepEqual(calls, [1, 3]);
    assert.equal(resumed.physics.batches, 2);
    assert.equal(Number.isFinite(resumed.pairAudit.sameAccountPairs), true);
    assert.equal((await fs.readFile(item.report + '.pairs.jsonl', 'utf8')).trim().split('\n').length, 6);
  } finally { await cleanup(item); }
});

test('snapshot payload corruption and an in-repository output path fail closed', async () => {
  const item = await fixture();
  try {
    const files = Object.keys(JSON.parse(await fs.readFile(path.join(item.root, 'public-snapshots1/index.json'), 'utf8')).files);
    const index = JSON.parse(await fs.readFile(path.join(item.root, 'public-snapshots1/index.json'), 'utf8'));
    const payload = index.files[files[0]].path;
    await fs.appendFile(path.join(item.root, 'public-snapshots1', payload), 'corrupt');
    await assert.rejects(loadSnapshotAuditInputs({root: item.root}), /SHA mismatch/);
    const fresh = await fixture();
    try {
      await assert.rejects(auditSnapshot({report: path.join(fresh.root, 'audit.json'), root: fresh.root,
        validateEngine: async () => {}, verify: fakeVerify([])}), /outside the Git repository/);
    } finally { await cleanup(fresh); }
  } finally { await cleanup(item); }
});

test('a snapshot or engine change invalidates the resumable checkpoint', async () => {
  const item = await fixture();
  try {
    await auditSnapshot({report: item.report, root: item.root, maxJobs: 1,
      validateEngine: async () => {}, verify: fakeVerify([])});
    const pointer = path.join(item.root, 'snapshot-current.json');
    await fs.writeFile(pointer, JSON.stringify({currentdir: 'public-snapshots1', refreshed: true}));
    await assert.rejects(auditSnapshot({report: item.report, root: item.root, maxJobs: 1,
      validateEngine: async () => {}, verify: fakeVerify([])}), /does not match current snapshot and pinned engine/);
  } finally { await cleanup(item); }
});

test('checkpoint replacement retries transient Windows locks without deleting the old checkpoint', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'polytrack-checkpoint-retry-'));
  const source = path.join(temp, 'next.tmp'), destination = path.join(temp, 'state.json');
  try {
    await fs.writeFile(source, 'new');
    await fs.writeFile(destination, 'old');
    let attempts = 0;
    await renameCheckpointWithRetry(source, destination, async (...args) => {
      attempts++;
      if (attempts < 3) { const error = Error('sharing violation'); error.code = 'EPERM'; throw error; }
      return fs.rename(...args);
    }, async () => {});
    assert.equal(attempts, 3);
    assert.equal(await fs.readFile(destination, 'utf8'), 'new');

    await fs.writeFile(source, 'newer');
    await assert.rejects(renameCheckpointWithRetry(source, destination, async () => {
      const error = Error('permanent lock'); error.code = 'EPERM'; throw error;
    }, async () => {}), /permanent lock/);
    assert.equal(await fs.readFile(destination, 'utf8'), 'new');
    assert.equal(await fs.readFile(source, 'utf8'), 'newer');
  } finally { await fs.rm(temp, {recursive: true, force: true}); }
});
