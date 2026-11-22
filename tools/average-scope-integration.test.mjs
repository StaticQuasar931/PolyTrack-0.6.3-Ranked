import * as rankingDisplayPolicy from './ranking-display-policy.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {rankedMetricState,rankingScopeChoices,rankingScopeMarkup,SCOPED_AVERAGE_EXTRA_TRACK_IDS} from './ranking-scope-model.mjs';
import {EXTRA_TRACK_IDS} from '../workers/ranked/src/extra-track-ids.js';
const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
function fn(name){const a=source.indexOf('  function '+name+'(');assert.ok(a>=0,name);return source.slice(a,source.indexOf('\n  }',a)+4);}
const finish=(trackId,rank=2,fieldSize=10)=>({trackId,rank,fieldSize,weight:1,competition:1,timeMs:100,pbAt:0});
const options={category:'average',scope:'official',complete:true,officialTrackIds:['o'],communityTrackIds:['c'],extraTrackIds:['x']};
test('scoped model validates coverage, unique tracks and eligible populations; All remains published',()=>{
  const finishes=[finish('o',2),finish('c',4),finish('x',3),finish('small',1,4),finish('custom',1)];
  const entry={raceCount:5,averagePlacement:91.25,averagePlacementVersion:2};
  for(const [scope,value] of [['official',2],['community',4],['extra',3],['total',91.25]])
    assert.equal(rankedMetricState(entry,{...options,scope,finishes}).value,value);
  assert.equal(rankedMetricState(entry,{category:'average',scope:'total'}).value,91.25);
  for(const [row,changes] of [[entry,{complete:false}],[{...entry,raceCount:6},{}],
    [entry,{finishes:finishes.slice(0,4)}],[{raceCount:2},{finishes:[finish('o'),finish('o')]}],
    [{raceCount:1},{finishes:[finish('o',0)]}],[{raceCount:1},{finishes:[finish('o',2,1)]}],
    [{...entry,sourceComplete:false},{}],[{...entry,groupResults:finishes},{}],
    [{raceCount:1},{finishes:[{...finish('o'),pending:true}]}]])
    assert.equal(rankedMetricState(row,{...options,finishes,...changes}).known,false);
  for(const finishes of [[],[finish('o',1,4)],[finish('custom')]]){
    const state=rankedMetricState({raceCount:finishes.length},{...options,finishes});
    assert.equal(state.known,false);assert.equal(state.count,0);
  }
  assert.deepEqual(new Set(SCOPED_AVERAGE_EXTRA_TRACK_IDS),EXTRA_TRACK_IDS);
});
function harness(){
  const c=vm.createContext({rankingDisplayPolicy,overallCategory:'average',overallRankingScope:'official',averageScopeExtraIds:['x'],
    TRACK_CATALOG:new Map([['o',{id:'o',type:'official'}],['c',{id:'c',type:'community'}],['rhr',{id:'rhr',type:'community'}]]),
    LEGACY_TRACK_CATALOG:new Map(),ROLLING_HILLS_ID:'rhr',rankedMetricState,
    overallEntriesCache:[],attachLocalRankingSidecars:rows=>rows,personalFilterRuntime:null,MIN_RANKED_TRACKS:3,
    AVERAGE_PLACEMENT_VERSION:2,annotateCategoryRanks:rows=>rows,
    trackSnapshotStore(){throw Error('No normal boards');},overallRacerQuery:'',rankedFilterResult:null});
  vm.runInContext(['scopedPodiumCategory','rankingTrackInScope','rankingMetricFor','scopedAverageDetails','rankingDisplayMetricState','filterRankingDisplayRows','sortedOverallEntries'].map(fn).join('\n')+'\n'+fn('searchRankingRows'),c);return c;
}
test('actual patch scopes only complete resultSamples, sorts ascending with missing last, and searches selected metric',()=>{
  const c=harness();
  c.overallEntriesCache=[{userId:'missing',rank:1,raceCount:2,resultSamples:[finish('o')],averagePlacement:1},
    {userId:'slow',rank:2,raceCount:1,resultSamples:[finish('o',4)],averagePlacement:1},
    {userId:'fast',rank:3,raceCount:1,resultSamples:[finish('o',2)],averagePlacement:90}];
  assert.deepEqual(Array.from(c.sortedOverallEntries(),r=>[r.userId,r.categoryRank]),[['fast',1],['slow',2]]);
  c.overallRacerQuery='<3';assert.deepEqual(Array.from(c.searchRankingRows(c.overallEntriesCache),r=>r.userId),['fast']);
  c.averageScopeExtraIds=null;assert.equal(c.rankingMetricFor(c.overallEntriesCache[1]).known,false);
  c.overallRankingScope='total';assert.equal(c.rankingMetricFor({...c.overallEntriesCache[1],averagePlacementVersion:2}).value,1);
});
test('scoped average details exclude Rolling Hills from Official and include it in Community',()=>{
  const c=harness();const row={raceCount:3,resultSamples:[finish('o',2),finish('rhr',1),finish('c',4)]};
  assert.deepEqual(Array.from(c.scopedAverageDetails(row),f=>f.trackId),['o']);
  c.overallRankingScope='community';
  assert.deepEqual(Array.from(c.scopedAverageDetails(row),f=>f.trackId),['rhr','c']);
});
test('inline model functions stay byte-equivalent to the module',()=>{
  for(const fn of [rankedMetricState,rankingScopeMarkup])assert.ok(source.includes(fn.toString()),fn.name);
});
test('actual category change resets incompatible average scope without altering the introduction hook',()=>{
  const c=vm.createContext({overallCategory:'average',overallRankingScope:'extra',document:{getElementById:()=>({})},
    rankingScopeChoices,recordLeaderboardUse(){},refreshLeaderboardArcade(){},syncOverallTrackScope(){},syncCategorySelect(){},renderEntries(){},
    updateRankedFreshness(){},overallEntriesCache:[{}],overallPage:2});
  vm.runInContext(fn('setOverallCategory').replace(/    if\(\['field','casual','skill','competitiveAverage','medals'\].*\n/,''),c);
  c.setOverallCategory('wins');assert.equal(c.overallRankingScope,'total');
  c.overallCategory='average';c.overallRankingScope='community';c.setOverallCategory('casual');assert.equal(c.overallRankingScope,'total');
});
test('browser selector mounts Average and podium scopes in the footer',{timeout:30000},async t=>{
  const require=createRequire(new URL('./verifier/package.json',import.meta.url));
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});t.after(()=>browser.close());
  const page=await browser.newPage();await page.route('**/*',route=>route.abort());
  await page.setContent('<section id="panel"><div class="overall-center-tools"></div><div class="overall-footer-right"></div></section>');
  const start=source.indexOf("      const rankingScope=event.target.closest?.('[data-ranking-scope]');"),end=source.indexOf("      const scope=event.target.closest?.('[data-track-scope]');",start);
  await page.addScriptTag({content:`let overallCategory='average',overallRankingScope='total',overallPage=1;
    const panel=document.getElementById('panel');function renderEntries(){}function syncLocalOverallProjection(){}function loadAverageScopeSource(){}
    ${rankingScopeChoices.toString()}\n${rankingScopeMarkup.toString()}\n${fn('syncOverallRankingScope')}
    panel.addEventListener('click',event=>{${source.slice(start,end)}});syncOverallRankingScope(panel,'average');`});
  assert.equal(await page.locator('.overall-footer-right [data-ranking-scope]').count(),4);
  assert.equal(await page.locator('.overall-center-tools [data-ranking-scope]').count(),0);
  for(const scope of ['official','community','extra','total']){
    await page.locator(`[data-ranking-scope="${scope}"]`).click();
    assert.equal(await page.locator(`[data-ranking-scope="${scope}"]`).getAttribute('aria-pressed'),'true');
  }
  await page.evaluate(()=>syncOverallRankingScope(document.getElementById('panel'),'wins'));
  assert.equal(await page.locator('[data-ranking-scope]').count(),2);
  for(const category of ['medals','podiumRate']){
    await page.evaluate(category=>{overallCategory=category;syncOverallRankingScope(document.getElementById('panel'),category);},category);
    assert.deepEqual(await page.locator('[data-ranking-scope]').allTextContents(),['All','Official','Community']);
    await page.locator('[data-ranking-scope="community"]').click();
    assert.equal(await page.locator('[data-ranking-scope="community"]').getAttribute('aria-pressed'),'true');
  }
});

