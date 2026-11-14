import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {Socket} from 'node:net';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import worker, {computeTrackEntries, handleRequest} from '../src/index.js';
import {eventEncode as encode, eventDecode as decode} from '../src/events-store.js';
import {VERIFICATION_BOOTSTRAP_ID, VERIFICATION_COLLECTION, pendingSlot,
  VERIFIER_ENGINE_DIGEST, VERIFIER_VERSION, verificationKey} from '../src/verification.js';
import {COMPETITIVE_REVIEW_REASON} from '../src/competitive-review.js';

globalThis.fetch = () => {throw Error('OFFLINE_AUTHORITY_TEST');};
Socket.prototype.connect = globalThis.fetch;
const base = 'projects/polytrack-052/databases/(default)/documents/';
const boards = '0.6.2_s1_leaderboards_track', results = '0.6.2_race_results';
const jobs = '0.6.2_s1_worker_jobs', jobKey = jobs + '/canonical_reconcile_v2';
const bootstrapKey = jobs + '/' + VERIFICATION_BOOTSTRAP_ID;
const track = '5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038';
const boardKey = boards + '/' + track, queueKey = VERIFICATION_COLLECTION + '/' + track;
const metaKey = '0.6.2_s1_release_meta/current';
const start = Date.UTC(2026,10,5);
const replay = 'authority-offline-replay', replayHash = createHash('sha256').update(replay).digest('hex');
const row = (accountId,timeMs) => ({accountId,ownerUid:'owner',trackId:track,name:accountId,
  timeMs,frames:timeMs,raceTimeFrames:timeMs,uploadId:1,pbAt:1000,replay,replayHash});
const proof = r => ({...pendingSlot(r),status:'verified',engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION});

test('tracked authority and reviewed shop activation preserve all other deployment settings',()=>{
  const config=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
  const policy=JSON.parse(readFileSync(new URL('../../../tools/verification-authority.json',import.meta.url),'utf8'));
  assert.equal(config.vars.VERIFICATION_AUTHORITY,'snapshot-native');
  assert.equal(config.vars.VERIFICATION_AUTHORITY,policy.mode);
  assert.equal(config.vars.PUBLIC_FIRESTORE_READ_MODE,'capture-only');
  assert.equal(config.vars.BACKGROUND_MAINTENANCE_MODE,'coordinated');
  assert.equal(config.vars.CANONICAL_DISCOVERY_BACKPRESSURE,'enabled');
  const base=JSON.parse(execFileSync('git',['show','HEAD:workers/ranked/wrangler.jsonc'],{
    cwd:new URL('../../../',import.meta.url),encoding:'utf8',windowsHide:true}));
  // The reviewed profile-shop activation adds only these two gate variables.
  for (const [key, expected] of Object.entries({CURRENCY_ENABLED:'true', CURRENCY_RULES_VERSION:'currency-server-only-v1'})) {
    assert.equal(config.vars[key], expected);
    if (Object.hasOwn(base.vars, key)) assert.equal(base.vars[key], expected);
    delete config.vars[key]; delete base.vars[key];
  }
  delete base.vars.VERIFICATION_AUTHORITY;
  delete config.vars.VERIFICATION_AUTHORITY;
  assert.deepEqual(config,base,'no Overall, limiter, secret, trigger, runtime or other config changes');
});

