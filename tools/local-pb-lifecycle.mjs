import {validatePublicReplayStructure} from './public-replay-playback.mjs';

const hashPattern = /^[a-f0-9]{64}$/;
const own = (object, key) => object != null && Object.hasOwn(object, key);
const account = row => row?.accountId || row?.userId;
const replay = row => row?.replay || row?.recording || '';
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 128 &&
  value.trim() === value && !['__proto__', 'constructor', 'prototype'].includes(value);
const validRow = row => validId(account(row)) && validId(row?.trackId) && Number.isSafeInteger(row.timeMs) && row.timeMs > 0;
const sameKey = (a, b) => account(a) === account(b) && a.trackId === b.trackId;

// Matches the existing reconcile receipt format; missing hashes are not exact proof.
export function localPbSignature(row) {
  return validRow(row) && hashPattern.test(row.replayHash || '')
    ? JSON.stringify([row.trackId, row.timeMs, row.replayHash]) : null;
}

export function canonicalPbMatches(local, canonical, {serverConfirmed = false} = {}) {
  const signature = localPbSignature(local);
  return serverConfirmed === true && signature !== null && sameKey(local, canonical || {}) &&
    signature === localPbSignature(canonical);
}

export function localPbIsConfirmed(row, state) {
  const signature = localPbSignature(row), id = account(row);
  return signature !== null && own(state, id) && own(state[id]?.confirmed, row.trackId) &&
    state[id].confirmed[row.trackId] === signature;
}

export function pendingLocalPbs(rows, accountId, state = {}) {
  if (!Array.isArray(rows) || !validId(accountId)) throw Error('Invalid local PB queue');
  const best = new Map();
  for (const row of rows) {
    if (!validRow(row) || account(row) !== accountId) continue;
    const prior = best.get(row.trackId);
    if (!prior || row.timeMs < prior.timeMs || row.timeMs === prior.timeMs && !replay(prior) && replay(row)) best.set(row.trackId, row);
  }
  return [...best.values()].filter(row => !localPbIsConfirmed(row, state));
}

// readRows/writeRows address ONLY the existing LOCAL_RACE_STORE_KEY, synchronously.
// writeRows must return true only for persistent storage, never a memory fallback.
export function persistLocalPb(row, {readRows, writeRows, maxRows = 5000} = {}) {
  try {
    if (!validRow(row) || !localPbSignature(row) || typeof replay(row) !== 'string' || !replay(row) ||
      typeof readRows !== 'function' || typeof writeRows !== 'function' || !Number.isSafeInteger(maxRows) || maxRows < 1) {
      return {localSaved: false, reason: 'invalid-pb'};
    }
    const rows = readRows();
    if (!Array.isArray(rows)) return {localSaved: false, reason: 'invalid-store'};
    const matches = rows.filter(other => validRow(other) && sameKey(row, other));
    const best = matches.reduce((a, b) => !a || b.timeMs < a.timeMs || b.timeMs === a.timeMs && !replay(a) && replay(b) ? b : a, null);
    const exact = other => localPbSignature(other) === localPbSignature(row) && replay(other) === replay(row);
    if (best && exact(best)) return {localSaved: true, row: best, changed: false};
    if (best && (best.timeMs < row.timeMs || best.timeMs === row.timeMs && replay(best))) {
      return {localSaved: false, reason: 'superseded', row: best};
    }
    const next = [JSON.parse(JSON.stringify(row)), ...rows.filter(other => !validRow(other) || !sameKey(row, other))];
    // Do not silently discard a different account's or an older pending PB.
    if (next.length > maxRows) return {localSaved: false, reason: 'capacity'};
    if (writeRows(next) !== true) return {localSaved: false, reason: 'storage-write-failed'};
    const stored = readRows();
    if (!Array.isArray(stored) || !stored.some(other => validRow(other) && sameKey(row, other) && exact(other))) {
      return {localSaved: false, reason: 'storage-readback-failed'};
    }
    return {localSaved: true, row: next[0], changed: true};
  } catch {
    return {localSaved: false, reason: 'storage-unavailable'};
  }
}

// Explicit manual own-PB selection only. This grants no public verification or RP.
// Native recording/style parsing and the current-context check remain mandatory.
export async function prepareOwnLocalPbPlayback(row, payload, {
  accountId, trackId, recordingId, isSelf = false, explicitSelection = false, playbackEngine
} = {}) {
  if (!isSelf || !explicitSelection || !validRow(row) || account(row) !== accountId || row.trackId !== trackId ||
    !Number.isSafeInteger(recordingId) || recordingId < 1 || Number(row.uploadId || row.id) !== recordingId ||
    !localPbSignature(row) || !payload || typeof payload.recording !== 'string' || payload.recording.length > 262144 || payload.recording !== replay(row) ||
    payload.frames !== Number(row.frames || row.raceTimeFrames) ||
    typeof payload.carStyle !== 'string' || payload.carStyle.length > 256 ||
    row.carStyle !== undefined && payload.carStyle !== row.carStyle) throw Error('Own local PB binding mismatch');
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload.recording)))].map(b => b.toString(16).padStart(2, '0')).join('');
  if (digest !== row.replayHash) throw Error('Own local PB hash mismatch');
  const structure = await validatePublicReplayStructure(payload.recording, payload.frames, {playbackEngine});
  return Object.freeze({recording: payload.recording, frames: payload.frames, carStyle: payload.carStyle,
    accountId, trackId, uploadId: recordingId, replayHash: digest, verifiedState: 0,
    runVerified: false, integrityVerified: false, verified: false, eventRpEligible: false,
    _dataSource: 'own-local-pb-playback', ...structure});
}
