import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {decodeSnapshot, MAX_FILE_BYTES} from '../snapshot-package.mjs';
import {compareControls} from './similarity.mjs';
import {publicEventPlaybackForPublication} from '../public-event-playback.mjs';
import {loadWeeklyTrustedTrack} from './weekly-track.mjs';
import {validateEnginePin} from './run.mjs';
import {VERIFIER_ENGINE_DIGEST, VERIFIER_VERSION, legacyTimingFrames} from '../../workers/ranked/src/verification.js';

const require = createRequire(import.meta.url);
const {LIMITS, sha256, decodeReplay} = require('./replay.cjs');
const {verifyBatch: nativeVerify, verifierFingerprint} = require('./verify.cjs');
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ACCOUNT = /^[a-f0-9]{64}$/;
const TRACK = /^[a-f0-9]{64}$/;
const HASH = /^[a-f0-9]{64}$/;
const PERMANENT_ID = 'permanent-rolling-hills';
const PERMANENT_TRACK = 'fb769ac2ea77e8f19a21a9dd3071742f2342bd49c41e4748d7e8c7903d4f0778';
const STATE_SCHEMA = 'polytrack-snapshot-audit-v1';
const NATIVE_BATCH_SIZE = 16;
const MAX_FINDING_LINES = 500000;
const CHECKPOINT_RETRY_COMPATIBLE_SOURCE = '72a1891fd54c0bdf157183a5973ff608f338d60e998b121912f5a0e56a2ec84a';

function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function recordId(kind, source) { return `${kind}-${digest(source).slice(0, 32)}`; }

function within(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

async function privateReportPath(file, root) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw Error('Report path must be absolute');
  const repo = await fs.realpath(root), parent = await fs.realpath(path.dirname(file));
  const resolved = path.join(parent, path.basename(file));
  if (within(repo, resolved)) throw Error('Private audit report must be outside the Git repository');
  return resolved;
}

async function atomicJson(file, value) {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  try { await renameCheckpointWithRetry(temp, file); }
  catch (error) { await fs.rm(temp, {force: true}).catch(() => {}); throw error; }
}

export async function renameCheckpointWithRetry(source, destination, rename = fs.rename,
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))) {
  const delays = [40, 100, 220, 450];
  for (let attempt = 0; ; attempt++) {
    try { await rename(source, destination); return; }
    catch (error) {
      if (!['EACCES', 'EBUSY', 'EPERM'].includes(error?.code) || attempt >= delays.length) throw error;
      await wait(delays[attempt]);
    }
  }
}

async function readIndexedPayload(snapshotDir, index, logicalPath, cache) {
  if (cache.has(logicalPath)) return cache.get(logicalPath);
  const item = index.files[logicalPath];
  if (!item || !HASH.test(item.sha256 || '') || item.path !== `${item.sha256}.bin` ||
      !Number.isSafeInteger(item.decodedBytes) || item.decodedBytes < 0 || item.decodedBytes > 2 * 1024 * 1024) return null;
  const full = path.resolve(snapshotDir, item.path);
  if (!within(snapshotDir, full)) throw Error('Snapshot index path escapes generation');
  const stat = await fs.lstat(full);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw Error('Invalid snapshot payload file');
  const encoded = await fs.readFile(full);
  if (digest(encoded) !== item.sha256) throw Error(`Snapshot payload SHA mismatch: ${logicalPath}`);
  const decoded = Buffer.from(await decodeSnapshot(encoded));
  if (decoded.length !== item.decodedBytes) throw Error(`Snapshot decoded length mismatch: ${logicalPath}`);
  let value;
  try { value = JSON.parse(decoded.toString('utf8')); } catch { throw Error(`Invalid snapshot JSON: ${logicalPath}`); }
  cache.set(logicalPath, value);
  return value;
}

async function validateIndexedPayloadHashes(snapshotDir, index) {
  const paths = Object.values(index.files);
  for (let start = 0; start < paths.length; start += 128) {
    await Promise.all(paths.slice(start, start + 128).map(async item => {
      if (!item || !HASH.test(item.sha256 || '') || item.path !== `${item.sha256}.bin` ||
          !Number.isSafeInteger(item.decodedBytes) || item.decodedBytes < 0 || item.decodedBytes > 2 * 1024 * 1024) {
        throw Error('Invalid snapshot index entry');
      }
      const full = path.resolve(snapshotDir, item.path);
      if (!within(snapshotDir, full)) throw Error('Snapshot index path escapes generation');
      const stat = await fs.lstat(full);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw Error('Invalid snapshot payload file');
      const bytes = await fs.readFile(full);
      if (digest(bytes) !== item.sha256) throw Error('Snapshot payload SHA mismatch');
    }));
  }
}

