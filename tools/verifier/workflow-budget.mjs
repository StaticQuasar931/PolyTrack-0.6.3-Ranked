import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const VERIFICATION_WORKFLOW_LIMITS=Object.freeze({reads:1500,writes:1000});

export function remainingVerificationBudget(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||
    Object.keys(value).sort().join('|')!=='readLimit|usedReads|usedWrites|writeLimit'||
    value.readLimit!==VERIFICATION_WORKFLOW_LIMITS.reads||value.writeLimit!==VERIFICATION_WORKFLOW_LIMITS.writes||
    !Number.isSafeInteger(value.usedReads)||value.usedReads<0||value.usedReads>value.readLimit||
    !Number.isSafeInteger(value.usedWrites)||value.usedWrites<0||value.usedWrites>value.writeLimit)
    throw Error('Missing or invalid preflight document accounting; refusing a fresh verification budget');
  const reads=value.readLimit-value.usedReads,writes=value.writeLimit-value.usedWrites;
  return {hasBudget:reads>0&&writes>0,reads,writes};
}

export function prepareWorkflowBudget(env=process.env,log=console.log){
  let value;
  try{value=JSON.parse(env.PREFLIGHT_DOCUMENT_BUDGET);}catch{throw Error('Missing preflight document accounting; verification is blocked');}
  const budget=remainingVerificationBudget(value);
  if(!env.GITHUB_OUTPUT)throw Error('Workflow output path required');
  fs.appendFileSync(env.GITHUB_OUTPUT,`has_budget=${budget.hasBudget}\nread_limit=${budget.reads}\nwrite_limit=${budget.writes}\n`);
  log(budget.hasBudget?`Verification shares its preflight budget: at most ${budget.reads} further document reads and ${budget.writes} writes.`:
    'Verification budget exhausted by preflight; no further verification reads or writes will be attempted in this run.');
  return budget;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length!==2)throw Error('Workflow budget helper takes no arguments');
  prepareWorkflowBudget();
}
