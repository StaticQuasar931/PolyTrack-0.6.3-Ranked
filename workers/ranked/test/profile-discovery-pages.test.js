import test from 'node:test';
import assert from 'node:assert/strict';
import worker,{handleRequest} from '../src/index.js';
import {eventEncode,eventDecode} from '../src/events-store.js';

const base='projects/polytrack-052/databases/(default)/documents/';
const account='a'.repeat(64),origin='https://profile-pages.invalid';
const jobs='0.6.2_s1_worker_jobs',boards='0.6.2_s1_leaderboards_track',races='0.6.2_race_results';
const jobKey=jobs+'/profile_'+account;

function fixture(t,count){
 t.mock.method(globalThis,'fetch',async()=>assert.fail('NETWORK_FORBIDDEN'));
 t.mock.method(console,'log',()=>{});t.mock.method(console,'error',()=>{});
 const data=new Map(),versions=new Map(),queries=[],touched=new Set();
 const wire=(key,value=data.get(key))=>({name:base+key,fields:eventEncode(value).mapValue.fields,updateTime:'v'+(versions.get(key)||0)});
 const ids=Array.from({length:count},(_,i)=>(i+1).toString(16).padStart(64,'0'));
 for(const trackId of ids){
  data.set(races+'/'+account+'_'+trackId,{accountId:account,trackId,replay:'private replay must not be selected'});
  data.set(boards+'/'+trackId,{entries:[],complete:true,totalEntries:0,signature:'ready',schemaVersion:6,algorithmVersion:'participation-v8-s1'});
 }
 data.set('0.6.2_profiles_public/'+account,{accountId:account,ownerUid:'owner',nickname:'Racer'});
 let failPage=false,failCommit=false,corruptPage=false,badPayload=false,jobWrites=0;
 const env={ALLOWED_ORIGINS:origin,OPEN_BETA_ENABLED:'false',BACKGROUND_MAINTENANCE_MODE:'coordinated',
  __TEST_UID:'owner',PB_NOTIFY_RATE_LIMITER:{limit:async()=>({success:true})},
  __TEST_FIRESTORE:async(path,init={})=>{
   if(path===':runQuery'){
    const q=JSON.parse(init.body).structuredQuery;
    if(q.from[0].collectionId===jobs)return data.get(jobKey)?.active?[{document:wire(jobKey)}]:[];
    assert.equal(q.from[0].collectionId,races);queries.push(q);
    assert.deepEqual(q.select,{fields:[{fieldPath:'trackId'}]});
    assert.equal(q.where.fieldFilter.field.fieldPath,'accountId');
    assert.equal(q.where.fieldFilter.value.stringValue,account);
    assert.equal(q.limit,100);assert.deepEqual(q.orderBy,[{field:{fieldPath:'__name__'},direction:'ASCENDING'}]);
    if(failPage){failPage=false;throw Error('FIRESTORE_503');}
    if(badPayload)return [{error:{message:'stream unavailable'}}];
    const cursor=q.startAt?.values?.[0]?.referenceValue||'';
    if(cursor)assert.equal(q.startAt.before,false);
    const rows=[...data].filter(([key])=>key.startsWith(races+'/')&&base+key>cursor)
     .sort(([a],[b])=>a.localeCompare(b)).slice(0,q.limit)
     .map(([key,row])=>({document:wire(key,{trackId:row.trackId})}));
    if(corruptPage&&rows.length)rows[0].document.name='projects/wrong/databases/(default)/documents/'+races+'/bad';
    return rows;
   }
   if(path===':commit'){
    const writes=JSON.parse(init.body).writes;
    if(failCommit){failCommit=false;throw Error('FIRESTORE_412');}
    for(const write of writes){const key=write.update.name.slice(base.length);assert.deepEqual(write.currentDocument,data.has(key)?{updateTime:'v'+(versions.get(key)||0)}:{exists:false});}
    for(const write of writes){const key=write.update.name.slice(base.length);if(key===jobKey)jobWrites++;data.set(key,eventDecode({mapValue:{fields:write.update.fields}}));versions.set(key,(versions.get(key)||0)+1);}
    return {writeResults:writes.map(write=>({updateTime:'v'+versions.get(write.update.name.slice(base.length))}))};
   }
   if(init.method==='PATCH'){
    const key=decodeURIComponent(path.slice(1));if(key===jobKey)jobWrites++;data.set(key,eventDecode({mapValue:{fields:JSON.parse(init.body).fields}}));versions.set(key,1);return {updateTime:'v1'};
   }
   const key=decodeURIComponent(path.slice(1));if(key.startsWith(boards+'/'))touched.add(key.slice(boards.length+1));
   return data.has(key)?wire(key):null;
  }};
 return {data,queries,ids,touched,job:()=>data.get(jobKey),jobWrites:()=>jobWrites,
  failPage:()=>{failPage=true;},failCommit:()=>{failCommit=true;},corruptPage:()=>{corruptPage=true;},badPayload:()=>{badPayload=true;},
  async notify(){const tasks=[];const response=await handleRequest(new Request(origin+'/v1/profile/notify',{method:'POST',headers:{Origin:origin},body:JSON.stringify({accountId:account})}),env,{waitUntil:p=>tasks.push(p)});await Promise.all(tasks);return response;},
  async turn(){let done;worker.scheduled({cron:'2-59/5 * * * *',scheduledTime:Date.UTC(2026,10,1,1,7)},env,{waitUntil:p=>{done=p;}});await done;},
  async drain(){for(let i=0;i<200&&data.get(jobKey)?.active;i++)await this.turn();assert.equal(data.get(jobKey)?.active,false);}
 };
}

