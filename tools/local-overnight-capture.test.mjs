import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {runLocalOvernightCapture,validateLocalEvidence} from './local-overnight-capture.mjs';
import {assertLocalCaptureOwner} from './local-capture-worker.mjs';
import {OVERNIGHT_SNAPSHOT as N} from './overnight-snapshot-plan.mjs';
const source='a'.repeat(40),receipt={ready:true,targetDate:N.date,execution:'local',oneOffAuthority:'snapshot-native',testedCommit:source,
  scheduledCaptureAt:new Date(N.start).toISOString(),replayDocumentLimit:1000};
function fixture(patch={}){
  const calls=[];let guarded=false;
  const step=(name,value)=>async()=>{calls.push(name);if(['claim','auth','capture','publish'].includes(name))assert.equal(guarded,true);return value;};
  return {calls,options:{receipt,now:()=>N.start,inspect:step('inspect',{head:source,complete:true}),
    acquireGuard:async()=>{calls.push('guard');guarded=true;return true;},claim:step('claim',true),authenticate:step('auth'),
    capture:step('capture',{published:true,generation:73,nativeVerification:{backendReads:0,backendWrites:0}}),publish:step('publish',{publicationCommit:'b'.repeat(40)}),
    record:async value=>calls.push(value.status),...patch}};
}
test('local capture orders exact-source inspection, both guards, auth, capture and publication',async()=>{
  const f=fixture();assert.equal((await runLocalOvernightCapture(f.options)).status,'complete');
  assert.deepEqual(f.calls,['inspect','guard','admission-started','claim','auth','capturing','capture','publish','complete']);
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
