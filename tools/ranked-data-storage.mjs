const LEGACY_CACHE_KEYS = new Set([
  'polytrack-0.6.2-overall-snapshot-v3',
  'polytrack-0.6.2-overall-snapshot-v4',
  'polytrack-0.6.2-track-snapshots-v3',
  'polytrack-0.6.2-s1-track-snapshots-v4',
  'polytrack-0.6.2-s1-overall-snapshot-v5',
  'polytrack-0.6.2-profile-last-names-v1',
  'polytrack-0.6.2-streak-leader-v2',
  'polytrack-062-ranked-event-totals-v1',
  'polytrack-062-events-v1',
]);

const MANAGED_KEY = /^(?:polytrack-0\.6\.2-category-ranks-[A-Za-z][A-Za-z-]*-v1|polytrack-062-events-v1-(?:totals|permanent|[dw]_\d{8}|kodub_\d+|archive-\d{4}-\d{2}))$/;
const DB_NAME = 'polytrack-ranked-cache-v1';
const STORE_NAME = 'cache';
const TOMBSTONE = Symbol('ranked-cache-deleted');

export function isRankedCacheKey(key) {
  if (typeof key !== 'string') return false;
  return LEGACY_CACHE_KEYS.has(key) || MANAGED_KEY.test(key);
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(transaction.error || Error('IndexedDB transaction failed'));
  });
}

function openIndexedDb(indexedDB, timeoutMs) {
  if (!indexedDB?.open) return Promise.reject(Error('IndexedDB is unavailable'));
  return new Promise((resolve, reject) => {
    let settled = false, request;
    const finish = (error, db) => {
      if (settled) { db?.close?.(); return; }
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(db);
    };
    const timer = setTimeout(() => finish(Error('IndexedDB open timed out')), timeoutMs);
    try { request = indexedDB.open(DB_NAME, 1); }
    catch (error) { finish(error); return; }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, {keyPath: 'key'});
    };
    request.onsuccess = () => finish(null, request.result);
    request.onerror = () => finish(request.error || Error('IndexedDB open failed'));
    request.onblocked = () => {};
  });
}

function idbPersistence(db) {
  const read = async key => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    return idbRequest(tx.objectStore(STORE_NAME).get(key));
  };
  const readAll = async () => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    return idbRequest(tx.objectStore(STORE_NAME).getAll());
  };
  const writeAndRead = async (key, value) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore(STORE_NAME).put({key, value});
    await done;
    const row = await read(key);
    return row?.value;
  };
  const migrateIfAbsentAndRead = async (key, value) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(key);
    request.onsuccess = () => { if (request.result === undefined) store.add({key, value}); };
    await done;
    const row = await read(key);
    return row?.value;
  };
  const deleteAndRead = async key => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore(STORE_NAME).delete(key);
    await done;
    return await read(key) === undefined;
  };
  return {read, readAll, writeAndRead, migrateIfAbsentAndRead, deleteAndRead, close: () => db.close()};
}

