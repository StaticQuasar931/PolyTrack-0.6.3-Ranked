import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { decodeSnapshot, publishSnapshot, MAX_DECODED_BYTES } from './snapshot-package.mjs';
import { runPublicSnapshotBackup } from './public-snapshot-backup.mjs';
import { PublicBackupDeferredError } from './public-backup-fetch.mjs';
import { exportPublicProfilesAndReplays } from './public-profile-replay-export.mjs';
import { createSnapshotExportFetch } from './snapshot-export-auth.mjs';
import { capturePublicEventTotals } from './public-event-totals-backup.mjs';
import { buildProfileSnapshotResults } from './build-profile-snapshot-results.mjs';

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOGICAL_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+\.json$/;
const HASH = /^[a-f0-9]{64}$/;
const PAGE_SIZE = 100;
const MAX_RECONSTRUCTION_PAGES = 4096;
const MAX_RECONSTRUCTION_BYTES = 512 * 1024 * 1024;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function containedChild(root, name) {
  const absoluteRoot = path.resolve(root);
  const target = path.resolve(absoluteRoot, name);
  if (path.dirname(target) !== absoluteRoot || path.basename(target) !== name) throw new Error(`Unsafe repository child path: ${name}`);
  return target;
}

function validateBoardManifest(manifest, { kind, logicalPath }) {
  const positiveOrZero = value => Number.isSafeInteger(value) && value >= 0;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.kind !== kind ||
      manifest.pagingVersion !== 1 || manifest.sourceLogicalPath !== logicalPath ||
      manifest.fullBoardPath !== (manifest.monolithOmitted ? null : logicalPath) || typeof manifest.monolithOmitted !== 'boolean' ||
      manifest.complete !== (manifest.sourceComplete === true) || typeof manifest.sourceComplete !== 'boolean' ||
      manifest.pageSize !== PAGE_SIZE || !positiveOrZero(manifest.pageCount) ||
      !positiveOrZero(manifest.publishedEntries) ||
      !(manifest.totalEntries === null || positiveOrZero(manifest.totalEntries)) ||
      typeof manifest.totalEntriesExact !== 'boolean' || typeof manifest.ranksExact !== 'boolean' ||
      !(manifest.capturedAt === null || typeof manifest.capturedAt === 'string') ||
      !manifest.boardMetadata || typeof manifest.boardMetadata !== 'object' || Array.isArray(manifest.boardMetadata) ||
      !Array.isArray(manifest.pageBounds) || manifest.pageBounds.length !== manifest.pageCount ||
      manifest.pageCount !== Math.ceil(manifest.publishedEntries / PAGE_SIZE)) {
    throw new Error(`Invalid ${kind} paging manifest: ${logicalPath}`);
  }
  if (manifest.sourceComplete && (manifest.totalEntries !== manifest.publishedEntries || !manifest.totalEntriesExact)) {
    throw new Error(`Incomplete source totals in ${kind}: ${logicalPath}`);
  }
}

