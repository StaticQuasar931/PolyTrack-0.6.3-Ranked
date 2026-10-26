import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {exportPublicProfilesAndReplays} from './public-profile-replay-export.mjs';
import {publicEventBackup,publicEventReplayBackup} from './public-snapshot-backup.mjs';
import {publicEventPlaybackForPublication} from './public-event-playback.mjs';
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

async function seedEventBytes(directory,{count=1,verified=false,malformed=false}={}){
 const id='kodub_1793563200000',period={id,kind:'kodub',trackId,startsAt:100,endsAt:100000,maxRp:700};
 const bytes=deflateSync(Buffer.alloc(malformed?14:15)).toString('base64url');
 const hash=createHash('sha256').update(bytes).digest('hex');
 const rows=Array.from({length:count},(_,i)=>binding({accountId:(i+1).toString(16).padStart(64,'0'),uploadId:1000+i,
  frames:900,raceTimeFrames:900,timeMs:900,replayHash:hash,carStyle:'style',verified:false,runVerified:false,verifiedState:0}));
 const entries=rows.map((row,i)=>({accountId:row.accountId,runId:(i+100).toString(16).padStart(64,'0'),
  timeMs:900,frames:900,name:'Public Racer',carStyle:'style',replayHash:hash,submittedAt:150,
  ...(verified?{physicsVerified:true,replayIntegrityVerified:true}:{verificationStatus:'waiting',pending:true,verified:false,
   eventRpEligible:false,source:'pending-event-playback'})}));
 const board=publicEventBackup({id,period,updatedAt:200,archived:false,entries:verified?entries:[],pendingPlaybacks:verified?[]:entries},id);
 const manifest={schemaVersion:1,events:{[id]:{path:`events/${id}.json`,updatedAt:200}},eventPlaybacks:{},eventReplays:{}};
 await fs.mkdir(path.join(directory,'events'),{recursive:true});
 await fs.writeFile(path.join(directory,`events/${id}.json`),JSON.stringify(board));
 const payloads=[];
 for(const entry of entries){
  const raw={periodId:id,trackId,accountId:entry.accountId,runId:entry.runId,timeMs:900,frames:900,replay:bytes,replayHash:hash,
   carStyle:'style',submittedAt:150,verificationStatus:verified?'verified':'waiting',pending:!verified,verified,
   eventRpEligible:verified,source:'pending-event-recording'};
  const value=malformed?Object.fromEntries(Object.entries(raw).filter(([key])=>!verified||!['pending','source','verificationStatus','verified','eventRpEligible'].includes(key))):
   verified?publicEventReplayBackup(raw,{periodId:id,trackId,entry}):await publicEventPlaybackForPublication(raw,{periodId:id,trackId,entry});
  const relative=verified?`event-replays/${id}/${entry.accountId}.json`:`event-playbacks/${id}/${entry.runId}.json`;
  await fs.mkdir(path.dirname(path.join(directory,relative)),{recursive:true});
  await fs.writeFile(path.join(directory,relative),JSON.stringify(value));payloads.push({relative,value});
  manifest[verified?'eventReplays':'eventPlaybacks'][relative]={path:relative,periodId:id,accountId:entry.accountId,
   ...(verified?{}:{runId:entry.runId}),timeMs:900,replayHash:hash};
 }
 await fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify(manifest));
 await stage(directory,rows);return {rows,entries,board,manifest,payloads,id};
}

test('three normal pending runs reuse exact public event bytes with one bounded index and no payload reads',async()=>{
 await withDirectory(async directory=>{
  const f=await seedEventBytes(directory,{count:3});let manifests=0,boards=0;
  const original=fs.readFile;fs.readFile=async(...args)=>{const p=String(args[0]).replace(/\\/g,'/');
   if(p===path.join(directory,'manifest.json').replace(/\\/g,'/'))manifests++;
   if(p.endsWith(`/events/${f.id}.json`))boards++;return original(...args);};
  try{
   const result=await exportPublicProfilesAndReplays({directory,includeProfiles:false,includePendingReplays:true,
    fetchImpl:()=>{throw Error('Bundled immutable bytes must not be fetched');}});
   assert.equal(result.fetchedDocumentsThisRun,0);assert.equal(manifests,1);assert.equal(boards,1);
   for(const row of f.rows){
    const recording=JSON.parse(await original(path.join(directory,`recordings/${row.uploadId}.json`)));
    const canonical=JSON.parse(await original(path.join(directory,`canonical/${trackId}/${row.accountId}.json`)));
    assert.equal(recording.recording,f.payloads[0].value.replay);assert.equal(canonical.uploadId,row.uploadId);
    assert.equal(recording.verifiedState,0);assert.equal(recording.playbackPending,true);
    assert.equal(canonical.runVerified,false);assert.equal(canonical.verified,false);assert.equal(canonical.eventRpEligible,false);
    assert.equal(canonical.verificationStatus,'pending');assert.equal(canonical.verifiedAt,undefined);
    assert.equal(canonical.runId,undefined);assert.equal(canonical.proof,undefined);
   }
   manifests=0;await exportPublicProfilesAndReplays({directory,includeProfiles:false,includePendingReplays:true,
    fetchImpl:()=>{throw Error('Existing normal pairs must remain read-free');}});
   assert.equal(manifests,0,'valid normal pairs must not even load the event index');
  }finally{fs.readFile=original;}
 });
});

