import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildSnapshotBootstrapIndex, buildTrackSnapshotPaging, buildOverallSnapshotPaging } from './track-snapshot-paging.mjs';
import { decodeSnapshot, MAX_DECODED_BYTES, MAX_FILE_BYTES, publishSnapshot, restoreSnapshotArchive } from './snapshot-package.mjs';
import { createPublicSnapshotReader } from './public-snapshot-client.mjs';

const id = 'a'.repeat(64), account = n => n.toString(16).padStart(64, '0');
const capturedAt = '2026-10-10T00:00:00.000Z';
function board(count = 205, overrides = {}) {
  return { trackId: id, schemaVersion: 6, revision: 4, sourceRevision: 4, algorithmVersion: 'model', updatedAt: 100,
    complete: true, totalEntries: count, entries: Array.from({ length: count }, (_, i) =>
      ({ accountId: account(i + 1), timeMs: 1000 + Math.floor(i / 3), rank: i + 1, position: i + 1, name: `Racer ${i}` })), ...overrides };
}
async function fixture(t, value = board()) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'snapshot-paging-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    return rm(root, { recursive: true, force: true });
  });
  const stagingDirectory = path.join(root, 'stage'), historyDirectory = path.join(root, 'private-history');
  await mkdir(path.join(stagingDirectory, 'tracks'), { recursive: true });
  await writeFile(path.join(stagingDirectory, 'tracks', `${id}.json`), JSON.stringify(value));
  await writeFile(path.join(stagingDirectory, 'manifest.json'), JSON.stringify({ schemaVersion: 1, trackIdsKnown: 1,
    tracks: { [id]: { path: `tracks/${id}.json`, checkedAt: Date.parse(capturedAt) } } }));
  await writeFile(path.join(stagingDirectory, 'overall.json'), JSON.stringify({ updatedAt: 100, entries: [] }));
  await writeFile(path.join(stagingDirectory, 'public-export-summary.json'), JSON.stringify({ capturedAt: '2026-10-17T00:00:00.000Z' }));
  const options = { root, stagingDirectory, historyDirectory };
  const published = await publishSnapshot(options);
  const directory = path.join(root, published.directory);
  const index = JSON.parse(await readFile(path.join(directory, 'index.json'), 'utf8'));
  const logical = async logicalPath => JSON.parse(Buffer.from(await decodeSnapshot(await readFile(path.join(directory, index.files[logicalPath].path)))).toString());
  return { ...options, published, directory, index, logical };
}
function readerFixture(f, { bootstrap = true, intercept, now } = {}) {
  const requests = [];
  const read = createPublicSnapshotReader({ packed: true, bootstrap, baseUrl: 'https://example.test/public-snapshots1/', now,
    fetchImpl: async (url, options) => {
      const filename = path.posix.basename(new URL(url).pathname);
      requests.push({ filename, options });
      const override = await intercept?.(filename);
      if (override) return override;
      try { return new Response(await readFile(path.join(f.directory, filename))); }
      catch (error) { if (error.code === 'ENOENT') return new Response('', { status: 404 }); throw error; }
    } });
  return { read, requests, count: filename => requests.filter(request => request.filename === filename).length };
}

test('100-row pages and top-15 preview keep global ordinal ranks across both cut points', () => {
  const source = board(), original = structuredClone(source);
  source.entries.reverse();
  const { preview, pages } = buildTrackSnapshotPaging(source, { capturedAt });
  assert.equal(preview.entries.length, 15);
  assert.deepEqual(pages.map(page => page.entries.length), [100, 100, 5]);
  assert.deepEqual(preview.entries.map(row => row.rank), original.entries.slice(0, 15).map(row => row.rank));
  assert.equal(pages[0].entries[99].rank, 100);
  assert.equal(pages[1].entries[0].rank, 101);
  assert.equal(pages[1].entries[0].globalRank, 101);
  assert.equal(pages[2].entries[0].rank, 201);
  assert.equal(pages[2].entries[0].sourceRank, 201);
  assert.equal(pages[2].entries[0].position, 201);
  assert.equal(preview.complete, false);
  assert.equal(preview.sourceComplete, true);
  assert.equal(preview.ranksExact, true);
  assert.equal(preview.totalEntries, 205);
  assert.equal(preview.totalEntriesExact, true);
  assert.equal(preview.publishedEntries, 205);
  assert.equal(preview.capturedAt, capturedAt);
  assert.equal(preview.updatedAt, 100);
  assert.equal(preview.pageCount, 3);
  assert.deepEqual(preview.pageBounds.map(({ minTimeMs, maxTimeMs }) => [minTimeMs, maxTimeMs]), [[1000, 1033], [1033, 1066], [1066, 1068]]);
  assert.equal(pages[1].bounds.startPosition, 101);
  assert.equal(pages[1].bounds.endPosition, 200);
  assert.equal(source.entries[0].rank, 205, 'source is never mutated');
});

