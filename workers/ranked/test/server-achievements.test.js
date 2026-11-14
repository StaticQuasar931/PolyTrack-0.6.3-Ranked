import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateServerAchievements,
  BEAT_OWNER_STAGES,
  casualRpForPlacement,
  OWNER_PUBLIC_ID,
  SPECIAL_ROLLING_HILLS_TRACK_ID
} from '../src/server-achievements.js';
import {EXTRA_TRACK_IDS} from '../src/extra-track-ids.js';
import {computeTrackEntries} from '../src/index.js';
import {VERIFIER_ENGINE_DIGEST, VERIFIER_VERSION, verificationKey} from '../src/verification.js';
import {COMPETITIVE_REVIEW_REASON} from '../src/competitive-review.js';

const OFFICIAL = '5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038';
const OTHER_OFFICIAL = '7eac4fee1111152cfba4d3737410264ca0f22c7f5a2211e79f0099589b8b48c0';
const CATALOG = [OFFICIAL, OTHER_OFFICIAL, SPECIAL_ROLLING_HILLS_TRACK_ID];

function board(trackId, entries, revision = 7) {
  return { trackId, entries, revision, sourceRevision: revision, updatedAt: 1780000000000 + revision,
    signature: `${trackId.slice(0, 20)}_verified_snapshot`, complete: true };
}

function run(accountId, timeMs, extra = {}) {
  return { accountId, timeMs, pbAt: 1770000000000, integrityVerified: true, runVerified: true, weight: 1, ...extra };
}

const ownerOptions = {eligibleTrackIds: CATALOG, beatOwnerTrackIds: CATALOG, now: 1800000000000};

test('exact trusted ties qualify any racer and the owner on three distinct tracks', () => {
  const boards = CATALOG.map(trackId => board(trackId, [run(OWNER_PUBLIC_ID, 22000), run('racer', 22000)]));
  const first = aggregateServerAchievements([{userId: 'racer'}, {userId: OWNER_PUBLIC_ID}], boards, new Map(), ownerOptions);
  for (const entry of first.entries) {
    assert.equal(entry.serverAchievements.beatOwner.count, 3);
    assert.deepEqual(entry.cosmeticUnlocks, BEAT_OWNER_STAGES.map(stage => stage.cosmeticId));
    for (const proof of entry.serverAchievements.beatOwner.unlocks) {
      assert.equal(proof.playerTimeMs, proof.targetTimeMs);
      assert.equal(proof.source, 'ranked-track-snapshot');
    }
  }
  const later = aggregateServerAchievements(first.entries, [], new Map(first.entries.map(entry => [entry.userId, entry])),
    {...ownerOptions, now: ownerOptions.now + 1000});
  for (let i = 0; i < first.entries.length; i++) {
    assert.deepEqual(later.entries[i].serverAchievements.beatOwner, first.entries[i].serverAchievements.beatOwner);
  }
});

test('one millisecond slower fails, while repeated tied proofs count only one distinct track', () => {
  const duplicate = board(OFFICIAL, [run(OWNER_PUBLIC_ID, 22000), run('tied', 22000), run('tied', 22000), run('slow', 22001)]);
  const result = aggregateServerAchievements([{userId: 'tied'}, {userId: 'slow'}], [duplicate, duplicate], new Map(), ownerOptions);
  assert.equal(result.entries[0].serverAchievements.beatOwner.count, 1);
  assert.deepEqual(result.entries[0].cosmeticUnlocks, ['emblem:target']);
  assert.equal(result.entries[1].serverAchievements.beatOwner.count, 0);
  assert.deepEqual(result.entries[1].cosmeticUnlocks, []);
});

test('duplicate rows use the fastest verified owner target independent of row order', () => {
  for (const ownerRows of [[run(OWNER_PUBLIC_ID, 24000), run(OWNER_PUBLIC_ID, 22000)],
    [run(OWNER_PUBLIC_ID, 22000), run(OWNER_PUBLIC_ID, 24000)]]) {
    const result = aggregateServerAchievements([{userId: 'slow'}], [board(OFFICIAL,
      [...ownerRows, run('slow', 23000)])], new Map(), ownerOptions).entries[0];
    assert.equal(result.serverAchievements.beatOwner.count, 0);
  }
});

test('ties still require eligible tracks and immutable current snapshot evidence', () => {
  for (const overrides of [{signature: ''}, {sourceRevision: 6}, {updatedAt: 0}, {revision: 0}]) {
    const result = aggregateServerAchievements([{userId: 'racer'}], [{...board(OFFICIAL,
      [run(OWNER_PUBLIC_ID, 22000), run('racer', 22000)]), ...overrides}], new Map(), ownerOptions).entries[0];
    assert.deepEqual(result.cosmeticUnlocks, []);
  }
  const result = aggregateServerAchievements([{userId: 'racer'}], [board('f'.repeat(64),
    [run(OWNER_PUBLIC_ID, 22000), run('racer', 22000)])], new Map(), ownerOptions).entries[0];
  assert.equal(result.serverAchievements.beatOwner.count, 0);
});