test('verified event bytes may seed a pending normal pair but never promote normal proof',async()=>{
 await withDirectory(async directory=>{
  const f=await seedEventBytes(directory,{verified:true});
  await exportPublicProfilesAndReplays({directory,includeProfiles:false,includePendingReplays:true,
   fetchImpl:()=>{throw Error('Verified event bytes should be reused');}});
  const c=JSON.parse(await fs.readFile(path.join(directory,`canonical/${trackId}/${f.rows[0].accountId}.json`)));
  assert.equal(c.verifiedState,0);assert.equal(c.verified,false);assert.equal(c.runVerified,false);assert.equal(c.eventRpEligible,false);
 });
});

test('event reuse rejects cross-account, track, time, frames, hash, style and untrusted manifest/board sources',async()=>{
 const changes=[f=>{f.rows[0].accountId=otherAccount;},f=>{f.rows[0].timeMs++;},
  f=>{f.rows[0].frames++;f.rows[0].raceTimeFrames++;},f=>{f.rows[0].replayHash='e'.repeat(64);},
  f=>{f.rows[0].carStyle='other-style';},f=>{f.board.period.trackId='e'.repeat(64);},
  f=>{f.board.pendingPlaybacks[0].verificationStatus='rejected';},
  f=>{f.manifest.events[f.id].updatedAt++;},f=>{f.manifest.eventPlaybacks[f.payloads[0].relative].accountId=otherAccount;},
  f=>{f.manifest.eventPlaybacks[f.payloads[0].relative].path='../private.json';}];
 for(const mutate of changes)await withDirectory(async directory=>{
  const f=await seedEventBytes(directory);mutate(f);await stage(directory,f.rows);
  await fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify(f.manifest));
  await fs.writeFile(path.join(directory,`events/${f.id}.json`),JSON.stringify(f.board));
  const calls=[];const result=await exportPublicProfilesAndReplays({directory,includeProfiles:false,includePendingReplays:true,
   fetchImpl:fixtureFetch(req=>req.options.documents.map(missing=>({missing})),calls)});
  assert.equal(calls.length,1);assert.equal(result.fetchedDocumentsThisRun,1);
  await assert.rejects(fs.stat(path.join(directory,'recordings/1000.json')),{code:'ENOENT'});
 });
});

test('malformed hash-valid event bytes and normal upload collisions are not reusable',async()=>{
 for(const verified of [false,true])await withDirectory(async directory=>{
  await seedEventBytes(directory,{verified,malformed:true});const calls=[];
  await exportPublicProfilesAndReplays({directory,includeProfiles:false,includePendingReplays:true,
   fetchImpl:fixtureFetch(req=>req.options.documents.map(missing=>({missing})),calls)});
  assert.equal(calls.length,1);await assert.rejects(fs.stat(path.join(directory,'recordings/1000.json')),{code:'ENOENT'});
 });
 await withDirectory(async directory=>{
  await seedEventBytes(directory);await fs.mkdir(path.join(directory,'recordings'));
  const prior=JSON.stringify({accountId:otherAccount,trackId,replayHash,recording:replay});
  await fs.writeFile(path.join(directory,'recordings/1000.json'),prior);const calls=[];
  await exportPublicProfilesAndReplays({directory,includeProfiles:false,includePendingReplays:true,
   fetchImpl:fixtureFetch(req=>req.options.documents.map(missing=>({missing})),calls)});
  assert.equal(calls.length,1);assert.equal(await fs.readFile(path.join(directory,'recordings/1000.json'),'utf8'),prior);
 });
});

test('event bytes cannot seed a verified normal binding and local reuse beats deterministic cooldown',async()=>{
 await withDirectory(async directory=>{
  const f=await seedEventBytes(directory);await stage(directory,f.rows.map(row=>({...row,verified:true,runVerified:true,verifiedState:1})));
  const calls=[];await exportPublicProfilesAndReplays({directory,includeProfiles:false,includePendingReplays:true,
   fetchImpl:fixtureFetch(req=>req.options.documents.map(missing=>({missing})),calls)});assert.equal(calls.length,1);
 });
 await withDirectory(async directory=>{
  const f=await seedEventBytes(directory);await fs.unlink(path.join(directory,'manifest.json'));
  const calls=[];await exportPublicProfilesAndReplays({directory,includeProfiles:false,includePendingReplays:true,now:1000,
   fetchImpl:fixtureFetch(req=>req.options.documents.map(missing=>({missing})),calls)});assert.equal(calls.length,1);
  await fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify(f.manifest));
  const result=await exportPublicProfilesAndReplays({directory,includeProfiles:false,includePendingReplays:true,now:1001,
   fetchImpl:()=>{throw Error('Exact new cached bytes override a stale retry failure');}});
  assert.equal(result.fetchedDocumentsThisRun,0);
 });
});

test('event index stops at its record ceiling instead of scanning unbounded cache metadata',async()=>{
 await withDirectory(async directory=>{
  const f=await seedEventBytes(directory),records={};
  for(let i=0;i<2000;i++)records['ignored-'+i]={path:'invalid',accountId:'invalid'};
  f.manifest.eventPlaybacks={...records,...f.manifest.eventPlaybacks};
  await fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify(f.manifest));const calls=[];
  await exportPublicProfilesAndReplays({directory,includeProfiles:false,includePendingReplays:true,
   fetchImpl:fixtureFetch(req=>req.options.documents.map(missing=>({missing})),calls)});assert.equal(calls.length,1);
 });
});

