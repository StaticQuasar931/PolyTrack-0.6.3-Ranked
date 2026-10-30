import test from 'node:test';
import assert from 'node:assert/strict';
import {createCaptureHydrationCache} from './capture-hydration.mjs';
import {VERIFICATION_COLLECTION} from '../../workers/ranked/src/verification.js';
test('capture hydrates each canonical/queue once, isolates mutation and exposes no publication methods',async()=>{
  let reads=0;const db={get:async()=>{reads++;return {data:{value:1}};}};
  const cache=createCaptureHydrationCache(db,{maxDocuments:2});
  const [a,b]=await Promise.all([cache.get('0.6.2_race_results','a_b'),cache.get('0.6.2_race_results','a_b')]);
  a.data.value=2;assert.equal(b.data.value,1);await cache.get(VERIFICATION_COLLECTION,'track');
  assert.equal(reads,2);assert.deepEqual(cache.stats(),{canonicalReads:1,queueReads:1,hits:1,documents:2});
  assert.equal(cache.call,undefined);assert.equal(cache.write,undefined);
  await assert.rejects(cache.get('0.6.2_race_results','next'),/document limit/);
  await assert.rejects(cache.get('credentials','anything'),/Invalid/);
});
