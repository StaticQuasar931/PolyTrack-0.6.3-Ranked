import test from 'node:test';
import assert from 'node:assert/strict';
import {retentionMap16} from './published-target-retention.mjs';

test('retention reads use exactly sixteen slots and return deterministic source order',async()=>{
 let active=0,peak=0;const completed=[];
 const input=Array.from({length:65},(_,i)=>i);
 const result=await retentionMap16(input,async value=>{
  peak=Math.max(peak,++active);await new Promise(resolve=>setTimeout(resolve,(16-value%16)%5));
  completed.push(value);active--;return value*2;
 });
 assert.equal(peak,16);assert.equal(active,0);assert.deepEqual(result,input.map(value=>value*2));
 assert.equal(completed.length,input.length);
});

test('failed retention reads drain in-flight work, stop new admissions and report earliest source failure',async()=>{
 let active=0,admitted=0;const first=Error('source zero'),second=Error('source one');
 await assert.rejects(retentionMap16(Array.from({length:100},(_,i)=>i),async value=>{
  active++;admitted++;
  try{
   if(value===1)throw second;
   await new Promise(resolve=>setTimeout(resolve,10));
   if(value===0)throw first;
   return value;
  }finally{active--;}
 }),error=>error===first);
 assert.equal(active,0);assert.equal(admitted,16);
});

test('empty retention inputs admit no reads and small inputs never exceed their size',async()=>{
 assert.deepEqual(await retentionMap16([],()=>assert.fail('empty read')),[]);
 assert.deepEqual(await retentionMap16([1,2],async value=>value),[1,2]);
 await assert.rejects(retentionMap16(null,()=>{}),/invalid bounded read task/);
});
