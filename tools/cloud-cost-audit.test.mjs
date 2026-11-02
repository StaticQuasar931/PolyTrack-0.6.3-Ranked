import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudCostAudit} from './cloud-cost-audit.mjs';
const op=(overrides={})=>({message:['Ranked Firestore operation',JSON.stringify({schemaVersion:1,scope:'pb_notify',documentReadEstimate:2,writeEstimate:0,deleteEstimate:0,collections:{'0.6.2_race_results':2},...overrides})]});
const event=(logs=[op()])=>({logs,outcome:'ok',event:{request:{url:'https://example.invalid/private-user?token=secret',headers:{authorization:'Bearer secret'}}}});
test('pretty and line-delimited tail events stream across arbitrary chunk boundaries',()=>{
 const audit=createCloudCostAudit(),text='Wrangler connected\n'+JSON.stringify(event(),null,2)+'\n'+JSON.stringify(event());
 for(let i=0;i<text.length;i+=7)audit.push(text.slice(i,i+7));
 const r=audit.result();assert.equal(r.invocations,2);assert.equal(r.total.knownReads,4);assert.equal(r.incompleteEvent,false);
 assert.doesNotMatch(JSON.stringify(r),/secret|authorization|private-user|example\.invalid/);
});
test('request and background aggregates never double-count individual operations',()=>{
 const audit=createCloudCostAudit();audit.push(JSON.stringify(event([op(),{message:['Ranked request Firestore reads',JSON.stringify({documentReadEstimate:2})]},{message:['Ranked background Firestore reads',JSON.stringify({documentReadEstimate:99})]}])));
 assert.equal(audit.result().total.knownReads,2);assert.equal(audit.result().total.operations,1);
});
test('failed unknown operations remain explicitly unknown rather than zero-cost claims',()=>{
 const audit=createCloudCostAudit();audit.push(JSON.stringify(event([op({documentReadEstimate:null,writeEstimate:null,collections:{'0.6.2_race_results':null}})])));
 const r=audit.result();assert.equal(r.total.unknownReadOperations,1);assert.equal(r.total.unknownWriteOperations,1);assert.equal(r.byCollection['0.6.2_race_results'].unknownReadOperations,1);
});
test('write and delete collection costs and scheduled zero-record invocations stay separate',()=>{
 const audit=createCloudCostAudit();audit.push(JSON.stringify({event:{cron:'* * * * *'},outcome:'ok',logs:[]}));
 audit.push(JSON.stringify(event([op({documentReadEstimate:0,writeEstimate:3,deleteEstimate:1,collections:{},writeCollections:{'0.6.2_profiles_public':{writes:3,deletes:1}}})])));
 const r=audit.result();assert.equal(r.total.knownWrites,3);assert.equal(r.total.knownDeletes,1);assert.equal(r.scheduled,1);assert.equal(r.withoutOperationRecords,1);assert.equal(r.byCollection['0.6.2_profiles_public'].knownWrites,3);
});
test('malformed, oversized and truncated log events are reported and recovery is bounded',()=>{
 const audit=createCloudCostAudit({maxEventChars:128});audit.push('{bad}\n'+JSON.stringify(event())+'\n'+JSON.stringify({logs:[],outcome:'ok'})+'\n{"logs":[');
 const r=audit.result();assert.equal(r.malformed,1);assert.equal(r.oversized,1);assert.equal(r.incompleteEvent,true);assert.equal(r.invocations,1);
});
test('quotes, braces, prototype-like names and unknown scopes cannot leak or corrupt output',()=>{
 const audit=createCloudCostAudit();const collections=JSON.parse('{"__proto__":4,"user-private-id":2}');
 audit.push(JSON.stringify(event([op({scope:'private-account-id',collections})])));
 const r=audit.result();assert.equal(r.byScope.unknown.knownReads,2);assert.equal(r.byCollection.other.knownReads,6);assert.doesNotMatch(JSON.stringify(r),/private-account|user-private|__proto__/);
});
