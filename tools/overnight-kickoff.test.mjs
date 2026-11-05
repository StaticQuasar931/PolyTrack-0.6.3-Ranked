import test from 'node:test';
import assert from 'node:assert/strict';
import {kickoffOvernightSnapshot} from './overnight-kickoff.mjs';
test('retired hosted kickoff refuses old runbooks before requests or guards',async()=>{
  let requests=0,guards=0;
  for(const receipt of [{ready:true},null,{ready:true,execution:'local'}])await assert.rejects(kickoffOvernightSnapshot({receipt,fetchImpl:()=>requests++,acquireGuard:()=>guards++}),/Hosted overnight kickoff is disabled/);
  assert.equal(requests,0);assert.equal(guards,0);
});
