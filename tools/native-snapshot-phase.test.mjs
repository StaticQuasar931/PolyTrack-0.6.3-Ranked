import {pinRetainedNativeBoards,retainedNativeBoardMatches} from './retained-native-board-cache.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,generateKeyPairSync,privateDecrypt,createDecipheriv,constants} from 'node:crypto';
import {deflateSync,gunzipSync} from 'node:zlib';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import {prepareNativeSnapshotCapture,runNativeSnapshotPhase,verifyNativeSnapshotPhase} from './native-snapshot-phase.mjs';
import {ledgerBinding,ledgerKey,writeLedger,readLedger} from './native-verification-ledger.mjs';
import {encryptCaptureRecovery} from './capture-recovery.mjs';
const encryptNativeSnapshotRecovery=options=>encryptCaptureRecovery({attempt:'routine-capture',...options});
import {nativeLedgerPublicationFiles} from './verifier/local-snapshot-verification.mjs';
import {PERMANENT_ROLLING_HILLS} from '../workers/ranked/src/permanent-rolling-hills.js';
import {applyNativeLedgerToCapturedTracks} from './public-snapshot-backup.mjs';
import {publishSnapshot} from './snapshot-package.mjs';
import {hydrateStaging} from './update-public-snapshot.mjs';
import {nativeEventSourceHash} from './native-event-snapshot.mjs';
import {loadTrustedPublishedEventTotalsBaseline} from './published-event-totals-baseline.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const track='a'.repeat(64),account='b'.repeat(64),engine='c'.repeat(64),fingerprint='d'.repeat(64),content='e'.repeat(64);
const replay=deflateSync(Buffer.alloc(15)).toString('base64url'),replayHash=sha(replay),runId='f'.repeat(64);
const policy={engineDigest:engine,compatibleEngines:[],verifierVersion:'polytrack-native-bounded-v1',verifierFingerprint:fingerprint,
  resourceProfiles:['standard','extended-local'],reviewPolicyVersions:['snapshot-controls-v1'],
  trackContentHashes:{[track]:content},trackGeometries:{[track]:{geometryPolicy:'default',trackGeometry:{parts:1,spanX:10,spanZ:20}}}};
const read=async(directory,file)=>JSON.parse(await fs.readFile(path.join(directory,file),'utf8'));
async function write(directory,file,value){const target=path.join(directory,file);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,JSON.stringify(value)+'\n');}
async function inventory(directory){
  const values={};
  async function visit(relative=''){
    for(const item of await fs.readdir(path.join(directory,relative),{withFileTypes:true})){
      const file=relative?relative+'/'+item.name:item.name;
      // Rollback assertions cover authority/candidate bytes, not independent private recovery evidence.
      if(file==='local-reports/native-proof-checkpoints')continue;
      if(item.isDirectory())await visit(file);else values[file]=(await fs.readFile(path.join(directory,file))).toString('base64');
    }
  }
  await visit();return values;
}
function denyNetwork(t){
  const deny=()=>assert.fail('offline phase attempted transport');
  t.mock.method(globalThis,'fetch',deny);
  for(const [object,keys]of [[http,['request','get']],[https,['request','get']],[net,['connect','createConnection']],[tls,['connect']]])
    for(const key of keys)t.mock.method(object,key,deny);
}
async function fixture(t,{events=false,legacy=false}={}){
  denyNetwork(t);
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'native-phase-test-')),directory=path.join(root,'candidate');
  t.after(async()=>{assert.equal(path.dirname(root),os.tmpdir());await fs.rm(root,{recursive:true,force:true});});
  const row={accountId:account,trackId:track,timeMs:900,frames:900,uploadId:1,replayHash,runVerified:false,verified:false,integrityVerified:true};
  const manifest={schemaVersion:1,tracks:{},events:{}};
  if(!events){
    manifest.tracks[track]={path:`tracks/${track}.json`};
    await write(directory,`tracks/${track}.json`,{trackId:track,entries:[row],updatedAt:100,complete:true,totalEntries:1});
    await write(directory,`canonical/${track}/${account}.json`,row);
    await write(directory,'recordings/1.json',{...row,recording:replay});
  }else{
    const rh=PERMANENT_ROLLING_HILLS.trackId;
    manifest.tracks[rh]={path:`tracks/${rh}.json`};
    manifest.events.day1={path:'events/day1.json'};
    const rolling={...row,trackId:rh,runVerified:true,verified:true,pbAt:100};
    await write(directory,`tracks/${rh}.json`,{trackId:rh,entries:[rolling],updatedAt:100,complete:true,totalEntries:1,
      algorithmVersion:'participation-v8-s1',schemaVersion:6,revision:1,sourceRevision:1,builtAt:100});
    await write(directory,`canonical/${rh}/${account}.json`,rolling);
    await write(directory,'recordings/1.json',{...rolling,recording:replay});
    const period={id:'day1',kind:'custom',trackId:track,startsAt:1000,endsAt:1000000,targetMs:1000,maxRp:1000,
      entrantLimit:200,scoringVersion:'time-ratio-v1',eligibility:'best-submitted-during-period'};
    const pending={accountId:account,runId,timeMs:900,submittedAt:2000,replayHash,name:'Fixture',carStyle:'style',
      pending:true,verified:false,eventRpEligible:false,verificationStatus:'waiting',source:'pending-event-playback'};
    await write(directory,'events/day1.json',{id:'day1',period,entries:legacy?[{accountId:account,timeMs:1200,rank:4,rp:77}]:[],
      updatedAt:2500,...legacy?{}:{complete:true,totalEntries:0,sourceComplete:true,pendingPlaybacks:[pending]}});
    await write(directory,`event-playbacks/day1/${runId}.json`,{...pending,periodId:'day1',trackId:track,frames:900,
      replay,source:'pending-event-recording'});
    await write(directory,'event-totals.json',{updatedAt:2500,capturedAt:'2026-10-30T01:00:00.000Z',complete:true,totalEntries:legacy?1:0,
      entries:legacy?[{accountId:account,rp:77,finiteEventRp:77,permanentRollingHillsRp:0,rollingHillsEventRpContribution:0,events:1}]:[]});
  }
  await write(directory,'manifest.json',manifest);
  const ledger=writeLedger({root:path.join(root,'verification-ledger'),entries:[],expectedManifestHash:null});
  await write(root,'verification-ledger-current.json',{schemaVersion:1,directory:'verification-ledger',manifestHash:ledger.manifestHash});
  const calls=[];
  const options={root,directory,sourceCommit:'a'.repeat(40),now:()=>Date.now()-1000,
    preflight:async()=>({sourceTracks:1,sourceRows:1,sourceSha256:sha('fixture scoring inputs')}),
    buildPolicy:async()=>structuredClone(policy),validateEngine:async()=>{},
    verify:async(_root,jobs)=>{calls.push(jobs);return jobs.map(job=>{
      const binding={verifierVersion:policy.verifierVersion,verifierFingerprint:fingerprint,resourceProfile:job.resourceProfile||'standard',
        resultId:job.resultId,trackId:job.trackId,timeMs:job.timeMs,replayHash:job.replayHash,actualReplayHash:sha(job.replay),
        nativeTrackId:job.trackId,trackContentHash:content,engineDigest:engine};
      return {resultId:job.resultId,trackId:job.trackId,timeMs:job.timeMs,replayHash:job.replayHash,status:'verified',reason:'native_exact_finish',
        deterministic:true,engineDigest:engine,trackContentHash:content,...structuredClone(policy.trackGeometries[track]),binding,
        boundInputFingerprint:sha(JSON.stringify(binding))};
    });},
    reviewFactory:async({jobs})=>{assert(Object.isFrozen(jobs));return async({jobs,nativeResults})=>({complete:true,results:nativeResults,
      reviews:jobs.map(job=>({complete:true,disposition:'approved',bindingKey:ledgerKey(ledgerBinding(job)),
        policyVersion:'snapshot-controls-v1',attestationHash:sha('phase fixture review')}))});},
    rebuild:async({directory})=>{await write(directory,'rebuilt.json',{complete:true});return {complete:true};},
    buildProfiles:async directory=>{assert.equal((await read(directory,'rebuilt.json')).complete,true);await write(directory,'profiles-built.json',{complete:true});}};
  return {root,directory,row,options,calls};
}

