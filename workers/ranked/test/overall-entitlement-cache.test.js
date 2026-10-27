import test from 'node:test';
import assert from 'node:assert/strict';
import {rebuildOverall, handleRequest} from '../src/index.js';
import {eventEncode, eventDecode} from '../src/events-store.js';
import {unpackOverallDetails} from '../src/overall-details.js';
import {prepareSourcePublication} from '../src/overall-source-publication.js';
import {OWNER_PUBLIC_ID} from '../src/server-achievements.js';
import {ENTITLEMENT_COLLECTION as ENT, ENTITLEMENT_CACHE_COLLECTION as CACHE,
  ENTITLEMENT_AUDIT_MS, ENTITLEMENT_MAX_ACCOUNTS, ENTITLEMENT_JOURNAL_MAX_IDS, entitlementPolicyKey,
  invalidateEntitlements, entitlementMarkerValid, loadOverallEntitlements,
  prepareEntitlementPublication, decodeEntitlementPublication, fenceEntitlementWrites,
  captureEntitlementCommitTimes} from '../src/overall-entitlement-cache.js';

const META = '0.6.2_s1_release_meta/current';
const TRACKS = '0.6.2_s1_leaderboards_track';
const OVERALL = '0.6.2_s1_leaderboards_overall/main';
const TRACK = '5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038';
const BASE = 'projects/polytrack-052/databases/(default)/documents/';
const AT = 1792000000000;
const clone = value => structuredClone(value);
const isRefinement = writes => writes.some(write => write.update.name.includes('/' + CACHE + '/')) &&
  !writes.some(write => write.update.name.endsWith(OVERALL));
const binding = async () => ({scope: BASE + ENT, policyKey: await entitlementPolicyKey({version: 7}), epoch: 2, auditedAt: AT});
const docsOf = publication => new Map(publication.documents.map(doc => [doc.id, {id: doc.id, data: doc.data}]));
const canonical = (id = 'racer') => ({id, updateTime: '2026-09-01T00:00:00.123456789Z', data: {
  badge: ['auto', 'betaTester'], serverIssued: {beta: null, achievements: {version: 1, nested: {proof: ['preserve', 1]}}},
  unknownCanonicalField: {keep: true}
}});

test('companion round-trips full canonical data and exact legacy timestamp with exact bindings', async () => {
  const b = await binding(), input = new Map([['racer', canonical()]]);
  const p = await prepareEntitlementPublication(input, b);
  assert.ok(p.documents.every(doc => doc.collection === CACHE));
  assert.deepEqual(await decodeEntitlementPublication(p.marker, docsOf(p), b), input);
  for (const changed of [{epoch: 3}, {scope: 'other-project'}, {policyKey: 'f'.repeat(64)}, {auditedAt: AT + 1}]) {
    await assert.rejects(decodeEntitlementPublication(p.marker, docsOf(p), {...b, ...changed}), /BINDING/);
  }
  assert.equal(entitlementMarkerValid({...p.marker, count: ENTITLEMENT_MAX_ACCOUNTS + 1}, b), false);
  assert.equal(entitlementMarkerValid({...p.marker, publication: {...p.marker.publication, parts: 5}}, b), false);
  const reservedIds = new Map(['__proto__', 'constructor', 'prototype'].map(id => [id, canonical(id)]));
  const reserved = await prepareEntitlementPublication(reservedIds, b);
  assert.deepEqual(await decodeEntitlementPublication(reserved.marker, docsOf(reserved), b), reservedIds);
});

test('new and absent accounts are canonical lookups, never silently negative cached', async () => {
  const b = await binding(), p = await prepareEntitlementPublication(new Map([['racer', canonical()]]), b), batches = [];
  const result = await loadOverallEntitlements({meta: {entitlementEpoch: 2, entitlementAuditedAt: AT, entitlementBundle: p.marker},
    ...b, now: AT + 1, accountIds: ['racer', 'new', 'absent'], readPublished: async () => docsOf(p),
    readCanonical: async ids => {batches.push(ids); return new Map([['new', canonical('new')]]);}});
  assert.deepEqual(batches, [['new', 'absent']]);
  assert.equal(result.canonicalReads, 2);
  assert.equal(result.auditedAt, AT);
  assert.equal(result.documents.has('absent'), false);
  assert.deepEqual(result.documents.get('racer'), canonical());
});

test('a persistently missing canonical document is reread on every loader call, not negative cached', async () => {
  const b = await binding(), p = await prepareEntitlementPublication(new Map(), b);
  let canonicalReads = 0;
  for (let step = 1; step <= 4; step++) {
    const result = await loadOverallEntitlements({...b,
      meta: {entitlementEpoch: b.epoch, entitlementAuditedAt: AT, entitlementBundle: p.marker},
      now: AT + step * 30 * 60 * 1000, accountIds: ['no-document'], readPublished: async () => docsOf(p),
      readCanonical: async ids => {canonicalReads += ids.length; return new Map();}});
    assert.equal(result.canonicalReads, 1);
    assert.equal(result.documents.has('no-document'), false);
    assert.equal(result.auditedAt, AT);
  }
  assert.equal(canonicalReads, 4);
});

test('corrupt payload recovery is guarded; network failure never amplifies into canonical reads', async () => {
  const b = await binding(), p = await prepareEntitlementPublication(new Map([['racer', canonical()]]), b);
  let reads = 0, guards = 0;
  const options = {...b, meta: {entitlementEpoch: 2, entitlementAuditedAt: AT, entitlementBundle: p.marker},
    now: AT + 1, accountIds: ['racer'], readCanonical: async () => {reads++; return new Map();},
    beforeRecovery: async () => {guards++;}};
  const damaged = docsOf(p); damaged.get('main_0').data.bundle = 'x'.repeat(p.documents[0].data.bundle.length);
  await loadOverallEntitlements({...options, readPublished: async () => damaged});
  assert.equal(reads, 1); assert.equal(guards, 1);
  await assert.rejects(loadOverallEntitlements({...options, readPublished: async () => {throw Error('FIRESTORE_429');}}), /429/);
  assert.equal(reads, 1);
  await assert.rejects(loadOverallEntitlements({...options, readPublished: async () => damaged,
    beforeRecovery: async () => {throw Error('SUPERSEDED');}}), /SUPERSEDED/);
  assert.equal(reads, 1);
});

