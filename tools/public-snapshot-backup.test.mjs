import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {publicOverallBackup, publicTrackBackup, publicEventBackup, publicTrackRegistry, chooseTrackFetches,
  authenticatedOverallTrackBackup,
  publicEventReplayBackup, runPublicSnapshotBackup, PUBLIC_SNAPSHOT_LIMITS,
  isReusableArchivedEventBackup, createAdminArchiveCaptureFetch, promotePublicEventPlayback} from './public-snapshot-backup.mjs';

const trackId = 'a'.repeat(64);
const period = {id: 'daily_20261002', trackId, startsAt: 100, endsAt: 200, maxRp: 100, kind: 'daily'};
// Keep live fixtures live throughout synthetic year-long capture/reuse tests.
const livePeriod = {...period, endsAt: Date.UTC(2100, 0, 1)};
const archiveResponse = value => Response.json(value, {headers: {'X-Archive-Document-Reads': '1'}});
const archiveRepair = id => ({token: 'synthetic-private-token', periodIds: [id], maxRequests: 2});
const overall = {updatedAt: 300, revision: 9, builtRevision: 9, sourceRevision: 9, algorithmVersion: 'v1',
  schemaVersion: 6, complete: true, entries: [{userId: 'racer', name: 'Racer', score: 10, replayHash: 'private',
    ownerUid: 'private', resultSamples: [{replay: 'private'}], bestTracks: [{trackId, rank: 1, replayHash: 'private'}]}],
  trackSummaries: [{trackId, updatedAt: 250, fieldSize: 2, leader: {accountId: 'racer', name: 'Racer', replay: 'private'}}],
  authorityAudit: {ownerUid: 'private'}, resultBundleLocation: 'main_results'};

function materializedTrack(count = 501) {
  return {trackId, updatedAt: 250, revision: 7, sourceRevision: 7, complete: false, sourceComplete: true,
    totalEntriesExact: true, ranksExact: true, totalEntries: count,
    pagination: {version: 1, generation: 'b'.repeat(64), pageSize: 100, pageCount: Math.ceil(count / 100),
      totalEntries: count, complete: true},
    entries: Array.from({length: count}, (_, i) => ({accountId: (i + 1).toString(16).padStart(64, '0'), timeMs: 1000 + i}))};
}

test('authenticated materialized pages normalize only the preview flag and preserve exactness without mutating input', () => {
  for (const count of [0, 5, 501, 10000]) {
    const source = materializedTrack(count), before = structuredClone(source);
    const saved = authenticatedOverallTrackBackup(source, trackId);
    assert.equal(saved.complete, true);
    assert.equal(saved.sourceComplete, true);
    assert.equal(saved.paginatedSource, true);
    assert.equal(saved.totalEntries, count);
    assert.equal(saved.totalEntriesExact, true);
    assert.equal(saved.ranksExact, true);
    assert.deepEqual(saved.pagination, source.pagination);
    assert.deepEqual(saved.entries, source.entries);
    assert.deepEqual(source, before);
    assert.deepEqual(authenticatedOverallTrackBackup(saved, trackId), saved, 'materialization is idempotent');
    assert.deepEqual(publicTrackBackup(saved, trackId), saved);
  }
});

test('authenticated materialization rejects truncated pages, invalid manifests and explicit inexact or incomplete sources', () => {
  const changes = [
    b => {b.entries.pop();}, b => {b.totalEntries++;}, b => {b.totalEntries = String(b.totalEntries);},
    b => {delete b.totalEntries;}, b => {b.totalEntries = 0;},
    b => {b.totalEntriesExact = false;}, b => {b.ranksExact = false;},
    b => {b.sourceComplete = false;}, b => {delete b.sourceComplete;},
    b => {delete b.pagination;}, b => {b.pagination = null;},
    b => {b.pagination.complete = false;}, b => {b.pagination.totalEntries++;},
    b => {delete b.pagination.totalEntries;}, b => {b.pagination.totalEntries = 0;},
    b => {b.pagination.pageCount--;}, b => {b.pagination.pageSize = 500;},
    b => {b.pagination.version = 2;}, b => {b.pagination.generation = 'invalid';}
  ];
  for (const change of changes) {
    const source = materializedTrack(); change(source);
    assert.throws(() => authenticatedOverallTrackBackup(source, trackId), /Invalid authenticated Overall track snapshot/);
  }
  assert.throws(() => authenticatedOverallTrackBackup(materializedTrack(10001), trackId), /Invalid authenticated/);
  const direct = {...materializedTrack(5), complete: true}; delete direct.pagination;
  for (const key of ['sourceComplete', 'totalEntriesExact', 'ranksExact']) {
    assert.throws(() => authenticatedOverallTrackBackup({...direct, [key]: false}, trackId), /Invalid authenticated/);
  }
  const legacy = {...direct}; delete legacy.totalEntriesExact; delete legacy.ranksExact;
  assert.equal(authenticatedOverallTrackBackup(legacy, trackId).complete, true);
  assert.equal(Object.hasOwn(authenticatedOverallTrackBackup(legacy, trackId), 'totalEntriesExact'), false);
  assert.equal(Object.hasOwn(authenticatedOverallTrackBackup(legacy, trackId), 'ranksExact'), false);
  const pagedLegacy = materializedTrack(); delete pagedLegacy.totalEntriesExact; delete pagedLegacy.ranksExact;
  const normalized = authenticatedOverallTrackBackup(pagedLegacy, trackId);
  assert.equal(normalized.complete, true);
  assert.equal(Object.hasOwn(normalized, 'totalEntriesExact'), false, 'exact row count does not invent a flag');
  assert.equal(Object.hasOwn(normalized, 'ranksExact'), false);
});

test('public projection keeps negative exactness flags and never upgrades a preview', () => {
  const source = {...materializedTrack(), entries: materializedTrack().entries.slice(0, 500),
    totalEntriesExact: false, ranksExact: false};
  const saved = publicTrackBackup(source, trackId);
  assert.equal(saved.complete, false);
  assert.equal(saved.totalEntries, 501);
  assert.equal(saved.entries.length, 500);
  assert.equal(saved.totalEntriesExact, false);
  assert.equal(saved.ranksExact, false);
});

test('capture reuses normalized authenticated pages without fetching track data', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'materialized-source-capture-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const board = authenticatedOverallTrackBackup(materializedTrack(), trackId), calls = [];
  const result = await runPublicSnapshotBackup({directory, trackIds: [trackId], capturedOverall: overall,
    capturedTracks: new Map([[trackId, board]]), trackFetchLimit: 0, log: () => {}, fetchImpl: async input => {
      const pathname = new URL(input).pathname; calls.push(pathname);
      if (pathname === '/v1/events/catalog') return Response.json({periods: [], archives: []});
      assert.equal(pathname, '/v1/events/permanent-rolling-hills/snapshot');
      return new Response('', {status: 404});
    }});
  assert.equal(result.trackBackupsPresent, 1);
  assert.equal(calls.length, 2);
  const saved = JSON.parse(await fs.readFile(path.join(directory, `tracks/${trackId}.json`), 'utf8'));
  assert.deepEqual(saved, board);
});

async function pendingCaptureFixture(t,count=2){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'pending-capture-invariant-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const replay=deflateSync(Buffer.alloc(15)).toString('base64url'),replayHash=createHash('sha256').update(replay).digest('hex');
 const pending=Array.from({length:count},(_,i)=>({accountId:(i+1).toString(16).padStart(64,'0'),
  runId:(i+100).toString(16).padStart(64,'0'),timeMs:23,carStyle:'style',name:'Waiting',submittedAt:150,replayHash,
  verificationStatus:'waiting',pending:true,verified:false,eventRpEligible:false,source:'pending-event-playback'}));
 const verified={accountId:'f'.repeat(64),timeMs:22,rp:10,rank:1,physicsVerified:false};
 const state={calls:[],fail:new Set(),invalid:new Set()};
 const fetchImpl=async input=>{
  const url=new URL(input);state.calls.push(url.pathname);
  if(url.pathname.endsWith('/overall'))return Response.json({...overall,trackSummaries:[]});
  if(url.pathname.endsWith('/catalog'))return Response.json({periods:[livePeriod],archives:[]});
  if(url.pathname===`/v1/events/${period.id}/snapshot`)return Response.json({id:period.id,period:livePeriod,
   updatedAt:200,archived:false,entries:[verified],pendingPlaybacks:pending,racerCount:count+1});
  if(url.pathname.includes('/playbacks/')){
   const e=pending.find(row=>row.runId===url.pathname.split('/').at(-1));assert.ok(e);
   if(state.fail.has(e.runId))return new Response('',{status:404});
   return Response.json({periodId:period.id,trackId,accountId:e.accountId,runId:e.runId,timeMs:e.timeMs,frames:e.timeMs,
    replay,replayHash:state.invalid.has(e.runId)?'e'.repeat(64):replayHash,carStyle:e.carStyle,submittedAt:e.submittedAt,
    verificationStatus:'waiting',pending:true,verified:false,eventRpEligible:false,source:'pending-event-recording'});
  }
  return new Response('',{status:404});
 };
 const capture=()=>runPublicSnapshotBackup({directory,fetchImpl,trackIds:[],now:1000,log:()=>{}});
 const board=()=>fs.readFile(path.join(directory,`events/${period.id}.json`),'utf8').then(JSON.parse);
 const playbackCalls=()=>state.calls.filter(url=>url.includes('/playbacks/'));
 return {directory,pending,verified,state,capture,board,playbackCalls};
}

