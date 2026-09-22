'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const {LIMITS, decodeReplay, checkJob, sha256, linearScanWork} = require('./replay.cjs');
const {geometryDecision} = require('./geometry.cjs');
const {canonicalBytes} = require('./assets.cjs');
const reviewed = require('./track-geometry.json');
const manifest = require('./engine-manifest.json');
const root = path.resolve(__dirname, '../..');
const names = ['up','right','down','left','reset'];
const lists = () => Object.fromEntries(names.map(name => [name, []]));
function recording(channels) {
  const buffers = [];
  for (const name of names) {
    const frames = channels[name], bytes = Buffer.alloc(3+3*frames.length);
    bytes.writeUIntLE(frames.length,0,3);
    frames.forEach((frame,i) => bytes.writeUIntLE(frame-(i?frames[i-1]:0),3+i*3,3));
    buffers.push(bytes);
  }
  return zlib.deflateSync(Buffer.concat(buffers)).toString('base64url');
}

test('reviewed geometry matches committed track bytes and the pinned native engine', () => {
  assert.equal(reviewed.engineDigest, manifest.engineDigest);
  assert.equal(reviewed.tracks.length,90);
  assert.equal(new Set(reviewed.tracks.map(t=>t.id)).size,90);
  for (const t of reviewed.tracks) {
    const trusted=t.name.startsWith('trusted/');
    const assetPath=trusted?path.join(root,'events/kodub/assets',t.hash+'.track'):path.join(root,t.name);
    const hash=sha256(canonicalBytes(t.name,fs.readFileSync(assetPath)));
    assert.equal(hash,t.hash,t.name);
    if(!trusted)assert.equal(manifest.tracks[t.name],t.hash,t.name);
  }
});

test('17 official tracks fit defaults; 28 community and one trusted asset use exact exceptions', () => {
  let exceptions=0,official=0;
  for (const t of reviewed.tracks) {
    const decision=geometryDecision({...t,geometry:t},reviewed.engineDigest);
    assert.equal(decision.reason,null,t.name);
    if(t.name.startsWith('tracks/official/')) {official++;assert.equal(decision.geometryPolicy,'default');}
    if(t.parts>LIMITS.trackParts) {exceptions++;assert.equal(decision.geometryPolicy,'reviewed-pinned');}
  }
  assert.equal(official,17);assert.equal(exceptions,29);
  assert.equal(reviewed.tracks.filter(t=>t.parts>LIMITS.trackParts&&t.name.startsWith('tracks/community/')).length,28);
  assert.equal(reviewed.tracks.filter(t=>t.name.startsWith('trusted/')).length,1);
  assert.equal(Math.max(...reviewed.tracks.map(t=>t.parts)),74711);
  assert.equal(Math.max(...reviewed.tracks.flatMap(t=>[t.spanX,t.spanZ])),1264);
  assert.equal(LIMITS.trackParts,20000);assert.equal(LIMITS.trackSpan,2048);
});

test('reviewed exceptions cannot admit changed hashes, engines, native identities, or geometry', () => {
  const t=reviewed.tracks.find(t=>t.parts>LIMITS.trackParts);
  const track={...t,geometry:{parts:t.parts,spanX:t.spanX,spanZ:t.spanZ}};
  for(const change of [{hash:'0'.repeat(64)},{id:'0'.repeat(64)},{name:'tracks/custom.track'},
    {geometry:{...track.geometry,parts:t.parts+1}},{geometry:{...track.geometry,spanX:t.spanX+1}}]) {
    assert.equal(geometryDecision({...track,...change},reviewed.engineDigest).reason,'track_geometry_limit');
  }
  assert.equal(geometryDecision(track,'other-engine').reason,'track_geometry_limit');
  for(const geometry of [{parts:1,spanX:2049,spanZ:1},{parts:1,spanX:NaN,spanZ:1},
    {parts:Infinity,spanX:1,spanZ:1},{parts:1,spanX:-1,spanZ:1}]) {
    assert.equal(geometryDecision({...track,geometry},reviewed.engineDigest).reason,'track_geometry_limit');
  }
});

test('closed-form work matches native linear lookup element visits at every boundary', () => {
  const source=fs.readFileSync(path.join(root,'main.bundle.js'),'utf8');
  const start=source.indexOf('1754:('), end=source.indexOf('},1758:(',start);
  const module=source.slice(start,end);
  const match=module.match(/d=(function\(e,t\)\{let n=-1;for\(let i=0;i<t.length;\+\+i\)\{const r=t\[i\];if\(r==e\)\{n=i;break\}if\(r>e\)break;n=i\}return n\}),u=/);
  assert.ok(match,'Pinned native linear lookup must be reviewed if its implementation changes');
  const worker=fs.readFileSync(path.join(root,'simulation_worker.bundle.js'),'utf8');
  const workerMatch=worker.match(/ka=(function\(t,e\)\{let i=-1;for\(let r=0;r<e.length;\+\+r\)\{const s=e\[r\];if\(s==t\)\{i=r;break\}if\(s>t\)break;i=r\}return i\}),_a=/);
  assert.ok(workerMatch,'Pinned simulation-worker lookup must also retain the audited semantics');
  const nativeLookups=[match[1],workerMatch[1]].map(body=>vm.runInNewContext('('+body+')'));
  for(const native of nativeLookups) for(let mask=0;mask<256;mask++) {
    const channels=lists();channels.up=Array.from({length:8},(_,i)=>i).filter(i=>mask&(1<<i));
    channels.left=[0,3,7];channels.reset=[8];
    let probes=8*5;
    for(const name of names) {
      const a=channels[name];
      const observed=new Proxy(a,{get(target,key){if(/^\d+$/.test(String(key)))probes++;return Reflect.get(target,key);}});
      for(let frame=0;frame<8;frame++) {
        const index=native(frame,observed);
        assert.equal(index,a.filter(n=>n<=frame).length-1);
      }
    }
    assert.equal(linearScanWork(channels,8),probes);
  }
});

test('late transitions no longer fail a coarse estimate but early expensive scans still fail', () => {
  const late=lists();late.up=Array.from({length:1000},(_,i)=>59000+i);
  assert.ok(60000*1005>LIMITS.scanWork);
  const decoded=decodeReplay(recording(late),60000);
  assert.ok(decoded.scanWork<LIMITS.scanWork);
  assert.deepEqual(decoded.lists,late);
  const early=lists();early.up=Array.from({length:1000},(_,i)=>i);
  assert.throws(()=>decodeReplay(recording(early),60000),e=>e.reason==='scan_work_limit'&&e.status==='unavailable');
  assert.equal(LIMITS.scanWork,30000000);
});

test('five-minute, transition, decompression, CPU and wall bounds remain in force', () => {
  const replay=recording(lists());
  const job={resultId:'synthetic',trackId:'0'.repeat(64),timeMs:300000,replay,replayHash:sha256(replay)};
  assert.ok(checkJob(job));
  assert.throws(()=>checkJob({...job,timeMs:300001}),e=>e.reason==='time_limit');
  assert.equal(LIMITS.frames,300000);assert.equal(LIMITS.transitions,10000);
  assert.equal(LIMITS.inflatedBytes,30015);assert.equal(LIMITS.cpuMs,20000);assert.equal(LIMITS.wallMs,45000);
  const over=lists();over.up=Array.from({length:4097},(_,i)=>i);
  assert.throws(()=>decodeReplay(recording(over),10000),e=>e.reason==='transition_limit');
});