test('inactive phase hydrates, verifies, overlays normal flags, rebuilds and promotes one pinned cohort offline',async t=>{
  const f=await fixture(t),result=await runNativeSnapshotPhase(f.options);
  assert.equal(result.backendReads,0);assert.equal(result.backendWrites,0);assert.equal(result.counts.verified,1);
  assert.equal(f.calls.length,1);assert.equal(result.complete,true);
  const row=(await read(f.directory,`tracks/${track}.json`)).entries[0];
  assert.equal(row.runVerified,true);assert.equal(row.integrityVerified,true);assert.equal(row.nativeLedgerManifestHash,result.ledgerManifestHash);
  const context=await prepareNativeSnapshotCapture(f.options);
  assert.equal(context.canonicalRows[0].sourceBoardStatus.runVerified,false,'next capture restores pristine normal baseline without config activation');
  const files=await nativeLedgerPublicationFiles(f.root);
  assert(files.includes('verification-ledger-current.json'));assert(files.includes('verification-ledger/manifest.json'));
  assert(files.some(file=>/^verification-ledger\/shards\/[a-f0-9]{64}\.json$/.test(file)));
});

test('read-only scoring preflight failure prevents native work and all authority mutation',async t=>{
  const f=await fixture(t),before=await inventory(f.root),failure=Error('invalid scoring input');
  await assert.rejects(runNativeSnapshotPhase({...f.options,preflight:async({directory,validateOnly})=>{
    assert.equal(validateOnly,true);assert.notEqual(directory,f.directory);
    assert.equal(f.calls.length,0);throw failure;
  },proofCheckpoint:async()=>assert.fail('no proofs before preflight')}),error=>error===failure);
  assert.equal(f.calls.length,0);assert.deepEqual(await inventory(f.root),before);
});

test('production preflight catches missing canonical board scoring metadata before physics',async t=>{
  const f=await fixture(t),manifest=await read(f.directory,'manifest.json');
  manifest.tracks[track].updatedAt=100;await write(f.directory,'manifest.json',manifest);
  await write(f.directory,'overall.json',{algorithmVersion:'participation-v8-s1',schemaVersion:6,
    revision:1,sourceRevision:1,builtRevision:1,updatedAt:100,entries:[],trackSummaries:[],complete:true,totalEntries:0,trackCatalog:[{trackId:track,updatedAt:100}]});
  const before=await inventory(f.root);
  await assert.rejects(runNativeSnapshotPhase({...f.options,preflight:undefined}),/Unsupported scoring version/);
  assert.equal(f.calls.length,0);assert.deepEqual(await inventory(f.root),before);
});

test('controls preparation finishes before any native dispatch',async t=>{
  const f=await fixture(t);let prepared=false;
  await runNativeSnapshotPhase({...f.options,reviewFactory:async context=>{
    const review=await f.options.reviewFactory(context);
    review.inspect=async()=>{assert.equal(f.calls.length,0);prepared=true;return {complete:true};};return review;
  },verify:async(...args)=>{assert(prepared);return f.options.verify(...args);}});
  assert(prepared);
});

test('a globally stopped whole-inventory controls preflight spends no native budget',async t=>{
  const f=await fixture(t);
  await assert.rejects(runNativeSnapshotPhase({...f.options,reviewFactory:async input=>{
    const review=await f.options.reviewFactory(input);review.inspect=async()=>({complete:false,stop:'captured_controls_pair_limit'});return review;
  }}),/controls preflight stopped/);
  assert.equal(f.calls.length,0);
});

test('one native job budget reaches a live waiting event before a normal backlog without filtering full review',async t=>{
  const f=await fixture(t,{events:true}),manifest=await read(f.directory,'manifest.json'),rows=[];
  for(let index=2;index<=22;index++){
    const row={...f.row,accountId:sha('normal backlog '+index),uploadId:index,ingestedAt:Date.now()-index};rows.push(row);
    await write(f.directory,`canonical/${track}/${row.accountId}.json`,row);
    await write(f.directory,`recordings/${index}.json`,{...row,recording:replay});
  }
  manifest.tracks[track]={path:`tracks/${track}.json`};await write(f.directory,'manifest.json',manifest);
  await write(f.directory,`tracks/${track}.json`,{trackId:track,entries:rows,updatedAt:100,complete:true,totalEntries:rows.length});
  const event=await read(f.directory,'events/day1.json');event.state='open';await write(f.directory,'events/day1.json',event);
  let fullInventory=0;
  const result=await runNativeSnapshotPhase({...f.options,maxJobs:1,reviewFactory:async input=>{
    fullInventory=input.jobs.length;return f.options.reviewFactory(input);
  }});
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].length,1);assert.equal(f.calls[0][0].kind,'event-pending');
  assert.equal(fullInventory,23);assert.equal(result.counts.nativeDispatched,1);assert.equal(result.counts.unprocessed,21);
  assert.equal(result.priority.liveEventPending,1);assert.equal(result.sourceCoverage.knownBindings,23);
});

test('prepared capture and scoring pins fail before spending any native budget',async t=>{
  const f=await fixture(t);
  for(const option of ['expectedCaptureSha256','expectedScoringSha256']){
    await assert.rejects(runNativeSnapshotPhase({...f.options,[option]:'0'.repeat(64)}),/changed since preparation/);
    assert.equal(f.calls.length,0);
  }
});

test('completed in-process attestations retry scoring without physics or receipt-based admission',async t=>{
  const f=await fixture(t),before=await inventory(f.root);let attempts=0;
  const verified=await verifyNativeSnapshotPhase({...f.options,rebuild:async options=>{
    if(++attempts===1){await write(options.directory,'failed-compile.json',{partial:true});throw Error('scoring IO failure');}
    await assert.rejects(fs.stat(path.join(options.directory,'failed-compile.json')),error=>error.code==='ENOENT');
    return f.options.rebuild(options);
  }});
  assert.equal(verified.receipt.authority,false);assert.equal(verified.receipt.decisions.length,1);
  assert.deepEqual(await inventory(f.root),before);assert.equal(f.calls.length,1);
  const serialized=JSON.parse(JSON.stringify(verified));assert.equal(serialized.compile,undefined);
  try{
    await assert.rejects(verified.compile(),/scoring IO failure/);
    assert.deepEqual(await inventory(f.root),before);assert.equal(f.calls.length,1);
    assert.equal((await verified.compile()).counts.verified,1);assert.equal(f.calls.length,1);
    await assert.rejects(verified.compile(),/consumed/);
  }finally{await verified.dispose();}
  await assert.rejects(verified.compile(),/disposed/);
});

