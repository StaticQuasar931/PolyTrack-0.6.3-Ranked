import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {publicOverallBackup, publicTrackBackup, publicEventBackup, publicTrackRegistry, chooseTrackFetches,
  publicEventReplayBackup, runPublicSnapshotBackup, PUBLIC_SNAPSHOT_LIMITS} from './public-snapshot-backup.mjs';

const trackId = 'a'.repeat(64);
const period = {id: 'daily_20261002', trackId, startsAt: 100, endsAt: 200, maxRp: 100, kind: 'daily'};
const overall = {updatedAt: 300, revision: 9, builtRevision: 9, sourceRevision: 9, algorithmVersion: 'v1',
  schemaVersion: 6, complete: true, entries: [{userId: 'racer', name: 'Racer', score: 10, replayHash: 'private',
    ownerUid: 'private', resultSamples: [{replay: 'private'}], bestTracks: [{trackId, rank: 1, replayHash: 'private'}]}],
  trackSummaries: [{trackId, updatedAt: 250, fieldSize: 2, leader: {accountId: 'racer', name: 'Racer', replay: 'private'}}],
  authorityAudit: {ownerUid: 'private'}, resultBundleLocation: 'main_results'};

test('transient overall and catalog failures preserve every existing backup without retries', async t => {
  for (const stage of ['overall', 'catalog', 'network', 'body', 'empty']) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'polytrack-backup-defer-'));
    t.after(() => fs.rm(directory, {recursive: true, force: true}));
    await fs.mkdir(path.join(directory, 'events'));
    const files = {'manifest.json': JSON.stringify({schemaVersion: 1, tracks: {},
      events: {old: {path: 'events/old.json'}}}), 'overall.json': '{"saved":true}',
      'events/old.json': '{"oldEvent":true}'};
    for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(directory, name), text);
    let calls = 0;
    const result = await runPublicSnapshotBackup({directory, trackIds: [], log: () => {}, fetchImpl: async url => {
      calls++;
      if (stage === 'network') throw TypeError('fetch failed');
      if (stage === 'body') return {ok: true, status: 200, headers: new Headers(), text: async () => {throw Error('interrupted');}};
      if (url.endsWith('/overall')) return stage === 'overall' ? new Response('', {status: 429}) : Response.json(overall);
      if (stage === 'empty') return Response.json({periods: [], archives: []});
      return new Response('', {status: 503});
    }});
    assert.equal(result.deferred, true, stage);
    assert.equal(result.previousBackupsPreserved, true);
    assert.equal(calls, ['catalog', 'empty'].includes(stage) ? 2 : 1, 'no retry loop or later fetches');
    for (const [name, text] of Object.entries(files)) assert.equal(await fs.readFile(path.join(directory, name), 'utf8'), text);
  }
});

test('a mid-batch transient failure stops new fetches and does not publish partial backups', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'polytrack-backup-batch-defer-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const manifest = JSON.stringify({schemaVersion: 1, tracks: {}, events: {}});
  await fs.writeFile(path.join(directory, 'manifest.json'), manifest);
  const ids = Array.from({length: 20}, (_, i) => i.toString(16).padStart(64, '0'));
  let boardRequests = 0;
  const result = await runPublicSnapshotBackup({directory, trackIds: ids, log: () => {}, fetchImpl: async url => {
    if (url.endsWith('/overall')) return Response.json({...overall, trackSummaries: []});
    if (url.endsWith('/catalog')) return Response.json({periods: [], archives: []});
    boardRequests++; return new Response('', {status: 502});
  }});
  assert.equal(result.deferred, true);
  assert.ok(boardRequests <= PUBLIC_SNAPSHOT_LIMITS.concurrency);
  assert.deepEqual(await fs.readdir(directory), ['manifest.json']);
  assert.equal(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'), manifest);
});

