import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {createRequire} from 'node:module';
import {inspectReplayEligibility} from './replay-eligibility.mjs';

const {LIMITS, EXTENDED_LOCAL_LIMITS, checkJob} = createRequire(import.meta.url)('./replay.cjs');
const sha = value => createHash('sha256').update(value).digest('hex');
function job(timeMs, frames = []) {
  const bytes = Buffer.alloc(15 + frames.length * 3);
  bytes.writeUIntLE(frames.length, 0, 3);
  frames.forEach((frame, index) => bytes.writeUIntLE(frame - (index ? frames[index - 1] : 0), 3 + index * 3, 3));
  const replay = deflateSync(bytes).toString('base64url');
  return {resultId: 'fixture', trackId: 'a'.repeat(64), timeMs, replay, replayHash: sha(replay)};
}

test('diagnostic selects only existing profiles and requires extended opt-in', () => {
  assert.equal(inspectReplayEligibility(job(1000)).selectedProfile, 'standard');
  assert.equal(inspectReplayEligibility(job(400000)).selectedProfile, null);
  assert.equal(inspectReplayEligibility(job(400000), {allowExtendedLocal: 'true'}).selectedProfile, null);
  assert.equal(inspectReplayEligibility(job(400000), {allowExtendedLocal: true}).selectedProfile, 'extended-local');
  assert.equal(LIMITS.frames, 300000);
  assert.equal(EXTENDED_LOCAL_LIMITS.frames, 3600000);
  assert.equal(EXTENDED_LOCAL_LIMITS.jobs, 1);
  assert.equal(EXTENDED_LOCAL_LIMITS.wallMs, 120000);
  assert.equal(EXTENDED_LOCAL_LIMITS.cpuMs, 90000);
});

test('3,803,964-frame diagnosis cannot promote a run or widen limits even below the work cap', () => {
  const input = job(3803964, [0, 3803236]), before = structuredClone(input);
  const result = inspectReplayEligibility(input, {allowExtendedLocal: true});
  assert.equal(result.selectedProfile, null);
  assert.equal(result.nativeSimulationPerformed, false);
  assert.equal(result.verificationGranted, false);
  assert(result.profiles.every(row => !row.eligible && row.reason === 'time_limit'));
  assert.equal(result.analysis.exceedsExtendedFrameLimit, true);
  assert.deepEqual(result.analysis.extendedNonTimeBlockers, []);
  assert.equal(result.analysis.runtimeMeasured, false);
  assert.deepEqual(input, before);
  assert.throws(() => checkJob(input, 'extended-local'), {reason: 'time_limit'});
});

test('authenticated analysis rejects tampering and malformed original payloads', () => {
  const input = job(3803964);
  assert.equal(inspectReplayEligibility({...input, replayHash: 'b'.repeat(64)}).analysis.reason, 'replay_hash_mismatch');
  for (const replay of ['!', 'not-a-replay']) {
    const result = inspectReplayEligibility({...input, replay, replayHash: sha(replay)});
    assert(result.analysis.reason);
    assert.equal(result.selectedProfile, null);
  }
  assert.equal(inspectReplayEligibility(job(3803964, [3803965])).analysis.reason, 'transition_after_claim');
  assert.equal(inspectReplayEligibility(job(6000000)).analysis.reason, 'analysis_time_limit');
});

test('non-time work and transition blockers remain visible without dispatching physics', () => {
  const transition = inspectReplayEligibility(job(3803964, Array.from({length: 10001}, (_, i) => i)));
  assert(transition.analysis.extendedNonTimeBlockers.includes('transition_limit'));
  assert(transition.analysis.extendedNonTimeBlockers.includes('scan_work_limit'));
  const work = inspectReplayEligibility(job(3803964, Array.from({length: 3000}, (_, i) => i)));
  assert.deepEqual(work.analysis.extendedNonTimeBlockers, ['scan_work_limit']);
  assert.equal(work.selectedProfile, null);
  assert.equal(work.verificationGranted, false);
});