test('full audit and canonical identity bounds fail closed', async () => {
  const b = await binding(); let publishedReads = 0;
  const options = {...b, meta: {entitlementEpoch: 2, entitlementAuditedAt: AT}, now: AT + ENTITLEMENT_AUDIT_MS,
    accountIds: ['racer'], readPublished: async () => {publishedReads++;},
    readCanonical: async () => new Map([['other', canonical('other')]])};
  await assert.rejects(loadOverallEntitlements(options), /CANONICAL_IDENTITY/);
  await assert.rejects(loadOverallEntitlements({...options, accountIds: ['racer', 'racer']}), /ACCOUNT_BOUND/);
  await assert.rejects(loadOverallEntitlements({...options, accountIds: ['racer\n']}), /INVALID_DOCUMENT_ID/);
  assert.equal(await prepareEntitlementPublication(new Map(Array.from({length: ENTITLEMENT_MAX_ACCOUNTS + 1}, (_, i) => [String(i), null])), b), null);
  assert.equal(publishedReads, 0);
  const invalidated = invalidateEntitlements({entitlementEpoch: 2, sourceBundle: {keep: true}, dirty: false});
  assert.equal(invalidated.entitlementEpoch, 3); assert.equal(invalidated.dirty, true);
  assert.deepEqual(invalidated.entitlementBundle, {version: 1, ready: false});
  assert.deepEqual(invalidated.sourceBundle, {keep: true});
});

test('a digest-valid body with duplicate identities cannot be authorized by its marker', async () => {
  const b = await binding(), rows = [canonical(), canonical()];
  const body = JSON.stringify({version: 1, ...b, rows});
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)))].map(n => n.toString(16).padStart(2, '0')).join('');
  const p = await prepareSourcePublication(body, {version: 1, ready: true, ...b, count: 2, digest: hash});
  await assert.rejects(decodeEntitlementPublication(p.marker, docsOf(p), b), /ROW_INVALID/);
});

function fixture(count = 2) {
  const data = new Map(), versions = new Map(), calls = [], commits = [];
  const f = {data, calls, commits};
  const version = key => 'v' + (versions.get(key) || 0);
  const wire = key => ({name: BASE + key, fields: eventEncode(data.get(key)).mapValue.fields, updateTime: version(key)});
  f.mutate = (key, value) => {data.set(key, clone(value)); versions.set(key, (versions.get(key) || 0) + 1);};
  f.dirty = () => f.mutate(META, {...data.get(META), dirty: true, lastOverallBuildAt: 0});
  f.mutate(META, {dirty: true, revision: 1});
  f.mutate(TRACKS + '/' + TRACK, {trackId: TRACK, complete: true, sourceComplete: true,
    revision: 1, sourceRevision: 1, updatedAt: AT, signature: 'verified_source_signature',
    schemaVersion: 6, algorithmVersion: 'participation-v8-s1', totalEntries: count,
    entries: Array.from({length: count}, (_, i) => ({accountId: 'r' + String(i).padStart(4, '0'),
      timeMs: 10000 + i, integrityVerified: true, runVerified: true, weight: 1}))});
  f.env = {OPEN_BETA_ENABLED: 'false', __TEST_FIRESTORE: async (path, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null; calls.push({path, body});
    if (f.onRequest) await f.onRequest(path, body);
    if (path === ':batchGet') return body.documents.map(name => {
      const key = name.slice(BASE.length); return data.has(key) ? {found: wire(key)} : {missing: name};
    });
    if (path === ':runQuery') {
      const q = body.structuredQuery, collection = q.from[0].collectionId;
      const after = q.startAt?.values?.[0]?.referenceValue || '';
      return [...data.keys()].filter(key => key.startsWith(collection + '/') && BASE + key > after)
        .sort().slice(0, q.limit).map(key => ({document: wire(key)}));
    }
    if (path === ':commit') {
      const writes = body.writes;
      if (f.beforeCommit) await f.beforeCommit(writes);
      if (isRefinement(writes)) {
        assert.ok(writes.length <= 5);
        assert.ok(writes.every(write => write.update.name.endsWith(META) || write.update.name.includes('/' + CACHE + '/')));
        f.refinementAttempts = (f.refinementAttempts || 0) + 1;
        if (f.failRefinement) throw Error('FIRESTORE_503');
      }
      assert.ok(writes.length <= 500);
      for (const write of writes) {
        const key = write.update.name.slice(BASE.length), condition = write.currentDocument;
        if (key.startsWith(ENT + '/')) assert.ok(condition?.updateTime || condition?.exists === false, 'canonical writes must be conditional');
        if (condition && (condition.exists === false ? data.has(key) : !data.has(key) || version(key) !== condition.updateTime)) throw Error('FIRESTORE_409');
      }
      for (const write of writes) f.mutate(write.update.name.slice(BASE.length), eventDecode({mapValue: {fields: write.update.fields}}));
      commits.push(clone(writes));
      if (f.omitCommitResult || f.omitFinalCommitResult && writes.some(write => write.update.name.endsWith(OVERALL))) return {};
      return {writeResults: writes.map(write => ({updateTime: version(write.update.name.slice(BASE.length))}))};
    }
    const key = decodeURIComponent(path.slice(1));
    if (init.method === 'PATCH') {f.mutate(key, eventDecode({mapValue: {fields: body.fields}})); return {updateTime: version(key)};}
    return data.has(key) ? wire(key) : null;
  }};
  return f;
}
function reads(calls, collection) {
  return calls.flatMap(call => call.path === ':batchGet' ? call.body.documents : [])
    .filter(name => name.includes('/' + collection + '/')).length;
}
async function profileGrant(f, accountId = 'r0000') {
  const tasks = [];
  const response = await handleRequest(new Request('https://ranked.example/v1/profile/notify', {
    method: 'POST', headers: {Origin: 'https://example.test', 'Content-Type': 'application/json'}, body: JSON.stringify({accountId})
  }), {...f.env, ALLOWED_ORIGINS: 'https://example.test', PB_NOTIFY_RATE_LIMITER: {limit: async () => ({success:true})}, __TEST_UID: 'owner'}, {waitUntil(task) {tasks.push(task);}});
  await Promise.all(tasks);
  return response;
}

