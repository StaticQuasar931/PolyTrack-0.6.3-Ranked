import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import{deflateSync}from'node:zlib';import{createHash}from'node:crypto';
import{captureFullCanonical}from'./full-canonical-capture.mjs';import{openFullCanonicalTrackSource,isFullCanonicalTrackSource}from'./full-canonical-track-source.mjs';import{runPublicSnapshotBackup,publicTrackBackup}from'./public-snapshot-backup.mjs';
const track='b'.repeat(64),account='a'.repeat(64),point='2026-11-14T08:20:00.000Z',replay=deflateSync(Buffer.alloc(15)).toString('base64url'),sha=b=>createHash('sha256').update(b).digest('hex');
async function fixture(t,{held=false}={}){
 t.mock.method(globalThis,'fetch',()=>assert.fail('No live calls'));const directory=await fs.mkdtemp(path.join(os.tmpdir(),'canonical-first-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const row={accountId:account,trackId:track,uploadId:2,timeMs:1000,frames:500,raceTimeFrames:500,replay,replayHash:sha(replay),name:'Current racer',carStyle:'',verified:false,verifiedState:0,pbAt:'2026-11-13T08:00:00Z',updatedAt:'2026-11-13T08:05:00Z',ingestedAt:'2026-11-13T08:00:00Z'};
 await fs.mkdir(path.join(directory,'tracks'));await fs.writeFile(path.join(directory,'tracks',track+'.json'),JSON.stringify({trackId:track,updatedAt:123,entries:[{...row,replay:undefined,uploadId:1,timeMs:2000,verified:true,verifiedState:1,runVerified:true,verifiedAt:123,pbAt:'2026-11-10T08:00:00Z',reviewHold:held}]}));
 const fields=Object.fromEntries(Object.entries(row).map(([k,v])=>[k,typeof v==='string'?{stringValue:v}:typeof v==='boolean'?{booleanValue:v}:{integerValue:String(v)}]));fields.ingestedAt={timestampValue:row.ingestedAt};let reads=0;
 const report=await captureFullCanonical({directory,db:{async call(){return reads++===0?[{document:{name:'projects/test/databases/(default)/documents/0.6.2_race_results/'+account+'_'+track,fields},readTime:point}]:[{readTime:point}];}}});assert.equal(report.complete,true);
 const source=await openFullCanonicalTrackSource({directory,report});return{directory,row,report,source};
}
test('actual full capture brands current faster PB source without transferring old verification',async t=>{
 const f=await fixture(t);assert(isFullCanonicalTrackSource(f.source));assert.equal(isFullCanonicalTrackSource({...f.source}),false);assert.equal(f.source.rows,1);const b=f.source.validate(track,await fs.readFile(path.join(f.directory,'tracks',track+'.json')));assert.equal(b.entries[0].uploadId,2);assert.equal(b.entries[0].timeMs,1000);assert.equal(b.entries[0].runVerified,false);assert.equal(b.entries[0].pbAt,f.row.pbAt);assert.notEqual(b.entries[0].pbAt,'2026-11-10T08:00:00Z');
});
test('complete current canonical boards do not request stale Worker tracks or retention reads',async t=>{
 const f=await fixture(t),calls=[];const result=await runPublicSnapshotBackup({directory:f.directory,now:Date.parse(point)+1000,trackIds:[track],trackConfirmationNotBefore:Date.parse(point)+500,trackFetchLimit:512,fullCanonicalSource:f.source,reconcileCanonicalTrack:()=>assert.fail('No duplicate canonical reads'),log:()=>{},fetchImpl:async input=>{
 const u=new URL(input);calls.push(u.pathname);if(u.pathname==='/v1/snapshot/overall')return Response.json({updatedAt:123,revision:1,sourceRevision:1,algorithmVersion:'v1',entries:[{userId:account,name:'Racer',score:10}],trackSummaries:[{trackId:track,updatedAt:123}]});if(u.pathname==='/v1/events/catalog')return Response.json({periods:[],archives:[]});if(u.pathname==='/v1/events/permanent-rolling-hills/snapshot')return new Response('',{status:404});throw Error('Unexpected source '+u.pathname);
 }});assert.notEqual(result.deferred,true);assert.equal(calls.includes('/v1/snapshot/track'),false);const board=JSON.parse(await fs.readFile(path.join(f.directory,'tracks',track+'.json')));assert.equal(board.entries[0].uploadId,2);assert.equal(board.entries[0].runVerified,false);
});
test('changed source bytes fail closed rather than falling back to stale Worker data',async t=>{
 const f=await fixture(t),p=path.join(f.directory,'tracks',track+'.json');await fs.appendFile(p,' ');const bytes=await fs.readFile(p);assert.throws(()=>f.source.validate(track,bytes),/bytes changed/);
});
test('incomplete or changed capture report is never authoritative',async t=>{
 const f=await fixture(t);await assert.rejects(openFullCanonicalTrackSource({directory:f.directory,report:{...f.report,complete:false}}),/report changed/);
 const p=path.join(f.directory,'full-canonical-capture.json'),report={...f.report,complete:false};await fs.writeFile(p,JSON.stringify(report));await assert.rejects(openFullCanonicalTrackSource({directory:f.directory,report}),/incomplete/);
});
test('missing board and row-total mismatch cannot create a source capability',async t=>{
 const f=await fixture(t);const p=path.join(f.directory,'manifest.json'),m=JSON.parse(await fs.readFile(p));m.fullCanonicalCapture.sourceRows=2;await fs.writeFile(p,JSON.stringify(m));await assert.rejects(openFullCanonicalTrackSource({directory:f.directory,report:f.report}),/manifest/);
});

test('a held prior result remains held after faster replacement; source PB dates stay exact',async t=>{const f=await fixture(t,{held:true});const b=f.source.validate(track,await fs.readFile(path.join(f.directory,'tracks',track+'.json')));assert.equal(b.entries[0].reviewHold,true);assert.equal(b.entries[0].runVerified,false);assert.equal(b.entries[0].pbAt,f.row.pbAt);assert.equal(b.entries[0].updatedAt,f.row.updatedAt);});
