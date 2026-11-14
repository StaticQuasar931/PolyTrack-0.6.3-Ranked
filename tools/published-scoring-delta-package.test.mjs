import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {encodeSnapshot,decodeSnapshot} from './snapshot-package.mjs';
import {PERMANENT_ROLLING_HILLS as R} from '../workers/ranked/src/permanent-rolling-hills.js';
import {buildPublishedScoringDeltaPackage,validateScoringDeltaDirectory,SCORING_DELTA_PATHS} from './published-scoring-delta-package.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex'), id=c=>c.repeat(64);
async function fixture(t) {
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'scoring-delta-'));t.after(()=>fs.rm(base,{recursive:true,force:true}));
  const sourceRoot=path.join(base,'source'),directory=path.join(sourceRoot,'public-snapshots83');await fs.mkdir(directory,{recursive:true});
  const capture={kind:'captured-native-content-v1',sourceHash:id('f'),sourceHashMode:'canonical-json',sourceUpdatedAt:100};
  const rolling={id:R.id,kind:'permanent',trackId:R.trackId,scoreVersion:'rolling-hills-live-verified-v1',maxRp:1001,
    targetPolicy:'live-fastest-physics-verified',targetMs:10000,sourceRevision:7,updatedAt:200,complete:true,totalEntries:1,
    sourceTotalEntries:2,sourceCompleteness:'captured-native-complete',contributions:{normalRp:true,eventRp:true},capturedNativeSource:capture,
    entries:[{accountId:id('a'),trackId:R.trackId,timeMs:10000,frames:10000,rank:1,rp:1001,eventRpContribution:1001,
      physicsVerified:true,replayIntegrityVerified:true,normalRpEligible:true,replayHash:id('e')}]};
  const totals={complete:true,totalEntries:1,updatedAt:200,nativeEventOverlay:{version:'native-event-overlay-v1',source:'trusted-published-rebase',rollingSource:capture},
    entries:[{accountId:id('a'),name:'A',rp:1201,events:2,finiteEventRp:200,permanentRollingHillsRp:1001,rollingHillsEventRpContribution:1001,rollingHillsTimeMs:10000}]};
  const manifest={schemaVersion:1,events:{[R.id]:{path:'events/'+R.id+'.json',checkedAt:150,updatedAt:200}},
    permanentRollingHills:{path:'events/'+R.id+'.json',checkedAt:150,updatedAt:200},nativeVerificationLedger:{manifestHash:id('c'),policyFingerprint:id('d')}};
  const values={'events/permanent-rolling-hills.json':rolling,'event-totals.json':totals,'manifest.json':manifest,
    'overall-manifest.json':{monolithOmitted:true,fullBoardPath:null},'overall-pages/0.json':{entries:[],date:123},
    ['recordings/'+id('a')+'.json']:{pending:true,verified:false,date:100,replay:'unchanged'}};
  const index={schemaVersion:1,generation:83,publishedAt:300,encoding:'gzip-xor-a7-v1',lookupShardsVersion:1,files:{}};
  for(const[logical,value]of Object.entries(values)){const b=await encodeSnapshot(value),digest=sha(b);index.files[logical]={path:digest+'.bin',sha256:digest,decodedBytes:Buffer.byteLength(JSON.stringify(value))};await fs.writeFile(path.join(directory,digest+'.bin'),b);}
  const bytes=Buffer.from(JSON.stringify(index));await fs.writeFile(path.join(directory,'index.json'),bytes);await fs.writeFile(path.join(sourceRoot,'snapshot-current.json'),JSON.stringify({currentdir:'public-snapshots83'}));
  return {sourceRoot,outputRoot:path.join(base,'candidate'),expectedGeneration:83,expectedIndexSha256:sha(bytes),now:()=>400,index,directory};
}
test('delta copies encoded bytes with link count one, preserves omitted monolith and limits changed paths',async t=>{
  const f=await fixture(t),{index:sourceIndex,directory:sourceDirectory,...options}=f;
  const receipt=await buildPublishedScoringDeltaPackage(options),directory=receipt.candidate.directory;
  const index=JSON.parse(await fs.readFile(path.join(directory,'index.json')));
  assert.deepEqual(receipt.validation.changedLogicalPaths,[...SCORING_DELTA_PATHS].sort());
  assert.equal(index.files['overall.json'],undefined);assert.equal(receipt.encodedPayloadsGenerated,3);assert.equal(receipt.pointerWritten,false);
  for(const logical of ['overall-pages/0.json','overall-manifest.json','recordings/'+id('a')+'.json']){
    assert.deepEqual(index.files[logical],sourceIndex.files[logical]);const name=index.files[logical].path;
    assert.deepEqual(await fs.readFile(path.join(directory,name)),await fs.readFile(path.join(sourceDirectory,name)));
    assert.equal((await fs.stat(path.join(directory,name))).nlink,1);
  }
  const m=JSON.parse(Buffer.from(await decodeSnapshot(await fs.readFile(path.join(directory,index.files['manifest.json'].path)))));
  assert.equal(m.events[R.id].checkedAt,150);assert.equal(m.publishedScoringDelta.newVerification,false);
  assert.equal(m.events[R.id].scoreVersion,'rolling-hills-pace-placement-v2');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.sourceRoot,'snapshot-current.json'))).currentdir,'public-snapshots83');
  await fs.writeFile(path.join(directory,'extra.bin'),'x');
  await assert.rejects(validateScoringDeltaDirectory({directory,sourceIndex,index}),/extraneous_or_linked_file/);
  await fs.unlink(path.join(directory,'extra.bin'));
  const first=index.files['overall-pages/0.json'].path;
  await fs.link(path.join(directory,first),path.join(directory,'linked.bin'));
  await assert.rejects(validateScoringDeltaDirectory({directory,sourceIndex,index}),/extraneous_or_linked_file/);
  await fs.unlink(path.join(directory,'linked.bin'));
  const invented=structuredClone(index);invented.files['overall.json']=index.files['overall-pages/0.json'];
  await assert.rejects(validateScoringDeltaDirectory({directory,sourceIndex,index:invented}),/logical_inventory_changed/);
  await fs.appendFile(path.join(directory,index.files['overall-pages/0.json'].path),'bad');
  await assert.rejects(validateScoringDeltaDirectory({directory,sourceIndex,index}),/candidate_hash_changed/);
});
test('source pin, cross-cohort version, overlap and extraneous patch options fail closed',async t=>{
  const f=await fixture(t),{index,directory,...options}=f;
  await assert.rejects(buildPublishedScoringDeltaPackage({...options,expectedIndexSha256:id('0')}),/index SHA256 mismatch/);
  await assert.rejects(buildPublishedScoringDeltaPackage({...options,expectedGeneration:82}),/immediately previous/);
  await assert.rejects(buildPublishedScoringDeltaPackage({...options,outputRoot:path.join(f.sourceRoot,'bad')}),/overlapping/);
  await assert.rejects(buildPublishedScoringDeltaPackage({...options,patches:{'overall.json':{}}}),/unsupported_option/);
  const sourcePath=path.join(directory,index.files['overall-pages/0.json'].path);await fs.appendFile(sourcePath,'bad');
  await assert.rejects(buildPublishedScoringDeltaPackage(options),/candidate_hash_changed/);
  await assert.rejects(fs.stat(path.join(f.outputRoot,'build-receipt.json')),{code:'ENOENT'});
});
