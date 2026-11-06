import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {snapshotReplayCompleteness,assertSnapshotReplayCompleteness} from './snapshot-replay-completeness.mjs';

const accountId='a'.repeat(64),trackId='b'.repeat(64),runId='c'.repeat(64);
const recording=deflateSync(Buffer.alloc(15)).toString('base64url');
const replayHash=createHash('sha256').update(recording).digest('hex');
const entry={accountId,trackId,uploadId:123,frames:1000,timeMs:1000,replayHash,
  runVerified:true,verified:true,integrityVerified:true,verifiedState:1};
const period={id:'w_20261102',trackId};
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'snapshot-replay-complete-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const put=async(file,value)=>{await fs.mkdir(path.dirname(path.join(root,file)),{recursive:true});await fs.writeFile(path.join(root,file),JSON.stringify(value));};
  const normal=async(row=entry)=>put(`tracks/${trackId}.json`,{trackId,entries:[row]});
  const evidence=async(canonical=entry,replay={...entry,recording})=>{
    await put(`canonical/${trackId}/${accountId}.json`,canonical);
    await put('recordings/123.json',replay);
  };
  const event=async({pending=false,archived=false,payload=true,change={}}={})=>{
    const row={accountId,runId,timeMs:1000,replayHash,submittedAt:1};
    await put(`events/${period.id}.json`,{period,archived,entries:pending?[]:[row],pendingPlaybacks:pending?[row]:[]});
    if(payload)await put(`event-${pending?'playbacks':'replays'}/${period.id}/${pending?runId:accountId}.json`,
      {...row,periodId:period.id,trackId,frames:1000,replay:recording,carStyle:'AAAA',
        ...(pending?{pending:true,verified:false,eventRpEligible:false}:{}),...change});
  };
  return {root,put,normal,evidence,event};
}

test('complete normal and event replay evidence passes entirely offline',async t=>{
  const f=await fixture(t);await f.normal();await f.evidence();await f.event();
  t.mock.method(globalThis,'fetch',()=>assert.fail('Publication audit must not use the cloud'));
  const result=await assertSnapshotReplayCompleteness(f.root);
  assert.equal(result.complete,true);assert.equal(result.normal.available,1);assert.equal(result.events.published,1);
  assert.equal(result.backendReads,0);assert.equal(result.backendWrites,0);
});

test('verified flags never excuse a missing canonical or replay file',async t=>{
  for(const missing of ['canonical','recording']){
    const f=await fixture(t);await f.normal();await f.evidence();
    await fs.unlink(path.join(f.root,missing==='canonical'?`canonical/${trackId}/${accountId}.json`:'recordings/123.json'));
    await assert.rejects(assertSnapshotReplayCompleteness(f.root),e=>e.code==='SNAPSHOT_REPLAYS_INCOMPLETE'&&e.coverage.normal.missing===1);
  }
});

test('a matching old time alone cannot replace the exact run binding',async t=>{
  for(const change of [{uploadId:124},{accountId:'d'.repeat(64)},{trackId:'d'.repeat(64)},
    {timeMs:999},{frames:999},{raceTimeFrames:999},{replayHash:'d'.repeat(64)}]){
    const f=await fixture(t);await f.normal();await f.evidence({...entry,...change});
    const result=await snapshotReplayCompleteness(f.root);assert.equal(result.normal.invalid,1);assert.equal(result.complete,false);
  }
});

test('stale or corrupted recording metadata and bytes block publication',async t=>{
  for(const change of [{uploadId:124},{accountId:'d'.repeat(64)},{trackId:'d'.repeat(64)},
    {timeMs:999},{frames:999},{raceTimeFrames:999},{replayHash:'d'.repeat(64)},{recording:'broken'}]){
    const f=await fixture(t);await f.normal();await f.evidence(entry,{...entry,recording,...change});
    assert.equal((await snapshotReplayCompleteness(f.root)).normal.invalid,1);
  }
});

