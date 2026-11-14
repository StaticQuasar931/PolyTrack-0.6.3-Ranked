import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {buildAchievementGoals,ACHIEVEMENT_REWARD_PROPOSAL} from './achievement-model.mjs';

const goal=(metric,input={})=>buildAchievementGoals(input).find(item=>item.metric===metric);
const byId=goals=>Object.fromEntries(goals.map(item=>[item.id,item]));
const metrics=buildAchievementGoals().map(item=>item.metric);

test.beforeEach(t=>t.mock.method(globalThis,'fetch',()=>assert.fail('No network permitted')));

test('14 useful lanes contain 81 unique stable, navigable casual and advanced tiers',()=>{
  const goals=buildAchievementGoals();assert.equal(goals.length,14);
  assert.equal(goals.flatMap(item=>item.tiers).length,81);
  const ids=goals.flatMap(item=>[item.id,...item.tiers.map(tier=>tier.id)]);
  assert.equal(new Set(ids).size,ids.length);
  assert.deepEqual(new Set(goals.map(item=>item.family)),new Set(['daily','events','practice','discovery']));
  for(const item of goals){
    assert.match(item.id,/^achievement:v1:[a-z-]+$/);assert.ok(item.title&&item.description);
    assert.ok(['daily','events','practice','discovery'].includes(item.navigate));
    assert.ok(item.tiers.some(tier=>tier.difficulty==='casual'));assert.ok(item.tiers.some(tier=>tier.difficulty==='advanced'));
    assert.deepEqual(item.tiers.map(tier=>tier.target),[...new Set(item.tiers.map(tier=>tier.target))].sort((a,b)=>a-b));
    assert.equal(item.nextTierId,item.tiers[0].id);
    for(const tier of item.tiers){assert.equal(tier.id,item.id+':'+tier.target);assert.equal(tier.rewardKey,tier.id);}
  }
});

test('absent metrics are visible unknown goals rather than fabricated zeros',()=>{
  for(const item of buildAchievementGoals()){
    assert.equal(item.value,null);assert.equal(item.confirmedValue,null);assert.equal(item.localValue,null);
    assert.equal(item.source,'unknown');assert.ok(item.tiers.every(tier=>tier.status==='unknown'));
  }
});

test('exact zero is known in progress and is not replaced by device progress',()=>{
  const item=goal('pbImprovements',{confirmed:{pbImprovements:0},local:{pbImprovements:10}});
  assert.equal(item.value,0);assert.equal(item.confirmedValue,0);assert.equal(item.localValue,10);
  assert.equal(item.source,'confirmed');assert.deepEqual(item.tiers.map(tier=>tier.status),['device','device','device','in-progress','in-progress','in-progress']);
});

test('confirmed and local counters are never summed or promoted',()=>{
  const item=goal('practiceFinishes',{confirmed:{practiceFinishes:5},local:{practiceFinishes:7}});
  assert.equal(item.value,5);assert.equal(item.tiers[1].target,10);assert.equal(item.tiers[1].status,'in-progress');
  assert.equal(item.tiers[0].status,'confirmed');
  const saved=goal('practiceFinishes',{local:{practiceFinishes:25,verified:true}});
  assert.equal(saved.source,'device');assert.ok(saved.tiers.slice(0,3).every(tier=>tier.status==='device'));
  assert.ok(saved.tiers.every(tier=>tier.status!=='confirmed'&&!tier.claimable));
});

test('tier statuses distinguish confirmed progress from exact device milestones',()=>{
  const item=goal('pbImprovements',{confirmed:{pbImprovements:1},local:{pbImprovements:10}});
  assert.deepEqual(item.tiers.map(tier=>tier.status),['confirmed','device','device','in-progress','in-progress','in-progress']);
  assert.equal(item.nextTierId,item.tiers[3].id);
  assert.equal(goal('pbImprovements',{confirmed:{pbImprovements:100}}).nextTierId,null);
});

