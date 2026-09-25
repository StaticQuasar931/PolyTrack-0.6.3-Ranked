import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { addCodeMetadata, readEmbeddedTrackMetadata } from './sync-code-metadata.mjs';

test('extracts author and UTC modified date from a committed version 2 track', () => {
  const code = fs.readFileSync(new URL('./track-data/polytrackcodes/dakiu-the-japanese-nordschleife.track', import.meta.url), 'utf8').trim();
  assert.deepEqual(readEmbeddedTrackMetadata(code), {
    codeName: 'Dakiu: The Japanese  nordschleife',
    codeAuthor: 'ELIXIR (MASTERX)',
    codeModifiedAt: '2026-09-17T10:25:36.000Z'
  });
});

test('older codes have no invented modified date', () => {
  const code = fs.readFileSync(new URL('./track-data/polytrack-fun/shrouded-oasis.track', import.meta.url), 'utf8').trim();
  assert.equal(readEmbeddedTrackMetadata(code).codeModifiedAt, null);
});

test('catalog metadata and code byte sizes stay synchronized', () => {
  const catalog = JSON.parse(fs.readFileSync(new URL('./catalog.json', import.meta.url), 'utf8'));
  assert.ok(catalog.length > 0);
  assert.deepEqual(addCodeMetadata(catalog), catalog);
});

test('invalid code is rejected', () => {
  assert.throws(() => readEmbeddedTrackMetadata('PolyTrack2not-a-code'), /Invalid track code/);
});
