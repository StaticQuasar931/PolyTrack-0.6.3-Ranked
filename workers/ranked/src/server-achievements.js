import { EXTRA_TRACK_IDS } from './extra-track-ids.js';

export const SERVER_ACHIEVEMENT_VERSION = 1;
export const SERVER_ACHIEVEMENT_CATALOG = 'ranked-recognized-2026-09-20-v1';
export const OWNER_PUBLIC_ID = '732873e979838acecbce2a663dc69122d6deca4634e999897d1cc5e677df660b';
export const SPECIAL_ROLLING_HILLS_TRACK_ID = 'fb769ac2ea77e8f19a21a9dd3071742f2342bd49c41e4748d7e8c7903d4f0778';
export const CASUAL_RP_MIN_PER_TRACK = 10;
export const CASUAL_RP_MAX_PER_TRACK = 100;

export const BEAT_OWNER_STAGES = Object.freeze([
  Object.freeze({ threshold: 1, id: 'beat-owner-1', cosmeticId: 'emblem:target' }),
  Object.freeze({ threshold: 3, id: 'beat-owner-3', cosmeticId: 'stripe:overdrive' })
]);

const text = (value, max) => String(value || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, max);
const positiveInteger = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0;
const physicsVerified = entry => entry?.integrityVerified === true && entry?.runVerified === true;

// The base placement award is scaled by the same published weight used by Overall RP.
export function casualRpForPlacement(rank, fieldSize, weight) {
  if (!Number.isSafeInteger(rank) || !Number.isSafeInteger(fieldSize) || rank < 1 || fieldSize < rank ||
      !Number.isFinite(weight) || weight < 0) return null;
  const percentile = fieldSize === 1 ? 0 : (fieldSize - rank) / (fieldSize - 1);
  return Number(((CASUAL_RP_MIN_PER_TRACK + (CASUAL_RP_MAX_PER_TRACK - CASUAL_RP_MIN_PER_TRACK) * percentile) * weight).toFixed(3));
}

function encodeLedger(trackIds, catalog) {
  const bytes = new Uint8Array(Math.ceil(catalog.length / 8));
  const indexes = new Map(catalog.map((trackId, index) => [trackId, index]));
  for (const trackId of trackIds) {
    const index = indexes.get(trackId);
    if (index === undefined) continue;
    bytes[index >> 3] |= 1 << (index & 7);
  }
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}

function decodeLedger(value, catalog) {
  const expectedLength = Math.ceil(catalog.length / 8) * 2;
  if (typeof value !== 'string' || value.length !== expectedLength || !/^[0-9a-f]*$/i.test(value)) return new Set();
  const tracks = new Set();
  for (let index = 0; index < catalog.length; index += 1) {
    const byte = Number.parseInt(value.slice((index >> 3) * 2, (index >> 3) * 2 + 2), 16);
    if (byte & (1 << (index & 7))) tracks.add(catalog[index]);
  }
  return tracks;
}

function priorLedger(prior, kind, catalog) {
  const achievements = prior?.serverAchievements;
  if (achievements?.version !== SERVER_ACHIEVEMENT_VERSION || achievements.catalog !== SERVER_ACHIEVEMENT_CATALOG) return new Set();
  return decodeLedger(achievements[kind]?.ledger, catalog);
}

function validSource(source, eligibleTracks) {
  const trackId = text(source?.trackId, 80);
  const sourceRevision = positiveInteger(source?.sourceRevision);
  const sourceUpdatedAt = positiveInteger(source?.sourceUpdatedAt);
  const unlockedAt = positiveInteger(source?.unlockedAt);
  const playerTimeMs = positiveInteger(source?.playerTimeMs);
  const targetTimeMs = positiveInteger(source?.targetTimeMs);
  const sourceSignature = text(source?.sourceSignature, 128);
  if (!eligibleTracks.has(trackId) || !sourceRevision || !sourceUpdatedAt || !unlockedAt ||
      !playerTimeMs || !targetTimeMs || playerTimeMs >= targetTimeMs || !/^[A-Za-z0-9_-]{16,128}$/.test(sourceSignature)) return null;
  return { trackId, source: 'ranked-track-snapshot', sourceRevision, sourceUpdatedAt, sourceSignature,
    playerTimeMs, targetTimeMs, playerPbAt: positiveInteger(source?.playerPbAt),
    targetPbAt: positiveInteger(source?.targetPbAt), unlockedAt };
}

