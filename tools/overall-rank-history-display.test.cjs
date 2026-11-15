const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../polytrack_062_patch.js'),'utf8');
const block=source.slice(source.indexOf('  function observedRankState('),source.indexOf('  function refreshObservedRankLabels('));
const context=vm.createContext({Date:class extends Date{static now(){return 10000;}}});
vm.runInContext(block,context);
const entry={userId:'racer',rank:1};
const history={schemaVersion:1,directory:'public-snapshots88',observedAt:9000,rows:{racer:[1,1000,5]}};
test('uses saved observations instead of a reset rankSince',()=>{const row=context.observedRankState({...entry,rankSince:8500},history,'public-snapshots88');assert.equal(row.since,1000);assert.equal(row.until,9000);assert.equal(row.count,5);});
test('rejects different generation, rank and local projected rank',()=>{assert.equal(context.observedRankState(entry,history,'public-snapshots89'),null);assert.equal(context.observedRankState({...entry,rank:2},history,'public-snapshots88'),null);assert.equal(context.observedRankState({...entry,localEstimateOrigin:{rank:2}},history,'public-snapshots88'),null);});
test('rejects malformed or future history',()=>{for(const row of [[1,0,1],[1,9500,2],[1,1000,0],[1,1000,1.5]])assert.equal(context.observedRankState(entry,{...history,rows:{racer:row}},'public-snapshots88'),null);assert.equal(context.observedRankState(entry,{...history,observedAt:11000},'public-snapshots88'),null);});
test('history request is static, shared, and never uses Firebase',()=>{const block=source.slice(source.indexOf('  function loadOverallRankHistory('),source.indexOf('  function observedRankMarkup('));assert.match(block,/overallRankHistoryRequest/);assert.match(block,/tools\/overall-rank-history.json/);assert.doesNotMatch(block,/firestore|firebase|collection\(/i);});

test('a failed static request cannot leave newly rendered rows loading forever',async()=>{const document={querySelector:()=>({content:'./public-snapshots88/'}),querySelectorAll:()=>[]};const ctx=vm.createContext({document,URL,Date,fetch:async()=>({ok:false}),extraCatalogRevision:'test',eventsModuleUrl:'https://example.invalid/events/client.mjs',escapeHtml:String,durationLabel:String});vm.runInContext(source.slice(source.indexOf('  let overallRankHistory=null;'),source.indexOf('  function movementMarkup(')),ctx);ctx.loadOverallRankHistory();await vm.runInContext('overallRankHistoryRequest',ctx);assert.match(ctx.observedRankMarkup(entry),/History unavailable/);assert.doesNotMatch(ctx.observedRankMarkup(entry),/Loading rank history/);});

test('a new snapshot has a distinct history cache key even without a site revision',()=>{assert.match(source,/overall-rank-history\.json\?v='\+extraCatalogRevision\+'&snapshot='\+directory/);});
