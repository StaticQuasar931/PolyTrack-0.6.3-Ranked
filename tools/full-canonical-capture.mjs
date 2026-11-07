import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {canonicalBindingSignature} from './reconcile-captured-canonical.mjs';
import {validatePublicReplayForPublication} from './public-replay-playback.mjs';
import {publicDisplayName} from './public-display-name.mjs';
import {rankTrustedTrackEntries} from '../workers/ranked/src/index.js';
import {buildTrackStatistics} from './snapshot-package.mjs';
import {ledgerBinding, ledgerKey} from './native-verification-ledger.mjs';

export const FULL_CANONICAL_LIMITS = Object.freeze({documents: 10000, page: 100,
  memoryBytes: 64 * 1024 * 1024, fileBytes: 2 * 1024 * 1024});
const COLLECTION = '0.6.2_race_results';
const HASH = /^[a-f0-9]{64}$/;
const DATE_FIELDS = ['createdAt', 'pbAt', 'updatedAt', 'ingestedAt'];
const HOLD_FIELDS = ['needsReview', 'reviewHold', 'excluded', 'unscored'];
const STATUS_FIELDS = ['verificationStatus', 'validationState', 'status'];
const PLAYABLE = ['pending', 'waiting', 'unchecked', 'unverified', 'integrity', 'verified'];
const HELD = ['held', 'hold', 'review', 'needs_review', 'excluded', 'rejected', 'mismatch', 'unavailable_final'];
export const FULL_CANONICAL_FIELDS = Object.freeze(['accountId', 'trackId', 'name', 'nickname', 'countryCode',
  'timeMs', 'frames', 'raceTimeFrames', 'uploadId', 'verified', 'verifiedState', ...DATE_FIELDS,
  'carStyle', 'replay', 'replayHash', ...STATUS_FIELDS, ...HOLD_FIELDS]);
const PUBLIC_FIELDS = ['accountId', 'trackId', 'uploadId', 'frames', 'raceTimeFrames', 'timeMs', 'replayHash',
  'name', 'nickname', 'countryCode', 'carStyle', ...DATE_FIELDS, 'ingestedAtSource',
  'verified', 'runVerified', 'integrityVerified', 'verifiedState', 'playbackPending', 'eventRpEligible',
  ...STATUS_FIELDS, ...HOLD_FIELDS, 'verifiedAt', 'nativeLedgerKey', 'nativeLedgerManifestHash',
  'physicsVerified', 'replayIntegrityVerified', 'rank', 'position', 'fieldSize', 'weight', 'competition',
  'timingVersion', 'originalTimeMs', 'originalRank', 'unranked', 'identityUpdatedAt', 'carId', 'carColors',
  'accountCreatedAt', 'totalPlaytimeMs', 'pbCount', 'rankModel'];
const COSMETICS = ['version', 'theme', 'accent', 'finish', 'plate', 'edge', 'stageTint', 'stage',
  'stageEffect', 'stripe', 'emblem', 'emblem2', 'emblem3', 'emblemBackdrop', 'nameFont', 'nameSize',
  'nameWeight', 'nameColor', 'baseSecondary', 'title', 'badge', 'favoriteTrackId', 'overridePodium'];
const BOARD_FIELDS = ['trackId', 'updatedAt', 'builtAt', 'schemaVersion', 'algorithmVersion', 'revision', 'sourceRevision'];
const NATIVE_STATUS_FIELDS = ['verified', 'runVerified', 'integrityVerified', 'verifiedState', 'verificationStatus',
  'validationState', 'verifiedAt', 'needsReview', 'reviewHold', 'excluded', 'unscored', 'playbackPending'];
const sha = value => createHash('sha256').update(value).digest('hex');
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const positive = n => Number.isSafeInteger(n) && n > 0;
const active = new Set();

