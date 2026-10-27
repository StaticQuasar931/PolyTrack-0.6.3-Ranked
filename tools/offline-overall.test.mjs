import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {buildOfflineOverall} from './offline-overall.mjs';
import {computeOverall, rankTrustedTrackEntries, packPlannerResults} from '../workers/ranked/src/index.js';
import {decodeProjectionResults, decodeOverallProjectionBundle} from './overall-projection-bundle.mjs';
import {createPublicSnapshotReader} from './public-snapshot-client.mjs';

const ids = ['5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038',
  '7eac4fee1111152cfba4d3737410264ca0f22c7f5a2211e79f0099589b8b48c0',
  '148826aa16ffaa23dbc453b32cff05e025ddbce1773fc7733cc13d218926515a'];
const meta = {algorithmVersion: 'participation-v8-s1', schemaVersion: 6, sourceRevision: 10, builtRevision: 10, updatedAt: 1000};
function fixture() {
  const tracks = ids.map(trackId => ({...meta, trackId, complete: true, totalEntries: 5,
    entries: rankTrustedTrackEntries(Array.from({length: 5}, (_, i) => ({accountId: String(i + 1).repeat(64), trackId,
      timeMs: 10000 + i * 1000, pbAt: 100, pbCount: 2, totalPlaytimeMs: 500, accountCreatedAt: 10,
      name: 'Racer ' + i, runVerified: true, integrityVerified: true})), trackId)}));
  const entries = computeOverall(tracks);
  for (const row of entries) {row.rankSince = 900; row.movementAt = 0;}
  return {tracks, previousOverall: {...meta, entries, complete: true, totalEntries: entries.length,
    trackSummaries: [], trackCatalog: tracks.map(b => ({trackId: b.trackId, updatedAt: b.updatedAt}))}, expectedTrackIds: ids, now: 2000};
}
const overall = result => result.files.get('overall.json');

test('authoritative scores, qualification, medals, planner encoding and projection bindings agree', async () => {
  const f = fixture(), result = await buildOfflineOverall(f);
  const expected = computeOverall(f.tracks, f.previousOverall.entries, new Set(), {includePlannerResults: true});
  for (const [i, row] of overall(result).entries.entries()) {
    for (const key of ['score', 'rank', 'raceCount', 'skillCost', 'coverageCost', 'consistencyCost', 'weightedTracks', 'medals', 'provisional']) assert.deepEqual(row[key], expected[i][key], key);
  }
  const packed = await packPlannerResults(expected, overall(result), {boardCount: 3, boardLimit: 500, boardLimitReached: false});
  assert.equal(result.files.get('overall-results.json').resultBundle, packed.resultBundle);
  assert.deepEqual((await decodeProjectionResults(result.files.get('overall-results.json'))).entries, (await decodeProjectionResults(packed)).entries);
  const boards = decodeOverallProjectionBundle(result.files.get('projection-source.json'), {overall: overall(result)});
  assert.equal(boards.length, 3); assert.equal(overall(result).complete, true);
  assert.equal(overall(result).ranksExact, true); assert.equal(overall(result).catalogComplete, true);
  assert.equal(result.report.source, 'snapshot-computed-overall'); assert.equal(result.report.firestorePublished, false);
});

test('unverified, changed and held runs never score or become projection verification evidence', async () => {
  for (const change of [row => {row.runVerified = false;}, row => {row.integrityVerified = false;},
    row => {row.verificationStatus = 'changed';}, row => {row.validationState = 'held';}, row => {row.unranked = true;}]) {
    const f = fixture(); for (const board of f.tracks) change(board.entries[0]);
    const result = await buildOfflineOverall(f);
    assert.equal(overall(result).entries.some(r => r.userId === '1'.repeat(64)), false);
    assert.ok(result.files.get('projection-source.json').boards.every(b => b[4].every(r => r[0] !== '1'.repeat(64))));
    assert.equal(result.report.trustedRows, 12);
  }
});

