import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {scoreFieldRp} from './field-rp.mjs';
const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
function fn(name){const start=source.indexOf('  function '+name+'(');assert.ok(start>=0,name);return source.slice(start,source.indexOf('\n  }',start)+4);}
const finish={trackId:'track',rank:1,fieldSize:250,weight:4,competition:1,timeMs:100,pbAt:0};
function harness(){
  const c=vm.createContext({fieldRpModule:{scoreFieldRp},overallCategory:'field',overallRankingScope:'total',
    overallEntriesCache:[],attachLocalRankingSidecars:rows=>rows,personalFilterRuntime:null,
    trackSnapshotStore(){throw Error('Normal-board access forbidden');},
    TRACK_CATALOG:new Map(),LEGACY_TRACK_CATALOG:new Map(),ROLLING_HILLS_ID:'rhr',rankedMetricState:()=>({known:false,value:null})});
  vm.runInContext(fn('rankingMetricFor')+'\n'+fn('sortedOverallEntries'),c);return c;
}
test('actual patch uses complete scoring tuples, not normal boards, sidecars, summaries or grouped data',()=>{
  const c=harness(),entry={raceCount:1,resultSamples:[finish]};
  assert.equal(c.rankingMetricFor(entry).value,scoreFieldRp([finish],{complete:true,expectedCount:1}).points);
  for(const bad of [{raceCount:2,resultSamples:[finish]},{raceCount:1,bestTracks:[finish]},
    {...entry,groupResults:[finish]},{...entry,localOnly:true},
    {...entry,resultSamples:[{...finish,weight:null}]},{...entry,resultSamples:[{...finish,timeMs:0}]},
    {...entry,resultSamples:[{...finish,pending:true}]},
    {raceCount:1,localRankingFinishes:[{...finish,projectedRank:1}]}])assert.equal(c.rankingMetricFor(bad).known,false);
  c.fieldRpModule=null;assert.equal(c.rankingMetricFor(entry).known,false);
});
test('actual category sort is descending, stable ties share rank, missing scores stay unranked',()=>{
  const c=harness();c.overallEntriesCache=[
    {userId:'missing',rank:1,raceCount:2,resultSamples:[finish]},
    {userId:'b',rank:2,raceCount:1,resultSamples:[finish]},
    {userId:'a',rank:3,raceCount:1,resultSamples:[finish]},
    {userId:'last',rank:4,raceCount:1,resultSamples:[{...finish,rank:250}]}];
  const rows=c.sortedOverallEntries();
  assert.deepEqual(Array.from(rows,r=>[r.userId,r.categoryRank]),[['a',1],['b',1],['last',3],['missing',null]]);
  assert.equal(rows[0].globalRank,3);assert.equal(c.overallEntriesCache[0].rank,1);
});
test('lazy import coalesces and does not repaint a different current category',async()=>{
  let resolve;const loaded=new Promise(r=>resolve=r),renders=[];
  const c=vm.createContext({fieldRpModule:null,fieldRpModuleRequest:null,overallCategory:'field',
    loaded,document:{getElementById:()=>({})},isElementVisible:()=>true,
    renderEntries:(...args)=>renders.push(args),overallEntriesCache:[],overallLoadState:{}});
  vm.runInContext(fn('loadFieldRpModule').replace(/import\('\.\/tools\/field-rp\.mjs[^']*'\)/,'loaded'),c);
  const request=c.loadFieldRpModule();assert.equal(c.loadFieldRpModule(),request);
  c.overallCategory='overall';resolve({scoreFieldRp});await request;assert.equal(renders.length,0);
  assert.ok(c.fieldRpModule);assert.equal(c.fieldRpModuleRequest,null);
});
test('scope is mounted in footer-right, never the center; picker hides only legacy visibility',()=>{
  let removed=0,inserted=0;const c=vm.createContext({overallRankingScope:'total',rankingScopeMarkup:()=>'<scope>'});
  vm.runInContext(fn('syncOverallRankingScope'),c);
  c.syncOverallRankingScope({querySelector:selector=>selector==='#overallRankingScope'?{remove(){removed++;}}:
    selector==='.overall-footer-right'?{insertAdjacentHTML(where,html){assert.equal(html,'<scope>');inserted++;}}:assert.fail(selector)},'wins');
  assert.equal(removed,1);assert.equal(inserted,1);
  const picker=fn('openRankedCategoryMenu');
  for(const key of ['weight','rising','consistency']){
    assert.doesNotMatch(picker,new RegExp("'"+key+"'"));
    assert.match(source,new RegExp('<option value="'+key+'" hidden>'));
  }
  assert.match(picker,/'field'/);assert.match(fn('setOverallCategory'),/selected==='field'.*loadFieldRpModule/);
  assert.match(source,/playtime:'Active playtime',veterans:'Account age'/);
});
test('actual row groups RP values, keeps Casual whole, and renders unknown Field as N/A',()=>{
  const c=vm.createContext({Number,Date,Object,Math,MIN_RANKED_TRACKS:3,TOTAL_TRACKS:10,AVERAGE_PLACEMENT_VERSION:2,OVERALL_PAGE_SIZE:15,
    overallCategory:'casual',overallCompletionScope:'all',overallRankingScope:'total',escapeHtml:String,cleanUserId:String,safeDisplayName:v=>v,
    normalizeEntries:rows=>rows,normalizeCarColorId:()=>'',__pt062NormalizeStyle:()=>'',__pt062GetRememberedStyle:()=>'',categoryTrackMarkup:()=>'',
    activeRankedAccountId:()=>'',categoryContextMarkup:()=>'',completedTrackCount:()=>3,eligibleWinCount:()=>0,improvedRacerScore:()=>0,risingRacerScore:()=>0,
    rankingMetricFor:(_row,category)=>category==='field'?{known:false,value:null}:{known:true,value:12345.678},
    rpDecimals:()=>3,rankedWeightTitle:()=>'',LEADERBOARD_INFO:{},preciseDurationLabel:()=>'',
    compactParticipationMeta:()=>'',medalSummaryMarkup:()=>'',cosmeticTitleText:()=>'',profileBadgeMarkup:()=>'',racerCosmeticClasses:()=>'',carModelPreview:()=>'',countryFlagMarkup:()=>''});
  vm.runInContext(fn('formatRp')+'\n'+fn('renderEntryRow'),c);
  const entry={rank:1,userId:'a',name:'A',score:12345.678,raceCount:3,casualRp:12345.678,casualCompletionCount:3};
  assert.match(c.renderEntryRow(entry,0),/<div class="overall-score">12,346<\/div>/);
  c.overallCategory='overall';assert.match(c.renderEntryRow(entry,0),/<div class="overall-score">12,345.678<\/div>/);
  c.overallCategory='field';const html=c.renderEntryRow(entry,0);assert.match(html,/<div class="overall-score">N\/A<\/div>/);
  assert.match(html,/FIELD RP \(EXPERIMENTAL\)/);assert.match(html,/>N\/A<\/span>/);
});
