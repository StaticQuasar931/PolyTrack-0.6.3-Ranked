import test from 'node:test';
import assert from 'node:assert/strict';
import {handleRequest} from '../src/index.js';

const origin='https://staticquasar931.github.io';
const request=url=>new Request(url,{headers:{Origin:origin}});

async function captureLog(operation) {
  const original=console.log, lines=[];
  console.log=(...args)=>lines.push(args.join(' '));
  try { return {result:await operation(),lines}; }
  finally { console.log=original; }
}

test('cached public request reports zero Firestore reads without logging query values',async()=>{
  const previousCaches=globalThis.caches;
  globalThis.caches={default:{match:async()=>new Response(JSON.stringify({revision:3}))}};
  let reads=0;
  try {
    const {result,lines}=await captureLog(()=>handleRequest(request('https://ranked.example/v1/status?account=private-value'),{
      ALLOWED_ORIGINS:origin,__TEST_FIRESTORE:async()=>{reads++;return null;}}));
    assert.equal(result.status,200);
    assert.equal(reads,0);
    assert.equal(lines.length,1);
    assert.equal(lines[0].startsWith('Ranked request Firestore reads '),true);
    const {auditId,...record}=JSON.parse(lines[0].slice('Ranked request Firestore reads '.length));
    assert.match(auditId,/^[a-f0-9-]{36}$/);
    assert.deepEqual(record,{
      routeCategory:'public_status',measurementScope:'request_synchronous',operationAttempts:0,failedOperations:0,preTransportFailures:0,
      httpRequests:0,failedRequests:0,documentReadEstimate:0,collections:{},
      writeEstimate:0,deleteEstimate:0,writeCollections:{},unknownReadRequests:0,unknownWriteRequests:0,billingEstimateOnly:true});
    assert.equal(lines[0].includes('private-value'),false);
  } finally {
    if(previousCaches===undefined)delete globalThis.caches;else globalThis.caches=previousCaches;
  }
});

test('cold public request reports actual Firestore reads by collection only',async()=>{
  const previousCaches=globalThis.caches;
  delete globalThis.caches;
  let reads=0;
  try {
    const {result,lines}=await captureLog(()=>handleRequest(request('https://ranked.example/v1/status?token=must-not-log'),{
      ALLOWED_ORIGINS:origin,__TEST_FIRESTORE:async()=>{reads++;return {fields:{revision:{integerValue:'7'}}};}}));
    assert.equal(result.status,200);
    assert.equal(reads,1);
    const record=JSON.parse(lines[0].slice('Ranked request Firestore reads '.length));
    assert.equal(record.routeCategory,'public_status');
    assert.equal(record.measurementScope,'request_synchronous');
    assert.equal(record.httpRequests,1);
    assert.equal(record.failedRequests,0);
    assert.equal(record.documentReadEstimate,1);
    assert.deepEqual(record.collections,{'0.6.2_s1_release_meta':1});
    assert.equal(lines.join('\n').includes('must-not-log'),false);
  } finally {
    if(previousCaches!==undefined)globalThis.caches=previousCaches;
  }
});
