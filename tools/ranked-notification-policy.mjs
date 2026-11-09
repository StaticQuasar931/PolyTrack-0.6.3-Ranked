const ACCOUNT_ID = /^[a-f0-9]{64}$/;
const MAX_QUEUE_SIZE = 100;

function canonicalResult(item, accountId, ownerUid) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const resultId = item.resultId;
  if (typeof resultId !== 'string') return null;
  const match = /^([a-f0-9]{64})_([a-f0-9]{64})$/.exec(resultId);
  if (!match || match[1] !== accountId) return null;
  if (item.accountId !== undefined && item.accountId !== accountId) return null;
  if (item.ownerUid !== undefined && item.ownerUid !== ownerUid) return null;
  if (item.uid !== undefined && item.uid !== ownerUid) return null;
  if (item.trackId !== undefined && item.trackId !== match[2]) return null;

  if (item.queuedAt !== undefined && (!Number.isFinite(item.queuedAt) || item.queuedAt < 0)) return null;
  if (item.attempts !== undefined && (!Number.isSafeInteger(item.attempts) || item.attempts < 0)) return null;
  return {
    resultId,
    accountId,
    ownerUid,
    trackId: match[2],
    queuedAt: item.queuedAt ?? 0,
    attempts: item.attempts ?? 0,
    reason: typeof item.reason === 'string' ? item.reason.slice(0, 80) : 'pending'
  };
}

export function normalizeRankedNotifications(queue, accountId, ownerUid) {
  if (!ACCOUNT_ID.test(String(accountId || '')) || typeof ownerUid !== 'string' || !ownerUid || !Array.isArray(queue)) return [];

  const newest = new Map();
  for (const item of queue) {
    const normalized = canonicalResult(item, accountId, ownerUid);
    if (!normalized) continue;
    const previous = newest.get(normalized.resultId);
    if (!previous || normalized.queuedAt > previous.queuedAt ||
        normalized.queuedAt === previous.queuedAt && JSON.stringify(normalized) < JSON.stringify(previous)) {
      newest.set(normalized.resultId, normalized);
    }
  }

  return [...newest.values()]
    .sort((a, b) => b.queuedAt - a.queuedAt || a.resultId.localeCompare(b.resultId))
    .slice(0, MAX_QUEUE_SIZE);
}

export function rankedNotificationRetryDelay({ retryAt = 0, now = Date.now(), online = true, visible = true } = {}) {
  if (!online || !visible) return null;
  const deadline = Number(retryAt);
  const currentTime = Number(now);
  if (!Number.isFinite(deadline) || !Number.isFinite(currentTime)) return null;
  return Math.max(0, deadline - currentTime);
}
