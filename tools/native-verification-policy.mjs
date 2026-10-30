import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {VERIFIER_ENGINE_DIGEST, VERIFIER_VERSION} from '../workers/ranked/src/verification.js';
import {loadWeeklyTrustedTrack} from './verifier/weekly-track.mjs';

const require = createRequire(import.meta.url);
const {verifierFingerprint} = require('./verifier/verify.cjs');
const {geometryDecision} = require('./verifier/geometry.cjs');
const HASH = /^[a-f0-9]{64}$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const fail = message => {throw Error('Native verification policy: ' + message);};

// Code hashes come from reviewed local assets, never from a replay's own claims.
export function buildNativeVerificationPolicy({root, jobs = [], results = [], entries = [],
  reviewPolicyVersions = ['snapshot-controls-v1']} = {}) {
  if (!path.isAbsolute(root || '') || ![jobs, results, entries].every(Array.isArray)) fail('invalid input');
  const manifest = read(path.join(root, 'tools/verifier/engine-manifest.json'));
  if (manifest.engineDigest !== VERIFIER_ENGINE_DIGEST) fail('engine pin mismatch');
  const geometry = read(path.join(root, 'tools/verifier/track-geometry.json'));
  const extra = read(path.join(root, 'extra-tracks/catalog.json'));
  const artifacts = new Map();
  const add = (id, name, hash, trusted = false) => {
    if (!HASH.test(id || '') || !HASH.test(hash || '')) fail('invalid artifact identity');
    const list = artifacts.get(id) || [];
    list.push({id, name, hash, trusted}); artifacts.set(id, list);
  };
  const addStatic = (id, name, hash) => {
    if (!/^(?:tracks|extra-tracks\/track-data)\/[A-Za-z0-9_./-]+\.track$/.test(name || '') ||
      name.split('/').includes('..') || manifest.tracks?.[name] !== hash) fail('static artifact pin mismatch');
    if (digest(fs.readFileSync(path.join(root, name))) !== hash) fail('static artifact bytes changed');
    add(id, name, hash);
  };
  for (const row of geometry.tracks || []) {
    if (row.name === 'trusted/' + row.id + '.track') continue;
    addStatic(row.id, row.name, row.hash);
  }
  for (const row of extra) {
    const hash = manifest.tracks?.[row.trackPath];
    if (hash === undefined) continue;
    addStatic(row.trackId, row.trackPath, hash);
  }
  const hints = [...jobs, ...entries.map(entry => ({trackId: entry.binding?.trackId}))];
  for (const row of loadWeeklyTrustedTrack(root, hints)) add(row.trackId, 'trusted/' + row.trackId + '.track', row.codeHash, true);
  const trackContentHashes = {}, trackGeometries = {};
  const witnesses = [...results.filter(row => row?.status === 'verified').map(row => ({
    trackId: row.trackId, trackContentHash: row.trackContentHash, trackGeometry: row.trackGeometry,
    geometryPolicy: row.geometryPolicy, engineDigest: row.engineDigest,
    verifierFingerprint: row.binding?.verifierFingerprint
  })), ...entries.flatMap(entry => (entry.witnesses || []).map(witness => ({...witness, trackId: entry.binding?.trackId})))];
  for (const witness of witnesses) {
    // Incompatible historical approvals remain stored, but cannot authorize this build.
    if (witness.engineDigest !== VERIFIER_ENGINE_DIGEST || witness.verifierFingerprint !== verifierFingerprint) continue;
    const artifact = artifacts.get(witness.trackId)?.find(row => row.hash === witness.trackContentHash);
    if (!artifact) fail('native content has no independent asset pin');
    const decision = geometryDecision({...artifact, geometry: witness.trackGeometry || {}}, VERIFIER_ENGINE_DIGEST);
    if (decision.reason || decision.geometryPolicy !== witness.geometryPolicy) fail('geometry policy mismatch');
    const shape = {geometryPolicy: witness.geometryPolicy, trackGeometry: witness.trackGeometry};
    if (trackContentHashes[witness.trackId] && (trackContentHashes[witness.trackId] !== witness.trackContentHash ||
      JSON.stringify(trackGeometries[witness.trackId]) !== JSON.stringify(shape))) fail('conflicting current track witnesses');
    trackContentHashes[witness.trackId] = witness.trackContentHash;
    trackGeometries[witness.trackId] = shape;
  }
  return {engineDigest: VERIFIER_ENGINE_DIGEST, compatibleEngines: [], verifierVersion: VERIFIER_VERSION,
    verifierFingerprint, resourceProfiles: ['standard', 'extended-local'], reviewPolicyVersions,
    trackContentHashes, trackGeometries, knownTrackIds:[...artifacts.keys()].sort()};
}
