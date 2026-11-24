import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {buildProfileSnapshotResults} from './build-profile-snapshot-results.mjs';

const accountId='a'.repeat(64),trackId='b'.repeat(64);
test('racer directory reuses newest public identity without replay or owner identifiers',async t=>{
  const root=await fixture(t);await fs.mkdir(path.join(root,'profiles'));
  await fs.writeFile(path.join(root,'overall.json'),JSON.stringify({updatedAt:100,entries:[{userId:accountId,name:'Old name',carColors:'old'}]}));
  await fs.writeFile(path.join(root,'profiles',accountId+'.json'),JSON.stringify({accountId,updatedAt:200,name:'New name',carColors:'new',profileCosmetics:{version:7,theme:'cyan',ownerUid:'private'},ownerUid:'private',replay:'private'}));
  await fs.writeFile(path.join(root,'tracks',trackId+'.json'),JSON.stringify({trackId,updatedAt:300,entries:[{accountId,name:'Oldest name',createdAt:50,timeMs:123}]}));
  await buildProfileSnapshotResults(root);
  const directory=JSON.parse(await fs.readFile(path.join(root,'racer-directory.json')));
  assert.equal(directory.entries[accountId].name,'New name');
  assert.equal(directory.entries[accountId].carColors,'new');
  assert.equal(directory.entries[accountId].ownerUid,undefined);
  assert.equal(directory.entries[accountId].replay,undefined);
  assert.equal(directory.entries[accountId].profileCosmetics.ownerUid,undefined);
  assert.equal(directory.updatedAt,200);
});
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

test('snapshot cosmetic directory contains public designs without profile identity or replay fields',async t=>{
  const root=await fixture(t);await fs.mkdir(path.join(root,'profiles'));
  const design={version:7,theme:'crimson',emblem2:'flag',nameFont:'racing'};
  await fs.writeFile(path.join(root,'profiles',accountId+'.json'),JSON.stringify({accountId,updatedAt:90,profileCosmetics:design}));
  await buildProfileSnapshotResults(root);
  const directory=JSON.parse(await fs.readFile(path.join(root,'cosmetic-directory.json')));
  assert.deepEqual(directory.entries[accountId],{at:90,value:design});
  assert.equal(directory.updatedAt,90);assert.equal(directory.entries[accountId].ownerUid,undefined);
});

test('profile results preserve per-track capture time and sanitized public status',async t=>{
  const root=await fixture(t);const status={cosmeticUnlocks:['stripe:apex'],serverAchievements:{casual:{count:3,rp:300}},badges:{betaTester:true},rankTier:'gold',rankSince:70};
  await fs.writeFile(path.join(root,'overall.json'),JSON.stringify({updatedAt:100,entries:[{userId:accountId,raceCount:1,...status}]}));
  await fs.mkdir(path.join(root,'profiles'));
  await fs.writeFile(path.join(root,'profiles',accountId+'.json'),JSON.stringify({accountId,updatedAt:90,profileCosmetics:{theme:'crimson'}}));
  await fs.writeFile(path.join(root,'manifest.json'),JSON.stringify({schemaVersion:1,tracks:{[trackId]:{checkedAt:95}}}));
  await fs.writeFile(path.join(root,'tracks',trackId+'.json'),JSON.stringify({trackId,updatedAt:85,complete:true,entries:[{accountId,timeMs:123,rank:1}]}));
  await buildProfileSnapshotResults(root);
  const value=JSON.parse(await fs.readFile(path.join(root,'profile-results',accountId+'.json')));
  assert.equal(value.results[0].cachedAt,85);assert.equal(value.results[0].snapshotCapturedAt,95);
  assert.deepEqual(Object.fromEntries(Object.keys(status).map(key=>[key,value.publicProfile[key]])),status);
});

test('profile results fall back to public overall cosmetics and status when profile export is absent',async t=>{
  const root=await fixture(t);const profileCosmetics={theme:'neon',emblem:'crown'};
  const status={cosmeticUnlocks:['theme:neon'],serverAchievements:{casual:{count:2,rp:200}},rankTier:'silver'};
  await fs.writeFile(path.join(root,'overall.json'),JSON.stringify({updatedAt:100,entries:[{userId:accountId,raceCount:1,profileCosmetics,...status}]}));
  await fs.writeFile(path.join(root,'tracks',trackId+'.json'),JSON.stringify({trackId,updatedAt:85,entries:[{accountId,timeMs:123,rank:1}]}));
  await buildProfileSnapshotResults(root);
  const profile=JSON.parse(await fs.readFile(path.join(root,'profile-results',accountId+'.json'))).publicProfile;
  assert.deepEqual(profile.profileCosmetics,profileCosmetics);
  for(const [key,value]of Object.entries(status))assert.deepEqual(profile[key],value);
  const directory=JSON.parse(await fs.readFile(path.join(root,'cosmetic-directory.json')));
  assert.deepEqual(directory.entries[accountId].value,profileCosmetics);
});

