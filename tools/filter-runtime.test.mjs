import test from 'node:test';
import assert from 'node:assert/strict';
import {createFilterRuntime,groupScoreRows,GROUP_FILTER_KEY} from './filter-runtime.mjs';

const players=[{accountId:'a',score:10,rank:1,raceCount:1,countryCode:'US'},{accountId:'b',score:20,rank:2,raceCount:1,countryCode:'CA'},{accountId:'c',score:30,rank:3,raceCount:1,countryCode:'CA'}];
const board={trackId:'summer',weight:2,type:'official',complete:true,entries:[{accountId:'a',timeMs:1000,rank:1},{accountId:'b',timeMs:2000,rank:2},{accountId:'c',timeMs:3000,rank:3}]};
function fixture(){
 const stored=new Map();let changes=0;
 const storage={getItem:k=>stored.get(k),setItem:(k,v)=>stored.set(k,v)};
 const runtime=createFilterRuntime({storage,getData:()=>({key:'v1',profiles:players,boards:[board],finishes:board.entries.map(row=>({...row,trackId:'summer'}))}),onChange:()=>changes++});
 return {runtime,storage,get changes(){return changes;}};
}
test('normal visibility preserves scores and global positions; pause restores everyone',()=>{
 const {runtime}=fixture();runtime.setFilter({blacklist:['a']});
 const result=runtime.apply(board.entries,{trackId:'summer',complete:true});
 assert.deepEqual(result.rows.map(row=>row.rank),[2,3]);assert.equal(result.filteredCount,2);
 assert.equal(runtime.apply(players,{overall:true,category:'overall'}).rows[0].score,20);
 runtime.toggle();assert.equal(runtime.apply(players,{overall:true}).rows.length,3);
});
test('smart group recalculates softened scores without touching originals',()=>{
 const scored=groupScoreRows(players,[board],['b','c']);
 assert.equal(scored[1].groupResults[0].rank,1);assert.equal(scored[2].groupResults[0].rank,2);
 assert.ok(scored[1].groupScore<scored[2].groupScore);
 assert.equal(players[1].score,20);assert.equal(board.entries[1].rank,2);
 const {runtime}=fixture();runtime.setFilter({mode:'smart',grading:'group',blacklist:['a']});
 const result=runtime.apply(players,{overall:true,category:'overall',complete:true});
 assert.equal(result.rows[0].accountId,'b');assert.equal(result.rows[0].filteredRank,1);
 assert.equal(result.rows[0].globalScore,20);assert.notEqual(result.rows[0].score,20);
});
test('grading is independent in normal mode and event totals never invent lifetime points',()=>{
 const {runtime}=fixture();runtime.setFilter({grading:'group',blacklist:['a']});
 assert.deepEqual(runtime.apply(board.entries,{trackId:'summer'}).rows.map(row=>row.rank),[1,2]);
 runtime.setFilter({mode:'smart',blacklist:['a']});
 const events=players.map(row=>({...row,rp:100-row.rank}));
 const result=runtime.apply(events,{overall:true,event:true});
 assert.equal(result.scoringUnavailable,true);assert.equal(result.rows[0].rp,98);
});
test('track-specific completeness prevents false unfinished membership',()=>{
 const {runtime}=fixture();runtime.setFilter({trackRules:[{trackId:'unknown',state:'missing'}]});
 const result=runtime.apply(players,{overall:true,complete:true});
 assert.equal(result.rows.length,0);assert.equal(result.incomplete,true);
});
test('scope overall includes event totals but not track boards, filters persist locally',()=>{
 const {runtime,storage}=fixture();runtime.setFilter({scope:'overall',blacklist:['a']});
 assert.equal(runtime.apply(board.entries,{trackId:'summer',event:true}).rows.length,3);
 assert.equal(runtime.apply(players,{overall:true,event:true}).rows.length,2);
 assert.deepEqual(JSON.parse(storage.getItem(GROUP_FILTER_KEY)).blacklist,['a']);
});
test('a new version invalidates cached presentation and unknown group RP is not replaced by global RP',()=>{
 const {runtime}=fixture();runtime.setFilter({mode:'smart',whitelist:['b']});
 const source=[{accountId:'b',score:20,rank:2,raceCount:2}];
 const first=runtime.apply(source,{overall:true});assert.equal(first.incomplete,true);
 assert.strictEqual(first,runtime.apply(source,{overall:true}));runtime.invalidate();
 assert.notStrictEqual(first,runtime.apply(source,{overall:true}));
});
test('normal category ties and lifetime event ties retain competition places in a group',()=>{
 const {runtime}=fixture();runtime.setFilter({grading:'group',blacklist:['a']});
 const events=[{accountId:'b',rp:25,rank:2},{accountId:'c',rp:25,rank:2}];
 assert.deepEqual(runtime.apply(events,{overall:true,event:true,complete:true}).rows.map(row=>row.rank),[1,1]);
 const tied=players.slice(1).map(row=>({...row,categoryRank:2}));
 assert.deepEqual(runtime.apply(tied,{overall:true,category:'wins',complete:true}).rows.map(row=>row.filteredRank),[1,1]);
});
test('event group ERP uses linear canonical scaling and never overwrites published ERP',()=>{
 const {runtime}=fixture();runtime.setFilter({mode:'smart',grading:'group',whitelist:['b','c']});
 const source=[{accountId:'b',timeMs:2000,rank:2,rp:200},{accountId:'c',timeMs:4000,rank:3,rp:100}];
 const result=runtime.apply(source,{trackId:'summer',event:true,maxRp:700,complete:true});
 assert.deepEqual(result.rows.map(row=>row.groupRp),[700,350]);
 assert.deepEqual(result.rows.map(row=>row.rp),[200,100]);assert.equal(source[0].rank,2);
});
test('missing weights do not fabricate a ranked score',()=>{
 const unknown={trackId:'unknown',entries:[{accountId:'b',timeMs:1000}]};
 const result=groupScoreRows(players,[unknown],['b']);
 assert.equal(result[1].groupScore,null);assert.equal(result[1].groupScoreIncomplete,true);
});