test('cold no-op rebuild reuses 531 entitlements; new racer reads only itself after timestamp refinement', async t => {
  t.mock.method(Date, 'now', () => AT);
  const f = fixture(531); await rebuildOverall(f.env, true);
  assert.equal(reads(f.calls, ENT), 531);
  const oldHistory = clone(f.data.get(ENT + '/r0530'));
  f.dirty(); let start = f.calls.length;
  await rebuildOverall({...f.env});
  assert.equal(reads(f.calls.slice(start), ENT), 0);
  assert.equal(reads(f.calls.slice(start), CACHE), 1);
  assert.deepEqual(f.data.get(ENT + '/r0530'), oldHistory);
  const board = clone(f.data.get(TRACKS + '/' + TRACK));
  board.entries.push({...board.entries[0], accountId: 'new-racer', timeMs: 30000}); board.totalEntries++;
  f.mutate(TRACKS + '/' + TRACK, board);
  f.mutate(META, {...f.data.get(META), dirty: true, lastOverallBuildAt: 0, sourceCatalog: null});
  start = f.calls.length; await rebuildOverall({...f.env});
  assert.equal(reads(f.calls.slice(start), ENT), 1, 'only the new racer; 530 changed allowances use refined canonical CAS');
  const names = f.calls.slice(start).flatMap(call => call.path === ':batchGet' ? call.body.documents : []);
  assert.equal(names.some(name => name.endsWith(ENT + '/r0000')), false, 'unchanged allowance needs no fresh read');
  assert.ok(f.data.has(ENT + '/new-racer'));
  assert.equal(f.data.get(META).entitlementAuditedAt, AT);
});

test('racers initially missing entitlement documents are materialized without beta grants and reused on repeated cold builds', async t => {
  let now = AT; t.mock.method(Date, 'now', () => now);
  const f = fixture(7);
  assert.equal([...f.data.keys()].some(key => key.startsWith(ENT + '/')), false);
  await rebuildOverall(f.env, true);
  assert.equal(reads(f.calls, ENT), 7);
  assert.equal(f.data.get(META).entitlementBundle.count, 7);
  const published = f.commits.findLast(writes => writes.some(write => write.update.name.endsWith(OVERALL)));
  const materialized = published.filter(w => w.update.name.includes('/' + ENT + '/'));
  assert.equal(materialized.length, 7);
  assert.ok(published.some(w => w.update.name.endsWith(META) && w.currentDocument.updateTime));
  assert.ok(published.some(w => w.update.name.includes('/' + CACHE + '/')));
  for (let step = 1; step <= 4; step++) {
    now = AT + step * 30 * 60 * 1000; f.dirty();
    const start = f.calls.length;
    assert.equal((await rebuildOverall({...f.env})).rebuilt, true);
    assert.equal(reads(f.calls.slice(start), ENT), 0);
    assert.equal(reads(f.calls.slice(start), CACHE), 1);
    assert.equal(f.data.get(META).entitlementAuditedAt, AT);
    for (let i = 0; i < 7; i++) assert.equal(f.data.get(ENT + '/r' + String(i).padStart(4, '0')).serverIssued.beta, null);
  }
});

test('six-hour audit runs on clean unchanged sources and policy change bypasses cooldown', async t => {
  let now = AT; t.mock.method(Date, 'now', () => now);
  const f = fixture(); await rebuildOverall(f.env, true);
  const start = f.calls.length; now += ENTITLEMENT_AUDIT_MS;
  assert.equal((await rebuildOverall({...f.env})).rebuilt, true);
  assert.equal(reads(f.calls.slice(start), ENT), 2);
  assert.equal(f.data.get(META).entitlementAuditedAt, now);
  const policyStart = f.calls.length;
  await rebuildOverall({...f.env, BETA_CUTOFF_MS: String(now - 1)});
  assert.equal(reads(f.calls.slice(policyStart), ENT), 2);
});

test('one profile grant across a cold build saves N-1 canonical reads and retains the full audit timestamp', async t => {
  let now = AT; t.mock.method(Date, 'now', () => now);
  const f = fixture(531); f.env.OPEN_BETA_ENABLED = 'true'; f.env.BETA_CUTOFF_MS = String(AT + ENTITLEMENT_AUDIT_MS);
  await rebuildOverall(f.env, true);
  f.mutate('0.6.2_profiles_public/r0000', {accountId: 'r0000', ownerUid: 'owner', accountCreatedAt: AT - 1000});
  const epoch = f.data.get(META).entitlementEpoch;
  const baseline = clone(f.data.get(META).entitlementBundle);
  now += 30 * 60 * 1000;
  assert.equal((await profileGrant(f)).status, 202);
  const meta = f.data.get(META);
  assert.equal(meta.entitlementEpoch, epoch + 1); assert.equal(meta.dirty, true);
  assert.deepEqual(meta.entitlementBundle, baseline);
  assert.deepEqual(meta.entitlementInvalidations.accountIds, ['r0000']);
  const grant = f.commits.find(writes => writes.some(w => w.update.name.endsWith(ENT + '/r0000') && w.currentDocument));
  assert.ok(grant.find(w => w.update.name.endsWith(META)).currentDocument.updateTime);
  const start = f.calls.length; await rebuildOverall({...f.env});
  assert.equal(reads(f.calls.slice(start), ENT), 1);
  assert.equal(reads(f.calls.slice(start), CACHE), 1);
  assert.equal(f.data.get(META).entitlementAuditedAt, AT);
  assert.equal(f.data.get(META).entitlementInvalidations, null);
  console.log('One-grant cold build measured documents', JSON.stringify({baseline: 531, canonical: 1, companion: 1, canonicalSaved: 530}));
  assert.equal(f.data.get(ENT + '/r0000').serverIssued.beta.source, 'open-beta-release');
});