for(const count of [0,99,100,200,237])test('profile discovery reaches every one of '+count+' tracks in bounded pages',async t=>{
 const f=fixture(t,count);assert.equal((await f.notify()).status,202);await f.drain();
 assert.deepEqual([...f.touched].sort(),f.ids);
 assert.equal(f.job().processed||0,count);assert.equal(f.job().trackDiscovery.complete,true);
 assert.equal(f.queries.length,Math.floor(count/100)+1,'only an exact full page needs an EOF query');
 const cursors=f.queries.map(q=>q.startAt?.values?.[0]?.referenceValue||'');assert.equal(new Set(cursors).size,cursors.length);
 const queryCount=f.queries.length;const response=await f.notify();assert.equal(response.status,200);assert.equal((await response.json()).unchanged,true);assert.equal(f.queries.length,queryCount);
});

test('failed discovery and checkpoint cannot advance a durable cursor or lose pending work',async t=>{
 const f=fixture(t,101);await f.notify();
 while(f.job().pendingTrackIds.length)await f.turn();
 const before=structuredClone(f.job());f.failPage();await f.turn();assert.deepEqual(f.job(),before);
 f.failCommit();await f.turn();assert.deepEqual(f.job(),before);
 await f.drain();assert.equal(f.touched.size,101);assert.equal(f.job().processed,101);
});

test('foreign-project discovery results are rejected before a profile job is written',async t=>{
 const f=fixture(t,1);f.corruptPage();await assert.rejects(f.notify(),/PROFILE_DISCOVERY_CURSOR_INVALID/);assert.equal(f.job(),undefined);
});

test('profile ownership is still checked before any discovery page',async t=>{
 const f=fixture(t,237);f.data.get('0.6.2_profiles_public/'+account).ownerUid='different';
 assert.equal((await f.notify()).status,403);assert.equal(f.queries.length,0);assert.equal(f.job(),undefined);
});

test('stream errors cannot masquerade as an empty complete profile discovery',async t=>{
 const f=fixture(t,101);f.badPayload();await assert.rejects(f.notify(),/PROFILE_DISCOVERY_PAGE_INVALID/);assert.equal(f.job(),undefined);
});

test('empty profile propagation persists completion once rather than writing a second no-op checkpoint',async t=>{
 const f=fixture(t,0);assert.equal((await f.notify()).status,202);assert.equal(f.job().active,false);
 assert.equal(f.jobWrites(),1);assert.equal(f.job().trackDiscovery.complete,true);assert.ok(f.job().completedAt>0);
 assert.equal((await f.notify()).status,200);assert.equal(f.jobWrites(),1);assert.equal(f.queries.length,1);
});