test('incomplete captures cannot infer exact ranks, exact totals, or freshness', () => {
  const { preview } = buildTrackSnapshotPaging(board(20, { complete: false, totalEntries: 200 }));
  assert.equal(preview.sourceComplete, false);
  assert.equal(preview.totalEntries, 200);
  assert.equal(preview.totalEntriesExact, false);
  assert.equal(preview.ranksExact, false);
  assert.equal(preview.entries[0].rank, null);
  assert.equal(preview.entries[0].globalRank, null);
  assert.equal(preview.pageBounds[0].firstRank, null);
  assert.equal(preview.capturedAt, null);
  assert.equal(preview.pageCount, 1, 'only captured pages are advertised');
});

test('explicit authoritative incomplete ranks are retained, not reranked from one', () => {
  const value = board(3, { complete: false, totalEntries: 200, ranksExact: true, totalEntriesExact: true });
  value.entries.forEach((row, index) => { row.rank = 77 + index; row.position += 76; });
  const { preview } = buildTrackSnapshotPaging(value);
  assert.deepEqual(preview.entries.map(row => row.rank), [77, 78, 79]);
  assert.equal(preview.ranksExact, true);
  assert.equal(preview.totalEntriesExact, true);
  value.entries[1].rank = 77;
  assert.equal(buildTrackSnapshotPaging(value).preview.ranksExact, false, 'duplicate ordinal ranks cannot claim exactness');
  value.entries[1].rank = 80;
  assert.equal(buildTrackSnapshotPaging(value).preview.ranksExact, false, 'decreasing ranks cannot claim exactness');
  value.entries[2].rank = 90;
  assert.deepEqual(buildTrackSnapshotPaging(value).preview.entries.map(row => row.rank), [77, 80, 90], 'partial captures may omit ranks');
});

test('equal-time source ranks stay ordinal through preview and the page-100 boundary', async t => {
  const source = board(103);
  source.entries.forEach(row => { row.timeMs = 1000; });
  const f = await fixture(t, source), h = readerFixture(f);
  const preview = await h.read('track-preview', id);
  assert.deepEqual(preview.entries.slice(0, 3).map(row => row.rank), [1, 2, 3]);
  const first = await h.read('track-page', id, 1), second = await h.read('track-page', id, 2);
  assert.equal(first.entries.at(-1).rank, 100);
  assert.deepEqual(second.entries.map(row => row.rank), [101, 102, 103]);
  assert.deepEqual(second.entries.map(row => row.globalRank), [101, 102, 103]);
  assert.equal(preview.pageBounds[0].lastRank, 100);
  assert.equal(preview.pageBounds[1].firstRank, 101);
  assert.equal(preview.pageBounds[0].maxTimeMs, preview.pageBounds[1].minTimeMs);
  assert.deepEqual((await h.read('track', id)).entries.map(row => row.rank), source.entries.map(row => row.rank));
});

test('Overall paging preserves supplied source order and ranks instead of applying track ordinal rules', () => {
  const source = { updatedAt: 100, complete: true, totalEntries: 3, entries: [3, 1, 2].map(rank =>
    ({ userId: account(rank), rank, score: 1000 - rank })) };
  const { preview, pages } = buildOverallSnapshotPaging(source);
  assert.deepEqual(preview.entries.map(row => row.rank), [3, 1, 2]);
  assert.deepEqual(pages[0].entries.map(row => row.userId), source.entries.map(row => row.userId));
});

test('empty and small boards use honest complete flags and page counts', () => {
  for (const count of [0, 1, 15, 16, 100]) {
    const { preview, pages } = buildTrackSnapshotPaging(board(count));
    assert.equal(preview.complete, count <= 15);
    assert.equal(preview.pageCount, Math.ceil(count / 100));
    if (count) assert.equal(pages[0].complete, true);
    else assert.equal(preview.bounds.minTimeMs, null);
  }
});

