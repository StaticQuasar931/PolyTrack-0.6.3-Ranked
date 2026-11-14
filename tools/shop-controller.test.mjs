import test from 'node:test';
import assert from 'node:assert/strict';
import {createShopControllerStore,createShopController} from './shop-controller.mjs';
const A='a'.repeat(64),B='b'.repeat(64);
const cat={version:1,items:[{id:'mint-rally',label:'Mint Rally existing preset',price:20}]};
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const err=(code,ambiguous)=>Object.assign(Error(code),{code,ambiguous});
function fixture(overrides={}){
 let account=A,scope='login-1',clock=100,ids=0,mode=null,readGate=null,postGate=null;
 const local=new Map(),calls=[],states=[],records=new Map(),wallets=new Map();
 const wallet=id=>{if(!wallets.has(id))wallets.set(id,{accountId:id,catalogVersion:1,balance:100,revision:0,inventoryComplete:true,ownedItemIds:[],equipRevision:0,equipped:null});return wallets.get(id);};
 const transport=async req=>{
  calls.push(req);
  if(req.method==='GET'){
   if(readGate)await readGate.promise;
   if(mode==='read-fail'||mode==='refresh-fail'&&records.size)throw err('read_failed',false);
   return structuredClone(req.path.includes('/catalog')?cat:wallet(new URL(req.path,'http://offline').searchParams.get('accountId')));
  }
  if(mode==='definite')throw err('insufficient_funds',false);
  const b=req.body,key=b.accountId+':'+b.requestId,w=wallet(b.accountId);
  if(records.has(key))return {...records.get(key),duplicate:true};
  if(w.ownedItemIds.includes(b.itemId))throw err('item_already_owned',false);
  w.balance-=20;w.revision++;w.ownedItemIds.push(b.itemId);
  const result={op:'purchase',...b,outcomeOnly:true,balanceAfter:w.balance,walletRevision:w.revision,alreadyOwned:false,duplicate:false,delta:-20,carStyle:'encoded-existing-preset'};
  records.set(key,result);if(postGate)await postGate.promise;if(mode==='lost')throw err('network',true);return result;
 };
 const storage={getItem:k=>local.get(k)??null,setItem:(k,v)=>local.set(k,v),removeItem:k=>local.delete(k)};
 const store=createShopControllerStore({transport,storage,
  getAccountId:()=>account,getAuthScope:()=>scope,makeRequestId:()=> 'controller-request-'+(++ids),withAccountLock:async(id,work)=>work(),now:()=>clock,enabled:true,...overrides});
 store.subscribe(s=>states.push(s));
 return {store,transport,storage,calls,states,local,records,wallet,postGate:value=>postGate=value,account:id=>account=id,auth:value=>scope=value,time:value=>clock=value,mode:value=>mode=value,gate:value=>readGate=value,ids:()=>ids};
}
function mount(f,callbacks={}){
 const rendered=[];let disposed=0;
 const controller=createShopController({root:{},store:f.store,mountShopPreview:(root,options)=>{rendered.push(options);const cleanup=()=>disposed++;cleanup.update=options=>rendered.push(options);return cleanup;},...callbacks});
 return {controller,rendered,view:()=>rendered.at(-1),disposed:()=>disposed};
}
const intent=s=>({accountId:s.accountId,itemId:'mint-rally',price:20,walletRevision:s.wallet.revision});
const posts=f=>f.calls.filter(c=>c.method==='POST');

