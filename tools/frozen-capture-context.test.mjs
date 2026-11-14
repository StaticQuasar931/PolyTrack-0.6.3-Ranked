import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {validateFrozenCaptureContext} from './frozen-capture-context.mjs';
import {capturedCanonicalInventory} from './captured-canonical-input.mjs';
const hash = b => createHash('sha256').update(b).digest('hex');
const source = '5dba2db0eb73555d3103b51a570e2d19d452a7ad';
const point = '2026-11-14T09:22:22.767357Z', since = Date.parse('2026-11-09T05:52:15.391433Z');
let root, directory, original, canonicalDirectory, profileDirectory;
const normal = p => p.replace(/\\/g, '/');
async function put(file, value) {const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)); await fs.writeFile(file, bytes); return {file, sha256: hash(bytes)};}
before(async () => {
  root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'polytrack-frozen-context-'));
  const day = path.join(root, '2026-11-14'), d2 = path.join(day, 'admission-repair-local');
  directory = path.join(day, 'frozen-capture-continuation');
  canonicalDirectory = path.join(d2, 'full-canonical-64924866-a080-486e-83c8-669ab8157d6f');
  const acquisition = path.join(directory, 'profile-acquisition-system-ca'); profileDirectory = path.join(acquisition, 'source-only-profiles');
  await fs.mkdir(canonicalDirectory, {recursive: true}); await fs.mkdir(path.join(profileDirectory, 'profiles'), {recursive: true});
  const prior = await put(path.join(d2, 'failed.json'), {status: 'failed', phase: 'capture', sourceCommit: source, automaticRetry: false, at: '2026-11-14T09:34:52.034Z'});
  const d2Fence = {directDocumentReadReservations: 24638, workerRequests: 89, priorDirectReservations: 37, priorWorkerRequests: 88, oauthRequests: 1, maxDirectReservations: 40000, maxWorkerRequests: 1024, stopped: false, documentWrites: 0};
  const log = await put(path.join(d2, 'capture.log'), JSON.stringify({canonicalCaptureFailure: {reason: 'memory_cap', rows: 101, pages: 2, reservedDocumentReads: 200, verificationAttempts: 0, documentWrites: 0, scanInconsistency: false, missingPriorCount: 0, missingBoards: []}}) + '\n' + JSON.stringify({fullSnapshotOperations: d2Fence}));
  for (let i = 0; i < 101; i++) await put(path.join(canonicalDirectory, 'page-' + Math.floor(i / 100) + '-' + i % 100 + '.json'), {readTime: point, document: {name: 'projects/polytrack-052/databases/(default)/documents/0.6.2_race_results/' + String(i).padStart(8, '0'), fields: {}}});
  const canonicalInventory = await put(path.join(d2, 'inventory.json'), await capturedCanonicalInventory(canonicalDirectory));
  const baseline = await put(path.join(root, 'public-export-summary.json'), {profilesCapturedAt: '2026-11-09T05:52:15.391433Z'});
  const files = {}; let totalBytes = 0;
  for (let start = 0; start < 1654; start += 32) await Promise.all(Array.from({length: Math.min(32, 1654 - start)}, async (_, offset) => {
    const id = (start + offset).toString(16).padStart(64, '0'), name = 'profiles/' + id + '.json';
    const bytes = Buffer.from(JSON.stringify({accountId: id, name: 'Frozen public profile', updatedAt: since + 1}));
    await fs.writeFile(path.join(profileDirectory, name), bytes); files[name] = {bytes: bytes.length, sha256: hash(bytes)}; totalBytes += bytes.length;
  }));
  const sourceFence = {directDocumentReadReservations: 26338, workerRequests: 89, priorDirectReservations: 24638, priorWorkerRequests: 89, oauthRequests: 1, maxDirectReservations: 40000, maxWorkerRequests: 1024, stopped: false, documentWrites: 0};
  const report = await put(path.join(profileDirectory, 'report.json'), {complete: true, sourceOnly: true, sourceCommit: source, since, readTime: point, originalCanonicalReadTime: point, documentLimit: 5000, profilesUpdated: 1654, pages: 17, estimatedDocumentReads: 1654, backendWrites: 0, baseline, sourceFence, documentBudget: {readLimit: 5000, usedReads: 1654, usedWrites: 0, stopped: false}});
  const inventory = await put(path.join(profileDirectory, 'inventory.json'), {schemaVersion: 1, files, totalBytes});
  const profileLog = await put(path.join(acquisition, 'profile-acquisition.log'), JSON.stringify({complete: true, profilesUpdated: 1654, pages: 17, readTime: point, sourceFence}));
  const firstFile = path.join(canonicalDirectory, 'page-0-0.json');
  const started = await put(path.join(acquisition, 'profile-acquisition.started.json'), {sourceCommit: source, since, readTime: point, documentLimit: 5000, priorDirectReservations: 24638, priorWorkerRequests: 89, baseline, canonicalFirstItem: {file: firstFile, sha256: hash(await fs.readFile(firstFile))}});
  original = {replacementDirectory: normal(directory), claimTag: 'polytrack-oneoff-2026-11-14-frozen-continuation', priorFailure: prior,
    capturedCanonicalPages: {directory: canonicalDirectory, sourceCommit: source, failure: prior, log, inventory: canonicalInventory},
    capturedProfiles: {directory: profileDirectory, report, inventory}, profileAcquisition: {started, log: profileLog},
    priorAccounting: {directDocumentReadReservations: 26338, workerRequests: 89, evidence: profileLog}};
});
after(async () => {if (root) {assert.equal(path.dirname(root), await fs.realpath(os.tmpdir())); await fs.rm(root, {recursive: true, force: true});}});
const fresh = () => structuredClone(original);
const validate = receipt => validateFrozenCaptureContext(receipt, {directory});
async function changed(binding, change, run) {
  const bytes = await fs.readFile(binding.file), prior = binding.sha256;
  try {const value = JSON.parse(bytes); change(value); const next = Buffer.from(JSON.stringify(value)); await fs.writeFile(binding.file, next); binding.sha256 = hash(next); await run();}
  finally {await fs.writeFile(binding.file, bytes); binding.sha256 = prior;}
}

