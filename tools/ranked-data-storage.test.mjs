import test from 'node:test';
import assert from 'node:assert/strict';
import {createRankedDataStorage, createMemoryRankedDataPersistence, isRankedCacheKey} from './ranked-data-storage.mjs';

function localStorageMock(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(String(key)) ?? null; },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { values.delete(String(key)); },
    snapshot() { return new Map(values); },
  };
}
const makeFacade = options => createRankedDataStorage({...options, BroadcastChannel: null});

const managed = 'polytrack-062-events-v1-d_20261108';

test('classifies only exact derived ranked-data keys', () => {
  for (const key of ['polytrack-0.6.2-overall-snapshot-v3', 'polytrack-0.6.2-overall-snapshot-v4',
    'polytrack-0.6.2-track-snapshots-v3', 'polytrack-0.6.2-s1-track-snapshots-v4',
    'polytrack-0.6.2-s1-overall-snapshot-v5', 'polytrack-0.6.2-profile-last-names-v1',
    'polytrack-0.6.2-streak-leader-v2', 'polytrack-062-ranked-event-totals-v1', 'polytrack-0.6.2-category-ranks-Arcade-v1',
    'polytrack-0.6.2-category-ranks-My-Category-v1', 'polytrack-062-events-v1',
    'polytrack-062-events-v1-totals', 'polytrack-062-events-v1-permanent', managed,
    'polytrack-062-events-v1-w_20261231', 'polytrack-062-events-v1-kodub_1794168000000',
    'polytrack-062-events-v1-archive-2026-11']) assert.equal(isRankedCacheKey(key), true, key);
  for (const key of ['profile-last-names-v1', 'streak-leader-v2', 'ranked-event-totals-v1',
    'polytrack-062-events-v1-best', 'polytrack-062-events-v1-retry',
    'polytrack-062-events-v1-d_20261108-extra', 'polytrack-0.6.2-category-ranks-Arcade_1-v1',
    'polytrack_v5_prod_track_My Track', 'run-replay', 'account-settings', 12, null])
    assert.equal(isRankedCacheKey(key), false, String(key));
});

test('migrates only managed legacy values after exact durable readback', async () => {
  const legacy = '{"period":"old","opaque":"  exact raw  "}';
  const storage = localStorageMock({[managed]: legacy, 'polytrack-062-events-v1-best': 'keep',
    'polytrack_v5_prod_track_Save': 'saved-track', 'polytrack-0.6.2-ui-font-scale': '110'});
  const persistence = createMemoryRankedDataPersistence();
  const facade = makeFacade({storage, persistence});
  await facade.ready;
  assert.equal(facade.getItem(managed), legacy);
  assert.equal(storage.getItem(managed), null);
  assert.equal(storage.getItem('polytrack-062-events-v1-best'), 'keep');
  assert.equal(storage.getItem('polytrack_v5_prod_track_Save'), 'saved-track');
  assert.equal(storage.getItem('polytrack-0.6.2-ui-font-scale'), '110');
  assert.deepEqual(persistence.snapshot(), [{key: managed, value: legacy}]);
  assert.equal(facade.status().state, 'ready');
  await facade.close();
});

test('sync API keeps unmanaged user writes on original localStorage', async () => {
  const storage = localStorageMock();
  const persistence = createMemoryRankedDataPersistence();
  const facade = makeFacade({storage, persistence});
  await facade.ready;
  facade.setItem('polytrack_v5_prod_track_Save', 'user-track');
  facade.setItem('my-account-setting', 'dark');
  assert.equal(facade.getItem('polytrack_v5_prod_track_Save'), 'user-track');
  assert.equal(facade.getItem('my-account-setting'), 'dark');
  await facade.flush();
  assert.deepEqual(persistence.snapshot(), []);
  assert.equal(storage.getItem('polytrack_v5_prod_track_Save'), 'user-track');
  await facade.close();
});

test('a pre-hydration local write wins over stale hydration and persists in call order', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const base = createMemoryRankedDataPersistence([{key: managed, value: 'stale durable'}]);
  const persistence = {...base, async readAll() { await gate; return base.readAll(); }};
  const storage = localStorageMock({[managed]: 'old local'});
  const facade = makeFacade({storage, persistence});
  facade.setItem(managed, 'new local');
  assert.equal(facade.getItem(managed), 'new local');
  release();
  await facade.ready;
  await facade.flush();
  assert.equal(facade.getItem(managed), 'new local');
  assert.equal(base.snapshot()[0].value, 'new local');
  assert.equal(storage.getItem(managed), null);
  await facade.close();
});

