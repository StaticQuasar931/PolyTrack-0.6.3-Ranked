import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {validatePublicReplayForPublication, hasPlayablePublicReplayStatus} from './public-replay-playback.mjs';

const HASH = /^[a-f0-9]{64}$/;
const positive = n => Number.isSafeInteger(n) && n > 0;
const digest = text => createHash('sha256').update(text).digest('hex');
const dates = ['createdAt', 'pbAt', 'updatedAt', 'ingestedAt', 'ingestedAtSource'];
const metadata = ['name', 'nickname', 'countryCode', 'carStyle', ...dates];

export function canonicalBindingSignature(row) {
  const frames = row.frames ?? row.raceTimeFrames;
  if (!HASH.test(row.accountId || '') || !HASH.test(row.trackId || '') || !positive(row.uploadId) ||
      !positive(frames) || frames > 4000000 || !HASH.test(row.replayHash || '') ||
      row.frames !== undefined && row.frames !== frames ||
      row.raceTimeFrames !== undefined && row.raceTimeFrames !== frames) throw Error('Invalid binding signature');
  return JSON.stringify([row.accountId, row.trackId, row.uploadId, frames, row.replayHash]);
}

function expectedRow(value) {
  if (typeof value === 'string') value = JSON.parse(value);
  if (Array.isArray(value)) {
    if (value.length !== 5) throw Error('Expected five binding fields');
    const [accountId, trackId, uploadId, frames, replayHash] = value;
    value = {accountId, trackId, uploadId, frames, replayHash};
  }
  canonicalBindingSignature(value);
  return value;
}

async function validateBytes(recording, row) {
  if (typeof recording !== 'string' || digest(recording) !== row.replayHash) throw Error('Replay SHA256 mismatch');
  const structure = await validatePublicReplayForPublication(recording, row.frames ?? row.raceTimeFrames);
  if (!structure.indexedPlaybackWithinBudget) throw Error('Replay indexed playback budget exceeded');
}

