import test from 'node:test';
import assert from 'node:assert/strict';
import {kodubWeekly} from '../src/kodub-weekly.js';
import {handleRequest} from '../src/index.js';
const hash='a'.repeat(64),root='https://vps.kodub.com/v6/trackOfTheWeek';
const current={trackId:hash,name:'Weekly',author:'A',lastModified:new Date().toISOString(),environment:0,endTime:new Date(Date.now()+86400000).toISOString(),trackUrl:root+'/track/'+hash,thumbnailUrl:root+'/image/'+hash,coverUrl:root+'/image/'+hash};
test('mirrors only weekly URLs and never forwards client credentials',async()=>{
 let init,url;
 const request=new Request('https://broker.test/v1/kodub-weekly',{headers:{Authorization:'Bearer private',Cookie:'private'}});
 const result=await kodubWeekly(request,{}, {},{fetch:async(u,i)=>{url=u;init=i;return Response.json({current})}});
 const body=await result.json();assert.equal(result.status,200);
 assert.equal(url,root+'?version=0.6.3');assert.equal(init.redirect,'manual');assert.equal(init.headers.Authorization,undefined);assert.equal(init.headers.Cookie,undefined);
 assert.equal(body.current.trackUrl,'https://broker.test/v1/kodub-weekly/track/'+hash);
});
test('bad path and POST do not fetch upstream',async()=>{
 for(const [path,method] of [['/v1/kodub-weekly/track/bad','GET'],['/v1/kodub-weekly','POST']]){
  const result=await kodubWeekly(new Request('https://broker.test'+path,{method}),{}, {},{fetch:()=>{throw Error('must not fetch')}});assert.equal(result.status,404);
 }
});
test('origin restrictions apply to new routes',async()=>{
 const result=await handleRequest(new Request('https://broker.test/v1/kodub-weekly',{headers:{Origin:'https://evil.test'}}),{ALLOWED_ORIGINS:'https://game.test'});
 assert.equal(result.status,403);
});
test('403 upstream, foreign assets and HTML payload fail closed',async()=>{
 for(const response of [new Response('Forbidden',{status:403}),new Response(null,{status:302,headers:{Location:'https://evil.test'}}),Response.json({current:{...current,trackUrl:'https://evil.test/file'}})]){
  const result=await kodubWeekly(new Request('https://broker.test/v1/kodub-weekly'),{}, {},{fetch:async()=>response});assert.equal(result.status,502);
 }
 const result=await kodubWeekly(new Request('https://broker.test/v1/kodub-weekly/track/'+hash),{}, {},{fetch:async()=>new Response('<html>')});assert.equal(result.status,502);
});
test('cache hits skip upstream; successful responses are cached',async()=>{
 const writes=[],pending=[];const cache={match:async()=>undefined,put:async(k,v)=>writes.push([k,v])};
 const request=new Request('https://broker.test/v1/kodub-weekly');
 await kodubWeekly(request,{}, {waitUntil:p=>pending.push(p)},{cache,fetch:async()=>Response.json({current})});
 await Promise.all(pending);assert.equal(writes.length,1);
 const result=await kodubWeekly(request,{}, {},{cache:{match:async()=>writes[0][1]},fetch:()=>{throw Error('cache miss')}});assert.equal(result.status,200);
});

