import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {encodeSnapshot} from './snapshot-package.mjs';
import {PERMANENT_ROLLING_HILLS as R} from '../workers/ranked/src/permanent-rolling-hills.js';
import {loadPublishedRollingCohort, proposePublishedRollingRebalance, runPublishedRollingCli} from './rebalance-published-rolling-hills.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const id = value => value.repeat(64);
function source() {
  const capture = {kind: 'captured-native-content-v1', sourceHash: id('f'), sourceHashMode: 'canonical-json', sourceUpdatedAt: 100};
  const rolling = {id: R.id, kind: 'permanent', trackId: R.trackId, scoreVersion: 'rolling-hills-live-verified-v1',
    maxRp: 1001, targetPolicy: 'live-fastest-physics-verified', targetMs: 10000, sourceRevision: 7, updatedAt: 200,
    complete: true, totalEntries: 2, sourceTotalEntries: 3, sourceCompleteness: 'captured-native-complete',
    contributions: {normalRp: true, eventRp: true}, capturedNativeSource: capture,
    entries: ['a', 'b'].map((key, i) => ({accountId: id(key), trackId: R.trackId, timeMs: 10000 * (i + 1),
      frames: 10000 * (i + 1), rank: i + 1, rp: i ? 500 : 1001, eventRpContribution: i ? 500 : 1001,
      normalRpEligible: true, physicsVerified: true, replayIntegrityVerified: true, replayHash: id('e')}))};
  const totals = {complete: true, totalEntries: 3, updatedAt: 200,
    nativeEventOverlay: {version: 'native-event-overlay-v1', source: 'trusted-published-rebase', rollingSource: capture},
    entries: [{accountId: id('a'), name: 'A', rp: 1001, events: 0, finiteEventRp: 0, permanentRollingHillsRp: 1001,
      rollingHillsEventRpContribution: 1001, rollingHillsTimeMs: 10000},
    {accountId: id('b'), name: 'B', rp: 700, events: 1, finiteEventRp: 200, permanentRollingHillsRp: 500,
      rollingHillsEventRpContribution: 500, rollingHillsTimeMs: 20000},
    {accountId: id('c'), name: 'C', rp: 300, events: 2, finiteEventRp: 300, permanentRollingHillsRp: 0}]};
  return {rolling, totals};
}