test('default OFF and construction/mount do not fetch or POST',async()=>{
 const f=fixture({enabled:undefined}),ui=mount(f);assert.equal(f.calls.length,0);assert.equal(ui.view().purchaseEnabled,false);
 assert.throws(()=>ui.controller.open(),{code:'disabled'});await assert.rejects(f.store.purchase({},{confirmed:true}),{code:'disabled'});assert.equal(f.calls.length,0);
});
test('two views share account-scoped read dedupe and non-sliding cache',async()=>{
 const f=fixture(),a=mount(f),b=mount(f);const p=a.controller.open(),q=b.controller.open();assert.equal(p,q);await p;
 assert.equal(f.calls.length,2);assert.equal(a.view().wallet.balance,100);assert.equal(b.view().inventory.status,'confirmed');assert.equal(f.store.state().loading,false);
 f.time(20000);await a.controller.open();assert.equal(f.calls.length,2);f.time(31000);await b.controller.open();assert.equal(f.calls.length,4);
 f.account(B);f.store.reset();assert.equal(a.view().wallet.status,'unknown');await a.controller.open();assert.equal(a.view().wallet.accountId,B);assert.equal(f.calls.length,6);
});
test('purchase requires explicit confirmation and exact rendered intent',async()=>{
 const f=fixture();await f.store.load();const current=intent(f.store.state());
 await assert.rejects(f.store.purchase(current),{code:'confirmation_required'});
 for(const changed of [{accountId:B},{price:0},{walletRevision:99},{itemId:'fake'}])await assert.rejects(f.store.purchase({...current,...changed},{confirmed:true}),{code:'confirmation_stale'});
 assert.equal(posts(f).length,0);assert.equal(f.ids(),0);
});
test('UI confirmation -> persistent session POST -> historical outcome -> GET -> authoritative rerender',async()=>{
 const f=fixture(),a=mount(f),b=mount(f);await a.controller.open();const result=await a.view().actions.onPurchase(intent(f.store.state()));
 assert.equal(posts(f).length,1);assert.equal(f.calls.length,7);assert.equal(result.confirmed,true);assert.equal(result.outcome.outcomeOnly,true);
 assert.equal(result.wallet.balance,80);assert.deepEqual(result.inventory.ownedIds,['mint-rally']);
 const receiptState=f.states.find(s=>s.phase==='outcome');assert.equal(receiptState.wallet,null);assert.equal(receiptState.inventory,null);
 assert.equal(a.view().wallet.balance,80);assert.equal(b.view().wallet.balance,80);assert.deepEqual(a.view().inventory.ownedIds,['mint-rally']);
 assert.equal(f.local.size,0);assert.equal(f.store.state().busy,false);assert.equal(f.calls.some(c=>/claim|equip/.test(c.path)),false);
});
test('double click and refresh blocked during purchase; no additional ID',async()=>{
 const f=fixture(),ui=mount(f);await ui.controller.open();const input=intent(f.store.state()),d=defer();f.gate(d);
 const p=ui.view().actions.onPurchase(input);await assert.rejects(f.store.purchase(input,{confirmed:true}),{code:'purchase_in_flight'});
 assert.throws(()=>ui.controller.refresh(),{code:'purchase_in_flight'});assert.equal(ui.view().purchaseEnabled,false);
 f.gate(null);d.resolve();await p;assert.equal(posts(f).length,1);assert.equal(f.ids(),1);
});
test('failed completion GET never promotes receipt balance or ownership',async()=>{
 const f=fixture(),ui=mount(f);await ui.controller.open();f.mode('refresh-fail');
 await assert.rejects(ui.view().actions.onPurchase(intent(f.store.state())),{code:'read_failed'});
 const s=f.store.state();assert.equal(s.phase,'refresh-required');assert.equal(s.outcome.balanceAfter,80);assert.equal(s.wallet,null);assert.equal(s.inventory,null);
 assert.equal(ui.view().wallet.status,'unknown');assert.equal(ui.view().inventory.status,'unknown');assert.equal(posts(f).length,1);
 f.mode(null);await ui.controller.refresh();assert.equal(ui.view().wallet.balance,80);assert.equal(posts(f).length,1);
});
test('ambiguous committed request survives auth reset; only explicit same-ID reconcile submits',async()=>{
 const f=fixture(),ui=mount(f);await ui.controller.open();f.mode('lost');await assert.rejects(ui.view().actions.onPurchase(intent(f.store.state())),{code:'network'});
 const saved=[...f.local.values()][0],first=posts(f)[0].body.requestId;assert.equal(f.store.state().phase,'reconciliation-required');
 f.mode(null);f.store.reset();await ui.controller.open();assert.equal([...f.local.values()][0],saved);assert.equal(posts(f).length,1);assert.equal(ui.view().purchaseEnabled,false);
 await assert.rejects(ui.controller.reconcile(),{code:'confirmation_required'});
 const done=await ui.controller.reconcile({confirmed:true});assert.equal(done.outcome.duplicate,true);assert.equal(posts(f).length,2);assert.equal(posts(f)[1].body.requestId,first);assert.equal(f.wallet(A).balance,80);assert.equal(f.ids(),1);
});
test('definite rejection never computes a local balance or retries',async()=>{
 const f=fixture(),ui=mount(f);await ui.controller.open();f.mode('definite');await assert.rejects(ui.view().actions.onPurchase(intent(f.store.state())),{code:'insufficient_funds'});
 assert.equal(ui.view().wallet.status,'unknown');assert.equal(posts(f).length,1);assert.equal(f.local.size,0);assert.equal(f.wallet(A).balance,100);
});
test('account/auth scope reset invalidates late reads and both mounted views',async()=>{
 const f=fixture(),a=mount(f),b=mount(f),d=defer();f.gate(d);const p=a.controller.open();await Promise.resolve();await Promise.resolve();
 f.account(B);f.auth('login-2');f.store.reset();assert.equal(a.view().accountId,B);assert.equal(b.view().wallet.status,'unknown');
 f.gate(null);d.resolve();await assert.rejects(p,{code:'stale_response'});await b.controller.open();assert.equal(a.view().wallet.accountId,B);
});
test('same-account new authentication scope clears cached inventory before new reads',async()=>{
 const f=fixture(),ui=mount(f);await ui.controller.open();f.auth('reauth-new-owner');const s=f.store.state();assert.equal(s.wallet,null);assert.equal(ui.view().wallet.status,'unknown');
 await ui.controller.open();assert.equal(f.calls.length,4);
});
test('auth absence masks cached/pending state and blocks network',async()=>{
 const f=fixture(),ui=mount(f);await ui.controller.open();f.auth(null);const s=f.store.state();assert.equal(s.wallet,null);assert.equal(s.pending,null);assert.equal(s.accountId,null);assert.equal(ui.view().purchaseEnabled,false);
 await assert.doesNotReject(ui.controller.open());assert.equal(f.calls.length,2);
});
test('car preview resolves only known existing catalog IDs, with no POST/save/equip',async()=>{
 const f=fixture(),calls=[],ui=mount(f,{onCarPreview:value=>calls.push(value),onRestorePreview:()=>calls.push('restore')});await ui.controller.open();
 await ui.view().actions.onPreview({id:'mint-rally',style:'untrusted-extra'});assert.equal(calls[0].itemId,'mint-rally');assert.equal(calls[0].previewOnly,true);assert.equal(calls[0].isCurrent(),true);assert.equal(calls[0].style,undefined);
 await assert.rejects(ui.view().actions.onPreview({id:'not-in-catalog'}),{code:'preview_unavailable'});assert.equal(posts(f).length,0);
 ui.controller.dispose();assert.equal(calls.at(-1),'restore');assert.equal(calls[0].signal.aborted,true);assert.equal(calls[0].isCurrent(),false);
});
test('async preview receives cancellation and cannot apply after account cleanup',async()=>{
 const f=fixture(),d=defer();let applied=0,restored=0,context;
 const ui=mount(f,{onCarPreview:async value=>{context=value;await d.promise;if(value.isCurrent())applied++;},onRestorePreview:()=>restored++});await ui.controller.open();
 const p=ui.view().actions.onPreview({id:'mint-rally'});f.account(B);f.store.reset();assert.equal(context.signal.aborted,true);d.resolve();await assert.rejects(p,{code:'stale_response'});assert.equal(applied,0);assert.equal(restored,1);
});
test('preview/navigation require injected callbacks; navigating restores preview',async()=>{
 const f=fixture(),empty=mount(f);await empty.controller.open();assert.equal(empty.view().actions.onPreview,undefined);assert.equal(empty.view().actions.onGarage,undefined);
 let restored=0,garage=0;const ui=mount(f,{onCarPreview:()=>{},onRestorePreview:()=>restored++,onGarage:()=>garage++});
 await ui.view().actions.onPreview({id:'mint-rally'});ui.view().actions.onGarage();assert.equal(restored,1);assert.equal(garage,1);assert.equal(posts(f).length,0);
});
test('view cleanup does not dispose shared store or another view',async()=>{
 const f=fixture(),a=mount(f),b=mount(f);a.controller.dispose();assert.equal(a.disposed(),1);await b.controller.open();assert.equal(b.view().wallet.balance,100);assert.equal(f.store.state().disposed,false);
});
test('disabled transition aborts/clears previews and does not perform reads',async()=>{
 const f=fixture();let restored=0;const ui=mount(f,{onCarPreview:()=>{},onRestorePreview:()=>restored++});await ui.controller.open();await ui.view().actions.onPreview({id:'mint-rally'});
 f.store.setEnabled(false);assert.equal(restored,1);assert.equal(ui.view().wallet.status,'unknown');assert.equal(ui.view().purchaseEnabled,false);assert.equal(f.calls.length,2);
});
test('store disposal clears both views; late read never repopulates balances',async()=>{
 const f=fixture(),a=mount(f),b=mount(f),d=defer();f.gate(d);const p=a.controller.open();await Promise.resolve();await Promise.resolve();
 f.store.dispose();d.resolve();await assert.rejects(p);assert.equal(a.view().wallet.status,'unknown');assert.equal(b.view().inventory.status,'unknown');assert.equal(a.view().purchaseEnabled,false);assert.equal(f.store.state().wallet,null);
});