test('production receipt validates frozen raw source and profiles offline, returning conservative cumulative reservations', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('No network is allowed'));
  const receipt = fresh(), before = JSON.stringify(receipt);
  assert.deepEqual(await validate(receipt), {priorDirectReservations: 26338, priorWorkerRequests: 89});
  assert.equal(JSON.stringify(receipt), before);
  assert.equal(await fs.readFile(receipt.priorFailure.file, 'utf8'), await fs.readFile(original.priorFailure.file, 'utf8'));
  const array = fresh(); array.priorAccounting.evidence = [array.capturedCanonicalPages.log, array.profileAcquisition.log];
  assert.deepEqual(await validate(array), {priorDirectReservations: 26338, priorWorkerRequests: 89});
});

test('old namespaces, tags, legacy capturedCanonical spelling and path aliases cannot authorize continuation', async () => {
  for (const mutate of [r => {r.replacementDirectory += '/other';}, r => {r.claimTag += '-retry';}, r => {r.capturedCanonical = r.capturedCanonicalPages; delete r.capturedCanonicalPages;}, r => {r.capturedCanonicalPages.sourceCommit = 'a'.repeat(40);}, r => {r.priorFailure.file = path.join(root, 'failed.json');}]) {
    const receipt = fresh(); mutate(receipt); await assert.rejects(validate(receipt));
  }
  await assert.rejects(validateFrozenCaptureContext(fresh(), {directory: path.dirname(directory)}));
});

test('D2 must be an exact capture-phase source375 failure, never a new retry or admission failure', async () => {
  for (const change of [v => {v.phase = 'admission-revalidation';}, v => {v.sourceCommit = 'a'.repeat(40);}, v => {v.automaticRetry = true;}, v => {v.status = 'complete';}]) {
    const receipt = fresh(); await changed(receipt.priorFailure, change, async () => {receipt.capturedCanonicalPages.failure = receipt.priorFailure; await assert.rejects(validate(receipt));});
  }
});

test('canonical memory failure must represent a terminal complete scan with no missing source or verification', async () => {
  for (const change of [v => {v.reason = 'output_cap';}, v => {v.verificationAttempts = 1;}, v => {v.missingPriorCount = 1;}, v => {v.missingBoards = ['missing'];}, v => {v.scanInconsistency = true;}]) {
    const receipt = fresh(), binding = receipt.capturedCanonicalPages.log, old = await fs.readFile(binding.file), previous = binding.sha256;
    try {const rows = old.toString().split('\n').map(JSON.parse); change(rows[0].canonicalCaptureFailure); const bytes = Buffer.from(rows.map(JSON.stringify).join('\n')); await fs.writeFile(binding.file, bytes); binding.sha256 = hash(bytes); await assert.rejects(validate(receipt));}
    finally {await fs.writeFile(binding.file, old); binding.sha256 = previous;}
  }
});

