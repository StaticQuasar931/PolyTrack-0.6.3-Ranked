import test from 'node:test';
import assert from 'node:assert/strict';
import {Socket} from 'node:net';
import {execFileSync} from 'node:child_process';
import {eventEncode, eventDecode} from '../src/events-store.js';
import {preparePublicationPages, PUBLIC_PAGE_COLLECTION} from '../src/paged-publication.js';
import {trackBuildId} from '../src/track-build.js';

// Optional read-only comparison against the pre-fix committed Worker.
const baseline = process.env.OBSOLETE_IDENTITY_BASELINE === '1';
const api = baseline
  ? await import('data:text/javascript,' + encodeURIComponent(execFileSync('git',
    ['show', '999777064f2b9ab1c24c1c307bef0ac810e2dc5c:workers/ranked/src/index.js'], {encoding:'utf8'})
    .replace(/from '(\.\/[^']+)'/g, (_, path) => `from '${new URL('../src/' + path.slice(2), import.meta.url).href}'`)))
  : await import('../src/index.js');
const {updateTrackIdentity} = api;
const trackId = '5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038';
const base = 'projects/offline-identity/databases/(default)/documents/';
const boards = '0.6.2_s1_leaderboards_track', jobs = '0.6.2_s1_worker_jobs';
const boardKey = boards + '/' + trackId, buildKey = jobs + '/' + trackBuildId(trackId);
const queueKey = jobs + '/canonical_reconcile_v2', metaKey = '0.6.2_s1_release_meta/current';
const now = Date.UTC(2026, 10, 5, 12);
const counts = f => ({reads:f.stats.reads, requests:f.stats.requests, writes:f.stats.writes});
const difference = (a, b) => Object.fromEntries(Object.keys(a).map(key => [key, a[key] - b[key]]));

async function fixture(t) {
  const blocked = () => assert.fail('network forbidden');
  t.mock.method(globalThis, 'fetch', blocked);
  t.mock.method(Socket.prototype, 'connect', blocked);
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'log', () => {});
  const data = new Map(), versions = new Map(), reads = [], commits = [];
  const stats = {reads:0, requests:0, writes:0};
  let serial = 0;
  const set = (key, value) => {
    data.set(key, structuredClone(value));
    versions.set(key, 'v' + ++serial);
  };
  const wire = key => ({name:base + key, updateTime:versions.get(key),
    fields:eventEncode(data.get(key)).mapValue.fields});
  const read = key => {stats.reads++; reads.push(key); return data.has(key) ? wire(key) : null;};
  const env = {FIREBASE_PROJECT_ID:'offline-identity', BACKGROUND_MAINTENANCE_MODE:'coordinated', __TEST_FIRESTORE:async (path, init = {}) => {
    stats.requests++;
    const body = init.body ? JSON.parse(init.body) : null;
    if (path === ':runQuery') {
      assert.equal(body.structuredQuery.from[0].collectionId, jobs);
      assert.equal(body.structuredQuery.limit, 1);
      stats.reads++;
      if (body.structuredQuery.where.fieldFilter.field.fieldPath === 'profileRetryAt') return [];
      const key = [...data.keys()].find(key => key.startsWith(jobs + '/') && data.get(key).active === true);
      return key ? [{document:wire(key)}] : [];
    }
    if (path === ':batchGet') return body.documents.map(name => {
      const key = name.slice(base.length), found = read(key);
      return found ? {found} : {missing:name};
    });
    if (path === ':commit') {
      for (const w of body.writes) {
        assert.ok(w.update, 'no deletes');
        const key = w.update.name.slice(base.length);
        if (w.currentDocument) assert.deepEqual(w.currentDocument,
          data.has(key) ? {updateTime:versions.get(key)} : {exists:false}, 'fresh CAS');
        else assert.ok(key.startsWith(PUBLIC_PAGE_COLLECTION + '/') || key.startsWith('0.6.2_s1_public_manifests/'),
          'only immutable publication artifacts omit CAS');
      }
      commits.push(structuredClone(body.writes));
      const writeResults = body.writes.map(w => {
        const key = w.update.name.slice(base.length);
        set(key, eventDecode({mapValue:{fields:w.update.fields}})); stats.writes++;
        return {updateTime:versions.get(key)};
      });
      return {writeResults};
    }
    assert.equal(init.method || 'GET', 'GET');
    assert.ok(path.startsWith('/'), 'no unbounded query or unexpected transport');
    return read(decodeURIComponent(path.slice(1)));
  }};
  const entries = Array.from({length:1136}, (_, i) => ({accountId:'r' + String(i).padStart(4, '0'),
    trackId, rank:i + 1, timeMs:10000 + i, pbAt:1000, uploadId:1, replayHash:'a'.repeat(64),
    integrityVerified:true, runVerified:true, name:'Racer ' + i, countryCode:'US',
    identityUpdatedAt:1000, rp:100, participationRp:100}));
  const pages = await preparePublicationPages('track', trackId, entries, {sourceRevision:1, sourceComplete:true});
  for (const doc of pages.documents) set(doc.collection + '/' + doc.id, doc.data);
  set(boardKey, {trackId, entries:entries.slice(0,500), pagination:pages.pagination,
    totalEntries:entries.length, sourceComplete:true, complete:false, revision:1, sourceRevision:1,
    schemaVersion:6, algorithmVersion:'participation-v8-s1', signature:'initial'});
  set(metaKey, {dirty:false, revision:1, builtRevision:1});
  set(queueKey, {backfillComplete:true, pendingTrackIds:[], pendingFullRebuildTrackIds:[]});
  const identity = {accountId:entries[0].accountId, name:'Current Racer', countryCode:'US',
    profileCosmetics:{version:1, theme:'cyan'}, identityUpdatedAt:now};
  // Include a real, CAS-guarded identity publication in the whole-fixture costs.
  assert.equal((await updateTrackIdentity(env, trackId, identity)).changed, true);
  const state = () => structuredClone([...data]);
  return {env, data, versions, stats, reads, commits, set, identity, state,
    pageKeys:() => Array.from({length:12}, (_, page) => PUBLIC_PAGE_COLLECTION + '/track_' + trackId + '_' + data.get(boardKey).pagination.generation + '_' + page)};
}

