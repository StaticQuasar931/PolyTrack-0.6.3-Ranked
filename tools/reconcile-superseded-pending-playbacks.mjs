import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {decodeSnapshot, MAX_DECODED_BYTES} from './snapshot-package.mjs';
import {eventReplayCoverage} from './event-replay-coverage.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const ID = /^[a-f0-9]{64}$/;
const SAFE = /^[A-Za-z0-9_-]{1,64}$/;

function parseJson(bytes, label) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw Error(`Invalid JSON: ${label}`); }
}

function timestamp(value) {
  if (Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.length <= 64) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

async function containedPath(base, relative, {allowMissing = false} = {}) {
  const root = path.resolve(base);
  const target = path.resolve(root, relative);
  const inside = path.relative(root, target);
  if (!inside || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside))
    throw Error(`Path escapes reconciliation root: ${relative}`);
  let current = root;
  const components = [root, ...inside.split(path.sep).map(part => (current = path.join(current, part)))];
  for (const component of components) {
    try {
      if ((await fs.lstat(component)).isSymbolicLink()) throw Error(`Symlink path is not allowed: ${component}`);
    } catch (error) {
      if (error.code === 'ENOENT' && allowMissing) break;
      throw error;
    }
  }
  return target;
}

async function sourceFile(packageDirectory, index, logical) {
  const entry = index.files?.[logical];
  if (!entry || entry.path !== `${entry.sha256}.bin` || !ID.test(entry.sha256 || '') ||
      !Number.isSafeInteger(entry.decodedBytes) || entry.decodedBytes < 2 || entry.decodedBytes > MAX_DECODED_BYTES)
    throw Error(`Missing trusted package file: ${logical}`);
  if (path.isAbsolute(entry.path) || entry.path.includes('..') || entry.path.includes('/') || entry.path.includes('\\'))
    throw Error(`Unsafe trusted package path: ${logical}`);
  const payloadPath = await containedPath(packageDirectory, entry.path);
  const encoded = await fs.readFile(payloadPath);
  if (sha(encoded) !== entry.sha256) throw Error(`Trusted package payload hash mismatch: ${logical}`);
  let decoded;
  try { decoded = Buffer.from(await decodeSnapshot(encoded)); }
  catch { throw Error(`Trusted package payload decode failed: ${logical}`); }
  if (decoded.length !== entry.decodedBytes) throw Error(`Trusted package decoded size mismatch: ${logical}`);
  return {decoded, encodedSha256: entry.sha256};
}

