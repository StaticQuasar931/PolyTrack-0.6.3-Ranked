import { eventDecode } from './events-store.js';

export const PERMANENT_ROLLING_HILLS = Object.freeze({
  id: 'permanent-rolling-hills',
  trackId: 'fb769ac2ea77e8f19a21a9dd3071742f2342bd49c41e4748d7e8c7903d4f0778',
  collection: '0.6.2_s1_leaderboards_track',
  algorithmVersion: 'participation-v8-s1',
  minimumSchemaVersion: 5,
  scoreVersion: 'rolling-hills-live-verified-v1',
  maxRp: 1001,
  entryLimit: 500
});

export class PermanentRollingHillsError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const fail = code => { throw new PermanentRollingHillsError(code); };
const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const string = (value, max) => typeof value === 'string' ? value.replace(/[<>\u0000-\u001f]/g, '').slice(0, max) : '';

function completeSnapshot(snapshot) {
  return snapshot && snapshot.trackId === PERMANENT_ROLLING_HILLS.trackId &&
    snapshot.algorithmVersion === PERMANENT_ROLLING_HILLS.algorithmVersion &&
    integer(snapshot.schemaVersion, PERMANENT_ROLLING_HILLS.minimumSchemaVersion) &&
    integer(snapshot.revision, 1) && snapshot.sourceRevision === snapshot.revision &&
    typeof snapshot.signature === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(snapshot.signature) &&
    integer(snapshot.builtAt, 1) && integer(snapshot.updatedAt, 1) && Array.isArray(snapshot.entries) &&
    snapshot.complete === true && snapshot.totalEntries === snapshot.entries.length &&
    snapshot.entries.length < PERMANENT_ROLLING_HILLS.entryLimit;
}

function eligibleEntry(entry) {
  const accountId = string(entry?.accountId || entry?.userId, 128);
  const timeMs = entry?.timeMs, frames = entry?.raceTimeFrames ?? entry?.frames;
  return accountId && entry.trackId === PERMANENT_ROLLING_HILLS.trackId &&
    integer(timeMs, 1) && timeMs <= 300000 && frames === timeMs &&
    (entry.frames == null || entry.raceTimeFrames == null || entry.frames === entry.raceTimeFrames) &&
    entry.runVerified === true && entry.integrityVerified === true &&
    typeof entry.replayHash === 'string' && /^[a-f0-9]{64}$/i.test(entry.replayHash) ? { accountId, timeMs, frames } : null;
}

export function derivePermanentRollingHills(snapshot) {
  if (!completeSnapshot(snapshot)) fail('permanent_rolling_hills_snapshot_incomplete');
  const eligible = [];
  const seen = new Set();
  for (const source of snapshot.entries) {
    const identity = eligibleEntry(source);
    if (!identity) continue;
    if (seen.has(identity.accountId)) fail('permanent_rolling_hills_duplicate_account');
    seen.add(identity.accountId);
    eligible.push({ source, ...identity });
  }
  if (!eligible.length) fail('permanent_rolling_hills_no_verified_entries');
  const targetMs = Math.min(...eligible.map(row => row.timeMs));
  const rows = eligible.map(({ source, accountId, timeMs, frames }) => ({
    accountId, trackId: PERMANENT_ROLLING_HILLS.trackId, timeMs, frames,
    rp: Math.min(PERMANENT_ROLLING_HILLS.maxRp,
      Number(BigInt(PERMANENT_ROLLING_HILLS.maxRp) * BigInt(targetMs) / BigInt(timeMs))),
    name: string(source.name || source.nickname, 24) || 'Racer', countryCode: string(source.countryCode, 8).toUpperCase(),
    carStyle: string(source.carStyle, 256), replayHash: source.replayHash.toLowerCase(),
    physicsVerified: true, replayIntegrityVerified: true
  })).sort((a, b) => a.timeMs - b.timeMs || a.accountId.localeCompare(b.accountId));
  let rank = 0;
  const entries = rows.map((row, index) => {
    if (!index || row.timeMs !== rows[index - 1].timeMs) rank = index + 1;
    return { ...row, rank };
  });
  return { id: PERMANENT_ROLLING_HILLS.id, kind: 'permanent', trackId: PERMANENT_ROLLING_HILLS.trackId,
    scoreVersion: PERMANENT_ROLLING_HILLS.scoreVersion, targetPolicy: 'live-fastest-physics-verified',
    targetMs, maxRp: PERMANENT_ROLLING_HILLS.maxRp, sourceRevision: snapshot.sourceRevision,
    sourceSignature: snapshot.signature, updatedAt: snapshot.updatedAt, complete: true, entries };
}

export async function readPermanentRollingHills(request) {
  if (typeof request !== 'function') fail('permanent_rolling_hills_dependency');
  const raw = await request(`/${PERMANENT_ROLLING_HILLS.collection}/${PERMANENT_ROLLING_HILLS.trackId}`);
  if (!raw?.fields) fail('permanent_rolling_hills_snapshot_missing');
  return derivePermanentRollingHills(eventDecode({ mapValue: { fields: raw.fields } }));
}

export function mergePermanentRollingIntoTotals(finite, rolling) {
  if (!finite || !Array.isArray(finite.entries) || finite.complete !== true || finite.totalEntries !== finite.entries.length ||
    rolling?.complete !== true || !Array.isArray(rolling.entries))
    fail('permanent_rolling_hills_merge_incomplete');
  const merged = new Map();
  for (const row of finite.entries) {
    const accountId = string(row.accountId, 128);
    if (!accountId || !integer(row.rp)) continue;
    merged.set(accountId, { ...row, accountId, finiteEventRp: row.rp, permanentRollingHillsRp: 0 });
  }
  for (const row of rolling.entries) {
    const prior = merged.get(row.accountId) || { accountId: row.accountId, name: row.name, events: 0, finiteEventRp: 0 };
    merged.set(row.accountId, { ...prior, name: prior.name || row.name, carStyle: prior.carStyle || row.carStyle,
      permanentRollingHillsRp: row.rp, rollingHillsTimeMs: row.timeMs });
  }
  const sorted = [...merged.values()].map(row => ({ ...row,
    rp: row.finiteEventRp + row.permanentRollingHillsRp,
    dynamicEventRp: row.permanentRollingHillsRp
  })).sort((a, b) => b.rp - a.rp || a.accountId.localeCompare(b.accountId)).slice(0, 200);
  let rank = 0;
  const entries = sorted.map((row, index) => {
    if (!index || row.rp !== sorted[index - 1].rp) rank = index + 1;
    return { ...row, rank };
  });
  return { ...finite, entries, complete: merged.size <= 200, totalEntries: merged.size, updatedAt: Math.max(Number(finite.updatedAt || 0), rolling.updatedAt), eventRpComplete: true,
    dynamicComponents: { permanentRollingHills: { status: 'complete', id: rolling.id, trackId: rolling.trackId,
      scoreVersion: rolling.scoreVersion, targetPolicy: rolling.targetPolicy, targetMs: rolling.targetMs,
      maxRp: rolling.maxRp, sourceRevision: rolling.sourceRevision, updatedAt: rolling.updatedAt } } };
}
