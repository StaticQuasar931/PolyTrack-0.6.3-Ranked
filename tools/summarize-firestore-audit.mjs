#!/usr/bin/env node
// Offline diagnostic estimates only, not Firebase billing or project-wide usage.
import {open} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

export const MAX_AUDIT_BYTES = 50 * 1024 * 1024;
export const FIRESTORE_OPERATION_LABEL = 'Ranked Firestore operation';
const legacyLabels = new Map(['scheduled','request','background'].map(scope =>
  [`Ranked ${scope} Firestore reads`, scope]));
const modes = new Set(['operations','legacy']);
const kinds = new Set(['get','runQuery','batchGet','commit','patch','delete','unknown']);
const safeKey = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value) ? value : 'unknown';
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

// Wrangler --format json is a sequence of pretty JSON objects, not one JSON
// document. Scan balanced containers while respecting quoted/escaped braces.
export function parseFirestoreAuditEvents(source) {
  if (typeof source !== 'string') throw TypeError('Audit input must be text');
  if (Buffer.byteLength(source, 'utf8') > MAX_AUDIT_BYTES) throw Error('Audit input exceeds 50 MiB');
  const events = [];
  let start = -1, depth = 0, quoted = false, escaped = false, malformedObjects = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (start < 0) {
      if (ch !== '{' && ch !== '[') continue;
      start = i; depth = 1; quoted = escaped = false;
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      if (--depth !== 0) continue;
      try {
        const value = JSON.parse(source.slice(start, i + 1));
        if (Array.isArray(value)) { for (const event of value) events.push(event); }
        else events.push(value);
      } catch { malformedObjects++; }
      start = -1;
    }
  }
  return {events, malformedObjects, incompleteTrailingData:start >= 0};
}

function decodeLog(log) {
  const message = log?.message ?? log?.label;
  if (Array.isArray(message)) {
    const label = message[0];
    if (message[1] && typeof message[1] === 'object') return {label, data:message[1]};
    try { return {label, data:JSON.parse(message.slice(1).join(' '))}; } catch { return null; }
  }
  if (typeof message === 'string') {
    for (const label of [FIRESTORE_OPERATION_LABEL, ...legacyLabels.keys()]) {
      if (message === label) return {label, data:log.data ?? log};
      if (message.startsWith(label + ' ')) {
        try { return {label, data:JSON.parse(message.slice(label.length))}; } catch { return null; }
      }
    }
  }
  // A JSONL fixture can contain the operation descriptor plus scope directly.
  if (log?.schemaVersion === 1 && kinds.has(log.operationKind)) return {label:FIRESTORE_OPERATION_LABEL, data:log};
  return null;
}

function metric() { return {estimate:0, known:0, unknownEntries:0}; }
function bucket() {
  return {entries:0, reads:metric(), writes:metric(), deletes:metric(),
    httpRequests:metric(), operationAttempts:metric(), failedRequests:metric(), preTransportFailures:metric(),
    unknownReadRequests:metric(), unknownWriteRequests:metric()};
}
function add(target, value) {
  const n = count(value);
  if (n === null) { target.estimate = null; target.unknownEntries++; }
  else {
    target.known += n;
    if (!Number.isSafeInteger(target.known)) throw Error('Audit count exceeds safe integer range');
    if (target.estimate !== null) target.estimate += n;
  }
}
function accumulate(target, data, operation) {
  target.entries++;
  add(target.reads, data.documentReadEstimate);
  add(target.writes, data.writeEstimate);
  add(target.deletes, data.deleteEstimate);
  // An operation descriptor represents one actual call, NOT one document read.
  add(target.httpRequests, operation ? 1 : data.httpRequests);
  add(target.operationAttempts, operation ? null : data.operationAttempts);
  add(target.failedRequests, operation ? (typeof data.failed === 'boolean' ? Number(data.failed) : null) : data.failedRequests);
  add(target.preTransportFailures, operation ? 0 : data.preTransportFailures);
  add(target.unknownReadRequests, data.unknownReadRequests);
  add(target.unknownWriteRequests, data.unknownWriteRequests);
}
function collectionBucket() { return {reads:metric(), writes:metric(), deletes:metric()}; }
function addCollections(target, data) {
  const reads = data.collections && typeof data.collections === 'object' ? data.collections : {};
  const writes = data.writeCollections && typeof data.writeCollections === 'object' ? data.writeCollections : {};
  for (const key of new Set([...Object.keys(reads), ...Object.keys(writes)])) {
    const name = safeKey(key);
    const entry = target[name] ||= collectionBucket();
    if (Object.hasOwn(reads, key)) add(entry.reads, reads[key]);
    if (Object.hasOwn(writes, key)) {
      add(entry.writes, writes[key]?.writes);
      add(entry.deletes, writes[key]?.deletes);
    }
  }
}

