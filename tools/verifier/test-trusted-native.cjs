'use strict';
// Opt-in mixed native smoke: rejected large tracks must not block ordinary replays.
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
const test=require('node:test'),assert=require('node:assert/strict');
const {verifyBatch}=require('./verify.cjs');
const {sha256}=require('./replay.cjs');
const root=path.resolve(__dirname,'../..');
const weekly={trackId:'b'.repeat(64),trackUrl:'assets/84129c91045797a07a0b2c5bb5337ca946c80b63ac68287b32704a81c4bf77ba.track'};
const official=require('./track-geometry.json').tracks.find(t=>t.name==='tracks/official/summer1.track');
const code=fs.readFileSync(path.join(root,'events/kodub',weekly.trackUrl),'utf8');
const replay=zlib.deflateSync(Buffer.alloc(15)).toString('base64url');
const job=id=>({resultId:'synthetic_'+id,trackId:id,timeMs:1000,replay,replayHash:sha256(replay)});
test('oversized unreviewed track stays unavailable while ordinary native validation proceeds',{timeout:90000},async t=>{
 const results=await verifyBatch(root,[job(weekly.trackId),job(official.id)],
  [{trackId:weekly.trackId,code,codeHash:sha256(code)}]);
 assert.equal(results[0].status,'unavailable');assert.equal(results[0].reason,'trusted_track_inflated_size_limit');
 assert.equal(results[0].trackContentHash,null);
 assert.equal(results[1].reason,'native_finish_mismatch',JSON.stringify(results[1]));
 assert.equal(results[1].status,'mismatch');assert.equal(results[1].deterministic,true);
 assert.equal(results[1].geometryPolicy,'default');
 t.diagnostic(JSON.stringify(results.map(r=>({trackId:r.trackId,reason:r.reason,wallMs:r.wallMs,sampledCpuMs:r.sampledCpuMs}))));
});
