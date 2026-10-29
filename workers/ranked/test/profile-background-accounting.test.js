import test from 'node:test';
import assert from 'node:assert/strict';
import {handleRequest} from '../src/index.js';
import {eventEncode} from '../src/events-store.js';

const origin='https://accounting-audit.invalid';
const send=env=>new Request(origin+'/v1/profile/notify',{method:'POST',headers:{Origin:origin},body:JSON.stringify({accountId:'audit-racer'})});

function fixture(t,{fail=false}={}) {
  t.mock.method(globalThis,'fetch',async()=>assert.fail('network forbidden'));
  const logs=[];t.mock.method(console,'log',(label,body)=>logs.push({label,...JSON.parse(body)}));
  t.mock.method(console,'error',()=>{});
  let release;const gate=new Promise(resolve=>{release=resolve;});
  let successfulWrites=0;
  const env={ALLOWED_ORIGINS:origin,OPEN_BETA_ENABLED:'false',__TEST_UID:'owner',
    PB_NOTIFY_RATE_LIMITER:{limit:async()=>({success:true})},__TEST_FIRESTORE:async(path,init={})=>{
      if(path===':commit') {
        await gate;
        if(fail)throw Error('FIRESTORE_503');
        successfulWrites+=JSON.parse(init.body).writes.length;
        return {writeResults:[{updateTime:'v2'}]};
      }
      if(init.method==='PATCH'){successfulWrites++;return {updateTime:'v1'};}
      if(path===':runQuery')return [];
      if(path==='/0.6.2_profiles_public/audit-racer')return {fields:eventEncode({accountId:'audit-racer',ownerUid:'owner',nickname:'Racer'}).mapValue.fields,updateTime:'2026-10-01T00:00:00Z'};
      return null;
    }};
  return {env,logs,release,writes:()=>successfulWrites};
}

test('deferred completion emits separate final costs, with no foreground double counting',async t=>{
  const f=fixture(t),tasks=[];
  assert.equal((await handleRequest(send(),f.env,{waitUntil:p=>tasks.push(p)})).status,202);
  assert.equal(f.logs.length,1);
  const foreground=f.logs[0];
  assert.equal(foreground.measurementScope,'request_synchronous');
  assert.equal(foreground.writeEstimate,1);
  assert.equal(foreground.documentReadEstimate,5);
  f.release();await Promise.all(tasks);
  const background=f.logs.find(row=>row.measurementScope==='background_profile_job_final');
  assert.ok(background);assert.equal(f.logs.length,2);
  assert.equal(background.httpRequests,1);assert.equal(background.documentReadEstimate,0);
  assert.equal(background.writeEstimate,1);assert.equal(background.deleteEstimate,0);
  assert.equal(foreground.writeEstimate+background.writeEstimate,f.writes());
  assert.equal(f.writes(),2,'before: one logged write; after: two, once each');
});

test('failed background writes report unknown, not zero, and still emit a final record',async t=>{
  const f=fixture(t,{fail:true}),tasks=[];
  await handleRequest(send(),f.env,{waitUntil:p=>tasks.push(p)});
  f.release();await Promise.all(tasks);
  const background=f.logs.find(row=>row.measurementScope==='background_profile_job_final');
  assert.equal(background.writeEstimate,null);
  assert.equal(background.deleteEstimate,0);
  assert.equal(background.documentReadEstimate,0);
  assert.equal(background.failedRequests,1);assert.equal(background.unknownWriteRequests,1);
  assert.equal(f.logs.find(row=>row.measurementScope==='request_synchronous').writeEstimate,1);
});

test('without waitUntil the job is awaited but still accounted separately',async t=>{
  const f=fixture(t);f.release();
  assert.equal((await handleRequest(send(),f.env)).status,202);
  assert.equal(f.logs.length,2);
  assert.equal(f.logs.reduce((sum,row)=>sum+row.writeEstimate,0),2);
});

test('a throwing waitUntil still awaits the job and emits its final record',async t=>{
  const f=fixture(t);f.release();
  assert.equal((await handleRequest(send(),f.env,{waitUntil:()=>{throw Error('context closed');}})).status,202);
  assert.equal(f.logs.filter(row=>row.measurementScope==='background_profile_job_final').length,1);
});
