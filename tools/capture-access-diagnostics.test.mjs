import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createHash,privateDecrypt,constants} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {diagnoseCaptureAccess} from './capture-access-diagnostics.mjs';

const pair=generateKeyPairSync('rsa',{modulusLength:2048});
const account={type:'service_account',project_id:'polytrack-052',client_email:'fixture@polytrack-052.iam.gserviceaccount.com',
  private_key_id:'fixture-key',private_key:pair.privateKey.export({type:'pkcs8',format:'pem'})};
const sha=value=>createHash('sha256').update(value).digest('hex');
for(const statuses of [[204],[403,204],[403,403]])test('diagnostic stays inside zero-data routes: '+statuses,async()=>{
  const calls=[];let i=0;
  const result=await diagnoseCaptureAccess({serviceAccount:account,now:()=>1800000000000,fetchImpl:async(url,options)=>{
    calls.push(url);assert.equal(options.method,'GET');assert.equal(options.redirect,'error');
    if(url.startsWith('https://www.googleapis.com/service_accounts/v1/jwk/'))return Response.json({keys:[{kid:account.private_key_id}]});
    assert.equal(url,'https://polytrack-ranked-worker.staticquasar931.workers.dev/v1/capture-auth');
    return new Response(null,{status:statuses[i++]});
  }});
  assert.equal(calls.length,1+statuses.length);assert.equal(result.issuerFingerprint,sha(account.client_email));
  assert.equal(result.keyFingerprint,sha(account.private_key_id));assert.equal(result.authenticated,statuses.includes(204));
  assert.equal(result.publishedKey,true);assert.equal(result.firestoreReads,0);assert.equal(result.firestoreWrites,0);
  const output=JSON.stringify(result);assert(!output.includes(account.client_email));assert(!output.includes(account.private_key_id));assert(!output.includes('PRIVATE KEY'));
});
test('wrong project or malformed identity fails before transport',async()=>{
  for(const value of [null,'bad',{...account,project_id:'foreign'},{...account,client_email:'fixture@foreign.iam.gserviceaccount.com'}]){
    await assert.rejects(diagnoseCaptureAccess({serviceAccount:value,fetchImpl:()=>assert.fail('No transport')}),/Invalid configured/);
  }
});
test('issuer handoff is encrypted to the supplied public recipient, never logged in plaintext',async()=>{
  const result=await diagnoseCaptureAccess({serviceAccount:account,recipientPublicKey:pair.publicKey.export({type:'spki',format:'pem'}),
    fetchImpl:async url=>url.includes('googleapis.com')?Response.json({keys:[]}):new Response(null,{status:204})});
  assert.equal(privateDecrypt({key:pair.privateKey,oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},Buffer.from(result.issuerEnvelope,'base64')).toString(),account.client_email);
  assert(!JSON.stringify(result).includes(account.client_email));
  await assert.rejects(diagnoseCaptureAccess({serviceAccount:account,recipientPublicKey:account.private_key,fetchImpl:()=>assert.fail('No transport')}),/Invalid diagnostic recipient/);
});
test('manual diagnostic workflow pins its source and never invokes capture or verification',async()=>{
  const source=await readFile(new URL('../.github/workflows/check-capture-access.yml',import.meta.url),'utf8');
  assert.match(source,/workflow_dispatch:/);assert.doesNotMatch(source,/schedule:|update-public-snapshot|verify-runs|syncPublicEventCatalog/);
  assert.match(source,/test "\$\(git rev-parse HEAD\)" = "\$EXPECTED_SOURCE_COMMIT"/);
  assert.match(source,/node tools\/capture-access-diagnostics\.mjs/);assert.match(source,/contents: read/);
});
