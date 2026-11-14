import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {repairPreparedLocalArchives,localCaptureSourceStages} from './local-capture-worker.mjs';
import {ARCHIVE_REPAIR_NOT_BEFORE} from './local-archive-replay-repair.mjs';
async function fixture(t){
  t.mock.method(globalThis,'fetch',()=>assert.fail('Offline fixtures only'));
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'local-archive-worker-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  await fs.mkdir(path.join(directory,'events'));const periodId='d_20260913',trackId='b'.repeat(64);
  const targets=Array.from({length:12},(_,i)=>({periodId,trackId,accountId:(i+1).toString(16).padStart(64,'0'),timeMs:1000}));
  await fs.writeFile(path.join(directory,'events',periodId+'.json'),JSON.stringify({id:periodId,period:{id:periodId,trackId},archived:true,entries:targets}));
  await fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify({schemaVersion:1,events:{[periodId]:{path:'events/'+periodId+'.json'}}}));
  const file=path.join(directory,'plan.json'),bytes=JSON.stringify({schemaVersion:1,targets});await fs.writeFile(file,bytes);
  const receipt={archiveReplayRepair:{file,sha256:createHash('sha256').update(bytes).digest('hex'),maxDocuments:12}};
  let connects=0,gets=0;const db={get:async(collection,id)=>{gets++;return {data:{collection,id}};},documentBudget:()=>({usedReads:gets,usedWrites:0}),writeAttempts:()=>0};
  const options={receipt,directory,now:()=>ARCHIVE_REPAIR_NOT_BEFORE,connectImpl:async(raw,options)=>{connects++;assert.deepEqual(options,{env:{},mode:'scheduled',documentReadLimit:12,documentWriteLimit:1,maxReadRetries:0});return db;},repair:async({getDocument})=>{for(const t of targets)await getDocument('0.6.2_event_replays',t.periodId+'_'+t.accountId);return {recovered:12};}};
  return {options,targets,db,connects:()=>connects,gets:()=>gets};
}
test('optional absent archive plan costs no auth or reads',async()=>assert.equal(await repairPreparedLocalArchives({receipt:{},connectImpl:()=>assert.fail('No auth')}),null));
test('prepared archive recovery passes zero-retry bounded auth and only exact GETs',async t=>{const f=await fixture(t);assert.equal((await repairPreparedLocalArchives(f.options)).recovered,12);assert.equal(f.connects(),1);assert.equal(f.gets(),12);});
test('pre-reset and changed plan fail before authentication',async t=>{const f=await fixture(t);await assert.rejects(repairPreparedLocalArchives({...f.options,now:()=>ARCHIVE_REPAIR_NOT_BEFORE-1}),/before reset/);f.options.receipt.archiveReplayRepair.sha256='0'.repeat(64);await assert.rejects(repairPreparedLocalArchives(f.options),/fingerprint/);assert.equal(f.connects(),0);});
test('wrong collection, duplicate and unplanned documents never reach storage',async t=>{for(const kind of ['collection','duplicate','unknown']){const f=await fixture(t),id=f.targets[0].periodId+'_'+f.targets[0].accountId;await assert.rejects(repairPreparedLocalArchives({...f.options,repair:async({getDocument})=>{if(kind==='duplicate')await getDocument('0.6.2_event_replays',id);return getDocument(kind==='collection'?'other':'0.6.2_event_replays',kind==='unknown'?'bad':id);}}),/boundary/);assert.equal(f.gets(),kind==='duplicate'?1:0);}});
test('missing or failed document closes the storage capability',async t=>{const f=await fixture(t);f.db.get=async()=>{throw Error('quota');};await assert.rejects(repairPreparedLocalArchives({...f.options,repair:async({getDocument})=>{const id=f.targets[0].periodId+'_'+f.targets[0].accountId;await assert.rejects(getDocument('0.6.2_event_replays',id),/quota/);return getDocument('0.6.2_event_replays',f.targets[1].periodId+'_'+f.targets[1].accountId);}}),/boundary/);});
test('prior proof context and complete canonical source precede Worker backup and archive recovery',async()=>{
 const source=await fs.readFile(new URL('./local-capture-worker.mjs',import.meta.url),'utf8');
 const prior=source.indexOf('const priorContext=await prepareNativeSnapshotCapture'),canonical=source.indexOf('const full=await captureLocalCompleteSources'),opened=source.indexOf('const fullCanonicalSource=await openFullCanonicalTrackSource'),updater=source.indexOf('const result=await updatePublicSnapshot('),backup=source.indexOf('const backup=reused?.manifest||await runLocalSnapshotBackup'),repair=source.indexOf('await repairPreparedLocalArchives',backup);
 assert(prior>=0&&canonical>prior&&opened>canonical&&updater>opened&&backup>updater&&repair>backup);
 assert(source.includes('prepareNativeCapture:()=>priorContext'));
 assert(source.includes("verificationAuthority:captureOnly?'firestore':'snapshot-native'"));
 assert(source.includes('nativePhase:captureOnly?runNativeSnapshotPhase:createLocalNativePhaseReceipt'));
 assert(source.includes('...(captureOnly?{}:{nativeCompleted:createLocalNativeVerificationCompletion'));
});

