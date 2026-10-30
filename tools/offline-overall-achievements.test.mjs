import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {buildOfflineOverall} from './offline-overall.mjs';
import {publicOverallBackup} from './public-snapshot-backup.mjs';
import {computeOverall, rankTrustedTrackEntries} from '../workers/ranked/src/index.js';
import {aggregateServerAchievements, OWNER_PUBLIC_ID, SPECIAL_ROLLING_HILLS_TRACK_ID} from '../workers/ranked/src/server-achievements.js';

const worker = await readFile(new URL('../workers/ranked/src/index.js', import.meta.url), 'utf8');
const offline = await readFile(new URL('./offline-overall.mjs', import.meta.url), 'utf8');
const catalog = name => JSON.parse(worker.match(new RegExp('^const ' + name + ' = new Set\\((.*)\\);', 'm'))[1].replaceAll("'", '"'));
const official = catalog('OFFICIAL_IDS');
const community = catalog('COMMUNITY_IDS');
const legacy = catalog('LEGACY_COMMUNITY_IDS');
const policy = {eligibleTrackIds: [...official, ...community, ...legacy],
  beatOwnerTrackIds: [...official, SPECIAL_ROLLING_HILLS_TRACK_ID], ownerPublicId: OWNER_PUBLIC_ID};
const player = '1'.repeat(64);
const other = '2'.repeat(64);
const meta = {algorithmVersion: 'participation-v8-s1', schemaVersion: 6,
  sourceRevision: 10, builtRevision: 10, revision: 10, updatedAt: 1000};
const output = result => result.files.get('overall.json');
const playerRow = result => output(result).entries.find(row => row.userId === player);

function fixture(ids = official.slice(0, 3)) {
  const tracks = ids.map(trackId => ({...meta, trackId, complete: true, totalEntries: 3,
    signature: 'signed_public_snapshot_123456',
    entries: rankTrustedTrackEntries([player, OWNER_PUBLIC_ID, other].map((accountId, index) => ({
      accountId, trackId, timeMs: 10000 + index * 1000, pbAt: 100,
      name: 'Public racer', runVerified: true, integrityVerified: true
    })), trackId)}));
  const entries = computeOverall(tracks);
  return {tracks, previousOverall: {...meta, entries, complete: true, totalEntries: entries.length,
    trackSummaries: [], trackCatalog: ids.map(trackId => ({trackId, updatedAt: 1000}))},
  expectedTrackIds: ids, now: 2000};
}

function expected(f) {
  const prior = publicOverallBackup(f.previousOverall).snapshot.entries;
  const boards = f.tracks.map(board => ({...board, entries: rankTrustedTrackEntries(
    board.entries.filter(row => row.runVerified && row.integrityVerified && !row.unranked &&
      row.verificationStatus !== 'held' && row.validationState !== 'changed'), board.trackId)}));
  return aggregateServerAchievements(computeOverall(boards, prior), boards,
    new Map(prior.map(row => [row.userId, row])), {...policy, now: f.now}).entries;
}

test('offline achievement catalog ordering exactly matches the worker policy', () => {
  for (const name of ['OFFICIAL_IDS', 'COMMUNITY_IDS', 'LEGACY_COMMUNITY_IDS']) {
    assert.equal(offline.match(new RegExp('^const ' + name + ' = new Set\\((.*)\\);', 'm'))[1],
      worker.match(new RegExp('^const ' + name + ' = new Set\\((.*)\\);', 'm'))[1]);
  }
});

test('offline awards and Casual RP equal pure worker aggregation, including signed owner proofs', async () => {
  const f = fixture();
  const original = structuredClone(f);
  const result = await buildOfflineOverall(f);
  const projected = publicOverallBackup({...meta, entries: expected(f), trackSummaries: []}).snapshot.entries;
  for (const row of output(result).entries) {
    const reference = projected.find(candidate => candidate.userId === row.userId);
    for (const key of ['serverAchievements', 'casualRp', 'casualCompletionCount', 'cosmeticUnlocks']) {
      assert.deepEqual(row[key], reference[key], key);
    }
  }
  assert.equal(playerRow(result).casualCompletionCount, 3);
  assert.ok(playerRow(result).casualRp > 0);
  assert.equal(playerRow(result).serverAchievements.beatOwner.count, 3);
  assert.deepEqual(playerRow(result).cosmeticUnlocks, ['emblem:target', 'stripe:overdrive']);
  assert.equal(output(result).serverAchievementVersion, 1);
  assert.deepEqual(f, original, 'pure calculation must not mutate captures');
  assert.equal(result.report.networkRequests, 0);
  assert.equal(result.report.writes, 0);
});

test('community, legacy and custom tracks follow worker eligibility and owner-target rules', async () => {
  const f = fixture([SPECIAL_ROLLING_HILLS_TRACK_ID, community[1], legacy[0], 'f'.repeat(64)]);
  const row = playerRow(await buildOfflineOverall(f));
  assert.equal(row.casualCompletionCount, 3, 'custom tracks cannot earn Casual RP');
  assert.equal(row.serverAchievements.beatOwner.count, 1, 'only Rolling Hills is owner-eligible here');
  assert.deepEqual(row.cosmeticUnlocks, ['emblem:target']);
});

