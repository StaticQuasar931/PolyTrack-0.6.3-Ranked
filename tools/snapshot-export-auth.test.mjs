import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, verify, createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createSnapshotExportFetch} from './snapshot-export-auth.mjs';
import {exportPublicProfilesAndReplays} from './public-profile-replay-export.mjs';
import {updatePublicSnapshot} from './update-public-snapshot.mjs';
import {decodeSnapshot} from './snapshot-package.mjs';

const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength:2048});
const serviceAccount = {type:'service_account',project_id:'polytrack-052',
  client_email:'fixture@polytrack-052.iam.gserviceaccount.com',
  private_key:privateKey.export({format:'pem',type:'pkcs8'}),token_uri:'https://untrusted.invalid/token'};
const base='https://firestore.googleapis.com/v1/projects/polytrack-052/databases/(default)/documents';
const prefix='projects/polytrack-052/databases/(default)/documents/';
const account='a'.repeat(64),track='b'.repeat(64);
const fields=['name','nickname','countryCode','profileCosmetics','accountCreatedAt','totalPlaytimeMs',
  'pbCount','latestPbAt','updatedAt','carStyle','carColors','__name__'];
const raceFields=['accountId','trackId','name','nickname','countryCode','timeMs','frames','raceTimeFrames','uploadId',
  'verified','verifiedState','createdAt','pbAt','updatedAt','carStyle','replay','replayHash','ingestedAt'];
const query=()=>({structuredQuery:{from:[{collectionId:'0.6.2_profiles_public'}],
  select:{fields:fields.map(fieldPath=>({fieldPath}))},orderBy:[{field:{fieldPath:'__name__'},direction:'ASCENDING'}],limit:100}});
