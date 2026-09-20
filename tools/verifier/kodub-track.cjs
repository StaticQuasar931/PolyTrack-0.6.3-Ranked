'use strict';

const zlib = require('node:zlib');
const { LIMITS, sha256 } = require('./replay.cjs');

const TRACK_ID = /^[a-f0-9]{64}$/;
const TRACK_CODE = /^PolyTrack[12][0-9A-Za-z]+$/;
const CHECKPOINT_PARTS = new Set([52, 65, 75, 77]);
const START_PARTS = new Set([5, 91, 92, 93]);
const VALID_COLORS = new Set([0, 1, 2, 3, 32, 33, 34, 35, 36, 37, 38, 39, 40]);
const INVALID_CURRENT_PARTS = new Set([40, 60, 84, 89]);
const MAX_PART_GROUPS = 256;
const MAX_METADATA_BYTES = 517;
const MAX_BODY_HEADER_BYTES = 15;
const MAX_RECORD_BYTES = 18;
const MAX_TRACK_PAYLOAD_BYTES = MAX_METADATA_BYTES + MAX_BODY_HEADER_BYTES +
  MAX_PART_GROUPS * 5 + LIMITS.trackParts * MAX_RECORD_BYTES;
const MAX_SECOND_COMPRESSED_BYTES = MAX_TRACK_PAYLOAD_BYTES +
  (MAX_TRACK_PAYLOAD_BYTES >>> 12) + (MAX_TRACK_PAYLOAD_BYTES >>> 14) +
  (MAX_TRACK_PAYLOAD_BYTES >>> 25) + 13;
const MAX_INNER_TEXT_BYTES = Math.ceil(MAX_SECOND_COMPRESSED_BYTES * 8 / 5);

const TRACK_PREFLIGHT_LIMITS = Object.freeze({
  innerTextBytes: MAX_INNER_TEXT_BYTES,
  secondCompressedBytes: MAX_SECOND_COMPRESSED_BYTES,
  payloadBytes: MAX_TRACK_PAYLOAD_BYTES,
  parts: LIMITS.trackParts,
});

function reject(reason) {
  throw Object.assign(new TypeError(reason), { reason });
}

function packedValue(code) {
  if (code >= 48 && code <= 57) return code - 48 + 52;
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 97 + 26;
  return -1;
}

// This is the game's Wa decoder. Values 30 and 31 consume five bits; all others consume six.
function decodePacked(text, maximum, limitReason) {
  if (typeof text !== 'string' || text.length === 0) reject('invalid_trusted_track_code');
  let bit = 0;
  let lastBit = 0;
  for (let index = 0; index < text.length; index++) {
    const value = packedValue(text.charCodeAt(index));
    if (value < 0) reject('invalid_trusted_track_code');
    lastBit = bit;
    bit += (30 & ~value) ? 6 : 5;
  }
  const length = Math.floor(lastBit / 8) + 1;
  if (length > maximum) reject(limitReason);
  const output = Buffer.alloc(length);
  bit = 0;
  for (let index = 0; index < text.length; index++) {
    const value = packedValue(text.charCodeAt(index));
    const width = (30 & ~value) ? 6 : 5;
    const byte = Math.floor(bit / 8);
    const offset = bit - byte * 8;
    output[byte] |= value << offset & 255;
    if (offset > 8 - width && index !== text.length - 1) output[byte + 1] |= value >> (8 - offset);
    bit += width;
  }
  return output;
}

function inflateBounded(compressed, maximum, limitReason) {
  try {
    const result = zlib.inflateSync(compressed, { maxOutputLength: maximum, info: true });
    if (result.engine.bytesWritten !== compressed.length) reject('invalid_trusted_track_code');
    return result.buffer;
  } catch (error) {
    if (error?.reason) throw error;
    if (error?.code === 'ERR_BUFFER_TOO_LARGE') reject(limitReason);
    reject('invalid_trusted_track_code');
  }
}

function requireBytes(bytes, cursor, count) {
  if (!Number.isSafeInteger(count) || count < 0 || cursor + count > bytes.length) {
    reject('invalid_trusted_track_code');
  }
}

function readU32(bytes, cursor) {
  requireBytes(bytes, cursor, 4);
  return (bytes[cursor] | bytes[cursor + 1] << 8 | bytes[cursor + 2] << 16 |
    bytes[cursor + 3] << 24) >>> 0;
}

function currentPart(part) {
  return part <= 189 && !INVALID_CURRENT_PARTS.has(part);
}

