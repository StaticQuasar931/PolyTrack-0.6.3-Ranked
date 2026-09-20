'use strict';

// Safe for public CI: all recordings below are generated empty/control byte arrays.
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { decodeReplay, checkJob, sha256, LIMITS } = require('./replay.cjs');
const { canonicalBytes } = require('./assets.cjs');
const encode = bytes => zlib.deflateSync(bytes).toString('base64url');

test('synthetic five empty channels decode exactly', () => {
  assert.deepEqual(decodeReplay(encode(Buffer.alloc(15)), 100).lists,
    { up: [], right: [], down: [], left: [], reset: [] });
});
test('malformed and trailing input fail closed', () => {
  for (const replay of ['+', 'AB', encode(Buffer.alloc(14)), encode(Buffer.alloc(16))]) {
    assert.throws(() => decodeReplay(replay, 100));
  }
});
test('inflation cap defers rather than accuses', () => {
  assert.throws(() => decodeReplay(encode(Buffer.alloc(LIMITS.inflatedBytes + 1)), 100),
    error => error.status === 'unavailable' && error.reason === 'inflated_size_limit');
});
test('strict frame ordering rejects duplicate transitions', () => {
  const bytes = Buffer.alloc(21);
  bytes.writeUIntLE(2, 0, 3);
  assert.throws(() => decodeReplay(encode(bytes), 100), error => error.reason === 'non_increasing_transitions');
});
test('original-string hash is required', () => {
  const replay = encode(Buffer.alloc(15));
  const job = { resultId: 'synthetic', trackId: '0'.repeat(64), timeMs: 100, replay, replayHash: sha256(replay) };
  assert.equal(checkJob(job).transitions, 0);
  assert.throws(() => checkJob({ ...job, replayHash: '0'.repeat(64) }), error => error.reason === 'replay_hash_mismatch');
});
test('LF and CRLF text hash identically; binary bytes are preserved', () => {
  for (const name of ['x.js', 'x.json', 'x.svg', 'x.track']) {
    assert.equal(sha256(canonicalBytes(name, Buffer.from('a\r\nb\rc'))), sha256(Buffer.from('a\nb\nc')));
  }
  const binary = Buffer.from([0, 13, 10, 255]);
  assert.deepEqual(canonicalBytes('physics.wasm', binary), binary);
});
