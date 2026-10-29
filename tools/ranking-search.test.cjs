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

test('score comparisons combine with names, preserve row identity and support all operators',()=>{
  const {c}=fixture(),rows=[{name:'Friend A',score:3.19},{name:'Friend B',score:3.2},{name:'Other',score:4}];
  for(const [query,expected]of [['friend >3.19',[rows[1]]],['rp:<=3.19',[rows[0]]],['score:3.2',[rows[1]]],['>=4',[rows[2]]],['!=3.19',[rows[1],rows[2]]],['"Friend A"',[rows[0]]]]){
    c.overallRacerQuery=query;assert.deepEqual(Array.from(c.searchRankingRows(rows)),expected,query);assert.equal(c.searchRankingRows.error,'');
  }
});

test('duration filters use hours by default, support explicit units, and never invent missing values',()=>{
  const {c}=fixture(),rows=[{name:'Long',totalPlaytimeMs:43*3600000},{name:'Short',totalPlaytimeMs:30*60000},{name:'Unknown'},{name:'Null',totalPlaytimeMs:null},{name:'Zero',totalPlaytimeMs:0}];
  for(const query of ['playtime:>42h','time:>42','playtime:>1.75d','playtime:>=2580m']){
    c.overallRacerQuery=query;assert.deepEqual(Array.from(c.searchRankingRows(rows)),[rows[0]],query);
  }
  c.overallRacerQuery='playtime:<1h';assert.deepEqual(Array.from(c.searchRankingRows(rows)),[rows[1],rows[4]]);
  c.overallCategory='playtime';c.overallRacerQuery='>42h';assert.deepEqual(Array.from(c.searchRankingRows(rows)),[rows[0]]);
});

test('bare comparisons follow the visible category, rank and weight use published numbers',()=>{
  const {c}=fixture(),a={rp:900,score:2,categoryRank:3,rank:8,weight:6,fieldSize:42,officialCount:17},b={rp:100,score:4,categoryRank:9,rank:4,weight:2,fieldSize:2};
  for(const [category,query,expected]of [['events','>500',[a]],['topTracks','>3',[a]],['topTracks','weight:>3',[a]],['overall','>3',[b]],['overall','rank:<=3',[a]],['topTracks','players:>10',[a]],['overall','official:>=17',[a]]]){
    c.overallCategory=category;c.overallRacerQuery=query;assert.deepEqual(Array.from(c.searchRankingRows([a,b])),expected);
  }
  c.overallRacerQuery='rank:<10';assert.equal(c.searchRankingRows([{categoryRank:null,rank:1}]).length,0);
});

test('invalid filters report concise guidance, are bounded and never execute expressions',()=>{
  const {c,rows}=fixture();
  for(const query of ['playtime:>oops','rp:>3h','playtime:>3%','>>3','score:>Infinity','score:>1e9','score:>1;alert(1)']){
    c.overallRacerQuery=query;assert.equal(c.searchRankingRows(rows).length,0,query);assert.ok(c.searchRankingRows.error,query);
  }
  c.overallRacerQuery='';assert.equal(c.searchRankingRows(rows),rows);assert.equal(c.searchRankingRows.error,'');
});
