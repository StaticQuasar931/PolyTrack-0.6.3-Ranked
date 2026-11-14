import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createCurrencyService, handleCurrencyRequest, CURRENCY_COLLECTIONS as C,
  CURRENCY_RULES_VERSION, SHOP_CATALOG} from '../src/currency-wallet.js';
import {createEventFirestoreStore, eventEncode, eventDecode} from '../src/events-store.js';
import {SERVER_ACHIEVEMENT_CATALOG, SERVER_ACHIEVEMENT_RECOGNIZED_TRACK_COUNT} from '../src/server-achievements.js';
import {encodeNativeCarStyle, decodeNativeCarStyle} from '../src/native-car-style.js';
import {handleRequest} from '../src/index.js';

const ACCOUNT = 'a'.repeat(64), UID = 'test-owner', AT = Date.UTC(2026, 10, 14), DAY = 86400000;
const BASE = 'projects/polytrack-052/databases/(default)/documents/';
const copy = value => structuredClone(value);
// Real REST transaction adapter, in-memory mock transport only. No credentials,
// network, cloud SDK or live DB calls. State survives service reconstruction.
function fixture() {
  const docs = new Map(), snapshots = new Map(), calls = [], commits = [];
  let sequence = 0, clock = AT, failure = '', loseReply = false, barrier = null, beforeCommit = null;
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
      if (beforeCommit) {const hook = beforeCommit; beforeCommit = null; await hook();}
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
  // Quotes model the already displayed wallet, never an extra server GET.
  const quote = itemId => ({catalogVersion: 2, expectedPrice: SHOP_CATALOG.find(item => item.id === itemId)?.price,
    expectedWalletRevision: docs.get(C.wallet + '/' + ACCOUNT)?.data.revision ?? 0});
  const command = (op, extra = {}) => ({op, accountId: ACCOUNT, ...(op === 'wallet' ? {} : {requestId: 'request-' + ++nonce}),
    ...(op === 'purchase' && SHOP_CATALOG.some(item => item.id === extra.itemId) ? quote(extra.itemId) : {}), ...extra});
  return {docs, calls, commits, put, store, service, command, quote, request, setClock: value => {clock = value;},
    beforeCommit(hook) {beforeCommit = hook;},
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
test('profile purchase debits and grants atomically, preserves receipt and never buys owned cosmetic twice', async () => {
  const f=fixture();setMilestones(f,20);await f.run('claim',{rewardId:'milestones'});
  const cmd=f.command('purchase',{itemId:PROFILE_ITEMS[0]}),result=await f.service().execute(UID,cmd);
  assert.equal(result.balanceAfter,80);assert.equal(result.delta,-20);assert.equal(f.commits.at(-1).writes.length,5);
  assert.deepEqual(await f.service().execute(UID,cmd),{...result,duplicate:true});
  await assert.rejects(f.run('purchase',{itemId:PROFILE_ITEMS[0]}),e=>e.httpStatus===409&&e.message==='item_already_owned');
  assert.equal((await f.run('wallet')).balance,80);
});


test('profile purchase failure cannot debit without all grants; insufficient funds never writes',async()=>{
  const f=fixture();await assert.rejects(f.run('purchase',{itemId:PROFILE_ITEMS[0]}),/insufficient_funds/);
  f.funds(80);const before=copy(f.docs);f.fail('FIRESTORE_503');
  await assert.rejects(f.run('purchase',{itemId:PROFILE_ITEMS[1]}),/FIRESTORE_503/);assert.deepEqual(f.docs,before);
  assert.equal((await f.run('wallet')).balance,80);
});


test('concurrent quoted profile purchases reject a stale loser without overspending',async()=>{
  const f=fixture();f.funds(30);f.synchronize();
  const results=await Promise.allSettled(PROFILE_ITEMS.slice(0,2).map(itemId=>f.run('purchase',{itemId})));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.find(r=>r.status==='rejected').reason.message,'quote_stale');
  assert.ok((await f.run('wallet')).balance>=0);assert.equal(f.commits.length,1);
});


test('quoted idempotency key reuse across items or operations rejects without money changes',async()=>{
  const f=fixture();f.funds(100);const cmd=f.command('purchase',{itemId:PROFILE_ITEMS[0]});await f.service().execute(UID,cmd);
  await assert.rejects(f.service().execute(UID,{...cmd,itemId:PROFILE_ITEMS[1]}),/idempotency_key_reused/);
  await assert.rejects(f.run('claim',{requestId:cmd.requestId,rewardId:'login'}),/idempotency_key_reused/);
  assert.equal((await f.run('wallet')).balance,80);
});


test('profile Apply is Studio-only and native equip accepts no client grants or recipe',async()=>{
  const f=fixture();f.funds(20);await f.run('purchase',{itemId:PROFILE_ITEMS[0]});const before=copy(f.docs);
  await assert.rejects(f.run('equip',{itemId:PROFILE_ITEMS[0]}),/profile_apply_via_studio/);
  for(const extra of [{carStyle:'forged'},{grants:[{slot:'badge',value:'betaTester'}]},{equipRevision:1}])
    await assert.rejects(f.run('equip',{itemId:PROFILE_ITEMS[0],...extra}),/invalid_command/);
  assert.deepEqual(f.docs,before);assert.equal((await f.run('wallet')).equipped,null);
});


test('wallet preserves canonical profile ownership after inventory removal and cannot recharge orphaned entitlement',async()=>{
  const f=fixture();f.funds(100);await f.run('purchase',{itemId:PROFILE_ITEMS[0]});
  for(const key of f.docs.keys())if(key.startsWith(C.inventory+'/'))f.docs.delete(key);
  const before=copy(f.docs),wallet=await f.run('wallet');assert.deepEqual(wallet.ownedItemIds,[PROFILE_ITEMS[0]]);assert.equal(wallet.equipped,null);
  await assert.rejects(f.run('purchase',{itemId:PROFILE_ITEMS[0]}),/inventory_entitlement_conflict/);assert.deepEqual(f.docs,before);
});


test('retired equip receipt replay still revalidates inventory owner and catalog after historical success',async()=>{
  for(const mutation of ['delete','owner','account','version']){
    const f=fixture(),legacy=await seedRetiredEquip(f);assert.equal((await f.service().execute(UID,legacy.cmd)).duplicate,true);
    const old=f.docs.get(legacy.inventoryKey).data;
    if(mutation==='delete')f.docs.delete(legacy.inventoryKey);
    else f.put(legacy.inventoryKey,{...old,...(mutation==='owner'?{ownerUid:'other'}:mutation==='account'?{accountId:'b'.repeat(64)}:{catalogVersion:2})});
    const before=copy(f.docs);await assert.rejects(f.service().execute(UID,legacy.cmd),/item_not_owned/);assert.deepEqual(f.docs,before);
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
  await assert.rejects(f.run('purchase', {itemId: '__proto__', catalogVersion: 2, expectedPrice: 20, expectedWalletRevision: 0}), /unknown_item/);
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
test('ordinary login, profile purchase and denied equip have measured bounded costs',async()=>{
  const f=fixture();setMilestones(f,20);let start=f.calls.length;await f.run('claim',{rewardId:'login'});
  assert.equal(f.calls.length-start,6);assert.equal(f.commits.at(-1).writes.length,3);
  start=f.calls.length;await f.run('claim',{rewardId:'tracks-20'});assert.equal(f.calls.length-start,8);
  start=f.calls.length;await f.run('purchase',{itemId:PROFILE_ITEMS[0]});assert.equal(f.calls.length-start,8);assert.equal(f.commits.at(-1).writes.length,5);
  const commits=f.commits.length;start=f.calls.length;await assert.rejects(f.run('equip',{itemId:PROFILE_ITEMS[0]}),/profile_apply_via_studio/);
  assert.equal(f.calls.length-start,5);assert.equal(f.commits.length,commits);
});


test('profile wallet returns complete catalog-v2 inventory with exactly three point lookups',async()=>{
  const f=fixture();f.funds(50);await f.run('purchase',{itemId:PROFILE_ITEMS[0]});await f.run('purchase',{itemId:PROFILE_ITEMS[1]});
  f.put(C.inventory+'/'+'f'.repeat(64),{accountId:ACCOUNT,ownerUid:UID,itemId:'not-in-catalog',catalogVersion:2});
  const start=f.calls.length,commits=f.commits.length,wallet=await f.run('wallet');
  assert.equal(wallet.catalogVersion,2);assert.equal(wallet.inventoryComplete,true);assert.equal(wallet.balance,0);assert.equal(wallet.revision,3);
  assert.deepEqual(wallet.ownedItemIds,PROFILE_ITEMS.slice(0,2));assert.equal(wallet.equipped,null);assert.equal(wallet.equipRevision,0);
  const reads=f.calls.slice(start).filter(c=>c.route.startsWith('/'+C.inventory+'/'));
  assert.equal(reads.length,3);assert.equal(new Set(reads.map(c=>c.route.split('?')[0])).size,3);assert.equal(f.calls.length-start,9);
  assert.equal(f.commits.length,commits);assert.deepEqual((await fixture().run('wallet')).ownedItemIds,[]);
});


test('profile wallet rejects foreign malformed inventory and never reads another account inventory',async()=>{
  for(const change of [{ownerUid:'other'},{accountId:'b'.repeat(64)},{itemId:PROFILE_ITEMS[2]},{catalogVersion:1}]){
    const f=fixture();f.funds(20);await f.run('purchase',{itemId:PROFILE_ITEMS[0]});
    const [key,record]=[...f.docs].find(([key])=>key.startsWith(C.inventory+'/'));f.put(key,{...record.data,...change});
    const before=copy(f.docs);await assert.rejects(f.run('wallet'),/inventory_owner_changed/);assert.deepEqual(f.docs,before);
  }
  const f=fixture();await assert.rejects(f.service().execute('foreign',{op:'wallet',accountId:ACCOUNT}),/profile_not_owned/);
  assert.equal(f.calls.filter(c=>c.route.startsWith('/'+C.inventory+'/')).length,0);
});


test('each profile purchase advances state revision while receipts and Studio-only Apply never regress it',async()=>{
  const f=fixture();f.funds(50);const cmd=f.command('purchase',{itemId:PROFILE_ITEMS[0]}),a=await f.service().execute(UID,cmd);
  assert.equal(a.walletRevision,2);f.setClock(AT-1000);const b=await f.run('purchase',{itemId:PROFILE_ITEMS[1]});assert.equal(b.walletRevision,3);
  assert.deepEqual(await f.service().execute(UID,cmd),{...a,duplicate:true});
  await assert.rejects(f.run('equip',{itemId:PROFILE_ITEMS[1]}),/profile_apply_via_studio/);
  const wallet=await f.run('wallet');assert.equal(wallet.revision,3);assert.equal(wallet.balance,0);assert.equal(wallet.equipRevision,0);assert.equal(wallet.equipped,null);
});


test('ten owned profile purchase and native-equip aliases return 409 with zero writes',async()=>{
  const f=fixture();f.funds(20);const cmd=f.command('purchase',{itemId:PROFILE_ITEMS[0]}),a=await f.service().execute(UID,cmd);
  const before=copy(f.docs),start=f.calls.length;
  for(let i=0;i<10;i++){
    await assert.rejects(f.run('purchase',{itemId:PROFILE_ITEMS[0]}),/item_already_owned/);
    await assert.rejects(f.run('equip',{itemId:PROFILE_ITEMS[0]}),/profile_apply_via_studio/);
  }
  assert.deepEqual(f.docs,before);assert.equal(f.calls.length-start,110);assert.equal(f.commits.length,1);
  assert.deepEqual(await f.service().execute(UID,cmd),{...a,duplicate:true});
});


test('rejected profile equip ID is uncommitted until first valid purchase then permanently receipt-bound',async()=>{
  const f=fixture();f.funds(20);const cmd=f.command('equip',{itemId:PROFILE_ITEMS[0]});
  await assert.rejects(f.service().execute(UID,cmd),/profile_apply_via_studio/);
  const purchase=f.command('purchase',{itemId:PROFILE_ITEMS[0],requestId:cmd.requestId}),a=await f.service().execute(UID,purchase);
  assert.deepEqual(await f.service().execute(UID,purchase),{...a,duplicate:true});
  await assert.rejects(f.service().execute(UID,cmd),/idempotency_key_reused/);assert.equal(f.commits.length,1);
});


test('concurrent different profile native-equip requests cannot mutate wallet or profile',async()=>{
  const f=fixture();f.funds(50);for(const itemId of PROFILE_ITEMS.slice(0,2))await f.run('purchase',{itemId});
  const before=copy(f.docs);f.synchronize();const results=await Promise.allSettled(PROFILE_ITEMS.slice(0,2).map(itemId=>f.run('equip',{itemId})));
  assert.ok(results.every(r=>r.status==='rejected'&&r.reason.message==='profile_apply_via_studio'));assert.deepEqual(f.docs,before);
});


test('concurrent identical profile equip aliases both fail with no receipt or write',async()=>{
  const f=fixture();f.funds(20);await f.run('purchase',{itemId:PROFILE_ITEMS[0]});const before=copy(f.docs);f.synchronize();
  const results=await Promise.allSettled([f.run('equip',{itemId:PROFILE_ITEMS[0]}),f.run('equip',{itemId:PROFILE_ITEMS[0]})]);
  assert.ok(results.every(r=>r.status==='rejected'&&r.reason.message==='profile_apply_via_studio'));assert.deepEqual(f.docs,before);
});


test('lost profile purchase commit response reconciles exact quote without another revision or mutation',async()=>{
  const f=fixture();f.funds(20);const cmd=f.command('purchase',{itemId:PROFILE_ITEMS[0]});f.loseReply();
  await assert.rejects(f.service().execute(UID,cmd),/FIRESTORE_503/);const before=copy(f.docs);
  assert.equal((await f.service().execute(UID,cmd)).duplicate,true);assert.deepEqual(f.docs,before);
  const wallet=await f.run('wallet');assert.equal(wallet.revision,2);assert.equal(wallet.balance,0);assert.equal(f.commits.length,1);
});


test('legacy committed equip receipts remain byte-for-byte and missing revision reads zero without migration writes',async()=>{
  const f=fixture(),legacy=await seedRetiredEquip(f,{revision:null});const before=copy(f.docs);
  assert.deepEqual(await f.service().execute(UID,legacy.cmd),{...legacy.result,duplicate:true});
  const wallet=await f.run('wallet');assert.equal(wallet.equipRevision,0);assert.equal(wallet.equipped,null);
  assert.deepEqual(f.docs,before);assert.equal(f.commits.length,0);
});


test('revision overflow and invalid retired equip metadata never cause partial profile mutation',async()=>{
  const f=fixture();await seedRetiredEquip(f,{revision:1});const key=C.equip+'/'+ACCOUNT,good=copy(f.docs.get(key).data);
  for(const change of [{revision:-1},{revision:'1'},{equippedAt:'bad'},{carStyle:'forged'}]){
    f.put(key,{...good,...change});const before=copy(f.docs);await assert.rejects(f.run('wallet'),/equip_revision_invalid|equipped_recipe_invalid/);assert.deepEqual(f.docs,before);
  }
  f.put(key,good);f.put(C.wallet+'/'+ACCOUNT,{...f.docs.get(C.wallet+'/'+ACCOUNT).data,revision:Number.MAX_SAFE_INTEGER});
  let before=copy(f.docs);await assert.rejects(f.run('claim',{rewardId:'login'}),/wallet_revision_overflow/);assert.deepEqual(f.docs,before);
  f.funds(100);before=copy(f.docs);f.fail('FIRESTORE_503');await assert.rejects(f.run('purchase',{itemId:PROFILE_ITEMS[0]}),/FIRESTORE_503/);assert.deepEqual(f.docs,before);
});


test('bounded profile wallet and no-op paths retain exact document and transport ceilings',async()=>{
  const f=fixture();f.funds(20);let start=f.calls.length;await f.run('wallet');assert.equal(f.calls.length-start,9);
  const cmd=f.command('purchase',{itemId:PROFILE_ITEMS[0]});start=f.calls.length;await f.service().execute(UID,cmd);assert.equal(f.calls.length-start,8);
  start=f.calls.length;await f.service().execute(UID,cmd);assert.equal(f.calls.length-start,5);
  start=f.calls.length;await assert.rejects(f.run('purchase',{itemId:PROFILE_ITEMS[0]}),/item_already_owned/);assert.equal(f.calls.length-start,6);
  start=f.calls.length;await assert.rejects(f.run('equip',{itemId:PROFILE_ITEMS[0]}),/profile_apply_via_studio/);assert.equal(f.calls.length-start,5);
  assert.equal(f.commits.length,1);assert.equal(f.commits[0].writes.length,5);
});


test('same-ID concurrent retired equip recovery reads the same immutable historical receipt without commits',async()=>{
  const f=fixture(),legacy=await seedRetiredEquip(f);const before=copy(f.docs);f.synchronize();
  const results=await Promise.all([f.service().execute(UID,legacy.cmd),f.service().execute(UID,legacy.cmd)]);
  assert.ok(results.every(r=>r.duplicate));assert.deepEqual(results[0],results[1]);assert.deepEqual(f.docs,before);assert.equal(f.commits.length,0);
});


test('profile purchase replay stays historical while fresh wallet reconciles later purchases',async()=>{
  const f=fixture();f.funds(100);const cmd=f.command('purchase',{itemId:PROFILE_ITEMS[0]}),a=await f.service().execute(UID,cmd);
  await f.run('purchase',{itemId:PROFILE_ITEMS[1]});const before=copy(f.docs);
  assert.deepEqual(await f.service().execute(UID,cmd),{...a,duplicate:true});const wallet=await f.run('wallet');
  assert.equal(a.balanceAfter,80);assert.equal(wallet.balance,50);assert.equal(wallet.revision,3);assert.deepEqual(wallet.ownedItemIds,PROFILE_ITEMS.slice(0,2));assert.deepEqual(f.docs,before);
});


test('HTTP quoted profile wallet and no-op 409 responses remain owner-scoped and private',async()=>{
  const f=fixture();f.funds(20);const options={env:{CURRENCY_ENABLED:'true',CURRENCY_RULES_VERSION},store:f.store,now:()=>AT,authenticate:async()=>UID,admit:async()=>null};
  const post=(route,body)=>handleCurrencyRequest(new Request('https://test.invalid'+route,{method:'POST',body:JSON.stringify(body)}),options);
  const cmd=f.command('purchase',{itemId:PROFILE_ITEMS[0]}),{op,...body}=cmd;
  const bought=await post('/v1/shop/purchase',body);assert.equal(bought.status,200);assert.equal((await bought.json()).catalogVersion,2);
  const equip=await post('/v1/shop/equip',{accountId:ACCOUNT,requestId:'http-equip-rejected',itemId:PROFILE_ITEMS[0]});
  assert.equal(equip.status,409);assert.deepEqual(await equip.json(),{error:'profile_apply_via_studio',notCommitted:true});
  const response=await handleCurrencyRequest(new Request('https://test.invalid/v1/currency/wallet?accountId='+ACCOUNT),options),wallet=await response.json();
  assert.equal(response.headers.get('Cache-Control'),'private, no-store');assert.equal(wallet.revision,2);assert.equal(wallet.equipped,null);assert.deepEqual(wallet.ownedItemIds,[PROFILE_ITEMS[0]]);
  const denied=await post('/v1/shop/purchase',{...body,requestId:'http-owned-alias',...f.quote(PROFILE_ITEMS[0])});
  assert.equal(denied.status,409);assert.deepEqual(await denied.json(),{error:'item_already_owned',notCommitted:true});assert.equal(f.commits.length,1);
});


test('legacy equip counter survives claims but missing retired state fails closed without native repair writes',async()=>{
  const f=fixture();await seedRetiredEquip(f,{revision:3});await f.run('claim',{rewardId:'login'});
  assert.equal((await f.run('wallet')).equipRevision,3);f.docs.delete(C.equip+'/'+ACCOUNT);const before=copy(f.docs);
  await assert.rejects(f.run('wallet'),/equipped_state_missing/);await assert.rejects(f.run('equip',{itemId:'ember-circuit'}),/item_retired/);assert.deepEqual(f.docs,before);
});


test('inconsistent retired equip counters still fail closed without migration writes',async()=>{
  const f=fixture();await seedRetiredEquip(f,{revision:1});const key=C.equip+'/'+ACCOUNT;
  f.put(key,{...f.docs.get(key).data,revision:9});const before=copy(f.docs);
  await assert.rejects(f.run('wallet'),/equip_revision_invalid/);assert.deepEqual(f.docs,before);
});


async function seedRetiredEquip(f,{revision=1}={}){
  f.funds(80);const cmd=f.command('equip',{itemId:'mint-rally'}),carStyle=encodeNativeCarStyle({pattern:6,rims:11,exhaust:1,
    primaryHex:0x167d70,secondaryHex:0xeafff7,frameHex:0x171d23,rimsHex:0xc6e6d8});
  const inventoryKey=C.inventory+'/'+await keyFor([ACCOUNT,'mint-rally']);
  f.put(inventoryKey,{accountId:ACCOUNT,ownerUid:UID,itemId:'mint-rally',catalogVersion:1});
  const result={op:'equip',accountId:ACCOUNT,itemId:'mint-rally',carStyle,balanceAfter:80,walletRevision:2};
  f.put(C.receipts+'/'+await keyFor([UID,ACCOUNT,cmd.requestId]),{accountId:ACCOUNT,ownerUid:UID,
    fingerprint:JSON.stringify(['equip',ACCOUNT,null,'mint-rally']),result,createdAt:AT});
  f.put(C.equip+'/'+ACCOUNT,{accountId:ACCOUNT,ownerUid:UID,itemId:'mint-rally',catalogVersion:1,carStyle,equippedAt:AT,
    ...(revision===null?{}:{revision})});
  if(revision!==null)f.put(C.wallet+'/'+ACCOUNT,{...f.docs.get(C.wallet+'/'+ACCOUNT).data,equipRevision:revision});
  return{cmd,result,inventoryKey};
}

const PROFILE_ITEMS = ['profile-pitlane-ticket', 'profile-apex-observatory', 'profile-vector-ribbon'];
const ENT = '0.6.2_s1_cosmetic_entitlements/' + ACCOUNT, META = '0.6.2_s1_release_meta/current';
async function keyFor(parts) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parts))))]
    .map(value => value.toString(16).padStart(2, '0')).join('');
}
function setMilestones(f, count) {
  const bytes = new Uint8Array(12);
  for (let i = 0; i < count; i++) bytes[Math.floor(i / 8)] |= 1 << (i % 8);
  const old = f.docs.get(ENT)?.data || {};
  f.put(ENT, {...old, serverIssued: {...old.serverIssued, achievements: {version: 1,
    catalog: SERVER_ACHIEVEMENT_CATALOG, casual: {count, ledger: [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')}}}});
}

test('profile shop: append-only nine-item v2 catalog retains original three grants and prices', () => {
  assert.deepEqual(SHOP_CATALOG.slice(0, 3).map(item => [item.id, item.kind, item.price, item.grants]), [
    [PROFILE_ITEMS[0], 'profile-cosmetic', 20, [{slot: 'plate', value: 'pitlane-ticket'}]],
    [PROFILE_ITEMS[1], 'profile-cosmetic', 30, [{slot: 'stage', value: 'apex-observatory'}]],
    [PROFILE_ITEMS[2], 'profile-cosmetic', 50, [{slot: 'stripe', value: 'vector-ribbon'}]]]);
  assert.equal(SHOP_CATALOG.length, 9);
  assert.ok(SHOP_CATALOG.every(item => !('style' in item) && Object.isFrozen(item) && Object.isFrozen(item.grants[0])));
});

test('profile shop: all eligible milestones bank once in one three-write transaction', async () => {
  const f = fixture(); setMilestones(f, 20);
  const cmd = f.command('claim', {rewardId: 'milestones'}), outcome = await f.service().execute(UID, cmd);
  assert.equal(outcome.delta, 100); assert.equal(outcome.balanceAfter, 100);
  assert.deepEqual(outcome.claimedRewardIds, ['tracks-1', 'tracks-5', 'tracks-20']);
  assert.equal(f.commits.length, 1); assert.equal(f.commits[0].writes.length, 3);
  for (const rewardId of ['milestones', 'tracks-1', 'tracks-5', 'tracks-20'])
    await assert.rejects(f.run('claim', {rewardId}), /reward_already_claimed/);
  f.setClock(AT + DAY * 10);
  assert.deepEqual(await f.service().execute(UID, cmd), {...outcome, duplicate: true});
  assert.equal((await f.run('wallet')).balance, 100); assert.equal(f.commits.length, 1);
});

test('profile shop: progressive batches preserve committed receipts and never award old grants twice', async () => {
  const f = fixture(); setMilestones(f, 1);
  const first = f.command('claim', {rewardId: 'milestones'}), a = await f.service().execute(UID, first);
  assert.equal(a.delta, 20);
  setMilestones(f, 5); assert.equal((await f.run('claim', {rewardId: 'tracks-5'})).delta, 30);
  await assert.rejects(f.run('claim', {rewardId: 'milestones'}), /reward_already_claimed/);
  setMilestones(f, 20); const b = await f.run('claim', {rewardId: 'milestones'});
  assert.equal(b.delta, 50); assert.deepEqual(b.claimedRewardIds, ['tracks-20']);
  assert.equal((await f.run('wallet')).balance, 100);
  assert.deepEqual(await f.service().execute(UID, first), {...a, duplicate: true});
  assert.equal(f.commits.length, 3); assert.ok(f.commits.every(commit => commit.writes.length === 3));
});

test('profile shop: legacy individual claims then combined claim award only remaining points', async () => {
  const f = fixture(); setMilestones(f, 20);
  await f.run('claim', {rewardId: 'tracks-1'});
  const result = await f.run('claim', {rewardId: 'milestones'});
  assert.equal(result.delta, 80); assert.deepEqual(result.claimedRewardIds, ['tracks-5', 'tracks-20']);
  assert.equal((await f.run('wallet')).balance, 100);
});

test('profile shop: concurrent combined and individual claims cannot double award', async () => {
  for (const rewardId of ['milestones', 'tracks-1', 'tracks-5', 'tracks-20']) {
    const f = fixture(); setMilestones(f, 20); f.synchronize();
    const results = await Promise.allSettled([f.run('claim', {rewardId: 'milestones'}), f.run('claim', {rewardId})]);
    assert.ok(results.some(r => r.status === 'fulfilled'));
    assert.equal((await f.run('wallet')).balance, 100);
    assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.message === 'reward_already_claimed'));
  }
});

test('profile shop: no proof or inflated ledger and client claim fields cannot mint points', async () => {
  const f = fixture(); await assert.rejects(f.run('claim', {rewardId: 'milestones'}), /server_milestone_required/);
  setMilestones(f, 0); await assert.rejects(f.run('claim', {rewardId: 'milestones'}), /server_milestone_required/);
  setMilestones(f, 20);
  for (const extra of [{count: 89}, {amount: 999}, {grants: []}, {rewardIds: ['login']}])
    await assert.rejects(f.run('claim', {rewardId: 'milestones', ...extra}), /invalid_command/);
  const old = f.docs.get(ENT).data; f.put(ENT, {...old, serverIssued: {...old.serverIssued,
    achievements: {...old.serverIssued.achievements, casual: {count: 20, ledger: '1f'}}}});
  await assert.rejects(f.run('claim', {rewardId: 'milestones'}), /server_milestone_required/);
  assert.equal(f.commits.length, 0);
});

test('profile shop: lost batch response retries exact receipt, with no extra grant or write', async () => {
  const f = fixture(); setMilestones(f, 20); const cmd = f.command('claim', {rewardId: 'milestones'});
  f.loseReply(); await assert.rejects(f.service().execute(UID, cmd), /FIRESTORE_503/);
  assert.equal((await f.service().execute(UID, cmd)).delta, 100);
  assert.equal((await f.run('wallet')).balance, 100); assert.equal(f.commits.length, 1);
  const before = copy(f.docs);
  for (let i = 0; i < 10; i++) await assert.rejects(f.run('claim', {rewardId: 'milestones'}), /reward_already_claimed/);
  assert.deepEqual(f.docs, before);
});

test('profile shop: purchase atomically debits inventory entitlement receipt and cache, preserving earned proof', async () => {
  const f = fixture(); setMilestones(f, 20); await f.run('claim', {rewardId: 'milestones'});
  const proof = copy(f.docs.get(ENT).data.serverIssued);
  f.put(ENT, {...f.docs.get(ENT).data, plate: ['block', 'earned-plate'], stage: ['garage'], stripe: ['standard']});
  f.put(META, {entitlementEpoch: 7, dirty: false, other: 'preserved'});
  const cmd = f.command('purchase', {itemId: PROFILE_ITEMS[0]}), outcome = await f.service().execute(UID, cmd);
  assert.equal(outcome.balanceAfter, 80); assert.equal(outcome.delta, -20);
  assert.equal(outcome.itemKind, 'profile-cosmetic'); assert.equal(outcome.catalogVersion, 2);
  assert.equal('carStyle' in outcome, false); assert.equal(f.commits.at(-1).writes.length, 5);
  const entitlement = f.docs.get(ENT).data;
  assert.deepEqual(entitlement.serverIssued, proof);
  assert.deepEqual(entitlement.plate, ['block', 'earned-plate', 'pitlane-ticket']);
  assert.equal(entitlement.purchased.accountId, ACCOUNT); assert.equal(entitlement.purchased.ownerUid, UID);
  assert.deepEqual(entitlement.purchased.items[PROFILE_ITEMS[0]], {catalogVersion: 2, acquiredAt: AT});
  assert.equal(f.docs.get(META).data.entitlementEpoch, 8); assert.equal(f.docs.get(META).data.dirty, true);
  assert.equal(f.docs.get(META).data.other, 'preserved');
  const before = copy(f.docs); assert.deepEqual(await f.service().execute(UID, cmd), {...outcome, duplicate: true});
  assert.deepEqual(f.docs, before);
});

test('profile shop: all three original cosmetics can be purchased with exactly the milestone bank', async () => {
  const f = fixture(); setMilestones(f, 20); await f.run('claim', {rewardId: 'milestones'});
  for (const itemId of PROFILE_ITEMS) await f.run('purchase', {itemId});
  const wallet = await f.run('wallet'); assert.equal(wallet.balance, 0); assert.equal(wallet.revision, 4);
  assert.equal(wallet.catalogVersion, 2); assert.deepEqual(wallet.ownedItemIds, PROFILE_ITEMS);
  assert.equal(wallet.inventoryComplete, true); assert.equal(wallet.equipped, null); assert.equal(wallet.equipRevision, 0);
  assert.equal(f.docs.get(ENT).data.purchased.items[PROFILE_ITEMS[2]].catalogVersion, 2);
});

test('profile shop: concurrent different purchases preserve both entitlements and cache epochs', async () => {
  const f = fixture(); f.funds(50); f.synchronize();
  const racing = await Promise.allSettled(PROFILE_ITEMS.slice(0, 2).map(itemId => f.run('purchase', {itemId})));
  assert.equal(racing.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(racing.find(r => r.status === 'rejected').reason.message, 'quote_stale');
  const remaining = PROFILE_ITEMS.slice(0, 2).find(itemId => !Object.hasOwn(f.docs.get(ENT).data.purchased.items, itemId));
  await f.run('purchase', {itemId: remaining});
  const wallet = await f.run('wallet'); assert.equal(wallet.balance, 0);
  assert.deepEqual(wallet.ownedItemIds, PROFILE_ITEMS.slice(0, 2));
  assert.deepEqual(Object.keys(f.docs.get(ENT).data.purchased.items).sort(), PROFILE_ITEMS.slice(0, 2).sort());
  assert.equal(f.docs.get(META).data.entitlementEpoch, 2);
});

test('profile shop: same-ID concurrent purchase and insufficient-funds race commit only once', async () => {
  const f = fixture(); f.funds(20); f.synchronize(); const cmd = f.command('purchase', {itemId: PROFILE_ITEMS[0]});
  const results = await Promise.all([f.service().execute(UID, cmd), f.service().execute(UID, cmd)]);
  assert.deepEqual(results.map(r => r.duplicate).sort(), [false, true]); assert.equal(f.commits.length, 1);
  const g = fixture(); g.funds(30); g.synchronize();
  const racing = await Promise.allSettled(PROFILE_ITEMS.slice(0, 2).map(itemId => g.run('purchase', {itemId})));
  assert.equal(racing.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(racing.find(r => r.status === 'rejected').reason.message, 'quote_stale');
  assert.equal(g.commits.length, 1); assert.ok((await g.run('wallet')).balance >= 0);
});

test('profile shop: failed purchase changes nothing and lost commit reply recovers historical outcome only', async () => {
  const f = fixture(); f.funds(100); const before = copy(f.docs); f.fail('FIRESTORE_503');
  await assert.rejects(f.run('purchase', {itemId: PROFILE_ITEMS[0]}), /FIRESTORE_503/); assert.deepEqual(f.docs, before);
  const cmd = f.command('purchase', {itemId: PROFILE_ITEMS[0]}); f.loseReply();
  await assert.rejects(f.service().execute(UID, cmd), /FIRESTORE_503/);
  await f.run('purchase', {itemId: PROFILE_ITEMS[1]});
  const replay = await f.service().execute(UID, cmd); assert.equal(replay.balanceAfter, 80); assert.equal(replay.outcomeOnly, true);
  assert.equal((await f.run('wallet')).balance, 50); assert.equal(f.commits.length, 2);
});

test('profile shop: no-op purchases and profile equip aliases write zero documents', async () => {
  const f = fixture(); f.funds(20); await f.run('purchase', {itemId: PROFILE_ITEMS[0]}); const before = copy(f.docs);
  for (let i = 0; i < 10; i++) {
    await assert.rejects(f.run('purchase', {itemId: PROFILE_ITEMS[0]}), e => e.httpStatus === 409 && e.message === 'item_already_owned');
    await assert.rejects(f.run('equip', {itemId: PROFILE_ITEMS[0]}), e => e.httpStatus === 409 && e.message === 'profile_apply_via_studio');
  }
  assert.deepEqual(f.docs, before); assert.equal(f.commits.length, 1);
});

test('profile shop: client grants prices balances and protected badge fields are rejected before reads', async () => {
  const f = fixture(); f.funds(100);
  for (const extra of [{grants: [{slot: 'badge', value: 'betaTester'}]}, {price: 0}, {balance: 999}, {kind: 'native-preset'},
    {profileGrant: {plate: 'forged'}}, {extraQuote: 1}, {carStyle: 'forged'}]) {
    const calls = f.calls.length;
    await assert.rejects(f.run('purchase', {itemId: PROFILE_ITEMS[0], ...extra}), /invalid_command/);
    assert.equal(f.calls.length, calls);
  }
  assert.equal(f.commits.length, 0);
});

test('profile shop: foreign provenance and bad cache epoch fail closed without partial debit', async () => {
  for (const invalid of ['owner', 'account', 'unknown', 'version', 'time', 'epoch']) {
    const f = fixture(); f.funds(100); await f.run('purchase', {itemId: PROFILE_ITEMS[0]});
    if (invalid === 'epoch') f.put(META, {entitlementEpoch: Number.MAX_SAFE_INTEGER});
    else {
      const doc = copy(f.docs.get(ENT).data);
      if (invalid === 'owner') doc.purchased.ownerUid = 'foreign';
      if (invalid === 'account') doc.purchased.accountId = 'b'.repeat(64);
      if (invalid === 'unknown') doc.purchased.items.forged = {catalogVersion: 2, acquiredAt: AT};
      if (invalid === 'version') doc.purchased.items[PROFILE_ITEMS[0]].catalogVersion = 1;
      if (invalid === 'time') doc.purchased.items[PROFILE_ITEMS[0]].acquiredAt = -1;
      f.put(ENT, doc);
    }
    const before = copy(f.docs);
    await assert.rejects(f.run('purchase', {itemId: PROFILE_ITEMS[1]}), /PURCHASED_COSMETIC_ENTITLEMENT_INVALID|OVERALL_ENTITLEMENT_EPOCH_INVALID/);
    assert.deepEqual(f.docs, before);
  }
});

test('profile shop: exactly three inventory point reads and foreign records fail closed', async () => {
  const f = fixture(); f.funds(100); await f.run('purchase', {itemId: PROFILE_ITEMS[0]}); const start = f.calls.length;
  const wallet = await f.run('wallet'); assert.deepEqual(wallet.ownedItemIds, [PROFILE_ITEMS[0]]);
  assert.equal(f.calls.slice(start).filter(c => c.route.startsWith('/' + C.inventory + '/')).length, 3);
  const [key, record] = [...f.docs].find(([key]) => key.startsWith(C.inventory + '/'));
  for (const change of [{ownerUid: 'other'}, {accountId: 'b'.repeat(64)}, {catalogVersion: 1}, {kind: 'native-preset'}, {itemId: PROFILE_ITEMS[1]}]) {
    f.put(key, {...record.data, ...change}); const before = copy(f.docs);
    await assert.rejects(f.run('wallet'), /inventory_owner_changed/); assert.deepEqual(f.docs, before);
  }
});

test('profile shop: explicit version-2 HTTP contract supports claim purchase and private wallet', async () => {
  const f = fixture(); setMilestones(f, 20);
  const options = {env: {CURRENCY_ENABLED: 'true', CURRENCY_RULES_VERSION}, store: f.store,
    now: () => AT, authenticate: async () => UID, admit: async () => null};
  const get = path => handleCurrencyRequest(new Request('https://test.invalid' + path), options);
  const post = (path, body) => handleCurrencyRequest(new Request('https://test.invalid' + path,
    {method: 'POST', body: JSON.stringify({accountId: ACCOUNT, ...body})}), options);
  const catalog = await (await get('/v1/shop/catalog')).json(); assert.equal(catalog.version, 2);
  assert.equal(catalog.kind, 'profile-cosmetic'); assert.deepEqual(catalog.items, SHOP_CATALOG);
  const claim = await post('/v1/currency/claim', {requestId: 'http-all-milestones', rewardId: 'milestones'});
  assert.equal(claim.status, 200); assert.equal((await claim.json()).delta, 100);
  const purchase = await post('/v1/shop/purchase', {requestId: 'http-profile-purchase', itemId: PROFILE_ITEMS[0], ...f.quote(PROFILE_ITEMS[0])});
  assert.equal(purchase.status, 200); assert.equal((await purchase.json()).itemKind, 'profile-cosmetic');
  const response = await get('/v1/currency/wallet?accountId=' + ACCOUNT), wallet = await response.json();
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store'); assert.equal(wallet.catalogVersion, 2);
  assert.equal(wallet.balance, 80); assert.equal(wallet.equipped, null); assert.equal(wallet.equipRevision, 0);
  const equip = await post('/v1/shop/equip', {requestId: 'http-no-native-equip', itemId: PROFILE_ITEMS[0]});
  assert.equal(equip.status, 409); assert.deepEqual(await equip.json(), {error: 'profile_apply_via_studio', notCommitted: true});
});

test('profile shop: measured document costs bound claims purchases replays and no-effect paths', async () => {
  async function measure(f, fn, expected) {
    const c = f.calls.length, n = f.commits.length; await fn(); const calls = f.calls.slice(c);
    assert.deepEqual({reads: calls.filter(c => c.route.includes('?transaction=')).length,
      writes: f.commits.slice(n).reduce((n, commit) => n + commit.writes.length, 0), transport: calls.length}, expected);
  }
  const f = fixture(); setMilestones(f, 20);
  await measure(f, () => f.run('wallet'), {reads: 7, writes: 0, transport: 9});
  await measure(f, () => f.run('claim', {rewardId: 'login'}), {reads: 4, writes: 3, transport: 6});
  const claim = f.command('claim', {rewardId: 'milestones'});
  await measure(f, () => f.service().execute(UID, claim), {reads: 8, writes: 3, transport: 10});
  await measure(f, () => f.service().execute(UID, claim), {reads: 3, writes: 0, transport: 5});
  await measure(f, () => assert.rejects(f.run('claim', {rewardId: 'milestones'}), /reward_already_claimed/), {reads: 8, writes: 0, transport: 10});
  const purchase = f.command('purchase', {itemId: PROFILE_ITEMS[0]});
  await measure(f, () => f.service().execute(UID, purchase), {reads: 6, writes: 5, transport: 8});
  await measure(f, () => f.service().execute(UID, purchase), {reads: 3, writes: 0, transport: 5});
  await measure(f, () => assert.rejects(f.run('purchase', {itemId: PROFILE_ITEMS[0]}), /item_already_owned/), {reads: 4, writes: 0, transport: 6});
  await measure(f, () => assert.rejects(f.run('equip', {itemId: PROFILE_ITEMS[0]}), /profile_apply_via_studio/), {reads: 3, writes: 0, transport: 5});
});

test('profile shop: retired stock recipes cannot be newly purchased or equipped', async () => {
  const f = fixture(); f.funds(1000); const before = copy(f.docs);
  for (const itemId of ['mint-rally', 'ember-circuit', 'ice-apex']) for (const op of ['purchase', 'equip'])
    await assert.rejects(f.run(op, {itemId}), e => e.httpStatus === 409 && e.message === 'item_retired');
  assert.deepEqual(f.docs, before);
});

test('profile shop: retired successful purchase receipts stay immutable and never grant a profile item', async () => {
  const f = fixture(); f.funds(80); const cmd = f.command('purchase', {itemId: 'mint-rally'});
  const key = await keyFor([UID, ACCOUNT, cmd.requestId]);
  const result = {op: 'purchase', accountId: ACCOUNT, itemId: 'mint-rally', delta: -20,
    balanceAfter: 80, walletRevision: 1, carStyle: 'historical-native-string'};
  f.put(C.receipts + '/' + key, {accountId: ACCOUNT, ownerUid: UID,
    fingerprint: JSON.stringify(['purchase', ACCOUNT, null, 'mint-rally']), result, createdAt: AT});
  const before = copy(f.docs); f.setClock(AT + DAY * 30);
  assert.deepEqual(await f.service().execute(UID, cmd), {...result, duplicate: true}); assert.deepEqual(f.docs, before);
  await assert.rejects(f.service().execute(UID, {...cmd, itemId: PROFILE_ITEMS[0], ...f.quote(PROFILE_ITEMS[0])}), /idempotency_key_reused/);
  assert.deepEqual((await f.run('wallet')).ownedItemIds, []); assert.equal(f.commits.length, 0);
});

test('profile shop: retired equip replay validates historical inventory without exposing native recipes in wallet', async () => {
  const recipe = {pattern: 6, rims: 11, exhaust: 1, primaryHex: 0x167d70, secondaryHex: 0xeafff7,
    frameHex: 0x171d23, rimsHex: 0xc6e6d8};
  for (const mutation of ['none', 'delete', 'owner', 'account', 'version', 'recipe']) {
    const f = fixture(); f.funds(80);
    const cmd = f.command('equip', {itemId: 'mint-rally'}), result = {op: 'equip', accountId: ACCOUNT,
      itemId: 'mint-rally', carStyle: encodeNativeCarStyle(recipe), balanceAfter: 80, walletRevision: 3};
    const inventoryKey = C.inventory + '/' + await keyFor([ACCOUNT, 'mint-rally']);
    f.put(inventoryKey, {accountId: ACCOUNT, ownerUid: UID, itemId: 'mint-rally', catalogVersion: 1});
    const receiptKey = C.receipts + '/' + await keyFor([UID, ACCOUNT, cmd.requestId]);
    f.put(receiptKey, {accountId: ACCOUNT, ownerUid: UID, fingerprint: JSON.stringify(['equip', ACCOUNT, null, 'mint-rally']),
      result: mutation === 'recipe' ? {...result, carStyle: 'forged'} : result, createdAt: AT});
    f.put(C.equip + '/' + ACCOUNT, {accountId: ACCOUNT, ownerUid: UID, itemId: 'mint-rally',
      catalogVersion: 1, carStyle: result.carStyle, equippedAt: AT});
    if (mutation === 'delete') f.docs.delete(inventoryKey);
    if (mutation === 'owner') f.put(inventoryKey, {...f.docs.get(inventoryKey).data, ownerUid: 'foreign'});
    if (mutation === 'account') f.put(inventoryKey, {...f.docs.get(inventoryKey).data, accountId: 'b'.repeat(64)});
    if (mutation === 'version') f.put(inventoryKey, {...f.docs.get(inventoryKey).data, catalogVersion: 2});
    const before = copy(f.docs);
    if (mutation === 'none') assert.deepEqual(await f.service().execute(UID, cmd), {...result, duplicate: true});
    else await assert.rejects(f.service().execute(UID, cmd), /item_not_owned|equipped_recipe_invalid/);
    const start = f.calls.length, wallet = await f.run('wallet');
    assert.equal(wallet.equipped, null); assert.equal(wallet.equipRevision, 0); assert.deepEqual(wallet.ownedItemIds, []);
    assert.equal(f.calls.slice(start).filter(c => c.route.startsWith('/' + C.inventory + '/')).length, 3);
    assert.deepEqual(f.docs, before); assert.equal(f.commits.length, 0);
  }
});

test('profile shop: orphaned purchased entitlement cannot be charged twice after inventory removal', async () => {
  const f = fixture(); f.funds(100); await f.run('purchase', {itemId: PROFILE_ITEMS[0]});
  for (const key of f.docs.keys()) if (key.startsWith(C.inventory + '/')) f.docs.delete(key);
  const before = copy(f.docs);
  await assert.rejects(f.run('purchase', {itemId: PROFILE_ITEMS[0]}), /inventory_entitlement_conflict/);
  assert.deepEqual(f.docs, before); assert.equal((await f.run('wallet')).balance, 80);
});

test('profile shop: malformed aggregate grants or changed account ownership never grant points', async () => {
  for (const mutation of ['owner', 'account', 'duplicate', 'unknown', 'delta']) {
    const f = fixture(); setMilestones(f, 20); await f.run('claim', {rewardId: 'milestones'});
    const key = C.grants + '/' + await keyFor([ACCOUNT, 'milestones', 'lifetime']);
    const grant = copy(f.docs.get(key).data);
    if (mutation === 'owner') grant.ownerUid = 'foreign';
    if (mutation === 'account') grant.accountId = 'b'.repeat(64);
    if (mutation === 'duplicate') grant.claimedRewardIds = ['tracks-1', 'tracks-1'];
    if (mutation === 'unknown') grant.claimedRewardIds = ['tracks-89'];
    if (mutation === 'delta') grant.delta = 999;
    f.put(key, grant); const before = copy(f.docs);
    for (const rewardId of ['milestones', 'tracks-1'])
      await assert.rejects(f.run('claim', {rewardId}), /grant_owner_changed|grant_invalid/);
    assert.deepEqual(f.docs, before);
  }
  const f = fixture(); setMilestones(f, 20); const cmd = f.command('claim', {rewardId: 'milestones'});
  await f.service().execute(UID, cmd); f.put('0.6.2_profiles_public/' + ACCOUNT, {accountId: ACCOUNT, ownerUid: 'foreign'});
  const before = copy(f.docs); await assert.rejects(f.service().execute(UID, cmd), /profile_not_owned/);
  assert.deepEqual(f.docs, before);
});

test('profile shop: rejected no-op batch ID may first succeed after genuine new eligibility, then stays immutable', async () => {
  const f = fixture(); setMilestones(f, 1); await f.run('claim', {rewardId: 'milestones'});
  const cmd = f.command('claim', {rewardId: 'milestones'});
  await assert.rejects(f.service().execute(UID, cmd), /reward_already_claimed/);
  setMilestones(f, 5); const a = await f.service().execute(UID, cmd); assert.equal(a.delta, 30);
  setMilestones(f, 20); f.setClock(AT + DAY * 4);
  assert.deepEqual(await f.service().execute(UID, cmd), {...a, duplicate: true});
  assert.equal((await f.run('wallet')).balance, 50);
  assert.equal((await f.run('claim', {rewardId: 'milestones'})).delta, 50);
  assert.equal((await f.run('wallet')).balance, 100);
});

test('quoted purchase: version price and revision mismatch reject with zero writes and no inventory reads', async () => {
  for (const change of [{catalogVersion: 1}, {catalogVersion: 3}, {expectedPrice: 0}, {expectedPrice: 21},
    {expectedWalletRevision: 0}, {expectedWalletRevision: 2}]) {
    const f = fixture(); f.funds(100); const before = copy(f.docs), start = f.calls.length;
    await assert.rejects(f.run('purchase', {itemId: PROFILE_ITEMS[0], ...change}),
      e => e.message === 'quote_stale' && e.httpStatus === 409 && e.notCommitted === true);
    assert.deepEqual(f.docs, before); assert.equal(f.commits.length, 0);
    assert.equal(f.calls.length - start, 5);
    assert.equal(f.calls.slice(start).filter(c => c.route.includes('?transaction=')).length, 3);
    assert.equal(f.calls.slice(start).filter(c => c.route.startsWith('/' + C.inventory + '/')).length, 0);
  }
});

test('quoted purchase: malformed quote and unquoted profile command fail before any storage', async () => {
  const f = fixture(); f.funds(100); const start = f.calls.length;
  await assert.rejects(f.service().execute(UID, {op: 'purchase', accountId: ACCOUNT,
    requestId: 'unquoted-profile-buy', itemId: PROFILE_ITEMS[0]}), /invalid_command/);
  for (const change of [{expectedPrice: '20'}, {expectedPrice: -1}, {expectedWalletRevision: 1.5},
    {expectedWalletRevision: Number.MAX_SAFE_INTEGER + 1}, {catalogVersion: '2'}, {catalogVersion: null}])
    await assert.rejects(f.run('purchase', {itemId: PROFILE_ITEMS[0], ...change}), /invalid_quote/);
  assert.equal(f.calls.length, start); assert.equal(f.commits.length, 0);
});

test('quoted purchase: exact receipt replay precedes current revision and price comparison', async () => {
  const f = fixture(); f.funds(100); const cmd = f.command('purchase', {itemId: PROFILE_ITEMS[0]});
  const original = await f.service().execute(UID, cmd);
  await f.run('claim', {rewardId: 'login'}); await f.run('purchase', {itemId: PROFILE_ITEMS[1]});
  const before = copy(f.docs), start = f.calls.length;
  assert.deepEqual(await f.service().execute(UID, cmd), {...original, duplicate: true});
  assert.equal(f.calls.length - start, 5); assert.deepEqual(f.docs, before);
  assert.equal((await f.run('wallet')).balance, 58); assert.equal(original.balanceAfter, 80);
  for (const change of [{catalogVersion: 1}, {expectedPrice: 21}, {expectedWalletRevision: 4}, {itemId: PROFILE_ITEMS[1]}])
    await assert.rejects(f.service().execute(UID, {...cmd, ...change}), /idempotency_key_reused/);
  assert.deepEqual(f.docs, before);
});

test('quoted purchase: losing concurrent displayed quote is never automatically repriced or charged', async () => {
  const f = fixture(); f.funds(100); const cmd = f.command('purchase', {itemId: PROFILE_ITEMS[0]});
  await f.run('claim', {rewardId: 'login'}); const before = copy(f.docs);
  await assert.rejects(f.service().execute(UID, cmd), /quote_stale/); assert.deepEqual(f.docs, before);
  const revised = f.command('purchase', {itemId: PROFILE_ITEMS[0]});
  assert.equal((await f.service().execute(UID, revised)).balanceAfter, 88);
  assert.notEqual(cmd.requestId, revised.requestId);
});

test('quoted purchase: HTTP known precommit denial has marker; lost committed response never does', async () => {
  const f = fixture(); f.funds(100);
  const options = {env: {CURRENCY_ENABLED: 'true', CURRENCY_RULES_VERSION}, store: f.store,
    now: () => AT, authenticate: async () => UID, admit: async () => null};
  const post = cmd => {const {op, ...body} = cmd; return handleCurrencyRequest(new Request('https://test.invalid/v1/shop/purchase',
    {method: 'POST', body: JSON.stringify(body)}), options);};
  const cmd = f.command('purchase', {itemId: PROFILE_ITEMS[0]});
  let response = await post({...cmd, expectedPrice: 19}); assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {error: 'quote_stale', notCommitted: true});
  assert.equal(f.commits.length, 0);
  f.loseReply(); response = await post(cmd); assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {error: 'currency_unavailable'});
  assert.equal(f.commits.length, 1); assert.equal((await f.run('wallet')).balance, 80);
  response = await post(cmd); assert.equal(response.status, 200); const outcome = await response.json();
  assert.equal(outcome.duplicate, true); assert.equal('notCommitted' in outcome, false); assert.equal(f.commits.length, 1);
  response = await post(f.command('purchase', {itemId: PROFILE_ITEMS[0]}));
  assert.equal(response.status, 409); assert.deepEqual(await response.json(), {error: 'item_already_owned', notCommitted: true});
});

test('quoted purchase: precommit transport failure and untrusted typed commit error have no rejection certificate', async () => {
  const f = fixture(); f.funds(100); f.fail('FIRESTORE_503');
  const options = {env: {CURRENCY_ENABLED: 'true', CURRENCY_RULES_VERSION}, store: f.store,
    now: () => AT, authenticate: async () => UID, admit: async () => null};
  const cmd = f.command('purchase', {itemId: PROFILE_ITEMS[0]}), {op, ...body} = cmd;
  const request = () => new Request('https://test.invalid/v1/shop/purchase', {method: 'POST', body: JSON.stringify(body)});
  let response = await handleCurrencyRequest(request(), options);
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), {error: 'currency_unavailable'});
  assert.equal(f.commits.length, 0);
  const {CurrencyError} = await import('../src/currency-wallet.js');
  response = await handleCurrencyRequest(request(), {...options,
    store: {transaction: async () => {throw new CurrencyError('untrusted_store_error', 409);}}});
  assert.equal(response.status, 409); assert.deepEqual(await response.json(), {error: 'untrusted_store_error'});
});

test('quoted purchase: complete click is six POST reads plus seven completion reads, never a preflight GET', async () => {
  const f = fixture(); f.funds(100); const cmd = f.command('purchase', {itemId: PROFILE_ITEMS[0]});
  const start = f.calls.length, commits = f.commits.length;
  const outcome = await f.service().execute(UID, cmd);
  const wallet = await f.run('wallet'); assert.equal(outcome.balanceAfter, 80); assert.equal(wallet.balance, 80);
  const calls = f.calls.slice(start);
  assert.equal(calls.filter(c => c.route.includes('?transaction=')).length, 13);
  assert.equal(calls.length, 17);
  assert.equal(f.commits.slice(commits).reduce((n, commit) => n + commit.writes.length, 0), 5);
});

test('profile shop: entitlement and cache CAS retry preserves concurrent earned changes and commits exactly one debit', async () => {
  const f = fixture(); f.funds(100);
  f.put(ENT, {plate: ['block'], stage: ['garage'], stripe: ['standard'], serverIssued: {sentinel: 'preserved'}});
  f.put(META, {entitlementEpoch: 2, other: 'original'});
  const cmd = f.command('purchase', {itemId: PROFILE_ITEMS[0]});
  f.beforeCommit(() => {
    f.put(ENT, {...f.docs.get(ENT).data, plate: ['block', 'earned-during-purchase']});
    f.put(META, {entitlementEpoch: 5, other: 'concurrent-change'});
  });
  const result = await f.service().execute(UID, cmd);
  assert.equal(result.balanceAfter, 80); assert.equal(result.walletRevision, 2);
  assert.deepEqual(f.docs.get(ENT).data.plate, ['block', 'earned-during-purchase', 'pitlane-ticket']);
  assert.deepEqual(f.docs.get(ENT).data.serverIssued, {sentinel: 'preserved'});
  assert.equal(f.docs.get(META).data.entitlementEpoch, 6); assert.equal(f.docs.get(META).data.other, 'concurrent-change');
  assert.equal(f.calls.filter(c => c.route === ':commit').length, 2); assert.equal(f.commits.length, 1);
  assert.equal(f.commits[0].writes.length, 5);
  assert.equal([...f.docs.keys()].filter(key => key.startsWith(C.receipts + '/')).length, 1);
});

test('actual Worker profile shop: server milestone claim, login, all three purchases and canonical wallet use offline transport only', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('external network forbidden'));
  const f = fixture(); setMilestones(f, 20);
  const env = {ALLOWED_ORIGINS: 'https://client.invalid', PUBLIC_FIRESTORE_READ_MODE: 'capture-only',
    CURRENCY_ENABLED: 'true', CURRENCY_RULES_VERSION, __TEST_UID: UID, __TEST_FIRESTORE: f.request,
    PB_NOTIFY_RATE_LIMITER: {limit: async () => ({success: true})}, WRITE_IP_RATE_LIMITER: {limit: async () => ({success: true})}};
  const invoke = (route, body) => handleRequest(new Request('https://test.invalid' + route,
    {method: body ? 'POST' : 'GET', headers: {Origin: 'https://client.invalid', 'Content-Type': 'application/json',
      'CF-Connecting-IP': '192.0.2.1'}, ...(body ? {body: JSON.stringify(body)} : {})}), env);
  let response = await invoke('/v1/currency/claim', {accountId: ACCOUNT, requestId: 'worker-all-milestones', rewardId: 'milestones'});
  assert.equal(response.status, 200); const claim = await response.json(); assert.equal(claim.delta, 100);
  assert.deepEqual(claim.claimedRewardIds, ['tracks-1', 'tracks-5', 'tracks-20']);
  response = await invoke('/v1/currency/claim', {accountId: ACCOUNT, requestId: 'worker-daily-login', rewardId: 'login'});
  assert.equal(response.status, 200); assert.equal((await response.json()).delta, 8);
  for (const itemId of PROFILE_ITEMS) {
    const {op, ...body} = f.command('purchase', {itemId}); response = await invoke('/v1/shop/purchase', body);
    assert.equal(response.status, 200); const outcome = await response.json();
    assert.equal(outcome.itemKind, 'profile-cosmetic'); assert.equal(outcome.catalogVersion, 2); assert.equal('carStyle' in outcome, false);
    response = await invoke('/v1/currency/wallet?accountId=' + ACCOUNT); assert.equal(response.status, 200);
    assert.equal((await response.json()).balance, outcome.balanceAfter);
  }
  response = await invoke('/v1/currency/wallet?accountId=' + ACCOUNT); const wallet = await response.json();
  assert.equal(wallet.balance, 8); assert.equal(wallet.revision, 5); assert.deepEqual(wallet.ownedItemIds, PROFILE_ITEMS);
  assert.equal(wallet.equipped, null); assert.equal(f.docs.get(META).data.entitlementEpoch, 3);
  for (const item of SHOP_CATALOG.slice(0, 3)) assert.ok(f.docs.get(ENT).data[item.grants[0].slot].includes(item.grants[0].value));
  assert.deepEqual(f.commits.map(commit => commit.writes.length), [3, 3, 5, 5, 5]);
});