function fixture(t, authority, maintenance = 'coordinated') {
  const data = new Map(), versions = new Map(), calls = [], errors = [], audits = [];
  const old = row('old',12000), held = row('held',13000), fresh = row('fresh',11000);
  const verdicts = {old:proof(old),held:proof(held)};
  const entries = computeTrackEntries([old,held].map(r=>({...r,integrityVerified:true})),track,{},verdicts);
  const hold = {...pendingSlot(held),status:'unavailable',reason:COMPETITIVE_REVIEW_REASON,
    retryAt:Number.MAX_SAFE_INTEGER};
  const snapshot = id => ({trackId:id,entries,complete:true,sourceComplete:true,totalEntries:entries.length,
    revision:1,sourceRevision:1,signature:'fixture-current',schemaVersion:6,algorithmVersion:'participation-v8-s1'});
  data.set(boardKey,snapshot(track));
  for(let i=1;i<100;i++) {
    const id=i.toString(16).padStart(64,'0');
    data.set(boards+'/'+id,{...snapshot(id),entries:[{...entries[0],trackId:id}],totalEntries:1});
  }
  data.set(queueKey,{trackId:track,slots:{old:proof(old),held:hold}});
  data.set(metaKey,{revision:1,builtRevision:1,dirty:false});
  data.set(jobKey,{schemaVersion:2,backfillComplete:true,cursorIngestedAt:'2026-11-04T00:00:00.000000000Z',
    cursorDocumentId:'',pendingTrackIds:[],pendingFullRebuildTrackIds:[],pendingResultIds:{}});
  for(const r of [old,held,fresh])data.set(results+'/'+r.accountId+'_'+track,r);
  const f = {data,versions,calls,errors,audits,held,fresh,hold,now:start,beforeCommit:null,discovered:false};
  t.mock.method(Date,'now',()=>f.now);
  t.mock.method(console,'error',(...args)=>errors.push(args));
  t.mock.method(console,'log',(...args)=>{
    if(args[0]==='Ranked scheduled Firestore reads')audits.push(JSON.parse(args[1]));
  });
  const wire = key => ({name:base+key,fields:encode(data.get(key)).mapValue.fields,
    updateTime:'v'+(versions.get(key)||0)});
  f.env = {BACKGROUND_MAINTENANCE_MODE:maintenance,PUBLIC_FIRESTORE_READ_MODE:'capture-only',
    ALLOWED_ORIGINS:'https://audit.invalid',__TEST_UID:'owner',
    PB_NOTIFY_RATE_LIMITER:{limit:async()=>({success:true})},
    ...(authority===undefined?{}:{VERIFICATION_AUTHORITY:authority}),
    __TEST_FIRESTORE:async(path,init={})=>{
      const body=init.body?JSON.parse(init.body):null;
      const call={path,body,reads:0,writes:0};calls.push(call);
      if(path===':runQuery') {
        const q=body.structuredQuery, collection=q.from[0].collectionId;
        let keys;
        if(collection===boards) {
          const after=q.startAt?.values[0]?.referenceValue||'';
          keys=[...data.keys()].filter(key=>key.startsWith(boards+'/')&&base+key>after).sort().slice(0,q.limit);
        } else {
          assert.equal(collection,results);
          assert.notEqual(q.where?.fieldFilter?.field?.fieldPath,'trackId','no full canonical reconstruction');
          keys=f.discovered?[]:[results+'/'+fresh.accountId+'_'+track,results+'/'+held.accountId+'_'+track];
          f.discovered=true;
        }
        call.reads=Math.max(1,keys.length);
        return keys.map(key=>({document:{...wire(key),fields:{...wire(key).fields,
          ingestedAt:{timestampValue:'2026-11-05T00:00:00.000000000Z'}}}}));
      }
      if(path===':batchGet') {
        call.reads=body.documents.length;
        return body.documents.map(name=>{const key=name.slice(base.length);return data.has(key)?{found:wire(key)}:{missing:name};});
      }
      if(path===':commit') {
        if(f.beforeCommit)await f.beforeCommit(body.writes);
        for(const w of body.writes) {
          assert.ok(w.update,'no deletes or transforms');
          const key=w.update.name.slice(base.length);
          const expected=data.has(key)?{updateTime:'v'+(versions.get(key)||0)}:{exists:false};
          if(JSON.stringify(w.currentDocument)!==JSON.stringify(expected))throw Error('FIRESTORE_412');
        }
        for(const w of body.writes) {
          const key=w.update.name.slice(base.length);
          data.set(key,decode({mapValue:{fields:w.update.fields}}));versions.set(key,(versions.get(key)||0)+1);
        }
        call.writes=body.writes.length;
        return {writeResults:body.writes.map(w=>({updateTime:'v'+versions.get(w.update.name.slice(base.length))}))};
      }
      call.reads=1;
      const key=decodeURIComponent(path.slice(1));
      return data.has(key)?wire(key):null;
    }};
  f.turn = async(at=start+5*60000)=>{
    f.now=at;let completion;
    worker.scheduled({cron:'*/5 * * * *',scheduledTime:at},f.env,{waitUntil:p=>{completion=p;}});
    await completion;
  };
  f.cost = () => ({reads:calls.reduce((n,c)=>n+c.reads,0),writes:calls.reduce((n,c)=>n+c.writes,0),
    bootstrapQueries:calls.filter(c=>c.path===':runQuery'&&c.body.structuredQuery.from[0].collectionId===boards).length,
    bootstrapReads:calls.filter(c=>c.path==='/'+bootstrapKey).length,
    discoveryQueries:calls.filter(c=>c.path===':runQuery'&&c.body.structuredQuery.from[0].collectionId===results).length});
  return f;
}

