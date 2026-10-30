import fs from 'node:fs';
import {createOutcomeReport} from './outcome-report.mjs';
import {createCachedVerifier} from './proof-cache.mjs';
import {loadPrivateProofCache,writePrivateProofCache} from './proof-cache-file.mjs';
import {sameHashMap} from './engine-pin.cjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {connect, decode} from './firestore.mjs';
import {QUEUE_CANDIDATE_LIMIT, highestPriorityTrack, prioritizeQueueDocuments, selectJobs, publishResults, verifiedTrackCounts} from './runner.mjs';
import {budgetDatabase, drainVerification, DRAIN_LIMITS, CATCH_UP_LIMITS, SCHEDULED_DRAIN_LIMITS, VerificationEventConflictError, firestoreDeferralReason} from './throughput.mjs';
import {loadWeeklyTrustedTrack} from './weekly-track.mjs';
import {createSimilarityReviewer} from './similarity.mjs';
import {VERIFICATION_COLLECTION, EXTRA_VERIFICATION_COLLECTION, VERIFIER_ENGINE_DIGEST} from '../../workers/ranked/src/verification.js';
import {EXTRA_TRACK_IDS} from '../../workers/ranked/src/extra-track-ids.js';
export const NORMAL_JOB_LIMIT = 12;
export const TOTAL_JOB_LIMIT = 16;
export const PREFLIGHT_QUEUE_SAMPLE_LIMIT = 20;
const isDeferredEventConflict = error => error instanceof VerificationEventConflictError &&
  error.cause?.status === 409 && error.cause?.code === 'ABORTED';
const EVENT_CONFLICT_MESSAGE = 'An event transaction conflicted. Earlier writes may have committed; interrupted-round publication counts are incomplete. No write was replayed; the next invocation will reread queue state.';
const DOCUMENT_BUDGET_MESSAGE = 'The Firestore document-budget guard stopped verification. Earlier writes may have committed; interrupted-round publication counts are incomplete. No write was replayed; the next invocation will reread queue state.';
const checkEvents = async (db, options) => (await import('./events.mjs')).checkEventWork(db, options);
const runEvents = async (db, directory, options) => (await import('./events.mjs')).runEventVerification(db, directory, options);
const simulate = async (directory, jobs, trustedTracks, options) => (await import('./verify.cjs')).verifyBatch(directory, jobs, trustedTracks, options);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export async function validateEnginePin() {
  const {snapshot} = await import('./assets.cjs');
  const manifest=JSON.parse(fs.readFileSync(new URL('./engine-manifest.json',import.meta.url),'utf8'));
  const trusted=snapshot(root);
  if(trusted.engineFingerprint!==VERIFIER_ENGINE_DIGEST||manifest.engineDigest!==VERIFIER_ENGINE_DIGEST||!sameHashMap(trusted.tracks,manifest.tracks))throw Error('Verifier engine pin mismatch: repin and deploy matching Worker before processing');
}

