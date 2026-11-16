import fs from 'node:fs';import vm from 'node:vm';import test from 'node:test';import assert from 'node:assert/strict';
const s=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8').replace(/\r\n?/g,'\n');
const fn=name=>{const a=s.indexOf('  function '+name+'(');assert(a>=0,name);return s.slice(a,s.indexOf('\n  }',a)+4);};
const row=(trackId,fieldContribution,difference)=>({trackId,fieldContribution,difference});
function markup(summary){const h=vm.createContext({overallCategory:'field',fieldRpProfileSummary:()=>summary,trackInfo:id=>({name:id}),escapeHtml:String,
 formatRankingFieldRp:value=>value.toLocaleString('en-US',{maximumFractionDigits:0})});vm.runInContext(fn('categoryTrackMarkup'),h);return h.categoryTrackMarkup({});}
test('Field emits at most two distinct tracks, integer strongest and largest absolute other-track difference',()=>{
 const best=row('best',12345.67,10000),boost=row('boost',100,250.6),reduction=row('reduction',10,-500.9);
 const summary={known:true,best,tracks:[best,boost,reduction],positiveDifference:best,negativeDifference:reduction},before=JSON.stringify(summary),html=markup(summary);
 assert.equal((html.match(/data-track-id=/g)||[]).length,2);assert.match(html,/data-track-id="best"/);assert.match(html,/12,346/);
 assert.match(html,/data-track-id="reduction"/);assert.match(html,/Field reduction/);assert.match(html,/-501/);assert(!html.includes('data-track-id="boost"'));
 assert.match(html,/Current-model Field minus Overall contribution/);assert.match(html,/Not historical movement/);assert.equal(JSON.stringify(summary),before);
});
test('Field handles positive differences, deterministic absolute ties, only strongest, and unknown data',()=>{
 const best=row('best',1000,0),a=row('a',500,200.9),z=row('z',400,-200.9);
 const html=markup({known:true,best,tracks:[best,z,a]});assert.match(html,/data-track-id="a"/);assert.match(html,/Field boost/);assert.match(html,/\+201/);
 assert.equal((markup({known:true,best,tracks:[best]}).match(/data-track-id=/g)||[]).length,1);
 assert.equal((markup({known:false}).match(/data-track-id=/g)||[]).length,0);
 assert.equal((markup({known:true,best,tracks:[best,row('other',1,0)]}).match(/data-track-id=/g)||[]).length,1);
});
test('Field unit is concise but Experimental remains in the actual tooltip expression',()=>{
 assert.match(fn('renderEntryRow'),/field:'FIELD RP'/);assert(!fn('renderEntryRow').includes("field:'FIELD RP (EXPERIMENTAL)'"));
 assert(fn('renderEntryRow').includes("const scoreTitle=(overallCategory==='field'?'Experimental Field RP. ':'')"));
});
test('only Overall provisional status can substitute P for a known category rank',()=>{
 const functionSource=fn('renderEntryRow'),start=functionSource.indexOf('      const rankMarkup='),end=functionSource.indexOf('\n',start);
 const statement=functionSource.slice(start,end);assert(start>0);assert.match(statement,/provisional&&overallCategory==='overall'\?'P'/);
 const h=vm.createContext({filteredRank:null,filteredTotal:null,preservedGlobalRank:null,estimateTitle:'saved',escapeHtml:String,visibleRank:4,provisional:true,overallCategory:'veterans'});
 vm.runInContext(statement.replace('const rankMarkup=','globalThis.markup='),h);assert.match(h.markup,/>#4<\/span>/);
 h.overallCategory='overall';vm.runInContext(statement.replace('const rankMarkup=','globalThis.markup='),h);assert.match(h.markup,/>P<\/span>/);
 for(const category of ['medals','wins','tracks','field','casual','skill','consistency']){h.overallCategory=category;vm.runInContext(statement.replace('const rankMarkup=','globalThis.markup='),h);assert.match(h.markup,/>#4<\/span>/,category);}
});
test('missing snapshot date is silent, categorySince is not treated as snapshot date, movement survives',()=>{
 const h=vm.createContext({snapshotCaptureTimestamp:value=>Number.isSafeInteger(value)&&value>0?value:0,ageLabel:()=> '5 minutes ago',escapeHtml:String,movementMarkup:()=>'<move>+1</move>'});
 vm.runInContext(fn('categoryTrackObservationMarkup'),h);
 assert.equal(h.categoryTrackObservationMarkup({},1),'');assert.equal(h.categoryTrackObservationMarkup({categorySince:123},1),'');
 assert.equal(h.categoryTrackObservationMarkup({categoryMovement:1},1),'<move>+1</move>');
 const html=h.categoryTrackObservationMarkup({snapshotCapturedAt:123},1);assert.match(html,/Snapshot age: 5 minutes ago/);assert(!html.includes('Observed since'));assert(!html.includes('time unknown'));
 const moved=h.categoryTrackObservationMarkup({snapshotCapturedAt:123,categoryMovement:1},1);assert.match(moved,/<move>\+1<\/move>/);assert.match(moved,/Snapshot age/);
});
