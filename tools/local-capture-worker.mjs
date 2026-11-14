import {readPrivateSnapshotIndex} from './private-snapshot-index.mjs';
import {createHash} from 'node:crypto';
import {prepareNativeSnapshotCapture} from './native-snapshot-phase.mjs';
import {openFullCanonicalTrackSource} from './full-canonical-track-source.mjs';
import {openCapturedProfileDelta} from './captured-profile-input.mjs';
import {openCapturedCanonicalInput} from './captured-canonical-input.mjs';
import {reuseCompletedWorkerBackup} from './reuse-worker-backup.mjs';
import {captureBackendQueueDiagnostic} from './backend-queue-diagnostic.mjs';
import {createFullSnapshotReadFence} from './full-snapshot-read-fence.mjs';
import {fullSnapshotPolicy,readOnlySnapshotQueryDb} from './full-snapshot-policy.mjs';
import {captureFullCanonical} from './full-canonical-capture.mjs';
import {captureProfileDelta} from './capture-profile-delta.mjs';
import {loadTrustedPublishedEventTotalsBaseline} from './published-event-totals-baseline.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {localOvernightCapturePlan,OVERNIGHT_SNAPSHOT as N} from './overnight-snapshot-plan.mjs';
import {updatePublicSnapshot} from './update-public-snapshot.mjs';
import {captureOverallProjection} from './capture-overall-projection.mjs';
import {capturePublicEventTotals} from './public-event-totals-backup.mjs';
import {rebuildSnapshotOverall} from './rebuild-snapshot-overall.mjs';
import {syncPublicEventCatalog} from './sync-event-catalog.mjs';
import {recordCapture} from './workflow-capture-coordination.mjs';
import {preflightLocalCaptureCheckpoints,createLocalCaptureCheckpoint,retainLocalCaptureFailure,createLocalNativePhaseReceipt} from './local-capture-checkpoint.mjs';
import {connect,decode} from './verifier/firestore.mjs';
import {createCanonicalRetentionCapture} from './canonical-retention-capture.mjs';
import {runPublicSnapshotBackup} from './public-snapshot-backup.mjs';
import {prepareLocalArchiveReplayRepair,repairLocalArchiveReplays,ARCHIVE_REPAIR_COLLECTION,ARCHIVE_REPAIR_NOT_BEFORE} from './local-archive-replay-repair.mjs';
import {runNativeSnapshotPhase} from './native-snapshot-phase.mjs';
import {createLocalNativeVerificationCompletion} from './local-native-verification-completion.mjs';
import {assertLocalSource} from './local-capture-publication.mjs';
import {validateLocalEvidence} from './local-overnight-capture.mjs';

// A wrapped backup must not disable the updater's default source stages.
export function localCaptureSourceStages({captureOverall=captureOverallProjection,captureTotals=capturePublicEventTotals,calculateOverall=rebuildSnapshotOverall}={}){
  for(const stage of [captureOverall,captureTotals,calculateOverall])if(typeof stage!=='function')throw Error('Complete local capture source stages required');
  return {captureOverall,captureTotals,calculateOverall};
}

// Keep the shared proof/replay checks, but use the local fence's exact POST read route.
export function createLocalCanonicalRetention({ledger,serviceAccount,connectImpl=connect}={}){
  let database,stopped=false;
  return createCanonicalRetentionCapture({ledger,readLimit:N.replayDocumentLimit,readCanonical:async(accountId,trackId)=>{
    if(stopped||! /^[a-f0-9]{64}$/.test(accountId)||! /^[a-f0-9]{64}$/.test(trackId))throw Error('Local canonical retention stopped');
    try{
      if(typeof serviceAccount!=='string'||!serviceAccount)throw Error('Local canonical retention credential unavailable');
      database||=connectImpl(serviceAccount,{env:{},mode:'scheduled',documentReadLimit:32,documentWriteLimit:1,maxReadRetries:0});
      const db=await database,name='projects/polytrack-052/databases/(default)/documents/0.6.2_race_results/'+accountId+'_'+trackId;
      const rows=await db.call(':batchGet',{documents:[name]});
      if(db.writeAttempts()!==0||!Array.isArray(rows)||rows.length!==1||rows[0]?.found?.name!==name||rows[0].missing||rows[0].error)
        throw Error('Local canonical retention exact document unavailable');
      const document=rows[0].found;
      return {...document,data:decode({mapValue:{fields:document.fields||{}}})};
    }catch(error){stopped=true;throw error;}
  }});
}

