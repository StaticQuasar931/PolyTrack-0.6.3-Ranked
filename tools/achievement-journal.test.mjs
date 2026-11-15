import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {buildAchievementProgress,buildAchievementJournalModel,sortAchievementJournalItems,renderAchievementJournal} from './achievement-journal.mjs';

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
  assert.match(html,/Your progress/); assert.match(html,/Cosmetic goals unlock styles\. Eligible Style Coins sync when Shop opens\. Device-only stats do not award coins\./);
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
  assert.match(renderAchievementJournal(),/confirmed completion count not supplied/);
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
  for (const text of ['Achievements','Earn styles as you race.','View reward:','Background color','Name font','Emblem background','Device progress','Tracking only']) assert.ok(html.includes(text),text);
});

test('purchased shop designs are not racing goals or spendable achievement awards',()=>{
 const model=buildAchievementProgress({cosmetics,progress:{confirmed:{...profile,cosmeticUnlocks:['plate:pitlane-ticket','stage:apex-observatory','stripe:vector-ribbon']}}});
 assert.ok(model.milestones.every(item=>!String(item.requirement).startsWith('shop:')));
 assert.doesNotMatch(renderAchievementJournal({model}),/Claim Style Coins|earned Style Coins|wallet balance|reward points/i);
});

test('journal caption distinguishes listed cosmetic goals from personal tiers without extending Style Coins rewards',()=>{
 const html=renderAchievementJournal({progress:{local:{pbCount:1}},cosmetics:{}});
 assert.match(html,/Cosmetic goals unlock styles\. Eligible Style Coins sync when Shop opens\. Device-only stats do not award coins\./);
 assert.doesNotMatch(html,/Cosmetics become available when your progress is confirmed\./);
});

test('expanded details show exact goals and actual catalog rewards without proposing currency', () => {
  const html = renderAchievementJournal({cosmetics:{theme:[['test-theme','Exact theme label',3]]},progress:{confirmed:{raceCount:1},local:{practiceFinishes:2}}});
  assert.match(html,/Direct unlock: Theme: Exact theme label/);
  assert.match(html,/View reward: Exact theme label/);
  assert.match(html,/Current progress: 1<br>Goal: 3/);
  assert.match(html,/<details class="aj-more" open><summary>How it counts/);
  assert.match(html,/No unlock or Style Coins\./);
  assert.doesNotMatch(html,/rewardPoints|proposal-only|Claim Style Coins|\+\d+ Style Coins/);
});


test('rewarded journal excludes all proposal tiers and keeps exact local observations separate',()=>{
 const input={cosmetics,progress:{confirmed:{...profile,extraCount:0},local:{practiceFinishes:17,extraCount:25,historyVisits:10,teleportCount:100}}};
 const before=JSON.stringify(input),model=buildAchievementJournalModel(input);
 assert.ok(model.milestones.length>0);assert.ok(model.milestones.every(item=>item.source==='catalog'&&item.rewards.length>0||item.source==='currency'&&item.reward.amount>0&&!item.earned));
 assert.ok(!model.milestones.some(item=>item.id.startsWith('achievement:v1:')));
 assert.equal(model.counts.local,0);assert.equal(model.milestones.find(x=>x.id==='discovery:extra:1').earned,false);
 assert.deepEqual(model.observations,[{metric:'practiceFinishes',value:17},{metric:'extraCount',value:25}]);
 assert.equal(JSON.stringify(input),before);
 const html=renderAchievementJournal(input);assert.doesNotMatch(html,/cosmetic choice|Tokens|\bCP\b|teleportCount|historyVisits/);
 assert.match(html,/data-aj-sort/);assert.match(html,/aria-describedby=/);assert.match(html,/data-aj-reward-icon/);
 assert.match(html,/No unlock or Style Coins/);
});

