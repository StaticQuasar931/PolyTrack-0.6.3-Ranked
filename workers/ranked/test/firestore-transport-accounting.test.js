import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {createFirestoreAudit} from '../src/firestore-read-cost.js';

const origin='https://transport-audit.invalid';
const pair=generateKeyPairSync('rsa',{modulusLength:2048});
const privateKey=pair.privateKey.export({format:'pem',type:'pkcs8'});
let sequence=0;
const freshWorker=()=>import('../src/index.js?transport-audit='+sequence++);
const allow={limit:async()=>({success:true})};
const request=()=>new Request(origin+'/v1/snapshot/track?trackId=private_track_identifier&token=private_query_value',
  {headers:{Origin:origin,'CF-Connecting-IP':'192.0.2.1'}});

function capture(t) {
  const lines=[];
  t.mock.method(console,'log',(...args)=>lines.push(args.join(' ')));
  t.mock.method(console,'error',(...args)=>lines.push(args.join(' ')));
  const previous=globalThis.caches;delete globalThis.caches;
  t.after(()=>{if(previous===undefined)delete globalThis.caches;else globalThis.caches=previous;});
  return {lines,record:()=>JSON.parse(lines.find(line=>line.startsWith('Ranked request Firestore reads '))
    .slice('Ranked request Firestore reads '.length))};
}

for(const failure of ['rejected','network']) test('OAuth '+failure+' costs one operation attempt but zero Firestore transports or billing reads',async t=>{
  const worker=await freshWorker(),logs=capture(t);
  let oauth=0,firestore=0;
  t.mock.method(globalThis,'fetch',async url=>{
    if(String(url).startsWith('https://firestore.googleapis.com/')){firestore++;assert.fail('Firestore must not be reached');}
    assert.equal(url,'https://oauth2.googleapis.com/token');oauth++;
    if(failure==='network')throw Error('simulated OAuth outage');
    return Response.json({error:'invalid_grant'},{status:400});
  });
  const budget={used:0,limit:3};
  const response=await worker.default.fetch(request(),{
    ALLOWED_ORIGINS:origin,FIREBASE_PROJECT_ID:'private-project-id',
    FIREBASE_CLIENT_EMAIL:'private-service-account@example.invalid',FIREBASE_PRIVATE_KEY:privateKey,
    PUBLIC_READ_RATE_LIMITER:allow,__OVERALL_REQUEST_BUDGET:budget
  },{});
  assert.equal(response.status,503);assert.equal(oauth,1);assert.equal(firestore,0);
  assert.equal(budget.used,1,'auth failures still consume the admitted operation budget');
  const record=logs.record();
  assert.equal(record.operationAttempts,1);assert.equal(record.failedOperations,1);
  assert.equal(record.preTransportFailures,1);assert.equal(record.httpRequests,0);assert.equal(record.failedRequests,0);
  assert.equal(record.documentReadEstimate,0);assert.equal(record.writeEstimate,0);assert.equal(record.deleteEstimate,0);
  assert.equal(record.unknownReadRequests,0);assert.equal(record.unknownWriteRequests,0);
  assert.deepEqual(record.collections,{});assert.deepEqual(record.writeCollections,{});
  for(const secret of ['private_track_identifier','private_query_value','/v1/snapshot/track',
    'private-project-id','private-service-account','/documents/','BEGIN PRIVATE KEY'])
    assert.equal(logs.lines.join('\n').includes(secret),false,'logs must omit '+secret);
});

test('mocked storage is a real transport boundary for accounting, unlike OAuth acquisition',async t=>{
  const worker=await freshWorker(),logs=capture(t);let calls=0;
  t.mock.method(globalThis,'fetch',async()=>assert.fail('network forbidden'));
  assert.equal((await worker.default.fetch(request(),{ALLOWED_ORIGINS:origin,PUBLIC_READ_RATE_LIMITER:allow,
    __TEST_FIRESTORE:async()=>{calls++;throw Error('FIRESTORE_503');}},{})).status,503);
  const record=logs.record();
  assert.equal(calls,1);assert.equal(record.operationAttempts,1);assert.equal(record.httpRequests,1);
  assert.equal(record.failedOperations,1);assert.equal(record.failedRequests,1);
  assert.equal(record.preTransportFailures,0);assert.equal(record.documentReadEstimate,null);
  assert.equal(record.unknownReadRequests,1);assert.equal(record.writeEstimate,0);
});

