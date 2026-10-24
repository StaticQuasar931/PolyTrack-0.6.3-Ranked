import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runVerifier} from './verifier/run.mjs';
import {runEventVerification} from './verifier/events.mjs';

const count = value => Number.isSafeInteger(value) && value > 0 ? value : 0;
const COMPLETE_STOPS = new Set(['round_limit', 'time_reserve', 'request_reserve', 'no_progress', 'budget_deferred']);

export function needsSnapshot(summary, eventPublications = 0) {
  return summary?.countsComplete === true && summary.interruptedRound === false &&
    COMPLETE_STOPS.has(summary.stop) && summary.deferred !== true &&
    count(summary.verified) + count(summary.mismatch) + count(eventPublications) > 0;
}

// Observe existing committed-result APIs; no additional database calls or core edits.
export async function verifyAndSignal({env = process.env, verify = runVerifier,
  eventRun = runEventVerification, catchUp = false} = {}) {
  const output = async needed => {
    if (env.GITHUB_OUTPUT) await fs.appendFile(env.GITHUB_OUTPUT, 'snapshot_needed=' + needed + '\n');
  };
  await output(false);
  let eventPublications = 0;
  const summary = await verify({env, drain: true, catchUp, eventRun: async (...args) => {
    const result = await eventRun(...args);
    eventPublications += (result.results || []).filter(row => ['verified', 'mismatch'].includes(row?.status)).length;
    if (typeof result.archived === 'string' && result.archived) eventPublications++;
    return result;
  }});
  const needed = !process.exitCode && needsSnapshot(summary, eventPublications);
  await output(needed);
  if (env.GITHUB_STEP_SUMMARY) await fs.appendFile(env.GITHUB_STEP_SUMMARY,
    '\n## Post-verification publication\nPublic snapshot capture requested: ' + needed +
    '. Gate uses completed verdicts/archives, not due-work, native attempts, or process success alone. ' +
    'The separate bounded snapshot job runs automatically with an enabled verifier unless POLYTRACK_POST_VERIFY_SNAPSHOTS_ENABLED=false. ' +
    'Capture reads currently published public data: it does not force rebuilds or wait for a published revision. ' +
    'Cached track boards and the Overall aggregate may lag these verdicts; a new package is not proof of aggregate freshness.\n');
  return {snapshotNeeded: needed, summary};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args.includes('--drain') || args.some(arg => !['--drain', '--catch-up'].includes(arg)))
    throw Error('Expected --drain and optional --catch-up');
  await verifyAndSignal({catchUp: args.includes('--catch-up')});
}
