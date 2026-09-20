'use strict';

const crypto = require('node:crypto');
const zlib = require('node:zlib');

const LIMITS = Object.freeze({
  jobs: 16,
  replayCharacters: 65536,
  compressedBytes: 49152,
  inflatedBytes: 30015,
  transitionsPerChannel: 4096,
  transitions: 10000,
  frames: 300000,
  scanWork: 30000000,
  trackBytes: 262144,
  trackParts: 20000,
  trackSpan: 2048,
  assetBytes: 16777216,
  snapshotBytes: 134217728,
  assetFiles: 4096,
  wallMs: 45000,
  cpuMs: 20000,
});

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
class Rejection extends Error {
  constructor(reason, status = 'mismatch') {
    super(reason);
    this.reason = reason;
    this.status = status;
  }
}

function linearScanWork(lists, timeMs) {
  let work = timeMs * 5;
  for (const name of ['up', 'right', 'down', 'left', 'reset']) {
    const frames = lists[name];
    for (let i = 0; i < frames.length; i++) {
      // Native lookup restarts at index zero; element i is visited only AFTER i-1's tick.
      work += Math.max(0, timeMs - (i === 0 ? 0 : frames[i - 1] + 1));
    }
  }
  return work;
}

function decodeReplay(replay, timeMs) {
  if (typeof replay !== 'string' || !replay.length) throw new Rejection('invalid_replay_type');
  if (replay.length > LIMITS.replayCharacters) throw new Rejection('replay_size_limit', 'unavailable');
  if (!/^[A-Za-z0-9_-]+$/.test(replay) || replay.length % 4 === 1) throw new Rejection('invalid_base64url');
  const compressed = Buffer.from(replay, 'base64url');
  if (compressed.toString('base64url') !== replay) throw new Rejection('noncanonical_base64url');
  if (compressed.length > LIMITS.compressedBytes) throw new Rejection('compressed_size_limit', 'unavailable');
  let inflated;
  try {
    inflated = zlib.inflateSync(compressed, { maxOutputLength: LIMITS.inflatedBytes, info: true });
  } catch (error) {
    if (error.code === 'ERR_BUFFER_TOO_LARGE') throw new Rejection('inflated_size_limit', 'unavailable');
    throw new Rejection('invalid_zlib');
  }
  // Reject appended streams/garbage, not just trailing bytes in the inflated payload.
  if (inflated.engine.bytesWritten !== compressed.length) throw new Rejection('trailing_compressed_bytes');
  const bytes = inflated.buffer;
  const lists = {};
  let cursor = 0;
  let total = 0;
  for (const name of ['up', 'right', 'down', 'left', 'reset']) {
    if (cursor + 3 > bytes.length) throw new Rejection('truncated_transition_count');
    const count = bytes.readUIntLE(cursor, 3);
    cursor += 3;
    if (cursor + count * 3 > bytes.length) throw new Rejection('truncated_transition_list');
    if (count > LIMITS.transitionsPerChannel || total + count > LIMITS.transitions) {
      throw new Rejection('transition_limit', 'unavailable');
    }
    const frames = [];
    let frame = 0;
    for (let i = 0; i < count; i++) {
      const delta = bytes.readUIntLE(cursor, 3);
      cursor += 3;
      if (i > 0 && delta === 0) throw new Rejection('non_increasing_transitions');
      frame += delta;
      if (frame > 5999999) throw new Rejection('native_frame_limit');
      if (frame > LIMITS.frames) throw new Rejection('frame_limit', 'unavailable');
      if (frame > timeMs) throw new Rejection('transition_after_claim');
      frames.push(frame);
    }
    total += count;
    lists[name] = frames;
  }
  if (cursor !== bytes.length) throw new Rejection('trailing_transition_bytes');
  const scanWork = linearScanWork(lists, timeMs);
  if (scanWork > LIMITS.scanWork) throw new Rejection('scan_work_limit', 'unavailable');
  return { lists, transitions: total, inflatedBytes: bytes.length, scanWork };
}

function checkJob(job) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) throw new Rejection('invalid_job', 'unavailable');
  if (typeof job.resultId !== 'string' || !job.resultId.length || job.resultId.length > 512) {
    throw new Rejection('invalid_result_id', 'unavailable');
  }
  if (typeof job.trackId !== 'string' || !/^[a-f0-9]{64}$/.test(job.trackId)) throw new Rejection('invalid_track_id', 'unavailable');
  if (!Number.isSafeInteger(job.timeMs) || job.timeMs <= 0) throw new Rejection('invalid_time', 'unavailable');
  if (job.timeMs > LIMITS.frames) throw new Rejection('time_limit', 'unavailable');
  if (typeof job.replayHash !== 'string' || !/^[a-f0-9]{64}$/.test(job.replayHash)) throw new Rejection('invalid_replay_hash', 'unavailable');
  if (typeof job.replay !== 'string' || job.replay.length > LIMITS.replayCharacters) throw new Rejection('replay_size_limit', 'unavailable');
  if (sha256(job.replay) !== job.replayHash) throw new Rejection('replay_hash_mismatch', 'unavailable');
  return decodeReplay(job.replay, job.timeMs);
}

module.exports = { LIMITS, sha256, Rejection, decodeReplay, checkJob, linearScanWork };
