import test, {beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {rebuildOverall} from '../src/index.js';
import {purchasedProfileCosmeticsUnlocked} from '../src/purchased-cosmetic-entitlements.js';
import {ENTITLEMENT_CACHE_COLLECTION as CACHE, invalidateEntitlements} from '../src/overall-entitlement-cache.js';
import {createCommunityBadgeService, readCommunityClaim, COMMUNITY_CAMPAIGN, LEGACY_COMMUNITY_CAMPAIGN} from '../src/community-badge.js';
import {addCommunityBadge, addPurchase, mergeEarnedAndPurchasedEntitlements} from '../src/purchased-cosmetic-entitlements.js';
import {createEventFirestoreStore, eventEncode, eventDecode} from '../src/events-store.js';
import worker, {handleRequest, sanitizeProfileCosmetics} from '../src/index.js';
import {preparePublicationPages, PUBLIC_PAGE_COLLECTION} from '../src/paged-publication.js';
const A = 'a'.repeat(64), B = 'b'.repeat(64), UID = 'owner', AT = 1792000000000;
const ENT = '0.6.2_s1_cosmetic_entitlements/', META = '0.6.2_s1_release_meta/current';
const BASE = 'projects/polytrack-052/databases/(default)/documents/';
// Synthetic fixtures only; never use the configured relay code or digest.
const FAKE_CODE = 'ABCDEFGHIJKLMNOP';
const fakeHash = code => createHash('sha256').update(code).digest('hex');
const body = {accountId: A, communityCode: FAKE_CODE};
beforeEach(t => {t.mock.method(Date, 'now', () => AT);t.mock.method(globalThis, 'fetch', () => assert.fail('No external requests'));t.mock.method(console, 'log', () => {});});
function fixture(secret = fakeHash(FAKE_CODE)) {
  const docs = new Map(), snapshots = new Map(), calls = [], commits = []; let version = 0, fail = false, lose = false, hook, barrier;
  const put = (key, value) => docs.set(key, {data: structuredClone(value), version: ++version});
  put('0.6.2_profiles_public/' + A, {accountId: A, ownerUid: UID});
  const request = async (route, init = {}) => {
    calls.push(route); const data = init.body ? JSON.parse(init.body) : null;
    if (route === ':beginTransaction') {
      const id = 'tx-' + ++version; snapshots.set(id, {docs: structuredClone(docs), reads: new Set()});
      if (barrier) {const current = barrier; if (++current.arrivals === 2) {barrier = null; current.release();} await current.ready;}
      return {transaction: id};
    }
    if (route === ':rollback') {snapshots.delete(data.transaction); return {};}
    if (route === ':commit') {
      if (hook) {const callback = hook; hook = null; await callback();}
      const snapshot = snapshots.get(data.transaction);
      if (fail) {fail = false; throw Error('FIRESTORE_503');}
      for (const key of snapshot.reads) if (snapshot.docs.get(key)?.version !== docs.get(key)?.version) throw Error('FIRESTORE_409');
      for (const write of data.writes) {const key = write.update.name.slice(BASE.length), current = docs.get(key);
        if (write.currentDocument.exists === false && current || write.currentDocument.updateTime && write.currentDocument.updateTime !== String(current?.version)) throw Error('FIRESTORE_409');}
      for (const write of data.writes) put(write.update.name.slice(BASE.length), eventDecode({mapValue: {fields: write.update.fields}}));
      commits.push(data); snapshots.delete(data.transaction);
      if (lose) {lose = false; throw Error('FIRESTORE_503');}
      return {writeResults: data.writes.map(() => ({updateTime: String(version)}))};
    }
    const [pathname, query] = route.split('?'), snapshot = snapshots.get(new URLSearchParams(query).get('transaction'));
    assert.ok(snapshot, 'All Community reads are transactional');
    const key = decodeURIComponent(pathname.slice(1)); snapshot.reads.add(key); const value = snapshot.docs.get(key);
    return value ? {fields: eventEncode(value.data).mapValue.fields, updateTime: String(value.version)} : null;
  };
  const store = createEventFirestoreStore({request, projectId: 'polytrack-052', retries: 2, pause: async () => {}});
  const service = createCommunityBadgeService({store, grantEntitlement: addCommunityBadge, relayCodeSha256: secret, now: () => AT});
  const allow = {limit: async () => ({success: true})};
  const env = {COMMUNITY_RELAY_CODE_SHA256: secret, ALLOWED_ORIGINS: 'https://test.invalid', __TEST_UID: UID, WRITE_IP_RATE_LIMITER: allow,
    PB_NOTIFY_RATE_LIMITER: allow, __TEST_FIRESTORE: request};
  const post = (payload = body, extra = {}, headers = {}) => handleRequest(new Request('https://worker.invalid/v1/profile/community-badge',
    {method: 'POST', headers: {Origin: 'https://test.invalid', 'CF-Connecting-IP': '192.0.2.1', ...headers}, body: JSON.stringify(payload)}), {...env, ...extra});
  return {docs, calls, commits, service, put, post, fail: () => {fail = true;}, lose: () => {lose = true;}, hook: fn => {hook = fn;},
    synchronize: () => {let release; const ready = new Promise(resolve => {release = resolve;}); barrier = {ready, release, arrivals: 0};},
    reads: () => calls.filter(route => route.includes('?transaction=')).length};
}
const expected = alreadyClaimed => ({version: 1, accepted: true, accountId: A, badgeId: 'community',
  source: 'relay-code', membershipVerified: false, alreadyClaimed});
test('first actual Worker claim is three reads two atomic writes; repeat is two reads zero writes', async () => {
  const f = fixture(); f.put(META, {entitlementEpoch: 4, unrelated: true});
  const before = structuredClone(f.docs.get('0.6.2_profiles_public/' + A));
  let response = await f.post(); assert.equal(response.status, 200); assert.deepEqual(await response.json(), expected(false));
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(f.reads(), 3); assert.equal(f.calls.length, 5); assert.equal(f.commits.length, 1);
  assert.deepEqual(f.commits[0].writes.map(write => write.update.name.slice(BASE.length)), [ENT + A, META]);
  assert.equal(f.docs.get(META).data.entitlementEpoch, 5); assert.equal(f.docs.get(META).data.dirty, true);
  assert.deepEqual(f.docs.get('0.6.2_profiles_public/' + A), before);
  assert.deepEqual(f.docs.get(ENT + A).data.community, {version: 1, accountId: A, ownerUid: UID,
    campaign: COMMUNITY_CAMPAIGN, badgeId: 'community', source: 'relay-code', membershipVerified: false, claimedAt: AT});
  const docs = structuredClone(f.docs); response = await f.post({accountId: A, inviteCode: FAKE_CODE});
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), expected(true));
  assert.equal(f.reads(), 5); assert.equal(f.calls.length, 9); assert.equal(f.commits.length, 1); assert.deepEqual(f.docs, docs);
  assert.ok([...f.docs.keys()].every(key => !key.includes('currency') && !key.includes('badges/')));
});
test('invalid public codes, URLs and strict body shapes cause zero DB or URL requests', async () => {
  const f = fixture();
  for (const inviteCode of ['', 'other', 'https://evil.invalid/jW2az4AQUH', 'http://discord.gg/jW2az4AQUH',
    'https://discord.gg/jW2az4AQUH?x=1', 'https://discord.gg/jW2az4AQUH/', 'https://discord.gg@evil.invalid/jW2az4AQUH', ' jW2az4AQUH', null, 7]) {
    const response = await f.post({...body, communityCode: inviteCode}); assert.equal(response.status, 400);
  }
  for (const payload of [{...body, badgeId: 'betaTester'}, {...body, accountId: '../x'}, {accountId: A}, [], {...body, membershipVerified: true}])
    assert.equal((await f.post(payload)).status, 400);
  assert.equal((await f.post({...body, communityCode: 'x'.repeat(3000)})).status, 400);
  assert.equal(f.calls.length, 0);
});
test('origin revision freeze IP and UID gates remain before all Community database work', async () => {
  const f = fixture();
  for (const [extra, headers, status] of [
    [{}, {Origin: 'https://foreign.invalid'}, 403],
    [{MIN_CLIENT_REVISION: '381', MISSING_CLIENT_REVISION_POLICY: 'reject'}, {}, 426],
    [{RANKED_WRITES_ENABLED: 'false'}, {}, 503],
    [{WRITE_IP_RATE_LIMITER: {limit: async () => ({success: false})}}, {}, 429],
    [{PB_NOTIFY_RATE_LIMITER: {limit: async () => ({success: false})}}, {}, 429],
    [{PB_NOTIFY_RATE_LIMITER: undefined}, {}, 503]
  ]) assert.equal((await f.post(body, extra, headers)).status, status);
  await assert.rejects(f.service.claim('', body), error => error.httpStatus === 401);
  assert.equal(f.calls.length, 0);
});
test('current profile ownership is mandatory on first claim and repeats', async () => {
  const f = fixture(); await f.service.claim(UID, body);
  f.put('0.6.2_profiles_public/' + A, {accountId: A, ownerUid: 'other'});
  const before = structuredClone(f.docs), calls = f.calls.length;
  await assert.rejects(f.service.claim(UID, body), error => error.httpStatus === 403);
  assert.deepEqual(f.docs, before); assert.equal(f.calls.length - calls, 3);
  await assert.rejects(f.service.claim('other', body), /COMMUNITY_ENTITLEMENT_INVALID/);
});
test('canonical claim without matching allowance fails closed at two reads with no writes', async () => {
  const f = fixture(); const prior = addCommunityBadge(null, AT, {accountId: A, ownerUid: UID}); delete prior.badge;
  f.put(ENT + A, prior); const before = structuredClone(f.docs), response = await f.post();
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), {error: 'community_entitlement_inconsistent'});
  assert.equal(f.reads(), 2); assert.equal(f.commits.length, 0); assert.deepEqual(f.docs, before);
});
test('failed commit rolls back and lost commit reply safely recovers via canonical claim', async () => {
  for (const lost of [false, true]) {
    const f = fixture(), before = structuredClone(f.docs); if (lost) f.lose(); else f.fail();
    assert.equal((await f.post()).status, 503); assert.equal(f.commits.length, lost ? 1 : 0);
    if (!lost) assert.deepEqual(f.docs, before);
    const response = await f.post(); assert.equal(response.status, 200); assert.deepEqual(await response.json(), expected(lost));
    assert.equal(f.commits.length, 1);
  }
});
test('concurrent claims commit exactly once with existing serializable CAS retry', async () => {
  const f = fixture(); const results = await Promise.all([f.service.claim(UID, body), f.service.claim(UID, body)]);
  assert.deepEqual(results.map(result => result.alreadyClaimed).sort(), [false, true]);
  assert.equal(f.commits.length, 1); assert.equal(f.commits[0].writes.length, 2);
});
test('ownership switch before commit cannot commit Community grant', async () => {
  const f = fixture(); f.hook(() => f.put('0.6.2_profiles_public/' + A, {accountId: A, ownerUid: 'other'}));
  await assert.rejects(f.service.claim(UID, body), error => error.httpStatus === 403);
  assert.equal(f.docs.has(ENT + A), false); assert.equal(f.commits.length, 0);
});
test('Community does not authorize beta, rewards, arbitrary grants or stale root arrays', () => {
  const binding = {accountId: A, ownerUid: UID}, granted = addCommunityBadge(null, AT, binding);
  assert.equal(granted.badge.includes('betaTester'), false); assert.equal('serverIssued' in granted, false);
  assert.equal(sanitizeProfileCosmetics({version: 7, badge: 'community'}).badge, 'community');
  const fresh = {badge: ['auto', 'none'], serverIssued: {achievements: {version: 1}}};
  const forged = {...fresh, badge: ['betaTester', 'community']};
  assert.deepEqual(mergeEarnedAndPurchasedEntitlements(fresh, forged, binding), fresh);
  const merged = mergeEarnedAndPurchasedEntitlements(fresh, {...granted, badge: ['betaTester']}, binding);
  assert.deepEqual(merged.badge, ['auto', 'none', 'community']); assert.deepEqual(merged.serverIssued, fresh.serverIssued);
  const purchased = addPurchase(granted, 'profile-pitlane-ticket', AT + 1, binding);
  assert.deepEqual(purchased.community, granted.community); assert.ok(purchased.plate.includes('pitlane-ticket'));
  const both = addCommunityBadge(purchased, AT + 10, binding);
  assert.deepEqual(both.purchased, purchased.purchased); assert.deepEqual(both.community, granted.community);
});
for (const field of ['version', 'accountId', 'ownerUid', 'campaign', 'badgeId', 'source', 'membershipVerified', 'claimedAt', 'extra'])
  test('malformed Community provenance cannot survive rebuild or authorize claim: ' + field, async () => {
    const f = fixture(), prior = addCommunityBadge(null, AT, {accountId: A, ownerUid: UID});
    prior.community[field] = field === 'claimedAt' ? -1 : field === 'membershipVerified' ? true : 'forged';
    assert.throws(() => readCommunityClaim(prior, {accountId: A, ownerUid: UID}), /COMMUNITY_ENTITLEMENT_INVALID/);
    f.put(ENT + A, prior); assert.equal((await f.post()).status, 503); assert.equal(f.commits.length, 0);
  });
