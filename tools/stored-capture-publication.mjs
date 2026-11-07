import fs from 'node:fs/promises';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {runOfflineContinuation,validateOfflineSource,capturedInventory} from './offline-capture-continuation.mjs';
import {repairCapturedBoardMetadata} from './repair-canonical-board-metadata.mjs';
export async function storedProofPhase({phase,options,expectedManifestHash}){
 if(options.reuseOnly!==true)throw Error('Stored-only publication forbids new physics');
 const result=await phase({...options,verify:async()=>{throw Error('Stored-only publication forbids physics')},proofCheckpoint:async()=>{throw Error('Stored-only publication forbids new proof checkpoints')}});
 if(result.authority!=='stored-proof-overlay'||result.backendReads!==0||result.backendWrites!==0||result.ledgerManifestHash!==expectedManifestHash||result.counts.nativeDispatched!==0||result.counts.newProofs!==0)throw Error('Stored-only publication changed verification authority');
 return result;
}
async function main(){
 if(process.argv.length!==3||!path.isAbsolute(process.argv[2]))throw Error('Absolute stored publication configuration required');
 const c=JSON.parse(await fs.readFile(process.argv[2],'utf8'));if(c.previouslyTrustedOnly!==true)throw Error('Explicit pending verification approval required');
 const owner=randomUUID(),staging=path.join(c.root,'local-reports/snapshot-staging');
 const record=async value=>fs.writeFile(path.join(c.receiptDirectory,value.status==='failed'?'failed.json':'package-result.json'),JSON.stringify({...value,owner,testedCommit:c.testedCommit,at:new Date().toISOString()})+'\n',{flag:'wx',mode:0o600});
 await runOfflineContinuation({configuration:c,validate:async()=>{
  await validateOfflineSource(c);const{execFileSync}=await import('node:child_process');
  if(execFileSync('git',['rev-parse','HEAD'],{cwd:c.root,encoding:'utf8'}).trim()!==c.testedCommit||execFileSync('git',['diff','--name-only','HEAD'],{cwd:c.root,encoding:'utf8'}).trim())throw Error('Tested source changed');
 },acquire:async()=>fs.writeFile(path.join(c.receiptDirectory,'running.json'),JSON.stringify({owner,testedCommit:c.testedCommit,previouslyTrustedOnly:true})+'\n',{flag:'wx',mode:0o600}),copy:async()=>{
  await fs.cp(c.sourceDirectory,staging,{recursive:true,dereference:false,errorOnExist:true,force:false});
  if((await capturedInventory(staging)).sha256!==c.inventorySha256||(await capturedInventory(c.sourceDirectory)).sha256!==c.inventorySha256)throw Error('Source copy mismatch');
  await fs.copyFile(c.baseFile,path.join(c.root,'local-reports/snapshot-staging-base.json'),fs.constants.COPYFILE_EXCL);
  await fs.copyFile(c.catalogFile,path.join(c.root,'events/public-catalog.json'));
 },execute:async()=>{
  globalThis.fetch=()=>{throw Error('Stored capture publication forbids network')};
  for(const key of Object.keys(process.env))if(/^(?:FIREBASE_|GOOGLE_APPLICATION_CREDENTIALS$|GOOGLE_(?:ACCESS_TOKEN|OAUTH_ACCESS_TOKEN)$)/i.test(key))delete process.env[key];
  const repair=await repairCapturedBoardMetadata({directory:staging,expectedRepairs:69});
  await fs.writeFile(path.join(c.receiptDirectory,'metadata-repair.json'),JSON.stringify(repair)+'\n',{flag:'wx',mode:0o600});
  const{rebuildSnapshotOverall}=await import('./rebuild-snapshot-overall.mjs');console.log(JSON.stringify({scoringPreflight:await rebuildSnapshotOverall({directory:staging,validateOnly:true})}));
  const{updatePublicSnapshot}=await import('./update-public-snapshot.mjs');const{preparePublishedNativeBaseline}=await import('./published-native-baseline.mjs');
  const{loadTrustedPublishedEventTotalsBaseline}=await import('./published-event-totals-baseline.mjs');const{runNativeSnapshotPhase}=await import('./native-snapshot-phase.mjs');
  const{createLocalCaptureCheckpoint}=await import('./local-capture-checkpoint.mjs');
  const checkpoint=createLocalCaptureCheckpoint({root:c.root,directory:c.receiptDirectory,recipientPublicKey:await fs.readFile(c.recoveryPublicKeyFile,'utf8'),sourceCommit:c.testedCommit});
  const baseline=await loadTrustedPublishedEventTotalsBaseline({root:c.root,expectedGeneration:c.publishedBaseline.generation,expectedIndexSha256:c.publishedBaseline.indexSha256});
  const before=JSON.parse(await fs.readFile(path.join(c.root,'verification-ledger-current.json'),'utf8'));
  const result=await updatePublicSnapshot({root:c.root,offline:true,verificationAuthority:'firestore',reapplyStoredProofs:true,captureCheckpoint:checkpoint,
   prepareNativeCapture:()=>preparePublishedNativeBaseline({root:c.root,publishedBaseline:c.publishedBaseline}),
   nativePhase:async options=>{const result=await storedProofPhase({phase:runNativeSnapshotPhase,options,expectedManifestHash:before.manifestHash});
    await fs.writeFile(path.join(c.receiptDirectory,'stored-overlay.receipt.json'),JSON.stringify({authority:'stored-proof-overlay',backendReads:0,backendWrites:0,sourceBinding:result.sourceBinding,ledgerManifestHash:result.ledgerManifestHash,counts:result.counts,complete:result.complete,newVerificationPending:true})+'\n',{flag:'wx',mode:0o600});return result;},
   nativePhaseOptions:{sourceCommit:c.testedCommit,publishedEventTotalsBaseline:baseline}});
  const after=JSON.parse(await fs.readFile(path.join(c.root,'verification-ledger-current.json'),'utf8'));if(after.manifestHash!==before.manifestHash)throw Error('Prior proof authority changed');
  const{recordCapture}=await import('./workflow-capture-coordination.mjs');const binding=await recordCapture({root:c.root,startedAt:c.originalStartedAt});if(!binding.reusable)throw Error('Package cohort audit failed');
  return{generation:result.generation,directory:result.directory,published:result.published,deferred:result.deferred,nativeVerification:result.nativeVerification,binding,newVerificationPending:true};
 },record});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
