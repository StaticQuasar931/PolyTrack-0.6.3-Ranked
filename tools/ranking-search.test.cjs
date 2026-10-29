const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../polytrack_062_patch.js'),'utf8');
const extract=name=>{const a=source.indexOf('  function '+name+'(');assert.ok(a>0);return source.slice(a,source.indexOf('\n  }',a)+4);};
function fixture(){
  const rows=Array.from({length:200},(_,i)=>({userId:'racer-'+(i+1),name:'Driver '+(i+1),rank:i+1,score:i+0.5}));
  const c={overallRacerQuery:'',overallCategory:'overall',rankedFilterResult:null,sortedOverallEntries:()=>rows,sortedEventEntries:()=>rows,
    loadedTrackRankingRows:()=>rows,personalTrackRankingRows:rows=>rows};
  vm.createContext(c);vm.runInContext(extract('searchRankingRows')+extract('currentLeaderboardCount'),c);return {c,rows};
}
test('search covers later pages and preserves real rank and score',()=>{
  const {c,rows}=fixture();c.overallRacerQuery='Driver 191';
  const result=c.searchRankingRows(rows);assert.equal(result.length,1);assert.equal(result[0],rows[190]);
  assert.equal(result[0].rank,191);assert.equal(result[0].score,190.5);assert.equal(c.currentLeaderboardCount(),1);
});
test('plain text finds stylized and accented names, public IDs and all search words',()=>{
  const {c}=fixture(),rows=[{name:'𝔚𝔦𝔫𝔱𝔢𝔯 Café',userId:'public-123'},{name:'Other'}];
  for(const query of ['winter cafe','PUBLIC-123','cafe winter']){c.overallRacerQuery=query;assert.equal(c.searchRankingRows(rows)[0],rows[0]);}
});
test('query is literal text, not executable markup or a regular expression',()=>{
  const {c}=fixture(),row={name:'<img onerror=x> [.*]'};
  for(const query of ['<img','[.*]']){c.overallRacerQuery=query;assert.equal(c.searchRankingRows([row])[0],row);}
  c.overallRacerQuery='.*';assert.equal(c.searchRankingRows([{name:'ordinary'}]).length,0);
});
test('blank search preserves the original rows and Top Tracks can match a leader',()=>{
  const {c,rows}=fixture();c.overallRacerQuery='  ';assert.equal(c.searchRankingRows(rows),rows);
  c.overallRacerQuery='friend';assert.equal(c.searchRankingRows([{name:'Track',leader:{nickname:'Friend'}}]).length,1);
});
test('search is counted consistently across Overall, Event RP, Top Tracks and active filters',()=>{
  const {c,rows}=fixture();c.overallRacerQuery='Driver 191';
  for(const category of ['overall','events','topTracks']){c.overallCategory=category;assert.equal(c.currentLeaderboardCount(),1);}
  c.overallCategory='overall';c.rankedFilterResult={available:true,filter:{category:'overall'},rows:rows.slice(0,20)};assert.equal(c.currentLeaderboardCount(),0);
  c.overallCategory='events';c.rankedFilterResult={available:true,filter:{category:'events'},rows:[rows[190]]};assert.equal(c.currentLeaderboardCount(),1);
});
