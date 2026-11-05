import test from 'node:test';
import assert from 'node:assert/strict';
import {kickoffCaptureRepair} from './capture-repair-kickoff.mjs';
import {CAPTURE_REPAIR as R,CAPTURE_REPAIR_SECOND as R2} from './capture-repair-plan.mjs';
import {generateKeyPairSync} from 'node:crypto';
const sha='a'.repeat(40),receipt={ready:true,replacementAuthorized:true,targetDate:R.date,testedCommit:sha,preflightRunId:5,evidence:['tests']};
function fixture({head=sha,preflight='success',claimed=false,active=[],ambiguous=false,locked=false,second=false}={}){
 const calls=[],records=[];let guarded=false;
 const policy=second?R2:R,localReceipt=second?{...receipt,repairAttempt:'repair-2',recoveryPublicKey:generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({type:'spki',format:'pem'})}:receipt;
 return {calls,records,args:{receipt:localReceipt,now:policy.start,token:'fixture',acquireGuard:async()=>{guarded=!locked;return guarded;},record:async value=>records.push(value),fetchImpl:async(url,options)=>{
  calls.push({url,method:options.method||'GET'});assert.equal(options.redirect,'error');assert.ok(url.startsWith('https://api.github.com/repos/StaticQuasar931/PolyTrack-0.6.3-Ranked/'));
  const r=(status,value)=>({status,json:async()=>value});
  if(url.endsWith('/git/ref/heads/main'))return r(200,{object:{sha:head}});
  if(url.endsWith('/actions/runs/5'))return r(200,{name:'Check private snapshot access',status:'completed',conclusion:preflight,head_sha:sha,run_attempt:1});
  if(url.endsWith('/actions/runs/'+policy.priorFailureRunId))return r(200,{status:'completed',conclusion:'failure',head_sha:policy.priorSource,run_attempt:1});
  if(url.endsWith('/git/ref/'+(policy.priorClaimRef??'refs/tags/polytrack-oneoff-2026-11-05').slice(5)))return r(200,{object:{sha:policy.priorSource}});
  if(url.endsWith('/git/ref/'+policy.claimRef.slice(5)))return r(claimed?200:404,{});
  if(url.includes('/actions/runs?'))return r(200,{workflow_runs:active});
  assert.equal(options.method,'POST');assert.equal(guarded,true);assert.equal(records[0].status,'dispatch-requested');
  assert.deepEqual(JSON.parse(options.body),{ref:'main',inputs:{expected_source_commit:sha,...(second?{repair_attempt:'repair-2',recovery_public_key:localReceipt.recoveryPublicKey}:{})}});
  if(ambiguous)throw Error('transport');return r(204);
 }}};
}
test('replacement requires proven private access, original failure, metadata checks and exclusive guard',async()=>{
 const f=fixture();assert.equal((await kickoffCaptureRepair(f.args)).status,'dispatched');assert.equal(f.calls.filter(x=>x.method==='POST').length,1);
});

test('second replacement binds prior failed capture and passes only a public recovery key',async()=>{
 const f=fixture({second:true});assert.equal((await kickoffCaptureRepair(f.args)).status,'dispatched');
 assert.equal(f.calls.filter(x=>x.method==='POST').length,1);
 const invalid=fixture({second:true});invalid.args.receipt.recoveryPublicKey='not a public key';
 await assert.rejects(kickoffCaptureRepair(invalid.args),/Public/);assert.equal(invalid.calls.length,0);
});
test('bad readiness or expired window never makes a request',async()=>{
 for(const patch of [{receipt:{...receipt,ready:false}},{receipt:{...receipt,replacementAuthorized:false}},{now:R.latestStart}]){
  const f=fixture();await assert.rejects(kickoffCaptureRepair({...f.args,...patch}));assert.equal(f.calls.length,0);
 }
});
test('wrong source, failed preflight, existing claim, active work and guards cannot dispatch',async()=>{
 for(const options of [{head:'b'.repeat(40)},{preflight:'failure'},{claimed:true},{active:[{name:'Verifier',id:7}]},{locked:true}]){
  const f=fixture(options);try{assert.notEqual((await kickoffCaptureRepair(f.args)).status,'dispatched');}catch(e){assert.equal(options.preflight,'failure');}
  assert.equal(f.calls.filter(x=>x.method==='POST').length,0);
 }
});
test('ambiguous dispatch is recorded once, never retried',async()=>{
 const f=fixture({ambiguous:true});await assert.rejects(kickoffCaptureRepair(f.args),/Ambiguous/);
 assert.equal(f.records.at(-1).status,'dispatch-outcome-unknown');assert.equal(f.calls.filter(x=>x.method==='POST').length,1);
});
