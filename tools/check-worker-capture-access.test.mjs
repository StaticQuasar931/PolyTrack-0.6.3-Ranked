import test from 'node:test';
import assert from 'node:assert/strict';
import {checkWorkerCaptureAccess} from './check-worker-capture-access.mjs';

test('capture preflight requires the zero-database authentication probe',async()=>{
  let calls=0;
  await checkWorkerCaptureAccess({fetchImpl:async(url,init)=>{
    calls++;
    assert.equal(new URL(url).pathname,'/v1/capture-auth');
    assert.equal(init.headers.Origin,'https://staticquasar931.github.io');
    return new Response(null,{status:204});
  }});
  assert.equal(calls,1);
  for(const status of [200,301,401,403,429,500])await assert.rejects(checkWorkerCaptureAccess({
    fetchImpl:async()=>new Response(null,{status})}),/before database access/);
});

test('fresh capture rejects an undeployed read guard before any data route',async()=>{
 for(const marker of [null,'old','combined-v1']){
  let calls=0;const options={requiredReadGuard:'combined-v1',fetchImpl:async url=>{
   calls++;assert.equal(new URL(url).pathname,'/v1/capture-auth');
   return new Response(null,{status:204,headers:marker?{'X-PolyTrack-Capture-Read-Guard':marker}:{}});
  }};
  if(marker==='combined-v1')await checkWorkerCaptureAccess(options);
  else await assert.rejects(checkWorkerCaptureAccess(options),/deployed/);
  assert.equal(calls,1);
 }
});
