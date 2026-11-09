import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createSnapshotMetadataRecovery} from './snapshot-metadata-recovery.mjs';
const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const A='a'.repeat(64),B='b'.repeat(64);
function extract(name){
  const start=source.search(new RegExp('^ *(?:async )?function '+name+'\\(','m'));
  assert.ok(start>=0,name);
  const tail=source.slice(start);
  for(const match of tail.matchAll(/^ *}[^\n]*$/gm)){
    const candidate=tail.slice(0,match.index+match[0].length);
    try{new vm.Script(candidate);return candidate;}catch(error){if(!(error instanceof SyntaxError))throw error;}
  }
  assert.fail('No complete function: '+name);
}

function context(extra={}){
  const c=vm.createContext({snapshotTrackStatistics:{},overallTrackSummariesCache:[],overallLoadState:{serverUpdatedAt:100},
    trackInfo:()=>({type:'community'}),cachedTrackWeight:()=>7,applyPersonalFilters:rows=>({rows}),...extra});
  vm.runInContext(extract('hydratePlannerTrackSummaries')+'\n'+extract('plannerUnplayedField'),c);
  return c;
}
const statistic=(extra={})=>({complete:true,count:12,players:12,totalEntries:12,weight:4,updatedAt:100,...extra});
const plain=value=>JSON.parse(JSON.stringify(value));

test('statistics hydrate complete known-weight fields only, independently of global coverage',()=>{
  const c=context();
  for(const invalid of [{complete:false},{weight:null},{weight:0},{weight:NaN},{weight:'4'},{players:1,count:1,totalEntries:1},
    {players:12.5},{count:11},{totalEntries:13},{updatedAt:null},{updatedAt:-1}]){
    assert.equal(c.hydratePlannerTrackSummaries([],{[A]:statistic(invalid)}).length,0,JSON.stringify(invalid));
  }
  assert.equal(c.hydratePlannerTrackSummaries([],{invalid:statistic()}).length,0);
  const rows=c.hydratePlannerTrackSummaries([],{[A]:statistic(),[B]:statistic({complete:false})});
  assert.deepEqual(plain(rows),[{trackId:A,type:'community',fieldSize:12,weight:4,updatedAt:100,_plannerStatistics:true}]);
  assert.equal(c.hydratePlannerTrackSummaries([],{[A]:statistic({updatedAt:0})}).length,1,'an explicit zero observation time stays valid');
});

test('newer published summaries win; retired derived summaries never survive rehydration',()=>{
  const c=context(),newer={trackId:A,fieldSize:20,weight:6,updatedAt:200};
  assert.deepEqual(plain(c.hydratePlannerTrackSummaries([newer],{[A]:statistic()})),[newer]);
  const old=c.hydratePlannerTrackSummaries([],{[A]:statistic()});
  assert.equal(c.hydratePlannerTrackSummaries(old,{}).length,0);
  assert.equal(c.hydratePlannerTrackSummaries(old,{[A]:statistic({complete:false})}).length,0);
});

test('resolver rejects partial boards, contradictory exactness and unknown weights',()=>{
  const c=context();
  for(const change of [{complete:false},{totalEntries:13},{sourceComplete:false},{totalEntriesExact:false},{ranksExact:false}]){
    const board={complete:true,totalEntries:12,entries:Array(12).fill({}),serverUpdatedAt:200,...change};
    assert.equal(c.plannerUnplayedField(A,{[A]:board}),null);
  }
  c.overallTrackSummariesCache=c.hydratePlannerTrackSummaries([],{[A]:statistic()});
  const partial={[A]:{complete:false,totalEntries:1000,entries:[{}],serverUpdatedAt:999}};
  assert.equal(c.plannerUnplayedField(A,partial).fieldSize,12);
  assert.equal(c.plannerUnplayedField(A,partial,true),null,'group routes still require the complete field');
  c.overallTrackSummariesCache=[{trackId:A,fieldSize:12,weight:null}];
  assert.equal(c.plannerUnplayedField(A,{}),null);
});