test('malformed data and permanent access errors still fail instead of reporting success', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'polytrack-backup-invalid-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  await assert.rejects(runPublicSnapshotBackup({directory, trackIds: [], fetchImpl: async () => new Response('bad json')}), /Invalid public snapshot JSON/);
  await assert.rejects(runPublicSnapshotBackup({directory, trackIds: [], fetchImpl: async () => new Response('', {status: 403})}), /403/);
  await assert.rejects(runPublicSnapshotBackup({directory, trackIds: [], fetchImpl: async () => Response.json({entries: []})}), /Invalid public overall/);
});

test('overall public projection omits private and unrelated account fields when planner sidecar is absent', () => {
  const cosmetics = {version: 7, theme: 'neon', stageEffect: 'spark', emblemBackdrop: 'disc', favoriteTrackId: trackId,
    overridePodium: true, ownerUid: 'private'};
  const result = publicOverallBackup({...overall, entries: [{...overall.entries[0], profileCosmetics: cosmetics,
    cosmeticUnlocks: ['stripe:overdrive', 'nameColor:aurora', 'future_unlock:variant-v2'],
    serverAchievements: {beatOwner: {targetAccountId: 'b'.repeat(64), count: 1,
      unlocks: [{cosmeticId: 'emblem:target', unlockedAt: 44, sourceSignature: 'private-proof'}], privateProof: 'private'}},
    accountCreatedAt: 1, totalPlaytimeMs: 2, latestPbAt: 3, groupCode: '123456', groupCodeUpdatedAt: 4}]});
  assert.equal(result.snapshot.updatedAt, 300);
  assert.equal(result.snapshot.entries[0].score, 10);
  assert.equal(result.snapshot.entries[0].ownerUid, undefined);
  assert.equal(result.snapshot.entries[0].resultSamples, undefined);
  assert.equal(result.snapshot.entries[0].bestTracks[0].replayHash, undefined);
  assert.deepEqual(result.snapshot.entries[0].profileCosmetics, {version: 7, theme: 'neon', stageEffect: 'spark',
    emblemBackdrop: 'disc', favoriteTrackId: trackId, overridePodium: true});
  for (const field of ['cosmeticUnlocks', 'serverAchievements', 'accountCreatedAt', 'totalPlaytimeMs', 'latestPbAt', 'groupCode', 'groupCodeUpdatedAt']) {
    assert.ok(Object.hasOwn(result.snapshot.entries[0], field), `retains public ${field}`);
  }
  assert.deepEqual(result.snapshot.entries[0].cosmeticUnlocks, ['stripe:overdrive', 'nameColor:aurora', 'future_unlock:variant-v2']);
  assert.deepEqual(result.snapshot.entries[0].serverAchievements.beatOwner.unlocks,
    [{cosmeticId: 'emblem:target', unlockedAt: 44}]);
  assert.equal(JSON.stringify(result.snapshot.entries[0]).includes('private-proof'), false);
  assert.equal(result.snapshot.authorityAudit, undefined);
  assert.equal(result.snapshot.resultBundleLocation, undefined);
  assert.equal(result.snapshot.resultBundleComplete, false);
  assert.deepEqual(result.planner, {available: false, reason: 'sidecar-not-in-public-response'});
});

test('inline planner bundle is split into a revision-bound optional results file', () => {
  const {snapshot, planner} = publicOverallBackup({...overall, resultBundleLocation: undefined, resultBundle: 'gzip-data',
    resultBundleVersion: 1, resultBundleEncoding: 'gzip-base64-json-v1', resultBundleComplete: true, resultBundleStatus: 'complete'});
  assert.equal(snapshot.resultBundle, undefined);
  assert.equal(snapshot.resultBundleLocation, 'main_results');
  assert.equal(planner.document.resultBundle, 'gzip-data');
  for (const key of ['sourceRevision', 'builtRevision', 'updatedAt', 'algorithmVersion']) assert.equal(planner.document[key], snapshot[key]);
});

