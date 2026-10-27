import test from 'node:test';
import assert from 'node:assert/strict';
import {createEventService, eventPeriod, publicEventPeriod, EVENT_COLLECTIONS as C} from '../src/events.js';
import {eventEncode} from '../src/events-store.js';
import {publicEventPage} from '../src/event-public-projection.js';
import {publicEventBackup} from '../../../tools/public-snapshot-backup.mjs';
import {assemblePublishedSnapshotPages} from '../../../tools/published-snapshot-pages.mjs';
import {savedEventPlannerRoutes} from '../../../tools/event-planner-model.mjs';

const account = 'a'.repeat(64), newcomer = 'd'.repeat(64), runId = 'b'.repeat(64), replayHash = 'c'.repeat(64);
const period = eventPeriod({id: 'metadata_weekly', kind: 'weekly', enabled: true, trackId: 'e'.repeat(64),
  startsAt: 1000, endsAt: 86401000, graceMs: 3600000, targetMs: 10000, maxRp: 500,
  scoringVersion: 'time-gap-v2', eligibility: 'best-submitted-during-period',
  capacity: {policyVersion: 'test-reviewed-v1', entrants: 200, admissionsPerPeriod: 512,
    replayBytesPerPeriod: 8388608, minIntervalMs: 1000, verificationsPerDay: 128}});
const row = {accountId: account, timeMs: 12000, rp: 223, rank: 1, name: 'Racer', carStyle: 'AAAA',
  submittedAt: 2000, runId, replayHash, verifiedAt: 3000, physicsVerified: true,
  replayIntegrityVerified: true, verified: true, pending: false, eventRpEligible: true, verificationStatus: 'verified'};
function fixture(metadata = {}) {
  let now = 4000;
  const data = new Map([[`${C.periods}/${period.id}`, period], [`${C.live}/${period.id}`,
    {entries: [row], racerCount: 19, updatedAt: 3000, ...metadata}]]);
  const store = {transaction: async fn => {
    const copy = structuredClone(data);
    const tx = {get: async key => copy.get(key) ?? null,
      set: async (key, value) => {eventEncode(value); copy.set(key, structuredClone(value));},
      create: async (key, value) => {assert(!copy.has(key)); eventEncode(value); copy.set(key, structuredClone(value));}};
    const result = await fn(tx);
    data.clear(); for (const entry of copy) data.set(...entry);
    return result;
  }};
  return {data, service: createEventService({store, now: () => now}), close: () => {now = period.endsAt + period.graceMs;}};
}

test('monolithic live snapshots preserve explicit completeness and permit new-nonentrant planner routes after export', async () => {
  const metadata = {sourceComplete: true, totalEntries: 1, complete: true, sourceRevision: 7, sourceReadTime: 'saved-read-time'};
  const f = fixture(metadata), snapshot = await f.service.snapshot(period.id);
  for (const [key, value] of Object.entries(metadata)) assert.equal(snapshot[key], value);
  assert.equal(Object.hasOwn(snapshot, 'pagination'), false);
  assert.equal(snapshot.racerCount, 19, 'pending entrants do not establish scored coverage');
  const exported = JSON.parse(JSON.stringify(publicEventBackup(snapshot, period.id)));
  const routes = savedEventPlannerRoutes({periods: [snapshot.period]}, {[period.id]: exported}, null, {}, newcomer, null, 4000);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].currentRp, 0);
  assert.equal(routes[0].period.scoringVersion, 'time-gap-v2');
  assert.equal(snapshot.entries[0].runId, runId);
  assert.equal(snapshot.entries[0].replayHash, replayHash);
  assert.equal(snapshot.entries[0].verifiedAt, row.verifiedAt);
});

test('absent and explicitly incomplete live coverage stays unknown or incomplete, never inferred from racer count', async () => {
  for (const metadata of [{}, {sourceComplete: false, totalEntries: 19, complete: false}]) {
    const f = fixture(metadata), snapshot = await f.service.snapshot(period.id);
    for (const key of ['complete', 'sourceComplete', 'totalEntries'])
      assert.equal(Object.hasOwn(snapshot, key), Object.hasOwn(metadata, key));
    const routes = savedEventPlannerRoutes({periods: [snapshot.period]}, {[period.id]: snapshot}, null, {}, newcomer, null, 4000);
    assert.equal(routes.length, 0);
    assert.deepEqual(routes.missing, [period.id]);
  }
});

