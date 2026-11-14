import {createShopBrowserLock} from './shop-browser-lock.mjs';
// Offline integration: the real service runs over a serializable in-memory store.
// Test-only credits are never written to any Firebase project.
import test from 'node:test';import assert from 'node:assert/strict';
import{createShopSession}from'./shop-session.mjs';import{createShopTransport}from'./shop-transport.mjs';
import{handleCurrencyRequest,CURRENCY_COLLECTIONS,CURRENCY_RULES_VERSION}from'../workers/ranked/src/currency-wallet.js';
const accountId='a'.repeat(64),uid='test-owner';
function setup({loseFirstPurchase=false,enabled=true}={}){
 const docs=new Map([['0.6.2_profiles_public/'+accountId,{accountId,ownerUid:uid}],[CURRENCY_COLLECTIONS.wallet+'/'+accountId,{schema:1,accountId,ownerUid:uid,balance:100,revision:0}]]);
 let queue=Promise.resolve(),writes=0,transactions=0,lost=false;const sent=[];
 const store={transaction(fn){const work=queue.then(async()=>{transactions++;const draft=structuredClone(docs);let changed=0;const result=await fn({get:async path=>draft.get(path),set:async(path,value)=>{draft.set(path,structuredClone(value));changed++;},create:async(path,value)=>{assert.equal(draft.has(path),false);draft.set(path,structuredClone(value));changed++;}});docs.clear();for(const entry of draft)docs.set(...entry);writes+=changed;return result;});queue=work.catch(()=>{});return work;}};
 const transport=createShopTransport({revision:316,getToken:async()=> 'offline-test-token',fetch:async(url,options)=>{
  sent.push({path:new URL(url).pathname,body:options.body?JSON.parse(options.body):null});
  const response=await handleCurrencyRequest(new Request(url,options),{env:{CURRENCY_ENABLED:enabled?'true':'false',CURRENCY_RULES_VERSION},store,headers:{},authenticate:async request=>{assert.equal(request.headers.get('Authorization'),'Bearer offline-test-token');return uid;},admit:async()=>null});
  if(loseFirstPurchase&&!lost&&url.endsWith('/v1/shop/purchase')){lost=true;throw Error('test lost response after committed purchase');}return response;
 }});
 const local=new Map(),storage={getItem:key=>local.get(key)??null,setItem:(key,value)=>local.set(key,value),removeItem:key=>local.delete(key)};
 let ids=0;const session=()=>createShopSession({enabled:true,transport,storage,withAccountLock:createShopBrowserLock({locks:{request:async(name,options,callback)=>callback({name})}}),getAccountId:()=>accountId,makeRequestId:()=> 'offline-purchase-'+(++ids)});
 return{session,transport,docs,local,sent,get writes(){return writes;},get transactions(){return transactions;}};
}
test('confirmed purchase reaches actual service and atomically grants one item',async()=>{
 const f=setup(),s=f.session();await s.load();const c=s.preparePurchase('profile-pitlane-ticket');assert.equal(f.writes,0);
 await assert.rejects(s.confirmPurchase(c.id),/confirmation_required/);assert.equal(f.writes,0);
 const result=await s.confirmPurchase(c.id,{confirmed:true});assert.equal(result.wallet,null);const current=await s.load({refresh:true});assert.equal(current.wallet.balance,80);assert.deepEqual(current.inventory.ownedItemIds,['profile-pitlane-ticket']);assert.equal(f.writes,5);assert.equal(f.local.size,0);
 assert.equal([...f.docs.keys()].filter(k=>k.startsWith(CURRENCY_COLLECTIONS.inventory+'/')).length,1);
 assert.equal(f.docs.get(CURRENCY_COLLECTIONS.wallet+'/'+accountId).balance,80);
});
test('lost response survives reload and reconciles SAME receipt without another debit',async()=>{
 const f=setup({loseFirstPurchase:true}),s=f.session();await s.load();const c=s.preparePurchase('profile-pitlane-ticket');
 await assert.rejects(s.confirmPurchase(c.id,{confirmed:true}),e=>e.ambiguous);assert.equal(f.writes,5);assert.equal(f.local.size,1);
 const first=f.sent.find(r=>r.path==='/v1/shop/purchase').body.requestId;const restored=f.session();await restored.load();assert.equal(restored.state().pending.requestId,first);
 const done=await restored.reconcilePending({confirmed:true});assert.equal(done.result.duplicate,true);assert.equal(f.writes,5);assert.equal(f.local.size,0);
 const posts=f.sent.filter(r=>r.path==='/v1/shop/purchase');assert.equal(posts.length,2);assert.equal(posts[0].body.requestId,posts[1].body.requestId);assert.equal(f.docs.get(CURRENCY_COLLECTIONS.wallet+'/'+accountId).balance,80);
});
test('disabled real service performs zero database transactions and client stays disabled',async()=>{
 const f=setup({enabled:false}),s=f.session();await assert.rejects(s.load(),e=>e.code==='currency_disabled');assert.equal(f.transactions,0);assert.equal(f.writes,0);assert.equal(s.state().enabled,false);const count=f.sent.length;assert.throws(()=>s.load(),/disabled/);assert.equal(f.sent.length,count);
});