test('saved actual rules dynamically allow Community only through private allowance', () => {
  const rules = fs.readFileSync(new URL('../../../../../2026-11-13/late-update/live-firestore.rules', import.meta.url), 'utf8');
  assert.equal(createHash('sha256').update(rules).digest('hex'), 'd335b44eaff7406cb4972738527ce8519f76cd35f1b4815a396cbf88dce23f7d');
  assert.match(rules, /text\(cosmetics.badge, 1, 32\)/);
  assert.match(rules, /c.badge in allowed.badge/);
  assert.match(rules, /match \/0.6.2_s1_cosmetic_entitlements\/\{accountId\}\s*\{\s*allow read, write: if false;/);
});

const rebuildSource = fs.readFileSync(new URL('./overall-entitlement-cache.test.js', import.meta.url), 'utf8');
const fixtureStart = rebuildSource.indexOf('function fixture(count = 2)');
const fixtureBody = rebuildSource.slice(fixtureStart, rebuildSource.indexOf('\nfunction reads(', fixtureStart));
const TRACKS = '0.6.2_s1_leaderboards_track', OVERALL = '0.6.2_s1_leaderboards_overall/main';
const TRACK = '5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038';
const clone = value => structuredClone(value);
const isRefinement = writes => writes.some(write => write.update.name.includes('/' + CACHE + '/')) && !writes.some(write => write.update.name.endsWith(OVERALL));
assert.ok(fixtureBody.startsWith('function fixture('));
const rebuildFixture = Function('assert','BASE','META','TRACKS','TRACK','AT','ENT','CACHE','OVERALL','eventEncode','eventDecode','clone','isRefinement', fixtureBody + ';return fixture;')
  (assert, BASE, META, TRACKS, TRACK, AT, ENT.slice(0, -1), CACHE, OVERALL, eventEncode, eventDecode, clone, isRefinement);
for (const legacy of [false, true]) test('actual rebuild preserves typed Community plus purchases, legacy=' + legacy, async () => {
  const f = rebuildFixture(2), board = f.data.get(TRACKS + '/' + TRACK);
  board.entries[0].accountId = A; f.mutate(TRACKS + '/' + TRACK, board); await rebuildOverall(f.env, true);
  let entitlement = addPurchase(f.data.get(ENT + A), 'profile-pitlane-ticket', AT, {accountId: A, ownerUid: UID});
  entitlement = addCommunityBadge(entitlement, AT, {accountId: A, ownerUid: UID});
  if (legacy) {entitlement.community.campaign = LEGACY_COMMUNITY_CAMPAIGN; entitlement.community.source = 'invite-code';}
  const proof = clone(entitlement.community), purchase = clone(entitlement.purchased);
  f.mutate(ENT + A, entitlement); f.mutate(META, invalidateEntitlements(f.data.get(META), [A])); f.dirty();
  assert.equal((await rebuildOverall(f.env, true)).rebuilt, true);
  f.dirty(); assert.equal((await rebuildOverall(f.env)).rebuilt, true);
  const rebuilt = f.data.get(ENT + A);
  assert.deepEqual(rebuilt.community, proof); assert.deepEqual(rebuilt.purchased, purchase); assert.ok(rebuilt.badge.includes('community'));
  const design = {...sanitizeProfileCosmetics({version: 7}), badge: 'community', plate: 'pitlane-ticket'};
  assert.equal(purchasedProfileCosmeticsUnlocked(design, sanitizeAllowance(), rebuilt, {accountId: A, ownerUid: UID}), true);
  assert.throws(() => purchasedProfileCosmeticsUnlocked(design, sanitizeAllowance(), rebuilt, {accountId: A, ownerUid: 'foreign'}));
});
function sanitizeAllowance() {
  const defaults = sanitizeProfileCosmetics({version: 7});
  return Object.fromEntries(Object.entries(defaults).filter(([, value]) => typeof value === 'string').map(([key, value]) => [key, [value]]));
}
test('real rebuild fails closed on corrupt Community instead of erasing grant or publishing arrays', async () => {
  const f = rebuildFixture(2), board = f.data.get(TRACKS + '/' + TRACK);board.entries[0].accountId = A;
  f.mutate(TRACKS + '/' + TRACK, board); await rebuildOverall(f.env, true);
  const entitlement = addCommunityBadge(f.data.get(ENT + A), AT, {accountId: A, ownerUid: UID});
  entitlement.community.accountId = B; f.mutate(ENT + A, entitlement); f.mutate(META, invalidateEntitlements(f.data.get(META), [A])); f.dirty();
  const before = clone(f.data.get(OVERALL)); await assert.rejects(rebuildOverall(f.env, true), /COMMUNITY_ENTITLEMENT_INVALID/);
  assert.deepEqual(f.data.get(OVERALL), before); assert.deepEqual(f.data.get(ENT + A), entitlement);
});
test('real rebuild CAS cannot overwrite a concurrent Community grant and cache invalidation', async () => {
  const f = rebuildFixture(2), board = f.data.get(TRACKS + '/' + TRACK);board.entries[0].accountId = A;
  f.mutate(TRACKS + '/' + TRACK, board); await rebuildOverall(f.env, true); f.dirty();
  const before = clone(f.data.get(OVERALL)); let entitlement;
  f.beforeCommit = async writes => {
    if (!writes.some(write => write.update.name.endsWith(OVERALL))) return;
    f.beforeCommit = null;
    entitlement = addCommunityBadge(f.data.get(ENT + A), AT, {accountId: A, ownerUid: UID});
    f.mutate(ENT + A, entitlement); f.mutate(META, invalidateEntitlements(f.data.get(META), [A]));
  };
  await assert.rejects(rebuildOverall(f.env), /409/); assert.deepEqual(f.data.get(OVERALL), before);
  assert.deepEqual(f.data.get(ENT + A).community, entitlement.community);
  assert.equal((await rebuildOverall(f.env, true)).rebuilt, true); assert.ok(f.data.get(ENT + A).badge.includes('community'));
});

test('actual Community route conflict has no automatic retry and explicit repeat is bounded', async () => {
  const f = fixture(); f.synchronize(); const responses = await Promise.all([f.post(), f.post()]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 503]);
  assert.equal(f.reads(), 6); assert.equal(f.commits.length, 1);
  assert.equal((await f.post()).status, 200); assert.equal(f.reads(), 8); assert.equal(f.commits.length, 1);
});
const publishSource = fs.readFileSync(new URL('./profile-cosmetics-idempotency.test.js', import.meta.url), 'utf8');
const publishStart = publishSource.indexOf('async function fixture(t)');
const publishEnd = publishSource.indexOf("\ntest('three identical", publishStart);
const origin = 'https://cosmetics-audit.invalid', accountId = A, profilePath = '0.6.2_profiles_public/' + A;
const overallPath = OVERALL, jobPath = '0.6.2_s1_worker_jobs/profile_' + A, cosmeticJobPath = '0.6.2_s1_cosmetic_jobs/' + A;
const cosmetics = sanitizeProfileCosmetics({});
assert.ok(publishStart >= 0 && publishEnd > publishStart);
const publishFixture = Function('assert','sanitizeProfileCosmetics','eventEncode','eventDecode','preparePublicationPages','PUBLIC_PAGE_COLLECTION','handleRequest','worker','origin','accountId','profilePath','overallPath','jobPath','cosmeticJobPath','cosmetics',
  publishSource.slice(publishStart, publishEnd) + ';return fixture;')
  (assert,sanitizeProfileCosmetics,eventEncode,eventDecode,preparePublicationPages,PUBLIC_PAGE_COLLECTION,handleRequest,worker,origin,accountId,profilePath,overallPath,jobPath,cosmeticJobPath,cosmetics);