test('a hash-valid but malformed replay container is not playable evidence',async t=>{
  const f=await fixture(t),bad=deflateSync(Buffer.alloc(16)).toString('base64url');
  const row={...entry,replayHash:createHash('sha256').update(bad).digest('hex')};
  await f.normal(row);await f.evidence(row,{...row,recording:bad});
  assert.equal((await snapshotReplayCompleteness(f.root)).normal.invalid,1);
});

test('missing binding fields do not silently remove rows from the audit',async t=>{
  for(const field of ['accountId','uploadId','replayHash','timeMs','frames']){
    const f=await fixture(t),row={...entry};delete row[field];await f.normal(row);await f.evidence();
    const result=await snapshotReplayCompleteness(f.root);assert.equal(result.normal.known,1);assert.equal(result.normal.invalid,1);
  }
});

test('waiting and held evidence does not gain verified authority during availability checks',async t=>{
  const f=await fixture(t),row={...entry,runVerified:false,verified:false,verifiedState:0,reviewHold:true};
  await f.normal(row);await f.evidence(row,{...row,recording});
  await assertSnapshotReplayCompleteness(f.root);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.root,`tracks/${trackId}.json`))),{trackId,entries:[row]});
});

test('verified and archived event rows both require their own replay file',async t=>{
  for(const archived of [false,true]){
    const f=await fixture(t);await f.event({archived,payload:false});
    await assert.rejects(assertSnapshotReplayCompleteness(f.root),e=>e.coverage.events.missing===1);
  }
});

test('published waiting event playback is checked without changing its status',async t=>{
  const f=await fixture(t);await f.event({pending:true});
  assert.equal((await assertSnapshotReplayCompleteness(f.root)).events.published,1);
  await fs.unlink(path.join(f.root,`event-playbacks/${period.id}/${runId}.json`));
  await assert.rejects(assertSnapshotReplayCompleteness(f.root),e=>e.coverage.events.missing===1);
});

test('omitting unavailable pending previews never hides incomplete source evidence',async t=>{
  for(const counts of [{known:2,published:1,missing:1,failed:1,deferred:0},
    {known:32,published:30,missing:2,failed:0,deferred:2}]){
    const f=await fixture(t);await f.event({pending:true});
    await f.put('manifest.json',{pendingPlaybackCoverage:{...counts,complete:false}});
    const report=await snapshotReplayCompleteness(f.root);
    assert.equal(report.events.complete,true,'the retained preview itself has valid bytes');
    assert.equal(report.complete,false);assert.equal(report.pendingCapture.missing,counts.missing);
    await assert.rejects(assertSnapshotReplayCompleteness(f.root),e=>
      e.code==='SNAPSHOT_REPLAYS_INCOMPLETE'&&e.coverage.pendingCapture.missing===counts.missing&&/pending inputs missing/.test(e.message));
  }
});

test('resolved pending source coverage passes and malformed counters fail closed',async t=>{
  const f=await fixture(t);await f.event({pending:true});
  const valid={known:1,published:1,missing:0,failed:0,deferred:0,complete:true};
  await f.put('manifest.json',{pendingPlaybackCoverage:valid});
  assert.equal((await assertSnapshotReplayCompleteness(f.root)).pendingCapture.complete,true);
  for(const change of [{known:2},{published:-1},{missing:1},{complete:false},{deferred:NaN},{known:100001}]){
    await f.put('manifest.json',{pendingPlaybackCoverage:{...valid,...change}});
    await assert.rejects(snapshotReplayCompleteness(f.root),/Invalid pending replay capture coverage/);
  }
});

test('event replay mismatches cannot borrow another run or submission date',async t=>{
  for(const change of [{runId:'d'.repeat(64)},{accountId:'d'.repeat(64)},{trackId:'d'.repeat(64)},
    {frames:999},{replay:'bad'},{submittedAt:2},{verified:true}]){
    const f=await fixture(t);await f.event({pending:true,change});
    assert.equal((await snapshotReplayCompleteness(f.root)).events.invalid,1);
  }
});

