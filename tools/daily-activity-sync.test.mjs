import test from 'node:test';
import assert from 'node:assert/strict';
import {createDailyActivitySync, normalizeDailyActivityProgress, planDailyActivitySync} from './daily-activity-sync.mjs';

const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
const progress = (runs = 3, pbs = 1, extra = {}) => ({
  accountId: 'account', ownerUid: 'owner', activityDay: '2026-11-02', targetTrackId: 'target',
  name: 'Racer', targetRuns: runs, targetPbs: pbs, bestRunTimeMs: 100, bestPbImprovementMs: 10, ...extra
});
const row = (runs = 1, pbs = 1, extra = {}) => ({
  accountId: 'account', ownerUid: 'owner', activityDay: '2026-11-02', lastTrackId: 'target',
  name: 'Racer', dayRuns: runs, dayPbs: pbs, bestRunTimeMs: 100, bestPbImprovementMs: 10,
  currentStreak: 0, bestStreak: 0, completedDay: '', goalCompleted: false, updatedAt: 1, ...extra
});

// Candidate counter contract only; not a substitute for the exact-rules emulator suite.
function assertCounterContract(previous, next) {
  const sameDay = previous?.activityDay === next.activityDay;
  const dr = next.dayRuns - (sameDay ? previous.dayRuns : 0);
  const dp = next.dayPbs - (sameDay ? previous.dayPbs : 0);
  assert.ok(dr >= 1 && dr <= 3);
  assert.ok(dp >= 0 && dp <= dr);
  assert.ok(next.dayPbs <= next.dayRuns && next.dayRuns <= 10000);
  if (previous) {
    assert.ok(next.currentStreak === 1 || next.currentStreak === previous.currentStreak || next.currentStreak === previous.currentStreak + 1);
    assert.ok(next.bestStreak >= previous.bestStreak && next.bestStreak <= previous.bestStreak + 1);
  }
  assert.equal(next.accountId, 'account');
  assert.equal(next.ownerUid, 'owner');
}

function harness(options = {}) {
  let stored = copy(options.stored ?? null), cloud = copy(options.cloud ?? null), clock = 1000000;
  const context = {...progress(), sessionKey: 'session', online: true, visible: true, quotaRetryAt: 0};
  const stats = {transactions: 0, reads: 0, stagedWrites: 0, commits: 0, quotas: 0, saves: 0};
  let saveFails = false, error = null, beforeRead = null, afterRead = null, beforeCommit = null;
  let retries = 0, retryHook = null, entered = 0;
  const dependencies = {
    loadState: () => copy(stored),
    saveState: value => {stats.saves++; if (saveFails) return false; stored = copy(value); return true;},
    getContext: () => copy(context), now: () => clock,
    noteQuota: () => {stats.quotas++; context.quotaRetryAt = Math.max(context.quotaRetryAt, clock + 900000);},
    runTransaction: async (_binding, callback) => {
      stats.transactions++;
      for (let attempt = 0; ; attempt++) {
        let staged = null;
        const outcome = await callback({
          read: async () => {
            entered++;
            if (beforeRead) await beforeRead();
            stats.reads++;
            if (error?.phase === 'read') throw Object.assign(new Error(error.code), {code: error.code});
            const result = copy(cloud);
            if (afterRead) await afterRead();
            return result;
          },
          write: next => {stats.stagedWrites++; staged = copy(next);}
        });
        if (attempt < retries) {if (retryHook) retryHook(attempt); continue;}
        if (beforeCommit) await beforeCommit();
        if (error?.phase === 'commit') throw Object.assign(new Error(error.code), {code: error.code});
        if (staged) {assertCounterContract(cloud, staged); cloud = copy(staged); stats.commits++;}
        return outcome;
      }
    }
  };
  const api = {
    context, stats, dependencies, controller: createDailyActivitySync(dependencies),
    stored: () => copy(stored), cloud: () => copy(cloud), advance: ms => {clock += ms;},
    setCloud: value => {cloud = copy(value);}, setError: value => {error = value;},
    setSaveFails: value => {saveFails = value;},
    setAfterRead: fn => {afterRead = fn;}, setBeforeRead: fn => {beforeRead = fn;},
    setBeforeCommit: fn => {beforeCommit = fn;},
    retry: (count, hook) => {retries = count; retryHook = hook;},
    entered: () => entered,
    restart: () => {api.controller = createDailyActivitySync(dependencies); return api.controller;}
  };
  return api;
}

