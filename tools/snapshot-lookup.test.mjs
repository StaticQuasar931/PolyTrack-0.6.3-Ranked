
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {publishSnapshot,restoreSnapshotArchive} from './snapshot-package.mjs';
import {createPublicSnapshotReader} from './public-snapshot-client.mjs';
const digest=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t,{optimizedIndex=false}={}){
 const root=await mkdtemp(path.join(os.tmpdir(),'snapshot-lookups-')),staging=path.join(root,'staging');
 t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(path.join(staging,'profiles'),{recursive:true});
 const groups=new Map();let ids;
 for(let n=0;!ids;n++){const id=digest(String(n)),key=digest('profiles/'+id+'.json').slice(0,2);if(groups.has(key))ids=[groups.get(key),id];else groups.set(key,id);}
 for(const id of ids)await writeFile(path.join(staging,'profiles',id+'.json'),JSON.stringify({accountId:id,updatedAt:1,name:'Racer '+id.slice(0,4)}));
 // Include paging so the backwards-compatible bootstrap is emitted.
 await mkdir(path.join(staging,'tracks'));const track='a'.repeat(64);
 await writeFile(path.join(staging,'tracks',track+'.json'),JSON.stringify({trackId:track,updatedAt:1,complete:true,totalEntries:0,entries:[]}));
 const options={root,stagingDirectory:staging,historyDirectory:path.join(root,'history')},result=await publishSnapshot(options),directory=path.join(root,result.directory);
 const requests=[];let broken=false;
 const read=createPublicSnapshotReader({packed:true,bootstrap:true,optimizedIndex,baseUrl:'https://example.test/'+result.directory+'/',fetchImpl:async url=>{
  const file=new URL(url).pathname.split('/').slice(2).join('/');requests.push(file);
  if(broken&&file.startsWith('lookup-shards/'))return Response.json({schemaVersion:1,generation:999,files:{}});
  try{return new Response(await readFile(path.join(directory,file)));}catch{return new Response('',{status:404});}
 }});
 return {root,staging,options,result,directory,ids,track,requests,read,breakShard(){broken=true;}};
}
test('cold profiles share a small lookup shard without downloading the full index',async t=>{
 const f=await fixture(t);const rows=await Promise.all(f.ids.map(id=>f.read('profile',id)));
 assert.deepEqual(rows.map(row=>row.accountId),f.ids);
 assert.equal(f.requests.filter(p=>p.startsWith('lookup-shards/')).length,1);
 assert.equal(f.requests.filter(p=>p==='bootstrap-index.json').length,1);
 assert.ok(!f.requests.includes('index.json'));
 const count=f.requests.length;await f.read('profile',f.ids[0]);assert.equal(f.requests.length,count);
});
test('invalid shard generation falls back to the complete legacy index once',async t=>{
 const f=await fixture(t);f.breakShard();const rows=await Promise.all(f.ids.map(id=>f.read('profile',id)));
 assert.deepEqual(rows.map(row=>row.accountId),f.ids);assert.equal(f.requests.filter(p=>p==='index.json').length,1);
 assert.equal(f.requests.filter(p=>p.startsWith('lookup-shards/')).length,1);
});
test('publishing unchanged data reuses its generation; archive restore regenerates lookup shards',async t=>{
 const f=await fixture(t);assert.equal((await publishSnapshot(f.options)).changed,false);
 await writeFile(path.join(f.staging,'profiles',f.ids[0]+'.json'),JSON.stringify({accountId:f.ids[0],updatedAt:2,name:'Changed'}));
 const next=await publishSnapshot(f.options),restored=path.join(f.root,'restored');
 const index=await restoreSnapshotArchive(next.archivePath,restored);
 const bucket=digest('profiles/'+f.ids[0]+'.json').slice(0,2);
 const shard=JSON.parse(await readFile(path.join(restored,'lookup-shards',bucket+'.json'),'utf8'));
 assert.equal(shard.generation,index.generation);assert.equal(shard.compactIndexVersion,2);const record=index.files['profiles/'+f.ids[0]+'.json'];assert.deepEqual(shard.files['profiles/'+f.ids[0]+'.json'],[Buffer.from(record.sha256,'hex').toString('base64url'),record.decodedBytes]);
});

test('optimized bootstrap expands compact index tuples before normal payload validation',async t=>{
 const f=await fixture(t,{optimizedIndex:true});const value=await f.read('profile',f.ids[0]);
 assert.equal(value.accountId,f.ids[0]);assert.equal(f.requests[0],'bootstrap-fast.json');
 assert.ok(!f.requests.includes('bootstrap-index.json'));assert.ok(!f.requests.includes('index.json'));
});
test('a missing fast index falls back to the legacy bootstrap, without needing the full index',async t=>{
 const f=await fixture(t,{optimizedIndex:true});await rm(path.join(f.directory,'bootstrap-fast.json'));
 assert.equal((await f.read('profile',f.ids[0])).accountId,f.ids[0]);
 assert.ok(f.requests.includes('bootstrap-index.json'));assert.ok(!f.requests.includes('index.json'));
});

