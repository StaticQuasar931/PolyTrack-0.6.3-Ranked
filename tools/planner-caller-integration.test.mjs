import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {orderPlannerRoutes, minimumBenefitTarget} from './planner-route-model.mjs';
import {buildPlannerSnapshotInput} from './planner-snapshot-input.mjs';
import {practiceAdvice} from './practice-history.mjs';
const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const harnessSource=fs.readFileSync(new URL('./planner-filters.test.mjs',import.meta.url),'utf8');
const harnessText=harnessSource.slice(harnessSource.indexOf('function harness('),harnessSource.indexOf('const finishes='));
const baseHarness=new Function('source','vm','rhr',harnessText+';return harness;')(source,vm,'permanent');
function extract(name){
  const start=source.search(new RegExp('^ *(?:async )?function '+name+'\\(','m'));assert.ok(start>=0,name);
  const tail=source.slice(start);
  for(const match of tail.matchAll(/^ *}[^\n]*$/gm)){
    const candidate=tail.slice(0,match.index+match[0].length);
    try{new vm.Script(candidate);return candidate;}catch(error){if(!(error instanceof SyntaxError))throw error;}
  }
  assert.fail(name);
}
function harness(){
  const {context:c}=baseHarness(false,false);
  c.PINNED_EXTRA_TRACK_IDS=new Set();c.rankedWeightTitle=()=>'';c.formatRaceTime=String;
  c.profileGuideCache=new Map();
  for(const name of ['rankedTrackWeightParts','rankedTrackWeight','knownFinishWeight','rankedPlacementCost','medianNumber',
    'projectedOverallScore','projectedFinish','recommendationSimulator','recommendationAction',
    'rivalRecommendationAction','matchupPersonalAction','orderedPlannerRoutes','guideTrackCard',
    'routeBenefitPercent','plannerEase','helpfulThresholdText','worthwhileStart','plannerDefenseAllowed','plannerCategoryAvailability',
    'cachedProfileGuideMarkup'])vm.runInContext(extract(name),c);
  return c;
}
const entry={userId:'self',name:'Me',raceCount:3};
const render=(c,...display)=>c.profileGuideMarkup(entry,null,true,...(display.length?display:[[],[],[]]));

