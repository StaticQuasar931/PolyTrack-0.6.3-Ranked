import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {EventEmitter} from 'node:events';
import path from 'node:path';
import {runBoundedCaptureProcess} from './local-capture-process.mjs';
import {createLocalCaptureGit,assertBoundedLocalSource,publishLocalCaptureCommit,reconcileLocalPublication,completeReconciledLocalPublication} from './local-capture-git.mjs';

const source='a'.repeat(40),candidate='b'.repeat(40);
function gitFixture({reply={type:'git-result',stdout:'ok'},result={status:0,timedOut:false},patch={}}={}){
  const calls={};
  const git=createLocalCaptureGit({workspace:process.cwd(),deadline:15100,now:()=>80,
    spawnWorker:(file,argv,options)=>{Object.assign(calls,{file,argv,options});const child=new EventEmitter();
      child.send=(job,callback)=>{calls.job=job;callback?.();};return child;},
    runProcess:async options=>{calls.supervisor=options;const child=options.spawnImpl(options.file,options.args,options.options);
      child.emit('spawn');if(reply)child.emit('message',reply);return result;},...patch});
  return {git,calls};
}
test('every parent Git operation is inside a noninteractive owned wrapper with deadline-clamped budget',async()=>{
  for(const args of [['credential','fill'],['diff','--name-only'],['add','--','index.html'],['commit'],['push','origin','HEAD:refs/heads/main']]){
    const {git,calls}=gitFixture();
    assert.equal(await git(args,{input:'fixture'}),'ok');assert.equal(calls.file,process.execPath);
    assert.deepEqual(calls.job,{type:'git-job',args,input:'fixture'});assert.equal(calls.argv.at(-1),'--owned-git');
    assert.equal(calls.supervisor.timeoutMs,20);assert.equal(calls.supervisor.graceMs,0);
    assert.deepEqual(calls.options.stdio,['ignore','ignore','ignore','ipc']);
    assert.equal(calls.options.env.GIT_TERMINAL_PROMPT,'0');assert.equal(calls.options.env.GCM_INTERACTIVE,'Never');
  }
});
test('deadline reserves tree cleanup and ordinary Git work is capped at thirty seconds',async()=>{
  const git=createLocalCaptureGit({workspace:process.cwd(),deadline:15000,now:()=>0,runProcess:()=>assert.fail('expired spawn')});
  await assert.rejects(git(['push']),{code:'LOCAL_GIT_DEADLINE'});
  const {git:bounded,calls}=gitFixture({patch:{deadline:100000,now:()=>0}});await bounded(['status']);assert.equal(calls.supervisor.timeoutMs,30000);
});
test('unconfirmed tree, timeout, malformed IPC and nonzero exit never expose subprocess output',async()=>{
  for(const config of [{result:{status:null,timedOut:true}},{reply:{type:'git-error',code:'LOCAL_GIT_OUTPUT_LIMIT'}},
    {reply:{type:'git-error',code:'sensitive-output'}},{reply:{type:'git-result',stdout:42}},{reply:null},
    {result:{status:1,timedOut:false}},{patch:{runProcess:async()=>{throw Error('sensitive-output');}}}]){
    const {git}=gitFixture(config);
    await assert.rejects(git(['credential','fill']),error=>/^LOCAL_GIT_/.test(error.code)&&!JSON.stringify(error).includes('sensitive-output')&&!error.message.includes('sensitive-output'));
  }
});
test('real hung wrapper and stdout-holding descendant are both terminated before timeout failure returns',async t=>{
  let descendant,wrapper;
  t.after(()=>{
    if(!wrapper||wrapper.exitCode!==null||wrapper.signalCode!==null)return;
    if(process.platform==='win32')execFileSync(path.join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),['/PID',String(wrapper.pid),'/T','/F'],{windowsHide:true,timeout:5000,stdio:'ignore'});
    else process.kill(-wrapper.pid,'SIGKILL');
  });
  const code=`const {spawn}=require('node:child_process');process.once('message',()=>{const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','pipe','pipe'],windowsHide:true});process.send({type:'fixture-pid',pid:child.pid});setInterval(()=>{},1000);});`;
  const git=createLocalCaptureGit({workspace:process.cwd(),deadline:Date.now()+60000,
    runProcess:options=>runBoundedCaptureProcess({...options,timeoutMs:1000}),
    spawnWorker:(_file,_argv,options)=>{const child=spawn(process.execPath,['-e',code],options);wrapper=child;
      child.on('message',value=>{if(value.type==='fixture-pid')descendant=value.pid;});return child;}});
  await assert.rejects(git(['status']),{code:'LOCAL_GIT_TIMEOUT'});assert(Number.isSafeInteger(descendant));
  let alive=true;
  for(let i=0;i<20;i++){try{process.kill(descendant,0);}catch(error){if(error.code==='ESRCH'){alive=false;break;}throw error;}
    await new Promise(resolve=>setTimeout(resolve,50));}
  assert.equal(alive,false,'owned descendant must not outlive confirmed timeout termination');
});
test('actual owned Git worker returns bounded IPC output without credential or network operations',async()=>{
  const git=createLocalCaptureGit({workspace:process.cwd(),deadline:Date.now()+60000});
  assert.match(await git(['--version']),/^git version /);
});
test('existing source assertion runs in a bounded owned child without changing its policy',async()=>{
  await assertBoundedLocalSource({workspace:process.cwd(),sourceCommit:source,runnerFile:'fixture-runner',deadline:16000,now:()=>0,
    runProcess:async options=>{
      assert.equal(options.timeoutMs,1000);assert.equal(options.graceMs,0);assert.equal(options.file,process.execPath);
      assert.deepEqual(options.options.stdio,['ignore','ignore','ignore','ipc']);
      assert.match(options.args[2],/assertLocalSource/);assert.match(options.args[2],/fixture-runner/);
      return {status:0,timedOut:false};}});
  for(const result of [{status:0,timedOut:true},{status:1,timedOut:false},{status:0,signal:'SIGTERM',timedOut:false}])await assert.rejects(assertBoundedLocalSource({
    workspace:process.cwd(),deadline:16000,now:()=>0,runProcess:async()=>result}));
  await assert.rejects(assertBoundedLocalSource({deadline:15000,now:()=>0,runProcess:()=>assert.fail('expired source spawn')}),{code:'LOCAL_GIT_DEADLINE'});
});

