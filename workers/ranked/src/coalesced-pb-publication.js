export const CANONICAL_PUBLICATION_JOB = 'canonical_reconcile_v2';
export const CANONICAL_PUBLICATION_CAPACITY = 200;

const MAX_ATTEMPTS = 3;
const MAX_BINDING_LENGTH = 1024;
const bindingKey = value => typeof value === 'string' && value.length > 0 && value.length <= MAX_BINDING_LENGTH;
const plainMap = value => value !== null && typeof value === 'object' &&
  [null, Object.prototype].includes(Object.getPrototypeOf(value));
const own = (value, key, fallback) => Object.hasOwn(value, key) ? value[key] : fallback;
const safeName = (value, min, max, invalid) => typeof value === 'string' &&
  value.length >= min && value.length <= max && !invalid.test(value) &&
  !Object.hasOwn(Object.prototype, value) && value !== '.' && value !== '..';
const trackName = value => safeName(value, 8, 80, /[^A-Za-z0-9_-]/);
const resultName = (value, trackId) => {
  if (typeof value !== 'string' || !value.endsWith('_' + trackId)) return false;
  return safeName(value.slice(0, -trackId.length - 1), 1, 128, /[^A-Za-z0-9_.:-]/);
};

function pendingState(data) {
  const pending = own(data, 'pendingTrackIds', []);
  const rebuilds = own(data, 'pendingFullRebuildTrackIds', []);
  const storedResults = own(data, 'pendingResultIds', Object.create(null));
  const storedBindings = own(data, 'pendingResultBindings', Object.create(null));
  const active = own(data, 'activeFullRebuildTrackId', '');
  if (!Array.isArray(pending) || !Array.isArray(rebuilds) || !plainMap(storedResults) || !plainMap(storedBindings) ||
      (active !== '' && !trackName(active)) ||
      pending.length > CANONICAL_PUBLICATION_CAPACITY || rebuilds.length > CANONICAL_PUBLICATION_CAPACITY ||
      Object.keys(storedResults).length > CANONICAL_PUBLICATION_CAPACITY) throw Error('PUBLICATION_QUEUE_INVALID');
  const tracks = new Set(), full = new Set(), results = Object.create(null);
  for (const track of pending) {
    if (!trackName(track)) throw Error('PUBLICATION_QUEUE_INVALID');
    tracks.add(track);
  }
  for (const track of rebuilds) {
    if (!trackName(track)) throw Error('PUBLICATION_QUEUE_INVALID');
    full.add(track); tracks.add(track);
  }
  let count = 0;
  for (const [track, ids] of Object.entries(storedResults)) {
    if (!trackName(track) || !Array.isArray(ids) || ids.length > CANONICAL_PUBLICATION_CAPACITY)
      throw Error('PUBLICATION_QUEUE_INVALID');
    const unique = new Set();
    for (const id of ids) {
      if (!resultName(id, track)) throw Error('PUBLICATION_QUEUE_INVALID');
      unique.add(id);
    }
    results[track] = [...unique];
    if (unique.size) tracks.add(track);
    count += unique.size;
    if (count > CANONICAL_PUBLICATION_CAPACITY) throw Error('PUBLICATION_QUEUE_INVALID');
  }
  if (count > CANONICAL_PUBLICATION_CAPACITY || tracks.size > CANONICAL_PUBLICATION_CAPACITY)
    throw Error('PUBLICATION_QUEUE_INVALID');
  const bindings = Object.create(null);
  for (const ids of Object.values(results)) for (const id of ids) if (Object.hasOwn(storedBindings, id)) {
    if (!bindingKey(storedBindings[id])) throw Error('PUBLICATION_QUEUE_INVALID');
    bindings[id] = storedBindings[id];
  }
  const bindingsNeedPrune = Object.keys(bindings).length !== Object.keys(storedBindings).length;
  return {tracks, full, results, count, bindings, bindingsNeedPrune};
}

// Private binding markers fence notifications that change an already queued PB.
// Reconciliation still fetches canonical documents, not values from these markers.
export async function enqueueCanonicalPublication(options = {}) {
  if (!plainMap(options)) throw Error('PUBLICATION_QUEUE_INPUT_INVALID');
  const {trackId, resultId, canonicalBindingKey, read, commit, now = Date.now()} = options;
  if (!trackName(trackId) || !resultName(resultId, trackId) || typeof read !== 'function' ||
      typeof commit !== 'function' || (canonicalBindingKey !== undefined && !bindingKey(canonicalBindingKey)) ||
      !Number.isSafeInteger(now) || now < 0)
    throw Error('PUBLICATION_QUEUE_INPUT_INVALID');
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const prior = await read(CANONICAL_PUBLICATION_JOB);
    if (prior != null && (!plainMap(prior) || !Object.hasOwn(prior, 'data') || !plainMap(prior.data) ||
        !Object.hasOwn(prior, 'updateTime') || typeof prior.updateTime !== 'string' || !prior.updateTime))
      throw Error('PUBLICATION_QUEUE_INVALID');
    const data = prior?.data ?? Object.create(null);
    const state = pendingState(data), ids = state.results[trackId] || [];
    // An active full build may be pinned to an older readTime. Do not claim it
    // covers a newly notified PB, and never reset or discard its checkpoint.
    if (own(data, 'activeFullRebuildTrackId', '') === trackId) throw Error('PUBLICATION_QUEUE_REBUILD_ACTIVE');
    const alreadyQueued = ids.includes(resultId);
    if (alreadyQueued && canonicalBindingKey !== undefined && state.bindings[resultId] === canonicalBindingKey &&
        !state.bindingsNeedPrune) return {queued: true, changed: false, publicationPending: true};
    if ((!state.tracks.has(trackId) && state.tracks.size >= CANONICAL_PUBLICATION_CAPACITY) ||
        (!alreadyQueued && state.count >= CANONICAL_PUBLICATION_CAPACITY)) throw Error('PUBLICATION_QUEUE_CAPACITY');
    state.tracks.add(trackId);
    state.results[trackId] = alreadyQueued ? ids : [...ids, resultId];
    if (canonicalBindingKey === undefined) delete state.bindings[resultId];
    else state.bindings[resultId] = canonicalBindingKey;
    const next = Object.assign(Object.create(null), data,
      {pendingTrackIds: [...state.tracks], pendingResultIds: state.results,
        pendingResultBindings: state.bindings, updatedAt: now});
    try {
      await commit(CANONICAL_PUBLICATION_JOB, next, prior);
      return {queued: true, changed: true, publicationPending: true};
    } catch (error) {
      if ([error?.status, error?.code].some(value => [429, '429', 'RESOURCE_EXHAUSTED'].includes(value)) ||
          !['FIRESTORE_409', 'FIRESTORE_412'].includes(error?.message) || attempt === MAX_ATTEMPTS - 1) throw error;
    }
  }
}
