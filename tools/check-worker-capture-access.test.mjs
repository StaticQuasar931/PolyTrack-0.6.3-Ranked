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
