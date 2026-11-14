import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {runLocalOvernightCapture,assertClaimedLocalAdmission,validateLocalEvidence,validatePriorLocalCapture,validateReplacementContext,localCaptureFailure,writeLocalCaptureReceipt} from './local-overnight-capture.mjs';
import {publishLocalCaptureCommit,reconcileLocalPublication} from './local-capture-git.mjs';
import {assertLocalCaptureOwner} from './local-capture-worker.mjs';
import {OVERNIGHT_SNAPSHOT as N} from './overnight-snapshot-plan.mjs';
const source='a'.repeat(40),receipt={ready:true,targetDate:N.date,execution:'local',oneOffAuthority:'firestore',testedCommit:source,captureOnly:true,claimTag:N.claimTag,
  replacementAuthorization:{id:N.authorizationId,requestedBy:'user',publicationMode:'capture-first',automaticRetry:false},
  priorAccounting:{directDocumentReadReservations:37,workerRequests:88},
  scheduledCaptureAt:new Date(N.start).toISOString(),replayDocumentLimit:1000};
function fixture(patch={}){
  const calls=[];let guarded=false;
  const step=(name,value)=>async()=>{calls.push(name);if(['claim','auth','capture','publish'].includes(name))assert.equal(guarded,true);return value;};
  return {calls,options:{receipt,now:()=>N.start,inspect:step('inspect',{head:source,complete:true}),
    preflight:step('checkpoint-preflight'),
    acquireGuard:async()=>{calls.push('guard');guarded=true;return true;},claim:step('claim',true),authenticate:step('auth'),
    capture:step('capture',{published:true,generation:73,nativeVerification:{backendReads:0,backendWrites:0,reuseOnly:true,counts:{nativeDispatched:0,newProofs:0}}}),publish:step('publish',{publicationCommit:'b'.repeat(40)}),
    record:async value=>calls.push(value.status),...patch}};
}
test('local capture orders exact-source inspection, both guards, auth, capture and publication',async()=>{
  const f=fixture();assert.equal((await runLocalOvernightCapture(f.options)).status,'complete');
  assert.deepEqual(f.calls,['inspect','checkpoint-preflight','guard','admission-started','claim','auth','capturing','capture','publish','complete']);
});
test('early, late, unready and hosted receipts cause zero requests',async()=>{
  for(const patch of [{now:()=>N.start-1},{now:()=>N.latestCaptureStart},{receipt:{...receipt,ready:false}},{receipt:{...receipt,execution:'hosted'}}]){
    const f=fixture(patch);await assert.rejects(runLocalOvernightCapture(f.options));assert.deepEqual(f.calls,[]);
  }
});
test('changed source, active jobs, existing claim or guard prevent document capture',async()=>{
  for(const admission of [{head:'b'.repeat(40),complete:true},{head:source,complete:true,active:true},{head:source,claimed:true,complete:true},{head:source,complete:false}]){
    const f=fixture({inspect:async()=>admission});assert.notEqual((await runLocalOvernightCapture(f.options)).status,'complete');assert.equal(f.calls.includes('capture'),false);
  }
  const f=fixture({acquireGuard:async()=>false});assert.equal((await runLocalOvernightCapture(f.options)).status,'blocked');assert.equal(f.calls.includes('claim'),false);
});
test('ambiguous claim, auth rejection and missing replay failures are terminal with no automatic retry',async()=>{
  for(const name of ['claim','authenticate','capture','publish']){
    let attempts=0;const f=fixture({[name]:async()=>{attempts++;throw Error('injected failure');}});
    await assert.rejects(runLocalOvernightCapture(f.options),/injected/);assert.equal(attempts,1);assert.equal(f.calls.at(-1),'failed');assert.equal(f.calls.includes('complete'),false);
  }
});
test('deferred capture and nonzero offline usage can never reach publication',async()=>{
  for(const result of [null,{deferred:true},{published:true,nativeVerification:{backendReads:1,backendWrites:0}}]){
    const f=fixture({capture:async()=>result});await assert.rejects(runLocalOvernightCapture(f.options));assert.equal(f.calls.includes('publish'),false);
  }
});
test('time is checked again after admission and before publication',async()=>{
  let tick=0;const f=fixture({now:()=>++tick===1?N.start:N.latestCaptureStart});await assert.rejects(runLocalOvernightCapture(f.options));assert.equal(f.calls.includes('capture'),false);
  tick=0;const late=fixture({now:()=>++tick<3?N.start:N.deadline});await assert.rejects(runLocalOvernightCapture(late.options));assert.equal(late.calls.includes('publish'),false);
});
test('readiness requires real unchanged test files and accepted local signer',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'local-capture-evidence-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const bytes=Buffer.from('# pass 1\n# fail 0\n'),files=['one','two','three'].map(name=>path.join(dir,name+'.tap'));
  for(const file of files)await fs.writeFile(file,bytes);
  const tests=files.map(file=>({file,sha256:createHash('sha256').update(bytes).digest('hex'),passed:1})),file=files[0];
  const valid={tests,localSignerAccepted:true,publicationRequiresCompleteReplays:true};
  await validateLocalEvidence(valid);await assert.rejects(validateLocalEvidence({...valid,localSignerAccepted:false}));
  await assert.rejects(validateLocalEvidence({...valid,tests:[tests[0],tests[0],tests[0]]}),/Duplicate/);
  await fs.writeFile(file,'changed');await assert.rejects(validateLocalEvidence(valid),/changed/);
});
test('capture child requires matching owner and admits only once before any credential access',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'local-capture-owner-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const owner=randomUUID(),receiptFile=path.join(dir,'ready.json'),real=Date.now;
  t.mock.method(Date,'now',()=>N.start);
  await fs.writeFile(path.join(dir,'running.json'),JSON.stringify({owner,testedCommit:source}));
  await fs.writeFile(path.join(dir,'state.json'),JSON.stringify({owner,status:'capturing',sourceCommit:source}));
  await assert.rejects(assertLocalCaptureOwner({receipt,receiptFile,owner:randomUUID()}),/binding/);
  await assertLocalCaptureOwner({receipt,receiptFile,owner});await assert.rejects(assertLocalCaptureOwner({receipt,receiptFile,owner}),e=>e.code==='EEXIST');
});

