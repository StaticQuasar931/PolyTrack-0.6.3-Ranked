import test from 'node:test';
import assert from 'node:assert/strict';
import {persistTrackSnapshot, rebuildOverall} from '../src/index.js';
import {SOURCE_PUBLICATION_COLLECTION} from '../src/overall-source-publication.js';
import {encode, decode} from '../../../tools/verifier/firestore.mjs';
import {createSourceMemoryCache, loadOverallSources, sourceBinding, sourceCatalogAfterTrackWrite,
  sourceCatalogFromScan, sourceCatalogIsReady, sourceCatalogNeedsScan, SOURCE_CACHE_TTL_SECONDS,
  SOURCE_CATALOG_RESCAN_MS} from '../src/overall-source-cache.js';

const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64);
const clone = value => JSON.parse(JSON.stringify(value));
function doc(id = A, revision = 1, extra = {}) {
  return {id, updateTime: '2026-10-18T12:00:00.123456789Z', data: {trackId: id,
    revision, sourceRevision: revision, signature: `signature_${revision}`, updatedAt: revision * 100,
    complete: true, totalEntries: 1, entries: [{accountId: `racer_${id}`, timeMs: revision}], ...extra}};
}
const scanOf = documents => ({documents, fullScan: true, limitReached: false});
function fakeCache() {
  const values = new Map(), calls = {match: 0, put: 0};
  return {values, calls, async put(key, response) {
    calls.put++;
    assert.equal(response.headers.get('cache-control'), `max-age=${SOURCE_CACHE_TTL_SECONDS}`);
    values.set(key, await response.text());
  }, async match(key) { calls.match++; return values.has(key) ? new Response(values.get(key)) : undefined; }};
}
function fixture(documents = [doc(A), doc(B)], cache = fakeCache()) {
  const state = {documents, cache, batchCalls: 0, sourceDocumentsRead: 0, scans: 0, queryRequests: 0, pageRequests: 0};
  const options = {scope: 'project/database/tracks/loader-v2', now: 1000, cache,
    readDocuments: async ids => {
      state.batchCalls++; state.sourceDocumentsRead += ids.length;
      return clone(state.documents.filter(d => ids.includes(d.id)));
    },
    scanSources: async ({request}) => {
      state.scans++;
      return request(async () => { state.queryRequests++; return scanOf(clone(state.documents)); });
    },
    readPage: async () => { state.pageRequests++; return {data: {entries: [{accountId: 'page_entry'}]}}; }
  };
  return {state, options};
}
async function prime(f) {
  const result = await loadOverallSources(f.options);
  assert.equal(sourceCatalogIsReady(result.sourceCatalog), true);
  assert.ok(result.sourceBundle);
  return {...f.options, meta: {sourceCatalog: result.sourceCatalog, sourceBundle: result.sourceBundle}};
}

test('385 sources: warm build uses ONE bundle match, ONE put, zero source DB reads', async () => {
  const f = fixture(Array.from({length: 385}, (_, i) => doc(i.toString(16).padStart(64, '0'))));
  const options = await prime(f);
  assert.equal(f.state.cache.calls.put, 1);
  const result = await loadOverallSources(options);
  assert.equal(result.boards.length, 385);
  assert.equal(result.trackCatalog.length, 385);
  assert.equal(result.usedSourceCatalog, true);
  assert.equal(f.state.scans, 1);
  assert.equal(f.state.sourceDocumentsRead, 0);
  assert.equal(f.state.batchCalls, 0);
  assert.deepEqual(result.requests, {total: 2, max: 40, cacheReads: 1,
    cacheWrites: 1, publishedReads: 0, recoveryReads: 0, batchReads: 0, scanRequests: 0, pageReads: 0});
  assert.equal(f.state.cache.calls.match, 1);
  assert.equal(f.state.cache.calls.put, 2);
  const stored = JSON.parse([...f.state.cache.values.values()].at(-1));
  assert.equal(Object.keys(stored.payload.boards).length, 385);
  assert.equal(JSON.stringify(stored).match(/racer_0{64}/g).length, 1, 'unpaged entries occur once');
  assert.equal(stored.payload.documents, undefined, 'raw roots are not duplicated');
});

test('one accepted binding change batch-reads only that track; many changes still use one batch', async () => {
  const f = fixture(), options = await prime(f), original = clone(options.meta.sourceCatalog);
  f.state.documents[0] = doc(A, 2);
  options.meta.sourceCatalog = sourceCatalogAfterTrackWrite(original, A, doc(A, 2));
  const result = await loadOverallSources(options);
  assert.equal(f.state.batchCalls, 1);
  assert.equal(f.state.sourceDocumentsRead, 1);
  assert.equal(result.requests.total, 3);
  assert.equal(result.requests.batchReads, 1);
  assert.equal(result.boards[0].revision, 2);
  assert.deepEqual(original.tracks[A], sourceBinding(doc(A)));
  options.meta.sourceBundle = result.sourceBundle; // Simulate successful root CAS only.
  await loadOverallSources(options);
  assert.equal(f.state.batchCalls, 1);
  f.state.documents = [doc(A, 3), doc(B, 3), doc(C, 3)];
  for (const document of f.state.documents) options.meta.sourceCatalog =
    sourceCatalogAfterTrackWrite(options.meta.sourceCatalog, document.id, document);
  const many = await loadOverallSources(options);
  assert.equal(many.requests.batchReads, 1);
  assert.equal(many.requests.total, 3);
  assert.equal(f.state.sourceDocumentsRead, 4);
});

test('changed-source cold batch checks all expected binding fields and missing/duplicate/extra identities', async () => {
  for (const field of ['revision', 'sourceRevision', 'signature', 'updatedAt']) {
    const f = fixture([doc(A)]), options = await prime(f);
    options.meta.sourceCatalog = sourceCatalogAfterTrackWrite(options.meta.sourceCatalog, A, doc(A, 2));
    f.state.documents[0] = doc(A, 2);
    f.state.documents[0].data[field] = field === 'signature' ? 'other' : 999;
    await assert.rejects(loadOverallSources(options), /BINDING_MISMATCH/);
    assert.equal(f.state.cache.calls.put, 1, 'failed builds do not stage bundles');
  }
  for (const documents of [[], [doc(C, 2)], [doc(A, 2), doc(A, 2)], [doc(A, 2, {trackId: C})]]) {
    const f = fixture([doc(A)]), options = await prime(f);
    options.meta.sourceCatalog = sourceCatalogAfterTrackWrite(options.meta.sourceCatalog, A, doc(A, 2));
    options.readDocuments = async () => documents;
    await assert.rejects(loadOverallSources(options), /MISSING|BATCH_INVALID|IDENTITY_MISMATCH/);
    assert.equal(f.state.scans, 1, 'do not silently retry a stale indexed source via full query');
  }
});

