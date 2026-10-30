import fs from 'node:fs';
import path from 'node:path';
import {createHash, sign} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readLedger, ledgerBinding, ledgerKey, ledgerDisposition, applyLedgerToBoard} from './native-verification-ledger.mjs';

const HASH = /^[a-f0-9]{64}$/, COMMIT = /^[a-f0-9]{40}$/, PERIOD = /^[A-Za-z0-9_-]{1,128}$/;
const QUEUES = '0.6.2_event_queues';
const BASE = 'projects/polytrack-052/databases/(default)/documents/';
const REPOSITORY = 'StaticQuasar931/PolyTrack-0.6.3-Ranked';
const MAX_RECEIPT_BYTES = 64 * 1024 * 1024;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const integer = value => Number.isSafeInteger(value) && value >= 0;
const demand = (condition, message) => {if (!condition) throw Error('Native event ACK: ' + message);};
const sha = value => createHash('sha256').update(value).digest('hex');
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value) && Number.isFinite(Date.parse(value));
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (plain(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  demand(value === null || ['boolean', 'string'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value), 'invalid receipt value');
  return JSON.stringify(value);
}
function fields(value, expected) {
  demand(plain(value) && Object.keys(value).sort().join('|') === [...expected].sort().join('|'), 'unexpected schema fields');
}
function encode(value) {
  if (value === null) return {nullValue:null};
  if (typeof value === 'boolean') return {booleanValue:value};
  if (typeof value === 'string') return {stringValue:value};
  if (typeof value === 'number') {demand(Number.isFinite(value), 'invalid queue number'); return Number.isInteger(value) ? {integerValue:String(value)} : {doubleValue:value};}
  if (Array.isArray(value)) return {arrayValue:{values:value.map(encode)}};
  demand(plain(value), 'invalid queue value');
  return {mapValue:{fields:Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, encode(entry)]))}};
}

/** Canonical-object digest pinned by the private phase output, not a public caller's claim. */
export const nativeEventAckReceiptHash = receipt => sha(canonical(receipt));

function validateReceipt(receipt, expectedReceiptHash) {
  demand(HASH.test(expectedReceiptHash), 'independently pinned private receipt hash required');
  fields(receipt, ['schemaVersion', 'kind', 'sourceCommit', 'captureSha256', 'ledgerManifestHash', 'candidates']);
  demand(receipt.schemaVersion === 1 && receipt.kind === 'native-event-queue-ack' && COMMIT.test(receipt.sourceCommit) &&
    HASH.test(receipt.captureSha256) && HASH.test(receipt.ledgerManifestHash), 'receipt identity');
  demand(Array.isArray(receipt.candidates) && receipt.candidates.length <= 4096 &&
    Buffer.byteLength(canonical(receipt)) <= MAX_RECEIPT_BYTES && nativeEventAckReceiptHash(receipt) === expectedReceiptHash, 'receipt hash/limit');
  const seen = new Set();
  return receipt.candidates.map(candidate => {
    fields(candidate, ['binding', 'ledgerKey', 'sourceCollection', 'sourceStatus', 'replay', 'replayLength']);
    const binding = ledgerBinding(candidate.binding, 'event');
    fields(candidate.binding, Object.keys(binding));
    demand(binding.lane === 'event' && binding.frames === binding.timeMs && PERIOD.test(binding.periodId) && candidate.ledgerKey === ledgerKey(binding) &&
      ['0.6.2_event_runs', '0.6.2_event_replays'].includes(candidate.sourceCollection) &&
      candidate.sourceStatus === 'waiting', 'raw server-pending candidate required');
    demand(typeof candidate.replay === 'string' && candidate.replay.length > 0 && candidate.replay.length <= 8 * 1024 * 1024 &&
      /^[A-Za-z0-9_-]+$/.test(candidate.replay) && candidate.replay.length % 4 !== 1 &&
      integer(candidate.replayLength) && candidate.replayLength === candidate.replay.length &&
      Buffer.byteLength(candidate.replay, 'ascii') === candidate.replayLength && sha(candidate.replay) === binding.replayHash, 'retained ASCII replay binding');
    demand(!seen.has(binding.runId), 'duplicate run candidate'); seen.add(binding.runId);
    return {...candidate, binding};
  });
}

function pointerAt(root) {
  const file = path.join(root, 'verification-ledger-current.json'), stat = fs.lstatSync(file);
  demand(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 2 * 1024 * 1024, 'unsafe root pointer');
  const pointer = JSON.parse(fs.readFileSync(file, 'utf8'));
  fields(pointer, ['schemaVersion', 'directory', 'manifestHash']);
  demand(pointer.schemaVersion === 1 && pointer.directory === 'verification-ledger' && HASH.test(pointer.manifestHash), 'root pointer');
  return pointer;
}
const conflict = error => [409, 412].includes(Number(error?.status ?? error?.code)) || /^FIRESTORE_(409|412)$/.test(error?.message || '');
const quota = error => Number(error?.status ?? error?.code) === 429 || error?.code === 'RESOURCE_EXHAUSTED' || /(?:FIRESTORE_|\b)429\b/.test(error?.message || '');