test('missing or invalid pending payloads stay off saved boards and later capture fills only missing runs',async t=>{
 for(const failure of ['fail','invalid']){
  const f=await pendingCaptureFixture(t);f.state[failure].add(f.pending[1].runId);
  const first=await f.capture(),board=await f.board();
  assert.deepEqual(board.pendingPlaybacks.map(row=>row.runId),[f.pending[0].runId]);
  assert.deepEqual(board.entries,[f.verified],'verified standings and RP are not filtered or rewritten');
  assert.equal(board.racerCount,3,'source entrant count must not be relabelled as complete payload coverage');
  assert.deepEqual(first.pendingPlaybackCoverage,{known:2,published:1,missing:1,failed:1,deferred:0,complete:false,scope:'selected-saved-event-boards'});
  assert.equal(Object.keys(first.eventPlaybacks).length,1);
  f.state[failure].clear();f.state.calls.length=0;
  const second=await f.capture();assert.equal(f.playbackCalls().length,1);
  assert.ok(f.playbackCalls()[0].endsWith('/'+f.pending[1].runId),'valid retained run must not be fetched again');
  assert.equal((await f.board()).pendingPlaybacks.length,2);assert.equal(second.pendingPlaybackCoverage.complete,true);
  f.state.calls.length=0;await f.capture();assert.equal(f.playbackCalls().length,0,'all exact retained bytes are reused');
 }
});

test('pending payload cap publishes only validated rows and resumes the rest without refetching retained bytes',async t=>{
 const f=await pendingCaptureFixture(t,32);
 const first=await f.capture();assert.equal(f.playbackCalls().length,30);assert.equal((await f.board()).pendingPlaybacks.length,30);
 assert.deepEqual(first.pendingPlaybackCoverage,{known:32,published:30,missing:2,failed:0,deferred:2,complete:false,scope:'selected-saved-event-boards'});
 f.state.calls.length=0;const second=await f.capture();
 assert.equal(f.playbackCalls().length,2);assert.equal((await f.board()).pendingPlaybacks.length,32);
 assert.equal(second.pendingPlaybackCoverage.complete,true);assert.equal(second.pendingPlaybackCoverage.deferred,0);
 assert.equal(second.eventReplayLimit,30);assert.deepEqual((await f.board()).entries,[f.verified]);
});

test('cached pending payloads must revalidate, and manifest metadata is derived from exact bytes',async t=>{
 const f=await pendingCaptureFixture(t,1);await f.capture();
 const manifestPath=path.join(f.directory,'manifest.json');const manifest=JSON.parse(await fs.readFile(manifestPath));
 const relative=`event-playbacks/${period.id}/${f.pending[0].runId}.json`;
 manifest.eventPlaybacks[relative].accountId='0'.repeat(64);await fs.writeFile(manifestPath,JSON.stringify(manifest));
 f.state.calls.length=0;const corrected=await f.capture();
 assert.equal(f.playbackCalls().length,0);assert.equal(corrected.eventPlaybacks[relative].accountId,f.pending[0].accountId);
 const payloadPath=path.join(f.directory,relative),saved=JSON.parse(await fs.readFile(payloadPath));
 saved.accountId='0'.repeat(64);await fs.writeFile(payloadPath,JSON.stringify(saved));f.state.fail.add(f.pending[0].runId);
 const rejected=await f.capture();assert.equal((await f.board()).pendingPlaybacks.length,0);
 assert.equal(Object.keys(rejected.eventPlaybacks).length,0);assert.equal(rejected.pendingPlaybackCoverage.complete,false);
 await assert.rejects(fs.stat(payloadPath),{code:'ENOENT'},'invalid cached bytes must not stay listed');
});

function eventPromotionFixture(){
 const replay=deflateSync(Buffer.alloc(15)).toString('base64url'),replayHash=createHash('sha256').update(replay).digest('hex');
 const accountId='b'.repeat(64),runId='c'.repeat(64);
 return {value:{periodId:period.id,trackId,accountId,runId,timeMs:23,frames:23,replay,replayHash,carStyle:'style',submittedAt:150,
  verificationStatus:'waiting',pending:true,verified:false,eventRpEligible:false,source:'pending-event-recording'},
  entry:{accountId,runId,timeMs:23,frames:23,replayHash,physicsVerified:true,replayIntegrityVerified:true}};
}

async function verifiedReplayCaptureFixture(t) {
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'verified-replay-integrity-'));
 t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const f=eventPromotionFixture(),calls=[];
 const entry={...f.entry,rp:10,rank:1};
 const value={...f.value,verificationStatus:'verified',verified:true,eventRpEligible:true};
 const relative=`event-replays/${period.id}/${entry.accountId}.json`;
 const fetchImpl=async input=>{
  const url=new URL(input);calls.push(url.pathname);
  if(url.pathname.endsWith('/overall'))return Response.json({...overall,trackSummaries:[]});
  if(url.pathname.endsWith('/catalog'))return Response.json({periods:[livePeriod],archives:[]});
  if(url.pathname===`/v1/events/${period.id}/snapshot`)return Response.json({id:period.id,period:livePeriod,
   updatedAt:200,archived:false,entries:[entry]});
  if(url.pathname.includes('/replays/'))return Response.json(value);
  return new Response('',{status:404});
 };
 return {directory,calls,entry,value,relative,
  capture:()=>runPublicSnapshotBackup({directory,fetchImpl,trackIds:[],now:1000,log:()=>{}}),
  board:()=>fs.readFile(path.join(directory,`events/${period.id}.json`),'utf8').then(JSON.parse),
  replace(replay){value.replay=replay;entry.replayHash=value.replayHash=createHash('sha256').update(replay).digest('hex');}};
}

test('verified export rejects hash-matching malformed recordings without hiding scores',async t=>{
 const unordered=Buffer.alloc(21);unordered.writeUIntLE(2,0,3);
 const pastFinish=Buffer.alloc(18);pastFinish.writeUIntLE(1,0,3);pastFinish.writeUIntLE(24,3,3);
 const oversizedChannel=Buffer.alloc(15+4097*3);oversizedChannel.writeUIntLE(4097,0,3);
 for(let i=0;i<4097;i++)oversizedChannel.writeUIntLE(1,3+i*3,3);
 const cases=['encoded','AAAA','not-base64!',
  ...[Buffer.alloc(14),Buffer.alloc(16),unordered,pastFinish,oversizedChannel,Buffer.alloc(150019)]
   .map(bytes=>deflateSync(bytes).toString('base64url'))];
 for(const replay of cases){
  const f=await verifiedReplayCaptureFixture(t);f.replace(replay);
  const manifest=await f.capture();
  assert.equal(manifest.eventReplays[f.relative],undefined,'matching SHA-256 is not playback integrity');
  await assert.rejects(fs.stat(path.join(f.directory,f.relative)),{code:'ENOENT'});
  assert.deepEqual((await f.board()).entries,[f.entry],'standings and scores must survive unavailable recordings');
  assert.equal(f.calls.filter(url=>url.includes('/replays/')).length,1,'no additional retries');
 }
});