test('duplicate/mismatched accounts and inconsistent totals never certify a full board', () => {
  for (const mutate of [value => { value.entries[1].accountId = value.entries[0].accountId; },
    value => { value.entries[0].userId = account(300); }, value => { value.totalEntries = 2; },
    value => { delete value.totalEntries; }]) {
    const value = board(3); mutate(value);
    assert.equal(buildTrackSnapshotPaging(value).preview.sourceComplete, false);
    assert.equal(buildTrackSnapshotPaging(value).preview.ranksExact, false);
  }
  assert.throws(() => buildTrackSnapshotPaging(board(1, { entries: [{ timeMs: 0 }] })), /Invalid/);
});

test('bootstrap excludes large lookup categories without losing startup metadata or boards', () => {
  const names = ['manifest.json', 'overall.json', 'track-statistics.json', `tracks/${id}.json`, `track-previews/${id}.json`,
    `track-pages/${id}/1.json`, 'events/d_20261017.json', 'archives/2026-10.json', `profiles/${id}.json`,
    `profile-results/${id}.json`, `canonical/${id}/${id}.json`, 'recordings/123.json', `event-replays/d_20261017/${id}.json`];
  const input = { schemaVersion: 1, generation: 29, encoding: 'gzip-xor-a7-v1', files: Object.fromEntries(names.map(name => [name, {}])) };
  const bootstrap = buildSnapshotBootstrapIndex(input);
  assert.equal(bootstrap.partial, true);
  assert.equal(bootstrap.fallbackIndex, 'index.json');
  assert.deepEqual(Object.keys(bootstrap.files), names.slice(0, 8));
  assert.equal(Object.keys(input.files).length, names.length);
});

test('packaging hashes all payloads and preserves original monolith bytes and capture dates', async t => {
  const value = board(), f = await fixture(t, value);
  assert.deepEqual(await f.logical(`tracks/${id}.json`), value);
  const preview = await f.logical(`track-previews/${id}.json`);
  assert.equal(preview.capturedAt, capturedAt, 'track capture date, not newer export date');
  assert.equal((await f.logical(`track-pages/${id}/2.json`)).entries[0].rank, 101);
  for (const entry of Object.values(f.index.files)) {
    const bytes = await readFile(path.join(f.directory, entry.path));
    assert.ok(bytes.length <= MAX_FILE_BYTES);
    assert.equal(entry.path, `${createHash('sha256').update(bytes).digest('hex')}.bin`);
  }
  assert.deepEqual(JSON.parse(await readFile(path.join(f.directory, 'bootstrap-index.json'), 'utf8')), buildSnapshotBootstrapIndex(f.index));
  assert.equal((await publishSnapshot(f)).changed, false);
});

test('hydrated paging files are regenerated and retired generation archive restores bootstrap too', async t => {
  const f = await fixture(t), before = await readFile(path.join(f.directory, 'bootstrap-index.json'));
  await mkdir(path.join(f.stagingDirectory, 'track-previews'));
  await writeFile(path.join(f.stagingDirectory, 'track-previews', `${id}.json`), '{"stale":true}');
  assert.equal((await publishSnapshot(f)).changed, false);
  await writeFile(path.join(f.stagingDirectory, 'tracks', `${id}.json`), JSON.stringify(board(206)));
  const second = await publishSnapshot(f);
  assert.equal(second.generation, 2);
  assert.ok(second.archivePath.startsWith(f.historyDirectory + path.sep));
  assert.deepEqual(await readFile(path.join(f.directory, 'bootstrap-index.json')), before, 'immutable old generation');
  const restored = path.join(f.root, 'restored');
  await restoreSnapshotArchive(second.archivePath, restored);
  assert.deepEqual(await readFile(path.join(restored, 'bootstrap-index.json')), before);
  const restoredIndex = JSON.parse(await readFile(path.join(restored, 'index.json'), 'utf8'));
  assert.ok(restoredIndex.files[`tracks/${id}.json`]);
});

test('normal startup and concurrent previews/pages never fetch full index or monolith', async t => {
  const f = await fixture(t), h = readerFixture(f);
  const [overall, preview, page] = await Promise.all([h.read('overall'), h.read('track-preview', id), h.read('track-page', id, '2')]);
  assert.equal(overall.updatedAt, 100);
  assert.equal(preview.entries.length, 15);
  assert.equal(preview._snapshotCapturedAt, Date.parse(capturedAt));
  assert.equal(page.entries[0].rank, 101);
  assert.equal(h.count('bootstrap-index.json'), 1);
  assert.equal(h.count('index.json'), 0);
  assert.equal(h.count(f.index.files[`tracks/${id}.json`].path), 0);
  assert.equal(h.count(f.index.files['manifest.json'].path), 1, 'Overall resolves bound capture metadata once');
  assert.equal((await h.read('track-page', id, '', 2))._dataSource, 'cached');
  assert.equal(h.count(f.index.files[`track-pages/${id}/2.json`].path), 1);
  assert.equal((await h.read('track', id)).entries.length, 205, 'full logical read stays complete');
  assert.equal(h.count('index.json'), 0);
});

