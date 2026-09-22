'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const test = require('node:test');
const assert = require('node:assert/strict');
const { LIMITS, sha256 } = require('./replay.cjs');
const { normalizeTrustedTracks, _internals: trackInternals } = require('./kodub-track.cjs');
const { _internals } = require('./verify.cjs');

const id = 'a'.repeat(64);
const realCode = fs.readFileSync(path.join(__dirname, '../../tracks/community/4_seasons.track'), 'utf8').trim();
const realV1Code = fs.readFileSync(path.join(__dirname, '../../tracks/community/90_reset.track'), 'utf8').trim();
const descriptor = { trackId: id, code: realCode, codeHash: sha256(realCode) };
const laRivieraId = '5c891c15c754987ff7e1358000f265d26aa959716c443dec80f668762c3d83d7';
const laRivieraCode = fs.readFileSync(path.join(__dirname, '../../events/kodub/assets/aa5e949dbd8e18caab0fc3697f9ef10c72cf1d5acccfd0b9d618663f35131542.track'), 'utf8');
const laRiviera = {trackId: laRivieraId, code: laRivieraCode, codeHash: sha256(laRivieraCode)};

function packedValue(bytes, bit) {
  const byte = Math.floor(bit / 8);
  const offset = bit - byte * 8;
  if (offset <= 2 || byte >= bytes.length - 1) return (bytes[byte] & 63 << offset) >>> offset;
  return (bytes[byte] & 63 << offset) >>> offset |
    (bytes[byte + 1] & 63 >>> (8 - offset)) << (8 - offset);
}

function encodePacked(value) {
  const bytes = Buffer.from(value);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let bit = 0;
  let output = '';
  while (bit < bytes.length * 8) {
    const value = packedValue(bytes, bit);
    if (30 & ~value) { output += alphabet[value]; bit += 6; }
    else { output += alphabet[value & 31]; bit += 5; }
  }
  return output;
}

function exportCode(payload, version = 2) {
  const inner = encodePacked(zlib.deflateSync(payload));
  return `PolyTrack${version}${encodePacked(zlib.deflateSync(Buffer.from(inner, 'ascii')))}`;
}

function emptyV2Payload(groups = []) {
  const header = Buffer.alloc(18);
  header[17] = 1 | 1 << 2 | 1 << 4;
  const encoded = groups.map(({ part, count, records = Buffer.alloc(0) }) => {
    const group = Buffer.alloc(5);
    group[0] = part;
    group.writeUInt32LE(count, 1);
    return Buffer.concat([group, records]);
  });
  return Buffer.concat([header, ...encoded]);
}

test('trusted tracks require an explicit independent code hash and leased job id', () => {
  const [source] = normalizeTrustedTracks([descriptor], new Set([id]));
  assert.deepEqual(source, {
    expectedId: id,
    name: `trusted/${id}.track`,
    hash: descriptor.codeHash,
    text: realCode,
    trusted: true,
  });
  assert(Object.isFrozen(source));
  assert.deepEqual(normalizeTrustedTracks(undefined, new Set([id])), []);
});

test('real exported track is decoded and counted within existing caps', () => {
  const result = trackInternals.preflightTrackCode(realCode);
  assert.equal(result.version, 2);
  assert(result.parts > 0 && result.parts <= LIMITS.trackParts);
  assert(result.inflatedBytes > 0 && result.inflatedBytes <= trackInternals.TRACK_PREFLIGHT_LIMITS.payloadBytes);
  assert(Object.isFrozen(result));
  const legacy = trackInternals.preflightTrackCode(realV1Code);
  assert.equal(legacy.version, 1);
  assert(legacy.parts > 0 && legacy.parts <= LIMITS.trackParts);
});