test('obsolete inline identity: complete 1136-racer fixture and isolated rejection costs', async t => {
  const f = await fixture(t), before = counts(f), state = f.state(), readStart = f.reads.length;
  const result = await updateTrackIdentity(f.env, trackId, {...f.identity, identityUpdatedAt:now - 1});
  assert.equal(result.changed, false); assert.equal(result.superseded, true);
  assert.equal(result.revision, f.data.get(boardKey).revision);
  assert.deepEqual(before, {reads:15, requests:6, writes:15});
  assert.deepEqual(counts(f), {reads:baseline ? 29 : 17, requests:baseline ? 9 : 8, writes:15});
  assert.deepEqual(f.state(), state, 'root, meta, jobs, proofs and immutable artifacts unchanged');
  assert.deepEqual(difference(counts(f), before), {reads:baseline ? 14 : 2, requests:baseline ? 3 : 2, writes:0});
  assert.equal(f.reads.slice(readStart).filter(key => key.startsWith(PUBLIC_PAGE_COLLECTION + '/')).length, baseline ? 12 : 0);
  if (!baseline) assert.equal(Object.hasOwn(result, 'entries'), false, 'never label the inline prefix as a complete field');
  process.stdout.write('OBSOLETE_IDENTITY_COST ' + JSON.stringify({baseline, setup:before,
    rejection:difference(counts(f), before), fullFixture:counts(f)}) + '\n');
});

for (const mode of ['equal', 'newer', 'missing', 'unsafe', 'zero', 'negative'])
test('uncertain or nonobsolete incoming timestamp retains full hydration: ' + mode, async t => {
  const f = await fixture(t), start = f.reads.length;
  const identity = {...f.identity, name:'Changed Racer', identityUpdatedAt:
    ({equal:now, newer:now + 1, missing:undefined, unsafe:Number.MAX_SAFE_INTEGER + 1, zero:0, negative:-1})[mode]};
  if (mode === 'unsafe') {
    await assert.rejects(updateTrackIdentity(f.env, trackId, identity), /Unsafe Firestore integer/);
    assert.equal(f.reads.slice(start).filter(key => key.startsWith(PUBLIC_PAGE_COLLECTION + '/')).length, 12);
    return;
  }
  const result = await updateTrackIdentity(f.env, trackId, identity);
  assert.equal(result.superseded, undefined);
  assert.equal(result.changed, true);
  assert.equal(f.reads.slice(start).filter(key => key.startsWith(PUBLIC_PAGE_COLLECTION + '/')).length, 12);
});