test('new preview automatically selects bootstrap on an otherwise legacy reader', async t => {
  const f = await fixture(t), h = readerFixture(f, { bootstrap: false });
  assert.equal((await h.read('track-preview', id)).entries.length, 15);
  assert.equal(h.count('index.json'), 0);
  assert.equal(h.count('bootstrap-index.json'), 1);
});

test('only profile and replay paths load full index lazily, once', async t => {
  const f = await fixture(t);
  for (const [directory, filename, value] of [['profiles', `${id}.json`, { accountId: id, updatedAt: 1 }],
    ['recordings', '123.json', { recording: 'encoded', frames: 12, updatedAt: 1 }]]) {
    await mkdir(path.join(f.stagingDirectory, directory));
    await writeFile(path.join(f.stagingDirectory, directory, filename), JSON.stringify(value));
  }
  const published = await publishSnapshot(f);
  f.directory = path.join(f.root, published.directory);
  const h = readerFixture(f);
  await h.read('track-preview', id);
  assert.equal(h.count('index.json'), 0);
  assert.equal((await h.read('profile', id)).accountId, id);
  assert.equal((await h.read('recording', 123)).frames, 12);
  assert.equal(h.count('index.json'), 1);
  assert.equal(h.count('bootstrap-index.json'), 1);
});

test('old generation bootstrap 404/410 falls back once with unchanged full reads', async t => {
  for (const status of [404, 410]) {
    const f = await fixture(t), h = readerFixture(f, { intercept: filename => filename === 'bootstrap-index.json' ? new Response('', { status }) : null });
    const [track, overall] = await Promise.all([h.read('track', id), h.read('overall')]);
    assert.equal(track.entries.length, 205);
    assert.equal(track.complete, true);
    assert.equal(overall.updatedAt, 100);
    assert.equal(h.count('bootstrap-index.json'), 1);
    assert.equal(h.count('index.json'), 1);
    await h.read('track-page', id, 1);
    assert.equal(h.count('bootstrap-index.json'), 1);
  }
});

test('missing page/track in bootstrap does not download full index or check pointer', async t => {
  const f = await fixture(t), h = readerFixture(f);
  assert.equal(await h.read('track-page', id, 4), null);
  assert.equal(await h.read('track-preview', 'b'.repeat(64)), null);
  assert.deepEqual(h.requests.map(request => request.filename), ['bootstrap-index.json']);
});

test('invalid page numbers and unsafe IDs produce no requests', async t => {
  const f = await fixture(t), h = readerFixture(f);
  for (const page of [undefined, '', 0, -1, '01', 1.5, '1/../2', '9007199254740992', Infinity]) assert.equal(await h.read('track-page', id, page), null);
  assert.equal(await h.read('track-preview', '../track'), null);
  assert.equal(await h.read('track-page', '../track', 1), null);
  assert.equal(h.requests.length, 0);
});

test('empty and incomplete paging payloads round trip through strict reader validation', async t => {
  for (const value of [board(0), board(20, { complete: false, totalEntries: 50 }), board(16)]) {
    const f = await fixture(t, value), h = readerFixture(f);
    const preview = await h.read('track-preview', id);
    assert.ok(preview);
    assert.equal(preview.entries.length, Math.min(15, value.entries.length));
    if (value.entries.length) assert.ok(await h.read('track-page', id, 1));
  }
});

test('optional bootstrap transient failure retries without silently downloading full index', async t => {
  let now = 0, failed = true;
  const f = await fixture(t), h = readerFixture(f, { now: () => now,
    intercept: filename => filename === 'bootstrap-index.json' && failed ? new Response('', { status: 503 }) : null });
  assert.equal(await h.read('track-preview', id), null);
  assert.equal(await h.read('track-preview', id), null);
  assert.equal(h.count('bootstrap-index.json'), 1);
  assert.equal(h.count('index.json'), 0);
  failed = false; now = 30_000;
  assert.equal((await h.read('track-preview', id)).entries.length, 15);
  assert.equal(h.count('bootstrap-index.json'), 2);
});

