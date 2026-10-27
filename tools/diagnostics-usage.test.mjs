import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalInsights} from './local-insights.mjs';
import {summarizeClientUsage} from './diagnostics-usage.mjs';
import {wrapFirestoreUsage,FIREBASE_USAGE_COVERAGE} from './firebase-usage.mjs';
import {buildDeveloperReport} from './developer-diagnostics.mjs';
const track='a'.repeat(64);

test('usage exports disclose coverage and unknown backend/billing totals even without samples',()=>{
 for(const insights of [null,{version:1},{version:1,clientUsage:{version:999,startedAt:0}}]){
  const report=buildDeveloperReport({insights});
  assert.equal(report.firebaseUsage.available,false);
  assert.deepEqual(report.firebaseUsage.coverage,FIREBASE_USAGE_COVERAGE);
  assert.match(report.firebaseUsage.coverage.serverProjectUsage,/Unknown/);
  assert.match(report.firebaseUsage.coverage.billedUsage,/Unavailable/);
  assert.match(report.firebaseUsage.coverage.listeners,/Uninstrumented/);
  assert.equal(report.firebaseUsage.estimatedDocuments,null);
  report.firebaseUsage.coverage.scope='modified export';
  assert.notEqual(FIREBASE_USAGE_COVERAGE.scope,'modified export');
 }
});

test('acknowledged deletes reach the exported estimate without becoming billed usage',async()=>{
 const h=createLocalInsights({now:()=>1000});
 const database={doc:()=>({delete:()=>Promise.resolve()})};
 await wrapFirestoreUsage(database,{observeUsage:h.observeUsage,now:()=>0}).doc().delete();
 const insights=h.report(),before=structuredClone(insights);
 const usage=buildDeveloperReport({insights}).firebaseUsage;
 assert.equal(usage.observedOperations.firestore,1);
 assert.deepEqual(usage.estimatedDocuments,{reads:0,writes:1,unknownReadOperations:0,unknownWriteOperations:0});
 assert.deepEqual(usage.billed,{reads:null,writes:null,cost:null});
 assert.match(usage.coverage.deletes,/Acknowledged/);
 assert.deepEqual(insights,before);
});

test('opting out reports omitted per-profile PBs without exporting them',()=>{
 const localData={profiles:[{publicId:'racer',personalBests:[{trackId:track,timeMs:10},{trackId:track,timeMs:20}]},{personalBests:null}]};
 const before=structuredClone(localData),report=buildDeveloperReport({localData});
 assert.equal(report.localData,null);
 assert.equal(report.truncation.localPersonalBests.omitted,2);
 assert.equal(buildDeveloperReport({localData,includePublicId:true}).truncation.localPersonalBests.omitted,0);
 assert.deepEqual(localData,before);
});

