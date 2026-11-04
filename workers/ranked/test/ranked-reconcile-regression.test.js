import assert from 'node:assert/strict';
import test from 'node:test';
import {reconcileCanonicalChanges} from '../src/index.js';
import {eventEncode as encode, eventDecode as decode} from '../src/events-store.js';
import {verificationKey, VERIFICATION_COLLECTION} from '../src/verification.js';

const base = 'projects/polytrack-052/databases/(default)/documents/';
const jobPath = '0.6.2_s1_worker_jobs/canonical_reconcile_v2';
const results = '0.6.2_race_results';
const boards = '0.6.2_s1_leaderboards_track';
const now = 1_800_000_000_000;
const row = (trackId, accountId = 'current-racer') => ({accountId, trackId,
  timeMs: 12000, frames: 12000, raceTimeFrames: 12000, replay: 'r', uploadId: 1});
const resultId = r => `${r.accountId}_${r.trackId}`;
const board = trackId => ({trackId, entries: [], complete: true, totalEntries: 0,
  revision: 1, schemaVersion: 6, algorithmVersion: 'participation-v8-s1', signature: 'empty'});

function fixture({tracks, discover = false, failing = new Set()}) {
  const data = new Map(), calls = [], queries = [], commits = [];
  const versions = new Map();
  const wire = (key, value = data.get(key)) => ({name: base + key,
    fields: encode(value).mapValue.fields, updateTime: `v${versions.get(key) || 0}`});
  for (const track of tracks) {
    data.set(`${boards}/${track}`, board(track));
    for (const account of ['current-racer', 'legacy-racer']) {
      const r = row(track, account);
      data.set(`${results}/${resultId(r)}`, r);
    }
  }
  data.set(jobPath, {backfillComplete: !discover, schemaVersion: 2,
    cursorIngestedAt: '2026-10-13T00:00:00Z', pendingTrackIds: discover ? [] : tracks,
    pendingResultIds: discover ? {} : Object.fromEntries(tracks.map(t => [t, [resultId(row(t))]])),
    pendingFullRebuildTrackIds: [], failedFullRebuilds: {},
    pendingResultBindings:discover ? {} : Object.fromEntries(tracks.map(t=>[resultId(row(t)),verificationKey(row(t))]))});
  let discovered = false, backfilled = false;
  const env = {__TEST_FIRESTORE: async (path, init = {}) => {
    calls.push(path);
    if (path === ':runQuery') {
      const query = JSON.parse(init.body).structuredQuery;
      queries.push(query);
      assert.equal(query.from[0].collectionId, results);
      const field = query.where?.fieldFilter?.field.fieldPath;
      if (field === 'trackId') {
        const track = query.where.fieldFilter.value.stringValue;
        assert.equal(query.limit, 100, 'fallback scan remains bounded');
        if (failing.has(track)) throw Error('FIRESTORE_503');
        const after=query.startAt?.values?.[0]?.referenceValue || '';
        return [...data].filter(([key, value]) => key.startsWith(results + '/') && value.trackId === track)
          .filter(([key])=>base+key>after).sort(([a],[b])=>a.localeCompare(b)).slice(0,query.limit)
          .map(([key, value]) => ({document: wire(key, value)}));
      }
      if (discover && field === 'ingestedAt' && !discovered) {
        discovered = true;
        return tracks.map(track => {
          const document = wire(`${results}/${resultId(row(track))}`);
          document.fields.ingestedAt = {timestampValue: '2026-10-14T00:00:00Z'};
          return {document};
        });
      }
      if (discover && !field && !backfilled) {
        backfilled = true;
        return tracks.map(track => ({document: wire(`${results}/${resultId(row(track, 'legacy-racer'))}`)}));
      }
      return [];
    }
    if (path === ':batchGet') return JSON.parse(init.body).documents.map(name => {
      const key = name.slice(base.length);
      return data.has(key) ? {found: wire(key)} : {missing: name};
    });
    if (path === ':commit') {
      const writes = JSON.parse(init.body).writes;
      for (const write of writes) {
        const key = write.update.name.slice(base.length);
        assert.deepEqual(write.currentDocument, data.has(key)
          ? {updateTime: `v${versions.get(key) || 0}`} : {exists: false});
      }
      commits.push(writes);
      for (const write of writes) {
        const key = write.update.name.slice(base.length);
        data.set(key, decode({mapValue: {fields: write.update.fields}}));
        versions.set(key, (versions.get(key) || 0) + 1);
      }
      return {};
    }
    assert.ok(path.startsWith('/'), `unexpected request ${path}`);
    return data.has(path.slice(1)) ? wire(path.slice(1)) : null;
  }};
  return {env, data, calls, queries, commits, failing, job: () => data.get(jobPath)};
}