test('corrupt fast index recovers through legacy bootstrap instead of stranding snapshot users',async t=>{
 const f=await fixture(t,{optimizedIndex:true});await writeFile(path.join(f.directory,'bootstrap-fast.json'),'{bad');
 assert.equal((await f.read('profile',f.ids[0])).accountId,f.ids[0]);
 assert.equal(f.requests.filter(p=>p==='bootstrap-fast.json').length,2);
 assert.ok(f.requests.includes('bootstrap-index.json'));assert.ok(!f.requests.includes('index.json'));
});
test('stale fast generation is rejected and replaced by the current legacy bootstrap',async t=>{
 const f=await fixture(t,{optimizedIndex:true}),file=path.join(f.directory,'bootstrap-fast.json');
 const value=JSON.parse(await readFile(file,'utf8'));value.generation=999;await writeFile(file,JSON.stringify(value));
 assert.equal((await f.read('profile',f.ids[0])).accountId,f.ids[0]);assert.ok(f.requests.includes('bootstrap-index.json'));
});

test('compressed cache reuses verified hashes across reader instances and rejects damaged bytes',async()=>{
 const {encodeSnapshot}=await import('./snapshot-package.mjs');
 const id='a'.repeat(64),value={accountId:id,updatedAt:1,name:'Racer'},bytes=await encodeSnapshot(value),hash=digest(bytes);
 const files={['profiles/'+id+'.json']:{path:hash+'.bin',sha256:hash,decodedBytes:Buffer.byteLength(JSON.stringify(value))}};
 const stored=new Map(),disk={async keys(){return [...stored.keys()]},async delete(key){return stored.delete(typeof key==='string'?key:key.url)},async match(key){return stored.get(key)?.clone()},async put(key,response){stored.set(key,response.clone())}};
 const byteCache={async open(){return disk}};let payloadCalls=0;
 const make=(generation=1)=>createPublicSnapshotReader({packed:true,byteCache,baseUrl:'https://example.test/public-snapshots'+generation+'/',fetchImpl:async url=>String(url).endsWith('index.json')?Response.json({schemaVersion:1,encoding:'gzip-xor-a7-v1',files}):(payloadCalls++,new Response(bytes))});
 assert.equal((await make()('profile',id)).name,'Racer');
 for(let i=0;i<30&&!stored.size;i++)await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(stored.size,1);assert.equal((await make(2)('profile',id)).name,'Racer');assert.equal(payloadCalls,1);
 const key=[...stored.keys()][0];stored.set(key,new Response('corrupt'));
 assert.equal((await make()('profile',id)).name,'Racer');assert.equal(payloadCalls,2);
});
test('blocked browser cache never blocks snapshot loading',async t=>{
 const f=await fixture(t);const disk={async open(){throw Error('Storage blocked')}};
 const read=createPublicSnapshotReader({packed:true,byteCache:disk,baseUrl:'https://example.test/',fetchImpl:async url=>{
  const file=new URL(url).pathname.slice(1);try{return new Response(await readFile(path.join(f.directory,file)));}catch{return new Response('',{status:404});}
 }});
 assert.equal((await read('profile',f.ids[0])).accountId,f.ids[0]);
});


test('compact lookup metadata retains full hashes and saves space without changing the full index',async t=>{
 const f=await fixture(t),bucket=digest('profiles/'+f.ids[0]+'.json').slice(0,2);
 const shard=JSON.parse(await readFile(path.join(f.directory,'lookup-shards',bucket+'.json'),'utf8'));
 const full=JSON.parse(await readFile(path.join(f.directory,'index.json'),'utf8'));
 assert.equal(shard.compactIndexVersion,2);
 for(const [logical,row] of Object.entries(shard.files))assert.deepEqual(row,[Buffer.from(full.files[logical].sha256,'hex').toString('base64url'),full.files[logical].decodedBytes]);
 const expanded={...shard,files:Object.fromEntries(Object.keys(shard.files).map(logical=>[logical,full.files[logical]]))};
 assert.ok(JSON.stringify(shard).length<JSON.stringify(expanded).length);
});

test('legacy lookup records remain readable without a full index download',async t=>{
 const f=await fixture(t),bucket=digest('profiles/'+f.ids[0]+'.json').slice(0,2),file=path.join(f.directory,'lookup-shards',bucket+'.json');
 const shard=JSON.parse(await readFile(file,'utf8'));delete shard.compactIndexVersion;
 shard.files=Object.fromEntries(Object.entries(shard.files).map(([key,[hash,size]])=>{hash=Buffer.from(hash,'base64url').toString('hex');return [key,{path:hash+'.bin',sha256:hash,decodedBytes:size}];}));
 await writeFile(file,JSON.stringify(shard));assert.equal((await f.read('profile',f.ids[0])).accountId,f.ids[0]);assert.ok(!f.requests.includes('index.json'));
});

test('invalid compact lookup bindings recover through the unchanged full index',async t=>{
 const f=await fixture(t),bucket=digest('profiles/'+f.ids[0]+'.json').slice(0,2),file=path.join(f.directory,'lookup-shards',bucket+'.json');
 const shard=JSON.parse(await readFile(file,'utf8'));shard.files['profiles/'+f.ids[0]+'.json']=['not-a-hash',12];
 await writeFile(file,JSON.stringify(shard));assert.equal((await f.read('profile',f.ids[0])).accountId,f.ids[0]);assert.ok(f.requests.includes('index.json'));
});
