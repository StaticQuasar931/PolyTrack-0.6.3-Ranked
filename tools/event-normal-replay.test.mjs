import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {createPublicSnapshotReader} from './public-snapshot-client.mjs';
import {preparePublicRecordingPlayback} from './public-replay-playback.mjs';
import {eventRecordingToNormal} from './event-recording-binding.mjs';

const recording=deflateSync(Buffer.alloc(15)).toString('base64url');
const hash=createHash('sha256').update(recording).digest('hex');
const account='a'.repeat(64),track='b'.repeat(64),run='c'.repeat(64),period='kodub_fixture';
const entry={accountId:account,trackId:track,uploadId:12,timeMs:5000,frames:5000,raceTimeFrames:5000,replayHash:hash,
  runVerified:false,verified:false,integrityVerified:true,verifiedState:0};
function fixture({pending=false,prepareRecording,beforeRead}={}){
  const path=pending?`event-playbacks/${period}/${run}.json`:`event-replays/${period}/${account}.json`;
  const payload={periodId:period,trackId:track,accountId:account,runId:run,timeMs:5000,frames:5000,replayHash:hash,replay:recording,carStyle:'',
    ...(pending?{pending:true,verified:false,eventRpEligible:false,verificationStatus:'waiting',source:'pending-event-recording',submittedAt:100}:{verified:true,verifiedAt:100,proof:'must-not-copy',status:'verified'})};
  const record={path,periodId:period,accountId:account,timeMs:5000,replayHash:hash,...(pending?{runId:run}:{})};
  const manifest={schemaVersion:1,tracks:{},eventReplays:pending?{}:{[path]:record},eventPlaybacks:pending?{[path]:record}:{}};
  const board={id:period,period:{id:period,trackId:track},updatedAt:100,archived:false,entries:[],pendingPlaybacks:[{...payload,source:'pending-event-playback'}]};
  const data=new Map([['manifest.json',manifest],[path,payload],[`events/${period}.json`,board]]),calls=[],failures=[];
  const read=createPublicSnapshotReader({baseUrl:'https://offline.invalid/public-snapshots65/',prepareRecording,onPlaybackFailure:value=>failures.push(value),fetchImpl:async input=>{
    const url=new URL(input);assert.equal(url.origin,'https://offline.invalid');calls.push(url.pathname);
    if(url.pathname==='/snapshot-current.json')return Response.json({currentdir:'public-snapshots66'});
    const relative=url.pathname.replace(/^\/public-snapshots\d+\//,'');
    await beforeRead?.(relative);
    return data.has(relative)?Response.json(data.get(relative)):new Response('',{status:404});
  }});
  return {read,data,calls,failures,payload,manifest,path,record};
}
const pause=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

test('verified event bytes remain pending under the normal row; opt-in is mandatory and no authority is copied',async()=>{
  const f=fixture();assert.equal(await f.read.recordingPlayback(entry),null);
  assert.equal(f.calls.some(url=>url.includes('event-replays')),false);
  const result=await f.read.recordingPlayback(entry,{allowPending:true});
  assert.equal(result.recording,recording);assert.equal(result.uploadId,12);assert.equal(result.verifiedState,0);
  assert.equal(result.playbackPending,true);assert.equal(result.verificationStatus,'pending');assert.equal(result.eventRpEligible,false);
  assert.equal(result.proof,undefined);assert.equal(result.verifiedAt,undefined);assert.equal(entry.runVerified,false);
  assert.equal(await f.read('recording',12),null,'legacy unbound reads still have no normal payload');
});

test('normal verified eligibility, not an event verdict, controls verified-state conversion',async()=>{
  const f=fixture({pending:true});const normal={...entry,runVerified:true,verified:true,verifiedState:1};
  const result=await f.read.recordingPlayback(normal);
  assert.equal(result.verifiedState,1);assert.equal(result.playbackPending,false);assert.equal(result.eventRpEligible,false);
  const converted=eventRecordingToNormal({...f.payload,status:'rejected',verified:true,proof:'private'},entry);
  assert.deepEqual(Object.keys(converted).sort(),['accountId','trackId','uploadId','timeMs','frames','replayHash','recording','carStyle','verifiedState'].sort());
  assert.equal(converted.verifiedState,0);
});

test('pending event aliases remain subject to the existing listed-run validation',async()=>{
  const f=fixture({pending:true});assert.ok(await f.read.recordingPlayback(entry,{allowPending:true}));
  const missing=fixture({pending:true});missing.data.get(`events/${period}.json`).pendingPlaybacks=[];
  assert.equal(await missing.read.recordingPlayback(entry,{allowPending:true}),null);
});

test('metadata mismatches do not nominate payload reads',async()=>{
  for(const change of [{accountId:'d'.repeat(64)},{timeMs:4999},{replayHash:'d'.repeat(64)},{trackId:'d'.repeat(64)},{frames:4999},{path:'../private.json'}]){
    const f=fixture();Object.assign(f.record,change);
    assert.equal(await f.read.recordingPlayback(entry,{allowPending:true}),null);
    assert.equal(f.calls.some(url=>url.includes('/event-replays/')),false);
  }
});

test('payload identity, timing, frame, hash, run and actual byte corruption fail closed',async()=>{
  for(const change of [{accountId:'d'.repeat(64)},{trackId:'d'.repeat(64)},{periodId:'another_period'},{timeMs:4999},{frames:4999},{replayHash:'d'.repeat(64)},{runId:'bad'},{replay:'corrupt'}]){
    const f=fixture();Object.assign(f.payload,change);
    assert.equal(await f.read.recordingPlayback(entry,{allowPending:true}),null);
  }
});

test('normal terminal, ineligible and malformed entry bindings never start event fallback',async()=>{
  for(const change of [{status:'rejected'},{integrityVerified:false},{frames:0},{raceTimeFrames:4999},{uploadId:0},{verified:true},{runVerified:undefined}]){
    const f=fixture();assert.equal(await f.read.recordingPlayback({...entry,...change},{allowPending:true}),null);
    assert.equal(f.calls.some(url=>url.endsWith('/manifest.json')),false);
  }
});

test('existing normal binding mismatch may use exact alias; normal hash, format and budget failures remain terminal',async()=>{
  const f=fixture();f.data.set('recordings/12.json',{...entry,updatedAt:1,recording,accountId:'d'.repeat(64)});
  assert.ok(await f.read.recordingPlayback(entry,{allowPending:true}));
  for(const message of ['Public recording hash mismatch','Invalid public replay structure','Public replay work limit','Public recording status not eligible']){
    const g=fixture({prepareRecording:()=>{throw Error(message);}});g.data.set('recordings/12.json',{...entry,updatedAt:1,recording});
    assert.equal(await g.read.recordingPlayback(entry,{allowPending:true}),null);
    assert.equal(g.calls.some(url=>url.endsWith('/manifest.json')),false);
  }
});

test('at most four matching candidates are read, even when the fifth would succeed',async()=>{
  const f=fixture();f.manifest.eventReplays={};
  for(let index=0;index<6;index++){
    const id='event_'+index,path=`event-replays/${id}/${account}.json`;
    f.manifest.eventReplays[path]={...f.record,path,periodId:id};
    f.data.set(path,{...f.payload,periodId:id,frames:index===4?5000:4999});
  }
  assert.equal(await f.read.recordingPlayback(entry,{allowPending:true}),null);
  assert.equal(f.calls.filter(url=>url.includes('/event-replays/')).length,4);
});

for(const at of ['manifest','payload','prepare'])test('generation change during '+at+' discards the alias without cross-generation publication',async()=>{
  const entered=pause(),release=pause();let waiting=false;
  const wait=async()=>{if(waiting)return;waiting=true;entered.resolve();await release.promise;};
  const f=fixture({beforeRead:async relative=>{if(at==='manifest'&&relative==='manifest.json'||at==='payload'&&relative.startsWith('event-replays/'))await wait();},
    prepareRecording:async(...args)=>{const result=await preparePublicRecordingPlayback(...args);if(at==='prepare')await wait();return result;}});
  const pending=f.read.recordingPlayback(entry,{allowPending:true});await entered.promise;
  assert.equal(await f.read.refresh(),true);release.resolve();assert.equal(await pending,null);assert.equal(f.failures.length,0);
  assert.equal(f.read.packageInfo().generation,66);
});

test('golden public Hydropower canteringtoucan 41198 loads via exact packed event bytes without live requests',async()=>{
  const golden=JSON.parse(await fs.readFile(new URL('./fixtures/event-normal-hydropower-41198.json',import.meta.url),'utf8'));
  const {encodeSnapshot}=await import('./snapshot-package.mjs');
  const calls=[],blobs=new Map(),records={},lookupFiles={};
  const boardPath='tracks/'+golden.entry.trackId+'.json';
  const values=new Map([
    [boardPath,{trackId:golden.entry.trackId,updatedAt:1,entries:[golden.entry]}],
    ['manifest.json',{schemaVersion:1,tracks:{},eventReplays:{[golden.manifestRecord.path]:golden.manifestRecord},eventPlaybacks:{}}],
    [golden.manifestRecord.path,golden.payload]
  ]);
  for(const [logical,value] of values){
    const bytes=await encodeSnapshot(value),sha256=createHash('sha256').update(bytes).digest('hex');
    const record={path:sha256+'.bin',sha256,decodedBytes:Buffer.byteLength(JSON.stringify(value))};
    records[logical]=record;blobs.set(record.path,bytes);
    if(logical.startsWith('event-replays/')){
      const bucket=createHash('sha256').update(logical).digest('hex').slice(0,2);
      (lookupFiles[bucket]??={})[logical]=record;
    }
  }
  const bootstrapIndex={schemaVersion:1,generation:1,encoding:'gzip-xor-a7-v1',partial:true,fallbackIndex:'index.json',
    lookupShardsVersion:1,files:{[boardPath]:records[boardPath],'manifest.json':records['manifest.json']}};
  const read=createPublicSnapshotReader({baseUrl:'https://offline.invalid/public-snapshots1/',packed:true,bootstrap:true,optimizedIndex:true,
    byteCache:{open:async()=>null},fetchImpl:async input=>{
      const url=new URL(input);assert.equal(url.origin,'https://offline.invalid');assert.ok(url.pathname.startsWith('/public-snapshots1/'));
      calls.push(url.pathname);const name=url.pathname.slice('/public-snapshots1/'.length);
      if(name==='bootstrap-fast.json')return Response.json(bootstrapIndex);
      const shard=/^lookup-shards\/([a-f0-9]{2})\.json$/.exec(name);
      if(shard)return Response.json({schemaVersion:1,lookupShardsVersion:1,encoding:'gzip-xor-a7-v1',generation:1,bucket:shard[1],files:lookupFiles[shard[1]]||{}});
      assert.ok(blobs.has(name),'Only in-memory packed fixture assets may be requested');
      return new Response(blobs.get(name));
    }});
  const board=await read('track',golden.entry.trackId),selected=board.entries[0];
  assert.equal(selected.timeMs,41198);assert.equal(selected.uploadId,1793032721062804);
  assert.equal(await read('recording',selected.uploadId),null);
  const result=await read.recordingPlayback(selected,{allowPending:true});assert.ok(result);
  assert.equal(result.recording,golden.payload.replay);
  assert.equal(createHash('sha256').update(result.recording).digest('hex'),'a77178dc173a37da5d854dd2b98146e96aefbeafecb0cb5359b05f2e2732c9b3');
  assert.equal(result.uploadId,selected.uploadId);assert.equal(result.frames,41198);assert.equal(result.verifiedState,0);
  assert.equal(result.playbackPending,true);assert.equal(result.eventRpEligible,false);assert.equal(selected.runVerified,false);
  assert.ok(calls.some(path=>path.includes('/lookup-shards/')));
  assert.ok(calls.includes('/public-snapshots1/'+records[golden.manifestRecord.path].path));
});
import {deriveEventRecordings} from './snapshot-event-recordings.mjs';

test('future snapshot packaging reuses exact event bytes without raising normal eligibility',async()=>{
 const f=fixture();const files=[{logicalPath:`tracks/${track}.json`,value:{trackId:track,entries:[entry]}},{logicalPath:f.path,value:f.payload}];
 const aliases=await deriveEventRecordings(files);assert.equal(aliases.length,1);assert.equal(aliases[0].logicalPath,'recordings/12.json');
 assert.equal(aliases[0].value.recording,recording);assert.equal(aliases[0].value.verifiedState,0);assert.equal(aliases[0].value.proof,undefined);
 const verified=await deriveEventRecordings([{...files[0],value:{trackId:track,entries:[{...entry,runVerified:true,integrityVerified:true}]}},files[1]]);assert.equal(verified[0].value.verifiedState,1);
 assert.equal((await deriveEventRecordings([...files,{logicalPath:'recordings/12.json',value:{existing:true}}])).length,0);
 assert.equal((await deriveEventRecordings([files[0],{...files[1],value:{...f.payload,replay:'corrupt'}}])).length,0);
 assert.equal((await deriveEventRecordings([files[0],{...files[1],value:{...f.payload,accountId:'d'.repeat(64)}}])).length,0);
});

test('derived normal files meet the real reader schema without an event fallback or invented timestamp',async()=>{
 const f=fixture();const aliases=await deriveEventRecordings([{logicalPath:`tracks/${track}.json`,value:{trackId:track,entries:[entry]}},{logicalPath:f.path,value:f.payload}]);
 assert.equal(aliases[0].value.updatedAt,0);f.data.set(aliases[0].logicalPath,aliases[0].value);f.data.delete('manifest.json');f.data.delete(f.path);
 const result=await f.read.recordingPlayback(entry,{allowPending:true});assert.ok(result);assert.equal(result.frames,entry.frames);assert.equal(result.verifiedState,0);
 assert.equal(f.calls.some(path=>path.endsWith('/manifest.json')||path.includes('/event-replays/')),false);
 const known=await deriveEventRecordings([{logicalPath:`tracks/${track}.json`,value:{trackId:track,entries:[{...entry,updatedAt:123}]}},{logicalPath:f.path,value:f.payload}]);assert.equal(known[0].value.updatedAt,123);
});

