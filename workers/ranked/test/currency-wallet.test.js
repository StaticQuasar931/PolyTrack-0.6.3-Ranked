import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createCurrencyService, handleCurrencyRequest, CURRENCY_COLLECTIONS as C,
  CURRENCY_RULES_VERSION, SHOP_CATALOG} from '../src/currency-wallet.js';
import {createEventFirestoreStore, eventEncode, eventDecode} from '../src/events-store.js';
import {SERVER_ACHIEVEMENT_CATALOG, SERVER_ACHIEVEMENT_RECOGNIZED_TRACK_COUNT} from '../src/server-achievements.js';
import {decodeNativeCarStyle} from '../src/native-car-style.js';
import {handleRequest} from '../src/index.js';

const ACCOUNT = 'a'.repeat(64), UID = 'test-owner', AT = Date.UTC(2026, 10, 14), DAY = 86400000;
const BASE = 'projects/polytrack-052/databases/(default)/documents/';
const copy = value => structuredClone(value);
// Real REST transaction adapter, in-memory mock transport only. No credentials,
// network, cloud SDK or live DB calls. State survives service reconstruction.
function fixture() {
  const docs = new Map(), snapshots = new Map(), calls = [], commits = [];
  let sequence = 0, clock = AT, failure = '', loseReply = false, barrier = null;
  const put = (key, data) => docs.set(key, {data: copy(data), version: ++sequence});
  put('0.6.2_profiles_public/' + ACCOUNT, {accountId: ACCOUNT, ownerUid: UID});
  const request = async (route, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null; calls.push({route, body});
    if (route === ':beginTransaction') {
      const id = 'tx-' + ++sequence; snapshots.set(id, {docs: copy(docs), reads: new Set()});
      if (barrier && snapshots.size >= 2) barrier.release();
      return {transaction: id};
    }
    if (route === ':rollback') {snapshots.delete(body.transaction); return {};}
    if (route === ':commit') {
      if (barrier) await barrier.ready;
      const snapshot = snapshots.get(body.transaction); assert.ok(snapshot);
      if (failure) {const code = failure; failure = ''; throw Error(code);}
      for (const key of snapshot.reads) {
        if (docs.get(key)?.version !== snapshot.docs.get(key)?.version) throw Error('FIRESTORE_409');
      }
      for (const write of body.writes) {
        const key = write.update.name.slice(BASE.length), current = docs.get(key);
        if (write.currentDocument.exists === false && current || write.currentDocument.updateTime &&
            write.currentDocument.updateTime !== String(current?.version)) throw Error('FIRESTORE_409');
      }
      // Validate all conditions before applying any writes, like Firestore.
      for (const write of body.writes) put(write.update.name.slice(BASE.length),
        eventDecode({mapValue: {fields: write.update.fields}}));
      commits.push(copy(body)); snapshots.delete(body.transaction);
      if (loseReply) {loseReply = false; throw Error('FIRESTORE_503');}
      return {writeResults: body.writes.map(write => ({updateTime: String(docs.get(write.update.name.slice(BASE.length)).version)}))};
    }
    const [pathname, query] = route.split('?'), tx = snapshots.get(new URLSearchParams(query).get('transaction'));
    assert.ok(tx, 'every read belongs to one transaction');
    const key = decodeURIComponent(pathname.slice(1)); tx.reads.add(key);
    const document = tx.docs.get(key);
    return document ? {fields: eventEncode(document.data).mapValue.fields, updateTime: String(document.version)} : null;
  };
  const store = createEventFirestoreStore({request, projectId: 'polytrack-052', retries: 2, pause: async () => {}});
  const service = () => createCurrencyService({store, now: () => clock});
  let nonce = 0;
  const command = (op, extra = {}) => ({op, accountId: ACCOUNT, ...(op === 'wallet' ? {} : {requestId: 'request-' + ++nonce}), ...extra});
  return {docs, calls, commits, put, store, service, command, request, setClock: value => {clock = value;},
    synchronize() {let release; const ready = new Promise(resolve => {release = resolve;}); barrier = {ready, release};},
    fail: code => {failure = code;}, loseReply: () => {loseReply = true;},
    run: (op, extra) => service().execute(UID, command(op, extra)),
    // Synthetic balances only for concurrency/purchase tests, never production.
    funds: balance => put(C.wallet + '/' + ACCOUNT, {schema: 1, accountId: ACCOUNT, ownerUid: UID, balance, revision: 1}),
    milestones(count = 20) {this.put('0.6.2_s1_cosmetic_entitlements/' + ACCOUNT,
      {serverIssued: {achievements: {version: 1, catalog: SERVER_ACHIEVEMENT_CATALOG,
        casual: {count, ledger: (count === 20 ? 'ffff0f' : count === 5 ? '1f' : '01').padEnd(24, '0')}}}});}
  };
}

