'use strict';
// Review-only proposal tests. No production policy mutation, browser, physics or proof creation.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),zlib=require('node:zlib');
const {createRequire}=require('node:module');
const {sha256,LIMITS}=require('./replay.cjs');
const root=path.resolve(__dirname,'../..'),engine=require('./engine-manifest.json'),policy=require('./track-geometry.json');
const trackId='b978a8ebb3d822bfcafa592234bfe65d6f09181038a07230ef9acfc17151a22f';
const codeHash='ed47c43960ef37255a30ab43fce6e44a9ad9f8c534482ca083090a3eb7a03fcd';
const proposed={id:trackId,name:`trusted/${trackId}.track`,hash:codeHash,parts:51029,spanX:828,spanZ:860,displayName:"Magician's Residence"};
const code=fs.readFileSync(path.join(root,'events/kodub/assets',codeHash+'.track'),'utf8');
const proposedPolicy={...policy,tracks:[...policy.tracks.filter(row=>row.id!==trackId),proposed]};
function loadReviewModule(name,reviewPolicy){
 const filename=path.join(__dirname,name),req=createRequire(filename),c=vm.createContext({Buffer,module:{exports:{}},
  require:specifier=>specifier==='./track-geometry.json'?reviewPolicy:req(specifier)});
 const tail=name==='kodub-track.cjs'?'\nmodule.exports.reviewParse=parseTrackPayload;':'';
 new vm.Script(fs.readFileSync(filename,'utf8')+tail,{filename}).runInContext(c,{timeout:2000});return c.module.exports;
}
function boundedInflate(compressed){
 const result=zlib.inflateSync(compressed,{maxOutputLength:16*1024*1024,info:true});
 assert.equal(result.engine.bytesWritten,compressed.length,'no trailing compressed streams');return result.buffer;
}
function measurePayload(){
 assert.equal(sha256(code),codeHash);assert.equal(Buffer.byteLength(code),93502);
 const {decodePacked}=require('./kodub-track.cjs')._internals;
 const outer=decodePacked(code.slice(10),LIMITS.trackBytes,'review_input_cap'),text=boundedInflate(outer);
 assert.match(text.toString('latin1'),/^[0-9A-Za-z]+$/);
 const second=decodePacked(text.toString('ascii'),16*1024*1024,'review_inner_cap'),payload=boundedInflate(second);
 return {payload,outerBytes:outer.length,packedTextBytes:text.length,secondBytes:second.length};
}
function nativeGeometry(){
 const source=fs.readFileSync(path.join(root,'main.bundle.js'),'utf8').replace(/\r\n?/g,'\n');
 assert.equal(sha256(source),engine.files['main.bundle.js'],'native decoder must be the pinned engine bytes');
 const marker=',n={};function i(e){var r=n[e]',pos=source.indexOf(marker);
 assert(pos>0);assert.equal(source.indexOf(marker,pos+1),-1,'one reviewed module-table boundary');
 const c=vm.createContext({window:{},TextDecoder,TextEncoder,Uint8Array,ArrayBuffer,DataView,Buffer,URL,
  atob:s=>Buffer.from(s,'base64').toString('binary'),btoa:s=>Buffer.from(s,'binary').toString('base64')});
 new vm.Script(source.slice(0,pos)+';globalThis.factories=t;})();').runInContext(c,{timeout:2000});
 const cache=new Map();function req(id){if(cache.has(id))return cache.get(id).exports;const m={exports:{}};cache.set(id,m);
  assert.equal(typeof c.factories[id],'function');c.factories[id](m,m.exports,req);return m.exports;}
 req.d=(target,defs)=>{for(const[k,get]of Object.entries(defs))if(!Object.hasOwn(target,k))Object.defineProperty(target,k,{enumerable:true,get});};
 req.r=x=>Object.defineProperty(x,'__esModule',{value:true});req.n=x=>{const get=x?.__esModule?()=>x.default:()=>x;req.d(get,{a:get});return get;};
 req.o=(o,k)=>Object.hasOwn(o,k);req.p='';req.g=c;c.Track=req(9117).A;c.reviewCode=code;
 // Only track parsing/math modules run. There is no app startup, Worker, Validator or replay.
 new vm.Script('const data=Track.fromExportString(reviewCode).trackData,b=data.getBounds();globalThis.geometry={id:data.getId(),parts:data.numberOfParts,spanX:b.max.x-b.min.x,spanZ:b.max.y-b.min.y,hasStart:!!data.getStartTransform()};')
  .runInContext(c,{timeout:3000});
 return JSON.parse(JSON.stringify(c.geometry));
}

