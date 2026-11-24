import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {savedEventDispatchPlan} from './saved-event-offline-plan.mjs';
import {preparePublishedOfflineVerification} from '../public-offline-verification.mjs';
import {verifyNativeSnapshotPhase} from '../native-snapshot-phase.mjs';
import {publishSnapshot} from '../snapshot-package.mjs';
import {assertSnapshotReplayCompleteness,inheritedDeferredReplayCount} from '../snapshot-replay-completeness.mjs';
import {captureBinding} from '../workflow-capture-coordination.mjs';
import {createInterface} from 'node:readline';

const sha=b=>createHash('sha256').update(b).digest('hex');
const demand=(ok,message)=>{if(!ok)throw Error('Saved event verification: '+message);};

export function savedEventWorkflowConfig(env=process.env){
 const pins={sourceCommit:env.SNAPSHOT_SOURCE_COMMIT,generation:Number(env.SNAPSHOT_GENERATION),indexSha256:env.SNAPSHOT_INDEX_SHA256,
  ledgerManifestHash:env.LEDGER_MANIFEST_SHA256,ledgerEntries:Number(env.LEDGER_ENTRIES),maxJobs:Number(env.NATIVE_JOB_LIMIT),runAttempt:Number(env.GITHUB_RUN_ATTEMPT)};
 if(env.TARGET_TRACK_IDS!==undefined)pins.targetTrackIds=JSON.parse(env.TARGET_TRACK_IDS);
 if(env.NATIVE_RUNTIME_MINUTES!==undefined){
  demand(typeof env.NATIVE_RUNTIME_MINUTES==='string'&&/^(8|25|90|180)$/.test(env.NATIVE_RUNTIME_MINUTES),'invalid bounded native runtime minutes');
  pins.maxRuntimeMs=Number(env.NATIVE_RUNTIME_MINUTES)*60000;
 }
 if(env.NATIVE_TARGET_SCOPE!==undefined)pins.targetScope=env.NATIVE_TARGET_SCOPE;
 pins.budgetPreset=env.SAVED_VERIFICATION_PRESET??'standard';
 demand(env.WARMUP_FIRST_PROOF===undefined||env.WARMUP_FIRST_PROOF==='1','invalid first-proof warmup mode');
 const plan=savedEventDispatchPlan(pins);
 demand(plan.budgetPreset!=='extended-all'||env.WARMUP_FIRST_PROOF==='1','extended preset requires the fresh first-proof gate');
 demand(/^[a-f0-9]{40}$/.test(env.EXPECTED_SOURCE_COMMIT||''),'exact tested implementation commit required');
 return {plan,testedCommit:env.EXPECTED_SOURCE_COMMIT,warmupFirst:env.WARMUP_FIRST_PROOF==='1'};
}

export function savedEventSnapshotSparsePatterns(generation){
 demand(Number.isSafeInteger(generation)&&generation>0,'validated snapshot generation required before Git paths');
 return `/*\n!/public-snapshots*/\n/public-snapshots${generation}/\n`;
}