const sourceScans = f => f.queries.filter(q => q.where?.fieldFilter?.field.fieldPath === 'trackId').length;
function assertWaitingProofs(f, track, accounts) {
  const entries=f.data.get(`${boards}/${track}`).entries;
  assert.deepEqual(entries.map(entry=>entry.accountId).sort(),[...accounts].sort());
  for(const account of accounts){
    const entry=entries.find(entry=>entry.accountId===account);
    const slot=f.data.get(`${VERIFICATION_COLLECTION}/${track}`).slots[account];
    assert.equal(entry.timeMs,row(track,account).timeMs);
    assert.equal(entry.runVerified,false,'queue progress cannot fabricate verified credit');
    assert.equal(entry.integrityVerified,false,'this fixture has no valid replay hash');
    assert.equal(slot.key,verificationKey(row(track,account)));
    assert.equal(slot.status,'waiting','missing proof remains queued for verification');
  }
}
async function drainRetainedTargets(f, failed = []) {
  for (let pass=0;pass<20;pass++) {
    if (f.job().pendingTrackIds.every(id=>failed.includes(id))) return;
    const before=sourceScans(f);
    await reconcileCanonicalChanges(f.env,{scanResults:false,now:now+100+pass});
    assert.ok(sourceScans(f)-before<=1,'every invocation retains the one-full-build allowance');
  }
  assert.fail('non-cooling retained targets must make bounded progress');
}

test('legacy backfill keeps full-publication work across one-full-build passes', async () => {
  const tracks = Array.from({length: 5}, (_, i) => `backfill-track-${i}`);
  const f = fixture({tracks, discover: true});
  await reconcileCanonicalChanges(f.env, {now});
  assert.equal(f.job().backfillComplete, true);
  assert.deepEqual([...f.job().pendingTrackIds].sort(), [...tracks].sort());
  assert.deepEqual(f.job().pendingFullRebuildTrackIds,tracks.slice(1));
  assert.deepEqual(f.job().pendingResultIds[tracks[0]],[resultId(row(tracks[0]))]);
  const cursors={cursorIngestedAt:f.job().cursorIngestedAt,cursorDocumentId:f.job().cursorDocumentId,
    backfillDocumentId:f.job().backfillDocumentId};
  for(let pass=1;pass<tracks.length;pass++) {
    const before=sourceScans(f),callStart=f.calls.length;
    const result=await reconcileCanonicalChanges(f.env, {scanResults:false,now:now+pass});
    assert.equal(sourceScans(f)-before,1);
    assert.equal(result.targeted,1,'the previous completed track gets its fresh keyed pass while the next full build progresses');
    assert.equal(f.job().pendingResultIds[tracks[pass-1]],undefined);
    assert.deepEqual(Object.keys(f.job().pendingResultIds).sort(),tracks.slice(pass).sort());
    for(const track of tracks.slice(pass))assert.deepEqual(f.job().pendingResultIds[track],[resultId(row(track))]);
    assert.deepEqual([...f.job().pendingTrackIds].sort(),tracks.slice(pass).sort());
    assert.deepEqual(f.job().pendingFullRebuildTrackIds,tracks.slice(pass+1));
    assert.ok(f.calls.slice(callStart).includes(`/${VERIFICATION_COLLECTION}/${tracks[pass-1]}`),'keyed discharge reads the current proof queue');
    assertWaitingProofs(f,tracks[pass-1],['current-racer','legacy-racer']);
    for(const [key,value] of Object.entries(cursors))assert.equal(f.job()[key],value);
  }
  const published = f.data.get(`${boards}/${tracks[4]}`);
  assert.deepEqual(published.entries.map(r => r.accountId).sort(), ['current-racer', 'legacy-racer'],
    'the deferred track must include historical racers, not only the changed-result row');
  assert.deepEqual(f.job().pendingFullRebuildTrackIds, []);
  assert.deepEqual(f.job().pendingTrackIds,[tracks.at(-1)],'only the last completed full snapshot still awaits its fresh keyed pass');
  assert.deepEqual(f.job().pendingResultIds,{[tracks.at(-1)]:[resultId(row(tracks.at(-1))) ]});
  const scans=sourceScans(f);
  await drainRetainedTargets(f);
  assert.equal(sourceScans(f),scans,'draining the last retained target must not repeat a full scan');
  assert.deepEqual(f.job().pendingTrackIds, []);
  assert.deepEqual(f.job().pendingResultIds, {});
  assert.deepEqual(f.job().pendingResultBindings,{});
  for(const track of tracks)assertWaitingProofs(f,track,['current-racer','legacy-racer']);
  assert.equal(f.queries.filter(q => q.where?.fieldFilter?.field.fieldPath === 'trackId').length, 5);
});

