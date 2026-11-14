import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {buildAchievementProgress,renderAchievementJournal} from './achievement-journal.mjs';

const patch = fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const catalogText = patch.match(/const PROFILE_COSMETIC_OPTIONS=(\{[\s\S]*?\n  \});/)[1];
const cosmetics = JSON.parse(JSON.stringify(vm.runInNewContext(`(${catalogText})`)));
const profile = {raceCount:8,pbCount:10,totalPlaytimeMs:3600000,extraCount:1,trackWins:0,rank:8,badges:{betaTester:false},cosmeticUnlocks:[]};

test('catalog goals cover every real non-starter cosmetic without copying catalog values', () => {
  const model = buildAchievementProgress({cosmetics});
  const expected = Object.values(cosmetics).flat().filter(([id,,requirement]) => requirement !== 0 && requirement !== 'communityCode' && !String(requirement).startsWith('shop:') && !['auto','none'].includes(id)).length;
  assert.equal(model.milestones.reduce((sum,item) => sum + item.rewards.length,0),expected);
  assert.equal(model.counts.earned,0);
  assert.ok(model.milestones.every(item => item.value === null));
  assert.deepEqual(model.branches.map(branch => branch.id),['titles','style','discovery']);
});

test('catalog decisions match existing cosmeticUnlocked semantics for confirmed profiles', () => {
  const source = patch.match(/  function cosmeticUnlocked\([^\n]*\)\{[\s\S]*?\n  \}/)[0];
  const unlocked = vm.runInNewContext(`${source};cosmeticUnlocked`,{localExtraTrackCount:() => 0});
  for (const confirmed of [{},profile,{...profile,raceCount:16,pbCount:50,totalPlaytimeMs:18000000,extraCount:3,trackWins:5,rank:2,badges:{betaTester:true},cosmeticUnlocks:['emblem:target','stripe:overdrive']}]) {
    for (const item of buildAchievementProgress({cosmetics,progress:{confirmed}}).milestones) assert.equal(item.earned,unlocked(item.requirement,confirmed),item.id);
  }
});

test('local milestones never grant server rewards, including owner-beat cosmetics', () => {
  const model = buildAchievementProgress({cosmetics,progress:{confirmed:{...profile,extraCount:0},local:{pbCount:100,extraCount:25,trackWins:25,eventParticipations:10,practiceFinishes:100,verifiedTracks:25,totalPlaytimeMs:36000000}}});
  assert.ok(model.milestones.filter(item => item.source === 'local').every(item => item.rewards.length === 0));
  assert.equal(model.milestones.find(item => item.id === 'discovery:extra:1').earned,false);
  assert.equal(model.milestones.find(item => item.unlockId === 'stripe:overdrive').earned,false);
  assert.equal(model.milestones.find(item => item.unlockId === 'emblem:target').earned,false);
  assert.equal(model.counts.earned,model.counts.confirmed + model.counts.local);
  assert.equal(model.branches.length,5);
  assert.equal(model.milestones.find(item => item.id === 'local:eventParticipations:10').earned,true);
});

test('unknown, invalid and absent counts do not fabricate event or practice branches', () => {
  for (const value of [undefined,null,'10',NaN,Infinity,-1,0.5,{},true]) {
    assert.equal(buildAchievementProgress({progress:{local:{eventParticipations:value,practiceFinishes:value}}}).branches.length,0);
  }
  assert.equal(buildAchievementProgress({progress:{local:{eventParticipations:0}}}).branches[0].milestones.length,4);
});

test('next chooses only the next unearned tier in each family lane', () => {
  const model = buildAchievementProgress({cosmetics,progress:{confirmed:profile,local:{eventParticipations:5}}});
  assert.ok(model.nextIds.includes('local:eventParticipations:10'));
  assert.ok(!model.nextIds.includes('local:eventParticipations:25'));
  assert.ok(!model.nextIds.some(id => model.milestones.find(item => item.id === id).earned));
  const next = model.milestones.filter(item => model.nextIds.includes(item.id) && item.metric === 'raceCount' && item.family === 'style');
  assert.equal(next.length,1); assert.equal(next[0].target,12);
  assert.ok(!model.nextIds.some(id => model.milestones.find(item => item.id === id).metric === 'beta'));
  assert.equal(model.milestones.filter(item => model.nextIds.includes(item.id) && item.metric === 'unlock').length,1);
  assert.equal(model.milestones.find(item => item.unlockId === 'emblem:target').value,null);
});