const options=body=>({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const tokenResponse=()=>Response.json({access_token:'fixture-access-token',token_type:'Bearer',expires_in:3600});
function harness(overrides={}) {
  const calls=[],oauth=[];let clock=1700000000000;
  const read=createSnapshotExportFetch({serviceAccount,now:()=>clock,
    oauthFetch:async(url,init)=>{oauth.push({url,init});return tokenResponse();},
    fetchImpl:async(url,init)=>{calls.push({url,init});return Response.json([]);},...overrides});
  return {read,calls,oauth,setTime:value=>{clock=value;}};
}
async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'snapshot-export-auth-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;
}

test('canonical read boundary permits exactly the exporter mask plus ingestedAt, never arbitrary fields',async()=>{
 const name=prefix+'0.6.2_race_results/'+account+'_'+track;
 const h=harness();await h.read(base+':batchGet',options({documents:[name],mask:{fieldPaths:raceFields}}));
 assert.equal(h.calls.length,1);assert.equal(h.oauth.length,1);
 const denied=harness();
 for(const mask of [[...raceFields,'email'],[...raceFields,'ingestedAtSource'],['ingestedAt'],raceFields.slice(0,-1),
  [...raceFields,'ingestedAt'],[...raceFields].reverse()]){
  await assert.rejects(denied.read(base+':batchGet',options({documents:[name],mask:{fieldPaths:mask}})),/read boundary/);
 }
 await assert.rejects(denied.read(base+':batchGet',options({documents:[name],mask:{fieldPaths:raceFields},readTime:'2026-10-30T08:00:00Z'})),/read boundary/);
 assert.equal(denied.oauth.length,0);assert.equal(denied.calls.length,0);
});

test('lazy RS256 JWT exchange uses fixed OAuth audience/datastore scope; cache coalesces and refreshes before expiry',async()=>{
  const h=harness();assert.equal(h.oauth.length,0);
  await Promise.all([h.read(base+':runQuery',options(query())),h.read(base+':runQuery',options(query()))]);
  assert.equal(h.oauth.length,1);assert.equal(h.calls.length,2);
  const {url,init}=h.oauth[0];assert.equal(url,'https://oauth2.googleapis.com/token');assert.equal(init.redirect,'error');
  assert.equal(new Headers(init.headers).has('authorization'),false);
  const form=new URLSearchParams(init.body);assert.equal(form.get('grant_type'),'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const [head,body,signature]=form.get('assertion').split('.');
  assert.deepEqual(JSON.parse(Buffer.from(head,'base64url')),{alg:'RS256',typ:'JWT'});
  assert.deepEqual(JSON.parse(Buffer.from(body,'base64url')),{iss:serviceAccount.client_email,
    scope:'https://www.googleapis.com/auth/datastore',aud:url,iat:1700000000,exp:1700003600});
  assert.ok(verify('RSA-SHA256',Buffer.from(head+'.'+body),publicKey,Buffer.from(signature,'base64url')));
  for(const call of h.calls){assert.equal(call.init.headers.get('authorization'),'Bearer fixture-access-token');assert.equal(call.init.redirect,'error');}
  h.setTime(1700003539999);await h.read(base+':runQuery',options(query()));assert.equal(h.oauth.length,1);
  h.setTime(1700003540000);await h.read(base+':runQuery',options(query()));assert.equal(h.oauth.length,2);
});

test('rejects arbitrary URLs, methods, queries, cursors, headers and batch expansions before issuing credentials',async()=>{
  const h=harness();
  for(const url of ['https://example.com',base+':commit',base+':runQuery?x=1',base+':runQuery#x',
    base.replace('polytrack-052','other-project')+':runQuery',base.replace('https:','http:')+':runQuery',
    base.replace('firestore.googleapis.com','firestore.googleapis.com.evil.invalid')+':runQuery',new URL(base+':runQuery')]) {
    await assert.rejects(h.read(url,options(query())),/read boundary/);
  }
  for(const patch of [{method:'GET'},{method:'DELETE'},{method:'PATCH'}, {headers:{authorization:'Bearer external'}},
    {headers:{cookie:'private'}},{body:'not JSON'},{body:'{}'}])
    await assert.rejects(h.read(base+':runQuery',{...options(query()),...patch}),/read boundary/);
  for(const mutate of [q=>q.structuredQuery.from[0].collectionId='private',q=>q.structuredQuery.from[0].allDescendants=true,
    q=>delete q.structuredQuery.select,q=>q.structuredQuery.select.fields.push({fieldPath:'email'}),
    q=>q.structuredQuery.limit=101,q=>q.structuredQuery.limit=0,q=>q.structuredQuery.where={},q=>q.transaction='private',
    q=>q.structuredQuery.startAt={values:[{referenceValue:prefix+'private/'+account}],before:false}]) {
    const q=query();mutate(q);await assert.rejects(h.read(base+':runQuery',options(q)),/read boundary/);
  }
  for(const body of [{documents:[prefix+'private/'+account]}, {documents:[]},
    {documents:Array(21).fill(prefix+'0.6.2_race_results/'+account+'_'+track)},
    {documents:[prefix+'0.6.2_race_results/'+account+'_'+track],mask:{fieldPaths:['email']}}])
    await assert.rejects(h.read(base+':batchGet',options(body)),/read boundary/);
  assert.equal(h.oauth.length,0);assert.equal(h.calls.length,0);
  const q=query();q.structuredQuery.startAt={values:[{referenceValue:prefix+'0.6.2_profiles_public/'+account}],before:false};
  await h.read(base+':runQuery',options(q));assert.equal(h.calls.length,1);
});

test('missing/malformed credentials and OAuth failures are fatal, sanitized, and never fall back',async()=>{
  for(const credential of ['', '{fixture-secret', {...serviceAccount,project_id:'wrong'},
    {...serviceAccount,private_key:'fixture-secret'},{...serviceAccount,client_email:'attacker@example.com'}]) {
    const h=harness({serviceAccount:credential});
    await assert.rejects(h.read(base+':runQuery',options(query())),/authentication required|Invalid snapshot export/);
    assert.equal(h.calls.length,0);assert.equal(h.oauth.length,0);
  }
  for(const oauthFetch of [async()=>{throw Error('fixture-secret');},async()=>new Response('fixture-secret',{status:403}),
    async()=>Response.json({access_token:'fixture-secret',token_type:'Bearer',expires_in:60}),
    async()=>Response.json({access_token:'bad\r\ntoken',token_type:'Bearer',expires_in:3600})]) {
    const h=harness({oauthFetch});await assert.rejects(h.read(base+':runQuery',options(query())),error=>{
      assert.match(error.message,/OAuth authentication failed/);assert.doesNotMatch(error.message,/fixture-secret/);return true;
    });assert.equal(h.calls.length,0);
  }
});

test('authorization denial never retries publicly; redirects cannot be followed; diagnostics cannot leak tokens',async()=>{
  for(const status of [401,403]) {
    let calls=0;const h=harness({fetchImpl:async()=>{calls++;return new Response('fixture-secret',{status});}});
    await assert.rejects(h.read(base+':runQuery',options(query())),/no public fallback/);assert.equal(calls,1);
  }
  const h=harness({fetchImpl:async(url,init)=>{assert.equal(init.redirect,'error');throw Error('Bearer fixture-access-token');}});
  await assert.rejects(h.read(base+':runQuery',options(query())),error=>error.message==='Snapshot export transport failed');
});

test('validated request is snapshotted before async issuance and failed renewal never sends stale token',async()=>{
  let release,exchanges=0;
  const h=harness({oauthFetch:async()=>{
    if(++exchanges>1)throw Error('fixture-secret');
    await new Promise(resolve=>{release=resolve;});return tokenResponse();
  }});
  const init=options(query()),original=init.body;
  const work=h.read(base+':runQuery',init);
  init.body='{"structuredQuery":{"from":[{"collectionId":"private"}]}}';
  release();await work;assert.equal(h.calls[0].init.body,original);
  h.setTime(1700003600000);
  await assert.rejects(h.read(base+':runQuery',options(query())),/OAuth authentication failed/);
  assert.equal(h.calls.length,1);
});

test('profile pagination can pass skipped non-account document IDs without widening the collection',async()=>{
  const h=harness(),q=query();
  q.structuredQuery.startAt={values:[{referenceValue:prefix+'0.6.2_profiles_public/invalid-account-id'}],before:false};
  await h.read(base+':runQuery',options(q));assert.equal(h.calls.length,1);
});

test('no pending replay work requires neither credentials nor an OAuth exchange',async t=>{
  const directory=await fixture(t);await fs.mkdir(path.join(directory,'tracks'));
  const h=harness({serviceAccount:''});
  const result=await exportPublicProfilesAndReplays({directory,includeProfiles:false,fetchImpl:h.read});
  assert.equal(result.fetchedDocumentsThisRun,0);assert.equal(h.calls.length,0);assert.equal(h.oauth.length,0);
});

test('real exporter reads projected profiles and bound replay batches; no auth serialized into results, logs, files or package',async t=>{
  const root=await fixture(t),directory=path.join(root,'local-reports/snapshot-staging');
  await fs.mkdir(path.join(directory,'tracks'),{recursive:true});await fs.writeFile(path.join(root,'index.html'),'<html><head></head></html>');
  const replay='fixture recording',hash=createHash('sha256').update(replay).digest('hex');
  await fs.writeFile(path.join(directory,'tracks',track+'.json'),JSON.stringify({trackId:track,entries:[{
    accountId:account,trackId:track,uploadId:42,frames:900,timeMs:15000,replayHash:hash,runVerified:true,integrityVerified:true}]}));
  const string=stringValue=>({stringValue}),integer=n=>({integerValue:String(n)});
  const h=harness({fetchImpl:async(url,init)=>{
    assert.equal(init.headers.get('authorization'),'Bearer fixture-access-token');
    if(url.endsWith(':runQuery'))return Response.json([{document:{name:prefix+'0.6.2_profiles_public/'+account,
      fields:{name:string('Racer'),privateEmail:string('never-export@example.com')}}}]);
    assert.equal(JSON.parse(init.body).documents[0],prefix+'0.6.2_race_results/'+account+'_'+track);
    assert.deepEqual(JSON.parse(init.body).mask.fieldPaths,raceFields);
    return Response.json([{found:{name:prefix+'0.6.2_race_results/'+account+'_'+track,fields:{accountId:string(account),
      trackId:string(track),uploadId:integer(42),frames:integer(900),timeMs:integer(15000),replay:string(replay),replayHash:string(hash),
      ingestedAt:{timestampValue:'2026-10-30T08:01:02.123456Z'}}}}]);
  }});
  const logs=[];const result=await exportPublicProfilesAndReplays({directory,fetchImpl:h.read,log:value=>logs.push(value)});
  assert.equal(result.counts.profiles,1);assert.equal(result.counts.recordings,1);assert.equal(result.fetchedDocumentsThisRun,2);
  const canonical=JSON.parse(await fs.readFile(path.join(directory,`canonical/${track}/${account}.json`),'utf8'));
  assert.equal(canonical.ingestedAt,'2026-10-30T08:01:02.123456Z');assert.equal(canonical.ingestedAtSource,undefined);
  const packaged=await updatePublicSnapshot({root,offline:true,refreshReplays:true,fullPublic:true,
    exportAuth:{serviceAccount:'invalid'},exportFetch:async()=>assert.fail('offline network'),
    capture:async()=>assert.fail('offline capture'),exportPublic:async()=>assert.fail('offline export'),log:value=>logs.push(value)});
  const forbidden=/fixture-access-token|PRIVATE KEY|never-export@example.com|authorization|jwt-bearer/;
  assert.doesNotMatch(JSON.stringify({result,packaged,logs}),forbidden);
  for(const entry of await fs.readdir(directory,{recursive:true,withFileTypes:true})) {
    if(entry.isFile())assert.doesNotMatch(await fs.readFile(path.join(entry.parentPath,entry.name),'utf8'),forbidden);
  }
  const index=JSON.parse(await fs.readFile(path.join(root,packaged.directory,'index.json'),'utf8'));
  for(const item of Object.values(index.files))assert.doesNotMatch(Buffer.from(await decodeSnapshot(
    await fs.readFile(path.join(root,packaged.directory,item.path)))).toString('utf8'),forbidden);
});

test('live orchestrator without credentials fails before publication and never uses anonymous Firestore',async t=>{
  const root=await fixture(t);await fs.writeFile(path.join(root,'index.html'),'<html><head></head></html>');let calls=0;
  await fs.mkdir(path.join(root,'local-reports/snapshot-staging/tracks'),{recursive:true});
  await assert.rejects(updatePublicSnapshot({root,fullPublic:true,capture:async()=>({}),
    exportAuth:{serviceAccount:''},exportFetch:async()=>{calls++;assert.fail('anonymous fallback');},log:()=>{}}),/authentication required/);
  assert.equal(calls,0);await assert.rejects(fs.stat(path.join(root,'snapshot-current.json')), {code:'ENOENT'});
});