test('racer directory accepts bounded public cosmetic context without any profile reads', async () => {
  const contexts = [{}, { rank: 0, raceCount: 0, pbCount: 0, trackWins: 0, extraCount: 0, totalPlaytimeMs: 0 },
    { rank: 230, raceCount: 100, pbCount: 240, trackWins: 2, extraCount: 7, totalPlaytimeMs: 75000000,
      badges: { betaTester: true }, cosmeticUnlocks: ['theme:classic', 'badge:beat-owner', 'accent:cyan'] }];
  for (const cosmeticContext of contexts) {
    const requests = [];
    const read = createPublicSnapshotReader({ baseUrl: 'https://example.test/', fetchImpl: async url => {
      requests.push(new URL(url).pathname);
      return Response.json({ updatedAt: 100, entries: { [id]: { updatedAt: 90, name: 'Event-only racer', countryCode: 'US', cosmeticContext } } });
    } });
    const result = await read('racer-directory');
    assert.deepEqual(result.entries[id].cosmeticContext, cosmeticContext);
    assert.equal((await read('racer-directory'))._dataSource, 'cached');
    assert.deepEqual(requests, ['/racer-directory.json']);
  }
});

test('racer directory rejects private, unsafe or unbounded cosmetic context fields', async () => {
  const invalid = [null, [], 'context', { ownerUid: 'private' }, { replay: 'encoded' }, { arbitrary: 1 },
    { badges: null }, { badges: [] }, { badges: { owner: true } }, { badges: { betaTester: 'true' } },
    { badges: { betaTester: true, ownerAccountId: id } }, { cosmeticUnlocks: 'theme:classic' },
    { cosmeticUnlocks: Array(33).fill('theme:classic') }, { cosmeticUnlocks: ['theme:classic\n'] },
    { cosmeticUnlocks: ['unsafe'] }, { cosmeticUnlocks: ['theme:<script>'] }, { cosmeticUnlocks: [42] },
    { cosmeticUnlocks: [`theme:${'x'.repeat(65)}`] }];
  for (const key of ['rank', 'raceCount', 'pbCount', 'trackWins', 'extraCount', 'totalPlaytimeMs']) {
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null]) invalid.push({ [key]: value });
  }
  for (const cosmeticContext of invalid) {
    const read = createPublicSnapshotReader({ baseUrl: 'https://example.test/', fetchImpl: async () => Response.json({ updatedAt: 100,
      entries: { [id]: { updatedAt: 90, cosmeticContext } } }) });
    assert.equal(await read('racer-directory'), null, JSON.stringify(cosmeticContext));
  }
});

test('packed event-only racer context works through bootstrap without loading full/profile indexes', async t => {
  const f = await fixture(t);
  const cosmeticContext = { raceCount: 0, pbCount: 4, badges: { betaTester: false }, cosmeticUnlocks: ['accent:cyan'] };
  await writeFile(path.join(f.stagingDirectory, 'racer-directory.json'), JSON.stringify({ updatedAt: 50,
    entries: { [id]: { updatedAt: 40, name: 'Outside Overall 200', cosmeticContext } } }));
  const published = await publishSnapshot(f);
  f.directory = path.join(f.root, published.directory);
  const h = readerFixture(f);
  assert.deepEqual((await h.read('racer-directory')).entries[id].cosmeticContext, cosmeticContext);
  assert.equal(h.count('bootstrap-index.json'), 1);
  assert.equal(h.count('index.json'), 0);
  assert.equal(h.requests.length, 2);
});

test('first corrupt payload immediately retries with reload and never accepts bad bytes', async t => {
  const f = await fixture(t), payload = f.index.files[`track-previews/${id}.json`].path;
  let payloadReads = 0;
  const h = readerFixture(f, { intercept: filename => filename === payload && ++payloadReads === 1 ? new Response('corrupt bytes') : null });
  assert.equal((await h.read('track-preview', id)).entries.length, 15);
  assert.deepEqual(h.requests.filter(request => request.filename === payload).map(request => request.options.cache), ['force-cache', 'reload']);
  assert.equal(h.count('index.json'), 0);
});