test('La Riviera part-cap exception requires the exact reviewed ID and content hash', () => {
  assert.throws(() => trackInternals.preflightTrackCode(laRivieraCode), /trusted_track_part_limit/);
  const [source] = normalizeTrustedTracks([laRiviera], new Set([laRivieraId]));
  assert.equal(source.expectedId, laRivieraId);
  assert.equal(source.hash, laRiviera.codeHash);
  assert.equal(trackInternals.preflightTrackCode(laRivieraCode, 42781).parts, 42781);
  const unreviewedId = 'b'.repeat(64);
  assert.throws(() => normalizeTrustedTracks([{...laRiviera, trackId: unreviewedId}], new Set([unreviewedId])), /trusted_track_part_limit/);
});

test('job-supplied code is never admitted implicitly', () => {
  const hostileJob = { trackId: id, code: realCode, codeHash: descriptor.codeHash };
  assert.deepEqual(normalizeTrustedTracks(undefined, new Set([hostileJob.trackId])), []);
});

test('hostile trusted-track descriptors fail closed before native decoding', () => {
  const other = 'b'.repeat(64);
  const cases = [
    [[{ ...descriptor, codeHash: '0'.repeat(64) }], new Set([id]), /hash_mismatch/],
    [[descriptor, descriptor], new Set([id]), /duplicate/],
    [[descriptor], new Set([other]), /extraneous/],
    [[{ ...descriptor, code: '<script>' + 'A'.repeat(64) }], new Set([id]), /invalid_trusted_track_code/],
    [[{ ...descriptor, code: 'PolyTrack2' + 'A'.repeat(LIMITS.trackBytes) }], new Set([id]), /size_limit/],
    [[{ ...descriptor, trackId: 'A'.repeat(64) }], new Set([id]), /invalid_trusted_track/],
    [[{ ...descriptor, code: 'PolyTrack9' + realCode.slice(10), codeHash: sha256('PolyTrack9' + realCode.slice(10)) }], new Set([id]), /invalid_trusted_track_code/],
  ];
  for (const [tracks, jobs, expected] of cases) assert.throws(() => normalizeTrustedTracks(tracks, jobs), expected);
});

test('both decompression stages and native part count are bounded before construction', () => {
  const limits = trackInternals.TRACK_PREFLIGHT_LIMITS;
  const outerBomb = 'PolyTrack2' + encodePacked(zlib.deflateSync(Buffer.alloc(limits.innerTextBytes + 1, 65)));
  assert(outerBomb.length < LIMITS.trackBytes);
  assert.throws(() => trackInternals.preflightTrackCode(outerBomb), /trusted_track_inflated_size_limit/);

  const finalBomb = exportCode(Buffer.alloc(limits.payloadBytes + 1));
  assert(finalBomb.length < LIMITS.trackBytes);
  assert.throws(() => trackInternals.preflightTrackCode(finalBomb), /trusted_track_inflated_size_limit/);

  const tooManyParts = exportCode(emptyV2Payload([{ part: 0, count: LIMITS.trackParts + 1 }]));
  assert(tooManyParts.length < LIMITS.trackBytes);
  assert.throws(() => trackInternals.preflightTrackCode(tooManyParts), /trusted_track_part_limit/);
});

test('verdict projects the trusted track hash at top level and in its binding', () => {
  const hash = 'c'.repeat(64);
  const result = _internals.verdict({ resultId: 'result', trackId: id, timeMs: 1,
    replayHash: 'd'.repeat(64), replay: '' }, 'unavailable', 'test',
  { engineFingerprint: 'engine' }, { id, hash });
  assert.equal(result.trackContentHash, hash);
  assert.equal(result.binding.trackContentHash, hash);
});

