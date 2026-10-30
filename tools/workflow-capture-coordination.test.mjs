import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {checkCapture, recordCapture, requestedAfter} from './workflow-capture-coordination.mjs';
import {publishSnapshot, encodeSnapshot, decodeSnapshot, buildSnapshotLookupShards} from './snapshot-package.mjs';
import {buildSnapshotBootstrapIndex, buildSnapshotFastIndex} from './track-snapshot-paging.mjs';
import {publicEventTotals} from './public-event-totals-backup.mjs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import {buildOfflineOverall} from './offline-overall.mjs';
import {computeOverall, rankTrustedTrackEntries} from '../workers/ranked/src/index.js';

const now = Date.UTC(2026, 9, 25, 0, 40);
const statePath = 'tools/workflow-capture-state.json';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, {mixed=false, omitted=null, totalsCount=0}={}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'capture-coordination-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const stage = path.join(root, 'input');
  await fs.mkdir(path.join(stage, 'tracks'), {recursive:true});
  await fs.mkdir(path.join(root, 'events'));await fs.mkdir(path.join(stage,'profiles'));await fs.mkdir(path.join(root, 'tools'));
  const track='a'.repeat(64), account='b'.repeat(64);
  const row={accountId:account,userId:account,trackId:track,uploadId:1,timeMs:100,frames:100,rank:1,
    runVerified:false,verified:false,verifiedState:0,integrityVerified:true,replayHash:'c'.repeat(64)};
  const values={
    'overall.json':{updatedAt:10,sourceRevision:1,builtRevision:1,algorithmVersion:'participation-v8-s1',schemaVersion:6,
      entries:[{userId:account,rank:1}],trackSummaries:[{trackId:track,updatedAt:10}],trackCatalog:[{trackId:track,updatedAt:10}],complete:true,totalEntries:1},
    ['tracks/'+track+'.json']:{trackId:track,updatedAt:mixed?11:10,sourceRevision:1,schemaVersion:6,entries:[row],complete:true,totalEntries:1},
    'manifest.json':{schemaVersion:1,trackIdsKnown:1,trackBackupsPresent:1,trackBackupsMissing:0,eventsMissing:0,
      tracks:{[track]:{path:'tracks/'+track+'.json',checkedAt:now,sourceUpdatedAt:10}}},
    'coverage.json':{schemaVersion:1,complete:false,profileReplay:{complete:false,budgetReached:true}},
    'public-export-summary.json':{complete:false,budgetReached:true,counts:{profiles:1,canonical:0,recordings:0}},
    'event-totals.json':{updatedAt:10,entries:[],complete:true,totalEntries:0},
    ['profiles/'+account+'.json']:{accountId:account,name:'Fixture'}
  };
  if(totalsCount)values['event-totals.json']=publicEventTotals({updatedAt:10,complete:true,totalEntries:totalsCount,paginatedSource:true,
    entries:Array.from({length:totalsCount},(_,i)=>({accountId:(i+1).toString(16).padStart(64,'0'),name:'Fixture',rp:i}))});
  if(omitted){
    const key=omitted==='track'?'tracks/'+track+'.json':'overall.json';
    const large=values[key];
    large.entries=Array.from({length:610},(_,i)=>({...omitted==='track'?row:{},userId:(i+1).toString(16).padStart(64,'0'),
      accountId:(i+1).toString(16).padStart(64,'0'),name:'x'.repeat(3500),rank:i+1,...omitted==='track'?{timeMs:100+i}: {}}));
    Object.assign(large,{complete:true,totalEntries:610,paginatedSource:true,sourceComplete:true,
      pagination:{version:1,generation:'d'.repeat(64),complete:true,pageSize:100,pageCount:7,totalEntries:610}});
  }
  for(const [file,value] of Object.entries(values))await fs.writeFile(path.join(stage,file),JSON.stringify(value));
  const result=await publishSnapshot({root,stagingDirectory:stage});
  await fs.writeFile(path.join(root,'snapshot-current.json'),JSON.stringify({currentdir:result.directory}));
  await fs.writeFile(path.join(root,'index.html'),`<meta name="polytrack-snapshot" content="./${result.directory}/">`);
  await fs.writeFile(path.join(root,'events/public-catalog.json'),JSON.stringify({periods:[],archives:[]}));
  const index=JSON.parse(await fs.readFile(path.join(root,result.directory,'index.json'),'utf8'));
  return {root,sha:index.files['overall.json']?.sha256,track,directory:result.directory};
}
async function mutatePayload(f, logical, transform, {raw=false,encoded=false,decodedBytes}={}) {
  const indexPath=path.join(f.root,f.directory,'index.json');
  const index=JSON.parse(await fs.readFile(indexPath,'utf8'));
  const previous=index.files[logical];
  const value=raw?null:JSON.parse(Buffer.from(await decodeSnapshot(await fs.readFile(path.join(f.root,f.directory,previous.path)))).toString());
  const next=await transform(value), data=raw||encoded?Buffer.from(next):Buffer.from(await encodeSnapshot(next));
  const sha=digest(data);
  await fs.writeFile(path.join(f.root,f.directory,sha+'.bin'),data);
  index.files[logical]={path:sha+'.bin',sha256:sha,decodedBytes:decodedBytes??Buffer.byteLength(JSON.stringify(next))};
  await fs.writeFile(indexPath,JSON.stringify(index));
  await sidecars(f,index);
}
async function sidecars(f,index) {
  const directory=path.join(f.root,f.directory);
  await fs.writeFile(path.join(directory,'bootstrap-index.json'),JSON.stringify(buildSnapshotBootstrapIndex(index)));
  await fs.writeFile(path.join(directory,'bootstrap-fast.json'),JSON.stringify(buildSnapshotFastIndex(index)));
  for(const [bucket,shard] of buildSnapshotLookupShards(index))await fs.writeFile(path.join(directory,'lookup-shards',bucket+'.json'),JSON.stringify(shard));
}

