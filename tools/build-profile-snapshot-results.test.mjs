import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {buildProfileSnapshotResults} from './build-profile-snapshot-results.mjs';

const accountId='a'.repeat(64),trackId='b'.repeat(64);
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'profile-results-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(path.join(root,'tracks'));await fs.writeFile(path.join(root,'overall.json'),JSON.stringify({updatedAt:100,entries:[{userId:accountId,raceCount:1}]}));return root;}
test('all saved board results are indexed without replays or private identity fields',async t=>{
  const root=await fixture(t);
  await fs.writeFile(path.join(root,'tracks',trackId+'.json'),JSON.stringify({trackId,updatedAt:90,complete:true,entries:[{accountId,timeMs:123,rank:1,weight:2,ownerUid:'private',replay:'not needed'}]}));
  const stats=await buildProfileSnapshotResults(root);assert.equal(stats.results,1);
  const value=JSON.parse(await fs.readFile(path.join(root,'profile-results',accountId+'.json')));
  assert.equal(value.results[0].fieldSize,1);assert.equal(value.results[0].weight,2);assert.equal(value.expectedEligibleTracks,1);
  assert.equal(value.results[0].ownerUid,undefined);assert.equal(value.results[0].replay,undefined);
});
test('newer canonical PB does not borrow a placement from an older board time',async t=>{
  const root=await fixture(t);
  await fs.writeFile(path.join(root,'tracks',trackId+'.json'),JSON.stringify({trackId,entries:[{accountId,timeMs:200,rank:2,fieldSize:10}]}));
  await fs.mkdir(path.join(root,'canonical',trackId),{recursive:true});
  await fs.writeFile(path.join(root,'canonical',trackId,accountId+'.json'),JSON.stringify({accountId,trackId,timeMs:100,runVerified:true}));
  await buildProfileSnapshotResults(root);
  const value=JSON.parse(await fs.readFile(path.join(root,'profile-results',accountId+'.json')));
  assert.equal(value.results[0].timeMs,100);assert.equal(value.results[0].rank,null);assert.equal(value.results[0].fieldSize,null);
});
test('mismatched board identity is rejected',async t=>{
  const root=await fixture(t);await fs.writeFile(path.join(root,'tracks',trackId+'.json'),JSON.stringify({trackId:accountId,entries:[]}));
  await assert.rejects(buildProfileSnapshotResults(root),/Invalid captured track/);
});