function safeSnapshotName(logical) {
  return typeof logical === 'string' && !logical.startsWith('/') &&
    !logical.split('/').some(part => !part || part === '.' || part === '..');
}

function validPermanentBoard(board) {
  const uint = value => Number.isSafeInteger(value) && value >= 0;
  if (!board || board.id !== PERMANENT_ID || board.kind !== 'permanent' || board.trackId !== PERMANENT_TRACK ||
      board.period !== undefined || board.archived === true || board.complete !== true || board.sourceComplete === false ||
      !Array.isArray(board.entries) || !board.entries.length || board.entries.length > 10000 ||
      board.totalEntries !== board.entries.length || !uint(board.sourceTotalEntries) || board.sourceTotalEntries < board.totalEntries ||
      !uint(board.updatedAt) || board.updatedAt === 0 || !uint(board.sourceRevision) || board.sourceRevision === 0 ||
      board.scoreVersion !== 'rolling-hills-live-verified-v1' || board.targetPolicy !== 'live-fastest-physics-verified' ||
      board.maxRp !== 1001 || !uint(board.targetMs) || board.targetMs === 0 || board.targetMs > 300000 ||
      !['explicit-snapshot-metadata', 'legacy-exact-field-size', 'paged-source-manifest'].includes(board.sourceCompleteness) ||
      board.contributions?.normalRp !== true || board.contributions?.eventRp !== true) return false;
  const seen = new Set();
  for (const row of board.entries) {
    if (!ACCOUNT.test(row?.accountId || '') || seen.has(row.accountId) ||
        row.trackId !== undefined && row.trackId !== PERMANENT_TRACK ||
        !uint(row.timeMs) || row.timeMs < board.targetMs || row.timeMs > 300000 || row.frames !== row.timeMs ||
        !HASH.test(row.replayHash || '') || row.physicsVerified !== true || row.replayIntegrityVerified !== true ||
        row.normalRpEligible !== true || !uint(row.rank) || row.rank < 1 || row.rank > board.entries.length ||
        !uint(row.rp) || row.rp > board.maxRp || row.eventRpContribution !== row.rp) return false;
    seen.add(row.accountId);
  }
  return Math.min(...board.entries.map(row => row.timeMs)) === board.targetMs;
}

