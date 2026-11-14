import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {INPUT_FORMAT, SOURCE_VERSION, proposeRollingHillsRebalance, runRebalanceCli, jsonBytes} from './rebalance-rolling-hills.mjs';
import {PERMANENT_ROLLING_HILLS as R} from '../workers/ranked/src/permanent-rolling-hills.js';

function fixture() {
  const rows = ['a','b'].map((accountId,i) => ({accountId,trackId:R.trackId,timeMs:10000*(i+1),frames:10000*(i+1),
    runVerified:true,integrityVerified:true,replayHash:'a'.repeat(64)}));
  return {format:INPUT_FORMAT,sourceScoreVersion:SOURCE_VERSION,
    rollingSnapshot:{trackId:R.trackId,algorithmVersion:R.algorithmVersion,schemaVersion:6,revision:7,sourceRevision:7,
      signature:'valid_snapshot_signature',builtAt:100,updatedAt:200,complete:true,totalEntries:2,entries:rows},
    finiteResults:{complete:true,totalEntries:2,sourceReadTime:'2026-11-14T00:00:00Z',entries:[
      {periodId:'d_saved',accountId:'b',rp:80,physicsVerified:true,replayIntegrityVerified:true},
      {periodId:'w_saved',accountId:'finite-only',rp:400,physicsVerified:true,replayIntegrityVerified:true}]},
    totals:{complete:true,totalEntries:3,updatedAt:200,sourceReadTime:'2026-11-14T00:00:00Z',
      dynamicComponents:{permanentRollingHills:{status:'complete',id:R.id,trackId:R.trackId,scoreVersion:SOURCE_VERSION,
        maxRp:1001,sourceRevision:7,updatedAt:200,targetMs:10000,targetPolicy:'live-fastest-physics-verified'}},
      entries:[{accountId:'a',rp:1001,events:0},{accountId:'b',rp:580,events:1},{accountId:'finite-only',rp:400,events:1}]}};
}

test('retroactive totals derive from saved results, preserve finite awards, and do not mutate input', () => {
  const input = fixture(), before = structuredClone(input), proposal = proposeRollingHillsRebalance(input);
  assert.deepEqual(input,before);
  assert.deepEqual(proposal.changes.map(row => [row.accountId,row.before,row.after,row.finiteEventRp]),
    [['a',1001,10101,0],['b',580,1581,80],['finite-only',400,400,400]]);
  assert.equal(proposal.totals.dynamicComponents.permanentRollingHills.scoreVersion,R.scoreVersion);
  assert.deepEqual(proposal,proposeRollingHillsRebalance(input));
  assert.throws(() => proposeRollingHillsRebalance({...input,totals:proposal.totals}),/mixed_rolling_source/);
  input.totals.pagination={hasMore:false,totalEntries:3,generation:'obsolete'};
  input.totals.entries[0].eventHighlights=[{eventRp:1001}];
  input.totals.signature='old-signature';
  const clean=proposeRollingHillsRebalance(input);
  assert.equal(clean.totals.pagination,undefined);assert.equal(clean.totals.signature,undefined);
  assert(clean.totals.entries.every(row=>row.eventHighlights===undefined));
});

test('strict saved-results transform uses pace as well as place', () => {
  const input=fixture(), original=proposeRollingHillsRebalance(input);
  Object.assign(input.rollingSnapshot.entries[1],{timeMs:30000,frames:30000});
  input.totals.entries[1].rp=413;
  const slower=proposeRollingHillsRebalance(input);
  assert.equal(original.rolling.entries[1].rank,slower.rolling.entries[1].rank);
  assert.equal(original.rolling.entries[1].rp,1501);assert.equal(slower.rolling.entries[1].rp,667);
  assert.equal(slower.targetScoreVersion,'rolling-hills-pace-placement-v2');
});

test('unknown, mixed, incomplete, duplicated and inconsistent saved sources fail closed', () => {
  const mutations = [
    f=>f.sourceScoreVersion='future', f=>f.finiteResults.complete=false,
    f=>f.finiteResults.sourceReadTime='2026-11-15T00:00:00Z',
    f=>f.totals.dynamicComponents.permanentRollingHills.sourceRevision++,
    f=>f.totals.entries[0].rp++, f=>f.finiteResults.entries[0].rp++,
    f=>f.totals.entries[0].events++, f=>f.totals.entries[0].finiteEventRp=5,
    f=>f.finiteResults.entries.push(f.finiteResults.entries[0]),
    f=>{f.finiteResults.entries[1]=f.finiteResults.entries[0];},
    f=>f.totals.entries[1].accountId='a',
    f=>f.rollingSnapshot.sourceRevision++, f=>f.rollingSnapshot.entries[0].runVerified=false,
    f=>f.finiteResults.entries[0].physicsVerified=false,
    ...[{pending:true},{needsReview:true},{reviewHold:true},{eventRpEligible:false},{status:'unavailable'}]
      .map(patch=>f=>Object.assign(f.finiteResults.entries[0],patch))];
  for (const mutate of mutations) {const input=fixture();mutate(input);assert.throws(()=>proposeRollingHillsRebalance(input));}
});

test('CLI pins exact input bytes, emits reproducible output hashes, refuses overwrite and creates no output on validation failure', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rolling-rebalance-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const input=path.join(root,'input.json'), out=path.join(root,'proposal'), bytes=jsonBytes(fixture());
  const sha=data=>createHash('sha256').update(data).digest('hex');
  await fs.writeFile(input,bytes);
  await assert.rejects(runRebalanceCli(['--input',input,'--expect-sha256','0'.repeat(64),'--out',out]),/digest_mismatch/);
  await assert.rejects(fs.stat(out),{code:'ENOENT'});
  const args=['--input',input,'--expect-sha256',sha(bytes),'--out',out];
  const receipt=await runRebalanceCli(args);
  assert.equal(receipt.input.sha256,sha(bytes));assert.equal(receipt.databaseWrites,0);
  assert.equal(receipt.changedAccounts,2);assert.equal(receipt.publicationPerformed,false);
  for(const [name,record] of Object.entries(receipt.outputs)){
    const output=await fs.readFile(path.join(out,name));assert.equal(record.sha256,sha(output));assert.equal(record.bytes,output.length);
  }
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(out,'receipt.json'),'utf8')),receipt);
  await assert.rejects(runRebalanceCli(args),{code:'EEXIST'});
  assert.deepEqual(await fs.readFile(input),bytes);
});