for (const rejected of ['racer', OWNER_PUBLIC_ID]) {
  for (const status of ['unavailable', 'waiting', 'mismatch', 'stale-key']) {
    test(`trusted tie flow fails closed for ${rejected === 'racer' ? 'player' : 'owner'} ${status}`, () => {
      const rows = ['racer', OWNER_PUBLIC_ID].map((accountId, index) => ({accountId, trackId: OFFICIAL,
        timeMs: 22000, frames: 22000, raceTimeFrames: 22000, uploadId: index + 1,
        integrityVerified: true, replayHash: String(index + 1).repeat(64), replay: 'fixture-replay'}));
      const verdicts = Object.fromEntries(rows.map(row => [row.accountId, {status: 'verified',
        key: verificationKey(row), verifierVersion: VERIFIER_VERSION, engineDigest: VERIFIER_ENGINE_DIGEST}]));
      if (status === 'stale-key') verdicts[rejected].key += '-stale';
      else verdicts[rejected] = {...verdicts[rejected], status,
        ...(status === 'unavailable' ? {reason: COMPETITIVE_REVIEW_REASON, retryAt: Number.MAX_SAFE_INTEGER} : {})};
      const trusted = computeTrackEntries(rows, OFFICIAL, {}, verdicts);
      assert.equal(trusted.find(row => row.accountId === rejected).runVerified, false);
      const result = aggregateServerAchievements([{userId: 'racer'}, {userId: OWNER_PUBLIC_ID}],
        [board(OFFICIAL, trusted)], new Map(), ownerOptions);
      assert.deepEqual(result.entries[0].cosmeticUnlocks, []);
      if (rejected === OWNER_PUBLIC_ID) assert.deepEqual(result.entries[1].cosmeticUnlocks, []);
    });
  }
}

test('accepted exact-bound verifier proofs produce tied achievement evidence', () => {
  const rows = ['racer', OWNER_PUBLIC_ID].map((accountId, index) => ({accountId, trackId: OFFICIAL,
    timeMs: 22000, frames: 22000, raceTimeFrames: 22000, uploadId: index + 1,
    integrityVerified: true, replayHash: String(index + 1).repeat(64), replay: 'fixture-replay'}));
  const verdicts = Object.fromEntries(rows.map(row => [row.accountId, {status: 'verified', key: verificationKey(row),
    verifierVersion: VERIFIER_VERSION, engineDigest: VERIFIER_ENGINE_DIGEST}]));
  const trusted = computeTrackEntries(rows, OFFICIAL, {}, verdicts);
  const result = aggregateServerAchievements([{userId: 'racer'}, {userId: OWNER_PUBLIC_ID}],
    [board(OFFICIAL, trusted)], new Map(), ownerOptions);
  for (const entry of result.entries) assert.deepEqual(entry.cosmeticUnlocks, ['emblem:target']);
});

test('server aggregation rejects integrity-only rows from every authoritative metric', () => {
  const result = aggregateServerAchievements([{userId: 'racer'}], [board(OFFICIAL, [
    run(OWNER_PUBLIC_ID, 22000),
    run('racer', 21000, {runVerified: false}),
    run('verified', 21500)
  ])], new Map(), {eligibleTrackIds: CATALOG, beatOwnerTrackIds: CATALOG, now: 1800000000000});
  const racer = result.entries[0];
  assert.equal(racer.casualRp, 0);
  assert.equal(racer.serverAchievements.beatOwner.count, 0);
  assert.deepEqual(racer.cosmeticUnlocks, []);
  assert.equal(result.audit.integrityOnlyRejected, 1);
  assert.equal(result.audit.physicsVerifiedEntries, 2);
});