function publicationFixture(patch={}){
  const calls=[],records=[];
  const options={sourceCommit:source,directory:'public-snapshots73',deadline:100,now:()=>0,
    git:async args=>{calls.push(args);if(args[0]==='rev-parse')return args[1]==='HEAD'?candidate:source;return '';},
    record:async value=>records.push(value),...patch};
  return {options,calls,records};
}
test('publication persists candidate and unknown attempt before exactly one push',async()=>{
  const f=publicationFixture();const git=f.options.git;
  f.options.git=args=>{if(args[0]==='push')assert.deepEqual(f.records.map(r=>r.status),['publication-candidate','publication-attempt']);return git(args);};
  const result=await publishLocalCaptureCommit(f.options);
  assert.equal(result.publicationCommit,candidate);assert.equal(result.publicationState,'push-acknowledged');
  assert.equal(f.calls.filter(c=>c[0]==='push').length,1);
  assert.deepEqual(f.calls.find(c=>c[0]==='push'),['push','origin',candidate+':refs/heads/main']);
  assert.deepEqual(f.records.map(r=>r.status),['publication-candidate','publication-attempt','publication-acknowledged']);
  assert.equal(f.records[1].publicationState,'unknown');assert.equal(f.records[1].automaticRetry,false);
});
test('lost push acknowledgement preserves candidate and uncertainty with no push retry',async()=>{
  const f=publicationFixture();const git=f.options.git;let pushes=0;
  f.options.git=args=>{if(args[0]==='push'){pushes++;throw Object.assign(Error('sensitive transport output'),{code:'LOCAL_GIT_TIMEOUT'});}return git(args);};
  await assert.rejects(publishLocalCaptureCommit(f.options),error=>{
    assert.equal(error.captureFailure.candidateCommit,candidate);assert.equal(error.captureFailure.publicationState,'unknown');
    assert.equal(error.captureFailure.phase,'publication-push');assert.equal(error.message.includes('sensitive'),false);return true;});
  assert.equal(pushes,1);assert.equal(f.records.at(-1).status,'publication-attempt');
});
test('candidate or attempt receipt failure forbids push and acknowledgement receipt failure retains successful push',async()=>{
  for(const status of ['publication-candidate','publication-attempt','publication-acknowledged']){
    const f=publicationFixture({record:async value=>{if(value.status===status)throw Object.assign(Error('disk full'),{code:'ENOSPC'});}});
    await assert.rejects(publishLocalCaptureCommit(f.options),error=>{
      assert.equal(error.code,'ENOSPC');assert.equal(error.captureFailure.candidateCommit,candidate);
      assert.equal(error.captureFailure.publicationState,status==='publication-acknowledged'?'push-acknowledged':status==='publication-attempt'?'unknown':'not-attempted');return true;});
    assert.equal(f.calls.filter(c=>c[0]==='push').length,status==='publication-acknowledged'?1:0);
  }
});
test('parent mismatch, invalid commit and publication deadline never push',async()=>{
  for(const patch of [{now:()=>100},{git:args=>args[0]==='rev-parse'?args[1]==='HEAD'?candidate:'c'.repeat(40):''},
    {git:args=>args[0]==='rev-parse'?'invalid':''}]){
    const f=publicationFixture(patch);let pushes=0;const git=f.options.git;
    f.options.git=args=>{if(args[0]==='push')pushes++;return git(args);};
    await assert.rejects(publishLocalCaptureCommit(f.options));assert.equal(pushes,0);
  }
});
test('deadline passing while attempt receipt is persisted still forbids push',async()=>{
  let time=0;const f=publicationFixture({now:()=>time,record:async value=>{if(value.status==='publication-attempt')time=100;}});
  await assert.rejects(publishLocalCaptureCommit(f.options),{code:'LOCAL_GIT_DEADLINE'});
  assert.equal(f.calls.some(c=>c[0]==='push'),false);
});
test('read-only reconciliation never declares completion or retries anything',async()=>{
  for(const main of [candidate,source]){
    let reads=0;const result=await reconcileLocalPublication({candidateCommit:candidate,readMain:async()=>{reads++;return main;}});
    assert.equal(reads,1);assert.equal(result.publicationState,main===candidate?'remote-main-matches':'unknown');
    assert.equal(result.automaticRetry,false);assert.equal(result.status,undefined);
  }
  assert.equal((await reconcileLocalPublication({candidateCommit:candidate,readMain:async()=>{throw Error('offline');}})).publicationState,'unknown');
  for(const candidateCommit of [undefined,'mock',{toString:()=>candidate}])await assert.rejects(reconcileLocalPublication({candidateCommit,readMain:async()=>candidate}),TypeError);
});
function reconciliationFixture(patch={}){
  const identity={candidateCommit:candidate,sourceCommit:source,generation:73,snapshotDirectory:'public-snapshots73'},records=[],reads=[];
  return {identity,records,reads,options:{...identity,readMain:async()=>{reads.push('main');return candidate;},
    auditCandidate:async requested=>{assert.deepEqual(requested,identity);return {...identity,captureReusable:true,packageLedgerValid:true,ledgerManifestHash:'d'.repeat(64)};},
    record:async value=>records.push(value),...patch}};
}
test('reconciled completion requires explicit identity, exact main and identity-bound local package/ledger audits',async()=>{
  const f=reconciliationFixture(),result=await completeReconciledLocalPublication(f.options);
  assert.equal(result.status,'reconciled-complete');assert.equal(result.publicationCommit,candidate);assert.equal(result.automaticRetry,false);
  assert.deepEqual(f.reads,['main','main']);assert.deepEqual(f.records,[result]);
  assert.equal(result.captureReusable,true);assert.equal(result.packageLedgerValid,true);
});
test('remote nonmatch or unavailable main stays unknown and performs no local audit or completion write',async()=>{
  for(const readMain of [async()=>source,async()=>{throw Error('offline');}]){
    const f=reconciliationFixture({readMain,auditCandidate:()=>assert.fail('no matching main'),record:()=>assert.fail('no completion')});
    const result=await completeReconciledLocalPublication(f.options);
    assert.equal(result.status,'reconciliation-blocked');assert.equal(result.publicationState,'unknown');assert.equal(result.automaticRetry,false);
    assert.equal(result.reason.includes('not-pushed'),false);
  }
});
test('unbound, failed or incomplete local audits cannot authorize reconciliation completion',async()=>{
  const identity=reconciliationFixture().identity;
  for(const audit of [true,{}, {...identity,captureReusable:true,packageLedgerValid:false,ledgerManifestHash:'d'.repeat(64)},
    {...identity,candidateCommit:source,captureReusable:true,packageLedgerValid:true,ledgerManifestHash:'d'.repeat(64)},
    {...identity,captureReusable:true,packageLedgerValid:true}]){
    const f=reconciliationFixture({auditCandidate:async()=>audit});
    assert.equal((await completeReconciledLocalPublication(f.options)).status,'reconciliation-blocked');assert.equal(f.records.length,0);
  }
  const f=reconciliationFixture({auditCandidate:async()=>{throw Error('private audit output');}});
  assert.equal((await completeReconciledLocalPublication(f.options)).reason,'local-audit-failed');assert.equal(f.records.length,0);
});
test('main changing during local audit is unknown, and completion-write failure never returns completion',async()=>{
  let reads=0;const f=reconciliationFixture({readMain:async()=>++reads===1?candidate:source});
  assert.equal((await completeReconciledLocalPublication(f.options)).publicationState,'unknown');assert.equal(f.records.length,0);
  const g=reconciliationFixture({record:async()=>{throw Error('private receipt output');}});
  await assert.rejects(completeReconciledLocalPublication(g.options),error=>{
    assert.equal(error.code,'LOCAL_RECONCILIATION_RECEIPT_FAILED');assert.equal(error.captureFailure.candidateCommit,candidate);
    assert.equal(error.message.includes('private'),false);return true;});
});

test('failed source assertion retains its tree root until confirmed supervisor termination',async()=>{
  await assert.rejects(assertBoundedLocalSource({workspace:process.cwd(),sourceCommit:source,runnerFile:'fixture-runner',deadline:Date.now()+60000,
    runProcess:options=>runBoundedCaptureProcess({...options,timeoutMs:1000})}),{code:'LOCAL_GIT_TIMEOUT'});
});