test('legacy query timestamp pins exact version; warm bundle and changed legacy batch retain precision', async () => {
  const legacy = {id: A, name: `projects/p/databases/d/documents/tracks/${A}`,
    updateTime: '2026-10-18T12:00:00.123456789Z', data: {trackId: A, builtAt: 42, entries: [], complete: true}};
  const f = fixture([legacy]), options = await prime(f);
  assert.deepEqual(options.meta.sourceCatalog.tracks[A], {updateTime: legacy.updateTime});
  const warm = await loadOverallSources(options);
  assert.equal(f.state.sourceDocumentsRead, 0);
  assert.deepEqual(warm.trackCatalog, [{trackId: A, updatedAt: 42}]);
  options.meta.sourceCatalog.tracks[A] = {updateTime: '2026-10-18T12:00:00.123456790Z'};
  await assert.rejects(loadOverallSources(options), /BINDING_MISMATCH/);
  f.state.documents[0].updateTime = options.meta.sourceCatalog.tracks[A].updateTime;
  await loadOverallSources(options);
  assert.throws(() => sourceBinding({...legacy, updateTime: ''}), /BINDING_INVALID/);
  assert.throws(() => sourceCatalogAfterTrackWrite(options.meta.sourceCatalog, A, legacy), /BINDING_INVALID/);
});

test('corrupted bundle is rejected wholly and recovered with one authoritative bounded scan', async () => {
  for (const corrupt of [() => '{broken', record => { record.payload.boards[A].trackId = B; },
    record => { record.payload.boards[A].updatedAt = 999; },
    record => { record.payload.boards[A].entries[0].timeMs = 999; },
    record => { delete record.payload.boards[A]; },
    record => { record.payload.catalog.tracks[A].revision = 999; },
    record => { record.expiresAt++; }]) {
    const f = fixture([doc(A)]), options = await prime(f);
    const [key, body] = [...f.state.cache.values][0], record = JSON.parse(body), replacement = corrupt(record);
    f.state.cache.values.set(key, typeof replacement === 'string' ? replacement : JSON.stringify(record));
    const recovered = await loadOverallSources(options);
    assert.equal(recovered.recoveredCorruptBundle, true);
    assert.equal(recovered.usedSourceCatalog, false);
    assert.deepEqual(recovered.boards, [doc(A).data]);
    assert.equal(recovered.requests.cacheReads, 1);
    assert.equal(recovered.requests.cacheWrites, 1);
    assert.equal(recovered.requests.scanRequests, 1);
    assert.equal(f.state.batchCalls, 0); assert.equal(f.state.scans, 2);
  }
  const f = fixture([doc(A)]), options = await prime(f), g = fixture([doc(B)]);
  await prime(g);
  const key = f.state.cache.values.keys().next().value;
  f.state.cache.values.set(key, g.state.cache.values.values().next().value);
  const recovered = await loadOverallSources(options);
  assert.deepEqual(recovered.boards, [doc(A).data]);
  assert.equal(recovered.recoveredCorruptBundle, true);
});

test('bundle miss, unavailable cache, missing marker and wrong scope use one full scan, not per-track reads', async () => {
  for (const mode of ['miss', 'unavailable', 'disabled', 'marker', 'scope']) {
    const f = fixture(), options = await prime(f);
    if (mode === 'miss') options.cache = fakeCache();
    if (mode === 'unavailable') options.cache = {match: async () => { throw Error('unavailable'); },
      put: async () => { throw Error('unavailable'); }};
    if (mode === 'disabled') options.cache = null;
    if (mode === 'marker') delete options.meta.sourceBundle;
    if (mode === 'scope') options.scope = 'different-project/database/tracks/loader-v2';
    const result = await loadOverallSources(options);
    assert.equal(f.state.scans, 2);
    assert.equal(f.state.batchCalls, 0);
    assert.equal(result.usedSourceCatalog, false);
    assert.equal(result.boards.length, 2);
    assert.equal(sourceCatalogIsReady(result.sourceCatalog), true);
    assert.ok(result.requests.cacheReads <= 1 && result.requests.cacheWrites <= 1);
  }
});

test('immutable pages use budgeted reader, expand before caching, and warm bundle needs no page reads', async () => {
  const document = doc(A, 1, {complete: false, sourceComplete: true, totalEntries: 2,
    pagination: {version: 1, generation: 'd'.repeat(64), complete: true, totalEntries: 2}});
  const f = fixture([document]);
  f.options.loadEntries = async (root, id, read) => {
    assert.equal(id, A); assert.equal(root.pagination.generation, 'd'.repeat(64));
    const first = await read('pages', 'page_0'), second = await read('pages', 'page_1');
    return [...first.data.entries, ...second.data.entries];
  };
  const options = await prime(f), result = await loadOverallSources(options);
  assert.equal(f.state.pageRequests, 2);
  assert.equal(result.requests.pageReads, 0);
  assert.equal(result.boards[0].entries.length, 2);
  await assert.rejects(loadOverallSources({...f.options, loadEntries: async () => []}), /PAGES_INCOMPLETE/);
  await assert.rejects(loadOverallSources({...f.options,
    loadEntries: async () => { throw Error('PUBLIC_PAGE_INCOMPLETE'); }}), /PUBLIC_PAGE_INCOMPLETE/);
  await assert.rejects(loadOverallSources({...f.options, loadEntries: async root => {
    root.revision++; return [{}, {}];
  }}), /ROOT_MUTATED/);
});

test('request ceiling charges cache, batch, query and pages; stops BEFORE crossing its limit', async () => {
  const f = fixture([doc(A)]);
  let actualQueries = 0;
  f.options.scanSources = async ({request}) => {
    for (let i = 0; i < 4; i++) await request(async () => { actualQueries++; });
    return scanOf([doc(A)]);
  };
  await assert.rejects(loadOverallSources({...f.options, maxRequests: 3}), /REQUEST_BUDGET_EXHAUSTED/);
  assert.equal(actualQueries, 3);
  assert.equal(f.state.cache.calls.put, 0);
  await assert.rejects(loadOverallSources({...f.options, maxRequests: 46}), /REQUEST_BUDGET_INVALID/);
  const g = fixture([doc(A)]), options = await prime(g);
  const changed = doc(A, 2, {complete: false, sourceComplete: true, totalEntries: 2,
    pagination: {complete: true, totalEntries: 2}});
  options.meta.sourceCatalog = sourceCatalogAfterTrackWrite(options.meta.sourceCatalog, A, changed);
  g.state.documents = [changed];
  options.loadEntries = async (root, id, read) => [
    ...(await read('pages', '0')).data.entries, ...(await read('pages', '1')).data.entries];
  await assert.rejects(loadOverallSources({...options, maxRequests: 3}), /REQUEST_BUDGET_EXHAUSTED/);
  assert.equal(g.state.pageRequests, 1, 'match + batch + one page exhaust budget');
  const result = await loadOverallSources({...options, maxRequests: 4});
  assert.equal(result.requests.total, 4);
  assert.equal(result.requests.cacheWrites, 0, 'optional bundle put skipped when no request room remains');
  assert.equal(result.sourceBundle, null);
  await assert.rejects(loadOverallSources({...f.options,
    scanSources: async () => scanOf([doc(A)])}), /SCAN_BUDGET_CONTRACT/);
});

