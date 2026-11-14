import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {cloneBounded} from './bounded-clone.mjs';
const base=os.tmpdir();
async function fixture(t){
 const root=await fs.mkdtemp(path.join(base,'.clone-test-')),source=path.join(root,'source'),destination=path.join(root,'copy');
 await fs.mkdir(source);await fs.mkdir(path.join(source,'empty'));await fs.mkdir(path.join(source,'nested'));
 await fs.writeFile(path.join(source,'root.json'),'{}\n');await fs.writeFile(path.join(source,'nested','binary.bin'),Buffer.from([0,1,255,7]));
 t.after(async()=>{assert.equal(path.dirname(path.resolve(root)),base);assert(path.basename(root).startsWith('.clone-test-'));assert.equal(await fs.realpath(root),root);await fs.rm(root,{recursive:true,force:true});});
 return {root,source,destination};
}
const absent=file=>assert.rejects(fs.stat(file),error=>error.code==='ENOENT');
test('only exact root overall.json accepts 32 MiB; ordinary limits and totals stay bounded',async t=>{
 const f=await fixture(t),large=path.join(f.source,'overall.json');
 const handle=await fs.open(large,'w');await handle.truncate(32*1024*1024);await handle.close();
 await cloneBounded(f);assert.equal((await fs.stat(path.join(f.destination,'overall.json'))).size,32*1024*1024);
 for(const [name,size]of [['overall.json',32*1024*1024+1],['other.json',16*1024*1024+1],['nested/overall.json',16*1024*1024+1],['Overall.json',16*1024*1024+1]]){
  const target=path.join(f.source,name);if(name!=='overall.json')await fs.unlink(large).catch(e=>{if(e.code!=='ENOENT')throw e;});
  const file=await fs.open(target,'w');await file.truncate(size);await file.close();
  const destination=path.join(f.root,'reject-'+size+'-'+name.replaceAll('/','-'));
  await assert.rejects(cloneBounded({...f,destination}),/bound/);await absent(destination);await fs.unlink(target);
 }
 const file=await fs.open(large,'w');await file.truncate(17*1024*1024);await file.close();
 await assert.rejects(cloneBounded({...f,destination:path.join(f.root,'lower-file'),limits:{fileBytes:1024}}),/bound/);
 await assert.rejects(cloneBounded({...f,destination:path.join(f.root,'lower-total'),limits:{bytes:16*1024*1024}}),/bound/);
 await assert.rejects(cloneBounded({...f,destination:path.join(f.root,'raise-total'),limits:{bytes:256*1024*1024+1}}),/limit/);
 await assert.rejects(cloneBounded({...f,destination:path.join(f.root,'raise-count'),limits:{files:100001}}),/limit/);
});
test('exact bytes, empty directories, independent files and source immutability',async t=>{
 const f=await fixture(t),original=await fs.readFile(path.join(f.source,'root.json')),report=await cloneBounded(f);
 assert.equal(report.files,2);assert.equal(report.directories,2);assert.equal(report.authority,false);
 assert((await fs.readFile(path.join(f.destination,'nested/binary.bin'))).equals(Buffer.from([0,1,255,7])));
 assert((await fs.stat(path.join(f.destination,'empty'))).isDirectory());
 await fs.writeFile(path.join(f.destination,'root.json'),'changed');assert((await fs.readFile(path.join(f.source,'root.json'))).equals(original));
 assert.notEqual((await fs.stat(path.join(f.source,'root.json'))).ino,(await fs.stat(path.join(f.destination,'root.json'))).ino);
});
test('existing destination and overlapping roots are never overwritten',async t=>{
 const f=await fixture(t);await fs.mkdir(f.destination);await fs.writeFile(path.join(f.destination,'sentinel.json'),'untouched');
 await assert.rejects(cloneBounded(f),/already exists/);assert.equal(await fs.readFile(path.join(f.destination,'sentinel.json'),'utf8'),'untouched');
 await assert.rejects(cloneBounded({...f,destination:path.join(f.source,'new')}),/overlapping/);
 await assert.rejects(cloneBounded({...f,destination:f.root}),/overlapping/);
 await assert.rejects(cloneBounded({...f,source:path.parse(f.source).root}),/overlapping/);
});
test('source links and linked ancestors reject before output creation',async t=>{
 const f=await fixture(t),link=path.join(f.source,'junction');await fs.symlink(f.root,link,process.platform==='win32'?'junction':'dir');
 await assert.rejects(cloneBounded(f),/link/);await absent(f.destination);
 const alias=path.join(f.root,'alias');await fs.symlink(f.source,alias,process.platform==='win32'?'junction':'dir');
 await assert.rejects(cloneBounded({...f,source:alias}),/link/);await absent(f.destination);
});
test('count byte path and concurrency limits fail closed',async t=>{
 const f=await fixture(t);
 for(const limits of [{files:1},{bytes:1},{fileBytes:1},{pathLength:3},{directories:1},{concurrency:9}]){
  await assert.rejects(cloneBounded({...f,limits}),/bound|path|limit/);await absent(f.destination);
 }
});
test('eight bounded copy operations use COPYFILE_EXCL and drain before cleanup',async t=>{
 const f=await fixture(t);for(let i=0;i<30;i++)await fs.writeFile(path.join(f.source,`row-${i}.json`),'{}');
 const original=fs.copyFile;let active=0,peak=0,calls=0;
 try{
  t.mock.method(fs,'copyFile',async(from,to,flags)=>{assert.equal(flags,constants.COPYFILE_EXCL);const call=++calls;active++;peak=Math.max(peak,active);
   try{await new Promise(resolve=>setTimeout(resolve,15));if(call===3)throw Error('fixture copy failure');return await original(from,to,flags);}finally{active--;}});
  await assert.rejects(cloneBounded(f),/fixture copy failure/);
 }finally{fs.copyFile=original;}
 assert.equal(active,0);assert(peak<=8&&peak>1);await absent(f.destination);assert.equal((await fs.readdir(f.source)).length,33);
});
test('same-size source mutation rejects and cleans only the owned output',async t=>{
 const f=await fixture(t),original=fs.copyFile;let changed=false;
 try{
  t.mock.method(fs,'copyFile',async(from,to,flags)=>{await original(from,to,flags);if(!changed){changed=true;const data=await fs.readFile(from);data[0]^=1;await fs.writeFile(from,data);}});
  await assert.rejects(cloneBounded(f),/source changed/);
 }finally{fs.copyFile=original;}
 await absent(f.destination);assert((await fs.stat(f.source)).isDirectory());
});
test('files appearing during copy are not silently omitted',async t=>{
 const f=await fixture(t),original=fs.copyFile;let added=false;
 try{
  t.mock.method(fs,'copyFile',async(...args)=>{await original(...args);if(!added){added=true;await fs.writeFile(path.join(f.source,'late.json'),'{}');}});
  await assert.rejects(cloneBounded(f),/inventory changed/);
 }finally{fs.copyFile=original;}
 await absent(f.destination);assert.equal(await fs.readFile(path.join(f.source,'late.json'),'utf8'),'{}');
});
test('hash inventory equality after parallel copy',async t=>{
 const f=await fixture(t);for(let i=0;i<32;i++)await fs.writeFile(path.join(f.source,`row-${i}.json`),JSON.stringify({i,text:'x'.repeat(i)}));
 await cloneBounded(f);
 for(const entry of await fs.readdir(f.source,{recursive:true,withFileTypes:true}))if(entry.isFile()){
  const relative=path.relative(f.source,path.join(entry.parentPath??entry.path,entry.name));
  const digest=async root=>createHash('sha256').update(await fs.readFile(path.join(root,relative))).digest('hex');
  assert.equal(await digest(f.source),await digest(f.destination));
 }
});
test('COPYFILE_EXCL refuses a file appearing at its reserved destination',async t=>{
 const f=await fixture(t),original=fs.copyFile;let checked=false;
 try{
  t.mock.method(fs,'copyFile',async(from,to,flags)=>{
   if(!checked){checked=true;await fs.writeFile(to,'collision',{flag:'wx'});
    await assert.rejects(original(from,to,flags),error=>error.code==='EEXIST');assert.equal(await fs.readFile(to,'utf8'),'collision');
    throw Error('exclusive collision confirmed');
   }
   return original(from,to,flags);
  });
  await assert.rejects(cloneBounded(f),/exclusive collision confirmed/);
 }finally{fs.copyFile=original;}
 assert(checked);await absent(f.destination);
});


