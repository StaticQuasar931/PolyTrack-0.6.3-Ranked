export const DAILY_ACTIVITY_BATCH_SIZE = 3;
export const DAILY_ACTIVITY_FLUSH_LIMIT = 3;
export const DAILY_ACTIVITY_BUCKET_LIMIT = 64;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const clone = value => JSON.parse(JSON.stringify(value));
const fail = (code, message) => Object.assign(new Error(message), {code});
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const validDay = day => typeof day === 'string' && DAY.test(day)
  && Number.isFinite(Date.parse(day + 'T00:00:00Z'))
  && new Date(day + 'T00:00:00Z').toISOString().slice(0, 10) === day;
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;
const minimum = (a, b) => a > 0 && b > 0 ? Math.min(a, b) : Math.max(a, b);
const quotaAt = context => integer(context?.quotaRetryAt, 0, Number.MAX_SAFE_INTEGER) ? context.quotaRetryAt : 0;

export function normalizeDailyActivityProgress(input) {
  if (!input || !text(input.accountId, 128) || !text(input.ownerUid, 128)
    || !validDay(input.activityDay) || !text(input.targetTrackId, 80)
    || !text(input.name, 24) || !integer(input.targetRuns, 1, Number.MAX_SAFE_INTEGER)
    || !integer(input.targetPbs, 0, input.targetRuns)
    || !integer(input.bestRunTimeMs, 1, 36000000)
    || !integer(input.bestPbImprovementMs, 0, 36000000)) {
    throw fail('daily-invalid-progress', 'Invalid bound target progress');
  }
  const {accountId, ownerUid, activityDay, targetTrackId, name, targetRuns, targetPbs,
    bestRunTimeMs, bestPbImprovementMs} = input;
  return {accountId, ownerUid, activityDay, targetTrackId, name, targetRuns, targetPbs,
    bestRunTimeMs, bestPbImprovementMs};
}

function key(progress) {
  return JSON.stringify([progress.accountId, progress.ownerUid, progress.activityDay, progress.targetTrackId]);
}

function mergeProgress(previous, next) {
  if (!previous) return next;
  if (key(previous) !== key(next)) throw fail('daily-binding-changed', 'Cannot merge different daily bindings');
  return {...next, targetRuns: Math.max(previous.targetRuns, next.targetRuns),
    targetPbs: Math.max(previous.targetPbs, next.targetPbs),
    bestRunTimeMs: minimum(previous.bestRunTimeMs, next.bestRunTimeMs),
    bestPbImprovementMs: Math.max(previous.bestPbImprovementMs, next.bestPbImprovementMs)};
}

function represented(progress, row) {
  return row && row.activityDay === progress.activityDay && row.lastTrackId === progress.targetTrackId
    && row.accountId === progress.accountId && row.ownerUid === progress.ownerUid
    && row.dayRuns >= progress.targetRuns && row.dayPbs >= progress.targetPbs
    && row.bestRunTimeMs > 0 && row.bestRunTimeMs <= progress.bestRunTimeMs
    && row.bestPbImprovementMs >= progress.bestPbImprovementMs
    && (!(progress.targetRuns >= 3 && progress.targetPbs >= 1)
      || (row.goalCompleted === true && row.completedDay === progress.activityDay));
}

