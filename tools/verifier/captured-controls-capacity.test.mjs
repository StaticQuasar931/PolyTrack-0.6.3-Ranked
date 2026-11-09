import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {createCapturedControlReview, CAPTURED_CONTROL_LIMITS} from './captured-controls.mjs';
import {ledgerBinding} from '../native-verification-ledger.mjs';
import {verifyLocalSnapshot} from './local-snapshot-verification.mjs';
import {defaultCapturedReviewFactory} from './local-snapshot-capture.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const sourceBinding = {sourceCommit: 'a'.repeat(40), captureSha256: 'b'.repeat(64)};
const trackId = 'c'.repeat(64);
const MiB = 1024 * 1024;
const expectedLimits = {maxInputBytes: 64 * MiB, maxJobs: 100000, maxPairs: 2000000,
  maxRuntimeMs: 120000, maxEvents: 2000000, maxPostings: 2000000, maxPairWork: 8000000, maxFindings: 10000};

function makeJob(number, ownTrack = trackId) {
  const accountId = number.toString(16).padStart(64, '0');
  // One unique, valid transition per replay, not a shared payload with different IDs.
  const bytes = Buffer.alloc(18);
  bytes.writeUIntLE(1, 0, 3);
  bytes.writeUIntLE(number, 3, 3);
  const replay = deflateSync(bytes).toString('base64url');
  return {lane: 'normal', accountId, trackId: ownTrack, resultId: accountId + '_' + ownTrack,
    timeMs: 200000, frames: 200000, uploadId: number, replay, replayHash: sha(replay)};
}
const accepted = job => ({accepted: true, binding: ledgerBinding(job), sourceBinding});
const factory = (allJobs, extra = {}) => createCapturedControlReview({allJobs, sourceBinding, ...extra});

function runProbe(mode) {
  globalThis.fetch = () => assert.fail('Capacity probes must not use network');
  assert.deepEqual(CAPTURED_CONTROL_LIMITS, expectedLimits);
  const started = performance.now(), cpu = process.cpuUsage();
  let sampledPeakHeap = 0, sampledPeakRss = 0, ticks = 0;
  const sample = () => {
    const memory = process.memoryUsage();
    sampledPeakHeap = Math.max(sampledPeakHeap, memory.heapUsed);
    sampledPeakRss = Math.max(sampledPeakRss, memory.rss);
  };
  const clock = () => { if (!(ticks++ & 127)) sample(); return performance.now(); };
  sample();
  let measurements;
  if (mode === '20000' || mode === '100000') {
    const count = Number(mode), jobs = [];
    for (let number = 1; number <= count; number++) {
      jobs.push(makeJob(number));
      if (!(number & 255)) {
        sample();
        assert(performance.now() - started < 45000, 'bounded replay generation time');
      }
    }
    assert.equal(new Set(jobs.map(row => row.replayHash)).size, count, 'every replay hash is unique');
    assert.equal(new Set(jobs.map(row => row.resultId)).size, count, 'every result binding is unique');
    const previouslyAccepted = jobs.map(accepted);
    globalThis.gc();
    sample();
    const generatedAt = performance.now();
    const review = factory(jobs, {previouslyAccepted, clock});
    const constructedAt = performance.now();
    sample();
    assert.equal(typeof review, 'function');
    assert.equal(typeof review.inspect, 'function');
    // Do not invoke inspect/artifact/review: this is metadata admission, not 100k controls comparisons.
    measurements = {records: count, uniqueReplayHashes: count, acceptanceRecords: previouslyAccepted.length,
      generationMs: generatedAt - started, constructorMs: constructedAt - generatedAt,
      serializedBytes: jobs.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0)};
    assert(measurements.serializedBytes <= 64 * MiB);
    assert(measurements.constructorMs < 30000, 'unchanged default preparation deadline');
    sample();
  } else if (mode === 'overflow') {
    let touched = 0, clockCalls = 0;
    const overflow = new Array(100001);
    Object.defineProperty(overflow, Symbol.iterator, {get() { touched++; throw Error('OVERFLOW_ITERATED'); }});
    for (const options of [{allJobs: overflow}, {allJobs: [], previouslyAccepted: overflow}]) {
      assert.throws(() => createCapturedControlReview({...options, sourceBinding,
        clock: () => { clockCalls++; return performance.now(); }}), /^Error: captured_controls_input_limit$/);
    }
    assert.equal(touched, 0, 'count rejects before iteration');
    assert.equal(clockCalls, 0, 'count rejects before preparation work');
    measurements = {rejectedRecords: 100001, rejectedAcceptanceRecords: 100001, iterations: touched, clockCalls};
  } else if (mode === 'bytes') {
    const job = {...makeJob(1), padding: ''};
    job.padding = 'x'.repeat(64 * MiB - Buffer.byteLength(JSON.stringify(job)));
    assert.equal(Buffer.byteLength(JSON.stringify(job)), 64 * MiB);
    const atBoundary = performance.now(), review = factory([job], {clock});
    const boundaryMs = performance.now() - atBoundary;
    assert.equal(typeof review, 'function');
    sample();
    globalThis.gc();
    job.padding += 'x';
    // The byte check must fire before the deliberately invalid replay binding.
    job.replayHash = '0'.repeat(64);
    assert.equal(Buffer.byteLength(JSON.stringify(job)), 64 * MiB + 1);
    const overBoundary = performance.now();
    assert.throws(() => factory([job], {clock}), /^Error: captured_controls_input_limit$/);
    measurements = {acceptedBytes: 64 * MiB, rejectedBytes: 64 * MiB + 1,
      boundaryMs, rejectionMs: performance.now() - overBoundary};
    sample();
  } else throw Error('Unknown bounded capacity probe');
  sample();
  const used = process.cpuUsage(cpu);
  const result = {mode, ...measurements, elapsedMs: performance.now() - started,
    cpuMs: (used.user + used.system) / 1000, sampledPeakHeapUsedMiB: sampledPeakHeap / MiB,
    sampledPeakRssMiB: sampledPeakRss / MiB, peakRssMiB: process.resourceUsage().maxRSS / 1024,
    v8HeapLimitMiB: v8.getHeapStatistics().heap_size_limit / MiB,
    oldSpaceLimitMiB: 384, semiSpaceLimitMiB: 16, physicsDispatches: 0, replayFiles: 0, networkCalls: 0};
  assert(result.elapsedMs < 90000, 'bounded child wall time');
  assert(result.peakRssMiB < 768, 'bounded child RSS regression ceiling');
  console.log(JSON.stringify(result));
}

