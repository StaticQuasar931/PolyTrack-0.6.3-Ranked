import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {cloneBounded} from './bounded-clone.mjs';

test('metadata reads are bounded, drained, and report the first traversal error',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'clone-io-'));
 const source=path.join(root,'source'),destination=path.join(root,'copy');
 await fs.mkdir(source);
 for(let i=0;i<24;i++)await fs.writeFile(path.join(source,`row-${String(i).padStart(2,'0')}.json`),'{}');
 const original=fs.lstat;let active=0,peak=0,failed=false;
 try{
  t.mock.method(fs,'lstat',async(file,...args)=>{
   if(path.dirname(String(file))!==source)return original(file,...args);
   active++;peak=Math.max(peak,active);
   try{
    await new Promise(resolve=>setTimeout(resolve,path.basename(file)==='row-00.json'?15:1));
    if(path.basename(file)==='row-00.json')throw Error('first metadata failure');
    if(path.basename(file)==='row-01.json')throw Error('second metadata failure');
    return await original(file,...args);
   }finally{active--;}
  });
  await assert.rejects(cloneBounded({source,destination,limits:{concurrency:4}}),/first metadata failure/);
  failed=true;assert.equal(active,0);assert.equal(peak,4);
  await assert.rejects(fs.stat(destination),{code:'ENOENT'});
 }finally{
  t.mock.restoreAll();assert.equal(active,0);
  assert.equal(path.dirname(root),os.tmpdir());assert(path.basename(root).startsWith('clone-io-'));
  await fs.rm(root,{recursive:true,force:true});
 }
 assert(failed);
});

test('successful parallel inventory retains exact serial metadata digest',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'clone-io-'));
 t.after(async()=>{assert.equal(path.dirname(root),os.tmpdir());assert(path.basename(root).startsWith('clone-io-'));await fs.rm(root,{recursive:true,force:true});});
 const source=path.join(root,'source');await fs.mkdir(source);
 for(const name of ['z.json','a/1.json','a/2.json','b/3.json']){
  const file=path.join(source,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify({name}));
 }
 const old=await cloneBounded({source,destination:path.join(root,'old'),limits:{concurrency:1}}),next=await cloneBounded({source,destination:path.join(root,'next')});
 for(const key of ['authority','files','directories','bytes','sourceMetadataSha256'])assert.deepEqual(next[key],old[key]);
});
