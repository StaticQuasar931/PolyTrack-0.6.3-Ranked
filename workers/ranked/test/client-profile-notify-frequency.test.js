import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

// Reuse the parent-owned offline client/Worker fixture without registering its
// separate journey tests or changing its source. Relative resources stay bound
// to the original file, not the generated data module.
const fixtureUrl = new URL('../../../tools/new-account-five-track-cost.test.mjs', import.meta.url);
const source = readFileSync(fixtureUrl, 'utf8');
const end = source.indexOf("\ntest('");
assert.ok(end > source.indexOf('function fixture('));
const fixtureModule = source.slice(0, end)
  .replace(/from (['"])(\.\.?\/[^'"]+)\1/g, (_, quote, relative) =>
    'from ' + JSON.stringify(new URL(relative, fixtureUrl).href))
  .replaceAll('import.meta.url', JSON.stringify(fixtureUrl.href));
const {fixture, account, E, rawPatch} = await import('data:text/javascript,' +
  encodeURIComponent(fixtureModule + '\nexport {fixture, account, E, rawPatch};'));
const clientSha256 = createHash('sha256').update(rawPatch).digest('hex');
const profileRoute = '/v1/profile/notify', pbRoute = '/v1/pb/notify';
const profileJob = '0.6.2_s1_worker_jobs/profile_' + account;
const countRoute = (calls, route) => calls.filter(call => call.route === route).length;

test('current client: 15 saved PBs and five slower runs send zero stats-only profile notifications', async t => {
  const f = fixture(t), runs = [];
  await f.phase('account-create', f.profilePost);
  const startupNotifications = countRoute(f.http, profileRoute);
  assert.equal(startupNotifications, 1, 'account identity initialization is separate from run costs');
  const startCalls = f.http.length;
  let pbCount = 0;
  for (const trackId of f.selected) {
    for (const timeMs of [30000, 29000, 28000]) {
      pbCount++;
      f.c.currentPlaytimeMs = () => pbCount * 60000;
      const first = f.http.length, before = f.totals(), runEvents = f.events.length;
      const result = await f.phase('saved-PB-' + pbCount, () => f.finish(trackId, timeMs));
      assert.equal(result.saved, true);
      const profile = f.data.get(E.profiles + '/' + account);
      assert.equal(profile.pbCount, pbCount);
      assert.equal(profile.totalPlaytimeMs, pbCount * 60000);
      const after = f.totals(), postStart = f.http.length, postEvents = f.events.length;
      const sdk = f.events.slice(runEvents).filter(event => event.lane === 'sdk');
      const sdkReads = sdk.filter(event => event.op === 'read').reduce((sum, event) => sum + event.count, 0);
      const sdkWrites = sdk.filter(event => event.op === 'write').reduce((sum, event) => sum + event.count, 0);
      await f.phase('unchanged-user-POST-' + pbCount, f.profilePost);
      const postCost = f.totals();
      assert.equal(postCost.writes, after.writes, 'unchanged identity is not rewritten');
      assert.equal(postCost.deletes, after.deletes); assert.equal(postCost.failedAttempts, after.failedAttempts);
      assert.ok(postCost.reads-after.reads <= 1, 'at most one fresh SDK ownership/profile recheck after intervening PB work');
      assert.ok(f.events.slice(postEvents).every(event => event.lane === 'sdk' && event.op === 'read' &&
        event.key === E.profiles + '/' + account), 'any residual read is SDK profile validation, not Worker projection');
      assert.equal(f.http.length, postStart);
      const calls = f.http.slice(first);
      assert.equal(countRoute(calls, profileRoute), 0);
      assert.equal(countRoute(calls, pbRoute), 1);
      runs.push({pb:pbCount, reads:after.reads-before.reads, writes:after.writes-before.writes,
        sdkReads, sdkWrites, profileNotifications:0, pbNotifications:1,
        routes:calls.map(call=>call.route).filter(route => route.startsWith('/v1/')),
        unchangedUserPostReads:postCost.reads-after.reads, unchangedUserPostWrites:0});
    }
    const first = f.http.length;
    assert.equal((await f.phase('slower-local-run', () => f.finish(trackId, 31000))).saved, false);
    assert.equal(countRoute(f.http.slice(first), profileRoute), 0);
    assert.equal(countRoute(f.http.slice(first), pbRoute), 0);
  }
  assert.equal(countRoute(f.http.slice(startCalls), profileRoute), 0);
  assert.equal(countRoute(f.http.slice(startCalls), pbRoute), 15);
  process.stdout.write('CLIENT_PROFILE_NOTIFY_FREQUENCY ' + JSON.stringify({clientSha256,
    startupNotifications, savedPBs:15, slowerRuns:5, unchangedUserPosts:15,
    runProfileNotifications:0, runPbNotifications:15, runs,
    excludes:'actual browser gameplay, auth/network, SDK retries, rules/index reads, native verification and scheduled publication'}) + '\n');
});

test('current client still notifies genuine identity changes after stats-only PB updates', async t => {
  const f = fixture(t);
  await f.phase('account-create', f.profilePost);
  await f.phase('saved-PB', () => f.finish(f.selected[0], 30000, {capture:false}));
  const first = f.http.length, events = f.events.length;
  await f.phase('genuine-rename', f.rename);
  assert.equal(countRoute(f.http.slice(first), profileRoute), 1);
  assert.equal(f.data.get(E.profiles + '/' + account).nickname, 'Renamed Journey');
  assert.equal(f.data.get(profileJob).identity.name, 'Renamed Journey');
  assert.ok(f.events.slice(events).some(event => event.lane === 'worker' && event.op === 'read' &&
    event.key === '0.6.2_s1_cosmetic_entitlements/' + account), 'rename retains current entitlement authority');
});

test('explicit legacy stats notifications still pay four keyed checks each, not four inferred reads per current-client PB', async t => {
  const f = fixture(t);
  await f.phase('account-create', f.profilePost);
  const before = f.totals(), first = f.http.length;
  for (let i = 1; i <= 10; i++) {
    f.advance(1000);
    f.put(E.profiles + '/' + account, {...f.data.get(E.profiles + '/' + account),
      pbCount:i, totalPlaytimeMs:i*60000, updatedAt:Date.now()});
    const start = f.totals();
    const result = await f.c.sendRankedProfileNotification(account);
    await f.settle();
    assert.equal(result.accepted, true); assert.equal(result.unchanged, true);
    assert.equal(f.totals().reads-start.reads, 4);
    assert.equal(f.totals().writes-start.writes, 0);
  }
  assert.equal(countRoute(f.http.slice(first), profileRoute), 10);
  assert.equal(f.totals().reads-before.reads, 40);
  process.stdout.write('LEGACY_EXPLICIT_PROFILE_NOTIFY_COST ' + JSON.stringify({requests:10, reads:40, writes:0,
    excludes:'SDK writes used to prepare legacy stats, security-rule reads, transaction retries and production frequency'}) + '\n');
});

test('unchanged profile fields cannot conceal entitlement revocation or independent group-tag changes', async t => {
  const f = fixture(t);
  await f.phase('account-create', f.profilePost);
  const entitlementKey = '0.6.2_s1_cosmetic_entitlements/' + account;
  const beta = {id:'beta-tester', source:'release-migration', sourceRevision:4,
    issuedAt:Date.UTC(2026, 9, 1), cutoffAt:0};
  f.put(entitlementKey, {serverIssued:{beta}});
  assert.equal((await f.c.sendRankedProfileNotification(account)).betaEntitlement.id, 'beta-tester');
  f.put(entitlementKey, {serverIssued:{}});
  const before = f.totals();
  assert.equal((await f.c.sendRankedProfileNotification(account)).betaEntitlement, null);
  assert.equal(f.totals().reads-before.reads, 4, 'revocation is observed without a profile update');
  f.put('0.6.2_s1_group_tags/account_' + account, {accountId:account, groupCode:'123456', updatedAt:Date.now()});
  const result = await f.c.sendRankedProfileNotification(account);
  await f.settle();
  assert.equal(result.accepted, true); assert.notEqual(result.unchanged, true);
  assert.equal(f.data.get(profileJob).identity.groupCode, '123456');
});
