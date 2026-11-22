import test from 'node:test';
import assert from 'node:assert/strict';
import {countNewSnapshotRacers,countNewSnapshotResults} from './snapshot-update-additions.mjs';
const id=n=>n.toString(16).padStart(64,'0');
test('positive additions do not count reorders, cosmetics, or net off a removed account',()=>{
  const row=userId=>({userId});
  assert.equal(countNewSnapshotRacers([row(id(1)),row(id(2))],[{...row(id(2)),rank:1},row(id(4))]),1);
  const run=(accountId,uploadId,timeMs=1000)=>({accountId,uploadId,timeMs,replayHash:id(uploadId)});
  const saved=run(id(1),4);
  assert.equal(countNewSnapshotResults([saved,run(id(2),5)],[{...saved,name:'New',rank:2},run(id(2),6,990)]),1);
  assert.throws(()=>countNewSnapshotResults([],[saved,saved]),/Duplicate/);
});