test('initial state-write failure reaches the terminal handler without claiming or capturing',async()=>{
  const records=[],original=Object.assign(Error('sensitive disk path'),{code:'ENOSPC'});
  const f=fixture({record:async value=>{if(value.status==='admission-started')throw original;records.push(value);}});
  await assert.rejects(runLocalOvernightCapture(f.options),error=>error===original);
  assert.equal(f.calls.includes('claim'),false);assert.equal(f.calls.includes('capture'),false);
  assert.equal(records[0].status,'failed');assert.equal(records[0].phase,'admission-receipt');assert.equal(records[0].errorCode,'ENOSPC');
  assert.equal(JSON.stringify(records).includes('sensitive'),false);
});
test('failure receipt errors never mask the original error and remain in sanitized diagnostics',async()=>{
  const original=Object.assign(Error('sensitive capture output'),{code:'EIO'});
  const f=fixture({capture:async()=>{throw original;},record:async value=>{
    if(value.status==='failed')throw Object.assign(Error('sensitive receipt output'),{code:'ENOSPC'});}});
  await assert.rejects(runLocalOvernightCapture(f.options),error=>error===original);
  assert.deepEqual(localCaptureFailure(original),{phase:'capture',errorCode:'EIO',failureReceiptError:'ENOSPC'});
});
test('successful push followed by completion-write failure retains acknowledged commit without retry',async()=>{
  const records=[],candidate='b'.repeat(40);let pushes=0,captures=0;
  const f=fixture({capture:async()=>{captures++;return {published:true,generation:73,nativeVerification:{backendReads:0,backendWrites:0,reuseOnly:true,counts:{nativeDispatched:0,newProofs:0}}};},
    publish:async(result,onState)=>publishLocalCaptureCommit({sourceCommit:source,directory:'public-snapshots73',deadline:N.deadline,now:()=>N.start,
      git:args=>{if(args[0]==='push')pushes++;return args[0]==='rev-parse'?args[1]==='HEAD'?candidate:source:'';},
      record:async value=>records.push(value),onState}),
    record:async value=>{if(value.status==='complete')throw Object.assign(Error('completion disk full'),{code:'ENOSPC'});records.push(value);}});
  await assert.rejects(runLocalOvernightCapture(f.options),/completion disk full/);
  const failure=records.at(-1);assert.equal(failure.status,'failed');assert.equal(failure.phase,'completion-receipt');
  assert.equal(failure.candidateCommit,candidate);assert.equal(failure.publicationCommit,candidate);
  assert.equal(failure.publicationState,'push-acknowledged');assert.equal(failure.errorCode,'ENOSPC');
  assert.equal(captures,1);assert.equal(pushes,1);assert.equal(failure.automaticRetry,false);
});
test('lost push acknowledgement reaches terminal receipt with candidate and unknown state',async()=>{
  const records=[],candidate='b'.repeat(40);let pushes=0;
  const f=fixture({publish:async(result,onState)=>publishLocalCaptureCommit({sourceCommit:source,directory:'public-snapshots73',deadline:N.deadline,now:()=>N.start,
    git:args=>{if(args[0]==='push'){pushes++;throw Object.assign(Error('sensitive push output'),{code:'LOCAL_GIT_TIMEOUT'});}
      return args[0]==='rev-parse'?args[1]==='HEAD'?candidate:source:'';},record:async value=>records.push(value),onState}),
    record:async value=>records.push(value)});
  await assert.rejects(runLocalOvernightCapture(f.options));
  const failure=records.at(-1);assert.equal(failure.phase,'publication-push');assert.equal(failure.publicationState,'unknown');
  assert.equal(failure.candidateCommit,candidate);assert.equal(failure.publicationCommit,undefined);assert.equal(pushes,1);
  assert.equal(JSON.stringify(records).includes('sensitive'),false);
});
test('missing publication commit cannot produce complete receipt',async()=>{
  const records=[],f=fixture({publish:async()=>({}),record:async value=>records.push(value)});
  await assert.rejects(runLocalOvernightCapture(f.options),/real commit/);
  assert.equal(records.at(-1).phase,'publication-validation');assert.equal(records.some(r=>r.status==='complete'),false);
});
test('checkpoint preflight failure occurs before any guard, claim, credential access or capture',async()=>{
  const original=Object.assign(Error('checkpoint recipient unavailable'),{code:'EACCES'});
  const f=fixture({preflight:async()=>{throw original;}});
  await assert.rejects(runLocalOvernightCapture(f.options),error=>error===original);
  assert.deepEqual(f.calls,['inspect']);assert.equal(original.captureFailure.phase,'checkpoint-preflight');
  assert.equal(original.captureFailure.errorCode,'EACCES');
});
test('malformed, non-string and mismatched publication commits never complete',async()=>{
  for(const publication of [{publicationCommit:'mock'},{publicationCommit:'g'.repeat(40)},{publicationCommit:null},
    {publicationCommit:123},{publicationCommit:{toString:()=>'b'.repeat(40)}},
    {publicationCommit:'b'.repeat(40),candidateCommit:'c'.repeat(40)}]){
    const records=[],f=fixture({publish:async()=>publication,record:async value=>records.push(value)});
    await assert.rejects(runLocalOvernightCapture(f.options));
    assert.equal(records.at(-1).status,'failed');assert.equal(records.some(r=>r.status==='complete'),false);
  }
});
function unattendedFixture({loseAcknowledgement=true,completionFailures=0,readMain=async()=>'b'.repeat(40)}={}){
  const candidate='b'.repeat(40),records=[],counters={capture:0,push:0,read:0,completion:0};
  const original=Object.assign(Error('original publication failure'),{code:'EIO'});
  const f=fixture({capture:async()=>{counters.capture++;return {published:true,generation:73,directory:'public-snapshots73',nativeVerification:{backendReads:0,backendWrites:0,reuseOnly:true,counts:{nativeDispatched:0,newProofs:0}}};},
    publish:async(result,onState)=>publishLocalCaptureCommit({sourceCommit:source,directory:result.directory,deadline:N.deadline,now:()=>N.start,
      git:async args=>{if(args[0]==='push'){counters.push++;if(loseAcknowledgement)throw original;}
        return args[0]==='rev-parse'?args[1]==='HEAD'?candidate:source:'';},record:async value=>records.push(value),onState}),
    reconcilePublication:async identity=>{assert.equal(identity.candidateCommit,candidate);assert.equal(identity.sourceCommit,source);
      assert.equal(identity.generation,73);assert.equal(identity.snapshotDirectory,'public-snapshots73');
      return reconcileLocalPublication({candidateCommit:identity.candidateCommit,readMain:async()=>{counters.read++;return readMain();}});},
    record:async value=>{if(value.status==='complete'){counters.completion++;if(counters.completion<=completionFailures)throw original;}records.push(value);}});
  return {...f,records,counters,original,candidate};
}
test('unattended lost push acknowledgement reconciles exact main once and completes without another capture or push',async()=>{
  const f=unattendedFixture(),result=await runLocalOvernightCapture(f.options);
  assert.equal(result.status,'complete');assert.equal(result.reconciled,true);assert.equal(result.publicationCommit,f.candidate);
  assert.equal(result.publicationState,'remote-main-matches');assert.equal(f.records.at(-1).status,'complete');
  assert.deepEqual(f.counters,{capture:1,push:1,read:1,completion:1});
});
test('completion receipt failure after acknowledged push self-repairs through one read-only reconciliation',async()=>{
  const f=unattendedFixture({loseAcknowledgement:false,completionFailures:1}),result=await runLocalOvernightCapture(f.options);
  assert.equal(result.reconciled,true);assert.equal(result.reconciledFailure.phase,'completion-receipt');
  assert.deepEqual(f.counters,{capture:1,push:1,read:1,completion:2});
});
test('nonmatching or unavailable remote main remains unknown and terminal with no capture/push retry',async()=>{
  for(const readMain of [async()=>source,async()=>{throw Error('lookup failed');}]){
    const f=unattendedFixture({readMain});await assert.rejects(runLocalOvernightCapture(f.options));
    assert.deepEqual(f.counters,{capture:1,push:1,read:1,completion:0});
    assert.equal(f.records.at(-1).status,'failed');assert.equal(f.records.at(-1).publicationState,'unknown');
  }
  const f=unattendedFixture();f.options.reconcilePublication=async()=>{f.counters.read++;throw Error('capability failed');};
  await assert.rejects(runLocalOvernightCapture(f.options));assert.equal(f.counters.read,1);
  assert.equal(f.records.at(-1).reconciliationError,'LOCAL_RECONCILIATION_FAILED');
});
test('second completion receipt failure preserves the original error and never repeats reconciliation',async()=>{
  const f=unattendedFixture({loseAcknowledgement:false,completionFailures:2});
  await assert.rejects(runLocalOvernightCapture(f.options),error=>error===f.original);
  assert.deepEqual(f.counters,{capture:1,push:1,read:1,completion:2});
  const failed=f.records.at(-1);assert.equal(failed.status,'failed');assert.equal(failed.publicationState,'remote-main-matches');
  assert.equal(failed.reconciliationReceiptError,'EIO');assert.equal(failed.publicationCommit,f.candidate);
});
test('capture exceptions never reconcile even when the error supplies spoofed publication metadata',async()=>{
  const original=Object.assign(Error('capture failed'),{captureFailure:{candidateCommit:'b'.repeat(40),publicationState:'unknown'}});
  const f=fixture({capture:async()=>{throw original;},reconcilePublication:()=>assert.fail('capture must not reconcile')});
  await assert.rejects(runLocalOvernightCapture(f.options),error=>error===original);
});
test('unattended reconciliation rejects mismatched identity and is skipped at the publication deadline',async()=>{
  const f=unattendedFixture();f.options.reconcilePublication=async()=>({candidateCommit:source,publicationState:'remote-main-matches'});
  await assert.rejects(runLocalOvernightCapture(f.options));assert.equal(f.records.at(-1).publicationState,'unknown');
  const g=unattendedFixture();let expired=false;
  const publish=g.options.publish;g.options.publish=async(...args)=>{try{return await publish(...args);}finally{expired=true;}};
  g.options.now=()=>expired?N.deadline:N.start;
  await assert.rejects(runLocalOvernightCapture(g.options));assert.equal(g.counters.read,0);
});
test('receipts are separately preserved, atomically replaced, and require the existing guard owner',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'local-parent-receipts-')),owner=randomUUID();
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  await fs.writeFile(path.join(directory,'running.json'),JSON.stringify({owner}));
  for(const status of ['publication-candidate','publication-attempt','publication-acknowledged','complete','failed']){
    await writeLocalCaptureReceipt({directory,owner,value:{status,candidateCommit:'b'.repeat(40)}});
    assert.equal(JSON.parse(await fs.readFile(path.join(directory,status+'.json'),'utf8')).owner,owner);
  }
  await writeLocalCaptureReceipt({directory,owner,value:{status:'capturing'}});
  await writeLocalCaptureReceipt({directory,owner,value:{status:'capturing',generation:73}});
  assert.equal(JSON.parse(await fs.readFile(path.join(directory,'state.json'),'utf8')).generation,73);
  await assert.rejects(writeLocalCaptureReceipt({directory,owner:randomUUID(),value:{status:'complete'}}),/ownership/);
  const running=await fs.readFile(path.join(directory,'running.json')),failed=await fs.readFile(path.join(directory,'failed.json'));
  await writeLocalCaptureReceipt({directory,owner,value:{status:'reconciled-complete',candidateCommit:'b'.repeat(40)}});
  assert((await fs.readFile(path.join(directory,'running.json'))).equals(running));
  assert((await fs.readFile(path.join(directory,'failed.json'))).equals(failed));
  await assert.rejects(writeLocalCaptureReceipt({directory,owner,value:{status:'reconciled-complete'}}),{code:'EEXIST'});
  assert.equal(JSON.parse(await fs.readFile(path.join(directory,'reconciled-complete.json'),'utf8')).candidateCommit,'b'.repeat(40));
  assert.equal((await fs.readdir(directory)).some(name=>name.endsWith('.tmp')),false);
});

