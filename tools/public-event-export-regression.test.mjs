import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {publicEventBackup, chooseTrackFetches, runPublicSnapshotBackup, PUBLIC_SNAPSHOT_LIMITS} from './public-snapshot-backup.mjs';
import {savedEventPlannerRoutes} from './event-planner-model.mjs';
import {scheduledCatalog} from '../events/schedule.mjs';

const catalog = JSON.parse(await fs.readFile(new URL('../events/public-catalog.json', import.meta.url), 'utf8'));
const registry = JSON.parse(await fs.readFile(new URL('../events/rotation.json', import.meta.url), 'utf8'));
const account = 'a'.repeat(64), runId = 'b'.repeat(64), replayHash = 'c'.repeat(64);
const roundtrip = value => JSON.parse(JSON.stringify(value));
const board = period => ({id: period.id, period: {...period}, updatedAt: period.startsAt + 1000,
  complete: true, totalEntries: 1, entries: [{accountId: account, timeMs: period.targetMs, rank: 1,
    submittedAt: period.startsAt + 100, verifiedAt: period.startsAt + 200, runId, replayHash}]});
const projectBoard = period => roundtrip(publicEventBackup(board(period), period.id));
const current = catalog.periods.filter(p => ['weekly', 'kodub'].includes(p.kind));
const at = Math.max(...current.map(p => p.startsAt)) + 1000;

test('actual public catalog periods retain accepted scoring and target fields through export and JSON roundtrip', () => {
  assert.deepEqual(new Set(current.map(p => p.kind)), new Set(['weekly', 'kodub']));
  for (const period of [...catalog.periods, ...catalog.archives]) {
    const exported = projectBoard(period).period;
    for (const key of ['id', 'trackId', 'kind', 'startsAt', 'endsAt', 'maxRp', 'targetMs', 'scoringVersion', 'targetPolicy']) {
      assert.equal(exported[key], period[key], period.id + ':' + key);
    }
    assert.equal(Object.hasOwn(exported, 'scoringVersion'), Object.hasOwn(period, 'scoringVersion'));
  }
});

test('saved planner picks actual weekly and Kodub periods after public export roundtrip', () => {
  const boards = Object.fromEntries(current.map(p => [p.id, projectBoard(p)]));
  const routes = savedEventPlannerRoutes({periods: current}, boards, null, {}, account, null, at);
  assert.deepEqual(new Set(routes.map(r => r.period.kind)), new Set(['weekly', 'kodub']));
  assert.deepEqual(routes.missing, []);
  for (const route of routes) {
    assert.equal(route.period.scoringVersion, 'time-gap-v2');
    assert.equal(route.currentRp, Math.round(route.period.maxRp * .8));
    assert.ok(route.gain > 0);
    assert.equal(route.observedTarget, false);
  }
});

test('planner rejects missing, mismatched and unsupported scoring instead of inferring it from the catalog', () => {
  for (const scoringVersion of [undefined, 'time-ratio-v1', 'unsupported']) {
    const boards = Object.fromEntries(current.map(p => {
      const source = board(p);
      if (scoringVersion === undefined) delete source.period.scoringVersion;
      else source.period.scoringVersion = scoringVersion;
      const exported = roundtrip(publicEventBackup(source, p.id));
      assert.equal(exported.period.scoringVersion, scoringVersion);
      return [p.id, exported];
    }));
    const routes = savedEventPlannerRoutes({periods: current}, boards, null, {}, account, null, at);
    assert.equal(routes.length, 0);
    assert.deepEqual(new Set(routes.missing), new Set(current.map(p => p.id)));
  }
});

test('schedule-only export never invents a target or confirmed scoring and produces no planner routes', () => {
  const scheduled = scheduledCatalog(registry, {periods: [], archives: []}, at);
  assert.ok(scheduled.periods.length > 0);
  const boards = Object.fromEntries(scheduled.periods.map(p => {
    assert.equal(p.scheduleOnly, true);
    const source = {...board(p), entries: [], totalEntries: 0};
    const exported = roundtrip(publicEventBackup(source, p.id));
    assert.equal(Object.hasOwn(exported.period, 'targetMs'), false);
    assert.equal(Object.hasOwn(exported.period, 'scoringVersion'), false);
    return [p.id, exported];
  }));
  const routes = savedEventPlannerRoutes(scheduled, boards, null, {}, account, null, at);
  assert.equal(routes.length, 0);
  assert.deepEqual(new Set(routes.missing), new Set(scheduled.periods.map(p => p.id)));
});

