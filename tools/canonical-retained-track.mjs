import {createHash} from 'node:crypto';
import {rankTrustedTrackEntries} from '../workers/ranked/src/index.js';
import {canonicalBindingSignature} from './reconcile-captured-canonical.mjs';
import {hasPlayablePublicReplayStatus, validatePublicReplayForPublication} from './public-replay-playback.mjs';

const quarantineResults = new WeakSet();
export const hasCanonicalQuarantine = result => quarantineResults.has(result);

export const MANUAL_CANONICAL_READ_LIMIT = 875;
const HASH = /^[a-f0-9]{64}$/;
export class CanonicalRunChangedError extends Error {
  constructor(trackId, fields) {
    super('Canonical retained track: canonical binding changed (track '+trackId+'; '+fields.join(', ')+')');
    this.trackId = trackId;
  }
}

const HOLD_FIELDS = ['needsReview', 'reviewHold', 'excluded', 'unscored', 'held', 'hold', 'unranked'];
const demand = (ok, message) => { if (!ok) throw Error(`Canonical retained track: ${message}`); };

function playable(row) {
  return hasPlayablePublicReplayStatus(row) && HOLD_FIELDS.every(key =>
    !Object.hasOwn(row, key) || row[key] === false) &&
    !(typeof row.reason === 'string' && /review|hold|excluded|unscored|rejected|mismatch/i.test(row.reason));
}

// Integrity-only published rows are eligible for exact canonical retention, not for proof or RP.
function pendingPublished(row) {
  return playable(row) && row.runVerified === false && row.verified === false &&
    row.integrityVerified === true && row.verifiedState === 0 && row.verificationStatus === 'pending' &&
    row.playbackPending === true && row.playbackVerified !== true &&
    row.nativeLedgerKey == null && row.nativeLedgerManifestHash == null;
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

export function createCanonicalRetainedTrack({readCanonical, readCanonicalBatch, proofAllowed, confirmProof = () => true, maxDocuments = 32, manualRecovery = false, quarantineChanged = false} = {}) {
  demand(typeof readCanonical === 'function' && typeof proofAllowed === 'function' && typeof confirmProof === 'function', 'callbacks required');
  demand(readCanonicalBatch === undefined || typeof readCanonicalBatch === 'function', 'invalid batch reader');
  demand(Number.isSafeInteger(maxDocuments) && maxDocuments >= 1 && typeof manualRecovery === 'boolean' && maxDocuments <= (manualRecovery ? MANUAL_CANONICAL_READ_LIMIT : 32), 'invalid document budget');
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
    demand(missing.length <= maxDocuments - used - reserved, 'document budget exceeded (needed '+missing.length+', left '+(maxDocuments-used-reserved)+')');
    const pending = new Set();
    for (const row of missing) {
      canonicalBindingSignature(row);
      if (pendingPublished(row)) {
        pending.add(row.accountId);
        continue;
      }
      demand(playable(row) && row.runVerified === true && typeof row.nativeLedgerKey === 'string' &&
        HASH.test(row.nativeLedgerKey) && proofAllowed(structuredClone(row)) === true, 'missing native proof or held prior row');
    }

    // Reserve the whole batch synchronously, including against concurrent reconciliations.
    reserved += missing.length;
    let unread = missing.length;
    const retained = [], quarantined = [];
    try {
      const batchSize = readCanonicalBatch ? 32 : 1;
      for (let offset = 0; offset < missing.length; offset += batchSize) {
        const rows = missing.slice(offset, offset + batchSize);
        reserved -= rows.length; unread -= rows.length; used += rows.length;
        const docs = readCanonicalBatch
          ? await readCanonicalBatch(rows.map(row=>row.accountId), trackId)
          : [await readCanonical(rows[0].accountId, trackId)];
        demand(Array.isArray(docs) && docs.length === rows.length, 'invalid canonical batch response');
        for (const [index,row] of rows.entries()) {
          const doc = structuredClone(docs[index]);
          const source = doc?.data, id = `${row.accountId}_${trackId}`;
          demand(source && doc.exists !== false && !doc.missing, 'missing canonical document');
          demand((doc.id === undefined || doc.id === id) &&
            (doc.name === undefined || doc.name === id || typeof doc.name === 'string' &&
              /^projects\/[^/]+\/databases\/[^/]+\/documents\/0\.6\.2_race_results\/[^/]+$/.test(doc.name) &&
              doc.name.endsWith(`/${id}`)), 'canonical document identity mismatch');
          const sourceBinding=canonicalBindingSignature(source),priorBinding=canonicalBindingSignature(row);
          if(sourceBinding!==priorBinding||source.timeMs!==row.timeMs){
            const live=JSON.parse(sourceBinding),saved=JSON.parse(priorBinding);
            const fields=['account','track','upload','frames','replay'].filter((_,index)=>live[index]!==saved[index]);
            if(source.timeMs!==row.timeMs)fields.push('time');
            if(fields.includes('account') || fields.includes('track')) throw Error('Canonical retained track: canonical document identity mismatch');
            if (!quarantineChanged || pending.has(row.accountId)) throw new CanonicalRunChangedError(trackId,fields);
            quarantined.push(row.accountId);
            continue;
          }
          demand(playable(source), 'canonical status held or unavailable');
          demand(typeof source.replay === 'string' &&
            createHash('sha256').update(source.replay).digest('hex') === row.replayHash, 'replay SHA256 mismatch');
          const replay = await validatePublicReplayForPublication(source.replay, row.frames ?? row.raceTimeFrames);
          demand(replay.indexedPlaybackWithinBudget === true, 'replay indexed playback budget exceeded');
          if (!pending.has(row.accountId)) {
            demand(confirmProof(structuredClone(row),structuredClone(source)) === true, 'current native proof or policy did not match');
          }
          retained.push({accountId: row.accountId, trackId, uploadId: row.uploadId, replayHash: row.replayHash,
            canonicalUpdateTime: doc.updateTime || null});
        }
      }
      const excluded = new Set(quarantined);
      const entries = rankTrustedTrackEntries([...board.entries, ...missing.filter(row => !excluded.has(row.accountId))], trackId);
      const output = {...board, entries, complete: true, sourceComplete: true, totalEntriesExact: true,
        ranksExact: true, totalEntries: entries.length};
      if (Object.hasOwn(output, 'count')) output.count = entries.length;
      if (Object.hasOwn(output, 'publishedEntries')) output.publishedEntries = entries.length;
      delete output.pagination;
      delete output.paginatedSource;
      published.push(...structuredClone(retained));
      const result = {board: output, retained, readDocuments: missing.length};
      if (quarantined.length) {
        result.quarantined = Object.freeze(quarantined);
        quarantineResults.add(result);
      }
      return result;
    } finally {
      reserved -= unread;
    }
  }

  return {reconcile, usedDocuments: () => used,
    report: () => ({maxDocuments, readDocuments: used, retained: structuredClone(published)})};
}