test('login-only definite 409 exposes already-read server UTC clock with no extra reads or writes', async () => {
  const f = fixture(); const original = f.command('claim', {rewardId: 'login'});
  await f.service().execute(UID, original);
  let clock = AT + DAY - 1;
  const options = {env: {CURRENCY_ENABLED: 'true', CURRENCY_RULES_VERSION}, store: f.store,
    now: () => clock, authenticate: async () => UID, admit: async () => null};
  const post = requestId => handleCurrencyRequest(new Request('https://test.invalid/v1/currency/claim',
    {method: 'POST', body: JSON.stringify({accountId: ACCOUNT, requestId, rewardId: 'login'})}), options);
  const calls = f.calls.length, before = copy(f.docs);
  const rejected = await post('login-clock-alias'); assert.equal(rejected.status, 409);
  assert.deepEqual(await rejected.json(), {error: 'reward_already_claimed', notCommitted: true,
    claimDay: Math.floor(AT / DAY), serverNow: clock, dayEndsAt: AT + DAY});
  assert.deepEqual(f.docs, before); assert.equal(f.calls.length - calls, 6);
  assert.equal(f.calls.slice(calls).filter(call => call.route.includes('?transaction=')).length, 4);
  const replay = await post(original.requestId); assert.equal(replay.status, 200);
  const receipt = await replay.json(); assert.equal(receipt.duplicate, true);
  for (const key of ['claimDay', 'serverNow', 'dayEndsAt']) assert.equal(key in receipt, false, 'historical receipt is not current availability');
  clock = AT + DAY; const next = await post('login-clock-next-day'); assert.equal(next.status, 200);
  assert.equal((await next.json()).delta, 8); assert.equal((await f.run('wallet')).balance, 16);
});

