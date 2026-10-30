import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';

/**
 * Node-only offline authority format. This module never contacts a service or runs physics.
 * Trust boundary: createLedgerEntry receives a trusted private native result and a caller's
 * explicit review-complete attestation. Content hashes provide integrity, not signatures.
 * Public consumers must pin manifestHash from a trusted release/capture receipt.
 *
 * Source rows require accountId/trackId/replayHash (lowercase SHA-256), timeMs, frames
 * (or raceTimeFrames), uploadId, and lane. Normal sources without either frame field
 * use source timeMs. Missing normal-board frames are enriched from the exact current
 * canonical binding before lookup; explicit mismatched frames are never replaced.
 * Event rows additionally require periodId/runId;
 * use uploadId:null explicitly if that source has no upload identity. No legacy retiming.
 * Recording rows carry the same complete source identity plus replay bytes (UTF-8 string).
 *
 * Policy requires engineDigest, compatibleEngines (explicit digest array, possibly empty),
 * verifierVersion, verifierFingerprint, resourceProfiles, reviewPolicyVersions,
 * trackContentHashes:{[trackId]:hash}, and
 * trackGeometries:{[trackId]:{geometryPolicy,trackGeometry:{parts,spanX,spanZ}}}.
 * Review is exactly {complete:true,disposition:'approved'|'held'|'excluded',
 * bindingKey:ledgerKey(ledgerBinding(job)),policyVersion,attestationHash}.
 * The attestation hash must name the caller's private
 * completed review artifact, not merely a physics-cache hit or a client verification flag.
 * createLedgerEntry also requires verifiedAt: the caller's actual final review decision
 * timestamp, captured once after native proof and review complete, not physics start,
 * PB time, snapshot age, or import time. It must be a positive safe integer <= Date.now().
 * Every witness persists this field; timestamp-less entries fail closed. Approved
 * public rows use numeric verifiedState:1 and verificationStatus:'verified'; held or
 * excluded rows use numeric verifiedState:0 and their separate string status.
 * Public verifiedAt is the earliest compatible approval or valid existing public
 * verification timestamp when the row was already verified. Held/excluded rows clear it.
 *
 * writeLedger merges existing entries under an exclusive writer lock and manifest-hash CAS.
 * First write requires expectedManifestHash:null; subsequent writes require the last hash.
 * Its root is the dedicated public directory, normally <snapshot>/verification-ledger.
 * Failed writes never garbage-collect prior shards. A crash can leave .writer.lock;
 * operators must establish the writer is gone before removing it, never auto-steal a lock.
 * File contents are fsynced; atomic rename and directory-sync support depend on filesystem.
 * readLedger never trusts the public manifest's own claim about its hash.
 * applyLedgerToBoard takes a branded readLedger/writeLedger result, current source rows,
 * current recordings and explicit policy. It only sets verification metadata; callers must
 * recompute scores/standings and publish a new complete snapshot through their own gate.
 */
export const LEDGER_SCHEMA_VERSION = 1;
export const MAX_LEDGER_FILE_BYTES = 2 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_ENTRIES = 100000;
const MAX_REPLAY_BYTES = 8 * 1024 * 1024;
const trusted = new WeakMap();
const fail = message => {throw new Error('Native ledger: ' + message);};
const demand = (ok, message) => {if (!ok) fail(message);};
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const hash = value => createHash('sha256').update(value).digest('hex');
const integer = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => integer(value) && value > 0;
const decisionTime = value => positive(value) && value <= Date.now();

