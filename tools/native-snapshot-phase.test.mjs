import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import {prepareNativeSnapshotCapture,runNativeSnapshotPhase} from './native-snapshot-phase.mjs';
import {ledgerBinding,ledgerKey,writeLedger} from './native-verification-ledger.mjs';
import {nativeLedgerPublicationFiles} from './verifier/local-snapshot-verification.mjs';
import {PERMANENT_ROLLING_HILLS} from '../workers/ranked/src/permanent-rolling-hills.js';
import {applyNativeLedgerToCapturedTracks} from './public-snapshot-backup.mjs';
import {publishSnapshot} from './snapshot-package.mjs';
import {hydrateStaging} from './update-public-snapshot.mjs';
import {nativeEventSourceHash} from './native-event-snapshot.mjs';

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

test('stored proofs overlay without new native work or changing server verification authority',async t=>{
  const f=await fixture(t);await runNativeSnapshotPhase(f.options);
  const pointer=await read(f.root,'verification-ledger-current.json');
  const before=await fs.readFile(path.join(f.root,'verification-ledger/manifest.json'));
  let attempted=false;
  const result=await runNativeSnapshotPhase({...f.options,reuseOnly:true,
    verify:async()=>{attempted=true;throw Error('Stored overlays cannot run physics');},
    reviewFactory:async()=>{throw Error('Stored overlays cannot mint new review attestations');}});
  assert.equal(attempted,false);assert.equal(result.authority,'stored-proof-overlay');
  assert.equal(result.counts.nativeDispatched,0);assert.equal(result.counts.newProofs,0);
  assert.equal(result.backendReads,0);assert.equal(result.backendWrites,0);
  assert.equal((await read(f.directory,`tracks/${track}.json`)).entries[0].runVerified,true);
  assert.deepEqual(await read(f.root,'verification-ledger-current.json'),pointer);
  assert.deepEqual(await fs.readFile(path.join(f.root,'verification-ledger/manifest.json')),before);
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

test('a hash-valid companion cannot smuggle private fields through cold hydration',async t=>{
  const f=await fixture(t,{events:true});await runNativeSnapshotPhase(f.options);
  const manifest=await read(f.directory,'manifest.json'),old=manifest.nativeEventSources.day1;
  const companion=await read(f.directory,'native-event-source/'+old+'.json');companion.board.privateCredential='not public';
  const bytes=Buffer.from(JSON.stringify(companion)+'\n'),pin=sha(bytes);
  await fs.writeFile(path.join(f.directory,'native-event-source',pin+'.json'),bytes);
  manifest.nativeEventSources.day1=pin;await write(f.directory,'manifest.json',manifest);
  await assert.rejects(prepareNativeSnapshotCapture(f.options),/companion identity\/schema/);
});
