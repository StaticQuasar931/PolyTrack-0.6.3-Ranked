import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {buildNativeVerificationPolicy} from './native-verification-policy.mjs';
import {VERIFIER_ENGINE_DIGEST} from '../workers/ranked/src/verification.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const {verifierFingerprint} = createRequire(import.meta.url)('./verifier/verify.cjs');
const geometry = JSON.parse(fs.readFileSync(new URL('./verifier/track-geometry.json', import.meta.url)));
const track = geometry.tracks.find(row => row.name.startsWith('tracks/') && row.parts < 10000);
const witness = () => ({status:'verified', trackId:track.id, engineDigest:VERIFIER_ENGINE_DIGEST,
  trackContentHash:track.hash, geometryPolicy:'default',
  trackGeometry:{parts:track.parts, spanX:track.spanX, spanZ:track.spanZ}, binding:{verifierFingerprint}});

test('policy derives exact code pins locally and never dispatches physics or network work', t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('No network allowed'));
  const policy = buildNativeVerificationPolicy({root, results:[witness()]});
  assert.equal(policy.trackContentHashes[track.id], track.hash);
  assert.deepEqual(policy.trackGeometries[track.id].trackGeometry, witness().trackGeometry);
  assert.deepEqual(policy.compatibleEngines, []);
});

test('an invented or changed track hash cannot authorize a proof', () => {
  assert.throws(() => buildNativeVerificationPolicy({root, results:[{...witness(), trackContentHash:'f'.repeat(64)}]}), /independent asset pin/);
  assert.throws(() => buildNativeVerificationPolicy({root, results:[{...witness(), trackId:'f'.repeat(64)}]}), /independent asset pin/);
});

test('unreviewed oversized or invalid geometry is rejected under the existing physics policy', () => {
  for (const shape of [{parts:100000,spanX:1,spanZ:1}, {parts:10,spanX:-1,spanZ:1}]) {
    assert.throws(() => buildNativeVerificationPolicy({root, results:[{...witness(),trackGeometry:shape}]}), /geometry policy/);
  }
});

test('historical incompatible engine and verifier witnesses stay ineligible', () => {
  for (const result of [{...witness(),engineDigest:'f'.repeat(64)}, {...witness(),binding:{verifierFingerprint:'f'.repeat(64)}}]) {
    assert.deepEqual(buildNativeVerificationPolicy({root, results:[result]}).trackContentHashes, {});
  }
});

test('ledger witnesses reuse the same independent asset and geometry gates', () => {
  const result = witness();
  const entry = {binding:{trackId:track.id}, witnesses:[{...result,verifierFingerprint}]};
  assert.equal(buildNativeVerificationPolicy({root, entries:[entry]}).trackContentHashes[track.id],track.hash);
  entry.witnesses[0].trackContentHash = 'f'.repeat(64);
  assert.throws(() => buildNativeVerificationPolicy({root, entries:[entry]}), /independent asset pin/);
});

test('conflicting geometry witnesses do not silently select the last value', () => {
  const first = witness(), second = {...witness(),trackGeometry:{...witness().trackGeometry,parts:track.parts+1}};
  assert.throws(() => buildNativeVerificationPolicy({root, results:[first,second]}), /conflicting current track witnesses/);
});

test('unavailable and mismatch outcomes are not proof inputs', () => {
  const result = witness();
  assert.deepEqual(buildNativeVerificationPolicy({root,results:[{...result,status:'unavailable'},{...result,status:'mismatch'}]}).trackContentHashes,{});
});