test('concurrent profile grant fences a stale Overall commit without overwriting its grant', async t => {
  t.mock.method(Date, 'now', () => AT);
  const f = fixture(); f.env.OPEN_BETA_ENABLED = 'true'; f.env.BETA_CUTOFF_MS = String(AT + 10000);
  await rebuildOverall(f.env, true);
  f.mutate('0.6.2_profiles_public/r0000', {accountId: 'r0000', ownerUid: 'owner', accountCreatedAt: AT - 1});
  const previous = clone(f.data.get(OVERALL)); f.dirty();
  f.beforeCommit = async writes => {
    if (!writes.some(w => w.update.name.endsWith(OVERALL))) return;
    f.beforeCommit = null;
    assert.equal((await profileGrant(f)).status, 202);
  };
  await assert.rejects(rebuildOverall({...f.env}), /409/);
  assert.deepEqual(f.data.get(OVERALL), previous);
  assert.equal(f.data.get(ENT + '/r0000').serverIssued.beta.source, 'open-beta-release');
  assert.equal(f.data.get(META).entitlementBundle.ready, true);
  assert.deepEqual(f.data.get(META).entitlementInvalidations.accountIds, ['r0000']);
});

test('failed multi-commit build leaves companion invalid; missing commit version never adopts a fresh CAS', async t => {
  t.mock.method(Date, 'now', () => AT);
  const f = fixture(531); f.omitCommitResult = true;
  await assert.rejects(rebuildOverall(f.env, true), /COMMIT_FENCE_MISSING/);
  assert.equal(f.data.get(META).entitlementBundle.ready, false);
  assert.equal(f.data.get(META).dirty, true);
  assert.equal(f.data.has(OVERALL), false);
  assert.equal(f.calls.filter(call => call.path === '/' + META).length, 1);
  f.omitCommitResult = false;
  await rebuildOverall({...f.env}, true);
  assert.equal(f.data.get(META).entitlementBundle.ready, true);
});

test('audit observes administrator payload edits; ordinary builds deliberately require the writer fence', async t => {
  let now = AT; t.mock.method(Date, 'now', () => now);
  const f = fixture(); await rebuildOverall(f.env, true);
  const row = clone(f.data.get(ENT + '/r0000'));
  row.serverIssued.beta = {id: 'beta-tester', source: 'release-migration', sourceRevision: 1, issuedAt: AT - 1000, cutoffAt: 0};
  f.mutate(ENT + '/r0000', row);
  const start = f.calls.length;
  f.dirty(); await rebuildOverall({...f.env});
  assert.equal(reads(f.calls.slice(start), ENT), 0);
  assert.deepEqual(f.data.get(ENT + '/r0000'), row, 'unchanged cached authority cannot overwrite the admin edit');
  assert.equal((await unpackOverallDetails(f.data.get(OVERALL))).entries[0].betaEntitlement, null);
  now += ENTITLEMENT_AUDIT_MS;
  await rebuildOverall({...f.env});
  const published = await unpackOverallDetails(f.data.get(OVERALL));
  assert.equal(published.entries[0].betaEntitlement.source, 'release-migration');
});

test('24h cold-start model: 48 builds read 2124 canonical documents plus 44 companion documents, not 25488', async t => {
  let now = AT; t.mock.method(Date, 'now', () => now);
  const f = fixture(531); await rebuildOverall(f.env, true);
  const start = f.calls.length;
  for (let step = 1; step <= 48; step++) {
    now = AT + step * 30 * 60 * 1000; f.dirty(); await rebuildOverall({...f.env});
  }
  const calls = f.calls.slice(start);
  assert.equal(reads(calls, ENT), 4 * 531);
  assert.equal(reads(calls, CACHE), 44);
  console.log('Entitlement 24h measured documents', JSON.stringify({baseline: 48 * 531, canonical: reads(calls, ENT), companion: reads(calls, CACHE)}));
});

test('returning racer hydrates canonical beta and immutable owner-beat history after companion eviction', async t => {
  t.mock.method(Date, 'now', () => AT);
  const f = fixture(3), key = TRACKS + '/' + TRACK;
  const board = clone(f.data.get(key));
  board.entries[0].accountId = OWNER_PUBLIC_ID;
  board.entries[1].timeMs = 9000;
  f.mutate(key, board);
  f.mutate(ENT + '/r0001', {serverIssued: {beta: {
    id: 'beta-tester', source: 'release-migration', sourceRevision: 1, issuedAt: AT - 1000, cutoffAt: 0
  }}});
  await rebuildOverall(f.env, true);
  const earned = clone(f.data.get(ENT + '/r0001').serverIssued);
  assert.equal(earned.achievements.beatOwner.unlocks.length, 1);
  const dropped = {...board, entries: board.entries.filter(row => row.accountId !== 'r0001'), totalEntries: 2};
  f.mutate(key, dropped);
  f.mutate(META, {...f.data.get(META), dirty: true, lastOverallBuildAt: 0, sourceCatalog: null});
  await rebuildOverall({...f.env});
  assert.deepEqual(f.data.get(ENT + '/r0001').serverIssued, earned);
  board.entries[0].timeMs = 8000;
  f.mutate(key, board);
  f.mutate(META, {...f.data.get(META), dirty: true, lastOverallBuildAt: 0, sourceCatalog: null});
  const start = f.calls.length; await rebuildOverall({...f.env});
  assert.equal(reads(f.calls.slice(start), ENT), 1);
  const returned = f.data.get(ENT + '/r0001').serverIssued;
  assert.deepEqual(returned.beta, earned.beta);
  assert.deepEqual(returned.achievements.beatOwner, earned.achievements.beatOwner);
  assert.deepEqual(returned.cosmeticUnlocks, earned.cosmeticUnlocks);
});

test('canonical audit batches are bounded without truncating the racer set', async () => {
  const b = await binding(), accountIds = Array.from({length: 1001}, (_, i) => 'racer-' + i), sizes = [];
  const result = await loadOverallEntitlements({...b, meta: {}, now: AT, accountIds,
    readCanonical: async ids => {sizes.push(ids.length); return new Map(ids.map(id => [id, canonical(id)]));}});
  assert.deepEqual(sizes, [500, 500, 1]);
  assert.equal(result.documents.size, 1001);
});

