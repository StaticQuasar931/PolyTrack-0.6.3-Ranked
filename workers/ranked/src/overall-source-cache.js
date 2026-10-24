// Server-only source catalog and single-bundle reuse. No network/auth/database implementation.
export const SOURCE_CATALOG_VERSION = 1;
export const SOURCE_CATALOG_MAX_TRACKS = 2000;
export const SOURCE_CATALOG_MAX_BYTES = 600000;
export const SOURCE_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
export const SOURCE_CATALOG_RESCAN_MS = 6 * 60 * 60 * 1000;
export const SOURCE_BUNDLE_MAX_BYTES = 16 * 1024 * 1024;
export const SOURCE_REQUEST_DEFAULT_BUDGET = 40;
const encoder = new TextEncoder();
const plain = value => value !== null && typeof value === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const uint = value => Number.isSafeInteger(value) && value >= 0;
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) &&
  !['__proto__', 'constructor', 'prototype'].includes(value);
const bytes = value => encoder.encode(JSON.stringify(value)).length;
const copy = value => JSON.parse(JSON.stringify(value));
const fail = code => { throw Error(`OVERALL_SOURCE_${code}`); };
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function validBinding(binding) {
  if (!plain(binding)) return false;
  const keys = Object.keys(binding).sort().join(',');
  if (keys === 'updateTime') return typeof binding.updateTime === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(binding.updateTime) &&
    Number.isFinite(Date.parse(binding.updateTime));
  return keys === 'revision,signature,sourceRevision,updatedAt' &&
    uint(binding.revision) && binding.revision > 0 && uint(binding.sourceRevision) &&
    binding.sourceRevision > 0 && uint(binding.updatedAt) && typeof binding.signature === 'string' &&
    /^[A-Za-z0-9_-]{1,128}$/.test(binding.signature);
}
function equalBinding(a, b) {
  return validBinding(a) && validBinding(b) && Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every(key => a[key] === b[key]);
}
function identity(document) {
  if (!plain(document) || !plain(document.data)) fail('DOCUMENT_INVALID');
  const id = document.id || document.name?.split('/').at(-1);
  if (!validId(id) || (document.name && document.name.split('/').at(-1) !== id) ||
      (document.data.trackId !== undefined && document.data.trackId !== id)) fail('IDENTITY_MISMATCH');
  return id;
}
export function sourceBinding(document, {newWrite = false} = {}) {
  identity(document);
  const {revision, signature, updatedAt, sourceRevision} = document.data;
  const binding = {revision, signature, updatedAt, sourceRevision};
  if (validBinding(binding)) return binding;
  const legacy = {updateTime: document.updateTime};
  if (!newWrite && validBinding(legacy)) return legacy;
  fail('BINDING_INVALID');
}
export function sourceCatalogIsReady(catalog) {
  try {
    if (!plain(catalog) || catalog.version !== SOURCE_CATALOG_VERSION || catalog.complete !== true ||
        !uint(catalog.scannedAt) || !plain(catalog.tracks)) return false;
    const ids = Object.keys(catalog.tracks);
    return ids.length <= SOURCE_CATALOG_MAX_TRACKS && catalog.count === ids.length &&
      ids.every(id => validId(id) && validBinding(catalog.tracks[id])) && bytes(catalog) <= SOURCE_CATALOG_MAX_BYTES;
  } catch { return false; }
}
export function sourceCatalogNeedsScan(catalog, {now = Date.now(), force = false} = {}) {
  return force === true || !uint(now) || !sourceCatalogIsReady(catalog) ||
    catalog.scannedAt > now || now - catalog.scannedAt >= SOURCE_CATALOG_RESCAN_MS;
}
export function sourceCatalogFromScan(documents, {fullScan, limitReached, scannedAt = Date.now()} = {}) {
  if (!Array.isArray(documents)) fail('SCAN_INVALID');
  const tracks = Object.create(null);
  for (const document of documents) {
    const id = identity(document);
    if (Object.hasOwn(tracks, id)) fail('DUPLICATE_TRACK');
    tracks[id] = sourceBinding(document);
  }
  const catalog = {version: SOURCE_CATALOG_VERSION, complete: true, scannedAt, count: documents.length, tracks};
  return fullScan === true && limitReached === false && sourceCatalogIsReady(catalog) ? catalog : null;
}
// Include in the SAME guarded commit as every accepted track rewrite, even non-scoring changes.
export function sourceCatalogAfterTrackWrite(catalog, trackId, document) {
  if (identity(document) !== trackId) fail('IDENTITY_MISMATCH');
  const binding = sourceBinding(document, {newWrite: true});
  if (!sourceCatalogIsReady(catalog)) return {version: SOURCE_CATALOG_VERSION, complete: false};
  const tracks = {...catalog.tracks, [trackId]: binding};
  const next = {version: SOURCE_CATALOG_VERSION, complete: true, scannedAt: catalog.scannedAt,
    count: Object.keys(tracks).length, tracks};
  return sourceCatalogIsReady(next) ? next : {version: SOURCE_CATALOG_VERSION, complete: false};
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
async function hash(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(canonical(value))))),
    b => b.toString(16).padStart(2, '0')).join('');
}
export function createSourceMemoryCache({maxBytes = 8 * 1024 * 1024} = {}) {
  if (!uint(maxBytes) || maxBytes > SOURCE_BUNDLE_MAX_BYTES) fail('MEMORY_BUDGET');
  let record;
  return {
    get(key) { return record?.key === key ? record.body : undefined; },
    set(key, body) {
      if (encoder.encode(body).length > maxBytes) { record = undefined; return false; }
      record = {key, body}; return true;
    },
    delete(key) { if (record?.key === key) record = undefined; }
  };
}

