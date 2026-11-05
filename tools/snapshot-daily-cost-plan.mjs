import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// Pure document-operation arithmetic. No capture imports, credentials or transport.
const integer = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 0) throw Error(`${name} must be a nonnegative safe integer`);
  return value;
};
const sum = values => values.includes(null) ? null : integer(values.reduce((a, b) => a + b, 0), 'sum');
const product = (a, b) => a === 0 || b === 0 ? 0 : a === null || b === null ? null : integer(a * b, 'product');
const count = (value, name) => value === null ? null : integer(value, name);
function vector(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(`${name} requires reads and writes (null means unknown)`);
  return Object.fromEntries(['reads', 'writes'].map(key => [key, count(value[key], `${name}.${key}`)]));
}
const add = (...values) => Object.fromEntries(['reads', 'writes'].map(key => [key, sum(values.map(v => v[key]))]));
const scale = (v, n) => Object.fromEntries(['reads', 'writes'].map(key => [key, product(v[key], n)]));

/** Backend rebuild comparison ONLY. This is not published source capture. */
export function backendRebuildCost({rows, reusedRows, readsPerFetchedRow, writesPerFetchedRow,
  emptyQueries, fixed, httpRequests}) {
  integer(rows, 'rows'); integer(reusedRows, 'reusedRows');
  if (reusedRows > rows) throw Error('reusedRows cannot exceed rows');
  count(readsPerFetchedRow, 'readsPerFetchedRow');
  count(writesPerFetchedRow, 'writesPerFetchedRow'); count(emptyQueries, 'emptyQueries');
  const overhead = vector(fixed, 'fixed');
  const fetchedRows = rows - reusedRows;
  return {model: 'backend-rebuild-not-source-capture', rows, reusedRows, fetchedRows,
    reads: sum([product(fetchedRows, readsPerFetchedRow), emptyQueries, overhead.reads]),
    writes: sum([product(fetchedRows, writesPerFetchedRow), overhead.writes]),
    httpRequests: count(httpRequests, 'httpRequests')};
}

/** Published payload documents, not their contained rows. Count named reads,
 * including missing docs. Route overhead is additional, never silently zero.
 * No row-based fallback is accepted by the daily source-capture planner.
 */
export function captureCost({overall, published, normalReplays, eventReplays,
  workerRouteOverhead, otherCapture, httpRequests}) {
  const bounded = (value, name, max) => {
    integer(value, name);
    if (value > max) throw Error(`${name} exceeds ${max}`);
    return value;
  };
  const roots = bounded(overall.rootDocuments, 'overall.rootDocuments', 3);
  if (roots < 2) throw Error('overall.rootDocuments must be 2 or 3');
  const parts = bounded(overall.sourcePartDocuments, 'overall.sourcePartDocuments', 4);
  const pages = bounded(overall.pageDocuments, 'overall.pageDocuments', 100);
  const overallDocuments = sum([roots, parts, pages]);
  const publishedDocuments = Object.fromEntries(['trackRootDocuments', 'trackPageDocuments',
    'eventRootDocuments', 'eventPageDocuments', 'catalogTotalsDocuments']
    .map(key => [key, count(published[key], `published.${key}`)]));
  integer(normalReplays.missingBindings, 'normalReplays.missingBindings');
  const limit = bounded(normalReplays.documentLimit, 'normalReplays.documentLimit', 2000);
  if (limit < 1) throw Error('normalReplays.documentLimit must be positive');
  const normalReplayDocuments = Math.min(normalReplays.missingBindings, limit);
  const verified = bounded(eventReplays.verifiedRequests, 'eventReplays.verifiedRequests', 30);
  const pending = bounded(eventReplays.pendingRequests, 'eventReplays.pendingRequests', 30);
  if (verified + pending > 30) throw Error('Event replay/playback requests share a cap of 30');
  const eventReplayDocuments = sum([
    product(verified, count(eventReplays.readsPerVerifiedRequest, 'eventReplays.readsPerVerifiedRequest')),
    product(pending, count(eventReplays.readsPerPendingRequest, 'eventReplays.readsPerPendingRequest'))]);
  const route = vector(workerRouteOverhead, 'workerRouteOverhead');
  const other = vector(otherCapture, 'otherCapture');
  const components = {overallDocuments, ...publishedDocuments, normalReplayDocuments, eventReplayDocuments};
  return {model: 'published-source-capture', components,
    normalReplayDeferredBindings: normalReplays.missingBindings - normalReplayDocuments,
    modeledReadSubtotal: sum(Object.values(components)),
    // A partial known sum is useful evidence, but is not the complete capture cost.
    knownReadLowerBound: sum([...Object.values(components), route.reads, other.reads].filter(v => v !== null)),
    workerRouteOverhead: route, otherCapture: other,
    reads: sum([...Object.values(components), route.reads, other.reads]),
    writes: sum([route.writes, other.writes]),
    httpRequests: count(httpRequests, 'httpRequests')};
}

/** Compare only the declared layer; publication and queue costs must be included
 * explicitly or remain outside scope. Strictly-cheaper threshold, not <=.
 */
