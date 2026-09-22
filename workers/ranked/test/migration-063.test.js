import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {trackWeightParts} from '../src/index.js';
import {hasAcceptedVerifiedProof,VERIFIER_ENGINE_DIGEST,VERIFIER_VERSION} from '../src/verification.js';
const root=new URL('../../../',import.meta.url);
const tracks=JSON.parse(fs.readFileSync(new URL('tracks/catalog.json',root))).tracks;
test('Rolling Hills has a permanent official-baseline weight without changing other catalog weights',()=>{
 assert.equal(tracks.length,88);assert.equal(new Set(tracks.map(t=>t.id)).size,88);
 const official=tracks.find(t=>t.type==='official'),rolling=tracks.find(t=>t.name==='Rolling Hills Racer'),community=tracks.find(t=>t.type==='community'&&t.id!==rolling.id);
 assert.equal(trackWeightParts(rolling.id,10).type,'permanent');
 assert.equal(trackWeightParts(rolling.id,10).base,1.6);
 assert.equal(trackWeightParts(community.id,10).type,'community');
 assert.equal(trackWeightParts(community.id,10).base,1);
 assert.equal(trackWeightParts(official.id,10).base,1.6);
 for(const track of tracks){assert.ok(fs.existsSync(new URL(track.trackUrl,root)),track.name);assert.ok(fs.existsSync(new URL(track.thumbnail,root)),track.name);const expected=track.id===rolling.id?trackWeightParts(official.id,10):trackWeightParts(track.type==='official'?official.id:community.id,10);assert.equal(trackWeightParts(track.id,10).finalWeight,expected.finalWeight,track.name);}
});
test('retired Asguardia preserves its regular community weight rather than becoming custom',()=>{
 const old='5aafb733c264d51b09beedc7bd7eabb5e65bdded338980fcb14ae5ce36955572';
 const community=tracks.find(t=>t.type==='community'&&t.name!=='Rolling Hills Racer');
 assert.equal(trackWeightParts(old,10).finalWeight,trackWeightParts(community.id,10).finalWeight);
 assert.ok(!tracks.some(t=>t.id===old));
});
test('the previously deployed exact verification proof remains valid, not a client verified flag',()=>{
 const prior='32bfe32b8680597d9f1322dbcbb19242be38bee9ab243a379f5e449c3f4030fd';
 const row={accountId:'racer',trackId:'a'.repeat(64),timeMs:21000,frames:21000,uploadId:1,replayHash:'b'.repeat(64)};
 const proof={status:'verified',engineDigest:prior,verifierVersion:VERIFIER_VERSION,key:JSON.stringify([VERIFIER_VERSION,prior,row.accountId,row.trackId,21000,21000,1,row.replayHash])};
 assert.notEqual(prior,VERIFIER_ENGINE_DIGEST);assert.equal(hasAcceptedVerifiedProof(row,proof),true);
 assert.equal(hasAcceptedVerifiedProof({...row,timeMs:20999},proof),false);assert.equal(hasAcceptedVerifiedProof(row,{verified:true}),false);
});
test('migration preserves cloud collection names and current native event isolation',()=>{
 const patch=fs.readFileSync(new URL('polytrack_062_patch.js',root),'utf8');
 for(const name of ['0.6.2_race_results','0.6.2_profiles_public','0.6.2_s1_leaderboards_track','0.6.2_s1_leaderboards_overall','0.6.2_event_public'])assert.ok(patch.includes(name));
 const bundle=fs.readFileSync(new URL('main.bundle.js',root),'utf8');assert.ok(bundle.includes('let e="polytrack_v5_";return e+="prod_",e'));assert.ok(bundle.includes('eventRace?null:E.getRecord(g,i.getId())'));
});
