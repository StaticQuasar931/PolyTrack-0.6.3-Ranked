const fs=require('node:fs');const vm=require('node:vm');const test=require('node:test');const assert=require('node:assert/strict');
const source=fs.readFileSync(require('node:path').join(__dirname,'..','polytrack_062_patch.js'),'utf8');
function extract(name){const start=source.search(new RegExp('^  (?:async )?function '+name+'\\(','m'));assert.ok(start>=0,name);const tail=source.slice(start);const end=tail.indexOf('\n  }');assert.ok(end>0,name);return tail.slice(0,end+4);}
function run(name,context={}){context.cloudOwnerConflicts??=new Map();context.window??={firebase:{auth:()=>({currentUser:{uid:"test-owner"}})}};context.assertCloudOwner??=()=>{};context.safeRecordingId||=(x=>Number(x)||0);context.buildRecordingId||=(()=>999);context.plannerMetric??='overall';context.eventPlannerRoutes??=()=>[];context.trackInfo||=()=>({type:'official'});vm.createContext(context);if(['recommendationAction','rivalRecommendationAction','simulateRecommendation'].includes(name)&&!context.projectedFinish){context.trackInfo||=()=>({type:'official'});vm.runInContext(extract('rankedTrackWeightParts')+'\n'+extract('projectedFinish'),context);}vm.runInContext(extract(name),context);return context[name];}
for(const direction of [1,-1])test(`profile unknown results sort last in direction ${direction}`,()=>{
 const ctx={profileSort:'time',profileSortDirection:direction,knownFinishWeight:x=>x.weight,trackInfo:()=>({name:'track'})};
 const result=run('sortProfileFinishes',ctx)([{timeMs:null},{timeMs:2000},{timeMs:1000},{timeMs:undefined}]);
 assert.deepEqual(Array.from(result,x=>x.timeMs),direction===1?[1000,2000,null,undefined]:[2000,1000,null,undefined]);
});
test('category rank is independent of Overall rank',()=>{
 const ctx={readJsonStorage:()=>null,writeJsonStorage:()=>{},cleanUserId:x=>x,Date};
 const result=run('annotateCategoryRanks',ctx)([{userId:'b',rank:7},{userId:'a',rank:1}],'average');
 assert.equal(result[0].rank,7);assert.equal(result[0].categoryRank,1);assert.equal(result[1].categoryRank,2);
});
test('zero RP gain never invents a minimum helpful placement',()=>{
 const ctx={projectedOverallScore:()=>10,simulateRecommendation:()=>10};
 assert.equal(run('recommendationAction',ctx)({trackId:'zero',fieldSize:8,rank:0},'start',{},[]),null);
});
test('minimum helpful placement comes from before/after simulation',()=>{
 const ctx={projectedOverallScore:()=>10,simulateRecommendation:(_rows,_finish,rank)=>rank<=3?9:11,knownFinishWeight:()=>2,rankedTrackWeight:()=>2};
 const result=run('recommendationAction',ctx)({trackId:'new',fieldSize:8,rank:0},'start',{},[]);
 assert.equal(result.minimumHelpfulRank,3);assert.equal(result.currentFieldSize,8);assert.equal(result.fieldSize,9);
});
test('native track identity contains no badge or racer title renderer',()=>{
 const body=extract('decorateNativeLeaderboardIdentity');assert.doesNotMatch(body,/badgeMarkup|rankTitleMarkup|profileBadgeMarkup/);assert.match(body,/countryFlagMarkup/);
});
test('public cosmetic cursor includes timestamp and document tie-break',()=>{
 const body=extract('syncCosmeticDirectory');assert.match(body,/startAfter\(stamp,directory.cursorId\)/);assert.match(body,/FieldPath.documentId/);
});
test('PB is persisted before attempting Firestore',()=>{
 const body=extract('mirrorRaceResult');assert.ok(body.indexOf('addLocalRaceRow(raceRow)')<body.indexOf('const d = await db()'));
 assert.ok(body.indexOf('const priorLocal=')<body.indexOf('addLocalRaceRow(raceRow)'));
});
function overallContext({firestoreData=null,workerData=null,offline=false,failFirestore=false}={}) {
 const saved={entries:[{userId:'a',rank:1},{userId:'b',rank:2}],trackSummaries:[{trackId:'saved'}],fetchedAt:1,serverUpdatedAt:1,signature:'saved'};
 const ctx={Date,console,readOverallSnapshotCache:()=>saved,TOTAL_TRACKS:78,OVERALL_REFRESH_CHECK_MS:120000,overallTrackSummariesCache:[],overallLoadState:{},
 fetchRankedSnapshot:async()=>{if(workerData)return workerData;throw Error('blocked')},
 db:async()=>{if(failFirestore)throw Error('quota');return {collection:()=>({doc:()=>({get:async()=>({data:()=>firestoreData,metadata:{fromCache:offline}})})})}},
 expandRankedResults:async data=>run('decodeRankedResults')(data),normalizeEntries:x=>x,annotateOverallMovement:x=>x,writeOverallSnapshotCache:(rows,meta)=>{ctx.written={rows,meta}},log:()=>{},isLocalApiCapableHost:()=>false,
 COLLECTIONS:{leaderboardsOverall:'overall'},AVERAGE_PLACEMENT_VERSION:1,AVERAGE_FINISH_VERSION:1,RANK_MODEL:'test',TRACK_CACHE_SCHEMA:1};return ctx;
}
test('blocked Worker falls back to a complete Firestore snapshot',async()=>{
 const data={entries:[{userId:'new',rankModel:'test',averageFinishVersion:1,averagePlacementVersion:1}],trackSummaries:[{trackId:'new'}],algorithmVersion:'test',schemaVersion:1,revision:2,builtRevision:2,sourceRevision:2,updatedAt:2};
 const ctx=overallContext({firestoreData:data});const rows=await run('fetchOverallEntries',ctx)(true);
 assert.equal(rows[0].userId,'new');assert.equal(ctx.overallTrackSummariesCache[0].trackId,'new');assert.equal(ctx.written.meta.source,'firestore');
});
test('Worker and Firestore failure retain permanent saved Ranked',async()=>{
 const ctx=overallContext({failFirestore:true});const rows=await run('fetchOverallEntries',ctx)(true);
 assert.equal(rows.length,2);assert.equal(ctx.overallLoadState.status,'stale');assert.equal(ctx.written,undefined);
});
test('partial Firestore cache never replaces complete saved Ranked',async()=>{
 const ctx=overallContext({offline:true,firestoreData:{entries:[{userId:'partial'}]}});
 const rows=await run('fetchOverallEntries',ctx)(true);assert.equal(rows.length,2);assert.equal(rows[0].userId,'a');assert.equal(ctx.overallTrackSummariesCache[0].trackId,'saved');
});


