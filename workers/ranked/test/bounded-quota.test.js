import test from 'node:test';
import assert from 'node:assert/strict';
import {handleRequest, rebuildOverall} from '../src/index.js';
import {eventEncode, eventDecode} from '../src/events-store.js';
import {preparePublicationPages, publicationManifestId, PUBLIC_MANIFEST_COLLECTION, PUBLIC_PAGE_COLLECTION} from '../src/paged-publication.js';

const origin = 'https://staticquasar931.github.io';
const tags = '0.6.2_s1_group_tags';
const overall = '0.6.2_s1_leaderboards_overall';
const meta = '0.6.2_s1_release_meta/current';
const account = 'quota-racer';
const modern = {plannerPublicationVersion:999, plannerBundleVersion:999, cosmeticEntitlementVersion:999,
  averagePlacementVersion:999, derivedMetricsVersion:999, builtRevision:12};

function fixture() {
  const docs = new Map(), versions = new Map(), reads = [], writes = [];
  let conflicts = 0, commitAttempts = 0;
  const wire = key => docs.has(key) ? {fields:eventEncode(docs.get(key)).mapValue.fields,
    updateTime:'v' + (versions.get(key) || 1)} : null;
  const env = {ALLOWED_ORIGINS:origin, PB_NOTIFY_RATE_LIMITER: {limit: async () => ({success:true})}, __TEST_UID:'owner', __TEST_FIRESTORE:async (path, init = {}) => {
    if (path === ':commit') {
      commitAttempts++;
      const batch = JSON.parse(init.body).writes;
      if (conflicts > 0 && batch.some(write => write.update.name.includes('/' + tags + '/'))) {
        conflicts--; throw Error('FIRESTORE_412');
      }
      for (const write of batch) {
        const key = write.update.name.split('/documents/')[1];
        if (write.currentDocument) assert.deepEqual(write.currentDocument,
          docs.has(key) ? {updateTime:wire(key).updateTime} : {exists:false});
      }
      return {writeResults:batch.map(write => {
        const key = write.update.name.split('/documents/')[1];
        docs.set(key, eventDecode({mapValue:{fields:write.update.fields}}));
        versions.set(key, (versions.get(key) || 1) + 1);
        writes.push(key);
        return {updateTime:wire(key).updateTime};
      })};
    }
    assert.equal(init.method || 'GET', 'GET', 'unexpected mutation or query');
    reads.push(decodeURIComponent(path.slice(1)));
    return wire(reads.at(-1));
  }};
  const request = (path, body, source = origin) => new Request('https://quota.example' + path, {
    method:body === undefined ? 'GET' : 'POST',
    headers:{Origin:source, ...(body === undefined ? {} : {'Content-Type':'application/json'})},
    ...(body === undefined ? {} : {body:JSON.stringify(body)})
  });
  const fills = [], context = {waitUntil:p => fills.push(p)};
  return {env, docs, reads, writes, request, context,
    get commitAttempts() {return commitAttempts;},
    conflictOnce() {conflicts = 1;},
    async flush() {await Promise.all(fills.splice(0));},
    async save(groupCode) {return handleRequest(request('/v1/profile/group-code', {accountId:account, groupCode}), env, context);}};
}

async function groupFixture(code = '123456') {
  const f = fixture();
  f.docs.set('0.6.2_profiles_public/' + account, {accountId:account, ownerUid:'owner'});
  f.docs.set(tags + '/account_' + account, {accountId:account, groupCode:code, updatedAt:17});
  f.docs.set(tags + '/current', {accounts:code ? {[account]:{groupCode:code, updatedAt:17}} : {}, updatedAt:17});
  const entries = Array.from({length:201}, (_, i) => ({userId:i === 200 ? account : 'r' + i,
    rank:i + 1, ...(i === 200 && code ? {groupCode:code, groupCodeUpdatedAt:17} : {})}));
  const pages = await preparePublicationPages('overall', 'main', entries, {sourceRevision:7, sourceComplete:true});
  for (const doc of pages.documents) f.docs.set(doc.collection + '/' + doc.id, doc.data);
  f.docs.set(PUBLIC_MANIFEST_COLLECTION + '/' + publicationManifestId('overall', 'main', pages.pagination.generation), pages.pagination);
  f.docs.set(overall + '/main', {entries:entries.slice(0,200), pagination:pages.pagination, sourceRevision:7, sourceComplete:true});
  return f;
}

for (const code of ['123456', '']) test('unchanged paged group-code save is three reads, zero writes: ' + JSON.stringify(code), async () => {
  const f = await groupFixture(code), before = structuredClone(f.docs);
  for (let i = 0; i < 12; i++) {
    const response = await f.save(code);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {groupCode:code});
  }
  assert.equal(f.reads.length, 36);
  assert.equal(f.commitAttempts, 0);
  assert.deepEqual(f.docs, before, 'timestamps, pages and generations remain unchanged');
  assert.equal(f.reads.some(key => key.startsWith(overall) || key.startsWith(PUBLIC_PAGE_COLLECTION)), false);
});

