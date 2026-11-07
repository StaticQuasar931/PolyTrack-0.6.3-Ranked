import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';

const source = fs.readFileSync(new URL('../polytrack_062_patch.js', import.meta.url), 'utf8');
const SELF = 'a'.repeat(64), RIVAL = 'b'.repeat(64), TRACK = 'c'.repeat(64), OTHER = 'd'.repeat(64);
function extract(name) {
  const start = source.search(new RegExp('^ *(?:async )?function ' + name + '\\(', 'm'));
  assert.ok(start >= 0, name);
  const tail = source.slice(start);
  for (const match of tail.matchAll(/^ *}[^\n]*$/gm)) {
    const candidate = tail.slice(0, match.index + match[0].length);
    try { new vm.Script(candidate); return candidate; } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  }
  assert.fail('Incomplete function: ' + name);
}
const finish = (trackId = TRACK) => ({trackId, rank: 3, fieldSize: 10, timeMs: 15000, weight: 3});
const board = {complete: true, totalEntries: 10, updatedAt: 100,
  entries: Array.from({length: 10}, (_, i) => ({accountId: i === 2 ? SELF : 'synthetic-' + i, timeMs: 13000 + i * 1000, rank: i + 1}))};
function harness() {
  let now = 1000;
  const requests = [], saved = new Map();
  const c = vm.createContext({
    profileSnapshotEpoch: 0, plannerPublishedProfiles:new Map(), profileSnapshotResults: saved, profileSnapshotRequests: new Map(),
    profileSnapshotRetryAt: new Map(), profilePlacementRequests: new Map(), Date: {now: () => now},
    cleanUserId: value => String(value || ''), activeRankedAccountId: () => SELF,
    readLocalRaceRows: () => [{accountId: SELF, trackId: TRACK, timeMs: 15000}],
    readTrackSnapshotCache: () => null,
    readPublicSnapshotBackup: (kind, id) => { requests.push({kind, id}); return Promise.resolve(kind === 'track' ? board : {results: [finish(), finish(OTHER)]}); },
    visibleTrackEntries: rows => rows, localTrackDisplayEntries: (_id, rows) => rows,
    entryTimeMs: row => row.timeMs, pbTimestamp: () => 0, knownFinishWeight: () => 3,
  });
  for (const name of ['profileBoardIsComplete', 'loadProfileSnapshotResults', 'warmProfileLocalPlacements']) vm.runInContext(extract(name), c);
  return {c, saved, requests, advance: ms => { now += ms; }};
}

test('local-only warming does not suppress subsequent complete snapshot hydration', async () => {
  const h = harness();
  assert.equal(await h.c.warmProfileLocalPlacements(SELF), true);
  assert.equal(h.saved.get(SELF).results.length, 1);
  assert.equal(await h.c.loadProfileSnapshotResults(SELF), true);
  assert.equal(h.saved.get(SELF).results.length, 2);
  assert.equal(h.requests.filter(r => r.kind === 'profile-results').length, 1);
  assert.equal(await h.c.loadProfileSnapshotResults(SELF), false);
});

test('a missing snapshot retains retry backoff without making local results permanent', async () => {
  const h = harness(), read = h.c.readPublicSnapshotBackup;
  let available = false;
  h.c.readPublicSnapshotBackup = (kind, id) => kind === 'profile-results' && !available ? Promise.resolve(null) : read(kind, id);
  assert.equal(await h.c.loadProfileSnapshotResults(SELF), false);
  await h.c.warmProfileLocalPlacements(SELF);
  available = true;
  assert.equal(await h.c.loadProfileSnapshotResults(SELF), false);
  h.advance(15 * 60000);
  assert.equal(await h.c.loadProfileSnapshotResults(SELF), true);
  assert.equal(h.saved.get(SELF).results.length, 2);
});

test('an older placement warmup cannot overwrite a newly hydrated complete profile', async () => {
  const h = harness(), read = h.c.readPublicSnapshotBackup;
  let release;
  h.c.readPublicSnapshotBackup = (kind, id) => kind === 'track' ? new Promise(resolve => { release = resolve; }) : read(kind, id);
  const warm = h.c.warmProfileLocalPlacements(SELF);
  assert.equal(await h.c.loadProfileSnapshotResults(SELF), true);
  const complete = h.saved.get(SELF);
  release(board);
  assert.equal(await warm, false);
  assert.equal(h.saved.get(SELF), complete);
  assert.equal(complete.results.length, 2);
});

test('complete profiles stay cached after local placement warming', async () => {
  const h = harness();
  h.saved.set(SELF, {results: [finish(OTHER)]});
  assert.equal(await h.c.warmProfileLocalPlacements(SELF), true);
  assert.equal(h.saved.get(SELF).results.length, 2);
  assert.equal(await h.c.loadProfileSnapshotResults(SELF), false);
  assert.equal(h.requests.filter(r => r.kind === 'profile-results').length, 0);
});

test('partial-cache hydration coalesces requests and discards old-generation replies', async () => {
  const h = harness();
  await h.c.warmProfileLocalPlacements(SELF);
  let release, reads = 0;
  h.c.readPublicSnapshotBackup = () => { reads++; return new Promise(resolve => { release = resolve; }); };
  const first = h.c.loadProfileSnapshotResults(SELF), second = h.c.loadProfileSnapshotResults(SELF);
  assert.equal(reads, 1);
  assert.equal(first, second);
  h.c.profileSnapshotEpoch++;
  h.saved.clear();
  release({results: [finish(), finish(OTHER)]});
  assert.equal(await first, false);
  assert.equal(h.saved.size, 0);
});