test('failed targeted fallback performs only the job read during cooldown and retries the full publication', async () => {
  const track = 'failed-targeted-track';
  const f = fixture({tracks: [track], failing: new Set([track])});
  f.data.get(`${boards}/${track}`).schemaVersion = 5;
  await reconcileCanonicalChanges(f.env, {scanResults: false, now});
  const retryAt = f.job().failedFullRebuilds[track].retryAt;
  assert.equal(retryAt, now + 15 * 60 * 1000);
  const callCount = f.calls.length, commitCount = f.commits.length;
  for (const delta of [1, 5 * 60 * 1000, 10 * 60 * 1000]) {
    await reconcileCanonicalChanges(f.env, {scanResults: false, now: now + delta});
  }
  assert.deepEqual(f.calls.slice(callCount), Array(3).fill('/' + jobPath),
    'cooling fallback must not batch-read canonical IDs or reread the stale board');
  assert.equal(f.commits.length, commitCount, 'no cooldown heartbeat writes');
  assert.deepEqual(f.job().pendingResultIds[track], [resultId(row(track))]);
  f.failing.delete(track);
  await reconcileCanonicalChanges(f.env, {scanResults: false, now: retryAt});
  assert.equal(f.data.get(`${boards}/${track}`).entries.length, 2);
  assert.deepEqual(f.job().pendingTrackIds, [track]);
  assert.deepEqual(f.job().pendingResultIds[track],[resultId(row(track))]);
  assert.equal(f.job().pendingResultBindings[resultId(row(track))],verificationKey(row(track)));
  assert.deepEqual(f.job().pendingFullRebuildTrackIds, []);
  assert.deepEqual(f.job().failedFullRebuilds, {});
  const scans=sourceScans(f);
  await reconcileCanonicalChanges(f.env,{scanResults:false,now:retryAt+1});
  assert.equal(sourceScans(f),scans,'follow-up is keyed, not a second full rebuild');
  assert.deepEqual(f.job().pendingTrackIds, []);
  assert.deepEqual(f.job().pendingResultBindings, {});
});

test('cooling targeted fallbacks yield all four selection slots to healthy publications', async () => {
  const cooling = Array.from({length: 4}, (_, i) => `cooling-track-${i}`);
  const f = fixture({tracks: cooling, failing: new Set(cooling)});
  for (const track of cooling) f.data.get(`${boards}/${track}`).schemaVersion = 5;
  for (let pass = 0; pass < cooling.length; pass++)
    await reconcileCanonicalChanges(f.env, {scanResults: false, now});
  const healthy = 'healthy-track';
  f.data.set(`${boards}/${healthy}`, board(healthy));
  f.data.set(`${results}/${resultId(row(healthy))}`, row(healthy));
  f.job().pendingTrackIds.push(healthy);
  f.job().pendingResultIds[healthy] = [resultId(row(healthy))];
  await reconcileCanonicalChanges(f.env, {scanResults: false, now: now + 1});
  assert.equal(f.data.get(`${boards}/${healthy}`).entries.length, 1);
  assert.deepEqual(f.job().pendingTrackIds, cooling);
});