test('missing known tracks, duplicates, incomplete boards and invalid row/source metadata fail closed', async () => {
  const mutations = [f => f.tracks.pop(), f => {f.expectedTrackIds = ids.slice(0, 2); f.tracks.pop();},
    f => {f.tracks[1] = f.tracks[0];}, f => {f.tracks[0].complete = false;},
    f => {f.tracks[0].sourceComplete = false;}, f => {f.tracks[0].totalEntries++;},
    f => {f.tracks[0].sourceRevision = 0;}, f => {f.tracks[0].builtRevision++;},
    f => {f.tracks[0].entries[0].trackId = ids[1];}, f => {f.tracks[0].entries[1].accountId = f.tracks[0].entries[0].accountId;},
    f => {f.tracks[0].entries[0].pbAt = -1;}, f => {f.tracks[0].entries[0].timeMs = 36000001;},
    f => {f.tracks[0].entries[0].weight = Infinity;}, f => {f.tracks[0].entries[0].rank = 999;},
    f => {f.tracks[0].entries[0].rank = 2;}, f => {f.tracks[0].entries[0].weight += 0.001;},
    f => {f.tracks[0].entries = new Array(10001); f.tracks[0].totalEntries = 10001;},
    f => {f.tracks[0].entries[0].runVerified = 'true';}, f => {f.previousOverall.builtRevision++;},
    f => {f.expectedTrackIds = Array(501).fill(ids[0]);}, f => {f.now = 0;}];
  for (const mutate of mutations) {const f = fixture(); mutate(f); await assert.rejects(buildOfflineOverall(f));}
});

test('stable input digest and complete outputs have no clock or capture-metadata churn', async () => {
  const f = fixture(), first = await buildOfflineOverall(f);
  f.now = 999999; f.previousCalculation = first.calculation;
  f.tracks.reverse(); for (const b of f.tracks) {b.entries.reverse(); b._snapshotCapturedAt = 88888; b.ownerUid = 'PRIVATE';}
  const second = await buildOfflineOverall(f);
  assert.deepEqual(second.calculation, first.calculation); assert.deepEqual(second.files, first.files);
  assert.equal(second.report.unchanged, true);
});

test('changed boards and public identities update fingerprint and revision monotonically', async () => {
  const f = fixture(), first = await buildOfflineOverall(f);
  f.previousCalculation = {...first.calculation, revision: 50}; f.tracks[0].entries[0].timeMs++;
  const changed = await buildOfflineOverall(f);
  assert.equal(changed.calculation.revision, 51); assert.equal(changed.calculation.backendRevision, 10);
  assert.notEqual(changed.calculation.inputDigest, first.calculation.inputDigest);
  f.previousOverall.sourceRevision = 100; f.previousOverall.builtRevision = 100;
  assert.equal((await buildOfflineOverall(f)).calculation.revision, 100);
  const g = fixture(); g.previousCalculation = first.calculation; g.previousOverall.entries[0].name = 'New identity';
  assert.notEqual((await buildOfflineOverall(g)).calculation.inputDigest, first.calculation.inputDigest);
});

test('version mismatch, local estimates, invalid receipt and empty population reject', async () => {
  for (const change of [f => {f.tracks[0].schemaVersion++;}, f => {f.previousOverall.algorithmVersion = 'old';},
    f => {f.previousOverall.localPending = true;}, f => {f.tracks[0].entries[0].estimated = true;},
    f => {f.previousCalculation = {};}, f => {for (const b of f.tracks) {b.entries = []; b.totalEntries = 0;}}]) {
    const f = fixture(); change(f); await assert.rejects(buildOfflineOverall(f));
  }
});

function populationFixture(size) {
  const f = fixture();
  const paired = size === 731;
  const catalog = paired ? Array.from({length: Math.floor(size / 2)}, (_, i) => (i + 10000).toString(16).padStart(64, '0')) : ids.slice(0, 1);
  f.tracks = catalog.map((trackId, boardIndex) => {
    const entries = rankTrustedTrackEntries(Array.from({length: size}, (_, i) => ({
      accountId: (i + 1).toString(16).padStart(64, '0'), trackId,
      timeMs: 10000 + (i % 100), pbAt: 100, pbCount: 2, totalPlaytimeMs: 500, accountCreatedAt: 10,
      name: 'Public racer', runVerified: true, integrityVerified: true
    })).filter((_, i) => !paired || Math.min(Math.floor(i / 2), catalog.length - 1) === boardIndex), trackId);
    return {...meta, trackId, complete: true, totalEntries: entries.length, entries};
  });
  f.expectedTrackIds = f.tracks.map(board => board.trackId);
  f.previousOverall.entries = computeOverall(f.tracks);
  for (const row of f.previousOverall.entries) {row.rankSince = 900; row.movementAt = 0;}
  f.previousOverall.totalEntries = f.previousOverall.entries.length;
  f.previousOverall.trackCatalog = f.tracks.map(b => ({trackId: b.trackId, updatedAt: b.updatedAt}));
  return f;
}