for (const damage of ['directory', 'tag', 'missing-directory', 'missing-tag']) test('same-code save repairs ' + damage + ' instead of skipping', async () => {
  const f = await groupFixture();
  if (damage === 'directory') f.docs.get(tags + '/current').accounts[account].groupCode = '654321';
  if (damage === 'tag') f.docs.get(tags + '/account_' + account).groupCode = '654321';
  if (damage === 'missing-directory') f.docs.delete(tags + '/current');
  if (damage === 'missing-tag') f.docs.delete(tags + '/account_' + account);
  assert.equal((await f.save('123456')).status, 200);
  assert.equal(f.writes.length, 7, 'three pages, manifest, root, two tags');
  assert.equal(f.reads.length, 7, 'owner, two tags, root, three pages');
  assert.equal(f.docs.get(tags + '/current').accounts[account].groupCode, '123456');
  const written = f.writes.length, read = f.reads.length;
  assert.equal((await f.save('123456')).status, 200);
  assert.equal(f.writes.length, written);
  assert.equal(f.reads.length - read, 3);
});

test('real clear republishes beyond the legacy prefix, retains CAS retries and then becomes a no-op', async () => {
  const f = await groupFixture();
  f.conflictOnce();
  assert.equal((await f.save('')).status, 200);
  assert.equal(f.commitAttempts, 4, 'guarded final commit conflicts once; staging and final commit retry');
  const root = f.docs.get(overall + '/main');
  const last = f.docs.get(PUBLIC_PAGE_COLLECTION + '/overall_main_' + root.pagination.generation + '_2').entries[0];
  assert.equal(last.userId, account);
  assert.equal(last.rank, 201);
  assert.equal(last.groupCode, undefined);
  assert.equal(f.docs.get(tags + '/current').accounts[account], undefined);
  const count = f.writes.length;
  assert.equal((await f.save('')).status, 200);
  assert.equal(f.writes.length, count);
});

test('no-op optimization does not bypass ownership, authentication or write admission', async () => {
  const f = await groupFixture();
  f.docs.get('0.6.2_profiles_public/' + account).ownerUid = 'someone-else';
  assert.equal((await f.save('123456')).status, 403);
  assert.equal(f.reads.length, 1);
  delete f.env.__TEST_UID;
  assert.equal((await f.save('123456')).status, 401);
  assert.equal(f.reads.length, 1);
  f.env.__TEST_UID = 'owner';
  f.env.RANKED_WRITES_ENABLED = 'false';
  assert.equal((await f.save('123456')).status, 503);
  assert.equal(f.writes.length, 0);
});

function edgeCache() {
  const previous = globalThis.caches, stored = new Map();
  let now = 0;
  globalThis.caches = {default:{
    match:async key => {const row = stored.get(key.url); return row && row.until > now ? row.response.clone() : null;},
    put:async (key, response) => stored.set(key.url, {response:response.clone(),
      until:now + Number(/max-age=(\d+)/.exec(response.headers.get('Cache-Control'))[1]) * 1000})
  }};
  return {advance:ms => {now += ms;}, restore() {if (previous === undefined) delete globalThis.caches; else globalThis.caches = previous;}};
}

for (const kind of ['overall','track']) for (const miss of ['manifest','range','page']) test(kind + ' ' + miss + ' misses are negative cached and expire', async () => {
  const f = fixture(), cache = edgeCache(), generation = 'a'.repeat(64), id = kind === 'overall' ? 'main' : 'dynamic_track';
  const manifest = PUBLIC_MANIFEST_COLLECTION + '/' + publicationManifestId(kind,id,generation);
  const page = PUBLIC_PAGE_COLLECTION + '/' + kind + '_' + id + '_' + generation + '_0';
  if (miss !== 'manifest') f.docs.set(manifest, {pageCount:miss === 'range' ? 0 : 1});
  const path = '/v1/snapshot/' + kind + '/page?generation=' + generation + '&page=0' + (kind === 'track' ? '&trackId=' + id : '');
  try {
    for (let i = 0; i < 3; i++) {
      const response = await handleRequest(f.request(path + '&ignored=' + i), f.env, f.context);
      assert.equal(response.status, 404);
      assert.equal(response.headers.get('Cache-Control'), 'public, max-age=10');
      await f.flush();
    }
    assert.equal(f.reads.length, miss === 'page' ? 2 : 1);
    f.docs.set(manifest, {pageCount:1});
    f.docs.set(page, {entries:[{userId:account}], generation, page:0});
    cache.advance(9999);
    assert.equal((await handleRequest(f.request(path), f.env, f.context)).status, 404);
    cache.advance(2);
    const response = await handleRequest(f.request(path), f.env, f.context);
    assert.equal(response.status, 200, 'newly published pages recover after the negative TTL');
    assert.equal(response.headers.get('Cache-Control'), 'public, max-age=86400, immutable');
    assert.deepEqual((await response.json()).entries, [{userId:account}]);
    await f.flush();
    assert.equal(f.reads.length, (miss === 'page' ? 2 : 1) + 2);
  } finally {await f.flush(); cache.restore();}
});

