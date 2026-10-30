import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {Socket} from 'node:net';
import {applyNativeLedgerToCapturedTracks,readCapturedNormalLedgerRows,runPublicSnapshotBackup,publicTrackBackup,publicTrackConfirmationDigest} from './public-snapshot-backup.mjs';
import {createLedgerEntry,writeLedger,ledgerBinding,ledgerKey} from './native-verification-ledger.mjs';
import {exportPublicProfilesAndReplays} from './public-profile-replay-export.mjs';
import {preparePublicRecordingPlayback} from './public-replay-playback.mjs';
import {computeOverall,rankTrustedTrackEntries} from '../workers/ranked/src/index.js';
import {decodeProjectionResults} from './overall-projection-bundle.mjs';

globalThis.fetch=()=>{throw Error('No network in ledger capture tests');};
Socket.prototype.connect=globalThis.fetch;
const sha=value=>createHash('sha256').update(value).digest('hex');
const trackId='5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038';
const engine='b'.repeat(64),fingerprint='c'.repeat(64),content='d'.repeat(64);
const geometry={parts:20,spanX:100,spanZ:120};
const policy={engineDigest:engine,compatibleEngines:[],verifierVersion:'test-native-v1',verifierFingerprint:fingerprint,
  resourceProfiles:['standard'],reviewPolicyVersions:['snapshot-controls-v1'],trackContentHashes:{[trackId]:content},
  trackGeometries:{[trackId]:{geometryPolicy:'default',trackGeometry:geometry}}};