if (process.argv[2] === '--capacity-probe') {
  runProbe(process.argv[3]);
} else {
  test('metadata ceiling matches inventory without changing byte, event, comparison or runtime ceilings', async () => {
    assert.deepEqual(CAPTURED_CONTROL_LIMITS, expectedLimits);
    assert(Object.isFrozen(CAPTURED_CONTROL_LIMITS));
    const workflow = await fs.readFile(new URL('../../.github/workflows/publish-verified-snapshots.yml', import.meta.url), 'utf8');
    assert.match(workflow, /maxJobs:10000,maxRuntimeMs:1500000/,
      'production native dispatch remains 10000 jobs and 25 minutes');
  });

  for (const mode of ['20000', '100000', 'overflow', 'bytes']) {
    test('bounded child metadata capacity: ' + mode, {timeout: 125000}, () => {
      const child = spawnSync(process.execPath, ['--max-old-space-size=384', '--max-semi-space-size=16',
        '--expose-gc', fileURLToPath(import.meta.url), '--capacity-probe', mode], {
        timeout: 110000, maxBuffer: MiB, encoding: 'utf8', windowsHide: true,
        env: {SystemRoot: process.env.SystemRoot || '', WINDIR: process.env.WINDIR || '',
          TEMP: os.tmpdir(), TMP: os.tmpdir(), PATH: process.env.PATH || ''}
      });
      assert.equal(child.error, undefined, child.error?.message);
      assert.equal(child.signal, null);
      assert.equal(child.status, 0, child.stderr);
      const result = JSON.parse(child.stdout.trim());
      assert.equal(result.mode, mode);
      assert.equal(result.physicsDispatches, 0);
      assert.equal(result.networkCalls, 0);
      console.log('Captured controls capacity probe ' + JSON.stringify(result));
    });
  }

  test('lower count overrides and invalid overrides still fail closed', () => {
    const jobs = Array.from({length: 3}, (_, i) => makeJob(i + 1));
    assert.throws(() => factory(jobs, {limits: {maxJobs: 2}}), /captured_controls_input_limit/);
    assert.throws(() => factory([], {previouslyAccepted: jobs.map(accepted), limits: {maxJobs: 2}}), /captured_controls_input_limit/);
    for (const maxJobs of [0, -1, 1.5, 100001, NaN, Infinity])
      assert.throws(() => factory([], {limits: {maxJobs}}), /captured_controls_limits/);
    assert.equal(typeof factory(jobs, {limits: {maxJobs: 3}}), 'function');
  });

  test('constructor default runtime and late acceptance preparation checks remain effective', () => {
    const jobs = [makeJob(1)];
    let ticks = 0;
    assert.throws(() => factory(jobs, {clock: () => ticks++ ? 30001 : 0}), /captured_controls_runtime_limit/);
    let now = 0;
    const record = {...accepted(jobs[0]), get accepted() { now = 30001; return true; }};
    assert.throws(() => factory(jobs, {previouslyAccepted: [record], clock: () => now}), /captured_controls_runtime_limit/);
    assert.throws(() => factory(jobs, {limits: {maxRuntimeMs: 120001}}), /captured_controls_limits/);
  });

  test('replay character and hash binding ceilings remain independent of larger metadata count', () => {
    const job = makeJob(1), replay = 'x'.repeat(65537);
    assert.throws(() => factory([{...job, replay, replayHash: sha(replay)}]), /captured_controls_replay_binding/);
    assert.throws(() => factory([{...job, replayHash: '0'.repeat(64)}]), /captured_controls_replay_binding/);
    assert.throws(() => factory([job, job]), /captured_controls_duplicate_binding/);
  });

  test('20001-record source integration uses the real review factory while dispatch remains capped at two stubs',
    {timeout: 60000}, async t => {
    t.mock.method(globalThis, 'fetch', () => assert.fail('No network permitted'));
    const allJobs = Array.from({length: 20001}, (_, i) =>
      makeJob(i + 1, (i + 1000000).toString(16).padStart(64, '0')));
    const targets = allJobs.slice(0, 3), contentHash = 'f'.repeat(64);
    const policy = {engineDigest: 'd'.repeat(64), compatibleEngines: [],
      verifierVersion: 'polytrack-native-bounded-v1', verifierFingerprint: 'e'.repeat(64),
      resourceProfiles: ['standard', 'extended-local'], reviewPolicyVersions: ['snapshot-controls-v1'],
      trackContentHashes: Object.fromEntries(targets.map(j => [j.trackId, contentHash])),
      trackGeometries: Object.fromEntries(targets.map(j => [j.trackId,
        {geometryPolicy: 'default', trackGeometry: {parts: 20, spanX: 100, spanZ: 120}}]))};
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'captured-controls-capacity-integration-'));
    t.after(() => fs.rm(root, {recursive: true, force: true}));
    let reviewer, coverage, nativeJobs = 0, nativeCalls = 0, progress = 0;
    const review = context => reviewer(context);
    review.prepare = async context => {
      assert.equal(context.allJobs.length, 20001);
      assert(Object.isFrozen(context.allJobs));
      reviewer = await defaultCapturedReviewFactory({jobs: context.allJobs, sourceBinding: context.sourceBinding, policy});
      coverage = await reviewer.inspect();
      assert.equal(coverage.records, 20001);
      assert.equal(coverage.complete, true);
      assert.equal(coverage.stop, null);
    };
    const result = await verifyLocalSnapshot({root, ledgerRoot: path.join(root, 'ledger'),
      expectedManifestHash: null, jobs: targets, allJobs, sourceBinding, policy, review,
      validateEngine: async () => {}, verify: async (_root, batch) => {
        nativeCalls++; nativeJobs += batch.length;
        assert.equal(batch.length, 1);
        return batch.map(job => {
          const binding = {verifierVersion: policy.verifierVersion, verifierFingerprint: policy.verifierFingerprint,
            resourceProfile: 'standard', resultId: job.resultId, trackId: job.trackId, timeMs: job.timeMs,
            replayHash: job.replayHash, actualReplayHash: sha(job.replay), nativeTrackId: job.trackId,
            trackContentHash: contentHash, engineDigest: policy.engineDigest};
          return {resultId: job.resultId, trackId: job.trackId, timeMs: job.timeMs, replayHash: job.replayHash,
            status: 'verified', reason: 'native_exact_finish', deterministic: true,
            engineDigest: policy.engineDigest, trackContentHash: contentHash, ...policy.trackGeometries[job.trackId],
            binding, boundInputFingerprint: sha(JSON.stringify(binding))};
        });
      }, maxJobs: 2, batchSize: 1, maxRuntimeMs: 1500000, packReserveMs: 1000, env: {},
      onProgress: () => { progress++; }});
    assert.equal(nativeJobs, 2);
    assert.equal(nativeCalls, 2);
    assert.equal(result.counts.nativeDispatched, 2);
    assert.equal(result.counts.verified, 2);
    assert.equal(result.counts.unprocessed, 1);
    assert.equal(result.ledger.entries.length, 2);
    assert.equal(result.decisions.length, 3);
    assert(progress > 0);
    assert.equal(coverage.comparedPairs, 0, 'source integration does not trigger quadratic comparisons');
  });
}