function validatePagingCatalog(index, hydrated) {
  const catalogEntry = hydrated.get('snapshot-paging.json');
  const manifestPaths = Object.keys(index.files).filter(logicalPath =>
    /^track-manifests\/[a-f0-9]{64}\.json$/.test(logicalPath));
  const hasOverallManifest = Object.hasOwn(index.files, 'overall-manifest.json');
  if (!catalogEntry) {
    if (manifestPaths.length || hasOverallManifest || Object.keys(index.files).some(logicalPath =>
      /^(?:track-pages|overall-pages)\//.test(logicalPath))) {
      throw new Error('Snapshot paging files exist without snapshot-paging.json');
    }
    return [];
  }
  const catalog = catalogEntry.value;
  if (catalog?.schemaVersion !== 1 || catalog.pagingVersion !== 1 || catalog.pageSize !== PAGE_SIZE ||
      typeof catalog.legacyMonolithCoverageComplete !== 'boolean' || !Array.isArray(catalog.omittedMonoliths) ||
      !catalog.tracks || typeof catalog.tracks !== 'object' || Array.isArray(catalog.tracks) ||
      !(catalog.overall === null || (catalog.overall && typeof catalog.overall === 'object' && !Array.isArray(catalog.overall)))) {
    throw new Error('Invalid snapshot paging catalog');
  }

  const omitted = [];
  const reconstruct = [];
  const expectedTrackIds = new Set(manifestPaths.map(logicalPath => logicalPath.slice('track-manifests/'.length, -'.json'.length)));
  if (Object.keys(catalog.tracks).length !== expectedTrackIds.size) throw new Error('Snapshot paging catalog track coverage mismatch');
  for (const trackId of expectedTrackIds) {
    const manifestPath = `track-manifests/${trackId}.json`;
    const hydratedManifest = hydrated.get(manifestPath);
    if (!hydratedManifest) throw new Error(`Missing track paging manifest: ${manifestPath}`);
    const manifest = hydratedManifest.value;
    validateBoardManifest(manifest, { kind: 'track-manifest', logicalPath: `tracks/${trackId}.json` });
    const descriptor = catalog.tracks[trackId];
    const expected = { manifestPath, fullBoardPath: manifest.fullBoardPath, monolithOmitted: manifest.monolithOmitted,
      pageCount: manifest.pageCount, publishedEntries: manifest.publishedEntries, totalEntries: manifest.totalEntries,
      sourceComplete: manifest.sourceComplete, ranksExact: manifest.ranksExact };
    if (!isDeepStrictEqual(descriptor, expected)) throw new Error(`Snapshot paging catalog mismatch: ${trackId}`);
    if (manifest.monolithOmitted) {
      omitted.push(manifest.sourceLogicalPath);
      reconstruct.push({ manifestPath, manifest, logicalPath: manifest.sourceLogicalPath, kind: 'track-manifest', trackId });
    } else if (!Object.hasOwn(index.files, manifest.sourceLogicalPath)) {
      throw new Error(`Expected track monolith is missing: ${manifest.sourceLogicalPath}`);
    }
  }

  if (hasOverallManifest) {
    const hydratedManifest = hydrated.get('overall-manifest.json');
    if (!hydratedManifest) throw new Error('Missing overall paging manifest');
    const manifest = hydratedManifest.value;
    validateBoardManifest(manifest, { kind: 'overall-manifest', logicalPath: 'overall.json' });
    const expected = { manifestPath: 'overall-manifest.json', fullBoardPath: manifest.fullBoardPath,
      monolithOmitted: manifest.monolithOmitted, pageCount: manifest.pageCount,
      publishedEntries: manifest.publishedEntries, totalEntries: manifest.totalEntries,
      sourceComplete: manifest.sourceComplete, ranksExact: manifest.ranksExact };
    if (!isDeepStrictEqual(catalog.overall, expected)) throw new Error('Snapshot paging catalog overall mismatch');
    if (manifest.monolithOmitted) {
      omitted.push('overall.json');
      reconstruct.push({ manifestPath: 'overall-manifest.json', manifest, logicalPath: 'overall.json', kind: 'overall-manifest' });
    } else if (!Object.hasOwn(index.files, 'overall.json')) {
      throw new Error('Expected overall monolith is missing');
    }
  } else if (catalog.overall !== null) {
    throw new Error('Snapshot paging catalog has an unbacked overall descriptor');
  }

  const listedOmitted = [...catalog.omittedMonoliths].sort();
  const expectedOmitted = omitted.sort();
  if (!isDeepStrictEqual(listedOmitted, expectedOmitted) ||
      catalog.legacyMonolithCoverageComplete !== (expectedOmitted.length === 0)) {
    throw new Error('Snapshot paging catalog omitted-monolith coverage mismatch');
  }
  for (const board of reconstruct) {
    if (Object.hasOwn(index.files, board.logicalPath)) throw new Error(`Omitted monolith is unexpectedly indexed: ${board.logicalPath}`);
  }
  return reconstruct;
}

function reconstructPagedBoard(board, hydrated) {
  const { manifest, logicalPath, kind, trackId } = board;
  const commonKeys = ['pagingVersion', 'sourceComplete', 'totalEntries', 'totalEntriesExact', 'publishedEntries',
    'ranksExact', 'capturedAt', 'pageSize', 'pageCount', ...(trackId ? ['trackId'] : []),
    'schemaVersion', 'revision', 'sourceRevision', 'algorithmVersion', 'updatedAt', 'builtAt'];
  const entries = [];
  for (let index = 0; index < manifest.pageCount; index++) {
    const expectedBound = manifest.pageBounds[index];
    const expectedPath = trackId ? `track-pages/${trackId}/${index + 1}.json` : `overall-pages/${index + 1}.json`;
    const pageCount = Math.min(PAGE_SIZE, manifest.publishedEntries - index * PAGE_SIZE);
    if (!expectedBound || expectedBound.pageNumber !== index + 1 || expectedBound.offset !== index * PAGE_SIZE ||
        expectedBound.count !== pageCount || expectedBound.path !== expectedPath) {
      throw new Error(`Invalid page bounds in ${board.manifestPath}: page ${index + 1}`);
    }
    const payload = hydrated.get(expectedPath)?.value;
    if (!payload || payload.kind !== (trackId ? 'track-page' : 'overall-page') || payload.pageNumber !== index + 1 ||
        payload.offset !== index * PAGE_SIZE || payload.count !== pageCount || !Array.isArray(payload.entries) ||
        payload.entries.length !== pageCount || !isDeepStrictEqual(payload.bounds, Object.fromEntries(
          Object.entries(expectedBound).filter(([key]) => key !== 'path'))) ||
        commonKeys.some(key => Object.hasOwn(manifest, key) && !isDeepStrictEqual(payload[key], manifest[key]))) {
      throw new Error(`Invalid or mixed-generation page: ${expectedPath}`);
    }
    entries.push(...payload.entries);
  }
  if (entries.length !== manifest.publishedEntries) throw new Error(`Incomplete paged board: ${logicalPath}`);
  return { ...manifest.boardMetadata, entries, complete: manifest.sourceComplete,
    totalEntries: manifest.totalEntries, totalEntriesExact: manifest.totalEntriesExact,
    ranksExact: manifest.ranksExact, capturedAt: manifest.capturedAt, _reconstructedFromPages: true };
}

function reconstructOmittedBoards(index, hydrated) {
  const boards = validatePagingCatalog(index, hydrated);
  const pageCount = boards.reduce((total, board) => total + board.manifest.pageCount, 0);
  const pageBytes = boards.reduce((total, board) => total + board.manifest.pageBounds.reduce((sum, bound) =>
    sum + (hydrated.get(bound.path)?.decoded.byteLength || 0), 0), 0);
  if (pageCount > MAX_RECONSTRUCTION_PAGES || pageBytes > MAX_RECONSTRUCTION_BYTES) {
    throw new Error(`Paged snapshot reconstruction exceeds safety budget (${pageCount} pages, ${pageBytes} bytes)`);
  }
  return boards.map(board => ({ logicalPath: board.logicalPath,
    decoded: Buffer.from(`${JSON.stringify(reconstructPagedBoard(board, hydrated))}\n`, 'utf8') }));
}

export async function hydrateStaging(root, stagingDirectory) {
  const pointer = JSON.parse(await fs.readFile(path.join(root, 'snapshot-current.json'), 'utf8'));
  if (typeof pointer.currentdir !== 'string' || !/^public-snapshots[1-9]\d*$/.test(pointer.currentdir)) {
    throw new Error('Current snapshot pointer is invalid');
  }
  const generationDirectory = containedChild(root, pointer.currentdir);
  const indexBytes = await fs.readFile(path.join(generationDirectory, 'index.json'));
  const index = JSON.parse(indexBytes.toString('utf8'));
  const pointerGeneration = Number(pointer.currentdir.replace('public-snapshots', ''));
  if (index.schemaVersion !== 1 || index.encoding !== 'gzip-xor-a7-v1' || index.generation !== pointerGeneration ||
      !index.files || typeof index.files !== 'object' || Array.isArray(index.files)) {
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
    hydrated.push({ logicalPath, decoded, value: JSON.parse(decoded.toString('utf8')) });
  }
  const hydratedByPath = new Map(hydrated.map(item => [item.logicalPath, item]));
  hydrated.push(...reconstructOmittedBoards(index, hydratedByPath));
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

const STAGING_BASE_FILE = 'snapshot-staging-base.json';

async function writeStagingBase(root, generation) {
  const reports = path.join(root, 'local-reports');
  await fs.mkdir(reports, { recursive: true });
  const destination = path.join(reports, STAGING_BASE_FILE);
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, generation })}\n`, { flag: 'wx' });
  await fs.rename(temporary, destination);
}

async function mergeMissingJson(source, destination) {
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Staging directory cannot contain symlinks: ${entry.name}`);
    if (entry.isDirectory()) {
      await fs.mkdir(destinationPath, { recursive: true });
      await mergeMissingJson(sourcePath, destinationPath);
    } else if (entry.isFile() && entry.name.endsWith('.json') && LOGICAL_PATH.test(entry.name)) {
      try { await fs.lstat(destinationPath); continue; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await fs.mkdir(path.dirname(destinationPath), { recursive: true });
      await fs.copyFile(sourcePath, destinationPath);
    }
  }
}

