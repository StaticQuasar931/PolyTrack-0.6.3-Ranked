import {fullSnapshotPolicy} from './full-snapshot-policy.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {localOvernightCapturePlan,OVERNIGHT_SNAPSHOT as N} from './overnight-snapshot-plan.mjs';
import {acquireOvernightCaptureClaim} from './overnight-capture-claim.mjs';
import {snapshotPublicationFiles} from './local-capture-publication.mjs';
import {runBoundedCaptureProcess} from './local-capture-process.mjs';
import {createLocalCaptureGit,assertBoundedLocalSource,publishLocalCaptureCommit,reconcileLocalPublication} from './local-capture-git.mjs';
import {prepareLocalArchiveReplayRepair} from './local-archive-replay-repair.mjs';
import {preflightLocalCaptureCheckpoints} from './local-capture-checkpoint.mjs';
const REPO='StaticQuasar931/PolyTrack-0.6.3-Ranked',BASE='https://api.github.com/repos/'+REPO;
const PASSIVE=new Set(['Publish CDN release','pages build and deployment']);

export async function runLocalOvernightCapture({receipt,now=Date.now,inspect,preflight,acquireGuard,claim,authenticate,capture,publish,record,reconcilePublication}={}){
  localOvernightCapturePlan({now:now(),receipt});
  for(const fn of [inspect,preflight,acquireGuard,claim,authenticate,capture,publish,record])if(typeof fn!=='function')throw Error('Local capture capability missing');
  if(reconcilePublication!==undefined&&typeof reconcilePublication!=='function')throw Error('Invalid read-only reconciliation capability');
  const admission=await inspect();
  if(admission.head!==receipt.testedCommit)return {status:'blocked',reason:'tested-source-changed'};
  if(admission.claimed)return {status:'already-claimed'};
  if(admission.active||!admission.complete)return {status:'waiting',reason:'active-or-incomplete-job-inventory'};
  try{await preflight();}catch(error){
    if(error&&typeof error==='object')error.captureFailure=localCaptureFailure(error,{phase:'checkpoint-preflight'});
    throw error;
  }
  if(!await acquireGuard())return {status:'blocked',reason:'existing-local-guard'};
  let phase='admission-receipt',publication={},generation,snapshotDirectory;
  try{
    await record({status:'admission-started',sourceCommit:receipt.testedCommit});
    phase='claim';
    if(!await claim()){await record({status:'already-claimed'});return {status:'already-claimed'};}
    phase='admission-revalidation';
    localOvernightCapturePlan({now:now(),receipt});
    phase='authentication';
    await authenticate();
    phase='capture-start-receipt';
    await record({status:'capturing',sourceCommit:receipt.testedCommit});
    phase='capture';
    const result=await capture();
    phase='capture-postvalidation';
    if(!result||result.deferred||result.published!==true||result.nativeVerification?.backendReads!==0||result.nativeVerification?.backendWrites!==0)
      throw Error('Capture deferred or offline proof assertion failed; retain recovery, do not publish');
    if(now()>=N.deadline)throw Error('Publication deadline reached; preserve candidate');
    generation=result.generation;snapshotDirectory=result.directory;phase='publication-validation';
    const published=await publish(result,value=>{publication={...publication,...value};phase=value.phase||phase;});
    publication={...publication,...published};
    if(typeof publication.publicationCommit!=='string'||!/^[a-f0-9]{40}$/.test(publication.publicationCommit))throw Error('Publication did not return a real commit');
    if(publication.candidateCommit!==undefined&&publication.candidateCommit!==publication.publicationCommit)throw Error('Publication commit does not match the candidate');
    phase='completion-receipt';
    await record({status:'complete',sourceCommit:receipt.testedCommit,generation:result.generation,...publication});
    return {status:'complete',generation:result.generation,...publication};
  }catch(error){
    const details=localCaptureFailure(error,{...publication,phase,generation});
    if(reconcilePublication&&typeof publication.candidateCommit==='string'&&/^[a-f0-9]{40}$/.test(publication.candidateCommit)&&
      Number.isSafeInteger(generation)&&generation>0&&snapshotDirectory==='public-snapshots'+generation&&
      ['unknown','push-acknowledged'].includes(publication.publicationState)&&now()<N.deadline){
      const candidateCommit=publication.candidateCommit;
      try{
        const observed=await reconcilePublication({candidateCommit,sourceCommit:receipt.testedCommit,generation,snapshotDirectory});
        if(observed?.candidateCommit===candidateCommit&&observed.publicationState==='remote-main-matches'&&now()<N.deadline){
          details.publicationState='remote-main-matches';details.publicationCommit=candidateCommit;
          const complete={status:'complete',sourceCommit:receipt.testedCommit,generation,snapshotDirectory,candidateCommit,
            publicationCommit:candidateCommit,publicationState:'remote-main-matches',reconciled:true,automaticRetry:false,
            reconciledFailure:{...details}};
          try{await record(complete);return complete;}
          catch(receiptError){details.reconciliationReceiptError=localCaptureFailure(receiptError).errorCode;}
        }else{details.publicationState='unknown';details.reconciliationError='LOCAL_RECONCILIATION_UNCONFIRMED';}
      }catch{details.publicationState='unknown';details.reconciliationError='LOCAL_RECONCILIATION_FAILED';}
    }
    try{await record({status:'failed',sourceCommit:receipt.testedCommit,reason:'local-capture-or-publication-failed',automaticRetry:false,...details});}
    catch(recordError){details.failureReceiptError=localCaptureFailure(recordError).errorCode;}
    if(error&&typeof error==='object')error.captureFailure=details;
    throw error;
  }
}