function validateBoard(id, binding, board) {
  if (!validId(id) || !plain(board) || !Array.isArray(board.entries) ||
      (board.trackId !== undefined && board.trackId !== id)) fail('BOARD_INVALID');
  if (!Object.hasOwn(binding, 'updateTime') &&
      !equalBinding(sourceBinding({id, data: board}, {newWrite: true}), binding)) fail('BINDING_MISMATCH');
  if (board.pagination && (!uint(board.pagination.totalEntries) || board.pagination.complete !== true ||
      board.entries.length !== board.pagination.totalEntries || board.totalEntries !== board.entries.length)) fail('PAGES_INCOMPLETE');
  if (!board.pagination && board.totalEntries !== undefined && (!uint(board.totalEntries) ||
      ((board.complete === true || board.sourceComplete === true) && board.totalEntries !== board.entries.length))) fail('ENTRIES_INCOMPLETE');
}
function markerValid(marker, scopeHash, now) {
  return plain(marker) && marker.version === 1 && marker.scopeHash === scopeHash &&
    hex(marker.digest) && hex(marker.catalogHash) && uint(marker.createdAt) && marker.createdAt <= now;
}
function requestBudget(max) {
  if (!Number.isSafeInteger(max) || max < 3 || max > 45) fail('REQUEST_BUDGET_INVALID');
  const stats = {total: 0, max, cacheReads: 0, cacheWrites: 0, publishedReads: 0, recoveryReads: 0, batchReads: 0, scanRequests: 0, pageReads: 0};
  return {stats, async run(kind, fn) {
    if (stats.total >= max) fail('REQUEST_BUDGET_EXHAUSTED');
    stats.total++; stats[kind]++;
    return fn();
  }};
}

/**
 * Trusted meta/current only; scope identifies project/database/collection/loader schema.
 * readDocuments(ids): exactly ONE batchGet HTTP request, returning raw docs (array/Map).
 * scanSources({request}): wrap EVERY raw query request with request(() => runQuery(...)).
 * loadEntries(root,id,read): use ONLY the supplied budgeted read for immutable pages.
 * readPage(collection,id): exactly ONE document HTTP request, no hidden retries.
 * Cache operations count against maxRequests (default40, hard cap45). Reserve the rest
 * of the Worker's assumed 50 for root/entitlement/publication/etc; parent must budget
 * those too. A scan callback is one logical scan, NOT necessarily one subrequest.
 * readPublishedBundle(marker): ONE batchGet request for the committed companion.
 * Reject malformed companion data with sourcePublicationRejected=true; infrastructure
 * errors must propagate, not amplify a quota failure into a full source scan.
 * beforeRecoveryScan(): ONE fresh trusted-meta read before any corruption scan;
 * reject superseded builds or failed reads without retry/fallback.
 * Candidates must be persisted ONLY with the successful overall+meta CAS commit.
 */