/**
 * No queries, retries, verdict writes or source document changes. The only writes are
 * updateMask:[slots,replayBytes] on <=4 queue roots. Injected db.get/db.call must be
 * single-attempt. CLI uses maxReadRetries:0. Budgets count attempted document operations.
 * publicationGate must establish the exact published protected remote commit and pin
 * this private phase receipt. It must also enforce the parent's accepted-PB retention
 * gate; this helper cannot prove that an external compiler preserves future captures.
 */
export async function acknowledgeNativeEventQueues({root, receipt, expectedReceiptHash, publishedCommit,
  publicationGate, policy, buildPolicy, db, connectDb, now = Date.now, maxPeriods = 4, readLimit = 16, writeLimit = 8} = {}) {
  demand(typeof root === 'string' && path.isAbsolute(root) && COMMIT.test(publishedCommit), 'absolute root/published commit required');
  demand(typeof publicationGate === 'function', 'explicit publication gate required');
  demand(Number.isInteger(maxPeriods) && maxPeriods >= 1 && maxPeriods <= 4 &&
    Number.isInteger(readLimit) && readLimit >= 1 && readLimit <= 16 &&
    Number.isInteger(writeLimit) && writeLimit >= 1 && writeLimit <= 8 && typeof now === 'function', 'bounded ACK configuration');
  root = fs.realpathSync(root);
  // Snapshot all caller inputs before awaits. Later mutation cannot broaden an ACK.
  receipt = structuredClone(receipt);
  const candidates = validateReceipt(receipt, expectedReceiptHash);
  const pointer = pointerAt(root);
  demand(pointer.manifestHash === receipt.ledgerManifestHash, 'receipt/root ledger mismatch');
  const ledger = readLedger({root:path.join(root, 'verification-ledger'), expectedManifestHash:pointer.manifestHash});
  const gateInput = Object.freeze({root, sourceCommit:receipt.sourceCommit, publishedCommit,
    ledgerManifestHash:pointer.manifestHash, candidateReceiptHash:expectedReceiptHash, captureSha256:receipt.captureSha256});
  const gate = await publicationGate(gateInput);
  demand(plain(gate) && gate.published === true && gate.acceptedResultsRetained === true &&
    gate.acceptedBestAdmissionCompatible === true && gate.freshHoldFencesValidated === true &&
    ['sourceCommit', 'publishedCommit', 'ledgerManifestHash', 'candidateReceiptHash', 'captureSha256'].every(key => gate[key] === gateInput[key]), 'publication/retention gate not established');
  if (!policy) {
    const factory = buildPolicy ?? (await import('./native-verification-policy.mjs')).buildNativeVerificationPolicy;
    policy = await factory({root, entries:ledger.entries});
  }
  policy = structuredClone(policy);
  const entries = new Map(ledger.entries.map(entry => [entry.key, entry]));
  const approved = candidates.filter(candidate => {
    const entry = entries.get(candidate.ledgerKey);
    if (!entry || ledgerDisposition(entry) !== 'verified') return false;
    const row = {...candidate.binding, verificationStatus:'waiting', verifiedState:0};
    const check = applyLedgerToBoard({board:{periodId:row.periodId, trackId:row.trackId, entries:[row]}, ledger,
      canonicalRows:[candidate.binding], recordings:[{...candidate.binding, replay:candidate.replay}], policy, lane:'event'});
    return check.report.verified === 1;
  });
  const report = {schemaVersion:1, sourceCommit:receipt.sourceCommit, publishedCommit,
    ledgerManifestHash:pointer.manifestHash, candidateReceiptHash:expectedReceiptHash,
    counts:{candidates:candidates.length, approved:approved.length, readAttempts:0, writeAttempts:0, removedRuns:0, periodsAcknowledged:0},
    stopped:null, periods:[]};
  const periods = [...new Set(approved.map(candidate => candidate.binding.periodId))].sort();
  if (!periods.length) return report;
  demand(pointerAt(root).manifestHash === pointer.manifestHash, 'root ledger changed after publication gate');
  demand(db || typeof connectDb === 'function', 'DB adapter required after publication gate');
  db = db ?? await connectDb();
  demand(typeof db.get === 'function' && typeof db.call === 'function', 'single-attempt DB adapter required');
  for (const periodId of periods.slice(0, maxPeriods)) {
    if (report.counts.readAttempts >= readLimit || report.counts.writeAttempts >= writeLimit) {report.stopped = 'document_budget'; break;}
    // Recheck local pin immediately before each period; never ACK a changed local generation.
    demand(pointerAt(root).manifestHash === pointer.manifestHash, 'root ledger changed after publication gate');
    let document;
    report.counts.readAttempts++;
    try {document = await db.get(QUEUES, periodId);} catch (error) {
      report.stopped = quota(error) ? 'quota' : 'read_failed'; report.periods.push({periodId, status:report.stopped}); break;
    }
    if (!document) {report.periods.push({periodId, status:'missing_queue'}); continue;}
    const queue = document.data;
    if (!plain(queue) || !timestamp(document.updateTime) || !Array.isArray(queue.slots) || queue.slots.length > 512 || !integer(queue.replayBytes)) {
      report.stopped = 'invalid_queue'; report.periods.push({periodId, status:'invalid_queue'}); break;
    }
    const byRun = new Map(approved.filter(candidate => candidate.binding.periodId === periodId).map(candidate => [candidate.binding.runId, candidate]));
    const matched = new Set(), seen = new Set(); let released = 0, invalid = false;
    const at = now(); demand(integer(at) && at > 0, 'actual clock required');
    const slots = queue.slots.filter(slot => {
      if (!plain(slot) || !HASH.test(slot.runId) || seen.has(slot.runId)) {invalid = true; return true;}
      seen.add(slot.runId);
      const candidate = byRun.get(slot.runId);
      if (!candidate || slot.timeMs !== candidate.binding.timeMs) return true;
      if (!integer(slot.leaseUntil) || slot.leaseUntil > at) return true;
      matched.add(slot.runId); released += candidate.replayLength; return false;
    });
    if (invalid || released > queue.replayBytes) {report.stopped = 'invalid_queue'; report.periods.push({periodId, status:'invalid_queue'}); break;}
    if (!matched.size) {report.periods.push({periodId, status:'unchanged'}); continue;}
    const write = {update:{name:BASE + QUEUES + '/' + periodId,
      fields:encode({slots, replayBytes:queue.replayBytes - released}).mapValue.fields},
      updateMask:{fieldPaths:['slots', 'replayBytes']}, currentDocument:{updateTime:document.updateTime}};
    demand(Buffer.byteLength(JSON.stringify(write)) <= 800000, 'queue write document budget');
    report.counts.writeAttempts++;
    let committed;
    try {committed = await db.call(':commit', {writes:[write]});} catch (error) {
      if (conflict(error)) {report.periods.push({periodId, status:'conflict_deferred'}); continue;}
      report.stopped = quota(error) ? 'quota' : 'unknown_commit';
      report.periods.push({periodId, status:report.stopped}); break;
    }
    if (!Array.isArray(committed?.writeResults) || committed.writeResults.length !== 1 ||
      !timestamp(committed.writeResults[0]?.updateTime) || committed.writeResults[0]?.error || !timestamp(committed.commitTime)) {
      report.stopped = 'unknown_commit'; report.periods.push({periodId, status:'unknown_commit'}); break;
    }
    report.counts.removedRuns += matched.size; report.counts.periodsAcknowledged++;
    report.periods.push({periodId, status:'acknowledged', removedRuns:matched.size, releasedReplayBytes:released});
  }
  report.periodsDeferred = periods.length - report.periods.length;
  return report;
}