export function localCaptureFailure(error,context={}){
  const state={...context,...error?.captureFailure};
  const phases=new Set(['preflight','checkpoint-preflight','admission-receipt','claim','admission-revalidation','authentication','capture-start-receipt','capture',
    'capture-postvalidation','publication-validation','publication-commit','publication-parent-validation','publication-candidate-receipt',
    'publication-pre-push','publication-push','publication-acknowledgement-receipt','completion-receipt','source-validation','credential','git','reconciliation-receipt']);
  const details={phase:phases.has(state.phase)?state.phase:'preflight',errorCode:'LOCAL_CAPTURE_FAILED'};
  const code=error?.code;
  if(/^(?:LOCAL_[A-Z_]{1,64}|EACCES|EPERM|ENOENT|ENOSPC|EIO|EEXIST|ETIMEDOUT|SNAPSHOT_REPLAYS_INCOMPLETE)$/.test(code||''))details.errorCode=code;
  for(const key of ['candidateCommit','publicationCommit'])if(typeof state[key]==='string'&&/^[a-f0-9]{40}$/.test(state[key]))details[key]=state[key];
  if(['not-attempted','unknown','push-acknowledged','remote-main-matches'].includes(state.publicationState))details.publicationState=state.publicationState;
  if(Number.isSafeInteger(state.generation)&&state.generation>0)details.generation=state.generation;
  if(/^(?:LOCAL_[A-Z_]{1,64}|EACCES|EPERM|ENOENT|ENOSPC|EIO|EEXIST|ETIMEDOUT)$/.test(state.failureReceiptError||''))details.failureReceiptError=state.failureReceiptError;
  for(const key of ['reconciliationReceiptError','reconciliationError'])if(/^(?:LOCAL_[A-Z_]{1,64}|EACCES|EPERM|ENOENT|ENOSPC|EIO|EEXIST|ETIMEDOUT)$/.test(state[key]||''))details[key]=state[key];
  return details;
}

export async function writeLocalCaptureReceipt({directory,owner,value}){
  const current=JSON.parse(await fs.readFile(path.join(directory,'running.json'),'utf8'));
  if(current.owner!==owner)throw Error('Local guard ownership changed');
  const names={'complete':'complete.json','failed':'failed.json','publication-candidate':'publication-candidate.json',
    'publication-attempt':'publication-attempt.json','publication-acknowledged':'publication-acknowledged.json','reconciled-complete':'reconciled-complete.json'};
  const file=path.join(directory,names[value.status]||'state.json'),temporary=file+'.'+randomUUID()+'.tmp';
  try{
    const handle=await fs.open(temporary,'wx',0o600);
    try{await handle.writeFile(JSON.stringify({...value,owner,at:new Date().toISOString()})+'\n');await handle.sync();}
    finally{await handle.close();}
    if(value.status==='reconciled-complete'){await fs.link(temporary,file);await fs.unlink(temporary);}
    else await fs.rename(temporary,file);
  }catch(error){await fs.rm(temporary,{force:true}).catch(()=>{});throw error;}
}