test('each proposed tier has precise inclusive threshold boundaries',()=>{
  for(const item of buildAchievementGoals())for(const tier of item.tiers){
    const below=goal(item.metric,{confirmed:{[item.metric]:tier.target-1}}).tiers.find(t=>t.id===tier.id);
    const at=goal(item.metric,{confirmed:{[item.metric]:tier.target}}).tiers.find(t=>t.id===tier.id);
    assert.equal(below.status,'in-progress',tier.id);assert.equal(at.status,'confirmed',tier.id);
    assert.equal(at.claimable,false,tier.id);
  }
});

test('invalid counters are unknown without coercion in either trust lane',()=>{
  for(const value of [undefined,null,'10','0',false,true,NaN,Infinity,-1,0.5,Number.MAX_SAFE_INTEGER+1,{},[],new Number(10)]){
    for(const source of ['confirmed','local']){
      const input={[source]:Object.fromEntries(metrics.map(metric=>[metric,value]))};
      assert.ok(buildAchievementGoals(input).every(item=>item.value===null&&item.source==='unknown'),String(value));
    }
  }
});

test('safe integers and negative zero are normalized without arithmetic overflow',()=>{
  for(const item of buildAchievementGoals({confirmed:Object.fromEntries(metrics.map(metric=>[metric,Number.MAX_SAFE_INTEGER]))})){
    assert.equal(item.value,Number.MAX_SAFE_INTEGER);assert.ok(item.tiers.every(t=>t.status==='confirmed'));
  }
  assert.equal(Object.is(goal('pbCount',{local:{pbCount:-0}}).value,-0),false);
});

test('counter accessors and inherited values are not evaluated or trusted',()=>{
  const local=Object.create({pbCount:100});Object.defineProperty(local,'extraCount',{get(){throw Error('Must not invoke metric accessor');}});
  assert.equal(goal('pbCount',{local}).value,null);assert.equal(goal('extraCount',{local}).value,null);
  assert.ok(buildAchievementGoals({confirmed:null,local:[]}).every(item=>item.value===null));
});

test('known confirmed data may advance or regress without stale earned flags',()=>{
  const done=goal('trackWins',{confirmed:{trackWins:12}}),now=goal('trackWins',{confirmed:{trackWins:0}});
  assert.ok(done.tiers.every(t=>t.status==='confirmed'));assert.ok(now.tiers.every(t=>t.status==='in-progress'));
});

test('IDs, tiers and proposal amounts are independent of source, order and cosmetics',()=>{
  const base=buildAchievementGoals(),input={confirmed:{pbCount:25,trackWins:3},local:{practiceFinishes:100},cosmetics:{theme:[['example','Example','pb:25']]}};
  const changed=byId(buildAchievementGoals(input));
  for(const item of base)assert.deepEqual(item.tiers.map(t=>[t.id,t.target,t.rewardKey,t.rewardPoints]),changed[item.id].tiers.map(t=>[t.id,t.target,t.rewardKey,t.rewardPoints]));
  assert.deepEqual(buildAchievementGoals({confirmed:{trackWins:3,pbCount:25},local:input.local}),buildAchievementGoals(input));
});

test('no activity, freshness, daily, event or improvement counters are guessed',()=>{
  const input={confirmed:{raceCount:100,pbCount:100,rank:1},local:{totalPlaytimeMs:999999999,history:Array(100).fill({finish:true}),dailyStreak:100,events:['one','two'],verified:true}};
  for(const metric of ['dailyCompletions','activeDays','eventParticipations','eventFormats','practiceFinishes','practiceTracks','pbImprovements','improvedTracks','pbTimeSavedMs','verifiedTracks'])assert.equal(goal(metric,input).value,null,metric);
});

test('time savings use only explicit integer milliseconds, never frames or playtime',()=>{
  const item=goal('pbTimeSavedMs',{local:{pbTimeSavedMs:500,framesSaved:100000,totalPlaytimeMs:36000000}});
  assert.equal(item.unit,'milliseconds');assert.equal(item.value,500);assert.equal(item.tiers[1].status,'device');assert.equal(item.tiers[2].status,'in-progress');
});