test('invalid index/full fallback, proven EOF, source ceiling and empty source collection', async () => {
  const valid = sourceCatalogFromScan([doc(A)], {fullScan: true, limitReached: false, scannedAt: 1000});
  for (const catalog of [undefined, {}, {...valid, version: 2}, {...valid, complete: false},
    {...valid, count: 0}, {...valid, tracks: {[A]: {revision: 1}}}, {...valid, padding: 'x'.repeat(600000)}]) {
    assert.equal(sourceCatalogIsReady(catalog), false);
    const f = fixture(), options = await prime(f);
    const result = await loadOverallSources({...options, meta: {...options.meta, sourceCatalog: catalog}});
    assert.equal(result.usedSourceCatalog, false); assert.equal(f.state.scans, 2);
    assert.equal(result.requests.cacheReads, 0);
  }
  for (const flags of [{fullScan: false, limitReached: false}, {fullScan: true, limitReached: true},
    {limitReached: false}]) {
    const f = fixture();
    f.options.scanSources = ({request}) => request(async () => ({documents: [doc(A)], ...flags}));
    const result = await loadOverallSources(f.options);
    assert.deepEqual(result.sourceCatalog, {version: 1, complete: false});
    assert.deepEqual(result.sourceBundle, {version: 1, ready: false});
    assert.equal(result.limitReached, true);
  }
  assert.equal(sourceCatalogIsReady(sourceCatalogFromScan([], {fullScan: true, limitReached: false})), true);
  assert.throws(() => sourceCatalogFromScan([doc(A), doc(A)],
    {fullScan: true, limitReached: false}), /DUPLICATE_TRACK/);
  await assert.rejects(loadOverallSources(fixture([doc(A, 1, {entries: null})]).options), /BOARD_INVALID/);
});

test('2000-track and byte bounds invalidate catalog instead of truncating or blessing partial membership', () => {
  const documents = Array.from({length: 2000}, (_, i) => doc(`track_${i}`));
  const catalog = sourceCatalogFromScan(documents, {fullScan: true, limitReached: false});
  assert.equal(sourceCatalogIsReady(catalog), true);
  assert.equal(sourceCatalogFromScan([...documents, doc(A)], {fullScan: true, limitReached: false}), null);
  assert.deepEqual(sourceCatalogAfterTrackWrite(catalog, A, doc(A)), {version: 1, complete: false});
  assert.deepEqual(sourceCatalogAfterTrackWrite(null, A, doc(A)), {version: 1, complete: false});
  assert.equal(sourceCatalogIsReady(sourceCatalogAfterTrackWrite(catalog, 'track_0', doc('track_0', 2))), true);
  const byteOverflow = documents.map((document, i) => doc(`track_${i}_${'x'.repeat(100)}`, 1, {signature: 's'.repeat(128)}));
  assert.equal(sourceCatalogFromScan(byteOverflow, {fullScan: true, limitReached: false}), null);
});

test('six-hour/forced scans find administrative additions/deletions; track writes do not reset scan age', async () => {
  const f = fixture(), options = await prime(f);
  assert.equal(sourceCatalogNeedsScan(options.meta.sourceCatalog, {now: options.now}), false);
  assert.equal(sourceCatalogNeedsScan(options.meta.sourceCatalog,
    {now: options.now + SOURCE_CATALOG_RESCAN_MS}), true);
  f.state.documents = [doc(B), doc(C)];
  for (const overrides of [{now: options.now + SOURCE_CATALOG_RESCAN_MS}, {forceScan: true},
    {now: options.now + SOURCE_CACHE_TTL_SECONDS * 1000}]) {
    const result = await loadOverallSources({...options, ...overrides});
    assert.equal(result.usedSourceCatalog, false);
    assert.deepEqual(result.trackCatalog.map(row => row.trackId), [B, C]);
    assert.equal(result.requests.cacheReads, overrides.forceScan || overrides.now >= options.now + SOURCE_CACHE_TTL_SECONDS * 1000 ? 0 : 1);
  }
  assert.equal(f.state.scans, 4);
  assert.equal(sourceCatalogAfterTrackWrite(options.meta.sourceCatalog, A, doc(A, 2)).scannedAt,
    options.meta.sourceCatalog.scannedAt);
  // An accepted in-band delete must remove the key under root CAS; old bundle is not authoritative membership.
  delete options.meta.sourceCatalog.tracks[A]; options.meta.sourceCatalog.count--;
  const removed = await loadOverallSources(options);
  assert.deepEqual(removed.trackCatalog.map(row => row.trackId), [B]);
  assert.equal(removed.requests.batchReads, 0);
});

test('cache body cap skips one put and marker; optional memory stores exactly one bounded bundle', async () => {
  const f = fixture([doc(A)]);
  const oversized = await loadOverallSources({...f.options, maxBundleBytes: 100});
  assert.deepEqual(oversized.sourceBundle, {version: 1, ready: false});
  assert.equal(oversized.requests.cacheWrites, 0);
  assert.equal(oversized.boards.length, 1);
  const memory = createSourceMemoryCache({maxBytes: 100});
  assert.equal(memory.set('a', 'one'), true);
  memory.set('b', 'two'); assert.equal(memory.get('a'), undefined);
  assert.equal(memory.get('b'), 'two');
  assert.equal(memory.set('c', 'x'.repeat(101)), false); assert.equal(memory.get('b'), undefined);
  assert.throws(() => createSourceMemoryCache({maxBytes: 17000000}), /MEMORY_BUDGET/);
  const g = fixture([doc(A)]); g.options.cache = null; g.options.memory = createSourceMemoryCache();
  const options = await prime(g), first = await loadOverallSources(options);
  first.boards[0].entries[0].timeMs = 999;
  const second = await loadOverallSources(options);
  assert.equal(second.boards[0].entries[0].timeMs, 1);
  assert.equal(second.requests.total, 0);
  assert.equal(g.state.scans, 1);
});

test('staged but uncommitted bundle cannot replace root-authorized previous generation', async () => {
  const f = fixture([doc(A)]), options = await prime(f), root = clone(options.meta);
  options.meta.sourceCatalog = sourceCatalogAfterTrackWrite(options.meta.sourceCatalog, A, doc(A, 2));
  f.state.documents = [doc(A, 2)];
  const staged = await loadOverallSources(options);
  assert.notEqual(staged.sourceBundle.digest, root.sourceBundle.digest);
  // Simulate lost final CAS: no adoption of staged.sourceBundle. Old authorized bundle remains selectable.
  const old = await loadOverallSources({...options, meta: root});
  assert.equal(old.boards[0].revision, 1);
  assert.equal(old.requests.batchReads, 0);
});