export async function loadSnapshotAuditInputs({root = DEFAULT_ROOT} = {}) {
  const pointerBytes = await fs.readFile(path.join(root, 'snapshot-current.json'));
  const pointer = JSON.parse(pointerBytes.toString('utf8'));
  if (!/^public-snapshots[1-9]\d*$/.test(pointer.currentdir || '')) throw Error('Invalid current snapshot pointer');
  const snapshotDir = path.resolve(root, pointer.currentdir);
  if (!within(await fs.realpath(root), await fs.realpath(snapshotDir))) throw Error('Snapshot generation escapes repository');
  const indexBytes = await fs.readFile(path.join(snapshotDir, 'index.json'));
  const index = JSON.parse(indexBytes.toString('utf8'));
  if (index.schemaVersion !== 1 || index.generation !== Number(pointer.currentdir.replace('public-snapshots', '')) ||
      index.encoding !== 'gzip-xor-a7-v1' || !index.files || typeof index.files !== 'object' || Array.isArray(index.files)) {
    throw Error('Invalid snapshot generation index');
  }
  for (const logical of Object.keys(index.files)) if (!safeSnapshotName(logical)) throw Error('Unsafe snapshot logical path');
  await validateIndexedPayloadHashes(snapshotDir, index);
  const cache = new Map(), issues = [], jobs = [], expected = new Map(), canonicals = new Map(), recordings = new Map();
  const files = Object.keys(index.files).sort();

  for (const logical of files.filter(value => value.startsWith('canonical/'))) {
    const match = /^canonical\/([a-f0-9]{64})\/([a-f0-9]{64})\.json$/.exec(logical);
    if (!match) { issues.push({kind: 'invalid_canonical_path', source: logical}); continue; }
    const row = await readIndexedPayload(snapshotDir, index, logical, cache);
    if (!row || row.trackId !== match[1] || row.accountId !== match[2] || !Number.isSafeInteger(row.uploadId) ||
        !Number.isSafeInteger(row.timeMs) || row.timeMs <= 0 || !HASH.test(row.replayHash || '')) {
      issues.push({kind: 'canonical_binding_invalid', source: logical}); continue;
    }
    const key = `${row.trackId}/${row.accountId}`;
    canonicals.set(key, {row, logical});
  }

  for (const logical of files.filter(value => value.startsWith('tracks/') && value.endsWith('.json'))) {
    const match = /^tracks\/([a-f0-9]{64})\.json$/.exec(logical);
    const board = await readIndexedPayload(snapshotDir, index, logical, cache);
    if (!match || board?.trackId && board.trackId !== match[1] || !Array.isArray(board?.entries)) {
      issues.push({kind: 'current_track_binding_invalid', source: logical}); continue;
    }
    for (const entry of board.entries) {
      const accountId = String(entry?.accountId || entry?.userId || '');
      if (!ACCOUNT.test(accountId)) { issues.push({kind: 'current_track_account_invalid', source: logical}); continue; }
      const key = `${match[1]}/${accountId}`;
      if (expected.has(key)) issues.push({kind: 'duplicate_current_track_binding', key, source: logical});
      expected.set(key, {trackId: match[1], accountId, timeMs: entry.timeMs,
        uploadId: entry.uploadId ?? entry.id, replayHash: entry.replayHash, logical});
    }
  }
  for (const [key, binding] of expected) {
    const canonical = canonicals.get(key)?.row;
    if (!canonical || canonical.replayHash !== binding.replayHash ||
        binding.uploadId != null && Number(binding.uploadId) !== canonical.uploadId ||
        Number.isSafeInteger(binding.timeMs) && binding.timeMs !== canonical.timeMs) {
      issues.push({kind: 'current_track_canonical_mismatch', key, source: binding.logical});
    }
  }

  for (const logical of files.filter(value => value.startsWith('recordings/'))) {
    const match = /^recordings\/(\d+)\.json$/.exec(logical);
    const recording = await readIndexedPayload(snapshotDir, index, logical, cache);
    if (!match || !recording || !ACCOUNT.test(recording.accountId || '') || !TRACK.test(recording.trackId || '') ||
        String(recording.uploadId ?? match[1]) !== match[1] && recording.uploadId != null ||
        !Number.isSafeInteger(recording.frames) || recording.frames <= 0 || !HASH.test(recording.replayHash || '') ||
        typeof recording.recording !== 'string' || !recording.recording.length || sha256(recording.recording) !== recording.replayHash) {
      issues.push({kind: 'normal_recording_payload_invalid', source: logical}); continue;
    }
    recordings.set(match[1], {recording, logical});
    const key = `${recording.trackId}/${recording.accountId}`, canonicalInfo = canonicals.get(key), canonical = canonicalInfo?.row;
    let bindingStatus = 'orphan_recording', timeMs = recording.frames;
    if (canonical && canonical.uploadId === Number(match[1]) && canonical.replayHash === recording.replayHash &&
        canonical.trackId === recording.trackId && canonical.accountId === recording.accountId) {
      const corrected = legacyTimingFrames(canonical);
      timeMs = corrected ?? canonical.timeMs;
      bindingStatus = expected.has(key) ? 'current_track_bound' : 'canonical_bound_not_current_board';
    }
    const id = recordId('normal', logical);
    jobs.push({recordId: id, resultId: id, kind: 'normal', source: logical, accountId: recording.accountId,
      trackId: recording.trackId, timeMs, replayHash: recording.replayHash, replay: recording.recording,
      bindingStatus, verifiedState: recording.verifiedState ?? null,
      canonical: canonical ? {source: canonicalInfo.logical, timeMs: canonical.timeMs, uploadId: canonical.uploadId,
        replayHash: canonical.replayHash, verified: canonical.verified === true,
        integrityVerified: canonical.integrityVerified === true} : null});
  }
  for (const [key, {row, logical}] of canonicals) {
    const recordingInfo = recordings.get(String(row.uploadId));
    if (!recordingInfo || recordingInfo.recording.trackId !== row.trackId ||
        recordingInfo.recording.accountId !== row.accountId || recordingInfo.recording.replayHash !== row.replayHash) {
      issues.push({kind: 'canonical_missing_recording', key, source: logical,
      uploadId: row.uploadId, replayHash: row.replayHash});
    }
  }

  const eventBoards = new Map();
  for (const logical of files.filter(value => /^events\/[^/]+\.json$/.test(value))) {
    const board = await readIndexedPayload(snapshotDir, index, logical, cache);
    const period = logical.slice('events/'.length, -'.json'.length);
    if (period === PERMANENT_ID) {
      if (!validPermanentBoard(board)) issues.push({kind: 'permanent_board_invalid', source: logical});
      // This derived board has no timed period or recording namespace. Normal track jobs cover its replays.
      continue;
    }
    if (!board || board.id !== period || board.period?.id !== period || !TRACK.test(board.period?.trackId || '') || !Array.isArray(board.entries)) {
      issues.push({kind: 'event_board_invalid', source: logical}); continue;
    }
    eventBoards.set(period, board);
  }
  for (const logical of files.filter(value => value.startsWith('event-replays/'))) {
    const match = /^event-replays\/([A-Za-z0-9_-]{1,64})\/([a-f0-9]{64})\.json$/.exec(logical);
    if (match?.[1] === PERMANENT_ID) {
      issues.push({kind: 'permanent_replay_wrong_lane', source: logical}); continue;
    }
    const event = await readIndexedPayload(snapshotDir, index, logical, cache);
    if (!match || !event || event.periodId !== match[1] || event.accountId !== match[2] ||
        !TRACK.test(event.trackId || '') || !HASH.test(event.runId || '') || !Number.isSafeInteger(event.timeMs) || event.timeMs <= 0 ||
        !HASH.test(event.replayHash || '') || typeof event.replay !== 'string' || !event.replay.length ||
        sha256(event.replay) !== event.replayHash) {
      issues.push({kind: 'event_replay_payload_invalid', source: logical}); continue;
    }
    const board = eventBoards.get(match[1]);
    const boardBound = board?.period?.trackId === event.trackId && board.entries.some(entry =>
      entry.accountId === event.accountId && entry.timeMs === event.timeMs);
    if (!boardBound) issues.push({kind: 'event_replay_board_mismatch', source: logical});
    const id = recordId('event', logical);
    jobs.push({recordId: id, resultId: id, kind: 'event', source: logical, accountId: event.accountId,
      trackId: event.trackId, timeMs: event.timeMs, replayHash: event.replayHash, replay: event.replay,
      bindingStatus: boardBound ? 'event_board_bound' : 'event_board_missing', periodId: event.periodId,
      runId: event.runId});
  }

  // Publication integrity is not a verified verdict or permission for native dispatch.
  const pendingJobs = [], pendingBindings = new Map(), usedPendingFiles = new Set();
  for (const [periodId, board] of eventBoards) {
    if (board.pendingPlaybacks !== undefined && !Array.isArray(board.pendingPlaybacks)) {
      issues.push({kind: 'pending_event_list_invalid', source: 'events/'+periodId+'.json'}); continue;
    }
    for (const entry of board.pendingPlaybacks || []) {
      const logical = 'event-playbacks/'+periodId+'/'+String(entry?.runId || '')+'.json';
      if (!HASH.test(entry?.runId || '') || !HASH.test(entry?.replayHash || '') || board.archived === true ||
          board.entries.some(row => row?.runId === entry.runId)) {
        issues.push({kind: 'pending_event_binding_invalid', source: logical}); continue;
      }
      if (pendingBindings.has(logical)) {
        issues.push({kind: 'pending_event_binding_duplicate', source: logical}); continue;
      }
      pendingBindings.set(logical, entry);
      let payload;
      try { payload = await readIndexedPayload(snapshotDir, index, logical, cache); }
      catch { issues.push({kind: 'pending_event_payload_unreadable', source: logical}); continue; }
      if (!payload) { issues.push({kind: 'pending_event_payload_missing', source: logical}); continue; }
      let projected;
      try { projected = await publicEventPlaybackForPublication(payload, {periodId, trackId: board.period.trackId, entry}); }
      catch { issues.push({kind: 'pending_event_payload_invalid', source: logical}); continue; }
      usedPendingFiles.add(logical);
      const id = recordId('event-pending', logical);
      pendingJobs.push({recordId:id,resultId:id,kind:'event-pending',source:logical,accountId:projected.accountId,
        trackId:projected.trackId,periodId:projected.periodId,runId:projected.runId,timeMs:projected.timeMs,
        replay:projected.replay,replayHash:projected.replayHash,bindingStatus:'pending_event_board_bound',
        verificationStatus:'waiting',pending:true,verified:false,eventRpEligible:false,publicationOnly:true});
    }
  }
  for (const logical of files.filter(value => value.startsWith('event-playbacks/'))) {
    if (!/^event-playbacks\/([A-Za-z0-9_-]{1,64})\/([a-f0-9]{64})\.json$/.test(logical) || !pendingBindings.has(logical))
      issues.push({kind: 'pending_event_payload_unbound', source: logical});
  }

  const auditSource = await fs.readFile(fileURLToPath(import.meta.url));
  const manifest = {generation: pointer.currentdir, indexSha256: digest(indexBytes), pointerSha256: digest(pointerBytes),
    auditSourceSha256: digest(auditSource),
    pendingPlaybackValidatorSha256: digest(await fs.readFile(new URL('../public-event-playback.mjs', import.meta.url))),
    engineDigest: VERIFIER_ENGINE_DIGEST, verifierVersion: VERIFIER_VERSION, engineFingerprint: verifierFingerprint};
  const manifestSha256 = digest(Buffer.from(JSON.stringify(manifest)));
  jobs.sort((a, b) => a.trackId.localeCompare(b.trackId) || a.kind.localeCompare(b.kind) || a.recordId.localeCompare(b.recordId));
  const coverage = {canonicalRecords: canonicals.size, currentTrackBindings: expected.size,
    canonicalFiles: files.filter(value => value.startsWith('canonical/')).length,
    currentTrackFiles: files.filter(value => /^tracks\/[a-f0-9]{64}\.json$/.test(value)).length,
    normalRecordingFiles: files.filter(value => value.startsWith('recordings/')).length,
    eventReplayFiles: files.filter(value => value.startsWith('event-replays/')).length,
    pendingEventPlaybackFiles: files.filter(value => value.startsWith('event-playbacks/')).length,
    pendingEventBindings: pendingBindings.size, pendingEventPlaybacks: pendingJobs.length,
    normalRecordings: recordings.size, normalJobs: jobs.filter(job => job.kind === 'normal').length,
    eventReplays: jobs.filter(job => job.kind === 'event').length,
    orphanNormalRecordings: jobs.filter(job => job.kind === 'normal' && job.bindingStatus === 'orphan_recording').length,
    missingCanonicalRecordings: issues.filter(item => item.kind === 'canonical_missing_recording').length,
    missingOrInvalid: issues.length};
  coverage.complete = issues.length === 0 && coverage.canonicalFiles === coverage.canonicalRecords &&
    coverage.normalRecordingFiles === coverage.normalRecordings && coverage.eventReplayFiles === coverage.eventReplays &&
    coverage.normalJobs === coverage.normalRecordings &&
    coverage.pendingEventPlaybackFiles === usedPendingFiles.size && coverage.pendingEventBindings === pendingJobs.length;
  return {root, snapshotDir, manifest, manifestSha256, jobs, pendingJobs, issues, coverage};
}