test('native catalog enforces exact identity, start, geometry, and bounds for trusted code', async () => {
  const ids = ['1', '2', '3', '4'].map(value => value.repeat(64));
  const decoded = new Map([
    ['valid', { id: ids[0], parts: 11448, start: true, spanX: 100, spanZ: 200 }],
    ['wrong-id', { id: 'f'.repeat(64), parts: 1, start: true, spanX: 1, spanZ: 1 }],
    ['too-large', { id: ids[2], parts: LIMITS.trackParts + 1, start: true, spanX: 1, spanZ: 1 }],
    ['no-start', { id: ids[3], parts: 1, start: false, spanX: 1, spanZ: 1 }],
  ]);
  class Track {
    static fromExportString(text) {
      const value = decoded.get(text);
      if (!value) return null;
      return { trackData: {
        getId: () => value.id,
        getStartTransform: () => value.start ? {} : null,
        getBounds: () => ({ min: { x: 0, y: 0 }, max: { x: value.spanX, y: value.spanZ } }),
        numberOfParts: value.parts,
      } };
    }
  }
  const page = {
    on() {},
    addInitScript: async () => {},
    goto: async () => {},
    waitForFunction: async () => {},
    evaluate: async (operation, argument) => {
      if (!argument) return null;
      globalThis.__vrRequire = () => ({ A: Track });
      return operation(argument);
    },
  };
  const context = {
    route: async () => {}, routeWebSocket: async () => {}, newPage: async () => page,
  };
  const session = { browser: { newContext: async () => context } };
  const sources = ['valid', 'wrong-id', 'too-large', 'no-start'].map((text, index) => ({
    expectedId: ids[index], name: `trusted/${ids[index]}.track`, hash: sha256(text), text, trusted: true,
  }));
  const catalog = await _internals.initialize(session, { files: new Map(), engineFingerprint: 'test-engine' }, 'http://127.0.0.1', sources);
  assert.equal(catalog.get(ids[0]).reason, null);
  assert.deepEqual(catalog.get(ids[0]).geometry, { parts: 11448, spanX: 100, spanZ: 200 });
  assert.equal(catalog.get(ids[1]).reason, 'track_identity_mismatch');
  assert.equal(catalog.get(ids[2]).reason, 'track_geometry_limit');
  assert.equal(catalog.get(ids[3]).reason, 'track_missing_start');
  delete globalThis.__vrRequire;
  delete globalThis.__tracks;
});

test('La Riviera matches only its pinned native identity, hash, and measured geometry', async () => {
  class Track {
    static fromExportString(text) {
      if (text !== laRivieraCode) return null;
      return {trackData: {
        getId: () => laRivieraId,
        getStartTransform: () => ({}),
        getBounds: () => ({min: {x: 0, y: 0}, max: {x: 607, y: 588}}),
        numberOfParts: 42781,
      }};
    }
  }
  const page = {
    on() {}, addInitScript: async () => {}, goto: async () => {}, waitForFunction: async () => {},
    evaluate: async (operation, argument) => {
      if (!argument) return null;
      globalThis.__vrRequire = () => ({A: Track});
      return operation(argument);
    },
  };
  const context = {route: async () => {}, routeWebSocket: async () => {}, newPage: async () => page};
  const session = {browser: {newContext: async () => context}};
  const geometry = require('./track-geometry.json');
  const catalog = await _internals.initialize(session,
    {files: new Map(), engineFingerprint: geometry.engineDigest}, 'http://127.0.0.1', [{
      expectedId: laRivieraId, name: `trusted/${laRivieraId}.track`, hash: laRiviera.codeHash,
      text: laRivieraCode, trusted: true,
    }]);
  const track = catalog.get(laRivieraId);
  assert.equal(track.reason, null);
  assert.equal(track.geometryPolicy, 'reviewed-pinned');
  assert.deepEqual(track.geometry, {parts: 42781, spanX: 607, spanZ: 588});
  const forgedCatalog = await _internals.initialize(session,
    {files: new Map(), engineFingerprint: geometry.engineDigest}, 'http://127.0.0.1', [{
      expectedId: laRivieraId, name: `trusted/${laRivieraId}.track`, hash: 'b'.repeat(64),
      text: laRivieraCode, trusted: true,
    }]);
  assert.equal(forgedCatalog.get(laRivieraId).reason, 'track_geometry_limit');
});
