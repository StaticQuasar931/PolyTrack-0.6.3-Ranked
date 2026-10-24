// PB timestamps describe this finish; account/stat metadata describes the racer.
// Native approval remains in the private event run, never a client-writable flag.
export function canonicalPromotion(run, canonical, profile, at, serverTimestamp) {
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const pbCount = Math.min(1000000, Math.max(count(profile.pbCount), count(canonical?.pbCount)) + 1);
  const totalPlaytimeMs = Math.min(315576000000,
    Math.max(count(profile.totalPlaytimeMs), count(canonical?.totalPlaytimeMs)));
  const fields = {
    accountId: run.accountId, ownerUid: run.ownerUid, trackId: run.trackId,
    timeMs: run.timeMs, frames: run.timeMs, raceTimeFrames: run.timeMs,
    replay: run.replay, replayHash: run.replayHash,
    carStyle: run.carStyle || canonical?.carStyle || profile.carStyle || '',
    uploadId: parseInt(run.runId.slice(0, 13), 16) || 1,
    verified: false, verifiedState: 0,
    name: canonical?.name || profile.name || run.name,
    nickname: canonical?.nickname || profile.nickname || run.name,
    createdAt: run.receivedAt, pbAt: run.receivedAt, updatedAt: at,
    source: 'server-verified-event', ingestedAt: serverTimestamp,
    pbCount, totalPlaytimeMs
  };
  if (!canonical?.accountCreatedAt) fields.accountCreatedAt = profile.accountCreatedAt || run.receivedAt;
  if (!canonical && profile.countryCode !== undefined) fields.countryCode = profile.countryCode;
  return { fields, profileFields: {
    pbCount, totalPlaytimeMs, latestPbAt: Math.max(count(profile.latestPbAt), run.receivedAt), updatedAt: at
  }};
}
