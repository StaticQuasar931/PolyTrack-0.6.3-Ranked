import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {auditArchiveData, auditSavedEventFiles, inspectSavedEventRecording} from './archive-data-audit.mjs';

const period={id:'past',kind:'kodub',trackId:'a'.repeat(64),startsAt:1,endsAt:100};
const replay=deflateSync(Buffer.alloc(15)).toString('base64url');
const record={periodId:period.id,trackId:period.trackId,accountId:'b'.repeat(64),runId:'c'.repeat(64),
  timeMs:1000,frames:1000,replay,carStyle:'',replayHash:createHash('sha256').update(replay).digest('hex')};
const waiting={...record,runId:'d'.repeat(64),pending:true,verified:false,eventRpEligible:false,verificationStatus:'waiting',submittedAt:50};
const resultKey=`event-replays/${period.id}/${record.accountId}.json`;
const waitingKey=`event-playbacks/${period.id}/${waiting.runId}.json`;
const boardKey=`events/${period.id}.json`;
const audit=files=>auditSavedEventFiles({keys:Object.keys(files),read:async key=>files[key],catalog:{archives:[period]},at:200});

async function pointerFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-audit-pointer-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  await fs.mkdir(path.join(root, 'events'));
  await fs.writeFile(path.join(root, 'events/public-catalog.json'), JSON.stringify({archives: [], periods: []}));
  const write = (name, value) => fs.writeFile(path.join(root, name), JSON.stringify(value));
  const index = generation => ({schemaVersion: 1, encoding: 'gzip-xor-a7-v1', generation, files: {}});
  for (const generation of [69, 70]) {
    await fs.mkdir(path.join(root, 'public-snapshots' + generation));
    await write(`public-snapshots${generation}/index.json`, index(generation));
  }
  await write('snapshot-current.json', {currentdir: 'public-snapshots69'});
  return {root, write, index};
}

test('archive audit defaults to the current validated pointer after generation rollover', async t => {
  const f = await pointerFixture(t);
  assert.equal((await auditArchiveData({root: f.root, at: 200})).snapshot, 'public-snapshots69');
  await f.write('snapshot-current.json', {currentdir: 'public-snapshots70'});
  const report = await auditArchiveData({root: f.root, at: 200});
  assert.equal(report.snapshot, 'public-snapshots70');
  assert.equal(report.networkRequests, 0);
});

test('archive audit explicit directory remains authoritative without requiring a pointer', async t => {
  const f = await pointerFixture(t);
  await fs.unlink(path.join(f.root, 'snapshot-current.json'));
  assert.equal((await auditArchiveData({root: f.root, snapshotDirectory: 'public-snapshots69', at: 200})).snapshot, 'public-snapshots69');
  await assert.rejects(auditArchiveData({root: f.root}), {code: 'ENOENT'});
  await f.write('snapshot-current.json', {currentdir: '../private'});
  assert.equal((await auditArchiveData({root: f.root, snapshotDirectory: 'public-snapshots70', at: 200})).snapshot, 'public-snapshots70');
});

test('archive audit rejects unsafe pointers and mismatched index generations without fallback', async t => {
  const f = await pointerFixture(t);
  for (const pointer of [null, {}, {currentdir: 69}, {currentdir: ['public-snapshots69']},
    {currentdir: '../public-snapshots69'}, {currentdir: 'public-snapshots0'}, {currentdir: 'public-snapshots069'},
    {currentdir: 'public-snapshots99999999999999999999'}]) {
    await f.write('snapshot-current.json', pointer);
    await assert.rejects(auditArchiveData({root: f.root}), /pointer is invalid/);
  }
  await f.write('snapshot-current.json', {currentdir: 'public-snapshots69'});
  for (const change of [{generation: 70}, {schemaVersion: 2}, {encoding: 'unknown'}]) {
    await f.write('public-snapshots69/index.json', {...f.index(69), ...change});
    await assert.rejects(auditArchiveData({root: f.root}), /index does not match/);
  }
  for (const snapshotDirectory of ['../public-snapshots69', 'C:/private', ['public-snapshots69']])
    await assert.rejects(auditArchiveData({root: f.root, snapshotDirectory}), /local snapshot directory/);
});

