import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createPublicSnapshotReader} from './public-snapshot-client.mjs';
import {encodeSnapshot} from './snapshot-package.mjs';
import {SNAPSHOT_CDN_REPOSITORY,parseSnapshotPayloadShards,snapshotPayloadShard,snapshotPayloadBase,documentSnapshotPayloadShards} from './snapshot-payload-shards.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const base=(commit,generation=75)=>`https://cdn.jsdelivr.net/gh/${SNAPSHOT_CDN_REPOSITORY}@${commit.repeat(40)}/public-snapshots${generation}/`;
const mapping=(count=4)=>({schemaVersion:1,metadataBase:base('a'),payloadBases:['b','c','d','e'].slice(0,count).map(commit=>base(commit))});
const id='1'.repeat(64),logical='profiles/'+id+'.json';
async function entry(n=1){
  const value={accountId:id,name:'Racer '+n,updatedAt:n},bytes=await encodeSnapshot(value),sha256=hash(bytes);
  return {value,bytes,record:{path:sha256+'.bin',sha256,decodedBytes:Buffer.byteLength(JSON.stringify(value))}};
}
const index=record=>({schemaVersion:1,generation:75,encoding:'gzip-xor-a7-v1',files:{[logical]:record}});

test('all sixteen prefixes route deterministically for two and four payload packages only',()=>{
  for(const count of [2,4]){
    const map=parseSnapshotPayloadShards(mapping(count));
    for(let nibble=0;nibble<16;nibble++){
      const path=nibble.toString(16)+'0'.repeat(63)+'.bin';
      assert.equal(snapshotPayloadShard(path,count),nibble%count);
      assert.equal(snapshotPayloadBase(map,map.metadataBase,path),map.payloadBases[nibble%count]);
    }
    for(const path of ['index.json','bootstrap-fast.json','lookup-shards/00.json','../'+'0'.repeat(64)+'.bin','0'.repeat(63)+'.bin','A'.repeat(64)+'.bin','0'.repeat(64)+'.bin?x','0'.repeat(64)+'.bin\n'])
      assert.equal(snapshotPayloadBase(map,map.metadataBase,path),map.metadataBase,path);
  }
});

test('map validation rejects unowned, mutable, normalized, cross-generation and malformed URLs',()=>{
  const valid=mapping();
  const urls=[base('b').replace('https:','http:'),base('b').replace('cdn.jsdelivr.net','evil.test'),
    base('b').replace('cdn.jsdelivr.net','fastly.jsdelivr.net'),base('b').replace(SNAPSHOT_CDN_REPOSITORY,'other/repo'),
    base('b').replace('b'.repeat(40),'main'),base('b').replace('b'.repeat(40),'b'.repeat(39)),
    base('b').replace('/public-snapshots75/','/public-snapshots76/'),base('b')+'?x',base('b')+'#x',base('b')+'\n',
    base('b').replace('cdn.jsdelivr.net','user@cdn.jsdelivr.net'),base('b').replace('/public-snapshots75/','/x/../public-snapshots75/'),
    base('b').replace('/public-snapshots75/','/public-snapshots075/'),base('b').replace('/public-snapshots75/','/%70ublic-snapshots75/')];
  for(const url of urls){
    assert.equal(parseSnapshotPayloadShards({...valid,payloadBases:[url,...valid.payloadBases.slice(1)]}),null,url);
    assert.equal(parseSnapshotPayloadShards({...valid,metadataBase:url}),null,url);
  }
  for(const bad of [null,'{bad',' '.repeat(4097),{...valid,schemaVersion:2},{...valid,payloadBases:[base('b')]},
    {...valid,payloadBases:[base('b'),base('b')]},{...valid,payloadBases:[valid.metadataBase,base('b')]},
    {...valid,payloadBases:new Array(2)}])assert.equal(parseSnapshotPayloadShards(bad),null);
  const parsed=parseSnapshotPayloadShards(JSON.stringify(valid));
  assert.deepEqual(parsed,valid);assert.ok(Object.isFrozen(parsed.payloadBases));
  valid.payloadBases[0]=base('f');assert.equal(parsed.payloadBases[0],base('b'));
});

