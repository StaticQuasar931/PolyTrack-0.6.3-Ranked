import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

// Run from the repository root. The override reviews an external proposal without applying it.
const root=process.cwd();
const workflow=await fs.readFile(process.env.PROPOSED_SAVED_WORKFLOW||path.join(root,'.github/workflows/verify-saved-events.yml'),'utf8');
const {savedEventWorkflowConfig,savedEventSnapshotSparsePatterns}=await import(pathToFileURL(path.join(root,'tools/verifier/verify-saved-events.mjs')));
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

test('hosted standard runtime/defaults are unchanged and extended timeouts remain explicitly bounded',()=>{
 assert(workflow.includes("timeout-minutes: ${{ inputs.budget_preset == 'extended-all' && 270 || 60 }}"));
 assert(workflow.includes("timeout-minutes: ${{ inputs.budget_preset == 'extended-all' && 260 || 50 }}"));
 assert.match(workflow,/options: \['256', '512', '1024', '10000'\]/);assert.match(workflow,/default: '256'/);
 assert.match(workflow,/options: \['8', '25', '90', '180'\]/);assert.match(workflow,/default: '8'/);
 assert.equal(workflow.split('NATIVE_RUNTIME_MINUTES: ${{ inputs.native_runtime_minutes }}').length-1,2);
 assert(workflow.includes('![256,512,1024].includes(config.plan.maxJobs)||![480000,1500000].includes(config.plan.maxRuntimeMs)'));
 const {plan}=savedEventWorkflowConfig(environment());assert.equal(plan.maxJobs,256);assert.equal(plan.maxRuntimeMs,480000);
 const long=savedEventWorkflowConfig({...environment(),NATIVE_JOB_LIMIT:'1024',NATIVE_RUNTIME_MINUTES:'25'}).plan;
 assert.equal(long.maxJobs,1024);assert.equal(long.maxRuntimeMs,1500000);
});

test('extended-all is exact 10000/180 with all lanes, fresh warmup and at most512 exact targets',()=>{
 const env={...environment(),SAVED_VERIFICATION_PRESET:'extended-all',NATIVE_JOB_LIMIT:'10000',NATIVE_RUNTIME_MINUTES:'180',WARMUP_FIRST_PROOF:'1',
  TARGET_TRACK_IDS:JSON.stringify(Array.from({length:512},(_,i)=>i.toString(16).padStart(64,'0')))};
 const plan=savedEventWorkflowConfig(env).plan,standard=savedEventWorkflowConfig(environment()).plan;
 assert.equal(plan.maxJobs,10000);assert.equal(plan.maxRuntimeMs,10800000);assert.equal(plan.targetScope,'all');
 assert.equal(plan.targetTrackIds.length,512);assert.equal(plan.mode,'postpublication-offline');
 assert.equal(plan.packagingReserveMs,1200000);assert.equal(plan.finishWindowMs,240*60000);
 assert.deepEqual(plan.standard,standard.standard);assert.deepEqual(plan.extended,standard.extended);
 for(const patch of [{SAVED_VERIFICATION_PRESET:'standard'},{SAVED_VERIFICATION_PRESET:'unknown'},{NATIVE_JOB_LIMIT:'1024'},
  {NATIVE_RUNTIME_MINUTES:'25'},{NATIVE_RUNTIME_MINUTES:'90'},{NATIVE_TARGET_SCOPE:'events'},{NATIVE_TARGET_SCOPE:'normal'},{GITHUB_RUN_ATTEMPT:'2'},
  {WARMUP_FIRST_PROOF:undefined},{TARGET_TRACK_IDS:JSON.stringify(Array.from({length:513},(_,i)=>i.toString(16).padStart(64,'0')))}])
  assert.throws(()=>savedEventWorkflowConfig({...env,...patch}));
 assert.equal(workflow.split('SAVED_VERIFICATION_PRESET: ${{ inputs.budget_preset }}').length-1,2);
});

test('checkout excludes historical packages then adds only the validated requested generation after source admission',()=>{
 assert.match(workflow,/sparse-checkout-cone-mode: false\s+sparse-checkout: \|\s+\/\*\s+!\/public-snapshots\*\//);
 assert.deepEqual(savedEventSnapshotSparsePatterns(91),'/*\n!/public-snapshots*/\n/public-snapshots91/\n');
 for(const value of ['91','../91','91\n/foreign/',0,-1,Infinity,1.5])assert.throws(()=>savedEventSnapshotSparsePatterns(value));
 const config=workflow.indexOf('const config=savedEventWorkflowConfig()'),pin=workflow.indexOf("!==config.testedCommit)throw"),
  existence=workflow.indexOf("['cat-file','-e',`HEAD:public-snapshots${generation}/index.json`]"),
  sparse=workflow.indexOf("['sparse-checkout','set','--no-cone','--stdin']");
 assert(config>=0&&pin>config&&existence>pin&&sparse>existence);
 assert.doesNotMatch(workflow,/ref:\s*\$\{\{\s*inputs\./);
 assert.equal(workflow.split('uses: actions/checkout@').length-1,1);
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