test('milestone rejection, unavailable backend and OFF never imply a login day marker', async () => {
  const f = fixture(); setMilestones(f, 20); await f.run('claim', {rewardId: 'milestones'});
  const options = {env: {CURRENCY_ENABLED: 'true', CURRENCY_RULES_VERSION}, store: f.store,
    now: () => AT, authenticate: async () => UID, admit: async () => null};
  const request = () => new Request('https://test.invalid/v1/currency/claim', {method: 'POST',
    body: JSON.stringify({accountId: ACCOUNT, requestId: 'milestone-clock-denial', rewardId: 'milestones'})});
  let response = await handleCurrencyRequest(request(), options); assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {error: 'reward_already_claimed', notCommitted: true});
  response = await handleCurrencyRequest(request(), {...options, store: {transaction: async () => {throw Error('FIRESTORE_503');}}});
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), {error: 'currency_unavailable'});
  response = await handleCurrencyRequest(request(), {...options, env: {}, authenticate: () => assert.fail('OFF must not authenticate')});
  assert.deepEqual(await response.json(), {error: 'currency_disabled'});
});

test('optional login clock omits unrepresentable next midnight without changing the rejection or balance', async () => {
  const f = fixture(), clock = Number.MAX_SAFE_INTEGER; f.setClock(clock);
  await f.run('claim', {rewardId: 'login'}); const before = copy(f.docs);
  const response = await handleCurrencyRequest(new Request('https://test.invalid/v1/currency/claim', {method: 'POST',
    body: JSON.stringify({accountId: ACCOUNT, requestId: 'far-clock-alias', rewardId: 'login'})}),
    {env: {CURRENCY_ENABLED: 'true', CURRENCY_RULES_VERSION}, store: f.store, now: () => clock,
      authenticate: async () => UID, admit: async () => null});
  assert.equal(response.status, 409); assert.deepEqual(await response.json(), {error: 'reward_already_claimed', notCommitted: true});
  assert.deepEqual(f.docs, before);
});