test('track weight overrides only change local smart group scores',()=>{
 const boards=[
  {trackId:'one',weight:1,type:'official',complete:true,entries:[
   {accountId:'a',timeMs:1000},{accountId:'b',timeMs:2000},{accountId:'c',timeMs:3000}]},
  {trackId:'two',weight:1,type:'official',complete:true,entries:[
   {accountId:'c',timeMs:1000},{accountId:'b',timeMs:2000},{accountId:'a',timeMs:3000}]}
 ];
 const base=groupScoreRows(players,boards,['a','b','c']);
 const weighted=groupScoreRows(players,boards,['a','b','c'],[{trackId:'one',weight:5}]);
 assert.equal(weighted[0].groupResults.find(result=>result.trackId==='one').weight,5);
 assert.equal(weighted[0].groupResults.find(result=>result.trackId==='two').weight,1);
 assert.notEqual(weighted[0].groupScore,base[0].groupScore);
 assert.equal(boards[0].weight,1);
 const {runtime}=fixture();
 runtime.setFilter({mode:'normal',trackWeights:[{trackId:'summer',weight:20}]});
 assert.equal(runtime.apply(players,{overall:true,category:'overall'}).rows[0].score,10);
 runtime.setFilter({mode:'smart',trackRules:[{trackId:'summer',state:'any',weight:7}]});
 const weightedView=runtime.apply(players,{overall:true,category:'overall',complete:true});
 assert.equal(weightedView.active,true);
 assert.equal(weightedView.rows[0].groupResults[0].weight,7);
});

test('created and loaded timestamps persist locally without changing legacy filter behavior',()=>{
 const {runtime,storage}=fixture();
 runtime.setFilter({whitelist:['a']});
 const saved=JSON.parse(storage.getItem(GROUP_FILTER_KEY));
 assert.ok(Number.isSafeInteger(saved.createdAt));
 assert.equal(saved.loadedAt,null);
 runtime.markLoaded(123456);
 const loaded=JSON.parse(storage.getItem(GROUP_FILTER_KEY));
 assert.equal(loaded.createdAt,saved.createdAt);
 assert.equal(loaded.loadedAt,123456);
});