async function fixture(t, mutate = () => {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'published-rolling-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const values = source(); mutate(values);
  const directory = path.join(root, 'public-snapshots83'); await fs.mkdir(directory);
  const index = {schemaVersion: 1, generation: 83, encoding: 'gzip-xor-a7-v1', publishedAt: 300, files: {}};
  for (const [logical, value] of [['event-totals.json', values.totals], ['events/permanent-rolling-hills.json', values.rolling]]) {
    const data = await encodeSnapshot(value), digest = sha(data);
    index.files[logical] = {path: digest + '.bin', sha256: digest, decodedBytes: Buffer.byteLength(JSON.stringify(value))};
    await fs.writeFile(path.join(directory, digest + '.bin'), data);
  }
  const indexBytes = Buffer.from(JSON.stringify(index));
  await fs.writeFile(path.join(directory, 'index.json'), indexBytes);
  await fs.writeFile(path.join(root, 'snapshot-current.json'), JSON.stringify({currentdir: 'public-snapshots83'}));
  return {root, expectedGeneration: 83, expectedIndexSha256: sha(indexBytes)};
}

test('published cohort preserves historical residuals and every finite total without invented event results', async t => {
  const options = await fixture(t), cohort = await loadPublishedRollingCohort(options);
  const before = JSON.stringify(cohort), result = proposePublishedRollingRebalance(cohort);
  assert.equal(JSON.stringify(cohort), before);
  assert.deepEqual(result.changes.map(row => [row.before, row.after, row.finiteEventRp, row.events]),
    [[1001, 10101, 0, 0], [700, 1701, 200, 1], [300, 300, 300, 2]]);
  assert.equal(result.sourceScope.preservedHistoricalResidualAccounts, 2);
  assert.equal(result.sourceScope.finiteHistoryReconstructed, false);
  assert.equal(result.totals.nativeEventOverlay, undefined);
  assert.deepEqual(result, proposePublishedRollingRebalance(cohort));
  assert.throws(() => proposePublishedRollingRebalance(structuredClone(cohort)), /trusted_cohort_required/);
  assert.equal(result.rolling.capturedNativeSource.sourceHash, id('f'));
  assert.equal(result.totals.entries[0].eventHighlights[0].eventRp, 10101);
});

test('published transform uses pace at unchanged placement', async t => {
  const original=proposePublishedRollingRebalance(await loadPublishedRollingCohort(await fixture(t)));
  const options=await fixture(t,({rolling,totals})=>{
    Object.assign(rolling.entries[1],{timeMs:30000,frames:30000,rp:333,eventRpContribution:333});
    Object.assign(totals.entries[1],{rp:533,permanentRollingHillsRp:333,rollingHillsEventRpContribution:333,rollingHillsTimeMs:30000});
  });
  const slower=proposePublishedRollingRebalance(await loadPublishedRollingCohort(options));
  assert.equal(original.rolling.entries[1].rank,slower.rolling.entries[1].rank);
  assert.equal(original.rolling.entries[1].rp,1501);assert.equal(slower.rolling.entries[1].rp,667);
  assert.equal(slower.targetScoreVersion,'rolling-hills-pace-placement-v2');
});

test('exact published ties receive equal awards and retain all accounts', async t => {
  const options = await fixture(t, ({rolling, totals}) => {
    Object.assign(rolling.entries[1], {timeMs: 10000, frames: 10000, rank: 1, rp: 1001, eventRpContribution: 1001});
    Object.assign(totals.entries[1], {rp: 1201, permanentRollingHillsRp: 1001, rollingHillsEventRpContribution: 1001, rollingHillsTimeMs: 10000});
  });
  const result = proposePublishedRollingRebalance(await loadPublishedRollingCohort(options));
  assert.deepEqual(result.rolling.entries.map(row => row.rp), [10101, 10101]);
  assert.equal(result.totals.entries.length, 3);
});

test('missing components, mixed cohorts, wrong old math, held rows and duplicate accounts fail closed', async t => {
  const mutations = [
    v => delete v.totals.entries[0].finiteEventRp,
    v => delete v.totals.entries[2].permanentRollingHillsRp,
    v => v.totals.entries[1].rollingHillsEventRpContribution++,
    v => v.totals.entries[1].rollingHillsTimeMs++,
    v => v.totals.entries[2].permanentRollingHillsRp = 1,
    v => v.totals.updatedAt++, v => v.rolling.sourceTotalEntries = 1,
    v => v.rolling.scoreVersion = R.scoreVersion,
    v => v.rolling.entries[0].rp++, v => v.rolling.entries[1].rank = 1,
    v => v.rolling.entries[1].accountId = id('a'),
    v => {v.totals.nativeEventOverlay.rollingSource = {...v.rolling.capturedNativeSource, sourceHash: id('d')};},
    ...[{pending: true}, {playbackPending: true}, {needsReview: true}, {reviewHold: true}, {verified: false},
      {physicsVerified: false}, {replayIntegrityVerified: false}, {verificationStatus: 'waiting'}, {eventRpEligible: false}]
      .map(patch => v => Object.assign(v.rolling.entries[0], patch))];
  for (const mutate of mutations) await assert.rejects(loadPublishedRollingCohort(await fixture(t, mutate)));
});

test('independent hash pins, exact output receipts and overwrite refusal', async t => {
  const options = await fixture(t);
  await assert.rejects(loadPublishedRollingCohort({...options, expectedIndexSha256: id('0')}), /index SHA256 mismatch/);
  await assert.rejects(loadPublishedRollingCohort({...options, expectedGeneration: 82}), /immediately previous/);
  const out = path.join(options.root, 'proposal');
  const args = ['--root', options.root, '--generation', '83', '--index-sha256', options.expectedIndexSha256, '--out', out];
  const receipt = await runPublishedRollingCli(args);
  for (const [name, record] of Object.entries(receipt.outputs)) {
    const data = await fs.readFile(path.join(out, name)); assert.equal(sha(data), record.sha256); assert.equal(data.length, record.bytes);
  }
  assert.equal(receipt.publicationPerformed, false); assert.equal(receipt.databaseReads, 0); assert.equal(receipt.databaseWrites, 0);
  assert.deepEqual(receipt.changes, {increased: 2, decreased: 0, unchanged: 1});
  await assert.rejects(runPublishedRollingCli(args), {code: 'EEXIST'});
  const directory = path.join(options.root, 'public-snapshots83');
  const index = JSON.parse(await fs.readFile(path.join(directory, 'index.json')));
  await fs.appendFile(path.join(directory, index.files['events/permanent-rolling-hills.json'].path), 'bad');
  await assert.rejects(loadPublishedRollingCohort(options), /board_hash_mismatch/);
});
