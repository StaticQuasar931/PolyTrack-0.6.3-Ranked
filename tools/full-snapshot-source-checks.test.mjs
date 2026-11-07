import test from 'node:test';import assert from 'node:assert/strict';import {selectFullTrackChecks,assertFullTrackChecks} from './full-snapshot-source-checks.mjs';
const a='a'.repeat(64),b='b'.repeat(64),c='c'.repeat(64),records={[a]:{path:'tracks/'+a+'.json',checkedAt:100},[b]:{path:'tracks/'+b+'.json',checkedAt:99}};
test('full mode rechecks unchanged timestamps unless authenticated current data confirmed them',()=>assert.deepEqual(selectFullTrackChecks([b,a],records,{notBefore:100}),[b]));
test('insufficient full budget fails instead of silently publishing a twenty-track subset',()=>assert.throws(()=>selectFullTrackChecks([a,b],records,{notBefore:101,limit:1}),/cannot cover/));
test('a retained board with a failed read is not freshened',()=>assert.throws(()=>assertFullTrackChecks([a,b],{...records,[b]:{path:'tracks/b.json',missing:true,checkedAt:100}},100),/unconfirmed retained/));
test('confirmed absent unprovisioned tracks are reported unavailable, never as populated standings',()=>assert.deepEqual(assertFullTrackChecks([a,c],{...records,[c]:{path:null,missing:true,checkedAt:100}},100),{known:2,confirmed:1,unavailable:1,checkedAtOrAfter:100}));
test('oversized inventories and invalid bounds are rejected',()=>{assert.throws(()=>selectFullTrackChecks(['bad'],{}, {notBefore:1}));assert.throws(()=>selectFullTrackChecks([a],{}, {notBefore:NaN}));});

import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {runPublicSnapshotBackup} from './public-snapshot-backup.mjs';
async function fullFixture(t,{missing=false}={}){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'full-source-capture-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));await fs.mkdir(path.join(directory,'tracks'));
 const board=id=>({trackId:id,updatedAt:10,revision:1,complete:true,sourceComplete:true,totalEntries:0,entries:[]});
 const records=Object.fromEntries([a,b].map(id=>[id,{path:'tracks/'+id+'.json',updatedAt:10,sourceUpdatedAt:10,revision:1,checkedAt:100}]));
 for(const id of [a,b])await fs.writeFile(path.join(directory,records[id].path),JSON.stringify(board(id)));
 const manifest={schemaVersion:1,tracks:records,events:{}};await fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify(manifest));const calls=[];
 const options={directory,now:1000,trackIds:[a,b],trackFetchLimit:512,trackConfirmationNotBefore:900,log:()=>{},capturedOverall:{updatedAt:10,revision:1,complete:true,totalEntries:0,entries:[],trackSummaries:[{trackId:a,updatedAt:10},{trackId:b,updatedAt:10}]},fetchImpl:async input=>{const u=new URL(input);calls.push(u.pathname);if(u.pathname==='/v1/events/catalog')return Response.json({periods:[],archives:[]});if(u.pathname==='/v1/snapshot/track'){const id=u.searchParams.get('trackId');return missing&&id===b?new Response('',{status:404}):Response.json(board(id));}return new Response('',{status:404});}};
 return {directory,options,calls,manifest};
}
test('full backup refreshes unchanged but unconfirmed boards rather than skipping equal source timestamps',async t=>{const f=await fullFixture(t);const result=await runPublicSnapshotBackup(f.options);assert.notEqual(result.deferred,true);const manifest=JSON.parse(await fs.readFile(path.join(f.directory,'manifest.json'),'utf8'));assert.equal(manifest.tracks[a].checkedAt,1000);assert.equal(manifest.tracks[b].checkedAt,1000);assert.equal(f.calls.filter(p=>p==='/v1/snapshot/track').length,2);});
test('full backup cannot publish after a retained source returns unavailable',async t=>{const f=await fullFixture(t,{missing:true});await assert.rejects(runPublicSnapshotBackup(f.options),/unconfirmed retained/);assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.directory,'manifest.json'),'utf8')),f.manifest);});