// Explicit mode prevents adding operation entries to their own legacy summaries.
// Reused auditRequestId means snapshots of the SAME audit: the last background
// final replaces earlier snapshots. Distinct audits must have distinct IDs.
export function summarizeFirestoreAudit(source, {mode} = {}) {
  if (!modes.has(mode)) throw Error('Choose --mode operations or --mode legacy');
  const parsed = parseFirestoreAuditEvents(source);
  const selected = [], snapshots = new Map();
  let ignoredEntries = 0, supersededLegacyEntries = 0, uncorrelatedLegacyEntries = 0;
  for (const [eventIndex, event] of parsed.events.entries()) {
    if (!event || typeof event !== 'object') continue;
    const logs = Array.isArray(event.logs) ? event.logs : [event];
    for (const log of logs) {
      const decoded = decodeLog(log);
      if (!decoded || !decoded.data || typeof decoded.data !== 'object') continue;
      const {label, data} = decoded;
      const operation = label === FIRESTORE_OPERATION_LABEL;
      const legacyScope = legacyLabels.get(label);
      if ((!operation && !legacyScope) || operation !== (mode === 'operations')) { ignoredEntries++; continue; }
      const scope = safeKey(data.measurementScope || data.scope || legacyScope || 'operation');
      const entry = {data, scope, operation};
      if (operation) { selected.push(entry); continue; }
      const id = typeof data.auditRequestId === 'string' ? 'audit:' + data.auditRequestId :
        typeof event.requestId === 'string' ? 'invocation:' + event.requestId :
        typeof event.event?.requestId === 'string' ? 'invocation:' + event.event.requestId :
        Array.isArray(event.logs) ? 'event:' + eventIndex : null;
      const final = legacyScope === 'background' && /final/.test(data.measurementScope || '');
      if (id === null) {
        uncorrelatedLegacyEntries++;
        selected.push(entry);
      } else {
        const previous = snapshots.get(id);
        if (!previous || final || !previous.final) snapshots.set(id, {entry, final});
        if (previous) supersededLegacyEntries++;
      }
    }
  }
  selected.push(...[...snapshots.values()].map(value => value.entry));
  const totals = bucket(), byScope = Object.create(null), byCollection = Object.create(null), byOperationKind = Object.create(null);
  for (const {data, scope, operation} of selected) {
    accumulate(totals, data, operation);
    const scoped = byScope[scope] ||= {...bucket(), byCollection:Object.create(null)};
    accumulate(scoped, data, operation);
    addCollections(byCollection, data);
    addCollections(scoped.byCollection, data);
    if (operation) accumulate(byOperationKind[kinds.has(data.operationKind) ? data.operationKind : 'unknown'] ||= bucket(), data, true);
  }
  return {mode, billingEstimateOnly:true, parsedEvents:parsed.events.length,
    malformedObjects:parsed.malformedObjects, incompleteTrailingData:parsed.incompleteTrailingData,
    ignoredEntries, supersededLegacyEntries, uncorrelatedLegacyEntries,
    totals, byScope, byCollection, byOperationKind};
}

export async function summarizeFirestoreAuditFile(file, options) {
  // Check the actual bytes read as well as the stat: the file could grow while read.
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw Error('Audit input must be a regular file');
    if (stat.size > MAX_AUDIT_BYTES) throw Error('Audit input exceeds 50 MiB');
    const chunks = [];
    let bytes = 0;
    for await (const chunk of handle.createReadStream({autoClose:false, highWaterMark:64 * 1024})) {
      bytes += chunk.length;
      if (bytes > MAX_AUDIT_BYTES) throw Error('Audit input exceeds 50 MiB');
      chunks.push(chunk);
    }
    return summarizeFirestoreAudit(Buffer.concat(chunks).toString('utf8'), options);
  } finally { await handle.close(); }
}

const help = `Usage: node tools/summarize-firestore-audit.mjs --mode operations|legacy FILE
Offline only. Reads at most 50 MiB; accepts Wrangler pretty JSON events or JSONL.
Operations: "${FIRESTORE_OPERATION_LABEL}" + descriptor, or raw descriptor JSONL.
Legacy: Ranked scheduled/request/background Firestore reads + audit JSON.
Cumulative snapshots need the same auditRequestId (or Wrangler invocation).
Distinct audits need distinct IDs. Uncorrelated entries are counted and flagged.
Null estimates stay unknown; known subtotals are not complete billing totals.`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') console.log(help);
  else {
    const at = args.indexOf('--mode');
    const mode = at >= 0 ? args[at + 1] : undefined;
    const files = args.filter((_, i) => i !== at && i !== at + 1);
    if (args.length !== 3 || !modes.has(mode) || files.length !== 1 || files[0].startsWith('-')) {
      console.error(help); process.exitCode = 1;
    } else {
      try { console.log(JSON.stringify(await summarizeFirestoreAuditFile(files[0], {mode}), null, 2)); }
      catch { console.error('Could not summarize audit: unreadable/invalid input, unsafe counts, or size exceeds 50 MiB.'); process.exitCode = 1; }
    }
  }
}