test('authoritative run identity and verdict date survive projection, but absent or invalid values do not appear', () => {
  const period = current[0], source = board(period), original = roundtrip(source);
  const entry = publicEventBackup(source, period.id).entries[0];
  assert.equal(entry.runId, runId);
  assert.equal(entry.replayHash, replayHash);
  assert.equal(entry.verifiedAt, source.entries[0].verifiedAt);
  assert.deepEqual(source, original);
  for (const value of [undefined, null, '', 'invalid', 0, -1, '123', NaN, Infinity]) {
    const source = board(period);
    Object.assign(source.entries[0], {runId: value, replayHash: value, verifiedAt: value, checkedAt: period.startsAt + 300});
    const entry = publicEventBackup(source, period.id).entries[0];
    for (const key of ['runId', 'replayHash', 'verifiedAt', 'checkedAt']) assert.equal(Object.hasOwn(entry, key), false);
    assert.equal(entry.submittedAt, source.entries[0].submittedAt);
  }
});

const hex = n => n.toString(16).padStart(64, '0');
const day = 86400000, now = 20 * day;

test('smaller incremental budget retains active then dirty priority and unchanged boards stay read-free', () => {
  const [active, dirty, missing, unchanged] = [1, 2, 3, 4].map(hex);
  const previous = {[active]: {path: null, missing: true, checkedAt: now - 31 * 60000},
    [dirty]: {path: 'tracks/' + dirty + '.json', sourceUpdatedAt: 1, checkedAt: now - 1},
    [unchanged]: {path: 'tracks/' + unchanged + '.json', sourceUpdatedAt: 2, checkedAt: 1}};
  const summaries = [{trackId: dirty, updatedAt: 2}, {trackId: unchanged, updatedAt: 2}];
  assert.deepEqual(chooseTrackFetches([missing, unchanged, dirty, active], summaries, previous, 2, now, [active]), [active, dirty]);
  assert.equal(chooseTrackFetches(Array.from({length: 40}, (_, i) => hex(i + 10)), [], {}, undefined, now).length, 20);
});

test('speculative missing boards retain their seven-day negative-cache cooldown', () => {
  const missing = hex(1), previous = {[missing]: {path: null, missing: true, checkedAt: now - 7 * day + 1}};
  assert.deepEqual(chooseTrackFetches([missing], [], previous, 8, now), []);
  assert.deepEqual(chooseTrackFetches([missing], [], previous, 8, now + 1), [missing]);
});

test('invalid trackFetchLimit fails before network or staging access', async () => {
  for (const trackFetchLimit of [null, -1, .5, 21, NaN, Infinity, '8', true]) {
    let calls = 0;
    await assert.rejects(runPublicSnapshotBackup({trackFetchLimit, fetchImpl: async () => {calls++; throw Error('Unexpected network');}}), /Invalid trackFetchLimit/);
    assert.equal(calls, 0);
  }
});

test('mocked incremental runs honor effective limits, retain full registry and preserve existing boards on missing responses', async t => {
  for (const limit of [undefined, 8, 0]) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'public-track-limit-'));
    t.after(() => fs.rm(directory, {recursive: true, force: true}));
    const ids = Array.from({length: 25}, (_, i) => hex(i + 1)), savedId = ids[0];
    const saved = {trackId: savedId, updatedAt: 1, entries: []};
    await fs.mkdir(path.join(directory, 'tracks'));
    await fs.writeFile(path.join(directory, 'tracks', savedId + '.json'), JSON.stringify(saved));
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({schemaVersion: 1, tracks: {
      [savedId]: {path: 'tracks/' + savedId + '.json', sourceUpdatedAt: 1, checkedAt: now - 1}}, events: {}}));
    let trackCalls = 0;
    const fetchImpl = async input => {
      const url = new URL(input);
      if (url.pathname.endsWith('/snapshot/overall')) return Response.json({updatedAt: now, entries: [],
        trackSummaries: [{trackId: savedId, updatedAt: 2}]});
      if (url.pathname.endsWith('/events/catalog')) return Response.json({periods: [], archives: []});
      if (url.pathname.endsWith('/snapshot/track')) trackCalls++;
      return new Response('', {status: 404});
    };
    const manifest = await runPublicSnapshotBackup({directory, trackIds: ids, now, fetchImpl, log: () => {},
      ...(limit === undefined ? {} : {trackFetchLimit: limit})});
    const effective = limit ?? PUBLIC_SNAPSHOT_LIMITS.trackFetches;
    assert.equal(trackCalls, effective);
    assert.equal(manifest.trackFetchLimit, effective);
    assert.equal(manifest.tracksFetched, effective);
    assert.equal(manifest.trackIdsKnown, ids.length);
    assert.equal(manifest.tracks[savedId].path, 'tracks/' + savedId + '.json');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'tracks', savedId + '.json'), 'utf8')), saved);
    assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8')).trackFetchLimit, effective);
  }
});