test('201 users round-trip without truncation through authoritative chunk validation', async () => {
  const size = 201;
  const f = populationFixture(size), before = structuredClone(f);
  const result = await buildOfflineOverall(f), value = overall(result);
  assert.equal(value.entries.length, size); assert.equal(value.totalEntries, size);
  assert.equal(value.complete, true); assert.equal(value.entryLimit, 10000);
  const decoded = await decodeProjectionResults(result.files.get('overall-results.json'));
  assert.equal(decoded.entries.length, size); assert.equal(new Set(decoded.entries.map(r => r.userId)).size, size);
  const expected = computeOverall(f.tracks, f.previousOverall.entries, new Set(), {includePlannerResults: true});
  for (let offset = 0; offset < size; offset += 200) {
    const packed = await packPlannerResults(expected.slice(offset, offset + 200), meta, {boardCount: f.tracks.length, boardLimit: 500, boardLimitReached: false});
    const chunk = await decodeProjectionResults(packed);
    const remapped = chunk.entries.map(row => ({...row, resultData: JSON.stringify(JSON.parse(row.resultData).map(tuple => [decoded.resultTracks.indexOf(chunk.resultTracks[tuple[0]]), ...tuple.slice(1)]).sort((a, b) => a[0] - b[0]))}));
    assert.deepEqual(decoded.entries.slice(offset, offset + 200), remapped);
  }
  assert.deepEqual(f, before);
  const again = await buildOfflineOverall({...f, now: 99999, previousCalculation: result.calculation});
  assert.deepEqual(again.files, result.files); assert.deepEqual(again.calculation, result.calculation);
  for (const [name, artifact] of result.files) assert.ok(Buffer.byteLength(JSON.stringify(artifact) + '\n') <= (name === 'overall.json' ? 16 : 2) * 1024 * 1024);
});

test('731 users keep complete display fields above 2 MB within the existing paged Overall 16 MB budget', async () => {
  const f = populationFixture(731), before = structuredClone(f);
  const result = await buildOfflineOverall(f);
  const value = overall(result);
  assert.equal(value.entries.length, 731);
  assert.equal((await decodeProjectionResults(result.files.get('overall-results.json'))).entries.length, 731);
  assert.ok(result.report.artifactBytes['overall.json'] > 2 * 1024 * 1024);
  for (const [name, artifact] of result.files) {
    const bytes = Buffer.byteLength(JSON.stringify(artifact) + '\n');
    assert.equal(result.report.artifactBytes[name], bytes);
    assert.ok(bytes <= (name === 'overall.json' ? 16 : 2) * 1024 * 1024);
  }
  const expected = computeOverall(f.tracks, f.previousOverall.entries);
  for (let i = 0; i < expected.length; i++) {
    for (const key of ['score', 'rank', 'raceCount', 'provisional', 'bestTracks', 'weightedResults', 'strongestTrack', 'worstTrack', 'improvementTrack', 'opportunityTracks', 'medals', 'profileCosmetics']) assert.deepEqual(value.entries[i][key], expected[i][key], key);
    assert.equal(Object.hasOwn(value.entries[i], 'resultSamples'), false);
    assert.equal(Object.hasOwn(value.entries[i], 'resultData'), false);
  }
  assert.deepEqual(f, before);
  assert.deepEqual((await buildOfflineOverall({...f, now: 99999, previousCalculation: result.calculation})).files, result.files);
});

test('existing capture bounds still reject Overall above 16 MB and projection companions above 2 MB', async () => {
  const oversized = fixture();
  oversized.previousOverall.entries[0].carStyle = 'x'.repeat(16 * 1024 * 1024);
  await assert.rejects(buildOfflineOverall(oversized), /overall\.json exceeds 16 MB artifact budget/);
  const companion = populationFixture(201);
  companion.tracks = Array.from({length: 100}, (_, i) => {
    const trackId = (i + 10000).toString(16).padStart(64, '0');
    const entries = rankTrustedTrackEntries(companion.tracks[0].entries.map(row => ({...row, trackId})), trackId);
    return {...meta, trackId, complete: true, totalEntries: entries.length, entries};
  });
  companion.expectedTrackIds = companion.tracks.map(b => b.trackId);
  companion.previousOverall.trackCatalog = companion.tracks.map(b => ({trackId: b.trackId, updatedAt: b.updatedAt}));
  await assert.rejects(buildOfflineOverall(companion), /Overall projection source exceeds snapshot file limit|projection-source\.json exceeds 2 MB artifact budget/);
});