function fail(reason, deferred = false) {
  throw Object.assign(Error(`Full canonical capture stopped: ${reason}`), {code: 'FULL_CANONICAL_CAPTURE', reason, deferred});
}
function demand(condition, reason) { if (!condition) fail(reason); }
function timestamp(value) {
  const match = typeof value === 'string' && /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(value);
  const ms = match && Date.parse(`${match[1]}Z`);
  demand(Number.isFinite(ms) && ms > 0 && new Date(ms).toISOString().slice(0, 19) === match[1], 'invalid_timestamp');
  return BigInt(ms) * 1000000n + BigInt((match[2] || '').padEnd(9, '0'));
}
function date(value) {
  if (typeof value === 'number') demand(positive(value) && value <= 8640000000000000, 'invalid_date');
  else timestamp(value);
}
function scalar(value) {
  return typeof value === 'string' && value.length <= 256 || typeof value === 'boolean' ||
    typeof value === 'number' && Number.isFinite(value) || value === null;
}
function project(row, fields = PUBLIC_FIELDS) {
  const out = {};
  for (const key of fields) if (Object.hasOwn(row, key)) {
    demand(scalar(row[key]), 'invalid_public_metadata');
    out[key] = ['name', 'nickname'].includes(key) ? publicDisplayName(row[key]) : row[key];
  }
  if (fields === PUBLIC_FIELDS && Object.hasOwn(row, 'profileCosmetics')) {
    demand(plain(row.profileCosmetics), 'invalid_cosmetics');
    out.profileCosmetics = project(row.profileCosmetics, COSMETICS);
  }
  return out;
}
function binding(row, source = false) {
  try { canonicalBindingSignature(row); } catch { fail('invalid_binding'); }
  demand(positive(row.timeMs), 'invalid_time');
  for (const key of DATE_FIELDS) if (Object.hasOwn(row, key) && (source || row[key] !== 0)) date(row[key]);
  for (const key of ['name', 'nickname', 'countryCode', 'carStyle']) if (Object.hasOwn(row, key)) {
    // Existing public boards use null for an unspecified country. This does not
    // make names, car styles, binding fields, or status fields nullable.
    demand(key === 'countryCode' && row[key] === null ||
      typeof row[key] === 'string' && row[key].length <= 256, 'invalid_public_metadata');
  }
  for (const key of HOLD_FIELDS) if (Object.hasOwn(row, key)) demand(typeof row[key] === 'boolean', 'invalid_hold');
  for (const key of STATUS_FIELDS) if (Object.hasOwn(row, key)) {
    demand([...PLAYABLE, ...HELD].includes(row[key]), 'invalid_status');
  }
  demand(row.verified === false && row.verifiedState === 0 || row.verified === true && row.verifiedState === 1,
    'invalid_verification_flags');
  return canonicalBindingSignature(row) + ':' + row.timeMs;
}
function holds(...rows) {
  const out = {};
  for (const row of rows.filter(Boolean)) {
    if (typeof row.reason === 'string' && /review|hold|excluded|rejected/.test(row.reason)) out.reviewHold = true;
    for (const key of HOLD_FIELDS) if (row[key] === true) out[key] = true;
    for (const key of STATUS_FIELDS) if (HELD.includes(row[key])) out[key] = row[key];
  }
  if (Object.keys(out).length) Object.assign(out, {needsReview: true, runVerified: false, verified: false,
    verifiedState: 0, eventRpEligible: false, playbackPending: true, verificationStatus: out.verificationStatus || 'held'});
  return out;
}
function pristineCompanions(row, source) {
  const out = {}, key = ledgerKey(ledgerBinding(source, 'normal'));
  if (row.nativeLedgerKey !== undefined) demand(row.nativeLedgerKey === key, 'saved_ledger_binding');
  for (const field of ['nativeLedgerSource', 'nativeLedgerBoardSource']) if (Object.hasOwn(row, field)) {
    const companion = row[field];
    demand(plain(companion) && companion.bindingKey === key && plain(companion.status), 'saved_ledger_companion');
    const status = project(companion.status, NATIVE_STATUS_FIELDS);
    for (const [name, value] of Object.entries(status)) {
      if (['verificationStatus', 'validationState'].includes(name)) demand([...PLAYABLE, ...HELD].includes(value), 'saved_ledger_status');
      else if (name === 'verifiedState') demand(value === 0 || value === 1, 'saved_ledger_status');
      else if (name === 'verifiedAt') demand(value === null || positive(value), 'saved_ledger_status');
      else demand(typeof value === 'boolean', 'saved_ledger_status');
    }
    demand(Object.keys(status).length > 0, 'saved_ledger_status');
    out[field] = {bindingKey: key, status};
  }
  if (Object.hasOwn(row, 'nativeLedger')) {
    const proof = row.nativeLedger;
    demand(plain(proof) && proof.authority === 'native-verification-ledger' && proof.bindingKey === key &&
      HASH.test(proof.manifestHash) && ['verified', 'pending', 'held', 'excluded'].includes(proof.disposition), 'saved_ledger_provenance');
    demand(row.nativeLedgerManifestHash === undefined || row.nativeLedgerManifestHash === proof.manifestHash, 'saved_ledger_provenance');
    out.nativeLedger = {authority: proof.authority, manifestHash: proof.manifestHash, bindingKey: key, disposition: proof.disposition};
  }
  return out;
}
async function replayBytes(text, row) {
  demand(typeof text === 'string' && text.length <= 262144 && sha(text) === row.replayHash, 'replay_hash');
  try {
    const proof = await validatePublicReplayForPublication(text, row.frames ?? row.raceTimeFrames);
    demand(proof.indexedPlaybackWithinBudget, 'replay_publication_budget');
  } catch (error) {
    if (error.code === 'FULL_CANONICAL_CAPTURE') throw error;
    fail('replay_structure');
  }
}
function decode(value) {
  demand(plain(value) && Object.keys(value).length === 1, 'invalid_firestore_value');
  if (Object.hasOwn(value, 'nullValue')) { demand(value.nullValue === null, 'invalid_null'); return null; }
  if (Object.hasOwn(value, 'stringValue')) { demand(typeof value.stringValue === 'string', 'invalid_string'); return value.stringValue; }
  if (Object.hasOwn(value, 'timestampValue')) { timestamp(value.timestampValue); return value.timestampValue; }
  if (Object.hasOwn(value, 'booleanValue')) { demand(typeof value.booleanValue === 'boolean', 'invalid_boolean'); return value.booleanValue; }
  if (Object.hasOwn(value, 'integerValue')) {
    demand(typeof value.integerValue === 'string' && /^-?(0|[1-9]\d*)$/.test(value.integerValue), 'invalid_integer');
    const n = Number(value.integerValue); demand(Number.isSafeInteger(n), 'invalid_integer'); return n;
  }
  fail('unsupported_firestore_value');
}

// Conservative owned-data accounting, not a process RSS limit. The injected
// transport must itself bound response decoding; it returns an already-built array.
function memoryBudget() {
  let used = 4 * 1024 * 1024, peak = used;
  return {claim(bytes) {
    if (used + bytes > FULL_CANONICAL_LIMITS.memoryBytes) fail('memory_cap', true);
    used += bytes; peak = Math.max(peak, used); let released = false;
    return () => { if (!released) { used -= bytes; released = true; } };
  }, peak: () => peak};
}
function objectSize(value, depth = 0) {
  if (depth > 12) fail('object_depth');
  if (typeof value === 'string') return 64 + value.length * 2;
  if (value === null || typeof value !== 'object') return 16;
  demand(Array.isArray(value) || plain(value), 'invalid_object');
  let size = 64;
  for (const [key, item] of Object.entries(value)) {
    size += 64 + key.length * 2 + objectSize(item, depth + 1);
    if (size > FULL_CANONICAL_LIMITS.memoryBytes / 2) fail('memory_cap', true);
  }
  return size;
}