test('staged Worker config enables only the reviewed private currency contract and preserves shared rate/write gates', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('staging validation never contacts cloud services'));
  const config = JSON.parse(fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.vars.CURRENCY_ENABLED, 'true'); assert.equal(config.vars.CURRENCY_RULES_VERSION, CURRENCY_RULES_VERSION);
  assert.equal(config.vars.RANKED_WRITES_ENABLED, 'true'); assert.equal(config.vars.PUBLIC_FIRESTORE_READ_MODE, 'capture-only');
  assert.equal(config.vars.WRITE_IP_RATE_LIMIT_REQUIRED, 'true');
  assert.deepEqual(config.ratelimits.find(item => item.name === 'PB_NOTIFY_RATE_LIMITER').simple, {limit: 12, period: 60});
  assert.deepEqual(config.ratelimits.find(item => item.name === 'WRITE_IP_RATE_LIMITER').simple, {limit: 600, period: 60});
  const f = fixture(), admissions = [], env = {...config.vars, __TEST_UID: UID, __TEST_FIRESTORE: f.request,
    PB_NOTIFY_RATE_LIMITER: {limit: async input => {admissions.push(['uid', input.key]); return {success: true};}},
    WRITE_IP_RATE_LIMITER: {limit: async input => {admissions.push(['ip', input.key]); return {success: true};}}};
  const request = () => new Request('https://test.invalid/v1/shop/catalog', {headers: {
    Origin: 'https://staticquasar931.github.io', 'X-PolyTrack-Revision': '321', 'CF-Connecting-IP': '192.0.2.1'}});
  const catalog = await handleRequest(request(), env); assert.equal(catalog.status, 200);
  assert.equal((await catalog.json()).version, 2); assert.deepEqual(admissions, [['ip', 'ranked-write:192.0.2.1'], ['uid', UID]]);
  assert.equal(f.calls.length, 0, 'static catalog authentication/admission needs no document access');
  for (const change of [{CURRENCY_ENABLED: 'false'}, {CURRENCY_RULES_VERSION: 'unreviewed'}, {RANKED_WRITES_ENABLED: 'false'}]) {
    const response = await handleRequest(request(), {...env, ...change,
      __TEST_FIRESTORE: () => assert.fail('disabled config must not access DB'),
      WRITE_IP_RATE_LIMITER: {limit: () => assert.fail('disabled config must not admit')},
      PB_NOTIFY_RATE_LIMITER: {limit: () => assert.fail('disabled config must not admit')}});
    assert.equal(response.status, 503); assert.equal((await response.json()).error, 'currency_disabled');
  }
  for (const limiter of ['PB_NOTIFY_RATE_LIMITER', 'WRITE_IP_RATE_LIMITER']) {
    const response = await handleRequest(request(), {...env, [limiter]: undefined});
    assert.equal(response.status, 503); assert.equal(f.calls.length, 0, 'missing admission binding fails before document access');
  }
});


