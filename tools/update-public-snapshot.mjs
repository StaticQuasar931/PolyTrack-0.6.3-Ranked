import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeSnapshot, publishSnapshot, MAX_DECODED_BYTES } from './snapshot-package.mjs';
import { runPublicSnapshotBackup } from './public-snapshot-backup.mjs';
import { exportPublicProfilesAndReplays } from './public-profile-replay-export.mjs';
import { capturePublicEventTotals } from './public-event-totals-backup.mjs';

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOGICAL_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+\.json$/;
const HASH = /^[a-f0-9]{64}$/;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function containedChild(root, name) {
  const absoluteRoot = path.resolve(root);
  const target = path.resolve(absoluteRoot, name);
  if (path.dirname(target) !== absoluteRoot || path.basename(target) !== name) throw new Error(`Unsafe repository child path: ${name}`);
  return target;
}

async function hydrateStaging(root, stagingDirectory) {
  const pointer = JSON.parse(await fs.readFile(path.join(root, 'snapshot-current.json'), 'utf8'));
  if (typeof pointer.currentdir !== 'string' || !/^public-snapshots[1-9]\d*$/.test(pointer.currentdir)) {
    throw new Error('Current snapshot pointer is invalid');
  }
  const generationDirectory = containedChild(root, pointer.currentdir);
  const indexBytes = await fs.readFile(path.join(generationDirectory, 'index.json'));
  const index = JSON.parse(indexBytes.toString('utf8'));
  if (index.schemaVersion !== 1 || index.encoding !== 'gzip-xor-a7-v1' || !index.files || typeof index.files !== 'object' || Array.isArray(index.files)) {
    throw new Error('Current snapshot index is invalid');
  }
  const hydrated = [];
  for (const [logicalPath, item] of Object.entries(index.files)) {
    if (logicalPath === 'export-progress.json' || !LOGICAL_PATH.test(logicalPath) || logicalPath.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error(`Unsafe logical snapshot path: ${logicalPath}`);
    }
    if (!item || typeof item.path !== 'string' || item.path !== `${item.sha256}.bin` || !HASH.test(item.sha256) ||
        !Number.isSafeInteger(item.decodedBytes) || item.decodedBytes < 0 || item.decodedBytes > MAX_DECODED_BYTES) {
      throw new Error(`Invalid snapshot index entry: ${logicalPath}`);
    }
    const payloadName = path.basename(item.path);
    if (payloadName !== item.path) throw new Error(`Unsafe snapshot payload path: ${item.path}`);
    const encoded = await fs.readFile(path.join(generationDirectory, payloadName));
    if (sha256(encoded) !== item.sha256) throw new Error(`Snapshot payload hash mismatch: ${logicalPath}`);
    const decoded = Buffer.from(await decodeSnapshot(encoded));
    if (decoded.byteLength !== item.decodedBytes || decoded.byteLength > MAX_DECODED_BYTES) throw new Error(`Snapshot decoded size mismatch: ${logicalPath}`);
    JSON.parse(decoded.toString('utf8'));
    hydrated.push({ logicalPath, decoded });
  }
  await fs.mkdir(stagingDirectory, { recursive: true });
  for (const { logicalPath, decoded } of hydrated) {
    const target = path.resolve(stagingDirectory, ...logicalPath.split('/'));
    if (!target.startsWith(`${path.resolve(stagingDirectory)}${path.sep}`)) throw new Error(`Snapshot path escaped staging: ${logicalPath}`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, decoded, { flag: 'wx' });
  }
  return { directory: pointer.currentdir, files: hydrated.length };
}