for (const legacy of [false, true]) test('actual profile publisher preserves typed Community, legacy=' + legacy, async t => {
  const f = await publishFixture(t), design = sanitizeProfileCosmetics({version: 7, badge: 'community'});
  const entitlement = addCommunityBadge(null, AT, {accountId: A, ownerUid: UID});
  if (legacy) {entitlement.community.campaign = LEGACY_COMMUNITY_CAMPAIGN; entitlement.community.source = 'invite-code';}
  f.replace(ENT + A, entitlement); f.replace(profilePath, {...f.db.get(profilePath), profileCosmetics: design});
  assert.equal(f.db.get(overallPath).entries[0].profileCosmetics.badge, 'auto');
  let response = await f.save(design); assert.equal(response.status, 202); assert.equal((await response.json()).accepted, true);
  assert.equal(f.db.get(overallPath).entries[0].profileCosmetics.badge, 'community');
  const writes = f.writes.length, invalid = clone(entitlement); invalid.community.ownerUid = 'foreign';
  f.replace(ENT + A, invalid); response = await f.save(design); assert.equal(response.status, 403);
  assert.equal((await response.json()).error, 'cosmetic_locked'); assert.equal(f.writes.length, writes);
  f.db.delete(ENT + A); response = await f.save(design); assert.equal(response.status, 403);
  assert.equal(f.writes.length, writes);
});