test('normal first places are not event wins, participation or currency',()=>{
  const input={confirmed:{trackWins:12,rank:1,eventRp:999999}};
  assert.ok(goal('trackWins',input).tiers.every(t=>t.status==='confirmed'));
  assert.equal(goal('eventParticipations',input).value,null);assert.equal(goal('eventFormats',input).value,null);
  assert.match(goal('trackWins',input).description,/not event wins or event RP/);
});

test('device-only verified track counts never establish new confirmed proof',()=>{
  const item=goal('verifiedTracks',{local:{verifiedTracks:50,verified:true,physicsVerified:true}});
  assert.equal(item.source,'device');assert.ok(item.tiers.every(t=>t.status==='device'&&!t.claimable));
});

test('proposal scale is modest, lifetime-only and non-spendable even for all thresholds',()=>{
  const proposal=ACHIEVEMENT_REWARD_PROPOSAL;assert.equal(proposal.status,'proposal-only');assert.equal(proposal.claimable,false);assert.equal(proposal.spendable,false);
  assert.deepEqual(proposal.referencePrices,{first:20,common:80,rare:240});assert.equal(proposal.referenceRecurringDailyCap,40);assert.equal(proposal.application,'alternative-not-additive');
  const goals=buildAchievementGoals({confirmed:Object.fromEntries(metrics.map(metric=>[metric,1000000]))});
  for(const item of goals){assert.equal(item.rewardStatus,'proposal-only');assert.equal(item.claimable,false);for(const tier of item.tiers){assert.equal(tier.rewardStatus,'proposal-only');assert.equal(tier.claimable,false);assert.ok(Number.isSafeInteger(tier.rewardPoints)&&tier.rewardPoints>=2&&tier.rewardPoints<=20);}}
  assert.equal(goals.flatMap(item=>item.tiers).reduce((n,t)=>n+t.rewardPoints,0),688);
});

test('repeated builds never create claims, duplicate reward keys or a wallet',()=>{
  const input={confirmed:{pbCount:100,balance:999999,awards:[{id:'fake',validated:true}]},local:{pbCount:100,wallet:{balance:999999}}};
  const a=buildAchievementGoals(input),b=buildAchievementGoals(input);assert.deepEqual(a,b);
  const keys=a.flatMap(item=>item.tiers.map(t=>t.rewardKey));assert.equal(new Set(keys).size,keys.length);
  for(const text of ['balance','wallet','claimId','awardedPoints','spendableBalance','validated'])assert.ok(!JSON.stringify(a).includes(text),text);
});

test('cosmetic unlock catalog is untouched and cannot be bypassed through local counters',()=>{
  const cosmetics={theme:[['locked','Locked','pb:25']],badge:[['beta','Beta','beta']]};const before=structuredClone(cosmetics);
  const a=buildAchievementGoals({local:{pbCount:1000,cosmeticUnlocks:['anything']},cosmetics});
  assert.deepEqual(cosmetics,before);assert.deepEqual(a,buildAchievementGoals({local:{pbCount:1000}}));
  assert.ok(!JSON.stringify(a).includes('unlocked'));
});

test('input state is immutable to this model and returned results are isolated',()=>{
  const confirmed=Object.freeze({pbCount:10}),local=Object.freeze({practiceFinishes:25});const input=Object.freeze({confirmed,local});
  const a=buildAchievementGoals(input);a[0].title='changed';a[0].tiers[0].rewardPoints=999;
  const b=buildAchievementGoals(input);assert.notEqual(b[0].title,'changed');assert.equal(b[0].tiers[0].rewardPoints,2);assert.deepEqual(confirmed,{pbCount:10});
});

