import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {buildNativeVerificationPolicy} from '../native-verification-policy.mjs';
import {loadWeeklyTrustedTrack} from './weekly-track.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const geometry = JSON.parse(fs.readFileSync(new URL('./track-geometry.json', import.meta.url)));
const {verifierFingerprint} = createRequire(import.meta.url)('./verify.cjs');
const weekly = geometry.tracks.find(row => row.name.startsWith('trusted/'));
const witness = () => ({status: 'verified', trackId: weekly.id, engineDigest: geometry.engineDigest,
  trackContentHash: weekly.hash, geometryPolicy: weekly.parts > 20000 ? 'reviewed-pinned' : 'default',
  trackGeometry: {parts: weekly.parts, spanX: weekly.spanX, spanZ: weekly.spanZ}, binding: {verifierFingerprint}});

test('result-only policy builds select independent local weekly pins', t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('No network allowed'));
  const result = witness();
  const policy = buildNativeVerificationPolicy({root, results: [result]});
  assert.equal(policy.trackContentHashes[result.trackId], result.trackContentHash);
  assert.deepEqual(policy.trackGeometries[result.trackId].trackGeometry, result.trackGeometry);
  assert.throws(() => buildNativeVerificationPolicy({root, results: [{...result, trackContentHash: 'f'.repeat(64)}]}), /independent asset pin/);
  assert.throws(() => buildNativeVerificationPolicy({root, results: [{...result, trackId: 'f'.repeat(64)}]}), /independent asset pin/);
});

test('known sources and negative results never become proof authority', () => {
  const result = witness();
  for (const status of ['unavailable', 'mismatch']) {
    const policy = buildNativeVerificationPolicy({root, results: [{...result, status}]});
    assert(policy.knownTrackIds.includes(result.trackId));
    assert.deepEqual(policy.trackContentHashes, {});
    assert.deepEqual(policy.trackGeometries, {});
  }
});

test('catalog coverage includes every ranked checked-in source but not the unranked challenge', () => {
  const core = JSON.parse(fs.readFileSync(new URL('../../tracks/catalog.json', import.meta.url))).tracks;
  const extra = JSON.parse(fs.readFileSync(new URL('../../extra-tracks/catalog.json', import.meta.url)));
  const jobs = [...core.map(row => ({trackId: row.id})), ...extra.map(row => ({trackId: row.trackId}))];
  const policy = buildNativeVerificationPolicy({root, jobs});
  for (const row of core) assert(policy.knownTrackIds.includes(row.id), row.trackUrl);
  for (const row of extra.filter(row => row.ranked !== false && !row.unranked && !row.importOnly)) {
    assert(policy.knownTrackIds.includes(row.trackId), row.trackPath);
  }
  const challenge = extra.find(row => row.trackPath === 'extra-tracks/challenges/poly-dip-2.track');
  assert(challenge);
  assert(!policy.knownTrackIds.includes(challenge.trackId));
  assert.deepEqual(loadWeeklyTrustedTrack(root, [{trackId: challenge.trackId}]), []);
  assert.deepEqual(policy.trackContentHashes, {});
});
