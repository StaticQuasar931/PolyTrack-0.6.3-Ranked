const METADATA_KEYS = ['track-statistics', 'cosmetic-directory', 'racer-directory', 'snapshot-meta'];

function hasMetadata(kind, value) {
  if (!value || typeof value !== 'object') return false;
  if (kind === 'track-statistics') return value.tracks && typeof value.tracks === 'object';
  if (kind === 'cosmetic-directory' || kind === 'racer-directory') {
    return value.entries && typeof value.entries === 'object';
  }
  return kind === 'snapshot-meta' && typeof value.capturedAt === 'string';
}

export function createSnapshotMetadataRecovery({
  read,
  onValue,
  now = Date.now,
  retryDelayMs = 30_000,
  maxRetries = 2,
}) {
  let epoch = 0;
  let pending = new Map();
  let received = new Set();
  let automaticRetries = new Map();
  let retryAt = new Map();

  function request(kind, isAutomaticRetry) {
    if (received.has(kind)) return Promise.resolve(true);
    if (pending.has(kind)) return pending.get(kind);

    const requestEpoch = epoch;
    if (isAutomaticRetry) automaticRetries.set(kind, (automaticRetries.get(kind) || 0) + 1);
    const promise = Promise.resolve().then(() => read(kind)).then(value => {
      if (requestEpoch !== epoch) return false;
      if (hasMetadata(kind, value)) {
        try {
          onValue(kind, value);
          received.add(kind);
          retryAt.delete(kind);
          return true;
        } catch {
          retryAt.set(kind, now() + retryDelayMs);
          return false;
        }
      }
      retryAt.set(kind, now() + retryDelayMs);
      return false;
    }, () => {
      if (requestEpoch !== epoch) return false;
      retryAt.set(kind, now() + retryDelayMs);
      return false;
    }).finally(() => {
      if (requestEpoch === epoch && pending.get(kind) === promise) pending.delete(kind);
    });
    pending.set(kind, promise);
    return promise;
  }

  function warm() {
    return Promise.all(METADATA_KEYS.map(kind => request(kind, false)));
  }

  function retryMissing({ automatic = false } = {}) {
    const at = now();
    const due = METADATA_KEYS.filter(kind =>
      !received.has(kind) &&
      !pending.has(kind) &&
      (!automatic || (automaticRetries.get(kind) || 0) < maxRetries) &&
      at >= (retryAt.get(kind) || 0)
    );
    return Promise.all(due.map(kind => request(kind, automatic)));
  }

  function reset() {
    epoch++;
    pending = new Map();
    received = new Set();
    automaticRetries = new Map();
    retryAt = new Map();
  }

  return { warm, retryMissing, reset };
}
