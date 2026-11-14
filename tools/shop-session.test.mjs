import test from 'node:test';
import assert from 'node:assert/strict';
import {createShopSession} from './shop-session.mjs';
import {createShopBrowserLock} from './shop-browser-lock.mjs';
import {createShopTransport} from './shop-transport.mjs';
import {PROFILE_SHOP_CATALOG} from './profile-shop-catalog.mjs';
const A='a'.repeat(64),B='b'.repeat(64);
const cat={version:1,items:[{id:'mint-rally',label:'Mint Rally',price:20}]};
const wallet=(accountId=A,extra={})=>({accountId,catalogVersion:1,balance:100,revision:3,
  inventoryComplete:true,ownedItemIds:[],equipRevision:0,equipped:null,...extra});
const error=(code,ambiguous)=>Object.assign(Error(code),{code,ambiguous});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function shared() {
  const data=new Map(),held=new Set();
  const storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};
  const locks={async request(name,options,callback){if(held.has(name))return callback(null);held.add(name);try{return await callback({name});}finally{held.delete(name);}}};
  return {data,storage,held,withAccountLock:createShopBrowserLock({locks})};
}
function fixture(options={},common=shared()){
 const calls=[];let who=A,clock=100,ids=0;
 const result=body=>({op:'purchase',accountId:body.accountId,itemId:body.itemId,requestId:body.requestId,
   outcomeOnly:true,balanceAfter:80,walletRevision:4,alreadyOwned:false,duplicate:false,delta:-20,carStyle:'encoded'});
 let handler=async req=>req.method==='POST'?result(req.body):req.path.includes('catalog')?cat:wallet(new URL(req.path,'http://offline').searchParams.get('accountId'));
 const session=createShopSession({transport:req=>{calls.push(req);return handler(req);},storage:common.storage,
   getAccountId:()=>who,makeRequestId:()=>`request-${++ids}`,now:()=>clock,enabled:true,withAccountLock:common.withAccountLock,...options});
 return {session,...common,calls,result,setHandler:fn=>handler=fn,account:id=>who=id,time:n=>clock=n,ids:()=>ids};
}
async function prepared(f){await f.session.load();return f.session.preparePurchase('mint-rally');}
const confirm=(f,c)=>f.session.confirmPurchase(c.id,{confirmed:true});
const posts=f=>f.calls.filter(r=>r.method==='POST');