test('disposing a completed verification never advances the public ledger',async t=>{
  const f=await fixture(t),before=await inventory(f.root),verified=await verifyNativeSnapshotPhase(f.options);
  await verified.dispose();await verified.dispose();
  assert.deepEqual(await inventory(f.root),before);
  await assert.rejects(verified.compile(),/disposed/);
});

test('exact branded published event totals support a public-only offline rebase, not a private overlay',async t=>{
  const f=await fixture(t,{events:true});await runNativeSnapshotPhase(f.options);
  const totals=await read(f.directory,'event-totals.json');
  await publishSnapshot({root:f.root,stagingDirectory:f.directory});
  const pointer=await read(f.root,'snapshot-current.json'),generation=Number(pointer.currentdir.replace('public-snapshots',''));
  const publishedEventTotalsBaseline=await loadTrustedPublishedEventTotalsBaseline({root:f.root,expectedGeneration:generation,
    expectedIndexSha256:sha(await fs.readFile(path.join(f.root,pointer.currentdir,'index.json')))});
  await runNativeSnapshotPhase({...f.options,publishedEventTotalsBaseline});
  assert.deepEqual((await read(f.directory,'event-totals.json')).entries,totals.entries);
  assert.equal(f.calls.length,1,'exact public witnesses reuse physics');
  const changed=await read(f.directory,'event-totals.json');changed.updatedAt++;
  await write(f.directory,'event-totals.json',changed);
  const before=await inventory(f.root);
  await assert.rejects(runNativeSnapshotPhase({...f.options,publishedEventTotalsBaseline}),/exact trusted published totals required before native/);
  assert.equal(f.calls.length,1);assert.deepEqual(await inventory(f.root),before);
});

for(const crossVolume of [false,true])test('private candidate promotion avoids a second full copy when possible: '+crossVolume,async t=>{
  const f=await fixture(t),rename=fs.rename,copy=fs.cp;let copies=0,moves=0;
  t.mock.method(fs,'rename',async(from,to)=>{
    if(path.basename(path.dirname(from)).startsWith('polytrack-native-phase-')&&path.basename(from)==='candidate'){
      moves++;if(crossVolume)throw Object.assign(Error('cross volume'),{code:'EXDEV'});
    }
    return rename(from,to);
  });
  t.mock.method(fs,'cp',async(from,to,options)=>{if(to.includes('.native-next-'))copies++;return copy(from,to,options);});
  await runNativeSnapshotPhase(f.options);
  assert.equal(moves,1);assert.equal(copies,crossVolume?1:0);
  assert.equal((await read(f.directory,`tracks/${track}.json`)).entries[0].runVerified,true);
});

test('unavailable canonical replay defers its row through native processing and cold hydration',async t=>{
  const f=await fixture(t),captureContext=await prepareNativeSnapshotCapture(f.options);
  await fs.unlink(path.join(f.directory,`canonical/${track}/${account}.json`));
  const result=await runNativeSnapshotPhase({...f.options,captureContext});
  assert.equal(result.complete,false);assert.equal(result.counts.nativeDispatched,0);assert.equal(f.calls.length,0);
  assert.equal(result.privateProofCheckpoint,null);
  await assert.rejects(fs.stat(path.join(f.root,'local-reports/native-proof-checkpoints')),error=>error.code==='ENOENT');
  assert.equal(result.sourceCoverage.gaps.filter(g=>g.kind==='normal-replay-unavailable').length,1);
  const row=(await read(f.directory,`tracks/${track}.json`)).entries[0];
  assert.equal(row.timeMs,f.row.timeMs);assert.equal(row.runVerified,false);assert.equal(row.nativeLedgerKey,undefined);
  const cold=await prepareNativeSnapshotCapture(f.options);assert.equal(cold.canonicalRows.length,0);
});

test('stored proofs overlay without new native work or changing server verification authority',async t=>{
  const f=await fixture(t);await runNativeSnapshotPhase(f.options);
  const pointer=await read(f.root,'verification-ledger-current.json');
  const before=await fs.readFile(path.join(f.root,'verification-ledger/manifest.json'));
  let attempted=false;
  const result=await runNativeSnapshotPhase({...f.options,reuseOnly:true,
    proofCheckpoint:async()=>assert.fail('unchanged stored ledger must not copy or encrypt another checkpoint'),
    verify:async()=>{attempted=true;throw Error('Stored overlays cannot run physics');},
    reviewFactory:async()=>{throw Error('Stored overlays cannot mint new review attestations');}});
  assert.equal(attempted,false);assert.equal(result.authority,'stored-proof-overlay');
  assert.equal(result.counts.nativeDispatched,0);assert.equal(result.counts.newProofs,0);
  assert.equal(result.backendReads,0);assert.equal(result.backendWrites,0);
  assert.equal((await read(f.directory,`tracks/${track}.json`)).entries[0].runVerified,true);
  assert.deepEqual(await read(f.root,'verification-ledger-current.json'),pointer);
  assert.deepEqual(await fs.readFile(path.join(f.root,'verification-ledger/manifest.json')),before);
  assert.equal(result.privateProofCheckpoint,null);
  assert.equal((await fs.readdir(path.join(f.root,'local-reports/native-proof-checkpoints'))).length,1);
});

test('foreign root writer lock fails before changing any candidate, ledger, pointer or companions',async t=>{
  const f=await fixture(t),captureContext=await prepareNativeSnapshotCapture(f.options);
  await write(f.directory,'native-event-source/'+sha('old')+'.json',{sentinel:'must remain byte-identical'});
  await fs.writeFile(path.join(f.root,'verification-ledger','.writer.lock'),'foreign writer');
  const before=await inventory(f.root);
  await assert.rejects(runNativeSnapshotPhase({...f.options,captureContext}),/EEXIST/);
  assert.deepEqual(await inventory(f.root),before);
});

test('pointer publication failure after a partial write rolls back exact root/candidate bytes and removes new shards',async t=>{
  const f=await fixture(t),before=await inventory(f.root);
  await assert.rejects(runNativeSnapshotPhase({...f.options,publishPointer:async({root,pointer})=>{
    await write(root,'verification-ledger-current.json',pointer);throw Error('injected pointer failure');
  }}),/injected pointer failure/);
  assert.deepEqual(await inventory(f.root),before);
});

test('candidate swap failure restores the previous directory and root authority byte for byte',async t=>{
  const f=await fixture(t),before=await inventory(f.root),rename=fs.rename;
  t.mock.method(fs,'rename',async(from,to)=>{
    if(from.startsWith(f.directory+'.native-next-')&&to===f.directory)throw Error('injected candidate promotion failure');
    return rename(from,to);
  });
  await assert.rejects(runNativeSnapshotPhase(f.options),/injected candidate promotion failure/);
  assert.deepEqual(await inventory(f.root),before);
});

