import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {connect, decode} from './firestore.mjs';
import {QUEUE_CANDIDATE_LIMIT, prioritizeQueueDocuments, selectJobs, publishResults} from './runner.mjs';
import {budgetDatabase, drainVerification, DRAIN_LIMITS} from './throughput.mjs';
import {loadWeeklyTrustedTrack} from './weekly-track.mjs';
import {VERIFICATION_COLLECTION, VERIFIER_ENGINE_DIGEST} from '../../workers/ranked/src/verification.js';
export const NORMAL_JOB_LIMIT = 12;
export const TOTAL_JOB_LIMIT = 16;
const checkEvents = async (db, options) => (await import('./events.mjs')).checkEventWork(db, options);
const runEvents = async (db, directory, options) => (await import('./events.mjs')).runEventVerification(db, directory, options);
const simulate = async (directory, jobs, trustedTracks) => (await import('./verify.cjs')).verifyBatch(directory, jobs, trustedTracks);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
async function validateEnginePin() {
  const {snapshot} = await import('./assets.cjs');
  const manifest=JSON.parse(fs.readFileSync(new URL('./engine-manifest.json',import.meta.url),'utf8'));
  const trusted=snapshot(root);
  if(trusted.engineFingerprint!==VERIFIER_ENGINE_DIGEST||manifest.engineDigest!==VERIFIER_ENGINE_DIGEST||JSON.stringify(trusted.tracks)!==JSON.stringify(manifest.tracks))throw Error('Verifier engine pin mismatch: repin and deploy matching Worker before processing');
}

export async function checkForWork(db, {env = process.env, now = Date.now(), log = console.log, eventCheck = checkEvents} = {}) {
  const rows = await db.call(':runQuery', {structuredQuery: {
    from: [{collectionId: VERIFICATION_COLLECTION}],
    select: {fields: [{fieldPath: 'notBefore'}]},
    where: {fieldFilter: {field: {fieldPath: 'notBefore'}, op: 'LESS_THAN_OR_EQUAL', value: {integerValue: String(now)}}},
    orderBy: [{field: {fieldPath: 'notBefore'}, direction: 'ASCENDING'}],
    limit: 1
  }});
  if (!Array.isArray(rows)) throw Error('Unexpected verification queue response');
  const normalHasWork = rows.some(row => row.document);
  const events = await eventCheck(db, {now});
  if (typeof events?.hasWork !== 'boolean') throw Error('Unexpected event queue response');
  const eventHasWork = events.hasWork;
  const due = normalHasWork || eventHasWork;
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, 'has_work=' + due + '\n');
  const message = due ? 'Verification work is due; the verifier will re-read current queue state.' :
    'No verification work is due. Dependency installation, browser setup, and simulation are skipped.';
  log(message);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY,
    '## Verification preflight\n' + message + '\n\n' +
    'Normal queue: one projected existence query. Events: bounded receipt/cursor and due-period checks. No canonical replay reads or Firestore writes.\n' +
    (due ? 'This is not a backlog count. Processing remains bounded per invocation.\n' :
      'Future-dated retries are not due work. The next scheduled check is nominally in 15 minutes; GitHub may delay it.\n'));
  return {hasWork: due, normalHasWork, eventHasWork, queueQueries: 1, returnedDocuments: normalHasWork ? 1 : 0};
}

export async function runVerifier({check = false, drain = false, borrowUnusedEvents = false, clock = () => performance.now(), env = process.env, connectDatabase = connect,
  validateEngine = validateEnginePin, log = console.log, eventCheck = checkEvents,
  eventRun = runEvents, prioritizeNormal = prioritizeQueueDocuments, selectNormal = selectJobs,
  verifyNormal = simulate, publishNormal = publishResults} = {}) {
  // Preflight never loads or hashes physics assets. Actual processing still pins the engine first.
  if (!check) await validateEngine();
  const raw = env.FIREBASE_VERIFIER_SERVICE_ACCOUNT;
  if (!raw) throw Error('Set the private FIREBASE_VERIFIER_SERVICE_ACCOUNT Actions secret.');
  const db = await connectDatabase(raw);
  delete env.FIREBASE_VERIFIER_SERVICE_ACCOUNT;
  if (check) return checkForWork(db, {env, log, eventCheck});
  const roundOptions={env,log,eventRun,prioritizeNormal,selectNormal,verifyNormal,publishNormal,borrowUnusedEvents};
  if (!drain) return runRound(db,roundOptions);
  const bounded=budgetDatabase(db);
  const summary=await drainVerification({requests:bounded.requests,now:clock,log,
    runRound:()=>runRound(bounded,{...roundOptions,borrowUnusedEvents:true})});
  if(env.GITHUB_STEP_SUMMARY)fs.appendFileSync(env.GITHUB_STEP_SUMMARY,
    '\n## Bounded drain\n'+JSON.stringify(summary)+'\nLimits: '+DRAIN_LIMITS.rounds+
    ' rounds, 64 total native attempts, '+DRAIN_LIMITS.requests+' Firestore HTTP requests. Request count is not billed document usage. '+
    'Time admission is measured, not a completion guarantee; the workflow step timeout remains the hard stop. '+
    'Interrupted-round publication counts are incomplete, not zero. `stop` explains why this invocation ended; a round is not a GitHub workflow run number. '+
    'Unknown or untrusted tracks remain unavailable rather than admitting user-supplied track data.\n');
  return summary;
}

