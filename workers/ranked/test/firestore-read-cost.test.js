import test from 'node:test';
import assert from 'node:assert/strict';
import {createFirestoreAudit, recordFirestoreReads, recordFirestoreFailure} from '../src/firestore-read-cost.js';
import {handleRequest} from '../src/index.js';
test('read diagnostics count documents, empty queries and batch misses, not HTTP calls or writes', () => {
  const audit={collections:{},documentReadEstimate:0};
  const query={body:JSON.stringify({structuredQuery:{from:[{collectionId:'boards'}]}})};
  recordFirestoreReads(audit,':runQuery',query,[{document:{}},{document:{}}]);
  recordFirestoreReads(audit,':runQuery',query,[]);
  recordFirestoreReads(audit,'/meta/current',{},null);
  recordFirestoreReads(audit,':batchGet',{body:JSON.stringify({documents:['projects/p/databases/(default)/documents/profiles/a','projects/p/databases/(default)/documents/profiles/b']})},[{found:{}},{missing:'b'}]);
  recordFirestoreReads(audit,':commit',{method:'POST',body:JSON.stringify({writes:[
    {update:{name:'projects/p/databases/(default)/documents/profiles/a'}},
    {update:{name:'projects/p/databases/(default)/documents/profiles/b'}},
    {delete:'projects/p/databases/(default)/documents/profiles/old'}
  ]})},{});
  assert.equal(audit.documentReadEstimate,6);
  assert.deepEqual(audit.collections,{boards:3,meta:1,profiles:2});
  assert.deepEqual(audit.writeCollections,{profiles:{writes:2,deletes:1}});
  assert.equal(audit.writeEstimate,2);
  assert.equal(audit.deleteEstimate,1);
});

test('successful PATCH and DELETE are counted by collection without double-counting reads',()=>{
  const audit={collections:{},documentReadEstimate:0};
  recordFirestoreReads(audit,'/profiles/a',{method:'PATCH'},{});
  recordFirestoreReads(audit,'/profiles/b',{method:'DELETE'},null);
  assert.deepEqual(audit.writeCollections,{profiles:{writes:1,deletes:1}});
  assert.equal(audit.writeEstimate,1);
  assert.equal(audit.deleteEstimate,1);
  assert.deepEqual(audit.collections,{});
  assert.equal(audit.documentReadEstimate,0);
});

test('failed Firestore calls increment failure count but never reach write cost recorder',async()=>{
  const origin='https://staticquasar931.github.io';
  const previousCaches=globalThis.caches;
  const originalLog=console.log, lines=[];
  delete globalThis.caches;
  console.log=(...args)=>lines.push(args.join(' '));
  try {
    const response=await handleRequest(new Request('https://ranked.example/v1/status',{headers:{Origin:origin}}),{
      ALLOWED_ORIGINS:origin,__TEST_FIRESTORE:async()=>{throw Error('simulated_failure');}});
    assert.equal(response.status,503);
    const record=JSON.parse(lines[0].slice('Ranked request Firestore reads '.length));
    assert.equal(record.httpRequests,1);
    assert.equal(record.failedRequests,1);
    assert.equal(record.documentReadEstimate,null);
    assert.equal(record.unknownReadRequests,1);
    assert.deepEqual(record.collections,{'0.6.2_s1_release_meta':null});
    assert.equal(record.writeEstimate,0);
    assert.equal(record.deleteEstimate,0);
    assert.deepEqual(record.writeCollections,{});
  } finally {
    console.log=originalLog;
    if(previousCaches===undefined)delete globalThis.caches;else globalThis.caches=previousCaches;
  }
});

test('unknown costs stay unknown after later successful reads, writes and deletes',()=>{
  const audit=createFirestoreAudit();
  recordFirestoreFailure(audit,'/profiles/a');
  recordFirestoreReads(audit,'/profiles/b',{},null);
  assert.equal(audit.documentReadEstimate,null);
  assert.equal(audit.collections.profiles,null);
  recordFirestoreFailure(audit,'/profiles/a',{method:'PATCH'});
  recordFirestoreReads(audit,'/profiles/b',{method:'PATCH'},{});
  assert.equal(audit.writeEstimate,null);
  assert.equal(audit.writeCollections.profiles.writes,null);
  assert.equal(audit.deleteEstimate,0);
  recordFirestoreFailure(audit,'/profiles/a',{method:'DELETE'});
  recordFirestoreReads(audit,'/profiles/b',{method:'DELETE'},null);
  assert.equal(audit.deleteEstimate,null);
  assert.equal(audit.writeCollections.profiles.deletes,null);
  assert.equal(audit.unknownReadRequests,1);
  assert.equal(audit.unknownWriteRequests,2);
});

test('failed read-only commits have known zero writes; failed mixed commits mark only affected costs unknown',()=>{
  const audit=createFirestoreAudit();
  recordFirestoreFailure(audit,':commit',{method:'POST',body:'{"writes":[]}'});
  assert.equal(audit.writeEstimate,0);
  assert.equal(audit.unknownWriteRequests,0);
  recordFirestoreFailure(audit,':commit',{method:'POST',body:JSON.stringify({writes:[
    {update:{name:'projects/p/databases/(default)/documents/profiles/a'}},
    {delete:'projects/p/databases/(default)/documents/old/b'}]})});
  assert.equal(audit.writeEstimate,null);
  assert.equal(audit.deleteEstimate,null);
  assert.deepEqual(audit.writeCollections,{profiles:{writes:null,deletes:0},old:{writes:0,deletes:null}});
});