test('failed initial bootstrap leaves no new root ledger or pointer',async t=>{
  const f=await fixture(t);
  const ledgerRoot=path.join(f.root,'verification-ledger');
  assert.equal(path.dirname(ledgerRoot),f.root);
  await fs.rm(ledgerRoot,{recursive:true});await fs.unlink(path.join(f.root,'verification-ledger-current.json'));
  const before=await inventory(f.root);
  await assert.rejects(runNativeSnapshotPhase({...f.options,publishPointer:async()=>{throw Error('bootstrap pointer failure');}}),/bootstrap pointer failure/);
  assert.deepEqual(await inventory(f.root),before);
});

test('publication stages only the pinned manifest and referenced shards, rejecting active writers',async t=>{
  const f=await fixture(t);await runNativeSnapshotPhase(f.options);
  const initial=await nativeLedgerPublicationFiles(f.root);
  for(const [file,value]of [['verification-ledger/shards/'+sha('orphan')+'.json',{orphan:true}],
    ['verification-ledger/.manifest-abandoned.tmp',{temporary:true}],['verification-ledger/private-companion.json',{private:true}]])await write(f.root,file,value);
  assert.deepEqual(await nativeLedgerPublicationFiles(f.root),initial);
  await fs.writeFile(path.join(f.root,'verification-ledger','.writer.lock'),'writer');
  await assert.rejects(nativeLedgerPublicationFiles(f.root),/writer|lock/);
});

test('first live event publication admits exact verified pending runs from an inline empty lane',async t=>{
 const f=await fixture(t,{events:true}),board=await read(f.directory,'events/day1.json');
 for(const key of ['complete','totalEntries','sourceComplete'])delete board[key];
 Object.assign(board,{archived:false,state:'open',racerCount:1});board.period.kind='weekly';
 await write(f.directory,'events/day1.json',board);
 const manifest=await read(f.directory,'manifest.json');manifest.events.day1.checkedAt=3000;await write(f.directory,'manifest.json',manifest);
 await runNativeSnapshotPhase(f.options);
 const published=await read(f.directory,'events/day1.json');assert.equal(published.entries.length,1);assert.equal(published.entries[0].verified,true);
});

test('full event admission persists public-safe pristine companions through cold checkout hydration',async t=>{
  const f=await fixture(t,{events:true}),result=await runNativeSnapshotPhase(f.options);
  assert.equal(result.counts.verified,1);assert.equal(result.events.periods,1);
  const board=await read(f.directory,'events/day1.json');
  assert.equal(board.entries.length,1,JSON.stringify(board));
  assert.equal(board.entries[0].verified,true);assert.equal(board.entries[0].runId,runId);
  const manifest=await read(f.directory,'manifest.json'),pin=manifest.nativeEventSources.day1;
  const companion=await read(f.directory,'native-event-source/'+pin+'.json');
  assert.deepEqual(Object.keys(companion).sort(),['board','schemaVersion']);
  assert.equal(companion.board.entries.length,0);assert.equal(companion.board.nativeEventOverlay,undefined);
  assert.equal(companion.board.period.capacity,undefined);
  const cold=path.join(f.root,'cold');await fs.mkdir(cold);
  await publishSnapshot({root:cold,stagingDirectory:f.directory});
  for(const item of ['verification-ledger','verification-ledger-current.json'])await fs.cp(path.join(f.root,item),path.join(cold,item),{recursive:true});
  await hydrateStaging(cold,path.join(cold,'candidate'));
  const context=await prepareNativeSnapshotCapture({...f.options,root:cold,directory:path.join(cold,'candidate')});
  assert.deepEqual(context.eventSources.get('day1'),companion.board);
  assert.equal(context.retainedNativeEntries.day1.recordings.length,1);
});

test('legacy unknown completeness preserves visible rows, rank, RP and finite totals without invented admission',async t=>{
  const f=await fixture(t,{events:true,legacy:true}),before=await read(f.directory,'events/day1.json');
  const result=await runNativeSnapshotPhase(f.options),board=await read(f.directory,'events/day1.json');
  assert.equal(result.complete,false);assert.equal(f.calls.length,0);
  assert.deepEqual(board.entries,before.entries);assert.equal(board.complete,undefined);assert.equal(board.totalEntries,undefined);
  assert.equal((await read(f.directory,'event-totals.json')).entries[0].finiteEventRp,77);
  assert((await read(f.directory,'manifest.json')).nativeEventSources.day1);
});

test('real normal projection compiles event totals with exact captured-native provenance and no forged Worker signature',async t=>{
  const f=await fixture(t,{events:true}),rh=PERMANENT_ROLLING_HILLS.trackId;
  assert.equal(Object.hasOwn(await read(f.directory,`tracks/${rh}.json`),'signature'),false);
  const result=await runNativeSnapshotPhase({...f.options,applyNormal:applyNativeLedgerToCapturedTracks});
  assert.equal(result.complete,true);assert.equal(result.normal.tracks,1);assert.equal(result.counts.verified,1);
  assert.equal(result.backendReads,0);assert.equal(result.backendWrites,0);
  const normal=await read(f.directory,`tracks/${rh}.json`),rolling=await read(f.directory,'events/permanent-rolling-hills.json');
  const totals=await read(f.directory,'event-totals.json'),event=await read(f.directory,'events/day1.json');
  assert.equal(normal.complete,true);assert.equal(normal.totalEntries,normal.entries.length);
  assert.equal(Object.hasOwn(normal,'signature'),false);
  assert.equal(Object.hasOwn(rolling,'sourceSignature'),false);
  assert.deepEqual(rolling.capturedNativeSource,{kind:'captured-native-content-v1',
    sourceHash:nativeEventSourceHash(normal),sourceHashMode:'canonical-json',sourceUpdatedAt:normal.updatedAt,sourceBuiltAt:normal.builtAt});
  assert.equal(rolling.sourceCompleteness,'captured-native-complete');
  assert.deepEqual(totals.nativeEventOverlay.rollingSource,rolling.capturedNativeSource);
  assert.equal(event.entries[0].verified,true);assert.equal(event.entries[0].runId,runId);
  assert.equal(totals.entries[0].finiteEventRp,event.entries[0].rp);
  assert.equal(totals.entries[0].rp,event.entries[0].rp+rolling.entries[0].rp);
  assert.equal((await read(f.directory,'manifest.json')).nativeVerificationLedger.manifestHash,result.ledgerManifestHash);
  assert.equal((await read(f.root,'verification-ledger-current.json')).manifestHash,result.ledgerManifestHash);
});

