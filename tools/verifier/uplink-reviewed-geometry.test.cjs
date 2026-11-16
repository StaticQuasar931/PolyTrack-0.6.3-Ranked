'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {sha256,LIMITS}=require('./replay.cjs'),{geometryDecision}=require('./geometry.cjs'),decoder=require('./kodub-track.cjs');
const root=path.resolve(__dirname,'../..'),engine=require('./engine-manifest.json'),policy=require('./track-geometry.json');
const trackId='99fe53184c661a29a6b9125af16897c54c6ce228df05b22b8f3cd504ff9e8b37',
 codeHash='9a4fbc02e4cf8416fc7fd6fc6691072b8b349be5f7f02aab5a7b2990ada6019a';
const code=fs.readFileSync(path.join(root,'events/kodub/assets',codeHash+'.track'),'utf8');
const row=policy.tracks.find(value=>value.id===trackId);

test('Uplink exception is exact, engine-pinned and leaves general bounds unchanged',()=>{
 assert.equal(sha256(code),codeHash);assert.equal(policy.engineDigest,engine.engineDigest);
 assert.deepEqual(row,{id:trackId,name:'trusted/'+trackId+'.track',hash:codeHash,parts:50193,spanX:604,spanZ:604,displayName:'Uplink\u26d0Error'});
 assert.equal(LIMITS.trackParts,20000);assert.equal(LIMITS.trackSpan,2048);
 assert.equal(decoder._internals.preflightTrackCode(code,row).parts,50193);
 const accepted=decoder.partitionTrustedTracks([{trackId,codeHash,code}],new Set([trackId]));
 assert.equal(accepted.accepted.length,1);assert.equal(accepted.rejected.size,0);
 const input={...row,trusted:true,geometry:{parts:50193,spanX:604,spanZ:604}};
 assert.equal(geometryDecision(input,engine.engineDigest).geometryPolicy,'reviewed-pinned');
 for(const change of [{hash:'f'.repeat(64)},{id:'f'.repeat(64)},
  {geometry:{parts:50194,spanX:604,spanZ:604}},{geometry:{parts:50193,spanX:605,spanZ:604}}])
  assert.equal(geometryDecision({...input,...change},engine.engineDigest).reason,'track_geometry_limit');
 assert.equal(geometryDecision(input,'f'.repeat(64)).reason,'track_geometry_limit');
 assert.equal(decoder.partitionTrustedTracks([{trackId:'f'.repeat(64),codeHash,code}],new Set(['f'.repeat(64)])).accepted.length,0);
});

test('pinned native decoder independently confirms Uplink identity, bounds and start',()=>{
 const source=fs.readFileSync(path.join(root,'main.bundle.js'),'utf8').replace(/\r\n?/g,'\n');
 assert.equal(sha256(source),engine.files['main.bundle.js']);
 const marker=',n={};function i(e){var r=n[e]',position=source.indexOf(marker);
 assert.ok(position>0);assert.equal(source.indexOf(marker,position+1),-1);
 const c=vm.createContext({window:{},TextDecoder,TextEncoder,Uint8Array,ArrayBuffer,DataView,Buffer,URL,
  atob:s=>Buffer.from(s,'base64').toString('binary'),btoa:s=>Buffer.from(s,'binary').toString('base64')});
 new vm.Script(source.slice(0,position)+';globalThis.factories=t;})();').runInContext(c,{timeout:2000});
 const cache=new Map();function req(id){if(cache.has(id))return cache.get(id).exports;const m={exports:{}};cache.set(id,m);c.factories[id](m,m.exports,req);return m.exports;}
 req.d=(target,defs)=>{for(const [key,get]of Object.entries(defs))if(!Object.hasOwn(target,key))Object.defineProperty(target,key,{enumerable:true,get});};
 req.r=x=>Object.defineProperty(x,'__esModule',{value:true});req.n=x=>{const get=x?.__esModule?()=>x.default:()=>x;req.d(get,{a:get});return get;};
 req.o=(o,k)=>Object.hasOwn(o,k);req.p='';req.g=c;c.Track=req(9117).A;c.reviewCode=code;
 new vm.Script('const data=Track.fromExportString(reviewCode).trackData,b=data.getBounds();globalThis.geometry={id:data.getId(),parts:data.numberOfParts,spanX:b.max.x-b.min.x,spanZ:b.max.y-b.min.y,hasStart:!!data.getStartTransform()};').runInContext(c,{timeout:5000});
 assert.deepEqual(JSON.parse(JSON.stringify(c.geometry)),{id:trackId,parts:50193,spanX:604,spanZ:604,hasStart:true});
});
