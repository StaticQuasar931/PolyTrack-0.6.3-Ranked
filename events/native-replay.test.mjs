import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {deflateSync} from 'node:zlib';
import {prepareOwnEventGhost,EVENT_REPLAY_LIMITS} from './native-replay.mjs';
function runtime(){
 const source=fs.readFileSync(new URL('../main.bundle.js',import.meta.url),'utf8'),end=source.lastIndexOf('},n={};function i(e)');assert(end>0);
 const context=vm.createContext({console,TextEncoder,TextDecoder,Uint8Array,Uint16Array,Int32Array,ArrayBuffer,DataView,atob,btoa,setTimeout,clearTimeout});
 const factories=vm.runInContext('('+source.slice(source.indexOf('t={')+2,end+1)+')',context),cache={};
 function require(id){if(cache[id])return cache[id].exports;const module=cache[id]={exports:{}};factories[id](module,module.exports,require);return module.exports;}
 require.d=(exports,names)=>{for(const key in names)Object.defineProperty(exports,key,{get:names[key]});};require.o=(object,key)=>Object.hasOwn(object,key);require.r=exports=>Object.defineProperty(exports,'__esModule',{value:true});require.n=exports=>{const getter=exports?.__esModule?()=>exports.default:()=>exports;require.d(getter,{a:getter});return getter;};require.g=context;require.p='';return require;
}
function fixture(){const require=runtime(),session={accountId:'a'.repeat(64),trackId:'b'.repeat(64),periodId:'daily-fixture'},best={attemptId:'event-attempt',timeMs:20000};const recording=new (require(1754).A)();recording.recordFrame(0,{up:true,right:false,down:false,left:false,reset:false});recording.recordFrame(1500,{up:true,right:true,down:false,left:false,reset:false});const row={...session,...best,frames:best.timeMs,replay:recording.serialize(),carStyle:require(8724).A.default().serialize(),source:'local-event-recording'};return {require,session,best,row,recording};}
test('own event ghost constructs real native recording, style and time without verification claims',()=>{
 const f=fixture(),ghost=prepareOwnEventGhost(f);assert(ghost.recording instanceof f.require(1754).A);assert(ghost.carStyle instanceof f.require(8724).A);assert.equal(ghost.time.numberOfFrames,20000);assert.equal(ghost.recording.serialize(),f.row.replay);assert.equal(ghost.nickname,'Your event PB (local)');assert.equal(ghost.isSelf,true);assert.equal(ghost.verified,undefined);
});
test('ghost rejects another account, period, track, attempt, PB time or normal source',()=>{
 for(const edit of [{accountId:'c'.repeat(64)},{periodId:'weekly-fixture'},{trackId:'d'.repeat(64)},{attemptId:'old'},{timeMs:19000,frames:19000},{source:'normal-recording'}]){const f=fixture();assert.throws(()=>prepareOwnEventGhost({...f,row:{...f.row,...edit}}));}
});
test('bounded native inflate rejects malformed data and compression bombs',()=>{
 for(const replay of ['AAAA','!',deflateSync(Buffer.alloc(30016)).toString('base64url'),'A'.repeat(65537)]){const f=fixture();assert.throws(()=>prepareOwnEventGhost({...f,row:{...f.row,replay}}));}
});
test('ghost rejects transition after event PB and invalid car style',()=>{
 const f=fixture(),recording=new (f.require(1754).A)();recording.recordFrame(20001,{up:true,right:false,down:false,left:false,reset:false});assert.throws(()=>prepareOwnEventGhost({...f,row:{...f.row,replay:recording.serialize()}}));assert.throws(()=>prepareOwnEventGhost({...f,row:{...f.row,carStyle:'AAAA'}}));
});
test('playback resource limits stay equal to verifier decoder limits',async()=>{
 const {default:verifier}=await import('../tools/verifier/replay.cjs');for(const [name,value] of Object.entries(EVENT_REPLAY_LIMITS))assert.equal(value,verifier.LIMITS[name],name);
});
