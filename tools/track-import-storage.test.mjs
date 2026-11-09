import test from 'node:test';
import assert from 'node:assert/strict';
import {reserveTrackSpace,disposableLeaderboardKeys} from './track-import-storage.mjs';
function storage(initial,limit){const rows=new Map(Object.entries(initial));return {rows,getItem:key=>rows.get(key)??null,removeItem:key=>rows.delete(key),setItem(key,value){const next=new Map(rows);next.set(key,String(value));if([...next.values()].reduce((n,row)=>n+row.length,0)>limit)throw Object.assign(Error('full'),{name:'QuotaExceededError'});rows.set(key,String(value));}};}
test('import makes room from disposable boards but preserves user-owned data',()=>{
 const cached=disposableLeaderboardKeys[0],s=storage({[cached]:'x'.repeat(400000),custom_track:'my track',recordings:'my replay',picks:'my picks',pending:'pending'},450000);const evicted=[];
 assert.deepEqual(reserveTrackSpace(s,329000,{onEvict:(key,raw)=>evicted.push([key,raw.length])}),[cached]);
 assert.deepEqual(evicted,[[cached,400000]]);assert.equal(s.getItem('custom_track'),'my track');assert.equal(s.getItem('recordings'),'my replay');assert.equal(s.getItem('picks'),'my picks');assert.equal(s.getItem('pending'),'pending');assert.equal(s.rows.size,4);
});
test('successful reservation removes its probe and retains all caches',()=>{const s=storage({[disposableLeaderboardKeys[0]]:'cache'},100000);assert.deepEqual(reserveTrackSpace(s,10),[]);assert.equal(s.rows.size,1);});
test('insufficient space fails clearly without deleting unknown data',()=>{const s=storage({custom_track:'x'.repeat(200000)},210000);assert.throws(()=>reserveTrackSpace(s,329000),/Browser storage is full/);assert.equal(s.rows.size,1);assert.equal(s.getItem('custom_track').length,200000);});
test('security and disabled-storage errors are not treated as reclaimable quota',()=>{const error=Object.assign(Error('disabled'),{name:'SecurityError'});let removed=0;assert.throws(()=>reserveTrackSpace({setItem(){throw error;},removeItem(){removed++;},getItem(){throw Error('must not read');}},10),e=>e===error);assert.equal(removed,1);});
test('invalid sizes never access storage',()=>{for(const size of [0,-1,524289,Infinity,1.5])assert.throws(()=>reserveTrackSpace(null,size),/Invalid track size/);});

test('cache-preserving imports never delete a cache whose migration could not finish',()=>{
 const key=disposableLeaderboardKeys[0],s=storage({[key]:'x'.repeat(400000),custom_track:'personal-track',recordings:'personal-replay'},450000);
 assert.throws(()=>reserveTrackSpace(s,329000,{preserveCaches:true}),/Browser storage is full/);
 assert.equal(s.getItem(key),'x'.repeat(400000));assert.equal(s.getItem('custom_track'),'personal-track');assert.equal(s.getItem('recordings'),'personal-replay');
 assert.equal(s.rows.size,3);
});