test('legacy cleanup uses compare-and-delete and preserves a newer old-tab value', async () => {
  const storage = localStorageMock({[managed]: 'legacy'});
  const base = createMemoryRankedDataPersistence();
  const persistence = {...base, async writeAndRead(key, value) {
    const readback = await base.writeAndRead(key, value);
    storage.setItem(key, 'newer old-tab write');
    return readback;
  }};
  const facade = makeFacade({storage, persistence});
  await facade.ready;
  facade.setItem(managed, 'committed derived value');
  await facade.flush();
  assert.equal(storage.getItem(managed), 'newer old-tab write');
  assert.equal(facade.getItem(managed), 'newer old-tab write');
  await facade.close();
});

test('open or transaction failures settle ready and retain legacy data without localStorage writes', async () => {
  const storage = localStorageMock({[managed]: 'preserve me'});
  const base = createMemoryRankedDataPersistence();
  const persistence = {...base,
    async migrateIfAbsentAndRead() { throw Error('transaction unavailable'); },
    async writeAndRead() { throw Error('write unavailable'); },
  };
  const facade = makeFacade({storage, persistence});
  await facade.ready;
  assert.equal(facade.getItem(managed), 'preserve me');
  facade.setItem('polytrack-062-events-v1-totals', 'memory only');
  await facade.flush();
  assert.equal(storage.getItem(managed), 'preserve me');
  assert.equal(storage.getItem('polytrack-062-events-v1-totals'), null);
  assert.equal(facade.getItem('polytrack-062-events-v1-totals'), 'memory only');
  assert.equal(facade.status().state, 'memory-only');
  assert.match(facade.status().failure, /unavailable/);
  await facade.close();
});

test('failed remove retains exact legacy value while the sync cache observes removal', async () => {
  const storage = localStorageMock({[managed]: 'preserve'});
  const base = createMemoryRankedDataPersistence();
  const persistence = {...base, async readAll() { throw Error('read transaction failed'); },
    async deleteAndRead() { throw Error('delete transaction failed'); }};
  const facade = makeFacade({storage, persistence});
  await facade.ready;
  facade.removeItem(managed);
  assert.equal(facade.getItem(managed), null);
  await facade.flush();
  assert.equal(storage.getItem(managed), 'preserve');
  assert.equal(facade.status().state, 'memory-only');
  await facade.close();
});

test('IndexedDB open failure resolves ready and keeps optional cache writes memory-only', async () => {
  const storage = localStorageMock({[managed]: 'legacy remains'});
  const facade = makeFacade({storage, indexedDB: {open() { throw Error('blocked open'); }}});
  await facade.ready;
  facade.setItem('polytrack-062-events-v1-totals', 'not written to localStorage');
  await facade.flush();
  assert.equal(facade.getItem(managed), 'legacy remains');
  assert.equal(storage.getItem(managed), 'legacy remains');
  assert.equal(facade.getItem('polytrack-062-events-v1-totals'), 'not written to localStorage');
  assert.equal(storage.getItem('polytrack-062-events-v1-totals'), null);
  assert.equal(facade.status().state, 'memory-only');
  await facade.close();
});

test('preserves and exposes a differing visible localStorage value without overwriting IndexedDB', async () => {
  const storage = localStorageMock({[managed]: 'legacy-visible'});
  const persistence = createMemoryRankedDataPersistence([{key: managed, value: 'durable-current'}]);
  const facade = makeFacade({storage, persistence});
  await facade.ready;
  assert.equal(facade.getItem(managed), 'legacy-visible');
  assert.equal(storage.getItem(managed), 'legacy-visible');
  assert.equal(persistence.snapshot()[0].value, 'durable-current');
  storage.setItem(managed, 'new old-tab value');
  assert.equal(facade.getItem(managed), 'new old-tab value');
  assert.equal(persistence.snapshot()[0].value, 'durable-current');
  await facade.close();
});