test('persistent checksum failure is bounded and explicit reads recover after 30 seconds without reload', async t => {
  let now = 0, corrupt = true;
  const f = await fixture(t), payload = f.index.files[`track-previews/${id}.json`].path;
  const h = readerFixture(f, { now: () => now, intercept: filename => filename === payload && corrupt ? new Response('corrupt bytes') : null });
  assert.equal(await h.read('track-preview', id), null);
  assert.equal(h.count(payload), 2, 'one automatic integrity retry');
  const failures = await Promise.all(Array.from({ length: 20 }, () => h.read('track-preview', id)));
  assert.ok(failures.every(value => value === null));
  assert.equal(h.count(payload), 2);
  now = 29999; corrupt = false;
  assert.equal(await h.read('track-preview', id), null);
  now = 30000;
  const values = await Promise.all(Array.from({ length: 20 }, () => h.read('track-preview', id)));
  assert.ok(values.every(value => value?.entries.length === 15));
  assert.equal(h.count(payload), 3, 'retries stay coalesced');
  assert.equal(h.requests.filter(request => request.filename === payload).at(-1).options.cache, 'reload');
});

test('malformed bootstrap and legacy index retry once with cache bypass', async t => {
  for (const bootstrap of [true, false]) {
    for (const badIndex of ['{', 'null', '{"schemaVersion":1,"encoding":"gzip-xor-a7-v1","files":[]}',
      '{"schemaVersion":1,"encoding":"gzip-xor-a7-v1","files":{"overall.json":{"path":"../unsafe.bin"}}}']) {
      const f = await fixture(t), indexName = bootstrap ? 'bootstrap-index.json' : 'index.json';
      let indexes = 0;
      const h = readerFixture(f, { bootstrap, intercept: filename => filename === indexName && ++indexes === 1 ? new Response(badIndex) : null });
      assert.equal((await h.read('overall')).updatedAt, 100);
      assert.deepEqual(h.requests.filter(request => request.filename === indexName).map(request => request.options.cache), ['default', 'reload']);
      if (bootstrap) assert.equal(h.count('index.json'), 0);
    }
  }
});

test('invalid index cooldown is shared across logical paths and recovers on explicit read', async t => {
  let now = 0, corrupt = true;
  const f = await fixture(t);
  const h = readerFixture(f, { now: () => now, intercept: filename => filename === 'bootstrap-index.json' && corrupt ? new Response('{') : null });
  assert.equal(await h.read('overall'), null);
  assert.equal(h.count('bootstrap-index.json'), 2);
  for (const kind of ['manifest', 'track-statistics', 'snapshot-meta', 'event-totals']) assert.equal(await h.read(kind), null);
  assert.equal(h.count('bootstrap-index.json'), 2, 'different logical paths cannot amplify an invalid index');
  corrupt = false; now = 30000;
  assert.equal((await h.read('overall')).updatedAt, 100);
  assert.equal(h.count('bootstrap-index.json'), 3);
  assert.equal(h.requests.filter(request => request.filename === 'bootstrap-index.json').at(-1).options.cache, 'reload');
  assert.equal(h.count('index.json'), 0);
});

test('bootstrap generation recovery invalidates cached pages and capture dates together', async t => {
  const f = await fixture(t), oldPreviewPayload = f.index.files[`track-previews/${id}.json`].path;
  const nextCapturedAt = '2026-10-11T00:00:00.000Z';
  await writeFile(path.join(f.stagingDirectory, 'tracks', `${id}.json`), JSON.stringify(board(206)));
  await writeFile(path.join(f.stagingDirectory, 'manifest.json'), JSON.stringify({ schemaVersion: 1, trackIdsKnown: 1,
    tracks: { [id]: { checkedAt: Date.parse(nextCapturedAt) } } }));
  await publishSnapshot(f);
  const requests = [], changes = [];
  const read = createPublicSnapshotReader({ packed: true, bootstrap: true, baseUrl: 'https://example.test/public-snapshots1/',
    onGenerationChange: change => changes.push(change), fetchImpl: async url => {
      const pathname = new URL(url).pathname; requests.push(pathname);
      if (pathname === '/snapshot-current.json') return Response.json({ currentdir: 'public-snapshots2' });
      if (pathname === '/public-snapshots1/' + oldPreviewPayload) return new Response('', { status: 410 });
      return new Response(await readFile(path.join(f.root, pathname.slice(1))));
    } });
  assert.equal((await read('track-page', id, 2)).publishedEntries, 205);
  const preview = await read('track-preview', id);
  assert.equal(preview.publishedEntries, 206);
  assert.equal(preview._snapshotCapturedAt, Date.parse(nextCapturedAt));
  const page = await read('track-page', id, 2);
  assert.equal(page.publishedEntries, 206);
  assert.equal(page.capturedAt, nextCapturedAt);
  assert.equal(page.entries[0].rank, 101);
  assert.equal(changes.length, 1);
  assert.equal(requests.filter(url => url === '/snapshot-current.json').length, 1);
  assert.equal(requests.filter(url => url.endsWith('/index.json')).length, 0);
  assert.equal(requests.filter(url => url.endsWith('/bootstrap-index.json')).length, 2);
});