test('track projection preserves public replay lookup fields but excludes payloads and private fields', () => {
  const cosmetics = {version: 2, theme: 'classic', ownerUid: 'private'};
  const value = publicTrackBackup({trackId, updatedAt: 10, revision: 2, complete: true,
    entries: [{id: 'row-id', uploadId: 9, replayHash: 'public-hash', trackId, accountId: 'public-account', timeMs: 12,
      rankModel: 'model-v1', timingVersion: 2, runVerified: true, profileCosmetics: cosmetics,
      validationState: 'integrity', verified: true, verificationStatus: 'verified', createdAt: 3, totalPlaytimeMs: 4,
      pbCount: 5, ownerUid: 'private', replay: 'payload', proof: 'private', audit: 'private'}], privateQueue: []}, trackId);
  const row = value.entries[0];
  assert.equal(row.id, 'row-id'); assert.equal(row.uploadId, 9); assert.equal(row.replayHash, 'public-hash');
  assert.equal(row.accountId, 'public-account'); assert.equal(row.rankModel, 'model-v1');
  assert.equal(row.timingVersion, 2); assert.deepEqual(row.profileCosmetics, {version: 2, theme: 'classic'});
  for (const field of ['trackId', 'validationState', 'verified', 'verificationStatus', 'createdAt', 'totalPlaytimeMs', 'pbCount']) {
    assert.ok(Object.hasOwn(row, field), `retains public ${field}`);
  }
  assert.equal(row.rankModel, 'model-v1');
  assert.equal(row.replay, undefined); assert.equal(row.ownerUid, undefined); assert.equal(row.proof, undefined);
  assert.equal(value.privateQueue, undefined);
  assert.throws(() => publicTrackBackup({...value, trackId: 'b'.repeat(64)}, trackId), /Invalid public track/);
});

test('event snapshots omit pending playback, replay payloads, signatures, and queue fields', () => {
  const finite = publicEventBackup({id: period.id, period, updatedAt: 180, archived: false,
    pendingPlaybacks: [{runId: 'private'}], entries: [{accountId: 'racer', timeMs: 20, rp: 10, rank: 1, replayHash: 'private'}],
    sourceSignature: 'private', privateQueue: []}, period.id);
  assert.equal(finite.entries[0].rp, 10); assert.equal(finite.pendingPlaybacks, undefined);
  assert.equal(finite.sourceSignature, undefined); assert.equal(finite.privateQueue, undefined);
  const permanent = publicEventBackup({id: 'permanent-rolling-hills', kind: 'permanent', trackId, updatedAt: 9,
    complete: true, sourceSignature: 'private', entries: [{accountId: 'racer', rp: 4, rank: 1, replayHash: 'private'}]},
  'permanent-rolling-hills');
  assert.equal(permanent.entries[0].rp, 4); assert.equal(permanent.entries[0].replayHash, undefined);
});

test('event replay backup requires exact public entry binding and valid content hash', () => {
  const accountId = 'c'.repeat(64), replay = 'PolyTrackAA==';
  const entry = {accountId, timeMs: 23};
  const value = {periodId: period.id, trackId, accountId, runId: 'd'.repeat(64), timeMs: 23, frames: 23,
    replay, replayHash: createHash('sha256').update(replay).digest('hex'), carStyle: 'public-style',
    verificationStatus: 'verified', verified: true, eventRpEligible: true,
    ownerUid: 'private', proof: 'private'};
  const backup = publicEventReplayBackup(value, {periodId: period.id, trackId, entry});
  assert.equal(backup.replayHash, value.replayHash);
  assert.equal(backup.ownerUid, undefined);
  assert.throws(() => publicEventReplayBackup({...value, timeMs: 24}, {periodId: period.id, trackId, entry}), /unbound/);
  assert.throws(() => publicEventReplayBackup({...value, replayHash: '0'.repeat(64)}, {periodId: period.id, trackId, entry}), /unbound/);
  assert.throws(() => publicEventReplayBackup({...value, verified: false}, {periodId: period.id, trackId, entry}), /unbound/);
});