export async function runLocalSnapshotBackup(options,{serviceAccount=process.env.FIREBASE_VERIFIER_SERVICE_ACCOUNT,
  backup=runPublicSnapshotBackup,connectImpl=connect,log=console.log}={}){
  if(options?.reconcileCanonicalTrack!==undefined)throw Error('Local canonical retention callback must be locally bound');
  const retention=createLocalCanonicalRetention({ledger:options?.nativeVerification?.ledger,serviceAccount,connectImpl});
  try{return await backup({...options,reconcileCanonicalTrack:retention.reconcile});}
  finally{log(JSON.stringify({localCanonicalRetention:retention.report(),replayDocumentLimit:N.replayDocumentLimit}));}
}

export async function captureLocalCompleteSources({policy,directory,checkpointDirectory,serviceAccount,capturedCanonical=null,connectImpl=connect,captureCanonical=captureFullCanonical,captureProfiles=captureProfileDelta,captureJob=captureBackendQueueDiagnostic}={}){
  fullSnapshotPolicy({fullSnapshotPolicy:policy});
  const summaryFile=path.join(directory,'public-export-summary.json'),stat=await fs.lstat(summaryFile);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2*1024*1024)throw Error('Safe saved profile watermark required before capture');
  const summary=JSON.parse(await fs.readFile(summaryFile,'utf8')),since=Date.parse(summary.profilesCapturedAt||summary.capturedAt);
  if(!Number.isSafeInteger(since)||since<1||since>Date.now())throw Error('Known profile watermark required before database access');
  const db=await connectImpl(serviceAccount,{env:{},mode:'scheduled',documentReadLimit:policy.canonicalDocumentLimit+policy.profileDocumentLimit+1,documentWriteLimit:1,maxReadRetries:0});
  const backendQueue=await captureJob(db);
  const query=readOnlySnapshotQueryDb(db);
  const canonical=await captureCanonical({db:capturedCanonical?.db||query,directory,documentLimit:policy.canonicalDocumentLimit,checkpointDirectory});
  if(!canonical.complete||!canonical.imported||canonical.scanInconsistency){console.error(JSON.stringify({canonicalCaptureFailure:canonical}));throw Error('Full canonical catch-up incomplete; retain previous public snapshot');}
  if(capturedCanonical){canonical.sourceAcquisition='retained-frozen-query-pages';canonical.backendDocumentReadsThisRun=0;canonical.reusedDocumentReservations=capturedCanonical.originalReservations;await fs.writeFile(path.join(directory,'full-canonical-capture.json'),JSON.stringify(canonical)+'\n');}
  const profiles=await captureProfiles({db:query,directory,since,readTime:canonical.fullScanReadPoint,maxDocuments:policy.profileDocumentLimit});
  if(!profiles.complete)throw Error('Profile capture incomplete');
  if(db.writeAttempts()!==0)throw Error('Full snapshot attempted a database write');
  await fs.writeFile(summaryFile,JSON.stringify({...summary,profilesCapturedAt:profiles.readTime,profileDelta:profiles})+'\n');
  return {canonical,profiles,backendQueue,documentBudget:db.documentBudget(),backendWrites:0};
}

