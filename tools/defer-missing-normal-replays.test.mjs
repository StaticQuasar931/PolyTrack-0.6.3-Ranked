import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {encodeSnapshot} from './snapshot-package.mjs';
import {deferMissingNormalReplayRows} from './defer-missing-normal-replays.mjs';
import {assertSnapshotReplayCompleteness} from './snapshot-replay-completeness.mjs';

const track='e'.repeat(64),oldId='a'.repeat(64),newId='b'.repeat(64);
const replay=deflateSync(Buffer.alloc(15)).toString('base64url'),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const run=(accountId,uploadId,timeMs)=>({accountId,trackId:track,uploadId,timeMs,frames:timeMs,replayHash:sha(replay),runVerified:true});
const old=run(oldId,10,2000),fresh=run(newId,11,1000);
const boardPath='tracks/'+track+'.json',canonical=row=>'canonical/'+track+'/'+row.accountId+'.json',recording=row=>'recordings/'+row.uploadId+'.json';
async function fixture(t,{includeOldMedia=true,complete=true}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pt-missing-run-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const directory=path.join(root,'stage'),published=path.join(root,'public-snapshots92');
  const put=async (base,name,bytes)=>{const target=path.join(base,name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes);};
  const json=(base,name,value)=>put(base,name,JSON.stringify(value));
  await json(root,'snapshot-current.json',{currentdir:'public-snapshots92'});
  const files={};
  for(const [name,row] of [[canonical(old),old],...(includeOldMedia?[[recording(old),{...old,recording:replay}]]:[])]){
    const blob=Buffer.from(await encodeSnapshot(row)),hash=sha(blob);
    files[name]={path:hash+'.bin',sha256:hash,decodedBytes:Buffer.byteLength(JSON.stringify(row))};
    await put(published,hash+'.bin',blob);
  }
  await json(published,'index.json',{schemaVersion:1,generation:92,encoding:'gzip-xor-a7-v1',files});
  await json(directory,'manifest.json',{tracks:{[track]:{path:boardPath,updatedAt:50,revision:1,checkedAt:60,fullCanonicalCapture:{complete:true}}}});
  await json(directory,boardPath,{trackId:track,complete,sourceComplete:complete,totalEntriesExact:true,ranksExact:true,updatedAt:50,revision:1,totalEntries:2,entries:[fresh,old]});
  return {root,directory,read:async name=>JSON.parse(await fs.readFile(path.join(directory,name),'utf8')),json};
}

test('restores exact original evidence, omits only a missing newer row, and reranks the board',async t=>{
  const f=await fixture(t);
  t.mock.method(globalThis,'fetch',()=>assert.fail('No Firebase requests'));
  const outcome=await deferMissingNormalReplayRows(f);
  assert.deepEqual(outcome,{restored:1,deferred:1,boards:1,backendReads:0,backendWrites:0});
  const b=await f.read(boardPath);
  assert.equal(b.totalEntries,1);
  assert.equal(b.entries[0].accountId,oldId);
  assert.equal(b.entries[0].rank,1);
  assert.equal(b.entries[0].fieldSize,1);
  assert.equal((await f.read('manifest.json')).tracks[track].checkedAt,60);
  assert.deepEqual((await f.read('manifest.json')).deferredMissingNormalReplays,{rows:1,boards:1});
  assert.equal((await assertSnapshotReplayCompleteness(f.directory)).complete,true);
  assert.equal((await deferMissingNormalReplayRows(f)).deferred,0);
});

test('missing old published media is not silently removed',async t=>{
  const f=await fixture(t,{includeOldMedia:false});
  await assert.rejects(deferMissingNormalReplayRows(f),/Exact previously published replay/);
  assert.deepEqual((await f.read(boardPath)).entries,[fresh,old]);
});

test('incomplete board is never promoted by deferring missing media',async t=>{
  const f=await fixture(t,{complete:false});
  await assert.rejects(deferMissingNormalReplayRows(f),/incomplete board/);
  await assert.rejects(f.read(canonical(old)),{code:'ENOENT'});
});

test('files that exist but have an invalid binding are not bypassed',async t=>{
  const f=await fixture(t);
  await f.json(f.directory,canonical(fresh),fresh);
  await f.json(f.directory,recording(fresh),{...fresh,recording:'wrong'});
  assert.equal((await deferMissingNormalReplayRows(f)).deferred,0);
  await assert.rejects(assertSnapshotReplayCompleteness(f.directory),error=>error.coverage.normal.invalid===1);
});