test('a first authenticated reward persists real balance, durable proof receipt and operation receipt atomically', async () => {
  const f = fixture(), result = await f.run('claim', {rewardId: 'login'});
  assert.equal(result.delta, 8); assert.equal(result.balanceAfter, 8);
  assert.equal(f.commits.length, 1); assert.equal(f.commits[0].writes.length, 3);
  assert.equal((await f.service().execute(UID, {op: 'wallet', accountId: ACCOUNT})).balance, 8);
  assert.equal([...f.docs.keys()].filter(key => key.startsWith(C.grants + '/')).length, 1);
});
test('login is once per trusted UTC day regardless of aliases, restart, retries or missed days', async () => {
  const f = fixture(), cmd = f.command('claim', {rewardId: 'login'});
  assert.equal((await f.service().execute(UID, cmd)).delta, 8);
  assert.equal((await f.service().execute(UID, cmd)).duplicate, true);
  await assert.rejects(f.run('claim', {rewardId: 'login'}), /reward_already_claimed/);
  f.setClock(AT + DAY * 4);
  assert.equal((await f.service().execute(UID, cmd)).delta, 8, 'old receipt describes original award, never re-awards');
  assert.equal((await f.run('claim', {rewardId: 'login'})).balanceAfter, 16);
});
test('actual successful login ID is permanently receipt-bound and cannot credit on a later day', async () => {
  const f = fixture(), cmd = f.command('claim', {rewardId: 'login'});
  const original = await f.service().execute(UID, cmd);
  for (const days of [1, 2, 30]) {
    f.setClock(AT + days * DAY);
    const replay = await f.service().execute(UID, cmd);
    assert.deepEqual(replay, {...original, duplicate: true});
    assert.equal((await f.run('wallet')).balance, 8);
    assert.equal(f.commits.length, 1);
  }
  assert.equal([...f.docs.keys()].filter(key => key.startsWith(C.grants + '/')).length, 1);
});
test('unknown already-claimed alias fails 409 without writes; next-day first success is not a changed success', async () => {
  const f = fixture(); await f.run('claim', {rewardId: 'login'});
  const alias = f.command('claim', {rewardId: 'login'}), size = f.docs.size, commits = f.commits.length;
  await assert.rejects(f.service().execute(UID, alias), error => error.message === 'reward_already_claimed' && error.httpStatus === 409);
  assert.equal(f.docs.size, size); assert.equal(f.commits.length, commits);
  f.setClock(AT + DAY);
  const firstSuccess = await f.service().execute(UID, alias);
  assert.equal(firstSuccess.duplicate, false); assert.equal(firstSuccess.delta, 8);
  assert.equal(firstSuccess.balanceAfter, 16);
  f.setClock(AT + DAY * 2);
  assert.deepEqual(await f.service().execute(UID, alias), {...firstSuccess, duplicate: true});
  assert.equal((await f.run('wallet')).balance, 16); assert.equal(f.commits.length, 2);
});
test('milestone evidence is canonical server-issued distinct-track ledger, never a client count', async () => {
  const f = fixture();
  await assert.rejects(f.run('claim', {rewardId: 'tracks-20'}), /server_milestone_required/);
  for (const extra of [{count: 99}, {verified: true}, {now: AT + DAY}, {amount: 999}, {ownerUid: UID}]) {
    await assert.rejects(f.run('claim', {rewardId: 'tracks-20', ...extra}), /invalid_command/);
  }
  f.milestones();
  let total = 0;
  for (const rewardId of ['tracks-1', 'tracks-5', 'tracks-20']) {
    total += (await f.run('claim', {rewardId})).delta;
    await assert.rejects(f.run('claim', {rewardId}), /reward_already_claimed/);
  }
  assert.equal(total, 100);
  assert.equal((await f.run('wallet')).balance, 100);
});
test('invalid or inflated server evidence also fails closed', async () => {
  const f = fixture(); f.milestones();
  const key = '0.6.2_s1_cosmetic_entitlements/' + ACCOUNT;
  const good = copy(f.docs.get(key).data);
  for (const change of [{count: 100}, {count: 20, ledger: ''}, {count: 20, ledger: 'zz'}, {count: 1, ledger: '01'}]) {
    const data = copy(good); Object.assign(data.serverIssued.achievements.casual, change); f.put(key, data);
    await assert.rejects(f.run('claim', {rewardId: 'tracks-20'}), /server_milestone_required/);
  }
  assert.equal([...f.docs.keys()].some(key => key.startsWith(C.wallet + '/')), false);
});
test('recognized ledger width is pinned to the actual 89-track server registry', () => {
  const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const tracks = new Set();
  for (const name of ['OFFICIAL_IDS', 'COMMUNITY_IDS', 'LEGACY_COMMUNITY_IDS']) {
    const match = source.match(new RegExp('const ' + name + ' = new Set\\((\\[[^\\n]+?\\])\\);'));
    assert.ok(match, name);
    for (const id of match[1].matchAll(/['"]([a-f0-9]{64})['"]/g)) tracks.add(id[1]);
  }
  assert.equal(tracks.size, 89);
  assert.equal(SERVER_ACHIEVEMENT_RECOGNIZED_TRACK_COUNT, tracks.size);
});
test('short forged ledger 1f/count5, bad width, padding bits and count mismatch never mint a milestone', async () => {
  for (const casual of [{count: 5, ledger: '1f'}, {count: 5, ledger: '1f'.padEnd(22, '0')},
    {count: 5, ledger: '1f'.padEnd(26, '0')}, {count: 5, ledger: '0f' + '00'.repeat(10) + '02'},
    {count: 5, ledger: '0f' + '00'.repeat(10) + '80'}, {count: 5, ledger: '01'.padEnd(24, '0')},
    {count: 90, ledger: 'ff'.repeat(11) + '03'}]) {
    const f = fixture();
    f.put('0.6.2_s1_cosmetic_entitlements/' + ACCOUNT, {serverIssued: {achievements: {
      version: 1, catalog: SERVER_ACHIEVEMENT_CATALOG, casual}}});
    await assert.rejects(f.run('claim', {rewardId: 'tracks-5'}), /server_milestone_required/);
    assert.equal(f.commits.length, 0); assert.equal(f.docs.size, 2);
  }
});
test('exact-width recognized bits qualify, including last recognized bit88 without padding bits', async () => {
  for (const casual of [{count: 5, ledger: '1f'.padEnd(24, '0')},
    {count: 5, ledger: '0f' + '00'.repeat(10) + '01'}, {count: 89, ledger: 'ff'.repeat(11) + '01'}]) {
    const f = fixture(); f.put('0.6.2_s1_cosmetic_entitlements/' + ACCOUNT, {serverIssued: {achievements: {
      version: 1, catalog: SERVER_ACHIEVEMENT_CATALOG, casual}}});
    assert.equal((await f.run('claim', {rewardId: 'tracks-5'})).delta, 30);
  }
});
test('ten already-claimed login aliases produce zero new writes or receipts', async () => {
  const f = fixture(); await f.run('claim', {rewardId: 'login'});
  const commits = f.commits.length, size = f.docs.size, receipts = [...f.docs.keys()].filter(key => key.startsWith(C.receipts + '/')).length;
  const start = f.calls.length;
  for (let index = 0; index < 10; index++) {
    await assert.rejects(f.run('claim', {rewardId: 'login'}), error =>
      error.message === 'reward_already_claimed' && error.httpStatus === 409);
  }
  assert.equal(f.commits.length, commits); assert.equal(f.docs.size, size);
  assert.equal([...f.docs.keys()].filter(key => key.startsWith(C.receipts + '/')).length, receipts);
  assert.equal(f.calls.slice(start).filter(call => call.route === ':commit').length, 0);
  assert.equal(f.calls.length - start, 60);
  assert.equal(f.calls.slice(start).filter(call => call.route === ':rollback').length, 10);
  assert.equal((await f.run('wallet')).balance, 8);
});
test('concurrent duplicate proof claims award once after transaction conflict retry', async () => {
  const f = fixture(); f.synchronize();
  const results = await Promise.allSettled([f.run('claim', {rewardId: 'login'}), f.run('claim', {rewardId: 'login'})]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'fulfilled').value.delta, 8);
  assert.equal(results.find(result => result.status === 'rejected').reason.message, 'reward_already_claimed');
  assert.equal((await f.run('wallet')).balance, 8);
  assert.ok(f.calls.filter(call => call.route === ':beginTransaction').length >= 4);
});
test('failed commit leaves no partial credit, proof receipt or operation receipt', async () => {
  const f = fixture(); f.fail('FIRESTORE_503');
  await assert.rejects(f.run('claim', {rewardId: 'login'}), /FIRESTORE_503/);
  assert.equal(f.docs.size, 1);
  assert.equal((await f.run('claim', {rewardId: 'login'})).balanceAfter, 8);
});
test('lost commit response recovers from durable operation receipt without repeating the award', async () => {
  const f = fixture(), cmd = f.command('claim', {rewardId: 'login'}); f.loseReply();
  await assert.rejects(f.service().execute(UID, cmd), /FIRESTORE_503/);
  assert.equal((await f.service().execute(UID, cmd)).duplicate, true);
  assert.equal((await f.run('wallet')).balance, 8); assert.equal(f.commits.length, 1);
});
test('purchase debits and grants atomically, preserves replay receipt and never buys owned preset twice', async () => {
  const f = fixture(); f.milestones();
  await f.run('claim', {rewardId: 'tracks-20'});
  const cmd = f.command('purchase', {itemId: 'mint-rally'});
  const result = await f.service().execute(UID, cmd);
  assert.equal(result.balanceAfter, 30); assert.equal(result.delta, -20);
  assert.equal(f.commits.at(-1).writes.length, 3);
  assert.equal((await f.service().execute(UID, cmd)).duplicate, true);
  assert.equal((await f.run('purchase', {itemId: 'mint-rally'})).delta, 0);
  assert.equal((await f.run('wallet')).balance, 30);
});
test('purchase failure cannot debit without granting inventory; insufficient funds never writes', async () => {
  const f = fixture();
  await assert.rejects(f.run('purchase', {itemId: 'mint-rally'}), /insufficient_funds/);
  f.funds(80); f.fail('FIRESTORE_503');
  await assert.rejects(f.run('purchase', {itemId: 'ember-circuit'}), /FIRESTORE_503/);
  assert.equal((await f.run('wallet')).balance, 80);
  assert.equal([...f.docs.keys()].some(key => key.startsWith(C.inventory + '/')), false);
});
test('concurrent purchases cannot overspend the same persisted balance', async () => {
  const f = fixture(); f.funds(80); f.synchronize();
  const results = await Promise.allSettled([f.run('purchase', {itemId: 'mint-rally'}), f.run('purchase', {itemId: 'ember-circuit'})]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.message, 'insufficient_funds');
  assert.ok((await f.run('wallet')).balance >= 0);
});
test('idempotency key reuse across items or operations rejects rather than mutating money', async () => {
  const f = fixture(); f.funds(100);
  const cmd = f.command('purchase', {itemId: 'mint-rally'}); await f.service().execute(UID, cmd);
  await assert.rejects(f.service().execute(UID, {...cmd, itemId: 'ember-circuit'}), /idempotency_key_reused/);
  await assert.rejects(f.service().execute(UID, {op: 'claim', accountId: ACCOUNT, requestId: cmd.requestId, rewardId: 'login'}), /idempotency_key_reused/);
  assert.equal((await f.run('wallet')).balance, 80);
});
test('secure equip accepts only purchased SKU and server recipe, never request-supplied fields', async () => {
  const f = fixture();
  await assert.rejects(f.run('equip', {itemId: 'mint-rally'}), /item_not_owned/);
  f.funds(20); await f.run('purchase', {itemId: 'mint-rally'});
  await assert.rejects(f.run('equip', {itemId: 'mint-rally', carStyle: 'forged'}), /invalid_command/);
  const result = await f.run('equip', {itemId: 'mint-rally'});
  assert.deepEqual(decodeNativeCarStyle(result.carStyle), SHOP_CATALOG[0].style);
  assert.equal((await f.run('wallet')).equipped.carStyle, result.carStyle);
  assert.equal([...f.docs.keys()].some(key => key.startsWith('0.6.2_s1_cosmetic_entitlements/')), false);
});
test('wallet reads do not expose an equipped recipe after its ownership has been revoked', async () => {
  const f = fixture(); f.funds(20); await f.run('purchase', {itemId: 'mint-rally'});
  await f.run('equip', {itemId: 'mint-rally'});
  for (const key of f.docs.keys()) if (key.startsWith(C.inventory + '/')) f.docs.delete(key);
  await assert.rejects(f.run('wallet'), /equipped_item_not_owned/);
  await assert.rejects(f.run('equip', {itemId: 'mint-rally'}), /item_not_owned/);
});
test('equip receipt replay revalidates current inventory owner and catalog version after success', async () => {
  for (const mutation of ['delete', 'owner', 'account', 'catalog-version']) {
    const f = fixture(); f.funds(20); await f.run('purchase', {itemId: 'mint-rally'});
    const cmd = f.command('equip', {itemId: 'mint-rally'});
    await f.service().execute(UID, cmd);
    assert.equal((await f.service().execute(UID, cmd)).duplicate, true);
    const [key, value] = [...f.docs].find(([key]) => key.startsWith(C.inventory + '/'));
    if (mutation === 'delete') f.docs.delete(key);
    else f.put(key, {...value.data, ...(mutation === 'owner' ? {ownerUid: 'other'} :
      mutation === 'account' ? {accountId: 'b'.repeat(64)} : {catalogVersion: 2})});
    const commits = f.commits.length;
    await assert.rejects(f.service().execute(UID, cmd), /item_not_owned/);
    assert.equal(f.commits.length, commits);
  }
});
test('overflow and retry exhaustion fail without partial mutation', async () => {
  const f = fixture(); f.funds(Number.MAX_SAFE_INTEGER);
  await assert.rejects(f.run('claim', {rewardId: 'login'}), /wallet_overflow/);
  assert.equal(f.commits.length, 0);
  const store = createEventFirestoreStore({projectId: 'polytrack-052', pause: async () => {},
    request: async (route, init) => {
      if (route === ':commit') throw Error('FIRESTORE_409');
      return f.request(route, init);
    }});
  f.funds(0);
  await assert.rejects(createCurrencyService({store, now: () => AT}).execute(UID,
    f.command('claim', {rewardId: 'login'})), /FIRESTORE_409/);
  assert.equal(f.commits.length, 0);
});
test('account ownership is read in each transaction, including receipt replay and equip', async () => {
  const f = fixture(), cmd = f.command('claim', {rewardId: 'login'});
  await f.service().execute(UID, cmd);
  await assert.rejects(f.service().execute('other-user', cmd), /profile_not_owned/);
  f.put('0.6.2_profiles_public/' + ACCOUNT, {accountId: ACCOUNT, ownerUid: 'other-user'});
  await assert.rejects(f.service().execute(UID, cmd), /profile_not_owned/);
  await assert.rejects(f.service().execute('other-user', cmd), /wallet_invalid_or_owner_changed/);
});
test('malformed balances, unknown SKUs, clocks and path tricks fail closed', async () => {
  const f = fixture(); f.funds(-1);
  await assert.rejects(f.run('wallet'), /wallet_invalid_or_owner_changed/);
  await assert.rejects(f.run('purchase', {itemId: '__proto__'}), /unknown_item/);
  await assert.rejects(f.run('claim', {rewardId: ['login']}), /unknown_reward/);
  await assert.rejects(f.service().execute(UID, {op: ['wallet'], accountId: ACCOUNT}), /invalid_command/);
  await assert.rejects(f.run('wallet', {accountId: '../wallet'}), /invalid_command/);
  f.setClock(NaN); await assert.rejects(f.run('wallet'), /server_clock_required/);
});
test('disabled HTTP routes make no auth or store calls; gate marker is not a rules deployment', async () => {
  const response = await handleCurrencyRequest(new Request('https://test.invalid/v1/currency/wallet'),
    {env: {}, store: null, authenticate: () => assert.fail('auth must not run'), admit: () => assert.fail('admit must not run')});
  assert.equal(response.status, 503); assert.equal((await response.json()).error, 'currency_disabled');
});
test('sixty OFF handler cases perform zero auth, storage or network operations', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('no network while OFF'));
  const states = [{}, {CURRENCY_ENABLED: 'false'}, {CURRENCY_ENABLED: false}, {CURRENCY_ENABLED: true},
    {CURRENCY_ENABLED: 'true'}, {CURRENCY_ENABLED: 'true', CURRENCY_RULES_VERSION: ''},
    {CURRENCY_ENABLED: 'true', CURRENCY_RULES_VERSION: 'old'}, {CURRENCY_RULES_VERSION},
    {CURRENCY_ENABLED: 'false', CURRENCY_RULES_VERSION},
    {CURRENCY_ENABLED: 'true', CURRENCY_RULES_VERSION, RANKED_WRITES_ENABLED: 'false'}];
  let count = 0;
  for (const env of states) for (const path of ['/v1/currency/wallet', '/v1/shop/catalog',
    '/v1/currency/claim', '/v1/shop/purchase', '/v1/shop/equip', '/v1/shop/unknown']) {
    const response = await handleCurrencyRequest(new Request('https://test.invalid' + path), {env,
      store: {transaction: () => assert.fail('no storage while OFF')},
      authenticate: () => assert.fail('no auth while OFF'), admit: () => assert.fail('no admission while OFF')});
    assert.equal(response.status, 503); assert.equal((await response.json()).error, 'currency_disabled'); count++;
  }
  assert.equal(count, 60);
});
test('HTTP auth, CORS, strict fields and body size are enforced', async () => {
  const f = fixture(), options = {env: {CURRENCY_ENABLED: 'true', CURRENCY_RULES_VERSION}, store: f.store,
    now: () => AT, authenticate: async () => UID, admit: async () => null,
    headers: new Headers({'Access-Control-Allow-Origin': 'https://client.invalid'})};
  const url = 'https://test.invalid/v1/currency/claim';
  const request = body => new Request(url, {method: 'POST', body: JSON.stringify(body)});
  const response = await handleCurrencyRequest(request({accountId: ACCOUNT, requestId: 'request-http', rewardId: 'login'}), options);
  assert.equal(response.status, 200); assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://client.invalid');
  assert.match(response.headers.get('Cache-Control'), /private/);
  const commits = f.commits.length;
  const deniedAlias = await handleCurrencyRequest(request({accountId: ACCOUNT, requestId: 'request-http-alias', rewardId: 'login'}), options);
  assert.equal(deniedAlias.status, 409); assert.equal((await deniedAlias.json()).error, 'reward_already_claimed');
  assert.equal(f.commits.length, commits);
  assert.equal((await handleCurrencyRequest(request({amount: 100}), options)).status, 400);
  assert.equal((await handleCurrencyRequest(request({padding: 'x'.repeat(3000)}), options)).status, 413);
  assert.equal((await handleCurrencyRequest(request({}), {...options, authenticate: async () => {throw Error('bad token');}})).status, 401);
});
test('Worker routes stay disabled and perform zero transport calls with existing capture-only configuration', async () => {
  const response = await handleRequest(new Request('https://test.invalid/v1/currency/wallet?accountId=' + ACCOUNT,
    {headers: {Origin: 'https://client.invalid'}}), {ALLOWED_ORIGINS: 'https://client.invalid', PUBLIC_FIRESTORE_READ_MODE: 'capture-only',
    __TEST_FIRESTORE: () => assert.fail('no DB transport')});
  assert.equal(response.status, 503); assert.equal((await response.json()).error, 'currency_disabled');
});
test('enabled Worker owner route uses authenticated transaction adapter even in capture-only mode', async () => {
  const f = fixture();
  const response = await handleRequest(new Request('https://test.invalid/v1/currency/claim', {method: 'POST',
    headers: {Origin: 'https://client.invalid', 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1'},
    body: JSON.stringify({accountId: ACCOUNT, requestId: 'request-worker', rewardId: 'login'})}), {
    ALLOWED_ORIGINS: 'https://client.invalid', PUBLIC_FIRESTORE_READ_MODE: 'capture-only',
    CURRENCY_ENABLED: 'true', CURRENCY_RULES_VERSION, __TEST_UID: UID, __TEST_FIRESTORE: f.request,
    PB_NOTIFY_RATE_LIMITER: {limit: async () => ({success: true})}, WRITE_IP_RATE_LIMITER: {limit: async () => ({success: true})}
  });
  assert.equal(response.status, 200); assert.equal((await response.json()).delta, 8);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://client.invalid');
  assert.equal(f.commits.length, 1);
});
test('ordinary claim, purchase and equip have small measured transaction read/write bounds', async () => {
  const f = fixture(); let start = f.calls.length;
  await f.run('claim', {rewardId: 'login'});
  assert.equal(f.calls.length - start, 6); assert.equal(f.commits.at(-1).writes.length, 3);
  f.milestones(); start = f.calls.length;
  await f.run('claim', {rewardId: 'tracks-20'});
  assert.equal(f.calls.length - start, 7); assert.equal(f.commits.at(-1).writes.length, 3);
  start = f.calls.length; await f.run('purchase', {itemId: 'mint-rally'});
  assert.equal(f.calls.length - start, 6); assert.equal(f.commits.at(-1).writes.length, 3);
  start = f.calls.length; await f.run('equip', {itemId: 'mint-rally'});
  assert.equal(f.calls.length - start, 7); assert.equal(f.commits.at(-1).writes.length, 2);
});
