import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readEmbeddedTrackMetadata } from './sync-code-metadata.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { _internals: { preflightTrackCode } } = require('../tools/verifier/kodub-track.cjs');
const source = JSON.parse(fs.readFileSync(path.join(root, 'extra-tracks/sources/itch.json'), 'utf8'));
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'extra-tracks/catalog.json'), 'utf8'));
const pinned = JSON.parse(fs.readFileSync(path.join(root, 'tools/verifier/engine-manifest.json'), 'utf8'));

test('itch.io source entries stay attributed, playable, pinned, and previewed', () => {
  assert.equal(source.length, 20);
  assert.equal(new Set(source.map(row => row.id)).size, source.length);
  assert.equal(new Set(source.map(row => row.trackId)).size, source.length);
  for (const row of source) {
    assert.match(row.id, /^itch-\d+$/);
    assert.match(row.sourceUrl, /^https:\/\/itch\.io\/post\/\d+$/);
    assert.equal(row.source, 'itch.io community');
    assert.ok(row.author && row.codeAuthor && row.codeName);
    assert.deepEqual(catalog.find(item => item.id === row.id), row);
    assert.match(row.trackPath, /^extra-tracks\/track-data\/itch\/itch-\d+\.track$/);
    assert.equal(row.thumbnailUrl, `extra-tracks/thumbnails/${row.id}.png`);
    assert.ok(row.sourceUpvotes === null || Number.isSafeInteger(row.sourceUpvotes));
    assert.ok(row.sourceDownvotes === null || Number.isSafeInteger(row.sourceDownvotes));
    assert.ok(row.sourceReplies === null || Number.isSafeInteger(row.sourceReplies));

    const fileBytes = fs.readFileSync(path.join(root, row.trackPath));
    const code = fileBytes.toString('utf8').trim();
    assert.equal(Buffer.byteLength(code), row.sizeBytes);
    const metadata = readEmbeddedTrackMetadata(code);
    assert.equal(metadata.codeName, row.codeName);
    assert.equal(metadata.codeAuthor, row.codeAuthor);
    assert.ok(preflightTrackCode(code).parts > 0);
    assert.equal(createHash('sha256').update(fileBytes).digest('hex'), pinned.tracks[row.trackPath]);

    const png = fs.readFileSync(path.join(root, row.thumbnailUrl));
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.ok(png.readUInt32BE(16) > 0 && png.readUInt32BE(20) > 0);
  }
});