test('track registry parser and bounded selection prioritize dirty snapshots and reuse matching timestamps', () => {
  const registry = publicTrackRegistry(`const OFFICIAL_IDS = new Set(["${trackId}"]); const COMMUNITY_IDS = new Set([]); const LEGACY_COMMUNITY_IDS = new Set([]);`,
    `export const EXTRA_TRACK_IDS = new Set(['${'b'.repeat(64)}']);`);
  assert.equal(registry.length, 2);
  const ids = [trackId, 'b'.repeat(64), 'c'.repeat(64)];
  const selected = chooseTrackFetches(ids, [{trackId, updatedAt: 21}, {trackId: ids[1], updatedAt: 10}], {
    [trackId]: {path: `tracks/${trackId}.json`, sourceUpdatedAt: 20, checkedAt: 1},
    [ids[1]]: {path: `tracks/${ids[1]}.json`, sourceUpdatedAt: 10, checkedAt: 1}
  }, 1, 1000000000);
  assert.deepEqual(selected, [trackId]);
  assert.equal(PUBLIC_SNAPSHOT_LIMITS.trackFetches, 100);
});

test('registry supports single/double quoted IDs and trailing commas without evaluating code', () => {
  const legacy = '5aafb733c264d51b09beedc7bd7eabb5e65bdded338980fcb14ae5ce36955572';
  const index = `const OFFICIAL_IDS = new Set(["${trackId}",]); const COMMUNITY_IDS = new Set([]);
    const LEGACY_COMMUNITY_IDS = new Set(['${legacy}']);`;
  assert.deepEqual(publicTrackRegistry(index, `export const EXTRA_TRACK_IDS = new Set([\n '${legacy}', "${trackId}",\n]);`),
    [legacy, trackId].sort());
  assert.throws(() => publicTrackRegistry(index.replace(`['${legacy}']`, `[getIds()]`), 'export const EXTRA_TRACK_IDS = new Set([]);'), /Invalid track registry/);
  assert.throws(() => publicTrackRegistry(index, `export const EXTRA_TRACK_IDS = new Set(['invalid']);`), /Invalid track registry/);
});

test('actual repository registries parse without network access', async () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const registry = publicTrackRegistry(await fs.readFile(path.join(repo, 'workers/ranked/src/index.js'), 'utf8'),
    await fs.readFile(path.join(repo, 'workers/ranked/src/extra-track-ids.js'), 'utf8'));
  assert.ok(registry.includes('5aafb733c264d51b09beedc7bd7eabb5e65bdded338980fcb14ae5ce36955572'));
  assert.ok(registry.length > 200);
  assert.equal(new Set(registry).size, registry.length);
});

test('missing track fetches rotate on later daily runs instead of pinning the first cap', () => {
  const ids = Array.from({length: 140}, (_, i) => i.toString(16).padStart(64, '0'));
  const first = chooseTrackFetches(ids, [], {}, 100, Date.UTC(2026, 9, 2));
  const second = chooseTrackFetches(ids, [], {}, 100, Date.UTC(2026, 9, 3));
  assert.equal(first.length, 100);
  assert.equal(second.length, 100);
  assert.ok(second.some(id => !first.includes(id)));
});

