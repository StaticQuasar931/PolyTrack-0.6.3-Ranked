'use strict';
// Explicit opt-in: npm run test:native-limits after installing Chromium. No credentials or remote data.
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const zlib=require('node:zlib');
const {verifyBatch}=require('./verify.cjs');
const {sha256,LIMITS}=require('./replay.cjs');
const reviewed=require('./track-geometry.json');
const root=path.resolve(__dirname,'../..');
const replay=zlib.deflateSync(Buffer.alloc(15)).toString('base64url');
const job=(track,timeMs=1000)=>({resultId:'synthetic_'+track.id,trackId:track.id,timeMs,replay,replayHash:sha256(replay)});

test('pinned community exceptions and all official geometry reach bounded native validation', {timeout:180000},async t=>{
  const tracks=reviewed.tracks.filter(track=>track.parts>LIMITS.trackParts||track.name.startsWith('tracks/official/'));
  let worstWall=0,worstCpu=0;
  for(let start=0;start<tracks.length;start+=LIMITS.jobs){
    const group=tracks.slice(start,start+LIMITS.jobs);
    const results=await verifyBatch(root,group.map(track=>job(track)));
    for(let i=0;i<group.length;i++){
      const track=group[i],result=results[i];
      assert.equal(result.reason,'native_finish_mismatch',track.name+': '+result.reason);
      assert.equal(result.status,'mismatch');
      assert.equal(result.deterministic,true);
      assert.deepEqual(result.trackGeometry,{parts:track.parts,spanX:track.spanX,spanZ:track.spanZ});
      assert.equal(result.geometryPolicy,track.parts>LIMITS.trackParts?'reviewed-pinned':'default');
      assert.ok(result.wallMs<LIMITS.wallMs);assert.ok(result.sampledCpuMs<LIMITS.cpuMs);
      worstWall=Math.max(worstWall,result.wallMs);worstCpu=Math.max(worstCpu,result.sampledCpuMs);
    }
  }
  t.diagnostic(JSON.stringify({nativeTracks:tracks.length,syntheticFrames:1000,worstWallMs:worstWall,worstSampledCpuMs:worstCpu}));
});

test('largest pinned geometry still uses unchanged five-minute and native deadline limits',{timeout:90000},async t=>{
  const track=reviewed.tracks.reduce((a,b)=>a.parts>b.parts?a:b);
  const [result]=await verifyBatch(root,[job(track,LIMITS.frames)]);
  assert.equal(result.status,'mismatch',JSON.stringify({reason:result.reason,priorReason:result.priorReason}));
  assert.equal(result.reason,'native_finish_mismatch');assert.equal(result.deterministic,true);
  assert.ok(result.wallMs<LIMITS.wallMs);assert.ok(result.sampledCpuMs<LIMITS.cpuMs);
  t.diagnostic(JSON.stringify({track:track.name,parts:track.parts,syntheticFrames:LIMITS.frames,wallMs:result.wallMs,sampledCpuMs:result.sampledCpuMs}));
});

test('late-transition recording previously rejected by coarse scan estimate reaches unchanged native physics',{timeout:90000},async t=>{
  const bytes=Buffer.alloc(15+1000*3);bytes.writeUIntLE(1000,0,3);
  for(let i=0;i<1000;i++)bytes.writeUIntLE(i?1:59000,3+i*3,3);
  const lateReplay=zlib.deflateSync(bytes).toString('base64url');
  const track=reviewed.tracks.find(t=>t.name==='tracks/official/summer1.track');
  const [result]=await verifyBatch(root,[{...job(track,60000),replay:lateReplay,replayHash:sha256(lateReplay)}]);
  assert.equal(result.status,'mismatch',result.reason);assert.equal(result.reason,'native_finish_mismatch');
  assert.equal(result.deterministic,true);
  t.diagnostic(JSON.stringify({lateTransitions:1000,frames:60000,wallMs:result.wallMs,sampledCpuMs:result.sampledCpuMs}));
});
