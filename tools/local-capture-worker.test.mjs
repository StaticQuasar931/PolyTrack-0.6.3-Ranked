import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {repairPreparedLocalArchives} from './local-capture-worker.mjs';
import {ARCHIVE_REPAIR_NOT_BEFORE} from './local-archive-replay-repair.mjs';
async function fixture(t){
  t.mock.method(globalThis,'fetch',()=>assert.fail('Offline fixtures only'));
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'local-archive-worker-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  await fs.mkdir(path.join(directory,'events'));const periodId='d_20260913',trackId='b'.repeat(64);
  const targets=Array.from({length:12},(_,i)=>({periodId,trackId,accountId:(i+1).toString(16).padStart(64,'0'),timeMs:1000}));
  await fs.writeFile(path.join(directory,'events',periodId+'.json'),JSON.stringify({id:periodId,period:{id:periodId,trackId},archived:true,entries:targets}));
  await fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify({schemaVersion:1,events:{[periodId]:{path:'events/'+periodId+'.json'}}}));
  const file=path.join(directory,'plan.json'),bytes=JSON.stringify({schemaVersion:1,targets});await fs.writeFile(file,bytes);
  const receipt={archiveReplayRepair:{file,sha256:createHash('sha256').update(bytes).digest('hex'),maxDocuments:12}};
  let connects=0,gets=0;const db={get:async(collection,id)=>{gets++;return {data:{collection,id}};},documentBudget:()=>({usedReads:gets,usedWrites:0}),writeAttempts:()=>0};
  const options={receipt,directory,now:()=>ARCHIVE_REPAIR_NOT_BEFORE,connectImpl:async(raw,options)=>{connects++;assert.deepEqual(options,{env:{},mode:'scheduled',documentReadLimit:12,documentWriteLimit:1,maxReadRetries:0});return db;},repair:async({getDocument})=>{for(const t of targets)await getDocument('0.6.2_event_replays',t.periodId+'_'+t.accountId);return {recovered:12};}};
  return {options,targets,db,connects:()=>connects,gets:()=>gets};
}
test('optional absent archive plan costs no auth or reads',async()=>assert.equal(await repairPreparedLocalArchives({receipt:{},connectImpl:()=>assert.fail('No auth')}),null));
test('prepared archive recovery passes zero-retry bounded auth and only exact GETs',async t=>{const f=await fixture(t);assert.equal((await repairPreparedLocalArchives(f.options)).recovered,12);assert.equal(f.connects(),1);assert.equal(f.gets(),12);});
test('pre-reset and changed plan fail before authentication',async t=>{const f=await fixture(t);await assert.rejects(repairPreparedLocalArchives({...f.options,now:()=>ARCHIVE_REPAIR_NOT_BEFORE-1}),/before reset/);f.options.receipt.archiveReplayRepair.sha256='0'.repeat(64);await assert.rejects(repairPreparedLocalArchives(f.options),/fingerprint/);assert.equal(f.connects(),0);});
test('wrong collection, duplicate and unplanned documents never reach storage',async t=>{for(const kind of ['collection','duplicate','unknown']){const f=await fixture(t),id=f.targets[0].periodId+'_'+f.targets[0].accountId;await assert.rejects(repairPreparedLocalArchives({...f.options,repair:async({getDocument})=>{if(kind==='duplicate')await getDocument('0.6.2_event_replays',id);return getDocument(kind==='collection'?'other':'0.6.2_event_replays',kind==='unknown'?'bad':id);}}),/boundary/);assert.equal(f.gets(),kind==='duplicate'?1:0);}});
test('missing or failed document closes the storage capability',async t=>{const f=await fixture(t);f.db.get=async()=>{throw Error('quota');};await assert.rejects(repairPreparedLocalArchives({...f.options,repair:async({getDocument})=>{const id=f.targets[0].periodId+'_'+f.targets[0].accountId;await assert.rejects(getDocument('0.6.2_event_replays',id),/quota/);return getDocument('0.6.2_event_replays',f.targets[1].periodId+'_'+f.targets[1].accountId);}}),/boundary/);});
test('archive recovery runs between source backup and native verification',async()=>{const source=await fs.readFile(new URL('./local-capture-worker.mjs',import.meta.url),'utf8');assert.match(source,/const backup=await runPublicSnapshotBackup\(options\);if\(backup\?\.deferred\)return backup;[\s\S]*?repairPreparedLocalArchives/);});
