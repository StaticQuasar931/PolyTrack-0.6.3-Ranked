'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { sha256 } = require('./replay.cjs');
const { verifyBatch } = require('./verify.cjs');

const root = path.resolve(__dirname, '../..');
const jealousyPath = path.join(root, 'events/kodub/assets/84129c91045797a07a0b2c5bb5337ca946c80b63ac68287b32704a81c4bf77ba.track');
const jealousyCode = fs.readFileSync(jealousyPath, 'utf8').trim();
const validCode = fs.readFileSync(path.join(root, 'tracks/community/4_seasons.track'), 'utf8').trim();
const validId = 'a'.repeat(64);
const unreviewedJealousyId = 'b'.repeat(64);

function invalidReplayJob(trackId, resultId) {
  const replay = 'not-a-replay';
  return { trackId, resultId, timeMs: 1, replay, replayHash: sha256(replay) };
}

test('oversized trusted payload only poisons its own jobs and never falls back to static code', async () => {
  const validTrack = { trackId: validId, code: validCode, codeHash: sha256(validCode) };
  const oversizedTrack = {
    trackId: unreviewedJealousyId, code: jealousyCode, codeHash: sha256(jealousyCode),
  };
  const jobs = [
    invalidReplayJob(validId, 'valid-track'),
    invalidReplayJob(unreviewedJealousyId, 'jealousy-track'),
  ];
  const output = await verifyBatch(root, jobs, [validTrack, oversizedTrack]);

  assert.equal(output[0].reason, 'invalid_zlib');
  assert.equal(output[1].status, 'unavailable');
  assert.equal(output[1].reason, 'trusted_track_inflated_size_limit');
  assert.equal(output[1].trackContentHash, null);
  assert.equal(output[1].binding.nativeTrackId, null);
  assert.equal(output[1].boundInputFingerprint, sha256(JSON.stringify(output[1].binding)));
});

test('a trusted code hash mismatch is isolated and keeps the job input fingerprint', async () => {
  const badHash = { trackId: validId, code: validCode, codeHash: '0'.repeat(64) };
  const job = invalidReplayJob(validId, 'hash-mismatch');
  const [result] = await verifyBatch(root, [job], [badHash]);

  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'trusted_track_hash_mismatch');
  assert.equal(result.boundInputFingerprint, sha256(JSON.stringify(result.binding)));
  assert.equal(result.boundinputfingerprint, result.boundInputFingerprint);
});

test('duplicate and extraneous trusted descriptors remain batch-wide failures', async () => {
  const descriptor = { trackId: validId, code: validCode, codeHash: sha256(validCode) };
  const job = invalidReplayJob(validId, 'structural-failure');

  for (const [tracks, expected] of [
    [[descriptor, descriptor], 'duplicate_trusted_track'],
    [[{ ...descriptor, trackId: 'b'.repeat(64) }], 'extraneous_trusted_track'],
  ]) {
    const [result] = await verifyBatch(root, [job], tracks);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, expected);
  }
});
