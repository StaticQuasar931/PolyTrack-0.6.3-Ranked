import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {exportPublicProfilesAndReplays} from './public-profile-replay-export.mjs';
const accountId='a'.repeat(64), trackId='b'.repeat(64), otherAccount='c'.repeat(64);
const replay='fixture-replay-payload', replayHash=createHash('sha256').update(replay).digest('hex');
const str=stringValue=>({stringValue}), int=integerValue=>({integerValue:String(integerValue)});
const bool=booleanValue=>({booleanValue}), map=fields=>({mapValue:{fields}});
const ref=(collection,id)=>'projects/polytrack-052/databases/(default)/documents/'+collection+'/'+id;
const profileDoc=(id=accountId)=>({document:{name:ref('0.6.2_profiles_public',id),fields:{
  name:str('sh1t'),nickname:str('Valid Racer'),countryCode:str('US'),updatedAt:int(123),accountCreatedAt:int(10),
  totalPlaytimeMs:int(900),pbCount:int(4),latestPbAt:int(120),carStyle:str('profile-style'),carColors:str('profile-colors'),
  email:str('private@example.invalid'),ownerUid:str('private-owner'),activeTime:int(99),
  profileCosmetics:map({theme:str('blue'),title:str('Champion'),privateToken:str('secret')})}}});
const binding=(overrides={})=>({accountId,trackId,uploadId:42,frames:900,raceTimeFrames:900,replayHash,
  runVerified:true,integrityVerified:true,verifiedState:1,timeMs:15000,name:'Master of Baiting',
  nickname:'sh1t',countryCode:'US',carStyle:'style',...overrides});
const raceFields=(overrides={})=>({accountId:str(accountId),trackId:str(trackId),name:str('Canonical Name'),
  nickname:str('Canonical Nickname'),countryCode:str('US'),timeMs:int(15000),frames:int(900),raceTimeFrames:int(900),
  uploadId:int(42),verified:bool(false),verifiedState:int(0),createdAt:int(500),pbAt:int(500),updatedAt:int(600),
  carStyle:str('style'),replay:str(replay),replayHash:str(replayHash),ownerUid:str('private-owner'),
  proof:str('private-proof'),...overrides});
async function withDirectory(fn){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'public-profile-replay-'));
  await fs.mkdir(path.join(directory,'staging','tracks'),{recursive:true});
  try{await fn(directory);}finally{await fs.rm(directory,{recursive:true,force:true});}}
async function stage(directory,entries){await fs.writeFile(path.join(directory,'staging','tracks',trackId+'.json'),
  JSON.stringify({trackId,complete:true,entries}));}
function fixtureFetch(handler,requests=[]){return async(url,options)=>{
  const request={url:String(url),options:JSON.parse(options.body)};requests.push(request);
  assert.equal(new URL(url).hostname,'firestore.googleapis.com');assert.equal(options.method,'POST');
  assert.deepEqual(options.headers,{'content-type':'application/json'});
  assert.equal(options.signal instanceof AbortSignal,true);assert.equal(options.signal.aborted,false);
  return{ok:true,status:200,text:async()=>JSON.stringify(await handler(request))};};}
const emptyProfiles=[{readTime:'2026-10-06T00:00:00Z'}];
const batchResponse=(request,fields=raceFields())=>request.options.documents.map(name=>({found:{name,fields}}));