test('workflow stages first-run untracked snapshots before checking for changes', async t => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const workflow = await fs.readFile(path.join(repo, '.github/workflows/sync-event-catalog.yml'), 'utf8');
  const stageCatalog = workflow.indexOf('git add -- events/public-catalog.json');
  const conditionalSnapshots = workflow.indexOf('if [ -d public-snapshots ]; then');
  const stageSnapshots = workflow.indexOf('git add -- public-snapshots', conditionalSnapshots);
  const stagedDiff = workflow.indexOf('git diff --cached --quiet -- events/public-catalog.json public-snapshots');
  assert.ok(stageCatalog >= 0 && conditionalSnapshots > stageCatalog && stageSnapshots > conditionalSnapshots && stagedDiff > stageSnapshots);
  assert.equal(workflow.split('git add -- events/public-catalog.json').length - 1, 1);

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'polytrack-workflow-untracked-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const runGit = (...args) => spawnSync('git', args, {cwd: directory, encoding: 'utf8'});
  assert.equal(runGit('init', '--quiet').status, 0);
  await fs.mkdir(path.join(directory, 'events'));
  await fs.mkdir(path.join(directory, 'public-snapshots'));
  await fs.writeFile(path.join(directory, 'events/public-catalog.json'), '{}');
  await fs.writeFile(path.join(directory, 'public-snapshots/overall.json'), '{}');
  assert.equal(runGit('add', '--', 'events/public-catalog.json').status, 0);
  assert.equal(runGit('add', '--', 'public-snapshots').status, 0);
  assert.equal(runGit('diff', '--cached', '--quiet', '--', 'events/public-catalog.json', 'public-snapshots').status, 1);

  const catalogOnly = await fs.mkdtemp(path.join(os.tmpdir(), 'polytrack-catalog-only-'));
  t.after(() => fs.rm(catalogOnly, {recursive: true, force: true}));
  const init = spawnSync('git', ['init', '--quiet'], {cwd: catalogOnly});
  assert.equal(init.status, 0);
  await fs.mkdir(path.join(catalogOnly, 'events'));
  await fs.writeFile(path.join(catalogOnly, 'events/public-catalog.json'), '{}');
  assert.equal(spawnSync('git', ['add', '--', 'events/public-catalog.json'], {cwd: catalogOnly}).status, 0);
  assert.equal(spawnSync('git', ['diff', '--cached', '--quiet', '--', 'events/public-catalog.json', 'public-snapshots'],
    {cwd: catalogOnly}).status, 1);
});

test('bounded export keeps prior tracks, exports permanent event, and continues boards without a sidecar', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'polytrack-public-snapshots-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const calls = [];
  let overallReadCount = 0;
  const replayAccount = 'e'.repeat(64), replayData = 'PolyTrackAA==';
  const replayHash = createHash('sha256').update(replayData).digest('hex');
  const oldTrack = 'f'.repeat(64);
  await fs.mkdir(path.join(directory, 'tracks'), {recursive: true});
  await fs.writeFile(path.join(directory, `tracks/${oldTrack}.json`), JSON.stringify({trackId: oldTrack, updatedAt: 1, entries: []}));
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({schemaVersion: 1,
    tracks: {[oldTrack]: {path: `tracks/${oldTrack}.json`, sourceUpdatedAt: 1, checkedAt: 1000000000}}, events: {}}));
  const fetchImpl = async input => {
    const url = new URL(input); calls.push(url.pathname + url.search);
    if (url.pathname.endsWith('/v1/snapshot/overall')) return Response.json({...overall,
      trackSummaries: [{trackId, updatedAt: overallReadCount++ === 0 ? 250 : 251}]});
    if (url.pathname.endsWith('/v1/events/catalog')) return Response.json({periods: [period], archives: []});
    if (url.pathname.endsWith('/v1/snapshot/track')) return Response.json({trackId, updatedAt: 251, revision: 1, entries: []});
    if (url.pathname.endsWith('/v1/events/permanent-rolling-hills/snapshot')) return Response.json({id: 'permanent-rolling-hills', updatedAt: 190, entries: []});
    if (url.pathname.endsWith('/v1/events/daily_20261002/snapshot')) return Response.json({id: period.id, period, updatedAt: 180,
      entries: [{accountId: replayAccount, name: 'Racer', timeMs: 23, rp: 10, rank: 1}], pendingPlaybacks: [{runId: 'private'}]});
    if (url.pathname.endsWith(`/v1/events/${period.id}/replays/${replayAccount}`)) return Response.json({periodId: period.id,
      trackId, accountId: replayAccount, runId: 'd'.repeat(64), timeMs: 23, frames: 23, replay: replayData,
      replayHash, carStyle: 'public-style', verificationStatus: 'verified', verified: true, eventRpEligible: true,
      ownerUid: 'private'});
    return new Response('', {status: 404});
  };
  await runPublicSnapshotBackup({fetchImpl, directory, now: 1000000000, trackIds: [trackId], log: () => {}});
  const firstCount = calls.length;
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.overallResults.available, false);
  assert.equal(manifest.overall.updatedAt, overall.updatedAt);
  assert.deepEqual(manifest.trackSummaryMismatches, [trackId]);
  assert.equal(manifest.tracks[trackId].path, `tracks/${trackId}.json`);
  assert.equal(manifest.tracks[oldTrack].path, `tracks/${oldTrack}.json`);
  assert.equal(manifest.permanentRollingHills.path, 'events/permanent-rolling-hills.json');
  assert.equal(manifest.eventReplays[`event-replays/${period.id}/${replayAccount}.json`].replayHash, replayHash);
  const eventBackup = JSON.parse(await fs.readFile(path.join(directory, `events/${period.id}.json`), 'utf8'));
  assert.equal(eventBackup.entries[0].replayHash, replayHash);
  const replayBackup = JSON.parse(await fs.readFile(path.join(directory, `event-replays/${period.id}/${replayAccount}.json`), 'utf8'));
  assert.equal(replayBackup.ownerUid, undefined);
  assert.equal((await fs.readFile(path.join(directory, `events/${period.id}.json`), 'utf8')).includes('pendingPlaybacks'), false);
  calls.length = 0;
  await runPublicSnapshotBackup({fetchImpl, directory, now: 1000000001, trackIds: [trackId], log: () => {}});
  assert.equal(calls.filter(url => url.includes('/v1/snapshot/track')).length, 0);
  assert.ok(calls.length < firstCount);
});