test('an older cloud revision cannot replace newer saved Overall',async()=>{
 const ctx=overallContext({workerData:{entries:[{userId:'old',rankModel:'test',averageFinishVersion:1,averagePlacementVersion:1}],trackSummaries:[],algorithmVersion:'test',schemaVersion:1,revision:2,builtRevision:2,sourceRevision:2,updatedAt:999}});
 ctx.readOverallSnapshotCache=()=>({entries:[{userId:'current'}],trackSummaries:[{trackId:'current'}],algorithmVersion:'test',sourceRevision:3,serverUpdatedAt:3,signature:'new'});
 const rows=await run('fetchOverallEntries',ctx)(true);assert.equal(rows[0].userId,'current');assert.equal(ctx.written,undefined);assert.equal(ctx.overallTrackSummariesCache[0].trackId,'current');
});


test('rival target obeys helpful minimum and uses signed margin change',()=>{
 const ctx={projectedOverallScore:rows=>rows[0]?.trackId==='rival'?20+rows[0].rank:10,simulateRecommendation:(_rows,_track,rank)=>rank<=3?9:20,recommendationAction:()=>({minimumHelpfulRank:3,targetRank:2,simulationComplete:true}),safeDisplayName:x=>x};
 const action=run('rivalRecommendationAction',ctx)(null,{trackId:'rival',rank:6,fieldSize:9},{rank:1,raceCount:1},{name:'Rival',rank:2,raceCount:1},[{trackId:'mine',rank:2,fieldSize:8}],[{trackId:'rival',rank:6,fieldSize:9}]);
 assert.equal(action.targetRank,3);assert.equal(action.estimatedGain,1);assert.equal(action.rivalEstimatedLoss,1);assert.equal(action.value,2);
 ctx.simulateRecommendation=()=>20;
 assert.equal(ctx.rivalRecommendationAction(null,{trackId:'rival',rank:6,fieldSize:9},{rank:1},{rank:2},[{trackId:'mine',rank:2,fieldSize:8}],[{trackId:'rival',rank:6,fieldSize:9}]),null);
});

function socketHarness(db,extra={}){
 const ctx={EventTarget,Event,MessageEvent,CloseEvent:class extends Event{constructor(type,init){super(type);Object.assign(this,init)}},crypto:{randomUUID:()=> 'test-socket'},db,log:()=>{},setTimeout,window:{firebase:{auth:()=>({currentUser:{uid:'tester'}})}},COLLECTIONS:{multiplayerSessions:'sessions',multiplayerMessages:'messages',multiplayerInvites:'invites'},...extra};
 vm.createContext(ctx);const start=source.indexOf('  class FirebaseSignalingSocket');const end=source.indexOf('  FirebaseSignalingSocket.CONNECTING',start);vm.runInContext(source.slice(start,end)+';this.Socket=FirebaseSignalingSocket;',ctx);return new ctx.Socket('wss://vps.kodub.com/multiplayer/host');
}

test('close during relay database wait never writes a ghost message',async()=>{
 let writes=0;const socket=socketHarness(async()=>({collection:()=>({add:async()=>{writes++;return {delete:async()=>{}}}})}));
 await Promise.resolve();const pending=socket._relay('target','uid',{});socket.close();await pending;assert.equal(writes,0);assert.equal(socket.readyState,3);
});

test('close during host name validation does not create an orphan invite',async()=>{
 let release,writes=0;const name=new Promise(resolve=>release=resolve);
 const socket=socketHarness(async()=>({collection:()=>({doc:()=>({set:async()=>{writes++},delete:async()=>{}})})}),{enforceSafeDisplayName:()=>name,multiplayerCode:()=> 'INVITE',localStorage:{getItem:()=>null},LAST_ACTIVE_NAME_KEY:'name'});
 await Promise.resolve();const pending=socket._handleHost({type:'createInvite',nickname:'Tester'});await Promise.resolve();socket.close();release('Tester');await pending;assert.equal(writes,0);
});

test('authoritative public design is not masked by a legacy aggregate clock',()=>{
 const ctx={cleanUserId:x=>x,activeRankedAccountId:()=>'',readCosmeticDirectory:()=>({entries:{racer:{at:100,value:{theme:'cyan'}}}}),sanitizeProfileCosmetics:x=>x,enforceCosmeticUnlocks:x=>x};
 const value=run('resolveCosmeticsForEntry',ctx)({userId:'racer',cosmeticsUpdatedAt:9007199254740991,profileCosmetics:{theme:'classic'}});
 assert.equal(value.theme,'cyan');
});
// Source guards complement the isolated browser interaction matrix in the UI handoff.
test('dialog focus enumeration includes summaries and excludes inactive tabs',()=>{
 let selector='';const result=run('visibleDialogFocusables',{isElementVisible:x=>x.visible})({querySelectorAll:s=>{selector=s;return[{visible:true},{visible:false}]}});
 assert.equal(result.length,1);assert.ok(selector.includes('summary'));assert.ok(selector.includes('button:not([disabled]):not([tabindex="-1"])'));
});
test('Studio markup retains drafts and offers explicit discard',()=>{
 const body=extract('profileCustomizerMarkup');assert.ok(body.includes('profileCosmeticDrafts.get(accountId)||cosmeticsForEntry(entry)'));assert.ok(body.includes('data-discard-profile-cosmetics'));
});
test('favorite search resets its active option and preserves explicit option identities',()=>{
 const body=extract('setupRacerStudio');assert.ok(body.includes("input.dataset.selectedTrackId=id"));assert.ok(body.includes("input.removeAttribute('aria-activedescendant')"));assert.ok(body.includes("selected<0?(e.key==='ArrowDown'?0:buttons.length-1)"));
});
test('Needs work cards exclude first-place finishes',()=>{
 const body=extract('openRankedProfile');assert.ok(body.includes('const needsWorkCard=takeUnique(rankedDetails.filter((finish)=>Number(finish.rank)>1&&'));
});


test('replay checksum and legacy flags never imply run verification',()=>{
 const status=run('runStatus');
 for(const row of [null,{}, {verified:true,verifiedState:1}, {runVerified:'true'}])assert.equal(status(row),'unchecked');
 assert.equal(status({integrityVerified:true,verified:true}),'replay');
 assert.equal(status({runVerified:true}),'verified');
});
test('native result status requires unique name AND exact PB time',()=>{
 const ctx={safeDisplayName:x=>x,canonicalRaceTimeMs:x=>x.timeMs,formatRaceTime:x=>String(x)};
 const match=run('matchNativeResult',ctx);
 const a={name:'Guest',timeMs:1000,runVerified:true}, b={name:'Guest',timeMs:2000};
 assert.equal(match([a,b],'Guest','2000'),b);
 assert.equal(match([a,b],'Guest','3000'),null);
 assert.equal(match([a,{...a}],'Guest','1000'),null);
 assert.equal(match([a],'Guest',''),null);
 assert.equal(match([a],'Different','1000'),null);
});
test('native status resets when result identity cannot be established',()=>{
 const body=extract('decorateNativeLeaderboardCosmetics');
 assert.ok(body.indexOf('dataset.sqRunStatus=runStatus(racer)')<body.indexOf('if(!racer)'));
 assert.doesNotMatch(body,/rows\[rank-1\]/);
});


