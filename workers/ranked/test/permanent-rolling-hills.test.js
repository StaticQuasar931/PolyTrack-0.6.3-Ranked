import test from 'node:test';
import assert from 'node:assert/strict';
import { eventWorkerHandler } from '../src/events-worker.js';
import { eventEncode } from '../src/events-store.js';
import { PERMANENT_ROLLING_HILLS as R, PermanentRollingHillsError, derivePermanentRollingHills,
  readPermanentRollingHills, mergePermanentRollingIntoTotals, permanentRollingHillsRp } from '../src/permanent-rolling-hills.js';

const entry = (accountId, timeMs, extra = {}) => ({ accountId, trackId: R.trackId, timeMs, frames: timeMs,
  raceTimeFrames: timeMs, runVerified: true, integrityVerified: true, replayHash: 'a'.repeat(64),
  pbAt: 100, name: accountId, carStyle: 'recorded-style', ...extra });
const snapshot = (entries = [entry('first', 10000), entry('second', 20000)]) => ({ trackId: R.trackId,
  algorithmVersion: R.algorithmVersion, schemaVersion: R.minimumSchemaVersion, revision: 7, sourceRevision: 7,
  signature: 'valid_snapshot_signature', builtAt: 100, updatedAt: 200, complete: true,
  totalEntries: entries.length, entries });

test('permanent Rolling Hills derives live first-place scoring only from explicitly verified normal PB rows', () => {
  const result = derivePermanentRollingHills(snapshot([
    entry('first', 10000), entry('second', 20000),
    entry('hash-only', 9000, { runVerified: false }), entry('physics-only', 8000, { integrityVerified: false })
  ]));
  assert.equal(result.complete, true); assert.equal(result.targetMs, 10000);
  assert.equal(result.targetPolicy, 'live-fastest-physics-verified');
  assert.deepEqual(result.entries.map(row => [row.accountId, row.rp]), [['first', 10101], ['second', 1501]]);
  assert(result.entries.every(row => row.physicsVerified && row.replayIntegrityVerified));
  assert.deepEqual(result.contributions, { normalRp: true, eventRp: true });
  assert(result.entries.every(row => row.runAgeMs === 100 && row.eventRpContribution === row.rp && row.normalRpEligible));
  assert.equal(result.totalEntries, 2);
  assert.equal(result.sourceTotalEntries, 4);
  assert.equal(result.sourceCompleteness, 'explicit-snapshot-metadata');
});

test('legacy Rolling Hills snapshot rebuilds omitted completeness only from unanimous bounded field-size proof', () => {
  const entries = [entry('first', 10000, { fieldSize: 2 }), entry('second', 20000, { fieldSize: 2 })];
  const legacy = snapshot(entries);
  delete legacy.complete;
  delete legacy.totalEntries;
  legacy.revision = 18;
  legacy.sourceRevision = 18;
  const result = derivePermanentRollingHills(legacy);
  assert.equal(result.complete, true);
  assert.equal(result.totalEntries, 2);
  assert.equal(result.sourceTotalEntries, 2);
  assert.equal(result.sourceRevision, 18);
  assert.equal(result.sourceCompleteness, 'legacy-exact-field-size');
  for (const invalid of [
    { ...legacy, entries: [entries[0], { ...entries[1], fieldSize: 3 }] },
    { ...legacy, complete: false },
    { ...legacy, totalEntries: 2 },
    { ...legacy, entries: entries.map(({ fieldSize, ...row }) => row) },
  ]) assert.throws(() => derivePermanentRollingHills(invalid), /snapshot_incomplete/);
});

test('permanent Rolling Hills fails closed for missing, partial, stale or unverified snapshots', async () => {
  for (const value of [
    { ...snapshot(), signature: '' }, { ...snapshot(), sourceRevision: 6 }, { ...snapshot(), schemaVersion: 4 },
    { ...snapshot(), complete: false }, { ...snapshot(), totalEntries: 3 },
    { ...snapshot(), sourceComplete: false }, { ...snapshot(), publicationPending: true },
    snapshot([entry('hash-only', 10000, { runVerified: false })]),
    snapshot([entry('frame-mismatch', 10000, { frames: 600, raceTimeFrames: 600 })]),
    snapshot(Array.from({ length: R.entryLimit }, (_, index) => entry(`racer-${index}`, 10000 + index)))
  ]) assert.throws(() => derivePermanentRollingHills(value), PermanentRollingHillsError);
  await assert.rejects(readPermanentRollingHills(async () => null), /snapshot_missing/);
});

test('combined EventRP preserves earned finite RP and labels the moving permanent component', () => {
  const rolling = derivePermanentRollingHills(snapshot());
  const finiteEntries = [
    { accountId: 'second', name: 'Finite Name', rp: 900, events: 3 },
    { accountId: 'finite-only', name: 'Finite Only', rp: 700, events: 2 }
  ];
  const combined = mergePermanentRollingIntoTotals({ entries: finiteEntries, complete: true,
    totalEntries: finiteEntries.length, updatedAt: 150 }, rolling);
  const second = combined.entries.find(row => row.accountId === 'second');
  assert.equal(second.finiteEventRp, 900); assert.equal(second.permanentRollingHillsRp, 1501); assert.equal(second.rp, 2401);
  assert.equal(second.rollingHillsRunAgeMs, 100); assert.equal(second.rollingHillsEventRpContribution, 1501);
  assert.equal(second.events, 3); assert.equal(combined.eventRpComplete, true);
  assert.equal(combined.dynamicComponents.permanentRollingHills.targetPolicy, 'live-fastest-physics-verified');
  assert.throws(() => mergePermanentRollingIntoTotals({ entries: finiteEntries, updatedAt: 150 }, rolling),
    /merge_incomplete/);
});