test('document discovery is optional, unique and guarded outside a browser',()=>{
  assert.equal(documentSnapshotPayloadShards(),null);
  const previous=Object.getOwnPropertyDescriptor(globalThis,'document');
  try{
    let tags=[];
    Object.defineProperty(globalThis,'document',{configurable:true,value:{querySelectorAll:selector=>{
      assert.equal(selector,'meta[name="polytrack-snapshot-payload-shards"]');return tags;
    }}});
    assert.equal(documentSnapshotPayloadShards(),null);
    tags=[{getAttribute:()=>JSON.stringify(mapping())}];assert.deepEqual(documentSnapshotPayloadShards(),mapping());
    tags.push(tags[0]);assert.equal(documentSnapshotPayloadShards(),null);
    Object.defineProperty(globalThis,'document',{configurable:true,get(){throw Error('blocked DOM');}});
    assert.equal(documentSnapshotPayloadShards(),null);
  }finally{if(previous)Object.defineProperty(globalThis,'document',previous);else delete globalThis.document;}
});

test('reader routes validated payloads while compact v2 lookup and bootstrap remain on metadata',async()=>{
  const payload=await entry(),map=mapping(),bucket=hash(logical).slice(0,2),calls=[];
  const previous=Object.getOwnPropertyDescriptor(globalThis,'document');
  try{
    Object.defineProperty(globalThis,'document',{configurable:true,value:{querySelectorAll:()=>[{getAttribute:()=>JSON.stringify(map)}]}});
    const read=createPublicSnapshotReader({packed:true,bootstrap:true,optimizedIndex:true,baseUrl:map.metadataBase,byteCache:null,fetchImpl:async url=>{
      const href=String(url);calls.push(href);
      if(href===map.metadataBase+'bootstrap-fast.json')return Response.json({...index(payload.record),partial:true,fallbackIndex:'index.json',compactIndexVersion:1,lookupShardsVersion:1,files:{}});
      if(href===map.metadataBase+'lookup-shards/'+bucket+'.json')return Response.json({...index(payload.record),lookupShardsVersion:1,compactIndexVersion:2,bucket,
        files:{[logical]:[Buffer.from(payload.record.sha256,'hex').toString('base64url'),payload.record.decodedBytes]}});
      assert.equal(href,map.payloadBases[snapshotPayloadShard(payload.record.path,4)]+payload.record.path);
      return new Response(payload.bytes);
    }});
    assert.equal((await read('profile',id)).name,payload.value.name);
    assert.equal(calls.length,3);assert.ok(!calls.includes(map.metadataBase+'index.json'));
  }finally{if(previous)Object.defineProperty(globalThis,'document',previous);else delete globalThis.document;}
});

test('legacy, local and different immutable bases ignore a stale mapping',async()=>{
  const payload=await entry();
  for(const baseUrl of ['https://example.test/public-snapshots75/',base('f'),base('a',76),base('a')+'?other']){
    const calls=[];
    const read=createPublicSnapshotReader({packed:true,baseUrl,payloadShards:mapping(),fetchImpl:async url=>{
      const href=String(url);calls.push(href);
      if(href===new URL('index.json',baseUrl).href)return Response.json(index(payload.record));
      assert.equal(href,new URL(payload.record.path,baseUrl).href);return new Response(payload.bytes);
    }});
    assert.equal((await read('profile',id)).name,payload.value.name);assert.equal(calls.length,2);
  }
});