/** CLI gate: exact remote default-branch tip, not merely a successful earlier push. */
export function verifyPublishedNativeEventCommit(input, {env = process.env, run = execFileSync} = {}) {
  const branch = env.DEFAULT_BRANCH;
  demand(env.GITHUB_REPOSITORY === REPOSITORY && env.GITHUB_REF_PROTECTED === 'true' &&
    typeof branch === 'string' && /^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(branch) &&
    env.GITHUB_REF === 'refs/heads/' + branch && env.NATIVE_EVENT_QUEUE_ACK_APPROVED === 'true' &&
    env.NATIVE_ACCEPTED_RESULTS_RETENTION_VALIDATED === 'true' && env.NATIVE_EVENT_ACCEPTED_BEST_ADMISSION_VALIDATED === 'true' &&
    env.NATIVE_EVENT_FRESH_HOLD_FENCES_VALIDATED === 'true',
    'protected canonical workflow/parent approval, accepted-best admission and fresh hold-fence validation required');
  const git = args => String(run('git', args, {cwd:input.root, encoding:'utf8', timeout:30000,
    env:{...env, GIT_TERMINAL_PROMPT:'0'}, stdio:['ignore', 'pipe', 'pipe']})).trim();
  demand(fs.realpathSync(git(['rev-parse', '--show-toplevel'])) === fs.realpathSync(input.root), 'canonical repository root required');
  const remote = git(['remote', 'get-url', 'origin']);
  demand(['https://github.com/' + REPOSITORY + '.git', 'https://github.com/' + REPOSITORY,
    'git@github.com:' + REPOSITORY + '.git'].includes(remote), 'canonical origin required');
  demand(git(['status', '--porcelain', '--untracked-files=no']) === '', 'tracked worktree must match published commit');
  demand(git(['rev-parse', 'HEAD']) === input.publishedCommit && git(['rev-parse', 'HEAD^']) === input.sourceCommit, 'published/source commit mismatch');
  const remoteTip = git(['ls-remote', '--exit-code', 'origin', 'refs/heads/' + branch]).split(/\s+/);
  demand(remoteTip.length === 2 && remoteTip[0] === input.publishedCommit && remoteTip[1] === 'refs/heads/' + branch, 'exact protected remote publication not established');
  return {...input, published:true, acceptedResultsRetained:true, acceptedBestAdmissionCompatible:true, freshHoldFencesValidated:true};
}

