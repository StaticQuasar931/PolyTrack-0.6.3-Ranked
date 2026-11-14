import test from 'node:test';
import assert from 'node:assert/strict';
import {createShopControllerStore} from './shop-controller.mjs';
import {createShopTransport} from './shop-transport.mjs';
import {PROFILE_SHOP_CATALOG as items} from './profile-shop-catalog.mjs';
const accountId='a'.repeat(64);
function fixture(){
 const data=new Map(),calls=[];let revision=3,balance=100,owned=[],lost=false,receipts=new Map(),ids=0;
 const storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
 const transport=async request=>{calls.push(structuredClone(request));if(request.method==='GET')return request.path.includes('catalog')?{version:2,items}:{accountId,catalogVersion:2,balance,revision,equipRevision:0,equipped:null,inventoryComplete:true,ownedItemIds:[...owned]};
 const b=request.body;let result=receipts.get(b.requestId);if(!result){assert.equal(b.catalogVersion,2);assert.equal(b.expectedWalletRevision,revision);const item=items.find(i=>i.id===b.itemId);assert.equal(b.expectedPrice,item.price);balance-=item.price;revision++;owned.push(item.id);result={op:'purchase',accountId,requestId:b.requestId,itemId:b.itemId,itemKind:'profile-cosmetic',catalogVersion:2,outcomeOnly:true,delta:-item.price,balanceAfter:balance,walletRevision:revision,alreadyOwned:false};receipts.set(b.requestId,result);if(lost){lost=false;throw Object.assign(Error('lost'),{code:'shop_unavailable',ambiguous:true});}return {...result,duplicate:false};}return {...result,duplicate:true};};
 const store=createShopControllerStore({transport,storage,getAccountId:()=>accountId,getAuthScope:()=> 'auth-1',makeRequestId:()=> 'quote-request-'+(++ids),withAccountLock:async(id,fn)=>fn(),enabled:true});
 return {store,calls,data,lose:()=>{lost=true;},later:()=>{balance+=8;revision++;}};
}
test('profile purchase uses one server-quoted POST and one completion read, not an extra preflight GET',async()=>{
 const f=fixture();await f.store.load();assert.equal(f.calls.length,2);const item=items[0];const result=await f.store.purchase({accountId,itemId:item.id,price:item.price,walletRevision:3},{confirmed:true});
 assert.equal(f.calls.length,4);assert.deepEqual(f.calls.map(c=>c.method),['GET','GET','POST','GET']);assert.deepEqual(f.calls[2].body,{accountId,requestId:'quote-request-1',itemId:item.id,catalogVersion:2,expectedPrice:20,expectedWalletRevision:3});
 assert.equal(result.wallet.balance,80);assert.deepEqual(result.inventory.ownedIds,[item.id]);assert.equal(f.data.size,0);assert.equal(f.store.state().catalog.items[0].category,'profile');
});
test('lost quoted purchase reuses the original quote and ID while completion GET supplies current money',async()=>{
 const f=fixture();await f.store.load();f.lose();await assert.rejects(f.store.purchase({accountId,itemId:items[0].id,price:20,walletRevision:3},{confirmed:true}));const original=f.calls.find(c=>c.method==='POST').body;f.later();f.store.reset();await f.store.load();const result=await f.store.reconcile({confirmed:true});const posts=f.calls.filter(c=>c.method==='POST');assert.equal(posts.length,2);assert.deepEqual(posts[1].body,original);assert.equal(result.wallet.balance,88);assert.equal(result.wallet.revision,5);assert.equal(result.outcome.balanceAfter,80);assert.equal(result.outcome.duplicate,true);assert.equal(f.data.size,0);
});
test('transport admits only the exact bounded profile quote shape before token or network access',async()=>{
 let calls=0;const transport=createShopTransport({revision:321,getToken:async()=>{calls++;return 'token';},fetch:async()=>{calls++;return new Response('{}');}});
 const body={accountId,requestId:'quote-request-1',itemId:items[0].id,catalogVersion:2,expectedPrice:20,expectedWalletRevision:3};await transport({path:'/v1/shop/purchase',method:'POST',body});assert.equal(calls,2);for(const patch of [{expectedPrice:-1},{expectedWalletRevision:1.2},{extra:true},{expectedPrice:'20'}])await assert.rejects(transport({path:'/v1/shop/purchase',method:'POST',body:{...body,...patch}}));assert.equal(calls,2);
});