export async function checkForWork(db, {env = process.env, now = Date.now(), log = console.log, eventCheck = checkEvents} = {}) {
  const requestsBefore = db.requests?.() ?? null;
  const documentsBefore = db.returnedDocuments?.() ?? null;
  const queryCountBefore = db.queryCount?.() ?? null;
  const emptyQueryMinimumBefore = db.emptyQueryMinimumReads?.() ?? null;
  const estimatedReadsBefore = db.estimatedDocumentReads?.() ?? null;
  // Scheduled wakes need an existence check, not a repeated queue-health scan.
  // Manual runs keep the larger, explicitly bounded diagnostic sample.
  const sampleLimit=env.GITHUB_EVENT_NAME==='schedule'?1:PREFLIGHT_QUEUE_SAMPLE_LIMIT;
  const due = async collection => db.call(':runQuery', {structuredQuery: {
    from: [{collectionId: collection}],
    select: {fields: [{fieldPath: 'notBefore'}, {fieldPath: 'slots'}]},
    where: {fieldFilter: {field: {fieldPath: 'notBefore'}, op: 'LESS_THAN_OR_EQUAL', value: {integerValue: String(now)}}},
    orderBy: [{field: {fieldPath: 'notBefore'}, direction: 'ASCENDING'}],
    limit: sampleLimit
  }});
  const coreRows = await due(VERIFICATION_COLLECTION);
  const extraRows = await due(EXTRA_VERIFICATION_COLLECTION);
  if (!Array.isArray(coreRows) || !Array.isArray(extraRows)) throw Error('Unexpected verification queue response');
  const coreDocs = coreRows.filter(row => row.document);
  const extraDocs = extraRows.filter(row => row.document);
  const coreHasWork = coreDocs.length > 0;
  const extraHasWork = extraDocs.length > 0;
  const normalHasWork = coreHasWork || extraHasWork;
  const queueRows = [...coreDocs, ...extraDocs];
  let queuedRuns = 0, overdueAgeTotalMs = 0;
  for (const row of queueRows) {
    const fields = row.document.fields || {};
    const notBefore = Number(decode(fields.notBefore || {integerValue: '0'}));
    const slots = decode(fields.slots || {mapValue: {fields: {}}});
    const count = Object.values(slots || {}).filter(slot =>
      slot && (slot.status === 'waiting' || slot.status === 'unavailable' && Number(slot.retryAt || 0) < Number.MAX_SAFE_INTEGER)).length;
    queuedRuns += count;
    overdueAgeTotalMs += Math.max(0, now - notBefore) * count;
  }
  const averageOverdueAgeMs = queuedRuns ? Math.round(overdueAgeTotalMs / queuedRuns) : 0;
  const queueSample = {queuedRuns, averageOverdueAgeMs, sampledQueueDocuments: queueRows.length,
    sampleLimitPerLane: sampleLimit, truncated: coreDocs.length === sampleLimit || extraDocs.length === sampleLimit};
  // Normal work already wakes the workflow. Event discovery runs again during
  // processing, where event work is still reserved and checked first.
  const events = normalHasWork ? null : await eventCheck(db, {now});
  if (!normalHasWork && typeof events?.hasWork !== 'boolean') throw Error('Unexpected event queue response');
  const eventHasWork = events?.hasWork ?? false;
  const hasWork = normalHasWork || eventHasWork;
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, 'has_work=' + hasWork + '\n');
  const message = hasWork ? 'Verification work is due; the verifier will re-read current queue state.' :
    'No verification work is due. Dependency installation, browser setup, and simulation are skipped.';
  log(message);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY,
    '## Verification preflight\n' + message + '\n\n' +
    `Queue health (bounded sample, not an exact total): ${queuedRuns} queued runs across Core and Extra; average overdue age ${(averageOverdueAgeMs / 60000).toFixed(1)} minutes (proxy from queue notBefore, weighted by queued runs). Sampled ${queueRows.length} due queue documents, at most ${sampleLimit} per lane; sample ${queueSample.truncated ? 'may be truncated' : 'did not reach its cap'}.\n\n` +
    'Core and Extra queues: two bounded projected queue queries. ' +
    (normalHasWork ? 'Event discovery skipped because normal due work already starts processing; processing still checks events first. ' :
      'Events: bounded receipt/cursor and due-period checks. ') +
    'No canonical replay reads or Firestore writes.\n' +
    `Observed Firestore usage: ${db.requests?.() == null ? 'HTTP count unavailable' : db.requests() - requestsBefore} HTTP calls, ${db.returnedDocuments?.() == null ? 'returned-document count unavailable' : db.returnedDocuments() - documentsBefore} returned documents, ${db.emptyQueryMinimumReads?.() == null ? 'empty-query minimum count unavailable' : db.emptyQueryMinimumReads() - emptyQueryMinimumBefore} empty-query minimum reads, and ${db.estimatedDocumentReads?.() == null ? 'read estimate unavailable' : db.estimatedDocumentReads() - estimatedReadsBefore} estimated document reads. This estimate is not billed usage and excludes index-entry charges.\n` +
    (hasWork ? 'This is not a backlog count. Processing remains bounded per invocation.\n' :
      'Future-dated retries are not due work. The next scheduled verification window; GitHub may delay it.\n'));
  return {hasWork, normalHasWork, coreHasWork, extraHasWork, eventHasWork, queueQueries: 2,
    eventCheckSkipped: normalHasWork,
    returnedDocuments: queueRows.length,
    queueReturnedDocuments: queueRows.length,
    firestoreHttpRequests: requestsBefore === null || db.requests?.() == null ? null : db.requests() - requestsBefore,
    firestoreReturnedDocuments: documentsBefore === null || db.returnedDocuments?.() == null ? null : db.returnedDocuments() - documentsBefore,
    firestoreQueryCount: queryCountBefore === null || db.queryCount?.() == null ? null : db.queryCount() - queryCountBefore,
    firestoreEmptyQueryMinimumReads: emptyQueryMinimumBefore === null || db.emptyQueryMinimumReads?.() == null ? null : db.emptyQueryMinimumReads() - emptyQueryMinimumBefore,
    firestoreEstimatedDocumentReads: estimatedReadsBefore === null || db.estimatedDocumentReads?.() == null ? null : db.estimatedDocumentReads() - estimatedReadsBefore,
    queueSample};
}