test('a delayed Casual intro does not open after Ranked closes',async()=>{
  const panel={visible:true};
  let resolve,shown=0;
  const pending=new Promise(r=>resolve=r);
  const c=vm.createContext({overallCategory:'overall',overallRankingScope:'total',overallPage:0,
    rankingScopeChoices,document:{getElementById:()=>panel},isElementVisible:p=>p.visible,loadIntro:()=>pending,
    LEADERBOARD_LABELS:{casual:'Casual RP'},LEADERBOARD_INFO:{casual:'Explanation'},recordLeaderboardUse(){},
    refreshLeaderboardArcade(){},syncOverallTrackScope(){},syncCategorySelect(){},renderEntries(){},updateRankedFreshness(){},
    overallEntriesCache:[{}]});
  const action=fn('setOverallCategory'),start=action.indexOf('import(new URL('),end=action.indexOf('.href)',start)+6;
  assert.ok(start>=0&&end>start);
  const categoryChange=action.slice(0,start)+'loadIntro()'+action.slice(end);
  vm.runInContext(categoryChange,c);
  c.setOverallCategory('casual');
  panel.visible=false;
  resolve({showRankingIntroduction:()=>shown++});
  await pending;
  assert.equal(shown,0);
  panel.visible=true;
  c.setOverallCategory('overall');
  c.setOverallCategory('casual');
  await pending;
  assert.equal(shown,1);
});