function parseTrackBody(bytes, cursor, version) {
  requireBytes(bytes, cursor, MAX_BODY_HEADER_BYTES);
  if (bytes[cursor] > 2 || bytes[cursor + 1] >= 180) reject('invalid_trusted_track_code');
  cursor += 14;
  const widths = [bytes[cursor] & 3, bytes[cursor] >> 2 & 3, bytes[cursor] >> 4 & 3];
  cursor += 1;
  if (widths.some(width => width < 1 || width > 3)) reject('invalid_trusted_track_code');

  const seen = new Set();
  let parts = 0;
  while (cursor < bytes.length) {
    requireBytes(bytes, cursor, 5);
    const rawPart = bytes[cursor++];
    let part = rawPart;
    let synthetic = false;
    if (version === 1) {
      if (rawPart === 40 || rawPart === 84) { part = 4; synthetic = true; }
      else if (rawPart === 99 || rawPart === 100) { part = 35; synthetic = true; }
    }
    if (!currentPart(part) || seen.has(rawPart) || seen.size >= MAX_PART_GROUPS) reject('invalid_trusted_track_code');
    seen.add(rawPart);
    const count = readU32(bytes, cursor);
    cursor += 4;
    const nativeCount = count * (synthetic ? 2 : 1);
    if (nativeCount > LIMITS.trackParts - parts) reject('trusted_track_part_limit');
    parts += nativeCount;

    const coordinateBytes = widths[0] + widths[1] + widths[2];
    const recordBytes = coordinateBytes + (version === 1 ? 3 : 2) +
      (CHECKPOINT_PARTS.has(part) ? 2 : 0) + (START_PARTS.has(part) ? 4 : 0);
    requireBytes(bytes, cursor, count * recordBytes);
    for (let index = 0; index < count; index++) {
      cursor += coordinateBytes;
      if (version === 1) {
        if (bytes[cursor++] > 3 || bytes[cursor++] > 5 || !VALID_COLORS.has(bytes[cursor++])) {
          reject('invalid_trusted_track_code');
        }
      } else {
        const flags = bytes[cursor++];
        if ((flags >> 2 & 7) > 5 || !VALID_COLORS.has(bytes[cursor++])) reject('invalid_trusted_track_code');
      }
      if (CHECKPOINT_PARTS.has(part)) cursor += 2;
      if (START_PARTS.has(part)) cursor += 4;
    }
  }
  if (cursor !== bytes.length) reject('invalid_trusted_track_code');
  return parts;
}

function parseTrackPayload(bytes, version) {
  let cursor = 0;
  requireBytes(bytes, cursor, 1);
  const nameBytes = bytes[cursor++];
  requireBytes(bytes, cursor, nameBytes);
  cursor += nameBytes;
  requireBytes(bytes, cursor, 1);
  const authorBytes = bytes[cursor++];
  requireBytes(bytes, cursor, authorBytes);
  cursor += authorBytes;
  if (version === 2) {
    requireBytes(bytes, cursor, 1);
    const modified = bytes[cursor++];
    if (modified === 1) { requireBytes(bytes, cursor, 4); cursor += 4; }
    else if (modified !== 0) reject('invalid_trusted_track_code');
  }
  return parseTrackBody(bytes, cursor, version);
}

function preflightTrackCode(code) {
  const match = /^PolyTrack([12])([0-9A-Za-z]+)$/.exec(code);
  if (!match) reject('invalid_trusted_track_code');
  const version = Number(match[1]);
  const outerCompressed = decodePacked(match[2], LIMITS.trackBytes, 'trusted_track_size_limit');
  const innerTextBytes = inflateBounded(outerCompressed, MAX_INNER_TEXT_BYTES, 'trusted_track_inflated_size_limit');
  for (const byte of innerTextBytes) if (packedValue(byte) < 0) reject('invalid_trusted_track_code');
  const innerCompressed = decodePacked(innerTextBytes.toString('ascii'), MAX_SECOND_COMPRESSED_BYTES,
    'trusted_track_inflated_size_limit');
  const payload = inflateBounded(innerCompressed, MAX_TRACK_PAYLOAD_BYTES, 'trusted_track_inflated_size_limit');
  const parts = parseTrackPayload(payload, version);
  return Object.freeze({ version, parts, inflatedBytes: payload.length });
}

function normalizeTrustedTracks(value, jobTrackIds) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > LIMITS.jobs) reject('invalid_trusted_tracks');
  const admitted = jobTrackIds instanceof Set ? jobTrackIds : new Set(jobTrackIds || []);
  const seen = new Set();
  let totalBytes = 0;
  return value.map(item => {
    if (!item || typeof item !== 'object' || !TRACK_ID.test(item.trackId || '') ||
        !TRACK_ID.test(item.codeHash || '') || typeof item.code !== 'string') {
      reject('invalid_trusted_track');
    }
    if (!admitted.has(item.trackId)) reject('extraneous_trusted_track');
    if (seen.has(item.trackId)) reject('duplicate_trusted_track');
    seen.add(item.trackId);
    const bytes = Buffer.byteLength(item.code, 'utf8');
    totalBytes += bytes;
    if (bytes < 32 || bytes > LIMITS.trackBytes || totalBytes > LIMITS.trackBytes * LIMITS.jobs) {
      reject('trusted_track_size_limit');
    }
    if (!TRACK_CODE.test(item.code)) reject('invalid_trusted_track_code');
    if (sha256(item.code) !== item.codeHash) reject('trusted_track_hash_mismatch');
    preflightTrackCode(item.code);
    return Object.freeze({
      expectedId: item.trackId,
      name: `trusted/${item.trackId}.track`,
      hash: item.codeHash,
      text: item.code,
      trusted: true,
    });
  });
}

module.exports = { normalizeTrustedTracks, TRACK_CODE,
  _internals: { preflightTrackCode, decodePacked, TRACK_PREFLIGHT_LIMITS } };