test('first target PB on run two is one legal two-increment batch', async () => {
  const h = harness(); h.controller.enqueue(progress(1, 0));
  assert.equal((await h.controller.flush()).status, 'idle');
  assert.equal(h.stats.reads, 0);
  h.controller.enqueue(progress(2, 1));
  assert.equal((await h.controller.flush()).status, 'synced');
  assert.equal(h.cloud().dayRuns, 2); assert.equal(h.cloud().dayPbs, 1);
  assert.equal(h.stats.reads, 1); assert.equal(h.stats.commits, 1);
});

test('PB run one plus slower third finish completes through the same enqueue API', async () => {
  const h = harness(); h.controller.enqueue(progress(1, 1)); await h.controller.flush();
  h.controller.enqueue(progress(2, 1));
  h.controller.enqueue(progress(3, 1), {trigger: true});
  await h.controller.flush();
  assert.equal(h.cloud().dayRuns, 3); assert.equal(h.cloud().dayPbs, 1);
  assert.equal(h.cloud().goalCompleted, true); assert.equal(h.cloud().currentStreak, 1);
  assert.equal(h.stats.commits, 2);
});

test('flush is at most three transactions; actual counts beyond nine remain durable', async () => {
  const h = harness(); h.controller.enqueue(progress(14, 6));
  const first = await h.controller.flush();
  assert.equal(first.status, 'pending'); assert.equal(first.transactions, 3);
  assert.equal(h.cloud().dayRuns, 9); assert.equal(h.cloud().dayPbs, 6);
  assert.equal(h.stored().entries[0].progress.targetRuns, 14);
  assert.equal(h.stored().entries[0].acknowledged.dayRuns, 9);
  h.restart(); assert.equal((await h.controller.flush()).status, 'deferred');
  assert.equal(h.stats.reads, 3);
  h.advance(60000); assert.equal((await h.controller.flush()).status, 'synced');
  assert.equal(h.cloud().dayRuns, 14); assert.equal(h.cloud().dayPbs, 6);
  assert.equal(h.stats.reads, 5);
});

test('stale and concurrent snapshots max-coalesce without reducing counters or metadata', async () => {
  const h = harness();
  h.controller.enqueue(progress(5, 3, {bestRunTimeMs: 90, bestPbImprovementMs: 20}));
  h.controller.enqueue(progress(3, 1));
  assert.equal(h.stats.transactions, 0);
  assert.equal(h.stored().entries[0].progress.targetRuns, 5);
  await h.controller.flush();
  assert.equal(h.cloud().dayRuns, 5); assert.equal(h.cloud().dayPbs, 3);
  assert.equal(h.cloud().bestRunTimeMs, 90); assert.equal(h.cloud().bestPbImprovementMs, 20);
});

test('concurrent flush calls share one promise and latest queued progress is used after read', async () => {
  const h = harness(); h.controller.enqueue(progress(2, 1));
  let release; const gate = new Promise(resolve => {release = resolve;});
  h.setBeforeRead(() => gate);
  const a = h.controller.flush(), b = h.controller.flush(); assert.equal(a, b);
  await Promise.resolve();
  h.controller.enqueue(progress(5, 2)); release();
  await a;
  assert.equal(h.cloud().dayRuns, 5); assert.equal(h.cloud().dayPbs, 2);
  assert.equal(h.stats.transactions, 2);
});

test('callback retries recompute from remote authority and never acknowledge discarded attempts', async () => {
  const h = harness(); h.controller.enqueue(progress(6, 3));
  let observedUnacknowledged = false;
  h.retry(1, () => {
    observedUnacknowledged = h.stored().entries[0].acknowledged === null;
    h.setCloud(row(3, 2, {goalCompleted: true, completedDay: '2026-11-02', currentStreak: 1, bestStreak: 1}));
  });
  await h.controller.flush();
  assert.equal(observedUnacknowledged, true);
  assert.equal(h.stats.transactions, 1); assert.equal(h.stats.reads, 2);
  assert.equal(h.stats.commits, 1); assert.equal(h.cloud().dayRuns, 6); assert.equal(h.cloud().dayPbs, 3);
  assert.equal(h.cloud().currentStreak, 1);
});

