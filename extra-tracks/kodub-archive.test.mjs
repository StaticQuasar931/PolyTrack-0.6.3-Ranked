import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {buildKodubArchive} from './build-kodub-archive.mjs';
import {addCodeMetadata} from './sync-code-metadata.mjs';
test('all locally captured trusted weekly selections have exact bytes, attribution and end dates in Extra Tracks', async () => {
  const added = await buildKodubArchive();
  const read = async name => JSON.parse(await fs.readFile(new URL(name, import.meta.url), 'utf8'));
  const selections = await read('../events/kodub/selections.json');
  const catalog = await read('./catalog.json');
  assert.equal(added.length, selections.length);
  assert.equal(new Set(catalog.map(row => row.trackId)).size, catalog.length);
  assert.deepEqual(addCodeMetadata(added), added);
  for (const entry of added) {
    const source = selections.find(row => row.trackId === entry.trackId);
    const bytes = await fs.readFile(new URL('../' + entry.trackPath, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.codeHash);
    assert.equal(entry.weeklyEndsAt, source.endTime);
    assert.equal(entry.codeName, source.name); assert.equal(entry.codeAuthor, source.author);
    assert.equal(entry.weeklyStartsAt, undefined, 'no invented historical start date');
    assert.equal(entry.submittedAt, undefined, 'selection date is not a submission date');
  }
});

test('archive build fails closed on altered bytes, missing trust, false dates and identity collisions without writing output', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'polytrack-extra-archive-'));
  const base = pathToFileURL(directory + path.sep);
  const read = async name => JSON.parse(await fs.readFile(new URL(name, import.meta.url), 'utf8'));
  const [selection] = await read('../events/kodub/selections.json');
  const trusted = (await read('../events/kodub/trusted-tracks.json')).filter(row => row.trackId === selection.trackId);
  const original = await fs.readFile(new URL('../events/kodub/' + selection.trackUrl, import.meta.url));
  const image = await fs.readFile(new URL('../events/kodub/' + selection.thumbnailUrl, import.meta.url));
  const write = async (name, value) => fs.writeFile(new URL(name, base), typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
  try {
    await fs.mkdir(new URL('events/kodub/assets/', base), {recursive: true});
    await fs.mkdir(new URL('extra-tracks/', base), {recursive: true});
    await write('events/kodub/' + selection.trackUrl, original);
    await write('events/kodub/' + selection.thumbnailUrl, image);
    await write('events/kodub/selections.json', [selection]);
    await write('events/kodub/trusted-tracks.json', trusted);
    await write('extra-tracks/catalog.json', []);
    const rejects = async pattern => {
      const before = await fs.readFile(new URL('extra-tracks/catalog.json', base), 'utf8');
      await assert.rejects(buildKodubArchive({root: base, write: true}), pattern);
      assert.equal(await fs.readFile(new URL('extra-tracks/catalog.json', base), 'utf8'), before, 'rejected future imports retain the previous catalog');
    };
    await write('events/kodub/' + selection.trackUrl, Buffer.from('tampered'));
    await rejects(/hash mismatch/);
    await write('events/kodub/' + selection.trackUrl, original);
    await write('events/kodub/trusted-tracks.json', []); await rejects(/Untrusted/);
    await write('events/kodub/trusted-tracks.json', trusted);
    await write('events/kodub/selections.json', [{...selection, endTime: 'unknown'}]); await rejects(/undated/);
    await write('events/kodub/selections.json', [{...selection, author: 'Incorrect attribution'}]); await rejects(/attribution/);
    await write('events/kodub/selections.json', [{...selection, lastModified: '2000-01-01T00:00:00.000Z'}]); await rejects(/modification date/);
    await write('events/kodub/selections.json', [selection, selection]); await rejects(/Repeated weekly identity/);
    await write('events/kodub/selections.json', [selection]);
    await write('extra-tracks/catalog.json', [{id: 'already-present', trackId: selection.trackId}]); await rejects(/already exists/);
    await assert.rejects(fs.access(new URL('extra-tracks/track-data/', base)), /ENOENT/);
  } finally { await fs.rm(directory, {recursive: true, force: true}); }
});


