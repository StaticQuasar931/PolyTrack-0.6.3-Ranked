import {createHash} from 'node:crypto';
import {rankTrustedTrackEntries} from '../workers/ranked/src/index.js';
import {canonicalBindingSignature} from './reconcile-captured-canonical.mjs';
import {hasPlayablePublicReplayStatus, validatePublicReplayForPublication} from './public-replay-playback.mjs';

const HASH = /^[a-f0-9]{64}$/;
const HOLD_FIELDS = ['needsReview', 'reviewHold', 'excluded', 'unscored', 'held', 'hold', 'unranked'];
const demand = (ok, message) => { if (!ok) throw Error(`Canonical retained track: ${message}`); };

function playable(row) {
  return hasPlayablePublicReplayStatus(row) && HOLD_FIELDS.every(key =>
    !Object.hasOwn(row, key) || row[key] === false) &&
    !(typeof row.reason === 'string' && /review|hold|excluded|unscored|rejected|mismatch/i.test(row.reason));
}

function validateBoard(board, trackId) {
  demand(board?.trackId === trackId && Array.isArray(board.entries) && board.entries.length <= 10000 &&
    board.complete === true && board.sourceComplete !== false && board.totalEntriesExact !== false &&
    board.ranksExact !== false && board.totalEntries === board.entries.length &&
    (board.count === undefined || board.count === board.entries.length), 'incomplete or inexact board');
  const accounts = new Set();
  for (const row of board.entries) {
    demand(row && HASH.test(row.accountId) && row.trackId === trackId &&
      Number.isSafeInteger(row.timeMs) && row.timeMs > 0 && !accounts.has(row.accountId),
    'invalid or duplicate board account');
    accounts.add(row.accountId);
  }
  return accounts;
}

export function createCanonicalRetainedTrack({readCanonical, proofAllowed, maxDocuments = 32} = {}) {
  demand(typeof readCanonical === 'function' && typeof proofAllowed === 'function', 'callbacks required');
  demand(Number.isSafeInteger(maxDocuments) && maxDocuments >= 1 && maxDocuments <= 32, 'invalid document budget');
  let used = 0, reserved = 0;
  const published = [];

  async function reconcile({trackId, prior, board} = {}) {
    demand(typeof trackId === 'string' && HASH.test(trackId), 'invalid track');
    prior = structuredClone(prior);
    board = structuredClone(board);
    validateBoard(prior, trackId);
    const accounts = validateBoard(board, trackId);
    const missing = prior.entries.filter(row => !accounts.has(row.accountId));
    demand(board.entries.length + missing.length <= 10000, 'combined board limit');
    demand(missing.length <= maxDocuments - used - reserved, 'document budget exceeded');
    for (const row of missing) {
      canonicalBindingSignature(row);
      demand(playable(row) && row.runVerified === true && typeof row.nativeLedgerKey === 'string' &&
        HASH.test(row.nativeLedgerKey) && proofAllowed(structuredClone(row)) === true, 'missing native proof or held prior row');
    }

    // Reserve the whole batch synchronously, including against concurrent reconciliations.
    reserved += missing.length;
    let unread = missing.length;
    const retained = [];
    try {
      for (const row of missing) {
        reserved--; unread--; used++;
        const doc = structuredClone(await readCanonical(row.accountId, trackId));
        const source = doc?.data, id = `${row.accountId}_${trackId}`;
        demand(source && doc.exists !== false && !doc.missing, 'missing canonical document');
        demand((doc.id === undefined || doc.id === id) &&
          (doc.name === undefined || doc.name === id || typeof doc.name === 'string' &&
            /^projects\/[^/]+\/databases\/[^/]+\/documents\/0\.6\.2_race_results\/[^/]+$/.test(doc.name) &&
            doc.name.endsWith(`/${id}`)), 'canonical document identity mismatch');
        demand(canonicalBindingSignature(source) === canonicalBindingSignature(row) &&
          source.timeMs === row.timeMs, 'canonical binding changed');
        demand(playable(source), 'canonical status held or unavailable');
        demand(typeof source.replay === 'string' &&
          createHash('sha256').update(source.replay).digest('hex') === row.replayHash, 'replay SHA256 mismatch');
        const replay = await validatePublicReplayForPublication(source.replay, row.frames ?? row.raceTimeFrames);
        demand(replay.indexedPlaybackWithinBudget === true, 'replay indexed playback budget exceeded');
        retained.push({accountId: row.accountId, trackId, uploadId: row.uploadId, replayHash: row.replayHash,
          canonicalUpdateTime: doc.updateTime || null});
      }
      const entries = rankTrustedTrackEntries([...board.entries, ...missing], trackId);
      const output = {...board, entries, complete: true, sourceComplete: true, totalEntriesExact: true,
        ranksExact: true, totalEntries: entries.length};
      if (Object.hasOwn(output, 'count')) output.count = entries.length;
      if (Object.hasOwn(output, 'publishedEntries')) output.publishedEntries = entries.length;
      delete output.pagination;
      delete output.paginatedSource;
      published.push(...structuredClone(retained));
      return {board: output, retained, readDocuments: missing.length};
    } finally {
      reserved -= unread;
    }
  }

  return {reconcile, usedDocuments: () => used,
    report: () => ({maxDocuments, readDocuments: used, retained: structuredClone(published)})};
}
