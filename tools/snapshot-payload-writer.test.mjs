import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {writeSnapshotPayloads} from './snapshot-payload-writer.mjs';
import {encodeSnapshot} from './snapshot-package.mjs';

async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'snapshot-writer-'));
  t.after(async()=>{assert.equal(path.dirname(directory),os.tmpdir());assert.ok(path.basename(directory).startsWith('snapshot-writer-'));await fs.rm(directory,{recursive:true,force:true});});
  return directory;
}
const entries=Array.from({length:20},(_,i)=>({logicalPath:`data/${i}.json`,bytes:Buffer.from(JSON.stringify({i:i%5}))}));
test('parallel encoding preserves exact serial bytes, ordered metadata and duplicate content',async t=>{
  const directory=await fixture(t);let active=0,peak=0;
  const encode=async bytes=>{active++;peak=Math.max(peak,active);try{await new Promise(r=>setTimeout(r,4));return Buffer.from(await encodeSnapshot(bytes.toString('utf8')));}finally{active--;}};
  const output=await writeSnapshotPayloads({entries,directory,encode,maxEncodedBytes:1024});
  assert.equal(peak,4);assert.equal(active,0);assert.deepEqual(output.map(v=>v.logicalPath),entries.map(v=>v.logicalPath));
  for(const [i,row] of output.entries())assert.deepEqual(await fs.readFile(path.join(directory,row.path)),Buffer.from(await encodeSnapshot(entries[i].bytes.toString('utf8'))));
  assert.equal((await fs.readdir(directory)).length,5);
});
test('encoding failure drains workers before publication cleanup and does not schedule the whole queue',async t=>{
  const directory=await fixture(t);let active=0,calls=0;
  const encode=async bytes=>{const i=calls++;active++;try{await new Promise(r=>setTimeout(r,i?15:1));if(!i)throw Error('encode failed');return bytes;}finally{active--;}};
  await assert.rejects(writeSnapshotPayloads({entries,directory,encode,maxEncodedBytes:1024}),/encode failed/);
  assert.equal(active,0);assert.equal(calls,4);assert.deepEqual(await fs.readdir(directory),[]);
});
test('disk failure drains all outstanding writers before rejecting',async t=>{
  const directory=await fixture(t),original=fs.writeFile;let active=0;
  t.mock.method(fs,'writeFile',async(file,...args)=>{active++;try{await new Promise(r=>setTimeout(r,5));if(path.basename(file)==='snapshot-0001.bin')throw Error('disk failed');return await original(file,...args);}finally{active--;}});
  await assert.rejects(writeSnapshotPayloads({entries,directory,encode:async bytes=>bytes,maxEncodedBytes:1024}),/disk failed/);
  assert.equal(active,0);
});
test('worker and encoded-size bounds fail closed',async t=>{
  const directory=await fixture(t),options={entries,directory,encode:async bytes=>bytes,maxEncodedBytes:1024};
  for(const concurrency of [0,9,NaN])await assert.rejects(writeSnapshotPayloads({...options,concurrency}),/Invalid/);
  await assert.rejects(writeSnapshotPayloads({...options,maxEncodedBytes:1}),/exceeds/);
});
test('multiple worker failures retain input-order error precedence',async t=>{
  const directory=await fixture(t);let next=0;
  const encode=async()=>{const index=next++;await new Promise(r=>setTimeout(r,index?1:15));throw Error('entry-'+index);};
  await assert.rejects(writeSnapshotPayloads({entries,directory,encode,maxEncodedBytes:1024,concurrency:2}),/entry-0/);
});
