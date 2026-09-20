export const SERVER_ACHIEVEMENT_VERSION = 1;
export const SERVER_ACHIEVEMENT_CATALOG = 'ranked-recognized-2026-09-20-v1';
export const OWNER_PUBLIC_ID = '732873e979838acecbce2a663dc69122d6deca4634e999897d1cc5e677df660b';
export const SPECIAL_ROLLING_HILLS_TRACK_ID = 'fb769ac2ea77e8f19a21a9dd3071742f2342bd49c41e4748d7e8c7903d4f0778';
export const CASUAL_RP_PER_TRACK = 100;

export const BEAT_OWNER_STAGES = Object.freeze([
  Object.freeze({ threshold: 1, id: 'beat-owner-1', cosmeticId: 'emblem:target' }),
  Object.freeze({ threshold: 3, id: 'beat-owner-3', cosmeticId: 'stripe:overdrive' })
]);

const text = (value, max) => String(value || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, max);
const positiveInteger = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0;
const physicsVerified = entry => entry?.integrityVerified === true && entry?.runVerified === true;

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
  const ownerBeats = new Map();
  const audit = { version: SERVER_ACHIEVEMENT_VERSION, inputTrackDocuments: 0, inputEntries: 0,
    physicsVerifiedEntries: 0, integrityOnlyRejected: 0, unverifiedRejected: 0,
    eligibleVerifiedCompletions: 0, ownerTargets: 0, verifiedOwnerBeats: 0 };

  for (const board of trackDocuments || []) {
    const trackId = text(board?.trackId, 80);
    if (!trackId) continue;
    audit.inputTrackDocuments += 1;
    const rows = Array.isArray(board?.entries) ? board.entries : [];
    const verified = [];
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
      verified.push({ ...entry, accountId, timeMs });
      if (eligibleTracks.has(trackId)) {
        const tracks = completions.get(accountId) || new Set();
        tracks.add(trackId);
        completions.set(accountId, tracks);
        audit.eligibleVerifiedCompletions += 1;
      }
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
    for (const trackId of completions.get(accountId) || []) casualTracks.add(trackId);

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
      casualRp: casualCount * CASUAL_RP_PER_TRACK,
      casualCompletionCount: casualCount,
      cosmeticUnlocks,
      serverAchievements: {
        version: SERVER_ACHIEVEMENT_VERSION,
        catalog: SERVER_ACHIEVEMENT_CATALOG,
        casual: { ledger: encodeLedger(casualTracks, catalog), count: casualCount, rp: casualCount * CASUAL_RP_PER_TRACK, pointsPerTrack: CASUAL_RP_PER_TRACK },
        beatOwner: { targetAccountId: ownerPublicId, ledger: encodeLedger(beatenTracks, catalog), count: beatenTracks.size, unlocks }
      }
    };
  });
  return { entries: output, audit };
}