for (const phase of ['read', 'commit']) test(phase + ' quota failure retains sticky completion and no failed acknowledgement', async () => {
  const h = harness(); h.controller.enqueue(progress(1, 1));
  h.setError({phase, code: 'resource-exhausted'});
  const failed = await h.controller.flush();
  assert.equal(failed.status, 'deferred'); assert.equal(h.stats.quotas, 1);
  assert.equal(h.stored().entries[0].acknowledged, null);
  h.controller.enqueue(progress(3, 1), {trigger: true});
  h.restart(); await h.controller.flush();
  assert.equal(h.stats.transactions, 1);
  assert.equal(h.stored().entries[0].progress.targetRuns, 3);
  h.advance(900000); h.setError(null);
  await h.controller.flush();
  assert.equal(h.cloud().goalCompleted, true); assert.equal(h.cloud().dayRuns, 3);
  assert.equal(h.cloud().dayPbs, 1);
});

test('quota raised after the first commit stops a flush before its second database request', async () => {
  const h = harness(); h.controller.enqueue(progress(9, 2));
  h.setBeforeCommit(() => {h.context.quotaRetryAt = 2000000;});
  const result = await h.controller.flush();
  assert.equal(result.status, 'deferred'); assert.equal(h.stats.transactions, 1);
  assert.equal(h.stored().entries[0].acknowledged.dayRuns, 3);
  assert.equal(h.stored().entries[0].progress.targetRuns, 9);
});

test('quota on transaction two retains transaction one acknowledgement and never starts transaction three', async () => {
  const h = harness(); h.controller.enqueue(progress(9, 2));
  h.setBeforeCommit(() => {h.setError({phase: 'read', code: 'resource-exhausted'});});
  const result = await h.controller.flush();
  assert.equal(result.status, 'deferred'); assert.equal(result.transactions, 2);
  assert.equal(h.stats.reads, 2); assert.equal(h.stats.commits, 1);
  assert.equal(h.stored().entries[0].acknowledged.dayRuns, 3);
  assert.equal(h.stored().entries[0].progress.targetRuns, 9);
});

test('failing shared quota notifier still persists a fifteen-minute local cooldown', async () => {
  const h = harness();
  h.dependencies.noteQuota = () => {throw Error('notifier failed');};
  h.restart(); h.controller.enqueue(progress()); h.setError({phase: 'read', code: 'resource-exhausted'});
  const result = await h.controller.flush();
  assert.equal(result.nextRetryAt, 1900000);
  assert.equal(h.stored().entries[0].acknowledged, null);
  assert.equal((await h.controller.flush()).transactions, 0);
});

test('ordinary failure backoff persists and new progress cannot bypass it', async () => {
  const h = harness(); h.controller.enqueue(progress(3, 1)); h.setError({phase: 'commit', code: 'unavailable'});
  const first = await h.controller.flush();
  assert.equal(first.nextRetryAt, 1300000);
  h.controller.enqueue(progress(4, 2)); h.restart(); await h.controller.flush();
  assert.equal(h.stats.transactions, 1);
  h.advance(300000); const second = await h.controller.flush();
  assert.equal(second.nextRetryAt, 1900000);
  assert.equal(h.stored().entries[0].acknowledged, null);
});

for (const field of ['accountId', 'ownerUid', 'activityDay', 'targetTrackId', 'sessionKey']) {
  test(field + ' changing after transaction read prevents a stale write', async () => {
    const h = harness(); h.controller.enqueue(progress());
    h.setAfterRead(() => {h.context[field] = field === 'activityDay' ? '2026-11-03' : 'changed';});
    assert.equal((await h.controller.flush()).status, 'paused');
    assert.equal(h.stats.stagedWrites, 0); assert.equal(h.stored().entries[0].acknowledged, null);
  });
}

for (const field of ['online', 'visible']) test(field + '=false prevents all transaction requests and resumes once restored', async () => {
  const h = harness(); h.controller.enqueue(progress()); h.context[field] = false;
  assert.equal((await h.controller.flush()).status, 'paused'); assert.equal(h.stats.transactions, 0);
  h.context[field] = true; await h.controller.flush(); assert.equal(h.stats.commits, 1);
});