test('manual, legacy callers and catalog-only wakes cannot infer freshness from age', () => {
  for (const eventName of ['workflow_dispatch', 'workflow_call', undefined])
    assert.equal(requestedAfter({eventName, now}), null);
  assert.equal(requestedAfter({eventName: 'schedule', schedule: '19 20 * * 0', now}), null);
  assert.equal(requestedAfter({eventName: 'schedule', schedule: '20 0 * * *', now: now - 30 * 60000}), null);
  assert.equal(requestedAfter({eventName: 'schedule', schedule: '20 0 * * *', now}), now - 20 * 60000);
  for (const requestedAt of ['invalid', '-1', String(now + 1), '1e12'])
    assert.throws(() => requestedAfter({requestedAt, now}), /timestamp/);
});

test('only a successfully recorded capture starting after the request can coalesce', async t => {
  const {root} = await fixture(t), request = {root, requestedAt: String(now - 60000), now};
  assert.equal((await checkCapture(request)).reuse, false);
  await recordCapture({root, startedAt: String(now - 120000), now: now - 1000});
  assert.equal((await checkCapture(request)).reuse, false, 'finishing after request is insufficient');
  await recordCapture({root, startedAt: String(now - 30000), now: now - 1000});
  assert.equal((await checkCapture(request)).reuse, true);
  assert.equal((await checkCapture({root, now})).reuse, false, 'manual always captures');
  assert.equal((await checkCapture({...request, requestedAt: String(now)})).reuse, false, 'new verdict still captures');
});

test('daily reconciliation only reuses a capture that started after its own due boundary', async t => {
  const {root} = await fixture(t);
  const request = {root, now, eventName: 'schedule', schedule: '20 0 * * *'};
  await recordCapture({root, startedAt: String(now - 21 * 60000), now: now - 1000});
  assert.equal((await checkCapture(request)).reuse, false);
  await recordCapture({root, startedAt: String(now - 19 * 60000), now: now - 1000});
  assert.equal((await checkCapture(request)).reuse, true);
});

test('receipt mismatch cannot skip changed catalog or pointer, and corruption is not hidden', async t => {
  const {root, sha} = await fixture(t), request = {root, requestedAt: String(now - 60000), now};
  await recordCapture({root, startedAt: String(now - 30000), now: now - 1000});
  await fs.writeFile(path.join(root, 'events/public-catalog.json'), '{"periods":[],"archives":[],"updatedAt":1}');
  assert.equal((await checkCapture(request)).reuse, false);
  await recordCapture({root, startedAt: String(now - 30000), now: now - 1000});
  await fs.writeFile(path.join(root, 'public-snapshots1', sha + '.bin'), 'corrupt');
  await assert.rejects(checkCapture(request), /hash mismatch/);
  await assert.rejects(recordCapture({root, startedAt: String(now - 30000), now}), /hash mismatch/);
});

