import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import * as field from './field-rp-planner.mjs';
const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
function fn(name){const a=source.search(new RegExp('^  (?:async )?function '+name+'\\(','m'));assert.ok(a>=0,name);return source.slice(a,source.indexOf('\n  }',a)+4);}
const finish=(trackId,fieldSize,weight)=>({trackId,rank:4,fieldSize,weight,timeMs:10000,competition:1,pbAt:0});
function harness(){
  const finishes=[finish('large',2000,10),finish('small',10,1)],index={epoch:0,fields:finishes,profiles:new Map([['me',finishes]]),boards:new Map(finishes.map(row=>[row.trackId,{trackId:row.trackId,fromScoring:true}]))};
  const c=vm.createContext({fieldRpPlannerModule:field,plannerScoringIndex:index,profileSnapshotEpoch:0,localRaceGeneration:0,
    activeRankedAccountId:()=> 'me',cleanUserId:String,overallCategory:'field',plannerMetric:'field',plannerSort:'impact',plannerCurrentTracksOnly:false,plannerOfficialOnly:false,
    PLANNER_METRICS:{overall:'Overall RP',field:'Field RP (experimental)',events:'Event RP'},personalFilterRuntime:null,
    loadFieldRpPlannerModule:async()=>field,loadPlannerScoringIndex:async()=>index,
    plannerTrackAllowed:trackId=>!c.plannerOfficialOnly||trackId==='large',
    plannerCategoryAvailability:()=>({overall:true,events:true,field:true}),plannerPracticePlans:new Map(),
    practiceHistory:{get:(_id,trackId)=>({trackId,factor:trackId==='small'?1.2:1}),coverage:()=>null},
    practiceAdviceFor:row=>({factor:row.factor}),plannerFilterMarkup:()=>'<span>Filters</span>',
    plannerEase:(_action,board)=>{assert.equal(board.fromScoring,true);return {effortScore:board.trackId==='small'?.1:2};},
    trackSnapshotStore(){throw Error('Normal-board access forbidden');},cachedProfileFinishes(){throw Error('Display cache forbidden');},
    trackInfo:trackId=>({name:trackId}),escapeHtml:String,trackThumbnailMarkup:()=>'',ageLabel:()=>'',rankedWeightTitle:()=>'',
    compactPlannerTargetLabel:row=>'#'+row.currentRank+' to #'+row.targetRank,rpDecimals:()=>3});
  vm.runInContext(['formatRp','fieldRpProfileSummary','categoryTrackMarkup','fieldRpPlannerControls',
    'routeBenefitPercent','guideTrackCard','fieldRpGuideMarkup','profileGuideMarkup'].map(fn).join('\n'),c);
  return {c,index,finishes,entry:{userId:'me',name:'Me',raceCount:2,resultSamples:finishes}};
}
test('real Field Next Moves path uses complete scoring fields and stable reference for five sorts and filters',async()=>{
  const {c,entry}=harness();let reference;
  for(const sort of ['impact','practice','ease','training','benefit-ease'])for(const official of [false,true]){
    c.plannerSort=sort;c.plannerOfficialOnly=official;
    const html=await c.profileGuideMarkup(entry,null,true,[],[],[]);
    assert.match(html,/Your next Field RP moves/);assert.match(html,/full-publication reference/);
    assert.match(html,/\+.*Field points/);
    const routes=c.plannerPracticePlans.get('me').routes;
    for(const row of routes){reference??=row.benefitReference;assert.equal(row.benefitReference,reference);assert.ok(row.value>0);}
    if(official)assert.ok(routes.every(row=>row.trackId==='large'));
  }
});
test('viewing rivals never fabricates a Field margin; group, partial and late results fail honestly',async()=>{
  const {c,entry}=harness();
  assert.match(await c.profileGuideMarkup({userId:'rival',raceCount:9},entry,false,[],[],[]),/no rival margin estimated/);
  assert.match(await c.profileGuideMarkup({...entry,raceCount:3},null,true,[],[],[]),/Complete matching scoring results/);
  c.personalFilterRuntime={active:()=>true,getFilter:()=>({mode:'smart'})};
  assert.match(await c.profileGuideMarkup(entry,null,true,[],[],[]),/Group-recalculated Field routes are unavailable/);
  c.personalFilterRuntime=null;let resolve;c.loadPlannerScoringIndex=()=>new Promise(r=>resolve=r);
  const request=c.profileGuideMarkup(entry,null,true,[],[],[]);c.plannerMetric='overall';resolve(c.plannerScoringIndex);
  assert.equal(await request,'');
});
test('Field ranking details remain while the three unwanted profile cards are absent',()=>{
 const {c,entry}=harness(),middle=c.categoryTrackMarkup(entry);
 assert.match(middle,/Strongest Field/);assert.match(middle,/Field boost/);assert.match(middle,/Field reduction/);
 assert.match(middle,/<em>\+/);assert.match(middle,/<em>-/);
 assert.doesNotMatch(source,/data-profile-field-results|function profileFieldRpCards|function ensureProfileFieldRp/);
 assert.match(source,/fieldRpGuideMarkup/);
});