test('missing or incompatible retained native media preserves the protected previous board even with zero compatible recordings',async t=>{
  const f=await fixture(t,{events:true});await runNativeSnapshotPhase(f.options);
  const original=await read(f.directory,'events/day1.json');
  const changed=structuredClone(policy);changed.verifierFingerprint='0'.repeat(64);
  const incompatible=await prepareNativeSnapshotCapture({...f.options,buildPolicy:async()=>changed});
  assert.deepEqual(incompatible.retainedNativeEntries.day1.previousBoard,original);
  assert.deepEqual(incompatible.retainedNativeEntries.day1.recordings,[]);
  await fs.unlink(path.join(f.directory,`event-replays/day1/${account}.json`));
  const missing=await prepareNativeSnapshotCapture(f.options);
  assert.deepEqual(missing.retainedNativeEntries.day1.previousBoard,original);
  assert.deepEqual(missing.retainedNativeEntries.day1.recordings,[]);
});

async function pendingEventWithPublishedProof(t){
  const f=await fixture(t,{events:true}),files=['events/day1.json',`event-playbacks/day1/${runId}.json`,'event-totals.json'];
  const pristine=await Promise.all(files.map(file=>fs.readFile(path.join(f.directory,file))));
  await runNativeSnapshotPhase(f.options);
  assert.equal(f.calls.length,1);
  const pointer=await read(f.root,'verification-ledger-current.json');
  const ledger=readLedger({root:path.join(f.root,pointer.directory),expectedManifestHash:pointer.manifestHash});
  assert(ledger.entries.some(entry=>entry.binding.lane==='event'&&entry.binding.runId===runId));
  for(let i=0;i<files.length;i++)await fs.writeFile(path.join(f.directory,files[i]),pristine[i]);
  // The public source can still be pending even when its exact root proof exists.
  await fs.unlink(path.join(f.directory,`event-replays/day1/${account}.json`));
  assert((await read(f.directory,'manifest.json')).nativeVerificationLedger);
  f.reuseOptions={...f.options,reuseOnly:true,
    verify:async()=>assert.fail('published pending proof reuse must not dispatch physics'),
    reviewFactory:async()=>assert.fail('published pending proof reuse must not mint reviews'),
    proofCheckpoint:async()=>assert.fail('published pending proof reuse must not import or checkpoint private proofs')};
  return f;
}

test('public pending event playback with an exact root proof is retained and compiles reuse-only',async t=>{
  const f=await pendingEventWithPublishedProof(t),pointer=await read(f.root,'verification-ledger-current.json');
  const context=await prepareNativeSnapshotCapture(f.reuseOptions),retained=context.retainedNativeEntries.day1;
  assert.equal(retained.previousBoard.entries.length,0);assert.equal(retained.previousBoard.pendingPlaybacks.length,1);
  assert.equal(retained.recordings.length,1);assert.equal(retained.recordings[0].runId,runId);
  assert.equal(retained.recordings[0].replay,replay);assert.equal(retained.recordings[0].submittedAt,2000);
  assert.equal(context.retainedJobs.filter(job=>job.source===`event-playbacks/day1/${runId}.json`).length,1);
  const result=await runNativeSnapshotPhase({...f.reuseOptions,captureContext:context});
  assert.equal(result.authority,'stored-proof-overlay');assert.equal(result.counts.nativeDispatched,0);
  assert.equal(result.counts.newProofs,0);assert.equal(result.backendReads,0);assert.equal(result.backendWrites,0);
  assert.equal(f.calls.length,1);assert.equal(result.events.ready,true);
  const board=await read(f.directory,'events/day1.json');
  assert.equal(board.entries.length,1);assert.equal(board.entries[0].runId,runId);assert.equal(board.entries[0].verified,true);
  assert.equal((board.pendingPlaybacks||[]).length,0);
  assert.deepEqual(await read(f.root,'verification-ledger-current.json'),pointer);
});

const pendingMediaRestrictions={
  'pending media hold':{reviewHold:true},
  'pending media needsReview':{needsReview:true},
  'pending media excluded':{excluded:true},
  'pending media unscored':{unscored:true},
  'pending media held status':{status:'held'},
  'pending media held verificationStatus':{verificationStatus:'held'},
  'pending media review validationState':{validationState:'review_required'},
  'pending media excluded verifiedState':{verifiedState:'excluded'},
  'pending media held reason':{reason:'held'},
  'pending media hold reason':{reason:'hold'},
  'pending media review reason':{reason:'review_required'},
  'pending media excluded reason':{reason:'excluded'},
  'pending media rejected reason':{reason:'rejected'},
  'pending media mismatch reason':{reason:'mismatch'},
  'pending media unavailable reason':{reason:'unavailable_final'}
};
for(const scenario of ['missing media','changed replay bytes','changed replay hash','conflicting submission date','missing pending submittedAt with legacy date',
  'out-of-period submission date','incompatible policy','pending row hold',...Object.keys(pendingMediaRestrictions)])
test('public pending proof reuse fails closed for '+scenario,async t=>{
  const f=await pendingEventWithPublishedProof(t),file=`event-playbacks/day1/${runId}.json`;
  const board=await read(f.directory,'events/day1.json'),raw=await read(f.directory,file);
  if(scenario==='missing media')await fs.unlink(path.join(f.directory,file));
  else if(scenario==='incompatible policy'){
    const changed=structuredClone(policy);changed.verifierFingerprint='0'.repeat(64);
    f.reuseOptions.buildPolicy=async()=>changed;
  }else{
    if(scenario==='changed replay bytes')raw.replay=deflateSync(Buffer.alloc(15,1)).toString('base64url');
    if(scenario==='changed replay hash')raw.replayHash='1'.repeat(64);
    if(scenario==='conflicting submission date')raw.submittedAt++;
    if(scenario==='missing pending submittedAt with legacy date'){raw.runCreatedAt=raw.submittedAt;delete raw.submittedAt;}
    if(scenario==='out-of-period submission date')board.pendingPlaybacks[0].submittedAt=raw.submittedAt=board.period.endsAt;
    if(scenario==='pending row hold')board.pendingPlaybacks[0].reviewHold=true;
    if(Object.hasOwn(pendingMediaRestrictions,scenario))Object.assign(raw,pendingMediaRestrictions[scenario]);
    await write(f.directory,'events/day1.json',board);await write(f.directory,file,raw);
  }
  const before=await inventory(f.root);
  if(['missing media','incompatible policy','pending row hold'].includes(scenario)||Object.hasOwn(pendingMediaRestrictions,scenario)){
    const context=await prepareNativeSnapshotCapture(f.reuseOptions);
    assert.deepEqual(context.retainedNativeEntries.day1.previousBoard,board);
    assert.equal(context.retainedNativeEntries.day1.recordings.length,0);
  }
  await assert.rejects(runNativeSnapshotPhase(f.reuseOptions),
    /approved event payload unavailable|protected retained (?:event|pending) .*mismatch|Retained event requires original submittedAt|Invalid exact event ledger binding|Invalid retained event pending lane|Invalid public pending event playback binding|Invalid retained event status/);
  assert.equal(f.calls.length,1);assert.deepEqual(await inventory(f.root),before);
});

test('a hash-valid companion cannot smuggle private fields through cold hydration',async t=>{
  const f=await fixture(t,{events:true});await runNativeSnapshotPhase(f.options);
  const manifest=await read(f.directory,'manifest.json'),old=manifest.nativeEventSources.day1;
  const companion=await read(f.directory,'native-event-source/'+old+'.json');companion.board.privateCredential='not public';
  const bytes=Buffer.from(JSON.stringify(companion)+'\n'),pin=sha(bytes);
  await fs.writeFile(path.join(f.directory,'native-event-source',pin+'.json'),bytes);
  manifest.nativeEventSources.day1=pin;await write(f.directory,'manifest.json',manifest);
  await assert.rejects(prepareNativeSnapshotCapture(f.options),/companion identity\/schema/);
});

