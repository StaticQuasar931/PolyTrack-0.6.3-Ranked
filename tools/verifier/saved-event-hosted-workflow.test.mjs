import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

// Run from the repository root. The override reviews an external proposal without applying it.
const root=process.cwd();
const workflow=await fs.readFile(process.env.PROPOSED_SAVED_WORKFLOW||path.join(root,'.github/workflows/verify-saved-events.yml'),'utf8');
const {savedEventWorkflowConfig}=await import(pathToFileURL(path.join(root,'tools/verifier/verify-saved-events.mjs')));
const environment=()=>({EXPECTED_SOURCE_COMMIT:'a'.repeat(40),SNAPSHOT_SOURCE_COMMIT:'b'.repeat(40),
 SNAPSHOT_GENERATION:'86',SNAPSHOT_INDEX_SHA256:'c'.repeat(64),LEDGER_MANIFEST_SHA256:'d'.repeat(64),
 LEDGER_ENTRIES:'19476',NATIVE_JOB_LIMIT:'256',GITHUB_RUN_ATTEMPT:'1',
 TARGET_TRACK_IDS:JSON.stringify(['e'.repeat(64),'f'.repeat(64)]),NATIVE_TARGET_SCOPE:'all'});

test('dispatch maps exact target JSON and scope into both existing source-admission and native steps',()=>{
 for(const name of ['target_track_ids','target_scope','warmup_first'])assert.match(workflow,new RegExp('^      '+name+':','m'));
 for(const line of ['TARGET_TRACK_IDS: ${{ inputs.target_track_ids }}','NATIVE_TARGET_SCOPE: ${{ inputs.target_scope }}',
  'WARMUP_FIRST_INPUT: ${{ inputs.warmup_first }}'])assert.equal(workflow.split(line).length-1,2);
 assert.match(workflow,/options: \['events', 'all', 'normal'\]/);
 assert.match(workflow,/target_track_ids:[\s\S]*?required: true[\s\S]*?type: string/);
});

test('boolean warmup uses one or an absent variable, never an invalid empty/false executor value',()=>{
 const block=`case "$WARMUP_FIRST_INPUT" in\n            true) export WARMUP_FIRST_PROOF=1 ;;\n            false) unset WARMUP_FIRST_PROOF ;;`;
 assert.equal(workflow.split(block).length-1,2);
 assert.doesNotMatch(workflow,/WARMUP_FIRST_PROOF:\s*\$\{\{/);
 const enabled=savedEventWorkflowConfig({...environment(),WARMUP_FIRST_PROOF:'1'});
 assert.equal(enabled.warmupFirst,true);assert.equal(savedEventWorkflowConfig(environment()).warmupFirst,false);
 for(const value of ['false','', 'true'])assert.throws(()=>savedEventWorkflowConfig({...environment(),WARMUP_FIRST_PROOF:value}));
});

test('hosted runtime choices preserve the legacy default and stay inside the existing twenty-five-minute core cap',()=>{
 assert.match(workflow,/^    timeout-minutes: 60$/m);assert.match(workflow,/^        timeout-minutes: 50$/m);
 assert.match(workflow,/options: \['256', '512', '1024'\]/);assert.match(workflow,/default: '256'/);
 assert.match(workflow,/options: \['8', '25'\]/);assert.match(workflow,/default: '8'/);
 assert.equal(workflow.split('NATIVE_RUNTIME_MINUTES: ${{ inputs.native_runtime_minutes }}').length-1,2);
 assert(workflow.includes('![256,512,1024].includes(config.plan.maxJobs)||![480000,1500000].includes(config.plan.maxRuntimeMs)'));
 const {plan}=savedEventWorkflowConfig(environment());assert.equal(plan.maxJobs,256);assert.equal(plan.maxRuntimeMs,480000);
 const long=savedEventWorkflowConfig({...environment(),NATIVE_JOB_LIMIT:'1024',NATIVE_RUNTIME_MINUTES:'25'}).plan;
 assert.equal(long.maxJobs,1024);assert.equal(long.maxRuntimeMs,1500000);
});

test('existing commit/source pins, first-attempt guard and malformed-target rejection remain mandatory',()=>{
 for(const scope of ['events','all','normal'])assert.equal(savedEventWorkflowConfig({...environment(),NATIVE_TARGET_SCOPE:scope}).plan.targetScope,scope);
 for(const change of [{GITHUB_RUN_ATTEMPT:'2'},{EXPECTED_SOURCE_COMMIT:'main'},{SNAPSHOT_SOURCE_COMMIT:'main'},
  {SNAPSHOT_INDEX_SHA256:'bad'},{LEDGER_MANIFEST_SHA256:'bad'},{TARGET_TRACK_IDS:'[]'},
  {TARGET_TRACK_IDS:JSON.stringify(['e'.repeat(64),'e'.repeat(64)])},{NATIVE_TARGET_SCOPE:'unknown'}])
  assert.throws(()=>savedEventWorkflowConfig({...environment(),...change}));
 assert(workflow.includes("execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()!==config.testedCommit"));
 assert(workflow.indexOf('Validate first-attempt')<workflow.indexOf('Install pinned native dependencies'));
 assert.doesNotMatch(workflow,/default: '(?:84|19391)'/);
});

test('workflow remains read-only and artifact-only, retaining first-proof and completed candidate evidence',()=>{
 assert.match(workflow,/contents: read/);assert.match(workflow,/persist-credentials: false/);assert.match(workflow,/cancel-in-progress: false/);
 assert.doesNotMatch(workflow,/FIREBASE_|secrets\.|git push|workflow_call:|schedule:|download-artifact|publish-verified-snapshots|update-public-snapshot/);
 for(const item of ['ubuntu-24.04','first-proof-pass-*.json','event-candidate-complete.json','local-reports/native-proof-checkpoints/',
  'tools/native-verification-ledger.test.mjs','tools/native-event-snapshot.test.mjs','tools/native-snapshot-phase.test.mjs',
  'tools/verifier/saved-event-hosted-workflow.test.mjs','tools/published-target-retention.test.mjs'])assert(workflow.includes(item));
 assert.equal(workflow.split('run: node tools/verifier/verify-saved-events.mjs').length-1,0);
 assert.equal(workflow.split('          node tools/verifier/verify-saved-events.mjs').length-1,1);
});