function pairAccumulator() {
  return {tracksDone: 0, totalPairs: 0, exactPairs: 0, informativeExactPairs: 0,
    lowInformationExactPairs: 0, sameAccountPairs: 0, sameAccountExactPairs: 0,
    crossAccountExactPairs: 0, actionableCrossAccountExactPairs: 0,
    similarPairs: 0, nearSimilarPairs: 0, comparisonsSkippedInputInvalid: 0,
    inputDecodeUnavailable: 0, findingLines: 0, findingBytes: 0};
}

async function compareAllPairs(audit, pairsFile, state, checkpoint) {
  const grouped = new Map();
  const rowCounts = new Map();
  let decodeUnavailable = 0;
  for (const job of [...audit.jobs, ...(audit.pendingJobs || [])]) {
    rowCounts.set(job.trackId, (rowCounts.get(job.trackId) || 0) + 1);
    try {
      job.controls = decodeReplay(job.replay, job.timeMs);
      job.controlHash = digest(Buffer.from(JSON.stringify(job.controls.lists)));
      if (!grouped.has(job.trackId)) grouped.set(job.trackId, []);
      grouped.get(job.trackId).push(job);
    } catch { job.inputDecode = 'unavailable'; decodeUnavailable++; }
  }
  audit.coverage.inputDecodeUnavailable = decodeUnavailable;
  const tracks = [...grouped.keys()].sort();
  const comparison = state.comparison || (state.comparison = pairAccumulator());
  const eligiblePairs = [...grouped.values()].reduce((sum, rows) => sum + rows.length * (rows.length - 1) / 2, 0);
  const sourcePairs = [...rowCounts.values()].reduce((sum, count) => sum + count * (count - 1) / 2, 0);
  comparison.comparisonsSkippedInputInvalid = sourcePairs - eligiblePairs;
  comparison.inputDecodeUnavailable = decodeUnavailable;
  if (!Number.isSafeInteger(comparison.trackCursor)) comparison.trackCursor = 0;
  if (!Number.isSafeInteger(comparison.findingBytes)) comparison.findingBytes = 0;
  let pairsHandle;
  try { pairsHandle = await fs.open(pairsFile, 'r+'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; pairsHandle = await fs.open(pairsFile, 'wx+'); }
  try {
    await pairsHandle.truncate(comparison.findingBytes);
    for (let ti = comparison.trackCursor; ti < tracks.length; ti++) {
      const rows = grouped.get(tracks[ti]);
      for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
        const left = rows[i], right = rows[j];
        comparison.totalPairs++;
        const sameAccount = left.accountId === right.accountId;
        if (sameAccount) comparison.sameAccountPairs++;
        const exact = left.timeMs === right.timeMs && left.controlHash === right.controlHash;
        const similarity = compareControls(left.controls, right.controls, left.timeMs, right.timeMs);
        if (exact) {
          comparison.exactPairs++;
          if (sameAccount) comparison.sameAccountExactPairs++;
          else comparison.crossAccountExactPairs++;
          if (similarity) comparison.informativeExactPairs++; else comparison.lowInformationExactPairs++;
          if (!sameAccount && similarity) comparison.actionableCrossAccountExactPairs++;
        }
        if (similarity) comparison.similarPairs++;
        if (similarity && !exact) comparison.nearSimilarPairs++;
        if (similarity) {
          if (comparison.findingLines < MAX_FINDING_LINES) {
            const line = `${JSON.stringify({trackId: left.trackId, exactInput: exact, sameAccount,
              actionable: Boolean(exact && similarity && !sameAccount), reviewOnly: !exact,
              informative: Boolean(similarity), inputSimilarity: similarity?.inputSimilarity ?? null,
              transitionSimilarity: similarity?.transitionSimilarity ?? null, informativeMs: similarity?.informativeMs ?? 0,
              left: {kind: left.kind, source: left.source, accountId: left.accountId, timeMs: left.timeMs, replayHash: left.replayHash},
              right: {kind: right.kind, source: right.source, accountId: right.accountId, timeMs: right.timeMs, replayHash: right.replayHash}})}\n`;
            await pairsHandle.write(line, comparison.findingBytes, 'utf8');
            comparison.findingLines++;
            comparison.findingBytes += Buffer.byteLength(line);
          }
        }
      }
      await pairsHandle.sync();
      comparison.tracksDone = ti + 1;
      comparison.trackCursor = ti + 1;
      await checkpoint();
    }
    comparison.done = true;
    comparison.trackCount = tracks.length;
  } finally { await pairsHandle.close(); }
}