test('verified cache revalidates recording structure even with exact fresh board bindings',async t=>{
 const f=await verifiedReplayCaptureFixture(t);await f.capture();
 f.replace('AAAA');
 const saved=publicEventReplayBackup(f.value,{periodId:period.id,trackId,entry:f.entry});
 await fs.writeFile(path.join(f.directory,f.relative),JSON.stringify(saved));
 const manifestPath=path.join(f.directory,'manifest.json');
 const prior=JSON.parse(await fs.readFile(manifestPath));prior.eventReplays[f.relative].replayHash=f.entry.replayHash;
 await fs.writeFile(manifestPath,JSON.stringify(prior));f.calls.length=0;
 const manifest=await f.capture();
 assert.equal(manifest.eventReplays[f.relative],undefined,'legacy malformed cache must not be retained indefinitely');
 await assert.rejects(fs.stat(path.join(f.directory,f.relative)),{code:'ENOENT'});
 assert.deepEqual((await f.board()).entries,[f.entry]);
 assert.equal(f.calls.filter(url=>url.includes('/replays/')).length,1,'replacement remains within the existing candidate budget');
});

test('verified export retains indexed-safe recordings and reuses valid bytes without requests',async t=>{
 const f=await verifiedReplayCaptureFixture(t);
 const bytes=Buffer.alloc(15+200*3);bytes.writeUIntLE(200,0,3);
 for(let i=0;i<200;i++)bytes.writeUIntLE(1,3+i*3,3);
 f.replace(deflateSync(bytes).toString('base64url'));
 f.entry.timeMs=f.entry.frames=f.value.timeMs=f.value.frames=300000;
 const first=await f.capture();assert.ok(first.eventReplays[f.relative]);
 assert.equal(first.replayCoverage.indexed,1,'legacy work limit must not reject indexed-safe bytes');
 assert.equal(first.replayCoverage.complete,true);
 f.calls.length=0;const second=await f.capture();
 assert.ok(second.eventReplays[f.relative]);
 assert.equal(f.calls.some(url=>url.includes('/replays/')),false);
 assert.equal(JSON.parse(await fs.readFile(path.join(f.directory,f.relative))).replay,f.value.replay);
});

test('event promotion requires exact fresh verified binding and preserves bytes without invented verdict dates',async()=>{
 const f=eventPromotionFixture();const context={periodId:period.id,trackId,entry:f.entry};
 const promoted=await promotePublicEventPlayback(f.value,context);
 assert.equal(promoted.replay,f.value.replay);assert.equal(promoted.submittedAt,150);assert.equal(promoted.verifiedAt,undefined);
 assert.equal(promoted.pending,undefined);assert.equal(promoted.source,undefined);
 const dated=await promotePublicEventPlayback(f.value,{...context,entry:{...f.entry,verifiedAt:200}});
 assert.equal(dated.verifiedAt,200);
 for(const mutation of [{accountId:'d'.repeat(64)},{runId:'d'.repeat(64)},{replayHash:'d'.repeat(64)},
  {timeMs:24},{frames:24},{physicsVerified:false},{physicsVerified:undefined},
  {replayIntegrityVerified:false},{replayHash:undefined},{submittedAt:151}])
  await assert.rejects(promotePublicEventPlayback(f.value,{...context,entry:{...f.entry,...mutation}}));
 for(const mutation of [{trackId:'d'.repeat(64)},{frames:24},{replay:f.value.replay+'A'},
  {verificationStatus:'rejected'},{ownerUid:'private'}])
  await assert.rejects(promotePublicEventPlayback({...f.value,...mutation},context));
});