test('real RP formatter caches exactly three precision formatters; formatting never changes numbers',()=>{
  const {c}=harness();
  assert.equal(c.formatRp(12345.678),'12,345.678');const cache=c.formatRp.formats;
  assert.deepEqual(Object.keys(cache),['2','3','4']);
  for(const precision of [2,3,4]){c.rpDecimals=()=>precision;assert.equal(c.formatRp(12345.678),Number(12345.678).toLocaleString('en-US',{minimumFractionDigits:precision,maximumFractionDigits:precision}));}
  assert.equal(c.formatRp.formats,cache);assert.equal(c.formatRp(null),'N/A');assert.equal(c.formatRp(Infinity),'N/A');
});
test('owner tie sanitizer retains every proof requirement while allowing exact tied milliseconds',()=>{
  const c=vm.createContext({SERVER_COSMETIC_UNLOCK_IDS:new Set(['emblem:target','stripe:overdrive']),safeServerInteger:value=>Number.isSafeInteger(value)&&value>0?value:null});
  vm.runInContext(fn('sanitizeServerAchievementProof'),c);
  const proof={id:'beat-owner-1',threshold:1,cosmeticId:'emblem:target',trackId:'track',source:'ranked-track-snapshot',sourceRevision:1,sourceUpdatedAt:2,
    sourceSignature:'abcdefghijklmnop',playerTimeMs:100,targetTimeMs:100,unlockedAt:3};
  assert.ok(c.sanitizeServerAchievementProof(proof));
  for(const changes of [{playerTimeMs:101},{sourceSignature:''},{sourceRevision:0},{source:'local'},{unlockedAt:0}])assert.equal(c.sanitizeServerAchievementProof({...proof,...changes}),null);
  assert.match(source,/Tie or beat StaticQuasar931/);
});
test('browser popup groups preserve requested order and arrow-key traversal',{timeout:30000},async t=>{
  const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();
  await page.route('**/*',route=>route.abort());await page.setContent('<button id="trigger">Rankings</button>');
  await page.addScriptTag({content:`let closeRankedCategoryMenu=null,overallCategory='overall';const LEADERBOARD_LABELS={},LEADERBOARD_INFO={};function setOverallCategory(){}${fn('openRankedCategoryMenu')};openRankedCategoryMenu(document.getElementById('trigger'));`});
  assert.deepEqual(await page.locator('.sq-category-popup > [role="presentation"]').evaluateAll(groups=>groups.map(group=>[...group.querySelectorAll('button')].map(b=>b.dataset.category))),
    [['overall','field','events','casual'],['topTracks','tracks','average','medals','wins']]);
  for(const category of ['field','events','casual','topTracks','tracks','average','medals','wins']){
    await page.keyboard.press('ArrowDown');assert.equal(await page.evaluate(()=>document.activeElement.dataset.category),category);
  }
  await page.keyboard.press('Home');assert.equal(await page.evaluate(()=>document.activeElement.dataset.category),'overall');
  await page.keyboard.press('Escape');assert.equal(await page.locator('.sq-category-popup').count(),0);
});