export async function assertLocalCaptureOwner({receipt,receiptFile,owner}){
  localOvernightCapturePlan({receipt});
  if(typeof owner!=='string'||! /^[a-f0-9-]{36}$/.test(owner))throw Error('Local capture owner required');
  const directory=path.dirname(receiptFile),running=JSON.parse(await fs.readFile(path.join(directory,'running.json'),'utf8'));
  const state=JSON.parse(await fs.readFile(path.join(directory,'state.json'),'utf8'));
  if(running.owner!==owner||running.testedCommit!==receipt.testedCommit||state.owner!==owner||state.status!=='capturing'||state.sourceCommit!==receipt.testedCommit)
    throw Error('Local capture admission binding mismatch');
  for(const file of ['complete.json','failed.json'])if(await fs.lstat(path.join(directory,file)).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;}))throw Error('Local attempt already finished');
  await fs.writeFile(path.join(directory,'capture-admitted.json'),JSON.stringify({owner,testedCommit:receipt.testedCommit,startedAt:new Date().toISOString()})+'\n',{flag:'wx',mode:0o600});
}


export async function repairPreparedLocalArchives({receipt,directory,connectImpl=connect,repair=repairLocalArchiveReplays,now=Date.now}={}){
  const options=receipt.archiveReplayRepair;
  if(!options)return null;
  const args={directory,planFile:options.file,planSha256:options.sha256,maxDocuments:options.maxDocuments};
  const plan=await prepareLocalArchiveReplayRepair(args);
  if(!plan.missing.length)return {planned:12,attempted:0,recovered:0,backendReads:0,backendWrites:0,staged:false};
  if(now()<ARCHIVE_REPAIR_NOT_BEFORE)throw Error('Archive repair cannot authenticate before reset');
  const db=await connectImpl(process.env.FIREBASE_VERIFIER_SERVICE_ACCOUNT,{env:{},mode:'scheduled',documentReadLimit:12,documentWriteLimit:1,maxReadRetries:0});
  const allowed=new Set(plan.missing.map(t=>t.periodId+'_'+t.accountId)),used=new Set();let stopped=false;
  let result;
  try{result=await repair({...args,now,getDocument:async(collection,id)=>{
    if(stopped||collection!==ARCHIVE_REPAIR_COLLECTION||!allowed.has(id)||used.has(id)||used.size>=12)throw Error('Archive repair request outside exact prepared boundary');
    used.add(id);
    try{const doc=await db.get(collection,id);if(!doc)throw Error('Prepared archive replay unavailable');return doc.data;}
    catch(error){stopped=true;throw error;}
  }});}catch(error){console.error(JSON.stringify({archiveReplayRepair:{status:'failed',attempted:used.size,documentBudget:db.documentBudget(),backendWrites:db.writeAttempts()}}));throw error;}
  if(db.documentBudget().usedReads>12||db.writeAttempts()!==0)throw Error('Archive repair accounting exceeded prepared boundary');
  return {...result,documentBudget:db.documentBudget()};
}

export async function assertLocalStagingBase({root,publishedBaseline}={}){
 const parent=path.join(root,'local-reports'),stage=path.join(parent,'snapshot-staging');
 for(const p of [parent,stage]){const st=await fs.lstat(p);if(!st.isDirectory()||st.isSymbolicLink())throw Error('Unsafe prepared staging');}
 const read=async relative=>{const p=path.join(root,relative),st=await fs.lstat(p);if(!st.isFile()||st.isSymbolicLink()||st.size>16*1024*1024)throw Error('Unsafe prepared base file');return fs.readFile(p);};
 const pointer=JSON.parse(await read('snapshot-current.json')),base=JSON.parse(await read('local-reports/snapshot-staging-base.json'));
 const {generation,indexSha256}=publishedBaseline||{};
 if(!Number.isSafeInteger(generation)||generation<1||! /^[a-f0-9]{64}$/.test(indexSha256||'')||pointer.currentdir!=='public-snapshots'+generation||base.schemaVersion!==1||base.generation!==generation)throw Error('Prepared staging base changed before source acquisition');
 const bytes=await readPrivateSnapshotIndex(path.join(root,'public-snapshots'+generation,'index.json'));
 if(createHash('sha256').update(bytes).digest('hex')!==indexSha256)throw Error('Published source baseline changed');
}

