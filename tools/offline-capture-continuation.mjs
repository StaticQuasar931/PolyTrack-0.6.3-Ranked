import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const demand=(value,message)=>{if(!value)throw Error('Offline continuation: '+message);};
const absent=async file=>{try{await fs.lstat(file);throw Error('Offline continuation: existing guard or output');}catch(error){if(error.code!=='ENOENT')throw error;}};
export async function capturedInventory(directory){
 const root=await fs.realpath(directory),entries=[];let bytes=0;
 async function walk(folder,relative=''){
  for(const name of (await fs.readdir(folder)).sort()){
   const file=path.join(folder,name),logical=relative?relative+'/'+name:name,stat=await fs.lstat(file);
   demand(!stat.isSymbolicLink(),'source links forbidden');
   if(stat.isDirectory())await walk(file,logical);
   else{
    demand(stat.isFile()&&/^[A-Za-z0-9_./-]+\.(?:json|bin)$/.test(logical)&&!logical.split('/').some(p=>p==='..'||p==='.'),'unsafe source file');
    demand(entries.length<50000&&stat.size<=16*1024*1024&&(bytes+=stat.size)<=256*1024*1024,'source inventory limit');
    const data=await fs.readFile(file);demand(data.length===stat.size,'source changed');
    entries.push({path:logical,bytes:data.length,sha256:sha(data)});
   }
  }
 }
 await walk(root);return {entries,bytes,sha256:sha(JSON.stringify(entries))};
}
export async function runOfflineContinuation({configuration,validate,acquire,copy,execute,record}){
 for(const capability of [validate,acquire,copy,execute,record])demand(typeof capability==='function','missing capability');
 await validate(configuration);
 await acquire(configuration);
 try{
  await copy(configuration);
  const result=await execute(configuration);
  demand(result?.published===true&&result.deferred===false&&result.nativeVerification?.backendReads===0&&result.nativeVerification?.backendWrites===0,'incomplete offline result');
  await record({status:'packaged',result});return result;
 }catch(error){await record({status:'failed',errorCode:error.code||'OFFLINE_CONTINUATION_FAILED'});throw error;}
}
export async function validateOfflineSource(c){
 demand(c?.kind==='polytrack-source-bound-offline-continuation'&&c.authorized===true&&/^[a-f0-9]{40}$/.test(c.testedCommit||''),'explicit tested identity required');
 for(const key of ['root','sourceDirectory','receiptDirectory','failedFile','failedCheckpointFile','captureLog','baseFile','catalogFile','recoveryPublicKeyFile','verifierNodeModules'])demand(path.isAbsolute(c[key]||''),'absolute paths required');
 for(const [key,expected] of Object.entries(c.evidence))demand(/^[a-f0-9]{64}$/.test(expected)&&sha(await fs.readFile(c[key]))===expected,'evidence changed: '+key);
 const failed=JSON.parse(await fs.readFile(c.failedFile,'utf8')),checkpoint=JSON.parse(await fs.readFile(c.failedCheckpointFile,'utf8'));
 demand(failed.status==='failed'&&failed.sourceCommit===c.capturedSourceCommit&&failed.phase==='capture','terminal failed capture required');
 demand(checkpoint.status==='failed'&&checkpoint.phase==='pre-native'&&checkpoint.sourceCommit===c.capturedSourceCommit&&checkpoint.failure?.operation==='encryption','capture must have stopped before physics');
 const source=await capturedInventory(c.sourceDirectory);
 demand(source.sha256===c.inventorySha256&&source.entries.length===c.inventoryFiles&&source.bytes===c.inventoryBytes,'saved capture changed');
 for(const file of ['native-complete.receipt.json','verification-completed.json','verification-completed.receipt.json','proofs.receipt.json','proofs.ptenc'])await absent(path.join(path.dirname(c.failedFile),file));
 for(const file of ['running.json','complete.json','failed.json','native-complete.receipt.json','verification-completed.json','verification-completed.receipt.json'])await absent(path.join(c.receiptDirectory,file));
 await absent(path.join(c.root,'local-reports/snapshot-staging'));
 return source;
}
async function main(){
 demand(process.argv.length===3&&path.isAbsolute(process.argv[2]),'absolute configuration required');
 const c=JSON.parse(await fs.readFile(process.argv[2],'utf8')),owner=randomUUID();
 const record=async value=>fs.writeFile(path.join(c.receiptDirectory,value.status==='failed'?'failed.json':'package-result.json'),JSON.stringify({...value,owner,testedCommit:c.testedCommit,at:new Date().toISOString()})+'\n',{flag:'wx',mode:0o600});
 await runOfflineContinuation({configuration:c,validate:async value=>{
  await validateOfflineSource(value);
  const {execFileSync}=await import('node:child_process');
  demand(execFileSync('git',['rev-parse','HEAD'],{cwd:c.root,encoding:'utf8'}).trim()===c.testedCommit,'tested source changed');
  demand(!execFileSync('git',['diff','--name-only','HEAD'],{cwd:c.root,encoding:'utf8'}).trim(),'source is dirty');
  const installed=JSON.parse(await fs.readFile(path.join(c.verifierNodeModules,'playwright/package.json'),'utf8'));
  const declared=JSON.parse(await fs.readFile(path.join(c.root,'tools/verifier/package.json'),'utf8'));
  demand(installed.version===declared.dependencies.playwright,'pinned dependency changed');
 },acquire:async()=>{
  await fs.writeFile(path.join(c.receiptDirectory,'running.json'),JSON.stringify({owner,testedCommit:c.testedCommit,sourceInventory:c.inventorySha256,at:new Date().toISOString()})+'\n',{flag:'wx',mode:0o600});
 },copy:async()=>{
  const target=path.join(c.root,'local-reports/snapshot-staging');
  await fs.cp(c.sourceDirectory,target,{recursive:true,dereference:false,errorOnExist:true,force:false});
  demand((await capturedInventory(target)).sha256===c.inventorySha256,'copied source differs');
  demand((await capturedInventory(c.sourceDirectory)).sha256===c.inventorySha256,'original source changed during copy');
  await fs.copyFile(c.baseFile,path.join(c.root,'local-reports/snapshot-staging-base.json'),fs.constants.COPYFILE_EXCL);
  await fs.copyFile(c.catalogFile,path.join(c.root,'events/public-catalog.json'));
 },execute:async()=>{
  for(const key of Object.keys(process.env))if(/^(?:FIREBASE_|GOOGLE_APPLICATION_CREDENTIALS$|GOOGLE_(?:ACCESS_TOKEN|OAUTH_ACCESS_TOKEN)$)/i.test(key))delete process.env[key];
  globalThis.fetch=()=>{throw Error('Offline continuation forbids network')};
  process.env.VERIFIER_PLAYWRIGHT_MODULE=path.join(c.verifierNodeModules,'playwright');
  const {loadCapturedNativeJobs}=await import('./verifier/local-snapshot-capture.mjs');
  const inputs=await loadCapturedNativeJobs({directory:path.join(c.root,'local-reports/snapshot-staging'),allowExtendedLocal:true});
  demand(inputs.captureSha256===c.captureSha256&&inputs.jobs.length===c.availableJobs&&inputs.coverage.missingBindings===12,'source replay cohort changed');
  const {rebuildSnapshotOverall}=await import('./rebuild-snapshot-overall.mjs');
  await rebuildSnapshotOverall({directory:path.join(c.root,'local-reports/snapshot-staging'),validateOnly:true});
  const {createLocalCaptureCheckpoint,createLocalNativePhaseReceipt}=await import('./local-capture-checkpoint.mjs');
  const {runNativeSnapshotPhase}=await import('./native-snapshot-phase.mjs');
  const {preparePublishedNativeBaseline}=await import('./published-native-baseline.mjs');
  const {loadTrustedPublishedEventTotalsBaseline}=await import('./published-event-totals-baseline.mjs');
  const {updatePublicSnapshot}=await import('./update-public-snapshot.mjs');
  const checkpoint=createLocalCaptureCheckpoint({root:c.root,directory:c.receiptDirectory,recipientPublicKey:await fs.readFile(c.recoveryPublicKeyFile,'utf8'),sourceCommit:c.testedCommit});
  const baseline=await loadTrustedPublishedEventTotalsBaseline({root:c.root,expectedGeneration:c.publishedBaseline.generation,expectedIndexSha256:c.publishedBaseline.indexSha256});
  const result=await updatePublicSnapshot({root:c.root,offline:true,verificationAuthority:'snapshot-native',
   prepareNativeCapture:()=>preparePublishedNativeBaseline({root:c.root,publishedBaseline:c.publishedBaseline}),captureCheckpoint:checkpoint,
   nativePhase:createLocalNativePhaseReceipt({root:c.root,directory:c.receiptDirectory,owner,testedCommit:c.testedCommit,nativePhase:runNativeSnapshotPhase}),
   nativePhaseOptions:{sourceCommit:c.testedCommit,publishedEventTotalsBaseline:baseline,maxJobs:10000,maxRuntimeMs:1500000,
    proofCheckpoint:({directory,sourceBinding,ledgerManifestHash})=>checkpoint({directory,sourceCommit:c.testedCommit,phase:'native-proofs',sourceBinding,ledgerManifestHash})}});
  const {recordCapture}=await import('./workflow-capture-coordination.mjs');
  const binding=await recordCapture({root:c.root,startedAt:c.originalStartedAt});
  demand(binding.reusable===true,'package/ledger/cohort audit failed');
  return {generation:result.generation,directory:result.directory,published:result.published,deferred:result.deferred,nativeVerification:result.nativeVerification,binding};
 },record});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
