import test from 'node:test';
import assert from 'node:assert/strict';
import {createFirestoreAudit, recordFirestoreReads, recordFirestoreFailure, describeFirestoreOperation} from '../src/firestore-read-cost.js';
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
    const record=JSON.parse(lines.find(line=>line.startsWith('Ranked request Firestore reads ')).slice('Ranked request Firestore reads '.length));
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

const operationQuery = {method:'POST', body:JSON.stringify({structuredQuery:{from:[{collectionId:'boards'}]}})};
const documentName = (collection, id = 'PRIVATE_DOCUMENT') => `projects/PRIVATE_PROJECT/databases/(default)/documents/${collection}/${id}`;

test('pure operation descriptor leaves the default audit shape and all inputs unchanged', () => {
  const before = createFirestoreAudit();
  assert.deepEqual(Object.keys(before), ['operationAttempts','failedOperations','preTransportFailures',
    'httpRequests','failedRequests','documentReadEstimate','collections','writeEstimate','deleteEstimate',
    'writeCollections','unknownReadRequests','unknownWriteRequests']);
  const payload = Object.freeze([Object.freeze({document:Object.freeze({fields:{secret:'PRIVATE_PAYLOAD'}})})]);
  const init = Object.freeze({...operationQuery, headers:Object.freeze({Authorization:'PRIVATE_TOKEN'})});
  const result = describeFirestoreOperation({path:':runQuery', init, payload});
  assert.equal(result.documentReadEstimate, 1);
  assert.equal(result.returnedDocumentCount, 1);
  assert.equal(result.minimumEmptyQuery, false);
  assert.deepEqual(result.collections, {boards:1});
  assert.deepEqual(createFirestoreAudit(), before);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  result.collections.boards = 99;
  assert.equal(describeFirestoreOperation({path:':runQuery', init, payload}).collections.boards, 1);
});

test('query descriptors distinguish returned document count from minimum empty-query read', () => {
  const result = describeFirestoreOperation({path:':runQuery', init:operationQuery, payload:[{readTime:'private'}]});
  assert.equal(result.operationKind, 'runQuery');
  assert.equal(result.outcome, 'success');
  assert.equal(result.documentReadEstimate, 1);
  assert.equal(result.returnedDocumentCount, 0);
  assert.equal(result.minimumEmptyQuery, true);
  assert.equal(result.writeEstimate, 0);
});

test('GET, PATCH and DELETE handle lowercase methods, missing documents and nested collections safely', () => {
  const get = describeFirestoreOperation({path:'/accounts/PRIVATE_ACCOUNT/profiles/PRIVATE_ID?token=PRIVATE_TOKEN', method:'get', payload:null});
  assert.deepEqual(get.collections, {profiles:1});
  assert.equal(get.requestedDocumentCount, 1);
  assert.equal(get.returnedDocumentCount, 0);
  for (const [method, writes, deletes] of [['patch',1,0], ['delete',0,1]]) {
    const result = describeFirestoreOperation({path:'/profiles/PRIVATE_ID', init:{method, body:'PRIVATE_BODY'}, payload:null});
    assert.equal(result.documentReadEstimate, 0);
    assert.equal(result.writeEstimate, writes);
    assert.equal(result.deleteEstimate, deletes);
    assert.deepEqual(result.writeCollections, {profiles:{writes,deletes}});
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  }
});

test('batch descriptors count requested documents including misses, not HTTP attempts', () => {
  const result = describeFirestoreOperation({path:':batchGet', init:{method:'POST', body:JSON.stringify({documents:[
    documentName('profiles'), documentName('boards'), documentName('accounts/PRIVATE_ACCOUNT/profiles')
  ]})}, payload:[{found:{fields:{secret:'PRIVATE'}}},{missing:'PRIVATE'},{found:{}}]});
  assert.equal(result.documentReadEstimate, 3);
  assert.equal(result.requestedDocumentCount, 3);
  assert.equal(result.returnedDocumentCount, 2);
  assert.deepEqual(result.collections, {profiles:2, boards:1});
  assert.equal('operationAttempts' in result, false);
  assert.equal('httpRequests' in result, false);
});