test('verified filtering preserves full-field weight and sorts waiting self by time',()=>{
 const choose=run('visibleTrackEntries',{canonicalRaceTimeMs:x=>x.timeMs});
 const rows=[{accountId:'b',timeMs:2000,runVerified:true,weight:3,fieldSize:20},{accountId:'me',timeMs:1000,runVerified:false,weight:3,fieldSize:20},{accountId:'a',timeMs:2000,runVerified:true,weight:3,fieldSize:20},{accountId:'other',timeMs:500,runVerified:false,weight:3,fieldSize:20}];
 const selected=choose(rows,true,'me');assert.deepEqual(Array.from(selected,x=>x.accountId),['me','a','b']);assert.deepEqual(Array.from(selected,x=>x.position),[2,3,4]);assert.ok(selected.every(x=>x.fieldSize===20&&x.weight===3));
});
test('no verified results shows all waiting racers in deterministic order',()=>{
 const choose=run('visibleTrackEntries',{canonicalRaceTimeMs:x=>x.timeMs});
 assert.deepEqual(Array.from(choose([{accountId:'z',timeMs:1000},{accountId:'a',timeMs:1000}],true,'me'),x=>x.accountId),['a','z']);
});
test('PB normalization retains exact run verification and deterministic ties',()=>{
 const ctx={safePositiveInt:(v,f)=>Number(v)>0?Number(v):f,canonicalRaceTimeMs:x=>x.timeMs,safeDisplayName:x=>x,getLastKnownName:()=>'',__pt062NormalizeStyle:x=>x,__pt062GetRememberedStyle:()=>'',safeRecordingId:x=>x,extractCarId:()=>'',normalizeCarColorId:x=>x,pbTimestamp:x=>x.pbAt||0,buildRecordingId:()=>1};
 const normalize=run('computeTrackTopEntries',ctx);const rows=normalize([{trackId:'t',accountId:'b',timeMs:1000,runVerified:true},{trackId:'t',accountId:'a',timeMs:1000,verified:true}], 't',500);
 assert.equal(rows[0].accountId,'a');assert.equal(rows[0].runVerified,false);assert.equal(rows[1].runVerified,true);
});