test('journal merges changed IDs, discards changed missing rows, and rejects incomplete epoch/digest bindings', async () => {
  const b = await binding(), p = await prepareEntitlementPublication(new Map([
    ['racer', canonical()], ['removed', canonical('removed')], ['unchanged', canonical('unchanged')]
  ]), b);
  const initial = {entitlementEpoch: b.epoch, entitlementAuditedAt: AT, entitlementBundle: p.marker};
  const meta = invalidateEntitlements(invalidateEntitlements(initial, ['racer']), ['racer', 'removed', 'inactive']);
  assert.equal(meta.entitlementEpoch, b.epoch + 2);
  assert.deepEqual(meta.entitlementInvalidations.accountIds, ['inactive', 'racer', 'removed']);
  const batches = [], options = {...b, meta, now: AT + 1, accountIds: ['racer', 'removed', 'unchanged', 'new'],
    readPublished: async () => docsOf(p), readCanonical: async ids => {batches.push(ids); return new Map([['racer', canonical()]]);}};
  const result = await loadOverallEntitlements(options);
  assert.deepEqual(batches, [['racer', 'removed', 'new']]);
  assert.equal(result.documents.has('removed'), false);
  assert.equal(result.documents.has('unchanged'), true);
  assert.equal(result.auditedAt, AT);
  for (const change of [{baseEpoch: 0}, {throughEpoch: 0}, {baseDigest: 'f'.repeat(64)},
    {accountIds: ['racer', 'racer']}, {accountIds: []}, {accountIds: ['invalid/id']}]) {
    const recovered = await loadOverallEntitlements({...options,
      meta: {...meta, entitlementInvalidations: {...meta.entitlementInvalidations, ...change}}});
    assert.equal(recovered.canonicalReads, 4); assert.equal(recovered.reused, false);
  }
  const gap = await loadOverallEntitlements({...options, meta: {...meta, entitlementInvalidations: null}});
  assert.equal(gap.reused, false);
});

test('journal count/byte overflow forces one full scan then a fresh baseline resumes reuse', async () => {
  const b = await binding(), p = await prepareEntitlementPublication(new Map([['racer', canonical()]]), b);
  const meta = {entitlementEpoch: b.epoch, entitlementAuditedAt: AT, entitlementBundle: p.marker};
  const countOverflow = invalidateEntitlements(meta, Array.from({length: ENTITLEMENT_JOURNAL_MAX_IDS + 1}, (_, i) => 'id-' + i));
  const byteOverflow = invalidateEntitlements(meta, Array.from({length: ENTITLEMENT_JOURNAL_MAX_IDS}, (_, i) => String(i).padStart(128, 'x')));
  for (const invalidated of [countOverflow, byteOverflow]) {
    assert.equal(invalidated.entitlementBundle.ready, false);
    assert.equal(invalidated.entitlementInvalidations, null);
    const options = {...b, meta: invalidated, now: AT + 1, accountIds: ['racer'],
      readPublished: async () => {throw Error('invalid baseline must not be read');},
      readCanonical: async () => new Map([['racer', canonical()]])};
    const audited = await loadOverallEntitlements(options);
    assert.equal(audited.canonicalReads, 1); assert.equal(audited.auditedAt, AT + 1);
    const next = await prepareEntitlementPublication(audited.documents, {...b, epoch: invalidated.entitlementEpoch, auditedAt: audited.auditedAt});
    const reused = await loadOverallEntitlements({...options,
      meta: {...invalidated, entitlementAuditedAt: audited.auditedAt, entitlementBundle: next.marker}, readPublished: async () => docsOf(next)});
    assert.equal(reused.canonicalReads, 0); assert.equal(reused.reused, true);
  }
});

test('interrupted Overall chunk journals committed IDs; recovery reuses refined versions for unaffected rows', async t => {
  let now = AT; t.mock.method(Date, 'now', () => now);
  const f = fixture(531); f.env.OPEN_BETA_ENABLED = 'true'; f.env.BETA_CUTOFF_MS = String(AT + ENTITLEMENT_AUDIT_MS);
  await rebuildOverall(f.env, true);
  const baseline = clone(f.data.get(META).entitlementBundle);
  const board = clone(f.data.get(TRACKS + '/' + TRACK));
  board.entries = board.entries.map(row => ({...row, accountCreatedAt: AT - 1}));
  f.mutate(TRACKS + '/' + TRACK, board);
  f.mutate(META, {...f.data.get(META), sourceCatalog: null, dirty: true, lastOverallBuildAt: 0});
  now += 30 * 60 * 1000; f.omitCommitResult = true;
  await assert.rejects(rebuildOverall({...f.env}), /COMMIT_FENCE_MISSING/);
  assert.deepEqual(f.data.get(META).entitlementBundle, baseline);
  const ids = f.commits.at(-1).filter(w => w.update.name.includes('/' + ENT + '/')).map(w => w.update.name.split('/').at(-1)).sort();
  assert.equal(ids.length, 400);
  assert.deepEqual(f.data.get(META).entitlementInvalidations.accountIds, ids);
  assert.equal(f.data.get(META).entitlementAuditedAt, AT);
  f.omitCommitResult = false;
  const start = f.calls.length; await rebuildOverall({...f.env});
  assert.equal(reads(f.calls.slice(start), ENT), 400, '400 journal reads; the other 131 rows already have canonical CAS timestamps');
  assert.equal(f.data.get(META).entitlementInvalidations, null);
  assert.equal(f.data.get(META).entitlementAuditedAt, AT);
  for (let i = 0; i < 531; i++) assert.equal(f.data.get(ENT + '/r' + String(i).padStart(4, '0')).serverIssued.beta.source, 'open-beta-release');
});

test('24h cold-start builds with one new profile grant each half hour retain savings and six-hour audits', async t => {
  let now = AT; t.mock.method(Date, 'now', () => now);
  const f = fixture(531); f.env.OPEN_BETA_ENABLED = 'true'; f.env.BETA_CUTOFF_MS = String(AT + 48 * 60 * 60 * 1000);
  await rebuildOverall(f.env, true);
  let canonicalReads = 0, companionReads = 0, lastAudit = AT;
  for (let step = 1; step <= 48; step++) {
    now = AT + step * 30 * 60 * 1000;
    const accountId = 'r' + String(step).padStart(4, '0');
    f.mutate('0.6.2_profiles_public/' + accountId, {accountId, ownerUid: 'owner', accountCreatedAt: AT - 1});
    assert.equal((await profileGrant(f, accountId)).status, 202);
    const start = f.calls.length;
    assert.equal((await rebuildOverall({...f.env})).rebuilt, true);
    const count = reads(f.calls.slice(start), ENT);
    assert.equal(count, step % 12 === 0 ? 531 : 1);
    canonicalReads += count; companionReads += reads(f.calls.slice(start), CACHE);
    if (step % 12 === 0) lastAudit = now;
    assert.equal(f.data.get(META).entitlementAuditedAt, lastAudit);
    assert.equal(f.data.get(META).entitlementInvalidations, null);
  }
  assert.equal(canonicalReads, 4 * 531 + 44);
  assert.equal(companionReads, 44);
  console.log('One-grant-per-build 24h measured documents', JSON.stringify({baseline: 48 * 531, canonical: canonicalReads, companion: companionReads, total: canonicalReads + companionReads}));
});

