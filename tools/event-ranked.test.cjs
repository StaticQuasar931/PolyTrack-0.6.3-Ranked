const fs=require('node:fs'),vm=require('node:vm'),test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'..','polytrack_062_patch.js'),'utf8');
function extract(name){const start=source.search(new RegExp('^  (?:async )?function '+name+'\\(','m'));assert(start>=0,name);const tail=source.slice(start),end=tail.indexOf('\n  }');assert(end>0,name);return tail.slice(0,end+4);}
function setup(saved=null){
 const elements=new Map(),ctx={console,Date,Map,Set,Number,Promise,practiceObserver:null,overallRacerQuery:'',overallCategory:'events',overallPage:0,OVERALL_PAGE_SIZE:15,overallEntriesCache:[],rankedFilterResult:null,eventTotalsSnapshot:null,eventTotalsRequest:null,eventTotalsState:{status:'idle',checkedAt:0},EVENT_TOTALS_CACHE_KEY:'test',readJsonStorage:()=>saved,writeJsonStorage:(_k,v)=>{saved=v;},readPublicSnapshotBackup:async()=>null,snapshotOnlyForNewAccount:()=>false,profileSnapshotResults:new Map(),loadProfileSnapshotResults:async()=>false,warmProfileLocalPlacements:async()=>false,localPlannerProfileEntry:()=>null,cleanUserId:x=>String(x),withTimeout:p=>p,renderEntries:()=>{},updateRankedFreshness:()=>{},eventCloudRead:async()=>({entries:[],updatedAt:1}),document:{getElementById:id=>elements.get(id),querySelector:()=>null,querySelectorAll:()=>[]},window:{},syncCategorySelect:()=>{},hydrateOverallCarModels:()=>{},escapeHtml:s=>String(s).replaceAll('<','&lt;').replaceAll('"','&quot;'),safeDisplayName:x=>x,formatRp:String,formatRaceTime:value=>`${value}ms`,durationLabel:value=>`${value}ms`,activeRankedAccountId:()=>'',racerCosmeticClasses:()=>'',carModelPreview:()=>'',countryFlagMarkup:()=>'',profileBadgeMarkup:()=>'',ageLabel:String};
 ctx.sanitizeProfileCosmetics=value=>({...value});ctx.rankedIdentityForRacer=event=>({...event,...ctx.overallEntriesCache.find(row=>(row.userId||row.accountId)===event.accountId)});ctx.syncRankedFilterRowsSafely=()=>null;ctx.applyPersonalFilters=rows=>({rows,active:false});ctx.personalFilterRuntime=null;ctx.rankedFilterSnapshotMeta={complete:false};
 vm.createContext(ctx);for(const name of ['searchRankingRows','eventIdentityPresentation','normalizeEventTotals','savedEventTotals','fetchEventTotals','sortedEventEntries','renderEventEntryRow','renderEventEntries','updateEventFreshness','sortedOverallEntries','currentLeaderboardCount','updateOverallPager','changeOverallPage'])vm.runInContext(extract(name),ctx);
 return {ctx,elements,getSaved:()=>saved};
}
const row=(id='a',rp=20,rank=1)=>({accountId:id,name:'Event Racer',rp,rank,events:2});
test('Event RP display rounds fractional totals without changing the snapshot',()=>{
 const {ctx}=setup();const entry=row('a',27.4);const html=ctx.renderEventEntryRow(entry,0);
 assert.match(html,/class="overall-score"[^>]*>27<\/div>/);assert.doesNotMatch(html,/27\.4/);
 assert.equal(entry.rp,27.4);assert.match(html,/aria-label="Verified Event RP - 27. Pending runs are excluded."/);
});
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
test('Rolling Hills totals preserve bounded optional contribution, time and advancing run age',()=>{
 const updatedAt=Date.now()-5000,{ctx}=setup({updatedAt,entries:[]});
 const valid=ctx.normalizeEventTotals({updatedAt,entries:[{...row(),rollingHillsRunAgeMs:1000,rollingHillsEventRpContribution:500,permanentRollingHillsRp:500,rollingHillsTimeMs:20000}]}).entries[0];
 assert.equal(valid.rollingHillsRunAgeMs,1000);assert.equal(valid.rollingHillsEventRpContribution,500);assert.equal(valid.permanentRollingHillsRp,500);assert.equal(valid.rollingHillsTimeMs,20000);
 ctx.eventTotalsSnapshot={updatedAt,entries:[valid]};const html=ctx.renderEventEntryRow(valid,0);
 assert.match(html,/Rolling Hills/);assert.match(html,/\+500 ERP/);assert.match(html,/20000ms/);assert.match(html,/run [5-9]\d{3}ms old/);
 const invalid=ctx.normalizeEventTotals({updatedAt,entries:[{...row('b'),rollingHillsRunAgeMs:-1,rollingHillsEventRpContribution:1002,permanentRollingHillsRp:'500',rollingHillsTimeMs:0}]}).entries[0];
 assert.equal(invalid.rollingHillsRunAgeMs,null);assert.equal(invalid.rollingHillsEventRpContribution,null);assert.equal(invalid.permanentRollingHillsRp,null);assert.equal(invalid.rollingHillsTimeMs,null);
 assert.doesNotMatch(ctx.renderEventEntryRow(invalid,0),/Rolling Hills/);
});
test('one shared totals read, correct public endpoint, refresh cache and no per-racer reads',async()=>{
 const {ctx,getSaved}=setup();let calls=0,release;ctx.eventCloudRead=(...args)=>{calls++;assert.deepEqual(args,['/v1/events/totals','0.6.2_event_public','totals']);return new Promise(resolve=>release=resolve);};
 const first=ctx.fetchEventTotals(),second=ctx.fetchEventTotals(true);await new Promise(resolve=>setImmediate(resolve));release({updatedAt:5,entries:[row()]});await Promise.all([first,second]);assert.equal(calls,1);assert.equal(getSaved().entries.length,1);
 await ctx.fetchEventTotals();assert.equal(calls,1);assert.equal(ctx.eventTotalsState.status,'cloud');
});
test('saved event totals snapshot is used before cloud access',async()=>{
 const {ctx}=setup();const saved={updatedAt:5,entries:[row()]};let cloudReads=0,snapshotReads=0;
 ctx.readPublicSnapshotBackup=async kind=>{assert.equal(kind,'event-totals');snapshotReads++;return saved;};
 ctx.eventCloudRead=async()=>{cloudReads++;throw Error('cloud must not be read when a snapshot is available');};
 await ctx.fetchEventTotals();
 assert.equal(snapshotReads,1);assert.equal(cloudReads,0);
 assert.equal(ctx.eventTotalsSnapshot.updatedAt,5);assert.equal(ctx.eventTotalsState.status,'snapshot');
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
 const {ctx}=setup();let release;ctx.eventCloudRead=()=>new Promise(r=>release=r);const pending=ctx.fetchEventTotals();ctx.overallCategory='overall';ctx.renderEntries=()=>assert.fail('unexpected repaint');ctx.updateRankedFreshness=()=>assert.fail('unexpected freshness');await new Promise(resolve=>setImmediate(resolve));release({updatedAt:1,entries:[row()]});await pending;
});
test('200 event racers paginate 15 per page with stable event rank and bounded buttons',()=>{
 const {ctx,elements}=setup({updatedAt:1,entries:Array.from({length:200},(_,i)=>row('user'+i,200-i,i+1))});ctx.LEADERBOARD_LABELS={events:'Event RP'};for(const id of ['overallPageStatus','overallPrevPage','overallNextPage'])elements.set(id,{setAttribute(name,value){this[name]=value;},getAttribute(name){return this[name];}});
 let list={innerHTML:'',scrollTop:9};ctx.overallPage=13;ctx.renderEventEntries(list);assert.equal((list.innerHTML.match(/data-category="events"/g)||[]).length,5);assert.match(list.innerHTML,/#200/);assert.equal(elements.get('overallNextPage').disabled,true);ctx.changeOverallPage(99);assert.equal(ctx.overallPage,13);ctx.changeOverallPage(-99);assert.equal(ctx.overallPage,0);
});
test('event row never invents Overall RP, provisional or missing metrics',()=>{
 const {ctx}=setup();let html=ctx.renderEventEntryRow({accountId:'a',name:'<bad>',rank:null,rp:null,events:null},0);assert.match(html,/N\/A/);assert.match(html,/Event count unavailable/);assert.match(html,/&lt;bad>/);assert.doesNotMatch(html,/PROVISIONAL|RANK POINTS/);html=ctx.renderEventEntryRow(row('a',0),0);assert.match(html,/>0<\/div>/);
});
test('unknown event profile opens honest dialog without run reads',()=>{
 const {ctx,elements}=setup();const content={dataset:{}},popup={};elements.set('overallProfileContent',content);elements.set('overallProfilePopup',popup);let opened=false;ctx.openRankedDialog=p=>{assert.equal(p,popup);opened=true;};vm.runInContext(extract('openRankedProfile'),ctx);ctx.openRankedProfile('unknown');assert(opened);assert.match(content.innerHTML,/No Overall score or track results are inferred/);
});
test('manual refresh selects event fetch and normal category selection does not open totals dialog',()=>{
 const {ctx}=setup();Object.assign(ctx,{lastRankedManualRefreshAt:0,RANKED_MANUAL_REFRESH_COOLDOWN_MS:120000,rankedManualRefreshFailed:false,rankedRefreshCooldownTimer:0,setTimeout:()=>1,clearTimeout(){}});let forced=false;ctx.fetchEventTotals=force=>forced=force;vm.runInContext(extract('requestRankedRefresh'),ctx);ctx.requestRankedRefresh();assert(forced);assert.doesNotMatch(extract('setOverallCategory'),/ui\.totals/);assert.match(source,/window\.__pt062OpenRankedEvents=function/);assert.match(extract('renderEntries'),/renderEventEntries\(listEl\)/);
});

test('unknown appearance never fabricates a default car',()=>{const {ctx}=setup();ctx.carModelPreview=()=>assert.fail('invented appearance');ctx.renderEventEntryRow(row(),0);});
test('category selector fetches events and loads Overall after event-only startup',()=>{
 const {ctx,elements}=setup();elements.set('overallLeaderboardPanel',{querySelector:()=>null});ctx.recordLeaderboardUse=()=>{};ctx.refreshLeaderboardArcade=()=>{};ctx.syncCategorySelect=()=>{};ctx.syncOverallTrackScope=()=>{};let events=0,overall=0;ctx.fetchEventTotals=()=>events++;ctx.openRankedPanel=()=>overall++;vm.runInContext(extract('setOverallCategory'),ctx);
 ctx.overallCategory='overall';ctx.setOverallCategory('events');assert.equal(events,1);assert.equal(ctx.overallPage,0);ctx.setOverallCategory('overall');assert.equal(overall,1);
});

test('Event RP does not report empty or unavailable standings before the first response',()=>{
 const {ctx,elements}=setup();ctx.updateOverallPager=()=>{};const list={innerHTML:'',scrollTop:0};elements.set('overallLeaderboardPanel',{setAttribute(){}});
 for(const status of ['idle','loading']){ctx.eventTotalsState={status};ctx.renderEventEntries(list);assert.match(list.innerHTML,/overall-loading/);assert.doesNotMatch(list.innerHTML,/No Event RP earned|unavailable/);}
 ctx.eventTotalsState={status:'error'};ctx.renderEventEntries(list);assert.match(list.innerHTML,/Event RP unavailable/);
});


test('event snapshot provenance and successful live check survive a failed refresh',async()=>{
 const {ctx}=setup();ctx.readPublicSnapshotBackup=async()=>({updatedAt:5,entries:[row()],_snapshotCapturedAt:123});
 await ctx.fetchEventTotals();assert.equal(ctx.eventTotalsSnapshot.source,'snapshot');assert.equal(ctx.eventTotalsSnapshot.snapshotCapturedAt,123);assert.equal(ctx.eventTotalsSnapshot.lastLiveCheckedAt,0);
 ctx.eventCloudRead=async()=>({updatedAt:6,entries:[row()]});await ctx.fetchEventTotals(true);
 const checked=ctx.eventTotalsSnapshot.lastLiveCheckedAt;assert.ok(checked>0);assert.equal(ctx.eventTotalsSnapshot.source,'cloud');
 ctx.eventCloudRead=async()=>{throw Error('offline');};await ctx.fetchEventTotals(true);assert.equal(ctx.eventTotalsSnapshot.lastLiveCheckedAt,checked);assert.equal(ctx.eventTotalsSnapshot.source,'cloud');assert.equal(ctx.eventTotalsState.status,'stale');
});


test('event freshness labels source separately from successful check and failure',()=>{
 const {ctx}=setup();vm.runInContext(extract('rankedFreshnessText'),ctx);
 ctx.syncSnapshotRefreshControl=()=>{};ctx.publicSnapshotCapturedAt=123;ctx.rankedManualRefreshFailed=false;
 const el={dataset:{},className:'',textContent:'',title:''};
 ctx.eventTotalsSnapshot={updatedAt:100,entries:[],source:'snapshot',snapshotCapturedAt:123};ctx.eventTotalsState={status:'snapshot'};ctx.updateEventFreshness(el);
 assert.match(el.textContent,/Snapshot data/);assert.equal(el.dataset.source,'snapshot');assert.doesNotMatch(el.textContent,/check succeeded/);
 ctx.eventTotalsSnapshot={updatedAt:100,entries:[],source:'cloud',lastLiveCheckedAt:200};ctx.eventTotalsState={status:'cloud'};ctx.updateEventFreshness(el);assert.match(el.textContent,/Live results.*check succeeded 200/);
 ctx.eventTotalsState={status:'stale',checkedAt:999};ctx.updateEventFreshness(el);assert.match(el.textContent,/Cached results.*last live check 200.*Live check failed/);assert.doesNotMatch(el.textContent,/999/);
});


test('resolved snapshot fallback is not reported as a successful live Event RP check',async()=>{
 const {ctx}=setup();ctx.eventCloudRead=async()=>({updatedAt:5,entries:[row()],_publicBackup:true,_snapshotCapturedAt:123,_eventRefreshFailed:true});
 await ctx.fetchEventTotals(true);assert.equal(ctx.eventTotalsSnapshot.source,'snapshot');assert.equal(ctx.eventTotalsSnapshot.snapshotCapturedAt,123);
 assert.equal(ctx.eventTotalsSnapshot.lastLiveCheckedAt,0);assert.equal(ctx.eventTotalsState.status,'stale');
});
test('shared live Event RP responses retain their actual check time',async()=>{
 const {ctx}=setup();ctx.eventCloudRead=async()=>({updatedAt:5,entries:[row()],_eventLiveCheckedAt:200});
 await ctx.fetchEventTotals(true);assert.equal(ctx.eventTotalsSnapshot.lastLiveCheckedAt,200);assert.equal(ctx.eventTotalsState.status,'cloud');
 ctx.eventCloudRead=async()=>({updatedAt:5,entries:[row()],_eventLiveCheckedAt:200,_eventRefreshFailed:true});
 await ctx.fetchEventTotals(true);assert.equal(ctx.eventTotalsSnapshot.lastLiveCheckedAt,200);assert.equal(ctx.eventTotalsState.status,'stale');
});

test('Event RP preserves its score and rank while joining appearance outside the Overall prefix',()=>{
 const {ctx}=setup({updatedAt:5,entries:[row('event-only',500,7)]});
 ctx.rankedIdentityForRacer=()=>({userId:'event-only',name:'Directory name',carStyle:'safe-car',profileCosmetics:{theme:'ocean'},rank:501,rp:1,events:1,raceCount:12,cosmeticContext:{rank:501,raceCount:12}});
 const [result]=ctx.sortedEventEntries();assert.equal(result.rank,7);assert.equal(result.rp,500);assert.equal(result.events,2);
 assert.equal(result.carStyle,'safe-car');assert.equal(result.name,'Directory name');assert.equal(result.profileCosmetics.theme,'ocean');assert.equal(result.cosmeticContext.rank,501);
});
test('Event RP normalization retains public presentation and drops private fields',()=>{
 const {ctx}=setup();const input={...row(),carStyle:'saved-car',carColors:'aabbcc',identityUpdatedAt:123,profileCosmetics:{theme:'ice'},ownerUid:'private',replay:'private'};
 const result=ctx.normalizeEventTotals({updatedAt:3,entries:[input]}).entries[0];
 assert.equal(result.carStyle,'saved-car');assert.equal(result.identityUpdatedAt,123);assert.equal(result.ownerUid,undefined);assert.equal(result.replay,undefined);
});
test('Event RP omits redundant summary and uses the middle for event information',()=>{
 const {ctx}=setup({updatedAt:5,entries:[row('a',100,1)]});ctx.updateOverallPager=()=>{};
 const list={innerHTML:'',scrollTop:0};ctx.renderEventEntries(list);assert.doesNotMatch(list.innerHTML,/event-rp-summary/);assert.match(list.innerHTML,/Average 50 ERP per event/);
});


test('official Event RP uses the bound snapshot even when legacy live storage has a newer timestamp',async()=>{
 const {ctx,getSaved}=setup({updatedAt:999,source:'cloud',entries:[row('old',99)]});ctx.snapshotOnlyForNewAccount=()=>true;
 ctx.readPublicSnapshotBackup=async()=>({updatedAt:10,_snapshotPackageAt:400,_snapshotCapturedAt:300,entries:[row('new',20)]});
 ctx.eventCloudRead=()=>assert.fail('No backend fallback');await ctx.fetchEventTotals(true);
 assert.equal(ctx.eventTotalsSnapshot.entries[0].accountId,'new');assert.equal(ctx.eventTotalsSnapshot.source,'snapshot');assert.equal(ctx.eventTotalsState.status,'snapshot');
 assert.equal(getSaved().snapshotPackageAt,400);assert.equal(ctx.normalizeEventTotals(getSaved()).snapshotPackageAt,400);
});