test('future, reversed, malformed and absent receipts never report reuse', async t => {
  const {root} = await fixture(t), request = {root, requestedAt: String(now - 60000), now};
  const state = await recordCapture({root, startedAt: String(now - 30000), now: now - 1000});
  for (const patch of [{completedAt: now + 1}, {startedAt: now}, {schemaVersion: 1}, {startedAt: 'today'}]) {
    await fs.writeFile(path.join(root, statePath), JSON.stringify({...state, ...patch}));
    assert.equal((await checkCapture(request)).reuse, false);
  }
  await fs.writeFile(path.join(root, statePath), 'malformed');
  assert.equal((await checkCapture(request)).reuse, false);
  await assert.rejects(recordCapture({root, startedAt: String(now + 1), now}), /timestamp/);
});

test('CLI uses local files only and rejects unsupported modes', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./workflow-capture-coordination.mjs', import.meta.url)), 'publish'],
    {encoding: 'utf8', env: {PATH: process.env.PATH, SystemRoot: process.env.SystemRoot}});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Expected check or record/);
});

test('valid bounded replay incompleteness is reusable independently of source coherence', async t => {
  const f=await fixture(t);
  const state=await recordCapture({root:f.root,startedAt:String(now-1000),now});
  assert.equal(state.schemaVersion,2);assert.equal(state.reusable,true);
  assert.equal((await checkCapture({root:f.root,requestedAt:String(now-2000),now})).reuse,true);
});

test('225-row projected totals remain valid without source pagination fields, but cross-chunk duplicates fail',async t=>{
  const f=await fixture(t,{totalsCount:225});
  assert.equal((await recordCapture({root:f.root,startedAt:String(now-1000),now})).reusable,true);
  assert.equal((await checkCapture({root:f.root,requestedAt:String(now-2000),now})).reuse,true);
  await mutatePayload(f,'event-totals.json',value=>({...value,entries:value.entries.map((row,i)=>i===224?value.entries[0]:row)}));
  await assert.rejects(recordCapture({root:f.root,startedAt:String(now-1000),now}),/Duplicate/);
  await assert.rejects(checkCapture({root:f.root,requestedAt:String(now-2000),now}),/Duplicate/);
});

test('profile-enriched event totals accept public nicknames but still reject private fields',async t=>{
  const f=await fixture(t,{totalsCount:226});
  await mutatePayload(f,'event-totals.json',value=>({...value,entries:value.entries.map(row=>({...row,nickname:'Public Racer'}))}));
  assert.equal((await recordCapture({root:f.root,startedAt:String(now-1000),now})).reusable,true);
  await mutatePayload(f,'event-totals.json',value=>({...value,entries:value.entries.map((row,index)=>index===0?{...row,ownerUid:'private-owner'}:row)}));
  await assert.rejects(recordCapture({root:f.root,startedAt:String(now-1000),now}),/Non-public/);
});

test('legacy success receipts and null receipts cannot bypass the upgraded package validation contract', async t => {
  const f=await fixture(t), request={root:f.root,requestedAt:String(now-2000),now};
  const state=await recordCapture({root:f.root,startedAt:String(now-1000),now});
  for(const value of [null,{...state,schemaVersion:1}]) {
    await fs.writeFile(path.join(f.root,statePath),JSON.stringify(value));
    assert.equal((await checkCapture(request)).reuse,false);
  }
});

test('a structurally valid mixed-source publication receives a nonreusable receipt without failing publication', async t => {
  const f=await fixture(t,{mixed:true});
  const state=await recordCapture({root:f.root,startedAt:String(now-1000),now});
  assert.equal(state.reusable,false);assert.equal(state.coherenceReason,'track_binding_mismatch');
  const request={root:f.root,requestedAt:String(now-2000),now};
  assert.equal((await checkCapture(request)).reuse,false);
  await fs.writeFile(path.join(f.root,statePath),JSON.stringify({...state,reusable:true}));
  assert.equal((await checkCapture(request)).reuse,false,'do not trust a success flag over current source bindings');
});

test('real omitted Overall and track monoliths remain valid through existing page reconstruction', async t => {
  for(const omitted of ['overall','track']) {
    const f=await fixture(t,{omitted});
    assert.equal((await recordCapture({root:f.root,startedAt:String(now-1000),now})).reusable,true);
  }
});

