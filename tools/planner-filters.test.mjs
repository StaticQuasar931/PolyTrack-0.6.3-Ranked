import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const rhr='fb769ac2ea77e8f19a21a9dd3071742f2342bd49c41e4748d7e8c7903d4f0778';
function harness(current,official){
 const tracks=new Map([['official',{type:'official',id:'official',name:'Official'}],['new',{type:'official',id:'new',name:'New'}],['community',{type:'community',id:'community',name:'Community'}],[rhr,{type:'community',id:rhr,name:'RHR'}]]),baselineSizes=[];
 const context=vm.createContext({Map,Set,Date,Number,Math,Array,Object,Promise,setTimeout,plannerMetric:'overall',plannerSort:'impact',plannerCurrentTracksOnly:current,plannerOfficialOnly:official,PLANNER_METRICS:{overall:'Overall RP'},
 trackInfo:id=>tracks.get(id),TRACK_CATALOG:tracks,personalFilterRuntime:null,practiceHistory:null,practiceAdviceFor:()=>({factor:1,text:''}),overallTrackSummariesCache:[...tracks.values()].map(t=>({trackId:t.id,fieldSize:20,weight:3})),overallLoadState:{},
 eventPlannerRoutes:()=>Object.assign([],{dataAvailable:false}),trackSnapshotStore:()=>({}),maximumKnownTrackWeight:()=>10,worthwhileStart:()=>true,
 recommendationAction:(finish,kind,entry,baseline)=>{baselineSizes.push(baseline.length);return{...finish,kind,currentRank:finish.rank,targetRank:1,minimumHelpfulRank:1,value:1,weight:3};},
 orderedPlannerRoutes:(_r,p)=>p,plannerEase:()=>1,plannerDefenseAllowed:()=>false,guideTrackCard:action=>'<button data-route="'+action.trackId+'">Route</button>',
 trackThumbnailMarkup:()=>'',safeDisplayName:x=>x,escapeHtml:x=>x,plannerCategoryAvailability:()=>({overall:true}),ageLabel:()=>'',
 });

 context.profileSnapshotEpoch=0;context.localRaceGeneration=0;
 context.cleanUserId=value=>String(value||'');context.activeRankedAccountId=()=> 'self';
 context.readLocalRaceRows=()=>[];context.entryTimeMs=row=>row.timeMs;context.pbTimestamp=row=>row.pbAt||0;
 context.knownFinishWeight=row=>Number(row.weight)||3;context.snapshotTrackStatistics={};
 context.plannerPublishedProfiles=new Map();context.plannerBoardRequests=new Map();context.plannerPracticePlans=new Map();
 context.loadProfileSnapshotResults=async id=>{
   if(!context.plannerPublishedProfiles.has(id))context.plannerPublishedProfiles.set(id,{epoch:context.profileSnapshotEpoch,
     profile:{accountId:id,results:context.__profileRows||['official','community',rhr].map(trackId=>({trackId,rank:5,fieldSize:20,timeMs:20000,weight:3})),expectedEligibleTracks:context.__profileRows?.length??3}});
   return false;
 };
 context.readPublicSnapshotBackup=async()=>null;
 vm.runInContext(source.slice(source.indexOf('// BEGIN PLANNER MODEL'),source.indexOf('// END PLANNER MODEL')),context);
 const helperStart=source.indexOf('  function plannerTrackAllowed('),helperEnd=source.indexOf('  function eventPlannerRoutes(',helperStart);
 vm.runInContext(source.slice(helperStart,helperEnd),context);
 const start=source.indexOf('  async function profileGuideMarkup('),end=source.indexOf('  function openRankedProfile(',start);
 vm.runInContext(source.slice(start,end),context);
 return{context,baselineSizes};
}
const finishes=['official','community',rhr].map(trackId=>({trackId,rank:5,fieldSize:20,timeMs:20000,weight:3}));
for(const [current,official,ids]of [[false,false,['official','new','community',rhr]],[true,false,['official','community',rhr]],[false,true,['official','new',rhr]],[true,true,['official',rhr]]]){
 test('planner filters candidate routes but retain all scoring inputs: '+current+'/'+official,async()=>{
 const h=harness(current,official),html=await h.context.profileGuideMarkup({userId:'self',name:'Me',raceCount:3},null,true,finishes,finishes,[]);
 const actual=[...html.matchAll(/data-route="([^"]+)"/g)].map(m=>m[1]);assert.deepEqual(actual.sort(),ids.sort());assert.ok(h.baselineSizes.every(n=>n===3));
 assert.match(html,/aria-pressed="/);assert.match(html,/Played tracks only/);assert.match(html,/Official only/);
 });
}
test('filters restore persisted choices and include Rolling Hills Racer in the official set',()=>{
 const context=vm.createContext({localStorage:{getItem:key=>key.includes('only')?'true':null},trackInfo:()=>({type:'community'}),PLANNER_METRICS:{overall:'Overall'}});
 const start=source.indexOf("  let plannerMetric='overall';"),end=source.indexOf('  function eventPlannerRoutes(',start);vm.runInContext(source.slice(start,end),context);
 assert.equal(context.plannerTrackAllowed(rhr,new Set([rhr])),true);assert.equal(context.plannerTrackAllowed('community',new Set(['community'])),false);
 assert.equal(context.plannerTrackAllowed(rhr,new Set()),false);
});


test('a partial board uses the published full-field summary, not its truncated rows',async()=>{
 const h=harness(false,false);let selected;
 h.context.trackSnapshotStore=()=>({new:{complete:false,totalEntries:1000,serverUpdatedAt:200,entries:Array(500).fill({})}});
 h.context.overallTrackSummariesCache.find(r=>r.trackId==='new').fieldSize=1000;
 const original=h.context.recommendationAction;h.context.recommendationAction=(finish,...rest)=>{if(finish.trackId==='new')selected=finish;return original(finish,...rest);};
 await h.context.profileGuideMarkup({userId:'self',name:'Me',raceCount:3},null,true,finishes,finishes,[]);
 assert.equal(selected.fieldSize,1000);
});

test('an incomplete field without an authoritative summary cannot supply a new-track route',async()=>{
 const h=harness(false,false);h.context.trackSnapshotStore=()=>({new:{complete:false,totalEntries:1000,serverUpdatedAt:200,entries:Array(500).fill({})}});
 h.context.overallTrackSummariesCache=h.context.overallTrackSummariesCache.filter(r=>r.trackId!=='new');
 const html=await h.context.profileGuideMarkup({userId:'self',name:'Me',raceCount:3},null,true,finishes,finishes,[]);
 assert.ok(!html.includes('data-route="new"'));
});


test('profile opportunity summaries open without planner-local variables',()=>{
 const h=harness(false,false);h.context.readLocalRaceRows=()=>[];h.context.cleanUserId=x=>x;h.context.activeRankedAccountId=()=> 'self';h.context.cachedTrackWeight=()=>2;
 const start=source.indexOf('  function profileOpportunityCandidates('),end=source.indexOf('  function profileComparisonRoutes(',start);vm.runInContext(source.slice(start,end),h.context);
 const rows=h.context.profileOpportunityCandidates({opportunityTracks:[]},finishes,true);assert.ok(rows.some(row=>row.trackId==='new'));
});

test('official control has the requested accessible label and route limit is eight',()=>{
 const h=harness(false,false);assert.match(h.context.plannerFilterMarkup(),/aria-label="Only suggests official tracks"/);
 const start=source.indexOf('  function orderedPlannerRoutes('),end=source.indexOf('  function plannerDefenseAllowed(',start);vm.runInContext(source.slice(start,end),h.context);
 const actions=Array.from({length:12},(_,i)=>({trackId:'track'+i,value:12-i}));assert.equal(h.context.orderedPlannerRoutes([],actions).length,8);
});
