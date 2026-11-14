import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {openCapturedCanonicalInput} from './captured-canonical-input.mjs';
import {openCapturedProfileDelta} from './captured-profile-input.mjs';

const SOURCE = '5dba2db0eb73555d3103b51a570e2d19d452a7ad';
const SUFFIX = '/2026-11-14/frozen-capture-continuation';
const TAG = 'polytrack-oneoff-2026-11-14-frozen-continuation';
const D2_DIRECT = 24638, WORKER = 89, FINAL_DIRECT = 26338;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const uint = value => Number.isSafeInteger(value) && value >= 0;
const demand = (ok, message) => {if (!ok) throw Error(message);};
const normalized = value => path.resolve(value).replace(/\\/g, '/');
const same = (a, b) => a?.sha256 === b?.sha256 && typeof a?.file === 'string' && typeof b?.file === 'string' && normalized(a.file) === normalized(b.file);
const within = (root, file) => file === root || file.startsWith(root + '/');

async function safeFile(file, maxBytes) {
  demand(typeof file === 'string' && path.isAbsolute(file), 'Absolute frozen evidence path required');
  const resolved = normalized(file), st = await fs.lstat(file);
  demand(st.isFile() && !st.isSymbolicLink() && st.size <= maxBytes && normalized(await fs.realpath(file)) === resolved,
    'Unsafe frozen evidence file');
  const bytes = await fs.readFile(file);
  demand(bytes.length <= maxBytes, 'Frozen evidence file exceeds bound');
  return bytes;
}
async function evidence(binding, maxBytes = 16 * 1024 * 1024) {
  demand(binding && /^[a-f0-9]{64}$/.test(binding.sha256 || ''), 'SHA-bound frozen evidence required');
  const bytes = await safeFile(binding.file, maxBytes);
  demand(hash(bytes) === binding.sha256, 'Frozen evidence SHA changed');
  return bytes;
}
async function safeDirectory(directory) {
  demand(typeof directory === 'string' && path.isAbsolute(directory), 'Absolute frozen source directory required');
  const root = normalized(directory), st = await fs.lstat(directory);
  demand(st.isDirectory() && !st.isSymbolicLink() && normalized(await fs.realpath(directory)) === root, 'Unsafe frozen source directory');
  return root;
}
function records(bytes) {
  const result = [];
  for (const line of bytes.toString('utf8').split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    try {result.push(JSON.parse(line));} catch {throw Error('Malformed frozen accounting JSON');}
  }
  return result;
}
function one(rows, key) {
  const found = rows.filter(row => row && Object.hasOwn(row, key));
  demand(found.length === 1, 'Exactly one frozen ' + key + ' record required');
  return found[0];
}
function fence(value, priorDirect, priorWorker, finalDirect) {
  demand(value && value.priorDirectReservations === priorDirect && value.priorWorkerRequests === priorWorker &&
    value.directDocumentReadReservations === finalDirect && value.workerRequests === WORKER &&
    uint(value.directDocumentReadReservations) && value.directDocumentReadReservations <= 40000 &&
    uint(value.workerRequests) && value.workerRequests <= 1024 && value.maxDirectReservations === 40000 &&
    value.maxWorkerRequests === 1024 && value.documentWrites === 0 && value.stopped === false &&
    uint(value.oauthRequests) && value.oauthRequests <= 12, 'Frozen accounting chain or fixed budget changed');
}