const recoveryKeys=generateKeyPairSync('rsa',{modulusLength:2048});
const recoveryPublicKey=recoveryKeys.publicKey.export({type:'spki',format:'pem'});
function decryptRoutineRecovery(bytes){
  const magic=Buffer.from('PTREC01\n');assert(bytes.subarray(0,magic.length).equals(magic));
  const start=magic.length+4,end=start+bytes.readUInt32BE(magic.length),encoded=bytes.subarray(start,end),header=JSON.parse(encoded);
  const secret=privateDecrypt({key:recoveryKeys.privateKey,oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},Buffer.from(header.wrappedKey,'base64'));
  const decipher=createDecipheriv('aes-256-gcm',secret,Buffer.from(header.iv,'base64'));
  decipher.setAAD(encoded);decipher.setAuthTag(bytes.subarray(-16));
  let decoded;try{decoded=gunzipSync(Buffer.concat([decipher.update(bytes.subarray(end,-16)),decipher.final()]));}finally{secret.fill(0);}
  const [inventory,...records]=decoded.toString('utf8').trimEnd().split('\n').map(line=>JSON.parse(line));
  assert.equal(inventory.entries.length,records.length);
  for(const [index,record]of records.entries()){
    const data=Buffer.from(record.data,'base64'),entry=inventory.entries[index];
    assert.equal(record.path,entry.path);assert.equal(data.length,entry.bytes);assert.equal(sha(data),entry.sha256);
  }
  return {header,inventory,records};
}

async function multiBatchFixture(t){
  const f=await fixture(t),board=await read(f.directory,`tracks/${track}.json`);
  for(let index=1;index<18;index++){
    const row={...f.row,accountId:index.toString(16).padStart(64,'0'),uploadId:index+1};
    board.entries.push(row);
    await write(f.directory,`canonical/${track}/${row.accountId}.json`,row);
    await write(f.directory,`recordings/${row.uploadId}.json`,{...row,recording:replay});
  }
  board.totalEntries=board.entries.length;await write(f.directory,`tracks/${track}.json`,board);
  return f;
}

for(const failure of ['review','attestation','native binding','engine'])test('completed batch survives later '+failure+' failure as private evidence only',async t=>{
  const f=await multiBatchFixture(t),before=await inventory(f.root),outputFile=path.join(f.root,'proofs.ptenc');
  const original=Error('later '+failure+' failure');let reviews=0,engines=0,callbacks=0,checkpoint,sourceBinding,completedKeys;
  const options={...f.options,
    verify:async(...args)=>{
      const results=await f.options.verify(...args);
      if(failure==='native binding'&&f.calls.length===2)results.at(-1).timeMs++;
      return results;
    },
    validateEngine:async()=>{if(++engines===3&&failure==='engine')throw original;},
    reviewFactory:async context=>{
      sourceBinding=context.sourceBinding;
      const review=await f.options.reviewFactory(context);
      return async value=>{
        if(++reviews===1)completedKeys=value.jobs.map(job=>ledgerKey(ledgerBinding(job))).sort();
        else if(failure==='review')throw original;
        const result=await review(value);
        if(reviews===2&&failure==='attestation')result.reviews.at(-1).complete=false;
        return result;
      };
    },
    proofCheckpoint:async value=>{
      callbacks++;checkpoint=value;
      assert.equal(value.authority,false);assert.deepEqual(value.sourceBinding,sourceBinding);
      const ledger=readLedger({root:path.join(value.directory,'ledger'),expectedManifestHash:value.ledgerManifestHash});
      assert.deepEqual(ledger.entries.map(entry=>entry.key).sort(),completedKeys);
      assert.equal(ledger.entries.length,16);
      await encryptNativeSnapshotRecovery({directory:value.directory,outputFile,recipientPublicKey:recoveryPublicKey,
        sourceCommit:value.sourceBinding.sourceCommit,sourceBinding:value.sourceBinding,ledgerManifestHash:value.ledgerManifestHash,phase:'native-proofs'});
    },
    eventCompiler:async()=>assert.fail('verification failure must not compile'),
    publishPointer:async()=>assert.fail('verification failure must not publish')};
  await assert.rejects(runNativeSnapshotPhase(options),error=>{
    if(['review','engine'].includes(failure))assert.equal(error,original);
    else assert.match(error.message,failure==='attestation'?/current review attestation/:/result binding/);
    return true;
  });
  assert.equal(callbacks,1);assert.equal(f.calls.length,2);assert(checkpoint);
  const after=await inventory(f.root);delete after['proofs.ptenc'];assert.deepEqual(after,before);
  const receipt=await read(checkpoint.directory,'receipt.json');assert.equal(receipt.authority,false);
  assert.deepEqual(receipt.sourceBinding,sourceBinding);
  assert.equal(receipt.previousLedgerManifestHash,(await read(f.root,'verification-ledger-current.json')).manifestHash);
  const decoded=decryptRoutineRecovery(await fs.readFile(outputFile));
  assert.deepEqual(decoded.header.sourceBinding,sourceBinding);
  assert(decoded.records.some(row=>row.path==='ledger/manifest.json'));
  const overlay=await runNativeSnapshotPhase({...f.options,reuseOnly:true,
    proofCheckpoint:async()=>assert.fail('private evidence must not become authority')});
  assert.equal(overlay.counts.storedProofs,0);assert.equal(f.calls.length,2);
  assert((await read(f.directory,`tracks/${track}.json`)).entries.every(row=>row.runVerified===false));
});

for(const failure of ['copy','callback'])test('later verification error survives checkpoint '+failure+' failure',async t=>{
  const f=await multiBatchFixture(t),before=await inventory(f.root),original=Error('original later review failure');
  let reviews=0,callbacks=0;
  if(failure==='copy'){
    const copy=fs.copyFile;
    t.mock.method(fs,'copyFile',async(from,to)=>{
      if(to.includes('native-proof-checkpoints'))throw Error('checkpoint copy failed');
      return copy(from,to);
    });
  }
  await assert.rejects(runNativeSnapshotPhase({...f.options,
    reviewFactory:async context=>{
      const review=await f.options.reviewFactory(context);
      return async value=>{if(++reviews===2)throw original;return review(value);};
    },
    proofCheckpoint:async()=>{callbacks++;throw Error('checkpoint encryption failed');},
    eventCompiler:async()=>assert.fail('verification failure must not compile')}),error=>error===original);
  assert.equal(callbacks,failure==='copy'?0:1);assert.deepEqual(await inventory(f.root),before);
  const parent=path.join(f.root,'local-reports/native-proof-checkpoints'),names=await fs.readdir(parent);
  assert.equal(names.length,failure==='copy'?0:1);
  if(names.length)assert.equal((await read(path.join(parent,names[0]),'receipt.json')).authority,false);
});

