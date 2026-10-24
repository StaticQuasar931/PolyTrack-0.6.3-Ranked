const TRACK_ID = /^[a-f0-9]{64}$/;
const PHYSICS_FINGERPRINT = /^[a-f0-9]{64}$/;
export const OFFICIAL_BENCHMARK_SCHEMA_VERSION = 1;

const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;

// Import one already-fetched native API page. Never retain racer names, IDs, or replays.
export function importOfficialLeaderboardPage(response, {
  trackId, capturedAt, skip = 0, onlyVerified = true,
  gameVersion = '0.6.3', physicsFingerprint = null
} = {}) {
  if (!TRACK_ID.test(trackId || '') || !nonnegative(skip) || onlyVerified !== true || gameVersion !== '0.6.3')
    throw new TypeError('Invalid official leaderboard context');
  if (physicsFingerprint !== null && !PHYSICS_FINGERPRINT.test(physicsFingerprint))
    throw new TypeError('Invalid physics fingerprint');
  const captureTime = Date.parse(capturedAt);
  if (typeof capturedAt !== 'string' || !Number.isFinite(captureTime) ||
      new Date(captureTime).toISOString() !== capturedAt)
    throw new TypeError('Invalid capture timestamp');
  if (!response || !nonnegative(response.total) || !Array.isArray(response.entries) ||
      response.entries.length > response.total - skip ||
      !response.entries.every(row => positive(row?.frames) && positive(row?.verifiedState)))
    throw new TypeError('Invalid native leaderboard response');
  const frames = response.entries.map(row => row.frames);
  if (frames.some((value, index) => index > 0 && value < frames[index - 1]))
    throw new TypeError('Native leaderboard page is not sorted by time');
  return {
    schemaVersion: OFFICIAL_BENCHMARK_SCHEMA_VERSION,
    source: 'https://vps.kodub.com/v6/leaderboard',
    gameVersion, trackId, capturedAt, physicsFingerprint, onlyVerified,
    coverage: {
      totalEntries: response.total,
      sampledEntries: frames.length,
      skip,
      complete: skip === 0 && frames.length === response.total
    },
    frames
  };
}

// Midrank percentile among all verified records, not an estimate from a top-page sample.
export function officialPercentile(reference, {trackId, gameVersion = '0.6.3', physicsFingerprint, frames} = {}) {
  if (!reference || reference.schemaVersion !== OFFICIAL_BENCHMARK_SCHEMA_VERSION ||
      reference.source !== 'https://vps.kodub.com/v6/leaderboard' ||
      reference.trackId !== trackId || reference.gameVersion !== gameVersion ||
      !PHYSICS_FINGERPRINT.test(physicsFingerprint || '') ||
      reference.physicsFingerprint !== physicsFingerprint ||
      reference.onlyVerified !== true || reference.coverage?.complete !== true ||
      reference.coverage.skip !== 0 || !positive(reference.coverage.totalEntries) ||
      reference.coverage.sampledEntries !== reference.coverage.totalEntries ||
      !Array.isArray(reference.frames) || reference.frames.length !== reference.coverage.totalEntries ||
      !reference.frames.every((value, index) => positive(value) &&
        (index === 0 || value >= reference.frames[index - 1])) || !positive(frames)) return null;
  const slower = reference.frames.filter(value => value > frames).length;
  const tied = reference.frames.filter(value => value === frames).length;
  return {
    percentile: Math.round((slower + tied / 2) / reference.frames.length * 1000) / 10,
    population: reference.frames.length,
    capturedAt: reference.capturedAt,
    definition: 'Percentage of verified records slower than this time, with ties counted as half'
  };
}
