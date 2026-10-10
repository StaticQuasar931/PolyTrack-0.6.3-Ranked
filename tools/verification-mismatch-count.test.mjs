import test from 'node:test';
import assert from 'node:assert/strict';
import {mismatchCount} from './verification-mismatch-count.mjs';
test('uses one aggregate, never downloads canonical replay documents',async()=>{
  let calls=0;
  const result=await mismatchCount({call:async(endpoint,body)=>{
    calls++;assert.equal(endpoint,':runAggregationQuery');
    assert.equal(body.structuredAggregationQuery.structuredQuery.where.fieldFilter.value.stringValue,'mismatch');
    return [{result:{aggregateFields:{mismatches:{integerValue:'0'}}}}];
  }});
  assert.equal(calls,1);assert.equal(result.auditMismatchRecords,0);
});
test('rejects missing or unsafe counts instead of inventing zero',async()=>{
  for(const rows of [[],[{result:{aggregateFields:{mismatches:{integerValue:'-1'}}}}],
    [{result:{aggregateFields:{mismatches:{integerValue:'9007199254740992'}}}}]]) {
    await assert.rejects(mismatchCount({call:async()=>rows}),/Invalid mismatch/);
  }
});