async function readJsonIfPresent(filePath) {
  try { return JSON.parse(await fs.readFile(filePath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function makeCoverage(overall, manifest, exportResult, previousCoverage, savedExportSummary) {
  const replayCount = manifest?.eventReplays && typeof manifest.eventReplays === 'object'
    ? Object.keys(manifest.eventReplays).length
    : Number.isSafeInteger(manifest?.eventReplays) ? manifest.eventReplays : null;
  const backup = {
    overallComplete: overall?.complete === true,
    overallEntries: Number.isSafeInteger(overall?.entries?.length) ? overall.entries.length : null,
    tracksKnown: Number.isSafeInteger(manifest?.trackIdsKnown) ? manifest.trackIdsKnown : null,
    tracksPresent: Number.isSafeInteger(manifest?.trackBackupsPresent) ? manifest.trackBackupsPresent : null,
    tracksMissing: Number.isSafeInteger(manifest?.trackBackupsMissing) ? manifest.trackBackupsMissing : null,
    eventsKnown: Array.isArray(manifest?.selectedEventIds) ? manifest.selectedEventIds.length : null,
    eventsPresent: manifest?.events && typeof manifest.events === 'object'
      ? Object.values(manifest.events).filter(item => item?.path).length : null,
    eventsMissing: Number.isSafeInteger(manifest?.eventsMissing) ? manifest.eventsMissing : null,
    eventReplays: replayCount,
    deferred: manifest?.deferred === true,
  };
  const liveCoverage = exportResult?.coverage || exportResult?.totalCoverage;
  const savedCoverage = savedExportSummary?.coverage || savedExportSummary?.totalCoverage;
  const profileReplay = exportResult ? {
    requested: true,
    complete: exportResult.complete === true && liveCoverage?.complete === true &&
      (liveCoverage.invalid ?? 0) === 0 && (liveCoverage.missing ?? 0) === 0,
    counts: exportResult.counts || null,
    scanned: Number.isSafeInteger(exportResult.scanned) ? exportResult.scanned : null,
    coverage: liveCoverage || null,
    budgetReached: exportResult.budgetReached === true,
    incompletePage: exportResult.incompletePage === true,
  } : savedExportSummary && typeof savedExportSummary === 'object' ? {
    requested: true,
    complete: savedExportSummary.complete === true &&
      savedCoverage?.complete === true && (savedCoverage.invalid ?? 0) === 0 && (savedCoverage.missing ?? 0) === 0,
    counts: savedExportSummary.counts || null,
    scanned: Number.isSafeInteger(savedExportSummary.scanned) ? savedExportSummary.scanned : null,
    coverage: savedCoverage || null,
    budgetReached: savedExportSummary.budgetReached === true,
    incompletePage: savedExportSummary.incompletePage === true,
  } : previousCoverage?.profileReplay && typeof previousCoverage.profileReplay === 'object'
    ? previousCoverage.profileReplay : { requested: false, complete: false };
  return {
    schemaVersion: 1,
    complete: backup.overallComplete && backup.tracksMissing === 0 && backup.eventsMissing === 0 && profileReplay.complete,
    backup,
    profileReplay,
  };
}

async function updateMeta(root, generationDirectory) {
  const indexPath = path.join(root, 'index.html');
  let html = await fs.readFile(indexPath, 'utf8');
  const meta = `<meta name="polytrack-snapshot" content="./${generationDirectory}/">`;
  const expression = /<meta\s+name=["']polytrack-snapshot["'][^>]*>/i;
  html = expression.test(html) ? html.replace(expression, meta) : html.replace(/<head\b[^>]*>/i, match => `${match}\n    ${meta}`);
  if (!html.includes(meta)) throw new Error('Could not insert snapshot meta tag into index.html');
  const temporary = `${indexPath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, html, { flag: 'wx' });
  await fs.rename(temporary, indexPath);
}

async function moveIntoHistory(root, sourceName, destinationName) {
  const source = containedChild(root, sourceName);
  const history = containedChild(root, 'local-reports');
  const historyDirectory = path.join(history, 'snapshot-history');
  await fs.mkdir(historyDirectory, { recursive: true });
  const destination = path.join(historyDirectory, destinationName);
  try { await fs.lstat(source); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  try { await fs.lstat(destination); return false; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.rename(source, destination);
  return true;
}

export async function updatePublicSnapshot({ root = moduleRoot, offline = false, fullPublic = false,
  capture = runPublicSnapshotBackup, captureTotals = capturePublicEventTotals,
  captureOptions = {}, exportPublic = exportPublicProfilesAndReplays, log = console.log } = {}) {
  const absoluteRoot = path.resolve(root);
  const stagingDirectory = path.join(absoluteRoot, 'local-reports', 'snapshot-staging');
  const historyDirectory = path.join(absoluteRoot, 'local-reports', 'snapshot-history');
  const stageStat = await fs.stat(stagingDirectory).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  let backupResult = null;
  let exportResult = null;
  if (!stageStat) {
    const pointer = await readJsonIfPresent(path.join(absoluteRoot, 'snapshot-current.json'));
    if (pointer) await hydrateStaging(absoluteRoot, stagingDirectory);
    else if (offline) throw new Error('Offline packaging needs staging data or a current packed generation');
    else await fs.mkdir(stagingDirectory, { recursive: true });
  }
  if (!offline) {
    backupResult = await capture({ ...captureOptions, directory: stagingDirectory, log });
    if (capture === runPublicSnapshotBackup) {
      try { await captureTotals({ directory: stagingDirectory, log }); }
      catch (error) { log(JSON.stringify({ publicEventTotalsBackup: { preservedPrevious: true, error: error.message } })); }
    }
    if (backupResult?.deferred) throw new Error(`Snapshot capture deferred: ${backupResult.reason || 'previous backups preserved'}`);
  }
  if (fullPublic) {
    const previousProgress = await readJsonIfPresent(path.join(stagingDirectory, 'export-progress.json'));
    const startFullSnapshot = previousProgress?.fullSnapshotPending !== true;
    exportResult = await exportPublic({ directory: stagingDirectory, snapshotDirectory: stagingDirectory, maxDocuments: 2000,
      fullSnapshot: startFullSnapshot, log });
    const summary={counts:exportResult.counts,scanned:exportResult.scanned,
      coverage:exportResult.coverage||exportResult.totalCoverage,complete:exportResult.complete===true,
      budgetReached:exportResult.budgetReached===true,incompletePage:exportResult.incompletePage===true};
    await fs.writeFile(path.join(stagingDirectory,'public-export-summary.json'),JSON.stringify(summary)+'\n');
  }

  const overall = await readJsonIfPresent(path.join(stagingDirectory, 'overall.json'));
  const manifest = await readJsonIfPresent(path.join(stagingDirectory, 'manifest.json'));
  const previousCoverage = await readJsonIfPresent(path.join(stagingDirectory, 'coverage.json'));
  const savedExportSummary = await readJsonIfPresent(path.join(stagingDirectory, 'public-export-summary.json'));
  const coverage = makeCoverage(overall, manifest, exportResult, previousCoverage, savedExportSummary);
  await fs.writeFile(path.join(stagingDirectory, 'coverage.json'), `${JSON.stringify(coverage, null, 2)}\n`);

  let oldCurrent = null;
  try {
    const pointer = await readJsonIfPresent(path.join(absoluteRoot, 'snapshot-current.json'));
    if (typeof pointer?.currentdir === 'string' && /^public-snapshots[1-9]\d*$/.test(pointer.currentdir)) oldCurrent = pointer.currentdir;
  } catch {}
  const result = await publishSnapshot({ root: absoluteRoot, stagingDirectory, historyDirectory });
  await updateMeta(absoluteRoot, result.directory);

  if (oldCurrent && oldCurrent !== result.directory && result.archivePath) {
    const generation = Number(/^public-snapshots([1-9]\d*)$/.exec(oldCurrent)?.[1]);
    const archive = path.join(historyDirectory, `generation-${generation}.snapshot.gz`);
    if (Number.isSafeInteger(generation) && await fs.stat(archive).then(() => true, () => false)) {
      await moveIntoHistory(absoluteRoot, oldCurrent, `retired-${oldCurrent}`);
    }
  }
  await moveIntoHistory(absoluteRoot, 'public-snapshots', 'legacy-public-snapshots');
  const names = await fs.readdir(absoluteRoot);
  for (const name of names) {
    const match = /^public-snapshots([1-9]\d*)$/.exec(name);
    if (!match || name === result.directory) continue;
    const archive = path.join(historyDirectory, `generation-${Number(match[1])}.snapshot.gz`);
    if (await fs.stat(archive).then(() => true, () => false)) await moveIntoHistory(absoluteRoot, name, `retired-${name}`);
  }
  const summary = { ...result, coverage, backup: backupResult, profileReplay: exportResult };
  log(JSON.stringify({ updatePublicSnapshot: summary }));
  return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = new Set(process.argv.slice(2));
  const unknown = [...args].filter(arg => !['--offline', '--full-public'].includes(arg));
  if (unknown.length) throw new Error(`Unknown arguments: ${unknown.join(', ')}`);
  await updatePublicSnapshot({ offline: args.has('--offline'), fullPublic: args.has('--full-public') });
}
