import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, open, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createFirestoreAudit, describeFirestoreOperation} from '../workers/ranked/src/firestore-read-cost.js';
import {MAX_AUDIT_BYTES, FIRESTORE_OPERATION_LABEL, parseFirestoreAuditEvents,
  summarizeFirestoreAudit, summarizeFirestoreAuditFile} from './summarize-firestore-audit.mjs';

const legacy = (scope, data) => ({message:[`Ranked ${scope} Firestore reads`, JSON.stringify({...createFirestoreAudit(), ...data})]});
const operation = (data = {}) => ({...describeFirestoreOperation({path:'/profiles/PRIVATE_ACCOUNT', payload:{}}),
  measurementScope:'request_synchronous', ...data});
const event = (...logs) => ({logs});
const jsonl = values => values.map(value=>JSON.stringify(value)).join('\n');
const summarize = (values, mode='operations') => summarizeFirestoreAudit(jsonl(values), {mode});

test('parser accepts multiple pretty Wrangler events, banners and quoted escaped braces', () => {
  const input = [event({message:['unrelated "{\\}"']}, legacy('scheduled',{documentReadEstimate:4})),
    event(legacy('request',{documentReadEstimate:2}))];
  const text = 'Connected to worker\n' + input.map(value=>JSON.stringify(value,null,2)).join('\n\n');
  const parsed = parseFirestoreAuditEvents(text);
  assert.deepEqual(parsed.events, input);
  assert.equal(parsed.malformedObjects, 0);
  assert.equal(parsed.incompleteTrailingData, false);
  assert.equal(summarizeFirestoreAudit(text,{mode:'legacy'}).totals.reads.estimate, 6);
});

test('parser keeps complete events before truncated/incomplete trailing JSON', () => {
  const prefix = JSON.stringify(event(legacy('scheduled',{documentReadEstimate:7})),null,2);
  for (const suffix of ['{', '{"logs": [', '{"logs":[{"message":["Ranked request Firestore reads", "{\\"x', '[{"pending":']) {
    const report = summarizeFirestoreAudit(prefix + '\n' + suffix, {mode:'legacy'});
    assert.equal(report.totals.reads.estimate, 7);
    assert.equal(report.parsedEvents, 1);
    assert.equal(report.incompleteTrailingData, true);
  }
});

test('parser skips balanced malformed JSON, supports arrays and does not parse nested messages as events', () => {
  const good = operation();
  const parsed = parseFirestoreAuditEvents('{bad}\n' + JSON.stringify([good, good]));
  assert.equal(parsed.malformedObjects, 1);
  assert.equal(parsed.events.length, 2);
  assert.equal(summarizeFirestoreAudit('{bad}\n'+JSON.stringify([good,good]),{mode:'operations'}).totals.httpRequests.estimate,2);
});

test('operation mode never adds legacy summaries and preserves scopes, collections and operation kinds', () => {
  const query = describeFirestoreOperation({path:':runQuery',init:{method:'POST',body:'{"structuredQuery":{"from":[{"collectionId":"boards"}]}}'},payload:[]});
  const report = summarize([event(
    {message:[FIRESTORE_OPERATION_LABEL,JSON.stringify(operation())]},
    {message:[FIRESTORE_OPERATION_LABEL,{...query,measurementScope:'scheduled'}]},
    legacy('request',{documentReadEstimate:100,operationAttempts:1000,httpRequests:200})
  )]);
  assert.equal(report.totals.reads.estimate, 2);
  assert.equal(report.totals.httpRequests.estimate, 2);
  assert.equal(report.totals.operationAttempts.estimate, null);
  assert.equal(report.totals.operationAttempts.known, 0);
  assert.equal(report.ignoredEntries, 1);
  assert.equal(report.byScope.request_synchronous.reads.estimate, 1);
  assert.equal(report.byScope.scheduled.byCollection.boards.reads.estimate, 1);
  assert.equal(report.byCollection.profiles.reads.estimate, 1);
  assert.equal(report.byOperationKind.runQuery.entries, 1);
});