const model={algorithmVersion:'participation-v8-s1',schemaVersion:6,revision:10,sourceRevision:10,builtRevision:10,updatedAt:1000};
const replay=deflateSync(Buffer.alloc(15)).toString('base64url'),replayHash=sha(replay),verifiedAt=Date.now()-60000;
const read=(dir,name)=>fs.readFile(path.join(dir,name),'utf8').then(JSON.parse);
async function write(dir,name,value){await fs.mkdir(path.dirname(path.join(dir,name)),{recursive:true});await fs.writeFile(path.join(dir,name),JSON.stringify(value)+'\n');}
function approval(job,disposition='approved'){
  const binding={resultId:job.resultId,trackId,timeMs:job.timeMs,replayHash,actualReplayHash:replayHash,
    nativeTrackId:trackId,trackContentHash:content,engineDigest:engine,verifierVersion:policy.verifierVersion,
    verifierFingerprint:fingerprint,resourceProfile:'standard'};
  const nativeResult={resultId:job.resultId,trackId,timeMs:job.timeMs,replayHash,status:'verified',reason:'native_exact_finish',
    deterministic:true,engineDigest:engine,trackContentHash:content,trackGeometry:geometry,geometryPolicy:'default',binding,
    boundInputFingerprint:sha(JSON.stringify(binding))};
  return createLedgerEntry({job,nativeResult,result:disposition==='approved'?nativeResult:{...nativeResult,status:'unavailable',reason:'review_hold'},
    policy,verifiedAt,review:{complete:true,disposition,bindingKey:ledgerKey(ledgerBinding(job)),
      policyVersion:'snapshot-controls-v1',attestationHash:sha('review-'+job.accountId+disposition)}});
}
async function fixture(t,{approved=[0],disposition='approved',count=3}={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ledger-capture-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const sources=Array.from({length:count},(_,i)=>({lane:'normal',accountId:sha('account-'+i),trackId,
    uploadId:100+i,timeMs:1000+i,frames:1000+i,raceTimeFrames:1000+i,replayHash,
    integrityVerified:true,verified:false,runVerified:false,verifiedState:0,verificationStatus:'pending',
    pbAt:100,createdAt:100,updatedAt:200,name:'Racer '+i,pbCount:2,totalPlaytimeMs:500,accountCreatedAt:10}));
  const jobs=sources.map(row=>({...row,replay,resultId:row.accountId+'_'+trackId}));
  const board=publicTrackBackup({...model,trackId,complete:true,sourceComplete:true,totalEntries:count,
    entries:rankTrustedTrackEntries(sources,trackId)},trackId);
  await write(directory,'tracks/'+trackId+'.json',board);
  for(const row of sources){
    await write(directory,`canonical/${trackId}/${row.accountId}.json`,row);
    await write(directory,`recordings/${row.uploadId}.json`,{accountId:row.accountId,trackId,uploadId:row.uploadId,
      recording:replay,frames:row.frames,replayHash,verifiedState:0,verificationStatus:'pending',playbackPending:true,updatedAt:200});
  }
  const entries=computeOverall([{...board,entries:board.entries.map(row=>({...row,verified:true,verifiedState:1,runVerified:true,verificationStatus:'verified'}))}]);
  await write(directory,'overall.json',{...model,entries,complete:true,totalEntries:entries.length,
    trackSummaries:[],trackCatalog:[{trackId,updatedAt:1000}]});
  const manifest={schemaVersion:1,trackIdsKnown:1,tracks:{[trackId]:{path:`tracks/${trackId}.json`,updatedAt:1000,sourceUpdatedAt:1000,revision:10}},
    overall:{path:'overall.json'},events:{sentinel:{path:'events/sentinel.json'}},eventReplays:{
      [`event-replays/sentinel/${sources[0].accountId}.json`]:{path:`event-replays/sentinel/${sources[0].accountId}.json`,periodId:'sentinel',accountId:sources[0].accountId}}};
  await write(directory,'manifest.json',manifest);
  await fs.mkdir(path.join(directory,'verification-ledger'),{recursive:true});
  const ledger=writeLedger({root:path.join(directory,'verification-ledger'),entries:approved.map(i=>approval(jobs[i],disposition)),expectedManifestHash:null});
  const options={directory,ledger,policy,canonicalRows:sources,rebuildDerived:false,now:2000};
  return {directory,sources,jobs,board,ledger,options,manifest};
}

test('exact ledger approval updates board, recording and derived canonical as distinct native authority',async t=>{
  const f=await fixture(t),before=structuredClone(f.sources),report=await applyNativeLedgerToCapturedTracks(f.options);
  assert.equal(report.verified,1);const row=(await read(f.directory,`tracks/${trackId}.json`)).entries[0];
  const recording=await read(f.directory,'recordings/100.json');
  const canonical=await read(f.directory,`canonical/${trackId}/${row.accountId}.json`);
  assert.equal(row.runVerified,true);assert.equal(row.verifiedState,1);
  assert.equal(recording.verifiedState,1);assert.equal(recording.playbackPending,false);
  assert.equal(canonical.runVerified,true);assert.equal(canonical.verified,true);assert.equal(canonical.verifiedState,1);
  assert.equal(canonical.nativeLedger.authority,'native-verification-ledger');
  assert.equal(canonical.nativeLedgerSource.status.verified,false);assert.equal(canonical.nativeLedgerSource.status.verifiedState,0);
  assert.equal(canonical.pbAt,100);assert.equal(canonical.createdAt,100);assert.equal(canonical.updatedAt,200);
  assert.equal(canonical.verifiedAt,verifiedAt);assert.deepEqual(f.sources,before);
  assert.equal((await preparePublicRecordingPlayback(recording,row)).verifiedState,1);
  const manifest=await read(f.directory,'manifest.json');assert.equal(manifest.nativeVerificationLedger.manifestHash,f.ledger.manifestHash);
  assert.equal(manifest.nativeVerificationLedger.sourceRepositoryPath,'verification-ledger/manifest.json');
  assert.equal(manifest.nativeVerificationLedger.path,undefined,'repository authority is not a logical packed-file claim');
  assert.deepEqual(manifest.events,{sentinel:{path:'events/sentinel.json'}});
  assert.deepEqual(manifest.eventReplays,f.manifest.eventReplays);
});

test('pending and ledger-promoted caches both satisfy future export without any DB read',async t=>{
  const f=await fixture(t);await applyNativeLedgerToCapturedTracks(f.options);
  let calls=0;
  for(let pass=0;pass<2;pass++){
    const report=await exportPublicProfilesAndReplays({directory:f.directory,includeProfiles:false,includePendingReplays:true,
      fetchImpl:()=>{calls++;throw Error('Exact saved bindings must avoid all DB calls');}});
    assert.equal(report.fetchedDocumentsThisRun,0);assert.equal(report.totalCoverage.available,3);
    assert.equal(report.totalCoverage.invalid,0);assert.equal(report.knownVerifiedBindings,3);
  }
  assert.equal(calls,0);
});

test('reapplying promoted derived cache does not reset original source-status companions or PB dates',async t=>{
  const f=await fixture(t);await applyNativeLedgerToCapturedTracks(f.options);
  const beforeCanonical=await read(f.directory,`canonical/${trackId}/${f.sources[0].accountId}.json`);
  const beforeRecording=await read(f.directory,'recordings/100.json');
  const sources=await Promise.all(f.sources.map(row=>read(f.directory,`canonical/${trackId}/${row.accountId}.json`)));
  await applyNativeLedgerToCapturedTracks({...f.options,canonicalRows:sources});
  const after=await read(f.directory,`canonical/${trackId}/${f.sources[0].accountId}.json`);
  assert.deepEqual(after.nativeLedgerSource,beforeCanonical.nativeLedgerSource);
  assert.deepEqual((await read(f.directory,'recordings/100.json')).nativeLedgerSource,beforeRecording.nativeLedgerSource);
  assert.equal(after.pbAt,beforeCanonical.pbAt);assert.equal(after.verifiedAt,verifiedAt);
});

test('fresh explicit current holds revoke a cached approval across board and both public payloads',async t=>{
  const f=await fixture(t);await applyNativeLedgerToCapturedTracks(f.options);
  const sources=f.sources.map((row,i)=>i?row:{...row,reviewHold:true});
  const report=await applyNativeLedgerToCapturedTracks({...f.options,canonicalRows:sources});
  assert.equal(report.verified,0);assert.equal(report.held,1);
  const board=await read(f.directory,`tracks/${trackId}.json`),recording=await read(f.directory,'recordings/100.json');
  const canonical=await read(f.directory,`canonical/${trackId}/${f.sources[0].accountId}.json`);
  assert.equal(board.entries[0].runVerified,false);assert.equal(recording.verifiedState,0);assert.equal(canonical.verifiedState,0);
  await assert.rejects(preparePublicRecordingPlayback(recording,board.entries[0],{allowPending:true}),/not eligible/);
  const exported=await exportPublicProfilesAndReplays({directory:f.directory,includeProfiles:false,includePendingReplays:true,
    fetchImpl:()=>{throw Error('Held bindings must not trigger DB retry');}});
  assert.equal(exported.fetchedDocumentsThisRun,0);assert.equal(exported.totalCoverage.available,2);
});

test('exact held ledger witnesses block cached approvals, and cached recording holds cannot be masked by source flags',async t=>{
  for(const ledgerHeld of [true,false]){
    const f=await fixture(t,{disposition:ledgerHeld?'held':'approved'});
    if(!ledgerHeld){const recording=await read(f.directory,'recordings/100.json');recording.reviewHold=true;await write(f.directory,'recordings/100.json',recording);}
    await applyNativeLedgerToCapturedTracks(f.options);
    assert.equal((await read(f.directory,`tracks/${trackId}.json`)).entries[0].runVerified,false);
    assert.equal((await read(f.directory,'recordings/100.json')).verifiedState,0);
  }
});

test('wrong source or recording bindings never promote and recording bytes are never copied by time alone',async t=>{
  for(const change of ['source-hash','source-upload','payload-hash','payload-account','payload-frames','payload-bytes']){
    const f=await fixture(t),options={...f.options,canonicalRows:structuredClone(f.sources)};
    if(change==='source-hash')options.canonicalRows[0].replayHash='f'.repeat(64);
    else if(change==='source-upload')options.canonicalRows[0].uploadId++;
    else{const recording=await read(f.directory,'recordings/100.json');
      if(change==='payload-hash')recording.replayHash='f'.repeat(64);
      if(change==='payload-account')recording.accountId='f'.repeat(64);
      if(change==='payload-frames')recording.frames++;
      if(change==='payload-bytes')recording.recording+='changed';
      await write(f.directory,'recordings/100.json',recording);}
    const before=await fs.readFile(path.join(f.directory,'recordings/100.json'),'utf8');
    await applyNativeLedgerToCapturedTracks(options);
    assert.equal((await read(f.directory,`tracks/${trackId}.json`)).entries[0].runVerified,false,change);
    assert.equal(await fs.readFile(path.join(f.directory,'recordings/100.json'),'utf8'),before,change);
  }
});

test('final normal apply rebuilds whole-board ranks, verified-only Overall, profiles and track statistics from one candidate',async t=>{
  const f=await fixture(t,{approved:[1,2]});
  await applyNativeLedgerToCapturedTracks({...f.options,rebuildDerived:true});
  const board=await read(f.directory,`tracks/${trackId}.json`),overall=await read(f.directory,'overall.json');
  assert.deepEqual(board.entries.map(row=>row.rank),[1,2,3]);
  assert.equal(board.entries[0].runVerified,false);
  assert.equal(overall.entries.length,2);
  const results=await decodeProjectionResults(await read(f.directory,'overall-results.json'));
  assert.deepEqual(results.entries.flatMap(row=>JSON.parse(row.resultData).map(tuple=>[tuple[1],tuple[2]])).sort((a,b)=>a[0]-b[0]),[[1,2],[2,2]]);
  const profile=await read(f.directory,`profile-results/${f.sources[1].accountId}.json`);
  assert.equal(profile.results[0].runVerified,true);assert.equal(profile.results[0].pbAt,100);assert.equal(profile.results[0].rank,2);
  const stats=await read(f.directory,'track-statistics.json');assert.equal(stats.tracks[trackId].count,3);assert.equal(stats.tracks[trackId].players,3);
});

test('unbranded or unpinned ledger fails before any candidate mutation',async t=>{
  const f=await fixture(t),before=await fs.readFile(path.join(f.directory,`tracks/${trackId}.json`),'utf8');
  await assert.rejects(applyNativeLedgerToCapturedTracks({...f.options,ledger:structuredClone(f.ledger)}),/branded|pinned readLedger/);
  await assert.rejects(applyNativeLedgerToCapturedTracks({...f.options,ledger:{...f.ledger,manifestHash:'f'.repeat(64)}}),/manifest hash/);
  assert.equal(await fs.readFile(path.join(f.directory,`tracks/${trackId}.json`),'utf8'),before);
});

test('future capture cannot silently discard retained ledger authority when explicit validated policy is absent',async t=>{
  const f=await fixture(t);await applyNativeLedgerToCapturedTracks(f.options);let calls=0;
  const manifest=await fs.readFile(path.join(f.directory,'manifest.json'),'utf8');
  await assert.rejects(runPublicSnapshotBackup({directory:f.directory,fetchImpl:()=>{calls++;throw Error('No request allowed');},log(){}}),/Explicit native ledger policy/);
  assert.equal(calls,0);assert.equal(await fs.readFile(path.join(f.directory,'manifest.json'),'utf8'),manifest);
});

async function acceptedBaseline(f,index){
  const flags={verified:true,runVerified:true,verifiedState:1,verificationStatus:'verified',
    playbackPending:false,verifiedAt:verifiedAt-10000};
  Object.assign(f.sources[index],flags);Object.assign(f.board.entries[index],flags);
  await write(f.directory,`tracks/${trackId}.json`,f.board);
  const canonicalPath=`canonical/${trackId}/${f.sources[index].accountId}.json`,recordingPath=`recordings/${f.sources[index].uploadId}.json`;
  await write(f.directory,canonicalPath,{...await read(f.directory,canonicalPath),...flags});
  await write(f.directory,recordingPath,{...await read(f.directory,recordingPath),...flags});
  return {canonicalPath,recordingPath,canonical:await fs.readFile(path.join(f.directory,canonicalPath),'utf8'),
    recording:await fs.readFile(path.join(f.directory,recordingPath),'utf8')};
}

test('mixed board preserves trusted baseline approval and ordinary pending while applying only exact native decisions and holds',async t=>{
  const f=await fixture(t,{approved:[1],count:4}),baseline=await acceptedBaseline(f,0);
  await acceptedBaseline(f,3);f.sources[3].reviewHold=true;
  const accepted=structuredClone(f.board.entries[0]),pending=structuredClone(f.board.entries[2]);
  const pendingCanonical=await fs.readFile(path.join(f.directory,`canonical/${trackId}/${f.sources[2].accountId}.json`),'utf8');
  const pendingRecording=await fs.readFile(path.join(f.directory,'recordings/102.json'),'utf8');
  const report=await applyNativeLedgerToCapturedTracks(f.options),board=await read(f.directory,`tracks/${trackId}.json`);
  assert.equal(report.verified,1);assert.equal(report.held,1);
  assert.deepEqual(board.entries[0],accepted);assert.deepEqual(board.entries[2],pending);
  assert.equal(board.entries[1].runVerified,true);assert.equal(board.entries[3].runVerified,false);
  assert.equal(await fs.readFile(path.join(f.directory,baseline.canonicalPath),'utf8'),baseline.canonical);
  assert.equal(await fs.readFile(path.join(f.directory,baseline.recordingPath),'utf8'),baseline.recording);
  assert.equal(await fs.readFile(path.join(f.directory,`canonical/${trackId}/${f.sources[2].accountId}.json`),'utf8'),pendingCanonical);
  assert.equal(await fs.readFile(path.join(f.directory,'recordings/102.json'),'utf8'),pendingRecording);
  for(const row of [board.entries[0],board.entries[2]])assert.equal(row.nativeLedgerKey,undefined);
  for(const relative of [`canonical/${trackId}/${f.sources[3].accountId}.json`,'recordings/103.json']){
    const held=await read(f.directory,relative);assert.equal(held.verifiedState,0);
    assert.equal(held.nativeLedger,undefined,'a current-source hold is not an invented ledger decision');
  }
});

test('empty ledger is a status no-op for every exact trusted baseline approval, payload and PB date',async t=>{
  const f=await fixture(t,{approved:[]}),saved=[];
  for(let i=0;i<f.sources.length;i++)saved.push(await acceptedBaseline(f,i));
  const rows=structuredClone(f.board.entries),sources=structuredClone(f.sources);
  const report=await applyNativeLedgerToCapturedTracks(f.options);
  assert.equal(report.verified,0);assert.equal(report.canonical,0);assert.equal(report.recordings,0);
  assert.deepEqual((await read(f.directory,`tracks/${trackId}.json`)).entries,rows);
  for(const value of saved){
    assert.equal(await fs.readFile(path.join(f.directory,value.canonicalPath),'utf8'),value.canonical);
    assert.equal(await fs.readFile(path.join(f.directory,value.recordingPath),'utf8'),value.recording);
  }
  assert.deepEqual(f.sources,sources);
});

test('incompatible prior overlay restores the fresh accepted or pending baseline without manufacturing new native provenance',async t=>{
  for(const accepted of [false,true]){
    const f=await fixture(t);await applyNativeLedgerToCapturedTracks(f.options);
    if(accepted)Object.assign(f.sources[0],{runVerified:true,verified:true,verifiedState:1,verificationStatus:'verified',verifiedAt:verifiedAt-10000});
    const policyChanged={...policy,verifierFingerprint:'e'.repeat(64)};
    await applyNativeLedgerToCapturedTracks({...f.options,policy:policyChanged});
    const row=(await read(f.directory,`tracks/${trackId}.json`)).entries[0];
    assert.equal(row.runVerified,accepted);assert.equal(row.verifiedState,accepted?1:0);
    assert.equal(row.nativeLedgerKey,undefined);assert.equal(row.nativeLedgerManifestHash,undefined);
    for(const relative of [`canonical/${trackId}/${f.sources[0].accountId}.json`,'recordings/100.json']){
      const payload=await read(f.directory,relative);assert.equal(payload.verifiedState,accepted?1:0);
      assert.equal(payload.nativeLedger,undefined);assert.equal(payload.nativeLedgerSource.status.verifiedState,0);
    }
  }
});

test('fresh mocked capture preserves trusted root pointer, ledger files and source preimages, then honors a new current hold',async t=>{
  const f=await fixture(t);await applyNativeLedgerToCapturedTracks(f.options);
  const ledgerRoot=await fs.mkdtemp(path.join(os.tmpdir(),'external-native-ledger-'));
  t.after(()=>fs.rm(ledgerRoot,{recursive:true,force:true}));
  const external=writeLedger({root:ledgerRoot,entries:f.ledger.entries,expectedManifestHash:null});
  await fs.writeFile(path.join(f.directory,'verification-ledger/manifest.json'),'not-an-authority');
  const pointer={manifestHash:f.ledger.manifestHash};
  await write(f.directory,'verification-ledger-current.json',pointer);
  const baseline=(await read(f.directory,`canonical/${trackId}/${f.sources[0].accountId}.json`)).nativeLedgerSource;
  const ledgerBytes=await fs.readFile(path.join(ledgerRoot,'manifest.json'),'utf8');
  const overall=await read(f.directory,'overall.json');overall.trackSummaries=[{trackId,updatedAt:1000,fieldSize:3}];
  const period={id:'daily_fixture',kind:'daily',trackId,startsAt:1,endsAt:Date.UTC(2100,0,1),maxRp:100};
  let requests=0;
  const fetchImpl=async input=>{requests++;const url=new URL(input);
    if(url.pathname.endsWith('/overall'))return Response.json(overall);
    if(url.pathname.endsWith('/catalog'))return Response.json({periods:[period],archives:[]});
    if(url.pathname==='/v1/snapshot/track')return Response.json(f.board);
    if(url.pathname.includes('/daily_fixture/'))return Response.json({period,updatedAt:1000,entries:[],complete:true,totalEntries:0});
    if(url.pathname.includes('/permanent-rolling-hills/'))return Response.json({id:'permanent-rolling-hills',updatedAt:1000,entries:[]});
    return new Response('',{status:404});};
  for(const held of [false,true]){
    const canonicalRows=f.sources.map((row,i)=>held&&!i?{...row,reviewHold:true}:row);
    const manifest=await runPublicSnapshotBackup({directory:f.directory,trackIds:[trackId],fetchImpl,now:2000,log(){},
      nativeVerification:{ledger:external,ledgerRoot,policy,canonicalRows}});
    assert.equal(manifest.nativeVerificationLedger.manifestHash,f.ledger.manifestHash);
    assert.equal(manifest.nativeVerificationLedger.sourceRepositoryPath,'verification-ledger/manifest.json');
    assert.equal(JSON.stringify(manifest).includes(ledgerRoot),false,'private external filesystem path must not leak');
    const canonical=await read(f.directory,`canonical/${trackId}/${f.sources[0].accountId}.json`);
    assert.equal(canonical.verifiedState,held?0:1);assert.deepEqual(canonical.nativeLedgerSource,baseline);
    assert.equal((await read(f.directory,'recordings/100.json')).verifiedState,held?0:1);
    assert.equal(await fs.readFile(path.join(f.directory,'verification-ledger/manifest.json'),'utf8'),'not-an-authority');
    assert.deepEqual(await read(f.directory,'verification-ledger-current.json'),pointer);
  }
  assert.ok(requests<=12,'fresh source transport remains bounded and fully mocked');
  assert.equal(await fs.readFile(path.join(ledgerRoot,'manifest.json'),'utf8'),ledgerBytes);
  assert.equal(await fs.readFile(path.join(f.directory,'verification-ledger/manifest.json'),'utf8'),'not-an-authority',
    'external ledger files are not copied into packed staging');
  await assert.rejects(applyNativeLedgerToCapturedTracks({...f.options,ledgerRoot:'relative-ledger'}),/Invalid native ledger capture options/);
  await assert.rejects(applyNativeLedgerToCapturedTracks({...f.options,ledgerRoot:path.join(f.directory,'missing-ledger')}),/ENOENT/);
});

test('two unchanged authenticated confirmations reuse overlays with zero track fetches; bytes, replay, source and hold changes invalidate',async t=>{
  const f=await fixture(t);await applyNativeLedgerToCapturedTracks(f.options);
  const overall=await read(f.directory,'overall.json'),period={id:'daily_cache',kind:'daily',trackId,startsAt:1,endsAt:Date.UTC(2100,0,1),maxRp:100};
  let fetches=0,now=Date.UTC(2026,9,30);
  const fetchImpl=async input=>{const url=new URL(input);
    if(url.pathname.endsWith('/overall'))return Response.json(overall);
    if(url.pathname.endsWith('/catalog'))return Response.json({periods:[period],archives:[]});
    if(url.pathname==='/v1/snapshot/track'){fetches++;return Response.json(f.board);}
    if(url.pathname.includes('/daily_cache/'))return Response.json({period,updatedAt:1000,entries:[],complete:true,totalEntries:0});
    if(url.pathname.includes('/permanent-rolling-hills/'))return Response.json({id:'permanent-rolling-hills',updatedAt:1000,entries:[]});
    return new Response('',{status:404});};
  const capture=(withSources=false)=>runPublicSnapshotBackup({directory:f.directory,trackIds:[trackId],fetchImpl,now:now+=1000,log(){},
    confirmedTracks:new Map([[trackId,{updatedAt:1000,checkedAt:now,sha256:publicTrackConfirmationDigest(f.board,trackId)}]]),
    ...(withSources?{capturedTracks:new Map([[trackId,f.board]])}:{}),
    nativeVerification:{ledger:f.ledger,policy,canonicalRows:f.sources}});
  const before=(await read(f.directory,'manifest.json')).tracks[trackId].nativeLedgerOverlay;
  assert.equal(before.sourceConfirmationDigest,publicTrackConfirmationDigest(f.board,trackId));
  await capture();await capture();assert.equal(fetches,0);
  await capture(true);await capture(true);assert.equal(fetches,0,'unchanged full authenticated source boards also reuse their overlay');
  assert.equal((await read(f.directory,'manifest.json')).tracks[trackId].nativeLedgerOverlay.sourceConfirmationDigest,before.sourceConfirmationDigest);
  for(const field of ['runVerified','replayHash']){
    const cached=await read(f.directory,`tracks/${trackId}.json`);
    cached.entries[0][field]=field==='runVerified'?false:'f'.repeat(64);
    await write(f.directory,`tracks/${trackId}.json`,cached);
    const prior=fetches;await capture();assert.equal(fetches,prior+1,field+' mutation cannot reuse stale confirmation');
  }
  f.board.entries[0].name='Captured source changed';
  let prior=fetches;await capture(true);assert.equal(fetches,prior,'an already captured fresh source repairs locally without a Worker read');
  assert.equal((await read(f.directory,`tracks/${trackId}.json`)).entries[0].name,'Captured source changed');
  f.board.entries[0].name='Fresh source identity';
  prior=fetches;await capture();assert.equal(fetches,prior+1,'changed pristine source digest must repair the baseline');
  assert.equal((await read(f.directory,`tracks/${trackId}.json`)).entries[0].name,'Fresh source identity');
  f.sources[0].reviewHold=true;
  prior=fetches;await capture();assert.equal(fetches,prior+1,'new current hold invalidates confirmation reuse');
  assert.equal((await read(f.directory,`tracks/${trackId}.json`)).entries[0].runVerified,false);
  assert.equal((await read(f.directory,'recordings/100.json')).verifiedState,0);
});

test('normal source adapter separates accepted public board flags from raw canonical client flags',async t=>{
  const f=await fixture(t,{approved:[]});
  Object.assign(f.board.entries[0],{runVerified:true,integrityVerified:true});
  for(const field of ['verified','verifiedState','verificationStatus'])delete f.board.entries[0][field];
  await write(f.directory,`tracks/${trackId}.json`,f.board);
  const before=await fs.readFile(path.join(f.directory,`canonical/${trackId}/${f.sources[0].accountId}.json`),'utf8');
  const rows=await readCapturedNormalLedgerRows({directory:f.directory});
  assert.equal(rows.length,3);assert.equal(rows[0].runVerified,true);assert.equal(rows[0].verifiedState,1);
  assert.equal(rows[0].sourceCanonicalStatus.verified,false);assert.equal(rows[0].sourceCanonicalStatus.verifiedState,0);
  assert.equal(rows[0].sourceBoardStatus.runVerified,true);
  assert.equal(await fs.readFile(path.join(f.directory,`canonical/${trackId}/${f.sources[0].accountId}.json`),'utf8'),before);
});

test('adapter preserves independent pristine canonical and board baselines across native apply and incompatible reuse',async t=>{
  const f=await fixture(t);Object.assign(f.board.entries[0],{runVerified:true,verified:true,verifiedState:1,verificationStatus:'verified'});
  await write(f.directory,`tracks/${trackId}.json`,f.board);
  let rows=await readCapturedNormalLedgerRows({directory:f.directory});
  await applyNativeLedgerToCapturedTracks({...f.options,canonicalRows:rows});
  const file=`canonical/${trackId}/${f.sources[0].accountId}.json`,canonical=await read(f.directory,file);
  assert.equal(canonical.nativeLedgerSource.status.verified,false);
  assert.equal(canonical.nativeLedgerBoardSource.status.runVerified,true);
  rows=await readCapturedNormalLedgerRows({directory:f.directory});
  assert.equal(rows[0].runVerified,true);assert.equal(rows[0].sourceCanonicalStatus.verified,false);
  await applyNativeLedgerToCapturedTracks({...f.options,canonicalRows:rows,policy:{...policy,verifierFingerprint:'e'.repeat(64)}});
  const restored=await read(f.directory,file);
  assert.equal(restored.runVerified,true);assert.equal(restored.verifiedState,1);assert.equal(restored.nativeLedger,undefined);
  assert.deepEqual(restored.nativeLedgerSource,canonical.nativeLedgerSource);
});

test('normal source adapter rejects changed canonical binding or conflicting explicit frames instead of omitting a racer',async t=>{
  for(const changed of ['uploadId','replayHash','timeMs','frames']){
    const f=await fixture(t),file=`canonical/${trackId}/${f.sources[0].accountId}.json`,canonical=await read(f.directory,file);
    canonical[changed]=changed==='replayHash'?'f'.repeat(64):canonical[changed]+1;
    await write(f.directory,file,canonical);
    await assert.rejects(readCapturedNormalLedgerRows({directory:f.directory}),/binding|frames/);
  }
});