for(const mode of [undefined,'firestore','snapshot-native'])test('whole coordinated reconciliation day: '+String(mode),async t=>{
  const f=fixture(t,mode);
  for(let minute=0;minute<1440;minute+=5)await f.turn(start+minute*60000);
  assert.deepEqual(f.errors,[]);
  const cost=f.cost(), native=mode==='snapshot-native';
  assert.equal(f.audits.length,288);
  assert.deepEqual({reads:cost.reads,writes:cost.writes},native?{reads:324,writes:4}:{reads:557,writes:130});
  assert.equal(cost.discoveryQueries,32,'discovery cadence is unchanged');
  assert.equal(cost.bootstrapQueries,native?0:26);
  assert.equal(cost.bootstrapReads,native?0:32);
  assert.equal(f.data.has(bootstrapKey),!native);
  assert.equal([...f.data.keys()].filter(key=>key.startsWith(VERIFICATION_COLLECTION+'/')).length,native?1:100);
  assert.equal(f.data.get(boardKey).entries.find(r=>r.accountId==='fresh').timeMs,f.fresh.timeMs);
  assert.equal(f.data.get(boardKey).entries.find(r=>r.accountId==='fresh').runVerified,false);
  assert.equal(f.data.get(boardKey).entries.find(r=>r.accountId==='held').runVerified,false,'fresh hold overrides stale snapshot approval');
  assert.deepEqual(f.data.get(queueKey).slots.held,f.hold);
  assert.equal(f.data.get(queueKey).slots.fresh.key,verificationKey(f.fresh));
  assert.deepEqual(f.data.get(jobKey).pendingTrackIds,[]);
  assert.equal(f.data.get(metaKey).dirty,true,'normal publication invalidation still occurs');
  assert.equal(f.audits.reduce((n,a)=>n+a.documentReadEstimate,0),cost.reads);
  assert.equal(f.audits.reduce((n,a)=>n+a.writeEstimate,0),cost.writes);
  process.stdout.write('AUTHORITY_DAY_COST '+JSON.stringify({mode:mode??'unset',...cost})+'\n');
  for(let minute=0;minute<1440;minute+=5)await f.turn(start+86400000+minute*60000);
  const after=f.cost(),steady=Object.fromEntries(Object.keys(cost).map(key=>[key,after[key]-cost[key]]));
  assert.deepEqual(steady,{reads:native?320:352,writes:0,bootstrapQueries:0,
    bootstrapReads:native?0:32,discoveryQueries:32});
  assert.deepEqual(f.errors,[]);
  process.stdout.write('AUTHORITY_STEADY_DAY_COST '+JSON.stringify({mode:mode??'unset',...steady})+'\n');
});

for(const mode of ['Snapshot-native','snapshot-native ','','unknown'])test('only exact authority flag skips bootstrap: '+JSON.stringify(mode),async t=>{
  const f=fixture(t,mode);await f.turn();
  assert.equal(f.cost().bootstrapQueries,1);assert.deepEqual(f.errors,[]);
});

test('snapshot-native also skips bootstrap in non-coordinated forks without stopping discovery',async t=>{
  const f=fixture(t,'snapshot-native','continuous');await f.turn(start+15*60000);
  assert.equal(f.cost().bootstrapQueries,0);assert.equal(f.cost().discoveryQueries,1);
  assert.ok(f.data.get(boardKey).entries.some(r=>r.accountId==='fresh'));assert.deepEqual(f.errors,[]);
});

test('snapshot-native leaves explicit authenticated admin repair and ownership checks intact',async t=>{
  const f=fixture(t,'snapshot-native');
  const token='offline-fixture-only';
  f.env.OVERALL_PUBLICATION_MODE='external';f.env.ADMIN_REBUILD_TOKEN=token;
  const admin=token=>new Request('https://audit.invalid/v1/admin/reconcile',{method:'POST',
    headers:{Origin:'https://audit.invalid','X-Admin-Token':token}});
  assert.equal((await handleRequest(admin('wrong'),f.env)).status,403);assert.equal(f.calls.length,0);
  assert.equal((await handleRequest(admin(token),f.env)).status,200);
  assert.equal(f.cost().bootstrapQueries,1,'explicit admin request still seeds legacy queues');
  const before=structuredClone([...f.data]);
  const response=await handleRequest(new Request('https://audit.invalid/v1/pb/notify',{method:'POST',
    headers:{Origin:'https://audit.invalid','Content-Type':'application/json'},
    body:JSON.stringify({resultId:'fresh_'+track})}),{...f.env,__TEST_UID:'intruder'});
  assert.equal(response.status,403);assert.deepEqual([...f.data],before);
});

test('snapshot-native preserves publication CAS and keeps new PB queued after a conflict',async t=>{
  const f=fixture(t,'snapshot-native'),original=structuredClone(f.data.get(boardKey));let injected=false;
  f.beforeCommit=async writes=>{
    if(!injected&&writes.some(w=>w.update.name===base+boardKey)) {
      injected=true;f.versions.set(boardKey,99);
    }
  };
  await f.turn();assert.equal(injected,true);assert.deepEqual(f.data.get(boardKey),original);
  assert.ok(f.data.get(jobKey).pendingTrackIds.includes(track));
  f.beforeCommit=null;await f.turn(start+25*60000);
  assert.ok(f.data.get(boardKey).entries.some(r=>r.accountId==='fresh'));
  assert.equal(f.data.get(boardKey).entries.find(r=>r.accountId==='held').runVerified,false);
  assert.equal(f.cost().bootstrapQueries,0);
});
