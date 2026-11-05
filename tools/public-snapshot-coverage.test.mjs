import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runPublicSnapshotBackup,PUBLIC_SNAPSHOT_LIMITS} from './public-snapshot-backup.mjs';
import {updatePublicSnapshot} from './update-public-snapshot.mjs';
import {PERMANENT_ROLLING_HILLS} from '../workers/ranked/src/permanent-rolling-hills.js';

for (const count of [119,122]) test(`event coverage reports every budget-deferred board for ${count} live periods`,async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'capture-event-coverage-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.writeFile(path.join(root,'index.html'),'<html><head></head></html>');
  const trackId='a'.repeat(64),periods=Array.from({length:count},(_,i)=>({id:'daily_'+i,
    kind:'daily',trackId,startsAt:100,endsAt:100000}));
  let requests=0,boardRequests=0;
  const result=await updatePublicSnapshot({root,log:()=>{},capture:options=>runPublicSnapshotBackup({...options,
    now:1000,trackIds:[],trackFetchLimit:0,
    capturedOverall:{updatedAt:300,entries:[],trackSummaries:[],complete:true,totalEntries:0},
    fetchImpl:async input=>{
      requests++;const url=new URL(input);
      if(url.pathname==='/v1/events/catalog')return Response.json({periods,archives:[]});
      const id=/^\/v1\/events\/([^/]+)\/snapshot$/.exec(url.pathname)?.[1];
      assert.ok(id,'only catalog and bounded event reads are allowed');boardRequests++;
      return Response.json({id,updatedAt:300,entries:[],complete:true,totalEntries:0,
        period:periods.find(p=>p.id===id)??{id:PERMANENT_ROLLING_HILLS.id,kind:'permanent',
          trackId:PERMANENT_ROLLING_HILLS.trackId,startsAt:0,endsAt:8640000000000000}});
    }})});
  assert.equal(result.deferred,false);
  const directory=path.join(root,'local-reports','snapshot-staging');
  const manifest=JSON.parse(await fs.readFile(path.join(directory,'manifest.json'),'utf8'));
  const coverage=JSON.parse(await fs.readFile(path.join(directory,'coverage.json'),'utf8'));
  const deferred=Math.max(0,count+1-PUBLIC_SNAPSHOT_LIMITS.eventFetches);
  assert.equal(manifest.eventsMissing,deferred);
  assert.equal(manifest.eventsDeferred,deferred);
  assert.equal(manifest.selectedEventIds.length,count+1);
  assert.equal(coverage.backup.eventsKnown,count+1);
  assert.equal(coverage.backup.eventsMissing,deferred);
  assert.equal(boardRequests,Math.min(count+1,PUBLIC_SNAPSHOT_LIMITS.eventFetches));
  assert.equal(requests,1+boardRequests);
});