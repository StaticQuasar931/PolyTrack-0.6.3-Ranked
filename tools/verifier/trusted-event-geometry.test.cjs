'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {geometryDecision} = require('./geometry.cjs');
const {partitionTrustedTracks, _internals} = require('./kodub-track.cjs');
const {sha256, LIMITS} = require('./replay.cjs');
const {verifyBatch} = require('./verify.cjs');
const policy = require('./track-geometry.json');
const root = path.resolve(__dirname, '../..');

test('all 17 official exports, including weekly Desert 1, pass exact trusted preflight', () => {
  const official = policy.tracks.filter(row => row.name.startsWith('tracks/official/'));
  assert.equal(official.length, 17);
  for (const row of official) {
    const code = fs.readFileSync(path.join(root, row.name), 'utf8').trim();
    assert.equal(sha256(code), row.hash);
    assert.equal(_internals.preflightTrackCode(code, row).parts, row.parts);
    const partition = partitionTrustedTracks([{trackId: row.id, code, codeHash: row.hash}], [row.id]);
    assert.equal(partition.rejected.size, 0, row.name);
    assert.equal(partition.accepted.length, 1);
  }
});

test('reviewed static geometry survives exact trusted event transport names only', () => {
  const rows = policy.tracks.filter(row => row.name.startsWith('tracks/') && row.parts > LIMITS.trackParts);
  assert(rows.length > 0);
  for (const row of rows) {
    const track = {...row, name: `trusted/${row.id}.track`, trusted: true, geometry: row};
    assert.equal(geometryDecision(track, policy.engineDigest).geometryPolicy, 'reviewed-pinned', row.name);
    for (const change of [
      {trusted: false}, {name: 'trusted/unreviewed.track'}, {id: 'f'.repeat(64)},
      {hash: 'f'.repeat(64)}, {geometry: {...row, parts: row.parts + 1}},
      {geometry: {...row, spanX: row.spanX + 1}}, {geometry: {...row, spanZ: row.spanZ + 1}},
      {geometry: {...row, spanX: LIMITS.trackSpan + 1}},
    ]) assert.equal(geometryDecision({...track, ...change}, policy.engineDigest).reason, 'track_geometry_limit');
    assert.equal(geometryDecision(track, 'wrong-engine').reason, 'track_geometry_limit');
  }
});

test('current and archived registry assets pass reviewed preflight without trusting history names', async () => {
  const {loadWeeklyTrustedTrack} = await import('./weekly-track.mjs');
  const registry = JSON.parse(fs.readFileSync(path.join(root, 'events/kodub/trusted-tracks.json')));
  const history = JSON.parse(fs.readFileSync(path.join(root, 'events/kodub/history.json')));
  const current = JSON.parse(fs.readFileSync(path.join(root, 'events/kodub/current.json'))).current;
  const jobs = [...history, current].map(row => ({trackId: row.trackId}));
  const tracks = loadWeeklyTrustedTrack(root, jobs);
  assert.equal(tracks.length, registry.length);
  assert(tracks.some(row => row.trackId === current.trackId));
  const {accepted, rejected} = partitionTrustedTracks(tracks, jobs.map(row => row.trackId));
  assert.deepEqual([...rejected], []);
  assert.equal(accepted.length, tracks.length);
});

test('unreviewed weekly code cannot poison a small official job or skip replay authentication', async () => {
  const official = policy.tracks.find(row => row.name === 'tracks/official/desert1.track');
  // Pin Spite's bytes: the rotating weekly track need not exceed the default part cap.
  const codeHash = 'a6ccd78cc443cd848a41da11d94904d2fffb7647d0ecafca64562eb53480ea2b';
  const code = fs.readFileSync(path.join(root, 'events/kodub/assets', codeHash + '.track'), 'utf8');
  assert.equal(sha256(code), codeHash);
  assert.equal(LIMITS.trackParts, 20000);
  assert.throws(() => _internals.preflightTrackCode(code), {reason: 'trusted_track_part_limit'});
  const unknown = 'f'.repeat(64);
  assert(!policy.tracks.some(row => row.id === unknown));
  const trusted = [{trackId: unknown, code, codeHash}];
  const jobs = [official.id, unknown].map((trackId, index) => ({
    resultId: `offline-${index}`, trackId, timeMs: 1000,
    replay: 'not-a-replay', replayHash: sha256('not-a-replay'),
  }));
  // Both jobs fail before browser startup. The official job must reach replay decoding.
  const results = await verifyBatch(root, jobs, trusted);
  assert.equal(results[0].reason, 'invalid_zlib');
  assert.equal(results[1].status, 'unavailable');
  assert.equal(results[1].reason, 'trusted_track_part_limit');
  assert.equal(results[1].trackContentHash, null);
  assert.equal(results[1].binding.nativeTrackId, null);
  const [badHash, stillRejected] = await verifyBatch(root,
    [{...jobs[0], replayHash: '0'.repeat(64)}, jobs[1]], trusted);
  assert.equal(badHash.reason, 'replay_hash_mismatch');
  assert.equal(stillRejected.reason, 'trusted_track_part_limit');
});

test('four-job event batches reach replay validation for the current weekly track and Desert 1', async () => {
  const {runEventCoordinator} = await import('./events.mjs');
  const current = JSON.parse(fs.readFileSync(path.join(root, 'events/kodub/current.json'))).current;
  const official = policy.tracks.find(row => row.name === 'tracks/official/desert1.track');
  for (const row of [
    {id: current.trackId, name: path.join('events/kodub', current.trackUrl)}, official,
  ]) {
    const code = fs.readFileSync(path.join(root, row.name), 'utf8').trim();
    const period = {id: 'offline-weekly', kind: 'kodub', trackId: row.id,
      kodub: {trackCode: code, trackCodeHash: sha256(code)}};
    const replay = 'not-a-replay';
    const jobs = Array.from({length:4}, (_, index) => ({resultId:`offline-${index}`, trackId:row.id,
      timeMs:1000, replay, replayHash:sha256(replay)}));
    let called = false;
    const result = await runEventCoordinator({service: {
      // This fixture returns verifier output, never calls a real service or publishes.
      processBatch: async (_id, verify) => {
        assert.equal(called, false); called = true;
        return verify(jobs, period);
      },
    }}, root, {limit:4, verifyBatch,
      consumeInbox:async () => ({consumed:0}),
      readWork:async () => ({periodIds:[period.id], archiveId:null}),
    });
    assert.equal(result.checked, 4);
    assert(result.results.every(result => result.reason === 'invalid_zlib'), row.id);
  }
});