test('disabled default has no transport/storage activity',()=>{const f=fixture({enabled:false,storage:null});assert.throws(()=>f.session.load(),{code:'disabled'});assert.equal(f.calls.length,0);assert.equal(f.session.state().wallet,null);});
test('reads dedupe/cache and account transitions clear old state',async()=>{const f=fixture();const a=f.session.load(),b=f.session.load();assert.equal(a,b);await a;await f.session.load();assert.equal(f.calls.length,2);const s=f.session.state();s.wallet.balance=0;s.inventory.ownedItemIds.push('fake');assert.equal(f.session.state().wallet.balance,100);assert.deepEqual(f.session.state().inventory.ownedItemIds,[]);f.account(B);assert.equal(f.session.syncAccount().wallet,null);await f.session.load();f.account(A);await f.session.load();assert.equal(f.calls.length,6);});
test('exact authoritative inventory required; wallet alone cannot authorize purchase',async()=>{const f=fixture();f.setHandler(async r=>r.path.includes('catalog')?cat:{balance:100,revision:3,equipped:null});await assert.rejects(f.session.load());assert.equal(f.session.state().ownedStatus,'unknown');assert.throws(()=>f.session.preparePurchase('mint-rally'));assert.equal(posts(f).length,0);});
test('cross-account inventory, incomplete lists, duplicates and unknown IDs fail closed',async()=>{for(const extra of [{accountId:B},{catalogVersion:2},{inventoryComplete:false},{ownedItemIds:['fake']},{ownedItemIds:['mint-rally','mint-rally']}]){const f=fixture();f.setHandler(async r=>r.path.includes('catalog')?cat:wallet(A,extra));await assert.rejects(f.session.load(),{code:'invalid_inventory'});assert.equal(f.session.state().ownedStatus,'unknown');assert.equal(posts(f).length,0);}});
test('owned item and insufficient funds never create request IDs or POST',async()=>{for(const extra of [{ownedItemIds:['mint-rally']},{balance:10}]){const f=fixture();f.setHandler(async r=>r.path.includes('catalog')?cat:wallet(A,extra));await f.session.load();assert.throws(()=>f.session.preparePurchase('mint-rally'),{code:extra.balance?'insufficient_funds':'already_owned'});assert.equal(f.ids(),0);assert.equal(posts(f).length,0);}});
test('missing Web Locks disables purchases but allows authoritative viewing',async()=>{const f=fixture({withAccountLock:undefined});await f.session.load();assert.equal(f.session.state().ownedStatus,'confirmed');assert.throws(()=>f.session.preparePurchase('mint-rally'),{code:'shop_locks_unavailable'});assert.equal(f.ids(),0);});
test('explicit confirmation persists BEFORE POST; receipt does not grant current balance or inventory',async()=>{const f=fixture(),c=await prepared(f);await assert.rejects(f.session.confirmPurchase(c.id),{code:'confirmation_required'});f.setHandler(async r=>{if(r.method!=='POST')return r.path.includes('catalog')?cat:wallet();assert.equal(f.data.size,1);assert.equal(JSON.parse([...f.data.values()][0]).requestId,r.body.requestId);return f.result(r.body);});const s=await confirm(f,c);assert.equal(s.busy,false);assert.equal(s.wallet,null);assert.equal(s.inventory,null);assert.equal(s.ownedStatus,'unknown');assert.equal(s.result.balanceAfter,80);assert.equal(s.confirmedPurchases.length,1);assert.equal(f.data.size,0);await f.session.load();assert.equal(f.session.state().wallet.balance,100);});
test('double click and read are blocked throughout preflight and POST',async()=>{const f=fixture(),c=await prepared(f),d=deferred();f.setHandler(r=>r.path.includes('catalog')?Promise.resolve(cat):r.method==='POST'?Promise.resolve(f.result(r.body)):d.promise);const p=confirm(f,c);await assert.rejects(confirm(f,c),{code:'purchase_in_flight'});assert.throws(()=>f.session.load(),{code:'purchase_in_flight'});assert.equal(posts(f).length,0);d.resolve(wallet());await p;assert.equal(posts(f).length,1);});
test('storage failure or readback mismatch prevents POST',async()=>{for(const mode of ['throw','drop']){const f=fixture(),c=await prepared(f);f.storage.setItem=()=>{if(mode==='throw')throw Error('disk');};await assert.rejects(confirm(f,c),{code:'storage_unavailable'});assert.equal(posts(f).length,0);}});
test('competing tabs fail immediately, then durable ambiguity prevents fresh ID',async()=>{const common=shared(),a=fixture({},common),b=fixture({},common);const ca=await prepared(a),cb=await prepared(b),d=deferred();a.setHandler(r=>r.method==='POST'?d.promise:Promise.resolve(r.path.includes('catalog')?cat:wallet()));const p=confirm(a,ca);await assert.rejects(confirm(b,cb),{code:'shop_busy'});assert.equal(b.ids(),0);await new Promise(r=>setImmediate(r));assert.equal(posts(a).length,1);d.resolve({});await assert.rejects(p,{code:'invalid_purchase_response'});assert.equal(common.held.size,0);assert.throws(()=>b.session.preparePurchase('mint-rally'),{code:'reconciliation_required'});assert.equal(b.ids(),0);});
test('pending is reread under lock before ID generation or preflight',async()=>{const common=shared(),a=fixture({},common),b=fixture({},common);const ca=await prepared(a),cb=await prepared(b);a.setHandler(async r=>{if(r.method==='POST')throw error('network',true);return r.path.includes('catalog')?cat:wallet();});await assert.rejects(confirm(a,ca));await assert.rejects(confirm(b,cb),{code:'reconciliation_required'});assert.equal(b.ids(),0);assert.equal(posts(b).length,0);});
test('reload uses same pending ID; wallet read does not settle ambiguous transaction',async()=>{const common=shared(),f=fixture({},common),c=await prepared(f);f.setHandler(async r=>{if(r.method==='POST')throw error('network',true);return r.path.includes('catalog')?cat:wallet();});await assert.rejects(confirm(f,c));const saved=[...f.data.values()][0],g=fixture({},common);await g.session.load();assert.equal([...g.data.values()][0],saved);assert.throws(()=>g.session.preparePurchase('mint-rally'),{code:'reconciliation_required'});await assert.rejects(g.session.reconcilePending(),{code:'confirmation_required'});g.setHandler(async r=>({...g.result(r.body),duplicate:true}));const s=await g.session.reconcilePending({confirmed:true});assert.equal(g.ids(),0);assert.equal(posts(g)[0].body.requestId,JSON.parse(saved).requestId);assert.equal(s.wallet,null);assert.equal(s.ownedStatus,'unknown');assert.equal(g.data.size,0);});
test('later definite failure cannot erase an earlier ambiguous request',async()=>{const f=fixture(),c=await prepared(f);f.setHandler(async r=>{if(r.method==='POST')throw error('network',true);return r.path.includes('catalog')?cat:wallet();});await assert.rejects(confirm(f,c));const saved=[...f.data.values()][0];f.setHandler(async()=>{throw error('profile_not_owned',false);});await assert.rejects(f.session.reconcilePending({confirmed:true}));assert.equal([...f.data.values()][0],saved);assert.equal(f.session.state().status,'reconciliation-required');assert.equal(f.ids(),1);});
test('first definite business rejection clears new pending, never debits locally',async()=>{const f=fixture(),c=await prepared(f);f.setHandler(async r=>{if(r.method==='POST')throw error('insufficient_funds',false);return r.path.includes('catalog')?cat:wallet();});await assert.rejects(confirm(f,c));assert.equal(f.session.state().wallet,null);assert.equal(f.data.size,0);assert.equal(posts(f).length,1);});
test('malformed/misbound outcome preserves pending with no confirmed purchase',async()=>{for(const extra of [{requestId:'another-request'},{accountId:B},{outcomeOnly:false},{balanceAfter:-1},{delta:-19}]){const f=fixture(),c=await prepared(f);f.setHandler(async r=>r.method==='POST'?{...f.result(r.body),...extra}:r.path.includes('catalog')?cat:wallet());await assert.rejects(confirm(f,c),{code:'invalid_purchase_response'});assert.equal(f.data.size,1);assert.equal(f.session.state().confirmedPurchases.length,0);}});
test('account change during POST aborts signal and preserves prior account pending',async()=>{const f=fixture(),c=await prepared(f),d=deferred();f.setHandler(r=>r.method==='POST'?d.promise:Promise.resolve(r.path.includes('catalog')?cat:wallet()));const p=confirm(f,c);await new Promise(r=>setImmediate(r));const req=posts(f)[0];f.account(B);const s=f.session.syncAccount();assert.equal(req.signal.aborted,true);assert.equal(s.wallet,null);assert.equal(s.confirmation,null);d.resolve(f.result(req.body));await assert.rejects(p,{code:'stale_response'});assert.equal(f.session.state().confirmedPurchases.length,0);assert.equal(f.data.size,1);});
test('dispose blanks all transient state and rejects late responses',async()=>{const f=fixture(),c=await prepared(f),d=deferred();f.setHandler(r=>r.method==='POST'?d.promise:Promise.resolve(r.path.includes('catalog')?cat:wallet()));const p=confirm(f,c);await new Promise(r=>setImmediate(r));const req=posts(f)[0];f.session.dispose();d.resolve(f.result(req.body));await assert.rejects(p,{code:'stale_response'});const s=f.session.state();assert.equal(s.wallet,null);assert.equal(s.accountId,null);assert.equal(s.inventory,null);assert.equal(s.result,null);assert.equal(s.confirmation,null);assert.equal(req.signal.aborted,true);await assert.rejects(f.session.reconcilePending({confirmed:true}),{code:'disposed'});assert.equal(f.data.size,1);});
test('signed-out account clears previous ownership and confirmation',async()=>{const f=fixture();await prepared(f);f.account(null);const s=f.session.syncAccount();assert.equal(s.accountId,null);assert.equal(s.wallet,null);assert.equal(s.ownedStatus,'unknown');assert.equal(s.status,'signed-out');assert.throws(()=>f.session.load(),{code:'account_required'});});
test('reset rejects A-B-A stale read',async()=>{const f=fixture(),d=deferred();f.setHandler(r=>r.path.includes('catalog')?Promise.resolve(cat):d.promise);const p=f.session.load();f.session.reset();d.resolve(wallet());await assert.rejects(p,{code:'stale_response'});assert.equal(f.session.state().wallet,null);});
test('delayed read cannot race a prepared confirmation or reconciliation',async()=>{const f=fixture(),c=await prepared(f),d=deferred();f.setHandler(r=>r.path.includes('catalog')?Promise.resolve(cat):d.promise);const p=f.session.load({refresh:true});await assert.rejects(confirm(f,c),{code:'confirmation_stale'});await assert.rejects(f.session.reconcilePending({confirmed:true}),{code:'read_in_flight'});assert.equal(posts(f).length,0);d.resolve(wallet(A,{revision:5}));await p;await assert.rejects(confirm(f,c),{code:'confirmation_stale'});assert.equal(posts(f).length,0);});
test('new server revision/price/ownership invalidates confirmation before persistence',async()=>{for(const change of ['revision','price','owned']){const f=fixture(),c=await prepared(f);f.setHandler(async r=>r.path.includes('catalog')?(change==='price'?{...cat,items:[{...cat.items[0],price:21}]}:cat):wallet(A,change==='revision'?{revision:6}:change==='owned'?{ownedItemIds:['mint-rally']}:{}));await assert.rejects(confirm(f,c),{code:change==='owned'?'already_owned':'confirmation_stale'});assert.equal(f.ids(),0);assert.equal(f.data.size,0);assert.equal(posts(f).length,0);}});
test('expired confirmation cannot start preflight or POST',async()=>{const f=fixture(),c=await prepared(f);f.time(40000);await assert.rejects(confirm(f,c),{code:'confirmation_stale'});assert.equal(f.calls.length,2);});
test('disabled response during preflight clears state and performs no POST',async()=>{const f=fixture(),c=await prepared(f);f.setHandler(async()=>{throw error('currency_disabled',false);});await assert.rejects(confirm(f,c));assert.equal(f.session.state().enabled,false);assert.equal(f.session.state().wallet,null);assert.equal(f.session.state().inventory,null);assert.equal(posts(f).length,0);});
test('cleanup failure retains request for reconciliation even after known outcome',async()=>{const f=fixture(),c=await prepared(f);f.storage.removeItem=()=>{throw Error('disk');};const s=await confirm(f,c);assert.equal(s.status,'reconciliation-required');assert.equal(s.pending.requestId,'request-1');assert.equal(s.wallet,null);});
test('corrupt pending fails closed before transport',()=>{const f=fixture();f.data.set('polytrack-shop-pending-v1:'+A,'{}');assert.throws(()=>f.session.load(),{code:'invalid_pending'});assert.equal(f.calls.length,0);});
test('real transport integration uses mocked I/O, revision 316 and exact request JSON',async()=>{const calls=[];const transport=createShopTransport({revision:316,getToken:async()=> 'test-token',fetch:async(url,init)=>{calls.push({url,init});const body=init.body&&JSON.parse(init.body);return new Response(JSON.stringify(init.method==='POST'?{op:'purchase',accountId:A,itemId:body.itemId,requestId:body.requestId,outcomeOnly:true,balanceAfter:80,walletRevision:4,alreadyOwned:false,duplicate:false,delta:-20,carStyle:'encoded'}:url.includes('catalog')?cat:wallet()),{status:200});}});const f=fixture({transport}),c=await prepared(f);const s=await confirm(f,c);assert.equal(calls.length,5);for(const row of calls)assert.equal(row.init.headers['X-PolyTrack-Revision'],'316');assert.deepEqual(JSON.parse(calls.at(-1).init.body),{accountId:A,requestId:'request-1',itemId:'mint-rally'});assert.equal(s.wallet,null);assert.equal(s.ownedStatus,'unknown');});