test('requests denied before storage retain known zero costs and consume no operation budget',async t=>{
  const worker=await freshWorker(),logs=capture(t),budget={used:0,limit:3};
  t.mock.method(globalThis,'fetch',async()=>assert.fail('network forbidden'));
  assert.equal((await worker.default.fetch(request(),{ALLOWED_ORIGINS:origin,
    PUBLIC_READ_RATE_LIMITER:{limit:async()=>({success:false})},__OVERALL_REQUEST_BUDGET:budget,
    __TEST_FIRESTORE:async()=>assert.fail('storage forbidden')},{})).status,429);
  assert.equal(budget.used,0);
  const record=logs.record();
  for(const field of ['operationAttempts','failedOperations','preTransportFailures','httpRequests','failedRequests',
    'documentReadEstimate','writeEstimate','deleteEstimate','unknownReadRequests','unknownWriteRequests'])
    assert.equal(record[field],0,field+' must be known zero');
});

test('budget exhaustion prevents transport; prior operation attempts still seed aggregation budgets',async t=>{
  const worker=await freshWorker();capture(t);
  t.mock.method(globalThis,'fetch',async()=>assert.fail('network forbidden'));
  const exhausted={used:1,limit:1};
  assert.equal((await worker.default.fetch(request(),{ALLOWED_ORIGINS:origin,PUBLIC_READ_RATE_LIMITER:allow,
    __OVERALL_REQUEST_BUDGET:exhausted,__TEST_FIRESTORE:async()=>assert.fail('storage forbidden')},{})).status,503);
  assert.equal(exhausted.used,1);
  let calls=0;
  const audit=createFirestoreAudit();audit.operationAttempts=42;
  await assert.rejects(worker.rebuildOverall({__FIRESTORE_READ_AUDIT:audit,
    __TEST_FIRESTORE:async()=>{calls++;assert.fail('prior attempts exhausted this budget');}},true),/BUDGET_EXHAUSTED/);
  assert.equal(calls,0);assert.equal(audit.httpRequests,0);
});

test('document GET 404 remains a cacheable absence, not a transport failure',async t=>{
 const worker=await freshWorker(),logs=capture(t);let calls=0;
 t.mock.method(globalThis,'fetch',async url=>{assert.ok(String(url).startsWith('https://firestore.googleapis.com/'));calls++;return new Response(null,{status:404});});
 const response=await worker.default.fetch(request(),{ALLOWED_ORIGINS:origin,PUBLIC_READ_RATE_LIMITER:allow,__TEST_ACCESS_TOKEN:'synthetic-test-token'},{});
 assert.equal(response.status,404);assert.equal(calls,1);assert.equal(logs.record().documentReadEstimate,1);assert.equal(logs.record().failedRequests,0);
});

for(const kind of ['commit','patch'])test('Firestore '+kind+' 404 cannot acknowledge a successful user write',async t=>{
 const worker=await freshWorker(),logs=capture(t);let calls=0;
 t.mock.method(globalThis,'fetch',async(url,init={})=>{
  assert.ok(String(url).startsWith('https://firestore.googleapis.com/'));calls++;
  if(kind==='patch'&&String(url).endsWith('/0.6.2_profiles_public/racer'))return Response.json({fields:{accountId:{stringValue:'racer'},ownerUid:{stringValue:'owner'},nickname:{stringValue:'Racer'}}});
  if(String(url).endsWith(':runQuery'))return Response.json([]);
  return new Response(null,{status:404});
 });
 const path=kind==='commit'?'/v1/extra-tracks/submissions':'/v1/profile/notify';
 const body=kind==='commit'?{name:'Test',author:'Tester',code:'PolyTrack'+'A'.repeat(24),difficulty:1,permissionGranted:true}:{accountId:'racer'};
 const response=await worker.default.fetch(new Request(origin+path,{method:'POST',headers:{Origin:origin},body:JSON.stringify(body)}),
  {ALLOWED_ORIGINS:origin,OPEN_BETA_ENABLED:'false',__TEST_UID:'owner',__TEST_ACCESS_TOKEN:'synthetic-test-token',PB_NOTIFY_RATE_LIMITER:allow},{});
 const audit=logs.record();process.stdout.write('BACKEND_TRANSPORT_404 '+JSON.stringify({kind,status:response.status,calls,reads:audit.documentReadEstimate,writes:audit.writeEstimate,unknownWrites:audit.unknownWriteRequests})+'\n');
 assert.equal(response.status,503);assert.equal(calls,kind==='commit'?2:6);
 assert.equal(audit.writeEstimate,null);assert.equal(audit.unknownWriteRequests,1);assert.equal(audit.failedRequests,1);
});

test('Firestore query 404 cannot masquerade as an empty maintenance queue',async t=>{
 const worker=await freshWorker();capture(t);let calls=0;
 t.mock.method(globalThis,'fetch',async(url,init)=>{assert.ok(String(url).endsWith(':runQuery'));assert.equal(init.method,'POST');calls++;return new Response(null,{status:404});});
 await assert.rejects(worker.migrateCapacityVerificationQueues({__TEST_ACCESS_TOKEN:'synthetic-test-token'}),/FIRESTORE_404/);
 assert.equal(calls,1,'do not continue querying a missing/unavailable database');
});