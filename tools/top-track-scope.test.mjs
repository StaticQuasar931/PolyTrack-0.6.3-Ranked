import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const start=source.indexOf('  function topTrackRowsForScope(');
const code=source.slice(start,source.indexOf('\n  let overallRacerQuery=',start));
assert.ok(start>0&&code.length<2000);
function harness(){
 const kinds={official:'official',community:'community',extra:'community',custom:'custom',archive:'custom',dynamic:'custom'};
 const ctx=vm.createContext({overallTopTrackScope:'all',PINNED_EXTRA_TRACK_IDS:new Set(['extra']),extraTrackInfoById:new Map([['dynamic',{}]]),
  trackInfo:id=>({type:kinds[id]||'custom'}),annotateCategoryRanks:(rows,key)=>rows.map((row,i)=>({...row,categoryRank:i+1,key}))});
 vm.runInContext(code,ctx);return ctx;
}
test('Top Tracks scopes use canonical membership, retain order and rank the selected field',()=>{
 const h=harness(),rows=['official','extra','community','archive','dynamic','custom'].map((trackId,i)=>({trackId,type:'extra',weight:10-i,categoryRank:i+1}));
 const original=JSON.stringify(rows);
 assert.equal(h.topTrackRowsForScope(rows),rows);
 assert.deepEqual(Array.from(h.topTrackRowsForScope(rows,'official'),row=>[row.trackId,row.categoryRank]),[['official',1]]);
 assert.deepEqual(Array.from(h.topTrackRowsForScope(rows,'community'),row=>[row.trackId,row.categoryRank]),[['community',1]]);
 assert.deepEqual(Array.from(h.topTrackRowsForScope(rows,'extra'),row=>[row.trackId,row.categoryRank]),[['extra',1],['dynamic',2]]);
 assert.equal(h.topTrackRowsForScope(rows,'invalid'),rows);
 assert.equal(JSON.stringify(rows),original);
});
test('Top Tracks scope applies equally to rows and page counts without changing completion scope',()=>{
 assert.equal((source.match(/personalTrackRankingRows\(topTrackRowsForScope\(loadedTrackRankingRows\(\)\)\)/g)||[]).length,2);
 const handler=source.slice(source.indexOf("      if(topScope&&overallCategory==='topTracks')"),source.indexOf('      if(scope){',source.indexOf("      if(topScope&&overallCategory==='topTracks')")));
 assert.match(handler,/overallPage=0/);assert.doesNotMatch(handler,/overallCompletionScope=|overallCategory='tracks'|fetch|\.get\(/);
 assert.match(source,/aria-label','Track types for Top Tracks'/);
});