test('caller uses scored lanes even when the normal profile contains extra pending rows',async()=>{
  const c=harness();await c.loadProfileSnapshotResults('self');
  const profile=c.plannerPublishedProfiles.get('self').profile;
  const finishes=profile.results.map(row=>({...row}));
  profile.results.push({trackId:'pending-normal',rank:4,fieldSize:100,timeMs:9000,weight:9});
  c.plannerScoringIndex={epoch:0,updatedAt:1000,profiles:new Map([['self',finishes]]),fields:c.overallTrackSummariesCache,
    boards:new Map()};
  const input=c.plannerProfileInput(entry);
  assert.equal(input.complete,true);assert.equal(input.finishes.length,3);
  assert.ok(input.played.includes('pending-normal'));assert.ok(!input.finishes.some(f=>f.trackId==='pending-normal'));
  c.readPublicSnapshotBackup=()=>{throw Error('Scored lanes must not read normal boards');};
  assert.equal(await c.readPlannerPackageBoard('not-scored'),null);
});
test('embedded model and isolated snapshot IIFE match the owned modules with no imports',()=>{
  const model=fs.readFileSync(new URL('./planner-route-model.mjs',import.meta.url),'utf8').replace(/\r\n/g,'\n')
    .replace(/^export \{[^\n]+\n/m,'').replace(/\bexport /g,'').replace(/\bpositive\b/g,'plannerPositive')
    .replace(/\bcount\b/g,'plannerCount').replace(/\bclamp\b/g,'plannerClamp').replace(/\brouteKey\b/g,'plannerRouteKey');
  assert.ok(source.includes(model));
  const block=source.slice(source.indexOf('// BEGIN PLANNER MODEL'),source.indexOf('// END PLANNER MODEL'));
  assert.doesNotMatch(block,/\b(?:import|export)\s+(?:\{|function|async|const)/);
  assert.match(block,/const buildPlannerSnapshotInput=\(\(\)=>\{/);
  const c=vm.createContext({});vm.runInContext(block,c);
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(buildPlannerSnapshotInput())',c)),buildPlannerSnapshotInput());
});
test('actual recommendation action uses weakest positive-benefit rank for new and played tracks',()=>{
  const c=harness(),baseline=['official','community','permanent'].map(trackId=>({trackId,rank:5,fieldSize:20,timeMs:20000,weight:3}));
  for(const sort of ['practice','impact','ease','training','benefit-ease']){
    c.plannerSort=sort;
    for(const finish of [{trackId:'new',rank:0,fieldSize:20,weight:3},baseline[0]]){
      const action=c.recommendationAction(finish,finish.rank?'improve':'start',entry,baseline);
      const baselineScore=c.projectedOverallScore(baseline),scoreAt=c.recommendationSimulator(baseline,finish);
      const expected=minimumBenefitTarget({currentRank:finish.rank,fieldSize:finish.fieldSize+(finish.rank?0:1),baselineScore,scoreAt});
      assert.ok(action&&action.targetRank>1);
      assert.equal(action.targetRank,expected.targetRank);assert.equal(action.value,baselineScore-scoreAt(action.targetRank));
      if(action.targetRank<action.fieldSize&&(!finish.rank||action.targetRank+1<finish.rank))
        assert.ok(baselineScore-scoreAt(action.targetRank+1)<=.0005);
    }
  }
});
test('full caller ignores display cache, warmed page fields and result order',async()=>{
  const c=harness(),before=await render(c);
  const record=c.plannerPublishedProfiles.get('self');
  record.profile.results.reverse();
  c.trackSnapshotStore=()=>{throw Error('planner read a browsed cache');};
  const falseDisplay=[{trackId:'new',rank:1,fieldSize:1000,timeMs:1,weight:999,cachedAt:999999}];
  const after=await render(c,falseDisplay,falseDisplay,falseDisplay);
  assert.equal(after,before);
  assert.doesNotMatch(after,/Estimate from loaded standings/);
  assert.match(after,/First finish: aim for #[2-9]/);
});
test('cache key excludes browsed standings versions but includes actual local generation',async()=>{
  const c=harness();await c.loadProfileSnapshotResults('self');
  c.trackSnapshotStore=()=>{throw Error('cache key read visited track pages');};
  const a=await c.cachedProfileGuideMarkup(entry,null,true,[],[],[],()=>true),size=c.profileGuideCache.size;
  const b=await c.cachedProfileGuideMarkup(entry,null,true,[{trackId:'bogus'}],[],[],()=>true);
  assert.equal(a,b);assert.equal(c.profileGuideCache.size,size);
  c.localRaceGeneration++;await c.cachedProfileGuideMarkup(entry,null,true,[],[],[],()=>true);
  assert.equal(c.profileGuideCache.size,size+1);
});
test('published source remains frozen when display hydration replaces the saved profile',async()=>{
  const c=harness();await c.loadProfileSnapshotResults('self');
  const before=JSON.stringify(c.plannerProfileInput(entry));
  c.profileSnapshotResults=new Map([['self',{results:[{trackId:'new',rank:1,fieldSize:2,weight:999}]}]]);
  assert.equal(JSON.stringify(c.plannerProfileInput(entry)),before);
});
test('all played boards use the package reader and partial fields stay unknown',async()=>{
  const c=harness(),reads=[];
  c.readPublicSnapshotBackup=async(kind,id)=>{
    assert.equal(kind,'track');reads.push(id);
    return {trackId:id,complete:false,totalEntries:50,entries:[{accountId:'self',timeMs:1}]};
  };
  c.trackSnapshotStore=()=>{throw Error('warmed cache used');};
  await render(c);
  assert.deepEqual(reads,['community','official','permanent']);
  const routes=c.plannerPracticePlans.get('self').routes;
  assert.ok(routes.every(route=>route.simulationComplete));
  await render(c);assert.equal(reads.length,3,'static board reads coalesce across recalculation');
});
test('account, package and genuine local-PB changes cancel in-flight plan publication',async()=>{
  for(const change of ['account','epoch','local']){
    const c=harness();let finish,reads=0;
    const gate=new Promise(resolve=>finish=resolve);
    c.readPublicSnapshotBackup=()=>{reads++;return gate;};
    const pending=render(c);
    for(let turn=0;turn<20&&!reads;turn++)await Promise.resolve();
    assert.ok(reads>0);
    if(change==='account')c.activeRankedAccountId=()=> 'other';
    if(change==='epoch')c.profileSnapshotEpoch++;
    if(change==='local')c.localRaceGeneration++;
    finish(null);
    assert.equal(await pending,'');assert.equal(c.plannerPracticePlans.size,0);
  }
});
test('unplaced local PB blocks a new-track recommendation without becoming awarded placement',async()=>{
  const c=harness();
  c.readLocalRaceRows=()=>[{accountId:'self',trackId:'new',timeMs:10000,pbAt:Date.now()-1000}];
  const html=await render(c),input=c.plannerProfileInput(entry);
  assert.equal(input.localPBs[0].rank,null);assert.equal(input.finishes.some(row=>row.trackId==='new'),false);
  assert.doesNotMatch(html,/First finish: aim/);
});
test('practice options forwards validated finished routes without invoking a planner recursively',()=>{
  const c=harness();c.practiceHistory={list:()=>[],coverage:()=>null,observeBest(){}};
  c.plannerPracticePlans.set('self',{epoch:0,localGeneration:0,metric:'overall',routes:[{trackId:'new',value:1,simulationComplete:true,targetRank:7}]});
  vm.runInContext(extract('practiceProfileOptions'),c);
  const options=c.practiceProfileOptions('self',[]);
  assert.equal(options.plannerRoutes[0].targetRank,7);
  c.localRaceGeneration++;assert.equal(c.practiceProfileOptions('self',[]).plannerRoutes.length,0);
});
test('practice advice in actual route enrichment receives track identity and real local PB evidence',async()=>{
  const c=harness(),at=Date.now();
  c.practiceAdviceFor=practiceAdvice;
  c.practiceHistory={get:()=>({attempts:10,activeMs:120000,lastPlayedAt:at-10*86400000,finishes:4,bestMs:20000}),coverage:()=>null};
  c.readLocalRaceRows=()=>[{accountId:'self',trackId:'official',timeMs:19000,pbAt:at-86400000}];
  const seen=[];c.guideTrackCard=action=>{seen.push(action);return '<button>route</button>';};
  await render(c);
  assert.doesNotMatch(seen.find(row=>row.trackId==='official').practice.text,/baseline run/);
  assert.equal(seen.find(row=>row.trackId==='official').ease.known,false,'pending PB cannot borrow an old gap');
});
