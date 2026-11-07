import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadWeeklyTrustedTrack} from './weekly-track.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function catalogFixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-catalog-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    fs.rmSync(temporary, {recursive: true, force: true});
  });
  const entry = JSON.parse(fs.readFileSync(path.join(root, 'extra-tracks/catalog.json'), 'utf8')).find(row => row.archiveImport);
  const directory = path.join(temporary, 'events/kodub');
  fs.mkdirSync(path.join(directory, 'assets'), {recursive: true});
  fs.mkdirSync(path.join(temporary, 'extra-tracks'));
  const code = fs.readFileSync(path.join(root, entry.trackPath), 'utf8');
  fs.writeFileSync(path.join(temporary, entry.trackPath), code);
  const catalog = rows => fs.writeFileSync(path.join(temporary, 'extra-tracks/catalog.json'), JSON.stringify(rows));
  catalog([entry]);
  return {temporary, directory, entry, code, catalog};
}

test('a reviewed catalog alias recovers an omitted registry binding, not a proof', t => {
  const {temporary, directory, entry, code} = catalogFixture(t);
  const jobs = [{trackId: entry.trackId}];
  for (const registry of ['[]', 'invalid JSON', JSON.stringify(Array(521).fill(null)), ' '.repeat(128 * 1024 + 1)]) {
    fs.writeFileSync(path.join(directory, 'trusted-tracks.json'), registry);
    const tracks = loadWeeklyTrustedTrack(temporary, jobs);
    assert.deepEqual(tracks, [{trackId: entry.trackId, code, codeHash: entry.codeHash}]);
    assert.equal(tracks[0].verified, undefined);
  }
  assert.deepEqual(loadWeeklyTrustedTrack(temporary, [{trackId: 'b'.repeat(64)}]), []);
});

test('catalog fallback requires exact local archive path, hash, and ranked alias flags', t => {
  const {temporary, entry, catalog} = catalogFixture(t);
  for (const change of [{archiveImport: false}, {ranked: false}, {unranked: true}, {importOnly: true},
    {trackPath: '../outside.track'}, {trackPath: 'https://example.test/track'},
    {trackPath: 'extra-tracks/challenges/poly-dip-2.track'}, {codeHash: 'f'.repeat(64)}, {trackId: 'invalid'}]) {
    catalog([{...entry, ...change}]);
    assert.deepEqual(loadWeeklyTrustedTrack(temporary, [{trackId: entry.trackId}]), [], JSON.stringify(change));
  }
  catalog([entry]);
  fs.appendFileSync(path.join(temporary, entry.trackPath), 'tampered');
  assert.deepEqual(loadWeeklyTrustedTrack(temporary, [{trackId: entry.trackId}]), []);
});

test('catalog and asset size limits fail closed without hiding a valid registry', t => {
  const {temporary, directory, entry, code, catalog} = catalogFixture(t);
  const jobs = [{trackId: entry.trackId}];
  catalog(Array(1025).fill(entry));
  assert.deepEqual(loadWeeklyTrustedTrack(temporary, jobs), []);
  fs.writeFileSync(path.join(temporary, 'extra-tracks/catalog.json'), ' '.repeat(1024 * 1024 + 1));
  assert.deepEqual(loadWeeklyTrustedTrack(temporary, jobs), []);
  fs.writeFileSync(path.join(directory, 'trusted-tracks.json'), JSON.stringify([
    {trackId: entry.trackId, codeHash: entry.codeHash, assetPath: `assets/${entry.codeHash}.track`},
  ]));
  assert.deepEqual(loadWeeklyTrustedTrack(temporary, jobs), [{trackId: entry.trackId, code, codeHash: entry.codeHash}]);
  fs.writeFileSync(path.join(temporary, entry.trackPath), 'x'.repeat(262145));
  assert.deepEqual(loadWeeklyTrustedTrack(temporary, jobs), []);
});