// Cumulative maxima, not an additive or exactly-once multi-device event ledger.
export function planDailyActivitySync(input, current, now) {
  const progress = normalizeDailyActivityProgress(input);
  if (!integer(now, 0, Number.MAX_SAFE_INTEGER)) throw fail('daily-invalid-clock', 'Invalid clock');
  const blocked = reason => ({status: 'blocked', reason});
  if (progress.targetRuns > 10000 || progress.targetPbs > 10000) return blocked('counter-limit');
  if (current) {
    if (current.accountId !== progress.accountId || current.ownerUid !== progress.ownerUid) return blocked('owner-conflict');
    if (!validDay(current.activityDay) || !integer(current.dayRuns, 1, 10000)
      || !integer(current.dayPbs, 0, current.dayRuns)
      || !integer(current.currentStreak, 0, 10000)
      || !integer(current.bestStreak, current.currentStreak, 10000)
      || !(current.completedDay === '' || validDay(current.completedDay))
      || !integer(current.bestRunTimeMs, 1, 36000000)
      || !integer(current.bestPbImprovementMs, 0, 36000000)
      || typeof current.goalCompleted !== 'boolean') return blocked('invalid-cloud-progress');
    if (current.activityDay > progress.activityDay || current.completedDay > progress.activityDay) return blocked('newer-cloud-day');
    if (current.activityDay === progress.activityDay && current.lastTrackId !== progress.targetTrackId) return blocked('target-conflict');
  }
  const sameDay = current?.activityDay === progress.activityDay;
  const runs = sameDay ? current.dayRuns : 0;
  const pbs = sameDay ? current.dayPbs : 0;
  const missingRuns = Math.max(0, progress.targetRuns - runs);
  const missingPbs = Math.max(0, progress.targetPbs - pbs);
  if (missingPbs > missingRuns) return blocked('pb-run-deficit');
  if (!missingRuns) return represented(progress, current)
    ? {status: 'acknowledged', row: clone(current)} : blocked('metadata-without-run');
  const increment = Math.min(DAILY_ACTIVITY_BATCH_SIZE, missingRuns);
  const dayRuns = runs + increment, dayPbs = pbs + Math.min(increment, missingPbs);
  const alreadyComplete = current?.completedDay === progress.activityDay;
  const goalCompleted = alreadyComplete || (dayRuns >= 3 && dayPbs >= 1);
  let currentStreak = current?.currentStreak || 0;
  let completedDay = current?.completedDay || '';
  if (goalCompleted && !alreadyComplete) {
    const previousDay = new Date(Date.parse(progress.activityDay + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
    currentStreak = completedDay === previousDay ? Math.min(10000, currentStreak + 1) : 1;
    completedDay = progress.activityDay;
  }
  const row = {
    accountId: progress.accountId, ownerUid: progress.ownerUid, name: progress.name,
    currentStreak, bestStreak: Math.max(currentStreak, current?.bestStreak || 0),
    activityDay: progress.activityDay, completedDay, lastTrackId: progress.targetTrackId,
    dayRuns, dayPbs,
    bestPbImprovementMs: Math.max(sameDay ? current.bestPbImprovementMs : 0, progress.bestPbImprovementMs),
    bestRunTimeMs: minimum(sameDay ? current.bestRunTimeMs : 0, progress.bestRunTimeMs),
    goalCompleted, updatedAt: now
  };
  return {status: 'write', row};
}

// Storage adapters are synchronous and durable; transaction resolves only after commit.
// The transaction adapter supplies {read, write} and may re-execute the callback.
export function createDailyActivitySync({loadState, saveState, getContext, runTransaction,
  now = Date.now, noteQuota = () => {}, withLock = work => work()}) {
  for (const dependency of [loadState, saveState, getContext, runTransaction, now, noteQuota, withLock]) {
    if (typeof dependency !== 'function') throw new TypeError('Daily activity dependencies must be functions');
  }
  let pending = null;
  function state() {
    const stored = loadState();
    if (stored == null) return {version: 1, entries: []};
    if (stored.version !== 1 || !Array.isArray(stored.entries)) throw fail('daily-invalid-storage', 'Daily activity storage is invalid');
    const copy = clone(stored);
    const keys = new Set();
    for (const entry of copy.entries) {
      normalizeDailyActivityProgress(entry.progress);
      const id = key(entry.progress);
      if (keys.has(id) || typeof entry.eligible !== 'boolean'
        || !integer(entry.retryAt, 0, Number.MAX_SAFE_INTEGER)
        || !integer(entry.failures, 0, Number.MAX_SAFE_INTEGER)) throw fail('daily-invalid-storage', 'Daily activity entry is invalid');
      keys.add(id);
    }
    return copy;
  }
  function persist(value) {
    if (saveState(clone(value)) !== true) throw fail('daily-storage-failed', 'Daily progress was not durably saved');
  }
  function mutate(id, change) {
    const value = state(), entry = value.entries.find(item => key(item.progress) === id);
    if (!entry) throw fail('daily-missing-pending', 'Pending daily progress disappeared');
    change(entry);
    persist(value);
    return entry;
  }
  function enqueue(input, {trigger = false} = {}) {
    const progress = normalizeDailyActivityProgress(input), id = key(progress), value = state();
    value.entries = value.entries.filter(item => item.progress.activityDay >= progress.activityDay
      || !represented(item.progress, item.acknowledged));
    let entry = value.entries.find(item => key(item.progress) === id);
    if (!entry) {
      if (value.entries.length >= DAILY_ACTIVITY_BUCKET_LIMIT) {
        throw fail('daily-storage-full', 'Daily history is full of retained pending buckets; export or resolve it before adding another');
      }
      entry = {progress, eligible: false, retryAt: 0, failures: 0, acknowledged: null, blocked: null};
      value.entries.push(entry);
    } else {
      const priorRuns = entry.progress.targetRuns;
      entry.progress = mergeProgress(entry.progress, progress);
      if (entry.progress.targetRuns > priorRuns && entry.blocked === 'pb-run-deficit') {
        entry.blocked = null;
      }
    }
    entry.eligible ||= trigger === true || entry.progress.targetPbs > 0;
    persist(value);
    return {pending: !represented(entry.progress, entry.acknowledged), eligible: entry.eligible};
  }
  function guard(binding, sessionKey) {
    const context = getContext();
    if (!context || key(context) !== key(binding) || context.sessionKey !== sessionKey) {
      throw fail('daily-binding-changed', 'Active account, day, target or session changed');
    }
    if (context.visible !== true || context.online !== true) throw fail('daily-paused', 'Daily activity paused while hidden or offline');
    if (quotaAt(context) > now()) throw fail('local-quota-cooldown', 'Daily activity quota cooldown');
    return context;
  }
  async function drain() {
    const context = getContext();
    if (!context) return {status: 'idle', transactions: 0};
    const id = key(context), initial = state().entries.find(item => key(item.progress) === id);
    if (!initial || !initial.eligible || represented(initial.progress, initial.acknowledged)) return {status: 'idle', transactions: 0};
    if (initial.blocked) return {status: 'blocked', reason: initial.blocked, transactions: 0};
    if (initial.retryAt > now()) return {status: 'deferred', nextRetryAt: initial.retryAt, transactions: 0};
    let transactions = 0;
    try {
      for (; transactions < DAILY_ACTIVITY_FLUSH_LIMIT;) {
        guard(initial.progress, context.sessionKey);
        const entry = state().entries.find(item => key(item.progress) === id);
        if (represented(entry.progress, entry.acknowledged)) return {status: 'synced', transactions};
        transactions++;
        const outcome = await runTransaction(clone(initial.progress), async tx => {
          guard(initial.progress, context.sessionKey);
          const current = await tx.read();
          guard(initial.progress, context.sessionKey);
          const latest = state().entries.find(item => key(item.progress) === id);
          const plan = planDailyActivitySync(latest.progress, current, now());
          if (plan.status === 'write') {
            guard(initial.progress, context.sessionKey);
            tx.write(clone(plan.row));
          }
          return plan;
        });
        if (!outcome || !['write', 'acknowledged', 'blocked'].includes(outcome.status)) {
          throw fail('daily-invalid-transaction', 'Transaction adapter lost its callback result');
        }
        if (outcome.status === 'blocked') {
          mutate(id, item => {item.blocked = outcome.reason;});
          return {status: 'blocked', reason: outcome.reason, transactions};
        }
        // Never acknowledge inside a callback: it can run again or fail at commit.
        const updated = mutate(id, item => {
          item.acknowledged = clone(outcome.row); item.failures = 0; item.retryAt = 0;
        });
        if (represented(updated.progress, updated.acknowledged)) return {status: 'synced', transactions};
      }
      const updated = mutate(id, item => {item.retryAt = now() + 60000;});
      return {status: 'pending', nextRetryAt: updated.retryAt, transactions};
    } catch (error) {
      if (['daily-binding-changed', 'daily-paused'].includes(error?.code)) return {status: 'paused', transactions};
      const quota = /resource-exhausted|quota|429/i.test(String(error?.code || '') + ' ' + String(error?.message || ''));
      if (quota) {
        try { noteQuota(error); } catch { /* Retain a local cooldown even if the shared notifier fails. */ }
      }
      const updated = mutate(id, item => {
        item.failures = Math.min(32, item.failures + 1);
        const backoff = Math.min(3600000, 300000 * 2 ** Math.min(4, item.failures - 1));
        item.retryAt = Math.max(now() + backoff, quota ? Math.max(now() + 900000, quotaAt(getContext())) : 0);
        item.lastError = quota ? 'quota' : String(error?.code || 'daily-sync-failed');
      });
      return {status: 'deferred', reason: updated.lastError, nextRetryAt: updated.retryAt, transactions};
    }
  }
  function flush() {
    if (pending) return pending;
    pending = Promise.resolve().then(() => withLock(drain)).finally(() => {pending = null;});
    return pending;
  }
  return {enqueue, flush, inspect: () => state()};
}
