import test from 'node:test';
import assert from 'node:assert/strict';
import {repairExtraQueues} from './repair-extra-queues.mjs';
import {encode} from './firestore.mjs';
import {EXTRA_TRACK_IDS} from '../../workers/ranked/src/extra-track-ids.js';
const id=[...EXTRA_TRACK_IDS][0], name='projects/polytrack-052/databases/(default)/documents/0.6.2_s1_verification/'+id;
const source={name,updateTime:'source-version',fields:encode({trackId:id,slots:{racer:{key:'key',status:'pending',attempts:2,retryAt:1}}}).mapValue.fields};
const fixture=(target=null)=>{const commits=[];return {commits,db:{call:async(p,b)=>p===':runQuery'?[{document:source}]:(commits.push(b),{}),get:async()=>target,write:(c,i,data,prior)=>({update:{name:c+'/'+i,fields:encode(data).mapValue.fields},currentDocument:prior?{updateTime:prior.updateTime}:{exists:false}})}};};
test('dry run inspects destination without writes',async()=>{const f=fixture();const r=await repairExtraQueues(f.db);assert.equal(r.misrouted,1);assert.equal(r.slots,1);assert.equal(r.moved,0);assert.equal(f.commits.length,0);});
test('atomic repair backs up first and pins both versions',async()=>{const f=fixture();let saved=false;const r=await repairExtraQueues(f.db,{apply:true,backup:async record=>{assert.equal(f.commits.length,0);assert.deepEqual(record.source,source);saved=true;}});assert.equal(saved,true);assert.equal(r.moved,1);assert.deepEqual(f.commits[0].writes[0].currentDocument,{exists:false});assert.deepEqual(f.commits[0].writes[1],{delete:name,currentDocument:{updateTime:'source-version'}});});
test('backup failures and overlapping slots never commit',async()=>{const f=fixture();await assert.rejects(repairExtraQueues(f.db,{apply:true,backup:async()=>{throw Error('disk full');}}),/disk full/);assert.equal(f.commits.length,0);const overlap=fixture({data:{trackId:id,slots:{racer:{}}},updateTime:'target-version'});await assert.rejects(repairExtraQueues(overlap.db),/SLOT_CONFLICT/);assert.equal(overlap.commits.length,0);});
test('truncated discovery and missing backup fail closed',async()=>{const f=fixture();await assert.rejects(repairExtraQueues(f.db,{limit:1}),/SCAN_TRUNCATED/);await assert.rejects(repairExtraQueues(f.db,{apply:true}),/BACKUP_REQUIRED/);assert.equal(f.commits.length,0);});
test('nonoverlapping target slots survive the move',async()=>{const f=fixture({data:{trackId:id,slots:{other:{key:'other',status:'pending',retryAt:1}}},updateTime:'target-version'});await repairExtraQueues(f.db,{apply:true,backup:async()=>{}});assert.equal(Object.keys(f.commits[0].writes[0].update.fields.slots.mapValue.fields).length,2);assert.deepEqual(f.commits[0].writes[0].currentDocument,{updateTime:'target-version'});});

test('source without version cannot be removed',async()=>{const f=fixture();f.db.call=async()=>[{document:{...source,updateTime:undefined}}];await assert.rejects(repairExtraQueues(f.db,{apply:true,backup:async()=>{}}),/QUEUE_VERSION_REQUIRED/);assert.equal(f.commits.length,0);});