test('exports matching staged native binding despite canonical verified false',async()=>{
 await withDirectory(async directory=>{await stage(directory,[binding()]);const requests=[],logs=[];
  const result=await exportPublicProfilesAndReplays({directory,fetchImpl:fixtureFetch(req=>req.url.endsWith(':runQuery')?[profileDoc()]:batchResponse(req),requests),log:m=>logs.push(m)});
  assert.equal(result.complete,true);assert.equal(result.scanComplete,true);assert.equal(result.knownVerifiedBindings,1);
  assert.deepEqual(result.totalCoverage,{available:1,missing:0,invalid:0,complete:true,scope:'current-staged-track-snapshots'});
  const queries=requests.filter(r=>r.url.endsWith(':runQuery'));assert.equal(queries.length,1);
  assert.equal(queries[0].options.structuredQuery.from[0].collectionId,'0.6.2_profiles_public');
  const batch=requests.find(r=>r.url.endsWith(':batchGet'));
  assert.deepEqual(batch.options.documents,[ref('0.6.2_race_results',accountId+'_'+trackId)]);
  assert.ok(batch.options.mask.fieldPaths.includes('replayHash'));assert.equal(batch.options.mask.fieldPaths.includes('proof'),false);
  const profile=JSON.parse(await fs.readFile(path.join(directory,'profiles',accountId+'.json'),'utf8'));
  assert.equal(profile.name,'Racer');assert.equal(profile.nickname,'Valid Racer');
  assert.deepEqual(profile.profileCosmetics,{theme:'blue',title:'Champion'});assert.equal(profile.updatedAt,123);
  assert.equal(profile.carStyle,'profile-style');assert.equal(profile.carColors,'profile-colors');
  for(const field of ['email','ownerUid','activeTime','userId','groupCode'])assert.equal(Object.hasOwn(profile,field),false);
  const recording=JSON.parse(await fs.readFile(path.join(directory,'recordings','42.json'),'utf8'));
  assert.deepEqual(recording,{recording:replay,frames:900,verifiedState:1,carStyle:'style',accountId,trackId,replayHash,updatedAt:600});
  const canonical=JSON.parse(await fs.readFile(path.join(directory,'canonical',trackId,accountId+'.json'),'utf8'));
  assert.equal(canonical.verified,true);assert.equal(canonical.runVerified,true);assert.equal(canonical.integrityVerified,true);
  assert.equal(canonical.uploadId,42);assert.equal(canonical.name,'Racer');assert.equal(canonical.replayHash,replayHash);
  for(const field of ['replay','ownerUid','proof','rp','rank'])assert.equal(Object.hasOwn(canonical,field),false);
  assert.equal(logs.some(line=>line.includes(replay)),false);
 });});

test('never fetches canonical races without both native verification flags',async()=>{
 await withDirectory(async directory=>{await stage(directory,[binding({runVerified:false}),binding({accountId:otherAccount,uploadId:43,integrityVerified:false})]);
  const requests=[];const result=await exportPublicProfilesAndReplays({directory,fetchImpl:fixtureFetch(()=>emptyProfiles,requests),log:()=>{}});
  assert.equal(result.knownVerifiedBindings,0);assert.equal(result.complete,true);
  assert.equal(requests.some(r=>r.url.endsWith(':batchGet')),false);
 });});

test('rejects upload/hash mismatches and records missing batchGet documents unavailable',async()=>{
 await withDirectory(async directory=>{await stage(directory,[binding(),binding({accountId:otherAccount,uploadId:43,replayHash:'d'.repeat(64)})]);
  const result=await exportPublicProfilesAndReplays({directory,fetchImpl:fixtureFetch(req=>{
   if(req.url.endsWith(':runQuery'))return emptyProfiles;const names=req.options.documents;
   return[{found:{name:names[0],fields:raceFields({uploadId:int(999)})}},{missing:names[1]}];}),log:()=>{}});
  assert.equal(result.knownVerifiedBindings,2);assert.equal(result.totalCoverage.available,0);
  assert.equal(result.totalCoverage.missing,1);assert.equal(result.totalCoverage.invalid,1);assert.equal(result.complete,false);
  assert.equal(result.counts.skipped,1);
  const progress=JSON.parse(await fs.readFile(path.join(directory,'export-progress.json'),'utf8'));
  assert.ok(Object.values(progress.raceExport.records).some(r=>r.available===false&&r.reason==='missing'));
  assert.equal((await fs.readdir(path.join(directory,'recordings')).catch(()=>[])).length,0);
 });});

test('resumes invocation budget and does not rescan completed profiles',async()=>{
 await withDirectory(async directory=>{await stage(directory,[binding()]);
  const first=await exportPublicProfilesAndReplays({directory,pageSize:1,maxDocuments:1,
   fetchImpl:fixtureFetch(()=>[profileDoc()]),log:()=>{}});
  assert.equal(first.budgetReached,true);assert.equal(first.scanComplete,false);
  const requests=[];const second=await exportPublicProfilesAndReplays({directory,pageSize:1,maxDocuments:1,
   fetchImpl:fixtureFetch(req=>req.url.endsWith(':runQuery')?emptyProfiles:batchResponse(req),requests),log:()=>{}});
  assert.equal(second.counts.profiles,1);assert.equal(second.counts.recordings,1);assert.equal(second.budgetReached,false);
  assert.equal(requests.filter(r=>r.url.endsWith(':runQuery')).length,1);
  assert.equal(requests.filter(r=>r.url.endsWith(':batchGet')).length,1);
  const thirdRequests=[];const third=await exportPublicProfilesAndReplays({directory,maxDocuments:1,
   fetchImpl:fixtureFetch(()=>{throw Error('completed binding must not be fetched again');},thirdRequests),log:()=>{}});
  assert.equal(third.complete,true);assert.equal(thirdRequests.length,0);
 });});