test('unrelated PII and data payloads never appear in the normalized output',()=>{
  const input={confirmed:{pbCount:1,email:'private@example.invalid',accountId:'secret-account',replay:'PRIVATE_REPLAY',ownerUid:'PRIVATE_UID'},local:{practiceFinishes:1,trackCode:'PRIVATE_TRACK'}};
  const output=JSON.stringify(buildAchievementGoals(input));for(const secret of ['private@example','secret-account','PRIVATE_REPLAY','PRIVATE_UID','PRIVATE_TRACK'])assert.ok(!output.includes(secret));
});

test('model has no imports, database, storage, DOM, clock or network calls',()=>{
  const source=fs.readFileSync(new URL('./achievement-model.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/^import\s/m);assert.doesNotMatch(source,/\b(fetch|localStorage|sessionStorage|indexedDB|Firestore|document|window|Date\.now|Math\.random)\s*[.(]/);
});

import {aggregateAchievementPractice} from './achievement-model.mjs';
const practiceRow=(n,values={})=>({trackId:n.toString(16).padStart(64,'0'),finishes:0,pbs:0,improvedMs:0,...values});

test('practice helper aggregates exact retained counters without identities or guessed days',()=>{
 const rows=[practiceRow(1,{finishes:3,pbs:2,improvedMs:500,recentFinishes:[{at:1000}]}),practiceRow(2,{finishes:2,pbs:1,improvedMs:100}),practiceRow(3)];
 const before=structuredClone(rows),result=aggregateAchievementPractice(rows);
 assert.deepEqual(result,{practiceFinishes:5,practiceTracks:2,pbCount:3,pbImprovements:null,improvedTracks:2,pbTimeSavedMs:600});assert.deepEqual(rows,before);
 for(const key of ['trackId','accountId','activeDays','dailyCompletions','eventParticipations','eventFormats'])assert.ok(!Object.hasOwn(result,key));
 assert.equal(goal('practiceFinishes',{local:result}).value,5);
});

test('initial PB is not automatically an improvement, and one real gain is exact',()=>{
 assert.equal(aggregateAchievementPractice([practiceRow(1,{finishes:1,pbs:1,improvedMs:0})]).pbImprovements,0);
 assert.equal(aggregateAchievementPractice([practiceRow(1,{finishes:1,pbs:1,improvedMs:100})]).pbImprovements,1);
 assert.equal(aggregateAchievementPractice([practiceRow(1,{finishes:3,pbs:3,improvedMs:100})]).pbImprovements,null);
 assert.equal(aggregateAchievementPractice([practiceRow(1,{finishes:3,pbs:3,improvedMs:0})]).pbImprovements,0);
});

test('practice helper deduplicates identical rows and rejects conflicting track aliases',()=>{
 const row=practiceRow(1,{finishes:2,pbs:1,improvedMs:100});assert.equal(aggregateAchievementPractice([row,{...row}]).practiceFinishes,2);
 assert.ok(Object.values(aggregateAchievementPractice([row,{...row,finishes:3}])).every(value=>value===null));
});

test('practice unknowns and unsafe sums stay unknown, not partial totals',()=>{
 assert.deepEqual(aggregateAchievementPractice([]),{practiceFinishes:0,practiceTracks:0,pbCount:0,pbImprovements:0,improvedTracks:0,pbTimeSavedMs:0});
 for(const rows of [undefined,null,{},[{}],[practiceRow(1,{trackId:'invalid'})]])assert.ok(Object.values(aggregateAchievementPractice(rows)).every(value=>value===null));
 const result=aggregateAchievementPractice([practiceRow(1,{finishes:2}),practiceRow(2,{finishes:'bad'})]);assert.equal(result.practiceFinishes,null);assert.equal(result.practiceTracks,null);
 assert.equal(aggregateAchievementPractice([practiceRow(1,{finishes:Number.MAX_SAFE_INTEGER}),practiceRow(2,{finishes:1})]).practiceFinishes,null);
 assert.equal(aggregateAchievementPractice([practiceRow(1,{pbs:2,finishes:1})]).pbCount,null);
});