async function runRound(db,{env,log,eventRun,prioritizeNormal,selectNormal,verifyNormal,publishNormal,borrowUnusedEvents}) {
  const now = Date.now();
  // Events must get their reservation before normal canonical reads/commits. Otherwise
  // normal selection can spend the request budget and strand both sources.
  const eventLimit = TOTAL_JOB_LIMIT - NORMAL_JOB_LIMIT;
  const events = await eventRun(db, root, {limit: eventLimit, intakeLimit: TOTAL_JOB_LIMIT, canSpend:db.canSpend});
  if (!Number.isInteger(events.checked) || events.checked<0 || events.checked>eventLimit) throw Error('Invalid event native count');
  let selectedJobs = [], canonicalAttempts = 0, selectionConflicts = 0;
  if (events.checked < TOTAL_JOB_LIMIT) {
    const query = await db.call(':runQuery', {structuredQuery: {from: [{collectionId: VERIFICATION_COLLECTION}], where: {fieldFilter: {field: {fieldPath: 'notBefore'}, op: 'LESS_THAN_OR_EQUAL', value: {integerValue: String(now)}}}, orderBy: [{field: {fieldPath: 'notBefore'}, direction: 'ASCENDING'}, {field: {fieldPath: '__name__'}, direction: 'ASCENDING'}], limit: QUEUE_CANDIDATE_LIMIT}});
    const docs = (query || []).filter(x => x.document).map(x => ({...x.document, data: decode({mapValue: {fields: x.document.fields || {}}})}));
    const prioritized = await prioritizeNormal(db, docs, now);
    const selected = await selectNormal(db, prioritized, now);
    selectedJobs = selected.jobs;
    canonicalAttempts = selected.canonicalAttempts;
    selectionConflicts = selected.selectionConflicts;
  }
  // Normal selection is unleased: unprocessed bindings remain in their queue.
  let jobs = selectedJobs.slice(0, NORMAL_JOB_LIMIT);
  // Events get their reserved work first; only unused slots can be borrowed.
  if(borrowUnusedEvents)jobs=selectedJobs.slice(0,TOTAL_JOB_LIMIT-events.checked);
  // Each normal publication can make five requests on each of three conflict attempts.
  if(db.remainingRequests)jobs=jobs.slice(0,Math.floor(db.remainingRequests()/15));
  const eventSummary = {checked: events.checked, consumed: events.consumed,
    rejected: events.rejected, archived: events.archived, budgetDeferred:events.budgetDeferred===true};
  log(JSON.stringify({events: eventSummary}));
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY,
    '## Event verification\n' + JSON.stringify(eventSummary) + `\nNative work: ${events.checked} event checks (${eventLimit} reserved slots), ${jobs.length} normal; at most ${TOTAL_JOB_LIMIT} total per round (unused event slots may be borrowed). Inbox intake: at most ${TOTAL_JOB_LIMIT}.\n`);
  if (events.results?.some(result => result.reason === 'engine_unavailable')) process.exitCode = 1;
  const infrastructure = result => result?.status==='unavailable' && /^(engine_|isolate_|process_|page_error|cpu_|wall_|deadline|native_engine_error)/.test(String(result.reason||''));
  const eventFailure=(events.results||[]).some(infrastructure);
  if (!jobs.length) {
    const summary={processed:0,canonicalAttempts,selectionConflicts,events:eventSummary,infrastructureFailure:eventFailure};
    log(JSON.stringify({...summary,message:'No runnable normal verification jobs.'}));return summary;
  }
  const trustedTracks = loadWeeklyTrustedTrack(root, jobs);
  const results = await verifyNormal(root, jobs, trustedTracks);
  if (results.length !== jobs.length || new Set(results.map(r => r.resultId)).size !== jobs.length) throw Error('Incomplete verifier result set');
  const totals = await publishNormal(db, jobs, results);
  const reasons = totals.reasons;
  log(JSON.stringify({processed: jobs.length, canonicalAttempts, selectionConflicts, ...totals, reasons, firestoreRequests: db.requests()}));
  if(env.GITHUB_STEP_SUMMARY)fs.appendFileSync(env.GITHUB_STEP_SUMMARY,`## Replay verification\nProcessed: ${jobs.length}. Verified: ${totals.verified}. Corrected legacy times: ${totals.corrected}. Waiting: ${totals.unavailable}. Deferred conflicts: ${totals.deferred}.\n\n${Object.entries(reasons).map(([reason,count])=>'- '+reason+': '+count).join('\n')}\n`);
  if(results.some(r=>r.reason==='engine_unavailable')){console.error('Verifier startup failed. Runs remain waiting; inspect the startup diagnostic.');process.exitCode=1;}
  return {processed:jobs.length,canonicalAttempts,selectionConflicts,...totals,events:eventSummary,
    infrastructureFailure:eventFailure||results.some(infrastructure)};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runVerifier({check: process.argv.includes('--check'), drain: process.argv.includes('--drain')});
}