test('complete board freshness and filtered group fields keep the existing source preference',()=>{
  const c=context();c.overallTrackSummariesCache=c.hydratePlannerTrackSummaries([],{[A]:statistic()});
  const board={complete:true,totalEntries:15,entries:Array(15).fill({}),serverUpdatedAt:200};
  assert.deepEqual(plain(c.plannerUnplayedField(A,{[A]:board})),{trackId:A,rank:0,fieldSize:15,weight:7,cachedAt:200});
  board.serverUpdatedAt=50;
  assert.equal(c.plannerUnplayedField(A,{[A]:board}).fieldSize,12);
  c.applyPersonalFilters=()=>({rows:[{},{}]});
  assert.equal(c.plannerUnplayedField(A,{[A]:board},true).fieldSize,2);
});

function routes(){
  const harnessSource=fs.readFileSync(new URL('./planner-filters.test.mjs',import.meta.url),'utf8');
  const text=harnessSource.slice(harnessSource.indexOf('function harness('),harnessSource.indexOf('const finishes='));
  const harness=new Function('source','vm','rhr',text+';return harness;')(source,vm,B);
  const h=harness(false,false),c=h.context;
  c.TRACK_CATALOG.set(A,{id:A,name:'Unopened community',type:'community'});
  c.overallTrackSummariesCache=[];c.readLocalRaceRows=()=>[];c.cleanUserId=x=>x;c.activeRankedAccountId=()=> 'self';
  vm.runInContext(extract('profileOpportunityCandidates'),c);
  return c;
}
test('production opportunity cards and route loop use the same hydrated unopened field',async()=>{
  const c=routes(),seen=[];const previous=c.recommendationAction;
  c.recommendationAction=(finish,...rest)=>{seen.push(finish);return previous(finish,...rest);};
  c.overallTrackSummariesCache=c.hydratePlannerTrackSummaries([],{[A]:statistic()});
  const candidate=c.profileOpportunityCandidates({opportunityTracks:[]},[],true).find(row=>row.trackId===A);
  const html=await c.profileGuideMarkup({userId:'self',name:'Me',raceCount:0},null,true,[],[],[]);
  assert.ok(html.includes('data-route="'+A+'"'));
  const route=seen.find(row=>row.trackId===A);
  for(const key of ['trackId','fieldSize','weight','cachedAt'])assert.equal(route[key],candidate[key]);
  assert.equal(Object.keys(c.trackSnapshotStore()).length,0,'no track needs opening');
});

test('incomplete-only fields and known unplaced PBs cannot become new authoritative routes',async()=>{
  const c=routes();c.overallTrackSummariesCache=c.hydratePlannerTrackSummaries([],{[A]:statistic({complete:false})});
  c.trackSnapshotStore=()=>({[A]:{complete:false,totalEntries:1000,entries:[{}]}});
  assert.equal(c.profileOpportunityCandidates({opportunityTracks:[]},[],true).length,0);
  let html=await c.profileGuideMarkup({userId:'self',name:'Me',raceCount:0},null,true,[],[],[]);
  assert.ok(!html.includes('data-route="'+A+'"'));
  c.overallTrackSummariesCache=c.hydratePlannerTrackSummaries([],{[A]:statistic()});
  const unplaced=[{trackId:A,timeMs:10000,rank:null}];
  c.readLocalRaceRows=()=>unplaced.map(row=>({...row,accountId:'self'}));
  html=await c.profileGuideMarkup({userId:'self',name:'Me',raceCount:0},null,true,unplaced,unplaced,[]);
  assert.ok(!html.includes('data-route="'+A+'"'));
});