test('old day and old account pending remain separate; no rebinding or automatic old-day request', async () => {
  const h = harness(); h.controller.enqueue(progress(8, 2));
  h.context.activityDay = '2026-11-03'; h.context.targetTrackId = 'tomorrow';
  assert.equal((await h.controller.flush()).status, 'idle'); assert.equal(h.stats.reads, 0);
  h.controller.enqueue(progress(2, 0, {activityDay: '2026-11-03', targetTrackId: 'tomorrow'}));
  assert.equal(h.stored().entries.length, 2);
  h.context.accountId = 'other'; assert.equal((await h.controller.flush()).status, 'idle');
  assert.equal(h.stored().entries[0].progress.targetRuns, 8);
});

test('successful in-flight commit acknowledges only its original bucket after an account switch', async () => {
  const h = harness(); h.controller.enqueue(progress(2, 1));
  h.setBeforeCommit(() => {h.context.accountId = 'other';});
  await h.controller.flush();
  assert.equal(h.stored().entries[0].acknowledged.accountId, 'account');
  assert.equal(h.stored().entries[0].progress.accountId, 'account');
  assert.equal((await h.controller.flush()).status, 'idle');
});

test('already-complete cloud still accepts further actual counts, without another streak award', async () => {
  const h = harness({cloud: row(3, 1, {completedDay: '2026-11-02', currentStreak: 4, bestStreak: 8, goalCompleted: true})});
  h.controller.enqueue(progress(7, 2)); await h.controller.flush();
  assert.equal(h.cloud().dayRuns, 7); assert.equal(h.cloud().dayPbs, 2);
  assert.equal(h.cloud().currentStreak, 4); assert.equal(h.cloud().bestStreak, 8);
});

test('current-day authoritative read can acknowledge already represented progress without a new write', async () => {
  const h = harness({cloud: row(3, 1, {completedDay: '2026-11-02', currentStreak: 1, bestStreak: 1, goalCompleted: true})});
  h.controller.enqueue(progress()); await h.controller.flush(); await h.controller.flush();
  assert.equal(h.stats.reads, 1); assert.equal(h.stats.commits, 0);
});

for (const [reason, desired, cloud] of [
  ['owner-conflict', progress(), row(1, 1, {ownerUid: 'other'})],
  ['target-conflict', progress(), row(1, 1, {lastTrackId: 'other'})],
  ['newer-cloud-day', progress(), row(1, 1, {activityDay: '2026-11-03'})],
  ['pb-run-deficit', progress(4, 3), row(3, 0)],
  ['metadata-without-run', progress(3, 1), row(3, 1)],
  ['counter-limit', progress(10001, 2), null]
]) test(reason + ' retains pending without fabricated runs or retry loops', async () => {
  const h = harness({cloud}); h.controller.enqueue(desired);
  const first = await h.controller.flush(); assert.equal(first.status, 'blocked'); assert.equal(first.reason, reason);
  await h.controller.flush(); assert.equal(h.stats.transactions, 1); assert.equal(h.stats.commits, 0);
  assert.equal(h.stored().entries[0].progress.targetRuns, desired.targetRuns);
  assert.equal(h.stored().entries[0].acknowledged, null);
});

test('new actual runs can unblock a retained PB deficit, but repeating the old snapshot cannot', async () => {
  const h = harness({cloud: row(3, 0)}); h.controller.enqueue(progress(4, 3));
  assert.equal((await h.controller.flush()).reason, 'pb-run-deficit');
  h.controller.enqueue(progress(4, 3)); await h.controller.flush(); assert.equal(h.stats.reads, 1);
  h.controller.enqueue(progress(6, 3)); await h.controller.flush();
  assert.equal(h.cloud().dayRuns, 6); assert.equal(h.cloud().dayPbs, 3);
  assert.equal(h.stats.reads, 2); assert.equal(h.stored().entries[0].blocked, null);
});

