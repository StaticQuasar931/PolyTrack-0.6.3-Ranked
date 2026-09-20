import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalPromotion} from '../src/event-canonical.js';
const run={accountId:'a'.repeat(64),ownerUid:'owner',trackId:'b'.repeat(64),runId:'c'.repeat(64),
  timeMs:20000,replay:'exact-controls',replayHash:'d'.repeat(64),carStyle:'new-style',name:'Racer',receivedAt:2000};
const profile={pbCount:7,totalPlaytimeMs:5000,latestPbAt:3000,accountCreatedAt:100,name:'Profile',nickname:'Profile',carStyle:'profile-style'};
const marker={__eventServerTimestamp:true};
test('new canonical PB uses compatible timestamps and profile stats, never public approval fields',()=>{
  const {fields,profileFields}=canonicalPromotion({...run,proof:'forged',verified:true,timingVersion:9},null,profile,4000,marker);
  assert.equal(fields.createdAt,2000);assert.equal(fields.pbAt,2000);assert.equal(fields.accountCreatedAt,100);
  assert.equal(fields.pbCount,8);assert.equal(profileFields.pbCount,8);assert.equal(profileFields.latestPbAt,3000);
  assert.equal(fields.replay,run.replay);assert.equal(fields.replayHash,run.replayHash);assert.equal(fields.frames,fields.timeMs);
  assert.equal(fields.ingestedAt,marker);assert.equal(fields.verified,false);assert.equal(fields.verifiedState,0);
  for(const key of ['proof','eventRunId','timingVersion','verificationKey'])assert.ok(!(key in fields));
});
test('masked promotion preserves account metadata and never lowers accepted stats',()=>{
  const canonical={accountCreatedAt:{__firestoreTimestamp:'precise'},pbCount:12,totalPlaytimeMs:9000,
    metadata:{untouched:true},name:'Old',nickname:'Old',countryCode:'US',carColors:'colors'};
  const before=structuredClone(canonical);
  const {fields,profileFields}=canonicalPromotion(run,canonical,profile,4000,marker);
  assert.deepEqual(canonical,before);
  assert.ok(!('accountCreatedAt'in fields));assert.ok(!('metadata'in fields));assert.ok(!('carColors'in fields));
  assert.equal(fields.pbCount,13);assert.equal(profileFields.pbCount,13);
  assert.equal(fields.totalPlaytimeMs,9000);assert.equal(profileFields.totalPlaytimeMs,9000);
});
test('empty native style inherits real stored style without fabricating approval or recording data',()=>{
  const result=canonicalPromotion({...run,carStyle:''},null,profile,4000,marker);
  assert.equal(result.fields.carStyle,'profile-style');assert.equal(result.fields.replay,run.replay);
});
test('PB count and playtime respect existing schema maxima',()=>{
  const {fields,profileFields}=canonicalPromotion(run,{pbCount:1000000,totalPlaytimeMs:315576000000},profile,4000,marker);
  assert.equal(fields.pbCount,1000000);assert.equal(profileFields.pbCount,1000000);
  assert.equal(fields.totalPlaytimeMs,315576000000);
});
