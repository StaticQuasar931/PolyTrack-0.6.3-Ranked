const fs=require('node:fs'),vm=require('node:vm'),test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'..','polytrack_062_patch.js'),'utf8');
function extract(name){const start=source.search(new RegExp('^  (?:async )?function '+name+'\\(','m'));assert(start>=0,name);const tail=source.slice(start),end=tail.indexOf('\n  }');assert(end>0,name);return tail.slice(0,end+4);}
function setup(saved=null){
 const elements=new Map(),ctx={console,Date,Map,Set,Number,Promise,overallCategory:'events',overallPage:0,OVERALL_PAGE_SIZE:15,overallEntriesCache:[],eventTotalsSnapshot:null,eventTotalsRequest:null,eventTotalsState:{status:'idle',checkedAt:0},EVENT_TOTALS_CACHE_KEY:'test',readJsonStorage:()=>saved,writeJsonStorage:(_k,v)=>{saved=v;},cleanUserId:x=>String(x),withTimeout:p=>p,renderEntries:()=>{},updateRankedFreshness:()=>{},eventCloudRead:async()=>({entries:[],updatedAt:1}),document:{getElementById:id=>elements.get(id),querySelector:()=>null,querySelectorAll:()=>[]},window:{},syncCategorySelect:()=>{},hydrateOverallCarModels:()=>{},escapeHtml:s=>String(s).replaceAll('<','&lt;').replaceAll('"','&quot;'),safeDisplayName:x=>x,formatRp:String,activeRankedAccountId:()=>'',racerCosmeticClasses:()=>'',carModelPreview:()=>'',countryFlagMarkup:()=>'',profileBadgeMarkup:()=>'',ageLabel:String};
 vm.createContext(ctx);for(const name of ['normalizeEventTotals','savedEventTotals','fetchEventTotals','sortedEventEntries','renderEventEntryRow','renderEventEntries','updateEventFreshness','sortedOverallEntries','currentLeaderboardCount','updateOverallPager','changeOverallPage'])vm.runInContext(extract(name),ctx);
 return {ctx,elements,getSaved:()=>saved};
}
const row=(id='a',rp=20,rank=1)=>({accountId:id,name:'Event Racer',rp,rank,events:2});
test('event sorting preserves server ties and only joins cached presentation',()=>{
 const {ctx}=setup({updatedAt:1,entries:[row('b',20,1),row('a',20,1),row('c',2,3)]});
 ctx.overallEntriesCache=[{userId:'a',name:'Saved Name',nickname:'Nick',rank:99,score:999,events:99,rp:999,provisional:true,profileCosmetics:{theme:'cyan'}}];
 const rows=ctx.sortedOverallEntries();assert.deepEqual(Array.from(rows,r=>r.rank),[1,1,3]);
 assert.equal(rows[0].rp,20);assert.equal(rows[0].events,2);assert.equal(rows[0].nickname,'Nick');assert.equal(rows[0].score,undefined);assert.equal(rows[0].provisional,undefined);assert.equal(rows[0].profileCosmetics.theme,'cyan');
});
test('unknown event metrics stay null, zero points remain zero, malformed snapshot rejected whole',()=>{
 const {ctx}=setup();const result=ctx.normalizeEventTotals({updatedAt:0,entries:[{accountId:'a',rank:null,rp:null,events:null},row('b',0,2)]});
 assert.equal(result.entries[0].rp,null);assert.equal(result.entries[1].rp,0);
 for(const entries of [[row(),row()],[row('a','20')],[{...row(),rank:0}],[{...row(),events:-1}]])assert.throws(()=>ctx.normalizeEventTotals({updatedAt:1,entries}));
});
test('one shared totals read, correct public endpoint, refresh cache and no per-racer reads',async()=>{
 const {ctx,getSaved}=setup();let calls=0,release;ctx.eventCloudRead=(...args)=>{calls++;assert.deepEqual(args,['/v1/events/totals','0.6.2_event_public','totals']);return new Promise(resolve=>release=resolve);};
 const first=ctx.fetchEventTotals(),second=ctx.fetchEventTotals(true);release({updatedAt:5,entries:[row()]});await Promise.all([first,second]);assert.equal(calls,1);assert.equal(getSaved().entries.length,1);
 await ctx.fetchEventTotals();assert.equal(calls,1);assert.equal(ctx.eventTotalsState.status,'cloud');
});
test('indefinitely old saved snapshot survives failed and malformed responses',async()=>{
 const {ctx,getSaved}=setup({updatedAt:1,entries:[row()]});ctx.eventCloudRead=async()=>{throw Error('offline');};await ctx.fetchEventTotals(true);assert.equal(ctx.eventTotalsState.status,'stale');assert.equal(ctx.sortedEventEntries().length,1);
 ctx.eventCloudRead=async()=>({updatedAt:8,entries:[row(),row()]});await ctx.fetchEventTotals(true);assert.equal(getSaved().updatedAt,1);
});
test('missing snapshot error differs from successful empty snapshot; refresh can recover',async()=>{
 const {ctx}=setup();ctx.eventCloudRead=async()=>{throw Error('offline');};await ctx.fetchEventTotals(true);assert.equal(ctx.eventTotalsState.status,'error');assert.equal(ctx.eventTotalsSnapshot,null);
 ctx.eventCloudRead=async()=>({updatedAt:3,entries:[]});await ctx.fetchEventTotals(true);assert.equal(ctx.eventTotalsState.status,'cloud');assert.equal(ctx.eventTotalsSnapshot.entries.length,0);
});
test('late older cloud snapshot never replaces newer event scores',async()=>{
 const {ctx}=setup({updatedAt:100,entries:[row('a',50)]});ctx.eventCloudRead=async()=>({updatedAt:99,entries:[row('a',1)]});await ctx.fetchEventTotals(true);assert.equal(ctx.sortedEventEntries()[0].rp,50);assert.equal(ctx.eventTotalsState.status,'stale');
});
test('category switch during fetch cannot repaint normal list',async()=>{
 const {ctx}=setup();let release;ctx.eventCloudRead=()=>new Promise(r=>release=r);const pending=ctx.fetchEventTotals();ctx.overallCategory='overall';ctx.renderEntries=()=>assert.fail('unexpected repaint');ctx.updateRankedFreshness=()=>assert.fail('unexpected freshness');release({updatedAt:1,entries:[row()]});await pending;
});
test('200 event racers paginate 15 per page with stable event rank and bounded buttons',()=>{
 const {ctx,elements}=setup({updatedAt:1,entries:Array.from({length:200},(_,i)=>row('user'+i,200-i,i+1))});ctx.LEADERBOARD_LABELS={events:'Event RP'};for(const id of ['overallPageStatus','overallPrevPage','overallNextPage'])elements.set(id,{});
 let list={innerHTML:'',scrollTop:9};ctx.overallPage=13;ctx.renderEventEntries(list);assert.equal((list.innerHTML.match(/data-category="events"/g)||[]).length,5);assert.match(list.innerHTML,/#200/);assert.equal(elements.get('overallNextPage').disabled,true);ctx.changeOverallPage(99);assert.equal(ctx.overallPage,13);ctx.changeOverallPage(-99);assert.equal(ctx.overallPage,0);
});
test('event row never invents Overall RP, provisional or missing metrics',()=>{
 const {ctx}=setup();let html=ctx.renderEventEntryRow({accountId:'a',name:'<bad>',rank:null,rp:null,events:null},0);assert.match(html,/N\/A/);assert.match(html,/Event count unavailable/);assert.match(html,/&lt;bad>/);assert.doesNotMatch(html,/PROVISIONAL|RANK POINTS/);html=ctx.renderEventEntryRow(row('a',0),0);assert.match(html,/>0<\/div>/);
});
test('unknown event profile opens honest dialog without run reads',()=>{
 const {ctx,elements}=setup();const content={dataset:{}},popup={};elements.set('overallProfileContent',content);elements.set('overallProfilePopup',popup);let opened=false;ctx.openRankedDialog=p=>{assert.equal(p,popup);opened=true;};vm.runInContext(extract('openRankedProfile'),ctx);ctx.openRankedProfile('unknown');assert(opened);assert.match(content.innerHTML,/No Overall score or track results are inferred/);
});
test('manual refresh selects event fetch and normal category selection does not open totals dialog',()=>{
 const {ctx}=setup();let forced=false;ctx.fetchEventTotals=force=>forced=force;vm.runInContext(extract('requestRankedRefresh'),ctx);ctx.requestRankedRefresh();assert(forced);assert.doesNotMatch(extract('setOverallCategory'),/ui\.totals/);assert.match(source,/window\.__pt062OpenRankedEvents=function/);assert.match(extract('renderEntries'),/renderEventEntries\(listEl\)/);
});

test('unknown appearance never fabricates a default car',()=>{const {ctx}=setup();ctx.carModelPreview=()=>assert.fail('invented appearance');ctx.renderEventEntryRow(row(),0);});
test('category selector fetches events and loads Overall after event-only startup',()=>{
 const {ctx,elements}=setup();elements.set('overallLeaderboardPanel',{querySelector:()=>null});ctx.recordLeaderboardUse=()=>{};ctx.refreshLeaderboardArcade=()=>{};ctx.syncCategorySelect=()=>{};let events=0,overall=0;ctx.fetchEventTotals=()=>events++;ctx.openPanel=()=>overall++;vm.runInContext(extract('setOverallCategory'),ctx);
 ctx.overallCategory='overall';ctx.setOverallCategory('events');assert.equal(events,1);assert.equal(ctx.overallPage,0);ctx.setOverallCategory('overall');assert.equal(overall,1);
});