for (const fails of [false, true]) test(`targeted fallbacks share one full-build attempt, failure=${fails}`, async () => {
  const tracks = Array.from({length:4}, (_, i) => `stale-track-${i}`);
  const f = fixture({tracks, failing:new Set(fails ? [tracks[0]] : [])});
  for (const track of tracks) f.data.get(`${boards}/${track}`).schemaVersion = 5;
  await reconcileCanonicalChanges(f.env, {scanResults:false, now});
  const scans = () => f.queries.filter(q => q.where?.fieldFilter?.field.fieldPath === 'trackId');
  assert.equal(scans().length, 1, 'failed attempts also consume the shared allowance');
  assert.deepEqual(f.job().pendingFullRebuildTrackIds, fails ? tracks : []);
  assert.deepEqual([...f.job().pendingTrackIds].sort(), [...tracks].sort());
  for (const track of tracks.slice(1)) {
    assert.deepEqual(f.job().pendingResultIds[track], [resultId(row(track))]);
    assert.equal(f.job().pendingResultBindings[resultId(row(track))],verificationKey(row(track)));
    assert.equal(f.job().failedFullRebuilds[track], undefined, 'budget deferral is not a failure');
    assert.equal(f.data.get(`${boards}/${track}`).schemaVersion, 5, 'deferred publication is untouched');
  }
  for (let pass = 1; pass < tracks.length; pass++) {
    await reconcileCanonicalChanges(f.env, {scanResults:false, now:now+pass});
    assert.equal(scans().length, pass+1, 'each later invocation advances one queued full rebuild');
  }
  await drainRetainedTargets(f,fails ? [tracks[0]] : []);
  assert.equal(scans().length,tracks.length,'retained keyed work never restarts completed full scans');
  assert.deepEqual(f.job().pendingTrackIds, fails ? [tracks[0]] : []);
});

test('known full build and newly discovered fallback share the same allowance', async () => {
  const tracks = ['known-full', 'new-fallback', 'healthy-target'];
  const f = fixture({tracks});
  f.job().pendingFullRebuildTrackIds = [tracks[0]];
  f.data.get(`${boards}/${tracks[1]}`).schemaVersion = 5;
  const first=await reconcileCanonicalChanges(f.env, {scanResults:false, now});
  assert.equal(f.queries.filter(q => q.where?.fieldFilter?.field.fieldPath === 'trackId').length, 1);
  assert.equal(first.targeted,1);
  assert.equal(first.rebuilt,2,'healthy target and reserved full build both progress');
  assert.deepEqual([...f.job().pendingTrackIds].sort(),tracks.slice(0,2).sort());
  assert.deepEqual(f.job().pendingFullRebuildTrackIds,[tracks[1]],'new fallback retains full intent without taking the reserved turn');
  assert.deepEqual(f.job().pendingResultIds,Object.fromEntries(tracks.slice(0,2).map(track=>[track,[resultId(row(track))]])));
  assert.deepEqual(f.job().pendingResultBindings,Object.fromEntries(tracks.slice(0,2).map(track=>[resultId(row(track)),verificationKey(row(track))])));
  assertWaitingProofs(f,tracks[2],['current-racer']);
  assertWaitingProofs(f,tracks[0],['current-racer','legacy-racer']);
  assert.equal(f.data.get(`${boards}/${tracks[1]}`).schemaVersion,5,'deferred fallback remains untouched');
  assert.equal(f.data.has(`${VERIFICATION_COLLECTION}/${tracks[1]}`),false);
  assert.deepEqual(f.job().failedFullRebuilds,{},'capacity deferral must not create failure backoff');
  const second=await reconcileCanonicalChanges(f.env,{scanResults:false,now:now+1});
  assert.equal(second.targeted,1,'known full build gets its keyed follow-up while the fallback completes');
  assert.deepEqual(f.job().pendingFullRebuildTrackIds,[]);
  assert.deepEqual(f.job().pendingTrackIds,[tracks[1]]);
  assert.deepEqual(f.job().pendingResultBindings,{[resultId(row(tracks[1]))]:verificationKey(row(tracks[1]))});
  assertWaitingProofs(f,tracks[1],['current-racer','legacy-racer']);
  const third=await reconcileCanonicalChanges(f.env,{scanResults:false,now:now+2});
  assert.equal(third.targeted,1);
  assert.equal(sourceScans(f),2,'only known-full and new-fallback need full scans');
  assert.deepEqual(f.queries.map(q=>q.where.fieldFilter.value.stringValue),tracks.slice(0,2));
  assertWaitingProofs(f,tracks[2],['current-racer']);
  assert.deepEqual(f.job().pendingTrackIds,[]);
  assert.deepEqual(f.job().pendingResultIds,{});
  assert.deepEqual(f.job().pendingResultBindings,{});
});