test('catalog fallback does not replace or duplicate a valid registry binding', t => {
  const {temporary, directory, entry, code, catalog} = catalogFixture(t);
  const otherCode = code + 'A', otherHash = crypto.createHash('sha256').update(otherCode).digest('hex');
  fs.writeFileSync(path.join(directory, 'assets', otherHash + '.track'), otherCode);
  catalog([{...entry, codeHash: otherHash, trackPath: `events/kodub/assets/${otherHash}.track`}, entry]);
  fs.writeFileSync(path.join(directory, 'trusted-tracks.json'), JSON.stringify([
    {trackId: entry.trackId, codeHash: entry.codeHash, assetPath: `assets/${entry.codeHash}.track`},
  ]));
  assert.deepEqual(loadWeeklyTrustedTrack(temporary, [{trackId: entry.trackId}]), [{trackId: entry.trackId, code, codeHash: entry.codeHash}]);
});
test('weekly Kodub asset is offered only for selected jobs with its exact current track ID', () => {
  const current = JSON.parse(fs.readFileSync(path.join(root, 'events/kodub/current.json'), 'utf8')).current;
  const [track] = loadWeeklyTrustedTrack(root, [{trackId: current.trackId}]);
  assert.equal(track.trackId, current.trackId);
  assert.equal(track.codeHash, current.trackUrl.match(/^assets\/([a-f0-9]{64})\.track$/)[1]);
  assert.equal(track.code.length > 32, true);
  assert.deepEqual(loadWeeklyTrustedTrack(root, [{trackId: 'b'.repeat(64)}]), []);
});

test('malformed pointers and content-hash mismatches never produce trusted tracks', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-track-'));
  const directory = path.join(temporary, 'events', 'kodub');
  fs.mkdirSync(path.join(directory, 'assets'), {recursive: true});
  try {
    fs.writeFileSync(path.join(directory, 'current.json'), JSON.stringify({current: {
      trackId: '5c891c15c754987ff7e1358000f265d26aa959716c443dec80f668762c3d83d7',
      trackUrl: 'assets/aa5e949dbd8e18caab0fc3697f9ef10c72cf1d5acccfd0b9d618663f35131542.track',
    }}));
    fs.writeFileSync(path.join(directory, 'assets', 'aa5e949dbd8e18caab0fc3697f9ef10c72cf1d5acccfd0b9d618663f35131542.track'), 'PolyTrack2' + 'A'.repeat(64));
    const trackId = '5c891c15c754987ff7e1358000f265d26aa959716c443dec80f668762c3d83d7';
    assert.deepEqual(loadWeeklyTrustedTrack(temporary, [{trackId}]), []);
    fs.writeFileSync(path.join(directory, 'current.json'), JSON.stringify({current: {
      trackId, trackUrl: '../outside.track',
    }}));
    assert.deepEqual(loadWeeklyTrustedTrack(temporary, [{trackId}]), []);
  } finally {
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    fs.rmSync(temporary, {recursive: true, force: true});
  }
});

test('archived registry supplies only selected jobs with checked exact ID and hash', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-history-'));
  const directory = path.join(temporary, 'events', 'kodub');
  const asset = 'PolyTrack2' + 'A'.repeat(100);
  const hash = crypto.createHash('sha256').update(asset).digest('hex');
  const trackId = '5c891c15c754987ff7e1358000f265d26aa959716c443dec80f668762c3d83d7';
  fs.mkdirSync(path.join(directory, 'assets'), {recursive: true});
  try {
    fs.writeFileSync(path.join(directory, 'assets', `${hash}.track`), asset);
    fs.writeFileSync(path.join(directory, 'trusted-tracks.json'), JSON.stringify([
      {trackId, codeHash: hash, assetPath: `assets/${hash}.track`},
    ]));
    assert.deepEqual(loadWeeklyTrustedTrack(temporary, [{trackId: 'b'.repeat(64)}]), []);
    assert.deepEqual(loadWeeklyTrustedTrack(temporary, [{trackId}]), [{trackId, code: asset, codeHash: hash}]);
    fs.writeFileSync(path.join(directory, 'trusted-tracks.json'), JSON.stringify([
      {trackId:'b'.repeat(64),codeHash:'c'.repeat(64),assetPath:`assets/${'c'.repeat(64)}.track`},
      {trackId,codeHash:hash,assetPath:`assets/${hash}.track`},
    ]));
    assert.deepEqual(loadWeeklyTrustedTrack(temporary,[{trackId:'b'.repeat(64)},{trackId}]),[{trackId,code:asset,codeHash:hash}]);
    fs.writeFileSync(path.join(directory, 'trusted-tracks.json'), JSON.stringify([
      {trackId, codeHash: hash, assetPath: '../outside.track'},
    ]));
    assert.deepEqual(loadWeeklyTrustedTrack(temporary, [{trackId}]), []);
    fs.writeFileSync(path.join(directory, 'trusted-tracks.json'), JSON.stringify([
      {trackId, codeHash: 'a'.repeat(64), assetPath: `assets/${'a'.repeat(64)}.track`},
    ]));
    assert.deepEqual(loadWeeklyTrustedTrack(temporary, [{trackId}]), []);
  } finally {
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    fs.rmSync(temporary, {recursive: true, force: true});
  }
});