test('unsafe or malformed boards fail closed before resolving replay paths',async t=>{
  for(const board of [{period:{...period,id:'../outside'},entries:[]},{period,entries:[{accountId:'../outside',timeMs:1}]}]){
    const f=await fixture(t);await f.put(`events/${period.id}.json`,board);
    await assert.rejects(assertSnapshotReplayCompleteness(f.root),/Invalid replay audit/);
  }
});

test('blocking leaves the existing snapshot pointer and capture checkpoint untouched',async t=>{
  const f=await fixture(t);await f.normal();
  await f.put('snapshot-current.json',{currentdir:'public-snapshots72'});await f.put('export-progress.json',{checkpoint:'keep'});
  const before=await fs.readdir(f.root);
  await assert.rejects(assertSnapshotReplayCompleteness(f.root),{code:'SNAPSHOT_REPLAYS_INCOMPLETE'});
  assert.deepEqual(await fs.readdir(f.root),before);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.root,'snapshot-current.json'))),{currentdir:'public-snapshots72'});
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.root,'export-progress.json'))),{checkpoint:'keep'});
});

test('oversized or non-file payloads are rejected without accepting metadata-only evidence',async t=>{
  const f=await fixture(t);await f.normal();await f.evidence();
  await fs.unlink(path.join(f.root,'recordings/123.json'));await fs.mkdir(path.join(f.root,'recordings/123.json'));
  assert.equal((await snapshotReplayCompleteness(f.root)).normal.invalid,1);
});

test('permanent standings reuse exact normal evidence without requiring a nonexistent event replay',async t=>{
  const f=await fixture(t);await f.normal();await f.evidence();
  const row={accountId,trackId,timeMs:1000,frames:1000,replayHash};
  await f.put('events/permanent-rolling-hills.json',{id:'permanent-rolling-hills',kind:'permanent',trackId,entries:[row]});
  assert.equal((await assertSnapshotReplayCompleteness(f.root)).derived.available,1);
  await f.put('events/permanent-rolling-hills.json',{id:'permanent-rolling-hills',kind:'permanent',trackId,entries:[{...row,timeMs:999}]});
  await assert.rejects(assertSnapshotReplayCompleteness(f.root),e=>e.coverage.derived.invalid===1);
});

test('permanent standings cannot advertise an absent normal replay',async t=>{
  const f=await fixture(t);await f.normal();
  await f.put('events/permanent-rolling-hills.json',{id:'permanent-rolling-hills',kind:'permanent',trackId,
    entries:[{accountId,trackId,timeMs:1000,frames:1000,replayHash}]});
  await assert.rejects(assertSnapshotReplayCompleteness(f.root),e=>e.coverage.derived.missing===1);
});

test('archive catalogs do not invent replay obligations but archived boards do',async t=>{
  const f=await fixture(t);await f.put('archives/2026-11.json',{periods:[period]});
  await assertSnapshotReplayCompleteness(f.root);
  await f.put(`archives/${period.id}.json`,{period,archived:true,entries:[{accountId,runId,timeMs:1000,replayHash}]});
  await assert.rejects(assertSnapshotReplayCompleteness(f.root),e=>e.coverage.events.missing===1);
});

test('manifest references cannot omit an entire advertised board to evade replay coverage',async t=>{
  const f=await fixture(t);
  await f.put('manifest.json',{tracks:{[trackId]:{path:`tracks/${trackId}.json`}},events:{}});
  await assert.rejects(assertSnapshotReplayCompleteness(f.root),e=>e.coverage.referencedBoardsMissing===1);
  await f.put('manifest.json',{tracks:{[trackId]:{path:null}},events:{}});
  await assertSnapshotReplayCompleteness(f.root);
});