test('cache reads do not slide server freshness indefinitely',async()=>{
 const f=fixture();await f.session.load();f.time(20000);await f.session.load();assert.equal(f.calls.length,2);
 f.time(31000);await f.session.load();assert.equal(f.calls.length,4);
});
test('failed refresh invalidates previously cached authoritative state',async()=>{
 const f=fixture();await f.session.load();f.setHandler(async()=>{throw error('network',false);});
 await assert.rejects(f.session.load({refresh:true}));const count=f.calls.length;
 await assert.rejects(f.session.load());assert.equal(f.calls.length,count+2);assert.equal(f.session.state().wallet,null);
});
test('authoritative equipment projection is bound to inventory and equip revision',async()=>{
 const e={itemId:'mint-rally',catalogVersion:1,carStyle:'encoded',equippedAt:100,revision:2,ownerUid:'must-not-be-exposed'};
 const f=fixture();f.setHandler(async r=>r.path.includes('catalog')?cat:wallet(A,{ownedItemIds:['mint-rally'],equipRevision:2,equipped:e}));
 await f.session.load();assert.equal(f.session.state().wallet.equipped.ownerUid,undefined);assert.equal(f.session.state().wallet.equipped.revision,2);
 for(const extra of [{ownedItemIds:[]},{equipRevision:1}]){
  f.setHandler(async r=>r.path.includes('catalog')?cat:wallet(A,{ownedItemIds:['mint-rally'],equipRevision:2,equipped:e,...extra}));
  await assert.rejects(f.session.load({refresh:true}),{code:'invalid_wallet'});assert.equal(f.session.state().ownedStatus,'unknown');
 }
});