function metadataHooks(c,reader){
  const start=source.indexOf('metadataRecovery=recoveryModule.createSnapshotMetadataRecovery(');
  const tail=source.slice(start),readStart=tail.indexOf('read:')+5,readEnd=tail.indexOf(',onValue:');
  const valueStart=readEnd+9,valueEnd=tail.indexOf('\n      }});')+8;
  c.reader=reader;
  const read=vm.runInContext('('+tail.slice(readStart,readEnd)+')',c);
  const onValue=vm.runInContext('('+tail.slice(valueStart,valueEnd)+')',c);
  return {read,onValue};
}
test('production metadata callback hydrates and refreshes; read binding rejects mixed packages',async()=>{
  let info={generation:71,epoch:1,baseUrl:'package71'},reply;
  const reader=()=>new Promise(resolve=>{reply=resolve;});reader.packageInfo=()=>info;
  let refreshes=0;
  const c=context({updateTrackFreshnessBanner:()=>{},extraTracksUi:null,currentTrackLoadState:null,
    refreshOpenProfilePlanner:options=>{assert.equal(options.hydrate,true);refreshes++;}});
  const hooks=metadataHooks(c,reader),pending=hooks.read('track-statistics');
  info={generation:72,epoch:2,baseUrl:'package72'};reply({tracks:{[A]:statistic()}});
  assert.equal(await pending,null);
  for(const change of [{epoch:3},{baseUrl:'different'}]){
    const pending=hooks.read('track-statistics');info={...info,...change};reply({tracks:{[A]:statistic()}});assert.equal(await pending,null);
  }
  const ready=hooks.read('track-statistics');reply({tracks:{[A]:statistic()}});
  const value=await ready;hooks.onValue('track-statistics',value);
  assert.equal(c.overallTrackSummariesCache[0].fieldSize,12);assert.equal(refreshes,1);
});

test('recovery reset plus production hydration callback cannot apply retired-generation statistics',async()=>{
  const replies=[];let refreshed=0;
  const c=context({updateTrackFreshnessBanner:()=>{},extraTracksUi:null,currentTrackLoadState:null,refreshOpenProfilePlanner:()=>refreshed++});
  const reader=()=>new Promise(resolve=>replies.push(resolve));reader.packageInfo=()=>({generation:71,epoch:1,baseUrl:'package71'});
  const hooks=metadataHooks(c,reader),recovery=createSnapshotMetadataRecovery({...hooks,read:kind=>kind==='track-statistics'?reader():null});
  const old=recovery.warm();await Promise.resolve();recovery.reset();const fresh=recovery.warm();await Promise.resolve();
  replies[0]({tracks:{[A]:statistic()}});await old;assert.equal(refreshed,0);
  replies[1]({tracks:{[B]:statistic()}});await fresh;
  assert.equal(refreshed,1);assert.deepEqual(Object.keys(c.snapshotTrackStatistics),[B]);
});

test('visible-profile hydration rebuilds inputs without opening a dialog or touching focused controls',()=>{
  const focused={};let active='self',visible=true,renders=0;
  const old={userId:'viewed',raceCount:1},fresh={userId:'viewed',raceCount:2},self={userId:'self'};
  const popup={dataset:{profileUser:'viewed'}},profileCard={scrollTop:42};
  const state={entry:old,self,isSelf:false,popup,profileCard,plannerAccountId:'self'};
  const content={__plannerContext:state};
  const c=context({overallEntriesCache:[fresh,self],document:{activeElement:focused,getElementById:()=>content},
    cleanUserId:x=>x,activeRankedAccountId:()=>active,isElementVisible:()=>visible,personalFilterRuntime:null,
    cachedProfileFinishes:id=>[{trackId:id,timeMs:100}],normalizedFinishSamples:entry=>[{trackId:'summary',count:entry.raceCount}],
    mergePlannerFinishes:(a,b)=>[...a,...b],refreshProfileOpportunityCards:()=>{},
    refreshProfilePlanner:(_content,current)=>{renders++;assert.equal(current.entry,fresh);},openRankedProfile:()=>assert.fail('Dialog reopened')});
  vm.runInContext(extract('refreshOpenProfilePlanner'),c);
  c.refreshOpenProfilePlanner({hydrate:true});assert.equal(renders,1);assert.equal(state.snapshotFinishes[0].count,2);
  assert.equal(state.selfSnapshotFinishes[1].trackId,'self');assert.equal(c.document.activeElement,focused);assert.equal(profileCard.scrollTop,42);
  active='other';c.refreshOpenProfilePlanner({hydrate:true});assert.equal(renders,1);
  active='self';popup.dataset.profileUser='other';c.refreshOpenProfilePlanner({hydrate:true});assert.equal(renders,1);
  popup.dataset.profileUser='viewed';visible=false;c.refreshOpenProfilePlanner({hydrate:true});assert.equal(renders,1);
});

