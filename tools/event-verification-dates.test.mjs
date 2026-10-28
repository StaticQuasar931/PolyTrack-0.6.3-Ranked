import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {publicEventBackup,publicEventReplayBackup,runPublicSnapshotBackup} from './public-snapshot-backup.mjs';
const period={id:'w_20261019',kind:'weekly',trackId:'a'.repeat(64),startsAt:100,endsAt:200,graceMs:100,maxRp:500,targetMs:23};
const entry={accountId:'b'.repeat(64),name:'Racer',timeMs:23,rp:400,rank:1,submittedAt:150};
const replay=deflateSync(Buffer.alloc(15)).toString('base64url'),replayHash=createHash('sha256').update(replay).digest('hex');
const payload={periodId:period.id,trackId:period.trackId,accountId:entry.accountId,runId:'c'.repeat(64),timeMs:23,frames:23,
  replay,replayHash,carStyle:'public',verifiedAt:250,verificationStatus:'verified',verified:true,eventRpEligible:true};
test('snapshot preserves source PB date and actual verdict date separately, not private proof',()=>{
  const board=publicEventBackup({period,updatedAt:300,entries:[{...entry,verifiedAt:250,checkedAt:299,proof:{secret:1}}]},period.id);
  assert.equal(board.entries[0].submittedAt,150);assert.equal(board.entries[0].verifiedAt,250);
  assert.equal(board.entries[0].checkedAt,undefined);assert.equal(board.entries[0].proof,undefined);
  const saved=publicEventReplayBackup(payload,{periodId:period.id,trackId:period.trackId,entry});
  assert.equal(saved.verifiedAt,250);assert.equal(saved.submittedAt,undefined);
});
test('missing or invalid dates are never synthesized from submission, capture or failed checkedAt',()=>{
  for(const bad of [undefined,null,0,-1,'250',NaN,Infinity]){
    const row=publicEventBackup({period,updatedAt:300,entries:[{...entry,verifiedAt:bad,checkedAt:299}]},period.id).entries[0];
    assert.equal(row.submittedAt,150);assert.equal(row.verifiedAt,undefined);
    const saved=publicEventReplayBackup({...payload,verifiedAt:bad},{periodId:period.id,trackId:period.trackId,entry});
    assert.equal(saved.verifiedAt,undefined);
  }
});
test('fresh and retained verified replay exports enrich verdict dates without refetching or approving pending runs',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'event-dates-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  let replayRequests=0,failReplay=false;
  const fetchImpl=async url=>{
    const pathname=new URL(url).pathname;
    if(pathname==='/v1/snapshot/track')return new Response('',{status:404});
    if(pathname.includes('/permanent-rolling-hills/'))return new Response('',{status:404});
    if(pathname.endsWith('/overall'))return Response.json({updatedAt:300,entries:[],trackSummaries:[],complete:true});
    if(pathname.endsWith('/catalog'))return Response.json({periods:[{...period,endsAt:Date.UTC(2100,0,1)}],archives:[]});
    if(pathname.includes('/replays/')){replayRequests++;return failReplay?new Response('',{status:404}):Response.json(payload);}
    return Response.json({period,updatedAt:300,archived:false,entries:[entry],pendingPlaybacks:[]});
  };
  for(let i=0;i<2;i++){
    await runPublicSnapshotBackup({directory,fetchImpl,trackIds:[],now:300+i,log:()=>{}});
    const board=JSON.parse(await fs.readFile(path.join(directory,'events',period.id+'.json'),'utf8'));
    assert.equal(board.entries[0].submittedAt,150);assert.equal(board.entries[0].verifiedAt,250);
    const saved=JSON.parse(await fs.readFile(path.join(directory,'event-replays',period.id,entry.accountId+'.json'),'utf8'));
    assert.equal(saved.verifiedAt,250);
  }
  assert.equal(replayRequests,1);
  const replayFile=path.join(directory,'event-replays',period.id,entry.accountId+'.json');
  const legacy=JSON.parse(await fs.readFile(replayFile,'utf8'));delete legacy.verifiedAt;
  await fs.writeFile(replayFile,JSON.stringify(legacy));
  const manifestPath=path.join(directory,'manifest.json');
  const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
  delete manifest.eventReplays[`event-replays/${period.id}/${entry.accountId}.json`].verdictDateCheckedAt;
  await fs.writeFile(manifestPath,JSON.stringify(manifest));
  failReplay=true;
  const retained=await runPublicSnapshotBackup({directory,fetchImpl,trackIds:[],now:302,log:()=>{}});
  assert(retained.eventReplays[`event-replays/${period.id}/${entry.accountId}.json`]);
  assert.equal(JSON.parse(await fs.readFile(replayFile,'utf8')).verifiedAt,undefined);
  failReplay=false;
  await runPublicSnapshotBackup({directory,fetchImpl,trackIds:[],now:303,log:()=>{}});
  assert.equal(JSON.parse(await fs.readFile(replayFile,'utf8')).verifiedAt,250);
  assert.equal(replayRequests,3,'missing live metadata is repaired; present metadata costs no extra read');
  assert.throws(()=>publicEventReplayBackup({...payload,verificationStatus:'waiting',verified:false,eventRpEligible:false},
    {periodId:period.id,trackId:period.trackId,entry}),/Invalid or unbound/);
});