async function checkedRoot(directory) {
  demand(typeof directory === 'string' && path.isAbsolute(directory), 'absolute_directory_required');
  const root = path.resolve(directory), base = path.parse(root).root;
  let current = base;
  for (const part of path.relative(base, root).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    demand(stat.isDirectory() && !stat.isSymbolicLink(), 'unsafe_directory');
  }
  demand((await fs.realpath(root)).toLowerCase() === root.toLowerCase(), 'unsafe_directory');
  return root;
}
async function checked(root, relative, directory = false) {
  demand(typeof relative === 'string' && relative.split('/').every(part => /^[A-Za-z0-9_.-]+$/.test(part) && !['.', '..'].includes(part)), 'unsafe_path');
  await checkedRoot(root);
  let current = root;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    try {
      const stat = await fs.lstat(current);
      demand(!stat.isSymbolicLink() && (i < parts.length - 1 || directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1), 'unsafe_path');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return current;
}
const inside = (a, b) => { const rel = path.relative(a, b); return !rel || !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel); };

// Validate the entire JSON stream but retain only three top-level scalars. The
// read-only overall input has its own cap; no row/output/checkpoint cap changes.
function overallMetadataParser() {
  const fields = new Set(['revision', 'sourceRevision', 'updatedAt']), result = {};
  const stack = []; let root = false, mode = '', token = '', capture = false, escape = false, unicode = 0;
  const invalid = () => fail('invalid_stage_json');
  function emit(type, value) {
    const top = stack.at(-1);
    if (top?.object && ['key', 'firstKey'].includes(top.state) && type === 'string') {
      top.key = value; top.state = 'colon'; return;
    }
    if (type === ':' && top?.state === 'colon') { top.state = 'value'; return; }
    if (type === ',' && top?.state === 'end') { top.state = top.object ? 'key' : 'value'; return; }
    if (type === '}' || type === ']') {
      if (!top || top.object !== (type === '}') || !['end', top.object ? 'firstKey' : 'firstValue'].includes(top.state)) invalid();
      stack.pop(); return;
    }
    if (top ? !['value', 'firstValue'].includes(top.state) : root || type !== '{') invalid();
    if (!['{', '[', 'string', 'scalar'].includes(type)) invalid();
    if (stack.length === 1 && fields.has(top.key)) {
      delete result[top.key];
      if (type === 'scalar' && Number.isSafeInteger(value)) result[top.key] = value;
    }
    if (top) top.state = 'end'; else root = true;
    if (type === '{' || type === '[') {
      if (stack.length >= 128) fail('overall_json_depth');
      stack.push({object: type === '{', state: type === '{' ? 'firstKey' : 'firstValue', key: null});
    }
  }
  function scalarToken() {
    let value;
    try { value = JSON.parse(token); } catch { invalid(); }
    if (value !== null && typeof value !== 'boolean' && typeof value !== 'number') invalid();
    emit('scalar', value); mode = ''; token = '';
  }
  return {push(text) {
    for (const c of text) {
      if (mode === 'string') {
        if (capture) { token += c; if (token.length > 1536) { capture = false; token = ''; } }
        if (unicode) { if (!/^[0-9a-fA-F]$/.test(c)) invalid(); unicode--; continue; }
        if (escape) { escape = false; if (c === 'u') unicode = 4; else if (!'"\\/bfnrt'.includes(c)) invalid(); continue; }
        if (c === '\\') { escape = true; continue; }
        if (c === '"') { emit('string', capture ? JSON.parse(token) : null); mode = ''; token = ''; continue; }
        if (c.charCodeAt(0) < 32) invalid();
        continue;
      }
      if (mode === 'scalar') {
        if (!' \t\r\n{}[],:"'.includes(c)) { token += c; if (token.length > 256) invalid(); continue; }
        scalarToken();
      }
      if (' \t\r\n'.includes(c)) continue;
      if (c === '"') {
        mode = 'string'; capture = stack.length === 1 && ['key', 'firstKey'].includes(stack[0].state);
        token = capture ? '"' : ''; continue;
      }
      if ('{}[],:'.includes(c)) emit(c);
      else { mode = 'scalar'; token = c; }
    }
  }, finish() {
    if (mode === 'scalar') scalarToken();
    if (mode || stack.length || !root) invalid();
    return result;
  }};
}

async function readOverallMetadata(root, memory, parse = true) {
  const release = memory.claim(1024 * 1024);
  let handle;
  try {
    const file = await checked(root, 'overall.json');
    try { handle = await fs.open(file, 'r'); } catch (error) { if (error.code === 'ENOENT') return {hash: null, value: null}; throw error; }
    const stat = await handle.stat();
    demand(stat.isFile() && stat.nlink === 1, 'unsafe_path');
    if (stat.size > 16 * 1024 * 1024) fail('overall_input_cap', true);
    const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
    const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}), parser = parse ? overallMetadataParser() : null;
    let total = 0;
    for (;;) {
      const {bytesRead} = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > 16 * 1024 * 1024) fail('overall_input_cap', true);
      const chunk = buffer.subarray(0, bytesRead); hash.update(chunk);
      if (parser) {
        let text; try { text = decoder.decode(chunk, {stream: true}); } catch { fail('invalid_stage_json'); }
        parser.push(text);
      }
    }
    demand(total === stat.size, 'file_changed');
    if (parser) {
      let text; try { text = decoder.decode(); } catch { fail('invalid_stage_json'); }
      parser.push(text);
    }
    return {hash: hash.digest('hex'), value: parser?.finish() ?? null};
  } finally { if (handle) await handle.close(); release(); }
}