for (const mode of ['outside-prefix', 'absent', 'invalid-account'])
test('inline absence never proves full-field absence: ' + mode, async t => {
  const f = await fixture(t), start = f.reads.length;
  const accountId = mode === 'outside-prefix' ? 'r1000' : mode === 'absent' ? 'not-present' : '';
  const result = await updateTrackIdentity(f.env, trackId, {...f.identity, accountId, identityUpdatedAt:999});
  assert.equal(f.reads.slice(start).filter(key => key.startsWith(PUBLIC_PAGE_COLLECTION + '/')).length, 12);
  if (mode === 'outside-prefix') assert.equal(result.superseded, true);
  else assert.equal(result.changed, false);
});

for (const mode of ['missing', 'unsafe'])
test('uncertain stored timestamp retains page checks: ' + mode, async t => {
  const f = await fixture(t), root = structuredClone(f.data.get(boardKey));
  if (mode === 'missing') delete root.entries[0].identityUpdatedAt;
  else root.entries[0].identityUpdatedAt = String(Number.MAX_SAFE_INTEGER + 1);
  f.set(boardKey, root);
  f.data.delete(f.pageKeys()[0]);
  await assert.rejects(updateTrackIdentity(f.env, trackId, {...f.identity, identityUpdatedAt:now - 1}), /PUBLIC_PAGE_INCOMPLETE/);
});

for (const mode of ['schema', 'incomplete', 'page-size', 'page-count', 'generation'])
test('invalid root metadata cannot authorize shortcut: ' + mode, async t => {
  const f = await fixture(t), root = structuredClone(f.data.get(boardKey));
  if (mode === 'schema') root.schemaVersion = 0;
  if (mode === 'incomplete') root.sourceComplete = false;
  if (mode === 'page-size') root.pagination.pageSize = 99;
  if (mode === 'page-count') root.pagination.pageCount++;
  if (mode === 'generation') root.pagination.generation = 'invalid';
  f.set(boardKey, root);
  const identity = {...f.identity, identityUpdatedAt:now - 1};
  if (mode === 'schema' || mode === 'incomplete') {
    const result = await updateTrackIdentity(f.env, trackId, identity, {fullRebuildAttempted:true});
    assert.equal(result.pending, true); assert.equal(result.superseded, undefined);
  } else await assert.rejects(updateTrackIdentity(f.env, trackId, identity), /INVALID_PUBLIC_PAGE|PUBLIC_MANIFEST_INVALID/);
});

test('required identity update still fails closed on missing pages', async t => {
  const f = await fixture(t); f.data.delete(f.pageKeys()[0]);
  await assert.rejects(updateTrackIdentity(f.env, trackId, {...f.identity, identityUpdatedAt:now + 1}), /PUBLIC_PAGE_INCOMPLETE/);
});

for (const mode of ['live-owned', 'expired', 'unowned', 'base-changed', 'blocked', 'complete'])
test('build ownership and expiry guards remain ahead of rejection: ' + mode, async t => {
  const f = await fixture(t), start = counts(f);
  f.set(buildKey, {complete:mode === 'complete', blocked:mode === 'blocked',
    baseVersion:mode === 'base-changed' ? 'other' : f.versions.get(boardKey),
    readTime:new Date(now - (mode === 'expired' ? 51 : 1) * 60000).toISOString()});
  f.set(queueKey, {activeFullRebuildTrackId:mode === 'unowned' ? 'other' : trackId,
    pendingFullRebuildTrackIds:[trackId]});
  const state = f.state();
  const result = await updateTrackIdentity(f.env, trackId, {...f.identity, identityUpdatedAt:now - 1});
  if (mode === 'live-owned') {
    assert.equal(result.reason, 'active_track_build_identity');
    assert.equal(result.pending, true); assert.equal(result.superseded, undefined);
    assert.equal(f.stats.reads - start.reads, 3);
  } else assert.equal(result.superseded, true);
  assert.deepEqual(f.state(), state); assert.equal(f.stats.writes, start.writes);
});