async function pendingPair(directory,{frames=900,payload=deflateSync(Buffer.alloc(15)).toString('base64url')}={}) {
 const hash=createHash('sha256').update(payload).digest('hex');
 const row=binding({frames,raceTimeFrames:frames,replayHash:hash,runVerified:false,verified:false,verifiedState:0});
 await stage(directory,[row]);
 // Seed an existing public pair directly so malformed-cache rejection can be tested too.
 await fs.mkdir(path.join(directory,'recordings'),{recursive:true});
 await fs.mkdir(path.join(directory,'canonical',trackId),{recursive:true});
 const recording={recording:payload,frames,verifiedState:0,carStyle:'style',accountId,trackId,replayHash:hash,
  updatedAt:600,playbackPending:true,verificationStatus:'pending',eventRpEligible:false};
 const canonical={...row,updatedAt:600,playbackPending:true,verificationStatus:'pending',eventRpEligible:false};
 await fs.writeFile(path.join(directory,'recordings/42.json'),JSON.stringify(recording));
 await fs.writeFile(path.join(directory,`canonical/${trackId}/${accountId}.json`),JSON.stringify(canonical));
 return {row,recording,canonical};
}

test('status-only promotion retains exact encoded bytes and makes zero payload requests',async()=>{
 await withDirectory(async directory=>{
  const f=await pendingPair(directory);await stage(directory,[{...f.row,verified:true,runVerified:true,verifiedState:1}]);
  const options={directory,includeProfiles:false,includePendingReplays:true,
   fetchImpl:()=>{throw Error('Status-only promotion must not fetch');}};
  const result=await exportPublicProfilesAndReplays(options);
  assert.equal(result.fetchedDocumentsThisRun,0);
  const saved=JSON.parse(await fs.readFile(path.join(directory,'recordings/42.json')));
  const canonical=JSON.parse(await fs.readFile(path.join(directory,`canonical/${trackId}/${accountId}.json`)));
  assert.equal(saved.recording,f.recording.recording);assert.equal(saved.updatedAt,600);assert.equal(saved.verifiedState,1);
  assert.equal(canonical.verified,true);assert.equal(canonical.runVerified,true);assert.equal(canonical.verifiedState,1);
  for(const row of [saved,canonical])for(const key of ['playbackPending','verificationStatus','eventRpEligible','verifiedAt'])
   assert.equal(row[key],undefined,key+' must not carry stale pending status or invented verdict time');
  assert.equal((await exportPublicProfilesAndReplays(options)).fetchedDocumentsThisRun,0);
 });
});

test('promotion rejects every changed immutable binding including time and optional recording upload',async()=>{
 const mutations=[f=>{f.canonical.accountId=otherAccount;},f=>{f.canonical.trackId='d'.repeat(64);},
  f=>{f.canonical.uploadId++;},f=>{f.canonical.frames++;},f=>{f.canonical.raceTimeFrames++;},
  f=>{f.canonical.replayHash='d'.repeat(64);},f=>{f.canonical.timeMs++;},
  f=>{f.recording.uploadId=43;},f=>{f.recording.timeMs=15001;},f=>{f.recording.recording+='A';},
  f=>{f.canonical.verificationStatus='rejected';}];
 for(const mutate of mutations)await withDirectory(async directory=>{
  const f=await pendingPair(directory);mutate(f);
  await fs.writeFile(path.join(directory,'recordings/42.json'),JSON.stringify(f.recording));
  await fs.writeFile(path.join(directory,`canonical/${trackId}/${accountId}.json`),JSON.stringify(f.canonical));
  await stage(directory,[{...f.row,verified:true,runVerified:true,verifiedState:1}]);
  const calls=[];const result=await exportPublicProfilesAndReplays({directory,includeProfiles:false,
   fetchImpl:fixtureFetch(req=>req.options.documents.map(missing=>({missing})),calls)});
  assert.equal(calls.length,1);assert.equal(result.fetchedDocumentsThisRun,1);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory,'recordings/42.json'))).verifiedState,0);
 });
});

test('interrupted two-file status promotion is safely completed without re-fetch',async()=>{
 for(const partial of ['recording','canonical'])await withDirectory(async directory=>{
  const f=await pendingPair(directory);
  if(partial==='recording')f.recording={...f.recording,verifiedState:1,playbackPending:undefined,verificationStatus:undefined,eventRpEligible:undefined};
  else f.canonical={...f.canonical,verified:true,runVerified:true,verifiedState:1,playbackPending:undefined,verificationStatus:undefined,eventRpEligible:undefined};
  await fs.writeFile(path.join(directory,'recordings/42.json'),JSON.stringify(f.recording));
  await fs.writeFile(path.join(directory,`canonical/${trackId}/${accountId}.json`),JSON.stringify(f.canonical));
  await stage(directory,[{...f.row,verified:true,runVerified:true,verifiedState:1}]);
  await exportPublicProfilesAndReplays({directory,includeProfiles:false,fetchImpl:()=>{throw Error('Partial pair must resume locally');}});
  assert.equal(JSON.parse(await fs.readFile(path.join(directory,'recordings/42.json'))).verifiedState,1);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory,`canonical/${trackId}/${accountId}.json`))).verified,true);
 });
});