const usageCounters = Object.freeze({
  firestoreHttpRequests: 'httpRequests', firestoreRequestReservations: 'requestReservations',
  firestoreReturnedDocuments: 'returnedDocuments', firestoreQueryCount: 'queryCount',
  firestoreEmptyQueryMinimumReads: 'emptyQueryMinimumReads', firestoreEstimatedDocumentReads: 'estimatedDocumentReads',
  firestoreEstimatedDocumentWrites: 'estimatedDocumentWrites',
  firestoreFailedRequests: 'failedRequests', firestoreUnknownReadOutcomes: 'unknownReadOutcomes',
  firestoreCommitAttempts: 'commitAttempts', firestoreWriteAttempts: 'writeAttempts',
  firestoreUnknownCommitOutcomes: 'unknownCommitOutcomes'
});
const budgetCounters = Object.freeze({firestoreDocumentReadLimit:'readLimit', firestoreDocumentWriteLimit:'writeLimit',
  firestoreDocumentReadsUsed:'usedReads', firestoreDocumentWritesUsed:'usedWrites',
  firestoreRemainingDocumentReads:'remainingReads', firestoreRemainingDocumentWrites:'remainingWrites'});

// Numeric allowlist only: never serialize errors, credentials, paths or database payloads.
export function verifierAccounting(db) {
  const counters = Object.fromEntries(Object.entries(usageCounters).map(([name, method]) => {
    let value;
    try { value = method === 'httpRequests' && typeof db?.httpRequests !== 'function'
      ? db?.requests?.() : db?.[method]?.(); }
    catch { value = null; }
    return [name, Number.isSafeInteger(value) && value >= 0 ? value : null];
  }));
  let budget;
  try { budget = db?.documentBudget?.(); } catch {}
  for (const [name, key] of Object.entries(budgetCounters)) {
    let value;
    try { value = budget?.[key]; } catch {}
    counters[name] = Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  return counters;
}

function reportAccounting(db, phase, outcome, env, log) {
  const usage = {phase, outcome, ...verifierAccounting(db)};
  // Reporting must not replace a transport error or turn a committed result into failure.
  try { log(JSON.stringify({firestoreUsage: usage})); } catch {}
  try {
    if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY,
      '\n## Firestore accounting\n' + JSON.stringify(usage) +
      '\nReservations are admission charges, not HTTP attempts. Read estimates are not billed usage, exclude index-entry charges, and omit unknown outcomes. Document-budget usage includes in-flight and retained unknown reservations; null limits mean unlimited or unavailable. Commit/write attempts are not confirmed writes. Failed requests include HTTP, transport and read-decoding failures. Unknown outcomes count attempts, not documents. OAuth is excluded.\n');
  } catch {}
}

