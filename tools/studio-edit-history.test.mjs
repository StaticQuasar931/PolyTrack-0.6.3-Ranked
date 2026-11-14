import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createStudioEditHistory} from './studio-edit-history.mjs';

test('snapshots detach, deep freeze, deduplicate and track clean state across undo',()=>{
 const initial={theme:'blue',nested:{list:[1,2]}};
 const history=createStudioEditHistory({accountId:'alpha',initial});
 initial.nested.list.push(3);
 assert.deepEqual(history.current('alpha').nested.list,[1,2]);
 assert.ok(Object.isFrozen(history.current('alpha').nested.list));
 assert.equal(history.isDirty('alpha'),false);
 assert.equal(history.record('alpha',{nested:{list:[1,2]},theme:'blue'}),false);
 assert.ok(history.record('alpha',{theme:'gold'}));assert.equal(history.isDirty('alpha'),true);
 history.markClean('alpha');assert.equal(history.isDirty('alpha'),false);
 assert.deepEqual(history.undo('alpha'),{theme:'blue',nested:{list:[1,2]}});
 assert.equal(history.isDirty('alpha'),true);assert.equal(history.undo('alpha'),null);
});

test('bounded ring evicts old snapshots but retains independent clean baseline',()=>{
 const h=createStudioEditHistory({accountId:'a',initial:{n:0},limit:3});
 for(let n=1;n<=6;n++)h.record('a',{n});
 assert.equal(h.size('a'),3);assert.deepEqual(h.undo('a'),{n:5});assert.deepEqual(h.undo('a'),{n:4});
 assert.equal(h.canUndo('a'),false);assert.equal(h.isDirty('a'),true);
 h.markClean('a',{n:4});assert.equal(h.isDirty('a'),false);
 h.record('a',{n:7});assert.equal(h.isDirty('a'),true);
});

test('account switch, stale callers, clear and disposal never expose another draft',()=>{
 const h=createStudioEditHistory({accountId:'a',initial:{n:1}});h.record('a',{n:2});
 for(const id of ['b',null,undefined]){
  assert.equal(h.current(id),null);assert.equal(h.record(id,{n:9}),false);
  assert.equal(h.undo(id),null);assert.equal(h.markClean(id),false);assert.equal(h.isDirty(id),false);
 }
 h.reset('b',{n:8});assert.equal(h.current('a'),null);assert.equal(h.size('b'),1);assert.equal(h.isDirty('b'),false);
 h.clear();assert.equal(h.current('b'),null);assert.equal(h.record('b',{}),false);
 h.reset('c',{});h.dispose();assert.equal(h.reset('a',{}),false);assert.equal(h.current('c'),null);
});

test('invalid snapshots fail atomically without invoking getters or serializing hooks',()=>{
 const h=createStudioEditHistory({accountId:'a',initial:{ok:true}});
 const getter={};Object.defineProperty(getter,'bad',{enumerable:true,get(){throw Error('getter executed');}});
 const cycle={};cycle.self=cycle;
 for(const value of [getter,cycle,new Date(),{bad:NaN},{bad:undefined},{toJSON(){throw Error('hook executed');}}]){
  assert.throws(()=>h.record('a',value),TypeError);assert.deepEqual(h.current('a'),{ok:true});
 }
 assert.throws(()=>h.reset('',{}),TypeError);assert.deepEqual(h.current('a'),{ok:true});
 for(const limit of [1,1001,1.5])assert.throws(()=>createStudioEditHistory({limit}),RangeError);
 const source=fs.readFileSync(new URL('./studio-edit-history.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(source,/\b(fetch|localStorage|sessionStorage|indexedDB|window|document|globalThis)\b/);
});

test('finite scalar snapshots remain exact, and sparse/decorated arrays fail closed',()=>{
 const h=createStudioEditHistory({accountId:'a',initial:0});assert.equal(h.current('a'),0);
 h.record('a',false);assert.equal(h.current('a'),false);assert.equal(h.undo('a'),0);
 const sparse=[];sparse.length=2;const decorated=[1];decorated.extra=2;
 for(const value of [sparse,decorated])assert.throws(()=>h.record('a',value),/Dense/);
 assert.equal(h.current('a'),0);
});