test('exact uppercase base32 and either wire field are required before database work', async () => {
  const f = fixture();
  for (const code of [FAKE_CODE.toLowerCase(), ' ' + FAKE_CODE, FAKE_CODE + ' ', FAKE_CODE.slice(1),
    FAKE_CODE + 'A', FAKE_CODE + '\n', FAKE_CODE + '\r\n', '0' + FAKE_CODE.slice(1), '1' + FAKE_CODE.slice(1), '8' + FAKE_CODE.slice(1),
    FAKE_CODE.slice(0, 15) + '\n', '\uFF21' + FAKE_CODE.slice(1), 'Q'.repeat(16), null, [], {}]) {
    for (const field of ['communityCode', 'inviteCode']) {
      const response = await f.post({accountId: A, [field]: code});
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {error: 'invalid_community_code'});
    }
  }
  assert.equal((await f.post({...body, inviteCode: FAKE_CODE})).status, 400);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.post({accountId: A, inviteCode: FAKE_CODE})).status, 200);
});

test('unset malformed or wrong server verifier never opens a transaction or echoes input', async () => {
  for (const secret of [null, '', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), 'a'.repeat(64) + '\n', {}, fakeHash('Q'.repeat(16))]) {
    const f = fixture(secret), response = await f.post();
    assert.equal(response.status, typeof secret === 'string' && secret.length === 64 && /^[a-f0-9]{64}$/i.test(secret) ? 400 : 503);
    assert.deepEqual(await response.json(), {error: response.status === 400 ? 'invalid_community_code' : 'community_unavailable'});
    assert.equal(f.calls.length, 0); assert.equal(f.commits.length, 0);
  }
  const f = fixture();
  assert.equal((await f.post(body, {COMMUNITY_RELAY_CODE_SHA256: undefined})).status, 503);
  assert.equal(f.calls.length, 0);
});