test('finalized archive backups are reused, while live events and weekly correction checks stay fresh', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'polytrack-archive-reuse-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const archived = {...period, id: 'daily_old'};
  const calls = [];
  const fetchImpl = async input => {
    const url = new URL(input); calls.push(url.pathname);
    if (url.pathname.endsWith('/v1/snapshot/overall')) return Response.json({...overall, trackSummaries: []});
    if (url.pathname.endsWith('/v1/events/catalog')) return Response.json({periods: [period], archives: [archived]});
    const id = url.pathname.split('/').at(-2);
    return Response.json({id, updatedAt: 180, entries: [], archived: id === archived.id});
  };
  const now = 1000000000;
  await runPublicSnapshotBackup({fetchImpl, directory, now, trackIds: [], log: () => {}});
  calls.length = 0;
  await runPublicSnapshotBackup({fetchImpl, directory, now: now + 86400000, trackIds: [], log: () => {}});
  assert.equal(calls.some(url => url.includes('/daily_old/')), false);
  assert.ok(calls.some(url => url.includes('/daily_20261002/')));
  assert.ok(calls.some(url => url.includes('/permanent-rolling-hills/')));
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.events[archived.id].checkedAt, now);
  assert.equal(manifest.eventIdsFetched, 2);
  calls.length = 0;
  await runPublicSnapshotBackup({fetchImpl, directory,
    now: now + PUBLIC_SNAPSHOT_LIMITS.archivedEventRecheckMs, trackIds: [], log: () => {}});
  assert.ok(calls.some(url => url.includes('/daily_old/')));
  await fs.writeFile(path.join(directory, `events/${archived.id}.json`), '{}');
  calls.length = 0;
  await runPublicSnapshotBackup({fetchImpl, directory,
    now: now + PUBLIC_SNAPSHOT_LIMITS.archivedEventRecheckMs + 1, trackIds: [], log: () => {}});
  assert.ok(calls.some(url => url.includes('/daily_old/')));
});