export async function validateLocalEvidence(receipt){
  if(!Array.isArray(receipt.tests)||receipt.tests.length<3)throw Error('Test evidence required');
  const seen=new Set();
  for(const entry of receipt.tests){
    if(!path.isAbsolute(entry.file||'')||!entry.file.endsWith('.tap')||! /^[a-f0-9]{64}$/.test(entry.sha256||'')||!(entry.passed>0))throw Error('Invalid test evidence');
    if(seen.has(path.resolve(entry.file)))throw Error('Duplicate test evidence');seen.add(path.resolve(entry.file));
    const info=await fs.lstat(entry.file);
    if(!info.isFile()||info.isSymbolicLink()||info.size>200*1024*1024)throw Error('Unsafe test evidence');
    const bytes=await fs.readFile(entry.file),text=bytes.toString('utf8');
    if(createHash('sha256').update(bytes).digest('hex')!==entry.sha256||
      ! /^(?:#|\u2139) fail 0\r?$/m.test(text)||Number(/^(?:#|\u2139) pass (\d+)\r?$/m.exec(text)?.[1])!==entry.passed)
      throw Error('Test evidence changed');
  }
  if(receipt.localSignerAccepted!==true||receipt.publicationRequiresCompleteReplays!==true)throw Error('Capture signer or strict replay gate not ready');
}

async function main(){
  const args=process.argv.slice(2);
  if(args.length!==2||args[0]!=='--receipt'||!path.isAbsolute(args[1]))throw Error('Usage: node tools/local-overnight-capture.mjs --receipt ABSOLUTE_READY_JSON');
  const receipt=JSON.parse(await fs.readFile(args[1],'utf8')),directory=path.dirname(args[1]),owner=randomUUID();
  localOvernightCapturePlan({receipt});fullSnapshotPolicy(receipt);await validateLocalEvidence(receipt);
  const workspace=receipt.workspace;
  if(!path.isAbsolute(workspace||'')||!path.isAbsolute(receipt.credentialFile||'')||!path.isAbsolute(receipt.recoveryPublicKeyFile||'')||
    !path.isAbsolute(receipt.verifierNodeModules||''))throw Error('Explicit private workspace, dependencies and credential paths required');
  const git=createLocalCaptureGit({workspace,deadline:N.deadline});
  await assertBoundedLocalSource({workspace,sourceCommit:receipt.testedCommit,runnerFile:fileURLToPath(import.meta.url),deadline:N.deadline});
  const require=createRequire(import.meta.url),modulePath=path.join(receipt.verifierNodeModules,'playwright');
  const installed=JSON.parse(await fs.readFile(path.join(modulePath,'package.json'),'utf8'));
  const declared=JSON.parse(await fs.readFile(path.join(workspace,'tools/verifier/package.json'),'utf8'));
  if(installed.version!==declared.dependencies.playwright)throw Error('Pinned local verifier dependency changed');
  await fs.stat(require(modulePath).chromium.executablePath());
  const credential=await git(['credential','fill'],{input:'protocol=https\nhost=github.com\n\n'});
  const token=credential.split(/\r?\n/).find(v=>v.startsWith('password='))?.slice(9);
  if(!token)throw Error('Existing GitHub authorization unavailable');
  const read=async route=>{
    const remaining=N.deadline-Date.now();if(remaining<=0)throw Error('Publication metadata deadline reached');
    const r=await fetch(BASE+route,{headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json'},redirect:'error',signal:AbortSignal.timeout(Math.min(20000,remaining))});
    if(r.status===404)return null;if(!r.ok)throw Error('GitHub admission metadata unavailable');return r.json();
  };
  const record=value=>writeLocalCaptureReceipt({directory,owner,value});
  const result=await runLocalOvernightCapture({receipt,
    preflight:async()=>{await preflightLocalCaptureCheckpoints({workspace,directory,recoveryPublicKeyFile:receipt.recoveryPublicKeyFile});
      if(receipt.archiveReplayRepair)await prepareLocalArchiveReplayRepair({directory:path.join(workspace,'local-reports/snapshot-staging'),
        planFile:receipt.archiveReplayRepair.file,planSha256:receipt.archiveReplayRepair.sha256,maxDocuments:receipt.archiveReplayRepair.maxDocuments});},
    reconcilePublication:({candidateCommit})=>reconcileLocalPublication({candidateCommit,readMain:async()=>(await read('/git/ref/heads/main'))?.object?.sha}),
    inspect:async()=>{
      const head=await read('/git/ref/heads/main'),claimed=await read('/git/ref/tags/polytrack-oneoff-'+N.date);
      for(const status of ['in_progress','queued','waiting','pending','requested']){
        const rows=await read('/actions/runs?status='+status+'&per_page=100');
        if(!Array.isArray(rows?.workflow_runs)||rows.workflow_runs.length>=100)return {complete:false};
        if(rows.workflow_runs.some(r=>!PASSIVE.has(r.name)))return {head:head?.object?.sha,claimed:!!claimed,complete:true,active:true};
      }
      return {head:head?.object?.sha,claimed:!!claimed,complete:true,active:false};
    },
    acquireGuard:async()=>{
      for(const name of ['complete.json','failed.json','running.json','dispatch.json'])if(await fs.lstat(path.join(directory,name)).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;}))return false;
      try{await fs.writeFile(path.join(directory,'running.json'),JSON.stringify({owner,testedCommit:receipt.testedCommit,startedAt:new Date().toISOString()})+'\n',{flag:'wx',mode:0o600});return true;}
      catch(e){if(e.code==='EEXIST')return false;throw e;}
    },
    claim:async()=>(await acquireOvernightCaptureClaim({repository:REPO,sourceCommit:receipt.testedCommit,token})).acquired,
    authenticate:async()=>{
      const {checkWorkerCaptureAccess}=await import('./check-worker-capture-access.mjs');
      const {createWorkerCaptureFetch}=await import('./worker-capture-fetch.mjs');
      await checkWorkerCaptureAccess({fetchImpl:createWorkerCaptureFetch({serviceAccount:await fs.readFile(receipt.credentialFile,'utf8')})});
    },
    capture:async()=>{
      const log=await fs.open(path.join(directory,'capture.log'),'wx',0o600);
      let child;try{child=await runBoundedCaptureProcess({file:process.execPath,
        args:['--use-system-ca',path.join(workspace,'tools/local-capture-worker.mjs'),args[1],owner],timeoutMs:N.jobTimeoutMinutes*60000,
        options:{cwd:workspace,stdio:['ignore',log.fd,log.fd,'ipc'],env:{...process.env,NODE_OPTIONS:'--use-system-ca',
          NODE_PATH:receipt.verifierNodeModules,VERIFIER_PLAYWRIGHT_MODULE:path.join(receipt.verifierNodeModules,'playwright')}},
        recoverAfterTimeout:async()=>{
          const staging=path.join(workspace,'local-reports/snapshot-staging');
          if(!await fs.lstat(staging).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;}))return;
          const {encryptCaptureRecovery}=await import('./capture-recovery.mjs');
          await encryptCaptureRecovery({directory:staging,sourceCommit:receipt.testedCommit,
            outputFile:path.join(directory,'timeout.ptenc'),recipientPublicKey:await fs.readFile(receipt.recoveryPublicKeyFile,'utf8'),
            attempt:'overnight-capture',phase:'failure-state'});
        }});
      }finally{await log.close();}
      if(child.timedOut||child.status!==0)throw Error('Local bounded capture failed; inspect private capture.log, do not repeat');
      return JSON.parse(await fs.readFile(path.join(directory,'capture-result.json'),'utf8'));
    },
    publish:async(result,onState)=>{
      const {captureBinding}=await import('./workflow-capture-coordination.mjs');
      if((await captureBinding(workspace)).reusable!==true)throw Error('Candidate capture is not a consistent cohort');
      const {nativeLedgerPublicationFiles}=await import('./verifier/local-snapshot-verification.mjs');
      const files=['events/public-catalog.json','tools/workflow-capture-state.json','index.html','snapshot-current.json',
        ...await nativeLedgerPublicationFiles(workspace),...await snapshotPublicationFiles({root:workspace,directory:result.directory})];
      const allowed=new Set(files);
      if((await git(['diff','--name-only','HEAD','--diff-filter=ACMRTUXB'])).trim().split('\n').filter(Boolean).some(file=>!allowed.has(file))||
        (await git(['ls-files','--others','--exclude-standard','-z'])).split('\0').filter(Boolean).some(file=>!allowed.has(file)&&!file.startsWith('local-reports/')))
        throw Error('Unexpected source or untracked change during capture');
      // Bounded argv batches fit Windows; never stage arbitrary neighboring files.
      for(let i=0;i<files.length;i+=100)await git(['add','--',...files.slice(i,i+100)]);
      await git(['add','-u','--',':(glob)public-snapshots[0-9]*/**']);
      const staged=(await git(['diff','--cached','--name-only','--diff-filter=ACMRTUXB'])).trim().split('\n').filter(Boolean);
      if(staged.some(file=>!allowed.has(file)))throw Error('Unexpected capture publication file');
      return publishLocalCaptureCommit({git,sourceCommit:receipt.testedCommit,directory:result.directory,record,onState,deadline:N.deadline});
    },record});
  console.log(JSON.stringify(result));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))
  main().catch(error=>{console.error(JSON.stringify({...localCaptureFailure(error),automaticRetry:false}));process.exitCode=1;});
