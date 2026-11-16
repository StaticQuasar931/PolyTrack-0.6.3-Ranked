import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {encodeSnapshot} from './snapshot-package.mjs';
import {writeLedger} from './native-verification-ledger.mjs';
import {loadTrustedPublishedEventTotalsBaseline} from './published-event-totals-baseline.mjs';
import {retentionMap16,loadPublishedTargetRetention,assertPublishedTargetJobs,assertPublishedTargetRetention} from './published-target-retention.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
async function publishedMediaFixture(t,{visible=true,scoring=false}={}){
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'retention-media-')),root=path.join(base,'public'),directory=path.join(base,'stage');
 t.after(()=>fs.rm(base,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'public-snapshots1'),{recursive:true});
 const ledger=writeLedger({root:path.join(root,'verification-ledger'),entries:[],expectedManifestHash:null});
 const periodId='weekly_fixture',trackId=sha('track'),accountId=sha('racer');
 const raw={lane:'event',periodId,trackId,accountId,runId:sha('visible-run'),timeMs:900,frames:900,
  uploadId:null,replayHash:sha('replay'),replay:'replay',submittedAt:200,pending:!scoring,verified:scoring,eventRpEligible:scoring};
 const row={...raw,rp:scoring?10:0};delete row.replay;
 const orphan={...raw,accountId:sha('orphan-racer'),runId:sha('orphan-run')};
 const board={id:periodId,period:{id:periodId,trackId,kind:'weekly',startsAt:100,endsAt:2000},
  updatedAt:300,complete:true,totalEntries:visible&&scoring?1:0,entries:visible&&scoring?[row]:[],
  pendingPlaybacks:visible&&!scoring?[row]:[]};
 const visiblePath=scoring?`event-replays/${periodId}/${accountId}.json`:`event-playbacks/${periodId}/${raw.runId}.json`;
 const orphanPath=scoring?`event-replays/${periodId}/${orphan.accountId}.json`:`event-playbacks/${periodId}/${orphan.runId}.json`;
 const values={'manifest.json':{tracks:{},events:{[periodId]:{path:`events/${periodId}.json`}},nativeVerificationLedger:{manifestHash:ledger.manifestHash}},
  'event-totals.json':{updatedAt:300,complete:true,totalEntries:visible&&scoring?1:0,entries:visible&&scoring?
   [{accountId,rp:10,finiteEventRp:10,permanentRollingHillsRp:0,events:1}]:[]},
  [`events/${periodId}.json`]:board,[orphanPath]:orphan,...(visible?{[visiblePath]:raw}:{})};
 const index={schemaVersion:1,generation:1,publishedAt:400,encoding:'gzip-xor-a7-v1',files:{}};
 for(const [name,value]of Object.entries(values)){
  const decoded=Buffer.from(JSON.stringify(value)),encoded=Buffer.from(await encodeSnapshot(value)),hash=sha(encoded);
  index.files[name]={path:hash+'.bin',sha256:hash,decodedBytes:decoded.length};
  await fs.writeFile(path.join(root,'public-snapshots1',hash+'.bin'),encoded);
  await fs.mkdir(path.dirname(path.join(directory,name)),{recursive:true});await fs.writeFile(path.join(directory,name),decoded);
 }
 const indexBytes=Buffer.from(JSON.stringify(index));
 await fs.writeFile(path.join(root,'public-snapshots1/index.json'),indexBytes);
 await fs.writeFile(path.join(root,'snapshot-current.json'),JSON.stringify({currentdir:'public-snapshots1'}));
 await fs.writeFile(path.join(root,'verification-ledger-current.json'),JSON.stringify({schemaVersion:1,directory:'verification-ledger',manifestHash:ledger.manifestHash}));
 const pins={generation:1,indexSha256:sha(indexBytes),ledgerManifestHash:ledger.manifestHash,ledgerEntries:0};
 const publishedBaseline=await loadTrustedPublishedEventTotalsBaseline({root,expectedGeneration:1,expectedIndexSha256:pins.indexSha256});
 const options={root,directory,pins,targetTrackIds:[trackId],targetScope:'events',publishedBaseline};
 return {options,raw,orphan,orphanPath,ledger};
}

for(const scoring of [false,true])test(`published ${scoring?'standing':'pending'} media excludes orphan files but preserves their bytes`,async t=>{
 const f=await publishedMediaFixture(t,{scoring}),token=await loadPublishedTargetRetention(f.options);
 assert.equal(token.allowedNewKeys,1);
 assert.doesNotThrow(()=>assertPublishedTargetJobs(token,[f.raw]));
 assert.throws(()=>assertPublishedTargetJobs(token,[f.raw,f.orphan]),/native target inventory differs/);
 assert.throws(()=>assertPublishedTargetJobs(token,[]),/native target inventory differs/);
 const input={directory:f.options.directory,ledger:f.ledger,targetTrackIds:f.options.targetTrackIds,publishedBaseline:f.options.publishedBaseline,targetScope:'events'};
 await assertPublishedTargetRetention(token,input);
 await fs.writeFile(path.join(f.options.directory,f.orphanPath),'{}');
 await assert.rejects(assertPublishedTargetRetention(token,input),/retained bytes changed/);
});

test('orphan replay files alone never create a verification target',async t=>{
 const f=await publishedMediaFixture(t,{visible:false});
 await assert.rejects(loadPublishedTargetRetention(f.options),/no exact target media/);
});

test('retention reads use exactly sixteen slots and return deterministic source order',async()=>{
 let active=0,peak=0;const completed=[];
 const input=Array.from({length:65},(_,i)=>i);
 const result=await retentionMap16(input,async value=>{
  peak=Math.max(peak,++active);await new Promise(resolve=>setTimeout(resolve,(16-value%16)%5));
  completed.push(value);active--;return value*2;
 });
 assert.equal(peak,16);assert.equal(active,0);assert.deepEqual(result,input.map(value=>value*2));
 assert.equal(completed.length,input.length);
});

test('failed retention reads drain in-flight work, stop new admissions and report earliest source failure',async()=>{
 let active=0,admitted=0;const first=Error('source zero'),second=Error('source one');
 await assert.rejects(retentionMap16(Array.from({length:100},(_,i)=>i),async value=>{
  active++;admitted++;
  try{
   if(value===1)throw second;
   await new Promise(resolve=>setTimeout(resolve,10));
   if(value===0)throw first;
   return value;
  }finally{active--;}
 }),error=>error===first);
 assert.equal(active,0);assert.equal(admitted,16);
});

test('empty retention inputs admit no reads and small inputs never exceed their size',async()=>{
 assert.deepEqual(await retentionMap16([],()=>assert.fail('empty read')),[]);
 assert.deepEqual(await retentionMap16([1,2],async value=>value),[1,2]);
 await assert.rejects(retentionMap16(null,()=>{}),/invalid bounded read task/);
});
