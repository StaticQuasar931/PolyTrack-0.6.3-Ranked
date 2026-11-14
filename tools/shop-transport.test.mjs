import test from 'node:test';import assert from 'node:assert/strict';import{createShopTransport}from'./shop-transport.mjs';
const accountId='a'.repeat(64),body={accountId,requestId:'purchase_123',itemId:'mint-rally'};
const response=value=>new Response(JSON.stringify(value));
test('valid requests use only pinned Worker and never credentials/caches/redirects',async()=>{
 let calls=0;const run=createShopTransport({revision:316,getToken:async()=> 'private-token',fetch:async(url,options)=>{calls++;assert.equal(url,'https://polytrack-ranked-worker.staticquasar931.workers.dev/v1/shop/purchase');assert.equal(options.headers['X-PolyTrack-Revision'],'316');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');assert.equal(JSON.parse(options.body).requestId,body.requestId);return response({balanceAfter:12});}});
 assert.deepEqual(await run({path:'/v1/shop/purchase',method:'POST',body}),{balanceAfter:12});assert.equal(calls,1);
});
test('invalid URLs and commands make zero token or network requests',async()=>{
 let calls=0;const run=createShopTransport({revision:316,getToken:async()=>{calls++;return 'token';},fetch:async()=>{calls++;return response({});}});
 for(const path of ['https://evil.example/v1/shop/catalog','//evil.example/v1/shop/catalog','/v1/shop/catalog#x','/v1/shop/catalog?x=1','/v1/currency/wallet?accountId='+accountId+'&x=1','/v1/shop/purchase'])await assert.rejects(run({path}));
 await assert.rejects(run({path:'/v1/shop/purchase',method:'POST',body:{...body,price:0}}));assert.equal(calls,0);
});
test('an uncertain POST is never retried and remains ambiguous',async()=>{
 let calls=0;const run=createShopTransport({revision:316,getToken:async()=> 'token',fetch:async()=>{calls++;throw Error('lost response');}});
 await assert.rejects(run({path:'/v1/shop/purchase',method:'POST',body}),e=>e.ambiguous&&e.code==='shop_unavailable');assert.equal(calls,1);
});
test('disabled feature and business rejection are definite, not ambiguous',async()=>{
 for(const[status,code]of[[503,'currency_disabled'],[409,'insufficient_funds']]){const run=createShopTransport({revision:316,getToken:async()=> 'token',fetch:async()=>new Response(JSON.stringify({error:code}),{status})});await assert.rejects(run({path:'/v1/shop/purchase',method:'POST',body}),e=>!e.ambiguous&&e.status===status&&e.code===code);}
});
test('malformed, oversized, or 503 POST responses retain uncertain result',async()=>{
 for(const r of [new Response('{'),new Response('x'.repeat(65537)),new Response('{"error":"currency_unavailable"}',{status:503})]){
 const run=createShopTransport({revision:316,getToken:async()=> 'token',fetch:async()=>r});await assert.rejects(run({path:'/v1/shop/purchase',method:'POST',body}),e=>e.ambiguous);
 }
});
test('aborted or unauthenticated operations do not send requests',async()=>{
 let calls=0;const c=new AbortController();c.abort();const run=createShopTransport({revision:316,getToken:async()=>'',fetch:async()=>{calls++;return response({});}});await assert.rejects(run({path:'/v1/shop/catalog',signal:c.signal}));await assert.rejects(run({path:'/v1/shop/catalog'}));assert.equal(calls,0);
});
test('GET failures do not imply a purchase happened',async()=>{
 const run=createShopTransport({revision:316,getToken:async()=> 'token',fetch:async()=>{throw Error('offline');}});await assert.rejects(run({path:'/v1/currency/wallet?accountId='+accountId}),e=>!e.ambiguous);
});
test('token resolution is bounded even if the auth provider ignores cancellation',async()=>{
 let calls=0;const run=createShopTransport({revision:316,timeoutMs:5,getToken:()=>new Promise(()=>{}),fetch:async()=>{calls++;return response({});}});
 await assert.rejects(run({path:'/v1/shop/catalog'}),e=>e.code==='shop_request_cancelled'&&!e.ambiguous);assert.equal(calls,0);
});
test('request identity is frozen before asynchronous sign-in completes',async()=>{
 let release;const token=new Promise(resolve=>{release=resolve;});const draft={...body};let sent;
 const run=createShopTransport({revision:316,getToken:()=>token,fetch:async(url,options)=>{sent=JSON.parse(options.body);return response({});}});
 const result=run({path:'/v1/shop/purchase',method:'POST',body:draft});draft.accountId='b'.repeat(64);draft.requestId='other_request';release('token');await result;assert.deepEqual(sent,body);
});

test("caller must supply the current client revision",()=>{assert.throws(()=>createShopTransport({getToken:async()=>"token"}));});