test('disposed view callbacks and methods cannot submit or fetch',async()=>{
 const f=fixture(),ui=mount(f);await ui.controller.open();const actions=ui.view().actions,input=intent(f.store.state()),count=f.calls.length;
 ui.controller.dispose();await assert.rejects(actions.onPurchase(input),{code:'disposed'});
 assert.throws(()=>ui.controller.open(),{code:'disposed'});assert.throws(()=>ui.controller.refresh(),{code:'disposed'});
 assert.throws(()=>ui.controller.reconcile({confirmed:true}),{code:'disposed'});assert.equal(f.calls.length,count);assert.equal(posts(f).length,0);
});
test('callbacks from an earlier render cannot purchase after account/auth refresh',async()=>{
 const f=fixture(),ui=mount(f);await ui.controller.open();const actions=ui.view().actions,input=intent(f.store.state());
 f.auth('login-2');f.store.reset();await ui.controller.open();
 await assert.rejects(actions.onPurchase(input),{code:'stale_view'});assert.equal(posts(f).length,0);assert.equal(f.ids(),0);
});

test('real mounted preview confirms once and rerenders only authoritative GET data',
 {skip:!process.env.PLAYWRIGHT_MODULE,timeout:45000},async()=>{
 const {createRequire}=await import('node:module'),{createServer}=await import('node:http'),{readFile}=await import('node:fs/promises');
 const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE);
 const names=['shop-controller.mjs','shop-session.mjs','shop-browser-lock.mjs','shop-preview.mjs','shop-preview.css','profile-shop-catalog.mjs','profile-shop-art.mjs'];
 const sources=new Map(await Promise.all(names.map(async name=>['/'+name,await readFile(new URL(name,import.meta.url),'utf8')])));
 const server=createServer((req,res)=>{
  if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><link rel="stylesheet" href="/shop-preview.css"><main></main>');}
  else if(sources.has(req.url)){res.setHeader('Content-Type',req.url.endsWith('.css')?'text/css':'text/javascript');res.end(sources.get(req.url));}
  else{res.statusCode=404;res.end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port,blocked=[];let browser;
 try{
  browser=await chromium.launch({headless:true});const context=await browser.newContext();await context.route('**/*',route=>{
   if(new URL(route.request().url()).origin!==origin){blocked.push(route.request().url());return route.abort();}return route.continue();
  });const page=await context.newPage();await page.goto(origin);
  await page.evaluate(async()=>{
   const {createShopControllerStore,createShopController}=await import('/shop-controller.mjs'),{mountShopPreview}=await import('/shop-preview.mjs');
   const {PROFILE_SHOP_CATALOG}=await import('/profile-shop-catalog.mjs');const id='a'.repeat(64);globalThis.calls=[];globalThis.previews=[];globalThis.restores=0;
   const wallet={accountId:id,catalogVersion:2,balance:100,revision:0,inventoryComplete:true,ownedItemIds:[],equipRevision:0,equipped:null};
   globalThis.store=createShopControllerStore({enabled:false,storage:localStorage,getAccountId:()=>id,getAuthScope:()=> 'offline-owner-generation1',makeRequestId:()=> 'browser-controller-request',transport:async req=>{
    calls.push({path:req.path,method:req.method,body:req.body});
    if(req.method==='GET')return structuredClone(req.path.includes('catalog')?{version:2,items:[PROFILE_SHOP_CATALOG[0]]}:wallet);
    if(!localStorage.getItem('polytrack-shop-pending-v1:'+id))throw Error('missing durable request');
    wallet.balance=80;wallet.revision=1;wallet.ownedItemIds=['profile-pitlane-ticket'];
    return {op:'purchase',...req.body,outcomeOnly:true,delta:-20,balanceAfter:80,walletRevision:1,itemKind:'profile-cosmetic',catalogVersion:2,alreadyOwned:false,duplicate:false};
   }});
   globalThis.controller=createShopController({root:document.querySelector('main'),mountShopPreview,store,
    onCarPreview:value=>{if(value.isCurrent()&&!value.signal.aborted)previews.push({itemId:value.itemId,previewOnly:value.previewOnly});},
    onRestorePreview:()=>restores++});
  });
  assert.equal(await page.evaluate(()=>calls.length),0);
  await page.evaluate(()=>store.setEnabled(true));assert.equal(await page.evaluate(()=>calls.length),0);
  await page.evaluate(()=>controller.open());
  await page.getByRole('button',{name:'Preview',exact:true}).click();assert.deepEqual(await page.evaluate(()=>previews),[{itemId:'profile-pitlane-ticket',previewOnly:true}]);
  await page.getByRole('button',{name:'Buy for 20 CP',exact:true}).click();assert.equal(await page.evaluate(()=>calls.filter(c=>c.method==='POST').length),0);
  await page.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(await page.evaluate(()=>calls.filter(c=>c.method==='POST').length),0);
  await page.getByRole('button',{name:'Buy for 20 CP',exact:true}).click();await page.getByRole('button',{name:'Confirm purchase',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.sp-summary strong')?.textContent==='80 CP');
  assert.equal(await page.getByRole('button',{name:'Apply to draft',exact:true}).isDisabled(),true);
  const result=await page.evaluate(()=>({calls,pending:localStorage.getItem('polytrack-shop-pending-v1:'+'a'.repeat(64)),restores,state:store.state()}));
  assert.equal(result.calls.filter(c=>c.method==='POST').length,1);assert.equal(result.calls.length,4);assert.equal(result.pending,null);assert.equal(result.state.wallet.balance,80);assert.equal(result.state.ownedStatus,'confirmed');assert.equal(result.restores,1);
  assert.equal(result.calls.some(c=>/claim|equip/.test(c.path)),false);assert.deepEqual(blocked,[]);
  await page.evaluate(()=>controller.dispose());assert.equal(await page.locator('.shop-preview').count(),0);
 }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
});


test('a new store reconstructs durable ambiguity and reconciles the original ID',async()=>{
 const f=fixture(),ui=mount(f);await ui.controller.open();f.mode('lost');await assert.rejects(ui.view().actions.onPurchase(intent(f.store.state())));
 const first=posts(f)[0].body.requestId;ui.controller.dispose();f.store.dispose();f.mode(null);
 const restored=createShopControllerStore({transport:f.transport,storage:f.storage,getAccountId:()=>A,getAuthScope:()=> 'reloaded-owner',
  makeRequestId:()=>assert.fail('reconciliation cannot create a request ID'),withAccountLock:async(id,work)=>work(),enabled:true});
 await restored.load();assert.equal(restored.state().pending.requestId,first);assert.equal(posts(f).length,1);
 const result=await restored.reconcile({confirmed:true});assert.equal(result.outcome.duplicate,true);assert.equal(posts(f)[1].body.requestId,first);
 assert.equal(result.wallet.balance,80);assert.equal(f.wallet(A).balance,80);assert.equal(f.local.size,0);
});
test('account reset during a committed POST preserves pending and performs no wrong-account completion GET',async()=>{
 const f=fixture(),ui=mount(f);await ui.controller.open();const d=defer();f.postGate(d);
 const p=ui.view().actions.onPurchase(intent(f.store.state()));await new Promise(resolve=>setImmediate(resolve));assert.equal(posts(f).length,1);
 const count=f.calls.length;f.account(B);f.auth('owner-B-login');f.store.reset();d.resolve();await assert.rejects(p,{code:'stale_response'});
 assert.equal(f.calls.length,count);assert.equal(f.store.state().outcome,null);assert.equal(ui.view().wallet.status,'unknown');assert.equal(f.local.size,1);
 await ui.controller.open();assert.equal(ui.view().wallet.accountId,B);assert.equal(ui.view().wallet.balance,100);assert.deepEqual(ui.view().inventory.ownedIds,[]);
});

test('unauthenticated construction/open/subscribe/reset are safe for missing or invalid account IDs',async()=>{
 for(const id of [null,undefined,'','guest','a'.repeat(63),42,{}])for(const scope of [null,'transition-login'])for(const enabled of [false,true]){
  let f;assert.doesNotThrow(()=>{f=fixture({enabled,getAccountId:()=>id,getAuthScope:()=>scope,storage:{getItem:()=>assert.fail('unauthenticated state must not read storage')}});});
  const ui=mount(f);let observed;assert.doesNotThrow(()=>f.store.subscribe(s=>observed=s));
  assert.doesNotThrow(()=>f.store.reset());await assert.doesNotReject(ui.controller.open());
  const s=f.store.state();assert.equal(s.accountId,null);assert.equal(s.wallet,null);assert.equal(s.inventory,null);assert.equal(s.pending,null);
  assert.equal(observed.ownedStatus,'unknown');assert.equal(ui.view().wallet.status,'unknown');assert.equal(ui.view().purchaseEnabled,false);assert.equal(f.calls.length,0);
 }
});
test('unauthenticated transitions erase previous wallet and suppress late stale read completion',async()=>{
 for(const invalid of [null,undefined,'','guest','a'.repeat(63),42,{}]){
  const f=fixture(),ui=mount(f);await ui.controller.open();assert.equal(ui.view().wallet.balance,100);
  const d=defer();f.gate(d);const pending=ui.controller.refresh();await Promise.resolve();await Promise.resolve();const before=f.calls.length;
  f.account(invalid);assert.doesNotThrow(()=>f.store.state());assert.equal(ui.view().wallet.status,'unknown');assert.doesNotThrow(()=>f.store.reset());assert.doesNotThrow(()=>f.store.subscribe(()=>{}));
  await assert.doesNotReject(ui.controller.open());assert.equal(f.calls.length,before);
  const s=f.store.state();assert.equal(s.accountId,null);assert.equal(s.wallet,null);assert.equal(s.inventory,null);assert.equal(s.outcome,null);assert.equal(s.ownedStatus,'unknown');
  assert.equal(ui.view().wallet.status,'unknown');assert.equal(ui.view().purchaseEnabled,false);
  f.gate(null);d.resolve();await assert.rejects(pending);assert.equal(f.store.state().wallet,null);assert.equal(f.calls.length,before);
  f.account(B);f.store.reset();await ui.controller.open();assert.equal(ui.view().wallet.accountId,B);assert.equal(ui.view().wallet.balance,100);
 }
});