test('dispatches key-scoped cache-change events after external hydration only', async () => {
  const events = [];
  class CustomEvent { constructor(type, init) { this.type = type; this.detail = init.detail; } }
  const eventTarget = {CustomEvent, addEventListener() {}, removeEventListener() {}, dispatchEvent(event) { events.push(event); }};
  const persistence = createMemoryRankedDataPersistence([{key: managed, value: 'hydrated'}]);
  const facade = makeFacade({storage: localStorageMock(), persistence, eventTarget});
  await facade.ready;
  assert.deepEqual(events.map(event => [event.type, event.detail]), [['polytrack-ranked-cache-change', {key: managed}]]);
  facade.setItem(managed, 'local update');
  await facade.flush();
  assert.equal(events.length, 1);
  await facade.close();
});

test('broadcast invalidation reloads one key and sends no cache payload', async () => {
  const peers = new Set(), sent = [];
  class TestBroadcastChannel {
    constructor(name) { this.name = name; peers.add(this); }
    postMessage(data) {
      sent.push(data);
      for (const peer of peers) if (peer !== this && peer.name === this.name) peer.onmessage?.({data});
    }
    close() { peers.delete(this); }
  }
  const persistence = createMemoryRankedDataPersistence();
  const first = createRankedDataStorage({storage: localStorageMock(), persistence, BroadcastChannel: TestBroadcastChannel});
  const second = createRankedDataStorage({storage: localStorageMock(), persistence, BroadcastChannel: TestBroadcastChannel});
  await Promise.all([first.ready, second.ready]);
  first.setItem(managed, 'shared durable cache');
  await first.flush();
  await second.flush();
  assert.equal(second.getItem(managed), 'shared durable cache');
  assert.deepEqual(sent, [{type: 'invalidate', key: managed}]);
  await first.close();
  await second.close();
});

test('coalesces a thousand large same-key writes to the latest durable value', async () => {
  const storage = localStorageMock();
  const base = createMemoryRankedDataPersistence();
  let writes = 0;
  const persistence = {...base, async writeAndRead(key, value) { writes++; return base.writeAndRead(key, value); }};
  const facade = makeFacade({storage, persistence});
  await facade.ready;
  const bulk = 'x'.repeat(64 * 1024);
  for (let i = 0; i < 1000; i++) facade.setItem('polytrack-0.6.2-profile-last-names-v1', `${bulk}:${i}`);
  assert.equal(facade.getItem('polytrack-0.6.2-profile-last-names-v1'), `${bulk}:999`);
  await facade.flush();
  assert.ok(writes <= 2, `expected at most two writes, got ${writes}`);
  assert.equal(base.snapshot()[0].value, `${bulk}:999`);
  await facade.close();
});

test('keeps one in-flight write and only the newest pending write, preserving newer legacy data', async () => {
  const storage = localStorageMock();
  const base = createMemoryRankedDataPersistence();
  let calls = 0, releaseFirst, firstStarted;
  const started = new Promise(resolve => { firstStarted = resolve; });
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  const persistence = {...base, async writeAndRead(key, value) {
    calls++;
    if (calls === 1) { firstStarted(); await gate; }
    const saved = await base.writeAndRead(key, value);
    if (calls === 2) storage.setItem(key, 'newer old-tab value');
    return saved;
  }};
  const facade = makeFacade({storage, persistence});
  await facade.ready;
  facade.setItem(managed, 'in flight');
  await started;
  facade.setItem(managed, 'superseded pending value');
  facade.setItem(managed, 'latest pending value');
  releaseFirst();
  await facade.flush();
  assert.equal(calls, 2);
  assert.equal(base.snapshot()[0].value, 'latest pending value');
  assert.equal(storage.getItem(managed), 'newer old-tab value');
  assert.equal(facade.getItem(managed), 'newer old-tab value');
  await facade.close();
});

test('coalesced same-key remove and set preserve the final call order', async () => {
  const base = createMemoryRankedDataPersistence([{key: managed, value: 'initial'}]);
  const facade = makeFacade({storage: localStorageMock(), persistence: base});
  await facade.ready;
  facade.removeItem(managed);
  facade.setItem(managed, 'set after remove');
  await facade.flush();
  assert.equal(base.snapshot()[0].value, 'set after remove');
  facade.setItem(managed, 'remove after set');
  facade.removeItem(managed);
  await facade.flush();
  assert.deepEqual(base.snapshot(), []);
  await facade.close();
});
