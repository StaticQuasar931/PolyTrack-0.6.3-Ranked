import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
const root=process.env.POLYTRACK_REPO?pathToFileURL(process.env.POLYTRACK_REPO.replaceAll('\\','/')+'/'):new URL('../',import.meta.url);
const {createPublicSnapshotReader}=await import(new URL('tools/public-snapshot-client.mjs',root));
const emptyIndex={schemaVersion:1,encoding:'gzip-xor-a7-v1',files:{}};
const id=i=>i.toString(16).padStart(64,'a');
function fixture({status=404,bootstrap=false}={}){
  let now=100000,pointer='public-snapshots71',available=false;
  const urls=[];
  const profile={accountId:id(0),updatedAt:1};
  const json=JSON.stringify(profile),bytes=Uint8Array.from(gzipSync(json),byte=>byte^0xa7);
  const sha256=createHash('sha256').update(bytes).digest('hex');
  const index={...emptyIndex,files:{['profiles/'+id(0)+'.json']:{path:sha256+'.bin',sha256,decodedBytes:Buffer.byteLength(json)}}};
  const read=createPublicSnapshotReader({baseUrl:'https://index.invalid/public-snapshots71/',packed:true,bootstrap,optimizedIndex:bootstrap,now:()=>now,
    fetchImpl:async url=>{
      const path=new URL(url).pathname;urls.push(path);
      if(path==='/snapshot-current.json')return Response.json({currentdir:pointer});
      if(path.endsWith('/bootstrap-fast.json')||path.endsWith('/bootstrap-index.json'))return new Response(null,{status:404});
      if(path.endsWith('/'+sha256+'.bin'))return new Response(bytes);
      assert.ok(path.endsWith('/index.json'));
      return available?Response.json(index):new Response(null,{status});
    }});
  return {read,urls,advance:ms=>now+=ms,publish:()=>available=true,point:value=>pointer=value,indexes:()=>urls.filter(p=>p.endsWith('/index.json')).length};
}
for(const bootstrap of [false,true])test('eight distinct missing tracks share one full-index 404, bootstrap='+bootstrap,async()=>{
  const f=fixture({bootstrap});for(let i=0;i<8;i++)assert.equal(await f.read('track',id(i)),null);
  assert.equal(f.indexes(),1);
  f.advance(29999);await f.read('track',id(9));assert.equal(f.indexes(),1);
  f.advance(1);await f.read('track',id(0));assert.equal(f.indexes(),2,'original logical path also retries at the shared TTL');
});
test('same-generation recovery fetches a successful index after cooldown',async()=>{
  const f=fixture();await f.read('profile',id(0));assert.equal(f.indexes(),1);f.publish();f.advance(30000);
  assert.equal((await f.read('profile',id(0))).accountId,id(0));assert.equal(f.indexes(),2);
  await f.read('profile',id(1));assert.equal(f.indexes(),2,'successful shared index replaces failure state');
});
test('manual generation change clears shared and per-path negative state immediately',async()=>{
  const f=fixture();await f.read('profile',id(0));assert.equal(f.indexes(),1);
  f.publish();f.point('public-snapshots72');assert.equal(await f.read.refresh(),true);
  assert.equal((await f.read('profile',id(0))).accountId,id(0));assert.equal(f.indexes(),2);assert.ok(f.urls.includes('/public-snapshots72/index.json'));
});
test('authorization failures are not installed as shared absent-index state',async()=>{
  for(const status of [401,403]){const f=fixture({status});await f.read('profile',id(0));await f.read('profile',id(1));assert.equal(f.indexes(),2);}
});
test('existing quota/server transient backoff remains unchanged',async()=>{
  for(const status of [429,500,503]){const f=fixture({status});await f.read('profile',id(0));await f.read('profile',id(1));assert.equal(f.indexes(),1);f.advance(30000);await f.read('profile',id(2));assert.equal(f.indexes(),2);}
});