test('unverified, held and changed PBs cannot mint completions or owner achievements', async () => {
  const changes = [row => {row.runVerified = false;}, row => {row.integrityVerified = false;},
    row => {row.verificationStatus = 'held';}, row => {row.validationState = 'changed';},
    row => {row.unranked = true;}];
  for (const change of changes) {
    const f = fixture();
    for (const board of f.tracks.slice(0, 2)) change(board.entries.find(row => row.accountId === player));
    delete f.tracks[2].signature;
    const row = playerRow(await buildOfflineOverall(f));
    assert.equal(row.casualCompletionCount, 1);
    assert.equal(row.serverAchievements.beatOwner.count, 0);
    assert.deepEqual(row.cosmeticUnlocks, []);
  }
});

test('validated issued proof survives a later board without a live owner beat; arbitrary flags do not', async () => {
  const f = fixture();
  const issued = aggregateServerAchievements(computeOverall(f.tracks), f.tracks, new Map(), {...policy, now: 1500}).entries;
  f.previousOverall.entries = issued;
  for (const board of f.tracks) {
    const rows = board.entries.map(row => row.accountId === OWNER_PUBLIC_ID ? {...row, timeMs: 9000} : row);
    board.entries = rankTrustedTrackEntries(rows, board.trackId);
  }
  const row = playerRow(await buildOfflineOverall(f));
  assert.deepEqual(row.serverAchievements.beatOwner.unlocks,
    publicOverallBackup({...meta, entries: issued, trackSummaries: []}).snapshot.entries
      .find(candidate => candidate.userId === player).serverAchievements.beatOwner.unlocks);
  assert.deepEqual(row.cosmeticUnlocks, ['emblem:target', 'stripe:overdrive']);
  const previous = f.previousOverall.entries.find(candidate => candidate.userId === player);
  previous.serverAchievements = {beatOwner: {count: 999, unlocks: [{cosmeticId: 'stripe:overdrive', unlockedAt: 1}]}};
  previous.cosmeticUnlocks = ['stripe:overdrive', 'emblem:admin'];
  const invalid = playerRow(await buildOfflineOverall(f));
  assert.deepEqual(invalid.cosmeticUnlocks, []);
  assert.equal(invalid.serverAchievements.beatOwner.count, 0);
});

test('achievement evidence participates in the input digest and stable reruns retain proof timestamps', async () => {
  const f = fixture();
  const first = await buildOfflineOverall(f);
  f.previousCalculation = first.calculation;
  f.now = 99999;
  const same = await buildOfflineOverall(f);
  assert.equal(same.report.unchanged, true);
  assert.deepEqual(same.files, first.files);
  assert.deepEqual(same.calculation, first.calculation);
  f.previousOverall.entries = aggregateServerAchievements(computeOverall(f.tracks), f.tracks, new Map(), {...policy, now: 1500}).entries;
  const changed = await buildOfflineOverall(f);
  assert.notEqual(changed.calculation.inputDigest, first.calculation.inputDigest);
  assert.equal(changed.calculation.revision, first.calculation.revision + 1);
  assert.equal(changed.report.unchanged, false);
  assert.ok(playerRow(changed).serverAchievements.beatOwner.unlocks.every(proof => proof.unlockedAt === 1500));
});

test('legacy positive Casual RP without a ledger remains unknown instead of becoming a fabricated total', async () => {
  const f = fixture();
  f.previousOverall.entries.find(row => row.userId === player).casualRp = 500;
  const row = playerRow(await buildOfflineOverall(f));
  assert.equal(row.casualRp, null);
  assert.equal(row.serverAchievements.casual.rp, null);
});

test('retained completion ledger cannot invent RP for a currently absent verified PB', async () => {
  const f = fixture();
  f.previousOverall.entries = aggregateServerAchievements(computeOverall(f.tracks), f.tracks,
    new Map(), {...policy, now: 1500}).entries;
  const board = f.tracks[0];
  board.entries = rankTrustedTrackEntries(board.entries.filter(row => row.accountId !== player), board.trackId);
  board.totalEntries = board.entries.length;
  const row = playerRow(await buildOfflineOverall(f));
  assert.equal(row.casualCompletionCount, 3, 'issued completions persist independently of current PBs');
  assert.equal(row.casualRp, null, 'missing placement evidence must not become a partial RP total');
  assert.deepEqual(row.cosmeticUnlocks, ['emblem:target', 'stripe:overdrive']);
});

test('source signature changes invalidate receipts; missing signatures cannot issue owner proofs', async () => {
  const f = fixture();
  const first = await buildOfflineOverall(f);
  f.previousCalculation = first.calculation;
  for (const board of f.tracks) delete board.signature;
  const changed = await buildOfflineOverall(f);
  assert.notEqual(changed.calculation.inputDigest, first.calculation.inputDigest);
  assert.equal(changed.report.unchanged, false);
  assert.deepEqual(playerRow(changed).cosmeticUnlocks, []);
  assert.equal(playerRow(changed).serverAchievements.beatOwner.count, 0);
});