test('fresh login HTTP clock uses captured time after commit at unchanged four-read three-write cost', async () => {
  const f = fixture(), clock = AT + DAY - 1;
  let clockCalls = 0, committed = false;
  const options = {env: {CURRENCY_ENABLED: 'true', CURRENCY_RULES_VERSION},
    store: {transaction: async fn => {const result = await f.store.transaction(fn); committed = true; return result;}},
    now: () => {clockCalls++; return clock;}, authenticate: async () => UID, admit: async () => null};
  const response = await handleCurrencyRequest(new Request('https://test.invalid/v1/currency/claim',
    {method: 'POST', body: JSON.stringify({accountId: ACCOUNT, requestId: 'fresh-login-clock', rewardId: 'login'})}), options);
  assert.equal(committed, true); assert.equal(response.status, 200); assert.equal(clockCalls, 1);
  const result = await response.json();
  const receipt = [...f.docs.entries()].find(([key]) => key.startsWith(C.receipts + '/'))[1].data;
  assert.deepEqual(result, {...receipt.result, duplicate: false,
    claimDay: Math.floor(AT / DAY), serverNow: clock, dayEndsAt: AT + DAY});
  assert.equal(result.delta, 8); assert.equal(result.balanceAfter, 8); assert.equal(result.walletRevision, 1);
  assert.equal(f.calls.filter(call => call.route.includes('?transaction=')).length, 4);
  assert.equal(f.calls.length, 6); assert.equal(f.commits.length, 1); assert.equal(f.commits[0].writes.length, 3);
  for (const {data} of f.docs.values()) for (const key of ['claimDay', 'serverNow', 'dayEndsAt'])
    assert.equal(Object.hasOwn(data, key), false, 'clock metadata is not stored');
  const direct = fixture(); const directResult = await direct.run('claim', {rewardId: 'login'});
  const directReceipt = [...direct.docs.entries()].find(([key]) => key.startsWith(C.receipts + '/'))[1].data;
  assert.deepEqual(directResult, {...directReceipt.result, duplicate: false}, 'execute unit return shape is unchanged');
});