test('changed binding fingerprint preserves historical file and fetches the new signature',async()=>{
 await withDirectory(async directory=>{await stage(directory,[binding()]);
  await exportPublicProfilesAndReplays({directory,fetchImpl:fixtureFetch(req=>req.url.endsWith(':runQuery')?emptyProfiles:batchResponse(req)),log:()=>{}});
  const oldPath=path.join(directory,'recordings','42.json'),oldBytes=await fs.readFile(oldPath,'utf8');
  const nextReplay='new-replay',nextHash=createHash('sha256').update(nextReplay).digest('hex');
  await stage(directory,[binding({uploadId:43,replayHash:nextHash})]);let fetched=0;
  const result=await exportPublicProfilesAndReplays({directory,fetchImpl:fixtureFetch(req=>{
   if(req.url.endsWith(':runQuery'))throw Error('completed profiles must not be rescanned');fetched++;
   return batchResponse(req,raceFields({uploadId:int(43),replay:str(nextReplay),replayHash:str(nextHash)}));}),log:()=>{}});
  assert.equal(fetched,1);assert.equal(result.knownVerifiedBindings,1);assert.equal(await fs.readFile(oldPath,'utf8'),oldBytes);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory,'recordings','43.json'),'utf8')).replayHash,nextHash);
 });});

test('bounds batchGet response and rejects mismatched document name',async()=>{
 await withDirectory(async directory=>{await stage(directory,[binding()]);
  await assert.rejects(exportPublicProfilesAndReplays({directory,fetchImpl:fixtureFetch(req=>
   req.url.endsWith(':runQuery')?emptyProfiles:'x'.repeat(16*1024*1024+1)),log:()=>{}}),/byte limit/);
});

test('full snapshot refresh resets its cursor and prunes obsolete profiles only after completion',async()=>{
 await withDirectory(async directory=>{
  const profileDirectory=path.join(directory,'profiles');await fs.mkdir(profileDirectory,{recursive:true});
  const stale='f'.repeat(64);await fs.writeFile(path.join(profileDirectory,stale+'.json'),'{}');
  await fs.writeFile(path.join(directory,'export-progress.json'),JSON.stringify({schemaVersion:1,projectId:'polytrack-052',
   scanned:300,cursors:{profiles:ref('0.6.2_profiles_public',stale)},complete:{profiles:true,races:true},counts:{profiles:300}}));
  const firstRequests=[];
  const first=await exportPublicProfilesAndReplays({directory,fullSnapshot:true,pageSize:1,maxDocuments:1,
   fetchImpl:fixtureFetch(()=>[profileDoc()],firstRequests),log:()=>{}});
  assert.equal(first.budgetReached,true);
  assert.equal(Object.hasOwn(firstRequests[0].options.structuredQuery,'startAt'),false);
  assert.equal(await fs.readFile(path.join(profileDirectory,stale+'.json'),'utf8'),'{}');
  const secondRequests=[];
  const second=await exportPublicProfilesAndReplays({directory,pageSize:1,maxDocuments:1,
   fetchImpl:fixtureFetch(req=>{secondRequests.push(req);return emptyProfiles;}),log:()=>{}});
  assert.equal(second.complete,true);
  assert.equal(secondRequests[0].options.structuredQuery.startAt.values[0].referenceValue,
   ref('0.6.2_profiles_public',accountId));
  await assert.rejects(fs.stat(path.join(profileDirectory,stale+'.json')),{code:'ENOENT'});
  assert.equal(JSON.parse(await fs.readFile(path.join(profileDirectory,accountId+'.json'),'utf8')).accountId,accountId);
 });
});
 await withDirectory(async directory=>{await stage(directory,[binding()]);
  const result=await exportPublicProfilesAndReplays({directory,fetchImpl:fixtureFetch(req=>{
   if(req.url.endsWith(':runQuery'))return emptyProfiles;
   return[{found:{name:req.options.documents[0]+'_wrong',fields:raceFields()}}];}),log:()=>{}});
  assert.equal(result.totalCoverage.invalid,1);assert.equal(result.counts.recordings,0);
 });});
