import test from 'node:test';
import assert from 'node:assert/strict';
import {runVerifier,checkForWork} from './run.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {drainVerification,SCHEDULED_DRAIN_LIMITS,DRAIN_LIMITS} from './throughput.mjs';
const quiet=()=>{};
test('opt-in scheduled profile raises attempt ceiling without changing default or document caps',async()=>{
  let calls=0;
  const s=await drainVerification({limits:SCHEDULED_DRAIN_LIMITS,now:()=>0,requests:()=>calls*60,log:quiet,
    runRound:async()=>{calls++;return {processed:16,verified:16,events:{checked:0,consumed:0}};}});
  assert.equal(s.processed,192);assert.equal(s.rounds,12);assert.equal(DRAIN_LIMITS.rounds,4);
  assert.equal(SCHEDULED_DRAIN_LIMITS.admissionMs,360000);assert.equal(SCHEDULED_DRAIN_LIMITS.requests,1200);
});
test('scheduled mode rejects incompatible invocations and unbounded or higher caps before auth',async()=>{
  for(const overrides of [{},{drain:true},{drain:true,check:true},{drain:true,catchUp:true}]){
    await assert.rejects(runVerifier({scheduledDrain:true,env:{},...overrides}),/requires/);
  }
  for(const caps of [{},{VERIFIER_DOCUMENT_READ_LIMIT:'1501',VERIFIER_DOCUMENT_WRITE_LIMIT:'1000'},
    {VERIFIER_DOCUMENT_READ_LIMIT:'1500',VERIFIER_DOCUMENT_WRITE_LIMIT:'1001'}]){
    await assert.rejects(runVerifier({scheduledDrain:true,drain:true,env:{GITHUB_EVENT_NAME:'schedule',...caps}}),/document caps/);
  }
});
test('scheduled drain stops with time reserve and preserves manual catch-up gate',async()=>{
  let now=0;
  const s=await drainVerification({limits:SCHEDULED_DRAIN_LIMITS,now:()=>now,requests:()=>0,log:quiet,
    runRound:async()=>{now+=250000;return {processed:16,events:{checked:0,consumed:0}};}});
  assert.equal(s.rounds,1);assert.equal(s.stop,'time_reserve');
  await assert.rejects(runVerifier({catchUp:true,drain:true,env:{GITHUB_EVENT_NAME:'schedule'}}),/manually dispatched/);
});

test('empty preflight refers to the next scheduled window, never a fifteen-minute cadence',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'preflight-window-')),file=path.join(dir,'summary');
  try{
    await checkForWork({call:async()=>[]},{env:{GITHUB_EVENT_NAME:'schedule',GITHUB_STEP_SUMMARY:file},eventCheck:async()=>({hasWork:false}),log:quiet});
    const text=fs.readFileSync(file,'utf8');assert.match(text,/next scheduled verification window; GitHub may delay it/i);assert.doesNotMatch(text,/15 minutes|fifteen/i);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('scheduled environment flag is strict, schedule-only and disabled for preflight',async()=>{
  await assert.rejects(runVerifier({env:{VERIFIER_SCHEDULED_DRAIN:'yes'}}),/Invalid scheduled/);
  await assert.rejects(runVerifier({drain:true,env:{VERIFIER_SCHEDULED_DRAIN:'true',GITHUB_EVENT_NAME:'workflow_dispatch'}}),/Scheduled drain requires/);
  await assert.rejects(runVerifier({check:true,env:{VERIFIER_SCHEDULED_DRAIN:'true',GITHUB_EVENT_NAME:'schedule'}}),/Scheduled drain requires/);
});