export async function captureLocalSource({receipt,receiptFile,owner}={}){
  const fullPolicy=fullSnapshotPolicy(receipt);
  await validateLocalEvidence(receipt);
  await assertLocalSource({workspace:receipt.workspace,sourceCommit:receipt.testedCommit,
    runnerFile:path.join(receipt.workspace,'tools/local-overnight-capture.mjs')});
  const {recipientPublicKey}=await preflightLocalCaptureCheckpoints({workspace:receipt.workspace,
    directory:path.dirname(receiptFile),recoveryPublicKeyFile:receipt.recoveryPublicKeyFile});
  await assertLocalCaptureOwner({receipt,receiptFile,owner});
  const plan=localOvernightCapturePlan({receipt}),root=receipt.workspace,directory=path.dirname(receiptFile),startedAt=Date.now();
  const head=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  if(head!==receipt.testedCommit)throw Error('Capture child source changed');
  const transport=globalThis.fetch,controllers=new Set();let aborted=false;
  const sourceFence=createFullSnapshotReadFence({fetchImpl:transport,initialDirectReservations:N.priorDirectReservations,initialWorkerRequests:N.priorWorkerRequests});
  const abort=()=>{aborted=true;for(const controller of controllers)controller.abort();};
  const onMessage=value=>{if(value?.type==='abort')abort();};
  process.on('message',onMessage);process.on('disconnect',abort);
  globalThis.fetch=(input,options={})=>{
    if(aborted)throw Error('Local capture cancellation requested');
    const controller=new AbortController();controllers.add(controller);
    return sourceFence.fetch(input,{...options,signal:options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal});
  };
  // Only this bounded child holds credentials. The offline native phase strips them.
  const staging=path.join(root,'local-reports/snapshot-staging');
  await assertLocalStagingBase({root,publishedBaseline:fullPolicy.publishedBaseline});
  const catalogHandoff={file:path.join(directory,'catalog.private'),binding:{sourceCommit:receipt.testedCommit,
    repository:'StaticQuasar931/PolyTrack-0.6.3-Ranked',runId:String(startedAt),runAttempt:'1',startedAt}};
  const checkpoint=createLocalCaptureCheckpoint({root,directory,recipientPublicKey,sourceCommit:receipt.testedCommit});
  const publishedEventTotalsBaseline=await loadTrustedPublishedEventTotalsBaseline({root,expectedGeneration:fullPolicy.publishedBaseline.generation,expectedIndexSha256:fullPolicy.publishedBaseline.indexSha256});
  try{
    process.env.FIREBASE_VERIFIER_SERVICE_ACCOUNT=await fs.readFile(receipt.credentialFile,'utf8');
    const capturedCanonical=receipt.capturedCanonicalPages?await openCapturedCanonicalInput(receipt.capturedCanonicalPages):null;
    const capturedProfiles=receipt.capturedProfiles?await openCapturedProfileDelta(receipt.capturedProfiles):null;
    if(capturedCanonical&&capturedProfiles?.readTime!==capturedCanonical.readTime)throw Error('Frozen profile/canonical source mismatch');
    const reused=receipt.reuseWorkerBackup?await reuseCompletedWorkerBackup({directory:staging,receipt,capturedCanonical}):null;
    if(reused)await fs.writeFile(path.join(root,'events/public-catalog.json'),reused.catalogBytes);
    const catalog=reused?{deferred:false}:await syncPublicEventCatalog({outputFile:path.join(root,'events/public-catalog.json'),stagingDirectory:staging,catalogHandoff});
    if(catalog.deferred)throw Error('Catalog deferred; no source capture follows');
    // Prepare prior proof authority before current canonical rows replace old bindings.
    const priorContext=await prepareNativeSnapshotCapture({root,directory:staging});
    const full=await captureLocalCompleteSources({policy:fullPolicy,directory:staging,checkpointDirectory:directory,capturedCanonical,...(capturedProfiles?{captureProfiles:options=>capturedProfiles.apply(options)}:{}),serviceAccount:process.env.FIREBASE_VERIFIER_SERVICE_ACCOUNT});
    console.log(JSON.stringify({fullSnapshotCapture:full}));
    const fullCanonicalSource=await openFullCanonicalTrackSource({directory:staging,report:full.canonical});
    const captureOnly=receipt.captureOnly===true;
    const result=await updatePublicSnapshot({...localCaptureSourceStages(),root,refreshReplays:false,replayDocumentLimit:null,
      prepareNativeCapture:()=>priorContext,

      verificationAuthority:captureOnly?'firestore':'snapshot-native',captureOptions:{catalogHandoff,trackFetchLimit:fullPolicy.trackCheckLimit,trackConfirmationNotBefore:startedAt,eventReplayFetchLimit:fullPolicy.eventReplayLimit},captureCheckpoint:async input=>{
        const preflight=await rebuildSnapshotOverall({directory:input.directory,validateOnly:true});
        if(preflight.additionalFirestoreReads!==0||preflight.additionalFirestoreWrites!==0)throw Error('Offline scoring preflight used backend');
        await checkpoint(input);
      },
      capture:async options=>{const backup=reused?.manifest||await runLocalSnapshotBackup({...options,fullCanonicalSource});if(backup?.deferred)return backup;
        if(reused)console.log(JSON.stringify({publicSnapshotBackupReused:{...reused.summary,newWorkerRequests:0,verificationAuthority:false}}));
        const repair=await repairPreparedLocalArchives({receipt,directory:staging});if(repair)console.log(JSON.stringify({archiveReplayRepair:repair}));
        return backup;},
      nativePhase:captureOnly?runNativeSnapshotPhase:createLocalNativePhaseReceipt({root,directory,owner,testedCommit:receipt.testedCommit,nativePhase:runNativeSnapshotPhase}),
      nativePhaseOptions:{sourceCommit:receipt.testedCommit,publishedEventTotalsBaseline,maxJobs:plan.maxJobs,maxRuntimeMs:plan.maxRuntimeMs,
        ...(captureOnly?{}:{nativeCompleted:createLocalNativeVerificationCompletion({root,directory,owner,sourceCommit:receipt.testedCommit,maxJobs:plan.maxJobs})}),
        proofCheckpoint:({directory:source,sourceBinding,ledgerManifestHash})=>checkpoint({directory:source,
          sourceCommit:receipt.testedCommit,phase:'native-proofs',sourceBinding,ledgerManifestHash})}});
    if(aborted)throw Error('Local capture cancelled; do not publish');
    if(result.deferred||result.published!==true)throw Error('Snapshot candidate deferred; retain prior package');
    const binding=await recordCapture({root,startedAt});if(binding.reusable!==true)throw Error('Captured package is not a consistent reusable cohort');
    await fs.writeFile(path.join(directory,'capture-result.json'),JSON.stringify({generation:result.generation,directory:result.directory,
      published:true,deferred:false,nativeVerification:result.nativeVerification})+'\n',{flag:'wx',mode:0o600});
    return result;
  }catch(error){
    await retainLocalCaptureFailure({staging,sourceCommit:receipt.testedCommit,checkpoint});
    throw error;
  }finally{
    console.log(JSON.stringify({fullSnapshotOperations:sourceFence.report()}));
    delete process.env.FIREBASE_VERIFIER_SERVICE_ACCOUNT;globalThis.fetch=transport;
    process.removeListener('message',onMessage);process.removeListener('disconnect',abort);controllers.clear();
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const file=process.argv[2],owner=process.argv[3];
  if(process.argv.length!==4||!path.isAbsolute(file||''))throw Error('Explicit private readiness path and owner required');
  await captureLocalSource({receipt:JSON.parse(await fs.readFile(file,'utf8')),receiptFile:file,owner});
}
