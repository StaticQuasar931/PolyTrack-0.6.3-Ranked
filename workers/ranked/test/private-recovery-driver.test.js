import test from 'node:test';
import assert from 'node:assert/strict';
import {runBoundedRecovery,MAX_CALLS} from '../docs/private/recover-2397.mjs';

const start=Date.UTC(2026,10,8),old='a'.repeat(64),fresh='b'.repeat(64);
const input={workerOrigin:'https://polytrack-ranked-worker.offline.workers.dev',allowedOrigin:'https://offline.invalid',
  trackId:'offline-track',generation:old,checkpointVersion:'old-v1',expectedCount:2397,sourceCount:1900,recoverExpired:true};
const pending=(i,count=100+i*200)=>({pending:true,complete:false,generation:fresh,
  checkpointVersion:'new-v'+i,sourceCount:count,continueAfterMs:30000,deadlineAt:start+50*60000});
function fixture(handler) {
  let clock=start;const calls=[],sleeps=[],progress=[];
  const options={token:'offline-fixture-only',expectedWorkerOrigin:input.workerOrigin,now:()=>clock,
    sleep:async ms=>{sleeps.push(ms);clock+=ms;},onProgress:value=>progress.push(value),
    fetchImpl:async(url,init)=>{calls.push({url:String(url),...init});return handler(calls.length-1,init);}};
  return {calls,sleeps,progress,options,run:(change={})=>runBoundedRecovery({...input,...change},options)};
}
test('private recovery reaches 2397 server completion in 13 calls, never retries auth or discovery',async()=>{
  const f=fixture(i=>Response.json(i===12?{pending:false,complete:true,revision:1729}:pending(i)));
  assert.deepEqual(await f.run(),{complete:true,calls:13,elapsedMs:360000,independentRowCountAudit:false});
  assert.equal(f.sleeps.length,12);assert(f.sleeps.every(ms=>ms===30000));
  for(const [i,call]of f.calls.entries()) {
    const body=JSON.parse(call.body);assert.equal(body.recoverExpired,i===0);
    assert.equal(body.generation,i===0?old:fresh);
    assert.equal(body.checkpointVersion,i===0?'old-v1':'new-v'+(i-1));
    assert.equal(call.redirect,'error');assert.equal(call.method,'POST');
    assert.equal(new URL(call.url).pathname,'/v1/admin/track-build/continue');
  }
  assert.doesNotMatch(JSON.stringify(f.progress),/offline-fixture|generation|checkpointVersion|offline-track/);
});
for(const status of [301,401,403,409,429,500,503])test('any non-200 stops after one call: '+status,async()=>{
  const f=fixture(()=>new Response('private server data',{status}));
  await assert.rejects(f.run(),/STOP_HTTP_NON_200/);assert.equal(f.calls.length,1);assert.equal(f.sleeps.length,0);
});
test('lost/timeout response is ambiguous and never repeated',async()=>{
  const f=fixture(()=>{throw Error('private transport detail');});
  await assert.rejects(f.run(),/STOP_AMBIGUOUS_TRANSPORT/);assert.equal(f.calls.length,1);
});
test('strict fifteen-call ceiling even if server keeps advancing small pages',async()=>{
  const f=fixture(i=>Response.json(pending(i,i+1)));
  await assert.rejects(f.run(),/STOP_CALL_LIMIT/);assert.equal(MAX_CALLS,15);assert.equal(f.calls.length,15);
});
for(const bad of [{generation:old},{sourceCount:101},{checkpointVersion:'old-v1'},
  {deadlineAt:start},{continueAfterMs:0},{complete:true},{sourceCount:0}])
test('response fencing stops without retry: '+Object.keys(bad)[0]+JSON.stringify(bad),async()=>{
  const f=fixture(()=>Response.json({...pending(0),...bad}));
  await assert.rejects(f.run(),/STOP_RESPONSE/);assert.equal(f.calls.length,1);
});
test('generation changes and clock/readpoint relabels after recovery stop immediately',async()=>{
  for(const bad of [{generation:'c'.repeat(64)},{deadlineAt:start+49*60000},{sourceCount:100}]) {
    const f=fixture(i=>Response.json(i?{...pending(i),...bad}:pending(i)));
    await assert.rejects(f.run(),/STOP_RESPONSE_FENCE/);assert.equal(f.calls.length,2);
  }
});
test('malformed/oversized/non-json response stops; no response content is reflected',async()=>{
  for(const response of [new Response('secret',{headers:{'content-type':'text/plain'}}),
    new Response('{',{headers:{'content-type':'application/json'}}),
    new Response('x'.repeat(4097),{headers:{'content-type':'application/json'}})]) {
    const f=fixture(()=>response);await assert.rejects(f.run(),/STOP_RESPONSE/);assert.equal(f.calls.length,1);
  }
});
test('wrong host/secret/missing checkpoint fails before transport',async()=>{
  for(const bad of [{workerOrigin:'http://offline.invalid'},{workerOrigin:'https://other.offline.workers.dev'},
    {recoverExpired:false},{expectedCount:5000},{checkpointVersion:''}]) {
    const f=fixture(()=>assert.fail('no transport'));await assert.rejects(f.run(bad),/STOP_/);assert.equal(f.calls.length,0);
  }
  const f=fixture(()=>assert.fail('no transport'));f.options.token='';await assert.rejects(f.run(),/STOP_AUTH_INPUT/);
});
