import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('./client.mjs',import.meta.url),'utf8');
const fn=source.slice(source.indexOf('  async function snapshot('),source.indexOf('  function message('));
function fixture(readSnapshot){const cache=new Map(),saved=new Map();const context={cache,read:(k,v)=>saved.get(k)??v,cacheWrite:(k,v)=>saved.set(k,v),STORE:'test',now:()=>1000000,bridge:{readSnapshot}};return {cache,saved,run:vm.runInNewContext('('+fn+')',context)};}
const period={id:'p',trackId:'a'.repeat(64)};
const board=at=>({period,entries:[{accountId:'b'.repeat(64),timeMs:20000,rank:1,rp:100}],updatedAt:at});
test('complete event snapshot replaces atomically without merging entries',async()=>{const f=fixture(async()=>board(20));f.cache.set('p',{...board(10),entries:[{old:true}],fetchedAt:1});const out=await f.run(period,true);assert.equal(out.updatedAt,20);assert.equal(out.entries.length,1);assert.equal(out.entries[0].old,undefined);});
test('older delayed event response cannot replace a newer cached board',async()=>{const f=fixture(async()=>board(10));const newer={...board(20),fetchedAt:1};f.cache.set('p',newer);assert.equal(await f.run(period,true),newer);assert.equal(f.cache.get('p'),newer);});
test('offline event read preserves a complete saved board',async()=>{const f=fixture(async()=>{throw Error('offline');});f.saved.set('test-p',{...board(20),fetchedAt:1});const result=await f.run(period,true);assert.equal(result.saved,true);assert.equal(result.updatedAt,20);});
test('another track or malformed partial response cannot replace saved data',async()=>{for(const value of [{period,updatedAt:30},{...board(30),period:{...period,trackId:'c'.repeat(64)}}]){const f=fixture(async()=>value);f.cache.set('p',{...board(20),fetchedAt:1});assert.equal((await f.run(period,true)).updatedAt,20);assert.equal(f.cache.get('p').updatedAt,20);}});
test('wrong-period cache on the same track is rejected on fresh and offline paths',async()=>{
 for(const force of [false,true])for(const wrong of [{...period,id:'weekly-other'},{...period,kind:'weekly'}]){
  const f=fixture(async()=>{throw Error('offline');});f.cache.set('p',{...board(20),period:wrong,fetchedAt:1000000});
  await assert.rejects(f.run(period,force),/offline/);
 }
});

const receiptSource=source.slice(source.indexOf('  function receiptText('),source.indexOf('  function rows('));
const receiptText=vm.runInNewContext('('+receiptSource+')');
test('an older verified receipt cannot approve the newer local event attempt',()=>{assert.match(receiptText({attemptId:'old',timeMs:22000,status:'verified'},{attemptId:'new',timeMs:21000}),/Waiting/);});
test('mismatch and incomplete verification have explicit non-award explanations',()=>{assert.match(receiptText({status:'mismatch'},null),/No points/);assert.match(receiptText({status:'unavailable_final'},null),/No points/);});
test('verification does not claim points were awarded',()=>{assert.equal(receiptText({status:'verified',eventImproved:false},null),'Run verified. Event points unchanged.');assert.equal(receiptText({status:'verified',eventImproved:true},null),'Run verified. Event PB saved.');assert.equal(receiptText({status:'verified'},null),'Run verified.');});
test('rejected owner receipt explains the server capacity reason',()=>{assert.match(receiptText({status:'rejected',reason:'event_entrant_capacity'},null),/event is full/);assert.match(receiptText({status:'rejected',reason:'event_admission_capacity'},null),/submission limit/);assert.match(receiptText({status:'rejected',reason:'unrecognized'},null),/could not be scored/);});
