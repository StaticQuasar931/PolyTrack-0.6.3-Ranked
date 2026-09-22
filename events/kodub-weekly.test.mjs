import test from 'node:test';
import assert from 'node:assert/strict';
import {loadKodubWeekly} from './kodub-weekly.mjs';
import {validateWeekly,assetPath,boundedBytes,validateAsset,KODUB_ROOT} from './kodub-schema.mjs';
const now=Date.parse('2026-09-19T20:00:00Z'),hash='a'.repeat(64);
const current={trackId:hash,name:'Test track',author:'Author',lastModified:'2026-09-07T00:00:00Z',environment:0,endTime:'2026-09-20T20:00:00Z',trackUrl:`assets/${hash}.track`,thumbnailUrl:`assets/${hash}.webp`,coverUrl:`assets/${hash}.webp`};
const baseUrl='https://game.test/events/client.mjs',brokerUrl='https://broker.test';
const live={...current,trackUrl:`${brokerUrl}/v1/kodub-weekly/track/${hash}`,thumbnailUrl:`${brokerUrl}/v1/kodub-weekly/image/${hash}`,coverUrl:`${brokerUrl}/v1/kodub-weekly/image/${hash}`};
const response=c=>Response.json({current:c});
test('uses an unexpired same-origin capture without probing the broker',async()=>{
 let brokerReads=0;
 const result=await loadKodubWeekly({baseUrl,brokerUrl,now,fetcher:async u=>{if(String(u).includes('current.json'))return response(current);brokerReads++;return response(live);}});
 assert.equal(result.current.trackUrl,`https://game.test/events/kodub/assets/${hash}.track`);
 assert.equal(brokerReads,0);
});
test('missing capture uses broker assets as recovery',async()=>{
 const next={...live,trackId:'b'.repeat(64),name:'Next'};
 const result=await loadKodubWeekly({baseUrl,brokerUrl,now,fetcher:async u=>String(u).includes('current.json')?new Response(null,{status:404}):response(next)});
 assert.equal(result.current.name,'Next');assert.equal(result.current.trackUrl,next.trackUrl);
});
test('network failure uses unexpired capture, never expired capture',async()=>{
 const fetcher=async u=>{if(String(u).includes('current.json'))return response(current);throw Error('offline')};
 assert.ok((await loadKodubWeekly({baseUrl,brokerUrl,now,fetcher})).current);
 assert.equal((await loadKodubWeekly({baseUrl,brokerUrl,now:Date.parse(current.endTime),fetcher})).current,null);
});
test('untrusted recovery asset URLs never reach the native loader',async()=>{
 for(const trackUrl of ['https://evil.test/track',brokerUrl+'/v1/kodub-weekly/track/'+hash+'?redirect=evil']){
  const result=await loadKodubWeekly({baseUrl,brokerUrl,now,fetcher:async u=>String(u).includes('current.json')?new Response(null,{status:404}):response({...live,trackUrl})});
  assert.equal(result.current,null);
 }
});
test('metadata and download validation rejects malformed, oversized and HTML assets',async()=>{
 assert.throws(()=>validateWeekly({current:{...current,environment:9}},now));
 assert.throws(()=>assetPath(KODUB_ROOT+'/track/../../other','track'));
 assert.equal(assetPath(KODUB_ROOT+'/track/'+hash,'track'),'track/'+hash);
 assert.throws(()=>validateAsset(new TextEncoder().encode('<html>blocked</html>'),'track'));
 await assert.rejects(boundedBytes(new Response('too long'),3));
});

test('future selections may omit optional native fields',async()=>{
 const selection={...live,author:null,lastModified:null,coverUrl:null};
 const result=await loadKodubWeekly({baseUrl,brokerUrl,now,fetcher:async u=>String(u).includes('current.json')?new Response(null,{status:404}):response(selection)});
 assert.equal(result.current.coverUrl,null);assert.equal(result.current.author,null);
});
test('local capture cannot inject traversal paths',async()=>{
 const result=await loadKodubWeekly({baseUrl,now,fetcher:async()=>response({...current,trackUrl:'../../private.track'})});
 assert.equal(result.current,null);
});