test('helper CAS contract model: both scoring branches update binding, lost root CAS commits neither write', () => {
  const catalog = sourceCatalogFromScan([doc(A)], {fullScan: true, limitReached: false, scannedAt: 1000});
  const store = {meta: {sourceCatalog: catalog, dirty: false}, track: doc(A), rootToken: 1, trackToken: 1};
  function acceptedWrite(priorRoot, priorTrack, document, overallChanged) {
    const nextCatalog = sourceCatalogAfterTrackWrite(store.meta.sourceCatalog, document.id, document);
    if (priorRoot !== store.rootToken || priorTrack !== store.trackToken) throw Error('CAS_CONFLICT');
    store.meta = {...store.meta, sourceCatalog: nextCatalog, dirty: store.meta.dirty || overallChanged};
    store.track = document; store.rootToken++; store.trackToken++;
  }
  acceptedWrite(1, 1, doc(A, 2), false);
  assert.deepEqual(store.meta.sourceCatalog.tracks[A], sourceBinding(store.track));
  assert.equal(store.meta.dirty, false);
  const scanRootToken = store.rootToken, competingTrackToken = store.trackToken;
  acceptedWrite(scanRootToken, competingTrackToken, doc(A, 3), true);
  assert.deepEqual(store.meta.sourceCatalog.tracks[A], sourceBinding(store.track));
  const beforeConflict = clone(store);
  assert.throws(() => acceptedWrite(scanRootToken, competingTrackToken, doc(A, 4), false), /CAS_CONFLICT/);
  assert.deepEqual(store, beforeConflict);
  assert.notEqual(scanRootToken, store.rootToken, 'backfill publication must reject its old root CAS');
});

test('scan failures to replace a bounded catalog/bundle explicitly invalidate older ready authority', async () => {
  const f = fixture([doc(A)]), options = await prime(f);
  f.state.documents = [doc(B)];
  const uncached = await loadOverallSources({...options, forceScan: true, maxBundleBytes: 100});
  assert.deepEqual(uncached.sourceBundle, {version: 1, ready: false});
  const committed = {...options, meta: {sourceCatalog: uncached.sourceCatalog, sourceBundle: uncached.sourceBundle}};
  const next = await loadOverallSources(committed);
  assert.equal(next.usedSourceCatalog, false);
  assert.deepEqual(next.trackCatalog.map(row => row.trackId), [B]);
  const limited = await loadOverallSources({...options, forceScan: true,
    scanSources: ({request}) => request(async () => ({documents: [doc(B)], fullScan: false, limitReached: true}))});
  assert.deepEqual(limited.sourceCatalog, {version: 1, complete: false});
  assert.deepEqual(limited.sourceBundle, {version: 1, ready: false});
  const retry = await loadOverallSources({...options,
    meta: {sourceCatalog: limited.sourceCatalog, sourceBundle: limited.sourceBundle}});
  assert.equal(retry.requests.cacheReads, 0);
  assert.deepEqual(retry.trackCatalog.map(row => row.trackId), [B]);
});

// Real Worker entry points against an atomic, precondition-enforcing Firestore double.
const WORKER_TRACK = '5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038';
const TRACKS = '0.6.2_s1_leaderboards_track', META = '0.6.2_s1_release_meta/current';
const OVERALL = '0.6.2_s1_leaderboards_overall/main';
const BASE = 'projects/polytrack-052/databases/(default)/documents/';
function workerFixture(count = 1, {pending = false, legacy = false} = {}) {
  const data = new Map(), versions = new Map(), calls = [], commits = [], cache = fakeCache();
  const version = key => `2026-10-18T12:00:00.${String(versions.get(key) || 0).padStart(9, '0')}Z`;
  const f = {data, calls, commits, cache, beforeCommit: null, afterQuery: null};
  const wire = (key, value = data.get(key)) => ({name: BASE + key,
    fields: encode(value).mapValue.fields, updateTime: version(key)});
  const entries = [0, 1].map(i => ({accountId: `racer-${i}`, timeMs: 20000 + i * 1000, pbAt: 100,
    integrityVerified: true, runVerified: !pending, rank: i + 1, weight: 1, name: `Racer ${i}`}));
  for (let i = 0; i < count; i++) {
    const id = i === 0 ? WORKER_TRACK : i.toString(16).padStart(64, '0');
    const board = {trackId: id, entries: i === 0 ? clone(entries) : [], complete: true,
      totalEntries: i === 0 ? 2 : 0, revision: 1, sourceRevision: 1, updatedAt: 100,
      signature: 'initial', schemaVersion: 6, algorithmVersion: 'participation-v8-s1'};
    if (legacy) for (const key of ['revision', 'sourceRevision', 'signature', 'updatedAt']) delete board[key];
    data.set(`${TRACKS}/${id}`, board);
  }
  f.mutate = (key, value) => { data.set(key, clone(value)); versions.set(key, (versions.get(key) || 0) + 1); };
  f.prior = id => ({id, data: clone(data.get(`${TRACKS}/${id}`)), updateTime: version(`${TRACKS}/${id}`)});
  f.readyToBuild = () => f.mutate(META, {...data.get(META), dirty: true, lastOverallBuildAt: 0});
  f.env = {OPEN_BETA_ENABLED: 'false', __TEST_OVERALL_SOURCE_CACHE: cache,
    __TEST_FIRESTORE: async (path, init = {}) => {
      calls.push({path, body: init.body ? JSON.parse(init.body) : null});
      if (path === ':runQuery') {
        const q = JSON.parse(init.body).structuredQuery;
        assert.equal(q.from[0].collectionId, TRACKS);
        const after = q.startAt?.values?.[0]?.referenceValue || '';
        const result = [...data].filter(([key]) => key.startsWith(TRACKS + '/') && BASE + key > after)
          .sort(([a], [b]) => a.localeCompare(b)).slice(0, q.limit).map(([key]) => ({document: wire(key)}));
        if (f.afterQuery) { const hook = f.afterQuery; f.afterQuery = null; await hook(); }
        return result;
      }
      if (path === ':batchGet') return JSON.parse(init.body).documents.map(name => {
        const key = name.slice(BASE.length); return data.has(key) ? {found: wire(key)} : {missing: name};
      });
      if (path === ':commit') {
        const writes = JSON.parse(init.body).writes;
        if (f.beforeCommit) await f.beforeCommit(writes);
        // Validate the ENTIRE transaction before changing any document.
        for (const write of writes) {
          const key = write.update.name.slice(BASE.length), condition = write.currentDocument;
          if (condition && (condition.exists === false ? data.has(key) :
            !data.has(key) || condition.updateTime !== version(key))) throw Error('FIRESTORE_409');
        }
        for (const write of writes) f.mutate(write.update.name.slice(BASE.length),
          decode({mapValue: {fields: write.update.fields}}));
        commits.push(writes);
        return {writeResults: writes.map(write => ({updateTime: version(write.update.name.slice(BASE.length))}))};
      }
      const key = decodeURIComponent(path.slice(1));
      return data.has(key) ? wire(key) : null;
    }};
  return f;
}
const sourceReadNames = calls => calls.flatMap(call => call.path === ':batchGet' ? call.body.documents : [])
  .filter(name => name.includes('/' + TRACKS + '/'));