function priorStageSources(prior, beatOwnerTracks) {
  const output = new Map();
  for (const source of Array.isArray(prior?.serverAchievements?.beatOwner?.unlocks) ? prior.serverAchievements.beatOwner.unlocks : []) {
    const stage = BEAT_OWNER_STAGES.find(candidate => candidate.id === source?.id && candidate.cosmeticId === source?.cosmeticId);
    const proof = stage ? validSource(source, beatOwnerTracks) : null;
    if (proof) output.set(stage.id, { id: stage.id, threshold: stage.threshold, cosmeticId: stage.cosmeticId, ...proof });
  }
  return output;
}

function boardSource(board, trackId, player, target, unlockedAt) {
  const revision = positiveInteger(board?.revision);
  const sourceRevision = positiveInteger(board?.sourceRevision);
  const sourceUpdatedAt = positiveInteger(board?.updatedAt || board?.builtAt);
  const sourceSignature = text(board?.signature, 128);
  if (!revision || sourceRevision !== revision || !sourceUpdatedAt || !/^[A-Za-z0-9_-]{16,128}$/.test(sourceSignature)) return null;
  return {
    trackId,
    source: 'ranked-track-snapshot',
    sourceRevision,
    sourceUpdatedAt,
    sourceSignature,
    playerTimeMs: positiveInteger(player.timeMs),
    targetTimeMs: positiveInteger(target.timeMs),
    playerPbAt: positiveInteger(player.pbAt || player.createdAt),
    targetPbAt: positiveInteger(target.pbAt || target.createdAt),
    unlockedAt
  };
}