test('failure before a completed batch does not checkpoint the unchanged temporary ledger',async t=>{
  const f=await fixture(t),before=await inventory(f.root),original=Error('first review failed');
  await assert.rejects(runNativeSnapshotPhase({...f.options,
    reviewFactory:async()=>{throw original;},
    proofCheckpoint:async()=>assert.fail('no completed proof to checkpoint')}),error=>error===original);
  assert.deepEqual(await inventory(f.root),before);
  await assert.rejects(fs.stat(path.join(f.root,'local-reports/native-proof-checkpoints')),error=>error.code==='ENOENT');
});

for(const stage of ['eventCompiler','rebuild','buildProfiles','publishPointer'])test('completed private proofs survive '+stage+' failure without advancing authority',async t=>{
  const f=await fixture(t),before=await inventory(f.root),outputFile=path.join(f.root,'proofs.ptenc');
  let checkpoint,callbacks=0;
  await assert.rejects(runNativeSnapshotPhase({...f.options,[stage]:async()=>{throw Error('injected '+stage);},
    proofCheckpoint:async value=>{
      callbacks++;checkpoint=value;
      assert.equal(value.authority,false);assert.equal(value.sourceBinding.sourceCommit,f.options.sourceCommit);
      assert.equal((await read(f.root,'verification-ledger-current.json')).manifestHash,value.previousLedgerManifestHash);
      assert.equal(readLedger({root:path.join(value.directory,'ledger'),expectedManifestHash:value.ledgerManifestHash}).entries.length,1);
      await encryptNativeSnapshotRecovery({directory:value.directory,outputFile,recipientPublicKey:recoveryPublicKey,
        sourceCommit:value.sourceBinding.sourceCommit,sourceBinding:value.sourceBinding,ledgerManifestHash:value.ledgerManifestHash,phase:'native-proofs'});
    }}),new RegExp('injected '+stage));
  assert.equal(f.calls.length,1);assert.equal(callbacks,1);assert(checkpoint);
  const after=await inventory(f.root);delete after['proofs.ptenc'];assert.deepEqual(after,before);
  const retained=await read(checkpoint.directory,'receipt.json');assert.equal(retained.authority,false);
  assert.equal(retained.ledgerManifestHash,checkpoint.ledgerManifestHash);
  const evidenceBytes=await fs.readFile(path.join(checkpoint.directory,retained.evidenceFile));
  assert.equal(sha(evidenceBytes),retained.evidenceSha256);
  const evidence=JSON.parse(evidenceBytes);
  assert.equal(evidence.authority,false);assert.equal(evidence.ledger,undefined);
  assert.deepEqual(evidence.sourceBinding,retained.sourceBinding);
  assert.equal(evidence.decisions.length,evidence.counts.known);
  assert.equal(evidence.scoringPreflight.sourceSha256,sha('fixture scoring inputs'));
  assert(!evidenceBytes.includes(Buffer.from('"replay":')));
  const decoded=decryptRoutineRecovery(await fs.readFile(outputFile));
  assert.equal(decoded.header.attempt,'routine-capture');assert.deepEqual(decoded.header.sourceBinding,checkpoint.sourceBinding);
  assert(decoded.records.some(row=>row.path==='ledger/manifest.json'));assert(decoded.records.some(row=>row.path==='receipt.json'));
  const files=await nativeLedgerPublicationFiles(f.root);assert(files.every(file=>!file.includes('local-reports')));
});

test('private checkpoint failure stops compilation and leaves existing authority unchanged',async t=>{
  const f=await fixture(t),before=await inventory(f.root);let compiled=false;
  await assert.rejects(runNativeSnapshotPhase({...f.options,proofCheckpoint:async()=>{throw Error('checkpoint encryption failed');},
    eventCompiler:async()=>{compiled=true;}}),/checkpoint encryption failed/);
  assert.equal(compiled,false);assert.deepEqual(await inventory(f.root),before);
  const parent=path.join(f.root,'local-reports/native-proof-checkpoints'),names=await fs.readdir(parent);
  assert.equal(names.length,1);assert.equal((await read(path.join(parent,names[0]),'receipt.json')).authority,false);
});

test('private completed proofs are not silently reused as authority by a later stored overlay',async t=>{
  const f=await fixture(t);
  await assert.rejects(runNativeSnapshotPhase({...f.options,rebuild:async()=>{throw Error('compile failed');}}),/compile failed/);
  const result=await runNativeSnapshotPhase({...f.options,reuseOnly:true,verify:async()=>assert.fail('stored overlay cannot simulate')});
  assert.equal(result.counts.storedProofs,0);assert.equal((await read(f.directory,`tracks/${track}.json`)).entries[0].runVerified,false);
  assert.equal(f.calls.length,1);
});

test('routine capture envelope decrypts exactly, authenticates its binding, and never overwrites ciphertext',async t=>{
  const f=await fixture(t),outputFile=path.join(f.root,'capture.ptenc');
  const options={directory:f.directory,outputFile,recipientPublicKey:recoveryPublicKey,sourceCommit:f.options.sourceCommit};
  const result=await encryptNativeSnapshotRecovery(options),bytes=await fs.readFile(outputFile),decoded=decryptRoutineRecovery(bytes);
  assert.equal(result.ciphertextSha256,sha(bytes));assert.equal(decoded.header.sourceCommit,f.options.sourceCommit);
  assert.equal(bytes.includes(Buffer.from('"recording"')),false);assert.equal(decoded.header.phase,'pre-native');
  assert.equal(decoded.header.attempt,'routine-capture','routine capture must not impersonate repair-2');
  for(const record of decoded.records)assert((await fs.readFile(path.join(f.directory,record.path))).equals(Buffer.from(record.data,'base64')));
  await assert.rejects(encryptNativeSnapshotRecovery(options),/EEXIST/);assert((await fs.readFile(outputFile)).equals(bytes));
  const changed=Buffer.from(bytes);changed[changed.length-17]^=1;assert.throws(()=>decryptRoutineRecovery(changed));
  const headerChanged=Buffer.from(bytes),offset=headerChanged.indexOf(Buffer.from(f.options.sourceCommit));headerChanged[offset]=0x62;
  assert.throws(()=>decryptRoutineRecovery(headerChanged));
  for(const patch of [{sourceCommit:'main'},{recipientPublicKey:recoveryKeys.privateKey.export({type:'pkcs8',format:'pem'})},
    {phase:'native-proofs',sourceBinding:{sourceCommit:'b'.repeat(40),captureSha256:'c'.repeat(64)},ledgerManifestHash:'d'.repeat(64)}])
    await assert.rejects(encryptNativeSnapshotRecovery({...options,outputFile:path.join(f.root,'invalid.ptenc'),...patch}));
  await fs.writeFile(path.join(f.directory,'private-key.pem'),'must never leave runner');
  await assert.rejects(encryptNativeSnapshotRecovery({...options,outputFile:path.join(f.root,'unsafe.ptenc')}),/safe boundary/);
  assert.equal(await fs.stat(path.join(f.root,'unsafe.ptenc')).then(()=>true,()=>false),false);
});