test('legacy HTTP/latency counters do not imply Firebase document or billed totals',()=>{
 const h=createLocalInsights({now:()=>1000});for(let i=0;i<100;i++)h.measure('TRACK',1);
 const report=buildDeveloperReport({insights:h.report(),events:[{category:'snapshot',code:'TRACK',durationMs:1}]});
 assert.equal(report.firebaseUsage.available,false);assert.equal(report.firebaseUsage.estimatedDocuments,null);
 assert.deepEqual(report.firebaseUsage.billed,{reads:null,writes:null,cost:null});
 assert.equal(report.insights.metrics.TRACK.count,100);
});
test('explicit document estimates, zero snapshot/cache cost, unknown worker fanout and elapsed averages remain distinct',()=>{
 let at=1000;const h=createLocalInsights({now:()=>at});
 h.observeUsage({source:'snapshot',durationMs:10.25});h.observeUsage({source:'cache',durationMs:1.25});
 h.observeUsage({source:'firestore',reads:3,writes:0,durationMs:30.5});
 h.observeUsage({source:'firestore',reads:0,writes:2,durationMs:8});
 h.observeUsage({source:'worker',durationMs:10});at+=3600000;
 const usage=summarizeClientUsage(h.report().clientUsage,at);
 assert.deepEqual(usage.observedOperations,{snapshot:1,cache:1,firestore:2,worker:1});
 assert.deepEqual(usage.estimatedDocuments,{reads:3,writes:2,unknownReadOperations:1,unknownWriteOperations:1});
 assert.deepEqual(usage.elapsedAverages,{knownEstimatedReadsPerHour:3,knownEstimatedWritesPerHour:2});
 assert.deepEqual(usage.observedOperationTiming,{samples:5,totalMs:60,averageMs:12});
 assert.equal(usage.billed.reads,null);assert.match(usage.limitations,/may overlap/);
});
test('unknown SDK dimensions and missing duration samples are not invented as measured zeros',()=>{
 const h=createLocalInsights({now:()=>1000});h.observeUsage({source:'firestore'});
 const usage=summarizeClientUsage(h.report().clientUsage,1000);
 assert.equal(usage.estimatedDocuments.unknownReadOperations,1);assert.equal(usage.estimatedDocuments.unknownWriteOperations,1);
 assert.equal(usage.observedOperationTiming.samples,0);assert.equal(usage.observedOperationTiming.averageMs,null);
 assert.equal(usage.elapsedAverages.knownEstimatedReadsPerHour,null);
});
test('invalid instrumentation is ignored and private arbitrary fields never enter usage output',()=>{
 const h=createLocalInsights({now:()=>1000});
 for(const record of [{source:'https://private.invalid'},{source:'snapshot',reads:1},{source:'worker',writes:3},{source:'firestore',reads:-1},{source:'firestore',writes:1.5},{source:'firestore',durationMs:Infinity}])assert.equal(h.observeUsage(record),false);
 assert.equal(h.report().clientUsage,undefined);
 h.observeUsage({source:'snapshot',durationMs:1,token:'private-token',url:'private-url'});
 assert.doesNotMatch(JSON.stringify(buildDeveloperReport({insights:h.report()})),/private-token|private-url|private.invalid/);
});
test('raw usage precision persists through storage; report generation never mutates it',()=>{
 let saved,at=1000;const storage={getItem:()=>saved,setItem:(_,value)=>{saved=value;}};
 const h=createLocalInsights({storage,now:()=>at});h.observeUsage({source:'firestore',reads:1,writes:0,durationMs:1.23456});h.flush(true);
 const before=saved;buildDeveloperReport({insights:h.report()});assert.equal(saved,before);
 assert.equal(JSON.parse(saved).clientUsage.buckets.firestore.durationMs,1.23456);
 at+=1000;const restored=createLocalInsights({storage,now:()=>at});
 assert.equal(restored.report().clientUsage.buckets.firestore.operations,1);
 assert.equal(summarizeClientUsage(restored.report().clientUsage,at).estimatedDocuments.reads,1);
});
test('export-only millisecond rounding preserves useful history and exact exported summary arithmetic',()=>{
 const practice=[{trackId:track,activeMs:1.4,focusedMs:2.7,attempts:2,finishes:1,pbs:1,restarts:1,respawns:2,recentFinishes:[{timeMs:2.4,practiceMs:1.4}]},
  {trackId:'b'.repeat(64),activeMs:2.4,attempts:1,finishes:0}];
 const before=structuredClone(practice),report=buildDeveloperReport({practice,localData:{practice},includePublicId:true,insights:{version:1,metrics:{TRACK:{count:1,totalMs:3.456,maxMs:3.456}}},events:[{category:'snapshot',code:'TRACK',durationMs:1.234}]});
 assert.deepEqual(practice,before);assert.equal(report.practiceSummary.activeMs,3);
 assert.equal(report.practiceSummary.activeMs,report.practice.reduce((n,row)=>n+row.activeMs,0));
 assert.equal(report.practice[0].recentFinishes[0].timeMs,2);assert.equal(report.practice[0].recentFinishes[0].practiceMs,1);
 assert.equal(report.localData.practice[0].focusedMs,3);assert.equal(report.insights.metrics.TRACK.totalMs,3);assert.equal(report.recentEvents[0].durationMs,1);
 assert.equal(report.practiceSummary.finishes,1);assert.equal(report.practiceSummary.resets,3);
});
