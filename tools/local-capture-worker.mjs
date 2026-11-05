import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {localOvernightCapturePlan} from './overnight-snapshot-plan.mjs';
import {updatePublicSnapshot} from './update-public-snapshot.mjs';
import {syncPublicEventCatalog} from './sync-event-catalog.mjs';
import {recordCapture} from './workflow-capture-coordination.mjs';
import {encryptCaptureRecovery,validateRecoveryRecipient} from './capture-recovery.mjs';
import {assertLocalSource} from './local-capture-publication.mjs';
import {validateLocalEvidence} from './local-overnight-capture.mjs';

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

export async function captureLocalSource({receipt,receiptFile,owner}={}){
  await validateLocalEvidence(receipt);
  await assertLocalSource({workspace:receipt.workspace,sourceCommit:receipt.testedCommit,
    runnerFile:path.join(receipt.workspace,'tools/local-overnight-capture.mjs')});
  await assertLocalCaptureOwner({receipt,receiptFile,owner});
  const plan=localOvernightCapturePlan({receipt}),root=receipt.workspace,directory=path.dirname(receiptFile),startedAt=Date.now();
  const head=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  if(head!==receipt.testedCommit)throw Error('Capture child source changed');
  const recipientPublicKey=await fs.readFile(receipt.recoveryPublicKeyFile,'utf8');validateRecoveryRecipient(recipientPublicKey);
  const transport=globalThis.fetch,controllers=new Set();let aborted=false;
  const abort=()=>{aborted=true;for(const controller of controllers)controller.abort();};
  const onMessage=value=>{if(value?.type==='abort')abort();};
  process.on('message',onMessage);process.on('disconnect',abort);
  globalThis.fetch=(input,options={})=>{
    if(aborted)throw Error('Local capture cancellation requested');
    const controller=new AbortController();controllers.add(controller);
    return transport(input,{...options,signal:options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal});
  };
  // Only this bounded child holds credentials. The offline native phase strips them.
  const staging=path.join(root,'local-reports/snapshot-staging');
  const catalogHandoff={file:path.join(directory,'catalog.private'),binding:{sourceCommit:receipt.testedCommit,
    repository:'StaticQuasar931/PolyTrack-0.6.3-Ranked',runId:String(startedAt),runAttempt:'1',startedAt}};
  const checkpoint=({directory:source,sourceCommit,phase='pre-native'})=>encryptCaptureRecovery({directory:source,sourceCommit,
    outputFile:path.join(directory,phase==='failure-state'?'failure.ptenc':'capture.ptenc'),recipientPublicKey,attempt:'overnight-capture',phase});
  try{
    process.env.FIREBASE_VERIFIER_SERVICE_ACCOUNT=await fs.readFile(receipt.credentialFile,'utf8');
    const catalog=await syncPublicEventCatalog({outputFile:path.join(root,'events/public-catalog.json'),stagingDirectory:staging,catalogHandoff});
    if(catalog.deferred)throw Error('Catalog deferred; no source capture follows');
    const result=await updatePublicSnapshot({root,refreshReplays:true,replayDocumentLimit:plan.replayDocumentLimit,
      verificationAuthority:'snapshot-native',captureOptions:{catalogHandoff},captureCheckpoint:checkpoint,
      nativePhaseOptions:{sourceCommit:receipt.testedCommit,maxJobs:plan.maxJobs,maxRuntimeMs:plan.maxRuntimeMs,
        proofCheckpoint:({directory:source,sourceBinding,ledgerManifestHash})=>encryptCaptureRecovery({directory:source,
          sourceCommit:receipt.testedCommit,outputFile:path.join(directory,'proofs.ptenc'),recipientPublicKey,attempt:'overnight-capture',
          phase:'native-proofs',sourceBinding,ledgerManifestHash})}});
    if(aborted)throw Error('Local capture cancelled; do not publish');
    if(result.deferred||result.published!==true)throw Error('Snapshot candidate deferred; retain prior package');
    const binding=await recordCapture({root,startedAt});if(binding.reusable!==true)throw Error('Captured package is not a consistent reusable cohort');
    await fs.writeFile(path.join(directory,'capture-result.json'),JSON.stringify({generation:result.generation,directory:result.directory,
      published:true,deferred:false,nativeVerification:result.nativeVerification})+'\n',{flag:'wx',mode:0o600});
    return result;
  }catch(error){
    if(await fs.lstat(staging).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;}))
      await checkpoint({directory:staging,sourceCommit:receipt.testedCommit,phase:'failure-state'}).catch(()=>{});
    throw error;
  }finally{
    delete process.env.FIREBASE_VERIFIER_SERVICE_ACCOUNT;globalThis.fetch=transport;
    process.removeListener('message',onMessage);process.removeListener('disconnect',abort);controllers.clear();
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const file=process.argv[2],owner=process.argv[3];
  if(process.argv.length!==4||!path.isAbsolute(file||''))throw Error('Explicit private readiness path and owner required');
  await captureLocalSource({receipt:JSON.parse(await fs.readFile(file,'utf8')),receiptFile:file,owner});
}