test('a wrapped local backup keeps authenticated Overall, Event RP totals and local calculation stages',async()=>{
 const {captureOverallProjection}=await import('./capture-overall-projection.mjs');
 const {capturePublicEventTotals}=await import('./public-event-totals-backup.mjs');
 const {rebuildSnapshotOverall}=await import('./rebuild-snapshot-overall.mjs');
 assert.deepEqual(localCaptureSourceStages(),{captureOverall:captureOverallProjection,captureTotals:capturePublicEventTotals,calculateOverall:rebuildSnapshotOverall});
 const calls=[],options=localCaptureSourceStages({captureOverall:async()=>calls.push('overall'),captureTotals:async()=>calls.push('event-totals'),calculateOverall:async()=>calls.push('calculation')});
 for(const stage of Object.values(options))await stage();assert.deepEqual(calls,['overall','event-totals','calculation']);
 for(const key of Object.keys(options))assert.throws(()=>localCaptureSourceStages({[key]:null}),/source stages/);
 const source=await fs.readFile(new URL('./local-capture-worker.mjs',import.meta.url),'utf8');
 assert.ok(source.includes('updatePublicSnapshot({...localCaptureSourceStages()'));
});

import {captureLocalCompleteSources} from './local-capture-worker.mjs';
const fullPolicy={version:1,authorized:true,canonicalMode:'full',canonicalDocumentLimit:10000,profileDocumentLimit:2000,trackCheckLimit:512,eventReplayLimit:256,publishedBaseline:{generation:75,indexSha256:'a'.repeat(64)}};
async function sourceFixture(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'local-full-source-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const summaryFile=path.join(directory,'public-export-summary.json');await fs.writeFile(summaryFile,JSON.stringify({profilesCapturedAt:'2026-11-06T13:46:56.523Z',keep:true}));const calls=[],point='2026-11-07T08:05:00.000Z';let transportCalls=0;return {directory,summaryFile,calls,transportCalls:()=>transportCalls,options:{policy:fullPolicy,directory,checkpointDirectory:directory,serviceAccount:'synthetic-only',captureJob:async()=>({status:'synthetic'}),connectImpl:async(_credential,options)=>{calls.push('connect');assert.deepEqual(options,{env:{},mode:'scheduled',documentReadLimit:12001,documentWriteLimit:1,maxReadRetries:0});return {call:async()=>transportCalls++,writeAttempts:()=>0,documentBudget:()=>({usedReads:1,usedWrites:0})};},captureCanonical:async({db,documentLimit})=>{calls.push('canonical');assert.equal(documentLimit,10000);await db.call(':runQuery',{structuredQuery:{from:[{collectionId:'0.6.2_race_results'}],limit:1}});return {complete:true,imported:true,scanInconsistency:false,fullScanReadPoint:point};},captureProfiles:async({since,readTime,maxDocuments})=>{calls.push('profiles');assert.equal(since,Date.parse('2026-11-06T13:46:56.523Z'));assert.equal(readTime,point);assert.equal(maxDocuments,2000);return {complete:true,readTime:point};}}};}
test('full local source capture freezes profiles at the canonical point and advances watermark only after both complete',async t=>{const f=await sourceFixture(t);const report=await captureLocalCompleteSources(f.options);assert.deepEqual(f.calls,['connect','canonical','profiles']);assert.equal(report.backendWrites,0);const summary=JSON.parse(await fs.readFile(f.summaryFile,'utf8'));assert.equal(summary.keep,true);assert.equal(summary.profilesCapturedAt,'2026-11-07T08:05:00.000Z');});
test('invalid saved profile watermark fails before credentials or database access',async t=>{const f=await sourceFixture(t);await fs.writeFile(f.summaryFile,'{}');await assert.rejects(captureLocalCompleteSources(f.options),/watermark/);assert.deepEqual(f.calls,[]);});
test('incomplete canonical scan never starts profiles or advances any watermark',async t=>{const f=await sourceFixture(t),before=await fs.readFile(f.summaryFile,'utf8');await assert.rejects(captureLocalCompleteSources({...f.options,captureCanonical:async()=>({complete:false,imported:false})}),/incomplete/);assert.deepEqual(f.calls,['connect']);assert.equal(await fs.readFile(f.summaryFile,'utf8'),before);});
test('the connected full-source capability cannot write to Firebase',async t=>{const f=await sourceFixture(t);await assert.rejects(captureLocalCompleteSources({...f.options,captureCanonical:async({db})=>db.call(':commit',{writes:[]})}),/forbids/);assert.equal(f.transportCalls(),0);});

test('local canonical capture disables the later duplicate replay-export branch',async()=>{
  const source=await fs.readFile(new URL('./local-capture-worker.mjs',import.meta.url),'utf8');
  const start=source.indexOf('const result=await updatePublicSnapshot('),end=source.indexOf('if(aborted)throw',start);
  assert(start>=0&&end>start);const caller=source.slice(start,end);
  assert.match(caller,/root,refreshReplays:false,replayDocumentLimit:null/);
  assert.doesNotMatch(caller,/fullPublic\s*:\s*true|refreshReplays\s*:\s*true/);
  assert.equal((source.match(/await captureLocalCompleteSources\(/g)||[]).length,1);
  assert.equal(caller.includes('await captureLocalCompleteSources('),false,'no duplicate full scan in backup callback');
  const updater=await fs.readFile(new URL('./update-public-snapshot.mjs',import.meta.url),'utf8');
  assert.match(updater,/export async function updatePublicSnapshot\(\{[^\n]*fullPublic = false, refreshReplays = false/);
  const capture=updater.indexOf('backupResult=await capture('),exports=updater.indexOf('if (!offline && (fullPublic || refreshReplays))'),checkpoint=updater.indexOf('await captureCheckpoint(');
  assert(capture>=0&&exports>capture&&checkpoint>exports,'the disabled export branch follows complete canonical capture');
});

// Exercise the production callback bodies without entering credential admission.
test('scoring preflight validates offline before checkpoint and preserves the exact input',async()=>{
  const source=await fs.readFile(new URL('./local-capture-worker.mjs',import.meta.url),'utf8');
  const match=/captureCheckpoint:async input=>\{([\s\S]*?)\n\s*\},\s*capture:/.exec(source);
  assert(match,'production scoring checkpoint callback must remain explicit');
  const events=[],input={directory:'synthetic-staging',sourceCommit:'a'.repeat(40)};
  const callback=Function('rebuildSnapshotOverall','checkpoint','return async input=>{'+match[1]+'}')(async options=>{
    events.push('validate');assert.deepEqual(options,{directory:input.directory,validateOnly:true});
    return {additionalFirestoreReads:0,additionalFirestoreWrites:0};
  },async actual=>{events.push('checkpoint');assert.equal(actual,input);});
  await callback(input);assert.deepEqual(events,['validate','checkpoint']);
});

for(const mode of ['reads','writes','missing-counters','validation-failure'])
test('scoring checkpoint fails closed before persistence: '+mode,async()=>{
  const source=await fs.readFile(new URL('./local-capture-worker.mjs',import.meta.url),'utf8');
  const match=/captureCheckpoint:async input=>\{([\s\S]*?)\n\s*\},\s*capture:/.exec(source);assert(match);
  let validations=0,checkpoints=0;
  const callback=Function('rebuildSnapshotOverall','checkpoint','return async input=>{'+match[1]+'}')(async()=>{
    validations++;if(mode==='validation-failure')throw Error('fixture scoring rejection');
    return mode==='missing-counters'?{}:{additionalFirestoreReads:Number(mode==='reads'),additionalFirestoreWrites:Number(mode==='writes')};
  },async()=>{checkpoints++;});
  await assert.rejects(callback({directory:'synthetic'}),mode==='validation-failure'?/scoring rejection/:/preflight used backend/);
  assert.equal(validations,1);assert.equal(checkpoints,0);
});

for(const mode of ['fresh','reused','deferred'])test('backup callback executes source stages once in order: '+mode,async()=>{
  const source=await fs.readFile(new URL('./local-capture-worker.mjs',import.meta.url),'utf8');
  const match=/capture:async options=>\{([\s\S]*?return backup;)\},\s*nativePhase:/.exec(source);assert(match);
  const events=[],manifest={deferred:mode==='deferred',marker:'fixture'},capturedCanonical={readTime:'frozen-point'};
  const callback=Function('reused','runLocalSnapshotBackup','repairPreparedLocalArchives','captureLocalCompleteSources',
    'console','receipt','staging','fullPolicy','directory','capturedCanonical','capturedProfiles','process','fullCanonicalSource',
    'return async options=>{'+match[1]+'}')(
    mode==='reused'?{manifest,summary:{}}:null,
    async options=>{events.push('backup');assert.deepEqual(options,{marker:'options',fullCanonicalSource:'bound-source'});return manifest;},
    async()=>{events.push('repair');return null;},
    async options=>{events.push('canonical');assert.equal(options.capturedCanonical,capturedCanonical);return {complete:true};},
    {log:()=>{}},{},'synthetic-staging',fullPolicy,'synthetic-private',capturedCanonical,null,{env:{}},'bound-source');
  assert.equal(await callback({marker:'options'}),manifest);
  assert.deepEqual(events,mode==='deferred'?['backup']:mode==='reused'?['repair']:['backup','repair']);
});

import {assertLocalStagingBase} from './local-capture-worker.mjs';
test('stale or missing prepared base stops before acquiring current data',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'capture-base-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'local-reports/snapshot-staging'),{recursive:true});await fs.mkdir(path.join(root,'public-snapshots81'));
 const bytes=Buffer.from('{"generation":81}');await fs.writeFile(path.join(root,'public-snapshots81/index.json'),bytes);await fs.writeFile(path.join(root,'snapshot-current.json'),JSON.stringify({currentdir:'public-snapshots81'}));
 const base=path.join(root,'local-reports/snapshot-staging-base.json'),publishedBaseline={generation:81,indexSha256:createHash('sha256').update(bytes).digest('hex')};
 await assert.rejects(assertLocalStagingBase({root,publishedBaseline}),/ENOENT/);
 await fs.writeFile(base,JSON.stringify({schemaVersion:1,generation:80}));await assert.rejects(assertLocalStagingBase({root,publishedBaseline}),/base changed/);
 await fs.writeFile(base,JSON.stringify({schemaVersion:1,generation:81}));await assertLocalStagingBase({root,publishedBaseline});
 await fs.appendFile(path.join(root,'public-snapshots81/index.json'),' ');await assert.rejects(assertLocalStagingBase({root,publishedBaseline}),/baseline changed/);
 const source=await fs.readFile(new URL('./local-capture-worker.mjs',import.meta.url),'utf8');assert(source.indexOf('await assertLocalStagingBase(')<source.indexOf('process.env.FIREBASE_VERIFIER_SERVICE_ACCOUNT=await fs.readFile'));
});