test('malformed paging metadata is rejected before display', async () => {
  for (const mutate of [value => { value.totalEntries = 1; }, value => { value.pageBounds[1].offset = 0; },
    value => { value.entries[1].rank = 1000; }, value => { value.bounds.minTimeMs = 1; },
    value => { value.complete = true; }, value => { value.capturedAt = 'invalid'; }, value => { value.entries.push(value.entries[0]); }]) {
    const { preview } = buildTrackSnapshotPaging(board(), { capturedAt }); mutate(preview);
    const read = createPublicSnapshotReader({ baseUrl: 'https://example.test/', fetchImpl: async () => Response.json(preview) });
    assert.equal(await read('track-preview', id), null);
  }
});

test('startup stays bounded with more than 7000 replay lookup records', async t => {
  const f = await fixture(t), replayRecord = f.index.files['overall.json'];
  for (let n = 1; n <= 7400; n++) f.index.files[`recordings/${n}.json`] = replayRecord;
  const full = JSON.stringify(f.index);
  await writeFile(path.join(f.directory, 'index.json'), full);
  const compact = await readFile(path.join(f.directory, 'bootstrap-index.json'));
  assert.ok(compact.length < Buffer.byteLength(full) / 100);
  const h = readerFixture(f);
  const preview = await h.read('track-preview', id);
  assert.equal(preview.entries.length, 15);
  assert.equal(h.count('index.json'), 0);
  assert.equal(h.requests.length, 2, 'one compact index plus one small preview');
});