test('pure builder leaves inputs unchanged and rendering escapes untrusted text', () => {
  const input = {cosmetics:{theme:[['evil','<img src=x onerror=alert(1)>',1]]},progress:{confirmed:profile}};
  const before = JSON.stringify(input);
  const html = renderAchievementJournal({...input,idPrefix:'" onmouseover="bad'});
  assert.equal(JSON.stringify(input),before);
  assert.ok(!html.includes('<img')); assert.ok(html.includes('&lt;img'));
  assert.match(html,/Your progress/); assert.match(html,/Listed cosmetic goals require confirmation; personal milestones here award no cosmetics or Tokens\./);
  assert.ok(!html.includes('JOURNAL ONLY')); assert.ok(!html.includes('Existing server rules'));
});

test('only current authoritative unlock IDs qualify, not a count or a stale proof record', () => {
  const model = buildAchievementProgress({cosmetics,progress:{confirmed:{serverAchievements:{beatOwner:{count:3,unlocks:[{cosmeticId:'stripe:overdrive'}]}}}}});
  assert.equal(model.milestones.find(item => item.unlockId === 'stripe:overdrive').earned,false);
  assert.equal(model.milestones.find(item => item.unlockId === 'stripe:overdrive').value,3);
});

test('empty state and unsupported requirements remain honest', () => {
  assert.deepEqual(buildAchievementProgress().counts,{earned:0,total:0,confirmed:0,local:0});
  assert.equal(buildAchievementProgress({cosmetics:{theme:[['x','Unknown','future:10']]}}).milestones.length,0);
  assert.match(renderAchievementJournal(),/No progress yet/);
});

test('player-facing goals use natural grammar and rewards use friendly category labels', () => {
  const model = buildAchievementProgress({cosmetics,progress:{local:{practiceFinishes:1,eventParticipations:1,totalPlaytimeMs:3600000}}});
  assert.equal(model.milestones.find(item => item.id === 'discovery:extra:1').goal,'Finish 1 ranked Extra Track');
  assert.equal(model.milestones.find(item => item.id === 'style:wins:1').goal,'Earn 1 verified first-place finish');
  assert.equal(model.milestones.find(item => item.id === 'style:playtime:3600000').goal,'1h active playtime');
  assert.equal(model.milestones.find(item => item.id === 'local:practiceFinishes:1').goal,'1 practice finish');
  assert.equal(model.milestones.find(item => item.id === 'local:practiceFinishes:10').goal,'10 practice finishes');
  const html = renderAchievementJournal({cosmetics,progress:{local:{practiceFinishes:1}}});
  for (const raw of ['(nameFont)','(emblemBackdrop)','(stageTint)','Preview ','Journal milestone / no reward']) assert.ok(!html.includes(raw),raw);
  for (const text of ['Achievements','Earn styles as you race.','View reward:','Background color','Name font','Emblem background','Personal milestone','Saved on this device']) assert.ok(html.includes(text),text);
});

test('purchased shop designs are not racing goals or spendable achievement awards',()=>{
 const model=buildAchievementProgress({cosmetics,progress:{confirmed:{...profile,cosmeticUnlocks:['plate:pitlane-ticket','stage:apex-observatory','stripe:vector-ribbon']}}});
 assert.ok(model.milestones.every(item=>!String(item.requirement).startsWith('shop:')));
 assert.doesNotMatch(renderAchievementJournal({model}),/Claim Tokens|earned Tokens|wallet balance|reward points/i);
});

test('journal caption distinguishes listed cosmetic goals from personal tiers without extending Tokens rewards',()=>{
 const html=renderAchievementJournal({progress:{local:{pbCount:1}},cosmetics:{}});
 assert.match(html,/Listed cosmetic goals require confirmation; personal milestones here award no cosmetics or Tokens\./);
 assert.doesNotMatch(html,/Cosmetics become available when your progress is confirmed\./);
});

test('expanded details show exact goals and actual catalog rewards without proposing currency', () => {
  const html = renderAchievementJournal({cosmetics:{theme:[['test-theme','Exact theme label',3]]},progress:{confirmed:{raceCount:1},local:{practiceFinishes:2}}});
  assert.match(html,/Actual rewards: 1 cosmetic choice/);
  assert.match(html,/View reward: Exact theme label/);
  assert.match(html,/Current progress: 1<br>Goal: 3/);
  assert.match(html,/<details class="aj-more" open><summary>How it counts/);
  assert.match(html,/No cosmetic reward or Tokens\./);
  assert.doesNotMatch(html,/rewardPoints|proposal-only|Claim Tokens|\+\d+ Tokens/);
});
