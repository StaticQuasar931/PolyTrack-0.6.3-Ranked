import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {exportPublicProfilesAndReplays} from './public-profile-replay-export.mjs';
import {publicEventBackup} from './public-snapshot-backup.mjs';
import {publicEventPlaybackForPublication} from './public-event-playback.mjs';

const accountId='a'.repeat(64),trackId='b'.repeat(64);
const replay=deflateSync(Buffer.alloc(15)).toString('base64url');
const replayHash=createHash('sha256').update(replay).digest('hex');
const stamp='2026-10-30T08:01:02.123456789Z';
const str=stringValue=>({stringValue}),int=value=>({integerValue:String(value)});
const canonicalPath=`canonical/${trackId}/${accountId}.json`;
const binding={accountId,trackId,timeMs:900,frames:900,raceTimeFrames:900,uploadId:42,replayHash,
  carStyle:'style',runVerified:true,integrityVerified:true,verified:true,verifiedState:1,pbAt:100,createdAt:200};
const fields={accountId:str(accountId),trackId:str(trackId),timeMs:int(900),frames:int(900),raceTimeFrames:int(900),
  uploadId:int(42),replay:str(replay),replayHash:str(replayHash),carStyle:str('style'),updatedAt:int(300),
  pbAt:int(100),createdAt:int(200),verified:{booleanValue:true},verifiedState:int(1)};
const pending={...binding,runVerified:false,verified:false,verifiedState:0};
async function fixture(run){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'polytrack-ingestion-export-'));
 const stage=async row=>{
  await fs.mkdir(path.join(directory,'staging/tracks'),{recursive:true});
  await fs.writeFile(path.join(directory,`staging/tracks/${trackId}.json`),JSON.stringify({trackId,entries:[row]}));
 };
 await stage(binding);
 const read=async relative=>JSON.parse(await fs.readFile(path.join(directory,relative),'utf8'));
 const requests=[];
 const fetchFor=extra=>async(url,options)=>{
  assert.ok(String(url).endsWith(':batchGet'));
  const body=JSON.parse(options.body);requests.push(body);
  assert.equal(body.documents.length,1);assert.ok(body.mask.fieldPaths.includes('ingestedAt'));
  return {ok:true,text:async()=>JSON.stringify(body.documents.map(name=>({found:{name,fields:{...fields,...extra}}})))};
 };
 const options={directory,includeProfiles:false,maxDocuments:1,trustServerIngestedAt:true};
 try{await run({directory,stage,read,requests,fetchFor,options});}
 finally{await fs.rm(directory,{recursive:true,force:true});}
}
const noFetch=()=>{throw Error('Chronology must not add a request');};

test('existing canonical reads retain strict UTC server timestamps without truncating nanos',async()=>{
 for(const value of ['2026-10-30T08:01:02Z','2026-10-30T08:01:02.123Z',stamp])await fixture(async f=>{
  const result=await exportPublicProfilesAndReplays({...f.options,fetchImpl:f.fetchFor({ingestedAt:{timestampValue:value}})});
  assert.equal(result.fetchedDocumentsThisRun,1);assert.equal(f.requests.length,1);
  assert.equal((await f.read(canonicalPath)).ingestedAt,value);
  assert.equal((await f.read(canonicalPath)).ingestedAtSource,'firestore-server-timestamp');
  assert.equal((await f.read('recordings/42.json')).ingestedAt,undefined);
  assert.equal((await f.read(canonicalPath)).pbAt,100);
 });
});

test('integerValue ingestion dates do not receive timestamp provenance or chronology',async()=>{
 await fixture(async f=>{
  await exportPublicProfilesAndReplays({...f.options,fetchImpl:f.fetchFor({ingestedAt:int(1793347262123)})});
  assert.equal((await f.read(canonicalPath)).ingestedAt,undefined);
  assert.equal((await f.read(canonicalPath)).ingestedAtSource,undefined);
 });
});

test('malformed, coerced, rolled-over and nonpositive ingestion values are omitted',async()=>{
 const invalid=[int(0),int(-1),int(8640000000000001),{doubleValue:1.5},str('1793347262123'),str('2026-10-30'),
  str('2026-02-30T08:01:02Z'),str('2026-10-30T24:01:02Z'),str('2026-10-30T08:01:02+00:00'),
  str('2026-10-30T08:01:02.1234567890Z'),str(' 2026-10-30T08:01:02Z'),str(stamp),str('1970-01-01T00:00:00Z'),
  {mapValue:{fields:{__firestoreTimestamp:str(stamp)}}},{nullValue:null}];
 for(const value of invalid)await fixture(async f=>{
  const result=await exportPublicProfilesAndReplays({...f.options,fetchImpl:f.fetchFor({ingestedAt:value})});
  assert.equal(result.totalCoverage.available,1);
  assert.equal(Object.hasOwn(await f.read(canonicalPath),'ingestedAt'),false,JSON.stringify(value));
 });
});

test('missing server chronology never uses staged dates, PB/client dates or account age and does not refetch',async()=>{
 await fixture(async f=>{
  await f.stage({...binding,ingestedAt:stamp,receivedAt:stamp,accountCreatedAt:10});
  await exportPublicProfilesAndReplays({...f.options,fetchImpl:f.fetchFor({accountCreatedAt:int(10),receivedAt:str(stamp)})});
  const first=await fs.readFile(path.join(f.directory,canonicalPath),'utf8');
  assert.equal(Object.hasOwn(JSON.parse(first),'ingestedAt'),false);
  const reused=await exportPublicProfilesAndReplays({...f.options,fetchImpl:noFetch});
  assert.equal(reused.fetchedDocumentsThisRun,0);assert.equal(f.requests.length,1);
  assert.equal(await fs.readFile(path.join(f.directory,canonicalPath),'utf8'),first);
 });
});