test('chunk-local track indices are remapped to one sorted global catalog', async () => {
  const f = populationFixture(201);
  const last = f.tracks[0].entries.find(row => row.accountId === (201).toString(16).padStart(64, '0'));
  f.tracks[0].entries = rankTrustedTrackEntries(f.tracks[0].entries.filter(row => row !== last), ids[0]);
  f.tracks[0].trackId = ids[1];
  f.tracks[0].entries = rankTrustedTrackEntries(f.tracks[0].entries.map(row => ({...row, trackId: ids[1]})), ids[1]);
  f.tracks[0].totalEntries = 200;
  const entries = rankTrustedTrackEntries([{...f.tracks[0].entries[0], trackId: ids[0], timeMs: 9000}, {...last, trackId: ids[0], timeMs: 20000}], ids[0]);
  f.tracks.push({...meta, trackId: ids[0], complete: true, totalEntries: 2, entries});
  f.expectedTrackIds = ids.slice(0, 2);
  f.previousOverall.entries = computeOverall(f.tracks);
  f.previousOverall.trackCatalog = f.tracks.map(b => ({trackId: b.trackId, updatedAt: b.updatedAt}));
  const result = await buildOfflineOverall(f);
  const decoded = await decodeProjectionResults(result.files.get('overall-results.json'));
  assert.deepEqual(decoded.resultTracks, ids.slice(0, 2).sort());
  const expected = computeOverall(f.tracks, f.previousOverall.entries, new Set(), {includePlannerResults: true});
  let remapped = false;
  for (let offset = 0; offset < expected.length; offset += 200) {
    const packed = await packPlannerResults(expected.slice(offset, offset + 200), meta, {boardCount: 2, boardLimit: 500, boardLimitReached: false});
    const chunk = await decodeProjectionResults(packed);
    remapped ||= chunk.resultTracks.some((trackId, i) => decoded.resultTracks.indexOf(trackId) !== i);
  }
  assert.equal(remapped, true, 'fixture must exercise genuinely different chunk track indices');
  for (let i = 0; i < decoded.entries.length; i++) {
    const actual = JSON.parse(decoded.entries[i].resultData).map(tuple => [decoded.resultTracks[tuple[0]], ...tuple.slice(1)]);
    const wanted = expected[i].resultSamples.map(s => [s.trackId, s.rank, s.fieldSize, s.weight, s.competition, s.timeMs, s.pbAt]).sort((a, b) => a[0].localeCompare(b[0]));
    assert.deepEqual(actual, wanted);
  }
});

test('large direct prior inputs reject over 10000 users without fabricated pagination', async () => {
  const f = fixture(); f.previousOverall.entries = new Array(10001);
  await assert.rejects(buildOfflineOverall(f), /baseline entries limit/);
});