test('sorting is stable, pure, unknown-last for progress, and counts actual unlocks only',()=>{
 const items=[{id:'a',goal:'Alpha',target:3,value:null,ratio:0,rewards:[{}]},{id:'b',goal:'Bravo',target:2,value:1,ratio:.5,rewards:[{},{}]},{id:'c',goal:'Charlie',target:1,value:1,ratio:1,rewards:[{}]}];
 const before=JSON.stringify(items);
 assert.deepEqual(sortAchievementJournalItems(items,'progress').map(x=>x.id),['c','b','a']);
 assert.deepEqual(sortAchievementJournalItems(items,'rewards').map(x=>x.id),['b','c','a']);
 assert.deepEqual(sortAchievementJournalItems(items,'name').map(x=>x.id),['a','b','c']);
 assert.deepEqual(sortAchievementJournalItems(items,'target').map(x=>x.id),['c','b','a']);
 assert.equal(JSON.stringify(items),before);
});


test('seven actual currency rows use confirmed casual completions, never infer claims or money from local progress',()=>{
 const model=buildAchievementJournalModel({progress:{confirmed:{casualCompletionCount:20},local:{casualCompletionCount:89,raceCount:89,teleportCount:100}}});
 const rows=model.milestones.filter(x=>x.source==='currency');assert.equal(rows.length,7);assert.equal(model.counts.earned,0);
 assert.ok(rows.every(x=>!x.earned&&x.value===20&&x.reward.currency==='Style Coins'));
 const html=renderAchievementJournal({model,family:'currency',filter:'all'});
 assert.match(html,/Eligible to check/);assert.match(html,/Open Shop/);assert.match(html,/Eligible rewards are collected when Shop opens/);
 assert.doesNotMatch(html,/already claimed|CLAIMED|coins earned|balanceAfter|wallet balance/i);
 assert.deepEqual(sortAchievementJournalItems(rows,'coins').map(x=>x.reward.amount),[60,50,50,40,30,30,20]);
});

test('eligible historical cosmetic achievements show exact coin bonuses without claiming a wallet grant',()=>{
 const model=buildAchievementJournalModel({cosmetics:{theme:[['ocean','Ocean',1],['ice','Ice',3]]},progress:{confirmed:{raceCount:3}}});
 const rows=model.milestones.filter(r=>r.source==='catalog');assert.deepEqual(rows.map(r=>r.coinReward.amount),[2,4]);assert.ok(rows.every(r=>r.earned));
 assert.deepEqual(sortAchievementJournalItems(rows,'coins').map(r=>r.coinReward.amount),[4,2]);
 const html=renderAchievementJournal({model,filter:'all',family:'style'});assert.match(html,/4 Style Coins/);assert.match(html,/eligible past achievements/);assert.match(html,/Check rewards in Shop/);
 assert.doesNotMatch(html,/coins claimed|balanceAfter|wallet balance|CLAIMED/);
});

test('all real tiers are discoverable by default and goals never masquerade as unlock counts',()=>{
 const model=buildAchievementJournalModel({cosmetics});
 const goals=model.milestones.filter(row=>row.source==='catalog');
 assert.equal(goals.length,24);
 assert.equal(goals.reduce((sum,row)=>sum+row.rewards.length,0),112);
 assert.equal(model.milestones.filter(row=>row.source==='currency').length,7);
 const ids=goals.flatMap(row=>row.rewards.map(reward=>reward.kind+':'+reward.id));
 assert.equal(new Set(ids).size,112);
 const html=renderAchievementJournal({cosmetics});
 assert.match(html,/24 cosmetic goals reached; 112 cosmetic unlocks across these goals; 7 coin milestones/);
 assert.match(html,/data-aj-active-family="all"/);
 assert.match(html,/data-aj-filter="all" aria-pressed="true"/);
 assert.equal((html.match(/data-aj-node="/g)||[]).length,31);
});
test('shared title and style bonuses remain one payment condition, not coins per cosmetic',()=>{
 const model=buildAchievementJournalModel({cosmetics,progress:{confirmed:{raceCount:5}}});
 const shared=model.milestones.filter(row=>row.coinReward?.id==='achievement-ranked-5');
 assert.equal(shared.length,2);assert.equal(new Set(shared.map(row=>row.coinReward.id)).size,1);
 const html=renderAchievementJournal({model});
 assert.match(html,/shared bonus/);assert.match(html,/Shared title[/]style bonus, paid once/);
 assert.match(html,/Cosmetic unlocked does not mean coins paid/);
});
