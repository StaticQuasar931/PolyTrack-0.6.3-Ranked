import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {publicEventPlaybackForPublication} from './public-event-playback.mjs';
import {seedLocalEventPlaybacks} from './local-playback-cache.mjs';

const id='w_fixture',trackId='b'.repeat(64),accountId='a'.repeat(64),runId='c'.repeat(64);
async function fixture(t){
  t.mock.method(globalThis,'fetch',()=>assert.fail('Local cache reuse forbids network'));
  const top=await fs.mkdtemp(path.join(os.tmpdir(),'local-playback-cache-'));
  t.after(()=>fs.rm(top,{recursive:true,force:true}));
  const directory=path.join(top,'stage'),cacheDirectory=path.join(top,'cache');
  await fs.mkdir(path.join(directory,'events'),{recursive:true});await fs.mkdir(path.join(cacheDirectory,'event-playbacks',id),{recursive:true});
  const replay=deflateSync(Buffer.alloc(15)).toString('base64url'),replayHash=createHash('sha256').update(replay).digest('hex');
  const status={verificationStatus:'waiting',pending:true,verified:false,eventRpEligible:false};
  const entry={accountId,runId,timeMs:1000,replayHash,submittedAt:123,...status,source:'pending-event-playback'};
  const raw={periodId:id,trackId,accountId,runId,timeMs:1000,frames:1000,replay,replayHash,carStyle:'style',submittedAt:123,...status,source:'pending-event-recording'};
  const value=await publicEventPlaybackForPublication(raw,{periodId:id,trackId,entry});
  const relative=`event-playbacks/${id}/${runId}.json`,manifest={schemaVersion:1,events:{[id]:{path:`events/${id}.json`}},eventPlaybacks:{},nativeVerificationLedger:{manifestHash:'d'.repeat(64)}};
  const put=async(file,v)=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(v));};
  const board={id,period:{id,trackId},entries:[],pendingPlaybacks:[entry]};
  await put(path.join(directory,'manifest.json'),manifest);await put(path.join(directory,'events',id+'.json'),board);
  await put(path.join(cacheDirectory,relative),value);
  return {top,directory,cacheDirectory,relative,entry,value,manifest,board,put,run:()=>seedLocalEventPlaybacks({directory,cacheDirectory})};
}

test('exact retained waiting bytes seed once without changing boards or verification authority',async t=>{
  const f=await fixture(t),before=await fs.readFile(path.join(f.directory,'events',id+'.json'));
  const result=await f.run();assert.equal(result.reused,1);assert.equal(result.backendReads,0);assert.equal(result.backendWrites,0);
  assert.deepEqual(await fs.readFile(path.join(f.directory,'events',id+'.json')),before);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.directory,f.relative))),f.value);
  const saved=JSON.parse(await fs.readFile(path.join(f.directory,'manifest.json')));
  assert.deepEqual(saved.nativeVerificationLedger,f.manifest.nativeVerificationLedger);
  assert.equal(saved.eventPlaybacks[f.relative].replayHash,f.entry.replayHash);
  assert.equal((await f.run()).reused,0);
});

test('different bindings, private fields, changed bytes and verdicts cannot seed payloads',async t=>{
  for(const change of [{accountId:'f'.repeat(64)},{trackId:'f'.repeat(64)},{runId:'f'.repeat(64)},
    {timeMs:999},{frames:999},{submittedAt:124},{replayHash:'f'.repeat(64)},{replay:'broken'},
    {verified:true},{privateToken:'do-not-copy'},{verificationStatus:'verified'}]){
    const f=await fixture(t);await f.put(path.join(f.cacheDirectory,f.relative),{...f.value,...change});
    assert.equal((await f.run()).reused,0);
    await assert.rejects(fs.stat(path.join(f.directory,f.relative)),{code:'ENOENT'});
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.directory,'manifest.json'))),f.manifest);
  }
});

test('a time-only source binding is insufficient and existing files are never overwritten',async t=>{
  const f=await fixture(t);delete f.entry.replayHash;await f.put(path.join(f.directory,'events',id+'.json'),f.board);
  assert.equal((await f.run()).reused,0);
  await f.put(path.join(f.directory,f.relative),{existing:'untouched'});
  assert.equal((await f.run()).reused,0);assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.directory,f.relative))),{existing:'untouched'});
});

test('missing cache candidates and permanent boards do not cause network fallback',async t=>{
  const f=await fixture(t);await fs.unlink(path.join(f.cacheDirectory,f.relative));
  f.manifest.events['permanent-rolling-hills']={path:'events/permanent-rolling-hills.json'};
  await f.put(path.join(f.directory,'manifest.json'),f.manifest);
  await f.put(path.join(f.directory,'events/permanent-rolling-hills.json'),{id:'permanent-rolling-hills',kind:'permanent',trackId,entries:[]});
  const result=await f.run();assert.equal(result.reused,0);assert.equal(result.rejected,1);
});

test('manifest path escapes are rejected before copying',async t=>{
  const f=await fixture(t);f.manifest.events[id].path='../outside.json';
  await f.put(path.join(f.directory,'manifest.json'),f.manifest);
  await assert.rejects(f.run(),/invalid event path/);
  await assert.rejects(fs.stat(path.join(f.directory,f.relative)),{code:'ENOENT'});
});

test('manifest races preserve the winning manifest and remove only newly seeded files',async t=>{
  const f=await fixture(t),original=fs.writeFile,manifestFile=path.join(f.directory,'manifest.json');
  const winner={...f.manifest,winner:true};
  t.mock.method(fs,'writeFile',async(file,...args)=>{
    const result=await original(file,...args);
    if(file===path.join(f.directory,f.relative))await original(manifestFile,JSON.stringify(winner));
    return result;
  });
  await assert.rejects(f.run(),/manifest changed/);
  assert.deepEqual(JSON.parse(await fs.readFile(manifestFile)),winner);
  await assert.rejects(fs.stat(path.join(f.directory,f.relative)),{code:'ENOENT'});
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.cacheDirectory,f.relative))),f.value);
});

test('an output junction cannot redirect cached writes outside staging',async t=>{
  const f=await fixture(t),outside=path.join(f.top,'outside');await fs.mkdir(outside);
  try{await fs.symlink(outside,path.join(f.directory,'event-playbacks'),process.platform==='win32'?'junction':'dir');}
  catch(error){if(['EPERM','EACCES'].includes(error.code)){t.skip('Host denies junction creation');return;}throw error;}
  await assert.rejects(f.run(),/unsafe output directory/);
  assert.deepEqual(await fs.readdir(outside),[]);
});
