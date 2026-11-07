import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {capturedReadAhead} from './captured-read-ahead.mjs';

test('bounded reads consume in source order despite reversed completion',async()=>{
  let active=0,peak=0;const output=[];
  for await(const item of capturedReadAhead([0,1,2,3,4,5],async value=>{
    peak=Math.max(peak,++active);await delay(6-value);active--;return value;
  },3))output.push(item);
  assert.deepEqual(output,[0,1,2,3,4,5]);assert.equal(peak,3);assert.equal(active,0);
});

test('reader failure and early consumer exit drain pending work',async()=>{
  for(const fail of [true,false]){
    let active=0,started=0;
    const consume=async()=>{
      for await(const value of capturedReadAhead([0,1,2,3,4,5],async item=>{
        started++;active++;try{await delay(item===0?1:15);if(fail&&item===0)throw Error('failed read');return item;}
        finally{active--;}
      },3)){assert.equal(value,0);break;}
    };
    if(fail)await assert.rejects(consume(),/failed read/);else await consume();
    assert.equal(active,0);assert.equal(started,3);
  }
});

test('invalid concurrency fails without starting reads',async()=>{
  for(const concurrency of [0,9,1.5,Infinity,null])await assert.rejects(async()=>{
    for await(const value of capturedReadAhead([1],()=>assert.fail('read started'),concurrency))void value;
  },/bounds/);
});
