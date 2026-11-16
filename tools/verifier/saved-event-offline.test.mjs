import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {savedEventDispatchPlan} from './saved-event-offline-plan.mjs';
import {savedEventWorkflowConfig,runSavedEventVerification} from './verify-saved-events.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const pins={sourceCommit:'a'.repeat(40),generation:84,indexSha256:sha('index'),ledgerManifestHash:sha('ledger'),ledgerEntries:19391};
const environment=()=>({SNAPSHOT_SOURCE_COMMIT:pins.sourceCommit,SNAPSHOT_GENERATION:'84',SNAPSHOT_INDEX_SHA256:pins.indexSha256,
 LEDGER_MANIFEST_SHA256:pins.ledgerManifestHash,LEDGER_ENTRIES:'19391',NATIVE_JOB_LIMIT:'64',GITHUB_RUN_ATTEMPT:'1',EXPECTED_SOURCE_COMMIT:'b'.repeat(40)});
test('saved dispatch plan pins existing public artifacts and never creates an unbounded or repeated budget',()=>{
 const p=savedEventDispatchPlan(pins);assert.equal(p.targetScope,'events');assert.equal(p.maxJobs,64);assert.equal(p.maxRuntimeMs,480000);
 assert.equal(p.backendWrites,0);assert.equal(p.capture,false);assert.equal(p.publish,false);assert.equal(p.standard.wallMs,45000);
 assert.equal(p.extended.wallMs,120000);assert.equal(p.batchSize,16);
 assert.equal(savedEventDispatchPlan({...pins,maxJobs:512}).maxRuntimeMs,480000);
 assert.equal(savedEventDispatchPlan({...pins,maxJobs:512}).maxJobs,512);
 assert.equal(savedEventDispatchPlan({...pins,maxJobs:1}).maxJobs,1);
 for(const change of [{sourceCommit:'main'},{indexSha256:'bad'},{ledgerManifestHash:'bad'},{maxJobs:100000},{runAttempt:2}])
  assert.throws(()=>savedEventDispatchPlan({...pins,...change}));
 assert.throws(()=>savedEventWorkflowConfig({...environment(),GITHUB_RUN_ATTEMPT:'2'}),/first attempt/);
});

test('saved executor admits only an explicit unique exact track list and preserves defaults',()=>{
 const ids=['b'.repeat(64),'a'.repeat(64)],env=environment();
 assert.equal(Object.hasOwn(savedEventWorkflowConfig(env).plan,'targetTrackIds'),false);
 const configured=savedEventWorkflowConfig({...env,TARGET_TRACK_IDS:JSON.stringify(ids)});
 assert.deepEqual(configured.plan.targetTrackIds,[...ids].sort());
 assert.deepEqual(ids,['b'.repeat(64),'a'.repeat(64)]);
 for(const value of [[],null,'all',['main'],[ids[0],ids[0]],Array(513).fill(ids[0])])
  assert.throws(()=>savedEventWorkflowConfig({...env,TARGET_TRACK_IDS:JSON.stringify(value)}),/exact event track IDs/);
 assert.throws(()=>savedEventWorkflowConfig({...env,TARGET_TRACK_IDS:''}),SyntaxError);
 const combined=savedEventWorkflowConfig({...env,TARGET_TRACK_IDS:JSON.stringify(ids),NATIVE_TARGET_SCOPE:'all',WARMUP_FIRST_PROOF:'1'});
 assert.equal(combined.plan.targetScope,'all');assert.equal(combined.warmupFirst,true);
 assert.throws(()=>savedEventWorkflowConfig({...env,NATIVE_TARGET_SCOPE:'all'}),/explicit targets/);
 assert.throws(()=>savedEventWorkflowConfig({...env,NATIVE_TARGET_SCOPE:'normal'}),/explicit targets/);
 assert.equal(savedEventWorkflowConfig({...env,NATIVE_TARGET_SCOPE:'normal',TARGET_TRACK_IDS:JSON.stringify(ids)}).plan.targetScope,'normal');
 assert.throws(()=>savedEventWorkflowConfig({...env,WARMUP_FIRST_PROOF:'yes'}),/warmup mode/);
});

