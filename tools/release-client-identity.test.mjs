import createClientSourceRunner from './client-source-harness.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Set POLYTRACK_CLIENT_SOURCE to exercise a private patched copy before integration.
const source = fs.readFileSync(process.env.POLYTRACK_CLIENT_SOURCE || new URL('../polytrack_062_patch.js', import.meta.url), 'utf8');
const runClientSource=createClientSourceRunner(source);
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing source section: ${start}`);
  return source.slice(from, to);
}
function extract(name, optional = false) {
  const from = source.search(new RegExp(`^  (?:async )?function ${name}\\(`, 'm'));
  if (optional && from < 0) return '';
  assert.ok(from >= 0, `Missing function: ${name}`);
  const to = source.indexOf('\n  }', from);
  assert.ok(to > from, `Missing function end: ${name}`);
  return source.slice(from, to + 4);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
const plain = value => JSON.parse(JSON.stringify(value));
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const row = (id, timeMs = 20000) => ({userId: id, name: id, timeMs, timingVersion: 2});
const cached = (id, fetchedAt = 1000000) => ({entries: [row(id)], fetchedAt, serverUpdatedAt: 100, revision: 1, algorithmVersion: 'model'});
const board = (id, revision = 2) => ({entries: [row(id)], updatedAt: 200, revision, algorithmVersion: 'model', schemaVersion: 6, complete: true, totalEntries: 1});

function trackHarness(initial = {}, unranked = []) {
  const cache = new Map(Object.entries(initial)), metadata = [], loads = [], extraLoads = [], timers = [], repaints = [], classes = new Set(), visibility = [];
  const replayInvalidations = [];
  let account='one', host={visible:true};
  const context = vm.createContext({
    Date: {now: () => 1000000}, trackLoadGeneration: 0, currentTrackLoadState: {},
    invalidateNativePartialReplay: (...args) => replayInvalidations.push(args),
    TRACK_REFRESH_MS: 600000, TRACK_CACHE_SCHEMA: 6, RANK_MODEL: 'model', snapshotTrackStatistics: {},
    unrankedExtraTrackIds: new Set(unranked), publicSnapshotRetryAt: 0,
    readTrackSnapshotCache: id => cache.get(id) || null,
    writeTrackSnapshotCache: (id, entries, updatedAt, detail) => {
      cache.set(id, {...detail, entries, fetchedAt: 1000000, serverUpdatedAt: updatedAt}); return true;
    },
    readPublicSnapshotBackup: () => metadata.length ? metadata.shift().promise : Promise.resolve({}),
    fetchRankedSnapshot: (_kind, id, options) => { const pending = deferred(); loads.push({id, options, ...pending}); return pending.promise; },
    fetch: url => { const pending = deferred(); extraLoads.push({id: new URL(url).searchParams.get('trackId'), ...pending}); return pending.promise; },
    rankedBrokerUrl: () => 'https://example.test', AbortSignal: {timeout: () => undefined},
    document: {querySelector:()=>host,documentElement: {classList: {add: name => {visibility.push('hide');classes.add(name);}, remove: name => {visibility.push('show');classes.delete(name);}}}},
    activeRankedAccountId:()=>account,isElementVisible:node=>Boolean(node?.visible),
    setTimeout: (callback, delay) => { timers.push({callback, delay}); return timers.length; }, updateTrackFreshnessBanner: () => {},
    applyCanonicalTrackWeight: (_id, rows) => rows, canonicalRaceTimeMs: entry => entry.timeMs,
    computeTrackTopEntries: rows => rows, enrichLegacyLeaderboardEntries: rows => rows,
    canonicalDisplayName: (_id, name) => name, rowIdentityFreshness: () => 0,
    snapshotOnlyForNewAccount: () => true, db: () => { throw Error('Unexpected database access'); },
    noteFirebaseQuota: () => {}, localRaceRowsForTrack: () => [], ageLabel: () => 'old', log: () => {}
  });
  runClientSource(section('  const trackCloudRetryAt=new Map();', '  function computeOverallFromRaceRows('), context);
  context.scheduleNativeTrackSnapshotRefresh = id => repaints.push(id);
  return {
    context, cache, metadata, loads, extraLoads, repaints, timers, visibility, replayInvalidations,
    setAccount:value=>{account=value;},setHost:value=>{host=value;},
    get: (...args) => context.getTrackEntries(...args),
    state: () => plain(context.currentTrackLoadState),
    loading: () => classes.has('sq-track-leaderboard-loading'),
    flushLoading: () => {
      for (let i = 0; i < timers.length;) {
        if (timers[i].delay === 120) timers.splice(i, 1)[0].callback(); else i++;
      }
    }
  };
}
const resolveExtra = (pending, id) => pending.resolve({ok: true, json: async () => ({entries: [row(id)], updatedAt: 300})});

test('cached A metadata cannot reclaim selection after cached B', async () => {
  const h = trackHarness({A: cached('A'), B: cached('B')}), gate = deferred();
  h.metadata.push(gate);
  const a = h.get('A');
  assert.equal(h.state().trackId, 'A', 'claim the selection before awaiting metadata');
  await h.get('B');
  const generation = h.context.trackLoadGeneration;
  gate.resolve({}); await a;
  assert.equal(h.state().trackId, 'B'); assert.equal(h.context.trackLoadGeneration, generation);
  assert.equal(h.loads.length, 0); assert.equal(h.loading(), false);
  assert.deepEqual(h.replayInvalidations, [[], []], 'both selections invalidate replay work; stale metadata cannot invalidate again');
});

test('cached A -> B -> A ignores the first A continuation and rereads the latest cache', async () => {
  const h = trackHarness({A: cached('A'), B: cached('B')}), first = deferred(), last = deferred();
  h.metadata.push(first); const a1 = h.get('A');
  await h.get('B'); h.metadata.push(last); const a2 = h.get('A');
  const generation = h.context.trackLoadGeneration;
  first.resolve({}); await a1;
  assert.equal(h.context.trackLoadGeneration, generation); assert.equal(h.state().trackId, 'A');
  h.cache.set('A', {...cached('A-new'), revision: 2}); last.resolve({});
  assert.equal((await a2)[0].name, 'A-new'); assert.equal(h.loads.length, 0);
});

test('in-flight A -> B -> A reuses A while transferring state and loading ownership', async () => {
  const h = trackHarness();
  const a1 = h.get('A'), b = h.get('B'), a2 = h.get('A');
  assert.deepEqual(h.loads.map(load => load.id), ['A', 'B']);
  h.loads[1].resolve(board('B')); await b; h.flushLoading();
  assert.equal(h.state().trackId, 'A'); assert.equal(h.loading(), true);
  h.loads[0].resolve(board('A')); await a1; await a2; h.flushLoading();
  assert.equal(h.state().trackId, 'A'); assert.equal(h.state().status, 'cloud'); assert.equal(h.loading(), false);
});

test('cached background A refresh is adopted before the latest A metadata resolves', async () => {
  const h = trackHarness({A: cached('A', 1), B: cached('B')});
  await h.get('A'); assert.equal(h.loads.length, 1);
  await h.get('B'); const gate = deferred(); h.metadata.push(gate); const a = h.get('A');
  const generation = h.context.trackLoadGeneration;
  h.loads[0].resolve(board('A-new')); await tick(); h.flushLoading();
  assert.equal(h.state().trackId, 'A'); assert.equal(h.state().status, 'cloud');
  gate.resolve({}); assert.equal((await a)[0].name, 'A-new');
  assert.equal(h.context.trackLoadGeneration, generation); assert.equal(h.loads.length, 1);
  assert.deepEqual(h.repaints, [], 'the foreground adopter renders the accepted data itself'); assert.equal(h.loading(), false);
});

test('a forced A waiter superseded by B does not restart A', async () => {
  const h = trackHarness({B: cached('B')});
  const a = h.get('A'), forced = h.get('A', 10, true); await h.get('B');
  h.loads[0].resolve(board('A')); await a; await forced; h.flushLoading();
  assert.equal(h.loads.length, 1); assert.equal(h.state().trackId, 'B'); assert.equal(h.loading(), false);
});

test('same-track forced waiters share one replacement load and retain caller limits', async () => {
  const pending = [], flags = [];
  const context = vm.createContext({
    unrankedExtraTrackIds: new Set(), readTrackSnapshotCache: () => null, trackEntryRequests: new Map(),
    loadTrackEntries: (_id, _limit, force) => { const gate = deferred(); pending.push(gate); flags.push(force); return gate.promise; }
  });
  runClientSource(extract('getTrackEntries'), context);
  const prior = context.getTrackEntries('A', 1), first = context.getTrackEntries('A', 1, true), second = context.getTrackEntries('A', 2, true);
  pending[0].resolve([0]); await prior; await tick();
  assert.deepEqual(flags, [false, true]); pending[1].resolve([1, 2, 3]);
  assert.deepEqual(plain(await first), [1]); assert.deepEqual(plain(await second), [1, 2]);
  assert.equal(context.trackEntryRequests.size, 0);
});

for (const order of ['metadata-first', 'extra-first']) {
  test(`cached ranked A -> unranked Extra B with pending A metadata (${order})`, async () => {
    const h = trackHarness({A: cached('A')}, ['B']), gate = deferred();
    h.metadata.push(gate); const a = h.get('A'); const oldGeneration = h.context.trackLoadGeneration;
    const b = h.get('B');
    assert.ok(h.context.trackLoadGeneration > oldGeneration); assert.equal(h.state().trackId, 'B');
    if (order === 'metadata-first') { gate.resolve({}); await a; }
    assert.equal(h.state().trackId, 'B'); assert.equal(h.loading(), true);
    resolveExtra(h.extraLoads[0], 'B'); assert.equal((await b)[0].name, 'B');
    if (order === 'extra-first') { gate.resolve({}); await a; }
    assert.equal(h.state().trackId, 'B'); assert.equal(h.state().status, 'cloud');
    assert.equal(h.loading(), false); assert.equal(h.loads.length, 0);
  });
}

for (const order of ['ranked-first', 'extra-first']) {
  test(`cached ranked A -> unranked Extra B invalidates a pending A background load (${order})`, async () => {
    const h = trackHarness({A: cached('A', 1)}, ['B']);
    await h.get('A'); assert.equal(h.loads.length, 1);
    const oldGeneration = h.context.trackLoadGeneration, b = h.get('B');
    assert.ok(h.context.trackLoadGeneration > oldGeneration); assert.equal(h.state().trackId, 'B');
    if (order === 'ranked-first') { h.loads[0].resolve(board('A-new')); await tick(); h.flushLoading(); }
    assert.equal(h.state().trackId, 'B'); assert.equal(h.loading(), true);
    resolveExtra(h.extraLoads[0], 'B'); await b;
    if (order === 'extra-first') { h.loads[0].resolve(board('A-new')); await tick(); h.flushLoading(); }
    assert.equal(h.state().trackId, 'B'); assert.equal(h.state().status, 'cloud'); assert.equal(h.loading(), false);
    assert.equal(h.cache.get('A').entries[0].name, 'A-new', 'nonselected data may still populate its own cache');
  });
}

for (const failure of ['http', 'network', 'json']) {
  test(`unranked Extra B clears loading on ${failure} failure without restoring ranked A`, async () => {
    const h = trackHarness({A: cached('A', 1)}, ['B']); await h.get('A');
    const b = h.get('B');
    if (failure === 'network') h.extraLoads[0].reject(Error('offline'));
    else h.extraLoads[0].resolve({ok: failure !== 'http', json: async () => { throw Error('invalid json'); }});
    assert.deepEqual(plain(await b), []); assert.equal(h.state().trackId, 'B');
    assert.equal(h.state().status, 'stale'); assert.equal(h.loading(), false);
    h.loads[0].resolve(board('A')); await tick(); h.flushLoading();
    assert.equal(h.state().trackId, 'B'); assert.equal(h.state().status, 'stale'); assert.equal(h.loading(), false);
  });
}

for (const failure of [false, true]) {
  test(`late unranked completion cannot overwrite pending ranked C or clear its spinner (failure=${failure})`, async () => {
    const h = trackHarness({}, ['B']), b = h.get('B'), c = h.get('C');
    if (failure) h.extraLoads[0].reject(Error('offline')); else resolveExtra(h.extraLoads[0], 'B');
    await b; assert.equal(h.state().trackId, 'C'); assert.equal(h.loading(), true);
    h.loads[0].resolve(board('C')); await c; h.flushLoading();
    assert.equal(h.state().trackId, 'C'); assert.equal(h.state().status, 'cloud'); assert.equal(h.loading(), false);
  });
}

test('unranked B -> C -> B also adopts the existing B load', async () => {
  const h = trackHarness({}, ['B']), b1 = h.get('B'), c = h.get('C'), b2 = h.get('B');
  assert.equal(h.extraLoads.length, 1); h.loads[0].resolve(board('C')); await c; h.flushLoading();
  assert.equal(h.state().trackId, 'B'); assert.equal(h.loading(), true);
  resolveExtra(h.extraLoads[0], 'B'); await b1; await b2;
  assert.equal(h.state().status, 'cloud'); assert.equal(h.loading(), false);
});

function profileMerges(primary, incoming, selfPresent = true, normalize = false) {
  const profile = extract('openRankedProfile');
  const ownStart = profile.indexOf('    const cachedFinishes=');
  const ownEnd = profile.indexOf('    const rankedDetails=', ownStart);
  const rivalStart = profile.search(/    const self(?:DetailByTrack|SnapshotFinishes)=/);
  const rivalEnd = profile.indexOf('    const comparisonFor=', rivalStart);
  assert.ok(ownStart >= 0 && ownEnd > ownStart && rivalStart > ownEnd && rivalEnd > rivalStart);
  const context = vm.createContext({
    entry: {userId: 'self', resultSamples: primary}, self: selfPresent ? {userId: 'self', resultSamples: primary} : null,
    overallLoadState: {serverUpdatedAt: 999999}, normalizedFinishSamples: () => primary,
    cachedProfileFinishes: () => incoming,
    rankedTrackWeightParts: () => ({finalWeight: 1}), snapshotCaptureTimestamp: value => Number(value) || 0
  });
  runClientSource(extract('rankedPlacementCost') + '\n' + extract('knownFinishWeight'), context);
  if (normalize) {
    runClientSource(extract('normalizeFinishSummary'), context);
    context.normalizedFinishSamples = () => primary.map(context.normalizeFinishSummary);
  }
  runClientSource(extract('mergePlannerFinishes', true) + '\n' + profile.slice(ownStart, ownEnd) + '\n' + profile.slice(rivalStart, rivalEnd), context);
  return plain(runClientSource('({own:snapshotFinishes,rival:selfSnapshotFinishes})', context));
}
const finish = changes => ({trackId: 'track', timeMs: 20000, rank: 5, fieldSize: 10, cachedAt: 100, contribution: 50, ...changes});
const runBinding = {accountId: 'a'.repeat(64), uploadId: 'run-1', replayHash: 'b'.repeat(64), raceTimeFrames: 2000};

for (const local of [true, false]) {
  test(`own and rival planners both use the faster per-track PB despite later overall build (local=${local})`, () => {
    const next = finish({timeMs: 19000, rank: 2, cachedAt: 200, pbAt: 200, contribution: 80, local});
    const result = profileMerges([finish()], [next]);
    assert.deepEqual(result.own, [next]); assert.deepEqual(result.rival, result.own);
  });
}

test('a faster unplaced PB does not inherit the older PB rank, field, or contribution', () => {
  const next = {trackId: 'track', timeMs: 19000, local: true, cachedAt: 200, pbAt: 200};
  const result = profileMerges([finish()], [next]);
  assert.deepEqual(result.own, [next]); assert.deepEqual(result.rival, [next]);
});

test('newer per-track same-PB placement wins without consulting global overall age', () => {
  const next = finish({rank: 6, cachedAt: 200, contribution: 40});
  const result = profileMerges([finish()], [next]);
  assert.equal(result.own[0].rank, 6); assert.equal(result.own[0].cachedAt, 200);
  assert.ok(Math.abs(result.own[0].placementCost - 53.333333333333336) < 1e-10);
  assert.ok(Math.abs(result.own[0].contribution - 46.666666666666664) < 1e-10);
  assert.deepEqual(result.rival, result.own);
});

function cachedPlannerFinish({rank = 5, fieldSize = 10, weight = 2, timeMs = 20000} = {}) {
  const context = vm.createContext({
    profileSnapshotResults: new Map(), cleanUserId: value => String(value || ''),
    activeRankedAccountId: () => 'other', overallLoadState: {serverUpdatedAt: 0},
    readOverallSnapshotCache: () => null, sortProfileFinishes: rows => rows,
    entryTimeMs: row => row.timeMs, pbTimestamp: () => 100,
    rankedTrackWeightParts: () => ({finalWeight: 1}),
    trackSnapshotStore: () => ({track: {complete: true, totalEntries: fieldSize, serverUpdatedAt: 200,
      entries: Array.from({length: fieldSize}, (_, i) => ({
        accountId: i === rank - 1 ? 'self' : `rival-${i}`, rank: i + 1, timeMs, weight
      }))}})
  });
  runClientSource(['profileBoardIsComplete', 'knownFinishWeight', 'cachedProfileFinishes'].map(name => extract(name)).join('\n'), context);
  const [result] = plain(context.cachedProfileFinishes('self', {}));
  assert.equal(Object.hasOwn(result, 'placementCost'), false);
  assert.equal(Object.hasOwn(result, 'contribution'), false);
  return result;
}
const derivedFinish = changes => {
  const row = finish({weight: 2, ...changes});
  const placementCost = 50 + 100 * (row.rank - (row.fieldSize + 1) / 2) / (row.fieldSize + 5);
  return {...row, placementCost, contribution: (100 - placementCost) * row.weight};
};

for (const [label, changes] of [
  ['better rank', {rank: 2}], ['worse rank', {rank: 8}],
  ['larger field', {fieldSize: 20}], ['smaller field', {fieldSize: 6}],
  ['higher weight', {weight: 3}], ['lower weight', {weight: 1}],
  ['single-racer zero weight', {rank: 1, fieldSize: 1, weight: 0}]
]) {
  test(`cache-shaped same-PB merge recomputes derived values for ${label}`, () => {
    const primary = derivedFinish(), next = cachedPlannerFinish(changes);
    const before = plain({primary, next});
    const result = profileMerges([primary], [next], true, true);
    const expected = derivedFinish({...changes, weight: next.weight});
    assert.equal(result.own[0].rank, next.rank); assert.equal(result.own[0].fieldSize, next.fieldSize);
    assert.equal(result.own[0].weight, next.weight);
    assert.ok(Math.abs(result.own[0].placementCost - expected.placementCost) < 1e-10);
    assert.ok(Math.abs(result.own[0].contribution - expected.contribution) < 1e-10);
    assert.deepEqual(result.rival, result.own);
    assert.deepEqual({primary, next}, before);
  });
}

test('unchanged cache placement preserves published derived values and updates observation time', () => {
  const primary = {...derivedFinish(), placementCost: 46.667, contribution: 106.667};
  const result = profileMerges([primary], [cachedPlannerFinish()]);
  assert.equal(result.own[0].placementCost, primary.placementCost);
  assert.equal(result.own[0].contribution, primary.contribution);
  assert.equal(result.own[0].cachedAt, 200); assert.deepEqual(result.rival, result.own);
});

test('changed placement recomputes even explicitly supplied obsolete derived values', () => {
  const primary = derivedFinish(), next = {...cachedPlannerFinish({rank: 2}), placementCost: 999, contribution: 999};
  const result = profileMerges([primary], [next]);
  const expected = derivedFinish({rank: 2});
  assert.ok(Math.abs(result.own[0].placementCost - expected.placementCost) < 1e-10);
  assert.ok(Math.abs(result.own[0].contribution - expected.contribution) < 1e-10);
  assert.deepEqual(result.rival, result.own);
});

test('a new cache-shaped PB replaces rather than inherits the prior derived values', () => {
  const next = cachedPlannerFinish({timeMs: 19000, rank: 2});
  const result = profileMerges([derivedFinish()], [next]);
  assert.deepEqual(result.own, [next]); assert.deepEqual(result.rival, [next]);
});

test('older and tied placement changes do not invalidate the current derived values', () => {
  const primary = derivedFinish();
  for (const cachedAt of [50, 100]) {
    const next = {...cachedPlannerFinish({rank: 2, weight: 3}), cachedAt};
    const result = profileMerges([primary], [next]);
    assert.deepEqual(result.own, [primary]); assert.deepEqual(result.rival, [primary]);
  }
});

test('slower later-dated local rows do not replace the faster accepted PB', () => {
  const primary = finish(), next = finish({timeMs: 21000, cachedAt: 200, local: true});
  const result = profileMerges([primary], [next]);
  assert.deepEqual(result.own, [primary]); assert.deepEqual(result.rival, [primary]);
});

test('older same-PB observations cannot displace newer known placement', () => {
  const primary = finish({cachedAt: 300}), next = finish({rank: 2, cachedAt: 200, local: true});
  const result = profileMerges([primary], [next]);
  assert.deepEqual(result.own, [primary]); assert.deepEqual(result.rival, [primary]);
});

test('unplaced same-PB observations retain the known exact-PB placement', () => {
  const primary = finish(), next = {trackId: 'track', timeMs: 20000, local: true, cachedAt: 200};
  const result = profileMerges([primary], [next]);
  assert.deepEqual(result.own, [primary]); assert.deepEqual(result.rival, [primary]);
});

test('missing per-track results are appended and a missing signed-in profile stays empty', () => {
  const next = finish({trackId: 'other'}), result = profileMerges([finish()], [next], false);
  assert.deepEqual(result.own, [finish(), next]); assert.deepEqual(result.rival, []);
});

test('planner extraction executes both merges without a removed snapshot timestamp variable', () => {
  const profile = extract('openRankedProfile');
  assert.doesNotMatch(profile, /\bsnapshotAt\b/);
  assert.deepEqual(profileMerges([], []), {own: [], rival: []});
});

for (const incomingAt of [0, 200, 300]) {
  test(`older, unknown, or tied cached PB cannot undo a newer primary correction (incoming=${incomingAt})`, () => {
    const primary = finish({timeMs: 21000, cachedAt: 300});
    const next = finish({timeMs: 19000, cachedAt: incomingAt});
    const result = profileMerges([primary], [next]);
    assert.deepEqual(result.own, [primary]); assert.deepEqual(result.rival, [primary]);
  });
}

test('normalized primary snapshot capture prevents an older faster cached PB from reviving', () => {
  const primary = finish({timeMs: 21000, cachedAt: undefined, snapshotCapturedAt: 300});
  const next = finish({timeMs: 19000, cachedAt: 200});
  const result = profileMerges([primary], [next], true, true);
  assert.equal(result.own[0].timeMs, 21000); assert.equal(result.own[0].snapshotCapturedAt, 300);
  assert.deepEqual(result.rival, result.own);
});

test('normalization cannot erase the primary correction date', () => {
  const primary = finish({timeMs: 21000, updatedAt: 300, cachedAt: 100});
  const next = finish({timeMs: 19000, cachedAt: 200});
  const result = profileMerges([primary], [next], true, true);
  assert.equal(result.own[0].timeMs, 21000); assert.equal(result.own[0].updatedAt, 300);
  assert.deepEqual(result.rival, result.own);
});

test('raw metadata cannot attach a rejection to a different PB or fresher normalized observation', () => {
  const context = vm.createContext({});
  runClientSource(extract('mergePlannerFinishes'), context);
  const raw = finish({validationState: 'rejected', cachedAt: 300});
  for (const primary of [finish({timeMs: 19000, cachedAt: 300}), finish({cachedAt: 400})]) {
    const actual = context.mergePlannerFinishes([primary], [], {resultSamples: [raw]});
    assert.deepEqual(plain(actual), [primary]);
  }
});

test('a newer authoritative slower correction replaces the old faster PB', () => {
  const primary = finish({timeMs: 19000, snapshotCapturedAt: 200});
  const next = finish({timeMs: 21000, snapshotCapturedAt: 300, cachedAt: 100});
  const result = profileMerges([primary], [next]);
  assert.deepEqual(result.own, [next]); assert.deepEqual(result.rival, [next]);
});

for (const pbAt of [0, 100, 300, 400]) {
  test(`faster offline local PB remains eligible despite later package capture (pbAt=${pbAt})`, () => {
    const primary = finish({timeMs: 21000, snapshotCapturedAt: 300});
    const next = finish({timeMs: 19000, local: true, cachedAt: 100, pbAt, validationState: 'pending'});
    const result = profileMerges([primary], [next], true, true);
    assert.deepEqual(result.own, [next]); assert.deepEqual(result.rival, [next]);
  });
}

test('a later published slower time cannot remove the faster local PB without exact rejection evidence', () => {
  const primary = finish({timeMs: 19000, local: true, snapshotCapturedAt: 100, pbAt: 50});
  const next = finish({timeMs: 21000, snapshotCapturedAt: 300});
  const result = profileMerges([primary], [next]);
  assert.deepEqual(result.own, [primary]); assert.deepEqual(result.rival, [primary]);
});

for (const field of ['status', 'runStatus', 'validationState', 'verificationStatus']) {
  test(`explicit ${field} rejection cannot be revived by an incoming copy of the exact bound run`, () => {
    const primary = finish({...runBinding, [field]: 'rejected', snapshotCapturedAt: 300});
    const next = finish({...runBinding, local: true, cachedAt: 500, pbAt: 400});
    assert.deepEqual(profileMerges([primary], [next], true, true), {own: [], rival: []});
  });
}

test('a newer explicit rejection suppresses the same PB instead of preserving its scoring', () => {
  const primary = finish({...runBinding, snapshotCapturedAt: 200});
  const next = finish({...runBinding, snapshotCapturedAt: 300, validationState: 'rejected'});
  assert.deepEqual(profileMerges([primary], [next]), {own: [], rival: []});
});

test('rejection of a different older time does not remove an accepted correction', () => {
  const primary = finish({timeMs: 21000, snapshotCapturedAt: 300});
  const next = finish({timeMs: 19000, snapshotCapturedAt: 400, validationState: 'rejected'});
  const result = profileMerges([primary], [next]);
  assert.deepEqual(result.own, [primary]); assert.deepEqual(result.rival, [primary]);
});

test('pending verification is not treated as rejection', () => {
  const next = finish({timeMs: 19000, cachedAt: 200, runVerified: false, validationState: 'pending'});
  const result = profileMerges([finish()], [next]);
  assert.deepEqual(result.own, [next]); assert.deepEqual(result.rival, [next]);
});

for (const status of ['unavailable', 'unavailable_timeout', 'pending']) {
  test(`${status} is a deferral and remains eligible in both primary and incoming finishes`, () => {
    const next = finish({timeMs: 19000, local: true, cachedAt: 100, pbAt: 50, validationState: status});
    const result = profileMerges([finish({snapshotCapturedAt: 300})], [next]);
    assert.deepEqual(result.own, [next]); assert.deepEqual(result.rival, [next]);
    const retained = profileMerges([next], []);
    assert.deepEqual(retained.own, [next]); assert.deepEqual(retained.rival, [next]);
  });
}

test('a terminal mismatch excludes only its exact bound run', () => {
  const primary = finish({...runBinding, verificationStatus: 'mismatch', snapshotCapturedAt: 300});
  const next = finish({...runBinding, local: true, validationState: 'pending'});
  assert.deepEqual(profileMerges([primary], [next], true, true), {own: [], rival: []});
});

test('same track and time alone never transfer rejection to a local PB', () => {
  const primary = finish({...runBinding, validationState: 'rejected', snapshotCapturedAt: 300});
  const variants = [
    {}, {...runBinding, accountId: 'c'.repeat(64)}, {...runBinding, uploadId: 'run-2'},
    {...runBinding, replayHash: 'c'.repeat(64)}, {...runBinding, raceTimeFrames: 2001},
    {...runBinding, replayHash: undefined}, {...runBinding, uploadId: undefined},
    {...runBinding, timeMs: 19000}, {...runBinding, trackId: 'other'}
  ];
  for (const binding of variants) {
    const next = finish({...binding, local: true, cachedAt: 100, pbAt: 50});
    const result = profileMerges([primary], [next], true, true);
    assert.deepEqual(result.own, plain([next])); assert.deepEqual(result.rival, plain([next]));
  }
});

test('a separately rejected row without an exact binding cannot erase a pending local PB', () => {
  const primary = finish({local: true, cachedAt: 100, pbAt: 50});
  const next = finish({validationState: 'rejected', snapshotCapturedAt: 300});
  const result = profileMerges([primary], [next]);
  assert.deepEqual(result.own, [primary]); assert.deepEqual(result.rival, [primary]);
});

function identityFor(racer, overall, directory = null) {
  const context = vm.createContext({
    snapshotRacerDirectoryEntries: directory ? {[racer.accountId||racer.userId]:directory} : {},
    rankedIdentityIndex: null, rankedIdentityIndexSource: null, cleanUserId: value => String(value || ''),
    rankedIdentityRows: () => overall ? [overall] : [],
    snapshotRacerDirectoryIdentity: (_id, _at, seen) => directory && directory.updatedAt > seen ? directory : null
  });
  runClientSource(extract('rowIdentityFreshness') + '\n' + extract('rankedIdentityForRacer'), context);
  return plain(context.rankedIdentityForRacer(racer));
}
const identity = (name, at, theme) => ({userId: 'self', name, nickname: name, identityUpdatedAt: at, profileCosmetics: {theme}});

for (const at of [100, 200, 300]) {
  test(`cosmetics follow the same row freshness and tie policy as name (racer=${at}, overall=200)`, () => {
    const actual = identityFor(identity('track-name', at, 'track-theme'), identity('overall-name', 200, 'overall-theme'));
    const winner = at > 200 ? 'track' : 'overall';
    assert.equal(actual.name, `${winner}-name`); assert.equal(actual.profileCosmetics.theme, `${winner}-theme`);
  });
}

test('fresh directory cosmetics win, while a newer row rejects stale directory cosmetics', () => {
  const racer = identity('track-name', 100, 'track-theme'), overall = identity('overall-name', 200, 'overall-theme');
  const directory = {...identity('directory-name', 300, 'directory-theme'), updatedAt: 300};
  assert.equal(identityFor(racer, overall, directory).profileCosmetics.theme, 'directory-theme');
  const fresh = {...racer, identityUpdatedAt: 400, pbAt: 400};
  const actual = identityFor(fresh, overall, directory);
  assert.equal(actual.name, 'track-name'); assert.equal(actual.profileCosmetics.theme, 'track-theme');
});

test('missing directory cosmetics fall through to the freshest row, not the older track row', () => {
  const actual = identityFor(identity('track-name', 100, 'track-theme'), identity('overall-name', 200, 'overall-theme'), {name: 'directory-name', updatedAt: 300});
  assert.equal(actual.name, 'directory-name'); assert.equal(actual.profileCosmetics.theme, 'overall-theme');
});

test('cosmetics preserve fallback when the freshest row has none or no overall row exists', () => {
  const racer = identity('track-name', 100, 'track-theme');
  assert.equal(identityFor(racer, {userId: 'self', name: 'overall-name', identityUpdatedAt: 200}).profileCosmetics.theme, 'track-theme');
  assert.equal(identityFor(racer, null).profileCosmetics.theme, 'track-theme');
});

test('event-only cosmetic unlock context comes from the directory, not Event RP place',()=>{
 const racer={userId:'self',rank:1};const directory={updatedAt:300,cosmeticContext:{rank:501,raceCount:12}};
 assert.deepEqual(identityFor(racer,null,directory).cosmeticContext,{rank:501,raceCount:12});
 assert.equal(identityFor(racer,{userId:'self',rank:7},directory).cosmeticContext,null);
});

test('twenty unchanged warm selections never hide rows or reload the board', async () => {
  const h=trackHarness({A:cached('A')});
  for(let i=0;i<20;i++)assert.equal((await h.get('A'))[0].name,'A');
  assert.equal(h.loads.length,0);assert.deepEqual(h.repaints,[]);
  assert.ok(!h.visibility.includes('hide'));assert.equal(h.loading(),false);
  assert.equal(h.replayInvalidations.length,20,'replay cancellation does not force a board reload');
});

for(const changed of [false,true])test(`background refresh keeps cached rows visible (changed=${changed})`,async()=>{
  const h=trackHarness({A:cached('A',1)});
  assert.equal((await h.get('A'))[0].name,'A');
  assert.equal(h.loads.length,1);assert.equal(h.loading(),false);
  h.loads[0].resolve(board(changed?'A-new':'A'));await tick();
  assert.ok(!h.visibility.includes('hide'));assert.equal(h.loading(),false);
  assert.deepEqual(h.repaints,changed?['A']:[]);
  assert.ok(h.timers.every(timer=>timer.delay!==120));
});

test('empty cached boards remain usable and do not enter a repeated load loop',async()=>{
  const h=trackHarness({A:{...cached('A'),entries:[],complete:true,totalEntries:0}});
  for(let i=0;i<3;i++)assert.deepEqual(plain(await h.get('A')),[]);
  assert.equal(h.loads.length,0);assert.ok(!h.visibility.includes('hide'));
});

test('forced refresh retains cached visibility and cold load clears loading without a timer',async()=>{
  const h=trackHarness({A:cached('A')});
  const refresh=h.get('A',10,true);assert.equal(h.loading(),false);
  h.loads[0].resolve(board('A-new'));assert.equal((await refresh)[0].name,'A-new');
  const cold=h.get('B');assert.equal(h.loading(),true);
  h.loads[1].resolve(board('B'));await cold;
  assert.equal(h.loading(),false);assert.ok(h.timers.every(timer=>timer.delay!==120));
});

test('failed background refresh retains the exact saved board without repaint',async()=>{
  const h=trackHarness({A:cached('A',1)});await h.get('A');
  h.loads[0].reject(Error('offline'));await tick();
  assert.equal(h.cache.get('A').entries[0].name,'A');assert.equal(h.state().status,'stale');
  assert.equal(h.loading(),false);assert.ok(!h.visibility.includes('hide'));assert.deepEqual(h.repaints,[]);
});

function receiveTrackStatistics(h,tracks){
  const from=source.indexOf("        if(kind==='track-statistics'){");
  const to=source.indexOf("        }else if(kind==='cosmetic-directory'){",from);
  assert.ok(from>=0&&to>from);
  const accept=runClientSource('(value)=>{const kind="track-statistics";'+source.slice(from,to)+'}}',h.context);
  accept({tracks});
}

test('metadata received during a foreground selection does not steal it or schedule a second render',async()=>{
  const h=trackHarness({A:cached('A')}),gate=deferred();h.metadata.push(gate);
  const request=h.get('A'),selection=h.context.getTrackEntries.selection;
  receiveTrackStatistics(h,{A:{revision:2,updatedAt:200}});
  assert.equal(h.context.getTrackEntries.selection,selection);assert.equal(h.loads.length,0);
  gate.resolve({});await tick();assert.equal(h.loads.length,1);
  h.loads[0].resolve(board('A-new'));assert.equal((await request)[0].name,'A-new');
  assert.deepEqual(h.repaints,[]);assert.equal(h.loading(),false);
});

for(const changed of [false,true])test(`idle metadata refresh repaints only changed accepted rows (changed=${changed})`,async()=>{
  const h=trackHarness({A:cached('A')});await h.get('A');
  receiveTrackStatistics(h,{A:{revision:2,updatedAt:200}});await tick();
  assert.equal(h.loads.length,1);assert.equal(h.loading(),false);
  h.loads[0].resolve(board(changed?'A-new':'A'));await tick();
  assert.deepEqual(h.repaints,changed?['A']:[]);
});

for(const transition of ['account','exit','selection'])test(`metadata completion cannot repaint after ${transition} changes`,async()=>{
  const h=trackHarness({A:cached('A'),B:cached('B')});await h.get('A');
  receiveTrackStatistics(h,{A:{revision:2,updatedAt:200}});await tick();
  if(transition==='account')h.setAccount('two');
  if(transition==='exit')h.setHost(null);
  if(transition==='selection')await h.get('B');
  h.loads[0].resolve(board('A-new'));await tick();assert.deepEqual(h.repaints,[]);
});

test('metadata does not fetch a board after its native view has closed',async()=>{
  const h=trackHarness({A:cached('A')});await h.get('A');h.setHost(null);
  receiveTrackStatistics(h,{A:{revision:2,updatedAt:200}});await tick();
  assert.equal(h.loads.length,0);assert.deepEqual(h.repaints,[]);
});
