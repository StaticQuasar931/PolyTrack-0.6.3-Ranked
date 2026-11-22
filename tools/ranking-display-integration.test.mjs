import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
import * as policy from './ranking-display-policy.mjs';import {stampClientRelease} from './site-release.mjs';
const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8').replace(/\r\n?/g,'\n');
function fn(name){const a=source.indexOf('  function '+name+'(');assert(a>=0,name);const b=source.indexOf('\n  }',a);assert(b>a,name);return source.slice(a,b+4);}
const clock=Date.UTC(2026,10,16);class Clock extends Date{static now(){return clock;}}
function harness(category,rows=[]){
 const context=vm.createContext({rankingDisplayPolicy:policy,overallCategory:category,overallRankingScope:'total',overallCompletionScope:'all',
  overallEntriesCache:rows,overallFirstPreview:false,MIN_RANKED_TRACKS:3,AVERAGE_PLACEMENT_VERSION:2,personalFilterRuntime:null,
  Date:Clock,attachLocalRankingSidecars:rows=>rows,currentLocalOverallResult:()=>null,rankedFilterResult:null,
  searchRankingRows:rows=>rows,completedTrackCount:row=>row.raceCount,sortedEventEntries:()=>[],
  annotateCategoryRanks:(rows,key)=>rows.map((r,i)=>({...r,globalRank:r.rank,categoryRank:i+1,rankKey:key})),
  rankingMetricFor:(row,requestedCategory=category)=>{const field={field:'fieldPoints',wins:'trackWins',casual:'casualRp',average:'averagePlacement'}[requestedCategory];return {known:row.metricKnown!==false&&typeof row[field]==='number'&&Number.isFinite(row[field]),value:row[field]};},
  improvedRacerScore:row=>row.improvement,risingRacerScore:row=>row.rising,
  compareRankedMetrics:(a,b,as,bs)=>Number(bs.known)-Number(as.known)||(as.known?bs.value-as.value:0)||a.rank-b.rank});
 vm.runInContext(['scopedPodiumCategory','rankingCostValue','rankingDisplayMetricState','filterRankingDisplayRows','formatRankingFieldRp','sortedOverallEntries','currentLeaderboardCount'].map(fn).join('\n'),context);
 return context;
}
test('actual sorted categories filter zero/missing counts before assigning ranks and counting pages',()=>{
 const cases={medals:{medals:{bronze:1}},tracks:{raceCount:4},official:{officialCount:2},community:{communityCount:2},
  weight:{weightedTracks:2},wins:{trackWins:2},podiumRate:{podiumRate:2},pbs:{pbCount:2},playtime:{totalPlaytimeMs:1000},
  veterans:{accountCreatedAt:clock-10000},average:{averagePlacement:2,averagePlacementVersion:2},
  competitiveAverage:{competitiveAveragePlacement:2,competitiveAverageEligibleTracks:3},improved:{improvement:2},rising:{rising:2},
  field:{fieldPoints:1234.56},casual:{casualRp:100}};
 for(const [category,values]of Object.entries(cases)){
  const zero={userId:'zero',rank:1,raceCount:3,medals:{gold:0,silver:0,bronze:0},officialCount:0,communityCount:0,weightedTracks:0,trackWins:0,
   podiumRate:0,pbCount:0,totalPlaytimeMs:0,accountCreatedAt:0,averagePlacement:0,competitiveAveragePlacement:0,competitiveAverageEligibleTracks:0,
   improvement:0,rising:0,fieldPoints:0,casualRp:0};if(category==='tracks')zero.raceCount=0;
  const good={userId:'good',rank:20,raceCount:3,score:20,...values};
  const missing={userId:'missing',rank:2,...(category==='tracks'?{}:{raceCount:3})};
  const h=harness(category,[zero,missing,good]),result=h.sortedOverallEntries();
  assert.deepEqual(Array.from(result,r=>[r.userId,r.categoryRank]),[['good',1]],category);assert.equal(h.currentLeaderboardCount(),1,category);
  h.rankedFilterResult={available:true,filter:{category},rows:[zero,good]};assert.equal(h.currentLeaderboardCount(),1,category+' cached filtered count');
 }
});
test('actual cost ranking preserves sampled perfect zero, excludes absent costs and empty samples',()=>{
 for(const [category,field]of [['overall','score'],['skill','skillCost'],['consistency','consistencyCost']]){
  const h=harness(category,[{userId:'empty',rank:1,raceCount:0,[field]:0},{userId:'missing',rank:2,raceCount:3},
   {userId:'perfect',rank:8,raceCount:3,[field]:0},{userId:'positive',rank:9,raceCount:3,[field]:10}]);
  assert.deepEqual(Array.from(h.sortedOverallEntries(),r=>[r.userId,r.categoryRank]),[['perfect',1],['positive',2]],category);
  assert.equal(h.currentLeaderboardCount(),2);
 }
});
test('scoped metrics honor unknown/zero state rather than stale global counters',()=>{
 const h=harness('wins',[{userId:'stale',rank:1,raceCount:3,trackWins:5,metricKnown:false},{userId:'valid',rank:2,raceCount:3,trackWins:1}]);
 assert.deepEqual(Array.from(h.sortedOverallEntries(),r=>r.userId),['valid']);
});
test('policy is loaded once outside per-row functions and late resolution refreshes without losing entries',async()=>{
 let resolve,imports=0,renders=0;const pending=new Promise(r=>{resolve=r;});
 const h=vm.createContext({rankingDisplayPolicy:null,rankingDisplayPolicyRequest:null,rankingDisplayPolicyFailed:false,
  loaded:()=>{imports++;return pending;},isElementVisible:()=>true,document:{getElementById:()=>({})},renderEntries:()=>{renders++;},overallEntriesCache:[1],overallLoadState:{}});
 vm.runInContext(fn('loadRankingDisplayPolicy').replace(/import\('\.\/tools\/ranking-display-policy\.mjs\?v=\d+'\)/,'loaded()'),h);
 const first=h.loadRankingDisplayPolicy();assert.equal(h.loadRankingDisplayPolicy(),first);assert.equal(imports,1);
 resolve(policy);await first;assert.equal(renders,1);assert.equal(h.rankingDisplayPolicy,policy);
 const render=fn('renderEntries');assert(render.indexOf('overallEntriesCache = overlaySnapshotRacerDirectory')<render.indexOf('if(!rankingDisplayPolicy'));
 for(const name of ['renderEntryRow','sortedOverallEntries','filterRankingDisplayRows','topTrackRowsForScope'])assert(!fn(name).includes('import('),name);
});
test('actual normalizer preserves genuine zero costs and never manufactures missing skill/consistency',()=>{
 const h=vm.createContext({rankingCostValue:rankingValue,safeServerNumber:rankingValue,MIN_RANKED_TRACKS:3,TOTAL_TRACKS:10,SERVER_COSMETIC_UNLOCK_IDS:new Set(),SHOP_COSMETIC_UNLOCK_IDS:new Set(),
  normalizeCarColorId:()=>'',extractCarId:()=>'',normalizeFinishSummary:v=>v,fallbackMedals:r=>r.medals||{},fallbackAverageFinish:()=>0,fallbackPodiumRate:()=>0,
  sanitizeServerAchievements:()=>null,sanitizeProfileCosmetics:()=>null,__pt062NormalizeStyle:()=>'',__pt062GetRememberedStyle:()=>''});
 function rankingValue(v){return typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null;}
 vm.runInContext(fn('normalizeEntries'),h);
 const result=h.normalizeEntries([{score:0,skillCost:0,consistencyCost:0,raceCount:3,accountCreatedAt:clock-1},{raceCount:3},{score:5,raceCount:'3'}]);
 assert.deepEqual([result[0].score,result[0].skillCost,result[0].consistencyCost],[0,0,0]);
 const rolling='fb769ac2ea77e8f19a21a9dd3071742f2342bd49c41e4748d7e8c7903d4f0778';
 const [track]=h.normalizeEntries([{raceCount:3,officialCount:2,communityCount:0,customCount:0,resultSamples:[{trackId:rolling}],bestTracks:[{trackId:rolling}]}]);
 assert.deepEqual([track.officialCount,track.communityCount,track.raceCount],[2,1,3]);
 assert.equal(h.normalizeEntries([track])[0].communityCount,1);
 assert.equal(result[1].score,null);assert.equal(result[1].skillCost,null);assert.equal(result[1].consistencyCost,null);assert.equal(result[2].raceCount,0);
});
test('actual Field display hook groups whole integers while preserving numeric sorting value',()=>{
 const h=harness('field',[{userId:'a',rank:1,raceCount:3,fieldPoints:1234.56}]);assert.equal(h.formatRankingFieldRp(1234.56),'1,235');
 assert.match(fn('renderEntryRow'),/overallCategory==='field'\?formatRankingFieldRp\(categoryValue\)/);
 assert.match(fn('renderEntryRow'),/const score = rankingCostValue\(row\?\.score\)\?\?1\.000001/);
});
test('actual wins highlight largest fields first, deterministic ties, no fabricated lead tenure',()=>{
 const wins=[{trackId:'z',rank:1,fieldSize:25},{trackId:'b',rank:1,fieldSize:12345,snapshotCapturedAt:1},{trackId:'a',rank:1,fieldSize:12345,snapshotCapturedAt:2}];
 const original=JSON.stringify(wins);const h=vm.createContext({overallCategory:'wins',overallRankingScope:'total',normalizedFinishSamples:()=>wins,
  medalForRank:(rank,field)=>rank===1&&field>=5?'gold':null,trackInfo:id=>({name:id,type:'community'}),eligibleWinCount:()=>3,escapeHtml:String,ROLLING_HILLS_ID:'rhr'});
 vm.runInContext(fn('scopedPodiumCategory')+'\n'+fn('categoryTrackMarkup'),h);const markup=h.categoryTrackMarkup({});
 assert(markup.indexOf('data-track-id="a"')<markup.indexOf('data-track-id="b"'));assert(!markup.includes('data-track-id="z"'));
 assert.match(markup,/Largest winning field/);assert.match(markup,/Another win/);assert.match(markup,/#1 of 12,345/);
 assert.doesNotMatch(markup,/lead|since|tenure|snapshotCapturedAt/i);assert.equal(JSON.stringify(wins),original);
});
test('new sidecar literal is stamped for release without changing snapshot pointer or scoring assets',()=>{
 const stamped=stampClientRelease(source,'<script src="polytrack_062_patch.js?v=414"></script>',415);
 assert.match(stamped.patch,/import\('\.\/tools\/ranking-display-policy\.mjs\?v=415'\)/);
 assert.equal((source.match(/import\('\.\/tools\/ranking-display-policy\.mjs/g)||[]).length,1);
});

test('Workshop reads only an exact published Overall rank from the saved snapshot',()=>{
  const getter=source.match(/getPublishedRank:(id=>{[^}]+})/)[1];
  const h=vm.createContext({cleanUserId:id=>String(id).trim(),readOverallSnapshotCache:()=>saved});
  let saved=null;
  const get=vm.runInContext(getter,h);
  assert.equal(get('racer'),null);
  saved={ranksExact:false,entries:[{userId:'racer',rank:1}]};
  assert.equal(get('racer'),null);
  saved={ranksExact:true,entries:[{accountId:' racer ',rank:14},{userId:'provisional',rank:0}]};
  assert.equal(get('racer'),14);
  assert.equal(get('missing'),null);
  assert.equal(get('provisional'),0);
});
