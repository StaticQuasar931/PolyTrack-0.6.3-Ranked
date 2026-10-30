import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {deflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {createCachedVerifier,snapshotReplayFor} from './proof-cache.mjs';
const root=fileURLToPath(new URL('../..',import.meta.url));
const geometry=JSON.parse(fs.readFileSync(new URL('./track-geometry.json',import.meta.url)));
const manifest=JSON.parse(fs.readFileSync(new URL('./engine-manifest.json',import.meta.url)));
const t=geometry.tracks.find(t=>manifest.tracks[t.name]===t.hash);
const hash=v=>createHash('sha256').update(v).digest('hex');
const replay=deflateSync(Buffer.alloc(15)).toString('base64url');
const job={resultId:'a',accountId:'a'.repeat(64),trackId:t.id,timeMs:10,replay,replayHash:hash(replay),uploadId:1};
function verdict(j){return {resultId:j.resultId,trackId:j.trackId,timeMs:j.timeMs,replayHash:j.replayHash,status:'verified',reason:'native_exact_finish',
  deterministic:true,engineDigest:manifest.engineDigest,trackContentHash:t.hash,binding:{resultId:j.resultId,trackId:j.trackId,timeMs:j.timeMs,
    replayHash:j.replayHash,actualReplayHash:j.replayHash,nativeTrackId:j.trackId,trackContentHash:t.hash,engineDigest:manifest.engineDigest,
    verifierFingerprint:'f'.repeat(64),verifierVersion:'polytrack-native-bounded-v1',resourceProfile:'standard'}};}
const create=verify=>createCachedVerifier({root,verify,engineDigest:manifest.engineDigest,verifierFingerprint:'f'.repeat(64)});
test('exact bytes reuse native proof across result IDs but strip review decisions and rebind fingerprints',async()=>{
  let calls=0;const verify=create(async(_r,jobs)=>{calls++;return jobs.map(j=>({...verdict(j),needsReview:true,reviewEvidence:{private:true}}));});
  await verify(root,[job]);const next={...job,resultId:'b'},[r]=await verify(root,[next]);
  assert.equal(calls,1);assert.equal(r.resultId,'b');assert.equal(r.binding.resultId,'b');
  assert.equal(r.boundInputFingerprint,hash(JSON.stringify(r.binding)));assert.equal(r.needsReview,undefined);
  assert.deepEqual(verify.stats().hits,1);
});
test('changed bytes, claimed time and missing track identity miss cache; unavailable never enters it',async()=>{
  let calls=0;const verify=create(async(_r,jobs)=>{calls++;return jobs.map(j=>({...verdict(j),status:'unavailable'}));});
  await verify(root,[job]);await verify(root,[job]);assert.equal(calls,2);assert.equal(verify.stats().entries,0);
  const cached=create(async(_r,jobs)=>{calls++;return jobs.map(verdict);});
  cached.seed([job],[verdict(job)]);await cached(root,[{...job,timeMs:11}]);
  await cached(root,[{...job,replay:replay+'A'}]);await cached(root,[{...job,trackId:'b'.repeat(64)}]);assert.equal(cached.stats().hits,0);
});
test('non-deterministic, stale engine, hash and resource profiles cannot seed proofs',async()=>{
  for(const change of [r=>({...r,deterministic:false}),r=>({...r,engineDigest:'0'.repeat(64)}),r=>({...r,binding:{...r.binding,actualReplayHash:'0'.repeat(64)}}),r=>({...r,binding:{...r.binding,resourceProfile:'extended-local'}})]){
    const c=create(async()=>[]);c.seed([job],[change(verdict(job))]);assert.equal(c.stats().entries,0);
  }
});
test('snapshot byte reuse requires hydrated exact upload/account/track/time/hash, not snapshot freshness',()=>{
  const source={...job,canonical:{uploadId:1,replayHash:job.replayHash}};
  assert.equal(snapshotReplayFor(job,source),job.replay);
  for(const change of [{uploadId:2},{accountId:'b'.repeat(64)},{trackId:'b'.repeat(64)},{timeMs:11},{replayHash:'b'.repeat(64)}])assert.equal(snapshotReplayFor({...job,...change},source),null);
  assert.equal(snapshotReplayFor(job,{...source,replay:replay+'A'}),null);
  assert.equal(snapshotReplayFor({...job,uploadId:undefined},{...source,canonical:{replayHash:job.replayHash}}),null);
});
