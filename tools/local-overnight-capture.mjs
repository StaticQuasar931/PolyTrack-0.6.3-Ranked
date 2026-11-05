import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync,execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {localOvernightCapturePlan,OVERNIGHT_SNAPSHOT as N} from './overnight-snapshot-plan.mjs';
import {acquireOvernightCaptureClaim} from './overnight-capture-claim.mjs';
import {assertLocalSource,snapshotPublicationFiles} from './local-capture-publication.mjs';
import {runBoundedCaptureProcess} from './local-capture-process.mjs';
const REPO='StaticQuasar931/PolyTrack-0.6.3-Ranked',BASE='https://api.github.com/repos/'+REPO;
const PASSIVE=new Set(['Publish CDN release','pages build and deployment']);

export async function runLocalOvernightCapture({receipt,now=Date.now,inspect,acquireGuard,claim,authenticate,capture,publish,record}={}){
  localOvernightCapturePlan({now:now(),receipt});
  for(const fn of [inspect,acquireGuard,claim,authenticate,capture,publish,record])if(typeof fn!=='function')throw Error('Local capture capability missing');
  const admission=await inspect();
  if(admission.head!==receipt.testedCommit)return {status:'blocked',reason:'tested-source-changed'};
  if(admission.claimed)return {status:'already-claimed'};
  if(admission.active||!admission.complete)return {status:'waiting',reason:'active-or-incomplete-job-inventory'};
  if(!await acquireGuard())return {status:'blocked',reason:'existing-local-guard'};
  await record({status:'admission-started',sourceCommit:receipt.testedCommit});
  try{
    if(!await claim()){await record({status:'already-claimed'});return {status:'already-claimed'};}
    localOvernightCapturePlan({now:now(),receipt});
    await authenticate();
    await record({status:'capturing',sourceCommit:receipt.testedCommit});
    const result=await capture();
    if(!result||result.deferred||result.published!==true||result.nativeVerification?.backendReads!==0||result.nativeVerification?.backendWrites!==0)
      throw Error('Capture deferred or offline proof assertion failed; retain recovery, do not publish');
    if(now()>=N.deadline)throw Error('Publication deadline reached; preserve candidate');
    const publication=await publish(result);
    await record({status:'complete',sourceCommit:receipt.testedCommit,generation:result.generation,...publication});
    return {status:'complete',generation:result.generation,...publication};
  }catch(error){
    await record({status:'failed',sourceCommit:receipt.testedCommit,reason:'local-capture-or-publication-failed',automaticRetry:false});
    throw error;
  }
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
  localOvernightCapturePlan({receipt});await validateLocalEvidence(receipt);
  const workspace=receipt.workspace;
  if(!path.isAbsolute(workspace||'')||!path.isAbsolute(receipt.credentialFile||'')||!path.isAbsolute(receipt.recoveryPublicKeyFile||'')||
    !path.isAbsolute(receipt.verifierNodeModules||''))throw Error('Explicit private workspace, dependencies and credential paths required');
  const git=(args,options={})=>execFileSync('git',args,{cwd:workspace,encoding:'utf8',env:{...process.env,GIT_TERMINAL_PROMPT:'0'},...options});
  await assertLocalSource({workspace,sourceCommit:receipt.testedCommit,runnerFile:fileURLToPath(import.meta.url)});
  const require=createRequire(import.meta.url),modulePath=path.join(receipt.verifierNodeModules,'playwright');
  const installed=JSON.parse(await fs.readFile(path.join(modulePath,'package.json'),'utf8'));
  const declared=JSON.parse(await fs.readFile(path.join(workspace,'tools/verifier/package.json'),'utf8'));
  if(installed.version!==declared.dependencies.playwright)throw Error('Pinned local verifier dependency changed');
  await fs.stat(require(modulePath).chromium.executablePath());
  const c=spawnSync('git',['credential','fill'],{encoding:'utf8',input:'protocol=https\nhost=github.com\n\n',env:{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'Never'}});
  const token=c.status===0?c.stdout.split(/\r?\n/).find(v=>v.startsWith('password='))?.slice(9):null;
  if(!token)throw Error('Existing GitHub authorization unavailable');
  const read=async route=>{
    const r=await fetch(BASE+route,{headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json'},redirect:'error',signal:AbortSignal.timeout(20000)});
    if(r.status===404)return null;if(!r.ok)throw Error('GitHub admission metadata unavailable');return r.json();
  };
  const record=async value=>{
    const current=JSON.parse(await fs.readFile(path.join(directory,'running.json'),'utf8'));
    if(current.owner!==owner)throw Error('Local guard ownership changed');
    const file=path.join(directory,value.status==='complete'?'complete.json':value.status==='failed'?'failed.json':'state.json');
    await fs.writeFile(file,JSON.stringify({...value,owner,at:new Date().toISOString()})+'\n',{mode:0o600});
  };
  const result=await runLocalOvernightCapture({receipt,
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
    publish:async result=>{
      const {captureBinding}=await import('./workflow-capture-coordination.mjs');
      if((await captureBinding(workspace)).reusable!==true)throw Error('Candidate capture is not a consistent cohort');
      const {nativeLedgerPublicationFiles}=await import('./verifier/local-snapshot-verification.mjs');
      const files=['events/public-catalog.json','tools/workflow-capture-state.json','index.html','snapshot-current.json',
        ...await nativeLedgerPublicationFiles(workspace),...await snapshotPublicationFiles({root:workspace,directory:result.directory})];
      const allowed=new Set(files);
      if(git(['diff','--name-only','HEAD','--diff-filter=ACMRTUXB']).trim().split('\n').filter(Boolean).some(file=>!allowed.has(file))||
        git(['ls-files','--others','--exclude-standard','-z']).split('\0').filter(Boolean).some(file=>!allowed.has(file)&&!file.startsWith('local-reports/')))
        throw Error('Unexpected source or untracked change during capture');
      // Bounded argv batches fit Windows; never stage arbitrary neighboring files.
      for(let i=0;i<files.length;i+=100)git(['add','--',...files.slice(i,i+100)]);
      git(['add','-u','--',':(glob)public-snapshots[0-9]*/**']);
      const staged=git(['diff','--cached','--name-only','--diff-filter=ACMRTUXB']).trim().split('\n').filter(Boolean);
      if(staged.some(file=>!allowed.has(file)))throw Error('Unexpected capture publication file');
      git(['-c','user.name=github-actions[bot]','-c','user.email=41898282+github-actions[bot]@users.noreply.github.com','commit','-m','Sync public ranked snapshots']);
      if(git(['rev-parse','HEAD^']).trim()!==receipt.testedCommit)throw Error('Source parent changed; do not rebase proofs');
      if(Date.now()>=N.deadline)throw Error('Publication deadline reached; preserve committed candidate');
      git(['push','origin','HEAD:refs/heads/main']);
      return {publicationCommit:git(['rev-parse','HEAD']).trim(),snapshotDirectory:result.directory};
    },record});
  console.log(JSON.stringify(result));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