test('warming another racer never imports the active account local results', async () => {
  const h = harness();
  assert.equal(await h.c.warmProfileLocalPlacements(RIVAL), false);
  assert.equal(h.saved.size, 0);
  assert.equal(h.requests.length, 0);
});

test('rival routes recover after partial self results hydrate, retaining the coverage guard', async () => {
  const h = harness();
  Object.assign(h.c, {plannerMetric: 'overall', PINNED_EXTRA_TRACK_IDS: new Set(), trackInfo: () => ({type: 'official'}), safeDisplayName: () => 'Synthetic rival'});
  vm.runInContext(source.slice(source.indexOf('// BEGIN PLANNER MODEL'),source.indexOf('// END PLANNER MODEL')),h.c);
  for (const name of ['rankedTrackWeightParts', 'rankedTrackWeight', 'rankedPlacementCost', 'medianNumber',
    'projectedOverallScore', 'projectedFinish', 'simulateRecommendation', 'recommendationSimulator', 'recommendationAction', 'rivalRecommendationAction']) vm.runInContext(extract(name), h.c);
  await h.c.warmProfileLocalPlacements(SELF);
  const target = {...finish(), rank: 1};
  const route = () => h.c.rivalRecommendationAction(finish(), target, {raceCount: 2}, {raceCount: 1}, h.saved.get(SELF).results, [target]);
  assert.equal(route(), null, 'incomplete inputs must not invent a route');
  assert.equal(await h.c.loadProfileSnapshotResults(SELF), true);
  const action = route();
  assert.ok(action && action.value > 0);
  assert.equal(action.simulationComplete, true);
});

test('full rival planner renders routes after local-only self hydration', async () => {
  const original = fs.readFileSync(new URL('./planner-filters.test.mjs', import.meta.url), 'utf8');
  const text = original.slice(original.indexOf('function harness('), original.indexOf('const finishes='));
  const routes = new Function('source', 'vm', 'rhr', text + ';return harness;')(source, vm, 'synthetic-permanent');
  const c = routes(false, false).context, h = harness();
  c.TRACK_CATALOG = new Map([TRACK, OTHER].map(id => [id, {id, type: 'official', name: 'Synthetic track'}]));
  c.trackInfo = id => c.TRACK_CATALOG.get(id);
  c.PINNED_EXTRA_TRACK_IDS = new Set();
  c.overallTrackSummariesCache = [finish(), finish(OTHER)];
  for (const name of ['rankedTrackWeightParts', 'rankedTrackWeight', 'knownFinishWeight', 'rankedPlacementCost', 'medianNumber',
    'projectedOverallScore', 'projectedFinish', 'simulateRecommendation', 'recommendationSimulator', 'recommendationAction',
    'rivalRecommendationAction', 'matchupPersonalAction', 'orderedPlannerRoutes']) vm.runInContext(extract(name), c);
  await h.c.warmProfileLocalPlacements(SELF);
  const theirs = [{...finish(), rank: 1}], self = {userId: SELF, raceCount: 2};
  const render = () => c.profileGuideMarkup({userId: RIVAL, name: 'Synthetic rival', raceCount: 1}, self, false, theirs, theirs, h.saved.get(SELF).results);
  c.plannerPublishedProfiles=h.c.plannerPublishedProfiles;
  c.activeRankedAccountId=()=>SELF;c.readLocalRaceRows=()=>[];
  c.loadProfileSnapshotResults=async()=>false;
  h.c.plannerPublishedProfiles.set(RIVAL,{epoch:0,profile:{results:theirs}});
  assert.doesNotMatch(await render(), /data-route=/);
  await h.c.loadProfileSnapshotResults(SELF);
  const html = await render();
  assert.match(html, /data-route=/);
  assert.match(html, /Results loaded/);
});

test('local packed snapshot profiles hydrate over local-only caches without board or network reads',
  {skip: !process.env.PT_PLANNER_SNAPSHOT_DIRECTORY}, async () => {
    const directory = process.env.PT_PLANNER_SNAPSHOT_DIRECTORY;
    const index = JSON.parse(fs.readFileSync(path.join(directory, 'index.json'), 'utf8'));
    let checked = 0;
    for (const [key, record] of Object.entries(index.files)) {
      if (!key.startsWith('profile-results/')) continue;
      const bytes = fs.readFileSync(path.join(directory, record.path));
      for (let i = 0; i < bytes.length; i++) bytes[i] ^= 0xa7;
      const profile = JSON.parse(gunzipSync(bytes));
      assert.ok(Array.isArray(profile.results), 'packed result list');
      const h = harness();
      await h.c.warmProfileLocalPlacements(SELF);
      let reads = 0;
      h.c.readPublicSnapshotBackup = async kind => {
        assert.equal(kind, 'profile-results');
        reads++;
        return profile;
      };
      assert.equal(await h.c.loadProfileSnapshotResults(SELF), true);
      assert.ok(h.saved.get(SELF) === profile, 'the complete object replaces the partial cache');
      assert.equal(await h.c.loadProfileSnapshotResults(SELF), false);
      assert.equal(reads, 1);
      checked++;
    }
    assert.ok(checked > 0, 'the local package must contain profiles');
  });