test('offline archive audit separates result and pending coverage and never promotes non-final standings',async()=>{
  const report=await audit({[boardKey]:{period,archived:false,racerCount:21,entries:[record],pendingPlaybacks:[waiting]},
    [resultKey]:record,[waitingKey]:waiting});
  assert.deepEqual(report.replayCoverage.results,{referenced:1,saved:1,bound:1,missing:0,invalid:0,unreferenced:0});
  assert.deepEqual(report.replayCoverage.pending,{referenced:1,saved:1,bound:1,missing:0,invalid:0,unreferenced:0});
  assert.equal(report.finalBoards,0);assert.equal(report.endedNonFinalBoards,1);
  assert.equal(report.periods[0].capturedRacers,21);
  assert.equal(report.networkRequests,0);assert.equal(report.physicsVerificationPerformed,false);
});

test('every saved file is inspected even if no board references it',async()=>{
  const report=await audit({[boardKey]:{period,archived:true,entries:[record]},[waitingKey]:waiting});
  assert.equal(report.replayCoverage.results.missing,1);
  assert.equal(report.unreferenced.length,1);assert.equal(report.unreferenced[0].integrity,'valid');
  assert.equal(report.unreferenced[0].binding,'unreferenced');
  const bad=await audit({[waitingKey]:{...waiting,replay:'corrupt'}});
  assert.equal(bad.replayCoverage.pending.invalid,1);assert.equal(bad.unreferenced.length,1);
});

test('stale pending copies can match published result evidence without becoming current pending coverage',async()=>{
  const stale={...waiting,runId:record.runId};
  const key=`event-playbacks/${period.id}/${stale.runId}.json`;
  const report=await audit({[boardKey]:{period,entries:[record],pendingPlaybacks:[]},[resultKey]:record,[key]:stale});
  assert.equal(report.unreferenced[0].matchesPublishedResult,true);
  assert.equal(report.unreferenced[0].binding,'unreferenced');
  assert.equal(report.replayCoverage.pending.bound,0);
  assert.equal(report.replayCoverage.pending.referenced,0);
});

test('recordings must match their path, replay bytes, board identity and submitted date',async()=>{
  for(const change of [{periodId:'wrong'},{accountId:'f'.repeat(64)},{runId:'invalid'},{frames:999},
    {timeMs:0},{trackId:'invalid'},{replayHash:'f'.repeat(64)},{replay:'bad'},{carStyle:'x'.repeat(257)},{verified:false}]){
    await assert.rejects(inspectSavedEventRecording(resultKey,{...record,...change}));
  }
  for(const change of [{trackId:'f'.repeat(64)},{timeMs:1001,frames:1001},{runId:'e'.repeat(64)}]){
    const report=await audit({[boardKey]:{period,entries:[record]},[resultKey]:{...record,...change}});
    assert.equal(report.replayCoverage.results.invalid,1);
  }
  const report=await audit({[boardKey]:{period,entries:[],pendingPlaybacks:[waiting]},[waitingKey]:{...waiting,submittedAt:51}});
  assert.equal(report.replayCoverage.pending.invalid,1);
});

test('pending playback flags cannot borrow verification or Event RP authority',async()=>{
  for(const change of [{pending:false},{verified:true},{eventRpEligible:true},{verificationStatus:'verified'},{submittedAt:0}])
    await assert.rejects(inspectSavedEventRecording(waitingKey,{...waiting,...change}));
  const report=await audit({[boardKey]:{period,entries:[],pendingPlaybacks:[{...waiting,verified:true}]},[waitingKey]:waiting});
  assert.equal(report.replayCoverage.pending.invalid,1);
});

test('legacy row bindings are reported honestly and missing boards are not empty final boards',async()=>{
  const {runId,replayHash,...legacy}=record;
  const report=await audit({[boardKey]:{period,archived:true,entries:[legacy]},[resultKey]:record});
  assert.equal(report.rowBindingsWithoutRunHash,1);
  const missing=await audit({});
  assert.equal(missing.finalBoards,0);assert.equal(missing.periods[0].resultRows,null);
  assert.equal(missing.periods[0].state,'unavailable');
});

test('malformed or duplicate board identities are reported instead of silently counted',async()=>{
  const report=await audit({[boardKey]:{period,entries:[record,record]}});
  assert.equal(report.issues.length,1);assert.match(report.issues[0].reason,/Duplicate/);
  const wrong=await audit({'events/wrong.json':{period,entries:[record]}});
  assert.equal(wrong.timedBoards,0);assert.equal(wrong.issues.length,1);
});