export async function reconcileSupersededPendingPlaybacks({root, directory, expectedIndexSha256} = {}) {
  if (!path.isAbsolute(root || '') || !path.isAbsolute(directory || '') || !ID.test(expectedIndexSha256 || ''))
    throw Error('Explicit paths and trusted snapshot index hash required');

  const pointerPath = await containedPath(root, 'snapshot-current.json');
  const pointer = parseJson(await fs.readFile(pointerPath), 'snapshot-current.json');
  if (!/^public-snapshots[1-9]\d*$/.test(pointer.currentdir || '')) throw Error('Invalid trusted snapshot pointer');
  const packageDirectory = path.join(root, pointer.currentdir);
  await containedPath(root, pointer.currentdir);
  const indexPath = await containedPath(packageDirectory, 'index.json');
  const indexBytes = await fs.readFile(indexPath);
  if (sha(indexBytes) !== expectedIndexSha256) throw Error('Trusted snapshot index hash mismatch');
  const index = parseJson(indexBytes, 'snapshot index');

  const manifestPath = await containedPath(directory, 'manifest.json');
  const manifestBytes = await fs.readFile(manifestPath);
  const manifest = parseJson(manifestBytes, 'candidate manifest');
  const coverage = manifest.pendingPlaybackCoverage;
  if (!coverage || coverage.scope !== 'selected-saved-event-boards' || coverage.complete !== false ||
      !Number.isSafeInteger(coverage.missing) || coverage.missing < 1 ||
      !Number.isSafeInteger(coverage.known) || !Number.isSafeInteger(coverage.published) ||
      !Number.isSafeInteger(coverage.failed) || !Number.isSafeInteger(coverage.deferred) ||
      [coverage.known, coverage.published, coverage.missing, coverage.failed, coverage.deferred].some(n => n < 0) ||
      coverage.known !== coverage.published + coverage.missing ||
      coverage.missing !== coverage.deferred + coverage.failed) throw Error('Unsupported pending playback coverage state');
  if (manifest.pendingPlaybackReconciliation) throw Error('Pending playback reconciliation already recorded');

  const boardPaths = Object.keys(index.files || {}).filter(key => /^events\/[A-Za-z0-9_-]{1,64}\.json$/.test(key));
  if (boardPaths.length > 1024) throw Error('Trusted event board count exceeds boundary');
  const priorBoards = [];
  for (const logical of boardPaths) {
    const source = await sourceFile(packageDirectory, index, logical);
    const board = parseJson(source.decoded, logical);
    if (!Array.isArray(board.pendingPlaybacks) || board.pendingPlaybacks.length === 0) continue;
    if (!SAFE.test(board.period?.id || '') || logical !== `events/${board.period.id}.json`)
      throw Error(`Invalid prior event board: ${logical}`);
    priorBoards.push({board, source, logical});
  }

  const candidates = new Map();
  for (const {board} of priorBoards) {
    const currentPath = await containedPath(directory, `events/${board.period.id}.json`);
    const current = parseJson(await fs.readFile(currentPath), `current event ${board.period.id}`);
    if (current.period?.id !== board.period.id || current.period?.trackId !== board.period.trackId || !Array.isArray(current.entries))
      throw Error(`Current event binding mismatch: ${board.period.id}`);
    candidates.set(board.period.id, current);
  }

  const actions = [];
  const seen = new Set();
  for (const {board: oldBoard, source: boardSource} of priorBoards) {
    for (const oldRow of oldBoard.pendingPlaybacks) {
      if (!ID.test(oldRow.runId || '') || !ID.test(oldRow.accountId || '') || !ID.test(oldRow.replayHash || '') ||
          !Number.isSafeInteger(oldRow.timeMs) || !timestamp(oldRow.submittedAt)) throw Error('Invalid prior pending playback binding');
      const key = `${oldBoard.period.id}/${oldRow.runId}`;
      if (seen.has(key)) throw Error('Duplicate prior pending playback');
      seen.add(key);
      const logical = `event-playbacks/${oldBoard.period.id}/${oldRow.runId}.json`;
      const source = await sourceFile(packageDirectory, index, logical);
      const oldValue = parseJson(source.decoded, logical);
      const oldCoverage = await eventReplayCoverage([{...oldBoard, entries: [], pendingPlaybacks: [oldRow]}], async requested => {
        if (requested !== logical) throw Error('Unexpected old playback lookup');
        return oldValue;
      });
      if (!oldCoverage.complete) throw Error(`Prior pending playback failed replay validation: ${logical}`);

      const existingRecord = manifest.eventPlaybacks?.[logical];
      if (existingRecord) {
        if (existingRecord.path !== logical || existingRecord.periodId !== oldBoard.period.id ||
            existingRecord.runId !== oldRow.runId || existingRecord.accountId !== oldRow.accountId ||
            existingRecord.timeMs !== oldRow.timeMs || existingRecord.replayHash !== oldRow.replayHash)
          throw Error(`Existing playback manifest binding mismatch: ${logical}`);
        const existingBytes = await fs.readFile(path.join(directory, logical));
        const existingValue = parseJson(existingBytes, logical);
        if (!existingBytes.equals(source.decoded)) throw Error(`Existing playback payload mismatch: ${logical}`);
        const alreadyCovered = await eventReplayCoverage([{...oldBoard, entries: [], pendingPlaybacks: [oldRow]}], async requested => {
          if (requested !== logical) throw Error('Unexpected indexed playback lookup');
          return existingValue;
        });
        if (!alreadyCovered.complete) throw Error(`Existing indexed playback failed validation: ${logical}`);
        continue;
      }

      const current = candidates.get(oldBoard.period.id);
      const replacement = current.entries.find(row => row.accountId === oldRow.accountId &&
        (row.trackId === undefined || row.trackId === oldBoard.period.trackId) &&
        row.runVerified === true && row.verified === true && row.eventRpEligible === true &&
        row.pending !== true && row.needsReview !== true && row.reviewHold !== true && row.unscored !== true &&
        row.hold !== true && row.excluded !== true &&
        row.archived !== true && row.rejected !== true &&
        (row.verificationStatus === undefined || row.verificationStatus === 'verified') &&
        Number.isSafeInteger(row.timeMs) && row.timeMs < oldRow.timeMs &&
        timestamp(row.submittedAt) > timestamp(oldRow.submittedAt));
      if (!replacement || !ID.test(replacement.runId || '') || !ID.test(replacement.replayHash || ''))
        throw Error(`No later faster verified replacement for ${logical}`);
      const replacementLogical = `event-replays/${oldBoard.period.id}/${replacement.accountId}.json`;
      let replacementBytes;
      try { replacementBytes = await fs.readFile(await containedPath(directory, replacementLogical)); }
      catch { throw Error(`Replacement replay is unavailable: ${replacementLogical}`); }
      const replacementValue = parseJson(replacementBytes, replacementLogical);
      const replacementCoverage = await eventReplayCoverage([{...current, entries: [replacement], pendingPlaybacks: []}], async requested => {
        if (requested !== replacementLogical) throw Error('Unexpected replacement replay lookup');
        return replacementValue;
      });
      if (!replacementCoverage.complete) throw Error(`Replacement replay failed validation: ${replacementLogical}`);

      const target = await containedPath(directory, logical, {allowMissing: true});
      let alreadyPresent = false;
      try {
        const present = await fs.readFile(target);
        if (!present.equals(source.decoded)) throw Error(`Conflicting existing playback: ${logical}`);
        alreadyPresent = true;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      actions.push({logical, target, bytes: source.decoded, alreadyPresent, sourceBoardSha256: boardSource.encodedSha256,
        sourcePayloadSha256: source.encodedSha256, decodedPayloadSha256: sha(source.decoded),
        old: {periodId: oldBoard.period.id, trackId: oldBoard.period.trackId, runId: oldRow.runId,
          accountId: oldRow.accountId, timeMs: oldRow.timeMs, submittedAt: oldRow.submittedAt, replayHash: oldRow.replayHash},
        replacement: {periodId: oldBoard.period.id, trackId: oldBoard.period.trackId, runId: replacement.runId,
          accountId: replacement.accountId, timeMs: replacement.timeMs, submittedAt: replacement.submittedAt}});
    }
  }
  if (actions.length !== coverage.missing) throw Error(`Resolved ${actions.length} pending rows; expected exactly ${coverage.missing}`);

  const originalCoverage = structuredClone(coverage);
  const nextManifest = structuredClone(manifest);
  nextManifest.eventPlaybacks ||= {};
  for (const action of actions) {
    const record = {path: action.logical, periodId: action.old.periodId, runId: action.old.runId,
      accountId: action.old.accountId, timeMs: action.old.timeMs, replayHash: action.old.replayHash};
    const oldIndexed = nextManifest.eventPlaybacks[action.logical];
    if (oldIndexed && (oldIndexed.path !== action.logical || oldIndexed.periodId !== action.old.periodId ||
        oldIndexed.runId !== action.old.runId || oldIndexed.accountId !== action.old.accountId || oldIndexed.timeMs !== action.old.timeMs))
      throw Error(`Conflicting playback manifest index: ${action.logical}`);
    nextManifest.eventPlaybacks[action.logical] = record;
  }
  nextManifest.pendingPlaybackCoverage = {...coverage, published: coverage.published + actions.length,
    missing: 0, failed: 0, deferred: 0, complete: true};
  nextManifest.pendingPlaybackReconciliation = {schemaVersion: 1, kind: 'superseded-pending-playback-recovery',
    inputIndexSha256: expectedIndexSha256, originalScope: originalCoverage.scope, originalCoverage,
    resolved: actions.map(({logical, sourceBoardSha256, sourcePayloadSha256, decodedPayloadSha256, old, replacement}) =>
      ({logical, sourceBoardSha256, sourcePayloadSha256, decodedPayloadSha256, old, replacement})),
    resultingCoverage: structuredClone(nextManifest.pendingPlaybackCoverage), backendReads: 0, backendWrites: 0,
    verificationChanges: 0};
  const nextManifestBytes = Buffer.from(`${JSON.stringify(nextManifest, null, 2)}\n`);

  // Stage every new file and the manifest before publishing any of them.
  const staged = [];
  const token = `${process.pid}-${Date.now()}-${createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 12)}`;
  const manifestTemp = await containedPath(directory, `manifest.json.${token}.tmp`, {allowMissing: true});
  const created = [];
  try {
    for (const action of actions) if (!action.alreadyPresent) {
      const parent = path.posix.dirname(action.logical);
      await fs.mkdir(await containedPath(directory, parent, {allowMissing: true}), {recursive: true});
      const temp = await containedPath(directory, `${action.logical}.${token}.tmp`, {allowMissing: true});
      await fs.writeFile(temp, action.bytes, {flag: 'wx', mode: 0o600});
      staged.push({temp, target: action.target});
    }
    await fs.writeFile(manifestTemp, nextManifestBytes, {flag: 'wx', mode: 0o600});
    for (const file of staged) { await fs.rename(file.temp, file.target); created.push(file.target); }
    await fs.rename(manifestTemp, manifestPath);
  } catch (error) {
    for (const file of staged) await fs.rm(file.temp, {force: true}).catch(() => {});
    await fs.rm(manifestTemp, {force: true}).catch(() => {});
    for (const file of created) await fs.rm(file, {force: true}).catch(() => {});
    throw error;
  }
  return {resolved: actions.length, files: actions.map(({logical, sourcePayloadSha256, decodedPayloadSha256}) =>
    ({path: logical, sourcePayloadSha256, decodedPayloadSha256})), coverage: nextManifest.pendingPlaybackCoverage,
    backendReads: 0, backendWrites: 0, verificationChanges: 0};
}