export function createRankedDataStorage({storage, indexedDB = globalThis.indexedDB,
  eventTarget = globalThis, BroadcastChannel: BroadcastChannelCtor = globalThis.BroadcastChannel,
  persistence: injectedPersistence, openTimeoutMs = 1200} = {}) {
  const values = new Map();
  const observedLegacy = new Map();
  const versions = new Map();
  const touched = new Set();
  let persistence = injectedPersistence || null;
  let channel = null;
  let closed = false;
  const pendingWrites = new Map();
  const pendingOperations = [];
  let drainPromise = null;
  let state = 'opening';
  let failure = null;
  let hydrated = false;
  let persistedWrites = 0;
  let readyPromise = Promise.resolve();

  const bump = key => {
    const next = (versions.get(key) || 0) + 1;
    versions.set(key, next);
    return next;
  };
  const setFailure = error => { failure = String(error?.message || error || 'storage failure'); state = 'memory-only'; };
  const drain = async () => {
    await readyPromise;
    while (!closed && (pendingOperations.length || pendingWrites.size)) {
      if (pendingOperations.length) {
        const operation = pendingOperations.shift();
        try { if (persistence) await operation(); } catch (error) { setFailure(error); }
        continue;
      }
      const [key, job] = pendingWrites.entries().next().value;
      pendingWrites.delete(key);
      if (!persistence) continue;
      try {
        if (job.type === 'set') {
          const saved = await persistence.writeAndRead(key, job.value);
          if (saved !== job.value) throw Error(`IndexedDB readback mismatch for ${key}`);
        } else {
          const removed = await persistence.deleteAndRead(key);
          if (removed !== true) throw Error(`IndexedDB delete readback failed for ${key}`);
        }
        persistedWrites++;
        removeLegacyIfUnchanged(key, job.legacy);
        notify(key);
      } catch (error) { setFailure(error); }
    }
  };
  const ensureDrain = () => {
    if (drainPromise || closed) return drainPromise;
    const active = drain();
    drainPromise = active;
    active.then(() => {
      if (drainPromise === active) drainPromise = null;
      if (pendingOperations.length || pendingWrites.size) ensureDrain();
    }, error => {
      setFailure(error);
      if (drainPromise === active) drainPromise = null;
      if (pendingOperations.length || pendingWrites.size) ensureDrain();
    });
    return active;
  };
  const enqueue = operation => {
    pendingOperations.push(operation);
    return ensureDrain();
  };
  const enqueueWrite = (key, job) => {
    pendingWrites.set(key, job);
    ensureDrain();
  };
  const readLegacy = key => {
    try { return storage?.getItem(key) ?? null; } catch (error) { setFailure(error); return null; }
  };
  const legacyManagedKeys = () => {
    const keys = new Set(LEGACY_CACHE_KEYS);
    try {
      const count = Number(storage?.length) || 0;
      for (let i = 0; i < count; i++) {
        const key = storage.key(i);
        if (isRankedCacheKey(key)) keys.add(key);
      }
    } catch (error) { setFailure(error); }
    return keys;
  };
  const removeLegacyIfUnchanged = (key, exactRaw) => {
    if (exactRaw === null || exactRaw === undefined) return;
    try {
      if (storage?.getItem(key) === exactRaw) {
        storage.removeItem(key);
        observedLegacy.set(key, null);
      }
    } catch (error) { setFailure(error); }
  };
  const notify = key => {
    try { channel?.postMessage({type: 'invalidate', key}); } catch {}
  };
  const refreshKey = (key, fallback = null) => {
    const version = bump(key);
    touched.add(key);
    observedLegacy.set(key, fallback);
    values.delete(key);
    if (!persistence) {
      const local = fallback === null ? readLegacy(key) : fallback;
      observedLegacy.set(key, local);
      if (local !== null) assignExternal(key, String(local));
      return;
    }
    enqueue(async () => {
      const row = await persistence.read(key);
      if (versions.get(key) !== version) return;
      if (row !== undefined) {
        if (fallback !== null && String(row.value) !== String(fallback)) {
          observedLegacy.set(key, String(fallback));
          assignExternal(key, String(fallback));
        } else {
          observedLegacy.set(key, fallback);
          assignExternal(key, String(row.value));
        }
      }
      else if (fallback !== null) {
        observedLegacy.set(key, String(fallback));
        const saved = await persistence.migrateIfAbsentAndRead(key, String(fallback));
        if (saved !== String(fallback)) assignExternal(key, String(saved));
        else persistedWrites++;
        assignExternal(key, String(saved));
      }
    });
  };
  const assignExternal = (key, value) => {
    if (values.get(key) === value) return;
    values.set(key, value);
    try {
      const EventCtor = eventTarget?.CustomEvent || globalThis.CustomEvent;
      if (EventCtor && eventTarget?.dispatchEvent) eventTarget.dispatchEvent(new EventCtor('polytrack-ranked-cache-change', {detail: {key}}));
    } catch {}
  };
  const onStorage = event => {
    if (!event || !isRankedCacheKey(event.key)) return;
    refreshKey(event.key, event.newValue ?? null);
  };
  const onBroadcast = event => {
    const data = event?.data;
    if (data?.type === 'invalidate' && isRankedCacheKey(data.key)) refreshKey(data.key);
  };

  try {
    eventTarget?.addEventListener?.('storage', onStorage);
    channel = BroadcastChannelCtor ? new BroadcastChannelCtor(DB_NAME) : null;
    if (channel) channel.onmessage = onBroadcast;
  } catch { channel = null; }

  const ready = (async () => {
    try {
      if (!persistence) persistence = idbPersistence(await openIndexedDb(indexedDB, openTimeoutMs));
      const rows = await persistence.readAll();
      if (!Array.isArray(rows)) throw Error('IndexedDB returned invalid cache rows');
      for (const row of rows) {
        if (row && isRankedCacheKey(row.key) && typeof row.value === 'string' && !touched.has(row.key)) {
          const raw = readLegacy(row.key);
          observedLegacy.set(row.key, raw);
          assignExternal(row.key, raw !== null && raw !== row.value ? String(raw) : row.value);
        }
      }
      hydrated = true;
      state = 'ready';
      for (const key of legacyManagedKeys()) {
        if (touched.has(key)) continue;
        const raw = readLegacy(key);
        if (raw === null) continue;
        const version = versions.get(key) || 0;
        const existing = rows.find(row => row?.key === key);
        if (existing && typeof existing.value === 'string') {
          const verified = await persistence.read(key);
          if (verified?.value === raw) removeLegacyIfUnchanged(key, raw);
          else {
            observedLegacy.set(key, String(raw));
            if (!touched.has(key)) assignExternal(key, String(raw));
          }
          continue;
        }
        try {
          const saved = await persistence.migrateIfAbsentAndRead(key, String(raw));
          if (saved === String(raw)) {
            persistedWrites++;
            if (!touched.has(key) && (versions.get(key) || 0) === version) assignExternal(key, String(raw));
            removeLegacyIfUnchanged(key, raw);
        } else if (typeof saved === 'string' && !touched.has(key)) assignExternal(key, saved);
        } catch (error) { setFailure(error); }
      }
    } catch (error) {
      setFailure(error);
      hydrated = true;
      for (const key of legacyManagedKeys()) {
        if (!touched.has(key)) {
          const raw = readLegacy(key);
          if (raw !== null && !values.has(key)) values.set(key, String(raw));
        }
      }
    }
  })();
  readyPromise = ready;

  function getItem(rawKey) {
    const key = String(rawKey);
    if (!isRankedCacheKey(key)) return storage?.getItem(key) ?? null;
    const raw = readLegacy(key);
    const previousRaw = observedLegacy.get(key);
    if (raw !== null && observedLegacy.has(key) && raw !== previousRaw) {
      observedLegacy.set(key, raw);
      assignExternal(key, String(raw));
    } else if (!observedLegacy.has(key)) observedLegacy.set(key, raw);
    if (values.has(key)) return values.get(key) === TOMBSTONE ? null : values.get(key);
    if (raw !== null) values.set(key, String(raw));
    return raw;
  }

  function setItem(rawKey, rawValue) {
    const key = String(rawKey), value = String(rawValue);
    if (!isRankedCacheKey(key)) { storage?.setItem(key, value); return; }
    const legacy = readLegacy(key);
    observedLegacy.set(key, legacy);
    touched.add(key);
    bump(key);
    values.set(key, value);
    enqueueWrite(key, {type: 'set', value, legacy});
  }

  function removeItem(rawKey) {
    const key = String(rawKey);
    if (!isRankedCacheKey(key)) { storage?.removeItem(key); return; }
    const legacy = readLegacy(key);
    touched.add(key);
    bump(key);
    values.set(key, TOMBSTONE);
    enqueueWrite(key, {type: 'remove', legacy});
  }

  async function flush() {
    await ready;
    while (drainPromise || pendingOperations.length || pendingWrites.size) {
      if (!drainPromise) ensureDrain();
      const current = drainPromise;
      if (current) await current;
    }
  }

  function status() {
    return {state, durable: state === 'ready' && !!persistence, failure, hydrated,
      managedKeysInMemory: values.size, persistedWrites};
  }

  async function close() {
    if (closed) return;
    await flush();
    closed = true;
    try { eventTarget?.removeEventListener?.('storage', onStorage); } catch {}
    try { channel?.close?.(); } catch {}
    try { persistence?.close?.(); } catch {}
  }

  return {getItem, setItem, removeItem, ready, flush, status, close};
}

export function createMemoryRankedDataPersistence(initialRows = []) {
  const rows = new Map(initialRows.map(row => [row.key, {key: row.key, value: row.value}]));
  return {
    async readAll() { return [...rows.values()].map(row => ({...row})); },
    async read(key) { const row = rows.get(key); return row && {...row}; },
    async writeAndRead(key, value) { rows.set(key, {key, value}); return rows.get(key).value; },
    async migrateIfAbsentAndRead(key, value) {
      if (!rows.has(key)) rows.set(key, {key, value});
      return rows.get(key).value;
    },
    async deleteAndRead(key) { rows.delete(key); return !rows.has(key); },
    async close() {},
    snapshot() { return [...rows.values()].map(row => ({...row})); },
  };
}