test('missing, changed and duplicated accounting evidence or understated reservations fail closed', async () => {
  for (const mutate of [r => {r.priorAccounting.directDocumentReadReservations = 26292;}, r => {r.priorAccounting.workerRequests = 88;}, r => {r.priorAccounting.evidence = r.capturedCanonicalPages.log;}, r => {r.priorAccounting.evidence = [r.profileAcquisition.log, r.profileAcquisition.log];}, r => {r.priorAccounting.evidence = [r.capturedCanonicalPages.log];}, r => {r.profileAcquisition.log.sha256 = '0'.repeat(64);}]) {
    const receipt = fresh(); mutate(receipt); await assert.rejects(validate(receipt));
  }
});

test('profile report must be source-only, explicit5000, same frozen time and exact successful coverage', async () => {
  for (const change of [v => {v.sourceOnly = false;}, v => {delete v.documentLimit;}, v => {v.documentLimit = 2000;}, v => {v.readTime = '2026-11-14T09:23:00Z';}, v => {v.originalCanonicalReadTime = 'wrong';}, v => {v.backendWrites = 1;}, v => {v.complete = false;}, v => {v.sourceCommit = 'a'.repeat(40);}, v => {v.profilesUpdated = 5000;}, v => {v.pages = 18;}]) {
    const receipt = fresh(); await changed(receipt.capturedProfiles.report, change, () => assert.rejects(validate(receipt)));
  }
});

test('profile budget chain cannot reset prior totals, add Worker calls, exceed caps or conceal writes and retries', async () => {
  for (const change of [v => {v.priorDirectReservations = 0;}, v => {v.priorWorkerRequests = 0;}, v => {v.directDocumentReadReservations = 40001;}, v => {v.workerRequests = 1025;}, v => {v.maxDirectReservations = 50000;}, v => {v.maxWorkerRequests = 2048;}, v => {v.documentWrites = 1;}, v => {v.stopped = true;}]) {
    const receipt = fresh(); await changed(receipt.profileAcquisition.log, v => change(v.sourceFence), () => assert.rejects(validate(receipt)));
  }
});

test('duplicate profile acquisition records and failed successful-namespace receipts reject, unrelated old failed attempt remains untouched', async () => {
  const receipt = fresh(), file = receipt.profileAcquisition.log.file, bytes = await fs.readFile(file);
  try {await fs.writeFile(file, Buffer.concat([bytes, Buffer.from('\n'), bytes])); receipt.profileAcquisition.log.sha256 = hash(await fs.readFile(file)); await assert.rejects(validate(receipt), /Exactly one/);} finally {await fs.writeFile(file, bytes);}
  const failed = path.join(path.dirname(file), 'profile-acquisition.failed.json');
  try {await fs.writeFile(failed, '{}'); await assert.rejects(validate(fresh()), /Failed profile acquisition/);} finally {await fs.unlink(failed);}
  const unrelated = path.join(directory, 'profile-acquisition.failed.json');
  try {await fs.writeFile(unrelated, '{"failedBeforeSource":true}'); assert.deepEqual(await validate(fresh()), {priorDirectReservations: 26338, priorWorkerRequests: 89});} finally {await fs.unlink(unrelated);}
});

test('SHA-bound profile bytes, inventory totals, canonical raw pages and baseline cannot be replaced by materialized proof', async () => {
  const receipt = fresh(), profile = path.join(profileDirectory, 'profiles', '0'.repeat(64) + '.json'), bytes = await fs.readFile(profile);
  try {await fs.appendFile(profile, ' '); await assert.rejects(validate(receipt), /SHA changed/);} finally {await fs.writeFile(profile, bytes);}
  const bad = fresh(); await changed(bad.capturedProfiles.inventory, v => {v.totalBytes++;}, () => assert.rejects(validate(bad)));
  const raw = path.join(canonicalDirectory, 'page-1-0.json'), rawBytes = await fs.readFile(raw);
  try {await fs.writeFile(raw, JSON.stringify({verified: true, complete: true, readTime: point})); await assert.rejects(validate(fresh()));} finally {await fs.writeFile(raw, rawBytes);}
  const baseline = fresh(); await changed(baseline.capturedProfiles.report, v => {v.baseline.sha256 = '0'.repeat(64);}, () => assert.rejects(validate(baseline)));
});