// expectedBindings accepts five-field JSON signatures, tuples, or binding objects.
// Missing documents are allowed only when an unchanged, valid saved pair exists.
// Offline capture reconciliation only. Source status is evidence, never a local verdict.
// The caller must keep this directory exclusively owned until the promise settles.
export async function reconcileCapturedCanonical({directory, documents, expectedBindings} = {}) {
  if (!Array.isArray(documents) || !Array.isArray(expectedBindings)) throw Error('Expected documents and expectedBindings arrays');
  // Snapshot caller-owned inputs before the first await.
  documents = structuredClone(documents);
  const expected = expectedBindings.map(expectedRow).map(row => structuredClone(row));
  const root = await fs.realpath(directory), originals = new Map(), writes = new Map(), boards = new Map();
  async function safe(relative) {
    let cursor = root;
    const parts = relative.split('/');
    for (let i = 0; i < parts.length; i++) {
      cursor = path.join(cursor, parts[i]);
      try {
        const stat = await fs.lstat(cursor);
        if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) throw Error('Unsafe reconciliation path');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return cursor;
  }
  async function read(relative, optional = false) {
    const file = await safe(relative);
    let bytes;
    try {
      const stat = await fs.stat(file);
      if (stat.size > 32 * 1024 * 1024) throw Error('Reconciliation file too large');
      bytes = await fs.readFile(file);
    } catch (error) {
      if (!optional || error.code !== 'ENOENT') throw error;
      originals.set(relative, null); return null;
    }
    originals.set(relative, bytes);
    return JSON.parse(bytes);
  }
  async function plan(relative, value) {
    if (!originals.has(relative)) await read(relative, true);
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    if (bytes.length > 32 * 1024 * 1024) throw Error('Reconciliation output too large');
    if (writes.has(relative) && !writes.get(relative).equals(bytes)) throw Error('Conflicting output binding');
    writes.set(relative, bytes);
  }
  const wanted = new Map();
  for (const row of expected) {
    const id = `${row.accountId}_${row.trackId}`;
    if (wanted.has(id)) throw Error('Duplicate expected binding');
    wanted.set(id, row);
  }
  const sources = new Map();
  for (const document of documents) {
    const id = document.id ?? document.name?.split('/').at(-1);
    if (!wanted.has(id) || sources.has(id) || document.id !== undefined && document.id !== id ||
        document.name !== undefined && document.name !== id &&
        !document.name.endsWith(`/documents/0.6.2_race_results/${id}`)) throw Error('Unexpected or duplicate source document ID');
    const row = document.data;
    if (!row || `${row.accountId}_${row.trackId}` !== id) throw Error('Source account/track mismatch');
    canonicalBindingSignature(row);
    if (!positive(row.timeMs) || !hasPlayablePublicReplayStatus(row) ||
        !(row.verified === false && row.verifiedState === 0 || row.verified === true && row.verifiedState === 1) ||
        row.carStyle !== undefined && (typeof row.carStyle !== 'string' || row.carStyle.length > 256)) throw Error('Invalid source status or metadata');
    await validateBytes(row.replay, row);
    sources.set(id, document);
  }
  let changed = 0, reused = 0;
  for (const [id, binding] of wanted) {
    const boardPath = `tracks/${binding.trackId}.json`;
    if (!boards.has(boardPath)) {
      const board = await read(boardPath);
      if (board.trackId !== binding.trackId || !Array.isArray(board.entries)) throw Error('Invalid track board');
      const seen = new Set();
      for (const row of board.entries) {
        canonicalBindingSignature(row);
        if (row.trackId !== board.trackId || !positive(row.timeMs) || seen.has(row.accountId)) throw Error('Invalid or duplicate board row');
        seen.add(row.accountId);
      }
      boards.set(boardPath, board);
    }
    const board = boards.get(boardPath), index = board.entries.findIndex(row => row.accountId === binding.accountId);
    const old = board.entries[index];
    if (!old || canonicalBindingSignature(old) !== canonicalBindingSignature(binding) ||
        binding.timeMs !== undefined && binding.timeMs !== old.timeMs) throw Error('Expected existing binding mismatch');
    const document = sources.get(id), source = document?.data;
    const unchanged = !source || canonicalBindingSignature(source) === canonicalBindingSignature(old) && source.timeMs === old.timeMs;
    const canonicalPath = `canonical/${binding.trackId}/${binding.accountId}.json`;
    if (unchanged) {
      const canonical = await read(canonicalPath, true), recording = await read(`recordings/${old.uploadId}.json`, true);
      if (canonical && recording) {
        for (const row of [canonical, recording]) {
          if (canonicalBindingSignature({...old, ...row}) !== canonicalBindingSignature(old) ||
              row.accountId !== old.accountId || row.trackId !== old.trackId || row.frames !== (old.frames ?? old.raceTimeFrames) ||
              row.replayHash !== old.replayHash || row.timeMs !== undefined && row.timeMs !== old.timeMs ||
              !hasPlayablePublicReplayStatus(row)) throw Error('Invalid saved binding');
        }
        if (canonical.uploadId !== old.uploadId || canonical.timeMs !== old.timeMs || canonical.integrityVerified !== true ||
            canonical.verifiedState !== old.verifiedState || recording.verifiedState !== old.verifiedState ||
            canonical.runVerified !== old.runVerified || canonical.verified !== old.verified || old.runVerified !== old.verified ||
            !(old.verified === false && old.verifiedState === 0 || old.verified === true && old.verifiedState === 1)) throw Error('Invalid saved status');
        await validateBytes(recording.recording, old);
        if (source && source.replay !== recording.recording) throw Error('Saved/source bytes mismatch');
        reused++; continue;
      }
      if (!source) throw Error('Missing captured document and valid saved files');
    } else if (source.timeMs >= old.timeMs) throw Error('Changed binding must be strictly faster');
    const frames = source.frames ?? source.raceTimeFrames;
    if (board.entries.some(row => row.accountId !== source.accountId && row.uploadId === source.uploadId)) {
      throw Error('Recording upload collision with board row');
    }
    const projection = Object.fromEntries(metadata.filter(key => Object.hasOwn(source, key)).map(key => [key, source[key]]));
    const pending = {...projection, accountId: source.accountId, trackId: source.trackId, uploadId: source.uploadId,
      frames, raceTimeFrames: frames, timeMs: source.timeMs, replayHash: source.replayHash,
      runVerified: false, verified: false, verifiedState: 0, integrityVerified: true,
      playbackPending: true, verificationStatus: 'pending', eventRpEligible: false};
    const canonical = {...pending};
    const replayPath = `recordings/${source.uploadId}.json`, existing = await read(replayPath, true);
    if (existing && (existing.accountId !== source.accountId || existing.trackId !== source.trackId ||
        existing.frames !== frames || existing.replayHash !== source.replayHash || existing.recording !== source.replay ||
        existing.uploadId !== undefined && existing.uploadId !== source.uploadId ||
        existing.timeMs !== undefined && existing.timeMs !== source.timeMs)) throw Error('Recording upload collision');
    await plan(canonicalPath, canonical);
    await plan(replayPath, {...pending, recording: source.replay});
    const next = {...old};
    for (const key of dates) delete next[key];
    delete next.carStyle;
    // Old run witnesses and verdict dates cannot follow a replacement binding.
    for (const key of ['verifiedAt', 'nativeLedgerKey', 'nativeLedgerManifestHash', 'physicsVerified', 'replayIntegrityVerified']) delete next[key];
    if (next.validationState === 'verified') next.validationState = 'pending';
    if (next.status === 'verified') next.status = 'pending';
    board.entries[index] = {...next, ...pending,
      originalTimeMs: old.originalTimeMs ?? old.timeMs, originalRank: old.originalRank ?? old.rank};
    changed++;
  }
  for (const [relative, board] of boards) {
    const before = JSON.parse(originals.get(relative));
    if (isDeepStrictEqual(board, before)) continue;
    board.entries.sort((a, b) => a.timeMs - b.timeMs);
    let rank = 0;
    board.entries.forEach((row, i) => { if (!i || row.timeMs !== board.entries[i - 1].timeMs) rank = i + 1; row.rank = rank; });
    await plan(relative, board);
  }
  // All source, byte, board and collision validation precedes even temporary writes.
  for (const [relative, bytes] of originals) {
    const current = await fs.readFile(await safe(relative)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (bytes === null ? current !== null : !current || !bytes.equals(current)) throw Error('Reconciliation input changed');
  }
  const staged = [], committed = [];
  try {
    for (const [relative, bytes] of writes) {
      const file = await safe(relative);
      await fs.mkdir(path.dirname(file), {recursive: true});
      const temporary = `${file}.${randomUUID()}.tmp`;
      staged.push({relative, file, temporary});
      await fs.writeFile(temporary, bytes, {flag: 'wx', mode: 0o600});
    }
    for (const item of staged) { await fs.rename(item.temporary, item.file); committed.push(item); }
  } catch (error) {
    for (const item of committed.reverse()) {
      const previous = originals.get(item.relative);
      if (previous === null) await fs.unlink(item.file);
      else await fs.writeFile(item.file, previous);
    }
    throw error;
  } finally {
    for (const item of staged) await fs.rm(item.temporary, {force: true});
  }
  return {changed, reused, files: [...writes.keys()], networkRequests: 0, verificationAttempts: 0};
}