test('actual new runs do not clear owner, target, newer-day or metadata-only conflicts', async () => {
  for (const cloud of [row(1, 1, {ownerUid: 'other'}), row(1, 1, {lastTrackId: 'other'}),
    row(1, 1, {activityDay: '2026-11-03'}), row(3, 1)]) {
    const h = harness({cloud}); h.controller.enqueue(progress());
    const first = await h.controller.flush(); assert.equal(first.status, 'blocked');
    h.controller.enqueue(progress(6, 2));
    assert.equal(h.stats.transactions, 1, 'enqueue must not flush');
    const next = await h.controller.flush();
    assert.equal(next.status, 'blocked'); assert.equal(next.reason, first.reason); assert.equal(h.stats.reads, 1);
  }
});

test('an older cloud day starts a bounded current-day batch with correct consecutive streak', () => {
  const plan = planDailyActivitySync(progress(3, 1), row(5, 2, {activityDay: '2026-11-01',
    completedDay: '2026-11-01', goalCompleted: true, currentStreak: 4, bestStreak: 4}), 1000000);
  assert.equal(plan.row.dayRuns, 3); assert.equal(plan.row.dayPbs, 1);
  assert.equal(plan.row.currentStreak, 5); assert.equal(plan.row.bestStreak, 5);
  assertCounterContract(row(5, 2, {activityDay: '2026-11-01', currentStreak: 4, bestStreak: 4}), plan.row);
});

test('storage failure cannot silently queue new progress or acknowledge a cloud commit', async () => {
  const h = harness(); h.setSaveFails(true);
  assert.throws(() => h.controller.enqueue(progress()), /durably saved/); assert.equal(h.stats.transactions, 0);
  h.setSaveFails(false); h.controller.enqueue(progress());
  h.setBeforeCommit(() => {h.setSaveFails(true);});
  await assert.rejects(h.controller.flush(), /durably saved/);
  assert.equal(h.stats.commits, 1); assert.equal(h.stored().entries[0].acknowledged, null);
  h.setSaveFails(false); h.setBeforeCommit(null); h.restart(); await h.controller.flush();
  assert.equal(h.stats.commits, 1); assert.equal(h.stats.reads, 2);
});

test('malformed stored state fails closed without clearing previous evidence', async () => {
  const h = harness({stored: {version: 2, entries: []}});
  assert.throws(() => h.controller.enqueue(progress()), /storage is invalid/);
  await assert.rejects(h.controller.flush(), /storage is invalid/); assert.equal(h.stats.transactions, 0);
  assert.equal(h.stored().version, 2);
});

test('invalid days, fractional counts and PB counts above actual runs are not normalized by clipping', () => {
  for (const value of [progress(1.5, 1), progress(2, 3), progress(3, 1, {activityDay: '2026-02-30'})]) {
    assert.throws(() => normalizeDailyActivityProgress(value), /Invalid bound target progress/);
  }
});

test('retention removes only acknowledged past-day buckets and refuses to evict unsynced history at capacity', async () => {
  const h = harness(); h.controller.enqueue(progress()); await h.controller.flush();
  h.context.activityDay = '2026-11-03'; h.context.targetTrackId = 'tomorrow';
  h.controller.enqueue(progress(2, 1, {activityDay: '2026-11-03', targetTrackId: 'tomorrow'}));
  assert.equal(h.stored().entries.length, 1);
  assert.equal(h.stored().entries[0].progress.activityDay, '2026-11-03');
  const full = harness();
  for (let i = 0; i < 64; i++) full.controller.enqueue(progress(2, 0, {accountId: 'account-' + i}));
  const before = full.stored();
  assert.throws(() => full.controller.enqueue(progress()), /history is full/);
  assert.deepEqual(full.stored(), before); assert.equal(full.stats.transactions, 0);
});

test('planner transitions satisfy the bounded counter contract across deterministic count combinations', () => {
  for (let runs = 0; runs <= 12; runs++) for (let pbs = 0; pbs <= runs; pbs++) {
    for (let total = Math.max(1, runs); total <= 16; total++) {
      for (let pbTotal = pbs; pbTotal <= total; pbTotal++) {
        const current = runs ? row(runs, pbs) : null;
        const plan = planDailyActivitySync(progress(total, pbTotal), current, 1000000);
        if (plan.status !== 'write') continue;
        assertCounterContract(current, plan.row);
        assert.ok(plan.row.dayRuns <= total);
        assert.ok(plan.row.dayPbs <= pbTotal);
      }
    }
  }
});
