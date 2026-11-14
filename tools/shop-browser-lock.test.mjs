import test from 'node:test';
import assert from 'node:assert/strict';
import {createShopBrowserLock} from './shop-browser-lock.mjs';
const A = 'a'.repeat(64), B = 'b'.repeat(64);
function locks() {
  const held = new Set();
  return {held, async request(name, options, callback) {
    assert.deepEqual(options, {mode:'exclusive', ifAvailable:true});
    if (held.has(name)) return callback(null);
    held.add(name);
    try {return await callback({name});} finally {held.delete(name);}
  }};
}
const deferred = () => {let resolve;const promise = new Promise(r => resolve=r);return {resolve,promise};};
test('missing Web Locks fails closed without executing callback', async () => {
  let calls=0; await assert.rejects(createShopBrowserLock({locks:null})(A,()=>calls++),{code:'shop_locks_unavailable'});assert.equal(calls,0);
});
test('account lock is exclusive, nonqueued and held across async work', async () => {
  const manager=locks(),run=createShopBrowserLock({locks:manager}),d=deferred();
  const first=run(A,()=>d.promise);let calls=0;
  await assert.rejects(run(A,()=>calls++),{code:'shop_busy'});assert.equal(calls,0);
  assert.equal(await run(B,()=> 'other-account'),'other-account');
  d.resolve('done');assert.equal(await first,'done');assert.equal(await run(A,()=> 'released'),'released');assert.equal(manager.held.size,0);
});
test('errors release lock without swallowing original failure',async()=>{
  const manager=locks(),run=createShopBrowserLock({locks:manager});const error=Error('sent unknown');
  await assert.rejects(run(A,()=>{throw error;}),e=>e===error);assert.equal(await run(A,()=>42),42);
});
test('aborted lifecycle never starts work',async()=>{
  const run=createShopBrowserLock({locks:locks()}),controller=new AbortController();controller.abort();let calls=0;
  await assert.rejects(run(A,()=>calls++,{signal:controller.signal}),{code:'shop_lock_cancelled'});assert.equal(calls,0);
});
test('lifecycle changes before lock callback reject stale work',async()=>{
  const controller=new AbortController();let calls=0;
  const run=createShopBrowserLock({locks:{request:async(name,options,callback)=>{controller.abort();return callback({name});}}});
  await assert.rejects(run(A,()=>calls++,{signal:controller.signal}),{code:'shop_lock_cancelled'});assert.equal(calls,0);
});
test('account names are stable and invalid identifiers cannot execute',async()=>{
  const names=[],run=createShopBrowserLock({locks:{request:async(name,options,callback)=>{names.push(name);return callback({name});}}});
  await run(A,()=>{});await run(A,()=>{});assert.deepEqual(names,['polytrack-shop-account-v1:'+A,'polytrack-shop-account-v1:'+A]);
  await assert.rejects(run('guest',()=>assert.fail()),{code:'invalid_shop_lock'});await assert.rejects(run(A,null),{code:'invalid_shop_lock'});
});

test('native browser locks exclude tabs and release on reload; durable request reconciles unchanged',
 {skip:!process.env.PLAYWRIGHT_MODULE,timeout:30000},async()=>{
  const {createRequire}=await import('node:module');
  const {createServer}=await import('node:http');
  const {readFile}=await import('node:fs/promises');
  const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE);
  const sources=new Map(await Promise.all(['shop-session.mjs','shop-browser-lock.mjs','profile-shop-catalog.mjs'].map(async name=>['/'+name,await readFile(new URL(name,import.meta.url),'utf8')])));
  const server=createServer((req,res)=>{
    if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Offline shop lock regression</title>');}
    else if(sources.has(req.url)){res.setHeader('Content-Type','text/javascript');res.end(sources.get(req.url));}
    else{res.statusCode=404;res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port,blocked=[];
  let browser;
  try{
    browser=await chromium.launch({headless:true});const context=await browser.newContext();
    await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){blocked.push(route.request().url());return route.abort();}return route.continue();});
    const a=await context.newPage(),b=await context.newPage();await a.goto(origin);await b.goto(origin);
    async function setup(page,hold){return page.evaluate(async({hold})=>{
      const {createShopSession}=await import('/shop-session.mjs'),{createShopBrowserLock}=await import('/shop-browser-lock.mjs');
      const id='a'.repeat(64);globalThis.ids=0;globalThis.posts=[];globalThis.outcome=null;
      const transport=async req=>{
        if(req.method==='POST'){
          globalThis.posts.push(req.body);
          if(hold)return new Promise(resolve=>{globalThis.resolvePost=resolve;});
          return {op:'purchase',...req.body,outcomeOnly:true,balanceAfter:80,walletRevision:4,alreadyOwned:false,duplicate:true,delta:-20,carStyle:'encoded'};
        }
        return req.path.includes('catalog')?{version:1,items:[{id:'mint-rally',label:'Mint',price:20}]}:
          {accountId:id,catalogVersion:1,balance:100,revision:3,inventoryComplete:true,ownedItemIds:[],equipRevision:0,equipped:null};
      };
      globalThis.session=createShopSession({enabled:true,transport,storage:localStorage,getAccountId:()=>id,
        makeRequestId:()=> 'browser-request-'+(++globalThis.ids),withAccountLock:createShopBrowserLock({locks:navigator.locks})});
      await session.load();globalThis.choice=session.preparePurchase('mint-rally');return !!navigator.locks;
    },{hold});}
    assert.equal(await setup(a,true),true);await setup(b,false);
    await a.evaluate(()=>{globalThis.operation=session.confirmPurchase(choice.id,{confirmed:true}).then(value=>globalThis.outcome=value,error=>globalThis.outcome={error:error.code});});
    await a.waitForFunction(()=>globalThis.posts.length===1);
    const original=await a.evaluate(()=>JSON.parse(localStorage.getItem('polytrack-shop-pending-v1:'+'a'.repeat(64))));
    const busy=await b.evaluate(async()=>{try{await session.confirmPurchase(choice.id,{confirmed:true});return 'unexpected';}catch(error){return error.code;}});
    // The durable record is already visible, so the session may reject even before
    // lock acquisition. Prove native lock exclusion separately while A holds it.
    assert.equal(busy,'reconciliation_required');
    assert.equal(await b.evaluate(async()=>{
      const {createShopBrowserLock}=await import('/shop-browser-lock.mjs');
      try{await createShopBrowserLock()('a'.repeat(64),()=>{throw Error('must-not-run');});return 'unexpected';}catch(error){return error.code;}
    }),'shop_busy');
    assert.equal(await b.evaluate(()=>globalThis.ids),0);
    await a.reload();
    await b.waitForFunction(async()=>!(await navigator.locks.query()).held.some(lock=>lock.name==='polytrack-shop-account-v1:'+'a'.repeat(64)));
    const result=await b.evaluate(async()=>{const s=await session.reconcilePending({confirmed:true});return {s,posts:globalThis.posts,ids:globalThis.ids,raw:localStorage.getItem('polytrack-shop-pending-v1:'+'a'.repeat(64))};});
    assert.equal(result.posts.length,1);assert.equal(result.posts[0].requestId,original.requestId);
    assert.equal(result.ids,0);assert.equal(result.raw,null);assert.equal(result.s.wallet,null);assert.equal(result.s.ownedStatus,'unknown');assert.equal(result.s.result.duplicate,true);
    assert.deepEqual(blocked,[]);
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
});
