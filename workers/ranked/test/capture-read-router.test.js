import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {handleRequest} from '../src/index.js';
import {createWorkerCaptureFetch} from '../../../tools/worker-capture-fetch.mjs';

const base='https://polytrack-ranked-worker.staticquasar931.workers.dev', origin='https://staticquasar931.github.io';
test('real router rejects unsigned public reads even with a forged official Origin before database access',async()=>{
  let reads=0;
  const env={ALLOWED_ORIGINS:origin, PUBLIC_FIRESTORE_READ_MODE:'capture-only', EVENTS_ENABLED:'true',
    __TEST_FIRESTORE:async()=>{reads++;throw Error('Unexpected database request');}};
  for(const path of ['/v1/status','/v1/capture-auth','/v1/snapshot/overall','/v1/snapshot/track?trackId='+'a'.repeat(64),
    '/v1/snapshot/track/page?trackId=a&generation=a&page=0','/v1/events/catalog','/v1/events/current',
    '/v1/events/totals','/v1/events/archives/202610','/v1/events/weekly/snapshot',
    '/v1/events/weekly/replays/'+'a'.repeat(64),'/v1/events/weekly/playbacks/'+'b'.repeat(64),
    '/v1/events/weekly/track','/v1/extra-tracks/unranked','/v1/events/catalog/']){
    const response=await handleRequest(new Request(base+path,{headers:{Origin:origin}}),env);
    assert.equal(response.status,403,path);
    assert.equal((await response.json()).error,'snapshot_capture_required',path);
  }
  assert.equal(reads,0);
});

test('real signed capture probe validates without Firestore; browser preflight stays available',async()=>{
  const email='capture-test@polytrack-052.iam.gserviceaccount.com';
  const keys=generateKeyPairSync('rsa',{modulusLength:2048});
  const previous=globalThis.fetch;let db=0,lookups=0;
  globalThis.fetch=async url=>{
    lookups++;
    assert.equal(url,'https://www.googleapis.com/service_accounts/v1/jwk/'+encodeURIComponent(email));
    return Response.json({keys:[{...keys.publicKey.export({format:'jwk'}),kid:'capture-test'}]});
  };
  const env={ALLOWED_ORIGINS:origin,PUBLIC_FIRESTORE_READ_MODE:'capture-only',CAPTURE_SERVICE_ACCOUNT_EMAIL:email,
    __TEST_FIRESTORE:async()=>{db++;throw Error('Unexpected database request');}};
  try {
    const transport=createWorkerCaptureFetch({serviceAccount:{type:'service_account',client_email:email,
      private_key_id:'capture-test',private_key:keys.privateKey.export({format:'pem',type:'pkcs8'})},
      fetchImpl:(url,init)=>handleRequest(new Request(url,init),env)});
    assert.equal((await transport(base+'/v1/capture-auth',{headers:{Origin:origin}})).status,204);
    assert.equal(lookups,1);assert.equal(db,0);
    assert.equal((await handleRequest(new Request(base+'/v1/events/catalog',{method:'OPTIONS',headers:{Origin:origin}}),env)).status,204);
    assert.equal(db,0);
  }finally{globalThis.fetch=previous;}
});