function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {demand(Number.isFinite(value), 'invalid number'); return JSON.stringify(value);}
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  demand(plain(value), 'invalid object');
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
const encode = value => Buffer.from(canonical(value) + '\n');
function exactKeys(value, keys) {
  demand(plain(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|'), 'unexpected schema fields');
}
function freeze(value) {
  if (value && typeof value === 'object') {Object.values(value).forEach(freeze); Object.freeze(value);}
  return value;
}

/** Strict source identity. Event callers explicitly use uploadId:null when no upload exists. */
export function ledgerBinding(row, lane = row?.lane) {
  demand(plain(row) && ['normal', 'event'].includes(lane), 'binding lane');
  const {accountId, trackId, timeMs, uploadId, replayHash} = row;
  const frames = row.frames ?? row.raceTimeFrames ?? (lane === 'normal' ? timeMs : undefined);
  demand(HASH.test(accountId) && HASH.test(trackId) && HASH.test(replayHash), 'binding hashes');
  demand(positive(timeMs) && timeMs <= 36000000 && positive(frames) && frames <= 36000000, 'binding timing');
  demand(row.frames === undefined || row.raceTimeFrames === undefined || row.frames === row.raceTimeFrames, 'conflicting frames');
  demand(integer(uploadId) || lane === 'event' && uploadId === null, 'binding upload');
  const binding = {lane, accountId, trackId, timeMs, frames, uploadId, replayHash};
  if (lane === 'event') {
    demand(typeof row.periodId === 'string' && TOKEN.test(row.periodId) && HASH.test(row.runId), 'event identity');
    binding.periodId = row.periodId; binding.runId = row.runId;
  } else demand(row.periodId === undefined && row.runId === undefined, 'normal event identity');
  return binding;
}
export const ledgerKey = binding => hash(canonical(ledgerBinding(binding)));

function reviewValue(review) {
  exactKeys(review, ['complete', 'disposition', 'bindingKey', 'policyVersion', 'attestationHash']);
  demand(review.complete === true && ['approved', 'held', 'excluded'].includes(review.disposition), 'explicit review-complete required');
  demand(TOKEN.test(review.policyVersion) && HASH.test(review.attestationHash) && HASH.test(review.bindingKey), 'review attestation');
  return {...review};
}
function geometryValue(geometry) {
  exactKeys(geometry, ['parts', 'spanX', 'spanZ']);
  demand(integer(geometry.parts) && geometry.parts <= 1000000 && ['spanX', 'spanZ'].every(key =>
    typeof geometry[key] === 'number' && Number.isFinite(geometry[key]) && geometry[key] >= 0 && geometry[key] <= 1000000), 'geometry');
  return {...geometry};
}
function witnessValue(witness) {
  exactKeys(witness, ['engineDigest', 'verifierVersion', 'verifierFingerprint', 'resourceProfile', 'nativeTrackId',
    'trackContentHash', 'geometryPolicy', 'trackGeometry', 'deterministic', 'status', 'reason', 'review', 'verifiedAt']);
  demand(decisionTime(witness.verifiedAt), 'actual final review timestamp required');
  demand(HASH.test(witness.engineDigest) && TOKEN.test(witness.verifierVersion) && HASH.test(witness.verifierFingerprint), 'witness engine');
  demand(HASH.test(witness.nativeTrackId) && HASH.test(witness.trackContentHash), 'witness track');
  demand(['standard', 'extended-local'].includes(witness.resourceProfile) && ['default', 'reviewed-pinned'].includes(witness.geometryPolicy), 'witness policy');
  demand(witness.deterministic === true && witness.status === 'verified' && witness.reason === 'native_exact_finish', 'native physics witness');
  return {...witness, trackGeometry: geometryValue(witness.trackGeometry), review: reviewValue(witness.review)};
}
function entryValue(entry) {
  exactKeys(entry, ['schemaVersion', 'key', 'binding', 'witnesses']);
  demand(entry.schemaVersion === 1, 'schema version');
  const binding = ledgerBinding(entry.binding);
  exactKeys(entry.binding, Object.keys(binding));
  demand(entry.key === ledgerKey(binding), 'entry key');
  demand(Array.isArray(entry.witnesses) && entry.witnesses.length > 0 && entry.witnesses.length <= 128, 'witness count');
  const witnesses = entry.witnesses.map(witnessValue);
  demand(witnesses.every(w => w.nativeTrackId === binding.trackId && w.review.bindingKey === entry.key), 'native track/review identity');
  const unique = new Map(witnesses.map(w => [canonical(w), w]));
  demand(unique.size <= 64, 'witness count');
  return {schemaVersion:1, key:entry.key, binding, witnesses:[...unique].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, w]) => w)};
}
function policyValue(policy) {
  demand(plain(policy) && HASH.test(policy.engineDigest) && Array.isArray(policy.compatibleEngines) && policy.compatibleEngines.length <= 32, 'explicit engine policy');
  const accepted = [policy.engineDigest, ...policy.compatibleEngines];
  demand(accepted.every(d => HASH.test(d)) && TOKEN.test(policy.verifierVersion) && HASH.test(policy.verifierFingerprint), 'engine compatibility');
  demand(plain(policy.trackContentHashes) && plain(policy.trackGeometries) && Array.isArray(policy.reviewPolicyVersions) &&
    policy.reviewPolicyVersions.length > 0 && policy.reviewPolicyVersions.every(v => TOKEN.test(v)), 'track/review policy');
  demand(Array.isArray(policy.resourceProfiles) && policy.resourceProfiles.length > 0 && policy.resourceProfiles.every(p => ['standard', 'extended-local'].includes(p)), 'resource policy');
  return policy;
}