test('legacy generation without paging or bootstrap still supports complete logical track reads', async t => {
  const f = await fixture(t);
  const legacyIndex = { ...f.index, files: Object.fromEntries(Object.entries(f.index.files).filter(([name]) => !/^track-(?:previews|pages)\//.test(name))) };
  const h = readerFixture(f, { intercept: filename => filename === 'bootstrap-index.json' ? new Response('', { status: 404 }) :
    filename === 'index.json' ? Response.json(legacyIndex) : null });
  assert.equal(await h.read('track-preview', id), null);
  assert.equal(await h.read('track-page', id, 1), null);
  const track = await h.read('track', id);
  assert.equal(track.complete, true);
  assert.equal(track.entries.length, 205);
  assert.equal(track.entries[1].rank, 2, 'legacy monolith ranks are not rewritten');
  assert.equal(h.count('bootstrap-index.json'), 1);
  assert.equal(h.count('index.json'), 1);
  assert.equal(h.count('snapshot-current.json'), 0);
});

test('private tracks over 2 MB are paged first and full logical reads reconstruct all rows', async t => {
  const source = board(351);
  for (const row of source.entries) row.name = 'x'.repeat(9000);
  assert.ok(Buffer.byteLength(JSON.stringify(source)) > MAX_DECODED_BYTES);
  const f = await fixture(t, source);
  assert.equal(f.index.files[`tracks/${id}.json`], undefined, 'no oversized public monolith or misleading alias');
  const catalog = await f.logical('snapshot-paging.json');
  assert.equal(catalog.legacyMonolithCoverageComplete, false);
  assert.deepEqual(catalog.omittedMonoliths, [`tracks/${id}.json`]);
  const manifest = await f.logical(`track-manifests/${id}.json`);
  assert.equal(manifest.monolithOmitted, true);
  assert.equal(manifest.fullBoardPath, null);
  assert.equal(manifest.boardMetadata.trackId, id);
  assert.equal(manifest.boardMetadata.entries, undefined);
  assert.equal(manifest.pageCount, 4);
  assert.equal((await f.logical('track-statistics.json')).tracks[id].count, 351, 'statistics use the original full source');
  for (const record of Object.values(f.index.files)) {
    assert.ok(record.decodedBytes <= MAX_DECODED_BYTES);
    assert.ok((await readFile(path.join(f.directory, record.path))).length <= MAX_FILE_BYTES);
  }
  const pageFiles = new Set(manifest.pageBounds.map(bound => f.index.files[bound.path].path));
  let active = 0, peak = 0;
  const h = readerFixture(f, { intercept: async filename => {
    if (!pageFiles.has(filename)) return null;
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setImmediate(resolve));
    const bytes = await readFile(path.join(f.directory, filename)); active--;
    return new Response(bytes);
  } });
  const full = await h.read('track', id);
  assert.ok(full, 'full logical reads remain available');
  assert.equal(full.complete, true);
  assert.equal(full.entries.length, 351);
  assert.equal(full.entries[100].rank, 101);
  assert.equal(full.entries[350].name.length, 9000);
  assert.equal(full._reconstructedFromPages, true);
  assert.equal(full._snapshotCapturedAt, Date.parse(capturedAt));
  assert.ok(peak <= 4);
  assert.equal(h.count('index.json'), 0);
  assert.equal((await publishSnapshot(f)).changed, false);
});

test('small monoliths remain unchanged while their manifests enumerate every public page', async t => {
  const source = board(205), f = await fixture(t, source);
  assert.deepEqual(await f.logical(`tracks/${id}.json`), source);
  const h = readerFixture(f), manifest = await h.read('track-manifest', id);
  assert.equal(manifest.monolithOmitted, false);
  assert.equal(manifest.fullBoardPath, `tracks/${id}.json`);
  assert.deepEqual(manifest.pageBounds.map(bound => bound.path), [1, 2, 3].map(page => `track-pages/${id}/${page}.json`));
  const catalog = await h.read('snapshot-paging');
  assert.equal(catalog.legacyMonolithCoverageComplete, true);
  assert.equal((await h.read('track', id))._reconstructedFromPages, undefined);
});

test('oversized Overall supports bounded previews/pages plus full reconstruction without losing metadata', async t => {
  const f = await fixture(t);
  const overall = { schemaVersion: 6, revision: 18, sourceRevision: 18, updatedAt: 400, complete: true, totalEntries: 531,
    trackSummaries: [{ trackId: id, fieldSize: 205 }], entries: Array.from({ length: 531 }, (_, index) =>
      ({ userId: account(index + 1), rank: index + 1, score: 1000 - index, name: 'x'.repeat(5000) })) };
  assert.ok(Buffer.byteLength(JSON.stringify(overall)) > MAX_DECODED_BYTES);
  await writeFile(path.join(f.stagingDirectory, 'overall.json'), JSON.stringify(overall));
  const published = await publishSnapshot(f); f.directory = path.join(f.root, published.directory);
  f.index = JSON.parse(await readFile(path.join(f.directory, 'index.json'), 'utf8'));
  assert.equal(f.index.files['overall.json'], undefined);
  const h = readerFixture(f), preview = await h.read('overall-preview');
  assert.equal(preview.entries.length, 15);
  assert.equal(preview.sourceComplete, true);
  assert.equal(preview.complete, false);
  assert.equal(preview.pageCount, 6);
  assert.equal(preview.capturedAt, '2026-10-17T00:00:00.000Z');
  const page = await h.read('overall-page', 6);
  assert.equal(page.entries.length, 31);
  assert.equal(page.entries[0].rank, 501);
  assert.equal((await h.read('overall-page', '', 6))._dataSource, 'cached');
  const full = await h.read('overall');
  assert.equal(full.entries.length, 531);
  assert.equal(full.complete, true);
  assert.equal(full._reconstructedFromPages, true);
  assert.deepEqual(full.trackSummaries, overall.trackSummaries);
  assert.equal(h.count('index.json'), 0);
  const catalog = await h.read('snapshot-paging');
  assert.deepEqual(catalog.omittedMonoliths, ['overall.json']);
  assert.equal(catalog.overall.manifestPath, 'overall-manifest.json');
  for (const record of Object.values(f.index.files)) assert.ok(record.decodedBytes <= MAX_DECODED_BYTES);
});

test('full reconstruction never returns a partial board and recovers with child integrity cooldown', async t => {
  const source = board(251);
  source.entries.forEach(row => { row.name = 'x'.repeat(9000); });
  const f = await fixture(t, source), badPage = f.index.files[`track-pages/${id}/2.json`].path;
  let now = 0, corrupt = true;
  const h = readerFixture(f, { now: () => now, intercept: filename => filename === badPage && corrupt ? new Response('corrupt') : null });
  assert.equal(await h.read('track', id), null);
  assert.equal(h.count(badPage), 2);
  now = 30000; corrupt = false;
  const full = await h.read('track', id);
  assert.ok(full);
  assert.equal(full.entries.length, 251);
  assert.equal(full.complete, true);
  assert.equal(h.count(badPage), 3);
});