function profileFixture() {
  const common=shared(),calls=[];let who=A,clock=100,nonce=0,serverPrice=20,serverCatalog=null,heldWallet=null;
  const wallets=new Map(),getWallet=id=>{
    if(!wallets.has(id))wallets.set(id,{accountId:id,catalogVersion:2,balance:100,revision:3,
      inventoryComplete:true,ownedItemIds:[],equipRevision:0,equipped:null});return wallets.get(id);
  };
  const transport=async req=>{
    calls.push(req);
    if(req.method==='GET'){
      if(req.path.includes('/catalog'))return structuredClone(serverCatalog||{version:2,items:PROFILE_SHOP_CATALOG});
      const id=new URL(req.path,'http://offline').searchParams.get('accountId');
      const result=structuredClone(getWallet(id));
      if(heldWallet){const held=heldWallet;heldWallet=null;held.started();await held.promise;}
      return result;
    }
    const b=req.body,w=getWallet(b.accountId);
    if(b.catalogVersion!==2||b.expectedPrice!==serverPrice||b.expectedWalletRevision!==w.revision)
      throw Object.assign(error('quote_stale',false),{status:409,notCommitted:true});
    w.balance-=serverPrice;w.revision++;w.ownedItemIds.push(b.itemId);
    return {op:'purchase',accountId:b.accountId,requestId:b.requestId,itemId:b.itemId,itemKind:'profile-cosmetic',catalogVersion:2,
      outcomeOnly:true,delta:-serverPrice,balanceAfter:w.balance,walletRevision:w.revision,alreadyOwned:false,duplicate:false};
  };
  const session=createShopSession({transport,storage:common.storage,getAccountId:()=>who,makeRequestId:()=> 'profile-request-'+(++nonce),
    withAccountLock:common.withAccountLock,now:()=>clock,enabled:true});
  return{session,calls,...common,wallet:getWallet,account:id=>who=id,time:value=>clock=value,
    price:value=>serverPrice=value,catalog:value=>serverCatalog=value,
    holdWallet(){let release,started;const promise=new Promise(r=>release=r),ready=new Promise(r=>started=r);heldWallet={promise,started};return{ready,release};}};
}

