import test from 'node:test';import assert from 'node:assert/strict';import {fullSnapshotPolicy,readOnlySnapshotQueryDb} from './full-snapshot-policy.mjs';
const policy={version:1,authorized:true,canonicalMode:'full',canonicalDocumentLimit:10000,profileDocumentLimit:2000,trackCheckLimit:512,eventReplayLimit:256,publishedBaseline:{generation:75,indexSha256:'a'.repeat(64)}};
test('full capture requires exact approved budget and independently pinned previous generation',()=>{assert.deepEqual(fullSnapshotPolicy({fullSnapshotPolicy:policy}),policy);for(const patch of [{authorized:false},{canonicalDocumentLimit:50000},{profileDocumentLimit:5001},{canonicalMode:'partial'},{publishedBaseline:{generation:0,indexSha256:'a'.repeat(64)}},{publishedBaseline:{generation:75,indexSha256:'bad'}}])assert.throws(()=>fullSnapshotPolicy({fullSnapshotPolicy:{...policy,...patch}}));});
test('query capability rejects writes, foreign collections, group scans, offsets and oversized pages before transport',async()=>{let calls=0;const db=readOnlySnapshotQueryDb({call:async()=>calls++}),body={structuredQuery:{from:[{collectionId:'0.6.2_race_results'}],limit:100}};await db.call(':runQuery',body);assert.equal(calls,1);for(const [route,value] of [[':commit',{}],[':batchGet',{}],[':runQuery',{structuredQuery:{from:[{collectionId:'private'}],limit:1}}],[':runQuery',{structuredQuery:{...body.structuredQuery,limit:101}}],[':runQuery',{structuredQuery:{...body.structuredQuery,offset:1}}],[':runQuery',{structuredQuery:{...body.structuredQuery,from:[{collectionId:'0.6.2_race_results',allDescendants:true}]}}]])assert.throws(()=>db.call(route,value));assert.equal(calls,1);});


test('30000 canonical rows require the same exact authorization, sublimits and baseline pins',()=>{
 const approved={...policy,canonicalDocumentLimit:30000};const result=fullSnapshotPolicy({fullSnapshotPolicy:approved});assert.deepEqual(result,approved);result.publishedBaseline.generation++;assert.equal(approved.publishedBaseline.generation,75);
 for(const canonicalDocumentLimit of [24536,29999,30001,35000])assert.throws(()=>fullSnapshotPolicy({fullSnapshotPolicy:{...approved,canonicalDocumentLimit}}));
 for(const patch of [{authorized:false},{profileDocumentLimit:2001},{trackCheckLimit:513},{eventReplayLimit:257},{publishedBaseline:{generation:75,indexSha256:'bad'}}])assert.throws(()=>fullSnapshotPolicy({fullSnapshotPolicy:{...approved,...patch}}));
 for(const canonicalDocumentLimit of [10000,20000])assert.equal(fullSnapshotPolicy({fullSnapshotPolicy:{...policy,canonicalDocumentLimit}}).canonicalDocumentLimit,canonicalDocumentLimit);
});


test('tonight accepts exact 30000 canonical and 5000 profile limits without relaxing other policy gates',()=>{
 const tonight={...policy,canonicalDocumentLimit:30000,profileDocumentLimit:5000};assert.deepEqual(fullSnapshotPolicy({fullSnapshotPolicy:tonight}),tonight);
 for(const patch of [{profileDocumentLimit:4999},{profileDocumentLimit:5001},{canonicalDocumentLimit:30001},{authorized:false},{trackCheckLimit:513},{eventReplayLimit:257},{publishedBaseline:{generation:0,indexSha256:'a'.repeat(64)}}])assert.throws(()=>fullSnapshotPolicy({fullSnapshotPolicy:{...tonight,...patch}}));
 assert.equal(fullSnapshotPolicy({fullSnapshotPolicy:policy}).profileDocumentLimit,2000);
});