test('fresh login UTC boundary emits only its captured day while old receipt replay has no clock', async () => {
  const f = fixture(); let clock = AT + DAY - 1;
  const options = {env: {CURRENCY_ENABLED: 'true', CURRENCY_RULES_VERSION}, store: f.store,
    now: () => clock, authenticate: async () => UID, admit: async () => null};
  const post = requestId => handleCurrencyRequest(new Request('https://test.invalid/v1/currency/claim',
    {method: 'POST', body: JSON.stringify({accountId: ACCOUNT, requestId, rewardId: 'login'})}), options);
  f.beforeCommit(() => {clock = AT + DAY;});
  let response = await post('fresh-boundary-before'); let result = await response.json();
  assert.equal(response.status, 200); assert.equal(result.serverNow, AT + DAY - 1);
  assert.equal(result.claimDay, Math.floor(AT / DAY)); assert.equal(result.dayEndsAt, AT + DAY);
  response = await post('fresh-boundary-after'); result = await response.json();
  assert.equal(response.status, 200); assert.equal(result.serverNow, AT + DAY);
  assert.equal(result.claimDay, Math.floor(AT / DAY) + 1); assert.equal(result.dayEndsAt, AT + DAY * 2);
  assert.equal(result.balanceAfter, 16);
  for (const requestId of ['fresh-boundary-before', 'fresh-boundary-after']) {
    const before = copy(f.docs), calls = f.calls.length;
    response = await post(requestId); result = await response.json();
    assert.equal(response.status, 200); assert.equal(result.duplicate, true);
    for (const key of ['claimDay', 'serverNow', 'dayEndsAt']) assert.equal(key in result, false);
    assert.deepEqual(f.docs, before); assert.equal(f.calls.length - calls, 5);
  }
});

