
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDeveloperReport} from './developer-diagnostics.mjs';
import {createPracticeHistory,practiceAdvice} from './practice-history.mjs';
const id='a'.repeat(64),track='b'.repeat(64);

test('viewport diagnostics retain bounded signed offsets without unrelated browser data',()=>{
 const report=buildDeveloperReport({viewport:{width:440,height:780,pixelRatio:3,clientWidth:440,visualLeft:26.1234,scrollX:-12.345,visualScale:Infinity,visualHeight:1000001,userAgent:'private-browser-data'}});
 assert.deepEqual(report.viewport,{width:440,height:780,pixelRatio:3,clientWidth:440,visualLeft:26.12,scrollX:-12.34});
 assert.doesNotMatch(JSON.stringify(report),/private-browser-data|userAgent/);
 assert.deepEqual(buildDeveloperReport({viewport:null}).viewport,{width:0,height:0,pixelRatio:0});
});
test('developer export is an explicit whitelist, not a local storage or console dump',()=>{
 const report=buildDeveloperReport({publicId:id,email:'secret@test',token:'password',events:[{category:'snapshot',code:'PROFILE',message:'token=password',url:'https://private.test?token=x'}],practice:[{trackId:track,activeMs:100,ownerUid:'secret',replay:'secret',recentFinishes:[{timeMs:10,practiceMs:100,password:'secret'}]}]});
 const text=JSON.stringify(report);assert.doesNotMatch(text,/secret|password|private.test|ownerUid|publicRacerId/);assert.equal(report.privacy.automaticUpload,false);
 assert.equal(buildDeveloperReport({publicId:id,includePublicId:true}).publicRacerId,id);
});
test('missing placement and weight stay unknown instead of becoming zero',()=>{
 const row=buildDeveloperReport({finishes:[{rank:null,fieldSize:null,weight:null}]}).loadedResults[0];
 assert.equal(row.rank,null);assert.equal(row.fieldSize,null);assert.equal(row.weight,null);assert.equal(row.placementKnown,false);
});
test('feature coverage does not turn pre-feature lifetime time into observations',()=>{
 const h=createPracticeHistory({now:()=>100000});h.observeCoverage(id,60*3600000);h.observeCoverage(id,60*3600000+60000,60000);
 const c=h.coverage(id);assert.equal(c.baselinePlaytimeMs,60*3600000);assert.equal(c.observedVisibleMs,60000);assert.ok(c.coverageFraction<.001);
});
test('practice v2 measures actual sampled active time separately from simulation time',()=>{
 const h=createPracticeHistory({now:()=>100000}),a=h.begin(id,track);a.tick(50,1,1000);a.finish(50);
 const row=h.get(id,track);assert.equal(row.activeMs,1000);assert.equal(row.simulatedMs,50);assert.equal(row.recentFinishes[0].timingNote,false);
});
test('large timing differences are local review notes only and require reliable continuous sampling',()=>{
 for(const reliable of [false,true]){const h=createPracticeHistory({now:()=>100000}),a=h.begin(id,track);for(let i=0;i<80;i++)a.tick(100,1,1000);a.finish(8000,{reliable});const r=h.get(id,track);assert.equal(r.recentFinishes[0].timingNote,reliable);assert.equal(r.finishes,1);assert.equal(r.pbs,1);}
});
test('recent finish history is bounded, exported by copy, and can gently influence practice advice',()=>{
 const h=createPracticeHistory({now:()=>100000});for(let i=0;i<12;i++){const a=h.begin(id,track);a.tick(1000);a.finish(20000-i*100);}
 assert.equal(h.get(id,track).recentFinishes.length,8);const list=h.list(id);list[0].recentFinishes[0].timeMs=1;assert.notEqual(h.get(id,track).recentFinishes[0].timeMs,1);
 const advice=practiceAdvice({...h.get(id,track),attempts:12,activeMs:600000},100000);assert.ok(advice.factor>=.9&&advice.factor<=1.1);
});

test('invalid infinite placements are never exported as known results',()=>{const row=buildDeveloperReport({finishes:[{rank:Infinity,fieldSize:Infinity}]}).loadedResults[0];assert.equal(row.rank,null);assert.equal(row.fieldSize,null);assert.equal(row.placementKnown,false);});
test('coverage survives reload without counting baseline time twice',()=>{let value;const storage={getItem:()=>value,setItem:(_k,v)=>{value=v}};const h=createPracticeHistory({storage,now:()=>100000});h.observeCoverage(id,3601000,1000);h.flush(true);const again=createPracticeHistory({storage,now:()=>101000}).coverage(id);assert.equal(again.baselinePlaytimeMs,3600000);assert.equal(again.observedVisibleMs,1000);});