const entitlementNames = calls => calls.flatMap(call => call.path === ':batchGet' ? call.body.documents : [])
  .filter(name => name.includes('/0.6.2_s1_cosmetic_entitlements/'));

test('Worker E2E: 385-board warm rebuild reuses source and entitlement companions; changed track reads one', async () => {
  const f = workerFixture(385);
  await rebuildOverall(f.env, true);
  assert.equal(f.data.get(META).sourceCatalog.count, 385);
  assert.ok(f.data.get(META).sourceBundle.digest);
  f.readyToBuild();
  let start = f.calls.length, matches = f.cache.calls.match, puts = f.cache.calls.put;
  await rebuildOverall(f.env);
  let calls = f.calls.slice(start);
  assert.equal(calls.filter(call => call.path === ':runQuery').length, 0);
  assert.equal(sourceReadNames(calls).length, 0);
  assert.equal(entitlementNames(calls).length, 0);
  assert.equal(f.cache.calls.match - matches, 1); assert.equal(f.cache.calls.put - puts, 1);
  assert.equal(calls.length + 2, 7, 'five authoritative/commit HTTP plus two cache operations');
  const prior = f.prior(WORKER_TRACK), entries = clone(prior.data.entries); entries[0].timeMs--;
  await persistTrackSnapshot(f.env, WORKER_TRACK, entries, prior);
  assert.deepEqual(f.data.get(META).sourceCatalog.tracks[WORKER_TRACK], sourceBinding(f.prior(WORKER_TRACK)));
  f.readyToBuild(); start = f.calls.length;
  await rebuildOverall(f.env);
  calls = f.calls.slice(start);
  assert.equal(sourceReadNames(calls).length, 1);
  assert.equal(entitlementNames(calls).length, 0);
  assert.equal(calls.filter(call => call.path === ':runQuery').length, 0);
  assert.equal(calls.length + 2, 8);
});

for (const pending of [true, false]) test(`Worker E2E: accepted ${pending ? 'non-scoring' : 'scoring'} track rewrite atomically maintains exact root catalog`, async () => {
  const f = workerFixture(1, {pending}); await rebuildOverall(f.env, true);
  const before = clone(f.data.get(META)), prior = f.prior(WORKER_TRACK), entries = clone(prior.data.entries);
  entries[0].timeMs--;
  const result = await persistTrackSnapshot(f.env, WORKER_TRACK, entries, prior);
  assert.equal(result.overallChanged, !pending);
  const batch = f.commits.at(-1), track = batch.find(w => w.update.name.endsWith(`${TRACKS}/${WORKER_TRACK}`));
  const root = batch.find(w => w.update.name.endsWith(META));
  assert.ok(track?.currentDocument.updateTime); assert.ok(root?.currentDocument.updateTime);
  assert.deepEqual(f.data.get(META).sourceCatalog.tracks[WORKER_TRACK], sourceBinding(f.prior(WORKER_TRACK)));
  assert.deepEqual(f.data.get(META).sourceBundle, before.sourceBundle);
  assert.equal(f.data.get(META).dirty, !pending);
  assert.equal(f.data.get(META).sourceCatalog.scannedAt, before.sourceCatalog.scannedAt);
});

test('Worker E2E: new accepted track joins existing complete catalog in guarded commit', async () => {
  const f = workerFixture(); await rebuildOverall(f.env, true);
  await persistTrackSnapshot(f.env, C, [], null);
  assert.equal(f.data.get(META).sourceCatalog.count, 2);
  assert.deepEqual(f.data.get(META).sourceCatalog.tracks[C], sourceBinding(f.prior(C)));
});

test('Worker E2E: root CAS conflict commits neither track nor stale catalog for non-scoring rewrite', async () => {
  const f = workerFixture(1, {pending: true}); await rebuildOverall(f.env, true);
  const prior = f.prior(WORKER_TRACK), entries = clone(prior.data.entries); entries[0].timeMs--;
  const before = clone(prior.data);
  f.beforeCommit = async writes => {
    if (!writes.some(w => w.update.name.endsWith(`${TRACKS}/${WORKER_TRACK}`))) return;
    f.beforeCommit = null; f.mutate(META, {...f.data.get(META), concurrentCanary: true});
  };
  await assert.rejects(persistTrackSnapshot(f.env, WORKER_TRACK, entries, prior), /FIRESTORE_409/);
  assert.deepEqual(f.data.get(`${TRACKS}/${WORKER_TRACK}`), before);
  assert.equal(f.data.get(META).concurrentCanary, true);
  assert.deepEqual(f.data.get(META).sourceCatalog.tracks[WORKER_TRACK], sourceBinding(prior));
});

test('Worker E2E: accepted concurrent writer fences full-scan publication and cannot adopt orphan bundle', async () => {
  const f = workerFixture(); await rebuildOverall(f.env, true);
  const before = clone(f.data.get(OVERALL)), marker = clone(f.data.get(META).sourceBundle);
  f.afterQuery = async () => {
    const prior = f.prior(WORKER_TRACK), entries = clone(prior.data.entries); entries[0].timeMs--;
    await persistTrackSnapshot(f.env, WORKER_TRACK, entries, prior);
  };
  await assert.rejects(rebuildOverall(f.env, true), /FIRESTORE_409/);
  assert.deepEqual(f.data.get(OVERALL), before);
  assert.deepEqual(f.data.get(META).sourceBundle, marker);
  assert.deepEqual(f.data.get(META).sourceCatalog.tracks[WORKER_TRACK], sourceBinding(f.prior(WORKER_TRACK)));
  await rebuildOverall(f.env, true);
  assert.equal(f.data.get(META).overallRebuildFailureAttempts, undefined);
});

test('Worker E2E: six-hour/forced scans discover out-of-band writes; cold builds use publication; cooldown stays 30m', async () => {
  const f = workerFixture(); await rebuildOverall(f.env, true);
  f.mutate(META, {...f.data.get(META), dirty: true, lastOverallBuildAt: Date.now() - 20 * 60 * 1000});
  let start = f.calls.length;
  assert.equal((await rebuildOverall(f.env)).reason, 'cooldown');
  assert.equal(f.calls.length - start, 1);
  f.data.delete(`${TRACKS}/${WORKER_TRACK}`);
  f.mutate(`${TRACKS}/${B}`, doc(B).data);
  f.mutate(META, {...f.data.get(META), dirty: false, sourceCatalog: {...f.data.get(META).sourceCatalog,
    scannedAt: Date.now() - SOURCE_CATALOG_RESCAN_MS}});
  start = f.calls.length; await rebuildOverall(f.env);
  assert.equal(f.calls.slice(start).filter(c => c.path === ':runQuery').length, 1);
  assert.deepEqual(Object.keys(f.data.get(META).sourceCatalog.tracks), [B]);
  assert.deepEqual(f.data.get(OVERALL).trackCatalog.map(row => row.trackId), [B]);
  start = f.calls.length; await rebuildOverall(f.env, true);
  assert.equal(f.calls.slice(start).filter(c => c.path === ':runQuery').length, 1);
  f.cache.values.clear(); f.readyToBuild(); start = f.calls.length; await rebuildOverall(f.env);
  assert.equal(f.calls.slice(start).filter(c => c.path === ':runQuery').length, 0);
  assert.equal(sourceReadNames(f.calls.slice(start)).length, 0);
});

