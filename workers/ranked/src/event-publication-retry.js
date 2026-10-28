export const EVENT_PUBLICATION_RETRY_BASE_MS = 5 * 60000;
export const EVENT_PUBLICATION_RETRY_MAX_MS = 30 * 60000;

const reasons = new Set(['permanent_source_unavailable', 'permanent_source_changed',
  'finite_source_changed', 'finite_totals_coalescing', 'source_parts_missing', 'snapshot_expired', 'event_source_not_ready', 'publication_failed']);

export function publicationRetries(value, keys, now) {
  const output = {};
  for (const key of keys) {
    const retry = value?.[key];
    if (!retry || !reasons.has(retry.reason) || !Number.isSafeInteger(retry.attempts) ||
        retry.attempts < 1 || retry.attempts > 8 || !Number.isSafeInteger(retry.retryAt) ||
        retry.retryAt < 0 || retry.retryAt > now + EVENT_PUBLICATION_RETRY_MAX_MS) continue;
    output[key] = {reason: retry.reason, attempts: retry.attempts, retryAt: retry.retryAt};
  }
  return output;
}

export function publicationRetry(previous, reason, now) {
  if (!reasons.has(reason)) return null;
  const attempts = Math.min(8, (previous?.attempts || 0) + 1);
  return {reason, attempts, retryAt: now + Math.min(EVENT_PUBLICATION_RETRY_MAX_MS,
    EVENT_PUBLICATION_RETRY_BASE_MS * 2 ** (attempts - 1))};
}

// Firestore map ordering is not a version. Compare the entire coordinator state.
export function samePublicationState(left, right) {
  const ordered = value => Array.isArray(value) ? value.map(ordered) :
    value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort()
      .map(key => [key, ordered(value[key])])) : value;
  return JSON.stringify(ordered(left)) === JSON.stringify(ordered(right));
}
