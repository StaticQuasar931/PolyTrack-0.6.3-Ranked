import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalogPath = path.join(root, 'extra-tracks/catalog.json');
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const MAX_CODE_BYTES = 2_000_000;
const MAX_DECODED_BYTES = 8_000_000;

function unpack(text) {
  if (!text || /[^0-9A-Za-z]/.test(text)) throw Error('Invalid packed track text');
  let bit = 0;
  let lastBit = 0;
  for (const character of text) {
    const value = alphabet.indexOf(character);
    lastBit = bit;
    bit += (30 & ~value) ? 6 : 5;
  }
  const size = Math.floor(lastBit / 8) + 1;
  if (size > MAX_DECODED_BYTES) throw Error('Track metadata exceeds size limit');
  const output = Buffer.alloc(size);
  bit = 0;
  for (let index = 0; index < text.length; index++) {
    const value = alphabet.indexOf(text[index]);
    const width = (30 & ~value) ? 6 : 5;
    const byte = Math.floor(bit / 8);
    const offset = bit % 8;
    output[byte] |= value << offset & 255;
    if (offset > 8 - width && index !== text.length - 1) output[byte + 1] |= value >> (8 - offset);
    bit += width;
  }
  return output;
}

export function readEmbeddedTrackMetadata(code) {
  if (typeof code !== 'string' || Buffer.byteLength(code) > MAX_CODE_BYTES) throw Error('Invalid track code size');
  const match = /^PolyTrack([12])([0-9A-Za-z]+)$/.exec(code);
  if (!match) throw Error('Invalid track code');
  const inner = zlib.inflateSync(unpack(match[2]), { maxOutputLength: MAX_DECODED_BYTES }).toString('ascii');
  const payload = zlib.inflateSync(unpack(inner), { maxOutputLength: MAX_DECODED_BYTES });
  let cursor = 0;
  const readText = () => {
    if (cursor >= payload.length) throw Error('Truncated track metadata');
    const length = payload[cursor++];
    if (cursor + length > payload.length) throw Error('Truncated track metadata');
    const value = payload.subarray(cursor, cursor + length).toString('utf8').trim();
    cursor += length;
    return value;
  };
  const codeName = readText();
  const codeAuthor = readText();
  let codeModifiedAt = null;
  if (match[1] === '2') {
    const flag = payload[cursor++];
    if (flag === 1) {
      if (cursor + 4 > payload.length) throw Error('Truncated track date');
      const seconds = payload.readUInt32LE(cursor);
      codeModifiedAt = seconds ? new Date(seconds * 1000).toISOString() : null;
    } else if (flag !== 0) throw Error('Invalid track date flag');
  }
  return { codeName, codeAuthor, codeModifiedAt };
}

export function addCodeMetadata(entries) {
  return entries.map(entry => {
    if (!/^extra-tracks\/track-data\/[a-z0-9-]+\/[a-z0-9-]+\.track$/.test(entry.trackPath || '')) {
      throw Error(`Invalid track path: ${entry.id}`);
    }
    const code = fs.readFileSync(path.join(root, entry.trackPath), 'utf8').trim();
    const { codeName, codeAuthor, codeModifiedAt } = readEmbeddedTrackMetadata(code);
    return { ...entry, codeName, codeAuthor, codeModifiedAt, sizeBytes: Buffer.byteLength(code, 'utf8') };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const before = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const after = addCodeMetadata(before);
  if (process.argv.includes('--check')) {
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      console.error('Extra Tracks code metadata is out of date. Run node extra-tracks/sync-code-metadata.mjs --write.');
      process.exitCode = 1;
    }
  } else if (process.argv.includes('--write')) {
    fs.writeFileSync(catalogPath, JSON.stringify(after, null, 2) + '\n');
    console.log(`Updated embedded metadata for ${after.length} Extra Tracks.`);
  } else {
    console.log('Use --check or --write.');
  }
}