test('commit descriptors count update, transform and delete separately without reads', () => {
  const init = {method:'POST', body:JSON.stringify({writes:[
    {update:{name:documentName('profiles'), fields:{replay:'PRIVATE_REPLAY'}}},
    {transform:{document:documentName('profiles'), fieldTransforms:[{secret:'PRIVATE'}]}},
    {delete:documentName('boards')}
  ], transaction:'PRIVATE_TOKEN'})};
  const result = describeFirestoreOperation({path:':commit', init, payload:{writeResults:[{}, {}, {}]}});
  assert.equal(result.writeEstimate, 2);
  assert.equal(result.deleteEstimate, 1);
  assert.equal(result.documentReadEstimate, 0);
  assert.deepEqual(result.writeCollections, {profiles:{writes:2,deletes:0}, boards:{writes:0,deletes:1}});
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  const failed = describeFirestoreOperation({path:':commit', init, failed:true, payload:Error('PRIVATE_ERROR')});
  assert.equal(failed.outcome, 'unknown');
  assert.equal(failed.writeEstimate, null);
  assert.equal(failed.deleteEstimate, null);
  assert.equal(failed.documentReadEstimate, 0);
  assert.deepEqual(failed.writeCollections, {profiles:{writes:null,deletes:0}, boards:{writes:0,deletes:null}});
});

test('failed responses mark affected costs unknown, not zero or attempted document counts', () => {
  for (const input of [
    {path:'/profiles/PRIVATE_ID'},
    {path:':runQuery', init:operationQuery},
    {path:':batchGet', init:{method:'POST',body:JSON.stringify({documents:[documentName('profiles')]})}}
  ]) {
    const result = describeFirestoreOperation({...input, failed:true});
    assert.equal(result.outcome, 'unknown');
    assert.equal(result.failed, true);
    assert.equal(result.documentReadEstimate, null);
    assert.equal(result.returnedDocumentCount, null);
    assert.equal(result.minimumEmptyQuery, null);
    assert.equal(result.writeEstimate, 0);
    assert.equal(result.unknownReadRequests, 1);
    assert.ok(Object.values(result.collections).every(value=>value===null));
  }
  const emptyCommit = describeFirestoreOperation({path:':commit',init:{method:'POST',body:'{"writes":[]}'},failed:true});
  assert.equal(emptyCommit.writeEstimate, 0);
  assert.equal(emptyCommit.deleteEstimate, 0);
  assert.equal(emptyCommit.unknownWriteRequests, 0);
});

test('malformed inputs and unknown endpoints fail closed without throwing or leaking', () => {
  for (const input of [{}, {path:'/profiles/%zz',method:'PUT'},
    {path:':runQuery',init:{body:'PRIVATE_MALFORMED'}},
    {path:':runQuery',init:{body:'{"structuredQuery":{"from":[{"collectionId":"PRIVATE/COLLECTION"}]}}'},payload:[]},
    {path:':batchGet',init:{body:JSON.stringify({documents:['PRIVATE_BAD_NAME']})},payload:[]},
    {path:':commit',init:{method:'POST',body:'{"writes":[null]}'}},
    {path:'/PRIVATE_TOKEN',method:'GET'},
    {path:':runQuery',init:operationQuery,payload:{error:'PRIVATE_ERROR'}}]) {
    const result = describeFirestoreOperation(input);
    assert.equal(result.outcome, 'unknown');
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
    assert.ok([result.documentReadEstimate,result.writeEstimate,result.deleteEstimate].includes(null));
  }
  const partial = describeFirestoreOperation({path:':batchGet',init:{method:'POST',body:JSON.stringify({documents:[documentName('profiles')]})},payload:[]});
  assert.equal(partial.documentReadEstimate, null);
  assert.deepEqual(partial.collections, {profiles:null});
});

test('collection keys cannot pollute prototypes and full transport URLs are not emitted', () => {
  const result = describeFirestoreOperation({path:'https://firestore.googleapis.com/v1/' + documentName('__proto__'),payload:{}});
  assert.equal(Object.hasOwn(result.collections, '__proto__'), true);
  assert.equal(result.collections.__proto__, 1);
  assert.equal(Object.getPrototypeOf(result.collections), Object.prototype);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  const query = describeFirestoreOperation({path:':runQuery',init:{body:'{"structuredQuery":{"from":[{"collectionId":"constructor"}]}}'},payload:[]});
  assert.equal(query.collections.constructor, 1);
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