async function rebaseStaging(root, stagingDirectory, currentDirectory, currentGeneration) {
  const parent = path.dirname(stagingDirectory);
  const temporary = path.join(parent, `.snapshot-staging-rebase-${process.pid}-${Date.now()}`);
  await hydrateStaging(root, temporary);
  await mergeMissingJson(stagingDirectory, temporary);

  const marker = await readJsonIfPresent(path.join(parent, STAGING_BASE_FILE));
  const oldBase = Number.isSafeInteger(marker?.generation) ? `public-snapshots${marker.generation}` : 'unknown';
  const history = path.join(root, 'local-reports', 'snapshot-history');
  await fs.mkdir(history, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(history, `staging-${oldBase}-before-${currentDirectory}-${stamp}-${process.pid}`);
  let movedOldStage = false;
  try {
    await fs.rename(stagingDirectory, backup);
    movedOldStage = true;
    await fs.rename(temporary, stagingDirectory);
    await fs.writeFile(path.join(backup, 'snapshot-rebase.json'), `${JSON.stringify({
      schemaVersion: 1,
      previousBase: oldBase,
      rebasedTo: currentDirectory,
      policy: 'The old stage and export-progress checkpoint are retained intact. Missing JSON paths are copied into the new stage; files already present in the newer public baseline take precedence.',
    }, null, 2)}\n`, { flag: 'wx' });
    await writeStagingBase(root, currentGeneration);
  } catch (error) {
    if (movedOldStage) {
      const failedStage = path.join(parent, `.snapshot-staging-failed-${process.pid}-${Date.now()}`);
      await fs.rename(stagingDirectory, failedStage).catch(() => {});
      await fs.rename(backup, stagingDirectory).catch(() => {});
      await fs.rm(failedStage, { recursive: true, force: true }).catch(() => {});
    }
    await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { directory: currentDirectory, backup: path.basename(backup) };
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

const transientCaptureStatuses = new Set([408, 429, 500, 502, 503, 504]);
const transientNetworkError = error => ['AbortError', 'TimeoutError'].includes(error?.name) ||
  error instanceof TypeError && ['fetch failed', 'terminated'].includes(error.message);

// Preserve typed deferrals before the replay exporter turns HTTP failures into ordinary errors.
function replayCaptureFetch(fetchImpl) {
  const read = async work => {
    try { return await work(); }
    catch (error) {
      if (!transientNetworkError(error)) throw error;
      throw new PublicBackupDeferredError('Replay export network request interrupted');
    }
  };
  return async (...args) => {
    const response = await read(() => fetchImpl(...args));
    if (transientCaptureStatuses.has(response.status)) {
      throw new PublicBackupDeferredError('Replay export service temporarily unavailable', response.status);
    }
    return {ok: response.ok, status: response.status, text: () => read(() => response.text())};
  };
}

export async function reportCaptureOutcome(result, {env = process.env, log = console.log} = {}) {
  if (typeof result?.deferred !== 'boolean') throw new Error('Invalid public capture outcome');
  const status = result.deferred ? 'deferred' : 'complete';
  if (env.GITHUB_OUTPUT) await fs.appendFile(env.GITHUB_OUTPUT, 'capture_status=' + status + '\n');
  if (result.deferred) {
    const message = 'Public capture deferred. Repository publication skipped; the prior published package and private retry ledger are retained. No immediate retry was started.';
    log('::warning::' + message);
    if (env.GITHUB_STEP_SUMMARY) await fs.appendFile(env.GITHUB_STEP_SUMMARY, '## Public capture deferred\n' + message + '\n');
  }
  return result;
}

export async function updatePublicSnapshot({ root = moduleRoot, offline = false, fullPublic = false, refreshReplays = false,
  capture = runPublicSnapshotBackup, captureTotals = capture === runPublicSnapshotBackup ? capturePublicEventTotals : null,
  captureOptions = {}, exportPublic = exportPublicProfilesAndReplays, exportFetch = fetch, exportAuth = {}, log = console.log } = {}) {
  const absoluteRoot = path.resolve(root);
  const stagingDirectory = path.join(absoluteRoot, 'local-reports', 'snapshot-staging');
  const historyDirectory = path.join(absoluteRoot, 'local-reports', 'snapshot-history');
  const stageStat = await fs.stat(stagingDirectory).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  let backupResult = null;
  let exportResult = null;
  const defer = (phase, result) => {
    const summary = {deferred: true, published: false, phase, reason: result.reason || result.message,
      status: result.status ?? null, previousPackagePreserved: true};
    log(JSON.stringify({updatePublicSnapshot: summary}));
    return summary;
  };
  const pointer = await readJsonIfPresent(path.join(absoluteRoot, 'snapshot-current.json'));
  if (pointer) {
    const match = /^public-snapshots([1-9]\d*)$/.exec(pointer.currentdir || '');
    if (!match) throw new Error('Current snapshot pointer is invalid');
    const generation = Number(match[1]);
    const marker = await readJsonIfPresent(path.join(absoluteRoot, 'local-reports', STAGING_BASE_FILE));
    if (!stageStat) {
      await hydrateStaging(absoluteRoot, stagingDirectory);
      await writeStagingBase(absoluteRoot, generation);
    } else if (marker?.schemaVersion !== 1 || marker.generation !== generation) {
      await rebaseStaging(absoluteRoot, stagingDirectory, pointer.currentdir, generation);
    }
  } else if (!stageStat) {
    if (offline) throw new Error('Offline packaging needs staging data or a current packed generation');
    await fs.mkdir(stagingDirectory, { recursive: true });
  }
  if (!offline) {
    backupResult = await capture({ ...captureOptions, directory: stagingDirectory, log });
    if (backupResult?.deferred === true) return defer('snapshots', backupResult);
    if (captureTotals) {
      let totalsResult;
      try { totalsResult = await captureTotals({ directory: stagingDirectory, log }); }
      catch (error) {
        if (!(error instanceof PublicBackupDeferredError)) throw error;
        return defer('event-totals', error);
      }
      if (totalsResult?.deferred === true) return defer('event-totals', totalsResult);
      if (totalsResult?.deferred !== false) throw new Error('Invalid public event totals capture outcome');
    }
  }
  // Offline packaging never issues credentials or live reads, even with refresh flags.
  if (!offline && (fullPublic || refreshReplays)) {
    const previousProgress = await readJsonIfPresent(path.join(stagingDirectory, 'export-progress.json'));
    const previousSummary = await readJsonIfPresent(path.join(stagingDirectory, 'public-export-summary.json'));
    const startFullSnapshot = fullPublic && previousProgress?.fullSnapshotPending !== true;
    try {
      exportResult = await exportPublic({ directory: stagingDirectory, snapshotDirectory: stagingDirectory, maxDocuments: fullPublic ? 2000 : 100,
        fullSnapshot: startFullSnapshot, includeProfiles: fullPublic, includePendingReplays:true, retryInvalidAfterMs:3600000,
        fetchImpl: replayCaptureFetch(createSnapshotExportFetch({ ...exportAuth, fetchImpl: exportFetch })), log });
    } catch (error) {
      if (!(error instanceof PublicBackupDeferredError)) throw error;
      return defer('replays', error);
    }
    const capturedAt = new Date().toISOString();
    const summary={counts:exportResult.counts,scanned:exportResult.scanned,capturedAt,
      profilesCapturedAt:fullPublic ? capturedAt : previousSummary?.profilesCapturedAt || previousSummary?.capturedAt || null,
      replaysCapturedAt:capturedAt,
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
  await buildProfileSnapshotResults(stagingDirectory);

  let oldCurrent = null;
  try {
    const pointer = await readJsonIfPresent(path.join(absoluteRoot, 'snapshot-current.json'));
    if (typeof pointer?.currentdir === 'string' && /^public-snapshots[1-9]\d*$/.test(pointer.currentdir)) oldCurrent = pointer.currentdir;
  } catch {}
  const result = await publishSnapshot({ root: absoluteRoot, stagingDirectory, historyDirectory });
  await writeStagingBase(absoluteRoot, result.generation);
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
  const summary = { ...result, deferred: false, published: true, coverage, backup: backupResult, profileReplay: exportResult };
  log(JSON.stringify({ updatePublicSnapshot: summary }));
  return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = new Set(process.argv.slice(2));
  const unknown = [...args].filter(arg => !['--offline', '--full-public', '--refresh-replays'].includes(arg));
  if (unknown.length) throw new Error(`Unknown arguments: ${unknown.join(', ')}`);
  await reportCaptureOutcome(await updatePublicSnapshot({ offline: args.has('--offline'), fullPublic: args.has('--full-public'), refreshReplays: args.has('--refresh-replays') }));
}