test('new archives are idempotent canonical aliases and builder writes only the catalog', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'polytrack-extra-repeat-'));
  const base = pathToFileURL(directory + path.sep);
  const read = async name => JSON.parse(await fs.readFile(new URL(name, import.meta.url), 'utf8'));
  const [selection] = await read('../events/kodub/selections.json');
  const trusted = (await read('../events/kodub/trusted-tracks.json')).filter(row => row.trackId === selection.trackId);
  try {
    await fs.mkdir(new URL('events/kodub/assets/', base), {recursive: true});
    await fs.mkdir(new URL('extra-tracks/', base), {recursive: true});
    for (const name of [selection.trackUrl, selection.thumbnailUrl]) await fs.copyFile(new URL('../events/kodub/' + name, import.meta.url), new URL('events/kodub/' + name, base));
    for (const [name, value] of [['events/kodub/selections.json', [selection]], ['events/kodub/trusted-tracks.json', trusted], ['extra-tracks/catalog.json', []]]) await fs.writeFile(new URL(name, base), JSON.stringify(value));
    const [added] = await buildKodubArchive({root: base, write: true});
    assert.equal(added.archiveImport, true); assert.equal(added.ranked, undefined); assert.equal(added.importOnly, undefined);
    assert.equal(added.trackId, selection.trackId);
    assert.equal(added.trackPath, 'events/kodub/' + selection.trackUrl);
    assert.deepEqual(await fs.readdir(new URL('extra-tracks/', base)), ['catalog.json']);
    const before = await fs.readFile(new URL('extra-tracks/catalog.json', base), 'utf8');
    await buildKodubArchive({root: base, write: true});
    assert.equal(await fs.readFile(new URL('extra-tracks/catalog.json', base), 'utf8'), before);
    const modified = JSON.parse(before); modified[0].ranked = false; modified[0].importOnly = true;
    await fs.writeFile(new URL('extra-tracks/catalog.json', base), JSON.stringify(modified));
    await buildKodubArchive({root: base, write: true});
    const [preserved] = await buildKodubArchive({root: base});
    assert.equal(preserved.ranked, undefined); assert.equal(preserved.importOnly, undefined); assert.equal(preserved.archiveImport, true);
    assert.deepEqual(await fs.readdir(new URL('extra-tracks/', base)), ['catalog.json']);
  } finally { await fs.rm(directory, {recursive: true, force: true}); }
});


test('oversized or unsupported future trusted captures survive alias failure with the old catalog intact', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kodub-future-capture-'));
  const base = pathToFileURL(directory + path.sep);
  const selection = JSON.parse(await fs.readFile(new URL('../events/kodub/selections.json', import.meta.url), 'utf8'))[0];
  const previous = JSON.stringify([{id: 'old-catalog', name: 'Existing entry'}]) + '\n';
  try {
    await fs.mkdir(new URL('events/kodub/assets/', base), {recursive: true});
    await fs.mkdir(new URL('extra-tracks/', base), {recursive: true});
    for (const bytes of [Buffer.alloc(262145, 65), Buffer.from('PolyTrack3UnsupportedFutureMetadata')]) {
      const codeHash = createHash('sha256').update(bytes).digest('hex');
      const current = {...selection, trackUrl: 'assets/' + codeHash + '.track'};
      const receipt = JSON.stringify({serverTime: '2026-11-02T00:00:00Z', current});
      await fs.writeFile(new URL('events/kodub/' + current.trackUrl, base), bytes);
      await fs.writeFile(new URL('events/kodub/current.json', base), receipt);
      await fs.writeFile(new URL('events/kodub/selections.json', base), JSON.stringify([current]));
      await fs.writeFile(new URL('events/kodub/trusted-tracks.json', base), JSON.stringify([{trackId: current.trackId, codeHash, assetPath: current.trackUrl}]));
      await fs.writeFile(new URL('extra-tracks/catalog.json', base), previous);
      await assert.rejects(buildKodubArchive({root: base, write: true}));
      assert.equal(await fs.readFile(new URL('extra-tracks/catalog.json', base), 'utf8'), previous);
      assert.equal(await fs.readFile(new URL('events/kodub/current.json', base), 'utf8'), receipt);
      assert.deepEqual(await fs.readFile(new URL('events/kodub/' + current.trackUrl, base)), bytes);
      assert.deepEqual(await fs.readdir(new URL('extra-tracks/', base)), ['catalog.json']);
    }
  } finally { await fs.rm(directory, {recursive: true, force: true}); }
});