export function breakEven({rows, fullFixedReads, fullReadsPerRow, keyedFixedReads, keyedReadsPerChange}) {
  for (const [key, value] of Object.entries({rows, fullFixedReads, fullReadsPerRow, keyedFixedReads, keyedReadsPerChange})) integer(value, key);
  const fullReads = sum([fullFixedReads, product(rows, fullReadsPerRow)]);
  const available = fullReads - keyedFixedReads;
  const maxChangesStrictlyCheaper = available <= 0 ? -1 : keyedReadsPerChange === 0 ? rows :
    Math.min(rows, Math.ceil(available / keyedReadsPerChange) - 1);
  return {fullReads, maxChangesStrictlyCheaper,
    equalityAtChanges: keyedReadsPerChange > 0 && available >= 0 && available % keyedReadsPerChange === 0 && available / keyedReadsPerChange <= rows
      ? available / keyedReadsPerChange : null};
}

/** budgets are operator planning envelopes, not provider quota claims.
 * playerReserve is incremental, not included in uploads/background; never double count.
 * An unknown dimension prevents an affirmative fit or capture cap.
 */
export function dailyCostPlan({capture, capturesPerDay, budget, playerReserve,
  uploadsPerDay, uploadCost, backgroundDaily, otherDaily}) {
  const perCapture = captureCost(capture);
  integer(capturesPerDay, 'capturesPerDay'); integer(uploadsPerDay, 'uploadsPerDay');
  const envelope = vector(budget, 'budget'), reserve = vector(playerReserve, 'playerReserve');
  if (Object.values(envelope).includes(null) || Object.values(reserve).includes(null)) throw Error('budget and playerReserve must be explicit counts');
  const uploads = scale(vector(uploadCost, 'uploadCost'), uploadsPerDay);
  const background = vector(backgroundDaily, 'backgroundDaily'), other = vector(otherDaily, 'otherDaily');
  const sourceCapture = scale(perCapture, capturesPerDay);
  const consumed = add(sourceCapture, uploads, background, other);
  const withReserve = add(consumed, reserve);
  const dimensions = {};
  for (const key of ['reads', 'writes']) {
    const nonCapture = sum([uploads[key], background[key], other[key], reserve[key]]);
    const headroom = withReserve[key] === null ? null : envelope[key] - withReserve[key];
    const available = nonCapture === null ? null : envelope[key] - nonCapture;
    // A zero-cost dimension is nonbinding, not proof of unlimited users/captures.
    const cap = available === null || perCapture[key] === null ? null : available < 0 ? 0 :
      perCapture[key] === 0 ? null : Math.floor(available / perCapture[key]);
    dimensions[key] = {headroomAfterReserve: headroom, maxCaptures: cap,
      nonbinding: available !== null && available >= 0 && perCapture[key] === 0};
  }
  const exceeds = Object.values(dimensions).some(d => d.headroomAfterReserve !== null && d.headroomAfterReserve < 0);
  const known = Object.values(withReserve).every(v => v !== null);
  const constraintsKnown = Object.values(dimensions).every(d => d.maxCaptures !== null || d.nonbinding);
  const caps = Object.values(dimensions).flatMap(d => d.maxCaptures === null ? [] : [d.maxCaptures]);
  return {schemaVersion: 2, billingAttribution: false, forecast: false, capturesPerDay,
    perCapture, sourceCapture, offlineCalculation: {reads: 0, writes: 0, httpRequests: 0},
    sourceCaptureKnownReadLowerBound: product(perCapture.knownReadLowerBound, capturesPerDay),
    uploads, backgroundDaily: background, otherDaily: other, playerReserve: reserve,
    consumed, withReserve, dimensions,
    fitsDeclaredEnvelope: exceeds ? false : known ? true : null,
    maxCapturesPerDay: constraintsKnown && caps.length ? Math.min(...caps) : null,
    warning: 'Conditional document-operation model, not billed usage or a daily forecast. Unknown costs are not zero; HTTP requests are not documents. No user-capacity claim.'};
}

export function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--help') return 'Usage: node tools/snapshot-daily-cost-plan.mjs <local-input.json>\nInput: {capture:{overall:{rootDocuments,sourcePartDocuments,pageDocuments},published:{trackRootDocuments,trackPageDocuments,eventRootDocuments,eventPageDocuments,catalogTotalsDocuments},normalReplays:{missingBindings,documentLimit},eventReplays:{verifiedRequests,pendingRequests,readsPerVerifiedRequest,readsPerPendingRequest},workerRouteOverhead:{reads,writes},otherCapture:{reads,writes},httpRequests},capturesPerDay,budget:{reads,writes},playerReserve:{reads,writes},uploadsPerDay,uploadCost:{reads,writes},backgroundDaily:{reads,writes},otherDaily:{reads,writes}}\nAll counts are required. Use null for unmeasured costs, not zero. Published payload rows are not document reads; backendRebuildCost is separate. No network or writes.\n';
  if (args.length !== 1 || args[0].startsWith('-')) throw Error('Expected one local JSON input path; use --help');
  return JSON.stringify(dailyCostPlan(JSON.parse(readFileSync(resolve(args[0]), 'utf8'))), null, 2) + '\n';
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(main()); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