test('verified owner beats issue staged cosmetics with immutable snapshot evidence', () => {
  const first = aggregateServerAchievements([{userId: 'racer'}], [
    board(OFFICIAL, [run(OWNER_PUBLIC_ID, 22000), run('racer', 21000)]),
    board(OTHER_OFFICIAL, [run(OWNER_PUBLIC_ID, 23000), run('racer', 22000)]),
    board(SPECIAL_ROLLING_HILLS_TRACK_ID, [run(OWNER_PUBLIC_ID, 24000), run('racer', 23000)])
  ], new Map(), {eligibleTrackIds: CATALOG, beatOwnerTrackIds: CATALOG, now: 1800000000000});
  const earned = first.entries[0];
  assert.equal(earned.serverAchievements.beatOwner.count, 3);
  assert.deepEqual(earned.cosmeticUnlocks, BEAT_OWNER_STAGES.slice(0, 2).map(stage => stage.cosmeticId));
  assert.equal(earned.serverAchievements.beatOwner.unlocks[0].source, 'ranked-track-snapshot');
  assert.equal(earned.serverAchievements.beatOwner.unlocks[0].sourceRevision, 7);
  assert.equal(earned.serverAchievements.beatOwner.unlocks[0].unlockedAt, 1800000000000);

  const prior = new Map([['racer', earned]]);
  const later = aggregateServerAchievements([{userId: 'racer'}], [
    board(OFFICIAL, [run(OWNER_PUBLIC_ID, 20000), run('racer', 21000)], 9)
  ], prior, {eligibleTrackIds: CATALOG, beatOwnerTrackIds: CATALOG, now: 1900000000000}).entries[0];
  assert.equal(later.serverAchievements.beatOwner.count, 3);
  assert.deepEqual(later.serverAchievements.beatOwner.unlocks, earned.serverAchievements.beatOwner.unlocks);
});

test('Casual completions are once per recognized verified track and legacy ledgers do not fabricate RP', () => {
  const first = aggregateServerAchievements([{userId: 'racer'}], [
    board(OFFICIAL, [run('racer', 21000), run('racer', 22000), run('rival', 23000)]),
    board(OTHER_OFFICIAL, [run('racer', 23000), run('rival', 24000)]),
    board('f'.repeat(64), [run('racer', 19000)])
  ], new Map(), {
    eligibleTrackIds: CATALOG, beatOwnerTrackIds: CATALOG, now: 1800000000000
  }).entries[0];
  assert.equal(first.casualCompletionCount, 2);
  assert.equal(first.casualRp, 200);
  assert.equal(first.serverAchievements.casual.rp, 200);
  assert.equal(first.serverAchievements.casual.scoringVersion, 2);
  assert.equal('pointsPerTrack' in first.serverAchievements.casual, false);

  const later = aggregateServerAchievements([{userId: 'racer'}], [], new Map([['racer', first]]), {
    eligibleTrackIds: CATALOG, beatOwnerTrackIds: CATALOG, now: 1900000000000
  }).entries[0];
  assert.equal(later.casualCompletionCount, 2);
  assert.equal(later.casualRp, null, 'a legacy completion ledger must not be converted into placement points');
  assert.equal(later.serverAchievements.casual.ledger, first.serverAchievements.casual.ledger);

  const legacyPositive = aggregateServerAchievements([{userId: 'racer'}], [
    board(OFFICIAL, [run('racer', 21000)])
  ], new Map([['racer', {casualRp: 999999}]]), {
    eligibleTrackIds: CATALOG, beatOwnerTrackIds: [], now: 1900000000000
  }).entries[0];
  assert.equal(legacyPositive.casualRp, null, 'an old aggregate without placement evidence remains unknown');
  assert.equal(legacyPositive.serverAchievements.casual.scoringVersion, 2);
});

test('Casual RP scales placement percentile by published weight without a fixed score cap', () => {
  assert.equal(casualRpForPlacement(1, 3, 1), 100);
  assert.equal(casualRpForPlacement(2, 3, 1), 55);
  assert.equal(casualRpForPlacement(3, 3, 1), 10);
  assert.equal(casualRpForPlacement(1, 1, 1), 10);
  assert.equal(casualRpForPlacement(1, 3, 2), 200);
  assert.equal(casualRpForPlacement(0, 3, 1), null);
  assert.equal(casualRpForPlacement(4, 3, 1), null);
  assert.equal(casualRpForPlacement(1, 3, undefined), null);

  const initial = aggregateServerAchievements([{userId: 'racer'}], [board(OFFICIAL, [
    run('racer', 21000), run('rival', 22000), run('third', 23000)
  ])], new Map(), {eligibleTrackIds: CATALOG, beatOwnerTrackIds: [], now: 1800000000000}).entries[0];
  const rivalImproved = aggregateServerAchievements([{userId: 'racer'}], [board(OFFICIAL, [
    run('rival', 20000), run('racer', 21000), run('third', 23000)
  ])], new Map(), {eligibleTrackIds: CATALOG, beatOwnerTrackIds: [], now: 1800000000000}).entries[0];
  const racerImproved = aggregateServerAchievements([{userId: 'racer'}], [board(OFFICIAL, [
    run('racer', 19000), run('rival', 20000), run('third', 23000)
  ])], new Map(), {eligibleTrackIds: CATALOG, beatOwnerTrackIds: [], now: 1800000000000}).entries[0];
  assert.equal(initial.casualRp, 100);
  assert.equal(rivalImproved.casualRp, 55);
  assert.equal(racerImproved.casualRp, 100);
  assert.ok(racerImproved.casualRp > rivalImproved.casualRp);
});