test('newer captured identity updates profile results and cosmetics without changing unrelated status',async t=>{
 const root=await fixture(t);await fs.mkdir(path.join(root,'profiles'));
 await fs.writeFile(path.join(root,'profiles',accountId+'.json'),JSON.stringify({accountId,updatedAt:100,name:'Old racer',profileCosmetics:{theme:'crimson'},badges:{betaTester:true}}));
 await fs.writeFile(path.join(root,'tracks',trackId+'.json'),JSON.stringify({trackId,updatedAt:999,entries:[{accountId,timeMs:123,identityUpdatedAt:200,name:'New racer',carColors:'new',profileCosmetics:{theme:'cyan',ownerUid:'private'}}]}));
 await buildProfileSnapshotResults(root);
 const profile=JSON.parse(await fs.readFile(path.join(root,'profile-results',accountId+'.json'))).publicProfile;
 assert.equal(profile.name,'New racer');assert.equal(profile.carColors,'new');assert.equal(profile.updatedAt,100);assert.equal(profile.identityUpdatedAt,200);assert.deepEqual(profile.badges,{betaTester:true});assert.deepEqual(profile.profileCosmetics,{theme:'cyan'});
 const cosmetics=JSON.parse(await fs.readFile(path.join(root,'cosmetic-directory.json')));assert.deepEqual(cosmetics.entries[accountId],{at:200,value:{theme:'cyan'}});
});
test('rebuilding a board does not overwrite a newer exported profile identity',async t=>{
 const root=await fixture(t);await fs.mkdir(path.join(root,'profiles'));
 await fs.writeFile(path.join(root,'profiles',accountId+'.json'),JSON.stringify({accountId,updatedAt:500,name:'Current racer',profileCosmetics:{theme:'cyan'}}));
 await fs.writeFile(path.join(root,'tracks',trackId+'.json'),JSON.stringify({trackId,updatedAt:999,entries:[{accountId,timeMs:123,identityUpdatedAt:100,name:'Old racer',profileCosmetics:{theme:'crimson'}}]}));
 await buildProfileSnapshotResults(root);const profile=JSON.parse(await fs.readFile(path.join(root,'profile-results',accountId+'.json'))).publicProfile;
 assert.equal(profile.name,'Current racer');assert.deepEqual(profile.profileCosmetics,{theme:'cyan'});
});

test('event-only identity stays public and never becomes a normal finish or Overall podium',async t=>{
  const root=await fixture(t),eventAccount='c'.repeat(64);
  await fs.mkdir(path.join(root,'events'));
  await fs.writeFile(path.join(root,'events','daily-test.json'),JSON.stringify({updatedAt:999,entries:[{accountId:eventAccount,name:'Event racer',carStyle:'event-car',identityUpdatedAt:250,rank:1,rp:90,events:2,ownerUid:'private',replay:'private'}]}));
  await fs.writeFile(path.join(root,'event-totals.json'),JSON.stringify({updatedAt:100,entries:[{accountId:eventAccount,name:'Older name',rank:7,rp:123,events:2}]}));
  const totalsPath=path.join(root,'event-totals.json'),original=await fs.readFile(totalsPath,'utf8');
  await buildProfileSnapshotResults(root,{retainPublishedEventTotals:true});
  assert.equal(await fs.readFile(totalsPath,'utf8'),original);
  await buildProfileSnapshotResults(root);
  const directory=JSON.parse(await fs.readFile(path.join(root,'racer-directory.json')));
  const identity=directory.entries[eventAccount];
  assert.equal(identity.name,'Event racer');assert.equal(identity.carStyle,'event-car');
  assert.equal(identity.ownerUid,undefined);assert.equal(identity.replay,undefined);
  assert.equal(identity.cosmeticContext.rank,0);assert.equal(identity.cosmeticContext.raceCount,0);
  const results=JSON.parse(await fs.readFile(path.join(root,'profile-results',eventAccount+'.json')));
  assert.deepEqual(results.results,[]);
  const totals=JSON.parse(await fs.readFile(path.join(root,'event-totals.json')));
  assert.deepEqual([totals.entries[0].rank,totals.entries[0].rp,totals.entries[0].events],[7,123,2]);
  assert.equal(totals.entries[0].carStyle,'event-car');
});