test('lookup fallback to full metadata keeps routing, but generation recovery permanently discards old map',async()=>{
  const old=await entry(1),next=await entry(2),map=mapping(),nextBase=base('a',76),calls=[];
  const read=createPublicSnapshotReader({packed:true,bootstrap:true,optimizedIndex:true,baseUrl:map.metadataBase,payloadShards:map,fetchImpl:async url=>{
    const href=String(url);calls.push(href);
    if(href.endsWith('snapshot-current.json'))return Response.json({currentdir:'public-snapshots76'});
    if(href===map.metadataBase+'bootstrap-fast.json')return Response.json({...index(old.record),partial:true,fallbackIndex:'index.json',compactIndexVersion:1,lookupShardsVersion:1,files:{}});
    if(href.includes('/lookup-shards/'))return new Response('',{status:404});
    if(href===map.metadataBase+'index.json')return Response.json(index(old.record));
    if(href===map.payloadBases[snapshotPayloadShard(old.record.path,4)]+old.record.path)return new Response('',{status:410});
    if(href===nextBase+'bootstrap-fast.json'||href===nextBase+'bootstrap-index.json')return new Response('',{status:404});
    if(href===nextBase+'index.json')return Response.json({...index(next.record),generation:76});
    assert.equal(href,nextBase+next.record.path);return new Response(next.bytes);
  }});
  assert.equal((await read('profile',id)).name,next.value.name);
  assert.ok(calls.includes(map.metadataBase+'index.json'));assert.ok(calls.includes(nextBase+next.record.path));
  assert.equal(calls.filter(url=>map.payloadBases.some(base=>url.startsWith(base))).length,1);
});

test('shard transport preserves full SHA256 verification and bounded integrity retry',async()=>{
  const payload=await entry(),map=mapping(),requests=[];
  const read=createPublicSnapshotReader({packed:true,baseUrl:map.metadataBase,payloadShards:map,fetchImpl:async(url,options)=>{
    if(String(url)===map.metadataBase+'index.json')return Response.json(index(payload.record));
    assert.equal(String(url),map.payloadBases[snapshotPayloadShard(payload.record.path,4)]+payload.record.path);
    requests.push(options.cache);return new Response('corrupt bytes');
  }});
  assert.equal(await read('profile',id),null);assert.deepEqual(requests,['force-cache','reload']);
});

test('real checksummed payloads load through every prefix for both supported shard counts',async()=>{
  const byPrefix=new Map();
  for(let n=1;byPrefix.size<16;n++){
    assert.ok(n<1000,'fixture prefix search stays bounded');
    const payload=await entry(n);byPrefix.set(payload.record.sha256[0],payload);
  }
  for(const count of [2,4])for(const [prefix,payload] of byPrefix){
    const map=mapping(count),calls=[];
    const read=createPublicSnapshotReader({packed:true,baseUrl:map.metadataBase,payloadShards:map,fetchImpl:async url=>{
      const href=String(url);calls.push(href);
      if(href===map.metadataBase+'index.json')return Response.json(index(payload.record));
      assert.equal(href,map.payloadBases[parseInt(prefix,16)%count]+payload.record.path);return new Response(payload.bytes);
    }});
    assert.equal((await read('profile',id)).name,payload.value.name);assert.equal(calls.length,2);
  }
  const payload=byPrefix.get('0');let replacement;
  for(let n=1000;!replacement;n++){
    const candidate=await entry(n);
    if(candidate.record.sha256[0]==='0'&&candidate.record.sha256!==payload.record.sha256)replacement=candidate;
  }
  const read=createPublicSnapshotReader({packed:true,baseUrl:base('a'),payloadShards:mapping(),fetchImpl:async url=>
    String(url).endsWith('index.json')?Response.json(index(payload.record)):new Response(replacement.bytes)});
  assert.equal(await read('profile',id),null,'same routing nibble cannot substitute for full digest verification');
});

test('invalid index payload paths are never requested from a shard or metadata',async()=>{
  const payload=await entry();
  for(const path of ['../'+payload.record.path,'A'.repeat(64)+'.bin',payload.record.path+'?x']){
    const read=createPublicSnapshotReader({packed:true,baseUrl:base('a'),payloadShards:mapping(),fetchImpl:async url=>{
      assert.equal(String(url),base('a')+'index.json');return Response.json(index({...payload.record,path}));
    }});
    assert.equal(await read('profile',id),null);
  }
});
