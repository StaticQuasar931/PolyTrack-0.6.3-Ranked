import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const native=fs.readFileSync(new URL('../main.bundle.js',import.meta.url),'utf8');
test('native event policy is checked before disposal and replaces normal opponents/PB, disabling Next Track',()=>{
 const start=native.indexOf('J=(t,i,a,c,h,u)=>');assert(start>=0);
 const policy=native.indexOf('eventRace=window.__pt062PrepareEventRace?.(i.getId(),h)',start);
 const dispose=native.indexOf('$.dispose()',start),inputs=native.indexOf('if(eventRace){const ownGhost=eventRace.ownGhost||null;',start);
 assert(policy>start&&policy<dispose&&dispose<inputs);
 assert.equal(native.split('window.__pt062NativeEventLaunchVersion=1;').length,2);
 assert.equal(native.split('window.__pt062NativeEventGhostVersion=1;').length,2);
});
test('native event input uses only its own ghost; normal launch retains its inputs',()=>{
 const code=native.match(/if\(eventRace\)\{const ownGhost=eventRace\.ownGhost\|\|null;.*?f=null\}/)?.[0];assert(code);
 const inputs=new Function('eventRace','c','M','f',code+';return {c,v:M,u:f}'),normal={recording:'normal',time:9000},next=()=>{},own={recording:'event',time:20000};
 assert.deepEqual(inputs(false,[normal],normal,next),{c:[normal],v:normal,u:next});assert.deepEqual(inputs(true,[normal],normal,next),{c:[],v:null,u:null});
 const result=inputs({ownGhost:own},[normal],normal,next);assert.deepEqual(result.c,[own]);assert.equal(result.v.recording,'event');assert.equal(result.v.time,20000);assert.equal(result.u,null);
});
test('native event launch skips normal record lookup; ordinary launch still reads it',()=>{
 const expression=native.match(/A=(eventRace\?null:E\.getRecord\(g,i\.getId\(\)\));/)?.[1];assert(expression);
 const read=new Function('eventRace','E','g','i','return '+expression);
 let reads=0;const saved={time:9000},records={getRecord(slot,track){reads++;assert.equal(slot,0);assert.equal(track,'track');return saved;}},track={getId:()=> 'track'};
 assert.equal(read(true,records,0,track),null);assert.equal(reads,0);
 assert.equal(read(false,records,0,track),saved);assert.equal(reads,1);
});

test('selected opponent never replaces native personal-best comparison',()=>{
 const code=native.match(/if\(eventRace\)\{const ownGhost=eventRace\.ownGhost\|\|null;.*?f=null\}/)?.[0];assert(code);
 const run=new Function('eventRace','let c,M,f;'+code+';return {c,M}');
 const own={time:20000,recording:'own'},opponent={time:18000,recording:'other'};
 const result=run({ownGhost:own,opponents:[opponent]});assert.deepEqual(result.c,[own,opponent]);assert.equal(result.M.recording,'own');
 const withoutOwn=run({opponents:[opponent]});assert.deepEqual(withoutOwn.c,[opponent]);assert.equal(withoutOwn.M,null);
});
test('event Watch is attached to live track UI and replay return restores event policy',()=>{
 assert(native.includes('__pt062EventWatch={version:1,trackId:u,open:ghosts=>'));
 assert(native.includes('window.__pt062ResumeEventRace?.(t.getId(),()=>J(e,t,n,i,null,!1))'));
});