export async function loadOverallSources({meta, scope, readDocuments, scanSources, loadEntries, readPage,
  cache = globalThis.caches?.default, memory, now = Date.now(), forceScan = false,
  maxRequests = SOURCE_REQUEST_DEFAULT_BUDGET, maxBundleBytes = SOURCE_BUNDLE_MAX_BYTES, readPublishedBundle, beforeRecoveryScan}) {
  if (typeof scope !== 'string' || !scope.length || scope.length > 1024 || !uint(now) ||
      !uint(maxBundleBytes) || maxBundleBytes < 1 || maxBundleBytes > SOURCE_BUNDLE_MAX_BYTES) fail('OPTIONS_INVALID');
  const budget = requestBudget(maxRequests), scopeHash = await hash(scope);
  const current = copy(meta?.sourceCatalog ?? null);
  const marker = copy(meta?.sourceBundle ?? null);
  let previous, sourceCatalog = null, limitReached = false, cacheRejected = false;
  const boards = Object.create(null);
  const needsScan = sourceCatalogNeedsScan(current, {now, force: forceScan});
  let scanned = false;
  const cacheKey = digest => `https://overall-source-cache.invalid/bundle-v1/${scopeHash}/${digest}`;

  // At most ONE Cache API match for the last successfully committed bundle.
  if (!forceScan && sourceCatalogIsReady(current) && markerValid(marker, scopeHash, now)) {
    const key = cacheKey(marker.digest);
    let body = memory?.get(key);
    if (body === undefined && cache && now - marker.createdAt < SOURCE_CACHE_TTL_SECONDS * 1000) {
      const response = await budget.run('cacheReads', async () => {
        try { return await cache.match(key); } catch { return undefined; }
      });
      if (response) {
        try {
          if (!response.ok) fail('CACHE_CORRUPT');
          body = await response.text();
        } catch { cacheRejected = true; }
      }
    }
    for (let attempt = 0; attempt < 2 && !previous; attempt++) {
      if (attempt === 1) {
        if (typeof readPublishedBundle !== 'function' || !marker.publication) break;
        try { body = await budget.run('publishedReads', () => readPublishedBundle(marker)); }
        catch (error) {
          if (error?.sourcePublicationRejected !== true) throw error;
          body = undefined; cacheRejected = true;
        }
      }
      if (body === undefined) continue;
      try {
      const record = JSON.parse(body);
      const payload = record?.payload;
      if (encoder.encode(body).length > maxBundleBytes || record?.version !== 1 ||
          record.expiresAt !== marker.createdAt + SOURCE_CACHE_TTL_SECONDS * 1000 ||
          payload?.version !== 1 || payload.scopeHash !== scopeHash || payload.createdAt !== marker.createdAt ||
          !sourceCatalogIsReady(payload.catalog) || payload.catalog.scannedAt > payload.createdAt ||
          !plain(payload.boards) || Object.keys(payload.boards).length !== payload.catalog.count ||
          marker.catalogHash !== await hash(payload.catalog) || marker.digest !== await hash(payload)) fail('CACHE_CORRUPT');
      for (const [id, binding] of Object.entries(payload.catalog.tracks)) {
        if (!Object.hasOwn(payload.boards, id)) fail('CACHE_CORRUPT');
        validateBoard(id, binding, payload.boards[id]);
      }
      previous = payload;
      } catch {
        // Reject the entire bundle. Try the committed companion before one recovery scan.
        // No cached subset is ever mixed into this recovery build.
        cacheRejected = true;
      }
    }
  }
  async function expand(document, id, binding) {
    if (!document) fail('MISSING');
    if (identity(document) !== id || !equalBinding(sourceBinding(document), binding)) fail('BINDING_MISMATCH');
    const board = copy(document.data);
    if (board.pagination) {
      if (typeof loadEntries !== 'function' || typeof readPage !== 'function') fail('PAGE_LOADER_REQUIRED');
      const root = copy(board), {entries: ignored, ...before} = root;
      board.entries = await loadEntries(root, id, (collection, pageId) =>
        budget.run('pageReads', () => readPage(collection, pageId)));
      const {entries: ignoredAfter, ...after} = root;
      if (JSON.stringify(before) !== JSON.stringify(after)) fail('ROOT_MUTATED');
    }
    validateBoard(id, binding, board);
    return board;
  }
  let catalog;
  if (needsScan || !previous) {
    // Fixed publication slots can advance after our meta read. Distinguish that
    // ordinary race from corruption before paying for a full recovery scan.
    if (cacheRejected && typeof beforeRecoveryScan === 'function')
      await budget.run('recoveryReads', beforeRecoveryScan);
    scanned = true;
    if (typeof scanSources !== 'function') fail('SCAN_REQUIRED');
    const before = budget.stats.scanRequests;
    let scan;
    try { scan = await scanSources({request: fn => budget.run('scanRequests', fn)}); }
    catch (error) {
      if (cacheRejected && error instanceof Error) error.invalidateSourceBundle = true;
      throw error;
    }
    if (budget.stats.scanRequests === before) fail('SCAN_BUDGET_CONTRACT');
    if (!plain(scan) || !Array.isArray(scan.documents) || typeof scan.limitReached !== 'boolean') fail('SCAN_INVALID');
    catalog = sourceCatalogFromScan(scan.documents, {...scan, scannedAt: now});
    sourceCatalog = catalog || {version: SOURCE_CATALOG_VERSION, complete: false};
    limitReached = scan.limitReached || scan.fullScan !== true;
    for (const document of scan.documents) {
      const id = identity(document), binding = sourceBinding(document);
      boards[id] = await expand(document, id, binding);
    }
  } else {
    catalog = current;
    const changed = [];
    for (const [id, binding] of Object.entries(current.tracks)) {
      if (equalBinding(binding, previous.catalog.tracks[id]) && Object.hasOwn(previous.boards, id))
        boards[id] = previous.boards[id];
      else changed.push(id);
    }
    if (changed.length) {
      if (typeof readDocuments !== 'function') fail('BATCH_READER_REQUIRED');
      const result = await budget.run('batchReads', () => readDocuments(changed.slice()));
      const documents = result instanceof Map ? [...result.values()] : result;
      if (!Array.isArray(documents)) fail('BATCH_INVALID');
      const found = new Map(), wanted = new Set(changed);
      for (const document of documents) {
        const id = identity(document);
        if (!wanted.has(id) || found.has(id)) fail('BATCH_INVALID');
        found.set(id, document);
      }
      for (const id of changed) boards[id] = await expand(found.get(id), id, current.tracks[id]);
    }
  }

  // One expanded board per id: no duplicate raw/unpaged entries in the bundle.
  let sourceBundle = null, bundleBody;
  if (catalog) {
    const payload = {version: 1, scopeHash, createdAt: now, catalog, boards};
    const body = JSON.stringify({version: 1, expiresAt: now + SOURCE_CACHE_TTL_SECONDS * 1000, payload});
    if (encoder.encode(body).length <= maxBundleBytes) {
      const digest = await hash(payload), catalogHash = await hash(catalog);
      let saved = memory?.set(cacheKey(digest), body) === true;
      if (cache && budget.stats.total < budget.stats.max) {
        const stored = await budget.run('cacheWrites', async () => {
          try {
            await cache.put(cacheKey(digest), new Response(body, {headers: {
              'Content-Type': 'application/json', 'Cache-Control': `max-age=${SOURCE_CACHE_TTL_SECONDS}`}}));
            return true;
          } catch { return false; }
        });
        saved ||= stored;
      }
      bundleBody = body;
      // A durable companion may be committed even when the optional edge cache is unavailable.
      if (saved || typeof readPublishedBundle === 'function') sourceBundle = {version: 1, scopeHash, digest, catalogHash, createdAt: now};
    }
  }
  // A scan that cannot replace a marker must not leave the previous bundle authoritative.
  // Likewise, an overflow/partial scan explicitly invalidates an older ready catalog.
  if (scanned && !sourceBundle) sourceBundle = {version: 1, ready: false};
  const ids = Object.keys(boards).sort();
  return {boards: ids.map(id => boards[id]), trackCatalog: ids.flatMap(id => /^[a-f0-9]{64}$/.test(id) ? [{
    trackId: id, updatedAt: uint(boards[id].updatedAt) ? boards[id].updatedAt : uint(boards[id].builtAt) ? boards[id].builtAt : 0
  }] : []), limitReached, sourceCatalog, sourceBundle, bundleBody,
    unchanged: Boolean(previous && catalog && await hash(catalog.tracks) === await hash(previous.catalog.tracks) &&
      (!scanned || await hash(boards) === await hash(previous.boards))),
    usedSourceCatalog: !needsScan && Boolean(previous),
    recoveredCorruptBundle: cacheRejected, requests: {...budget.stats}};
}