test('malformed bytes cannot be promoted; structure-valid high-work bytes can be retained without refetching',async()=>{
 const work=Buffer.alloc(45);for(let channel=0;channel<5;channel++){work[channel*9]=2;work[channel*9+6]=1;}
 for(const [bytes,frames] of [[Buffer.alloc(14),900],[work,4000000]])await withDirectory(async directory=>{
  const f=await pendingPair(directory,{frames,payload:deflateSync(bytes).toString('base64url')});
  await stage(directory,[{...f.row,verified:true,runVerified:true,verifiedState:1}]);
  const calls=[];await exportPublicProfilesAndReplays({directory,includeProfiles:false,
   fetchImpl:fixtureFetch(req=>req.options.documents.map(missing=>({missing})),calls)});
  const malformed=bytes.length===14;
  assert.equal(calls.length,malformed?1:0,'malformed bytes need bounded recovery; valid source-bound bytes need no download');
  assert.equal(JSON.parse(await fs.readFile(path.join(directory,'recordings/42.json'))).verifiedState,malformed?0:1);
 });
});

test('opt-in pending public canonical replay exports bounded playback without a verified badge or private fields',async()=>{
 await withDirectory(async directory=>{
  const pendingReplay=deflateSync(Buffer.alloc(15)).toString('base64url');
  const pendingHash=createHash('sha256').update(pendingReplay).digest('hex');
  await stage(directory,[binding({runVerified:false,verified:false,verifiedState:0,replayHash:pendingHash})]);
  const requests=[],fetchImpl=fixtureFetch(req=>batchResponse(req,raceFields({replay:str(pendingReplay),replayHash:str(pendingHash)})),requests);
  await exportPublicProfilesAndReplays({directory,includeProfiles:false,fetchImpl});assert.equal(requests.length,0);
  await exportPublicProfilesAndReplays({directory,includeProfiles:false,includePendingReplays:true,fetchImpl});
  const saved=JSON.parse(await fs.readFile(path.join(directory,'recordings/42.json')));
  const canonical=JSON.parse(await fs.readFile(path.join(directory,`canonical/${trackId}/${accountId}.json`)));
  assert.equal(saved.verifiedState,0);assert.equal(saved.playbackPending,true);assert.equal(canonical.verified,false);
  assert.equal(canonical.runVerified,false);assert.equal(canonical.eventRpEligible,false);assert.equal(canonical.proof,undefined);
  assert.equal(canonical.ownerUid,undefined);assert.equal(canonical.verificationStatus,'pending');
  assert.equal(requests.length,1);
  const reused=await exportPublicProfilesAndReplays({directory,includeProfiles:false,includePendingReplays:true,fetchImpl});
  assert.equal(requests.length,1,'unchanged pending replay pair must not spend another read');
  assert.equal(reused.fetchedDocumentsThisRun,0);
 });
});

test('terminal public board rows never enter replay export even when pending playback is enabled',async()=>{
 await withDirectory(async directory=>{
  await stage(directory,[binding({runVerified:false,verified:false,verifiedState:0,verificationStatus:'rejected'})]);
  const requests=[];
  await exportPublicProfilesAndReplays({directory,includeProfiles:false,includePendingReplays:true,fetchImpl:fixtureFetch(req=>batchResponse(req),requests)});
  assert.equal(requests.length,0);
  await assert.rejects(fs.stat(path.join(directory,'recordings/42.json')),{code:'ENOENT'});
 });
});

test('terminal status on a cached replay or canonical invalidates reuse',async()=>{
 for(const target of ['recordings/42.json',`canonical/${trackId}/${accountId}.json`])await withDirectory(async directory=>{
  await stage(directory,[binding()]);const requests=[],fetchImpl=fixtureFetch(req=>batchResponse(req),requests);
  await exportPublicProfilesAndReplays({directory,includeProfiles:false,fetchImpl});
  const filename=path.join(directory,target),cached=JSON.parse(await fs.readFile(filename));
  await fs.writeFile(filename,JSON.stringify({...cached,verificationStatus:'rejected'}));
  await exportPublicProfilesAndReplays({directory,includeProfiles:false,fetchImpl});
  assert.equal(requests.length,2,'terminal cached projection cannot qualify as a reusable pair');
 });
});

test('private progress larger than the public payload limit is saved rather than silently dropped',async()=>{
 await withDirectory(async directory=>{
  await stage(directory,[binding()]);
  await fs.writeFile(path.join(directory,'export-progress.json'),JSON.stringify({profiles:{complete:true,ids:Array(40000).fill(accountId)},profileCount:40000}));
  await exportPublicProfilesAndReplays({directory,includeProfiles:false,fetchImpl:fixtureFetch(req=>batchResponse(req))});
  const file=await fs.readFile(path.join(directory,'export-progress.json'),'utf8');
  const saved=JSON.parse(file);
  assert.ok(Buffer.byteLength(file)>2*1024*1024);
  assert.equal(saved.profiles.ids.length,40000);
  assert.equal(saved.raceExport.known,1);
  assert.equal(Object.values(saved.raceExport.records)[0].available,true);
 });
});