test('reader uses the exact existing S1 snapshot document and wrapper exposes only complete data', async () => {
  const expectedPath = `/${R.collection}/${R.trackId}`;
  const calls = [];
  const firestore = async path => { calls.push(path); return path === expectedPath ?
    { fields: eventEncode(snapshot()).mapValue.fields } : null; };
  assert.equal((await readPermanentRollingHills(firestore)).entries[0].rp, 10101);
  assert.deepEqual(calls, [expectedPath]);
  const handler = eventWorkerHandler({ EVENTS_ENABLED: 'true', EVENT_RATE_LIMITER: { limit: async () => ({ success: true }) } },
    { request: firestore, authenticate: async () => 'unused', origins: new Set(['https://game.test']) });
  const response = await handler(new Request('https://worker.test/v1/events/permanent-rolling-hills/snapshot',
    { headers: { Origin: 'https://game.test', 'CF-Connecting-IP': '127.0.0.1' } }));
  assert.equal(response.status, 200); assert.equal((await response.json()).complete, true);
});

test('merged totals preserve the full field before publication paging',()=>{
 const rolling=derivePermanentRollingHills(snapshot());
 const small=mergePermanentRollingIntoTotals({entries:[],complete:true,totalEntries:0},rolling);
 assert.equal(small.totalEntries,2);assert.equal(small.complete,true);
 const entries=Array.from({length:199},(_,i)=>({accountId:'finite-'+i,rp:10}));
 const large=mergePermanentRollingIntoTotals({entries,complete:true,totalEntries:199},rolling);
 assert.equal(large.entries.length,201);assert.equal(large.totalEntries,201);assert.equal(large.complete,true);
});

test('bounded hybrid samples, ties and input-order independence', () => {
  assert.equal(R.scoreVersion, 'rolling-hills-pace-placement-v2');
  assert.deepEqual([1,2,3,5,10,25,100].map(rank => permanentRollingHillsRp(rank,10000,10000)), [10101,6006,4431,3020,1796,903,319]);
  for (const rank of [0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => permanentRollingHillsRp(rank,10000,10000), /invalid_rank/);
  const rows = [entry('z',10000),entry('a',10000),entry('third',10001)];
  const result = derivePermanentRollingHills(snapshot(rows));
  assert.deepEqual(result.entries.map(row => [row.accountId,row.rank,row.rp]), [['a',1,10101],['z',1,10101],['third',3,4430]]);
  assert.deepEqual(result, derivePermanentRollingHills(snapshot([...rows].reverse())));
  let previous = R.maxRp;
  for (let rank = 1; rank <= 10000; rank++) {
    const rp = permanentRollingHillsRp(rank,10000,10000);
    assert(rp >= 0 && rp <= previous); previous = rp;
  }
});

test('hybrid depends on pace and placement with exact floor, cap and zero', () => {
  assert.equal(permanentRollingHillsRp(10,18641,19000),1729);
  assert.equal(permanentRollingHillsRp(10,18641,22000),1289);
  assert(permanentRollingHillsRp(5,18641,19000)>permanentRollingHillsRp(10,18641,19000));
  assert.equal(permanentRollingHillsRp(1,20000,10000),10101);
  assert.equal(permanentRollingHillsRp(10000,1,300000),0);
  // rank 16 has an exact divisor of 8, exercising an integer floor boundary.
  assert.equal(permanentRollingHillsRp(16,10000,10000),1262);
  for(const invalid of [0,-1,1.5,NaN,Infinity,300001,undefined]) {
    assert.throws(()=>permanentRollingHillsRp(1,invalid,10000),/invalid_time/);
    assert.throws(()=>permanentRollingHillsRp(1,10000,invalid),/invalid_time/);
  }
  for(let rank=1;rank<=100;rank++)for(const time of [10000,10001,12000,20000,300000])
    assert.equal(permanentRollingHillsRp(rank,10000,time),Math.floor(10101*(10000/time)**2/rank**0.75));
});

test('negative proof and pending/review states never enter ranking or establish the target', () => {
  const patches = [{pending:true},{playbackPending:true},{needsReview:true},{reviewHold:true},
    {verified:false},{eventRpEligible:false},{physicsVerified:false},{replayIntegrityVerified:false},{verified:null},
    {status:'unavailable'},{verificationStatus:'pending'},{runStatus:'rejected'},
    {validationState:'mismatch'},{reason:'similar_replay_pending_manual_review'}];
  const result = derivePermanentRollingHills(snapshot([entry('valid',20000,{validationState:'integrity'}),
    ...patches.map((patch,i) => entry('excluded-'+i,10000,patch))]));
  assert.equal(result.targetMs,20000);
  assert.deepEqual(result.entries.map(row => [row.accountId,row.rp]), [['valid',10101]]);
});
