import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {acquireOvernightCaptureClaim,overnightClaimRef} from './overnight-capture-claim.mjs';
import {OVERNIGHT_SNAPSHOT as N} from './overnight-snapshot-plan.mjs';

const repository='StaticQuasar931/PolyTrack-0.6.3-Ranked',sourceCommit='a'.repeat(40),token='test-only-token';
const response=(status,value)=>({status,json:async()=>value});
const ref=overnightClaimRef();

test('only the first scheduled/manual claimant acquires the shared source-bound marker',async()=>{
  let claimed=null,requests=0;
  const fetchImpl=async(url,options)=>{
    requests++;
    assert.ok(url.startsWith('https://api.github.com/repos/'+repository+'/git/'));
    assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer '+token);
    if(options.method==='POST'){
      assert.equal(url.endsWith('/git/refs'),true);
      const body=JSON.parse(options.body);assert.deepEqual(body,{ref,sha:sourceCommit});
      if(claimed)return response(422,{});
      claimed={ref,object:{sha:sourceCommit}};return response(201,claimed);
    }
    assert.equal(options.method,'GET');assert.ok(url.endsWith('/git/ref/tags/'+(N.claimTag||'polytrack-oneoff-'+N.date)));
    return response(200,claimed);
  };
  const both=await Promise.all([1,2].map(()=>acquireOvernightCaptureClaim({repository,sourceCommit,token,fetchImpl})));
  assert.equal(both.filter(x=>x.acquired).length,1);assert.equal(requests,3);
  assert.equal((await acquireOvernightCaptureClaim({repository,sourceCommit,token,fetchImpl})).acquired,false,'an admitted crash is not permission to repeat a capture');
});

test('an earlier different-source claim also prevents a duplicate capture',async()=>{
  const result=await acquireOvernightCaptureClaim({repository,sourceCommit,token,fetchImpl:async(_url,options)=>options.method==='POST'?response(422,{}):response(200,{ref,object:{sha:'b'.repeat(40)}})});
  assert.equal(result.acquired,false);assert.equal(result.sourceCommit,'b'.repeat(40));
});

test('claim failures and malformed/conflicting responses fail closed',async()=>{
  for(const status of [401,403,429,500])await assert.rejects(acquireOvernightCaptureClaim({repository,sourceCommit,token,fetchImpl:async()=>response(status,{})}),/failed/);
  await assert.rejects(acquireOvernightCaptureClaim({repository,sourceCommit,token,fetchImpl:async()=>response(201,{ref,object:{sha:'bad'}})}),/binding/);
  await assert.rejects(acquireOvernightCaptureClaim({repository,sourceCommit,token,fetchImpl:async(_url,options)=>response(options.method==='POST'?422:404,{})}),/validated/);
  await assert.rejects(acquireOvernightCaptureClaim({repository,sourceCommit,token,fetchImpl:async(_url,options)=>response(options.method==='POST'?422:200,{ref:'wrong',object:{sha:sourceCommit}})}),/Invalid/);
});

test('invalid identity never makes a network request; tokens never reach another host',async()=>{
  for(const patch of [{repository:'untrusted/fork'},{sourceCommit:'bad'},{token:''}])await assert.rejects(acquireOvernightCaptureClaim({repository,sourceCommit,token,...patch,fetchImpl:()=>assert.fail('Network before validation')}),/identity/);
});

test('real workflows pin the verified checkout and require a claim before any overnight capture credential',async()=>{
  const workflow=await fs.readFile(new URL('../.github/workflows/publish-verified-snapshots.yml',import.meta.url),'utf8');
  const guard=workflow.slice(workflow.indexOf('      - name: Guard the one-time overnight capture'),workflow.indexOf('      - name: Capture public event assignments'));
  assert.match(guard,/SNAPSHOT_NATIVE_SOURCE_COMMIT!==process.env.EXPECTED_SOURCE_COMMIT/);
  assert.match(guard,/acquireOvernightCaptureClaim/);assert.doesNotMatch(guard,/FIREBASE_VERIFIER_SERVICE_ACCOUNT/);
  assert.match(workflow,/!inputs.overnight_native \|\| steps.overnight_guard.outputs.admitted == 'true'/);
  const root=await fs.readFile(new URL('../.github/workflows/verify-runs.yml',import.meta.url),'utf8');
  assert.match(root,/MANUAL_CATCH_UP==='true'/);assert.match(root,/expected_source_commit: \$\{\{ needs.verify.outputs.overnight_source_commit \}\}/);
});