function restoredResultValid(result, job, audit) {
  if (!result || !['verified', 'mismatch', 'unavailable'].includes(result.status)) return false;
  if (result.trackId !== job.trackId || result.timeMs !== job.timeMs || result.replayHash !== job.replayHash) return false;
  if (result.status === 'unavailable') return true;
  return result.engineDigest === audit.manifest.engineDigest && result.verifierVersion === audit.manifest.verifierVersion &&
    result.verifierFingerprint === audit.manifest.engineFingerprint && result.nativeTrackId === job.trackId &&
    result.actualReplayHash === job.replayHash;
}

function publicResult(result) {
  return {status: result.status, reason: result.reason || null, trackId: result.trackId, timeMs: result.timeMs,
    replayHash: result.replayHash, engineDigest: result.engineDigest || null,
    verifierVersion: result.verifierVersion || result.binding?.verifierVersion || null,
    verifierFingerprint: result.binding?.verifierFingerprint || null,
    nativeTrackId: result.binding?.nativeTrackId || null, trackContentHash: result.binding?.trackContentHash || null,
    actualReplayHash: result.binding?.actualReplayHash || null};
}

function summaryFor(audit, state, done) {
  const statuses = {verified: 0, mismatch: 0, unavailable: 0, unprocessed: 0};
  for (const job of audit.jobs) statuses[state.nativeResults?.[job.recordId]?.status || 'unprocessed']++;
  return {schema: STATE_SCHEMA, advisoryOnly: true, complete: done,
    manifest: audit.manifest, manifestSha256: audit.manifestSha256, coverage: audit.coverage,
    issues: audit.issues, physics: {...statuses, total: audit.jobs.length,
      batches: state.nativeBatches || 0, batchSizeMaximum: NATIVE_BATCH_SIZE,
      noAutoApproval: true}, pairAudit: state.comparison, findingsTruncated: (state.comparison?.findingLines || 0) >= MAX_FINDING_LINES,
    findingsFile: state.findingsFile};
}