async function connectCliDb(env, readLimit, writeLimit) {
  // Called only after publication + proof validation. Offline native work never needs this secret.
  const raw = env.FIREBASE_VERIFIER_SERVICE_ACCOUNT;
  demand(typeof raw === 'string' && raw.length > 0, 'ACK-step service account required');
  const credentials = JSON.parse(raw);
  demand(credentials.project_id === 'polytrack-052' && typeof credentials.client_email === 'string' && typeof credentials.private_key === 'string', 'canonical Firebase project required');
  const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url'), seconds = Math.floor(Date.now() / 1000);
  const unsigned = b64({alg:'RS256', typ:'JWT'}) + '.' + b64({iss:credentials.client_email,
    scope:'https://www.googleapis.com/auth/datastore', aud:'https://oauth2.googleapis.com/token', iat:seconds, exp:seconds + 1800});
  const assertion = unsigned + '.' + sign('RSA-SHA256', Buffer.from(unsigned), credentials.private_key).toString('base64url');
  const response = await fetch('https://oauth2.googleapis.com/token', {method:'POST',
    body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion}), signal:AbortSignal.timeout(20000)});
  demand(response.ok, 'ACK authentication failed');
  const access = (await response.json()).access_token; demand(typeof access === 'string' && access.length > 0, 'ACK access token missing');
  const {createFirestoreCaller, decode} = await import('./verifier/firestore.mjs');
  const caller = createFirestoreCaller({base:'https://firestore.googleapis.com/v1/' + BASE.slice(0, -1), access,
    mode:'manual', maxReadRetries:0, documentReadLimit:readLimit, documentWriteLimit:writeLimit});
  return {call:(endpoint, body) => caller.call(endpoint, body), get:async (collection, id) => {
    demand(collection === QUEUES && PERIOD.test(id), 'queue-only DB read required');
    const document = await caller.call('/' + collection + '/' + encodeURIComponent(id));
    return document ? {...document, data:decode({mapValue:{fields:document.fields || {}}})} : null;
  }};
}

export async function runNativeEventQueueAckCli({argv = process.argv.slice(2), env = process.env,
  publicationGate = input => verifyPublishedNativeEventCommit(input, {env}), connectDb = () => connectCliDb(env, 16, 8)} = {}) {
  demand(argv.includes('--execute'), 'explicit --execute required after tests and parent approval');
  const options = new Map();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--execute') continue;
    demand(['--root', '--receipt', '--receipt-hash', '--published-commit'].includes(argv[i]) && !options.has(argv[i]) && typeof argv[i + 1] === 'string' && !argv[i + 1].startsWith('--'), 'CLI arguments');
    options.set(argv[i], argv[++i]);
  }
  const root = fs.realpathSync(options.get('--root') || process.cwd()), file = options.get('--receipt');
  demand(typeof file === 'string' && path.isAbsolute(file), 'absolute private receipt required');
  const target = fs.realpathSync(file), relative = path.relative(root, target);
  demand(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative), 'receipt must be outside public repository');
  const stat = fs.lstatSync(file); demand(stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_RECEIPT_BYTES, 'bounded private receipt required');
  return acknowledgeNativeEventQueues({root, receipt:JSON.parse(fs.readFileSync(file, 'utf8')),
    expectedReceiptHash:options.get('--receipt-hash'), publishedCommit:options.get('--published-commit'), publicationGate, connectDb});
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runNativeEventQueueAckCli().then(report => {console.log(JSON.stringify(report)); if (report.stopped) process.exitCode = 2;})
    .catch(() => {console.error('Native event queue ACK failed closed. No automatic retry; inspect private workflow diagnostics.'); process.exitCode = 1;});
}