test('local snapshot68 frozen source is exercised without any external fetch or snapshot writes', async t => {
  const root = fileURLToPath(new URL('../public-snapshots68/', import.meta.url));
  try {await fs.access(path.join(root, 'index.json'));} catch (error) {
    if (error.code === 'ENOENT') return t.skip('Local snapshot68 not installed');
    throw error;
  }
  const requests = [];
  const read = createPublicSnapshotReader({baseUrl: 'https://offline.invalid/public-snapshots68/', packed: true,
    byteCache: {open: async () => null}, fetchImpl: async input => {
      const url = new URL(input);
      assert.equal(url.origin, 'https://offline.invalid');
      assert.ok(url.pathname.startsWith('/public-snapshots68/'));
      const local = path.resolve(root, decodeURIComponent(url.pathname.slice('/public-snapshots68/'.length)));
      assert.ok(local.startsWith(path.resolve(root) + path.sep));
      requests.push(local);
      try {return new Response(await fs.readFile(local));} catch (error) {
        if (error.code === 'ENOENT') return new Response('', {status: 404});
        throw error;
      }
    }});
  const previousOverall = await read('overall'), source = await read('overall-projection');
  assert.equal(previousOverall.entries.length, 731);
  const tracks = decodeOverallProjectionBundle(source, {overall: previousOverall});
  assert.equal(tracks.length, 278);
  const expected = computeOverall(tracks, previousOverall.entries, new Set(), {includePlannerResults: true});
  assert.equal(expected.length, 731);
  const expectedTrackIds = previousOverall.trackCatalog.map(row => row.trackId);
  let missing = 0, newer = 0, older = 0, equal = 0;
  const hybrid = [], standaloneHybrid = [];
  const boardBindings = [];
  for (const frozen of tracks) {
    const full = await read('track', frozen.trackId);
    if (!full) {missing++; hybrid.push(frozen); standaloneHybrid.push(frozen); continue;}
    standaloneHybrid.push(full);
    const delta = full.updatedAt - frozen.updatedAt;
    if (delta > 0) newer++; else if (delta < 0) older++; else equal++;
    // Prefer the newer public source; use revision only for equal timestamps.
    const selected = delta > 0 || delta === 0 && full.sourceRevision >= frozen.sourceRevision ? full : frozen;
    hybrid.push(selected);
    if (selected.sourceRevision !== frozen.sourceRevision || selected.updatedAt !== frozen.updatedAt) boardBindings.push({trackId: selected.trackId,
      baselineRevision: frozen.sourceRevision, sourceRevision: selected.sourceRevision,
      baselineUpdatedAt: frozen.updatedAt, updatedAt: selected.updatedAt});
  }
  assert.equal(missing, 6);
  t.diagnostic(`snapshot68: 731 users, 278 frozen boards, ${missing} unavailable full boards; ${requests.length} local file reads, zero external requests`);
  const input = {tracks, previousOverall, expectedTrackIds,
    now: Math.max(previousOverall.updatedAt, ...hybrid.map(b => b.updatedAt)) + 1000};
  const check = async (label, sourceTracks) => {
    const result = await buildOfflineOverall({...input, tracks: sourceTracks});
    const value = overall(result), results = result.files.get('overall-results.json'), projection = result.files.get('projection-source.json');
    const authoritative = sourceTracks === tracks ? expected : computeOverall(sourceTracks, previousOverall.entries, new Set(), {includePlannerResults: true});
    assert.equal(value.entries.length, authoritative.length);
    const prior = new Map(previousOverall.entries.map(row => [row.userId, row]));
    const decoded = await decodeProjectionResults(results);
    assert.equal(decoded.entries.length, value.entries.length);
    for (let i = 0; i < authoritative.length; i++) {
      for (const key of ['userId', 'score', 'rank', 'raceCount', 'provisional', 'skillCost', 'coverageCost', 'consistencyCost', 'medals']) assert.deepEqual(value.entries[i][key], authoritative[i][key], `${label} ${i} ${key}`);
      for (const key of ['name', 'countryCode', 'carId', 'carColors', 'carStyle', 'badges', 'cosmeticUnlocks']) {
        if (prior.get(value.entries[i].userId)?.[key] !== undefined) assert.deepEqual(value.entries[i][key], prior.get(value.entries[i].userId)[key], `${label} prior identity ${key}`);
      }
    }
    for (const key of ['algorithmVersion', 'schemaVersion', 'sourceRevision', 'builtRevision', 'updatedAt']) {
      assert.equal(results[key], value[key]); assert.equal(projection[key], value[key]);
    }
    assert.equal(decodeOverallProjectionBundle(projection, {overall: value}).length, 278);
    const sourceById = new Map(sourceTracks.map(b => [b.trackId, b]));
    for (const b of projection.boards) {assert.equal(b[1], sourceById.get(b[0]).sourceRevision); assert.equal(b[2], sourceById.get(b[0]).updatedAt);}
    assert.equal(result.calculation.backendRevision, previousOverall.sourceRevision);
    assert.equal(result.report.projectionReady, true);
    const changedScores = value.entries.filter(row => prior.get(row.userId)?.score !== row.score).length;
    const materialScoreChanges = value.entries.filter(row => Math.abs((prior.get(row.userId)?.score ?? row.score) - row.score) > 1e-9).length;
    const maxScoreDelta = Math.max(...value.entries.map(row => Math.abs((prior.get(row.userId)?.score ?? row.score) - row.score)));
    const changedRanks = value.entries.filter(row => prior.get(row.userId)?.rank !== row.rank).length;
    const retained = value.entries.filter(row => prior.has(row.userId)).length;
    const currentUsers = new Set(value.entries.map(row => row.userId));
    const summary = {cohort: label, users: value.entries.length, ranked: value.entries.filter(r => !r.provisional).length,
      provisional: value.entries.filter(r => r.provisional).length, retained, added: value.entries.length - retained,
      removed: prior.size - retained, changedScores, materialScoreChanges, maxScoreDelta, changedRanks,
      addedUserIds: value.entries.filter(row => !prior.has(row.userId)).map(row => row.userId),
      removedUserIds: [...prior.keys()].filter(id => !currentUsers.has(id)), scorerMismatch: false, bindingMismatch: false,
      backendRevision: result.calculation.backendRevision, revision: value.sourceRevision, updatedAt: value.updatedAt,
      boardCount: projection.boards.length, sourceRows: result.report.sourceRows, trustedRows: result.report.trustedRows,
      artifactBytes: result.report.artifactBytes,
      scoreRange: {min: Math.min(...value.entries.map(r => r.score)), max: Math.max(...value.entries.map(r => r.score))},
      leaders: value.entries.slice(0, 5).map(r => ({userId: r.userId, score: r.score, rank: r.rank, raceCount: r.raceCount})),
      materiallyChangedUsers: value.entries.filter(row => Math.abs((prior.get(row.userId)?.score ?? row.score) - row.score) > 1e-9)
        .slice(0, 20).map(row => ({userId: row.userId, priorScore: prior.get(row.userId)?.score, score: row.score, priorRank: prior.get(row.userId)?.rank, rank: row.rank}))};
    t.diagnostic(JSON.stringify(summary));
    for (const [name, artifact] of result.files) assert.ok(Buffer.byteLength(JSON.stringify(artifact) + '\n') <= (name === 'overall.json' ? 16 : 2) * 1024 * 1024);
    return result;
  };
  await check('all-278-frozen', tracks);
  t.diagnostic(JSON.stringify({cohort: 'hybrid-source-bindings', availableStandalone: 278 - missing, missingFrozenFallbacks: missing,
    selectedStandalone: 278 - missing - older, selectedFrozen: missing + older,
    newer, older, equal, literalChangedBindings: newer + older,
    newestSourceChangedBindings: boardBindings.length, boardBindings}));
  await check('literal-272-standalone-plus-6-frozen', standaloneHybrid);
  await check('newest-source-155-standalone-plus-123-frozen', hybrid);
});

