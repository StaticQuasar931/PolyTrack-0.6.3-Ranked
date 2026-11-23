import test from 'node:test';
import assert from 'node:assert/strict';
import {handleRequest} from '../src/index.js';
import {eventEncode,eventDecode} from '../src/events-store.js';
import {addPurchase} from '../src/purchased-cosmetic-entitlements.js';
import {encodeWorkshopStyle,WORKSHOP_STYLE_COLLECTION} from '../../../tools/public-workshop-style.mjs';

const origin='https://workshop-audit.invalid',accountId='a'.repeat(64),uid='owner';
const workshop=WORKSHOP_STYLE_COLLECTION+'/'+accountId;
const profile='0.6.2_profiles_public/'+accountId;
const entitlement='0.6.2_s1_cosmetic_entitlements/'+accountId;
const allow={limit:async()=>({success:true})};
function fixture(t){
 t.mock.method(globalThis,'fetch',async()=>assert.fail('External network forbidden'));
 t.mock.method(console,'log',()=>{});
 const reads=[],writes=[],db=new Map([[profile,{accountId,ownerUid:uid}]]);
 const env={ALLOWED_ORIGINS:origin,__TEST_UID:uid,WRITE_IP_RATE_LIMITER:allow,PB_NOTIFY_RATE_LIMITER:allow,
  __TEST_FIRESTORE:async(route,init)=>{
   if(route===':commit'){
    const batch=JSON.parse(init.body).writes;
    assert.equal(batch.length,1);
    const {update,currentDocument}=batch[0];
    const key=update.name.split('/documents/')[1];
    assert.equal(key,workshop);assert.deepEqual(currentDocument,db.has(key)?{updateTime:'2026-11-20T01:00:00Z'}:{exists:false});
    const data=eventDecode({mapValue:{fields:update.fields}});
    assert.deepEqual(Object.keys(data).sort(),['updatedAt','workshopStyle']);
    writes.push(key);db.set(key,data);return {writeResults:[{updateTime:'2026-11-20T01:00:00Z'}]};
   }
   const key=route.slice(1);reads.push(key);const value=db.get(key);
   return value?{fields:eventEncode(value).mapValue.fields,updateTime:'2026-11-20T01:00:00Z'}:null;
  }};
 const send=(style,id=accountId)=>handleRequest(new Request(origin+'/v1/profile/workshop',{
   method:'POST',headers:{Origin:origin,'CF-Connecting-IP':'192.0.2.1'},body:JSON.stringify({accountId:id,workshopStyle:style})
 }),env,{waitUntil(){}});
 return {db,reads,writes,send};
}
test('explicit free Workshop save uses one separate write and repeats make no writes',async t=>{
 const f=fixture(t),style=encodeWorkshopStyle({accessory:'fin',finish:'neon'});
 assert.equal((await f.send(style)).status,200);
 assert.deepEqual(f.reads,[profile,workshop]);assert.deepEqual(f.writes,[workshop]);
 assert.equal(f.db.get(workshop).workshopStyle,style);
 assert.equal((await f.send(style)).status,200);assert.equal(f.writes.length,1);
 assert.equal((await f.send('')).status,200);assert.equal(f.db.get(workshop).workshopStyle,'');
 assert.deepEqual(f.db.get(profile),{accountId,ownerUid:uid});
});
test('rejects unsigned identity, malformed styles and unowned paid accessories',async t=>{
 const f=fixture(t),style=encodeWorkshopStyle({accessory:'timing-pod'});
 assert.equal((await f.send('{"accessory":"fin","tier":"gold"}')).status,400);
 assert.equal(f.reads.length,0);
 assert.equal((await f.send(style,'b'.repeat(64))).status,403);
 assert.equal((await f.send(style)).status,403);
 assert.equal(f.writes.length,0);assert.equal(f.reads.at(-1),entitlement);
 f.db.set(entitlement,addPurchase(null,'workshop-accessory-timing-pod',1700000000000,{accountId,ownerUid:uid}));
 assert.equal((await f.send(style)).status,200);
 assert.equal(f.db.get(workshop).workshopStyle,style);
});