function forbidNetwork(t) {
  const calls = [];
  const deny = label => () => {calls.push(label); throw Error('Network forbidden: ' + label);};
  t.mock.method(globalThis, 'fetch', deny('fetch'));
  for (const [target, methods] of [[http, ['get', 'request']], [https, ['get', 'request']],
    [net, ['connect', 'createConnection']], [tls, ['connect']]])
    for (const method of methods) t.mock.method(target, method, deny(method));
  t.after(() => assert.deepEqual(calls, [], 'all integration inputs must be local'));
}

async function publishOfflineFixture(f) {
  const result = await publishSnapshot({root:f.root, stagingDirectory:f.stage});
  await fs.writeFile(path.join(f.root,'snapshot-current.json'),JSON.stringify({currentdir:result.directory}));
  await fs.writeFile(path.join(f.root,'index.html'),`<meta name="polytrack-snapshot" content="./${result.directory}/">`);
  const index = JSON.parse(await fs.readFile(path.join(f.root,result.directory,'index.json'),'utf8'));
  return {...f, directory:result.directory, index};
}

async function offlineOverallFixture(t, size) {
  forbidNetwork(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'offline-overall-receipt-'));
  assert.equal(path.dirname(root),path.resolve(os.tmpdir()));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const stage = path.join(root,'input');
  for (const name of ['input/tracks','events','tools']) await fs.mkdir(path.join(root,name),{recursive:true});
  const model = {algorithmVersion:'participation-v8-s1',schemaVersion:6,revision:10,sourceRevision:10,builtRevision:10,updatedAt:1000};
  // Small complete boards exercise 731 Overall rows without needing fake backend
  // pagination on either input. The many track opportunities also exercise omission.
  const population = Array.from({length:size},(_,i)=>(i+1).toString(16).padStart(64,'0'));
  const boardCount = size===731 ? Math.floor(size/2) : 3;
  const tracks = Array.from({length:boardCount},(_,i)=>{
    const trackId = (i+10000).toString(16).padStart(64,'0');
    const accounts = size===731 ? population.slice(i*2,i===boardCount-1?size:i*2+2) : population;
    const entries = rankTrustedTrackEntries(accounts.map((accountId,j)=>({accountId,trackId,name:'Public Racer',
      timeMs:10000+j*100,pbAt:100,pbCount:2,totalPlaytimeMs:500,accountCreatedAt:10,
      runVerified:true,integrityVerified:true})),trackId);
    return {...model,trackId,complete:true,sourceComplete:true,totalEntries:entries.length,entries};
  });
  const prior = computeOverall(tracks);
  const previousOverall = {...model,entries:prior,complete:true,totalEntries:prior.length,trackSummaries:[],
    trackCatalog:tracks.map(b=>({trackId:b.trackId,updatedAt:b.updatedAt}))};
  const built = await buildOfflineOverall({tracks,previousOverall,expectedTrackIds:tracks.map(b=>b.trackId),now:2000});
  const values = Object.fromEntries(built.files);
  values['overall-calculation.json'] = built.calculation;
  values['manifest.json'] = {schemaVersion:1,tracks:Object.fromEntries(tracks.map(b=>[b.trackId,{
    path:'tracks/'+b.trackId+'.json',sourceUpdatedAt:b.updatedAt,updatedAt:b.updatedAt}]))};
  values['coverage.json'] = {schemaVersion:1,complete:false};
  values['public-export-summary.json'] = {complete:false,counts:{profiles:0,canonical:0,recordings:0}};
  values['event-totals.json'] = {updatedAt:1000,entries:[],complete:true,totalEntries:0};
  for (const board of tracks) values['tracks/'+board.trackId+'.json'] = board;
  for (const [file,value] of Object.entries(values)) await fs.writeFile(path.join(stage,file),JSON.stringify(value));
  await fs.writeFile(path.join(root,'events/public-catalog.json'),JSON.stringify({periods:[],archives:[]}));
  return publishOfflineFixture({root,stage,built});
}