test('legacy mode counts reads independently of HTTP requests, operation attempts and pre-transport failures', () => {
  const report = summarize([event(legacy('request',{measurementScope:'request_synchronous',
    operationAttempts:20,httpRequests:3,preTransportFailures:17,failedOperations:18,failedRequests:1,unknownReadRequests:1,
    documentReadEstimate:150,collections:{profiles:150},writeEstimate:2,deleteEstimate:1,
    writeCollections:{boards:{writes:2,deletes:1}}}), {message:[FIRESTORE_OPERATION_LABEL,operation()]})], 'legacy');
  assert.equal(report.totals.reads.estimate, 150);
  assert.equal(report.totals.httpRequests.estimate, 3);
  assert.equal(report.totals.operationAttempts.estimate, 20);
  assert.equal(report.totals.preTransportFailures.estimate, 17);
  assert.equal(report.totals.failedRequests.estimate, 1);
  assert.equal(report.totals.unknownReadRequests.estimate, 1);
  assert.equal(report.totals.writes.estimate, 2);
  assert.equal(report.totals.deletes.estimate, 1);
  assert.equal(report.byCollection.boards.writes.estimate, 2);
});

test('cumulative background final supersedes request snapshot using auditRequestId in either order', () => {
  const initial = legacy('request',{auditRequestId:'PRIVATE_CORRELATION',measurementScope:'request_synchronous',documentReadEstimate:4});
  const final = legacy('background',{auditRequestId:'PRIVATE_CORRELATION',measurementScope:'background_profile_job_final',documentReadEstimate:9});
  for (const entries of [[initial,final],[final,initial]]) {
    const report = summarize(entries,'legacy');
    assert.equal(report.totals.reads.estimate, 9);
    assert.equal(report.totals.entries, 1);
    assert.equal(report.supersededLegacyEntries, 1);
    assert.equal(report.byScope.background_profile_job_final.reads.estimate, 9);
    assert.equal(JSON.stringify(report).includes('PRIVATE'), false);
  }
});

test('repeated cumulative finals count only the last snapshot, independent audits are additive', () => {
  const report = summarize([
    legacy('background',{auditRequestId:'a',measurementScope:'background_profile_job_final',documentReadEstimate:8}),
    legacy('background',{auditRequestId:'a',measurementScope:'background_profile_job_final',documentReadEstimate:10}),
    legacy('request',{auditRequestId:'b',documentReadEstimate:3}),
    legacy('scheduled',{auditRequestId:'c',documentReadEstimate:2})
  ],'legacy');
  assert.equal(report.totals.reads.estimate, 15);
  assert.equal(report.supersededLegacyEntries, 1);
  assert.equal(report.totals.entries, 3);
});

test('Wrangler invocation identity correlates snapshots across pretty events; per-event fallback works', () => {
  const initial = legacy('request',{documentReadEstimate:2});
  const final = legacy('background',{measurementScope:'background_profile_job_final',documentReadEstimate:5});
  for (const entries of [[event(initial, final)],
    [{requestId:'PRIVATE_ID',...event(initial)}, {requestId:'PRIVATE_ID',...event(final)}],
    [{event:{requestId:'PRIVATE_ID'},...event(initial)}, {event:{requestId:'PRIVATE_ID'},...event(final)}]]) {
    const report = summarize(entries,'legacy');
    assert.equal(report.totals.reads.estimate, 5);
    assert.equal(report.supersededLegacyEntries, 1);
  }
  const uncorrelated = summarize([initial, final],'legacy');
  assert.equal(uncorrelated.uncorrelatedLegacyEntries, 2);
});

test('null estimates remain unknown while known read/write/delete subtotals stay separate', () => {
  const failed = describeFirestoreOperation({path:'/profiles/PRIVATE_ID',init:{method:'PATCH'},failed:true});
  const report = summarize([
    operation({documentReadEstimate:null,collections:{profiles:null}}),
    operation({documentReadEstimate:3,collections:{profiles:3}}),
    {...failed,measurementScope:'background'},
    operation({documentReadEstimate:0,collections:{},writeEstimate:2,deleteEstimate:null,writeCollections:{profiles:{writes:2,deletes:null}}})
  ]);
  assert.deepEqual(report.totals.reads, {estimate:null,known:3,unknownEntries:1});
  assert.deepEqual(report.totals.writes, {estimate:null,known:2,unknownEntries:1});
  assert.deepEqual(report.totals.deletes, {estimate:null,known:0,unknownEntries:1});
  assert.deepEqual(report.byCollection.profiles.writes, {estimate:null,known:2,unknownEntries:1});
  assert.equal(report.totals.failedRequests.estimate,1);
});