test('runtime selection preserves eight minutes by default and admits only explicit core-compatible twenty-five minutes',()=>{
 const legacy=savedEventWorkflowConfig(environment()).plan;
 assert.equal(legacy.maxRuntimeMs,480000);assert.equal(legacy.maxJobs,64);
 const long=savedEventWorkflowConfig({...environment(),NATIVE_RUNTIME_MINUTES:'25',NATIVE_JOB_LIMIT:'1024'}).plan;
 assert.equal(long.maxRuntimeMs,1500000);assert.equal(long.maxJobs,1024);
 assert.deepEqual(long.standard,legacy.standard);assert.deepEqual(long.extended,legacy.extended);
 assert.equal(savedEventWorkflowConfig({...environment(),NATIVE_RUNTIME_MINUTES:'8'}).plan.maxRuntimeMs,480000);
 for(const value of ['', '0', '8.0', ' 25', '25 ', '30', 'Infinity', '1e9', String(Number.MAX_SAFE_INTEGER),25,null])
  assert.throws(()=>savedEventWorkflowConfig({...environment(),NATIVE_RUNTIME_MINUTES:value}),/bounded native runtime/);
 for(const value of [0,480001,1500001,1800000,Infinity,NaN,'1500000',Number.MAX_SAFE_INTEGER])
  assert.throws(()=>savedEventDispatchPlan({...pins,maxRuntimeMs:value}),/native runtime/);
 assert.throws(()=>savedEventDispatchPlan({...pins,maxJobs:1025}),/bounded first attempt/);
 assert.throws(()=>savedEventWorkflowConfig({...environment(),NATIVE_RUNTIME_MINUTES:'25',GITHUB_RUN_ATTEMPT:'2'}),/first attempt/);
});
test('extended sidecar passes one fixed publication budget, verifies once and preserves negative results',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'saved-event-sidecar-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const env={...environment(),TARGET_TRACK_IDS:JSON.stringify(['a'.repeat(64)]),NATIVE_TARGET_SCOPE:'all',SAVED_VERIFICATION_PRESET:'extended-all',
  NATIVE_RUNTIME_MINUTES:'90',NATIVE_JOB_LIMIT:'10000',WARMUP_FIRST_PROOF:'1'};let verified=0,disposed=0,compiled=0;
 await fs.mkdir(path.join(root,'stage'));await fs.writeFile(path.join(root,'stage/manifest.json'),'{}');
 await fs.mkdir(path.join(root,'events'));await fs.writeFile(path.join(root,'events/public-catalog.json'),'{}');
 await fs.writeFile(path.join(root,'index.html'),'<meta name="polytrack-snapshot" content="./public-snapshots84/">');
 const git=args=>Buffer.from(args[0]==='rev-parse'?env.EXPECTED_SOURCE_COMMIT:args[1].endsWith('/index.json')?'index':'ledger');
 const checkpoints=[];
 const result=await runSavedEventVerification({root,runDirectory:root,env},{git,now:()=>1000000,
  checkpointLog:async record=>{await fs.access(path.join(root,record.kind+'-'+record.sequence+'.json'));checkpoints.push(record);},
  verifyPhase:async input=>{await input.firstProofCheckpoint({privateEvidence:'must-not-appear-in-notice'});await input.progressCheckpoint({privateEvidence:'must-not-appear-in-notice'});},
  prepare:async(options,capabilities)=>{
  assert.equal(options.targetScope,'all');assert.equal(options.maxJobs,10000);assert.equal(options.maxRuntimeMs,5400000);
  assert.equal(options.mode,'postpublication-offline');assert.equal(options.finishDeadlineMs,10000000);assert.equal(options.packagingReserveMs,900000);
  assert.deepEqual(options.targetTrackIds,['a'.repeat(64)]);
  assert.deepEqual(options.publishedBaseline,{generation:84,indexSha256:pins.indexSha256,ledgerManifestHash:pins.ledgerManifestHash,ledgerEntries:19391});
  assert.equal(typeof capabilities.verifyPhase,'function');
  await capabilities.verifyPhase({});
  return {directory:path.join(root,'stage'),receipt:{backendReads:0,backendWrites:0},verify:async()=>{verified++;return {
   receipt:{authority:false,kind:'completed-in-process-native-verification',sourceBinding:{sourceCommit:env.EXPECTED_SOURCE_COMMIT},
    counts:{nativeDispatched:1,mismatch:1},decisions:[{status:'mismatch',reason:'exact_finish_mismatch'}]},
   compile:async()=>{compiled++;return {compilationComplete:true,backendReads:0,backendWrites:0,
    sourceBinding:{sourceCommit:env.EXPECTED_SOURCE_COMMIT}};},dispose:async()=>{disposed++;}};}};},
  replayAudit:async()=>({complete:true}),publishPackage:async options=>{assert.equal(options.root,root);return {directory:'public-snapshots85'};},
  auditPackage:async directory=>{assert.equal(directory,root);return {indexSha256:sha('candidate')};}});
 assert.equal(verified,1);assert.equal(compiled,1);assert.equal(disposed,1);assert.equal(result.nativeReceipt.decisions[0].status,'mismatch');
 assert.equal(result.publicationPerformed,false);assert.equal(result.compilePerformed,true);
 assert.deepEqual(checkpoints,[{kind:'first-proof-pass',sequence:1},{kind:'progress',sequence:2}]);
 assert.ok(!JSON.stringify(checkpoints).includes('privateEvidence'));
 const saved=JSON.parse(await fs.readFile(path.join(root,'event-candidate-complete.json')));assert.equal(saved.authority,false);
 await assert.rejects(runSavedEventVerification({root,runDirectory:root,env:{...env,SNAPSHOT_INDEX_SHA256:'0'.repeat(64)}},{git,prepare:()=>assert.fail('bad source cannot spend physics')}),/artifact pin/);
});
test('compile failure retains the actual live capability; retry never reruns physics or disposes completed proof',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'saved-event-blocked-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'stage'));await fs.writeFile(path.join(root,'stage/manifest.json'),'{}');
 await fs.mkdir(path.join(root,'events'));await fs.writeFile(path.join(root,'events/public-catalog.json'),'{}');
 await fs.writeFile(path.join(root,'index.html'),'<meta name="polytrack-snapshot" content="./public-snapshots84/">');
 const env=environment();let physics=0,compiles=0,disposed=0;
 const git=args=>Buffer.from(args[0]==='rev-parse'?env.EXPECTED_SOURCE_COMMIT:args[1].endsWith('/index.json')?'index':'ledger');
 const blocked=await runSavedEventVerification({root,runDirectory:root,env},{git,prepare:async()=>({directory:path.join(root,'stage'),
  receipt:{backendReads:0,backendWrites:0},verify:async()=>{physics++;return {
   receipt:{authority:false,kind:'completed-in-process-native-verification',sourceBinding:{sourceCommit:env.EXPECTED_SOURCE_COMMIT},counts:{nativeDispatched:1}},
   compile:async()=>{if(++compiles===1)throw Error('fixture compile blocked');return {compilationComplete:true,backendReads:0,backendWrites:0,sourceBinding:{sourceCommit:env.EXPECTED_SOURCE_COMMIT}};},
   dispose:async()=>{disposed++;}};}}),replayAudit:async()=>({complete:true}),publishPackage:async()=>({directory:'public-snapshots85'}),auditPackage:async()=>({})});
 assert.equal(blocked.status,'blocked-after-native');assert.equal(disposed,0);assert.equal(physics,1);
 const done=await blocked.retryCandidate();assert.equal(done.status,'candidate-ready');assert.equal(physics,1);assert.equal(compiles,2);assert.equal(disposed,1);
});
test('offline workflow cannot capture, mutate backend, automatically retry, or publish; checkpoints are evidence only',async()=>{
 const source=await fs.readFile(new URL('../../.github/workflows/verify-saved-events.yml',import.meta.url),'utf8');
 assert.match(source,/contents: read/);assert.match(source,/cancel-in-progress: false/);assert.match(source,/persist-credentials: false/);
 assert.doesNotMatch(source,/FIREBASE_|secrets\.|workflow_call:|schedule:|download-artifact|git push|publish-verified-snapshots|update-public-snapshot/);
 assert.match(source,/native_job_limit/);assert.match(source,/expected_source_commit/);assert.match(source,/local-reports\/native-proof-checkpoints/);
 for(const contract of ['native-verification-ledger.test.mjs','native-verification-policy.test.mjs','native-event-snapshot.test.mjs',
  'verifier/local-snapshot-verification.test.mjs','native-snapshot-phase.test.mjs','snapshot-native-workflow.test.mjs'])
  assert(source.includes(contract),'the original authority gate remains mandatory: '+contract);
});

test('local launch pins source85 and original budgets, requires committed code and gates first fresh proof',async()=>{
 const source=await fs.readFile(new URL('./run-saved-kodub-rhr.ps1',import.meta.url),'utf8');
 for(const text of ["$env:SNAPSHOT_GENERATION = '85'","$env:LEDGER_ENTRIES = '19457'","$env:NATIVE_JOB_LIMIT = '128'",
  "$env:WARMUP_FIRST_PROOF = '1'","$env:NATIVE_TARGET_SCOPE = 'all'",'git status --porcelain','Test-Path -LiteralPath $RunDirectory'])assert(source.includes(text));
 assert.doesNotMatch(source,/FIREBASE_|git push|Remove-Item|Start-Process|while\s*\(/);
});