test('one exact saved track reproduces the pre-physics guard and has bounded well-formed payload',t=>{
 const measured=measurePayload(),base=loadReviewModule('kodub-track.cjs',{...policy,tracks:policy.tracks.filter(r=>r.id!==trackId)});
 assert.equal(LIMITS.trackParts,20000);assert.equal(LIMITS.trackSpan,2048);assert.equal(LIMITS.trackBytes,262144);
 assert.equal(measured.payload.length,368288);assert.equal(base._internals.TRACK_PREFLIGHT_LIMITS.payloadBytes,361812);
 assert.throws(()=>base._internals.preflightTrackCode(code),{reason:'trusted_track_inflated_size_limit'});
 assert.equal(base.reviewParse(measured.payload,2,100000),51029);
 assert.throws(()=>base.reviewParse(measured.payload,2,51028),{reason:'trusted_track_part_limit'});
 assert.throws(()=>base.reviewParse(measured.payload.subarray(0,-1),2,100000));
 assert.throws(()=>base.reviewParse(Buffer.concat([measured.payload,Buffer.from([255])]),2,100000));
 t.diagnostic(JSON.stringify({codeHash,parts:51029,payloadBytes:368288,outerBytes:measured.outerBytes,packedTextBytes:measured.packedTextBytes,secondBytes:measured.secondBytes,reviewInflationCeiling:16777216}));
});
test('pinned native track decoder independently agrees with strict parser, exact identity and start',()=>{
 assert.deepEqual(policy.tracks.find(row=>row.id===trackId),proposed,'only the measured exact reviewed row is enabled');
 assert.equal(policy.engineDigest,engine.engineDigest);
 assert.deepEqual(nativeGeometry(),{id:trackId,parts:51029,spanX:828,spanZ:860,hasStart:true});
});
test('proposed exact exception passes existing production algorithms in memory; unknown inputs stay rejected',()=>{
 const decoder=loadReviewModule('kodub-track.cjs',proposedPolicy),geometry=loadReviewModule('geometry.cjs',proposedPolicy);
 const accepted=decoder.partitionTrustedTracks([{trackId,codeHash,code}],new Set([trackId]));
 assert.equal(accepted.accepted.length,1);assert.equal(accepted.rejected.size,0);
 const parsed=decoder._internals.preflightTrackCode(code,proposed);assert.equal(parsed.parts,51029);assert.equal(parsed.inflatedBytes,368288);
 const descriptor={...proposed,trusted:true,geometry:{parts:51029,spanX:828,spanZ:860}};
 assert.equal(geometry.geometryDecision(descriptor,engine.engineDigest).geometryPolicy,'reviewed-pinned');
 for(const change of [{hash:'f'.repeat(64)},{id:'f'.repeat(64)},{geometry:{parts:51030,spanX:828,spanZ:860}},
  {geometry:{parts:51029,spanX:829,spanZ:860}},{geometry:{parts:51029,spanX:828,spanZ:861}}])
  assert.equal(geometry.geometryDecision({...descriptor,...change},engine.engineDigest).reason,'track_geometry_limit');
 assert.equal(geometry.geometryDecision(descriptor,'f'.repeat(64)).reason,'track_geometry_limit');
 const other='f'.repeat(64),unknown=decoder.partitionTrustedTracks([{trackId:other,codeHash,code}],new Set([other]));
 assert.equal(unknown.accepted.length,0);assert.equal(unknown.rejected.get(other),'trusted_track_inflated_size_limit');
 const altered=decoder.partitionTrustedTracks([{trackId,codeHash,code:code+'A'}],new Set([trackId]));
 assert.equal(altered.rejected.get(trackId),'trusted_track_hash_mismatch');
 assert.equal(LIMITS.trackParts,20000,'proposal never modifies production defaults');
});