/** Offline validation only. Never applies profiles, requests source, or changes guards. */
export async function validateFrozenCaptureContext(receipt, {directory} = {}) {
  const root = await safeDirectory(directory);
  demand(root.endsWith(SUFFIX) && receipt?.replacementDirectory === root && receipt.claimTag === TAG,
    'Exact frozen continuation namespace and claim required');
  const day = path.dirname(root), d2 = normalized(path.join(day, 'admission-repair-local'));
  const prior = receipt.priorFailure, canonical = receipt.capturedCanonicalPages, profiles = receipt.capturedProfiles;
  demand(prior && normalized(prior.file || '') === d2 + '/failed.json', 'Exact D2 failure required');
  const failure = JSON.parse(await evidence(prior, 1024 * 1024));
  demand(failure.status === 'failed' && failure.phase === 'capture' && failure.sourceCommit === SOURCE &&
    failure.automaticRetry === false, 'D2 must be immutable source375 capture failure');
  demand(canonical?.sourceCommit === SOURCE && same(canonical.failure, prior) &&
    normalized(canonical.log?.file || '') === d2 + '/capture.log', 'Canonical source/failure/log binding changed');
  const canonicalRoot = await safeDirectory(canonical.directory);
  demand(path.dirname(canonicalRoot) === d2 && /^full-canonical-[a-f0-9-]{36}$/.test(path.basename(canonicalRoot)),
    'Canonical pages must remain in the D2 source namespace');
  const d2Bytes = await evidence(canonical.log), d2Rows = records(d2Bytes);
  const scan = one(d2Rows, 'canonicalCaptureFailure').canonicalCaptureFailure;
  demand(scan.reason === 'memory_cap' && scan.documentWrites === 0 && scan.verificationAttempts === 0 &&
    uint(scan.reservedDocumentReads) && scan.reservedDocumentReads === scan.pages * 100 &&
    scan.reservedDocumentReads <= D2_DIRECT - 37, 'Only a completed memory-cap source scan may continue');
  fence(one(d2Rows, 'fullSnapshotOperations').fullSnapshotOperations, 37, 88, D2_DIRECT);
  const rawInventory = JSON.parse(await evidence(canonical.inventory));
  demand(rawInventory.schemaVersion === 1 && rawInventory.files && typeof rawInventory.files === 'object', 'Bound raw canonical inventory required');
  const rawNames = Object.keys(rawInventory.files).sort();
  demand(rawNames.length > 0 && rawNames.length <= 30001, 'Raw canonical file count exceeds bound');
  let rawBytes = 0;
  for (const name of rawNames) {
    const item = rawInventory.files[name];
    demand(/^page-\d+-\d+\.json$/.test(name) && uint(item?.bytes) && item.bytes <= 2 * 1024 * 1024 &&
      /^[a-f0-9]{64}$/.test(item.sha256 || ''), 'Unsafe raw canonical inventory entry');
    rawBytes += item.bytes;
  }
  demand(rawBytes <= 256 * 1024 * 1024, 'Raw canonical bytes exceed bound');
  const actualNames = (await fs.readdir(canonicalRoot)).filter(name => /^page-\d+-\d+\.json$/.test(name)).sort();
  demand(isDeepStrictEqual(rawNames, actualNames), 'Raw canonical file inventory changed');
  const captured = await openCapturedCanonicalInput(canonical);
  demand(Number.isFinite(Date.parse(failure.at)) && Date.parse(captured.readTime) >= Date.parse('2026-11-14T08:00:00Z') &&
    Date.parse(captured.readTime) <= Date.parse(failure.at), 'Frozen canonical time is outside D2 capture');

  const profileRoot = await safeDirectory(profiles?.directory);
  const acquisitionRoot = normalized(path.dirname(profileRoot));
  demand(within(root, acquisitionRoot) && acquisitionRoot !== root && path.basename(profileRoot) === 'source-only-profiles',
    'Profiles require their distinct successful acquisition namespace');
  const acquisition = receipt.profileAcquisition;
  demand(acquisition && normalized(acquisition.started?.file || '') === acquisitionRoot + '/profile-acquisition.started.json' &&
    normalized(acquisition.log?.file || '') === acquisitionRoot + '/profile-acquisition.log' &&
    normalized(profiles.report?.file || '') === profileRoot + '/report.json' &&
    normalized(profiles.inventory?.file || '') === profileRoot + '/inventory.json', 'Bound profile acquisition evidence required');
  try {await fs.lstat(path.join(acquisitionRoot, 'profile-acquisition.failed.json')); throw Error('Failed profile acquisition cannot continue');}
  catch (error) {if (error.code !== 'ENOENT') throw error;}
  const started = JSON.parse(await evidence(acquisition.started, 1024 * 1024));
  const report = JSON.parse(await evidence(profiles.report));
  const inventory = JSON.parse(await evidence(profiles.inventory));
  const profileRow = one(records(await evidence(acquisition.log)), 'sourceFence');
  demand(report.complete === true && report.sourceOnly === true && report.documentLimit === 5000 && report.backendWrites === 0 &&
    report.sourceCommit === SOURCE && report.readTime === captured.readTime && report.originalCanonicalReadTime === captured.readTime &&
    uint(report.profilesUpdated) && report.profilesUpdated < 5000 && report.pages === Math.floor(report.profilesUpdated / 100) + 1 &&
    report.estimatedDocumentReads === report.profilesUpdated + (report.profilesUpdated % 100 === 0 ? 1 : 0) &&
    profileRow.complete === true && profileRow.profilesUpdated === report.profilesUpdated && profileRow.pages === report.pages &&
    profileRow.readTime === captured.readTime, 'Complete source-only 5000-profile report required at the canonical point');
  demand(started.sourceCommit === SOURCE && started.readTime === captured.readTime && started.since === report.since &&
    started.documentLimit === 5000 && started.priorDirectReservations === D2_DIRECT && started.priorWorkerRequests === WORKER &&
    same(started.baseline, report.baseline), 'Profile acquisition start does not bind this frozen source');
  demand(uint(report.since) && report.since < Date.parse(captured.readTime), 'Invalid profile baseline watermark');
  const baseline = JSON.parse(await evidence(report.baseline));
  demand(Date.parse(baseline.profilesCapturedAt || baseline.capturedAt) === report.since, 'Profile baseline SHA or watermark changed');
  const first = normalized(started.canonicalFirstItem?.file || '');
  demand(first === canonicalRoot + '/page-0-0.json', 'Profile acquisition must bind the first canonical item');
  const firstBytes = await evidence(started.canonicalFirstItem, 2 * 1024 * 1024);
  demand(JSON.parse(firstBytes).readTime === captured.readTime, 'Profile first canonical item time changed');
  fence(profileRow.sourceFence, D2_DIRECT, WORKER, FINAL_DIRECT);
  demand(isDeepStrictEqual(profileRow.sourceFence, report.sourceFence) &&
    profileRow.sourceFence.directDocumentReadReservations - D2_DIRECT === report.pages * 100 &&
    report.documentBudget?.readLimit === 5000 && report.documentBudget.usedReads === report.estimatedDocumentReads &&
    report.documentBudget.usedWrites === 0 && report.documentBudget.stopped === false, 'Profile acquisition accounting/report mismatch');
  demand(inventory.schemaVersion === 1 && inventory.files && uint(inventory.totalBytes) &&
    Object.keys(inventory.files).length === report.profilesUpdated, 'Bound profile inventory required');
  let totalBytes = 0;
  for (const [name, item] of Object.entries(inventory.files)) {
    demand(/^profiles\/[a-f0-9]{64}\.json$/.test(name) && uint(item?.bytes) && item.bytes <= 2 * 1024 * 1024,
      'Unsafe captured profile inventory entry');
    totalBytes += item.bytes;
  }
  demand(totalBytes === inventory.totalBytes && totalBytes <= 16 * 1024 * 1024, 'Captured profile inventory byte total mismatch');
  for (const [name, item] of Object.entries(inventory.files)) {
    const bytes = await evidence({file: path.join(profileRoot, name), sha256: item.sha256}, 2 * 1024 * 1024);
    demand(bytes.length === item.bytes, 'Captured profile byte length changed');
  }
  await openCapturedProfileDelta(profiles);

  const accounting = receipt.priorAccounting;
  const logs = accounting?.evidence;
  const finalBound = Array.isArray(logs) ? logs.length === 2 && same(logs[0], canonical.log) &&
    same(logs[1], acquisition.log) && normalized(logs[0].file) !== normalized(logs[1].file) : same(logs, acquisition.log);
  demand(finalBound && accounting.directDocumentReadReservations === FINAL_DIRECT && accounting.workerRequests === WORKER,
    'Both cumulative accounting logs and exact final carried reservations required');
  return {priorDirectReservations: FINAL_DIRECT, priorWorkerRequests: WORKER};
}