test('public identity/cosmetics/beta retained, private fields absent, no input mutation or network', async () => {
  const f = fixture(), row = f.previousOverall.entries[0];
  Object.assign(row, {name: 'Public identity', profileCosmetics: {version: 7, theme: 'dark', credential: 'SECRET'},
    badges: {betaTester: true, privateBadge: 'SECRET'}, groupCode: '123456', ownerUid: 'SECRET', credentials: {token: 'SECRET'}});
  for (const b of f.tracks) for (const r of b.entries) Object.assign(r, {ownerUid: 'SECRET', groupCode: '123456', replay: 'SECRET'});
  const before = structuredClone(f), fetchBefore = globalThis.fetch;
  globalThis.fetch = () => {throw Error('Network forbidden');};
  let result; try {result = await buildOfflineOverall(f);} finally {globalThis.fetch = fetchBefore;}
  assert.deepEqual(f, before);
  assert.equal(overall(result).entries[0].name, 'Public identity');
  assert.deepEqual(overall(result).entries[0].badges, {betaTester: true});
  assert.deepEqual(overall(result).entries[0].profileCosmetics, {version: 7, theme: 'dark'});
  const encoded = JSON.stringify({files: [...result.files], calculation: result.calculation, report: result.report});
  assert.doesNotMatch(encoded, /SECRET|ownerUid|credentials|groupCode|resultSamples|privateBadge/);
});

test('scoring digest change forces a fresh calculation and overflow revisions reject', async () => {
  const f = fixture(), first = await buildOfflineOverall(f);
  f.previousCalculation = {...first.calculation, scoringDigest: 'f'.repeat(64)};
  assert.equal((await buildOfflineOverall(f)).calculation.revision, 11);
  f.previousCalculation = {...first.calculation, revision: Number.MAX_SAFE_INTEGER};
  f.tracks[0].entries[0].timeMs++;
  await assert.rejects(buildOfflineOverall(f), /revision/);
  f.previousCalculation = {...first.calculation, algorithmVersion: 'unsupported'};
  await assert.rejects(buildOfflineOverall(f), /version/);
});

test('new users need no prior entries, but singleton-only boards cannot manufacture an Overall', async () => {
  const f = fixture(); f.previousOverall.entries = []; f.previousOverall.totalEntries = 0;
  const result = await buildOfflineOverall(f);
  assert.equal(overall(result).entries.length, 5);
  assert.ok(overall(result).entries.every(row => row.rankSince === 2000));
  for (const board of f.tracks) {
    board.entries = rankTrustedTrackEntries([board.entries[0]], board.trackId); board.totalEntries = 1;
  }
  await assert.rejects(buildOfflineOverall(f), /Empty Overall/);
});
