import test from 'node:test';
import assert from 'node:assert/strict';
import {selectJobs} from './runner.mjs';
import {pendingSlot,VERIFICATION_COLLECTION} from '../../workers/ranked/src/verification.js';
const trackId='5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038';
function fixture(){const rows=Array.from({length:20},(_,i)=>({accountId:'racer'+i,trackId,timeMs:100+i,frames:100+i,raceTimeFrames:100+i,uploadId:i+1,replayHash:'a'.repeat(64),replay:'fixture'}));
 const byId=new Map(rows.map(row=>[row.accountId+'_'+trackId,row]));let reads=0;
 return {get reads(){return reads;},docs:[{updateTime:'v1',queueCollection:VERIFICATION_COLLECTION,data:{trackId,notBefore:0,slots:Object.fromEntries(rows.map(row=>[row.accountId,pendingSlot(row,0)]))}}],
 db:{get:async(_collection,id)=>{reads++;return {data:byId.get(id)};},call:()=>assert.fail('no housekeeping expected')}};}
test('idle fill uses all sixteen slots from one due track without duplicate hydration',async()=>{
 const f=fixture(),r=await selectJobs(f.db,f.docs,3600001,{jobLimit:16,lookupLimit:16,fillIdleSlots:true});
 assert.equal(r.jobs.length,16);assert.equal(r.canonicalAttempts,16);assert.equal(f.reads,16);assert.equal(new Set(r.jobs.map(j=>j.resultId)).size,16);
});
test('explicit capture/default per-track and lookup limits remain bounded',async()=>{
 const f=fixture(),r=await selectJobs(f.db,f.docs,3600001,{jobLimit:16,lookupLimit:16});assert.equal(r.jobs.length,8);
 const g=fixture(),s=await selectJobs(g.db,g.docs,3600001,{jobLimit:16,lookupLimit:3,fillIdleSlots:true});assert.equal(s.jobs.length,3);assert.equal(g.reads,3);
});