export async function runVerifier({check = false, drain = false, catchUp = false, scheduledDrain = false, borrowUnusedEvents = false, clock = () => performance.now(), env = process.env, connectDatabase = connect,
  validateEngine = validateEnginePin, log = console.log, eventCheck = checkEvents,
  eventRun = runEvents, prioritizeNormal = prioritizeQueueDocuments, selectNormal = selectJobs,
  verifyNormal = simulate, publishNormal = publishResults} = {}) {
  if(env.VERIFIER_SCHEDULED_DRAIN!==undefined && !['true','false'].includes(env.VERIFIER_SCHEDULED_DRAIN))throw Error('Invalid scheduled drain option');
  if(env.VERIFIER_SCHEDULED_DRAIN==='true')scheduledDrain=true;
  if (typeof catchUp !== 'boolean' || catchUp && (!drain || check)) throw Error('Catch-Up requires --drain without --check');
  if (catchUp && env.GITHUB_EVENT_NAME !== 'workflow_dispatch') throw Error('Catch-Up requires a manually dispatched GitHub workflow');
  if (typeof scheduledDrain !== 'boolean' || scheduledDrain && (!drain || check || catchUp || env.GITHUB_EVENT_NAME !== 'schedule'))
    throw Error('Scheduled drain requires a scheduled --drain without --check or --catch-up');
  if (scheduledDrain && (!/^[1-9][0-9]*$/.test(env.VERIFIER_DOCUMENT_READ_LIMIT || '') ||
      !/^[1-9][0-9]*$/.test(env.VERIFIER_DOCUMENT_WRITE_LIMIT || '') ||
      Number(env.VERIFIER_DOCUMENT_READ_LIMIT)>1500 || Number(env.VERIFIER_DOCUMENT_WRITE_LIMIT)>1000))
    throw Error('Scheduled drain requires document caps at most 1500 reads and 1000 writes');
  const limits = catchUp ? CATCH_UP_LIMITS : scheduledDrain ? SCHEDULED_DRAIN_LIMITS : DRAIN_LIMITS;

  // Preflight never loads or hashes physics assets. Actual processing still pins the engine first.
  if (!check) await validateEngine();
  const raw = env.FIREBASE_VERIFIER_SERVICE_ACCOUNT;
  if (!raw) throw Error('Set the private FIREBASE_VERIFIER_SERVICE_ACCOUNT Actions secret.');
  let db;
  try { db = await connectDatabase(raw, {env}); }
  catch (error) {
    reportAccounting(null, 'connect', 'failed', env, log);
    throw error;
  } finally { delete env.FIREBASE_VERIFIER_SERVICE_ACCOUNT; }
  const report = createOutcomeReport({file:env.VERIFIER_OUTCOME_REPORT,root});
  let accountingDb = db, outcome = 'failed', reportComplete = false, proofCache, proofContext;
  const finish = result => {
    outcome = result.deferred === true || result.interruptedRound === true ? 'deferred'
      : result.infrastructureFailure || result.stop === 'infrastructure_failure' ? 'failed' : 'completed';
    reportComplete = result.countsComplete !== false && result.interruptedRound !== true && result.deferred !== true && result.events?.countsComplete !== false && result.eventCountsComplete !== false;
    const usage = verifierAccounting(accountingDb);
    // Preserve legacy result shapes when document caps are not configured.
    if (usage.firestoreDocumentReadLimit !== null || usage.firestoreDocumentWriteLimit !== null) Object.assign(result, usage);
    return result;
  };
  try {
    if (check) {
      try { return finish(await checkForWork(db, {env, log, eventCheck})); }
      catch (error) {
        const firestoreStop = firestoreDeferralReason(error);
        if (!firestoreStop && error?.status !== 429) throw error;
        const documentBudget = firestoreStop === 'firestore_document_budget';
        const message = documentBudget
          ? 'The Firestore document-budget guard stopped verification preflight. Queue state is unknown; no runs were processed or removed. The next invocation will reread queue state.'
          : 'Firestore throttled verification preflight. Queue state is unknown; no runs were processed or removed. The next scheduled run will retry.';
        if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, 'has_work=deferred\npreflight_status=' + (documentBudget ? 'document_budget' : 'throttled') + '\n');
        if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, '## Verification preflight deferred\n' + message + '\n');
        log(message);
        return finish({hasWork: null, deferred: true, reason: documentBudget ? firestoreStop : 'firestore_429',
          ...(documentBudget ? {countsComplete:false} : {})});
      }
    }
    const deadline = scheduledDrain ? performance.now()+480000 : Infinity;
    let initializedCache;
    const cachedVerify = async (...args) => {
      if(!initializedCache){
        const native = await import('./verify.cjs');
        initializedCache=createCachedVerifier({root,verify:(directory,jobs,tracks)=>verifyNormal(directory,jobs,tracks,{deadline}),
          verifierFingerprint:native.verifierFingerprint,engineDigest:VERIFIER_ENGINE_DIGEST});
        proofContext={root,engineDigest:VERIFIER_ENGINE_DIGEST,verifierFingerprint:native.verifierFingerprint};
        loadPrivateProofCache(initializedCache,{...proofContext,file:env.VERIFIER_PROOF_CACHE_INPUT,sha256:env.VERIFIER_PROOF_CACHE_SHA256});
        proofCache=initializedCache;
      }
      return initializedCache(...args);
    };
    cachedVerify.stats=()=>initializedCache?.stats()||{hits:0,misses:0,entries:0,bytes:0};
    const roundOptions={env,log,eventRun,prioritizeNormal,selectNormal,verifyNormal:cachedVerify,publishNormal,borrowUnusedEvents,
      recordOutcome:report.record,reviewSimilarity:createSimilarityReviewer(root),eventSelectionState:{}};
    if (!drain) {
      try { return finish(await runRound(db,roundOptions)); }
      catch (error) {
        const eventConflict=isDeferredEventConflict(error);
        const firestoreStop=firestoreDeferralReason(error);
        if (!eventConflict && !firestoreStop) throw error;
        const summary={deferred:true,reason:eventConflict?'event_conflict':firestoreStop,interruptedRound:true,countsComplete:false};
        const message=eventConflict?EVENT_CONFLICT_MESSAGE:firestoreStop==='firestore_document_budget'?DOCUMENT_BUDGET_MESSAGE:
          'Firestore throttled verification. This invocation deferred without replaying a write; queue state will be reread on the next scheduled run.';
        finish(summary);
        log(JSON.stringify(summary));
        if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY,'## Verification deferred\n'+message+'\n\n'+JSON.stringify(summary)+'\n');
        return summary;
      }
    }
    const bounded=budgetDatabase(db,limits.requests,limits);
    accountingDb = bounded;
    const summary=await drainVerification({requests:bounded.requests,now:clock,log,limits,
      runRound:()=>runRound(bounded,{...roundOptions,borrowUnusedEvents:true})});
    summary.mode=catchUp?'catch-up':scheduledDrain?'scheduled-drain':'normal';
    summary.proofCache=cachedVerify.stats();
    Object.assign(summary, verifierAccounting(bounded));
    if(env.GITHUB_STEP_SUMMARY)fs.appendFileSync(env.GITHUB_STEP_SUMMARY,
      '\n## Bounded drain\n'+JSON.stringify(summary)+'\nMode: '+summary.mode+'. Limits: '+limits.rounds+
      ' rounds, '+limits.rounds*TOTAL_JOB_LIMIT+' total native attempts, '+limits.requests+' Firestore HTTP requests. Returned documents, query count, empty-query minimum reads, and estimated document reads are separate counters; the estimate is not billed usage and excludes index-entry charges. '+
      (catchUp?'Catch-Up spends a larger per-run budget to drain due work with one setup. It stops early on empty work, throttling, document-budget stops, or infrastructure failure. It does not bypass verification limits or retry future-dated jobs. ':'')+
      'Time admission is measured, not a completion guarantee; the workflow step timeout remains the hard stop. '+
      'Interrupted-round publication counts are incomplete, not zero. `stop` explains why this invocation ended; a round is not a GitHub workflow run number. '+
      'Unknown or untrusted tracks remain unavailable rather than admitting user-supplied track data.\n'+
      `\nVerified tracks:\n${verifiedTrackCounts(summary.verifiedByTrack).map(track=>`- ${track.trackName}: ${track.count}`).join('\n') || '- None'}\n`+
      (summary.stop==='firestore_throttled'?'Firestore returned a deferred throttle response. No commit was replayed; queue state will be reread by a later scheduled run. Publication counts for the interrupted round are incomplete.\n':'')+
      (summary.stop==='firestore_document_budget'?DOCUMENT_BUDGET_MESSAGE+'\n':'')+
      (summary.stop==='event_conflict'?EVENT_CONFLICT_MESSAGE+'\n':''));
    return finish(summary);
  } finally {
    if(proofCache && env.VERIFIER_PROOF_CACHE_OUTPUT){
      try{const saved=writePrivateProofCache(proofCache,{...proofContext,file:env.VERIFIER_PROOF_CACHE_OUTPUT});log(JSON.stringify({privateProofCache:saved}));}
      catch{log('Private proof cache output failed; no publication was replayed.');process.exitCode=1;}
    }
    report.finish({countsComplete:reportComplete}); reportAccounting(accountingDb, check ? 'preflight' : drain ? 'drain' : 'single-round', outcome, env, log); }
}

