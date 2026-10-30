import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createOutcomeReport} from './outcome-report.mjs';
test('bounded report retains exact completed per-track totals without replay bytes or credentials',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'outcomes-')),file=path.join(dir,'private.jsonl');
  try{
    const r=createOutcomeReport({file,root:process.cwd(),maxRecords:3});
    const j={trackId:'a'.repeat(64),accountId:'b'.repeat(64),timeMs:2,replay:'SECRET-REPLAY',credentials:'SECRET-CREDENTIAL'};
    for(const [status,reason,completed] of [['verified','native_exact_finish',true],['unavailable','identical_replay_pending_manual_review',true],['waiting','missing_trusted_track',true],['superseded','binding_changed',false]])r.record(j,{status,reason,replay:j.replay},{completed});
    r.finish({countsComplete:true});r.finish();
    const text=fs.readFileSync(file,'utf8'),rows=text.trim().split('\n').map(JSON.parse),summary=rows.at(-1);
    assert.equal(rows.length,3);assert.equal(summary.dropped,2);assert.equal(summary.completed,3);assert.equal(summary.tracks[0].observed,4);
    assert.deepEqual(summary.tracks[0].outcomes,{verified:1,held:1,unavailable:1,superseded:1});assert.doesNotMatch(text,/SECRET/);
    assert.throws(()=>createOutcomeReport({file,root:process.cwd()}),/EEXIST/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('reports fail closed on unsafe paths or record limits',()=>{
  assert.throws(()=>createOutcomeReport({file:'relative',root:process.cwd()}),/absolute/);
  assert.throws(()=>createOutcomeReport({file:path.join(process.cwd(),'private-report.jsonl'),root:process.cwd()}),/outside/);
  assert.throws(()=>createOutcomeReport({maxRecords:20001}),/limit/);
});