test('concurrent grants cannot lose an invalidation or grant when their metadata CAS collides', async t => {
  t.mock.method(Date, 'now', () => AT);
  const f = fixture(); f.env.OPEN_BETA_ENABLED = 'true'; f.env.BETA_CUTOFF_MS = String(AT + ENTITLEMENT_AUDIT_MS);
  await rebuildOverall(f.env, true);
  for (const id of ['r0000', 'r0001']) f.mutate('0.6.2_profiles_public/' + id, {accountId: id, ownerUid: 'owner', accountCreatedAt: AT - 1});
  f.beforeCommit = async writes => {
    if (!writes.some(w => w.update.name.endsWith(ENT + '/r0000'))) return;
    f.beforeCommit = null;
    assert.equal((await profileGrant(f, 'r0001')).status, 202);
  };
  await assert.rejects(profileGrant(f, 'r0000'), /FIRESTORE_409/);
  assert.equal(f.data.get(ENT + '/r0000').serverIssued.beta, null);
  assert.equal(f.data.get(ENT + '/r0001').serverIssued.beta.source, 'open-beta-release');
  assert.deepEqual(f.data.get(META).entitlementInvalidations.accountIds, ['r0001']);
  assert.equal((await profileGrant(f, 'r0000')).status, 202);
  assert.deepEqual(f.data.get(META).entitlementInvalidations.accountIds, ['r0000', 'r0001']);
});

test('write fence uses cached versions or exists:false; unversioned changes require matching fresh payloads', async () => {
  const known = canonical('known'), unknown = {...canonical('unknown'), updateTime: ''};
  const previous = new Map([['known', known], ['unknown', unknown]]);
  const writes = ['known', 'unknown', 'absent'].map(id => ({id, data: {next: true}, unconditional: true}));
  const calls = [];
  const result = await fenceEntitlementWrites(writes, previous, async ids => {
    calls.push(ids); return new Map([['unknown', {...unknown, updateTime: 'fresh-version'}]]);
  });
  assert.deepEqual(calls, [['unknown']]);
  assert.equal(result.canonicalReads, 1);
  assert.equal(result.writes.some(write => write.unconditional), false);
  assert.deepEqual(result.writes.map(write => write.prior), [{updateTime: known.updateTime}, {updateTime: 'fresh-version'}, null]);
  assert.equal((await fenceEntitlementWrites([], previous, async () => {throw Error('no-op read');})).canonicalReads, 0);
  for (const found of [new Map(), new Map([['unknown', {...unknown, data: {admin: true}, updateTime: 'admin-version'}]])]) {
    await assert.rejects(fenceEntitlementWrites(writes, previous, async () => found), error =>
      error.message === 'OVERALL_ENTITLEMENT_PAYLOAD_CHANGED' && error.entitlementConflictIds.join() === 'unknown');
  }
  await assert.rejects(fenceEntitlementWrites(writes, previous, async () => new Map([['unknown', unknown]])), /VERSION_MISSING/);
});

function changeRacerWeight(f) {
  const board = clone(f.data.get(TRACKS + '/' + TRACK));
  board.entries[0].weight = 0.5;
  f.mutate(TRACKS + '/' + TRACK, board);
  f.mutate(META, {...f.data.get(META), sourceCatalog: null, dirty: true, lastOverallBuildAt: 0});
}
function adminBeta(f, id = 'r0000') {
  const data = clone(f.data.get(ENT + '/' + id) || {});
  data.serverIssued = {...data.serverIssued, beta: {
    id: 'beta-tester', source: 'release-migration', sourceRevision: 1, issuedAt: AT - 1000, cutoffAt: 0
  }};
  f.mutate(ENT + '/' + id, data);
  return clone(data);
}

for (const versioned of [false, true]) test(`out-of-band admin edit is never overwritten by a changed allowance (${versioned ? 'cached CAS' : 'targeted fresh compare'})`, async t => {
  let now = AT; t.mock.method(Date, 'now', () => now);
  const f = fixture(3); f.failRefinement = !versioned; await rebuildOverall(f.env, true);
  if (versioned) await rebuildOverall({...f.env}, true);
  const oldOverall = clone(f.data.get(OVERALL)), oldBundle = clone(f.data.get(META).entitlementBundle);
  const edited = adminBeta(f);
  changeRacerWeight(f); now += 30 * 60 * 1000;
  const start = f.calls.length, commits = f.commits.length;
  await assert.rejects(rebuildOverall({...f.env}), versioned ? /FIRESTORE_409/ : /PAYLOAD_CHANGED/);
  assert.deepEqual(f.data.get(ENT + '/r0000'), edited);
  assert.deepEqual(f.data.get(OVERALL), oldOverall);
  assert.deepEqual(f.data.get(META).entitlementBundle, oldBundle);
  assert.deepEqual(f.data.get(META).entitlementInvalidations.accountIds, ['r0000']);
  assert.equal(f.data.get(META).entitlementAuditedAt, AT);
  const recovery = f.commits.slice(commits).filter(writes => writes.some(write => write.update.name.endsWith(META)));
  assert.equal(recovery.length, 1);
  assert.equal(recovery[0].length, 1, 'recovery journals only, never publishes the stale calculation');
  assert.ok(f.commits.slice(commits).flat().every(write => !write.update.name.includes('/' + ENT + '/') &&
    !write.update.name.includes('/' + CACHE + '/') && !write.update.name.endsWith(OVERALL)));
  assert.equal(f.calls.slice(start).filter(call => call.path === '/' + META).length, 1, 'no fresh metadata CAS adoption');
  assert.equal(reads(f.calls.slice(start), ENT), versioned ? 0 : 1);
  const retry = f.calls.length;
  assert.equal((await rebuildOverall({...f.env})).rebuilt, true);
  assert.equal(reads(f.calls.slice(retry), ENT), 1);
  assert.deepEqual(f.data.get(ENT + '/r0000').serverIssued.beta, edited.serverIssued.beta);
  assert.equal(f.data.get(META).entitlementAuditedAt, AT);
  assert.equal(f.data.get(META).entitlementInvalidations, null);
});