test('unchanged canonical/replay reuse preserves authentic chronology without more reads',async()=>{
 await fixture(async f=>{
  await exportPublicProfilesAndReplays({...f.options,fetchImpl:f.fetchFor({ingestedAt:{timestampValue:stamp}})});
  const first=await fs.readFile(path.join(f.directory,canonicalPath),'utf8');
  await f.stage({...binding,name:'Changed public display name'});
  const result=await exportPublicProfilesAndReplays({...f.options,fetchImpl:noFetch});
  assert.equal(result.fetchedDocumentsThisRun,0);
  assert.equal(await fs.readFile(path.join(f.directory,canonicalPath),'utf8'),first);
 });
});

test('status-only promotion retains cached server chronology, not staged replacement dates',async()=>{
 await fixture(async f=>{
  await f.stage(pending);
  await exportPublicProfilesAndReplays({...f.options,includePendingReplays:true,
   fetchImpl:f.fetchFor({ingestedAt:{timestampValue:stamp},verified:{booleanValue:false},verifiedState:int(0)})});
  const before=await f.read('recordings/42.json');
  await f.stage({...binding,ingestedAt:'2026-10-30T09:00:00Z'});
  const result=await exportPublicProfilesAndReplays({...f.options,includePendingReplays:true,fetchImpl:noFetch});
  assert.equal(result.fetchedDocumentsThisRun,0);
  const canonical=await f.read(canonicalPath);
  assert.equal(canonical.ingestedAt,stamp);assert.equal(canonical.ingestedAtSource,'firestore-server-timestamp');assert.equal(canonical.verified,true);
  assert.equal((await f.read('recordings/42.json')).recording,before.recording);
 });
});

test('partial event-byte reuse retains an exact saved canonical ingestion date without DB reads',async()=>{
 await fixture(async f=>{
  await f.stage(pending);
  await exportPublicProfilesAndReplays({...f.options,includePendingReplays:true,
   fetchImpl:f.fetchFor({ingestedAt:{timestampValue:stamp},verified:{booleanValue:false},verifiedState:int(0)})});
  await fs.unlink(path.join(f.directory,'recordings/42.json'));
  const periodId='kodub_1793563200000',runId='c'.repeat(64);
  const entry={accountId,runId,timeMs:900,frames:900,replayHash,name:'Public Racer',carStyle:'style',submittedAt:150,
   verificationStatus:'waiting',pending:true,verified:false,eventRpEligible:false,source:'pending-event-playback'};
  const period={id:periodId,kind:'kodub',trackId,startsAt:100,endsAt:100000,maxRp:700};
  const board=publicEventBackup({id:periodId,period,updatedAt:200,archived:false,entries:[],pendingPlaybacks:[entry]},periodId);
  const payload=await publicEventPlaybackForPublication({periodId,trackId,accountId,runId,timeMs:900,frames:900,
   replay,replayHash,carStyle:'style',submittedAt:150,verificationStatus:'waiting',pending:true,verified:false,
   eventRpEligible:false,source:'pending-event-recording'},{periodId,trackId,entry});
  const relative=`event-playbacks/${periodId}/${runId}.json`;
  for(const [file,value]of [[`events/${periodId}.json`,board],[relative,payload],['manifest.json',{
   schemaVersion:1,events:{[periodId]:{path:`events/${periodId}.json`,updatedAt:200}},eventReplays:{},
   eventPlaybacks:{[relative]:{path:relative,periodId,runId,accountId,timeMs:900,replayHash}}}]]){
   await fs.mkdir(path.dirname(path.join(f.directory,file)),{recursive:true});
   await fs.writeFile(path.join(f.directory,file),JSON.stringify(value));
  }
  const result=await exportPublicProfilesAndReplays({...f.options,includePendingReplays:true,fetchImpl:noFetch});
  assert.equal(result.fetchedDocumentsThisRun,0);assert.equal(result.totalCoverage.available,1);
  assert.equal((await f.read(canonicalPath)).ingestedAt,stamp);
  assert.equal((await f.read(canonicalPath)).ingestedAtSource,'firestore-server-timestamp');
  assert.equal((await f.read('recordings/42.json')).recording,replay);
 });
});

test('origin is opt-in only after a trusted caller attests server-enforced timestamp rules',async()=>{
 await fixture(async f=>{
  await exportPublicProfilesAndReplays({...f.options,trustServerIngestedAt:false,
   fetchImpl:f.fetchFor({ingestedAt:{timestampValue:stamp}})});
  const canonical=await f.read(canonicalPath);assert.equal(canonical.ingestedAt,stamp);
  assert.equal(canonical.ingestedAtSource,undefined);
  // An old unmarked cache is not backfilled or upgraded by enabling the rule gate.
  const result=await exportPublicProfilesAndReplays({...f.options,fetchImpl:noFetch});
  assert.equal(result.fetchedDocumentsThisRun,0);assert.equal((await f.read(canonicalPath)).ingestedAtSource,undefined);
 });
});
