const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../polytrack_062_patch.js'),'utf8');
test('generation recovery rewarms metadata and ignores retired warm replies',async()=>{
 const start=source.indexOf('      const recoveryModule=await import('),end=source.indexOf('      return reader;',start);assert(start>=0&&end>start);
 const recoveryLibrary=await import('./snapshot-metadata-recovery.mjs');
 const requests=[],deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};let notify;
 const reader=kind=>{const item={kind,...deferred()};requests.push(item);return item.promise;};
 let replayInvalidations=0,eventInvalidations=0;
 const context={recoveryLibrary,metadataRecovery:null,currentTrackLoadState:null,extraTracksUi:null,
 nativeRecordingEpoch:0,nativeRecordingMemory:new Map([['old',1]]),nativeRecordingRequests:new Map([['old',1]]),nativeRecordingRetryAt:new Map([['old',1]]),
 invalidateNativePartialReplay:clear=>{assert.equal(clear,true);replayInvalidations++;},invalidateEventSnapshotCaches:()=>{eventInvalidations++;},
 ptPrepareGatedRecording:()=>{throw Error('Metadata warming must not prepare a recording');},allowSnapshotGenerationChange:()=>true,
 module:{readSnapshotPublicationMeta:()=>null,createPublicSnapshotReader:options=>{assert.equal(options.baseUrl.href,'https://example.test/public-snapshots24/');notify=options.onGenerationChange;return reader;}},document:{baseURI:'https://example.test/',addEventListener(){},querySelector:()=>({content:'./public-snapshots24/'}),getElementById:()=>null},window:{location:{href:'https://example.test/'}},URL,Date,queueMicrotask,
 profileSnapshotEpoch:0,profileSnapshotResults:new Map(),profileSnapshotRequests:new Map(),profileSnapshotRetryAt:new Map(),profilePlacementRequests:new Map(),profileGuideCache:new Map(),snapshotTrackStatistics:{old:1},snapshotCosmeticEntries:{old:1},snapshotRacerDirectoryEntries:{old:1},publicSnapshotCapturedAt:1,cosmeticEpoch:0,overallCacheGeneration:0,overallEntriesCache:[],overallLoadState:{},updateTrackFreshnessBanner:()=>{},isElementVisible:()=>false,renderEntries:()=>{},decorateNativeLeaderboardCosmetics:()=>{}};
 vm.createContext(context);await vm.runInContext('(async()=>{'+source.slice(start,end).replace(/await import\([^;]+\)/,'recoveryLibrary')+'})()',context);await new Promise(resolve=>setImmediate(resolve));assert.equal(requests.length,4);
 notify();await new Promise(resolve=>setImmediate(resolve));assert.equal(requests.length,8);assert.equal(context.publicSnapshotCapturedAt,0);
 assert.equal(context.nativeRecordingEpoch,1);assert.equal(replayInvalidations,1);assert.equal(eventInvalidations,1);
 for(const cache of [context.nativeRecordingMemory,context.nativeRecordingRequests,context.nativeRecordingRetryAt])assert.equal(cache.size,0);
 for(const req of requests.slice(0,4))req.resolve({tracks:{retired:1},entries:{retired:1},capturedAt:'2020-01-01T00:00:00Z'});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(Object.keys(context.snapshotTrackStatistics).length,0);assert.equal(context.publicSnapshotCapturedAt,0);
 for(const req of requests.slice(4))req.resolve({tracks:{current:1},entries:{current:1},capturedAt:'2021-01-01T00:00:00Z'});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(context.snapshotTrackStatistics.current,1);assert.equal(context.snapshotCosmeticEntries.current,1);assert.equal(context.snapshotRacerDirectoryEntries.current,1);assert.equal(context.publicSnapshotCapturedAt,Date.parse('2021-01-01T00:00:00Z'));
});

test('metadata row replacement preserves page while normal ranking loads reset it',()=>{
 const start=source.indexOf('  function renderEntries(entries,snapshotMeta,'),end=source.indexOf('    const filterRoot=',start);assert(start>=0&&end>start);
 const context={document:{getElementById:()=>({})},overallEntriesCache:[],overallCategory:'overall',overallPage:3,overallLoadState:{},overlaySnapshotRacerDirectory:rows=>rows,setRankedFilterSnapshotMeta:()=>{}};
 vm.createContext(context);vm.runInContext(source.slice(start,end)+'\n}',context);
 context.renderEntries([{userId:'test'}],{},{preservePage:true});assert.equal(context.overallPage,3);
 context.renderEntries([{userId:'test'}],{});assert.equal(context.overallPage,0);
 const warm=source.slice(source.indexOf('      const recoveryModule=await import('),source.indexOf('      return reader;',source.indexOf('      const recoveryModule=await import(')));
 assert.equal((warm.match(/renderEntries\(overallEntriesCache,overallLoadState,\{preservePage:true\}\)/g)||[]).length,2);
});


test('retired profile requests cannot repopulate a newer generation or remove its pending request',async()=>{
 const id='a'.repeat(64),replies=[];
 const context={Map,Date,cleanUserId:x=>x,readPublicSnapshotBackup:()=>new Promise(resolve=>replies.push(resolve)),profileSnapshotEpoch:0};
 vm.createContext(context);const start=source.indexOf('  const profileSnapshotResults=new Map()'),end=source.indexOf('  function cachedProfileFinishes(',start);
 vm.runInContext(source.slice(start,end)+';globalThis.results=profileSnapshotResults;globalThis.requests=profileSnapshotRequests;',context);
 const old=context.loadProfileSnapshotResults(id);context.profileSnapshotEpoch++;context.requests.clear();const fresh=context.loadProfileSnapshotResults(id);
 replies[0]({accountId:id,results:[{trackId:'old'}]});assert.equal(await old,false);assert.equal(context.results.has(id),false);assert.equal(context.requests.has(id),true);
 replies[1]({accountId:id,results:[{trackId:'new'}]});assert.equal(await fresh,true);assert.equal(context.results.get(id).results[0].trackId,'new');assert.equal(context.requests.has(id),false);
});