async function transaction(root, checkpoint, memory) {
  const originals = new Map(), writes = new Map();
  let overallDependency;
  let serial = 0;
  async function stash(bytes) {
    const release = memory.claim(512 + (checkpoint ? 0 : bytes.length));
    const ref = {hash: sha(bytes), length: bytes.length, release};
    if (checkpoint) {
      ref.relative = `blob-${++serial}.json`;
      await fs.writeFile(await checked(checkpoint, ref.relative), bytes, {flag: 'wx', mode: 0o600});
    } else ref.bytes = bytes;
    return ref;
  }
  async function materialize(ref) {
    if (ref.bytes) return ref.bytes;
    const file = await checked(checkpoint, ref.relative), stat = await fs.lstat(file);
    demand(stat.size === ref.length && stat.size <= FULL_CANONICAL_LIMITS.fileBytes, 'checkpoint_changed');
    const bytes = await fs.readFile(file);
    demand(sha(bytes) === ref.hash, 'checkpoint_changed'); return bytes;
  }
  async function current(relative) {
    const file = await checked(root, relative);
    try {
      const stat = await fs.lstat(file);
      if (stat.size > FULL_CANONICAL_LIMITS.fileBytes) fail('file_cap', true);
      const bytes = await fs.readFile(file);
      demand(bytes.length === stat.size, 'file_changed'); return bytes;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function read(relative) {
    const scratch = memory.claim(FULL_CANONICAL_LIMITS.fileBytes * 2);
    try {
      const bytes = await current(relative);
      if (!originals.has(relative)) originals.set(relative, bytes === null ? null : await stash(bytes));
      else demand(bytes === null ? originals.get(relative) === null : originals.get(relative)?.hash === sha(bytes), 'stage_changed');
      if (bytes === null) return {value: null, release() {}};
      const release = memory.claim(bytes.length * 6 + 512);
      try { return {value: JSON.parse(bytes), release}; } catch { release(); fail('invalid_stage_json'); }
    } finally { scratch(); }
  }
  async function plan(relative, value) {
    if (!originals.has(relative)) { const old = await read(relative); old.release(); }
    const release = memory.claim(objectSize(value) * 2);
    try {
      const bytes = Buffer.from(JSON.stringify(value) + '\n');
      if (bytes.length > FULL_CANONICAL_LIMITS.fileBytes) fail('output_cap', true);
      const previous = originals.get(relative);
      const descriptor = {sha256: sha(bytes), bytes: bytes.length};
      if (previous?.hash === descriptor.sha256) return descriptor;
      demand(!writes.has(relative), 'duplicate_output');
      writes.set(relative, await stash(bytes));
      return descriptor;
    } finally { release(); }
  }
  async function storeRow(value) {
    const scratch = memory.claim(objectSize(value) * 2);
    try {
      const bytes = Buffer.from(JSON.stringify(value));
      if (bytes.length > FULL_CANONICAL_LIMITS.fileBytes) fail('output_cap', true);
      return await stash(bytes);
    } finally { scratch(); }
  }
  async function loadRow(ref) {
    const release = memory.claim(ref.length * 6 + 512);
    try { return {value: JSON.parse(await materialize(ref)), release}; }
    catch (error) { release(); throw error; }
  }
  async function unchanged(relative, ref) {
    const bytes = await current(relative);
    demand(ref === null ? bytes === null : bytes !== null && sha(bytes) === ref.hash, 'stage_changed');
  }
  async function commit() {
    const scratch = memory.claim(FULL_CANONICAL_LIMITS.fileBytes * 3);
    const temporary = [], committed = [], directories = [];
    try {
      if (overallDependency !== undefined) demand((await readOverallMetadata(root, memory, false)).hash === overallDependency, 'stage_changed');
      for (const [relative, ref] of originals) {
        await unchanged(relative, ref);
        if (ref) await materialize(ref);
      }
      for (const ref of writes.values()) await materialize(ref);
      for (const [relative, ref] of writes) {
        const parts = relative.split('/');
        for (let i = 1; i < parts.length; i++) {
          const dir = parts.slice(0, i).join('/'), target = await checked(root, dir, true);
          try { await fs.mkdir(target); directories.push(dir); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        }
        const temp = `${relative}.${randomUUID()}.tmp`;
        temporary.push(temp);
        await fs.writeFile(await checked(root, temp), await materialize(ref), {flag: 'wx', mode: 0o600});
      }
      let i = 0;
      for (const [relative, ref] of writes) {
        await unchanged(relative, originals.get(relative));
        await fs.rename(await checked(root, temporary[i++]), await checked(root, relative));
        committed.push([relative, ref]);
      }
    } catch (error) {
      let rollbackFailed = false;
      for (const [relative, ref] of committed.reverse()) {
        try {
          await unchanged(relative, ref);
          const old = originals.get(relative), target = await checked(root, relative);
          if (old === null) await fs.unlink(target);
          else {
            const temp = `${relative}.${randomUUID()}.tmp`; temporary.push(temp);
            await fs.writeFile(await checked(root, temp), await materialize(old), {flag: 'wx', mode: 0o600});
            await fs.rename(await checked(root, temp), await checked(root, relative));
          }
        } catch { rollbackFailed = true; }
      }
      if (rollbackFailed) fail('rollback_failed');
      throw error;
    } finally {
      for (const relative of temporary) {
        try { await fs.unlink(await checked(root, relative)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      for (const dir of directories.reverse()) {
        try { await fs.rmdir(await checked(root, dir, true)); } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
      }
      scratch();
    }
  }
  return {read, plan, storeRow, loadRow, commit, fileCount: () => writes.size,
    async overallMetadata() {
      const {hash, value} = await readOverallMetadata(root, memory);
      overallDependency = hash; return value;
    }};
}

/**
 * Call only with an authorized read-only db transport. This module never loads
 * credentials, schedules a run, retries, performs batchGet, or writes remotely.
 * Caller must exclusively own directory for the entire call (including rollback).
 * checkpointDirectory must already exist, be private, and be disjoint from staging.
 * A unique checkpoint child retains raw pages, original bytes and planned outputs.
 * No automatic checkpoint resume: incomplete captures are not publication inputs.
 * All caps are fixed upper bounds. Cap exhaustion returns a deferred report with
 * zero staging changes; other failures throw an error carrying the same safe report.
 * A full final page at the read cap is NOT complete, even if exactly 10k rows exist.
 * complete/fullScan describe source enumeration, not publication readiness. A
 * missingPriorCount > 0 preserves those rows but marks their boards inexact.
 * manifest.json and track-statistics.json are committed with the imported boards.
 * Never-provisioned catalog entries stay unavailable, not scan inconsistencies.
 * Missing boards previously claimed by a path stay explicit missingBoards gaps.
 * The 64 MiB limit covers conservatively accounted module-owned working data;
 * decoded transport buffers / process RSS must be bounded by the caller.
 * full-canonical-capture.json is the public, transactionally persisted audit/watermark.
 */
export async function captureFullCanonical({db, directory, documentLimit = 10000, pageSize = 100,
  readTime, checkpointDirectory} = {}) {
  const report = {version: 1, complete: false, fullScan: false, fullScanReadPoint: null, watermark: null,
    rows: 0, newRows: 0, newAccounts: 0, newTracks: 0, changed: 0, reused: 0, repaired: 0,
    missingPrior: [], missingPriorCount: 0, missingBoards: [], unprovisionedTracks: [], unregisteredTrackCount: 0,
    scanInconsistency: false, pages: 0, reservedDocumentReads: 0,
    documentLimit, documentWrites: 0, verificationAttempts: 0, capDeferred: false, deferred: false,
    ingestedAt: {present: 0, missing: 0, serverTimestamp: 0, allPopulated: false, allServerTimestamps: false},
    incrementalEligible: false, imported: false};
  const memory = memoryBudget();
  let root, locked = false;
  try {
    demand(db && typeof db.call === 'function', 'transport_required');
    demand(positive(documentLimit) && documentLimit <= 10000 && positive(pageSize) && pageSize <= 100, 'invalid_limits');
    if (readTime !== undefined) timestamp(readTime);
    root = await checkedRoot(directory);
    demand(!active.has(root), 'capture_already_active'); active.add(root); locked = true;
    let checkpoint;
    if (checkpointDirectory !== undefined) {
      const parent = await checkedRoot(checkpointDirectory);
      demand(!inside(root, parent) && !inside(parent, root), 'checkpoint_must_be_private_and_disjoint');
      checkpoint = await checked(parent, `full-canonical-${randomUUID()}`, true);
      await fs.mkdir(checkpoint, {mode: 0o700});
    }
    const tx = await transaction(root, checkpoint, memory);
    const savedManifest = await tx.read('manifest.json');
    const manifest = savedManifest.value ?? {schemaVersion: 1, source: 'full-canonical-capture', tracks: {}};
    demand(plain(manifest) && plain(manifest.tracks) &&
      (manifest.schemaVersion === undefined || manifest.schemaVersion === 1), 'invalid_manifest');
    for (const [trackId, record] of Object.entries(manifest.tracks)) {
      demand(HASH.test(trackId) && plain(record) &&
        (record.path === undefined || record.path === null || record.path === `tracks/${trackId}.json`), 'invalid_manifest_track');
      demand(record.retainedBoardMissing === undefined || typeof record.retainedBoardMissing === 'boolean', 'invalid_manifest_track');
    }
    demand(manifest.trackIdsKnown === undefined || Number.isSafeInteger(manifest.trackIdsKnown) &&
      manifest.trackIdsKnown >= 0, 'invalid_manifest_count');
    const boards = new Map(), prior = new Set(), rows = new Map(), uploads = new Map(), seen = new Set(), accounts = new Set();
    const knownAccounts = new Set(), newAccounts = new Set();
    const tracksDir = await checked(root, 'tracks', true);
    let handle;
    try { handle = await fs.opendir(tracksDir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (handle) for await (const entry of handle) {
      demand(entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name), 'unsafe_track_inventory');
      const trackId = entry.name.slice(0, -5), saved = await tx.read(`tracks/${entry.name}`), board = saved.value;
      demand(plain(board) && board.trackId === trackId && Array.isArray(board.entries), 'invalid_board');
      try {
        const ids = [];
        for (const row of board.entries) {
          binding(row); demand(row.trackId === trackId, 'board_track_mismatch');
          const id = `${row.accountId}_${trackId}`;
          demand(!prior.has(id) && !uploads.has(row.uploadId), 'duplicate_prior_binding');
          memory.claim(768);
          prior.add(id); uploads.set(row.uploadId, id); knownAccounts.add(row.accountId); ids.push(id);
          if (prior.size > 10000) fail('baseline_exceeds_10000', true);
          const projected = project(row);
          if (typeof row.reason === 'string' && /review|hold|excluded|rejected/.test(row.reason)) {
            projected.reviewHold = true; projected.needsReview = true;
          }
          rows.set(id, await tx.storeRow(projected));
        }
        const metadata = project(board, BOARD_FIELDS);
        memory.claim(objectSize(metadata) + 512);
        boards.set(trackId, {metadata, ids});
      } finally { saved.release(); }
    }
    report.priorRows = prior.size;
    let cursor, sourcePrefix, point = readTime;
    for (;;) {
      const limit = Math.min(pageSize, documentLimit - report.reservedDocumentReads);
      if (!limit) fail('document_cap_without_terminal_page', true);
      const structuredQuery = {from: [{collectionId: COLLECTION}],
        select: {fields: [...FULL_CANONICAL_FIELDS, '__name__'].map(fieldPath => ({fieldPath}))},
        orderBy: [{field: {fieldPath: '__name__'}, direction: 'ASCENDING'}], limit};
      if (cursor) structuredQuery.startAt = {values: [{referenceValue: cursor}], before: false};
      const body = {structuredQuery, ...(point ? {readTime: point} : {})};
      report.reservedDocumentReads += limit;
      let response;
      try { response = await db.call(':runQuery', body, {onRetry: () => fail('retry_forbidden')}); }
      catch { fail('query_failed'); }
      demand(Array.isArray(response) && response.length > 0 && response.length <= limit + 1, 'invalid_page');
      const releasePage = memory.claim(objectSize(response) * 2);
      try {
        response = structuredClone(response);
        const times = response.filter(item => item?.readTime !== undefined).map(item => item.readTime);
        demand(times.length > 0, 'missing_read_point');
        if (!point) point = times[0];
        const fixed = timestamp(point);
        demand(times.every(value => timestamp(value) === fixed), 'unstable_read_point');
        const docs = [];
        let ended = false;
        for (const item of response) {
          demand(plain(item) && Object.keys(item).every(key => ['document', 'readTime', 'skippedResults', 'done'].includes(key)) &&
            (!Object.hasOwn(item, 'skippedResults') || item.skippedResults === 0) &&
            (!Object.hasOwn(item, 'done') || item.done === true), 'partial_or_invalid_page');
          if (item.document) { demand(!ended, 'partial_or_invalid_page'); docs.push(item.document); }
          else { demand(item.readTime !== undefined, 'partial_or_invalid_page'); ended = true; }
        }
        demand(docs.length <= limit, 'overfull_page');
        for (const doc of docs) {
          demand(plain(doc) && typeof doc.name === 'string' && plain(doc.fields), 'invalid_document');
          const match = /^(projects\/[A-Za-z0-9_-]+\/databases\/(?:\(default\)|[A-Za-z0-9_-]+)\/documents\/0\.6\.2_race_results\/)([a-f0-9]{64}_[a-f0-9]{64})$/.exec(doc.name);
          demand(match && (!sourcePrefix || match[1] === sourcePrefix) && (!cursor || doc.name > cursor), 'document_identity_or_order');
          sourcePrefix = match[1]; cursor = doc.name;
          const id = match[2]; demand(!seen.has(id), 'duplicate_document');
          const source = {};
          for (const field of FULL_CANONICAL_FIELDS) if (Object.hasOwn(doc.fields, field)) source[field] = decode(doc.fields[field]);
          demand(`${source.accountId}_${source.trackId}` === id, 'document_binding_mismatch');
          binding(source, true);
          demand(!STATUS_FIELDS.some(field => ['rejected', 'mismatch', 'unavailable_final'].includes(source[field])), 'source_rejected');
          project(source);
          if (source.ingestedAt !== undefined) {
            const value = typeof source.ingestedAt === 'number' ? BigInt(source.ingestedAt) * 1000000n : timestamp(source.ingestedAt);
            demand(value <= fixed, 'ingested_after_read_point'); report.ingestedAt.present++;
            if (doc.fields.ingestedAt?.timestampValue !== undefined) {
              source.ingestedAtSource = 'firestore-server-timestamp'; report.ingestedAt.serverTimestamp++;
            }
          } else report.ingestedAt.missing++;
          await replayBytes(source.replay, source);
          memory.claim(1024); seen.add(id); accounts.add(source.accountId); report.rows++;
          if (!knownAccounts.has(source.accountId)) newAccounts.add(source.accountId);
          const canonicalPath = `canonical/${source.trackId}/${source.accountId}.json`;
          const recordingPath = `recordings/${source.uploadId}.json`;
          const canonical = await tx.read(canonicalPath), recording = await tx.read(recordingPath);
          const previous = rows.has(id) ? await tx.loadRow(rows.get(id)) : {value: null, release() {}};
          try {
            const old = previous.value, saved = canonical.value, bytes = recording.value;
            if (saved) { binding(saved); demand(saved.accountId === source.accountId && saved.trackId === source.trackId, 'saved_identity'); }
            if (old && saved) demand(binding(old) === binding(saved), 'saved_board_mismatch');
            const baseline = old || saved, same = baseline && binding(baseline) === binding(source);
            if (baseline && !same) demand(source.timeMs < baseline.timeMs, 'non_faster_replacement');
            demand(!uploads.has(source.uploadId) || uploads.get(source.uploadId) === id, 'upload_collision');
            if (bytes) {
              const normalized = {uploadId: source.uploadId, timeMs: source.timeMs,
                verified: bytes.verifiedState === 1, ...bytes};
              demand(binding(normalized) === binding(source) && bytes.recording === source.replay &&
                (bytes.carStyle ?? '') === (source.carStyle ?? ''), 'recording_collision');
              await replayBytes(bytes.recording, source);
            }
            const restrictions = holds(old, saved, bytes, source);
            let next, canonicalOut, recordingOut;
            if (same && saved && bytes) {
              demand(saved.integrityVerified === true && saved.runVerified === saved.verified &&
                bytes.verifiedState === saved.verifiedState && (bytes.verified === undefined || bytes.verified === saved.verified) &&
                (bytes.runVerified === undefined || bytes.runVerified === saved.runVerified) &&
                (bytes.integrityVerified === undefined || bytes.integrityVerified === true) &&
                (saved.carStyle ?? '') === (source.carStyle ?? '') &&
                (!old || old.runVerified === saved.runVerified && old.verifiedState === saved.verifiedState), 'invalid_saved_proof');
              const dates = project(source, [...DATE_FIELDS, 'ingestedAtSource']);
              next = {...project(old || saved), ...dates, ...restrictions};
              const canonicalProof = pristineCompanions(saved, source), recordingProof = pristineCompanions(bytes, source);
              if (next.nativeLedgerKey !== undefined) {
                demand(next.nativeLedgerKey === ledgerKey(ledgerBinding(source, 'normal')) &&
                  (canonicalProof.nativeLedgerBoardSource || canonicalProof.nativeLedgerSource), 'saved_ledger_baseline_missing');
              }
              canonicalOut = {...project(saved), ...canonicalProof, ...dates, ...restrictions};
              recordingOut = {...project(bytes), ...recordingProof, ...restrictions, recording: bytes.recording};
              report.reused++;
            } else {
              const frames = source.frames ?? source.raceTimeFrames;
              next = {...project(source), frames, raceTimeFrames: frames, verified: false, runVerified: false,
                verifiedState: 0, integrityVerified: true, playbackPending: true, verificationStatus: 'pending',
                eventRpEligible: false};
              for (const key of ['validationState', 'status']) delete next[key];
              Object.assign(next, restrictions);
              canonicalOut = {...next}; recordingOut = {...next, recording: source.replay};
              if (old) { next.originalTimeMs = old.originalTimeMs ?? old.timeMs; next.originalRank = old.originalRank ?? old.rank ?? 1; }
              if (same) report.repaired++;
              else if (old) report.changed++;
            }
            if (!old) report.newRows++;
            if (!boards.has(source.trackId)) {
              memory.claim(1024); report.newTracks++;
              boards.set(source.trackId, {metadata: {trackId: source.trackId, updatedAt: Date.parse(point)}, ids: []});
            }
            if (!old) boards.get(source.trackId).ids.push(id);
            const nextRef = await tx.storeRow(next);
            rows.get(id)?.release(); rows.set(id, nextRef);
            uploads.set(source.uploadId, id);
            if (!saved || !isDeepStrictEqual(saved, canonicalOut)) await tx.plan(canonicalPath, canonicalOut);
            if (!bytes || !isDeepStrictEqual(bytes, recordingOut)) await tx.plan(recordingPath, recordingOut);
          } finally { canonical.release(); recording.release(); previous.release(); }
        }
        if (checkpoint) {
          // Raw responses are never placed in the public stage. Split pages by
          // response item so even private files respect the 2 MiB file cap.
          for (let i = 0; i < response.length; i++) {
            const bytes = Buffer.from(JSON.stringify(response[i]) + '\n');
            if (bytes.length > FULL_CANONICAL_LIMITS.fileBytes) fail('checkpoint_file_cap', true);
            await fs.writeFile(await checked(checkpoint, `page-${report.pages}-${i}.json`), bytes, {flag: 'wx', mode: 0o600});
          }
        }
        report.pages++;
        if (docs.length < limit) break;
      } finally { releasePage(); }
    }
    report.newAccounts = newAccounts.size;
    report.accounts = accounts.size;
    report.missingPrior = [...prior.keys()].filter(id => !seen.has(id)).sort();
    report.missingPriorCount = report.missingPrior.length;
    const unavailable = Object.keys(manifest.tracks).filter(trackId => !boards.has(trackId));
    // A catalog entry with no retained path never claimed prior standings. Keep
    // a persisted loss marker so nulling a genuinely lost path cannot clear the
    // quality gate on the next scan without actually restoring that board.
    const retained = trackId => manifest.tracks[trackId].path != null || manifest.tracks[trackId].retainedBoardMissing === true;
    report.missingBoards = unavailable.filter(retained).sort();
    report.unprovisionedTracks = unavailable.filter(trackId => !retained(trackId)).sort();
    report.scanInconsistency = report.missingPrior.length > 0 || report.missingBoards.length > 0;
    report.ingestedAt.allPopulated = report.ingestedAt.missing === 0;
    report.ingestedAt.allServerTimestamps = report.ingestedAt.serverTimestamp === report.rows;
    // A fully populated baseline is necessary but not sufficient to authorize a
    // future incremental policy. No such policy is activated by this module.
    report.incrementalEligible = false;
    const trackStatistics = {};
    for (const [trackId, {metadata, ids}] of boards) {
      const missing = ids.some(id => !seen.has(id)), entries = [], releases = [];
      try {
        for (const id of ids) {
          const row = await tx.loadRow(rows.get(id));
          entries.push({...row.value, ...holds(row.value)}); releases.push(row.release);
        }
        const output = {...metadata, complete: !missing, sourceComplete: !missing,
          totalEntries: entries.length, totalEntriesExact: !missing, ranksExact: !missing,
          entries: rankTrustedTrackEntries(entries, trackId)};
        demand(Number.isSafeInteger(output.updatedAt) && output.updatedAt >= 0 && output.updatedAt <= Date.parse(point), 'invalid_board_clock');
        const relative = `tracks/${trackId}.json`, descriptor = await tx.plan(relative, output);
        const previous = manifest.tracks[trackId] || {};
        const record = {...previous, path: relative, sha256: descriptor.sha256, bytes: descriptor.bytes,
          updatedAt: output.updatedAt, sourceUpdatedAt: output.updatedAt, count: output.entries.length,
          totalEntries: output.entries.length, complete: !missing, sourceComplete: !missing,
          totalEntriesExact: !missing, ranksExact: !missing, missing,
          fullCanonicalCapture: {source: 'firestore-full-canonical', fullScanReadPoint: point,
            sourceRows: ids.filter(id => seen.has(id)).length, retainedRows: ids.filter(id => !seen.has(id)).length,
            complete: !missing}};
        // A former published/native overlay is historical evidence, not a digest
        // authorizing this newly materialized board. Keep it explicitly historical.
        if (previous.nativeLedgerOverlay !== undefined) record.previousNativeLedgerOverlay = previous.nativeLedgerOverlay;
        delete record.nativeLedgerOverlay;
        delete record.retainedBoardMissing;
        if (previous.checkedAt !== undefined && (missing || previous.sha256 !== descriptor.sha256)) {
          record.previousConfirmation = project(previous, ['checkedAt', 'updatedAt', 'sourceUpdatedAt', 'revision', 'sha256']);
        }
        const revision = output.revision ?? output.sourceRevision;
        if (revision !== undefined) {
          demand(Number.isSafeInteger(revision) && revision >= 0, 'invalid_board_revision'); record.revision = revision;
        } else delete record.revision;
        if (missing) delete record.checkedAt;
        else record.checkedAt = Date.parse(point);
        memory.claim(objectSize(record) * 2 + 1024);
        manifest.tracks[trackId] = record;
        trackStatistics[trackId] = buildTrackStatistics([
          {logicalPath: 'manifest.json', value: {trackIdsKnown: 1, tracks: {[trackId]: record}}},
          {logicalPath: relative, value: output}
        ]).tracks[trackId];
      } finally { for (const release of releases) release(); }
    }
    for (const trackId of report.missingBoards) {
      const previous = manifest.tracks[trackId];
      const record = {...previous, path: null, retainedBoardMissing: true, missing: true, complete: false, sourceComplete: false,
        count: null, totalEntries: null, totalEntriesExact: false, ranksExact: false};
      if (previous.checkedAt !== undefined) record.previousConfirmation = project(previous,
        ['checkedAt', 'updatedAt', 'sourceUpdatedAt', 'revision', 'sha256']);
      if (previous.nativeLedgerOverlay !== undefined) record.previousNativeLedgerOverlay = previous.nativeLedgerOverlay;
      for (const key of ['checkedAt', 'sha256', 'bytes', 'nativeLedgerOverlay', 'fullCanonicalCapture']) delete record[key];
      memory.claim(objectSize(record) * 2 + 512); manifest.tracks[trackId] = record;
    }
    manifest.trackIdsKnown = Math.max(manifest.trackIdsKnown || 0, Object.keys(manifest.tracks).length);
    report.unregisteredTrackCount = manifest.trackIdsKnown - Object.keys(manifest.tracks).length;
    manifest.trackBackupsPresent = boards.size;
    manifest.trackBackupsMissing = manifest.trackIdsKnown - boards.size;
    manifest.tracksMissing = manifest.trackBackupsMissing;
    // Preserve unrelated overall/event/profile metadata and historical fetch counters.
    manifest.fullCanonicalCapture = {source: 'firestore-full-canonical', fullScanReadPoint: point,
      complete: true, imported: true, sourceRows: report.rows, stagingRows: rows.size,
      tracksPresent: boards.size, missingPriorCount: report.missingPriorCount,
      missingBoards: report.missingBoards, unprovisionedTracks: report.unprovisionedTracks,
      unregisteredTrackCount: report.unregisteredTrackCount,
      scanInconsistency: report.scanInconsistency};
    const overall = await tx.overallMetadata(), summary = await tx.read('public-export-summary.json');
    const statisticsMemory = memory.claim(objectSize(manifest) * 2 + 1024);
    try {
      const statistics = buildTrackStatistics([{logicalPath: 'manifest.json', value: manifest},
        {logicalPath: 'overall.json', value: overall}, {logicalPath: 'public-export-summary.json', value: summary.value}]);
      Object.assign(statistics.tracks, trackStatistics);
      statistics.tracksPresent = boards.size;
      statistics.complete = boards.size === manifest.trackIdsKnown && Object.values(statistics.tracks).every(row => row.complete);
      statistics.fullScanReadPoint = point;
      await tx.plan('track-statistics.json', statistics);
      await tx.plan('manifest.json', manifest);
    } finally { summary.release(); statisticsMemory(); savedManifest.release(); }
    report.complete = true; report.fullScan = true; report.fullScanReadPoint = point;
    report.watermark = point; report.imported = true; report.peakAccountedBytes = memory.peak();
    report.outputFiles = tx.fileCount() + 1;
    await tx.plan('full-canonical-capture.json', report);
    await tx.commit();
    return report;
  } catch (error) {
    Object.assign(report, {complete: false, fullScan: false, fullScanReadPoint: null, watermark: null,
      imported: false, deferred: error.deferred === true, capDeferred: error.deferred === true,
      reason: error.code === 'FULL_CANONICAL_CAPTURE' ? error.reason : 'local_io_failed', peakAccountedBytes: memory.peak()});
    if (error.deferred) return report;
    throw Object.assign(Error(`Full canonical capture stopped: ${report.reason}`), {code: 'FULL_CANONICAL_CAPTURE', report});
  } finally { if (locked) active.delete(root); }
}
