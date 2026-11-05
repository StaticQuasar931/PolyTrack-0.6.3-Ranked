import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runVerifier} from './run.mjs';
import {createFirestoreCaller} from './firestore.mjs';
import {remainingVerificationBudget,prepareWorkflowBudget} from './workflow-budget.mjs';

const receipt={readLimit:1500,writeLimit:1000,usedReads:4,usedWrites:0};
function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'verification-workflow-budget-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));return path.join(directory,'output');}

test('preflight and verification share the same read and write allowance',()=>{
  const budget=remainingVerificationBudget(receipt);
  assert.deepEqual(budget,{hasBudget:true,reads:1496,writes:1000});
  const writes=remainingVerificationBudget({...receipt,usedWrites:7});
  assert.equal(writes.writes,993);assert.equal(writes.writes+7,1000);assert.equal(budget.reads+receipt.usedReads,1500);
});

test('exhausted allowances do not become unlimited or reset for a second process',()=>{
  for(const change of [{usedReads:1500},{usedWrites:1000}])assert.equal(remainingVerificationBudget({...receipt,...change}).hasBudget,false);
});

test('missing, unknown, inflated and malformed accounting fail closed',()=>{
  for(const value of [null,{},[],{...receipt,readLimit:3000},{...receipt,writeLimit:2000},
    {...receipt,usedReads:null},{...receipt,usedReads:'4'},{...receipt,usedReads:-1},
    {...receipt,usedReads:1501},{...receipt,usedWrites:NaN},{...receipt,usedWrites:1001},
    {...receipt,token:'do not serialize'}, {...receipt,usedWrites:0.5}])assert.throws(()=>remainingVerificationBudget(value),/accounting/);
});

test('workflow helper emits only remaining numeric limits and a boolean admission',t=>{
  const output=fixture(t),logs=[];
  prepareWorkflowBudget({PREFLIGHT_DOCUMENT_BUDGET:JSON.stringify(receipt),GITHUB_OUTPUT:output},s=>logs.push(s));
  assert.equal(fs.readFileSync(output,'utf8'),'has_budget=true\nread_limit=1496\nwrite_limit=1000\n');
  assert.doesNotMatch(logs.join('\n'),/token|accountId|replay/);
  assert.throws(()=>prepareWorkflowBudget({GITHUB_OUTPUT:output}),/accounting/);
});

test('real transport accounting survives the preflight-to-drain process boundary',async t=>{
  const output=fixture(t);let preflightCalls=0;
  const first=createFirestoreCaller({base:'https://firestore.test',access:'fixture-token',documentReadLimit:1500,documentWriteLimit:1000,
    fetchImpl:async()=>Response.json(++preflightCalls===1?[{document:{name:'queue/one',fields:{notBefore:{integerValue:'0'},slots:{mapValue:{fields:{}}}}}}]:[])});
  await runVerifier({check:true,env:{FIREBASE_VERIFIER_SERVICE_ACCOUNT:'fixture',GITHUB_EVENT_NAME:'schedule',
    GITHUB_OUTPUT:output,VERIFIER_DOCUMENT_READ_LIMIT:'1500',VERIFIER_DOCUMENT_WRITE_LIMIT:'1000'},
    connectDatabase:async()=>first,validateEngine:()=>assert.fail('preflight must not load physics'),
    eventCheck:()=>assert.fail('normal work already wakes processing'),log:()=>{}});
  const text=fs.readFileSync(output,'utf8');assert.match(text,/has_work=true\n/);
  const serialized=/^preflight_document_budget=(.+)$/m.exec(text)?.[1];assert.ok(serialized);
  const budget=remainingVerificationBudget(JSON.parse(serialized));assert.equal(budget.reads,1498);
  let drainCalls=0;
  const second=createFirestoreCaller({base:'https://firestore.test',access:'fixture-token',documentReadLimit:budget.reads,documentWriteLimit:budget.writes,
    fetchImpl:async(_url,options)=>{drainCalls++;return Response.json(JSON.parse(options.body).documents.map(missing=>({missing})));}});
  for(const count of [500,500,498])await second.call(':batchGet',{documents:Array.from({length:count},(_,i)=>'projects/fixture/databases/(default)/documents/results/'+i)});
  await assert.rejects(second.call('/results/another'),e=>e.code==='FIRESTORE_DOCUMENT_BUDGET');
  assert.equal(drainCalls,3);assert.equal(first.documentBudget().usedReads+second.documentBudget().usedReads,1500);
});

test('the workflow uses remaining limits and gates expensive setup on budget availability',()=>{
  const source=fs.readFileSync(new URL('../../.github/workflows/verify-runs.yml',import.meta.url),'utf8');
  const step=name=>source.split(/(?=^      - )/m).find(v=>v.startsWith('      - name: '+name+'\n'));
  assert.match(step('Share the verification document budget'),/PREFLIGHT_DOCUMENT_BUDGET: \$\{\{ steps.queue.outputs.preflight_document_budget \}\}/);
  for(const name of ['Install pinned verifier dependencies','Test verifier safeguards','Cache the pinned Playwright browser','Install Chromium and system dependencies','Allow the pinned browser sandbox on Ubuntu','Verify queued runs'])
    assert.match(step(name),/steps.budget.outputs.has_budget == 'true'/);
  const drain=step('Verify queued runs');
  assert.match(drain,/VERIFIER_DOCUMENT_READ_LIMIT: \$\{\{ steps.budget.outputs.read_limit \}\}/);
  assert.match(drain,/VERIFIER_DOCUMENT_WRITE_LIMIT: \$\{\{ steps.budget.outputs.write_limit \}\}/);
  assert.doesNotMatch(drain,/VERIFIER_DOCUMENT_READ_LIMIT: '1500'/);
});