test('successful milestones and unrepresentable fresh login midnight omit optional day clock', async () => {
  for (const rewardId of ['tracks-1', 'tracks-5', 'tracks-20', 'milestones', 'login']) {
    const f = fixture(); setMilestones(f, 20);
    const response = await handleCurrencyRequest(new Request('https://test.invalid/v1/currency/claim',
      {method: 'POST', body: JSON.stringify({accountId: ACCOUNT, requestId: 'clock-exclude-' + rewardId, rewardId})}),
      {env: {CURRENCY_ENABLED: 'true', CURRENCY_RULES_VERSION}, store: f.store,
        now: () => rewardId === 'login' ? Number.MAX_SAFE_INTEGER : AT,
        authenticate: async () => UID, admit: async () => null});
    assert.equal(response.status, 200); const result = await response.json(); assert.equal(result.duplicate, false);
    for (const key of ['claimDay', 'serverNow', 'dayEndsAt']) assert.equal(key in result, false);
  }
});

test('failed or ambiguous fresh login commit never exposes successful clock metadata', async () => {
  for (const lostReply of [false, true]) {
    const f = fixture(); if (lostReply) f.loseReply(); else f.fail('FIRESTORE_503');
    const options = {env: {CURRENCY_ENABLED: 'true', CURRENCY_RULES_VERSION}, store: f.store,
      now: () => AT, authenticate: async () => UID, admit: async () => null};
    const post = () => handleCurrencyRequest(new Request('https://test.invalid/v1/currency/claim',
      {method: 'POST', body: JSON.stringify({accountId: ACCOUNT, requestId: 'clock-commit-failure', rewardId: 'login'})}), options);
    const response = await post(); assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {error: 'currency_unavailable'});
    assert.equal(f.commits.length, lostReply ? 1 : 0);
    if (lostReply) {
      const recovery = await post(); assert.equal(recovery.status, 200);
      const result = await recovery.json(); assert.equal(result.duplicate, true);
      for (const key of ['claimDay', 'serverNow', 'dayEndsAt']) assert.equal(key in result, false);
      assert.equal(f.commits.length, 1);
    }
  }
});


