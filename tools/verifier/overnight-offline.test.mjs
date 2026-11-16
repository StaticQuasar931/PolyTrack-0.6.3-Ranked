import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {config,selectSample,normalize,compareReports,AUDIT_REVIEW_LIMITS,auditSummary,ledgerEligible} from './overnight-offline.mjs';
const env={EXPECTED_SOURCE_COMMIT:'a'.repeat(40),SNAPSHOT_SOURCE_COMMIT:'b'.repeat(40),SNAPSHOT_INDEX_SHA256:'c'.repeat(64),SNAPSHOT_GENERATION:'91'};
test('exact pins, first attempt and unchanged native limits required',()=>{
  assert.equal(config(env).workers,'1');
  for(const extra of [{EXPECTED_SOURCE_COMMIT:'main'},{SNAPSHOT_GENERATION:'90'},{VERIFIER_NATIVE_WORKERS:'3'},{VERIFIER_CPU_MS:'45000'},{VERIFIER_WALL_MS:'90000'},{GITHUB_RUN_ATTEMPT:'2'}])assert.throws(()=>config({...env,...extra}));
});
test('same seed gives same mixed sample independent of inventory enumeration',()=>{
  const jobs=Array.from({length:500},(_,i)=>({resultId:String(i),replayHash:String(i),trackId:String(i%20),lane:i<100?'event':'normal'}));
  const a=selectSample(jobs,'seed');assert.equal(a.length,256);assert.equal(new Set(a.map(j=>j.resultId)).size,256);
  assert.deepEqual(a,selectSample([...jobs].reverse(),'seed'));assert.notDeepEqual(a,selectSample(jobs,'other'));
  assert(a.filter(j=>j.lane==='event').length>=64);assert.throws(()=>selectSample(jobs.slice(0,20),'seed'));
});
test('comparison rejects any binding, sample, unavailable or incomplete difference',()=>{
  const outcomes=Array.from({length:256},(_,i)=>({resultId:String(i),status:'verified',binding:{replayHash:String(i)}}));
  const a={complete:true,sampleSha256:'s',pins:{x:1},fingerprint:'f',repeats:[{elapsedMs:100,outcomes},{elapsedMs:120,outcomes}]};
  assert.equal(compareReports(a,structuredClone(a)).oneMedianMs,110);
  for(const mutate of [b=>b.sampleSha256='bad',b=>b.complete=false,b=>b.repeats[1].outcomes[0].binding.replayHash='bad',b=>b.repeats[0].outcomes[0].status='unavailable']){const b=structuredClone(a);mutate(b);assert.throws(()=>compareReports(a,b));}
  assert.equal(normalize([{status:'verified',wallMs:3,sampledCpuMs:4}])[0].status,'verified');
  assert(!('wallMs' in normalize([{status:'verified',wallMs:3}])[0]));
});
test('manual workflow has two native modes, audit, no secrets/publication, bounded jobs and always reports',()=>{
  const text=fs.readFileSync(new URL('../../.github/workflows/overnight-offline.yml',import.meta.url),'utf8');
  for(const value of ['workflow_dispatch:','max-parallel: 3','timeout-minutes: 120','retention-days: 14','if: always()','mode: audit','workers: \'2\'','contents: read'])assert(text.includes(value));
  assert(!/secrets\.|contents: write|firebase|git push|workflow_run:/i.test(text));
});
test('existing reviewer inspect and artifact work on a real bound controls fixture',async()=>{
  const {deflateSync}=await import('node:zlib');const {pathToFileURL}=await import('node:url');const {default: path}=await import('node:path');
  const root=process.env.OVERNIGHT_TEST_SOURCE_ROOT;
  const module=root?pathToFileURL(path.join(root,'tools/verifier/local-snapshot-capture.mjs')):new URL('./local-snapshot-capture.mjs',import.meta.url);
  const {defaultCapturedReviewFactory}=await import(module);
  const controlsModule=root?pathToFileURL(path.join(root,'tools/verifier/captured-controls.mjs')):new URL('./captured-controls.mjs',import.meta.url);
  const {createCapturedControlReview,CAPTURED_CONTROL_LIMITS}=await import(controlsModule);
  const {sha}=await import('./overnight-offline.mjs');const replay=deflateSync(Buffer.alloc(15)).toString('base64url');
  const jobs=[1,2].map(i=>({lane:'normal',kind:'normal',source:`recordings/${i}.json`,accountId:sha(String(i)),trackId:'a'.repeat(64),timeMs:900,frames:900,uploadId:i,replay,replayHash:sha(replay),resultId:sha(String(i))+'_'+'a'.repeat(64)}));
  const reviewer=await defaultCapturedReviewFactory({jobs,sourceBinding:{sourceCommit:'b'.repeat(40),captureSha256:'c'.repeat(64)},policy:{reviewPolicyVersions:['snapshot-controls-v1']}});
  const coverage=await reviewer.inspect(),artifact=await reviewer.artifact();assert.equal(coverage.records,2);assert.equal(artifact.rows.length,2);assert.equal(artifact.coverage.inventoryHash,coverage.inventoryHash);
  assert.equal(AUDIT_REVIEW_LIMITS.maxRuntimeMs,CAPTURED_CONTROL_LIMITS.maxRuntimeMs);
  assert.equal(AUDIT_REVIEW_LIMITS.maxPairs,CAPTURED_CONTROL_LIMITS.maxPairs);
  const diagnostic=createCapturedControlReview({allJobs:jobs,sourceBinding:{sourceCommit:'b'.repeat(40),captureSha256:'c'.repeat(64)},policy:{reviewPolicyVersions:['snapshot-controls-v1']},limits:AUDIT_REVIEW_LIMITS});
  assert.equal((await diagnostic.inspect()).records,2);assert.equal((await diagnostic.artifact()).rows.length,2);
});
test('audit summary exposes stopped and incomplete coverage without accusations',()=>{
  const summary=auditSummary({complete:false,scanComplete:true,evidenceCoverageComplete:false,reviewCoverage:{stop:'captured_controls_runtime_limit',findings:4},coverage:{missingBindings:12},payloadAudit:{unreferenced:9}});
  for(const text of ['INCOMPLETE / NOT AN ALL-CLEAR','captured_controls_runtime_limit','Missing bindings: 12','legitimate history','not proof of cheating'])assert(summary.includes(text));
});
test('event admission supplies each exact period to the existing ledger overlay',()=>{
  const jobs=[{lane:'event',periodId:'weekly',resultId:'a'},{lane:'normal',resultId:'b'},{lane:'event',periodId:'archived',resultId:'c'}],seen=[];
  const eligible=ledgerEligible(jobs,{}, {},({board,lane})=>{seen.push([lane,board.periodId]);for(const row of board.entries)if(lane==='event')assert.equal(board.periodId,row.periodId);return {board:{entries:board.entries.map(row=>({...row,integrityVerified:true,nativeLedgerKey:row.resultId}))}};});
  assert.equal(eligible.size,3);assert.deepEqual(seen,[['event','weekly'],['normal',undefined],['event','archived']]);
});


test('saved package checkout fetches missing blobs together rather than per-file archive requests',()=>{
 const text=fs.readFileSync(new URL('../../.github/workflows/overnight-offline.yml',import.meta.url),'utf8');
 assert(text.includes('git sparse-checkout set --no-cone --stdin'));
 assert(text.includes('git restore --source="$SNAPSHOT_SOURCE_COMMIT" --worktree -- snapshot-current.json verification-ledger-current.json verification-ledger'));
 assert(!text.includes('git archive'));
});