test('equal verified PB times share the same competition rank and Casual RP', () => {
  const entries = aggregateServerAchievements([{userId: 'alpha'}, {userId: 'beta'}, {userId: 'third'}], [board(OFFICIAL, [
    run('alpha', 21000), run('beta', 21000), run('third', 23000)
  ])], new Map(), {eligibleTrackIds: [OFFICIAL], beatOwnerTrackIds: []}).entries;
  assert.equal(entries.find(row => row.userId === 'alpha').casualRp, 100);
  assert.equal(entries.find(row => row.userId === 'beta').casualRp, 100);
  assert.equal(entries.find(row => row.userId === 'third').casualRp, 10);
});

test('Casual RP uses the capped published Extra weight, with cap independent of board order', () => {
  const extra = [...EXTRA_TRACK_IDS][0];
  const extraBoard = board(extra, [run('racer', 21000, {weight: 9}), run('rival', 22000, {weight: 9})]);
  const normalBoard = board(OFFICIAL, [run('racer', 21000, {weight: 2}), run('rival', 22000, {weight: 2})]);
  const result = aggregateServerAchievements([{userId: 'racer'}], [extraBoard, normalBoard], new Map(), {
    eligibleTrackIds: [extra, OFFICIAL], beatOwnerTrackIds: []
  }).entries[0];
  assert.equal(result.casualRp, 240, 'normal 200 plus Extra 10 points times the 0.4 cap');
});

test('missing published track weight leaves Casual RP unknown', () => {
  const noWeight = run('racer', 21000);
  delete noWeight.weight;
  const entry = aggregateServerAchievements([{userId: 'racer'}], [board(OFFICIAL, [noWeight, run('rival', 22000)])], new Map(), {
    eligibleTrackIds: [OFFICIAL], beatOwnerTrackIds: []
  }).entries[0];
  assert.equal(entry.casualCompletionCount, 1);
  assert.equal(entry.casualRp, null);
  assert.equal(entry.serverAchievements.casual.rp, null);
});

test('a slower personal attempt cannot replace the PB used for Casual RP', () => {
  const canonicalRun = (accountId, timeMs, uploadId) => ({accountId, trackId: OFFICIAL, timeMs,
    raceTimeFrames: timeMs, frames: timeMs, replay: 'fixture-replay', replayHash: 'a'.repeat(64),
    uploadId, integrityVerified: true});
  const faster = canonicalRun('racer', 21000, 1);
  const allRuns = [faster, canonicalRun('racer', 25000, 2), canonicalRun('rival', 22000, 3)];
  const verdicts = Object.fromEntries([faster, allRuns[2]].map(row => [row.accountId, {
    key: verificationKey(row), status: 'verified', verifierVersion: VERIFIER_VERSION, engineDigest: VERIFIER_ENGINE_DIGEST
  }]));
  const entries = computeTrackEntries(allRuns, OFFICIAL, {}, verdicts);
  const awarded = aggregateServerAchievements([{userId: 'racer'}], [board(OFFICIAL, entries)], new Map(), {
    eligibleTrackIds: CATALOG, beatOwnerTrackIds: []
  }).entries[0];
  assert.equal(entries.filter(row => row.accountId === 'racer').length, 1);
  assert.equal(entries.find(row => row.accountId === 'racer').timeMs, 21000);
  assert.equal(awarded.casualRp, 9, 'the verified PB contributes its published 0.09 track weight');
});

test('incomplete track snapshots leave placement-based Casual RP unknown', () => {
  const incomplete = {...board(OFFICIAL, [run('racer', 21000), run('rival', 22000)]), complete: false};
  const entry = aggregateServerAchievements([{userId: 'racer'}], [incomplete], new Map(), {
    eligibleTrackIds: CATALOG, beatOwnerTrackIds: []
  }).entries[0];
  assert.equal(entry.casualCompletionCount, 1);
  assert.equal(entry.casualRp, null);
});

test('owner achievements require an immutable current snapshot source', () => {
  const incompleteSource = board(OFFICIAL, [run(OWNER_PUBLIC_ID, 22000), run('racer', 21000)]);
  incompleteSource.signature = '';
  const entry = aggregateServerAchievements([{userId: 'racer'}], [incompleteSource], new Map(), {
    eligibleTrackIds: CATALOG, beatOwnerTrackIds: CATALOG, now: 1800000000000
  }).entries[0];
  assert.equal(entry.serverAchievements.beatOwner.count, 0);
  assert.deepEqual(entry.cosmeticUnlocks, []);
});