test('pending-to-verified event capture reuses payload locally across later runs within unchanged budgets',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'event-promote-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const f=eventPromotionFixture(),calls=[];let verified=false;
 const pending={...f.entry,name:'Racer',carStyle:'style',submittedAt:150,verificationStatus:'waiting',pending:true,verified:false,eventRpEligible:false,
  source:'pending-event-playback'};
 const fetchImpl=async input=>{
  const url=new URL(input);calls.push(url.pathname);
  if(url.pathname.endsWith('/overall'))return Response.json({...overall,trackSummaries:[]});
  if(url.pathname.endsWith('/catalog'))return Response.json({periods:[livePeriod],archives:[]});
  if(url.pathname===`/v1/events/${period.id}/snapshot`)return Response.json({id:period.id,period:livePeriod,
   updatedAt:verified?200:180,archived:false,entries:verified?[f.entry]:[],pendingPlaybacks:verified?[]:[pending]});
  if(url.pathname.includes('/playbacks/'))return Response.json(f.value);
  if(url.pathname.includes('/replays/'))throw Error('Same exact event bytes must never be re-fetched');
  return new Response('',{status:404});
 };
 const capture=now=>runPublicSnapshotBackup({directory,fetchImpl,trackIds:[],now,log:()=>{}});
 await capture(1000);assert.equal(calls.filter(url=>url.includes('/playbacks/')).length,1);
 verified=true;calls.length=0;const manifest=await capture(1001);
 assert.equal(calls.some(url=>/\/(?:replays|playbacks)\//.test(url)),false);
 const relative=`event-replays/${period.id}/${f.entry.accountId}.json`;
 assert.ok(manifest.eventReplays[relative]);assert.equal(Object.keys(manifest.eventPlaybacks).length,0);
 const saved=JSON.parse(await fs.readFile(path.join(directory,relative)));
 assert.equal(saved.replay,f.value.replay);assert.equal(saved.verifiedAt,undefined);
 await assert.rejects(fs.stat(path.join(directory,`event-playbacks/${period.id}/${f.entry.runId}.json`)),{code:'ENOENT'});
 calls.length=0;await capture(1001+8*86400000);
 assert.equal(calls.some(url=>/\/(?:replays|playbacks)\//.test(url)),false,'exact fresh run binding avoids metadata-only payload downloads too');
 assert.equal(PUBLIC_SNAPSHOT_LIMITS.eventReplayFetches,30);assert.equal(PUBLIC_SNAPSHOT_LIMITS.eventReplaysPerPeriod,500);
});

test('legacy archive reuse requires validated exact coverage and never invents completeness',()=>{
  const legacy={period:{...period,entrantLimit:200},updatedAt:220,archived:true,racerCount:1,
    entries:[{accountId:'b'.repeat(64),timeMs:23,name:'Racer'}]};
  assert.equal(isReusableArchivedEventBackup(legacy,period.id),true);
  assert.equal(isReusableArchivedEventBackup({...legacy,totalEntries:1,sourceTotalEntries:1},period.id),true);
  assert.equal(isReusableArchivedEventBackup({...legacy,racerCount:0,entries:[]},period.id),true);
  assert.equal(legacy.complete,undefined);assert.equal(legacy.totalEntries,undefined);
  const full=structuredClone(legacy);
  full.entries=Array.from({length:200},(_,i)=>({accountId:i.toString(16).padStart(64,'0'),timeMs:23}));
  full.racerCount=200;
  assert.equal(isReusableArchivedEventBackup(full,period.id),true,'exact authoritative count supports the legacy cap');
  for(const change of [{archived:false},{complete:false},{complete:null},{sourceComplete:false},
    {sourceComplete:'true'},{publicationPending:true},{publicationPending:null},{totalEntries:2},
    {totalEntries:null},{sourceTotalEntries:2},{racerCount:undefined},{racerCount:2},
    {racerCount:'1'},{racerCount:-1},{period:undefined},{period:{...period,id:'wrong'}},
    {period:{...period,entrantLimit:0}},{entries:[{accountId:'invalid',timeMs:23}]},
    {entries:[{accountId:'b'.repeat(64),timeMs:0}]},
    {entries:[legacy.entries[0],legacy.entries[0]],racerCount:2},
    {pagination:{complete:false}},{pagination:null},{paginatedSource:true}])
    assert.equal(isReusableArchivedEventBackup({...legacy,...change},period.id),false,JSON.stringify(change));
  const projected=publicEventBackup({...legacy,publicationPending:true},period.id);
  assert.equal(projected.publicationPending,true,'incomplete marker must survive saving');
  assert.equal(isReusableArchivedEventBackup(projected,period.id),false);
});

test('modern archive reuse rejects explicit incomplete metadata and unassembled pages',()=>{
  const modern={period,updatedAt:220,archived:true,entries:[],complete:true,totalEntries:0};
  assert.equal(isReusableArchivedEventBackup(modern,period.id),true);
  assert.equal(isReusableArchivedEventBackup({...modern,sourceComplete:false},period.id),false);
  const pagination={version:1,generation:'a'.repeat(64),pageSize:100,pageCount:0,totalEntries:0,complete:true};
  assert.equal(isReusableArchivedEventBackup({...modern,pagination,paginatedSource:true},period.id),true);
  assert.equal(isReusableArchivedEventBackup({...modern,pagination},period.id),false);
  for(const change of [{complete:false},{pageCount:1},{totalEntries:100},{generation:'wrong'},{pageSize:200}])
    assert.equal(isReusableArchivedEventBackup({...modern,paginatedSource:true,pagination:{...pagination,...change}},period.id),false);
});

test('validated legacy archives and recordings are reused indefinitely with no completeness fields',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'polytrack-legacy-archive-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const archived={...period,id:'daily_old',entrantLimit:200};
  const accountId='b'.repeat(64),replay=deflateSync(Buffer.alloc(15)).toString('base64url'),replayHash=createHash('sha256').update(replay).digest('hex');
  const calls=[],logs=[];
  const fetchImpl=async input=>{
    const url=new URL(input);calls.push(url.pathname);
    if(url.pathname.endsWith('/overall'))return archiveResponse({...overall,trackSummaries:[]});
    if(url.pathname.endsWith('/catalog'))return archiveResponse({periods:[livePeriod],archives:[archived]});
    if(url.pathname==='/v1/snapshot/track')return new Response('',{status:404});
    if(url.pathname.includes('/replays/'))return archiveResponse({periodId:archived.id,trackId,accountId,
      runId:'c'.repeat(64),timeMs:23,frames:23,replay,replayHash,carStyle:'native',
      verificationStatus:'verified',verified:true,eventRpEligible:true});
    const id=url.pathname.split('/').at(-2);
    return archiveResponse(id===archived.id?{period:archived,id,updatedAt:220,archived:true,racerCount:1,
      entries:[{accountId,timeMs:23,name:'Racer'}]}:{id,updatedAt:220,archived:false,entries:[]});
  };
  const capture=(now,repair=false)=>runPublicSnapshotBackup({fetchImpl,directory,now,trackIds:[],log:line=>logs.push(JSON.parse(line)),...(repair?{archiveExport:archiveRepair(archived.id)}:{})});
  await capture(1000,true);calls.length=0;
  const second=await capture(1000+365*86400000);
  assert.equal(calls.some(url=>url.includes('/daily_old/')),false);
  assert.equal(second.events[archived.id].checkedAt,1000);
  assert.equal(logs.at(-1).publicSnapshotBackup.archivedEventsReused,1);
  const file=path.join(directory,`events/${archived.id}.json`);
  const cached=JSON.parse(await fs.readFile(file,'utf8'));
  assert.equal(Object.hasOwn(cached,'complete'),false);
  assert.equal(Object.hasOwn(cached,'totalEntries'),false);
  for(const change of [null,{}, {complete:false},{sourceComplete:false},{publicationPending:true},{racerCount:2},{totalEntries:2}]) {
    if(change===null)await fs.unlink(file);else await fs.writeFile(file,JSON.stringify(Object.keys(change).length?{...cached,...change}:{}));calls.length=0;
    const routine=await capture(1001+365*86400000);
    assert.equal(calls.some(url=>url.includes('/daily_old/')),false,JSON.stringify(change));
    assert.equal(routine.archivedEventsUnavailable,1);assert.ok(routine.eventsMissing>=1);
    calls.length=0;
    await capture(1002+365*86400000,true);
    assert.equal(calls.filter(url=>url==='/v1/events/admin/archive-export/daily_old/snapshot').length,1,JSON.stringify(change));
    assert.equal(calls.some(url=>url==='/v1/events/daily_old/snapshot'),false,'no public archive fallback');
    assert.equal(logs.at(-1).publicSnapshotBackup.archivedEventsReused,0);
  }
});

test('missing or corrupt expired and archived standings never trigger routine Worker reads',async t=>{
  for(const state of ['missing','corrupt']){
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),'polytrack-no-frozen-fallback-'));
    t.after(()=>fs.rm(directory,{recursive:true,force:true}));
    const expired={...period,id:'daily_expired'},frozen={...period,id:'daily_frozen'},calls=[];
    const records=Object.fromEntries([expired,frozen].map(row=>[row.id,{path:`events/${row.id}.json`,checkedAt:500}]));
    await fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify({schemaVersion:1,tracks:{},events:records}));
    if(state==='corrupt'){
      await fs.mkdir(path.join(directory,'events'));
      for(const row of [expired,frozen])await fs.writeFile(path.join(directory,`events/${row.id}.json`),'{}');
    }
    const fetchImpl=async(input,init)=>{
      const url=new URL(input);calls.push(url.pathname);
      if(url.pathname.endsWith('/overall'))return Response.json({...overall,trackSummaries:[]});
      if(url.pathname.endsWith('/catalog'))return Response.json({periods:[expired],archives:[frozen]});
      if(url.pathname==='/v1/snapshot/track')return new Response('',{status:404});
      if(url.pathname==='/v1/events/permanent-rolling-hills/snapshot')return Response.json({updatedAt:300,entries:[]});
      assert.equal(url.pathname,'/v1/events/admin/archive-export/daily_expired/snapshot','only explicitly named admin repair may reach a frozen resource');
      assert.equal(init.headers.get('X-Admin-Token'),'synthetic-private-token');
      assert.equal(init.redirect,'error');
      return archiveResponse({id:expired.id,period:expired,updatedAt:300,archived:true,complete:true,totalEntries:0,entries:[]});
    };
    const options={fetchImpl,directory,now:1000000000,trackIds:[],log:()=>{}};
    const routine=await runPublicSnapshotBackup(options);
    assert.equal(calls.some(url=>url.includes('/daily_expired/')||url.includes('/daily_frozen/')),false,state);
    assert.equal(routine.archivedEventsUnavailable,2);assert.equal(routine.eventsMissing,2);
    calls.length=0;
    const repaired=await runPublicSnapshotBackup({...options,archiveExport:{...archiveRepair(expired.id),maxRequests:1}});
    assert.equal(calls.filter(url=>url.includes('/admin/archive-export/')).length,1);
    assert.equal(calls.some(url=>url.includes('/daily_frozen/')),false,'authorization does not extend to other frozen periods');
    assert.equal(repaired.archivedEventsUnavailable,1);assert.equal(repaired.eventsMissing,1);
    assert.ok(repaired.events[expired.id].path);
    const saved=JSON.parse(await fs.readFile(path.join(directory,`events/${expired.id}.json`),'utf8'));
    assert.equal(isReusableArchivedEventBackup(saved,expired.id),true);
  }
});

test('admin capture credentials are scoped to named GET resources and never follow redirects',async()=>{
  const base='https://polytrack-ranked-worker.staticquasar931.workers.dev',calls=[];
  const wrapper=createAdminArchiveCaptureFetch({token:'synthetic-private-token',periodIds:['daily_old'],maxRequests:4,
    fetchImpl:async(input,init)=>{calls.push({url:new URL(input),init});return Response.json({}, {headers:{'X-Archive-Document-Reads':'1'}});}});
  for(const suffix of ['snapshot','snapshot/page?generation='+'a'.repeat(64)+'&page=0','replays/'+'b'.repeat(64),'track']) {
    await wrapper.fetch(base+'/v1/events/daily_old/'+suffix,{headers:{Accept:'application/json'}});
    const sent=calls.at(-1);
    assert.ok(sent.url.pathname.startsWith('/v1/events/admin/archive-export/daily_old/'));
    assert.equal(sent.init.headers.get('X-Admin-Token'),'synthetic-private-token');
    assert.equal(sent.init.headers.get('Origin'),'https://staticquasar931.github.io');
    assert.equal(sent.init.redirect,'error');assert.equal(sent.init.method,'GET');
  }
  assert.equal(calls[1].url.searchParams.get('page'),'0');
  await assert.rejects(wrapper.fetch(base+'/v1/events/daily_old/snapshot'),/request budget/);
  assert.equal(calls.length,4);
  await wrapper.fetch(base+'/v1/events/daily_live/snapshot');
  assert.equal(new Headers(calls.at(-1).init?.headers).has('X-Admin-Token'),false);
  await assert.rejects(wrapper.fetch('https://foreign.test/v1/events/daily_old/snapshot'),/host/);
  await assert.rejects(wrapper.fetch(base+'/v1/events/daily_old/receipt'),/resource/);
  await assert.rejects(wrapper.fetch(base+'/v1/events/daily_old/snapshot',{method:'POST'}),/resource/);
  assert.deepEqual(wrapper.stats(),{requests:4,documentReads:4,documentReadCeiling:24});
  assert.equal(calls.length,5);
});

