'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {sameHashMap} = require('./engine-pin.cjs');
const a = 'a'.repeat(64), b = 'b'.repeat(64);

test('exact pin maps accept different insertion orders', () => {
  assert.equal(sameHashMap({'tracks/a':a, 'tracks/b':b}, {'tracks/b':b, 'tracks/a':a}), true);
});
test('pin maps reject changed hashes, missing, added and renamed paths', () => {
  const pinned = {'tracks/a':a, 'tracks/b':b};
  for (const candidate of [
    {'tracks/a':b, 'tracks/b':b}, {'tracks/a':a},
    {...pinned, 'tracks/c':a}, {'tracks/c':a, 'tracks/b':b}
  ]) assert.equal(sameHashMap(candidate, pinned), false);
});
test('malformed maps and noncanonical hashes fail closed', () => {
  for (const value of [null, undefined, [], 'text', 1]) {
    assert.equal(sameHashMap(value, {}), false);
    assert.equal(sameHashMap({}, value), false);
  }
  for (const hash of [null, 1, 'A'.repeat(64), 'a'.repeat(63), a+' ', a+'\n', 'not-a-hash'])
    assert.equal(sameHashMap({track:hash}, {track:hash}), false);
  assert.equal(sameHashMap({track:a}, Object.create({track:a})), false);
});
test('workflow gate accepts actual pinned repository assets', async () => {
  const {validateEnginePin} = await import('./run.mjs');
  await validateEnginePin();
});
test('native verifier uses exact unordered comparison and fingerprints its helper', () => {
  const source = fs.readFileSync(path.join(__dirname, 'verify.cjs'), 'utf8');
  assert.ok(source.includes('!sameHashMap(pin.tracks, engine.tracks)'));
  assert.ok(source.includes("['verify.cjs', 'engine-pin.cjs', 'assets.cjs',"));
  assert.ok(source.includes('sha256(JSON.stringify(pin.files)) !== pin.engineDigest'));
});