export function nativePolicyFingerprint(policy) {
  policyValue(policy);
  const keys=['engineDigest','compatibleEngines','verifierVersion','verifierFingerprint',
    'resourceProfiles','reviewPolicyVersions','trackContentHashes','trackGeometries'];
  return hash(encode(Object.fromEntries(keys.map(key=>[key,policy[key]]))));
}
function compatible(w, binding, policy) {
  return [policy.engineDigest, ...policy.compatibleEngines].includes(w.engineDigest) &&
    w.verifierVersion === policy.verifierVersion && w.verifierFingerprint === policy.verifierFingerprint &&
    policy.resourceProfiles.includes(w.resourceProfile) && policy.reviewPolicyVersions.includes(w.review.policyVersion) &&
    policy.trackContentHashes[binding.trackId] === w.trackContentHash &&
    canonical(policy.trackGeometries[binding.trackId] ?? null) === canonical({geometryPolicy:w.geometryPolicy, trackGeometry:w.trackGeometry});
}
function actualReplay(replay, expected) {
  demand(typeof replay === 'string' && Buffer.byteLength(replay) <= MAX_REPLAY_BYTES && replay.length > 0 && hash(replay) === expected, 'actual replay SHA-256');
}

/** Caller supplies the raw native result, reviewed outcome, and explicit review attestation. */
export function createLedgerEntry({job, result, nativeResult = result, review, verifiedAt, lane, policy} = {}) {
  demand(decisionTime(verifiedAt), 'actual final review timestamp required');
  policyValue(policy);
  const binding = ledgerBinding(job, lane ?? job?.lane);
  const expectedId = binding.lane === 'normal' ? binding.accountId + '_' + binding.trackId : binding.runId;
  demand(job.resultId === expectedId, 'job result identity');
  actualReplay(job.replay, binding.replayHash);
  const b = nativeResult?.binding;
  demand(plain(b) && nativeResult.resultId === expectedId && nativeResult.trackId === binding.trackId &&
    nativeResult.timeMs === binding.timeMs && nativeResult.replayHash === binding.replayHash &&
    b.resultId === expectedId && b.trackId === binding.trackId && b.nativeTrackId === binding.trackId &&
    b.timeMs === binding.timeMs && b.replayHash === binding.replayHash && b.actualReplayHash === hash(job.replay) &&
    b.trackContentHash === nativeResult.trackContentHash && b.engineDigest === nativeResult.engineDigest &&
    nativeResult.deterministic === true && nativeResult.status === 'verified' && nativeResult.reason === 'native_exact_finish', 'native result binding');
  demand((job.resourceProfile ?? 'standard') === b.resourceProfile &&
    nativeResult.boundInputFingerprint === hash(JSON.stringify(b)), 'native input fingerprint');
  if (nativeResult.boundinputfingerprint !== undefined) demand(nativeResult.boundinputfingerprint === nativeResult.boundInputFingerprint, 'conflicting fingerprint');
  demand(result?.resultId === expectedId && result.trackId === binding.trackId && result.timeMs === binding.timeMs &&
    result.replayHash === binding.replayHash && result.engineDigest === nativeResult.engineDigest &&
    result.trackContentHash === nativeResult.trackContentHash && canonical(result.binding) === canonical(b), 'reviewed result binding');
  const checkedReview = reviewValue(review);
  demand(checkedReview.bindingKey === ledgerKey(binding), 'review binding');
  demand(checkedReview.disposition === 'approved' ? result.status === 'verified' && result.reason === 'native_exact_finish' :
    ['unavailable', 'mismatch'].includes(result.status), 'review/result disposition');
  if (checkedReview.disposition === 'approved') demand(!blocked(job) && !blocked(result), 'review hold conflicts with approval');
  const witness = witnessValue({engineDigest:b.engineDigest, verifierVersion:b.verifierVersion,
    verifierFingerprint:b.verifierFingerprint, resourceProfile:b.resourceProfile,
    nativeTrackId:b.nativeTrackId, trackContentHash:b.trackContentHash,
    geometryPolicy:nativeResult.geometryPolicy, trackGeometry:nativeResult.trackGeometry,
    deterministic:true, status:'verified', reason:'native_exact_finish', review:checkedReview, verifiedAt});
  demand(compatible(witness, binding, policy), 'incompatible proof policy');
  return freeze(entryValue({schemaVersion:1, key:ledgerKey(binding), binding, witnesses:[witness]}));
}