test('PB completion cannot reopen Ranked over gameplay',()=>{const body=extract('mirrorRaceResult');assert.doesNotMatch(body,/openPanel\(/);assert.match(body,/OVERALL_PB_DIRTY_KEY/);});

test('canonical recovery retains only an exact published physics approval',()=>{
 const fn=run('exactPublishedVerification');const row={accountId:'a',trackId:'t',timeMs:10,frames:10,uploadId:1,replayHash:'abc'};
 assert.equal(fn(row,{...row,runVerified:true}),true);
 for(const changed of [{accountId:'b'},{trackId:'x'},{timeMs:9},{frames:9},{uploadId:2},{replayHash:'def'},{runVerified:false}])assert.equal(fn(row,{...row,runVerified:true,...changed}),false);
});


test('cosmetic synchronization budgets 10 legacy plus 20 changed profiles',()=>{
 const body=extract('syncCosmeticDirectory');assert.match(body,/seedQuery.limit\(10\)/);assert.match(body,/query.limit\(20\)/);
 assert.match(body,/seeded=seed.size<10/);assert.match(body,/startAfter\(stamp,directory.cursorId\)/);
});
test('all waiting results use one pending style, never the former blue integrity style',()=>{
 assert.doesNotMatch(source,/data-sq-run-status="replay"\]\{background/);
 assert.match(source,/verified-state.pending\{background:#473419/);
});
test('equal confirmed PB matching the board does not request a repair',()=>{
 const body=extract('mirrorRaceResult');assert.match(body,/leaderboardRepairNeeded=sourceBestMs>0&&cachedSourceMs!==sourceBestMs/);
 assert.ok(body.indexOf('rememberConfirmedLocalPb(accountId,savedRow)')>body.indexOf('await d.runTransaction'));
});
test('PB reconciliation never treats an offline cached response as cloud confirmation',()=>{
 const body=extract('reconcileLocalPersonalBestsToCloud');assert.match(body,/source:'server'/);assert.match(body,/doc.metadata\?\.fromCache/);
});
function receiptContext(rows,cloud){
 let store={};let reads=0;const ctx={window:{firebase:{auth:()=>({currentUser:{uid:"test-owner"}})}},cloudOwnerConflicts:new Map(),assertCloudOwner:()=>{},Date,JSON,Map,cleanUserId:x=>x,canonicalRaceTimeMs:x=>Number(x?.timeMs)||0,
 LOCAL_PB_RECONCILE_STATE_KEY:'receipts',localPbReconcilePromise:null,localBestRowsForAccount:()=>rows,
 readJsonStorage:()=>store,writeJsonStorage:(_key,value)=>{store=value},COLLECTIONS:{raceResults:'pb'},log:()=>{},
 db:async()=>({collection:()=>({doc:id=>({get:async()=>{reads++;return {exists:Boolean(cloud[id]),data:()=>cloud[id]}}})})}),
 addLocalRaceRow:row=>{const index=rows.findIndex(x=>x.trackId===row.trackId);rows[index]=row},
 readRecordingStore:()=>[],safeRecordingId:x=>x,normalizeReplayPayloadString:x=>x,
 safePositiveInt:x=>x,getDefaultCarStyle:()=>'',getLastKnownName:()=>'',overallLoadState:{},OVERALL_PB_DIRTY_KEY:'dirty'};
 vm.createContext(ctx);for(const name of ['localPbSyncSignature','rememberConfirmedLocalPb','reconcileLocalPersonalBestsToCloud'])vm.runInContext(extract(name),ctx);
 return {ctx,reads:()=>reads,store:()=>store};
}
test('confirmed PB receipts avoid all startup document reads',async()=>{
 const row={trackId:'one',timeMs:1000,replayHash:'hash'};const {ctx,reads}=receiptContext([row],{});
 ctx.rememberConfirmedLocalPb('a',row);const result=await ctx.reconcileLocalPersonalBestsToCloud('a');assert.equal(result.cached,true);assert.equal(reads(),0);
});
test('only unconfirmed tracks are checked and confirmed equality is remembered',async()=>{
 const a={trackId:'one',timeMs:1000,replayHash:'h'},b={trackId:'two',timeMs:2000,replayHash:'j'};
 const {ctx,reads}=receiptContext([a,b],{'a_two':b});ctx.rememberConfirmedLocalPb('a',a);
 await ctx.reconcileLocalPersonalBestsToCloud('a');assert.equal(reads(),1);
 await ctx.reconcileLocalPersonalBestsToCloud('a');assert.equal(reads(),1);
});
test('faster unsaved local PB is not suppressed by an older confirmation',async()=>{
 const old={trackId:'one',timeMs:2000,replayHash:'old'},row={trackId:'one',timeMs:1000,replayHash:'new',replay:'replay'};
 const {ctx,reads}=receiptContext([row],{'a_one':old});ctx.rememberConfirmedLocalPb('a',old);let attempts=0;
 ctx.mirrorRaceResult=async()=>{attempts++;return {saved:false}};
 await ctx.reconcileLocalPersonalBestsToCloud('a');await ctx.reconcileLocalPersonalBestsToCloud('a');assert.equal(attempts,2);assert.equal(reads(),2);
});


test('failed SDK script can be retried; simultaneous callers share the same load',async()=>{
 const scripts=[];const ctx={Map,Promise,Error,setTimeout,clearTimeout,sdkScriptLoads:new Map(),document:{querySelector:()=>null,createElement:()=>({dataset:{},remove(){this.removed=true}}),head:{appendChild:s=>scripts.push(s)}}};
 const load=run('loadScript',ctx);const first=load('sdk');assert.equal(load('sdk'),first);assert.equal(scripts.length,1);
 const rejected=assert.rejects(first,/unavailable/);scripts[0].onerror();await rejected;assert.equal(scripts[0].removed,true);
 const next=load('sdk');assert.equal(scripts.length,2);scripts[1].onload();await next;
});
test('Firebase failed initialization clears its memoized promise with retry backoff',async()=>{
 const ctx={Date,firestorePromise:null,firebaseRetryAt:0,loadScript:async()=>{throw Error('blocked')}};
 const get=run('db',ctx);await assert.rejects(get(),/blocked/);assert.equal(ctx.firestorePromise,null);assert.ok(ctx.firebaseRetryAt>Date.now());
 await assert.rejects(get(),/cooling down/);
});


test('new-track projection recomputes weight when a second racer becomes three',()=>{
 const ctx={trackInfo:()=>({type:'official'})};vm.createContext(ctx);vm.runInContext(extract('rankedTrackWeightParts')+'\n'+extract('projectedFinish'),ctx);
 const old=ctx.rankedTrackWeightParts('a',2,1,1).finalWeight;
 const next=ctx.projectedFinish({trackId:'a',fieldSize:2,weight:old},1,3);
 assert.ok(next.weight>old);assert.equal(next.weight,ctx.rankedTrackWeightParts('a',3,1,1).finalWeight);
});
test('self planner cannot reintroduce stale cached finishes after freshness resolution',()=>{
 assert.doesNotMatch(extract('profileGuideMarkup'),/isSelf\?cachedFinishes/);
});
test('rival routes and personal routes do not share unlike percentage denominators',()=>{
 assert.match(extract('profileGuideMarkup'),/orderedPlannerRoutes/);
});
test('No badge is first and has a separate control style',()=>{
 assert.match(source,/badge:\[\['none','No badge'/);assert.match(extract('profileCustomizerMarkup'),/badge-off-control/);
});


test('RP precision defaults to three and supports only two, three or four decimals',()=>{
 const ctx={localStorage:{getItem:()=>null}};const get=run('rpDecimals',ctx);assert.equal(get(),3);
 for(const value of ['2','3','4']){ctx.localStorage.getItem=()=>value;assert.equal(get(),Number(value));}
 for(const value of ['1','8','oops']){ctx.localStorage.getItem=()=>value;assert.equal(get(),3);}
});
test('RP formatting preserves missing values and does not affect score data',()=>{
 const format=run('formatRp',{rpDecimals:()=>4});assert.equal(format(12.345),'12.3450');assert.equal(format(null),'N/A');assert.equal(format(Infinity),'N/A');
});
test('planner objectives use their actual metric rather than relabeling Overall RP',()=>{
 const ctx={plannerMetric:'medals',knownFinishWeight:()=>2,rankedTrackWeight:()=>2,rankedPlacementCost:r=>r*10,medianNumber:()=>30};
 const score=run('projectedOverallScore',ctx),rows=[{trackId:'a',rank:2,fieldSize:10},{trackId:'b',rank:4,fieldSize:10}];
 assert.equal(score(rows),-3);ctx.plannerMetric='skill';assert.equal(score(rows),30);ctx.plannerMetric='overall';assert.ok(Math.abs(score(rows)-(24+20*Math.exp(-.2)))<1e-9);
});
test('multiplayer empty errors do not leave a phantom gap and help starts compact',()=>{
 assert.match(source,/error-box:empty\{display:none/);assert.match(extract('syncMultiplayerRelayPanel'),/route-collapsed'\)!=='0'/);
});



test('incomplete personal results cannot produce a minimum helpful placement',()=>{
 const action=run('recommendationAction',{projectedOverallScore:()=>10});assert.equal(action({trackId:'new',rank:0,fieldSize:8},'start',{raceCount:10},[{trackId:'loaded',rank:10,fieldSize:12}]),null);
});
test('neutral personal gain can still produce a positive rival route',()=>{
 const ctx={projectedOverallScore:rows=>rows.reduce((n,r)=>n+r.rank,0)/rows.length,simulateRecommendation:()=>1,projectedFinish:(f,rank,fieldSize)=>({...f,rank,fieldSize}),safeDisplayName:n=>n,recommendationAction:()=>({targetRank:1,minimumHelpfulRank:3,simulationComplete:true})};
 const rival=run('rivalRecommendationAction',ctx);const result=rival(null,{trackId:'rival',rank:1,fieldSize:2},{raceCount:1},{raceCount:1,name:'Rival'},[{trackId:'own',rank:1,fieldSize:3}],[{trackId:'rival',rank:1,fieldSize:2}]);
 assert.ok(result);assert.equal(result.estimatedGain,0);assert.equal(result.value,1);assert.equal(result.minimumHelpfulRank,1);
});
test('rival base allows neutral results, but ordinary improvement does not',()=>{
 const ctx={projectedOverallScore:()=>1,simulateRecommendation:()=>1,knownFinishWeight:()=>2,projectedFinish:f=>f,rankedTrackWeight:()=>2};const action=run('recommendationAction',ctx),finish={trackId:'new',rank:0,fieldSize:2},entry={raceCount:1},rows=[{trackId:'own',rank:1,fieldSize:2}];
 assert.ok(action(finish,'rival',entry,rows));assert.equal(action(finish,'start',entry,rows),null);
});

test('planner podium metrics follow field eligibility and actual leaderboard points',()=>{
 const ctx={plannerMetric:'medals',trackInfo:id=>({type:id==='private'?'custom':'official'}),knownFinishWeight:()=>2,rankedTrackWeight:()=>2,rankedPlacementCost:r=>r*10};const score=run('projectedOverallScore',ctx);
 const rows=[{trackId:'gold',rank:1,fieldSize:5},{trackId:'silver',rank:2,fieldSize:9},{trackId:'bronze',rank:3,fieldSize:8},{trackId:'small',rank:1,fieldSize:4},{trackId:'private',rank:1,fieldSize:9}];
 assert.equal(score(rows),-13);ctx.plannerMetric='wins';assert.equal(score(rows),-1);ctx.plannerMetric='podiumRate';assert.equal(score(rows),-100);assert.equal(score(rows.slice(0,2)),0);ctx.plannerMetric='weight';assert.equal(score(rows),-10);
});
test('planner selector excludes average and non-actionable categories',()=>{
 const options=source.match(/const PLANNER_METRICS=Object.freeze\(([^;]+)\);/)[1];assert.doesNotMatch(options,/average|playtime|veterans/);for(const key of ['medals','wins','podiumRate','weight'])assert.ok(options.includes(key));
});

test('planner fills six unique suggestions after the rival routes',()=>{
 const select=run('orderedPlannerRoutes');const rows=select([{trackId:'r'}],[{trackId:'r'},...Array.from({length:8},(_,i)=>({trackId:String(i)}))]);assert.deepEqual(Array.from(rows,r=>r.trackId),['r','0','1','2','3','4']);
});
test('defense requires first place on every important known track and complete personal data',()=>{
 const defense=run('plannerDefenseAllowed');const tracks=[{trackId:'a',fieldSize:5,weight:2},{trackId:'b',fieldSize:8,weight:3}];assert.equal(defense([{trackId:'a',rank:1}],{raceCount:1},tracks),false);assert.equal(defense([{trackId:'a',rank:1},{trackId:'b',rank:2}],{raceCount:2},tracks),false);assert.equal(defense([{trackId:'a',rank:1},{trackId:'b',rank:1}],{raceCount:2},tracks),true);assert.equal(defense([],{raceCount:0},[]),false);
});
test('planner reads new-track candidates from the existing overall summaries',()=>{
 assert.match(extract('profileGuideMarkup'),/overallTrackSummariesCache.find/);assert.doesNotMatch(extract('profileGuideMarkup'),/fetch\(|\.get\(\{source/);
});

test('hosted verifier checks sandbox startup before processing replays',()=>{
 const workflow=fs.readFileSync(require('node:path').join(__dirname,'../.github/workflows/verify-runs.yml'),'utf8');assert.ok(workflow.indexOf('Sandboxed browser startup passed')<workflow.indexOf('name: Verify queued runs'));assert.match(workflow,/apparmor_parser/);assert.match(workflow,/chromiumSandbox:true/);assert.doesNotMatch(workflow,/--no-sandbox|apparmor_restrict_unprivileged_userns=0/);
});

test('compact result snapshot decodes all scored tracks without cloud reads',()=>{
 const result=run('decodeRankedResults')({resultTracks:['summer','winter'],entries:[{raceCount:2,resultData:JSON.stringify([[0,3,10,2.1,1,19000,123],[1,1,5,1.4,1,20000,456]])}]});
 assert.equal(result[0].resultSamples.length,2);assert.equal(result[0].resultSamples[1].trackId,'winter');assert.equal(result[0].resultSamples[0].rank,3);
});
test('invalid compact data never supplies a partial scoring baseline',()=>{
 const result=run('decodeRankedResults')({resultTracks:['summer'],entries:[{resultData:'[[0,1,2,1,1,1000,0],[9,1,2,1,1,1000,0]]'}]});assert.equal(result[0].resultSamples,undefined);
});
test('faster local PB is projected only for its owner and cannot inherit approval',()=>{
 const cloud=[{accountId:'me',timeMs:20000,runVerified:true},{accountId:'other',timeMs:18000,runVerified:true}];
 const ctx={canonicalRaceTimeMs:r=>r?.timeMs||0,readLocalRaceRows:()=>[{accountId:'me',trackId:'a',timeMs:17000},{accountId:'other',trackId:'a',timeMs:1000}]};
 const result=run('localTrackDisplayEntries',ctx)('a',cloud,'me');const mine=result.find(r=>r.accountId==='me');
 assert.equal(mine.timeMs,17000);assert.equal(mine.cloudTimeMs,20000);assert.equal(mine.localPending,true);assert.equal(mine.runVerified,false);assert.equal(result.find(r=>r.accountId==='other').timeMs,18000);assert.equal(cloud[0].timeMs,20000);
});
test('equal or slower local PB retains the exact cloud verification',()=>{
 const cloud=[{accountId:'me',timeMs:20000,runVerified:true}];const ctx={canonicalRaceTimeMs:r=>r?.timeMs||0,readLocalRaceRows:()=>[{accountId:'me',trackId:'a',timeMs:20000}]};
 assert.equal(run('localTrackDisplayEntries',ctx)('a',cloud,'me'),cloud);
});

test('gzip planner envelope preserves every result and racer binding',async()=>{
 const zipped=require('node:zlib').gzipSync(JSON.stringify({resultTracks:['a'],entries:[{userId:'me',resultData:'[[0,2,3,1.5,1,19000,123]]'}]})).toString('base64');
 const ctx={DecompressionStream,Blob,Uint8Array,atob,TextDecoder,decodeRankedResults:run('decodeRankedResults')};
 const rows=await run('expandRankedResults',ctx)({entries:[{userId:'me'},{userId:'other'}],resultBundle:zipped,resultBundleVersion:1});
 assert.equal(rows[0].resultSamples[0].rank,2);assert.equal(rows[1].resultSamples,undefined);
});
test('damaged compressed results preserve the existing leaderboard',async()=>{
 const ctx={DecompressionStream,Blob,Uint8Array,atob,TextDecoder,decodeRankedResults:run('decodeRankedResults')};
 const rows=await run('expandRankedResults',ctx)({entries:[{userId:'me',score:3}],resultBundle:'bad data',resultBundleVersion:1});assert.equal(rows[0].score,3);assert.equal(rows[0].resultSamples,undefined);
});

test('local PB never inherits a different cloud replay ID',()=>{
 const ctx={canonicalRaceTimeMs:r=>r?.timeMs||0,readLocalRaceRows:()=>[{accountId:'me',trackId:'a',timeMs:17000,uploadId:222}]};
 const rows=run('localTrackDisplayEntries',ctx)('a',[{accountId:'me',timeMs:20000,id:111,uploadId:111}],'me');
 assert.equal(rows[0].id,222);assert.equal(rows[0].uploadId,222);
});
test('same snapshot decode failure retains complete cached planner samples',async()=>{
 const row={userId:'me',score:5,raceCount:2,rankModel:'test',averageFinishVersion:1,averagePlacementVersion:1};
 const data={entries:[row],trackSummaries:[],algorithmVersion:'test',schemaVersion:1,revision:2,builtRevision:2,sourceRevision:2,updatedAt:2};
 const ctx=overallContext({firestoreData:data});ctx.readOverallSnapshotCache=()=>({entries:[{...row,resultSamples:[{trackId:'a'},{trackId:'b'}]}],signature:'test:2:2:2',fetchedAt:1});
 const rows=await run('fetchOverallEntries',ctx)(true);assert.equal(rows[0].resultSamples.length,2);assert.equal(ctx.written.rows[0].resultSamples.length,2);
});
test('different revision cannot borrow older planner results',async()=>{
 const row={userId:'me',score:5,raceCount:2,rankModel:'test',averageFinishVersion:1,averagePlacementVersion:1};
 const data={entries:[row],trackSummaries:[],algorithmVersion:'test',schemaVersion:1,revision:3,builtRevision:3,sourceRevision:3,updatedAt:3};
 const ctx=overallContext({firestoreData:data});ctx.readOverallSnapshotCache=()=>({entries:[{...row,resultSamples:[{trackId:'a'},{trackId:'b'}]}],signature:'test:2:2:2',fetchedAt:1});
 const rows=await run('fetchOverallEntries',ctx)(true);assert.equal(rows[0].resultSamples,undefined);
});

test('large planner sidecar is used only with exact snapshot binding',async()=>{
 for(const offset of [0,1]){
  const data={entries:[{userId:'me',rankModel:'test',averageFinishVersion:1,averagePlacementVersion:1}],trackSummaries:[],algorithmVersion:'test',schemaVersion:1,revision:2,builtRevision:2,sourceRevision:2,updatedAt:2,resultBundleLocation:'main_results'};
  const ctx=overallContext({workerData:data});let reads=0;ctx.db=async()=>({collection:()=>({doc:id=>({get:async()=>{assert.equal(id,'main_results');reads++;return{data:()=>({algorithmVersion:'test',sourceRevision:2+offset,builtRevision:2,updatedAt:2,resultBundle:'bundle',resultBundleVersion:1})}}})})});
  let seen;ctx.expandRankedResults=async d=>{seen=d;return d.entries};await run('fetchOverallEntries',ctx)(true);assert.equal(reads,1);assert.equal(seen.resultBundle,offset?undefined:'bundle');
 }
});

test('weekly reset is next Monday UTC even when local weekday differs',()=>{
 let instant;const ctx={Date,escapeHtml:x=>x,Intl:{DateTimeFormat:class{constructor(locale,options){assert.equal(options.timeZoneName,undefined)}format(value){instant=value;return 'Sunday 5:00 PM'}}}};
 const html=run('resetTimeMarkup',ctx)(true,Date.UTC(2026,8,13,12));assert.equal(instant,Date.UTC(2026,8,14));assert.match(html,/Monday 00:00 UTC/);assert.match(html,/<strong[^>]*>Sunday 5:00 PM Local/);
});
test('daily reset advances at midnight and does not use a fixed local offset',()=>{
 let instant;const ctx={Date,escapeHtml:x=>x,Intl:{DateTimeFormat:class{format(value){instant=value;return 'local'}}}};
 run('resetTimeMarkup',ctx)(false,Date.UTC(2026,8,14));assert.equal(instant,Date.UTC(2026,8,15));
});
test('fresh successful checks may refresh planner observations without changing the board timestamp',()=>{
 const ctx={trackOverlayCache:null,trackSnapshotStore:()=>({a:{entries:[{accountId:'me',rank:1}],serverUpdatedAt:100,checkedAt:500}}),applyCanonicalTrackWeight:(_id,e)=>e,cleanUserId:x=>x,entryTimeMs:()=>1000,knownFinishWeight:()=>2};
 const result=run('cachedTrackFinishOverlays',ctx)();assert.equal(result.get('me')[0].cachedAt,500);
});

test('route benefit is relative gain, not ordinal or probability',()=>{
 const percent=run('routeBenefitPercent');assert.equal(percent(2,4),50);assert.equal(percent(4,4),100);assert.equal(percent(0,4),0);assert.equal(percent(NaN,4),0);
});
test('thin new tracks do not displace meaningful starter recommendations',()=>{
 const eligible=run('worthwhileStart');assert.equal(eligible({weight:.16},3.2),false);assert.equal(eligible({weight:1.2},3.2),true);assert.equal(eligible({weight:null},3.2),false);
});
test('planner preview uses three routes with track thumbnails',()=>{
 const markup=extract('profileGuideMarkup');assert.match(markup,/slice\(0,3\)/);assert.match(markup,/route-preview-image/);assert.match(markup,/trackThumbnailMarkup\(action.trackId\)/);assert.doesNotMatch(extract('guideTrackCard'),/YOUR PROGRESS/);
});
test('identity hides automatic choice and resolves earned default',()=>{
 const markup=extract('profileCustomizerMarkup');assert.match(markup,/current.title==='auto'/);assert.match(markup,/current.badge==='auto'/);assert.match(markup,/id==='auto'/);assert.match(markup,/\['badge','title'\].includes\(kind\)/);
});

function independentPlannerContext(metric){
 const ctx={plannerMetric:metric,trackInfo:()=>({type:'community'})};
 vm.createContext(ctx);
 for(const name of ['rankedPlacementCost','medianNumber','rankedTrackWeightParts','rankedTrackWeight','knownFinishWeight','projectedOverallScore','projectedFinish','simulateRecommendation','recommendationSimulator','recommendationAction','matchupPersonalAction','helpfulThresholdText'])vm.runInContext(extract(name),ctx);
 return ctx;
}

test('independent regression: non-monotonic best-ten changes cannot advertise a harmful target',()=>{
 const ctx=independentPlannerContext('overall');
 // This field mix makes last place helpful, but the former halved target harmful.
 const placements=[[48,52],[15,22],[5,72],[4,15],[9,87],[98,99],[16,77],[8,8],[1,18],[1,44],[16,61],[2,11],[89,99],[13,15]];
 const baseline=placements.map(([rank,fieldSize],i)=>({trackId:'t'+i,rank,fieldSize,competition:1,weight:ctx.rankedTrackWeight('t'+i,fieldSize)}));
 const finish={trackId:'new',rank:0,fieldSize:92,competition:1,weight:ctx.rankedTrackWeight('new',92)};
 const before=ctx.projectedOverallScore(baseline);
 const gains=Array.from({length:93},(_,i)=>before-ctx.simulateRecommendation(baseline,finish,i+1));
 assert.ok(gains[46]<0,'the former #47 target must remain a genuine regression fixture');
 assert.ok(gains[92]>0,'last place helps despite the harmful better placement');
 const action=ctx.recommendationAction(finish,'start',{raceCount:baseline.length},baseline);
 assert.ok(action);
 assert.ok(action.targetScore<before);
 assert.ok(Math.abs(action.estimatedGain-(before-action.targetScore))<1e-10);
 assert.ok(Math.abs(action.estimatedGain-Math.max(...gains))<1e-10);
 let prefix=0;while(prefix<gains.length&&gains[prefix]>.0005)prefix++;
 assert.equal(action.topGuaranteed,prefix>0);
 assert.equal(action.minimumHelpfulRank,prefix||action.targetRank);
 assert.doesNotMatch(ctx.helpfulThresholdText(action),/Any finish helps/);
});

test('independent regression: podium eligibility fallback uses the actual rival margin',()=>{
 const ctx=independentPlannerContext('podiumRate');
 const finish=(trackId,rank,fieldSize)=>({trackId,rank,fieldSize,competition:1,weight:ctx.rankedTrackWeight(trackId,fieldSize)});
 const mine=[finish('a',1,5),finish('b',1,5)];
 const theirs=[finish('c',1,5),finish('d',1,5),finish('new',1,4)];
 const start=finish('new',0,4);
 const action=ctx.recommendationAction(start,'start',{raceCount:2},mine);
 assert.ok(action);
 assert.equal(action.estimatedGain,100);
 assert.equal(ctx.matchupPersonalAction(action,theirs),null,'equal gains do not improve the matchup');
 const lastPlace={...action,targetRank:5,estimatedGain:200/3};
 assert.equal(ctx.matchupPersonalAction(lastPlace,theirs),null,'personal gain must not hide the rival gaining 100 points');
 const nonPodiumRival=[...theirs.slice(0,2),finish('new',4,4)];
 const helpful=ctx.matchupPersonalAction(action,nonPodiumRival);
 assert.ok(helpful,'a genuinely positive margin must survive');
 assert.ok(Math.abs(helpful.rivalEstimatedLoss+200/3)<1e-10);
 assert.ok(Math.abs(helpful.value-100/3)<1e-10);
 assert.deepEqual(theirs.map(row=>[row.rank,row.fieldSize]),[[1,5],[1,5],[1,4]]);
 assert.match(extract('profileGuideMarkup'),/personal\.map\(action=>matchupPersonalAction\(action,snapshotFinishes\)\)/);
});

for(const metric of ['overall','skill','medals','wins','podiumRate','weight'])test(`cached simulator differential: ${metric}`,t=>{
 const ctx=independentPlannerContext(metric);
 ctx.trackInfo=id=>({type:String(id).split(':')[0]});
 let seed=62931,comparisons=0,maxDifference=0;
 const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
 const types=['official','community','custom'];
 const fields=[2,3,4,5,7,20,50,500];
 for(const count of [0,1,2,3,9,10,11,14,78]){
  const baseline=Array.from({length:count},(_,i)=>{
   const trackId=types[i%3]+':'+i,fieldSize=fields[i%fields.length];
   const row={trackId,fieldSize,rank:1+Math.floor(random()*fieldSize),competition:[.85,1,1.15][i%3]};
   row.weight=ctx.rankedTrackWeightParts(trackId,fieldSize,row.competition).finalWeight;
   if(i%4===0)delete row.weight;
   if(i%7===0){row.depthBoost=1.2;row.weight=(row.weight||1)*1.2;}
   if(i%5===0)delete row.competition;
   return row;
  });
  const cases=[...new Set([0,Math.floor(count/2),count-1])].filter(i=>i>=0&&i<count).map(i=>baseline[i]);
  for(const [i,fieldSize] of [1,2,4,5,17,499].entries())cases.push({trackId:types[i%3]+':new'+i,rank:0,fieldSize,weight:ctx.rankedTrackWeight(types[i%3]+':new'+i,fieldSize)});
  const input=[...baseline,null,{trackId:'community:solo',rank:1,fieldSize:1},{trackId:'community:unplayed',rank:0,fieldSize:20}];
  const original=JSON.stringify(input);
  for(const finish of cases){
   const scoreAt=ctx.recommendationSimulator(input,finish);
   const field=finish.fieldSize+(baseline.some(row=>row.trackId===finish.trackId)?0:1);
   const ranks=[0,...Array.from({length:field},(_,i)=>i+1),field+1,1,field];
   for(const rank of ranks){
    const expected=ctx.simulateRecommendation(input,finish,rank),actual=scoreAt(rank);
    const difference=Math.abs(actual-expected);
    assert.ok(Number.isFinite(actual)&&difference<=1e-10,JSON.stringify({metric,count,trackId:finish.trackId,rank,expected,actual}));
    comparisons++;maxDifference=Math.max(maxDifference,difference);
   }
  }
  assert.equal(JSON.stringify(input),original,'cached evaluation must not mutate baseline rows');
 }
 t.diagnostic(JSON.stringify({comparisons,maxDifference}));
});

test('production recommendation action invokes the cached simulator without the slow fallback',()=>{
 const ctx=independentPlannerContext('overall');
 const baseline=Array.from({length:12},(_,i)=>({trackId:'track'+i,rank:20-i,fieldSize:30,competition:1,weight:ctx.rankedTrackWeight('track'+i,30)}));
 const original=ctx.recommendationSimulator;let factories=0,evaluations=0;
 ctx.recommendationSimulator=(...args)=>{factories++;const scoreAt=original(...args);return rank=>{evaluations++;return scoreAt(rank);};};
 ctx.simulateRecommendation=()=>{throw Error('slow fallback called in production path');};
 const action=ctx.recommendationAction(baseline[0],'improve',{raceCount:12},baseline);
 assert.ok(action&&action.estimatedGain>0);
 assert.equal(factories,1);
 assert.equal(evaluations,20);
});

test('cancelled asynchronous planner does not calculate or render stale routes',async()=>{
 let calls=0;const ctx={recommendationAction:()=>{calls++;throw Error('stale work');}};
 const result=await run('profileGuideMarkup',ctx)({raceCount:1},null,true,[],[{trackId:'a',rank:2,fieldSize:5}],[],()=>false);
 assert.equal(result,'');assert.equal(calls,0);
});

test('planner mixes rival and personal routes by actual benefit, not source',()=>{
 const result=run('orderedPlannerRoutes')([{trackId:'rival',value:1,weight:9}],[{trackId:'personal',value:8,weight:2},{trackId:'rival',value:2,weight:9}]);
 assert.deepEqual(Array.from(result,x=>x.trackId),['personal','rival']);assert.equal(result[1].value,2);
});
test('ease sorts relative time gaps and leaves missing evidence last',()=>{
 const result=run('orderedPlannerRoutes')([],[{trackId:'unknown',value:100},{trackId:'hard',value:20,ease:{relativeGap:.2}},{trackId:'easy',value:1,ease:{relativeGap:.01}}],6,'ease');
 assert.deepEqual(Array.from(result,x=>x.trackId),['easy','hard','unknown']);
});
test('ease uses the local viewer and relative target gap, not raw seconds',()=>{
 const ease=run('plannerEase');const snapshot={entries:[{accountId:'other',timeMs:9000},{accountId:'me',timeMs:10000}]};
 const result=ease({currentRank:2,targetRank:1},snapshot,'me');assert.equal(result.relativeGap,.1);assert.equal(result.gapMs,1000);assert.equal(ease({currentRank:0,targetRank:1},snapshot,'me'),null);assert.equal(ease({currentRank:2,targetRank:1},{entries:[]},'me'),null);
});
test('ease mode selects a smaller helpful step on a played track',()=>{
 const ctx={plannerSort:'ease',projectedOverallScore:()=>10,simulateRecommendation:(_rows,_finish,rank)=>rank<=3?rank+3:11,knownFinishWeight:()=>2,rankedTrackWeight:()=>2};
 const action=run('recommendationAction',ctx)({trackId:'played',fieldSize:8,rank:5},'improve',{},[]);assert.equal(action.targetRank,3);assert.ok(action.estimatedGain>0);
});

test('ease preserves the easier helpful target when two routes share a track',()=>{
 const result=run('orderedPlannerRoutes')([{trackId:'same',targetRank:1,value:10,ease:{relativeGap:.2}}],[{trackId:'same',targetRank:2,value:2,ease:{relativeGap:.01}}],6,'ease');assert.equal(result.length,1);assert.equal(result[0].targetRank,2);
});

test('ease does not use a track snapshot older than the planner result',()=>{
 const snapshot={serverUpdatedAt:100,entries:[{accountId:'me',timeMs:10000},{accountId:'other',timeMs:9000}]};assert.equal(run('plannerEase')({currentRank:2,targetRank:1,cachedAt:200},snapshot,'me'),null);
});

test('verified filtering never promotes self past a hidden waiting result',()=>{const choose=run('visibleTrackEntries',{canonicalRaceTimeMs:x=>x.timeMs});const rows=choose([{accountId:'fast',timeMs:1000},{accountId:'me',timeMs:2000},{accountId:'verified',timeMs:3000,runVerified:true}],true,'me');assert.equal(rows[0].position,2);assert.equal(rows[0].runVerified,undefined);});
test('planner data availability excludes empty and non-scoring fields',()=>{const available=run('plannerCategoryAvailability');assert.equal(available([],[]).overall,false);assert.equal(available([],[{fieldSize:1,weight:0}]).wins,false);assert.equal(available([{rank:2,fieldSize:8,weight:2}],[{fieldSize:8,weight:2}]).wins,true);});

test('local-only PB cannot invent a first place without a complete field',()=>{assert.equal(run('localTrackDisplayEntries')('track',[],'me',false).length,0);});

test('event planner requires matching cached period and computes integer points',()=>{const period={id:'d_x',kind:'daily',trackId:'track',startsAt:1,endsAt:100,targetMs:20000,maxRp:100};const data={'polytrack-062-events-v1':{periods:[period]},'polytrack-062-events-v1-best':{},'polytrack-062-events-v1-d_x':{period,entries:[{accountId:'me',timeMs:25000}],updatedAt:5}};const routes=run('eventPlannerRoutes',{readJsonStorage:(k,f)=>data[k]||f})('me','rival',10);assert.equal(routes.length,1);assert.equal(routes[0].currentRp,80);assert.equal(routes[0].gain,20);assert.equal(routes[0].minimumTime,24691);data['polytrack-062-events-v1-d_x'].period={...period,targetMs:19000};assert.equal(run('eventPlannerRoutes',{readJsonStorage:(k,f)=>data[k]||f})('me','rival',10).length,0);});
test('event planner excludes ended events and cannot farm maximum points',()=>{const p={id:'w_x',kind:'weekly',trackId:'t',startsAt:1,endsAt:10,targetMs:10000,maxRp:500};const data={'polytrack-062-events-v1':{periods:[p]},'polytrack-062-events-v1-best':{},'polytrack-062-events-v1-w_x':{period:p,entries:[{accountId:'me',timeMs:10000}]}};const fn=run('eventPlannerRoutes',{readJsonStorage:(k,f)=>data[k]||f});assert.equal(fn('me',null,5).length,0);assert.equal(fn('other',null,10).length,0);});

test('local unverified event attempt never hides verified point opportunities',()=>{const p={id:'d_x',kind:'daily',trackId:'t',startsAt:1,endsAt:100,targetMs:20000,maxRp:100};const data={'polytrack-062-events-v1':{periods:[p]},'polytrack-062-events-v1-best':{'d_x_me':{timeMs:20000}},'polytrack-062-events-v1-d_x':{period:p,entries:[{accountId:'me',timeMs:25000}]}};const rows=run('eventPlannerRoutes',{readJsonStorage:(k,f)=>data[k]||f})('me',null,10);assert.equal(rows[0].gain,20);assert.equal(rows[0].localTime,20000);});
test('filtered native navigation uses visible index while rows keep full-field rank',()=>{assert.match(source,/userEntry:mine \? \{position:mineIndex\+1,/);const choose=run('visibleTrackEntries',{canonicalRaceTimeMs:x=>x.timeMs});const rows=choose(Array.from({length:100},(_,i)=>({accountId:i===99?'me':String(i),timeMs:i+1,runVerified:i===0})),true,'me');assert.equal(rows.length,2);assert.equal(rows[1].rank,100);assert.equal(Math.floor(rows.findIndex(r=>r.accountId==='me')/20),0);});

test('known solo result has zero weight, unlike a missing result',()=>{const weight=run('knownFinishWeight');assert.equal(weight({rank:1,fieldSize:1}),0);assert.equal(weight({}),null);});

for(const direction of [1,-1])test('known zero weight sorts before missing in direction '+direction,()=>{const rows=run('sortProfileFinishes',{profileSort:'weight',profileSortDirection:direction,knownFinishWeight:r=>r.weight})([{weight:null},{weight:0},{weight:2}]);assert.deepEqual(Array.from(rows,r=>r.weight),direction===1?[0,2,null]:[2,0,null]);});

test('owner cosmetics require explicit server-issued unlocks',()=>{
 const unlocked=run('cosmeticUnlocked');assert.equal(unlocked('unlock:emblem:target',{raceCount:999,rank:1}),false);
 assert.equal(unlocked('unlock:emblem:target',{cosmeticUnlocks:['emblem:target']}),true);
 assert.equal(unlocked('unlock:stripe:overdrive',{cosmeticUnlocks:['emblem:target']}),false);
});
test('earned cosmetic hover preserves reason and award date',()=>{
 const unlocked=run('cosmeticUnlocked');const reason=run('cosmeticUnlockReason',{cosmeticUnlocked:unlocked});
 assert.match(reason('unlock:stripe:overdrive',{}),/3 distinct official or Rolling Hills/);
 assert.match(reason('unlock:emblem:target',{cosmeticUnlocks:['emblem:target'],serverAchievements:{beatOwner:{unlocks:[{cosmeticId:'emblem:target',unlockedAt:1000000000000}]}}}),/Permanently earned on/);
});