test('v2 completion reuses only a real validated catalog, always reads wallet, and explicit refresh refetches catalog',async()=>{
  const f=profileFixture();await f.session.load();assert.equal(f.calls.length,2);
  const chosen=f.session.preparePurchase(PROFILE_SHOP_CATALOG[0].id);await f.session.confirmPurchase(chosen.id,{confirmed:true});
  assert.equal(f.calls.length,3);const done=await f.session.load({refresh:true,completion:true});
  assert.equal(f.calls.length,4);assert.match(f.calls[3].path,/\/wallet\?/);assert.equal(done.wallet.balance,80);
  assert.deepEqual(done.inventory.ownedItemIds,[PROFILE_SHOP_CATALOG[0].id]);
  await f.session.load({refresh:true});assert.equal(f.calls.length,6);assert.equal(f.calls[4].path,'/v1/shop/catalog');
});

test('completion never reuses cached wallet even without refresh flag or after catalog age changes',async()=>{
  const f=profileFixture();await f.session.load();f.wallet(A).balance=77;f.wallet(A).revision=7;
  let current=await f.session.load({completion:true});assert.equal(f.calls.length,3);assert.equal(current.wallet.balance,77);
  f.time(60000);f.wallet(A).revision=8;current=await f.session.load({completion:true});
  assert.equal(current.wallet.revision,8);assert.equal(f.calls.length,4);assert.equal(f.calls.filter(r=>r.path.includes('/catalog')).length,1);
});