export async function auditSnapshot({report, root = DEFAULT_ROOT, maxJobs = Infinity, maxBatches = Infinity,
  verify = nativeVerify, validateEngine = validateEnginePin, onProgress = () => {}} = {}) {
  if (!Number.isInteger(maxJobs) && maxJobs !== Infinity || maxJobs < 1 ||
      !Number.isInteger(maxBatches) && maxBatches !== Infinity || maxBatches < 1) throw Error('Limits must be positive integers');
  const reportFile = await privateReportPath(report, root);
  const stateFile = reportFile + '.state.json', pairsFile = reportFile + '.pairs.jsonl';
  const audit = await loadSnapshotAuditInputs({root});
  await validateEngine();
  let state;
  try { state = JSON.parse(await fs.readFile(stateFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const checkpoint = async () => atomicJson(stateFile, state);
  if (state) {
    const oldManifestSha256 = state.manifest && digest(Buffer.from(JSON.stringify(state.manifest)));
    const compatibleRetryOnly = state.manifest?.auditSourceSha256 === CHECKPOINT_RETRY_COMPATIBLE_SOURCE &&
      audit.manifest.auditSourceSha256 !== state.manifest.auditSourceSha256 &&
      state.manifestSha256 === oldManifestSha256 &&
      Object.keys({...state.manifest, auditSourceSha256: undefined}).every(key =>
        key === 'auditSourceSha256' || state.manifest[key] === audit.manifest[key]);
    if (state.schema !== STATE_SCHEMA || state.manifestSha256 !== audit.manifestSha256 && !compatibleRetryOnly ||
        JSON.stringify(state.manifest) !== JSON.stringify(audit.manifest) && !compatibleRetryOnly) {
      throw Error('Audit checkpoint does not match current snapshot and pinned engine');
    }
  } else {
    try { await fs.access(pairsFile); throw Error('Findings file exists without matching checkpoint'); }
    catch (error) { if (error.message === 'Findings file exists without matching checkpoint') throw error; if (error.code !== 'ENOENT') throw error; }
    state = {schema: STATE_SCHEMA, manifest: audit.manifest, manifestSha256: audit.manifestSha256,
      nativeResults: {}, nativeBatches: 0, comparison: pairAccumulator(), findingsFile: pairsFile};
  }
  if (state.findingsFile !== pairsFile || !state.nativeResults || typeof state.nativeResults !== 'object') throw Error('Invalid audit checkpoint');
  state.comparison = {...pairAccumulator(), ...(state.comparison || {})};
  const jobMap = new Map(audit.jobs.map(job => [job.recordId, job]));
  for (const [id, result] of Object.entries(state.nativeResults)) {
    const job = jobMap.get(id);
    if (!job || !restoredResultValid(result, job, audit)) throw Error('Audit checkpoint contains an invalid native result');
  }
  await checkpoint();
  if (!state.comparison?.done) await compareAllPairs(audit, pairsFile, state, checkpoint);
  let remainingJobs = maxJobs, batches = 0;
  for (let index = 0; index < audit.jobs.length && batches < maxBatches;) {
    while (index < audit.jobs.length && state.nativeResults[audit.jobs[index].recordId]) index++;
    if (index >= audit.jobs.length || remainingJobs <= 0) break;
    const count = Math.min(NATIVE_BATCH_SIZE, remainingJobs, audit.jobs.length - index);
    const jobs = audit.jobs.slice(index, index + count);
    let results;
    try { results = await verify(root, jobs, loadWeeklyTrustedTrack(root, jobs)); }
    catch (error) {
      results = jobs.map(job => ({resultId: job.recordId, status: 'unavailable', reason: 'audit_batch_failed',
        trackId: job.trackId, timeMs: job.timeMs, replayHash: job.replayHash,
        engineDigest: audit.manifest.engineDigest, verifierVersion: audit.manifest.verifierVersion,
        binding: {verifierFingerprint: audit.manifest.engineFingerprint, nativeTrackId: job.trackId,
          actualReplayHash: job.replayHash}}));
      state.lastBatchError = String(error?.message || error).slice(0, 200);
    }
    if (!Array.isArray(results) || results.length !== jobs.length) throw Error('Native verifier returned an incomplete batch');
    if (new Set(results.map(result => result?.resultId)).size !== jobs.length ||
        jobs.some(job => !results.some(result => result?.resultId === job.recordId))) throw Error('Native verifier returned duplicate or unknown jobs');
    const byId = new Map(results.map(result => [result?.resultId, result]));
    for (const job of jobs) {
      const result = byId.get(job.recordId);
      const bound = result && result.trackId === job.trackId && result.timeMs === job.timeMs && result.replayHash === job.replayHash;
      const saved = bound ? publicResult(result) : {status: 'unavailable', reason: 'native_result_binding_mismatch',
        trackId: job.trackId, timeMs: job.timeMs, replayHash: job.replayHash,
        engineDigest: audit.manifest.engineDigest, verifierVersion: audit.manifest.verifierVersion,
        verifierFingerprint: audit.manifest.engineFingerprint, nativeTrackId: job.trackId, actualReplayHash: null};
      if (saved.verifierFingerprint !== audit.manifest.engineFingerprint || saved.engineDigest !== audit.manifest.engineDigest ||
          saved.verifierVersion !== audit.manifest.verifierVersion) {
        saved.status = 'unavailable'; saved.reason = 'native_engine_binding_mismatch';
      }
      state.nativeResults[job.recordId] = saved;
    }
    state.nativeBatches = (state.nativeBatches || 0) + 1;
    batches++; remainingJobs -= jobs.length;
    await checkpoint();
    index += count;
    onProgress({phase: 'native', processed: Object.keys(state.nativeResults).length,
      total: audit.jobs.length, batches: state.nativeBatches, batchSize: jobs.length});
  }
  const complete = audit.jobs.every(job => state.nativeResults[job.recordId]);
  audit.coverage.comparisonPairsSkipped = state.comparison?.comparisonsSkippedInputInvalid || 0;
  audit.coverage.complete = audit.coverage.complete && audit.coverage.inputDecodeUnavailable === 0 &&
    audit.coverage.comparisonPairsSkipped === 0;
  const summary = summaryFor(audit, state, complete && state.comparison?.done);
  await atomicJson(reportFile, summary);
  return summary;
}

function parseArgs(args) {
  const options = {maxJobs: Infinity, maxBatches: Infinity};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--report' && args[i + 1]) options.report = args[++i];
    else if (args[i] === '--max-jobs' && args[i + 1] && /^\d+$/.test(args[i + 1])) options.maxJobs = Number(args[++i]);
    else if (args[i] === '--max-batches' && args[i + 1] && /^\d+$/.test(args[i + 1])) options.maxBatches = Number(args[++i]);
    else throw Error('Usage: node snapshot-audit.mjs --report <absolute-private-json> [--max-jobs N] [--max-batches N]');
  }
  if (!options.report) throw Error('Usage: node snapshot-audit.mjs --report <absolute-private-json> [--max-jobs N] [--max-batches N]');
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  auditSnapshot(parseArgs(process.argv.slice(2))).then(summary => console.log(JSON.stringify({complete: summary.complete,
    coverage: summary.coverage, physics: summary.physics, pairAudit: summary.pairAudit,
    report: process.argv[process.argv.indexOf('--report') + 1]}))).catch(error => {
    console.error(String(error?.message || error)); process.exitCode = 1;
  });
}
