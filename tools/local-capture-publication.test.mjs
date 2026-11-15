import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {assertLocalSource,snapshotPublicationFiles,validateSnapshotPayloads} from './local-capture-publication.mjs';
import {MAX_FILE_BYTES} from './snapshot-package.mjs';

async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'local-publication-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
test('exact isolated source rejects uncommitted/untracked executables and an external runner',async t=>{
  const workspace=await fixture(t),git=args=>execFileSync('git',args,{cwd:workspace,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  git(['init']);await fs.mkdir(path.join(workspace,'tools'));
  for(const name of ['local-overnight-capture','local-capture-worker','local-capture-publication','local-capture-process',
    'local-capture-git','local-publication-argv','local-capture-checkpoint','local-playback-cache','local-archive-replay-repair'])await fs.writeFile(path.join(workspace,'tools',name+'.mjs'),'// committed\n');
  git(['add','tools']);git(['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture']);
  const sourceCommit=git(['rev-parse','HEAD']).trim(),runnerFile=path.join(workspace,'tools/local-overnight-capture.mjs');
  await assertLocalSource({workspace,sourceCommit,runnerFile});
  await fs.writeFile(path.join(workspace,'untracked.json'),'{}');await assert.rejects(assertLocalSource({workspace,sourceCommit,runnerFile}),/untracked/);
  await fs.unlink(path.join(workspace,'untracked.json'));
  const external=path.join(await fixture(t),'runner.mjs');await fs.writeFile(external,'// committed\n');
  await assert.rejects(assertLocalSource({workspace,sourceCommit,runnerFile:external}),/isolated workspace/);
  await fs.writeFile(runnerFile,'// modified\n');await assert.rejects(assertLocalSource({workspace,sourceCommit,runnerFile}),/clean and tested/);
});
test('snapshot publication admits only referenced hash-bound package artifacts',async t=>{
  const root=await fixture(t),directory='public-snapshots73',folder=path.join(root,directory),bytes=Buffer.from('encoded public data');
  await fs.mkdir(folder);const hash=createHash('sha256').update(bytes).digest('hex');
  await fs.writeFile(path.join(folder,hash+'.bin'),bytes);
  await fs.writeFile(path.join(folder,'index.json'),JSON.stringify({schemaVersion:1,generation:73,files:{'safe.json':{path:hash+'.bin',sha256:hash}}}));
  assert.deepEqual(await snapshotPublicationFiles({root,directory}),[directory+'/'+hash+'.bin',directory+'/index.json'].sort());
  await fs.writeFile(path.join(folder,'private.json'),'{}');await assert.rejects(snapshotPublicationFiles({root,directory}),/unreferenced/);
  await fs.unlink(path.join(folder,'private.json'));await fs.writeFile(path.join(folder,hash+'.bin'),'changed');await assert.rejects(snapshotPublicationFiles({root,directory}),/changed/);
});
test('publication inventory rejects path escapes, foreign generation and extra directories',async t=>{
  const root=await fixture(t);await assert.rejects(snapshotPublicationFiles({root,directory:'../outside'}),/directory/);
  await fs.mkdir(path.join(root,'public-snapshots73'));await fs.writeFile(path.join(root,'public-snapshots73/index.json'),JSON.stringify({schemaVersion:1,generation:74,files:{}}));
  await assert.rejects(snapshotPublicationFiles({root,directory:'public-snapshots73'}),/index/);
  await fs.writeFile(path.join(root,'public-snapshots73/index.json'),JSON.stringify({schemaVersion:1,generation:73,files:{}}));await fs.mkdir(path.join(root,'public-snapshots73/recovery'));
  await assert.rejects(snapshotPublicationFiles({root,directory:'public-snapshots73'}),/directory/);
});

const descriptor=bytes=>{const sha256=createHash('sha256').update(bytes).digest('hex');return {path:sha256+'.bin',sha256};};
const fileStat=size=>({size,isSymbolicLink:()=>false,isFile:()=>true});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function controlledPayloads(count){
  const items=[],values=new Map(),waiting=[];let active=0,peak=0,calls=0;
  for(let i=0;i<count;i++){const bytes=Buffer.from('payload-'+i),item=descriptor(bytes);items.push(item);values.set(item.path,bytes);}
  return {items,waiting,get active(){return active;},get peak(){return peak;},get calls(){return calls;},
    lstat:async()=>fileStat(100),readFile:file=>{
      calls++;active++;peak=Math.max(peak,active);
      return new Promise((resolve,reject)=>waiting.push({file,resolve:()=>resolve(values.get(path.basename(file))),reject}))
        .finally(()=>{active--;});
    }};
}

test('all descriptors are prevalidated before any I/O, including invalid duplicate bindings',async()=>{
  const item=descriptor(Buffer.from('safe'));let calls=0;
  for(const bad of [{path:'../escape.bin',sha256:item.sha256},{path:item.path,sha256:'f'.repeat(64)},null]){
    await assert.rejects(validateSnapshotPayloads({folder:'fixture',items:[item,item,bad],
      lstat:async()=>{calls++;return fileStat(1);},readFile:async()=>{calls++;return Buffer.from('safe');}}),/inventory/);
  }
  assert.equal(calls,0);
});

test('duplicate physical bindings read and hash once while corruption is still rejected',async()=>{
  const bytes=Buffer.from('shared payload'),item=descriptor(bytes);let reads=0,stats=0;
  const options={folder:'fixture',items:[item,{...item},{...item}],lstat:async()=>{stats++;return fileStat(bytes.length);},
    readFile:async()=>{reads++;return bytes;}};
  assert.deepEqual(await validateSnapshotPayloads(options),[item.path]);assert.equal(reads,1);assert.equal(stats,1);
  await assert.rejects(validateSnapshotPayloads({...options,readFile:async()=>Buffer.from('corrupt')}),/changed/);
});

test('payload validation reaches but never exceeds eight concurrent reads',async()=>{
  const f=controlledPayloads(21),work=validateSnapshotPayloads({folder:'fixture',items:f.items,lstat:f.lstat,readFile:f.readFile});
  await tick();assert.equal(f.calls,8);assert.equal(f.active,8);
  for(const count of [8,8,5]){
    const batch=f.waiting.splice(0,count);assert.equal(batch.length,count);
    for(const pending of batch)pending.resolve();await tick();assert.ok(f.active<=8);
  }
  assert.deepEqual(await work,f.items.map(item=>item.path));
  assert.equal(f.calls,21);assert.equal(f.peak,8);assert.equal(f.active,0);
});

test('first read failure stops scheduling and drains every in-flight read before rejection',async()=>{
  const f=controlledPayloads(20),first=Error('first read failed');let settled=false;
  const result=validateSnapshotPayloads({folder:'fixture',items:f.items,lstat:f.lstat,readFile:f.readFile})
    .then(()=>{settled=true;return null;},error=>{settled=true;return error;});
  await tick();assert.equal(f.calls,8);f.waiting[0].reject(first);await tick();
  assert.equal(settled,false);assert.equal(f.calls,8);assert.equal(f.active,7);
  f.waiting[1].reject(Error('second read failed'));
  for(const pending of f.waiting.slice(2))pending.resolve();
  assert.equal(await result,first);assert.equal(f.calls,8);assert.equal(f.active,0);assert.equal(settled,true);
});

test('digest failure also stops new work and drains readers',async()=>{
  const f=controlledPayloads(20);let settled=false;
  const result=validateSnapshotPayloads({folder:'fixture',items:f.items,lstat:f.lstat,
    readFile:async file=>{const bytes=await f.readFile(file);return file===f.waiting[0].file?Buffer.from('corrupt'):bytes;}})
    .then(()=>{settled=true;return null;},error=>{settled=true;return error;});
  await tick();f.waiting[0].resolve();await tick();assert.equal(settled,false);assert.equal(f.calls,8);
  for(const pending of f.waiting.slice(1))pending.resolve();
  assert.match((await result).message,/changed/);assert.equal(f.active,0);assert.equal(f.calls,8);
});

test('symlink, non-file and oversized payloads are rejected before reading',async()=>{
  const item=descriptor(Buffer.from('x'));let reads=0;
  for(const [stat,pattern] of [
    [{...fileStat(1),isSymbolicLink:()=>true},/symlinks/],
    [{...fileStat(1),isFile:()=>false},/entry/],
    [fileStat(MAX_FILE_BYTES+1),/size limit/]
  ])await assert.rejects(validateSnapshotPayloads({folder:'fixture',items:[item],lstat:async()=>stat,
    readFile:async()=>{reads++;return Buffer.from('x');}}),pattern);
  assert.equal(reads,0);
  await assert.rejects(validateSnapshotPayloads({folder:'fixture',items:[item],lstat:async()=>fileStat(1),
    readFile:async()=>({byteLength:MAX_FILE_BYTES+1})}),/size limit/);
});

test('publication output remains deduplicated and rejects missing physical files',async t=>{
  const root=await fixture(t),directory='public-snapshots88',folder=path.join(root,directory),bytes=Buffer.from('shared'),item=descriptor(bytes);
  await fs.mkdir(folder);await fs.writeFile(path.join(folder,item.path),bytes);
  await fs.writeFile(path.join(folder,'index.json'),JSON.stringify({schemaVersion:1,generation:88,
    files:{'a.json':item,'b.json':{...item}}}));
  assert.deepEqual(await snapshotPublicationFiles({root,directory}),[directory+'/'+item.path,directory+'/index.json'].sort());
  await fs.unlink(path.join(folder,item.path));await assert.rejects(snapshotPublicationFiles({root,directory}),{code:'ENOENT'});
});