for (const size of [201,731]) test(`real offline ${size}-row Overall builds, packages, records and reuses without backend pagination`,async t=>{
  const f = await offlineOverallFixture(t,size), overall = f.built.files.get('overall.json');
  assert.equal(overall.entries.length,size);
  assert.equal(Object.hasOwn(overall,'pagination'),false);
  assert.equal(Object.hasOwn(overall,'paginatedSource'),false);
  if(size===731){
    assert.ok(f.built.report.artifactBytes['overall.json']>2*1024*1024);
    assert.equal(Object.hasOwn(f.index.files,'overall.json'),false,'large source must use real canonical package pages');
  }else assert.ok(f.index.files['overall.json'],'small assembled monolith remains present');
  const state = await recordCapture({root:f.root,startedAt:String(now-1000),now});
  assert.equal(state.reusable,true);
  assert.equal((await checkCapture({root:f.root,requestedAt:String(now-2000),now})).reuse,true);
  if(size===731){
    const before = await fs.readFile(path.join(f.root,statePath),'utf8');
    await mutatePayload(f,'overall-pages/3.json',page=>({...page,entries:page.entries.slice(1)}));
    await assert.rejects(recordCapture({root:f.root,startedAt:String(now-1000),now}));
    await assert.rejects(checkCapture({root:f.root,requestedAt:String(now-2000),now}));
    assert.equal(await fs.readFile(path.join(f.root,statePath),'utf8'),before,'invalid pages cannot advance receipt');
  }
});

test('assembled Overall admission retains completeness, schema, identity and backend-pagination guards',async t=>{
  const f = await offlineOverallFixture(t,201);
  const original = f.built.files.get('overall.json');
  await recordCapture({root:f.root,startedAt:String(now-1000),now});
  const before = await fs.readFile(path.join(f.root,statePath),'utf8');
  for (const change of [
    value=>{value.complete=false;}, value=>{value.sourceComplete=false;},
    value=>{value.totalEntriesExact=false;}, value=>{value.totalEntries++;}, value=>{value.publishedEntries--;},
    value=>{value.schemaVersion++;}, value=>{value.algorithmVersion='unsupported';},
    value=>{value.builtRevision++;}, value=>{value.sourceRevision=0;value.builtRevision=0;},
    value=>{value.entries[200].userId=value.entries[0].userId;},
    value=>{value.entries[200].userId='invalid';}, value=>{value.entries[200]=null;},
    value=>{value.pagination={version:1,complete:true};}, value=>{value.paginatedSource=false;},
    value=>{value.entries=Array.from({length:10001},(_,i)=>({userId:(i+1).toString(16).padStart(64,'0'),rank:0}));
      value.totalEntries=value.publishedEntries=value.entries.length;}
  ]) {
    const value=structuredClone(original);change(value);
    await mutatePayload(f,'overall.json',()=>value);
    await assert.rejects(recordCapture({root:f.root,startedAt:String(now-1000),now}));
    await assert.rejects(checkCapture({root:f.root,requestedAt:String(now-2000),now}));
    assert.equal(await fs.readFile(path.join(f.root,statePath),'utf8'),before);
  }
});

test('hash-valid invalid codec, invalid JSON, decoded-length mismatch and missing required artifacts cannot record or reuse success', async t => {
  const mutations=[
    f=>mutatePayload(f,'coverage.json',()=>Buffer.from('not encoded JSON'),{raw:true,decodedBytes:16}),
    f=>mutatePayload(f,'coverage.json',()=>encodeSnapshot('not-json'),{encoded:true,decodedBytes:8}),
    f=>mutatePayload(f,'coverage.json',value=>value,{decodedBytes:1}),
    async f=>{
      const file=path.join(f.root,f.directory,'index.json'),index=JSON.parse(await fs.readFile(file,'utf8'));
      delete index.files['event-totals.json'];await fs.writeFile(file,JSON.stringify(index));await sidecars(f,index);
    },
    async f=>fs.writeFile(path.join(f.root,'events/public-catalog.json'),'{"periods":[],"archives":[{"id":"bad"}]}'),
    async f=>fs.writeFile(path.join(f.root,'events/public-catalog.json'),JSON.stringify({periods:[{id:'d_fixture',trackId:f.track,
      startsAt:1,endsAt:2,kind:'invalid'}],archives:[]})),
    f=>mutatePayload(f,'manifest.json',value=>({...value,schemaVersion:99})),
    f=>mutatePayload(f,'public-export-summary.json',value=>({...value,counts:{profiles:'1',canonical:0,recordings:0}})),
    f=>mutatePayload(f,'overall.json',()=>[]),
    f=>mutatePayload(f,'overall-pages/1.json',value=>({...value,entries:[]})),
    async f=>fs.writeFile(path.join(f.root,f.directory,'bootstrap-fast.json'),'{"wrong":true}'),
    async f=>fs.writeFile(path.join(f.root,f.directory,'bootstrap-index.json'),'{"wrong":true}'),
    async f=>{
      const directory=path.join(f.root,f.directory,'lookup-shards');
      const name=(await fs.readdir(directory))[0];await fs.writeFile(path.join(directory,name),'{"wrong":true}');
    }
  ];
  for(const mutate of mutations){
    const f=await fixture(t);
    await recordCapture({root:f.root,startedAt:String(now-1000),now});
    const before=await fs.readFile(path.join(f.root,statePath),'utf8');
    await mutate(f);
    await assert.rejects(recordCapture({root:f.root,startedAt:String(now-1000),now}));
    await assert.rejects(checkCapture({root:f.root,requestedAt:String(now-2000),now}));
    assert.equal(await fs.readFile(path.join(f.root,statePath),'utf8'),before,'failed validation cannot advance the receipt');
  }
});