test('Worker E2E: exact 500 EOF enables catalog; 501-source ceiling explicitly invalidates it', async () => {
  const f = workerFixture(500); await rebuildOverall(f.env, true);
  assert.equal(f.data.get(META).sourceCatalog.count, 500);
  f.mutate(`${TRACKS}/${C}`, doc(C).data);
  await rebuildOverall(f.env, true);
  assert.deepEqual(f.data.get(META).sourceCatalog, {version: 1, complete: false});
  assert.deepEqual(f.data.get(META).sourceBundle, {version: 1, ready: false});
  assert.equal(f.data.get(OVERALL).sourceComplete, false);
  assert.equal(f.data.get(META).overallIncompleteReason, 'board-query-limit');
});

test('Worker E2E: trusted legacy query timestamp bootstraps and reuses without source reads', async () => {
  const f = workerFixture(1, {legacy: true}); await rebuildOverall(f.env, true);
  const binding = f.data.get(META).sourceCatalog.tracks[WORKER_TRACK];
  assert.equal(binding.updateTime, f.prior(WORKER_TRACK).updateTime);
  f.readyToBuild(); const start = f.calls.length; await rebuildOverall(f.env);
  assert.equal(sourceReadNames(f.calls.slice(start)).length, 0);
  assert.equal(f.calls.slice(start).some(call => call.path === ':runQuery'), false);
});

test('Worker E2E: request exhaustion reserves guarded backoff within 45 and preserves last publication', async () => {
  const f = workerFixture(); await rebuildOverall(f.env, true); f.readyToBuild();
  const before = clone(f.data.get(OVERALL)), start = f.calls.length, matches = f.cache.calls.match;
  f.env.__FIRESTORE_READ_AUDIT = {httpRequests: 40, failedRequests: 0, documentReadEstimate: 0, collections: {}};
  await assert.rejects(rebuildOverall(f.env), /OVERALL_REQUEST_BUDGET_EXHAUSTED/);
  assert.deepEqual(f.data.get(OVERALL), before);
  assert.equal(f.calls.length - start, 3, 'root read + failure meta read + guarded backoff commit');
  assert.equal(f.cache.calls.match - matches, 1);
  assert.equal(40 + f.calls.length - start + f.cache.calls.match - matches, 44);
  assert.equal(f.data.get(META).overallRebuildFailureAttempts, 1);
  assert.ok(f.data.get(META).overallRebuildRetryAt > Date.now());
  delete f.env.__FIRESTORE_READ_AUDIT;
  const retryStart = f.calls.length;
  assert.equal((await rebuildOverall(f.env)).reason, 'failure_cooldown');
  assert.equal(f.calls.length - retryStart, 1);
});

for (const revision of [undefined, 0]) test(`Worker E2E: legacy accepted write with prior revision ${revision} assigns positive complete binding`, async () => {
  const f = workerFixture(1, {legacy: true});
  if (revision !== undefined) f.data.get(`${TRACKS}/${WORKER_TRACK}`).revision = revision;
  const prior = f.prior(WORKER_TRACK), entries = clone(prior.data.entries); entries[0].timeMs--;
  await persistTrackSnapshot(f.env, WORKER_TRACK, entries, prior);
  assert.equal(f.data.get(`${TRACKS}/${WORKER_TRACK}`).revision, 1);
  assert.equal(f.data.get(`${TRACKS}/${WORKER_TRACK}`).sourceRevision, 1);
  assert.deepEqual(f.data.get(META).sourceCatalog, {version: 1, complete: false});
});

test('Worker E2E: forced admin request joining a warm non-forced build still performs a full scan', async () => {
  const f = workerFixture(); await rebuildOverall(f.env, true); f.readyToBuild();
  const start = f.calls.length;
  const ordinary = rebuildOverall(f.env, false), forced = rebuildOverall(f.env, true);
  await Promise.all([ordinary, forced]);
  assert.equal(f.calls.slice(start).filter(call => call.path === ':runQuery').length, 1);
});

test('Worker E2E: corrupt cache uses publication; both corrupt trigger scan and guarded failure backoff', async () => {
  const f = workerFixture(); await rebuildOverall(f.env, true); f.readyToBuild();
  const key = f.cache.values.keys().next().value;
  f.cache.values.set(key, '{corrupt');
  let start = f.calls.length; await rebuildOverall(f.env);
  assert.equal(f.calls.slice(start).filter(call => call.path === ':runQuery').length, 0);
  assert.equal(sourceReadNames(f.calls.slice(start)).length, 0);
  assert.equal(f.data.get(OVERALL).sourceComplete, true);
  f.readyToBuild();
  // Corrupt only the currently adopted key, then fail its recovery query.
  const adopted = f.data.get(META).sourceBundle;
  const adoptedKey = [...f.cache.values.keys()].find(k => k.endsWith('/' + adopted.digest));
  f.cache.values.set(adoptedKey, '{corrupt');
  f.mutate(SOURCE_PUBLICATION_COLLECTION + '/main_0', {version:1,digest:'0'.repeat(64),part:0,bundle:'bad'});
  f.afterQuery = () => { throw Error('RECOVERY_QUERY_FAILED'); };
  const before = clone(f.data.get(OVERALL));
  await assert.rejects(rebuildOverall(f.env), /RECOVERY_QUERY_FAILED/);
  assert.deepEqual(f.data.get(OVERALL), before);
  assert.deepEqual(f.data.get(META).sourceBundle, {version: 1, ready: false});
  assert.equal(f.data.get(META).overallRebuildFailureAttempts, 1);
  f.mutate(META, {...f.data.get(META), overallRebuildRetryAt: 0});
  const matches = f.cache.calls.match; start = f.calls.length;
  await rebuildOverall(f.env);
  assert.equal(f.cache.calls.match, matches, 'invalidated marker bypasses poisoned cache');
  assert.equal(f.calls.slice(start).filter(call => call.path === ':runQuery').length, 1);
});