test('invalid pages and denied cold reads cost zero; storage errors are not cached', async () => {
  const f = fixture(), cache = edgeCache();
  const path = '/v1/snapshot/overall/page?generation=' + 'b'.repeat(64) + '&page=0';
  try {
    for (const suffix of ['-1','1.5','9007199254740992']) assert.equal((await handleRequest(f.request(path.replace('page=0','page=' + suffix)), f.env)).status, 400);
    assert.equal(f.reads.length, 0);
    f.env.PUBLIC_READ_RATE_LIMITER = {limit:async () => ({success:false})};
    assert.equal((await handleRequest(f.request(path), f.env)).status, 429);
    assert.equal(f.reads.length, 0);
    delete f.env.PUBLIC_READ_RATE_LIMITER;
    const read = f.env.__TEST_FIRESTORE;
    f.env.__TEST_FIRESTORE = async () => {throw Error('FIRESTORE_503');};
    await assert.rejects(handleRequest(f.request(path), f.env), /FIRESTORE_503/);
    f.env.__TEST_FIRESTORE = read;
    assert.equal((await handleRequest(f.request(path), f.env)).status, 404);
    assert.equal((await handleRequest(f.request(path), f.env)).status, 404, 'also fills cache without waitUntil');
    assert.equal(f.reads.length, 1);
  } finally {cache.restore();}
});

test('concurrent invalid page requests join one manifest read through delayed cache fill', async () => {
  const f = fixture(), previous = globalThis.caches;
  let release;
  const gate = new Promise(resolve => {release = resolve;});
  globalThis.caches = {default:{match:async () => null, put:async () => gate}};
  const path = '/v1/snapshot/overall/page?generation=' + 'c'.repeat(64) + '&page=0';
  try {
    const responses = await Promise.all(Array.from({length:8}, (_, i) => handleRequest(f.request(path + '&noise=' + i),f.env,f.context)));
    assert.ok(responses.every(response => response.status === 404));
    assert.equal(f.reads.length, 1);
    assert.equal((await handleRequest(f.request(path),f.env,f.context)).status, 404);
    assert.equal(f.reads.length, 1, 'join persists until cache put settles');
  } finally {release(); await f.flush(); if (previous === undefined) delete globalThis.caches; else globalThis.caches = previous;}
});

test('cooldown and clean Overall polling remain one metadata read with no writes', async () => {
  const f = fixture();
  f.docs.set(meta, {...modern, dirty:true, lastOverallBuildAt:Date.now(), sourceCatalog:{complete:false}});
  for (let i = 0; i < 12; i++) assert.equal((await rebuildOverall(f.env)).reason, 'cooldown');
  assert.equal(f.reads.length, 12);
  assert.equal(f.writes.length, 0);
  const clean = {...modern, dirty:false, lastOverallBuildAt:Date.now(),
    sourceCatalog:{version:1,complete:true,scannedAt:Date.now(),count:0,tracks:{}}};
  f.docs.set(meta, clean);
  assert.equal((await rebuildOverall(f.env)).reason, 'clean');
  assert.deepEqual(f.reads, Array(13).fill(meta));
  assert.equal(f.writes.length, 0);
});

test('public cold-root read costs and existing cache windows stay bounded', async () => {
  const f = fixture(), cache = edgeCache();
  f.docs.set(meta, {revision:12});
  f.docs.set(overall + '/main', {entries:[], revision:12});
  f.docs.set('0.6.2_s1_leaderboards_track/dynamic_track', {entries:[], revision:12});
  try {
    for (const [path, ttl] of [['/v1/status',30], ['/v1/snapshot/overall',300],
      ['/v1/snapshot/track?trackId=dynamic_track',300]]) {
      const before = f.reads.length;
      const response = await handleRequest(f.request(path),f.env,f.context);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('Cache-Control'), new RegExp('max-age=' + ttl));
      await f.flush();
      const noise = path.includes('?') ? '&noise=1' : '?noise=1';
      assert.equal((await handleRequest(f.request(path + noise),f.env,f.context)).status, 200);
      assert.equal(f.reads.length - before, 1);
    }
    assert.equal(f.writes.length, 0);
  } finally {await f.flush(); cache.restore();}
});
