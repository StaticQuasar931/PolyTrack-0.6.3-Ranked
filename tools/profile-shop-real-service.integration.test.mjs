import test, {beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {sanitizeProfileCosmetics} from '../workers/ranked/src/index.js';
import {createShopSession} from './shop-session.mjs';
import {createShopControllerStore, createShopController} from './shop-controller.mjs';
import {createShopTransport} from './shop-transport.mjs';
import {createShopBrowserLock} from './shop-browser-lock.mjs';
import {PROFILE_SHOP_CATALOG} from './profile-shop-catalog.mjs';
import {createCurrencyService, handleCurrencyRequest, CURRENCY_COLLECTIONS as C,
  CURRENCY_RULES_VERSION} from '../workers/ranked/src/currency-wallet.js';
import {createEventFirestoreStore, eventEncode, eventDecode} from '../workers/ranked/src/events-store.js';
import {SERVER_ACHIEVEMENT_VERSION, SERVER_ACHIEVEMENT_CATALOG} from '../workers/ranked/src/server-achievements.js';

const A = 'a'.repeat(64), B = 'b'.repeat(64), OWNER_A = 'owner-a', OWNER_B = 'owner-b';
const AT = Date.UTC(2026, 10, 14), BASE = 'projects/polytrack-052/databases/(default)/documents/';
const clone = value => structuredClone(value), ITEMS = PROFILE_SHOP_CATALOG.map(item => item.id);
const pendingKey = id => 'polytrack-shop-pending-v1:' + id;

beforeEach(t => t.mock.method(globalThis, 'fetch', () => assert.fail('external network forbidden')));

// Real client/session/transport + HTTP handler + service + REST transaction adapter.
// Only REST document I/O is simulated. No wallet is seeded and no SDK is loaded.
function fixture({enabled = true, uidLimit = 0} = {}) {
  const docs = new Map(), snapshots = new Map(), databaseCalls = [], commits = [], requests = [], local = new Map(), admissions = new Map();
  let sequence = 0, accountId = A, uid = OWNER_A, scope = 'auth-a-1', ids = 0, lose = null, delay = null, failDatabase = false;
  const put = (path, data) => docs.set(path, {data: clone(data), version: ++sequence});
  put('0.6.2_profiles_public/' + A, {accountId: A, ownerUid: OWNER_A, name: 'Fixture Racer',
    nickname: 'Fixture Racer', carStyle: 'fixture-native-style', isVerifier: false, updatedAt: AT});
  put('0.6.2_profiles_public/' + B, {accountId: B, ownerUid: OWNER_B});
  const defaults = sanitizeProfileCosmetics({});
  const starter = Object.fromEntries(['theme','accent','finish','plate','edge','stage','stageTint','stripe','emblem','title','badge']
    .map(slot => [slot, [defaults[slot]]]));
  put('0.6.2_s1_cosmetic_entitlements/' + A, {...starter, serverIssued: {achievements: {
    version: SERVER_ACHIEVEMENT_VERSION, catalog: SERVER_ACHIEVEMENT_CATALOG,
    casual: {count: 20, ledger: 'ffff0f'.padEnd(24, '0')}
  }}});
  async function request(route, init = {}) {
    const body = init.body ? JSON.parse(init.body) : null;
    databaseCalls.push({route, body});
    if (failDatabase) {failDatabase = false; throw Error('FIRESTORE_503');}
    if (route === ':beginTransaction') {
      const id = 'transaction-' + ++sequence;
      snapshots.set(id, {docs: clone(docs), reads: new Set()}); return {transaction: id};
    }
    if (route === ':rollback') {snapshots.delete(body.transaction); return {};}
    if (route === ':commit') {
      const snapshot = snapshots.get(body.transaction); assert.ok(snapshot);
      for (const path of snapshot.reads)
        if (docs.get(path)?.version !== snapshot.docs.get(path)?.version) throw Error('FIRESTORE_409');
      for (const write of body.writes) {
        const path = write.update.name.slice(BASE.length), current = docs.get(path), precondition = write.currentDocument;
        if (precondition.exists === false && current || precondition.updateTime && precondition.updateTime !== String(current?.version))
          throw Error('FIRESTORE_409');
      }
      for (const write of body.writes) put(write.update.name.slice(BASE.length), eventDecode({mapValue: {fields: write.update.fields}}));
      commits.push(clone(body)); snapshots.delete(body.transaction);
      return {writeResults: body.writes.map(write => ({updateTime: String(docs.get(write.update.name.slice(BASE.length)).version)}))};
    }
    const [path, query] = route.split('?'), transaction = snapshots.get(new URLSearchParams(query).get('transaction'));
    assert.ok(transaction, 'all document reads must belong to a real adapter transaction');
    const key = decodeURIComponent(path.slice(1)); transaction.reads.add(key);
    const document = transaction.docs.get(key);
    return document ? {fields: eventEncode(document.data).mapValue.fields, updateTime: String(document.version)} : null;
  }
  const database = createEventFirestoreStore({request, projectId: 'polytrack-052', retries: 2, pause: async () => {}});
  const service = createCurrencyService({store: database, now: () => AT});
  const storage = {getItem: key => local.get(key) ?? null, setItem: (key, value) => local.set(key, value), removeItem: key => local.delete(key)};
  const withAccountLock = createShopBrowserLock({locks: {request: async (name, options, work) => {
    assert.equal(options.mode, 'exclusive'); assert.equal(options.ifAvailable, true); return work({name});
  }}});
  const transport = createShopTransport({revision: 320, getToken: async () => 'fixture-token:' + uid,
    fetch: async (url, init) => {
      const body = init.body ? JSON.parse(init.body) : null, row = {path: new URL(url).pathname, method: init.method, body};
      requests.push(row);
      if (init.method === 'POST') {
        const saved = JSON.parse(local.get(pendingKey(body.accountId)) || 'null');
        // Direct ownership probes intentionally have no session pending record.
        if (body.requestId.startsWith('client-request-')) assert.equal(saved?.requestId, body.requestId, 'durable intent precedes dispatch');
      }
      const response = await handleCurrencyRequest(new Request(url, init), {env: {
        CURRENCY_ENABLED: enabled ? 'true' : 'false', CURRENCY_RULES_VERSION}, store: database, now: () => AT,
        authenticate: async input => {
          const token = input.headers.get('Authorization');
          assert.ok(token?.startsWith('Bearer fixture-token:')); return token.slice('Bearer fixture-token:'.length);
        }, admit: async authenticatedUid => {
          const count = (admissions.get(authenticatedUid) || 0) + 1; admissions.set(authenticatedUid, count);
          return uidLimit && count > uidLimit ? new Response(JSON.stringify({error: 'rate_limited', retryAfterSeconds: 60}),
            {status: 429, headers: {'Content-Type': 'application/json', 'Retry-After': '60'}}) : null;
        }});
      row.status = response.status; row.result = await response.clone().json();
      if (lose === row.path) {lose = null; throw Error('fixture response lost after successful server commit');}
      if (delay?.path === row.path) {const held = delay; delay = null; held.started(); await held.promise;}
      return response;
    }});
  const dependencies = {transport, storage, getAccountId: () => accountId, makeRequestId: () => 'client-request-' + ++ids,
    withAccountLock, now: () => AT, enabled: true};
  const createSession = () => createShopSession(dependencies);
  const createStore = () => createShopControllerStore({...dependencies, getAuthScope: () => scope});
  function checkpoint() {return {calls: databaseCalls.length, commits: commits.length, requests: requests.length};}
  function cost(since) {
    const calls = databaseCalls.slice(since.calls);
    return {reads: calls.filter(call => call.route.includes('?transaction=')).length,
      writes: commits.slice(since.commits).reduce((sum, commit) => sum + commit.writes.length, 0),
      transport: calls.length};
  }
  return {docs, databaseCalls, commits, requests, local, storage, service, transport, createSession, createStore, checkpoint, cost,
    resetAdmissions() {admissions.clear();},
    identity(id, owner, authScope) {accountId = id; uid = owner; scope = authScope;},
    loseNext(path) {lose = path;},
    failNextDatabaseRequest() {failDatabase = true;},
    delayNext(path) {
      let release, started; const promise = new Promise(resolve => {release = resolve;});
      const ready = new Promise(resolve => {started = resolve;}); delay = {path, promise, started}; return {ready, release};
    }};
}

function mount(f, callbacks = {}) {
  const store = f.createStore(), states = [], rendered = [];
  const unsubscribe = store.subscribe(state => states.push(state));
  const controller = createShopController({root: {}, store, mountShopPreview(root, options) {
    rendered.push(options); const cleanup = () => {}; cleanup.update = value => rendered.push(value); return cleanup;
  }, ...callbacks});
  return {store, controller, states, view: () => rendered.at(-1), dispose() {controller.dispose(); unsubscribe(); store.dispose();}};
}
const purchaseIntent = (ui, itemId) => ({accountId: ui.store.state().accountId, itemId,
  price: PROFILE_SHOP_CATALOG.find(item => item.id === itemId).price, walletRevision: ui.store.state().wallet.revision});
async function claimMilestones(ui) {
  return ui.view().actions.onClaim({accountId: A, rewardId: 'milestones', walletRevision: ui.store.state().wallet.revision});
}
const posts = (f, path) => f.requests.filter(row => row.method === 'POST' && row.path === path);

test('real client controller claims 100 then buys all three quoted v2 items with authoritative completion inventory and measured cost', async () => {
  const f = fixture(), ui = mount(f); assert.equal(f.requests.length, 0);
  assert.equal(f.docs.has(C.wallet + '/' + A), false); await ui.controller.open();
  assert.equal(ui.view().wallet.balance, 0); assert.deepEqual(ui.view().inventory.ownedIds, []); assert.equal(f.commits.length, 0);
  let before = f.checkpoint(); const claim = await claimMilestones(ui);
  assert.equal(claim.outcome.delta, 100); assert.equal(claim.outcome.outcomeOnly, true); assert.equal(claim.wallet.balance, 100);
  assert.deepEqual(claim.outcome.claimedRewardIds, ['tracks-1', 'tracks-5', 'tracks-20']);
  assert.deepEqual(f.cost(before), {reads: 14, writes: 3, transport: 18});
  const balances = [80, 50, 0];
  for (const [index, itemId] of ITEMS.entries()) {
    before = f.checkpoint(); const result = await ui.view().actions.onPurchase(purchaseIntent(ui, itemId));
    const sent = f.requests.slice(before.requests);
    assert.deepEqual(sent.map(row => [row.method, row.path]), [['POST', '/v1/shop/purchase'], ['GET', '/v1/currency/wallet']]);
    assert.deepEqual(Object.keys(sent[0].body).sort(), ['accountId', 'catalogVersion', 'expectedPrice', 'expectedWalletRevision', 'itemId', 'requestId'].sort());
    assert.equal(sent[0].body.catalogVersion, 2); assert.equal(sent[0].body.expectedWalletRevision, index + 1);
    assert.equal(result.outcome.itemKind, 'profile-cosmetic'); assert.equal(result.outcome.catalogVersion, 2); assert.equal('carStyle' in result.outcome, false);
    assert.equal(result.outcome.outcomeOnly, true); assert.equal(result.wallet.balance, balances[index]);
    assert.deepEqual(result.inventory.ownedIds, ITEMS.slice(0, index + 1));
    assert.deepEqual(f.cost(before), {reads: 12, writes: 5, transport: 16});
  }
  assert.deepEqual(f.commits.map(commit => commit.writes.length), [3, 5, 5, 5]);
  assert.equal(f.local.size, 0); assert.equal(posts(f, '/v1/shop/equip').length, 0);
  assert.equal(f.docs.get(C.wallet + '/' + A).data.balance, 0); ui.dispose();
});

test('real session never treats claim or purchase receipt balance as current wallet or inventory', async () => {
  const f = fixture(), session = f.createSession(); await session.load();
  let result = await session.claim('milestones', {confirmed: true});
  assert.equal(result.result.delta, 100); assert.equal(result.wallet, null); assert.equal(result.inventory, null);
  await session.load({refresh: true}); const intent = session.preparePurchase(ITEMS[0]);
  result = await session.confirmPurchase(intent.id, {confirmed: true});
  assert.equal(result.result.balanceAfter, 80); assert.equal(result.wallet, null); assert.equal(result.inventory, null);
  const before = f.checkpoint(); result = await session.load({refresh: true});
  assert.equal(result.wallet.balance, 80); assert.deepEqual(result.inventory.ownedItemIds, [ITEMS[0]]);
  assert.deepEqual(f.cost(before), {reads: 6, writes: 0, transport: 8}); session.dispose();
});

test('lost real purchase survives controller recreation and same original quote recovers outcome only before a fresh completion GET', async () => {
  const f = fixture(); let ui = mount(f); await ui.controller.open(); await claimMilestones(ui);
  f.loseNext('/v1/shop/purchase');
  await assert.rejects(ui.view().actions.onPurchase(purchaseIntent(ui, ITEMS[0])), error => error.ambiguous === true);
  const first = clone(posts(f, '/v1/shop/purchase')[0].body), durable = f.local.get(pendingKey(A));
  assert.equal(JSON.parse(durable).schemaVersion, 2); assert.equal(JSON.parse(durable).expectedWalletRevision, first.expectedWalletRevision);
  assert.equal(f.docs.get(C.wallet + '/' + A).data.balance, 80); assert.equal(ui.store.state().phase, 'reconciliation-required');
  ui.dispose();
  await f.service.execute(OWNER_A, {op: 'claim', accountId: A, requestId: 'other-tab-login', rewardId: 'login'});
  ui = mount(f); await ui.controller.open(); assert.equal(f.local.get(pendingKey(A)), durable);
  assert.equal(posts(f, '/v1/shop/purchase').length, 1); assert.equal(ui.view().reconciliationRequired, true);
  const before = f.checkpoint(); const recovered = await ui.controller.reconcile({confirmed: true});
  assert.equal(recovered.outcome.duplicate, true); assert.equal(recovered.outcome.outcomeOnly, true);
  assert.equal(recovered.outcome.balanceAfter, 80); assert.equal(recovered.wallet.balance, 88);
  assert.deepEqual(recovered.inventory.ownedIds, [ITEMS[0]]);
  assert.deepEqual(posts(f, '/v1/shop/purchase')[1].body, first); assert.equal(f.local.size, 0);
  assert.deepEqual(f.cost(before), {reads: 9, writes: 0, transport: 13});
  const transient = ui.states.find(state => state.phase === 'outcome');
  assert.equal(transient.wallet, null); assert.equal(transient.inventory, null); ui.dispose();
});

test('stale real quote 409 notCommitted clears new durable intent without a preflight GET, charge or automatic retry', async () => {
  const f = fixture(), ui = mount(f); await ui.controller.open(); await claimMilestones(ui);
  const intent = purchaseIntent(ui, ITEMS[0]);
  await f.service.execute(OWNER_A, {op: 'claim', accountId: A, requestId: 'parallel-login', rewardId: 'login'});
  const before = f.checkpoint();
  await assert.rejects(ui.view().actions.onPurchase(intent), error => error.code === 'quote_stale' && error.status === 409 && error.notCommitted === true && error.ambiguous === false);
  assert.deepEqual(f.cost(before), {reads: 3, writes: 0, transport: 5});
  assert.deepEqual(f.requests.slice(before.requests).map(row => row.path), ['/v1/shop/purchase']);
  assert.equal(f.local.size, 0); assert.equal(ui.store.state().pending, null); assert.equal(ui.view().wallet.status, 'unknown');
  assert.equal(f.docs.get(C.wallet + '/' + A).data.balance, 108);
  await ui.controller.refresh(); assert.equal(ui.view().wallet.balance, 108);
  await ui.view().actions.onPurchase(purchaseIntent(ui, ITEMS[0]));
  const commands = posts(f, '/v1/shop/purchase'); assert.notEqual(commands[0].body.requestId, commands[1].body.requestId);
  assert.equal(commands[1].body.expectedWalletRevision, 2); assert.equal(ui.view().wallet.balance, 88); ui.dispose();
});

test('real ownership checks reject another authenticated account and old view cannot apply its inventory', async () => {
  const f = fixture(), applied = [], ui = mount(f, {onApply: input => applied.push(input)});
  await ui.controller.open(); await claimMilestones(ui); await ui.view().actions.onPurchase(purchaseIntent(ui, ITEMS[0]));
  const old = ui.view().actions; f.identity(B, OWNER_B, 'auth-b'); ui.store.reset(); await ui.controller.open();
  assert.equal(ui.view().wallet.accountId, B); assert.equal(ui.view().wallet.balance, 0); assert.deepEqual(ui.view().inventory.ownedIds, []);
  await assert.rejects(old.onApply({accountId: A, itemId: ITEMS[0], draftOnly: true}), {code: 'stale_view'});
  await assert.rejects(ui.view().actions.onApply({accountId: B, itemId: ITEMS[0], draftOnly: true}), {code: 'ownership_required'});
  const before = f.checkpoint();
  await assert.rejects(f.transport({path: '/v1/currency/wallet?accountId=' + A}), error => error.code === 'profile_not_owned');
  await assert.rejects(f.transport({path: '/v1/shop/purchase', method: 'POST', body: {accountId: A, requestId: 'cross-account-attempt',
    itemId: ITEMS[1], catalogVersion: 2, expectedPrice: 30, expectedWalletRevision: 2}}), error => error.code === 'profile_not_owned' && error.notCommitted === true);
  assert.equal(f.cost(before).writes, 0); assert.equal(f.docs.get(C.wallet + '/' + A).data.balance, 80);
  assert.equal(f.docs.has(C.wallet + '/' + B), false); assert.equal(applied.length, 0); ui.dispose();
});

test('owned Apply only calls the injected Studio draft callback, with no service, equip, profile write or balance change', async () => {
  const f = fixture(), applied = []; let draft = null;
  const ui = mount(f, {onApply: input => {
    applied.push(input); const item = PROFILE_SHOP_CATALOG.find(item => item.id === input.itemId);
    assert.equal(input.draftOnly, true); assert.equal(input.isCurrent(), true);
    draft = clone(item.grants); return {applied: true, accountId: input.accountId, itemId: input.itemId, draftOnly: true};
  }});
  await ui.controller.open(); await claimMilestones(ui);
  await assert.rejects(ui.view().actions.onApply({accountId: A, itemId: ITEMS[0], draftOnly: true}), {code: 'ownership_required'});
  await ui.view().actions.onPurchase(purchaseIntent(ui, ITEMS[0])); const before = f.checkpoint(), documents = clone(f.docs);
  await assert.rejects(ui.view().actions.onApply({accountId: A, itemId: ITEMS[0], draftOnly: false}), {code: 'ownership_required'});
  const result = await ui.view().actions.onApply({accountId: A, itemId: ITEMS[0], draftOnly: true});
  assert.deepEqual(result, {applied: true, accountId: A, itemId: ITEMS[0], draftOnly: true});
  assert.deepEqual(draft, [{slot: 'plate', value: 'pitlane-ticket'}]); assert.equal(applied.length, 1);
  assert.deepEqual(f.docs, documents); assert.deepEqual(f.cost(before), {reads: 0, writes: 0, transport: 0});
  assert.equal(f.requests.length, before.requests); assert.equal(posts(f, '/v1/shop/equip').length, 0);
  ui.dispose(); assert.equal(applied[0].isCurrent(), false);
});

test('draft Apply freshness cannot revive after an A-B-A authentication transition', async () => {
  const f = fixture(); let callback;
  const ui = mount(f, {onApply: input => {callback = input; return {applied: true, accountId: A, itemId: ITEMS[0], draftOnly: true};}});
  await ui.controller.open(); await claimMilestones(ui); await ui.view().actions.onPurchase(purchaseIntent(ui, ITEMS[0]));
  await ui.view().actions.onApply({accountId: A, itemId: ITEMS[0], draftOnly: true}); assert.equal(callback.isCurrent(), true);
  f.identity(B, OWNER_B, 'auth-b'); ui.store.reset(); assert.equal(callback.isCurrent(), false); await ui.controller.open();
  f.identity(A, OWNER_A, 'auth-a-2'); ui.store.reset(); await ui.controller.open();
  assert.equal(callback.isCurrent(), false, 'an old asynchronous draft callback must remain stale after A-B-A'); ui.dispose();
});

test('disabled actual service rejects client load before auth or any document request', async () => {
  const f = fixture({enabled: false}), ui = mount(f); await assert.rejects(ui.controller.open(), {code: 'currency_disabled'});
  assert.equal(f.databaseCalls.length, 0); assert.equal(f.commits.length, 0); assert.equal(ui.store.state().enabled, false); ui.dispose();
});

const SAVED_RULES = fileURLToPath(new URL('../../../2026-11-13/late-update/live-firestore.rules', import.meta.url));
const SAVED_RULES_SHA256 = 'd335b44eaff7406cb4972738527ce8519f76cd35f1b4815a396cbf88dce23f7d';
function rulesFunction(source, name) {
  const start = source.indexOf('function ' + name + '('); assert.ok(start >= 0, 'actual saved rules function ' + name);
  const open = source.indexOf('{', start); let depth = 1, end = open;
  while (depth && ++end < source.length) {if (source[end] === '{') depth++; if (source[end] === '}') depth--;}
  assert.equal(depth, 0); return source.slice(open + 1, end);
}
function savedRules() {
  const bytes = readFileSync(SAVED_RULES); assert.equal(createHash('sha256').update(bytes).digest('hex'), SAVED_RULES_SHA256);
  return bytes.toString('utf8');
}
// Expressions come from the actual saved, hash-bound source. This models only
// these predicates, not the Firestore engine, rule billing, or live deployment.
function rulePredicates(source) {
  const expression = name => {const body = rulesFunction(source, name), start = body.indexOf('return ') + 7;
    return body.slice(start, body.indexOf(';', start));};
  const text = (value, min, max) => typeof value === 'string' && value.length >= min && value.length <= max;
  const number = (value, min, max) => typeof value === 'number' && value >= min && value <= max;
  const keys = value => ({hasAll: list => list.every(key => Object.hasOwn(value, key)),
    hasOnly: list => Object.keys(value).every(key => list.includes(key))});
  const compile = (body, args, scope) => vm.runInNewContext('(('+args.join(',')+')=>('+body+'))', scope);
  const valid = compile(expression('validProfileCosmetics').replace('cosmetics is map', 'isMap(cosmetics)')
    .replace(/cosmetics\.version in (\[[^\]]+\])/, '$1.includes(cosmetics.version)')
    .replace('cosmetics.overridePodium is bool', "typeof cosmetics.overridePodium === 'boolean'"), ['cosmetics','keys'],
    {text, isMap: value => !!value && typeof value === 'object' && !Array.isArray(value)});
  const validCosmetics = value => valid(value, keys(value));
  const member = compile(expression('entitledCosmetics')
    .replace(/c\.(\w+) in (allowed\.get\('[^']+', \[[^\]]*\]\)|allowed\.\w+)/g, '$2.includes(c.$1)'), ['c','allowed'], {});
  const entitled = (value, allowance) => member(value, {...allowance,
    get: (key, fallback) => Object.hasOwn(allowance, key) ? allowance[key] : fallback});
  const publicProfile = compile(expression('validPublicProfile').replace('data.updatedAt is number', "typeof data.updatedAt === 'number'"),
    ['data','accountId','keys'], {text, number, validProfileCosmetics: validCosmetics});
  function ownerUpdate(old, data, id, ownerUid, timestamp, allowance) {
    const changed = Object.keys({...old, ...data}).filter(key => JSON.stringify(old[key]) !== JSON.stringify(data[key]));
    const predicate = compile(expression('validProfileOwnerUpdate')
      .replace('data.cosmeticsUpdatedAt is number', "typeof data.cosmeticsUpdatedAt === 'number'"),
      ['old','data','changed','request','accountId'], {number, signedIn: () => !!ownerUid,
        entitledCosmetics: (value, accountId) => accountId === id && entitled(value, allowance)});
    return predicate(old, data, {hasOnly: list => changed.every(key => list.includes(key)),
      hasAny: list => changed.some(key => list.includes(key))}, {auth: {uid: ownerUid}, time: timestamp}, id) &&
      publicProfile(data, id, keys(data));
  }
  return {validCosmetics, entitled, ownerUpdate};
}

test('actual saved rules hash and match inventory leave every currency/shop collection default-denied', () => {
  const source = savedRules(), matches = [...source.matchAll(/^\s*match\s+(\S+)\s+\{/gm)].map(match => match[1]);
  assert.deepEqual(matches.filter(path => path.startsWith('/{')), ['/{document=**}'], 'no overlapping broad wildcard allow');
  for (const collection of Object.values(C)) assert.ok(!matches.some(path => path.startsWith('/' + collection + '/')),
    collection + ' must remain unlisted, not public or owner-readable');
  assert.match(source, /match \/\{document=\*\*\}\s*\{\s*allow read, write: if false;\s*\}/);
  assert.match(source, /match \/0\.6\.2_s1_cosmetic_entitlements\/\{accountId\}\s*\{\s*allow read, write: if false;\s*\}/);
  const profileBlock = source.slice(source.indexOf('match /0.6.2_profiles_public/'), source.indexOf('match /0.6.2_s1_cosmetic_jobs/'));
  assert.ok(profileBlock.includes('validProfileOwnerUpdate(accountId)')); assert.ok(profileBlock.includes('validPublicProfile(request.resource.data, accountId)'));
});

for (const version of [1,7]) test('actual saved owner-update/allowance expressions accept version ' + version + ' only after real server purchases', async () => {
  const predicates = rulePredicates(savedRules()), f = fixture(), ui = mount(f);
  const design = {...sanitizeProfileCosmetics({}), version};
  for (const item of PROFILE_SHOP_CATALOG) design[item.grants[0].slot] = item.grants[0].value;
  const prior = clone(f.docs.get('0.6.2_profiles_public/' + A).data), timestamp = {toMillis: () => AT};
  const update = {...prior, profileCosmetics: design, cosmeticsSyncedAt: timestamp, cosmeticsUpdatedAt: AT, updatedAt: AT};
  assert.equal(predicates.validCosmetics(design), true);
  assert.equal(predicates.ownerUpdate(prior, update, A, OWNER_A, timestamp, f.docs.get('0.6.2_s1_cosmetic_entitlements/' + A).data), false);
  await ui.controller.open(); await claimMilestones(ui);
  for (const itemId of ITEMS) await ui.view().actions.onPurchase(purchaseIntent(ui, itemId));
  const allowance = f.docs.get('0.6.2_s1_cosmetic_entitlements/' + A).data;
  assert.equal(predicates.ownerUpdate(prior, update, A, OWNER_A, timestamp, allowance), true);
  assert.equal(predicates.ownerUpdate(prior, update, A, OWNER_B, timestamp, allowance), false);
  assert.equal(predicates.ownerUpdate(prior, {...update, cosmeticsSyncedAt: {toMillis: () => AT}}, A, OWNER_A, timestamp, allowance), false);
  assert.equal(predicates.ownerUpdate(prior, {...update, profileCosmetics: {...design, badge: 'betaTester'}}, A, OWNER_A, timestamp, allowance), false);
  ui.dispose();
});

for (const rewardId of ['login', 'milestones']) test('second different real ' + rewardId + ' claim clears definitely rejected pending; explicit refresh then purchase works', async () => {
  const f = fixture(), ui = mount(f); await ui.controller.open(); await claimMilestones(ui);
  if (rewardId === 'login') await ui.store.claim('login', {confirmed: true});
  const first = posts(f, '/v1/currency/claim').find(row => row.body.rewardId === rewardId);
  const before = f.checkpoint(), documents = clone(f.docs);
  await assert.rejects(ui.store.claim(rewardId, {confirmed: true}), error =>
    error.code === 'reward_already_claimed' && error.status === 409 && error.notCommitted === true && error.ambiguous === false);
  await new Promise(resolve => setImmediate(resolve));
  const sent = f.requests.slice(before.requests); assert.equal(sent.length, 1, 'no completion or retry GET after rejection');
  assert.equal(sent[0].path, '/v1/currency/claim'); assert.equal(sent[0].method, 'POST');
  assert.notEqual(sent[0].body.requestId, first.body.requestId, 'this is a new uncommitted alias, not successful receipt replay');
  assert.deepEqual(sent[0].result, {error: 'reward_already_claimed', notCommitted: true,
    ...(rewardId === 'login' ? {claimDay: Math.floor(AT / 86400000), serverNow: AT, dayEndsAt: AT + 86400000} : {})});
  assert.equal(f.local.has(pendingKey(A)), false); assert.equal(ui.store.state().pending, null);
  assert.equal(ui.store.state().phase, 'error'); assert.equal(ui.view().reconciliationRequired, false);
  assert.equal(ui.view().wallet.status, 'unknown'); assert.deepEqual(f.docs, documents);
  assert.deepEqual(f.cost(before), {reads: rewardId === 'login' ? 4 : 8, writes: 0, transport: rewardId === 'login' ? 6 : 10});
  await ui.controller.refresh(); const oldBalance = ui.store.state().wallet.balance;
  const purchase = await ui.view().actions.onPurchase(purchaseIntent(ui, ITEMS[0]));
  assert.equal(purchase.wallet.balance, oldBalance - 20); assert.deepEqual(purchase.inventory.ownedIds, [ITEMS[0]]);
  assert.equal(f.local.size, 0); ui.dispose();
});

test('real missing milestone eligibility returns 403 notCommitted, clears fresh pending and never auto-fetches or writes', async () => {
  const f = fixture(), ui = mount(f); f.identity(B, OWNER_B, 'auth-b'); await ui.controller.open();
  const before = f.checkpoint(), documents = clone(f.docs);
  await assert.rejects(ui.store.claim('milestones', {confirmed: true}), error => error.code === 'server_milestone_required' &&
    error.status === 403 && error.notCommitted === true && error.ambiguous === false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests.length - before.requests, 1); assert.equal(f.cost(before).writes, 0);
  assert.deepEqual(f.docs, documents); assert.equal(ui.store.state().pending, null);
  assert.equal(f.local.has(pendingKey(B)), false); ui.dispose();
});

test('real initial claim 503 preserves exact pending with zero award, and only explicit same-ID reconcile may claim', async () => {
  const f = fixture(), ui = mount(f); await ui.controller.open(); f.failNextDatabaseRequest();
  const before = f.checkpoint();
  await assert.rejects(ui.store.claim('milestones', {confirmed: true}), error => error.status === 503 &&
    error.code === 'currency_unavailable' && error.ambiguous === true && error.notCommitted === false);
  const saved = f.local.get(pendingKey(A)), original = clone(posts(f, '/v1/currency/claim')[0].body);
  assert.equal(JSON.parse(saved).schemaVersion, 3); assert.equal(f.docs.has(C.wallet + '/' + A), false);
  assert.equal(f.requests.length - before.requests, 1); assert.equal(f.cost(before).writes, 0);
  assert.equal(ui.store.state().phase, 'reconciliation-required');
  await ui.controller.refresh(); assert.equal(f.local.get(pendingKey(A)), saved);
  assert.equal(posts(f, '/v1/currency/claim').length, 1, 'refresh must not automatically retry a claim');
  const recovered = await ui.controller.reconcile({confirmed: true});
  assert.equal(recovered.outcome.duplicate, false); assert.equal(recovered.wallet.balance, 100);
  assert.deepEqual(posts(f, '/v1/currency/claim')[1].body, original); assert.equal(f.local.size, 0);
  assert.equal(f.commits.length, 1); assert.equal(f.commits[0].writes.length, 3); ui.dispose();
});

test('ambiguous committed real daily claim plus later real 503 keeps original pending until exact receipt recovery, never another award', async () => {
  const f = fixture(); let ui = mount(f); await ui.controller.open(); await claimMilestones(ui);
  f.loseNext('/v1/currency/claim');
  await assert.rejects(ui.store.claim('login', {confirmed: true}), error => error.ambiguous === true);
  const original = clone(posts(f, '/v1/currency/claim').at(-1).body), saved = f.local.get(pendingKey(A));
  assert.equal(f.docs.get(C.wallet + '/' + A).data.balance, 108); assert.equal(f.commits.length, 2);
  ui.dispose(); ui = mount(f); await ui.controller.open(); assert.equal(f.local.get(pendingKey(A)), saved);
  const before = f.checkpoint(); f.failNextDatabaseRequest();
  await assert.rejects(ui.controller.reconcile({confirmed: true}), error => error.status === 503 &&
    error.code === 'currency_unavailable' && error.ambiguous === true && error.notCommitted === false);
  assert.equal(f.local.get(pendingKey(A)), saved); assert.equal(ui.store.state().pending.requestId, original.requestId);
  assert.equal(ui.store.state().phase, 'reconciliation-required'); assert.equal(f.requests.length - before.requests, 1);
  assert.equal(f.cost(before).writes, 0); assert.equal(f.commits.length, 2);
  const recovered = await ui.controller.reconcile({confirmed: true});
  assert.equal(recovered.outcome.duplicate, true); assert.equal(recovered.outcome.delta, 8); assert.equal(recovered.wallet.balance, 108);
  const daily = posts(f, '/v1/currency/claim').filter(row => row.body.rewardId === 'login');
  assert.equal(daily.length, 3); assert.ok(daily.every(row => JSON.stringify(row.body) === JSON.stringify(original)));
  assert.equal(f.local.size, 0); assert.equal(f.commits.length, 2); ui.dispose();
});

test('validated catalog reuse fits login plus milestones plus three real purchases in exactly twelve shared admissions', async () => {
  const f = fixture({uidLimit: 12}), ui = mount(f); await ui.controller.open();
  assert.equal(f.requests.length, 2);
  await ui.store.claim('login', {confirmed: true}); assert.equal(f.requests.length, 4);
  await claimMilestones(ui); assert.equal(f.requests.length, 6);
  for (const [index, itemId] of ITEMS.entries()) {
    await ui.view().actions.onPurchase(purchaseIntent(ui, itemId)); assert.equal(f.requests.length, 8 + 2 * index);
  }
  assert.equal(f.requests.length, 12); assert.ok(f.requests.every(row => row.status === 200));
  assert.equal(f.requests.filter(row => row.path === '/v1/shop/catalog').length, 1);
  assert.equal(f.requests.filter(row => row.path === '/v1/currency/wallet').length, 6);
  assert.equal(ui.store.state().wallet.balance, 8); assert.deepEqual(ui.store.state().inventory.ownedItemIds, ITEMS);
  assert.deepEqual(f.commits.map(commit => commit.writes.length), [3, 3, 5, 5, 5]); ui.dispose();
});

test('completion 429 after real committed purchase requires explicit later refresh, never a new POST or receipt-derived wallet', async () => {
  const f = fixture({uidLimit: 12}), ui = mount(f); await ui.controller.open(); await claimMilestones(ui);
  assert.equal(f.requests.length, 4);
  // Other admitted activity can consume the shared budget; no exemption is used.
  for (let i = 0; i < 7; i++) await f.transport({path: '/v1/shop/catalog', method: 'GET'});
  const before = f.checkpoint();
  await assert.rejects(ui.view().actions.onPurchase(purchaseIntent(ui, ITEMS[0])), error => error.status === 429 && error.code === 'rate_limited');
  assert.deepEqual(f.requests.slice(before.requests).map(row => [row.path, row.status]),
    [['/v1/shop/purchase', 200], ['/v1/currency/wallet', 429]]);
  assert.equal(ui.store.state().phase, 'refresh-required'); assert.equal(ui.store.state().pending, null);
  assert.equal(ui.store.state().wallet, null); assert.equal(ui.store.state().inventory, null);
  assert.equal(ui.store.state().outcome.outcomeOnly, true); assert.equal(ui.store.state().outcome.balanceAfter, 80);
  assert.equal(f.local.size, 0); assert.equal(f.docs.get(C.wallet + '/' + A).data.balance, 80);
  assert.deepEqual(f.cost(before), {reads: 6, writes: 5, transport: 8});
  const count = f.requests.length; await new Promise(resolve => setImmediate(resolve)); assert.equal(f.requests.length, count);
  f.resetAdmissions(); const recovery = f.checkpoint(); await ui.controller.refresh();
  assert.deepEqual(f.requests.slice(recovery.requests).map(row => row.path), ['/v1/shop/catalog', '/v1/currency/wallet']);
  assert.equal(posts(f, '/v1/shop/purchase').length, 1); assert.equal(ui.store.state().wallet.balance, 80);
  assert.deepEqual(ui.store.state().inventory.ownedItemIds, [ITEMS[0]]); assert.equal(f.cost(recovery).writes, 0); ui.dispose();
});