test('admin race after targeted payload comparison is stopped by canonical CAS', async t => {
  t.mock.method(Date, 'now', () => AT);
  const f = fixture(3); f.failRefinement = true; await rebuildOverall(f.env, true); changeRacerWeight(f);
  const oldOverall = clone(f.data.get(OVERALL)); let edited;
  f.beforeCommit = async writes => {
    const target = writes.find(write => write.update.name.endsWith(ENT + '/r0000'));
    if (!target) return;
    f.beforeCommit = null;
    assert.ok(target.currentDocument.updateTime);
    edited = adminBeta(f);
  };
  await assert.rejects(rebuildOverall({...f.env}), /FIRESTORE_409/);
  assert.deepEqual(f.data.get(ENT + '/r0000'), edited);
  assert.deepEqual(f.data.get(OVERALL), oldOverall);
  assert.deepEqual(f.data.get(META).entitlementInvalidations.accountIds, ['r0000']);
  await rebuildOverall({...f.env});
  assert.deepEqual(f.data.get(ENT + '/r0000').serverIssued.beta, edited.serverIssued.beta);
});

test('missing canonical creation is exists:false guarded against an administrator racing the first build', async t => {
  t.mock.method(Date, 'now', () => AT);
  const f = fixture(); let edited;
  f.beforeCommit = async writes => {
    const target = writes.find(write => write.update.name.endsWith(ENT + '/r0000'));
    if (!target) return;
    f.beforeCommit = null;
    assert.deepEqual(target.currentDocument, {exists: false});
    edited = adminBeta(f);
  };
  await assert.rejects(rebuildOverall(f.env, true), /FIRESTORE_409/);
  assert.deepEqual(f.data.get(ENT + '/r0000'), edited);
  assert.equal(f.data.has(OVERALL), false);
  await rebuildOverall({...f.env});
  assert.deepEqual(f.data.get(ENT + '/r0000').serverIssued.beta, edited.serverIssued.beta);
});

test('conflict recovery never replaces superseding metadata with a fresh CAS', async t => {
  t.mock.method(Date, 'now', () => AT);
  const f = fixture(3); f.failRefinement = true; await rebuildOverall(f.env, true);
  const edited = adminBeta(f); changeRacerWeight(f);
  const oldOverall = clone(f.data.get(OVERALL)); let winner;
  f.beforeCommit = async writes => {
    if (writes.length !== 1 || !writes[0].update.name.endsWith(META)) return;
    f.beforeCommit = null;
    winner = {...invalidateEntitlements(f.data.get(META), ['r0002']), sentinel: 'new-generation'};
    f.mutate(META, winner);
  };
  const start = f.calls.length;
  await assert.rejects(rebuildOverall({...f.env}), /PAYLOAD_CHANGED/);
  assert.deepEqual(f.data.get(META), winner);
  assert.deepEqual(f.data.get(ENT + '/r0000'), edited);
  assert.deepEqual(f.data.get(OVERALL), oldOverall);
  assert.equal(f.calls.slice(start).filter(call => call.path === '/' + META).length, 1);
});

async function cachedRows(f) {
  const marker = f.data.get(META).entitlementBundle;
  const documents = new Map(Array.from({length: marker.publication.parts}, (_, part) => {
    const id = 'main_' + part; return [id, {id, data: clone(f.data.get(CACHE + '/' + id))}];
  }));
  return decodeEntitlementPublication(marker, documents, marker);
}
function addRacer(f, id) {
  const board = clone(f.data.get(TRACKS + '/' + TRACK));
  board.entries.push({...board.entries[0], accountId: id, timeMs: 40000 + board.entries.length});
  board.totalEntries++;
  f.mutate(TRACKS + '/' + TRACK, board);
  f.mutate(META, {...f.data.get(META), sourceCatalog: null, dirty: true, lastOverallBuildAt: 0});
}

test('commit timestamp capture validates complete positional results and never partially refines malformed evidence', () => {
  const rows = new Map(['a', 'b'].map(id => [id, {...canonical(id), updateTime: ''}]));
  const writes = [...rows].map(([id, row]) => ({collection: ENT, id, data: row.data}));
  const good = {writeResults: [{updateTime: 'a-v1'}, {updateTime: 'b-v2'}, {updateTime: 'meta-v3'}]};
  for (const bad of [{}, {writeResults: good.writeResults.slice(0, 2)},
    {writeResults: [...good.writeResults, {updateTime: 'extra'}]},
    {writeResults: [{updateTime: 'a-v1'}, {}, {updateTime: 'meta-v3'}]},
    {writeResults: [{updateTime: 'a-v1'}, {updateTime: 'b-v2'}, {}]}]) {
    assert.equal(captureEntitlementCommitTimes(rows, writes, bad, 3), '');
    assert.ok([...rows.values()].every(row => row.updateTime === ''));
  }
  assert.equal(captureEntitlementCommitTimes(rows, writes, good, 3), 'meta-v3');
  assert.deepEqual([...rows.values()].map(row => row.updateTime), ['a-v1', 'b-v2']);
  assert.deepEqual(rows.get('a').data, writes[0].data);
});

test('successful refinement stores intermediate and final canonical timestamps without extra reads or audit changes', async t => {
  t.mock.method(Date, 'now', () => AT);
  const f = fixture(531); await rebuildOverall(f.env, true);
  assert.equal(reads(f.calls, ENT), 531);
  assert.equal(f.calls.filter(call => call.path === '/' + META).length, 1);
  assert.equal(f.refinementAttempts, 1);
  const publication = f.commits.findLast(writes => writes.some(write => write.update.name.endsWith(OVERALL)));
  const originalMeta = eventDecode({mapValue: {fields: publication.at(-1).update.fields}});
  assert.deepEqual({...f.data.get(META), entitlementBundle: originalMeta.entitlementBundle}, originalMeta);
  const rows = await cachedRows(f);
  assert.equal(rows.size, 531);
  for (const row of rows.values()) {
    assert.equal(row.updateTime, 'v1');
    assert.deepEqual(row.data, f.data.get(ENT + '/' + row.id));
  }
  assert.equal(f.data.get(META).entitlementAuditedAt, AT);
  const start = f.calls.length, refinements = f.refinementAttempts; f.dirty();
  await rebuildOverall({...f.env});
  assert.equal(reads(f.calls.slice(start), ENT), 0);
  assert.equal(f.refinementAttempts, refinements, 'a no-op build needs no optional commit');
});

