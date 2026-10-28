import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm, truncate} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {CODEC_LIMITS, COMPACT_SCHEMA, encodeDiagnosticReport, decodeDiagnosticReport, serializeDiagnosticReport} from './diagnostic-codec.mjs';
import {buildDeveloperReport} from './developer-diagnostics.mjs';
const encode = encodeDiagnosticReport, decode = decodeDiagnosticReport;
const envelope = data => JSON.stringify({schema: COMPACT_SCHEMA, version: 1, strings: [], shapes: [], data});
test('lossless JSON values, ordered shapes, IDs, nulls, fractional milliseconds and timestamps', () => {
 const report = {schema:'polytrack-developer-diagnostics-v1',exportedAt:'2026-01-01T00:00:00.123Z',rows:Array.from({length:100},(_,i)=>({trackId:'synthetic-track-id',at:1790000000000+i,timeMs:1.234,rank:null,known:false,text:'\u2603\n\u0000\ud800',nested:[[],{},true,0,-1,1e100]})),other:{b:2,a:1}};
 const packed = encode(report), result = decode(packed);
 assert.deepEqual(result, report); assert.equal(JSON.stringify(result), JSON.stringify(report));
 assert.ok(Buffer.byteLength(packed) < Buffer.byteLength(JSON.stringify(report)) * .75);
 assert.deepEqual(decode(JSON.stringify(report)),report);
 assert.equal(serializeDiagnosticReport(report,{format:'json'}),JSON.stringify(report));
 assert.ok(Object.is(decode(encode(-0)),-0));
});
test('privacy remains upstream: opted-out IDs and private codes never enter dictionary', () => {
 const localData = {profiles:[{publicId:'synthetic-racer',name:'Synthetic',personalBests:[]}],savedTracks:[{data:'SYNTHETIC-PRIVATE-CODE'}]};
 for (const choice of [false,{includePublicId:true,includeSavedTrackCodes:false},{includePublicId:true,includeSavedTrackCodes:true}]) {
  const report = buildDeveloperReport({includePublicId:choice,localData});
  const packed = encode(report); assert.deepEqual(decode(packed),report);
  if (!choice) {assert.doesNotMatch(packed,/synthetic-racer/);assert.equal(decode(packed).localData,null);}
  if (!choice || !choice.includeSavedTrackCodes) assert.doesNotMatch(packed,/SYNTHETIC-PRIVATE-CODE/);
  else assert.equal(decode(packed).localData.savedTracks[0].data,'SYNTHETIC-PRIVATE-CODE');
 }
});
test('prototype-related keys remain own data and never pollute prototypes', () => {
 const report = JSON.parse('{"schema":"polytrack-developer-diagnostics-v1","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"prototype":null}');
 const result = decode(encode(report));
 assert.deepEqual(result,report); assert.equal(Object.getPrototypeOf(result),Object.prototype);
 assert.equal(Object.hasOwn(result,'__proto__'),true); assert.equal({}.polluted,undefined);
 assert.deepEqual(decode(JSON.stringify(report)),report);
});
test('malformed tags, indices, versions, shapes, arities and numbers fail closed', () => {
 for (const text of ['', '{', 'null', '{}', envelope([4]), envelope([3,0]), envelope([0,-1]), envelope([0,0]), envelope([1,0]), envelope([2,{}]), envelope([2,0]).replace('[2,0]','[2,1e400]'), envelope([0,0,0]), envelope([2]).replace('"version":1','"version":2')]) assert.throws(()=>decode(text));
 for (const mutate of [w=>w.shapes=[[0,0]],w=>w.shapes=[[1]],w=>w.data=[1,0],w=>w.strings=[42],w=>w.extra=true,w=>w.shapes=[[-1]]]) {
  const wire={schema:COMPACT_SCHEMA,version:1,strings:['a'],shapes:[[0]],data:[1,0,null]};mutate(wire);assert.throws(()=>decode(JSON.stringify(wire)));
 }
 assert.throws(()=>decode('{"schema":"polytrack-developer-diagnostics-v1","n":1e400}'));
});
test('input, decoded output, node, depth, dictionary and shape limits are enforced', () => {
 const text=encode({a:['x','x']});
 for (const cap of [{inputBytes:1},{outputBytes:2},{nodes:2},{depth:1},{dictionary:1},{shapes:1}]) {
  if (Object.hasOwn(cap,'shapes')) assert.throws(()=>encode({a:{b:1}},cap));
  else assert.throws(()=>decode(text,cap));
 }
 assert.throws(()=>encode({a:'x',b:'y'},{dictionary:1}));
 assert.throws(()=>encode({a:[1,2]},{nodes:2}));
 assert.throws(()=>encode({a:{b:1}},{depth:1}));
 for (const cap of [{depth:0},{nodes:Infinity},{unknown:1},{depth:65}]) assert.throws(()=>decode(text,cap));
 const bomb={schema:COMPACT_SCHEMA,version:1,strings:['x'.repeat(1000)],shapes:[],data:[2,...Array.from({length:100},()=>[0,0])]};
 assert.throws(()=>decode(JSON.stringify(bomb),{outputBytes:10000}),/output limit/);
 assert.throws(()=>decode(JSON.stringify({schema:'polytrack-developer-diagnostics-v1',a:'x'.repeat(100)}),{outputBytes:80}));
 let deep=null;for(let i=0;i<66;i++)deep=[2,deep];assert.throws(()=>decode(envelope(deep)),/depth/);
});
test('unsupported input fails rather than silently losing values', () => {
 const cycle={};cycle.self=cycle;
 for (const value of [undefined,NaN,Infinity,1n,()=>{},new Date(),cycle,[,],{a:undefined},{get a(){throw Error('accessor must not run');}}]) assert.throws(()=>encode(value));
 assert.throws(()=>serializeDiagnosticReport({},{format:'zip'}));
});
test('deterministic synthetic generated structures roundtrip', () => {
 let seed=42; const rand=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
 function value(depth=0) {
  if(depth>4)return null;
  switch(Math.floor(rand()*6)) {
   case 0:return null;case 1:return rand();case 2:return 'synthetic-'+Math.floor(rand()*5);case 3:return rand()>.5;
   case 4:return Array.from({length:Math.floor(rand()*5)},()=>value(depth+1));
   default:return Object.fromEntries(Array.from({length:Math.floor(rand()*5)},(_,i)=>['key'+i,value(depth+1)]));
  }
 }
 for(let i=0;i<200;i++){const input=value();assert.deepEqual(decode(encode(input)),input);}
});
test('CLI decodes compact and legacy locally, rejects malformed input and never overwrites', async () => {
 const directory=await mkdtemp(join(tmpdir(),'polytrack-codec-'));
 const cli=fileURLToPath(new URL('./decode-developer-report.mjs',import.meta.url));
 const run=(...args)=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8'});
 try {
  const report={schema:'polytrack-developer-diagnostics-v1',unknown:null,at:1790000000000};
  const input=join(directory,'input.json'),output=join(directory,'output.json');
  await writeFile(input,encode(report)); assert.equal(run(input,output).status,0);
  assert.deepEqual(JSON.parse(await readFile(output,'utf8')),report);
  assert.equal(run(input,output).status,1); assert.deepEqual(JSON.parse(await readFile(output,'utf8')),report);
  await writeFile(input,JSON.stringify(report));const result=run(input);assert.equal(result.status,0);assert.deepEqual(JSON.parse(result.stdout),report);
  await writeFile(input,'bad');const failed=run(input);assert.equal(failed.status,1);assert.equal(failed.stdout,'');assert.doesNotMatch(failed.stderr,/bad/);
  await writeFile(input,Buffer.from([0xff]));assert.equal(run(input).status,1);
  await truncate(input,CODEC_LIMITS.inputBytes+1);const oversized=run(input);assert.equal(oversized.status,1);assert.equal(oversized.stdout,'');
  assert.equal(run('--help').status,0);
 } finally {await rm(directory,{recursive:true,force:true});}
});