test('malformed successful responses are unknown costs, not failed HTTP calls', () => {
  const bad = describeFirestoreOperation({path:':runQuery',init:{body:'{}'},payload:[]});
  assert.equal(bad.outcome,'unknown');
  const report = summarize([bad]);
  assert.equal(report.totals.reads.estimate,null);
  assert.equal(report.totals.failedRequests.estimate,0);
});

test('missing/invalid/negative/unsafe counts are unknown and never coerced to zero', () => {
  for (const value of [undefined,null,'12',-1,1.2,Number.MAX_SAFE_INTEGER+1]) {
    const report = summarize([operation({documentReadEstimate:value})]);
    assert.deepEqual(report.totals.reads,{estimate:null,known:0,unknownEntries:1});
  }
  assert.throws(()=>summarize([operation({documentReadEstimate:Number.MAX_SAFE_INTEGER}),operation()]),/safe integer/);
});

test('JSONL fixture formats accept prefixed messages, object data and raw descriptors without exposing private fields', () => {
  const descriptor = operation({path:'PRIVATE_PATH',body:'PRIVATE_BODY',accountId:'PRIVATE_ACCOUNT',replay:'PRIVATE_REPLAY',token:'PRIVATE_TOKEN'});
  const report = summarize([
    {message:FIRESTORE_OPERATION_LABEL+' '+JSON.stringify(descriptor)},
    {message:FIRESTORE_OPERATION_LABEL,data:descriptor},
    descriptor,
    {label:FIRESTORE_OPERATION_LABEL,...descriptor}
  ]);
  assert.equal(report.totals.reads.estimate,4);
  assert.equal(JSON.stringify(report).includes('PRIVATE'),false);
  const prototype = summarize([operation({collections:JSON.parse('{"__proto__":2,"constructor":1}'),documentReadEstimate:3})]);
  assert.equal(Object.hasOwn(prototype.byCollection,'__proto__'),true);
  assert.equal(prototype.byCollection.__proto__.reads.estimate,2);
});

test('mode is explicit so operation and legacy counts can never be silently combined', () => {
  assert.throws(()=>summarizeFirestoreAudit(''),/Choose --mode/);
  assert.throws(()=>summarizeFirestoreAudit('',{mode:'all'}),/Choose --mode/);
});

test('in-memory input limit is enforced on UTF-8 bytes, not character count', () => {
  const input = '\u00e9'.repeat(MAX_AUDIT_BYTES / 2 + 1);
  assert.ok(input.length < MAX_AUDIT_BYTES);
  assert.throws(()=>parseFirestoreAuditEvents(input),/50 MiB/);
});

test('bounded file CLI is offline, handles spaces, rejects >50 MiB, and never prints input errors', async t => {
  const directory = await mkdtemp(path.join(tmpdir(),'firestore-audit-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const fixture = path.join(directory,'audit fixture.jsonl');
  await writeFile(fixture,jsonl([operation()]));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ()=>{throw Error('Network forbidden');};
  try {
    assert.equal((await summarizeFirestoreAuditFile(fixture,{mode:'operations'})).totals.reads.estimate,1);
  } finally { globalThis.fetch = originalFetch; }
  const cli = fileURLToPath(new URL('./summarize-firestore-audit.mjs',import.meta.url));
  const result = spawnSync(process.execPath,[cli,'--mode','operations',fixture],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.equal(JSON.parse(result.stdout).totals.httpRequests.estimate,1);
  const missingMode = spawnSync(process.execPath,[cli,fixture],{encoding:'utf8'});
  assert.equal(missingMode.status,1);
  const missing = spawnSync(process.execPath,[cli,'--mode','legacy',path.join(directory,'PRIVATE_MISSING')],{encoding:'utf8'});
  assert.equal(missing.status,1);
  assert.equal(missing.stderr.includes('PRIVATE'),false);
  const large = path.join(directory,'large.jsonl');
  const handle = await open(large,'w');
  try { await handle.truncate(MAX_AUDIT_BYTES+1); } finally { await handle.close(); }
  await assert.rejects(summarizeFirestoreAuditFile(large,{mode:'operations'}),/50 MiB/);
  await assert.rejects(summarizeFirestoreAuditFile(directory,{mode:'operations'}));
});