export function aggregateServerAchievements(entries, trackDocuments, priorById, {
  eligibleTrackIds,
  beatOwnerTrackIds,
  ownerPublicId = OWNER_PUBLIC_ID,
  now = Date.now()
} = {}) {
  const catalog = [...new Set((eligibleTrackIds || []).map(value => text(value, 80)).filter(Boolean))];
  const eligibleTracks = new Set(catalog);
  const beatOwnerTracks = new Set((beatOwnerTrackIds || []).map(value => text(value, 80)).filter(value => eligibleTracks.has(value)));
  const completions = new Map();
  const casualPlacements = new Map();
  const ownerBeats = new Map();
  const audit = { version: SERVER_ACHIEVEMENT_VERSION, inputTrackDocuments: 0, inputEntries: 0,
    physicsVerifiedEntries: 0, integrityOnlyRejected: 0, unverifiedRejected: 0,
    eligibleVerifiedCompletions: 0, ownerTargets: 0, verifiedOwnerBeats: 0 };

  const boards = trackDocuments || [];
  const strongestNormalWeight = boards.reduce((strongest, board) => {
    if (EXTRA_TRACK_IDS.has(text(board?.trackId, 80))) return strongest;
    const weights = (Array.isArray(board?.entries) ? board.entries : [])
      .filter(physicsVerified)
      .map(entry => Number(entry.weight))
      .filter(weight => Number.isFinite(weight) && weight > 0);
    return weights.reduce((maximum, weight) => Math.max(maximum, weight), strongest);
  }, 0);

  for (const board of boards) {
    const trackId = text(board?.trackId, 80);
    if (!trackId) continue;
    audit.inputTrackDocuments += 1;
    const rows = Array.isArray(board?.entries) ? board.entries : [];
    const verified = [];
    const verifiedByAccount = new Map();
    for (const entry of rows) {
      audit.inputEntries += 1;
      if (!physicsVerified(entry)) {
        if (entry?.integrityVerified === true) audit.integrityOnlyRejected += 1;
        else audit.unverifiedRejected += 1;
        continue;
      }
      const accountId = text(entry.accountId || entry.userId, 128);
      const timeMs = positiveInteger(entry.timeMs);
      if (!accountId || !timeMs) continue;
      audit.physicsVerifiedEntries += 1;
      const trustedEntry = { ...entry, accountId, timeMs };
      verified.push(trustedEntry);
      const previous = verifiedByAccount.get(accountId);
      if (!previous || timeMs < previous.timeMs) verifiedByAccount.set(accountId, trustedEntry);
      if (eligibleTracks.has(trackId)) {
        const tracks = completions.get(accountId) || new Set();
        tracks.add(trackId);
        completions.set(accountId, tracks);
        audit.eligibleVerifiedCompletions += 1;
      }
    }
    const casualField = [...verifiedByAccount.values()].sort((left, right) => left.timeMs - right.timeMs || left.accountId.localeCompare(right.accountId));
    if (eligibleTracks.has(trackId)) {
      const fieldSize = casualField.length;
      let rank = 0;
      casualField.forEach((entry, index) => {
        if (index === 0 || entry.timeMs !== casualField[index - 1].timeMs) rank = index + 1;
        const placements = casualPlacements.get(entry.accountId) || new Map();
        const publishedWeight = Number(entry.weight);
        const extraCap = strongestNormalWeight > 0 ? strongestNormalWeight / 5 : 0.2;
        const weight = EXTRA_TRACK_IDS.has(trackId) && Number.isFinite(publishedWeight)
          ? Math.min(extraCap, publishedWeight) : publishedWeight;
        placements.set(trackId, board?.complete === true ? casualRpForPlacement(rank, fieldSize, weight) : null);
        casualPlacements.set(entry.accountId, placements);
      });
    }
    if (!beatOwnerTracks.has(trackId)) continue;
    const target = verified.find(entry => entry.accountId === ownerPublicId);
    if (!target) continue;
    audit.ownerTargets += 1;
    for (const entry of verified) {
      if (entry.accountId === ownerPublicId || entry.timeMs >= target.timeMs) continue;
      const source = boardSource(board, trackId, entry, target, positiveInteger(now));
      if (!source) continue;
      const tracks = ownerBeats.get(entry.accountId) || new Map();
      tracks.set(trackId, source);
      ownerBeats.set(entry.accountId, tracks);
      audit.verifiedOwnerBeats += 1;
    }
  }

  const prior = priorById instanceof Map ? priorById : new Map();
  const output = (entries || []).map(entry => {
    const accountId = text(entry?.userId || entry?.accountId, 128);
    const previous = prior.get(accountId) || {};
    const casualTracks = priorLedger(previous, 'casual', catalog);
    const legacyCasualUnknown = Number.isSafeInteger(previous.casualRp) && previous.casualRp > 0 && casualTracks.size === 0;
    for (const trackId of completions.get(accountId) || []) casualTracks.add(trackId);
    const placements = casualPlacements.get(accountId) || new Map();
    const casualRpKnown = !legacyCasualUnknown && [...casualTracks].every(trackId => Number.isFinite(placements.get(trackId)) && placements.get(trackId) >= 0);
    const casualRp = casualRpKnown ? Number([...casualTracks].reduce((sum, trackId) => sum + placements.get(trackId), 0).toFixed(3)) : null;

    const beatenTracks = priorLedger(previous, 'beatOwner', catalog);
    const priorBeatCount = beatenTracks.size;
    const liveBeatSources = ownerBeats.get(accountId) || new Map();
    const additions = [...liveBeatSources.keys()].filter(trackId => !beatenTracks.has(trackId))
      .sort((left, right) => catalog.indexOf(left) - catalog.indexOf(right));
    for (const trackId of additions) beatenTracks.add(trackId);

    const stages = priorStageSources(previous, beatOwnerTracks);
    for (const stage of BEAT_OWNER_STAGES) {
      if (stages.has(stage.id) || beatenTracks.size < stage.threshold) continue;
      const crossingIndex = Math.max(0, stage.threshold - priorBeatCount - 1);
      const source = liveBeatSources.get(additions[crossingIndex]) || liveBeatSources.get(additions.at(-1));
      if (source) stages.set(stage.id, { id: stage.id, threshold: stage.threshold, cosmeticId: stage.cosmeticId, ...source });
    }
    const unlocks = BEAT_OWNER_STAGES.flatMap(stage => stages.has(stage.id) ? [stages.get(stage.id)] : []);
    const cosmeticUnlocks = unlocks.map(unlock => unlock.cosmeticId);
    const casualCount = casualTracks.size;
    return {
      ...entry,
      casualRp,
      casualCompletionCount: casualCount,
      cosmeticUnlocks,
      serverAchievements: {
        version: SERVER_ACHIEVEMENT_VERSION,
        catalog: SERVER_ACHIEVEMENT_CATALOG,
        casual: { ledger: encodeLedger(casualTracks, catalog), count: casualCount, rp: casualRp, scoringVersion: 2 },
        beatOwner: { targetAccountId: ownerPublicId, ledger: encodeLedger(beatenTracks, catalog), count: beatenTracks.size, unlocks }
      }
    };
  });
  return { entries: output, audit };
}