test('only root index.json accepts20MiB; nested, case variants, ordinary files and tighter budgets stay bounded',async t=>{
 const f=await fixture(t),file=path.join(f.source,'index.json');let h=await fs.open(file,'w');await h.truncate(20*1024*1024);await h.close();
 const report=await cloneBounded(f);assert.equal(report.authority,false);assert.equal((await fs.stat(path.join(f.destination,'index.json'))).size,20*1024*1024);
 for(const [name,size]of [['index.json',20*1024*1024+1],['nested/index.json',16*1024*1024+1],['Index.json',16*1024*1024+1],['ordinary.json',16*1024*1024+1]]){
  await fs.unlink(file).catch(e=>{if(e.code!=='ENOENT')throw e;});const target=path.join(f.source,name);h=await fs.open(target,'w');await h.truncate(size);await h.close();const destination=path.join(f.root,'reject-index-'+name.replaceAll('/','-'));await assert.rejects(cloneBounded({...f,destination}),/bound/);await absent(destination);await fs.unlink(target);
 }
 h=await fs.open(file,'w');await h.truncate(17*1024*1024);await h.close();for(const limits of [{fileBytes:1024},{bytes:16*1024*1024}])await assert.rejects(cloneBounded({...f,destination:path.join(f.root,'tighter-'+Object.keys(limits)[0]),limits}),/bound/);
});