test('admin capture requires explicit finite options and bounded response accounting',async()=>{
  for(const change of [{token:''},{periodIds:[]},{periodIds:['*']},{periodIds:['daily_old','daily_old']},
    {periodIds:['permanent-rolling-hills']},{maxRequests:0},{maxRequests:121}])
    assert.throws(()=>createAdminArchiveCaptureFetch({token:'synthetic',periodIds:['daily_old'],...change}),/options/);
  for(const header of [undefined,'7','-1','NaN']) {
    const wrapper=createAdminArchiveCaptureFetch({token:'synthetic',periodIds:['daily_old'],maxRequests:1,
      fetchImpl:async()=>Response.json({},{headers:header===undefined?{}:{'X-Archive-Document-Reads':header}})});
    await assert.rejects(wrapper.fetch('https://polytrack-ranked-worker.staticquasar931.workers.dev/v1/events/daily_old/snapshot'),/accounting unavailable/);
    assert.deepEqual(wrapper.stats(),{requests:1,documentReads:6,documentReadCeiling:6});
  }
});

test('opt-in archive capture exhaustion preserves previous backups without public fallback',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'polytrack-admin-archive-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const prior={schemaVersion:1,tracks:{},events:{}};
  await fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify(prior));
  const calls=[];
  const options={directory,trackIds:[],log:()=>{},
    archiveExport:{token:'synthetic',periodIds:['old1','old2'],maxRequests:1},
    fetchImpl:async(input,init)=>{
      const url=new URL(input);calls.push(url.pathname);
      if(url.pathname.includes('/admin/archive-export/')) {
        assert.equal(init.headers.get('X-Admin-Token'),'synthetic');
        const id=url.pathname.split('/').at(-2);
        return Response.json({period:{...period,id},updatedAt:220,archived:true,racerCount:0,entries:[]},
          {headers:{'X-Archive-Document-Reads':'1'}});
      }
      assert.equal(new Headers(init?.headers).has('X-Admin-Token'),false);
      if(url.pathname.endsWith('/overall'))return Response.json({...overall,trackSummaries:[]});
      if(url.pathname.endsWith('/catalog'))return Response.json({periods:[],archives:['old1','old2'].map(id=>({...period,id}))});
      if(url.pathname==='/v1/snapshot/track')return new Response('',{status:404});
      assert.equal(url.pathname,'/v1/events/permanent-rolling-hills/snapshot');
      return Response.json({updatedAt:220,entries:[]});
    }};
  const result=await runPublicSnapshotBackup(options);
  assert.equal(result.deferred,true);
  assert.equal(result.previousBackupsPreserved,true);
  assert.equal(calls.filter(url=>url.includes('/admin/archive-export/')).length,1);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory,'manifest.json'),'utf8')),prior);
  assert.deepEqual(await fs.readdir(directory),['manifest.json']);
  calls.length=0;
  const captured=await runPublicSnapshotBackup({...options,archiveExport:{...options.archiveExport,maxRequests:2}});
  assert.equal(captured.deferred,undefined);
  assert.ok(captured.events.old1);assert.ok(captured.events.old2);
  assert.equal(calls.filter(url=>url.includes('/admin/archive-export/')).length,2);
  calls.length=0;
  await runPublicSnapshotBackup(options);
  assert.equal(calls.some(url=>url.includes('/admin/archive-export/')),false,'freshly captured legacy archives also become reusable');
});

test('archived standings and validated replays survive catalog rollover without replay refetches',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'polytrack-static-archive-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const archived={...period,id:'daily_old',startsAt:Date.UTC(2026,8,1),endsAt:Date.UTC(2026,8,2)};
  const accountId='e'.repeat(64), replay=deflateSync(Buffer.alloc(15)).toString('base64url'), replayHash=createHash('sha256').update(replay).digest('hex');
  let listed=true,replayRequests=0;
  const fetchImpl=async input=>{
    const url=new URL(input);
    if(url.pathname==='/v1/snapshot/track')return new Response('',{status:404});
    if(url.pathname.endsWith('/overall'))return archiveResponse({...overall,trackSummaries:[]});
    if(url.pathname.endsWith('/catalog'))return archiveResponse({periods:[livePeriod],archives:listed?[archived]:[]});
    if(url.pathname.includes('/replays/')){replayRequests++;return archiveResponse({periodId:archived.id,trackId,accountId,runId:'d'.repeat(64),timeMs:23,frames:23,replay,replayHash,carStyle:'public',verificationStatus:'verified',verified:true,eventRpEligible:true});}
    const id=url.pathname.split('/').at(-2);
    return archiveResponse({id,updatedAt:180,archived:id===archived.id,period:id===archived.id?archived:undefined,
      entries:id===archived.id?[{accountId,name:'sh1t',timeMs:23,physicsVerified:true,replayIntegrityVerified:true}]:[]});
  };
  const first=await runPublicSnapshotBackup({fetchImpl,directory,now:Date.UTC(2026,9,1),trackIds:[],log:()=>{},archiveExport:archiveRepair(archived.id)});
  assert.equal(replayRequests,1);
  const relative=`event-replays/${archived.id}/${accountId}.json`;
  assert.ok(first.eventReplays[relative]);
  listed=false;
  const second=await runPublicSnapshotBackup({fetchImpl,directory,now:Date.UTC(2026,9,1)+1,trackIds:[],log:()=>{}});
  assert.equal(replayRequests,1,'unchanged recording is retained without another cloud read');
  assert.ok(second.events[archived.id]);assert.ok(second.eventReplays[relative]);
  const saved=JSON.parse(await fs.readFile(path.join(directory,`events/${archived.id}.json`),'utf8'));
  assert.equal(saved.entries[0].name,'Racer');assert.equal(saved.entries[0].replayHash,replayHash);
  const month=JSON.parse(await fs.readFile(path.join(directory,'archives/2026-09.json'),'utf8'));
  assert.equal(month.periods[0].id,archived.id);
  for(const state of ['missing','corrupt']){
    if(state==='missing')await fs.unlink(path.join(directory,relative));
    else await fs.writeFile(path.join(directory,relative),'{}');
    const before=replayRequests;
    const routine=await runPublicSnapshotBackup({fetchImpl,directory,now:Date.UTC(2026,9,1)+2,trackIds:[],log:()=>{}});
    assert.equal(replayRequests,before,state+' frozen replay never triggers routine Worker repair');
    assert.equal(routine.eventReplays[relative],undefined,'unvalidated replay is not advertised');
    const repaired=await runPublicSnapshotBackup({fetchImpl,directory,now:Date.UTC(2026,9,1)+3,trackIds:[],log:()=>{},archiveExport:archiveRepair(archived.id)});
    assert.equal(replayRequests,before+1,'explicit bounded repair fetches the frozen replay');
    assert.equal(repaired.eventReplays[relative].replayHash,replayHash);
  }
});


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
    serverAchievements: {casual: {count: 12, rp: 1234.5, pointsPerTrack: 100, scoringVersion: 2, ledger: 'private-ledger', privateProof: 'private'},
      beatOwner: {targetAccountId: 'b'.repeat(64), count: 1,
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
  assert.deepEqual(result.snapshot.entries[0].serverAchievements.casual,
    {count: 12, rp: 1234.5, scoringVersion: 2});
  assert.equal(JSON.stringify(result.snapshot.entries[0]).includes('private-proof'), false);
  assert.equal(JSON.stringify(result.snapshot.entries[0]).includes('private-ledger'), false);
  assert.equal(result.snapshot.authorityAudit, undefined);
  assert.equal(result.snapshot.resultBundleLocation, undefined);
  assert.equal(result.snapshot.resultBundleComplete, false);
  assert.deepEqual(result.planner, {available: false, reason: 'sidecar-not-in-public-response'});
});

test('overall projection drops malformed Casual summaries rather than manufacturing totals', () => {
  const {snapshot} = publicOverallBackup({...overall, entries: [{...overall.entries[0],
    serverAchievements: {casual: {count: -1, rp: '1200', pointsPerTrack: 99, ledger: 'private'}}}]});
  assert.equal(snapshot.entries[0].serverAchievements, undefined);
});

