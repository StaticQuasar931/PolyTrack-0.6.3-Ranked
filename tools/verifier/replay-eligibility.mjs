import {createRequire} from 'node:module';
import {decodeAnalysisReplay} from './analysis-replay-decoder.mjs';

const {checkJob, LIMITS, EXTENDED_LOCAL_LIMITS, sha256, linearScanWork} = createRequire(import.meta.url)('./replay.cjs');

// Read-only diagnostics. Analysis can explain a rejection, never authorize physics.
export function inspectReplayEligibility(job, {allowExtendedLocal = false} = {}) {
  const profiles = ['standard', 'extended-local'].map(profile => {
    try {
      checkJob(job, profile);
      return {profile, eligible: true, reason: null};
    } catch (error) {
      return {profile, eligible: false, reason: error.reason || 'input_validation_failed'};
    }
  });
  const selectedProfile = profiles[0].eligible ? 'standard' :
    allowExtendedLocal === true && profiles[1].eligible ? 'extended-local' : null;
  const output = {nativeSimulationPerformed: false, verificationGranted: false,
    selectedProfile, profiles, analysis: null};
  try {
    if (typeof job?.replay !== 'string' || !job.replay.length || job.replay.length > LIMITS.replayCharacters) {
      throw Error('replay_size_limit');
    }
    if (sha256(job.replay) !== job.replayHash) throw Error('replay_hash_mismatch');
    const decoded = decodeAnalysisReplay(job.replay, job.timeMs);
    const compressedBytes = Buffer.from(job.replay, 'base64url').length;
    const scanWork = linearScanWork(decoded.lists, job.timeMs);
    const channelTransitions = Object.fromEntries(Object.entries(decoded.lists).map(([key, frames]) => [key, frames.length]));
    const limits = EXTENDED_LOCAL_LIMITS;
    const nonTimeBlockers = [];
    if (compressedBytes > limits.compressedBytes) nonTimeBlockers.push('compressed_size_limit');
    if (decoded.inflatedBytes > limits.inflatedBytes) nonTimeBlockers.push('inflated_size_limit');
    if (decoded.transitions > limits.transitions || Object.values(channelTransitions).some(count => count > limits.transitionsPerChannel)) {
      nonTimeBlockers.push('transition_limit');
    }
    if (scanWork > limits.scanWork) nonTimeBlockers.push('scan_work_limit');
    output.analysis = {authenticatedReplayBytes: true, timeMs: job.timeMs,
      replayCharacters: job.replay.length, compressedBytes, inflatedBytes: decoded.inflatedBytes,
      transitions: decoded.transitions, channelTransitions, scanWork,
      extendedFrameLimit: limits.frames, exceedsExtendedFrameLimit: job.timeMs > limits.frames,
      extendedNonTimeBlockers: nonTimeBlockers,
      runtimeMeasured: false};
  } catch (error) {
    output.analysis = {reason: error.reason || error.message, runtimeMeasured: false};
  }
  return output;
}