test('v2 completion catalog version mismatch fails closed without automatic fetch or stale ownership',async()=>{
  const f=profileFixture();await f.session.load();f.wallet(A).catalogVersion=3;
  await assert.rejects(f.session.load({refresh:true,completion:true}),{code:'invalid_inventory'});
  assert.equal(f.calls.length,3);assert.equal(f.session.state().wallet,null);assert.equal(f.session.state().catalog,null);
  assert.equal(f.session.state().ownedStatus,'unknown');assert.equal(posts(f).length,0);
  f.wallet(A).catalogVersion=2;await f.session.load({refresh:true});assert.equal(f.calls.length,5);
  assert.equal(f.calls[3].path,'/v1/shop/catalog');
});

test('malformed server catalog cannot use bundled static catalog as validation or purchase authority',async()=>{
  const f=profileFixture();f.catalog({version:2,items:[{...PROFILE_SHOP_CATALOG[0],price:0}]});
  await assert.rejects(f.session.load(),{code:'invalid_catalog'});assert.equal(f.session.state().wallet,null);
  assert.throws(()=>f.session.preparePurchase(PROFILE_SHOP_CATALOG[0].id),{code:'wallet_unknown'});
  f.catalog(null);const before=f.calls.length;await f.session.load({completion:true});
  assert.equal(f.calls.length-before,2);assert.equal(f.calls[before].path,'/v1/shop/catalog');
});

test('account A-B-A and same-account auth reset clear the v2 catalog memo before completion',async()=>{
  const f=profileFixture();await f.session.load();
  for(const id of [B,A]){f.account(id);f.session.syncAccount();const before=f.calls.length;
    await f.session.load({refresh:true,completion:true});assert.equal(f.calls.length-before,2);assert.equal(f.calls[before].path,'/v1/shop/catalog');}
  f.session.reset();const before=f.calls.length;await f.session.load({completion:true});assert.equal(f.calls.length-before,2);
  f.session.dispose();assert.throws(()=>f.session.load({completion:true}),{code:'disposed'});
});

test('late v2 completion after auth reset cannot replace the new account catalog memo',async()=>{
  const f=profileFixture();await f.session.load();const held=f.holdWallet(),old=f.session.load({refresh:true,completion:true});await held.ready;
  f.account(B);f.session.reset();await f.session.load({completion:true});assert.equal(f.session.state().wallet.accountId,B);
  held.release();await assert.rejects(old,{code:'stale_response'});const before=f.calls.length;
  const current=await f.session.load({completion:true});assert.equal(f.calls.length-before,1);assert.equal(current.wallet.accountId,B);
});

test('stale memo price cannot authorize a charge and a later explicit catalog refresh validates again',async()=>{
  const f=profileFixture();await f.session.load();const chosen=f.session.preparePurchase(PROFILE_SHOP_CATALOG[0].id);f.price(21);
  const before=f.calls.length;await assert.rejects(f.session.confirmPurchase(chosen.id,{confirmed:true}),{code:'quote_stale'});
  assert.equal(f.calls.length-before,1);assert.equal(f.data.size,0);assert.equal(f.wallet(A).balance,100);assert.equal(f.session.state().wallet,null);
  f.catalog({version:2,items:[{...PROFILE_SHOP_CATALOG[0],price:21}]});await assert.rejects(f.session.load({refresh:true}),{code:'invalid_catalog'});
  assert.equal(posts(f).length,1);
});

test('legacy v1 completion still refetches catalog and wallet and keeps legacy preflight intact',async()=>{
  const f=fixture(),chosen=await prepared(f);await confirm(f,chosen);assert.equal(f.calls.length,5);
  const before=f.calls.length;await f.session.load({refresh:true,completion:true});
  assert.equal(f.calls.length-before,2);assert.equal(f.calls[before].path,'/v1/shop/catalog');assert.match(f.calls[before+1].path,/\/wallet\?/);
});