test('base32 digits and uppercase hex verifier are supported without storing request secrets', async () => {
  const fakeCode = 'ABCDEFGH234567AB', f = fixture(fakeHash(fakeCode).toUpperCase());
  const response = await f.post({accountId: A, communityCode: fakeCode});
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), expected(false));
  const stored = JSON.stringify([...f.docs]);
  assert.equal(stored.includes(fakeCode), false); assert.equal(stored.includes(fakeHash(fakeCode)), false);
  assert.equal(stored.includes(fakeHash(fakeCode).toUpperCase()), false);
  assert.equal(stored.includes('communityCode'), false); assert.equal(stored.includes('inviteCode'), false);
});

test('strict legacy provenance preserves existing grants but cannot bypass relay verification', async () => {
  const f = fixture(), prior = addCommunityBadge(null, AT, {accountId: A, ownerUid: UID});
  prior.community.campaign = LEGACY_COMMUNITY_CAMPAIGN; prior.community.source = 'invite-code';
  f.put(ENT + A, prior); const before = structuredClone(f.docs);
  for (const inviteCode of ['jW2az4AQUH', 'https://discord.gg/jW2az4AQUH', 'Q'.repeat(16)]) {
    assert.equal((await f.post({accountId: A, inviteCode})).status, 400);
  }
  assert.equal(f.calls.length, 0);
  assert.equal((await f.post(body, {COMMUNITY_RELAY_CODE_SHA256: undefined})).status, 503);
  assert.equal(f.calls.length, 0);
  const response = await f.post(); assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), expected(true));
  assert.equal(f.reads(), 2); assert.equal(f.commits.length, 0); assert.deepEqual(f.docs, before);
  const purchase = addPurchase(prior, 'profile-pitlane-ticket', AT + 1, {accountId: A, ownerUid: UID});
  assert.deepEqual(purchase.community, prior.community);
  assert.deepEqual(addCommunityBadge(purchase, AT + 2, {accountId: A, ownerUid: UID}).community, prior.community);
});