export async function runRound(db,{env,log,eventRun,prioritizeNormal,selectNormal,verifyNormal,publishNormal,borrowUnusedEvents,reviewSimilarity,eventSelectionState,recordOutcome}) {
  const now = Date.now();
  // Events must get their reservation before normal canonical reads/commits. Otherwise
  // normal selection can spend the request budget and strand both sources.
  const eventLimit = TOTAL_JOB_LIMIT - NORMAL_JOB_LIMIT;
  const events = await eventRun(db, root, {limit: eventLimit, intakeLimit: TOTAL_JOB_LIMIT, canSpend:db.canSpend, selectionState:eventSelectionState,verifyBatch:verifyNormal,recordOutcome});
  if (!Number.isInteger(events.checked) || events.checked<0 || events.checked>eventLimit) throw Error('Invalid event native count');
  let selectedJobs = [], canonicalAttempts = 0, selectionConflicts = 0;
  let normalQueueReturnedDocuments = 0;
  let normalCapacity = Math.min(borrowUnusedEvents ? TOTAL_JOB_LIMIT - events.checked : NORMAL_JOB_LIMIT,
    db.remainingRequests ? Math.floor(db.remainingRequests() / 18) : TOTAL_JOB_LIMIT);
  if (events.checked < TOTAL_JOB_LIMIT && normalCapacity > 0) {
    const priorityCache = new Map();
    const baseCandidateLimit=Math.min(QUEUE_CANDIDATE_LIMIT,normalCapacity);
    let targetTrack=null;
    if(prioritizeNormal===prioritizeQueueDocuments && baseCandidateLimit>=2 &&
      (!db.remainingRequests || db.remainingRequests()>=54)) {
      targetTrack=await highestPriorityTrack(db,priorityCache);
      if(targetTrack && db.remainingRequests) normalCapacity=Math.min(normalCapacity,Math.floor((db.remainingRequests()-1)/18));
      if(normalCapacity<2) targetTrack=null;
    }
    const candidateLimit=Math.min(QUEUE_CANDIDATE_LIMIT,normalCapacity);
    const dueDocs = async (collection, targetedTrackId) => {
      const broadLimit=Math.max(1,candidateLimit-(targetedTrackId?1:0));
      const query = await db.call(':runQuery', {structuredQuery: {from: [{collectionId: collection}], where: {fieldFilter: {field: {fieldPath: 'notBefore'}, op: 'LESS_THAN_OR_EQUAL', value: {integerValue: String(now)}}}, orderBy: [{field: {fieldPath: 'notBefore'}, direction: 'ASCENDING'}, {field: {fieldPath: '__name__'}, direction: 'ASCENDING'}], limit: broadLimit}});
      if (!Array.isArray(query)) throw Error('Unexpected verification queue response');
      const documents=query.filter(x => x.document).map(x => {
        const document = {...x.document, queueCollection: collection, data: decode({mapValue: {fields: x.document.fields || {}}})};
        const registered = EXTRA_TRACK_IDS.has(document.data.trackId);
        if (registered !== (collection === EXTRA_VERIFICATION_COLLECTION)) {
          throw Error('EXTRA_QUEUE_BACKFILL_REQUIRED: '+collection+'/'+document.data.trackId+'; deploy the matching Worker registry and run the backed-up Extra queue repair before retrying');
        }
        return document;
      });
      if(targetedTrackId && !documents.some(document=>document.data.trackId===targetedTrackId)) {
        const target=await db.get(collection,targetedTrackId);
        if(target?.data?.trackId===targetedTrackId && Number(target.data.notBefore||0)<=now) {
          const registered=EXTRA_TRACK_IDS.has(targetedTrackId);
          if(registered!==(collection===EXTRA_VERIFICATION_COLLECTION)) throw Error('EXTRA_QUEUE_BACKFILL_REQUIRED: '+collection+'/'+targetedTrackId);
          documents.push({...target,queueCollection:collection});
        }
      }
      return documents;
    };
    const priorityCollection=targetTrack?(EXTRA_TRACK_IDS.has(targetTrack)?EXTRA_VERIFICATION_COLLECTION:VERIFICATION_COLLECTION):null;
    const coreDocs = await dueDocs(VERIFICATION_COLLECTION,priorityCollection===VERIFICATION_COLLECTION?targetTrack:null);
    const extraDocs = await dueDocs(EXTRA_VERIFICATION_COLLECTION,priorityCollection===EXTRA_VERIFICATION_COLLECTION?targetTrack:null);
    normalQueueReturnedDocuments = coreDocs.length + extraDocs.length;
    const coreLimit = normalCapacity - Number(extraDocs.length > 0);
    const core = await selectNormal(db, await prioritizeNormal(db, coreDocs, now, priorityCache), now, {jobLimit: coreLimit, lookupLimit: coreLimit, fillIdleSlots:true});
    // Extra runs have the last reservation, but can use every slot left idle by core tracks.
    const extraLimit = Math.max(0, Math.min(normalCapacity - core.jobs.length, normalCapacity - core.canonicalAttempts));
    const extra = extraLimit && extraDocs.length ? await selectNormal(db, await prioritizeNormal(db, extraDocs, now, priorityCache), now, {jobLimit: extraLimit, lookupLimit: extraLimit, fillIdleSlots:true}) : {jobs: [], canonicalAttempts: 0, selectionConflicts: 0};
    selectedJobs = [...core.jobs, ...extra.jobs];
    canonicalAttempts = core.canonicalAttempts + extra.canonicalAttempts;
    selectionConflicts = core.selectionConflicts + extra.selectionConflicts;
  }
  // Normal selection is unleased: unprocessed bindings remain in their queue.
  let jobs = selectedJobs.slice(0, NORMAL_JOB_LIMIT);
  // Events get their reserved work first; only unused slots can be borrowed.
  if(borrowUnusedEvents)jobs=selectedJobs.slice(0,TOTAL_JOB_LIMIT-events.checked);
  // Flagged publications can make six requests on each of three conflict attempts.
  if(db.remainingRequests)jobs=jobs.slice(0,Math.floor(db.remainingRequests()/18));
  // Published outcomes differ from native verdicts: unavailable can retry as waiting.
  const eventResults = events.results || [];
  const counts = field => Object.fromEntries([...new Set(eventResults.map(row => row?.[field] || 'unspecified'))]
    .map(value => [value, eventResults.filter(row => (row?.[field] || 'unspecified') === value).length]));
  const eventSummary = {checked: events.checked, consumed: events.consumed,
    statuses: counts('status'), reasons: counts('reason'), reported: eventResults.length,
    countsComplete: eventResults.length === events.checked,
    rejected: events.rejected, archived: events.archived, budgetDeferred:events.budgetDeferred===true,
    conflictDeferred:events.conflictDeferred===true,
    reviewInboxAdded:Number(events.eventFindingsAdded||0),reviewInboxWriteFailed:Number(events.eventFindingWriteFailed||0)};
  const idleCounts = {normalQueueReturnedDocuments,
    unusedEventReservedSlots: Math.max(0, eventLimit - events.checked),
    normalIdleSlots: Math.max(0, (borrowUnusedEvents ? TOTAL_JOB_LIMIT - events.checked : NORMAL_JOB_LIMIT) - jobs.length),
    idleNativeSlots: Math.max(0, TOTAL_JOB_LIMIT - events.checked - jobs.length)};
  announceReviewFindings(eventSummary.reviewInboxAdded,log);
  log(JSON.stringify({events: eventSummary}));
  if(eventSummary.conflictDeferred)log('Event inbox deferred after transaction contention. No contested write was replayed; normal verification continues.');
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY,
    '## Event verification\n' + JSON.stringify(eventSummary) + (eventSummary.conflictDeferred?'\nEvent inbox deferred after transaction contention; normal verification continues. The next invocation rereads the contested receipt.\n':'') + `\nNative work: ${events.checked} event checks (${eventLimit} reserved slots), ${jobs.length} normal; at most ${TOTAL_JOB_LIMIT} total per round (unused event slots may be borrowed). Inbox intake: at most ${TOTAL_JOB_LIMIT}.\nPriority: estimated RP impact; event ties favor faster times. One in four selection slots is reserved for runs overdue by at least one hour (normal lanes reserve at least one when capacity is smaller). Queue discovery remains bounded.\n`);
  if (events.results?.some(result => result.reason === 'engine_unavailable')) process.exitCode = 1;
  const infrastructure = result => result?.status==='unavailable' && /^(engine_|isolate_|process_|page_error|cpu_|wall_|deadline|native_engine_error)/.test(String(result.reason||''));
  const eventFailure=(events.results||[]).some(infrastructure);
  if (!jobs.length) {
    const summary={processed:0,canonicalAttempts,selectionConflicts,events:eventSummary,...idleCounts,infrastructureFailure:eventFailure};
    log(JSON.stringify({...summary,message:'No runnable normal verification jobs.'}));return summary;
  }
  const trustedTracks = loadWeeklyTrustedTrack(root, jobs);
  const results = await verifyNormal(root, jobs, trustedTracks);
  if (results.length !== jobs.length || new Set(results.map(r => r.resultId)).size !== jobs.length) throw Error('Incomplete verifier result set');
  if(reviewSimilarity) await reviewSimilarity(jobs,results);
  const totals = await publishNormal(db, jobs, results, {recordOutcome});
  const reasons = totals.reasons;
  announceReviewFindings(totals.reviewInboxAdded,log);
  log(JSON.stringify({processed: jobs.length, canonicalAttempts, selectionConflicts, ...idleCounts, ...totals, reasons, firestoreRequests: typeof db.httpRequests === 'function' ? db.httpRequests() : db.requests?.() ?? null}));
  const tracks = verifiedTrackCounts(totals.verifiedByTrack);
  if(env.GITHUB_STEP_SUMMARY)fs.appendFileSync(env.GITHUB_STEP_SUMMARY,`## Replay verification\nProcessed: ${jobs.length}. Verified: ${totals.verified}. Corrected legacy times: ${totals.corrected}. Waiting: ${totals.unavailable}. Deferred conflicts: ${totals.deferred}. Review inbox additions: ${totals.reviewInboxAdded||0} (manual review, not cheating verdicts).\n\nVerified tracks:\n${tracks.length ? tracks.map(track=>`- ${track.trackName}: ${track.count}`).join('\n') : '- None'}\n\n${Object.entries(reasons).map(([reason,count])=>'- '+reason+': '+count).join('\n')}\n`);
  if(results.some(r=>r.reason==='engine_unavailable')){console.error('Verifier startup failed. Runs remain waiting; inspect the startup diagnostic.');process.exitCode=1;}
  return {processed:jobs.length,canonicalAttempts,selectionConflicts,...idleCounts,...totals,events:eventSummary,
    verifiedByTrack:totals.verifiedByTrack, infrastructureFailure:eventFailure||results.some(infrastructure)};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runVerifier({check: process.argv.includes('--check'), drain: process.argv.includes('--drain'), catchUp: process.argv.includes('--catch-up'), scheduledDrain: process.argv.includes('--scheduled-drain'), borrowUnusedEvents: true});
}


export function announceReviewFindings(count, log = console.log) {
  if (!Number.isSafeInteger(count) || count <= 0) return;
  log('::warning title=Replay review required::' + count + ' new replay review ' + (count === 1 ? 'finding' : 'findings') + '. Strong near-clone candidates remain held pending human review. No account penalty was applied.');
}