test('fresh root is reread on the next invocation, not cached authority', async t => {
  const f = await fixture(t);
  await updateTrackIdentity(f.env, trackId, {...f.identity, identityUpdatedAt:now - 1});
  const root = structuredClone(f.data.get(boardKey));
  root.entries[0].identityUpdatedAt = now - 2; f.set(boardKey, root);
  f.data.delete(f.pageKeys()[0]);
  await assert.rejects(updateTrackIdentity(f.env, trackId, {...f.identity, identityUpdatedAt:now - 1}), /PUBLIC_PAGE_INCOMPLETE/);
});

test('scheduled obsolete job completes durably and clean follow-up includes all costs', async t => {
  const f = await fixture(t), key = jobs + '/profile_' + f.identity.accountId;
  f.set(key, {kind:'profile', active:true, accountId:f.identity.accountId,
    identity:{...f.identity, identityUpdatedAt:now - 1}, pendingTrackIds:[trackId],
    trackDiscovery:{version:1, complete:true, cursor:''}, processed:0, changed:0});
  const before = counts(f), root = structuredClone(f.data.get(boardKey));
  const meta = structuredClone(f.data.get(metaKey)), queue = structuredClone(f.data.get(queueKey));
  const turn = async () => {
    let done;
    api.default.scheduled({cron:'2-59/5 * * * *', scheduledTime:420000}, f.env, {waitUntil:p => {done = p;}});
    await done;
  };
  await turn();
  const job = f.data.get(key);
  assert.equal(job.active, false); assert.equal(job.processed, 1); assert.equal(job.changed, 0);
  assert.deepEqual(job.pendingTrackIds, []);
  assert.deepEqual(f.data.get(boardKey), root); assert.deepEqual(f.data.get(metaKey), meta);
  assert.deepEqual(f.data.get(queueKey), queue);
  assert.deepEqual(difference(counts(f), before), {reads:baseline ? 15 : 4, requests:5, writes:1});
  const after = counts(f); await turn();
  assert.deepEqual(difference(counts(f), after), {reads:baseline ? 1 : 2, requests:baseline ? 1 : 2, writes:0});
  assert.deepEqual(counts(f), {reads:baseline ? 31 : 21, requests:baseline ? 12 : 13, writes:16});
  process.stdout.write('OBSOLETE_IDENTITY_SCHEDULED_COST ' + JSON.stringify({baseline, setup:before,
    completion:difference(after, before), cleanFollowup:difference(counts(f), after), fullFixture:counts(f)}) + '\n');
});

for (const mode of ['missing-update-time', 'wrong-track', 'short-prefix'])
test('uncertain inline provenance falls back to full pages: ' + mode, async t => {
  const f = await fixture(t), root = structuredClone(f.data.get(boardKey));
  if (mode === 'wrong-track') root.trackId = 'other-track';
  if (mode === 'short-prefix') root.entries = root.entries.slice(0, 100);
  f.set(boardKey, root);
  if (mode === 'missing-update-time') f.versions.delete(boardKey);
  const before = counts(f), state = f.state();
  const result = await updateTrackIdentity(f.env, trackId, {...f.identity, identityUpdatedAt:now - 1});
  assert.equal(result.superseded, true);
  assert.deepEqual(difference(counts(f), before), {reads:14, requests:3, writes:0});
  assert.deepEqual(f.state(), state);
});

test('noncoordinated obsolete rejection also uses fresh root without page hydration', async t => {
  const f = await fixture(t); delete f.env.BACKGROUND_MAINTENANCE_MODE;
  const before = counts(f), state = f.state();
  assert.equal((await updateTrackIdentity(f.env, trackId, {...f.identity, identityUpdatedAt:now - 1})).superseded, true);
  assert.deepEqual(difference(counts(f), before), {reads:baseline ? 13 : 1, requests:baseline ? 2 : 1, writes:0});
  assert.deepEqual(f.state(), state);
});