test('legacy and relay campaign/source pairs cannot be mixed or acquire extra provenance fields', () => {
  const binding = {accountId: A, ownerUid: UID};
  for (const legacy of [false, true]) {
    const prior = addCommunityBadge(null, AT, binding);
    if (legacy) {prior.community.campaign = LEGACY_COMMUNITY_CAMPAIGN; prior.community.source = 'invite-code';}
    assert.deepEqual(readCommunityClaim(prior, binding), prior.community);
    for (const field of ['version', 'accountId', 'ownerUid', 'campaign', 'badgeId', 'source', 'membershipVerified', 'claimedAt', 'extra']) {
      const corrupt = structuredClone(prior);
      corrupt.community[field] = field === 'source' ? legacy ? 'relay-code' : 'invite-code' :
        field === 'campaign' ? legacy ? COMMUNITY_CAMPAIGN : LEGACY_COMMUNITY_CAMPAIGN :
        field === 'membershipVerified' ? true : field === 'claimedAt' ? 0 : 'forged';
      assert.throws(() => readCommunityClaim(corrupt, binding), /COMMUNITY_ENTITLEMENT_INVALID/);
      assert.throws(() => mergeEarnedAndPurchasedEntitlements({badge: ['auto', 'none']}, corrupt, binding), /COMMUNITY_ENTITLEMENT_INVALID/);
    }
  }
});