test('failed refinement keeps correct publication, intermediate timestamps and safe unknown-time fallback', async t => {
  t.mock.method(Date, 'now', () => AT);
  const f = fixture(531); f.failRefinement = true;
  assert.equal((await rebuildOverall(f.env, true)).rebuilt, true);
  const rows = await cachedRows(f);
  assert.equal([...rows.values()].filter(row => row.updateTime).length, 400);
  assert.equal([...rows.values()].filter(row => !row.updateTime).length, 131);
  assert.equal(f.data.get(META).overallRebuildFailureAttempts, undefined);
  assert.equal(f.calls.filter(call => call.path === '/' + META).length, 1);
  const start = f.calls.length; addRacer(f, 'new-after-failed-refinement');
  assert.equal((await rebuildOverall({...f.env})).rebuilt, true);
  assert.equal(reads(f.calls.slice(start), ENT), 132, 'new account plus the 131 still-unversioned changing rows');
});

test('missing final commit evidence or exhausted optional budget skips refinement without undoing publication', async t => {
  t.mock.method(Date, 'now', () => AT);
  for (const mode of ['missing-result', 'budget']) {
    const f = fixture(3);
    if (mode === 'missing-result') f.omitFinalCommitResult = true;
    else f.env.__FIRESTORE_READ_AUDIT = {httpRequests: 36, failedRequests: 0, documentReadEstimate: 0, collections: {}};
    assert.equal((await rebuildOverall(f.env, true)).rebuilt, true);
    assert.equal(f.refinementAttempts || 0, 0);
    assert.ok(f.data.has(OVERALL));
    assert.equal(f.data.get(META).overallRebuildFailureAttempts, undefined);
    assert.ok([...(await cachedRows(f)).values()].every(row => row.updateTime === ''));
    assert.equal(f.calls.filter(call => call.path === '/' + META).length, 1);
  }
});

test('profile grant winning post-publication CAS preserves newer metadata and all companion parts', async t => {
  t.mock.method(Date, 'now', () => AT);
  const f = fixture(3); f.env.OPEN_BETA_ENABLED = 'true'; f.env.BETA_CUTOFF_MS = String(AT + ENTITLEMENT_AUDIT_MS);
  f.mutate('0.6.2_profiles_public/r0000', {accountId: 'r0000', ownerUid: 'owner', accountCreatedAt: AT - 1});
  let winner, parts, afterWinner;
  f.beforeCommit = async writes => {
    if (!isRefinement(writes)) return;
    f.beforeCommit = null;
    assert.equal((await profileGrant(f)).status, 202);
    winner = clone(f.data.get(META));
    parts = clone([...f.data].filter(([key]) => key.startsWith(CACHE + '/')));
    afterWinner = f.calls.length;
  };
  assert.equal((await rebuildOverall(f.env, true)).rebuilt, true);
  assert.deepEqual(f.data.get(META), winner);
  assert.deepEqual([...f.data].filter(([key]) => key.startsWith(CACHE + '/')), parts);
  assert.deepEqual(winner.entitlementInvalidations.accountIds, ['r0000']);
  assert.equal(f.data.get(ENT + '/r0000').serverIssued.beta.source, 'open-beta-release');
  assert.equal(f.calls.slice(afterWinner).filter(call => call.path === '/' + META).length, 0);
  assert.equal(winner.overallRebuildFailureAttempts, undefined);
  const start = f.calls.length;
  await rebuildOverall({...f.env});
  assert.equal(reads(f.calls.slice(start), ENT), 1);
});

test('administrator mutation between publication and refinement retains stale CAS, never a fabricated fresh version', async t => {
  t.mock.method(Date, 'now', () => AT);
  const f = fixture(3); let edited;
  f.beforeCommit = async writes => {
    if (!isRefinement(writes)) return;
    f.beforeCommit = null;
    edited = adminBeta(f);
  };
  await rebuildOverall(f.env, true);
  assert.equal((await cachedRows(f)).get('r0000').updateTime, 'v1');
  assert.deepEqual(f.data.get(ENT + '/r0000'), edited);
  changeRacerWeight(f);
  await assert.rejects(rebuildOverall({...f.env}), /FIRESTORE_409/);
  assert.deepEqual(f.data.get(ENT + '/r0000'), edited);
});

test('24h active cold builds adding one racer each half hour avoid rereading changed existing allowances', async t => {
  let now = AT; t.mock.method(Date, 'now', () => now);
  const f = fixture(531); await rebuildOverall(f.env, true);
  let canonicalReads = 0, companionReads = 0, baseline = 0, lastAudit = AT;
  const initialRefinements = f.refinementAttempts;
  for (let step = 1; step <= 48; step++) {
    now = AT + step * 30 * 60 * 1000; addRacer(f, 'new-' + step);
    const start = f.calls.length;
    await rebuildOverall({...f.env});
    const count = reads(f.calls.slice(start), ENT);
    assert.equal(count, step % 12 === 0 ? 531 + step : 1);
    canonicalReads += count; companionReads += reads(f.calls.slice(start), CACHE); baseline += 531 + step;
    if (step % 12 === 0) lastAudit = now;
    assert.equal(f.data.get(META).entitlementAuditedAt, lastAudit);
  }
  assert.equal(canonicalReads, 2288); assert.equal(companionReads, 44); assert.equal(baseline, 26664);
  assert.equal(f.refinementAttempts - initialRefinements, 48);
  console.log('Active new-racer 24h measured documents', JSON.stringify({baseline, canonical: canonicalReads,
    companion: companionReads, total: canonicalReads + companionReads, extraRefinementWrites: 48 * 2}));
});