/** Commutative union: holds/exclusions cannot be erased by later verified entries. */
export function mergeLedgerEntries(...groups) {
  const entries = new Map();
  for (const group of groups) {
    demand(Array.isArray(group) && group.length <= MAX_ENTRIES, 'entry limit');
    for (const value of group) {
      const next = entryValue(value), old = entries.get(next.key);
      if (old) next.witnesses.push(...old.witnesses);
      entries.set(next.key, entryValue(next));
      demand(entries.size <= MAX_ENTRIES, 'ledger entry limit');
    }
  }
  return freeze([...entries.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export function ledgerDisposition(entry) {
  const reviews = entryValue(entry).witnesses.map(w => w.review.disposition);
  return reviews.includes('excluded') ? 'excluded' : reviews.includes('held') ? 'held' : 'verified';
}

function syncDirectory(directory) {
  try {const fd = fs.openSync(directory, 'r'); try {fs.fsyncSync(fd);} finally {fs.closeSync(fd);}} catch (error) {
    if (!['EPERM', 'EACCES', 'EISDIR', 'EINVAL'].includes(error.code)) throw error;
  }
}

function safeDirectory(root) {
  demand(typeof root === 'string' && path.isAbsolute(root), 'absolute ledger root required');
  demand(fs.lstatSync(root).isDirectory() && !fs.lstatSync(root).isSymbolicLink(), 'unsafe root');
  return fs.realpathSync(root);
}
function fileBytes(file) {
  const stat = fs.lstatSync(file);
  demand(stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_LEDGER_FILE_BYTES, 'unsafe/oversized ledger file');
  const data = fs.readFileSync(file);
  demand(data.length <= MAX_LEDGER_FILE_BYTES, 'oversized ledger file');
  return data;
}
function parse(data) {
  const value = JSON.parse(data.toString('utf8'));
  demand(encode(value).equals(data), 'noncanonical JSON');
  return value;
}
function manifestValue(manifest) {
  exactKeys(manifest, ['schemaVersion', 'kind', 'entries', 'shards']);
  demand(manifest.schemaVersion === 1 && manifest.kind === 'native-verification-ledger' && integer(manifest.entries) &&
    manifest.entries <= MAX_ENTRIES && Array.isArray(manifest.shards) && manifest.shards.length <= 1024, 'manifest');
  let total = 0, last = '';
  for (const shard of manifest.shards) {
    exactKeys(shard, ['hash', 'bytes', 'entries', 'firstKey', 'lastKey']);
    demand(HASH.test(shard.hash) && positive(shard.bytes) && shard.bytes <= MAX_LEDGER_FILE_BYTES && positive(shard.entries) &&
      HASH.test(shard.firstKey) && HASH.test(shard.lastKey) && shard.firstKey <= shard.lastKey && last < shard.firstKey, 'shard descriptor');
    total += shard.entries; last = shard.lastKey;
  }
  demand(total === manifest.entries, 'manifest entry count');
  return manifest;
}
/** expectedManifestHash is an external trust anchor, not a value obtained from the untrusted manifest. */
export function readLedger({root, expectedManifestHash} = {}) {
  demand(HASH.test(expectedManifestHash), 'pinned manifest hash required');
  root = safeDirectory(root);
  const bytes = fileBytes(path.join(root, 'manifest.json'));
  demand(hash(bytes) === expectedManifestHash, 'manifest hash');
  const manifest = manifestValue(parse(bytes));
  const dir = path.join(root, 'shards');
  safeDirectory(dir);
  const entries = [];
  for (const descriptor of manifest.shards) {
    const data = fileBytes(path.join(dir, descriptor.hash + '.json'));
    demand(data.length === descriptor.bytes && hash(data) === descriptor.hash, 'shard hash');
    const shard = parse(data);
    exactKeys(shard, ['schemaVersion', 'entries']);
    demand(shard.schemaVersion === 1 && Array.isArray(shard.entries), 'shard schema');
    const checked = mergeLedgerEntries(shard.entries);
    demand(canonical(checked) === canonical(shard.entries) && checked.length === descriptor.entries &&
      checked[0]?.key === descriptor.firstKey && checked.at(-1)?.key === descriptor.lastKey, 'shard ordering/count');
    entries.push(...checked);
  }
  demand(entries.length === manifest.entries, 'ledger completeness');
  const ledger = freeze({schemaVersion:1, manifestHash:expectedManifestHash, entries});
  trusted.set(ledger, new Map(entries.map(entry => [entry.key, entry])));
  return ledger;
}

function durableFile(file, bytes, exclusive = true) {
  const fd = fs.openSync(file, exclusive ? 'wx' : 'w', 0o600);
  try {fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
}
/** CAS on manifest hash + exclusive writer lock. Existing entries are always unioned, never replaced. */
export function writeLedger({root, entries, expectedManifestHash, maxFileBytes = MAX_LEDGER_FILE_BYTES} = {}) {
  demand(integer(maxFileBytes) && maxFileBytes >= 2048 && maxFileBytes <= MAX_LEDGER_FILE_BYTES, 'file byte limit');
  demand(typeof root === 'string' && path.isAbsolute(root), 'absolute ledger root required');
  fs.mkdirSync(root, {recursive:true}); root = safeDirectory(root);
  const lock = path.join(root, '.writer.lock');
  const lockFd = fs.openSync(lock, 'wx', 0o600);
  let temporary;
  try {
    const current = path.join(root, 'manifest.json');
    const exists = fs.existsSync(current);
    demand(exists ? HASH.test(expectedManifestHash) : expectedManifestHash === null, 'manifest CAS required');
    const previous = exists ? readLedger({root, expectedManifestHash}).entries : [];
    const merged = mergeLedgerEntries(previous, entries);
    const dir = path.join(root, 'shards'); fs.mkdirSync(dir, {recursive:true}); safeDirectory(dir);
    const groups = []; let group = [], groupBytes = encode({schemaVersion:1, entries:[]}).length;
    for (const entry of merged) {
      const entryBytes = Buffer.byteLength(canonical(entry));
      if (groupBytes + entryBytes + Number(group.length > 0) > maxFileBytes) {
        demand(group.length > 0, 'entry exceeds file limit'); groups.push(group); group = [];
        groupBytes = encode({schemaVersion:1, entries:[]}).length;
      }
      groupBytes += entryBytes + Number(group.length > 0);
      group.push(entry);
      demand(groupBytes <= maxFileBytes, 'entry exceeds file limit');
    }
    if (group.length) groups.push(group);
    const shards = groups.map(values => {
      const bytes = encode({schemaVersion:1, entries:values}), digest = hash(bytes), file = path.join(dir, digest + '.json');
      if (fs.existsSync(file)) demand(fileBytes(file).equals(bytes), 'immutable shard conflict');
      else {
        temporary = path.join(dir, '.stage-' + randomUUID()); durableFile(temporary, bytes);
        fs.renameSync(temporary, file); temporary = undefined;
      }
      return {hash:digest, bytes:bytes.length, entries:values.length, firstKey:values[0].key, lastKey:values.at(-1).key};
    });
    const manifest = manifestValue({schemaVersion:1, kind:'native-verification-ledger', entries:merged.length, shards});
    const bytes = encode(manifest); demand(bytes.length <= maxFileBytes, 'manifest exceeds file limit');
    syncDirectory(dir);
    temporary = path.join(root, '.manifest-' + randomUUID()); durableFile(temporary, bytes);
    fs.renameSync(temporary, current); temporary = undefined;
    syncDirectory(root);
    return readLedger({root, expectedManifestHash:hash(bytes)});
  } finally {
    if (temporary && fs.existsSync(temporary)) fs.unlinkSync(temporary);
    fs.closeSync(lockFd); fs.unlinkSync(lock);
  }
}

function blocked(row) {
  return row.needsReview === true || row.reviewHold === true || row.excluded === true || row.unscored === true ||
    ['status', 'verificationStatus', 'validationState', 'verifiedState'].some(key =>
      typeof row[key] === 'string' && /(?:held|hold|review|excluded|rejected|mismatch|unavailable_final)/.test(row[key])) ||
    typeof row.reason === 'string' && /(?:review|hold|excluded|rejected)/.test(row.reason);
}
function uniqueRows(rows, lane) {
  demand(Array.isArray(rows) && rows.length <= MAX_ENTRIES, 'current source rows');
  const map = new Map(), identities = new Set();
  for (const row of rows) {
    const binding = ledgerBinding(row, lane), key = ledgerKey(binding);
    const identity = canonical([binding.lane, binding.accountId, binding.trackId, binding.periodId ?? null, binding.runId ?? null]);
    demand(!identities.has(identity), 'duplicate current identity'); identities.add(identity); map.set(key, row);
  }
  return map;
}
/** Pure overlay, not ranking or a DB write. Caller must recompute scoring with existing project code. */
export function applyLedgerToBoard({board, ledger, canonicalRows, recordings, policy, lane = 'normal'} = {}) {
  policyValue(policy);
  demand(trusted.has(ledger), 'ledger must be loaded through pinned readLedger/writeLedger');
  demand(plain(board) && Array.isArray(board.entries) && board.entries.length <= MAX_ENTRIES, 'exported board');
  const current = uniqueRows(canonicalRows, lane), media = uniqueRows(recordings, lane);
  const normalSources = new Map(lane === 'normal' ? [...current.values()].map(row => [row.accountId + '_' + row.trackId, row]) : []);
  const report = {verified:0, held:0, excluded:0, skipped:0};
  const output = structuredClone(board);
  output.entries = output.entries.map(row => {
    if (lane === 'normal' && row.frames === undefined && row.raceTimeFrames === undefined) {
      const source = normalSources.get(row.accountId + '_' + row.trackId);
      if (source && ['timeMs', 'uploadId', 'replayHash'].every(field => row[field] === source[field])) {
        row = {...row, frames:ledgerBinding(source, lane).frames};
      }
    }
    let binding;
    try {binding = ledgerBinding(row, lane);} catch {report.skipped++; return row;}
    if (board.trackId !== undefined && board.trackId !== binding.trackId || lane === 'event' && board.periodId !== binding.periodId) {report.skipped++; return row;}
    const key = ledgerKey(binding), entry = trusted.get(ledger).get(key), source = current.get(key), recording = media.get(key);
    if (!entry || !source || !recording) {report.skipped++; return row;}
    try {actualReplay(recording.replay, binding.replayHash);} catch {report.skipped++; return row;}
    // Holds remain authoritative across compatible-engine changes; incompatible approvals never promote.
    const state = ledgerDisposition(entry);
    const disposition = state === 'excluded' ? 'excluded' :
      blocked(source) || blocked(recording) || blocked(row) || state === 'held' ? 'held' : 'approved';
    if (disposition !== 'approved') {
      report[disposition]++;
      return {...row, runVerified:false, verified:false, verifiedState:0, verificationStatus:disposition, verifiedAt:null,
        ...(disposition === 'held' ? {needsReview:true} : {excluded:true}), nativeLedgerKey:key};
    }
    const approvals = entry.witnesses.filter(w => w.review.disposition === 'approved' && compatible(w, binding, policy));
    if (!approvals.length) {report.skipped++; return row;}
    let verifiedAt = Math.min(...approvals.map(w => w.verifiedAt));
    if ((Number(row.verifiedState) === 1 || row.runVerified === true || row.verified === true) && decisionTime(row.verifiedAt)) {
      verifiedAt = Math.min(verifiedAt, row.verifiedAt);
    }
    report.verified++;
    return {...row, integrityVerified:true, runVerified:true, verified:true, verifiedState:1,
      verificationStatus:'verified', verifiedAt, nativeLedgerKey:key, nativeLedgerManifestHash:ledger.manifestHash};
  });
  return {board:output, report};
}