test('Worker E2E: cold dirty build reads committed publication plus exactly changed source; no source query', async () => {
  const f=workerFixture(385); await rebuildOverall(f.env,true);
  const original=clone(f.data.get(META).sourceBundle);
  assert.equal(original.publication.parts,1);
  const prior=f.prior(WORKER_TRACK),entries=clone(prior.data.entries); entries[0].timeMs--;
  await persistTrackSnapshot(f.env,WORKER_TRACK,entries,prior);
  f.cache.values.clear(); f.readyToBuild(); const start=f.calls.length;
  await rebuildOverall(f.env);
  const calls=f.calls.slice(start);
  assert.equal(calls.some(c=>c.path===':runQuery'),false);
  assert.equal(sourceReadNames(calls).length,1);
  assert.equal(calls.filter(c=>c.path===':batchGet'&&c.body.documents.some(n=>n.includes('/'+SOURCE_PUBLICATION_COLLECTION+'/'))).length,1);
  assert.equal(entitlementNames(calls).length,0,'epoch-bound companion replaces canonical entitlement reads');
  assert.notEqual(f.data.get(META).sourceBundle.digest,original.digest);
});

test('Worker E2E: immutable publication is adopted only in final CAS and conflict leaves old snapshot usable', async () => {
  const f=workerFixture();await rebuildOverall(f.env,true);
  const published=clone(f.data.get(SOURCE_PUBLICATION_COLLECTION+'/main_0'));
  f.readyToBuild();
  f.beforeCommit=writes=>{
    if(!writes.some(w=>w.update.name.endsWith('/'+OVERALL)))return;
    f.beforeCommit=null; f.mutate(META,{...f.data.get(META),revision:999,dirty:true});
  };
  await assert.rejects(rebuildOverall(f.env),/FIRESTORE_409/);
  assert.deepEqual(f.data.get(SOURCE_PUBLICATION_COLLECTION+'/main_0'),published);
  f.mutate(META,{...f.data.get(META),overallRebuildRetryAt:0});f.cache.values.clear();
  const start=f.calls.length;await rebuildOverall(f.env);
  assert.equal(f.calls.slice(start).some(c=>c.path===':runQuery'),false);
});

test('Worker E2E: clean unchanged six-hour audit skips overall, migration and all entitlement reads', async () => {
  const f=workerFixture(385);await rebuildOverall(f.env,true);
  const before=clone(f.data.get(OVERALL));
  f.mutate(META,{...f.data.get(META),sourceCatalog:{...f.data.get(META).sourceCatalog,scannedAt:Date.now()-SOURCE_CATALOG_RESCAN_MS}});
  f.cache.values.clear();const start=f.calls.length;
  const result=await rebuildOverall(f.env);
  assert.equal(result.reason,'sources_unchanged');
  assert.equal(f.calls.slice(start).filter(c=>c.path===':runQuery').length,4);
  assert.equal(entitlementNames(f.calls.slice(start)).length,0);
  assert.equal(f.calls.slice(start).some(c=>c.path==='/'+OVERALL||c.path.endsWith('/release_migration')),false);
  assert.deepEqual(f.data.get(OVERALL),before);
  assert.equal(f.data.get(META).dirty,false);
});

for(const mode of ['dirty','metrics','forced'])test('unchanged sources do not suppress '+mode+' rebuild',async()=>{
  const f=workerFixture();await rebuildOverall(f.env,true);
  if(mode==='dirty')f.readyToBuild();
  if(mode==='metrics')f.mutate(META,{...f.data.get(META),derivedMetricsVersion:0});
  assert.equal((await rebuildOverall(f.env,mode==='forced')).rebuilt,true);
  assert.equal(f.data.get(META).derivedMetricsVersion,3);
});

test('24h: 48 dirty cold-cache builds read 44 changed roots plus four 385-root audits, not 48 full scans', async t=>{
  let now=Date.parse('2026-10-21T00:00:00Z'); t.mock.method(Date,'now',()=>now);
  const f=workerFixture(385);await rebuildOverall(f.env,true);
  let estimates=0,sourceRoots=0,publishedParts=0;
  for(let i=1;i<=48;i++){
    now+=30*60000;
    const prior=f.prior(WORKER_TRACK),entries=clone(prior.data.entries);entries[0].timeMs--;
    await persistTrackSnapshot(f.env,WORKER_TRACK,entries,prior);
    f.cache.values.clear();const start=f.calls.length;
    const audit={httpRequests:0,failedRequests:0,documentReadEstimate:0,collections:{}};
    f.env.__FIRESTORE_READ_AUDIT=audit;
    await rebuildOverall(f.env);
    delete f.env.__FIRESTORE_READ_AUDIT;
    const calls=f.calls.slice(start);
    const scanned=calls.filter(c=>c.path===':runQuery').length>0;
    sourceRoots+=scanned?385:sourceReadNames(calls).length;
    publishedParts+=calls.flatMap(c=>c.path===':batchGet'?c.body.documents:[]).filter(n=>n.includes('/'+SOURCE_PUBLICATION_COLLECTION+'/')).length;
    estimates+=audit.documentReadEstimate;
  }
  assert.equal(sourceRoots,1584);assert.equal(publishedParts,48);
  assert.equal(estimates,1876,'sources1584 + source parts48 + base authority192 + entitlement audit8 + entitlement parts44');
  // Before: every cold build scanned 385 sources plus six authority docs: 18768 reads.
  assert.equal(48*(385+6)-estimates,16892);
});


test('Worker E2E: unchanged-audit optimization detects out-of-band content edits even with identical binding',async()=>{
  const f=workerFixture();await rebuildOverall(f.env,true);
  const board=clone(f.prior(WORKER_TRACK).data);board.entries[0].timeMs--;
  f.mutate(TRACKS+'/'+WORKER_TRACK,board);
  f.mutate(META,{...f.data.get(META),sourceCatalog:{...f.data.get(META).sourceCatalog,scannedAt:Date.now()-SOURCE_CATALOG_RESCAN_MS}});
  assert.equal((await rebuildOverall(f.env)).rebuilt,true);
});

test('Worker E2E: published-source quota/network failure stops before source scan and keeps last publication',async()=>{
  const f=workerFixture();await rebuildOverall(f.env,true);f.readyToBuild();f.cache.values.clear();
  const before=clone(f.data.get(OVERALL)),request=f.env.__TEST_FIRESTORE;
  let attempts=0;
  f.env.__TEST_FIRESTORE=async(path,init)=>{
    if(path===':batchGet'&&JSON.parse(init.body).documents.some(n=>n.includes('/'+SOURCE_PUBLICATION_COLLECTION+'/'))){attempts++;throw Error('FIRESTORE_429');}
    return request(path,init);
  };
  const start=f.calls.length;
  await assert.rejects(rebuildOverall(f.env),/FIRESTORE_429/);
  assert.equal(attempts,1);
  assert.equal(f.calls.slice(start).some(c=>c.path===':runQuery'),false);
  assert.deepEqual(f.data.get(OVERALL),before);
  assert.equal(f.data.get(META).overallRebuildFailureAttempts,1);
});