test('overall projection does not publish legacy Casual scoring as version 2', () => {
  const {snapshot} = publicOverallBackup({...overall, entries: [{...overall.entries[0],
    serverAchievements: {casual: {count: 3, rp: 300, scoringVersion: 1}}}]});
  assert.deepEqual(snapshot.entries[0].serverAchievements.casual, {count: 3});
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

test('event snapshots preserve bounded waiting rows without upgrading their status', () => {
  const pendingPlaybacks = ['b', 'c', 'd'].map((account, index) => ({accountId: account.repeat(64), runId: (index + 10).toString(16).padStart(64, '0'),
    timeMs: 23000 + index, name: `Waiting ${index}`, carStyle: 'public-style', submittedAt: 150,
    verificationStatus: 'waiting', pending: true, verified: false, eventRpEligible: false, source: 'pending-event-playback',
    periodId: period.id, trackId, replay: 'must-not-export', replayHash: 'private', ownerUid: 'private'}));
  const live = {period, updatedAt: 180, archived: false, racerCount: 5, entries: [], pendingPlaybacks};
  const snapshot = publicEventBackup(live, period.id);
  assert.equal(snapshot.entries.length, 0);assert.equal(snapshot.racerCount, 5);assert.equal(snapshot.pendingPlaybacks.length, 3);
  assert.deepEqual(Object.keys(snapshot.pendingPlaybacks[0]).sort(),
    ['accountId', 'carStyle', 'eventRpEligible', 'name', 'pending', 'runId', 'source', 'submittedAt', 'timeMs', 'verificationStatus', 'verified'].sort());
  assert.equal(snapshot.pendingPlaybacks[0].verified, false);assert.equal(snapshot.pendingPlaybacks[0].eventRpEligible, false);
  const restored = publicEventBackup(JSON.parse(JSON.stringify(snapshot)), period.id);
  assert.deepEqual(restored.pendingPlaybacks, snapshot.pendingPlaybacks);assert.equal(restored.racerCount, 5);
});

test('event snapshots omit the entire pending array on invalid binding, status, duplicate runs, overflow, or archive', () => {
  const row = {accountId: 'b'.repeat(64), runId: 'c'.repeat(64), timeMs: 23000, name: 'Waiting racer', carStyle: '', submittedAt: 150,
    verificationStatus: 'waiting', pending: true, verified: false, eventRpEligible: false, source: 'pending-event-playback'};
  const snapshot = pendingPlaybacks => publicEventBackup({period, updatedAt: 180, archived: false, racerCount: 5, entries: [], pendingPlaybacks}, period.id);
  for (const invalid of [
    {...row, periodId: 'weekly_other'}, {...row, trackId: 'd'.repeat(64)}, {...row, accountId: 'not-an-account'},
    {...row, runId: 'not-a-run'}, {...row, verificationStatus: 'verified'}, {...row, pending: false},
    {...row, verified: true}, {...row, eventRpEligible: true}, {...row, submittedAt: period.endsAt}
  ]) assert.equal(snapshot([row, invalid]).pendingPlaybacks, undefined);
  const sameAccount = snapshot([row, {...row, runId: 'e'.repeat(64), timeMs: row.timeMs + 1}]);
  assert.equal(sameAccount.pendingPlaybacks.length, 2, 'distinct pending runs from one account are retained');
  assert.deepEqual(sameAccount.pendingPlaybacks.map(pending => pending.runId), [row.runId, 'e'.repeat(64)]);
  assert.equal(snapshot([row, {...row, accountId: 'f'.repeat(64)}]).pendingPlaybacks, undefined, 'duplicate run rejects the full list');
  const tooMany = Array.from({length: 513}, (_, index) => ({...row,
    accountId: index.toString(16).padStart(64, '0'), runId: (index + 1000).toString(16).padStart(64, '0')}));
  assert.equal(snapshot(tooMany).pendingPlaybacks, undefined);
  const archived = publicEventBackup({period, updatedAt: 180, archived: true, racerCount: 5, entries: [], pendingPlaybacks: [row]}, period.id);
  assert.equal(archived.pendingPlaybacks, undefined);assert.equal(archived.racerCount, 5);
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
  for (const binding of [{runId: 'e'.repeat(64)}, {replayHash: 'f'.repeat(64)}]) {
    assert.throws(() => publicEventReplayBackup(value, {periodId: period.id, trackId, entry: {...entry, ...binding}}), /unbound/);
  }
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
  assert.equal(PUBLIC_SNAPSHOT_LIMITS.trackFetches, 20);
});

test('missing known-source boards outrank speculative stale cached boards within the fetch budget',()=>{
  const missingKnown='b'.repeat(64),staleSpeculative='c'.repeat(64),dirtyPresent='d'.repeat(64),unchanged='e'.repeat(64);
  const now=10*86400000;
  const summaries=[{trackId:missingKnown,updatedAt:21},{trackId:dirtyPresent,updatedAt:31},{trackId:unchanged,updatedAt:40}];
  for(const missingRecord of [undefined,{path:null,missing:true,sourceUpdatedAt:20,checkedAt:now-1}]){
    const previous={
      [staleSpeculative]:{path:`tracks/${staleSpeculative}.json`,sourceUpdatedAt:1,checkedAt:1},
      [dirtyPresent]:{path:`tracks/${dirtyPresent}.json`,sourceUpdatedAt:30,checkedAt:now-1},
      [unchanged]:{path:`tracks/${unchanged}.json`,sourceUpdatedAt:40,checkedAt:1},
      ...(missingRecord?{[missingKnown]:missingRecord}:{})
    };
    assert.deepEqual(chooseTrackFetches([staleSpeculative,missingKnown],summaries,previous,1,now),[missingKnown],
      'known source work beats an older existing file with no source summary, even after a recent missing check');
    assert.deepEqual(chooseTrackFetches([staleSpeculative,missingKnown,dirtyPresent,unchanged],summaries,previous,2,now),
      [dirtyPresent,missingKnown],'dirty source first, then present before missing within the dirty tier');
    assert.deepEqual(chooseTrackFetches([staleSpeculative,missingKnown,dirtyPresent,unchanged],summaries,previous,100,now),
      [dirtyPresent,missingKnown,staleSpeculative],'speculative coverage remains eligible after known dirty work');
  }
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
  assert.equal(first.length, PUBLIC_SNAPSHOT_LIMITS.trackFetches);
  assert.equal(second.length, PUBLIC_SNAPSHOT_LIMITS.trackFetches);
  assert.ok(second.some(id => !first.includes(id)));
});

test('workflow stages first-run untracked snapshots before checking for changes', async t => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const workflow = await fs.readFile(path.join(repo, '.github/workflows/sync-event-catalog.yml'), 'utf8');
  const stageCatalog = workflow.indexOf('git add -- events/public-catalog.json');
  const conditionalSnapshots = workflow.indexOf('if [ -f snapshot-current.json ]; then');
  const stageSnapshots = workflow.indexOf("git add -A -- ':(glob)public-snapshots[0-9]*/**'", conditionalSnapshots);
  const stagedDiff = workflow.indexOf('git diff --cached --quiet;');
  assert.ok(stageCatalog >= 0 && conditionalSnapshots > stageCatalog && stageSnapshots > conditionalSnapshots && stagedDiff > stageSnapshots);
  assert.equal(workflow.split('git add -- events/public-catalog.json').length - 1, 1);
  assert.ok(workflow.includes('node tools/update-public-snapshot.mjs'));
  assert.ok(!workflow.includes('git add -- local-reports'));

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
  const replayAccount = 'e'.repeat(64), replayData = deflateSync(Buffer.alloc(15)).toString('base64url');
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
    if (url.pathname.endsWith('/v1/events/catalog')) return Response.json({periods: [livePeriod], archives: []});
    if (url.pathname.endsWith('/v1/snapshot/track')) return Response.json({trackId, updatedAt: 251, revision: 1, entries: []});
    if (url.pathname.endsWith('/v1/events/permanent-rolling-hills/snapshot')) return Response.json({id: 'permanent-rolling-hills', updatedAt: 190, entries: []});
    if (url.pathname.endsWith('/v1/events/daily_20261002/snapshot')) return Response.json({id: period.id, period: livePeriod, updatedAt: 180,
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
  assert.equal(manifest.tracks[trackId].checkedAt, 1000000000);
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
  const unchangedManifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
  assert.equal(unchangedManifest.tracks[trackId].checkedAt, 1000000000);
  assert.ok(calls.length < firstCount);
});

test('complete finalized archives never expire, while live events stay fresh and incomplete archives require opt-in repair', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'polytrack-archive-reuse-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const archived = {...period, id: 'daily_old'};
  const calls = [];
  const fetchImpl = async input => {
    const url = new URL(input);
    if(url.pathname==='/v1/snapshot/track')return new Response('',{status:404}); calls.push(url.pathname);
    if (url.pathname.endsWith('/v1/snapshot/overall')) return archiveResponse({...overall, trackSummaries: []});
    if (url.pathname.endsWith('/v1/events/catalog')) return archiveResponse({periods: [livePeriod], archives: [archived]});
    const id = url.pathname.split('/').at(-2);
    return archiveResponse({id, period:id===archived.id?archived:id===livePeriod.id?livePeriod:undefined, updatedAt: 180, entries: [], complete:true, totalEntries:0, archived: id === archived.id});
  };
  const now = 1000000000;
  await runPublicSnapshotBackup({fetchImpl, directory, now, trackIds: [], log: () => {}, archiveExport:archiveRepair(archived.id)});
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
    now: now + 365 * 86400000, trackIds: [], log: () => {}});
  assert.equal(calls.some(url => url.includes('/daily_old/')),false);
  await fs.writeFile(path.join(directory, `events/${archived.id}.json`), '{}');
  calls.length = 0;
  await runPublicSnapshotBackup({fetchImpl, directory,
    now: now + 365 * 86400000 + 1, trackIds: [], log: () => {}});
  assert.equal(calls.some(url => url.includes('/daily_old/')),false,'corrupt frozen standings never trigger routine Worker repair');
  await fs.writeFile(path.join(directory, `events/${archived.id}.json`),JSON.stringify({id:archived.id,updatedAt:180,entries:[],archived:true,complete:false}));
  calls.length=0;
  await runPublicSnapshotBackup({fetchImpl,directory,now:now+365*86400000+2,trackIds:[],log:()=>{}});
  assert.equal(calls.some(url=>url.includes('/daily_old/')),false,'partial frozen standings require explicit repair');
  calls.length=0;
  const repaired=await runPublicSnapshotBackup({fetchImpl,directory,now:now+365*86400000+3,trackIds:[],log:()=>{},archiveExport:archiveRepair(archived.id)});
  assert.equal(calls.filter(url=>url==='/v1/events/admin/archive-export/daily_old/snapshot').length,1);
  assert.equal(repaired.archivedEventsUnavailable,0);
});