test('loader stores only published summaries and preserves the existing 15-racer first-paint path',()=>{
  const loader=extract('loadOverallEntries');
  assert.match(loader,/hydratePlannerTrackSummaries\(data.trackSummaries/);
  assert.match(loader,/trackSummaries:data.trackSummaries.slice/);
  assert.match(loader,/refreshOpenProfilePlanner\(\{hydrate:true,entries:direct\}\)/);
  assert.match(extract('prepareOverallFirstPreview'),/previewSize!==15/);
  assert.doesNotMatch(extract('showOverallFirstPreview'),/hydratePlanner|track-statistics|fetchOverallEntries/);
  assert.match(extract('readPublicSnapshotBackup'),/overallTrackSummariesCache=overallTrackSummariesCache.filter\(row=>row._plannerStatistics!==true\)/);
});

test('fresh Overall loading hydrates in-memory summaries without persisting package-derived rows',async()=>{
  const fixtureSource=fs.readFileSync(new URL('./overall-static-only.test.mjs',import.meta.url),'utf8');
  const fixtureText=fixtureSource.slice(fixtureSource.indexOf('function loaderFixture('),fixtureSource.indexOf("test('missing Overall"));
  const fixture=new Function('source','vm','assert','fn',fixtureText+';return loaderFixture;')(source,vm,assert,extract);
  const data={entries:[{userId:'self',rank:1,raceCount:3,rankModel:'test-model',averageFinishVersion:2,averagePlacementVersion:2}],trackSummaries:[],algorithmVersion:'test-model',schemaVersion:6,revision:2,builtRevision:2,sourceRevision:2,updatedAt:100,complete:true,totalEntries:1,totalEntriesExact:true,publishedEntries:1};
  const f=fixture({packageValue:data});f.context.snapshotTrackStatistics={[A]:statistic()};let refreshed;
  f.context.refreshOpenProfilePlanner=options=>refreshed=options;
  const rows=await f.context.loadOverallEntries(true);
  assert.equal(f.context.overallTrackSummariesCache[0].fieldSize,12);
  assert.equal(f.writes[0][1].trackSummaries.length,0);
  assert.equal(refreshed.hydrate,true);assert.equal(refreshed.entries,rows);
});

test('opportunity refresh preserves a focused card, deduplication and profile scroll',()=>{
  const focused={},card={scrollTop:42};
  const make=(label,id,hasFocus=false)=>{
    const node={dataset:{trackId:id},querySelector:()=>({textContent:label}),contains:value=>hasFocus&&value===focused};
    Object.defineProperty(node,'outerHTML',{set(value){node.replacement=value;card.scrollTop=0;}});return node;
  };
  const best=make('Best opportunity',A,true),next=make('Next opportunity','old'),other=make('Best finish','played');
  const content={querySelectorAll:()=>[other,best,next]};
  const c=context({document:{activeElement:focused},profileOpportunityCandidates:()=>[{trackId:A},{trackId:'played'},{trackId:B}],trackSummaryLine:(label,row)=>label+':'+row?.trackId});
  vm.runInContext(extract('refreshProfileOpportunityCards'),c);
  c.refreshProfileOpportunityCards(content,{entry:{},cachedFinishes:[],isSelf:true,profileCard:card});
  assert.equal(best.replacement,undefined);assert.equal(next.replacement,'Next opportunity:'+B);
  assert.equal(card.scrollTop,42);assert.equal(c.document.activeElement,focused);
});

test('an account switch during async route calculation cannot install the retired plan',async()=>{
  let active='self',finish,writes=0;
  const popup={dataset:{profileUser:'self'}},target={};Object.defineProperty(target,'outerHTML',{set(){writes++;}});
  const content={querySelector:selector=>selector==='.profile-guide-pending'?target:null};
  const c=context({plannerMetric:'overall',plannerSort:'impact',plannerCurrentTracksOnly:false,plannerOfficialOnly:false,
    document:{activeElement:null},cleanUserId:x=>x,activeRankedAccountId:()=>active,isElementVisible:()=>true,
    setTimeout:resolve=>resolve(),cachedProfileGuideMarkup:()=>new Promise(resolve=>finish=resolve)});
  vm.runInContext(extract('refreshProfilePlanner'),c);
  const pending=c.refreshProfilePlanner(content,{entry:{userId:'self'},popup,profileCard:{scrollTop:42},plannerAccountId:'self'});
  await Promise.resolve();assert.equal(typeof finish,'function');active='other';finish('<details>retired</details>');await pending;assert.equal(writes,0);
});

test('participation markup separates semantic counts, explicit zero, unknown data and saved Extra PBs',()=>{
  const c=context();vm.runInContext(extract('profileParticipationMarkup'),c);
  let html=c.profileParticipationMarkup({officialCount:0,communityCount:2,customCount:5,extraCount:3},4);
  assert.match(html,/<dl class="profile-participation-counts">/);
  for(const [label,value] of [['Official',0],['Community',2],['Extra',3],['Custom',2]])assert.ok(html.includes('<dt>'+label+'</dt><dd>'+value+'</dd>'));
  assert.match(html,/4 saved Extra PBs on this device; not a completed-track total/);
  assert.doesNotMatch(c.profileParticipationMarkup({officialCount:1,communityCount:0,customCount:2,extraCount:2},2),/saved Extra PBs/);
  html=c.profileParticipationMarkup({},0);assert.equal((html.match(/Not loaded/g)||[]).length,4);assert.doesNotMatch(html,/<dd>0<\/dd>|saved Extra PBs/);
  html=c.profileParticipationMarkup({officialCount:null,communityCount:'0',customCount:1,extraCount:2});
  assert.ok(html.includes('<dt>Custom</dt><dd>Not loaded</dd>'));
  const profile=extract('openRankedProfile');assert.match(profile,/profileParticipationMarkup\(entry,savedExtraCount\)/);assert.doesNotMatch(profile,/stat\(escapeHtml\(participation\)/);
});

test('empty podium markup provides a short eligibility explanation without fabricated medals',()=>{
  const c=context({medalIcon:kind=>kind});vm.runInContext(extract('profileAchievementMarkup'),c);
  const html=c.profileAchievementMarkup({gold:0,silver:0,bronze:0});assert.equal((html.match(/profile-medal-card/g)||[]).length,3);assert.equal((html.match(/<b>0<\/b>/g)||[]).length,3);assert.doesNotMatch(html,/Podiums not loaded/);
  for(const value of [undefined,'2',1.5,Infinity,-1]){
    const unknown=c.profileAchievementMarkup({gold:value,silver:0,bronze:0});
    assert.doesNotMatch(unknown,/profile-medal-card gold|<b>(?:2|Infinity|-1|1.5)<\/b>/);
  }
  assert.match(c.profileAchievementMarkup({gold:1}),/profile-medal-card gold/);
});

test('equal statistics preserve published leader details instead of replacing them with counts',()=>{
 const c=context(),published={trackId:A,fieldSize:12,weight:4,updatedAt:100,leader:{name:'Leader',accountId:'saved'},recordMs:1234};
 assert.deepEqual(plain(c.hydratePlannerTrackSummaries([published],{[A]:statistic()})),[published]);
 assert.equal(c.hydratePlannerTrackSummaries([published],{[A]:statistic({updatedAt:101})})[0].leader,undefined,'newer statistics cannot inherit an older record');
});