test('24h quiet cold polls: four full source and entitlement audits retain discovery',async t=>{
  let now=Date.parse('2026-10-21T00:00:00Z');t.mock.method(Date,'now',()=>now);
  const f=workerFixture(385);await rebuildOverall(f.env,true);
  let reads=0,audits=0;
  for(let i=0;i<288;i++){
    now+=5*60000;f.cache.values.clear();
    const audit={httpRequests:0,failedRequests:0,documentReadEstimate:0,collections:{}};
    f.env.__FIRESTORE_READ_AUDIT=audit;
    const result=await rebuildOverall(f.env);if(result.rebuilt)audits++;
    reads+=audit.documentReadEstimate;delete f.env.__FIRESTORE_READ_AUDIT;
  }
  assert.equal(audits,4);assert.equal(reads,1852,'288 meta +1540 scan sources +4 source parts +4*(overall1+migration1+entitlements2+group1)');
});


test('Worker E2E: concurrent ordinary cold publication replacement aborts loser before any source recovery scan',async t=>{
  let now=Date.parse('2026-10-21T00:00:00Z');t.mock.method(Date,'now',()=>now);
  const f=workerFixture(385);await rebuildOverall(f.env,true);f.readyToBuild();f.cache.values.clear();
  const originalMarker=clone(f.data.get(META).sourceBundle),raw=f.env.__TEST_FIRESTORE;
  let intercepted=false,winnerState,loserStart=-1;
  f.env.__TEST_FIRESTORE=async(path,init)=>{
    if(!intercepted && path===':batchGet' && JSON.parse(init.body).documents.some(n=>n.includes('/'+SOURCE_PUBLICATION_COLLECTION+'/'))){
      intercepted=true;now++;
      // A distinct root models a second isolate without sharing the in-flight coalescer.
      const competing={...f.env,__TEST_FIRESTORE:raw,__FIRESTORE_ROOT_ENV:{}};
      const winnerStart=f.calls.length;
      assert.equal((await rebuildOverall(competing)).rebuilt,true);
      assert.equal(f.calls.slice(winnerStart).some(c=>c.path===':runQuery'),false);
      winnerState=clone([...f.data]);loserStart=f.calls.length;
    }
    return raw(path,init);
  };
  await assert.rejects(rebuildOverall(f.env),/OVERALL_BUILD_SUPERSEDED/);
  assert.equal(intercepted,true);
  assert.notEqual(f.data.get(META).sourceBundle.digest,originalMarker.digest);
  assert.deepEqual(f.calls.slice(loserStart).map(c=>c.path),[':batchGet','/'+META],
    'only the replaced companion read and one fresh metadata guard, no recovery/authority/backoff work');
  assert.deepEqual(clone([...f.data]),winnerState,'loser cannot alter winner publication or metadata');
});

for(const mode of ['advanced','deleted','unversioned','read_error'])test('Worker E2E: corrupt recovery guard '+mode+' aborts conservatively with no fallback',async()=>{
  const f=workerFixture();await rebuildOverall(f.env,true);f.readyToBuild();
  f.cache.values.clear();
  f.mutate(SOURCE_PUBLICATION_COLLECTION+'/main_0',{version:1,digest:'0'.repeat(64),part:0,bundle:'bad'});
  const raw=f.env.__TEST_FIRESTORE,calls=[],failure=Error('RECOVERY_META_READ_FAILED');
  let metaReads=0,expectedState;
  f.env.__TEST_FIRESTORE=async(path,init)=>{
    calls.push(path);
    if(path==='/'+META && ++metaReads===2){
      if(mode==='advanced')f.mutate(META,{...f.data.get(META),dirty:true,revision:999});
      if(mode==='deleted')f.data.delete(META);
      expectedState=clone([...f.data]);
      if(mode==='read_error')throw failure;
      if(mode==='unversioned'){const doc=await raw(path,init);delete doc.updateTime;return doc;}
    }
    return raw(path,init);
  };
  await assert.rejects(rebuildOverall(f.env),error=>mode==='read_error'?error===failure:/OVERALL_BUILD_SUPERSEDED/.test(error.message));
  assert.equal(metaReads,2,'one original metadata read plus one recovery check, no backoff reread');
  assert.deepEqual(calls,['/'+META,':batchGet','/'+META]);
  assert.deepEqual(clone([...f.data]),expectedState,'no bookkeeping or invalidation writes after rejected check');
});

test('Worker E2E: unchanged metadata permits exactly one corruption scan after the fresh guard',async()=>{
  const f=workerFixture();await rebuildOverall(f.env,true);f.readyToBuild();f.cache.values.clear();
  f.mutate(SOURCE_PUBLICATION_COLLECTION+'/main_0',{version:1,digest:'0'.repeat(64),part:0,bundle:'bad'});
  const start=f.calls.length;
  assert.equal((await rebuildOverall(f.env)).rebuilt,true);
  const calls=f.calls.slice(start),scan=calls.findIndex(c=>c.path===':runQuery');
  assert.equal(calls.filter(c=>c.path===':runQuery').length,1);
  assert.deepEqual(calls.slice(0,scan).map(c=>c.path),['/'+META,':batchGet','/'+META]);
  assert.equal(f.data.get(OVERALL).sourceComplete,true);
});

test('deterministic Overall budget failures suppress unchanged-source scans and recover on source change',async t=>{
  let now=Date.parse('2026-10-26T00:00:00Z');t.mock.method(Date,'now',()=>now);
  const f=workerFixture();await rebuildOverall(f.env,true);f.readyToBuild();f.cache.values.clear();
  const old=clone(f.data.get(OVERALL)),request=f.env.__TEST_FIRESTORE;let expansions=0;
  f.env.__TEST_FIRESTORE=async(path,init)=>{
    if(path===':batchGet'&&JSON.parse(init.body).documents.some(name=>name.includes('/'+SOURCE_PUBLICATION_COLLECTION+'/'))){
      expansions++;throw Object.assign(Error('OVERALL_SOURCE_REQUEST_BUDGET_EXHAUSTED'),{invalidateSourceBundle:true});
    }
    return request(path,init);
  };
  await assert.rejects(rebuildOverall(f.env),/BUDGET_EXHAUSTED/);
  const blocked=f.data.get(META);assert.equal(blocked.overallRebuildRetryAt,now+86400000);
  assert.equal(blocked.overallRebuildBlockedSource.sourceDigest,'','block binds the invalidated source marker, not its old digest');
  for(let i=0;i<12;i++){now+=5*60000;assert.equal((await rebuildOverall(f.env)).reason,'failure_cooldown');}
  assert.equal(expansions,1);assert.deepEqual(f.data.get(OVERALL),old);
  f.mutate(META,{...f.data.get(META),revision:Number(blocked.revision||0)+1});
  f.env.__TEST_FIRESTORE=request;
  assert.equal((await rebuildOverall(f.env)).rebuilt,true,'changed source bypasses deterministic old-source block');
  assert.equal(f.data.get(META).overallRebuildBlockedSource,undefined);
});