async function priorReceiptFixture(t,{completed=true,patch={}}={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'local-prior-receipt-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const file=path.join(directory,'prior.json'),publicationCommit='b'.repeat(40);
  const plan={priorOutcome:completed?'complete':'failed',priorSource:source,priorPublicationCommit:publicationCommit};
  const value={status:completed?'complete':'failed',sourceCommit:source,...(completed?
    {publicationCommit,generation:73,binding:{reusable:true,directory:'public-snapshots73'}}:{}),...patch};
  const bytes=JSON.stringify(value);await fs.writeFile(file,bytes);
  const evidence={file,sha256:createHash('sha256').update(bytes).digest('hex')};
  return {directory,file,value,plan,evidence,receipt:{[completed?'priorCompletion':'priorFailure']:evidence}};
}

test('prior complete evidence requires the exact planned publication and reusable generation binding',async t=>{
  const f=await priorReceiptFixture(t);
  assert.deepEqual(await validatePriorLocalCapture(f.receipt,{plan:f.plan}),
    {status:'complete',publicationCommit:f.plan.priorPublicationCommit});
  await assert.rejects(validatePriorLocalCapture(f.receipt,{plan:{...f.plan,priorPublicationCommit:source}}),/exact-bound/);
});

for(const [name,patch] of [
  ['failed status',{status:'failed'}],['nonterminal status',{status:'capturing'}],
  ['wrong publication',{publicationCommit:'c'.repeat(40)}],['absent publication',{publicationCommit:null}],
  ['missing binding',{binding:null}],['nonreusable binding',{binding:{reusable:false,directory:'public-snapshots73'}}],
  ['truthy reusable flag',{binding:{reusable:'true',directory:'public-snapshots73'}}],
  ['wrong directory',{binding:{reusable:true,directory:'public-snapshots74'}}],
  ['path traversal',{binding:{reusable:true,directory:'../public-snapshots73'}}],
  ['generation changed',{generation:74}]
])test('prior complete evidence rejects independently hashed '+name,async t=>{
  const f=await priorReceiptFixture(t,{patch});
  await assert.rejects(validatePriorLocalCapture(f.receipt,{plan:f.plan}),/exact-bound/);
});

for(const generation of [undefined,'73',0,-1,1.5])
test('prior completed generation must be a positive integer: '+String(generation),async t=>{
  const f=await priorReceiptFixture(t,{patch:{generation,binding:{reusable:true,directory:'public-snapshots'+generation}}});
  await assert.rejects(validatePriorLocalCapture(f.receipt,{plan:f.plan}),/exact-bound/);
});

test('prior evidence chooses only the planned outcome and preserves failed-source validation',async t=>{
  const good=await priorReceiptFixture(t),failed=await priorReceiptFixture(t,{completed:false});
  assert.deepEqual(await validatePriorLocalCapture(failed.receipt,{plan:failed.plan}),{status:'failed',publicationCommit:null});
  await assert.rejects(validatePriorLocalCapture(failed.receipt,{plan:good.plan}),/evidence required/);
  await assert.rejects(validatePriorLocalCapture(good.receipt,{plan:failed.plan}),/evidence required/);
  await assert.rejects(validatePriorLocalCapture(failed.receipt,{plan:{...failed.plan,priorSource:'c'.repeat(40)}}),/exact-bound/);
  const mixed={...good.receipt,...failed.receipt};
  assert.equal((await validatePriorLocalCapture(mixed,{plan:good.plan})).status,'complete');
  assert.equal((await validatePriorLocalCapture(mixed,{plan:failed.plan})).status,'failed');
});

test('changed prior bytes fail their fingerprint even when receipt fields remain valid',async t=>{
  for(const completed of [false,true]){
    const f=await priorReceiptFixture(t,{completed});await fs.appendFile(f.file,'\n');
    await assert.rejects(validatePriorLocalCapture(f.receipt,{plan:f.plan}),/evidence changed/);
  }
});

test('prior evidence rejects missing absolute file and invalid SHA bindings before reading',async t=>{
  const f=await priorReceiptFixture(t);
  for(const evidence of [undefined,{}, {...f.evidence,file:'prior.json'}, {...f.evidence,sha256:''},
    {...f.evidence,sha256:'z'.repeat(64)}, {...f.evidence,sha256:'a'.repeat(63)}])
    await assert.rejects(validatePriorLocalCapture({priorCompletion:evidence},{plan:f.plan}),/evidence required/);
});

test('unsafe or missing prior evidence is rejected without accepting receipt contents',async t=>{
  const f=await priorReceiptFixture(t);
  await assert.rejects(validatePriorLocalCapture({priorCompletion:{...f.evidence,file:f.directory}},{plan:f.plan}),/Unsafe/);
  await assert.rejects(validatePriorLocalCapture({priorCompletion:{...f.evidence,file:path.join(f.directory,'missing.json')}},{plan:f.plan}),{code:'ENOENT'});
  await fs.writeFile(f.file,Buffer.alloc(1024*1024+1));
  await assert.rejects(validatePriorLocalCapture(f.receipt,{plan:f.plan}),/Unsafe/);
});

test('symlink prior evidence is rejected before following or reading the target',async t=>{
  const f=await priorReceiptFixture(t);
  t.mock.method(fs,'lstat',async()=>({isFile:()=>true,isSymbolicLink:()=>true,size:100}));
  t.mock.method(fs,'readFile',()=>assert.fail('must not follow evidence symlink'));
  await assert.rejects(validatePriorLocalCapture(f.receipt,{plan:f.plan}),/Unsafe/);
});

test('malformed prior JSON never becomes valid completion evidence',async t=>{
  const f=await priorReceiptFixture(t),bytes='{incomplete';await fs.writeFile(f.file,bytes);
  f.evidence.sha256=createHash('sha256').update(bytes).digest('hex');
  await assert.rejects(validatePriorLocalCapture(f.receipt,{plan:f.plan}),SyntaxError);
});

 test('post-claim metadata failure prevents authentication and capture while preserving the failed receipt',async()=>{
  let checked=0;const f=fixture({revalidateAdmission:async()=>{checked++;throw Error('source advanced');}});
  await assert.rejects(runLocalOvernightCapture(f.options),/source advanced/);assert.equal(checked,1);
  assert.equal(f.calls.includes('claim'),true);assert.equal(f.calls.includes('auth'),false);assert.equal(f.calls.includes('capture'),false);assert.equal(f.calls.at(-1),'failed');
});
 test('post-claim revalidation cannot consume the admission window and still authenticate',async()=>{
  let clock=N.start;const f=fixture({now:()=>clock,revalidateAdmission:async()=>{clock=N.latestCaptureStart;}});
  await assert.rejects(runLocalOvernightCapture(f.options),/authorized time window/);assert.equal(f.calls.includes('auth'),false);assert.equal(f.calls.at(-1),'failed');
});

test('post-claim admission requires exact own claim and complete idle job inventory',()=>{
  const valid={head:source,claimed:true,claimSource:source,active:false,complete:true};assert.doesNotThrow(()=>assertClaimedLocalAdmission(valid,source));
  for(const patch of [{head:'b'.repeat(40)},{claimed:false},{claimSource:'b'.repeat(40)},{active:true},{active:undefined},{complete:false},{complete:undefined}])
    assert.throws(()=>assertClaimedLocalAdmission({...valid,...patch},source),/Admission changed/);
  assert.throws(()=>assertClaimedLocalAdmission(null,source),/Admission changed/);
  assert.throws(()=>assertClaimedLocalAdmission(valid,'not-a-source'),/Admission changed/);
});

test('capture-first postvalidation rejects any native dispatch/new proofs or missing reuse-only claim',async()=>{
 for(const verification of [{backendReads:0,backendWrites:0,reuseOnly:false,counts:{nativeDispatched:0,newProofs:0}},
 {backendReads:0,backendWrites:0,reuseOnly:true,counts:{nativeDispatched:1,newProofs:0}},
 {backendReads:0,backendWrites:0,reuseOnly:true,counts:{nativeDispatched:0,newProofs:1}},
 {backendReads:0,backendWrites:0,reuseOnly:true,counts:{}}]){
  const f=fixture({capture:async()=>({published:true,nativeVerification:verification})});
  await assert.rejects(runLocalOvernightCapture(f.options),/Capture-only/);assert.equal(f.calls.includes('publish'),false);
 }
});

test('replacement namespace/accounting validation reads immutable failed attempt and rejects resets/changed evidence',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'replacement-admission-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const priorDir=path.join(root,'2026-11-13','overnight-local'),directory=path.join(root,'2026-11-14','replacement-local');
 await fs.mkdir(priorDir,{recursive:true});await fs.mkdir(directory,{recursive:true});
 const failure=path.join(priorDir,'failed.json'),log=path.join(priorDir,'capture.log');
 const failureBytes=JSON.stringify({status:'failed',sourceCommit:N.priorSource});
 const operations={directDocumentReadReservations:37,workerRequests:88,maxDirectReservations:40000,maxWorkerRequests:1024,documentWrites:0};
 await fs.writeFile(failure,failureBytes);await fs.writeFile(log,JSON.stringify({fullSnapshotOperations:operations})+'\n');
 const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
 const r={...receipt,replacementDirectory:directory.replace(/\\/g,'/'),priorFailure:{file:failure,sha256:hash(failureBytes)},priorAccounting:{...receipt.priorAccounting,evidence:{file:log,sha256:hash(await fs.readFile(log))}}};
 assert.deepEqual(await validateReplacementContext(r,{directory}),{priorDirectReservations:37,priorWorkerRequests:88});
 assert.equal(await fs.readFile(failure,'utf8'),failureBytes);
 await assert.rejects(validateReplacementContext(r,{directory:priorDir}),/distinct private/);
 await assert.rejects(validateReplacementContext({...r,replacementDirectory:priorDir},{directory}),/distinct private/);
 await fs.appendFile(log,'changed');await assert.rejects(validateReplacementContext(r,{directory}),/log changed/);
 await fs.writeFile(log,JSON.stringify({fullSnapshotOperations:{...operations,directDocumentReadReservations:0}})+'\n');
 r.priorAccounting.evidence.sha256=hash(await fs.readFile(log));await assert.rejects(validateReplacementContext(r,{directory}),/carry exact/);
});