test('public event projection preserves valid replay bindings across repeated captures', () => {
  const row = {accountId: 'b'.repeat(64), timeMs: 23, runId: 'c'.repeat(64), replayHash: 'd'.repeat(64),
    replay: 'private-payload', ownerUid: 'private-owner'};
  const snapshot = publicEventBackup({id: period.id, period, updatedAt: 180, entries: [row]}, period.id);
  assert.equal(snapshot.entries[0].runId, row.runId);
  assert.equal(snapshot.entries[0].replayHash, row.replayHash);
  assert.equal(snapshot.entries[0].replay, undefined);
  assert.equal(snapshot.entries[0].ownerUid, undefined);
  assert.deepEqual(publicEventBackup(snapshot, period.id), snapshot);
  for (const invalid of ['private', [row.runId], null]) {
    const projected = publicEventBackup({...snapshot, entries: [{...row, runId: invalid, replayHash: invalid}]}, period.id);
    assert.equal(projected.entries[0].runId, undefined);
    assert.equal(projected.entries[0].replayHash, undefined);
  }
});

test('same-time replay replacements cannot reuse or publish a conflicting run binding', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-replay-binding-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const accountId = 'b'.repeat(64);
  const alternate = Buffer.alloc(18); alternate.writeUIntLE(1,0,3); alternate.writeUIntLE(1,3,3);
  const versions = [Buffer.alloc(15), alternate].map(bytes=>deflateSync(bytes).toString('base64url')).map((replay, index) => ({
    replay, replayHash: createHash('sha256').update(replay).digest('hex'), runId: String(index + 1).repeat(64)
  }));
  let boardVersion = 0, replayVersion = 0, replayRequests = 0;
  const fetchImpl = async input => {
    const url = new URL(input);
    if(url.pathname==='/v1/snapshot/track')return new Response('',{status:404});
    if (url.pathname.endsWith('/overall')) return Response.json({...overall, trackSummaries: []});
    if (url.pathname.endsWith('/catalog')) return Response.json({periods: [livePeriod], archives: []});
    if (url.pathname.includes('/replays/')) {
      replayRequests++;
      return Response.json({...versions[replayVersion], periodId: period.id, trackId, accountId, timeMs: 23,
        frames: 23, carStyle: '', verificationStatus: 'verified', verified: true, eventRpEligible: true});
    }
    if (url.pathname.includes('/permanent-rolling-hills/')) return Response.json({updatedAt: 180, entries: []});
    return Response.json({id: period.id, period: livePeriod, updatedAt: 180 + boardVersion,
      entries: [{accountId, timeMs: 23, runId: versions[boardVersion].runId, replayHash: versions[boardVersion].replayHash}]});
  };
  const capture = now => runPublicSnapshotBackup({fetchImpl, directory, now, trackIds: [], log: () => {}});
  const relative = `event-replays/${period.id}/${accountId}.json`;
  await capture(1000);
  boardVersion = 1;
  const mismatched = await capture(1001);
  assert.equal(replayRequests, 2, 'changed run with the same finish time is refetched');
  assert.equal(mismatched.eventReplays[relative], undefined, 'stale endpoint reply is not rebound to the new board');
  await assert.rejects(fs.readFile(path.join(directory, relative)), {code: 'ENOENT'});
  const saved = JSON.parse(await fs.readFile(path.join(directory, `events/${period.id}.json`), 'utf8'));
  assert.equal(saved.entries[0].runId, versions[1].runId);
  replayVersion = 1;
  const recovered = await capture(1002);
  assert.equal(recovered.eventReplays[relative].replayHash, versions[1].replayHash);
  await capture(1003);
  assert.equal(replayRequests, 3, 'matching replacement is reused without further cloud reads');
});

test('missing or corrupt cached track paths are not counted as present after a 404', async t => {
  for (const state of ['missing', 'corrupt']) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-missing-track-'));
    t.after(() => fs.rm(directory, {recursive: true, force: true}));
    const now = 10 * 86400000;
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({schemaVersion: 1, events: {},
      tracks: {[trackId]: {path: `tracks/${trackId}.json`, sourceUpdatedAt: 250, checkedAt: 1}}}));
    if (state === 'corrupt') {
      await fs.mkdir(path.join(directory, 'tracks'));
      await fs.writeFile(path.join(directory, `tracks/${trackId}.json`), '{}');
    }
    let trackRequests = 0;
    const fetchImpl = async input => {
      const url = new URL(input);
      if (url.pathname.endsWith('/overall')) return Response.json({...overall, trackSummaries: []});
      if (url.pathname.endsWith('/catalog')) return Response.json({periods: [], archives: []});
      if (url.pathname.endsWith('/track')) { trackRequests++; return new Response('', {status: 404}); }
      return new Response('', {status: 404});
    };
    const capture = at => runPublicSnapshotBackup({fetchImpl, directory, now: at, trackIds: [trackId], log: () => {}});
    const result = await capture(now);
    assert.equal(result.tracks[trackId].path, null, state);
    assert.equal(result.tracks[trackId].checkedAt, now);
    assert.equal(result.trackBackupsPresent, 0);
    assert.equal(result.trackBackupsMissing, 1);
    await capture(now + 86400000);
    assert.equal(trackRequests, 1, 'known missing track observes the existing seven-day cooldown');
    await capture(now + 7 * 86400000);
    assert.equal(trackRequests, 2);
    await capture(now + 8 * 86400000);
    assert.equal(trackRequests, 2, 'each unsuccessful recheck renews the missing-track cooldown');
  }
});

test('a 404 preserves a valid stale track without advancing its capture timestamp', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-stale-track-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  await fs.mkdir(path.join(directory, 'tracks'));
  const board = {trackId, updatedAt: 250, entries: []};
  await fs.writeFile(path.join(directory, `tracks/${trackId}.json`), JSON.stringify(board));
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({schemaVersion: 1, events: {},
    tracks: {[trackId]: {path: `tracks/${trackId}.json`, sourceUpdatedAt: 250, checkedAt: 1000}}}));
  const result = await runPublicSnapshotBackup({directory, now: 2000, trackIds: [trackId], log: () => {}, fetchImpl: async input => {
    if (input.endsWith('/overall')) return Response.json({...overall, trackSummaries: [{trackId, updatedAt: 251}]});
    if (input.endsWith('/catalog')) return Response.json({periods: [], archives: []});
    return new Response('', {status: 404});
  }});
  assert.equal(result.trackBackupsPresent, 1);
  assert.equal(result.tracks[trackId].checkedAt, 1000);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, `tracks/${trackId}.json`), 'utf8')), board);
});

test('public capture workflows remain serialized and avoid full profile scans', async () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const name of ['sync-event-catalog.yml', 'sync-kodub-weekly.yml']) {
    const workflow = await fs.readFile(path.join(repo, '.github/workflows', name), 'utf8');
    assert.match(workflow, /group: public-repository-captures-\$\{\{ github\.repository \}\}/);
    assert.match(workflow, /cancel-in-progress: false/);
    assert.match(workflow, /github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/);
    assert.match(workflow, /node tools\/push-public-capture\.mjs/);
    assert.doesNotMatch(workflow, /--full-public|--force/);
    if (name === 'sync-event-catalog.yml') assert.match(workflow, /node tools\/update-public-snapshot\.mjs --refresh-replays/);
  }
});