test('constant wallet inventory unions canonical and original compatibility ownership without writes', async () => {
  for (const mode of ['empty', 'canonical', 'compatibility', 'both', 'union', 'allowance-only']) {
    const f = fixture();
    if (['canonical', 'both', 'union'].includes(mode)) f.put(ENT, {purchased: {version: 1, accountId: ACCOUNT,
      ownerUid: UID, items: {[PROFILE_ITEMS[0]]: {catalogVersion: 2, acquiredAt: AT}}}});
    if (['compatibility', 'both', 'union'].includes(mode)) {
      const id = mode === 'union' ? PROFILE_ITEMS[1] : PROFILE_ITEMS[0];
      f.put(C.inventory + '/' + await keyFor([ACCOUNT, id]), {accountId: ACCOUNT, ownerUid: UID,
        itemId: id, kind: 'profile-cosmetic', catalogVersion: 2, purchasedAt: AT});
    }
    if (mode === 'allowance-only') f.put(ENT, {plate: ['pitlane-ticket'], badge: ['community']});
    const before = copy(f.docs), start = f.calls.length, wallet = await f.run('wallet');
    assert.deepEqual(wallet.ownedItemIds, mode === 'union' ? PROFILE_ITEMS.slice(0, 2) :
      ['empty', 'allowance-only'].includes(mode) ? [] : [PROFILE_ITEMS[0]]);
    assert.equal(wallet.inventoryComplete, true); assert.equal(wallet.catalogVersion, 2);
    const calls = f.calls.slice(start), reads = calls.filter(c => c.route.includes('?transaction='));
    assert.equal(reads.length, 7); assert.equal(calls.length, 9);
    assert.equal(reads.filter(c => c.route.startsWith('/0.6.2_s1_cosmetic_entitlements/')).length, 1);
    assert.deepEqual(reads.filter(c => c.route.startsWith('/' + C.inventory + '/')).map(c => c.route.split('?')[0]).sort(),
      (await Promise.all(PROFILE_ITEMS.map(async id => '/' + C.inventory + '/' + await keyFor([ACCOUNT, id])))).sort());
    assert.equal(f.commits.length, 0); assert.deepEqual(f.docs, before);
  }
});

test('wallet fails closed on malformed canonical purchases even with valid fallback inventory', async () => {
  for (const mutation of ['owner', 'account', 'version', 'catalog', 'time', 'unknown', 'empty', 'null', 'extra']) {
    const f = fixture(); f.funds(100); await f.run('purchase', {itemId: PROFILE_ITEMS[0]});
    const prior = copy(f.docs.get(ENT).data), purchased = prior.purchased;
    if (mutation === 'owner') purchased.ownerUid = 'foreign';
    if (mutation === 'account') purchased.accountId = 'b'.repeat(64);
    if (mutation === 'version') purchased.version = 2;
    if (mutation === 'catalog') purchased.items[PROFILE_ITEMS[0]].catalogVersion = 1;
    if (mutation === 'time') purchased.items[PROFILE_ITEMS[0]].acquiredAt = -1;
    if (mutation === 'unknown') purchased.items.forged = {catalogVersion: 2, acquiredAt: AT};
    if (mutation === 'empty') purchased.items = {};
    if (mutation === 'null') prior.purchased = null;
    if (mutation === 'extra') purchased.grants = ['all'];
    f.put(ENT, prior); const before = copy(f.docs), commits = f.commits.length;
    await assert.rejects(f.run('wallet'), /PURCHASED_COSMETIC_ENTITLEMENT_INVALID/);
    assert.deepEqual(f.docs, before); assert.equal(f.commits.length, commits);
  }
});

test('wallet rejects conflicting canonical and inventory acquisition provenance', async () => {
  const f = fixture(); f.funds(100); await f.run('purchase', {itemId: PROFILE_ITEMS[0]});
  const key = C.inventory + '/' + await keyFor([ACCOUNT, PROFILE_ITEMS[0]]);
  f.put(key, {...f.docs.get(key).data, purchasedAt: AT + 1}); const before = copy(f.docs);
  await assert.rejects(f.run('wallet'), /inventory_entitlement_conflict/);
  assert.deepEqual(f.docs, before); assert.equal(f.commits.length, 1);
});

// In-memory module variants exercise future catalog sizes without editing shared catalog/art files.
function syntheticModule(file, overrides = {}) {
  const url = new URL(file, import.meta.url);
  const source = fs.readFileSync(url, 'utf8').replace(/from '([^']+)'/g, (match, spec) =>
    "from '" + (overrides[spec] || new URL(spec, url).href) + "'");
  return 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
}
async function syntheticCatalogService(count, version = 2, transform = items => items) {
  const items = transform([...SHOP_CATALOG, ...Array.from({length: Math.max(0, count - SHOP_CATALOG.length)}, (_, i) =>
    ({id: 'synthetic-profile-' + i, label: 'Synthetic ' + i, price: 20, kind: 'profile-cosmetic',
      grants: [{slot: 'plate', value: 'synthetic-' + i}]}))].slice(0, count));
  const catalog = 'data:text/javascript;base64,' + Buffer.from('export const PROFILE_SHOP_CATALOG_VERSION=' + version +
    ';export const PROFILE_SHOP_CATALOG=' + JSON.stringify(items) + ';').toString('base64');
  const helper = syntheticModule('../src/purchased-cosmetic-entitlements.js', {'../../../tools/profile-shop-catalog.mjs': catalog});
  const module = await import(syntheticModule('../src/currency-wallet.js', {
    '../../../tools/profile-shop-catalog.mjs': catalog, './purchased-cosmetic-entitlements.js': helper}));
  return {items, create: module.createCurrencyService};
}

for (const count of [3, 9, 32]) test('synthetic catalog size ' + count + ' retains exactly seven reads and three original hashes', async () => {
  const {items, create} = await syntheticCatalogService(count), f = fixture(), last = items.at(-1);
  f.put(ENT, {purchased: {version: 1, accountId: ACCOUNT, ownerUid: UID,
    items: {[last.id]: {catalogVersion: 2, acquiredAt: AT}}}});
  const before = copy(f.docs), wallet = await create({store: f.store, now: () => AT}).execute(UID, {op: 'wallet', accountId: ACCOUNT});
  assert.deepEqual(wallet.ownedItemIds, [last.id]); assert.equal(wallet.inventoryComplete, true);
  assert.equal(f.calls.filter(c => c.route.includes('?transaction=')).length, 7);
  assert.deepEqual(f.calls.filter(c => c.route.startsWith('/' + C.inventory + '/')).map(c => c.route.split('?')[0]).sort(),
    (await Promise.all(PROFILE_ITEMS.map(async id => '/' + C.inventory + '/' + await keyFor([ACCOUNT, id])))).sort());
  assert.equal(f.calls.length, 9); assert.equal(f.commits.length, 0); assert.deepEqual(f.docs, before);
});

test('catalog bound version and original compatibility identities fail closed before storage', async () => {
  for (const [count, version, transform] of [[2, 2], [33, 2], [3, 3], [3, 2, items => items.map((item, i) =>
    i === 0 ? {...item, id: 'missing-original'} : item)], [4, 2, items => [...items.slice(0, 3), items[0]]]]) {
    const {create} = await syntheticCatalogService(count, version, transform), f = fixture();
    assert.throws(() => create({store: f.store}), /inventory_catalog_limit/); assert.equal(f.calls.length, 0);
  }
});


test('actual nine-item catalog buys all slots atomically and retains constant seven-read ownership', async () => {
 const f=fixture(),total=SHOP_CATALOG.reduce((sum,item)=>sum+item.price,0);assert.equal(total,273);f.funds(total);
 const bought=[];
 for(const item of SHOP_CATALOG){
  const cmd=f.command('purchase',{itemId:item.id}),start=f.calls.length,commits=f.commits.length;
  const outcome=await f.service().execute(UID,cmd);bought.push(item.id);
  assert.equal(outcome.catalogVersion,2);assert.equal(outcome.delta,-item.price);
  assert.equal(f.calls.slice(start).filter(call=>call.route.includes('?transaction=')).length,6);
  assert.equal(f.commits.length-commits,1);assert.equal(f.commits.at(-1).writes.length,5);
  const before=copy(f.docs),readStart=f.calls.length,wallet=await f.run('wallet');
  assert.deepEqual(wallet.ownedItemIds,bought);assert.equal(wallet.inventoryComplete,true);
  assert.equal(f.calls.slice(readStart).filter(call=>call.route.includes('?transaction=')).length,7);
  assert.equal(f.calls.slice(readStart).filter(call=>call.route.startsWith('/'+C.inventory+'/')).length,3);
  assert.deepEqual(f.docs,before);
  const replayStart=f.calls.length,replay=await f.service().execute(UID,cmd);
  assert.deepEqual(replay,{...outcome,duplicate:true});assert.deepEqual(f.docs,before);
  assert.equal(f.calls.slice(replayStart).filter(call=>call.route.includes('?transaction=')).length,3);
 }
 assert.equal((await f.run('wallet')).balance,0);assert.equal(f.commits.length,9);
 for(const item of SHOP_CATALOG){const {slot,value}=item.grants[0];assert.ok(f.docs.get(ENT).data[slot].includes(value));}
 const provenance=copy(f.docs.get(ENT).data.purchased);
 for(const item of SHOP_CATALOG.slice(3))f.docs.delete(C.inventory+'/'+await keyFor([ACCOUNT,item.id]));
 assert.deepEqual((await f.run('wallet')).ownedItemIds,SHOP_CATALOG.map(item=>item.id));
 assert.deepEqual(f.docs.get(ENT).data.purchased,provenance);
});

for(const slot of ['badge','title','emblem','serverIssued','purchased','community','__proto__','unknown'])
 test('purchase helper rejects unapproved catalog grant slot '+slot+' without any debit',async()=>{
  const {create}=await syntheticCatalogService(9,2,items=>items.map((item,i)=>i===3?
   {...item,grants:[{slot,value:'forged'}]}:item));
  const f=fixture();f.funds(100);const before=copy(f.docs);
  await assert.rejects(create({store:f.store,now:()=>AT}).execute(UID,f.command('purchase',{itemId:'profile-petrol'})),
   /PURCHASED_COSMETIC_ENTITLEMENT_INVALID/);
  assert.deepEqual(f.docs,before);assert.equal(f.commits.length,0);
 });