test('native completion is recorded once before compilation and survives a later packaging error',async t=>{
  const f=await fixture(t),before=await inventory(f.root);let completion,calls=0;
  await assert.rejects(runNativeSnapshotPhase({...f.options,
    nativeCompleted:async receipt=>{calls++;completion=receipt;assert.equal(receipt.kind,'completed-in-process-native-verification');assert.equal(receipt.authority,false);},
    eventCompiler:async()=>{assert(completion);throw Error('packaging failed after native completion');}}),/packaging failed after native completion/);
  assert.equal(calls,1);assert.equal(f.calls.length,1);assert.equal(completion.counts.nativeDispatched,1);
  assert.equal(completion.sourceBinding.sourceCommit,f.options.sourceCommit);assert.equal(completion.verificationComplete,true);
  assert.equal(completion.privateProofCheckpoint.ledgerManifestHash,completion.ledgerManifestHash);
  assert.deepEqual(await inventory(f.root),before);
});

test('a failed completion recorder prevents compilation without hiding the original error',async t=>{
  const f=await fixture(t),before=await inventory(f.root),error=Error('completion disk full');let compiled=false;
  await assert.rejects(runNativeSnapshotPhase({...f.options,nativeCompleted:async()=>{throw error;},
    eventCompiler:async()=>{compiled=true;}}),actual=>actual===error);
  assert.equal(compiled,false);assert.equal(f.calls.length,1);assert.deepEqual(await inventory(f.root),before);
});

test('interrupted verification never calls the completed-verification recorder',async t=>{
  const f=await fixture(t),error=Error('review failed before completion');
  await assert.rejects(runNativeSnapshotPhase({...f.options,reviewFactory:async()=>{throw error;},
    nativeCompleted:async()=>assert.fail('interrupted work is not completion')}),actual=>actual===error);
});

test('a returned bounded pass records unavailable decisions honestly',async t=>{
  const f=await fixture(t);let completion;
  const result=await runNativeSnapshotPhase({...f.options,buildPolicy:async()=>({...structuredClone(policy),knownTrackIds:[]}),
    nativeCompleted:async receipt=>{completion=receipt;}});
  assert.equal(completion.verificationComplete,false);assert.equal(completion.counts.unavailable,1);
  assert.equal(completion.counts.nativeDispatched,0);assert.equal(f.calls.length,0);assert.equal(result.complete,false);
});

test('stored overlays and malformed callbacks cannot mint native completion',async t=>{
  for(const value of [()=>{},'callback']){
    const f=await fixture(t),before=await inventory(f.root);
    await assert.rejects(runNativeSnapshotPhase({...f.options,reuseOnly:true,nativeCompleted:value}),/native completion capability/);
    assert.equal(f.calls.length,0);assert.deepEqual(await inventory(f.root),before);
  }
});


test('completed receipt survives encrypted proof backup failure without allowing compilation',async t=>{
  const f=await fixture(t),before=await inventory(f.root);let completed,compiled=false;
  await assert.rejects(runNativeSnapshotPhase({...f.options,nativeCompleted:async receipt=>{completed=receipt;},
    proofCheckpoint:async checkpoint=>{assert(completed);assert.equal(completed.privateProofCheckpoint.directory,checkpoint.directory);throw Error('encrypted backup unavailable');},
    eventCompiler:async()=>{compiled=true;}}),/encrypted backup unavailable/);
  assert.equal(compiled,false);assert.equal(f.calls.length,1);assert.equal(completed.counts.nativeDispatched,1);
  assert.equal((await read(completed.privateProofCheckpoint.directory,'receipt.json')).ledgerManifestHash,completed.ledgerManifestHash);
  assert.deepEqual(await inventory(f.root),before);
});

test('completed batches checkpoint before a later interruption without promoting private evidence',async t=>{
 const f=await multiBatchFixture(t),failure=Error('second batch stopped');let checkpoints=0,progress,reviews=0;
 await assert.rejects(runNativeSnapshotPhase({...f.options,reviewFactory:async context=>{const review=await f.options.reviewFactory(context);return async value=>{if(++reviews===2)throw failure;return review(value);};},
 progressCheckpoint:async value=>{checkpoints++;progress=value;assert.equal(value.sequence,1);assert.equal(value.authority,false);const proof=readLedger({root:path.join(value.directory,'ledger'),expectedManifestHash:value.ledgerManifestHash});assert.equal(proof.entries.length,16);}}),actual=>actual===failure);
 assert.equal(checkpoints,1);assert.equal((await read(progress.directory,'receipt.json')).authority,false);
 assert.equal(readLedger({root:path.join(f.root,'verification-ledger'),expectedManifestHash:(await read(f.root,'verification-ledger-current.json')).manifestHash}).entries.length,0);
});
test('unchanged stored proofs do not copy progress checkpoints',async t=>{
 const f=await fixture(t);await runNativeSnapshotPhase(f.options);await runNativeSnapshotPhase({...f.options,progressCheckpoint:async()=>assert.fail('no changed ledger')});
});

 test('live native cache pins retain exact approved bytes, never serialized, mutated or differently bound evidence',async t=>{
  const f=await fixture(t);await runNativeSnapshotPhase(f.options);
  const unpinned=await prepareNativeSnapshotCapture(f.options);
  assert.equal(await pinRetainedNativeBoards({context:unpinned,directory:f.directory,root:f.root}),0);
  await publishSnapshot({root:f.root,stagingDirectory:f.directory});
  const decoded=path.join(f.root,'trusted-hydrate');await fs.mkdir(decoded);await hydrateStaging(f.root,decoded);
  const context=await prepareNativeSnapshotCapture({...f.options,directory:decoded}),bytes=await fs.readFile(path.join(f.directory,'tracks/'+track+'.json')),board=JSON.parse(bytes);
  const matches=(ctx=context,raw=bytes,authority=context.sourceManifest.nativeVerificationLedger)=>retainedNativeBoardMatches({context:ctx,authority,board,bytes:raw});
  assert.equal(matches(),true);assert.equal(matches({...context}),false);
  assert.equal(matches(context,Buffer.concat([bytes,Buffer.from(' ')])),false);
  assert.equal(matches(context,bytes,{manifestHash:'0'.repeat(64)}),false);
  const altered={...context,canonicalRows:context.canonicalRows.map(row=>({...row,timeMs:row.timeMs+1}))};
  assert.equal(await pinRetainedNativeBoards({context:altered,directory:f.directory,root:f.root}),0);assert.equal(matches(altered),false);
  await write(f.directory,'recordings/1.json',{recording:'wrong replay'});
  const corrupt={...context};assert.equal(await pinRetainedNativeBoards({context:corrupt,directory:f.directory,root:f.root}),0);assert.equal(matches(corrupt),false);
 });

test('phase proof-only mode cannot dispatch physics or manufacture a new approval',async t=>{const f=await fixture(t),result=await runNativeSnapshotPhase({...f.options,allowNativeDispatch:false,verify:()=>assert.fail('physics is forbidden')});assert.equal(result.backendReads,0);assert.equal(result.backendWrites,0);assert.equal(result.counts.nativeDispatched,0);assert.equal(result.counts.unprocessed,1);assert.equal(result.complete,false);assert.equal((await read(f.directory,'tracks/'+track+'.json')).entries[0].runVerified,false);});