const readWorkflow = async name => (await fs.readFile(new URL('../.github/workflows/' + name, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
test('locks protect just the mutation jobs, leaving downstream verification/capture/CDN independent', async () => {
  for (const [name, job, group] of [
    ['verify-runs.yml', 'verify', 'polytrack-run-verifier'],
    ['sync-kodub-weekly.yml', 'sync', 'public-repository-captures-'],
    ['sync-event-catalog.yml', 'sync', 'public-repository-captures-'],
    ['publish-verified-snapshots.yml', 'sync', 'public-repository-captures-'],
  ]) {
    const source = await readWorkflow(name);
    assert.doesNotMatch(source, /^concurrency:/m);
    assert.match(source, new RegExp('  ' + job + ':\\n(?:    #.*\\n)?    concurrency:\\n      group: ' + group));
    assert.match(source, /cancel-in-progress: false/);
    assert.match(source, /ref: \$\{\{ github.event.repository.default_branch \}\}|persist-credentials: false/);
  }
});

test('reuse precedes production reads; receipt is recorded only after both captures succeed', async () => {
  for (const name of ['sync-event-catalog.yml', 'publish-verified-snapshots.yml']) {
    const source = await readWorkflow(name);
    assert.ok(source.indexOf('workflow-capture-coordination.mjs check') < source.indexOf('name: Capture public event assignments'));
    assert.match(source, /id: catalog\n        if: steps.coordination.outputs.reuse != 'true'/);
    assert.match(source, /id: snapshot\n        if: steps.coordination.outputs.reuse != 'true'/);
    assert.match(source, /CAPTURE_REQUESTED_AT: (?:''|\$\{\{ inputs.capture_requested_at \}\})\n/);
    const record = source.slice(source.indexOf('      - name: Record the successful'), source.indexOf('      - name: Commit changed assignments'));
    assert.match(record, /if: success\(\) && steps.catalog.outputs.capture_status == 'complete' && steps.snapshot.outputs.capture_status == 'complete'/);
    assert.doesNotMatch(record, /continue-on-error/);
    assert.match(record, /CAPTURE_STARTED_AT: \$\{\{ steps.coordination.outputs.started_at \}\}/);
    assert.match(source, /git add -- tools\/workflow-capture-state.json/);
    assert.doesNotMatch(source, /echo 'capture_status=complete'/);
  }
  const verifier = await readWorkflow('verify-runs.yml');
  assert.match(verifier, /capture_requested_at: \$\{\{ needs.verify.outputs.capture_requested_at \}\}/);
  assert.ok(verifier.indexOf('name: Timestamp the scheduled or changed capture request') > verifier.indexOf('name: Verify queued runs'));
  assert.match(verifier, /if: steps.queue.outputs.has_work == 'true'/);
});

test('one four-window pipeline follows rotations, manual fallback has no cron and CDN cannot recapture Firebase', async () => {
  const catalog = await readWorkflow('sync-event-catalog.yml');
  assert.doesNotMatch(catalog, /^  schedule:|cron:/m);
  assert.match(catalog, /^  workflow_dispatch:$/m);
  assert.match(await readWorkflow('verify-runs.yml'), /cron: '50 0,8,12,20 \* \* \*'/);
  assert.match(await readWorkflow('sync-kodub-weekly.yml'), /cron: "3 20 \* \* \*"/);
  const cdn = await readWorkflow('publish-cdn-release.yml');
  assert.match(cdn, /cron: '13,28,43,58 \* \* \* \*'/);
  assert.doesNotMatch(cdn, /update-public-snapshot|post-verification|FIREBASE/);
  assert.match(cdn, /--refresh-only/);
});