test('archive history retains present monolithic, partial and paginated metadata without undefined Firestore values', async () => {
  for (const metadata of [{}, {pagination: null, sourceComplete: true, totalEntries: 1, complete: true},
    {sourceComplete: false, totalEntries: 19, complete: false},
    {pagination: {generation: 'f'.repeat(64), pageCount: 1}, sourceRevision: 7, sourceReadTime: 'saved-read-time', totalEntries: 1, complete: true}]) {
    const f = fixture(metadata); f.close();
    await f.service.archivePeriod(period.id);
    const history = f.data.get(`${C.history}/${period.id}`);
    const snapshot = await f.service.snapshot(period.id);
    assert.equal(snapshot.archived, true);
    for (const key of ['pagination', 'sourceRevision', 'sourceReadTime', 'sourceComplete', 'totalEntries', 'complete']) {
      const present=Object.hasOwn(metadata,key) && !(key==='pagination' && metadata[key]===null);
      assert.equal(Object.hasOwn(history, key), present);
      assert.equal(Object.hasOwn(snapshot, key), present);
      assert.deepEqual(snapshot[key], present?metadata[key]:undefined);
    }
    assert.equal(history.entries[0].runId, runId);
    assert.equal(snapshot.entries[0].verifiedAt, 3000);
    assert.doesNotThrow(() => eventEncode(history));
  }
});

test('paged public finish retains validated authoritative identity, date and verification fields without private data', () => {
  const input = {...row, ownerUid: 'private', replay: 'private', proof: {secret: true}};
  const page = publicEventPage({entries: [input]}, 'event');
  for (const key of ['runId', 'replayHash', 'verifiedAt', 'physicsVerified', 'replayIntegrityVerified', 'verified', 'pending', 'eventRpEligible', 'verificationStatus'])
    assert.equal(page.entries[0][key], row[key]);
  for (const key of ['ownerUid', 'replay', 'proof']) assert.equal(Object.hasOwn(page.entries[0], key), false);
  assert.deepEqual(publicEventPage(page, 'event'), page);
  const exported = publicEventBackup({period: publicEventPeriod(period), updatedAt: 4000, entries: page.entries}, period.id);
  assert.equal(exported.entries[0].verifiedAt, 3000);
  assert.equal(exported.entries[0].runId, runId);
});

test('invalid or absent binding and verdict metadata is omitted, never replaced by submission time', () => {
  for (const value of [undefined, null, '', 'invalid', 0, -1, NaN, Infinity, true]) {
    const projected = publicEventPage({entries: [{...row, runId: value, replayHash: value, verifiedAt: value,
      physicsVerified: 'true', replayIntegrityVerified: 1, verificationStatus: 'invented'}]}, 'event').entries[0];
    for (const key of ['runId', 'replayHash', 'verifiedAt', 'physicsVerified', 'replayIntegrityVerified', 'verificationStatus'])
      assert.equal(Object.hasOwn(projected, key), false);
    assert.equal(projected.submittedAt, 2000);
  }
  const empty = publicEventPage({entries: [{accountId: account, timeMs: 10000, rp: 400, rank: 1}]}, 'event').entries[0];
  for (const key of ['runId', 'replayHash', 'verifiedAt', 'physicsVerified', 'verified', 'eventRpEligible'])
    assert.equal(Object.hasOwn(empty, key), false);
});


test('inline null pagination omits the descriptor and roundtrips through the real capture assembler',async()=>{
 const f=fixture({pagination:null,sourceComplete:true,totalEntries:1,complete:true});
 const snapshot=await f.service.snapshot(period.id);
 assert.equal(Object.hasOwn(snapshot,'pagination'),false);
 const assembled=await assemblePublishedSnapshotPages(snapshot,{fetchPage:()=>{throw Error('No pages for inline board');}});
 assert.equal(assembled,snapshot);assert.equal(assembled.complete,true);assert.equal(assembled.totalEntries,1);
 assert.equal(publicEventBackup(assembled,period.id).entries[0].runId,runId);
});