test('replay-only refresh skips profile queries and reuses unchanged recordings',async()=>{
 await withDirectory(async directory=>{
  await stage(directory,[binding()]);const requests=[];
  await fs.writeFile(path.join(directory,'public-export-summary.json'),JSON.stringify({counts:{profiles:37}}));
  const fetchImpl=fixtureFetch(req=>batchResponse(req),requests);
  const first=await exportPublicProfilesAndReplays({directory,includeProfiles:false,maxDocuments:1,fetchImpl});
  assert.equal(first.fetchedDocumentsThisRun,1);
  assert.equal(first.counts.profiles,37);
  assert.equal(requests.length,1);assert.ok(requests[0].url.endsWith(':batchGet'));
  assert.equal(first.complete,false);
  requests.length=0;
  const second=await exportPublicProfilesAndReplays({directory,includeProfiles:false,maxDocuments:1,fetchImpl});
  assert.equal(second.fetchedDocumentsThisRun,0);assert.equal(requests.length,0);
  assert.equal(second.complete,false);
 });
});

test('exports matching staged native binding despite canonical verified false',async()=>{
 await withDirectory(async directory=>{await stage(directory,[binding()]);const requests=[],logs=[];
  const result=await exportPublicProfilesAndReplays({directory,fetchImpl:fixtureFetch(req=>req.url.endsWith(':runQuery')?[profileDoc()]:batchResponse(req),requests),log:m=>logs.push(m)});
  assert.equal(result.complete,true);assert.equal(result.scanComplete,true);assert.equal(result.knownVerifiedBindings,1);
  assert.equal(result.fetchedDocumentsThisRun,2);
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
  assert.equal(first.fetchedDocumentsThisRun,1);
  const requests=[];const second=await exportPublicProfilesAndReplays({directory,pageSize:1,maxDocuments:1,
   fetchImpl:fixtureFetch(req=>req.url.endsWith(':runQuery')?emptyProfiles:batchResponse(req),requests),log:()=>{}});
  assert.equal(second.counts.profiles,1);assert.equal(second.counts.recordings,1);assert.equal(second.budgetReached,false);
  assert.equal(second.fetchedDocumentsThisRun,1);
  assert.equal(requests.filter(r=>r.url.endsWith(':runQuery')).length,1);
  assert.equal(requests.filter(r=>r.url.endsWith(':batchGet')).length,1);
  const thirdRequests=[];const third=await exportPublicProfilesAndReplays({directory,maxDocuments:1,
   fetchImpl:fixtureFetch(()=>{throw Error('completed binding must not be fetched again');},thirdRequests),log:()=>{}});
  assert.equal(third.complete,true);assert.equal(thirdRequests.length,0);
  assert.equal(third.fetchedDocumentsThisRun,0);
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

test('reuses validated local replay pairs without progress metadata after a binding fingerprint change',async()=>{
 await withDirectory(async directory=>{await stage(directory,[binding()]);
  await exportPublicProfilesAndReplays({directory,fetchImpl:fixtureFetch(req=>req.url.endsWith(':runQuery')?emptyProfiles:batchResponse(req)),log:()=>{}});
  await fs.unlink(path.join(directory,'export-progress.json'));
  await stage(directory,[binding({name:'Updated public name'})]);
  const requests=[];
  const result=await exportPublicProfilesAndReplays({directory,fetchImpl:fixtureFetch(req=>{
   if(req.url.endsWith(':runQuery'))return emptyProfiles;
   throw Error('an unchanged verified replay pair must be reused');
  },requests),log:()=>{}});
  assert.equal(result.complete,true);assert.equal(result.counts.recordings,1);
  assert.equal(requests.filter(req=>req.url.endsWith(':batchGet')).length,0);
 });});

test('corrupt local replay pair is refetched instead of trusting saved progress',async()=>{
 await withDirectory(async directory=>{await stage(directory,[binding()]);
  await exportPublicProfilesAndReplays({directory,fetchImpl:fixtureFetch(req=>req.url.endsWith(':runQuery')?emptyProfiles:batchResponse(req)),log:()=>{}});
  const replayPath=path.join(directory,'recordings','42.json');
  const saved=JSON.parse(await fs.readFile(replayPath,'utf8'));saved.recording='corrupt';
  await fs.writeFile(replayPath,JSON.stringify(saved));
  let batchGets=0;
  const result=await exportPublicProfilesAndReplays({directory,fetchImpl:fixtureFetch(req=>{
   if(req.url.endsWith(':runQuery'))throw Error('completed profile scan must be reused');
   batchGets++;return batchResponse(req);
  }),log:()=>{}});
  assert.equal(batchGets,1);assert.equal(result.complete,true);
  assert.equal(JSON.parse(await fs.readFile(replayPath,'utf8')).recording,replay);
 });});

test('cached canonical time must match the staged binding time',async()=>{
 await withDirectory(async directory=>{await stage(directory,[binding()]);
  await exportPublicProfilesAndReplays({directory,fetchImpl:fixtureFetch(req=>req.url.endsWith(':runQuery')?emptyProfiles:batchResponse(req)),log:()=>{}});
  const canonicalPath=path.join(directory,'canonical',trackId,accountId+'.json');
  const saved=JSON.parse(await fs.readFile(canonicalPath,'utf8'));saved.timeMs++;
  await fs.writeFile(canonicalPath,JSON.stringify(saved));
  let batchGets=0;
  const result=await exportPublicProfilesAndReplays({directory,fetchImpl:fixtureFetch(req=>{
   if(req.url.endsWith(':runQuery'))throw Error('completed profile scan must be reused');
   batchGets++;return batchResponse(req);
  }),log:()=>{}});
  assert.equal(batchGets,1);assert.equal(result.complete,true);
  assert.equal(result.fetchedDocumentsThisRun,1);
  assert.equal(JSON.parse(await fs.readFile(canonicalPath,'utf8')).timeMs,15000);
 });});

test('explicit zero backoff preserves immediate missing-binding retries within the document limit',async()=>{
 await withDirectory(async directory=>{await stage(directory,[binding()]);
  const firstRequests=[];
  await exportPublicProfilesAndReplays({directory,maxDocuments:1,
   fetchImpl:fixtureFetch(req=>req.url.endsWith(':runQuery')?emptyProfiles:[{missing:req.options.documents[0]}],firstRequests),log:()=>{}});
  const progressPath=path.join(directory,'export-progress.json');
  const progress=JSON.parse(await fs.readFile(progressPath,'utf8'));
  const signature=JSON.stringify([accountId,trackId,42,900,replayHash]);
  progress.raceExport.covered[signature]=true;
  await fs.writeFile(progressPath,JSON.stringify(progress));
  const retryRequests=[];
  const result=await exportPublicProfilesAndReplays({directory,maxDocuments:1,retryInvalidAfterMs:0,
   fetchImpl:fixtureFetch(req=>[{missing:req.options.documents[0]}],retryRequests),log:()=>{}});
  assert.equal(result.budgetReached,false);
  assert.equal(result.fetchedDocumentsThisRun,1);
  assert.equal(retryRequests.length,1);
  assert.equal(retryRequests[0].url.endsWith(':batchGet'),true);
  assert.equal(retryRequests[0].options.documents.length,1);
 });});

const readProgress = async directory => JSON.parse(await fs.readFile(path.join(directory,'export-progress.json'),'utf8'));
const writeProgress = (directory,value) => fs.writeFile(path.join(directory,'export-progress.json'),JSON.stringify(value));
async function prepareRetry(directory,entries=[binding()]){
 await stage(directory,entries);await writeProgress(directory,{profiles:{complete:true,ids:[]}});
}
const signature = row => JSON.stringify([row.accountId,row.trackId,row.uploadId,row.frames,row.replayHash]);

test('missing bindings use exponential capped backoff and stay incomplete throughout cooldown',async()=>{
 await withDirectory(async directory=>{
  await prepareRetry(directory);let calls=0,now=1000;
  const fetchImpl=fixtureFetch(req=>{calls++;return req.options.documents.map(missing=>({missing}));});
  const run=at=>exportPublicProfilesAndReplays({directory,includeProfiles:false,now:at,fetchImpl});
  await run(now);assert.equal(calls,1);
  for(let attempts=1;attempts<=7;attempts++){
   const delay=Math.min(86400000,3600000*2**(attempts-1));
   const before=await run(now+delay-1);assert.equal(calls,attempts);assert.equal(before.deferredBindingRetries,1);
   assert.equal(before.complete,false);assert.equal(before.totalCoverage.missing,1);assert.equal(before.totalCoverage.available,0);
   now+=delay;await run(now);assert.equal(calls,attempts+1);
  }
  const record=Object.values((await readProgress(directory)).raceExport.records)[0];assert.equal(record.attempts,8);
 });
});

test('never-attempted bindings precede due retries even if their signatures sort later',async()=>{
 await withDirectory(async directory=>{
  const fresh=binding({accountId:otherAccount,uploadId:43});await prepareRetry(directory);
  await exportPublicProfilesAndReplays({directory,includeProfiles:false,now:1000,fetchImpl:fixtureFetch(req=>req.options.documents.map(missing=>({missing})))});
  await stage(directory,[binding(),fresh]);const requests=[];
  const result=await exportPublicProfilesAndReplays({directory,includeProfiles:false,now:3601000,maxDocuments:1,
   fetchImpl:fixtureFetch(req=>batchResponse(req,raceFields({accountId:str(otherAccount),uploadId:int(43)})),requests)});
  assert.deepEqual(requests[0].options.documents,[ref('0.6.2_race_results',otherAccount+'_'+trackId)]);
  assert.equal(result.counts.recordings,1);assert.equal(result.totalCoverage.missing,1);assert.equal(result.complete,false);assert.equal(result.budgetReached,true);
  const pending=(await readProgress(directory)).raceExport.pending;assert.deepEqual(pending,[signature(binding())]);
 });
});

test('valid saved pairs dominate stale failures and forged covered flags never hide missing files',async()=>{
 await withDirectory(async directory=>{
  await prepareRetry(directory);await exportPublicProfilesAndReplays({directory,includeProfiles:false,now:1000,fetchImpl:fixtureFetch(req=>batchResponse(req))});
  const progress=await readProgress(directory),key=signature(binding());
  progress.raceExport.records[key]={signature:key,available:false,reason:'missing',checkedAt:1000,attempts:32};
  await writeProgress(directory,progress);
  const result=await exportPublicProfilesAndReplays({directory,includeProfiles:false,now:1001,fetchImpl:async()=>{throw Error('valid local pair must win');}});
  assert.equal(result.complete,true);assert.equal(result.deferredBindingRetries,0);assert.equal(result.counts.recordings,1);
  assert.equal(Object.hasOwn((await readProgress(directory)).raceExport.records[key],'attempts'),false);
  await fs.unlink(path.join(directory,'recordings','42.json'));
  const requests=[];const repaired=await exportPublicProfilesAndReplays({directory,includeProfiles:false,now:1002,fetchImpl:fixtureFetch(req=>batchResponse(req),requests)});
  assert.equal(requests.length,1);assert.equal(repaired.complete,true);
 });
});

test('every binding identity change bypasses old deterministic cooldown, display-only edits do not',async()=>{
 for(const patch of [{uploadId:43},{frames:901,raceTimeFrames:901},{replayHash:'d'.repeat(64)},{accountId:otherAccount},{timeMs:14000}]){
  await withDirectory(async directory=>{
   await prepareRetry(directory);const fetchImpl=fixtureFetch(req=>req.options.documents.map(missing=>({missing})));
   await exportPublicProfilesAndReplays({directory,includeProfiles:false,now:1000,fetchImpl});
   await stage(directory,[binding({...patch,name:'new display'})]);const requests=[];
   const result=await exportPublicProfilesAndReplays({directory,includeProfiles:false,now:1001,fetchImpl:fixtureFetch(req=>req.options.documents.map(missing=>({missing})),requests)});
   assert.equal(requests.length,1);assert.equal(result.deferredBindingRetries,0);
   assert.equal(Object.keys((await readProgress(directory)).raceExport.records).length,1);
   await stage(directory,[binding({...patch,name:'another display'})]);
   const deferred=await exportPublicProfilesAndReplays({directory,includeProfiles:false,now:1002,fetchImpl:async()=>{throw Error('same binding must back off');}});
   assert.equal(deferred.deferredBindingRetries,1);assert.equal(deferred.complete,false);
  });
 }
});

test('legacy deterministic failure records without attempts retain checkedAt cooldown',async()=>{
 await withDirectory(async directory=>{
  await prepareRetry(directory);
  const fetchImpl=fixtureFetch(req=>batchResponse(req,raceFields({uploadId:int(999)})));
  await exportPublicProfilesAndReplays({directory,includeProfiles:false,now:1000,fetchImpl});
  const progress=await readProgress(directory),key=signature(binding());delete progress.raceExport.records[key].attempts;delete progress.raceExport.records[key].bindingTimeMs;
  await writeProgress(directory,progress);
  const result=await exportPublicProfilesAndReplays({directory,includeProfiles:false,now:1001,fetchImpl:async()=>{throw Error('legacy failure must back off');}});
  assert.equal(result.deferredBindingRetries,1);assert.equal(result.totalCoverage.invalid,1);assert.equal(result.complete,false);
 });
});

test('upload conflicts and oversized public outputs back off without skipping valid saved matches',async()=>{
 for(const reason of ['upload-conflict','output-too-large'])await withDirectory(async directory=>{
  await prepareRetry(directory);
  let fields=raceFields();
  if(reason==='upload-conflict'){
   await fs.mkdir(path.join(directory,'recordings'));await fs.writeFile(path.join(directory,'recordings','42.json'),JSON.stringify({accountId:otherAccount}));
  }else{
   // JSON escaping can exceed the public file cap while replay bytes are valid.
   const payload='\0'.repeat(360000),hash=createHash('sha256').update(payload).digest('hex');
   await stage(directory,[binding({replayHash:hash})]);fields=raceFields({replay:str(payload),replayHash:str(hash)});
  }
  await exportPublicProfilesAndReplays({directory,includeProfiles:false,now:1000,fetchImpl:fixtureFetch(req=>batchResponse(req,fields))});
  assert.equal(Object.values((await readProgress(directory)).raceExport.records)[0].reason,reason);
  const result=await exportPublicProfilesAndReplays({directory,includeProfiles:false,now:1001,fetchImpl:async()=>{throw Error('deterministic failure should defer');}});
  assert.equal(result.deferredBindingRetries,1);assert.equal(result.totalCoverage.invalid,1);assert.equal(result.complete,false);
 });
});

test('partial, duplicate, unexpected and undecodable batch responses never get deterministic cooldown',async()=>{
 const responses=[()=>[],req=>[{found:{name:req.options.documents[0],fields:{accountId:{unsupported:'bad'}}}}],
  req=>[{found:{name:req.options.documents[0]+'_wrong',fields:raceFields()}}],
  req=>[{found:{name:req.options.documents[0],fields:raceFields()},missing:req.options.documents[0]}]];
 for(const response of responses)await withDirectory(async directory=>{
  await prepareRetry(directory);
  const bad=await exportPublicProfilesAndReplays({directory,includeProfiles:false,now:1000,fetchImpl:fixtureFetch(response)});
  assert.equal(bad.complete,false);assert.equal(bad.totalCoverage.invalid,1);assert.equal(bad.totalCoverage.missing,0);
  const requests=[];const recovered=await exportPublicProfilesAndReplays({directory,includeProfiles:false,now:1001,fetchImpl:fixtureFetch(req=>batchResponse(req),requests)});
  assert.equal(requests.length,1);assert.equal(recovered.complete,true);assert.equal(recovered.totalCoverage.invalid,0);
 });
 await withDirectory(async directory=>{
  await prepareRetry(directory);const bad=await exportPublicProfilesAndReplays({directory,includeProfiles:false,fetchImpl:fixtureFetch(req=>{const rows=batchResponse(req);return [...rows,...rows];})});
  assert.equal(bad.complete,false);assert.equal(bad.totalCoverage.invalid,1);
 });
});

test('HTTP, network and invalid JSON failures throw and leave pending checkpoint recoverable',async()=>{
 for(const fetchImpl of [async()=>{throw Error('offline');},async()=>({ok:false,status:503}),async()=>({ok:true,text:async()=>'not json'})]){
  await withDirectory(async directory=>{
   await prepareRetry(directory);await assert.rejects(exportPublicProfilesAndReplays({directory,includeProfiles:false,now:1000,fetchImpl}));
   const progress=await readProgress(directory);assert.equal(progress.raceExport.pending.length,1);assert.deepEqual(progress.raceExport.records,{});
   const recovered=await exportPublicProfilesAndReplays({directory,includeProfiles:false,now:1001,fetchImpl:fixtureFetch(req=>batchResponse(req))});assert.equal(recovered.complete,true);
  });
 }
});

test('untrusted future retry timestamps cannot pin a binding indefinitely',async()=>{
 await withDirectory(async directory=>{
  await prepareRetry(directory);const p=await readProgress(directory);
  p.raceExport={records:{[signature(binding())]:{available:false,reason:'missing',checkedAt:Number.MAX_SAFE_INTEGER,attempts:1e9,retryAt:Number.MAX_SAFE_INTEGER}}};await writeProgress(directory,p);
  const requests=[];const result=await exportPublicProfilesAndReplays({directory,includeProfiles:false,now:1000,fetchImpl:fixtureFetch(req=>batchResponse(req),requests)});
  assert.equal(requests.length,1);assert.equal(result.complete,true);
 });
});

test('canonical time mismatch cannot overwrite a previously valid replay/canonical pair',async()=>{
 await withDirectory(async directory=>{
  await prepareRetry(directory);await exportPublicProfilesAndReplays({directory,includeProfiles:false,now:1000,fetchImpl:fixtureFetch(req=>batchResponse(req))});
  const canonicalPath=path.join(directory,'canonical',trackId,accountId+'.json');
  const oldCanonical=await fs.readFile(canonicalPath,'utf8');
  await stage(directory,[binding({timeMs:14000})]);
  const result=await exportPublicProfilesAndReplays({directory,includeProfiles:false,now:1001,fetchImpl:fixtureFetch(req=>batchResponse(req))});
  assert.equal(result.complete,false);assert.equal(result.totalCoverage.available,0);assert.equal(result.totalCoverage.invalid,1);
  assert.equal(await fs.readFile(canonicalPath,'utf8'),oldCanonical);
  const repaired=await exportPublicProfilesAndReplays({directory,includeProfiles:false,now:3601001,fetchImpl:fixtureFetch(req=>batchResponse(req,raceFields({timeMs:int(14000)})))});
  assert.equal(repaired.complete,true);assert.equal(JSON.parse(await fs.readFile(canonicalPath,'utf8')).timeMs,14000);
 });
});

test('profile checkpoints preserve pending replay failure history on transient profile failure',async()=>{
 await withDirectory(async directory=>{
  await prepareRetry(directory);await exportPublicProfilesAndReplays({directory,includeProfiles:false,now:1000,fetchImpl:fixtureFetch(req=>req.options.documents.map(missing=>({missing})))});
  const p=await readProgress(directory);p.profiles.complete=false;await writeProgress(directory,p);let calls=0;
  await assert.rejects(exportPublicProfilesAndReplays({directory,pageSize:1,now:1001,fetchImpl:fixtureFetch(()=>{if(calls++===0)return [profileDoc()];throw Error('profile transient');})}));
  const saved=await readProgress(directory);assert.equal(saved.raceExport.records[signature(binding())].reason,'missing');
  assert.equal(saved.raceExport.records[signature(binding())].checkedAt,1000);
 });
});

test('unchanged invalid bindings back off without claiming completeness, even after unrelated snapshot edits',async()=>{
 await withDirectory(async directory=>{
  await stage(directory,[binding()]);const requests=[];
  const fetchImpl=fixtureFetch(req=>batchResponse(req,raceFields({uploadId:int(999)})),requests);
  await exportPublicProfilesAndReplays({directory,includeProfiles:false,now:1000,retryInvalidAfterMs:3600000,fetchImpl});
  await stage(directory,[binding({name:'Updated display name'})]);requests.length=0;
  const cached=await exportPublicProfilesAndReplays({directory,includeProfiles:false,now:2000,retryInvalidAfterMs:3600000,fetchImpl});
  assert.equal(requests.length,0);assert.equal(cached.deferredBindingRetries,1);assert.equal(cached.complete,false);
  assert.equal(cached.totalCoverage.invalid,1);
  await exportPublicProfilesAndReplays({directory,includeProfiles:false,now:3601000,retryInvalidAfterMs:3600000,fetchImpl});
  assert.equal(requests.length,1);
 });
});

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