test('capture saves every paginated racer beyond preview limits and preserves files on a mixed generation',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'polytrack-paged-capture-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const generation='f'.repeat(64),sourceRevision=7;
 const rows=count=>Array.from({length:count},(_,i)=>({accountId:(i+1).toString(16).padStart(64,'0'),userId:(i+1).toString(16).padStart(64,'0'),name:'Racer',rank:i+1,timeMs:1000+i,ownerUid:'private'}));
 const boards={overall:rows(531),track:rows(650)};
 const metadata=kind=>({version:1,generation,pageSize:100,pageCount:Math.ceil(boards[kind].length/100),totalEntries:boards[kind].length,complete:true});
 let corrupt=false,pageRequests=0;
 const fetchImpl=async input=>{
  const url=new URL(input),kind=url.pathname.includes('/overall')?'overall':'track';
  if(url.pathname.endsWith('/page')){
   pageRequests++;const page=Number(url.searchParams.get('page'));
   assert.equal(url.searchParams.get('generation'),generation);
   return Response.json({...metadata(kind),generation:corrupt?'e'.repeat(64):generation,sourceRevision,page,entries:boards[kind].slice(page*100,(page+1)*100)});
  }
  if(url.pathname.endsWith('/overall'))return Response.json({updatedAt:300,sourceRevision,complete:false,totalEntries:531,entries:boards.overall.slice(0,200),pagination:metadata('overall'),trackSummaries:[{trackId,updatedAt:250,fieldSize:650}]});
  if(url.pathname.endsWith('/track'))return Response.json({trackId,updatedAt:250,sourceRevision,complete:false,totalEntries:650,entries:boards.track.slice(0,500),pagination:metadata('track')});
  if(url.pathname.endsWith('/catalog'))return Response.json({periods:[],archives:[]});
  return new Response('',{status:404});
 };
 await runPublicSnapshotBackup({directory,trackIds:[trackId],fetchImpl,log:()=>{}});
 const savedOverall=await fs.readFile(path.join(directory,'overall.json'),'utf8');
 const savedTrack=JSON.parse(await fs.readFile(path.join(directory,'tracks',trackId+'.json')));
 assert.equal(pageRequests,13);assert.equal(JSON.parse(savedOverall).entries.length,531);assert.equal(savedTrack.entries.length,650);
 assert.equal(savedTrack.complete,true);assert.equal(savedTrack.entries.at(-1).ownerUid,undefined);
 corrupt=true;
 await assert.rejects(runPublicSnapshotBackup({directory,trackIds:[trackId],fetchImpl,log:()=>{}}),/Invalid or incomplete/);
 assert.equal(await fs.readFile(path.join(directory,'overall.json'),'utf8'),savedOverall);
});


test('event tracks absent from fixed registries and Overall are captured as normal boards', async t => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'polytrack-weekly-discovery-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const weeklyId='b'.repeat(64),oldId='c'.repeat(64),calls=[];
  const weekly={...period,id:'kodub_current',trackId:weeklyId,kind:'kodub'};
  const old={...weekly,id:'kodub_old',trackId:oldId};
  const result=await runPublicSnapshotBackup({directory,trackIds:[],log:()=>{},fetchImpl:async input=>{
    const url=new URL(input);calls.push(url.href);
    if(url.pathname.endsWith('/overall'))return Response.json({...overall,trackSummaries:[]});
    if(url.pathname.endsWith('/catalog'))return Response.json({periods:[weekly],archives:[old]});
    if(url.pathname==='/v1/snapshot/track')return Response.json({trackId:url.searchParams.get('trackId'),complete:true,totalEntries:1,updatedAt:300,entries:[{accountId:'racer',name:'Racer',timeMs:1234,rank:1}]});
    return Response.json({id:url.pathname.split('/').at(-2),updatedAt:300,entries:[]});
  }});
  assert.equal(result.deferred,undefined);
  for(const id of [weeklyId,oldId]){
    assert.ok(result.tracks[id]?.path);
    const board=JSON.parse(await fs.readFile(path.join(directory,'tracks',id+'.json'),'utf8'));
    assert.equal(board.trackId,id);assert.equal(board.entries.length,1);
    assert.equal(calls.filter(value=>value.includes('/v1/snapshot/track?trackId='+id)).length,1);
  }
});


test('compact track catalog discovers low-participation boards and avoids unchanged reads',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'polytrack-catalog-coverage-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const id='d'.repeat(64);let trackReads=0;
 const capture=()=>runPublicSnapshotBackup({directory,trackIds:[],log:()=>{},fetchImpl:async input=>{
  const url=new URL(input);
  if(url.pathname.endsWith('/overall'))return Response.json({...overall,trackSummaries:[],trackCatalog:[{trackId:id,updatedAt:300,ownerUid:'private'}]});
  if(url.pathname.endsWith('/catalog'))return Response.json({periods:[],archives:[]});
  if(url.pathname==='/v1/snapshot/track'){trackReads++;return Response.json({trackId:id,updatedAt:300,entries:[],complete:true,totalEntries:0});}
  return Response.json({updatedAt:300,entries:[]});
 }});
 await capture();await capture();assert.equal(trackReads,1);
 const saved=JSON.parse(await fs.readFile(path.join(directory,'overall.json'),'utf8'));
 assert.deepEqual(saved.trackCatalog,[{trackId:id,updatedAt:300}]);
 for(const trackCatalog of [[{trackId:'bad',updatedAt:300}],[{trackId:id,updatedAt:-1}],[{trackId:id,updatedAt:300},{trackId:id,updatedAt:300}],{}])assert.throws(()=>publicOverallBackup({...overall,trackCatalog}),/track catalog/);
});

import './event-verification-dates.test.mjs';

import './public-event-export-regression.test.mjs';

for (const mode of ['archive', 'fresh', 'unavailable']) {
  test(mode + ' event boards avoid redundant local reads without losing fallback', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-board-read-reuse-'));
    t.after(() => fs.rm(directory, {recursive:true, force:true}));
    const id = 'daily_read_reuse', trackId = 'a'.repeat(64);
    const archived = mode === 'archive';
    const period = {id, trackId, startsAt:100, endsAt:archived ? 200 : 100000, kind:'daily', maxRp:100};
    const board = {id, period, updatedAt:300, archived, complete:true, totalEntries:0, entries:[]};
    const file = path.join(directory, 'events', id + '.json');
    await fs.mkdir(path.dirname(file), {recursive:true});
    await fs.writeFile(file, JSON.stringify(board) + '\n');
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({schemaVersion:1, tracks:{},
      events:{[id]:{path:'events/' + id + '.json', updatedAt:300, checkedAt:500}}}));
    const original = fs.readFile;
    let reads = 0, boardRequests = 0;
    fs.readFile = async function(input, ...args) {
      if (path.resolve(String(input)) === file) reads++;
      return original.call(this, input, ...args);
    };
    t.after(() => { fs.readFile = original; });
    const result = await runPublicSnapshotBackup({directory, trackIds:[], trackFetchLimit:0, now:1000,
      capturedOverall:{updatedAt:300, entries:[], trackSummaries:[]}, log:()=>{},
      fetchImpl:async input => {
        const pathname = new URL(input).pathname;
        if (pathname.endsWith('/catalog')) return Response.json({periods:archived ? [] : [period], archives:archived ? [period] : []});
        if (pathname === '/v1/events/' + id + '/snapshot') {
          boardRequests++;
          assert.equal(archived, false, 'immutable archives must never be fetched');
          return mode === 'unavailable' ? new Response('', {status:404}) : Response.json({...board, updatedAt:400});
        }
        assert.equal(pathname, '/v1/events/permanent-rolling-hills/snapshot');
        return new Response('', {status:404});
      }});
    // Includes the final write-if-changed comparison, which must still read disk.
    assert.equal(reads, mode === 'fresh' ? 1 : 2);
    assert.equal(boardRequests, archived ? 0 : 1);
    assert.equal(result.events[id].updatedAt, mode === 'fresh' ? 400 : 300);
    assert.equal(result.events[id].checkedAt, mode === 'fresh' ? 1000 : 500);
    fs.readFile = original;
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(saved.updatedAt, mode === 'fresh' ? 400 : 300);
    assert.deepEqual(saved.entries, []);
  });
}
