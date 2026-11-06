export const PROFILE_RETRY_BASE_MS = 15 * 60000;
export const PROFILE_RETRY_MAX_MS = 60 * 60000;

export function profileMaintenanceClock(now) {
  if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - PROFILE_RETRY_MAX_MS)
    throw Error('PROFILE_MAINTENANCE_CLOCK_INVALID');
  return now;
}

// Retry hints suppress work only for the exact queued identity, never authorize it.
export function profileRetryEntries(job, pending, now) {
  profileMaintenanceClock(now);
  const state = job.profileMaintenance;
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const identityKey = JSON.stringify([job.signature || '', canonical(job.identity || null)]);
  const entries = Object.create(null);
  if (state?.version === 1 && state.identityKey === identityKey) {
    for (const id of pending) {
      const retry = state.entries?.[id];
      if (retry && Number.isSafeInteger(retry.attempts) && retry.attempts >= 1 && retry.attempts <= 3 &&
          Number.isSafeInteger(retry.attemptedAt) && retry.attemptedAt >= 0 && retry.attemptedAt <= now &&
          Number.isSafeInteger(retry.retryAt) && retry.retryAt > retry.attemptedAt &&
          retry.retryAt - retry.attemptedAt <= PROFILE_RETRY_MAX_MS)
        entries[id] = {...retry};
    }
  }
  return {identityKey, entries};
}

export function deferProfileTrack(entries, id, now, continuation = false) {
  profileMaintenanceClock(now);
  const attempts = continuation ? 1 : Math.min(3, (entries[id]?.attempts || 0) + 1);
  entries[id] = {attempts, attemptedAt:now,
    retryAt:now + (continuation ? PROFILE_RETRY_BASE_MS : Math.min(PROFILE_RETRY_MAX_MS, PROFILE_RETRY_BASE_MS * 2 ** (attempts - 1)))};
}

export function deferredProfileJob(job, now) {
  if (!Array.isArray(job.pendingTrackIds) || !job.pendingTrackIds.length || job.completedAt !== 0 ||
      !Number.isSafeInteger(job.profileRetryAt)) return false;
  const {entries, identityKey} = profileRetryEntries(job, job.pendingTrackIds, now);
  if (job.profileMaintenance?.version === 1 && job.profileMaintenance.identityKey === identityKey &&
      Number.isSafeInteger(job.profileMaintenance.yieldedAt) && job.profileMaintenance.yieldedAt >= 0 &&
      job.profileMaintenance.yieldedAt <= now &&
      job.profileRetryAt === job.profileMaintenance.yieldedAt + PROFILE_RETRY_BASE_MS) return true;
  return job.pendingTrackIds.every(id => entries[id]) &&
    job.profileRetryAt === Math.min(...job.pendingTrackIds.map(id => entries[id].retryAt));
}