export async function runSavedEventVerification({root,runDirectory,env=process.env},{
 git=(args)=>execFileSync('git',args,{cwd:root,maxBuffer:32*1024*1024}),
 prepare=preparePublishedOfflineVerification,verifyPhase=verifyNativeSnapshotPhase,
 replayAudit=assertSnapshotReplayCompleteness,publishPackage=publishSnapshot,auditPackage=captureBinding,now=Date.now,checkpointLog=()=>{}}={}){
 demand(typeof checkpointLog==='function','checkpoint logger required');
 const {plan,testedCommit,warmupFirst}=savedEventWorkflowConfig(env);
 // One absolute deadline includes preparation; it cannot be renewed by verify/compile.
 const deadlineOptions=plan.budgetPreset==='extended-all'?{mode:plan.mode,
  finishDeadlineMs:now()+plan.finishWindowMs,packagingReserveMs:plan.packagingReserveMs}:{};
 demand(git(['rev-parse','HEAD']).toString().trim()===testedCommit,'checkout differs from tested implementation');
 const source=plan.sourceCommit,pins=plan.publishedBaseline;
 demand(sha(git(['show',source+':public-snapshots'+pins.generation+'/index.json']))===pins.indexSha256,'committed public artifact pin differs');
 demand(sha(git(['show',source+':verification-ledger/manifest.json']))===pins.ledgerManifestHash,'committed public ledger pin differs');
 let checkpointSequence=0;
 const save=async(kind,value)=>{
  const file=path.join(runDirectory,kind+'-'+(++checkpointSequence)+'.json');
  await fs.writeFile(file,JSON.stringify({authority:false,resumeAuthority:false,...value})+'\n',{flag:'wx',mode:0o600,flush:true});
  await checkpointLog({kind,sequence:checkpointSequence});
 };
 const prepared=await prepare({root,runDirectory,sourceCommit:testedCommit,publishedBaseline:pins,
  targetScope:plan.targetScope,...(plan.targetTrackIds?{targetTrackIds:plan.targetTrackIds}:{}),maxJobs:plan.maxJobs,maxRuntimeMs:plan.maxRuntimeMs,
  ...deadlineOptions},{verifyPhase:input=>verifyPhase({...input,
   ...(warmupFirst?{firstProofCheckpoint:record=>save('first-proof-pass',record)}:{}),
   progressCheckpoint:record=>save('progress',record),proofCheckpoint:record=>save('failure-checkpoint',record)})});
 // Verify once, then consume its live compile capability. Serialized evidence is never imported.
 const sourceManifest=JSON.parse(await fs.readFile(path.join(prepared.directory,'manifest.json')));
 const inheritedDeferred=inheritedDeferredReplayCount(sourceManifest);
 const verified=await prepared.verify();
  demand(prepared.receipt?.backendReads===0&&prepared.receipt?.backendWrites===0&&
   verified.receipt?.authority===false&&verified.receipt?.kind==='completed-in-process-native-verification'&&
   verified.receipt?.sourceBinding?.sourceCommit===testedCommit&&verified.receipt?.counts?.nativeDispatched<=plan.maxJobs,'non-offline verification receipt');
 let compiled,packaged,allocatorWritten=false,supersededScoringDelta;
 const finish=async()=>{
  try{
   compiled ||= await verified.compile();
   demand(compiled.compilationComplete===true&&compiled.backendReads===0&&compiled.backendWrites===0&&
    compiled.ledgerManifestHash===verified.receipt.ledgerManifestHash&&
    JSON.stringify(compiled.sourceBinding)===JSON.stringify(verified.receipt.sourceBinding),'compiled candidate does not match live completed proof');
   const finalManifest=JSON.parse(await fs.readFile(path.join(prepared.directory,'manifest.json')));
   demand(inheritedDeferredReplayCount(finalManifest)===inheritedDeferred,'inherited pending replays changed during verification');
   const replay=await replayAudit(prepared.directory,{deferredUnpublishedPending:inheritedDeferred});
   // An old scoring-only declaration cannot claim hashes of newly compiled event totals.
   const manifestPath=path.join(prepared.directory,'manifest.json');
   const manifest=JSON.parse(await fs.readFile(manifestPath));
   if(manifest.publishedScoringDelta){supersededScoringDelta=manifest.publishedScoringDelta;delete manifest.publishedScoringDelta;
    await fs.writeFile(manifestPath,JSON.stringify(manifest)+'\n');}
   if(!allocatorWritten){
    // Private package generation counter only; it names no nonexistent source package.
    await fs.writeFile(path.join(runDirectory,'snapshot-current.json'),JSON.stringify({generation:pins.generation})+'\n',{flag:'wx'});
    allocatorWritten=true;
   }
   packaged ||= await publishPackage({root:runDirectory,stagingDirectory:prepared.directory});
   const html=(await fs.readFile(path.join(root,'index.html'),'utf8')).replace(
    'name="polytrack-snapshot" content="./public-snapshots'+pins.generation+'/"',
    'name="polytrack-snapshot" content="./'+packaged.directory+'/"');
   demand(html.includes('name="polytrack-snapshot" content="./'+packaged.directory+'/"'),'candidate HTML generation mismatch');
   await fs.writeFile(path.join(runDirectory,'index.html'),html);
   await fs.mkdir(path.join(runDirectory,'events'),{recursive:true});
   await fs.copyFile(path.join(root,'events/public-catalog.json'),path.join(runDirectory,'events/public-catalog.json'));
   const audit=await auditPackage(runDirectory);
   const receipt={schemaVersion:1,kind:'saved-event-compiled-candidate',status:'candidate-ready',authority:false,plan,testedCommit,
    checkpointSequence,nativeReceipt:verified.receipt,compiled,packaged,audit,replay,supersededScoringDelta,
    compilePerformed:true,publicationPerformed:false,databaseReads:0,databaseWrites:0};
   await fs.writeFile(path.join(runDirectory,'event-candidate-complete.json'),JSON.stringify(receipt)+'\n',{flag:'wx',mode:0o600,flush:true});
   await verified.dispose();return receipt;
  }catch(error){
   await save('candidate-blocked',{kind:'same-process-candidate-blocker',message:String(error.message),
    nativeReceipt:verified.receipt,compilePerformed:!!compiled,newPhysicsAllowed:false});
   return {kind:'saved-event-candidate-blocked',status:'blocked-after-native',message:error.message,liveCapabilityRetained:true,
    nativeReceipt:verified.receipt,retryCandidate:finish,dispose:verified.dispose};
  }
 };
 return finish();
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [root,runDirectory]=process.argv.slice(2);
 demand(root&&runDirectory,'usage ROOT NEW_PRIVATE_RUN_DIRECTORY');
 let receipt=await runSavedEventVerification({root:path.resolve(root),runDirectory:path.resolve(runDirectory)},{checkpointLog:record=>{
  console.log(JSON.stringify({verificationCheckpoint:record}));
  if(record.kind==='first-proof-pass'&&process.env.GITHUB_ACTIONS==='true')
   console.log('::notice title=First replay verified::A fresh replay passed native physics and integrity checks. Remaining saved runs are processing offline.');
 }});
 const report=()=>console.log(JSON.stringify({kind:receipt.kind,status:receipt.status,message:receipt.message,
  plan:receipt.plan,counts:receipt.nativeReceipt.counts,packaged:receipt.packaged,publicationPerformed:false}));
 report();
 if(receipt.status==='blocked-after-native'){
  console.error('Live compile capability retained. Commands: retry-candidate (no physics), dispose (explicit abandonment).');
  const keepAlive=setInterval(()=>{},60000),input=createInterface({input:process.stdin});
  for await(const line of input){
   if(line.trim()==='retry-candidate'){receipt=await receipt.retryCandidate();report();if(receipt.status==='candidate-ready')break;}
   else if(line.trim()==='dispose'){await receipt.dispose();process.exitCode=1;break;}
  }
  if(receipt.status==='candidate-ready'||process.exitCode===1){clearInterval(keepAlive);input.close();}
 }
}
