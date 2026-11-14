/** Pure recommendations only: no imports, storage, clock, network, unlocks or rewards.
 * Supply the entire static Extra catalog, not a loaded/browsed subset.
 * snapshotComplete must be true only for complete account-scoped profileFinishes.
 * localPBs must also be account-scoped (practice rows use bestMs/lastPlayedAt).
 * Optional row accountId/ownerAccountId bindings are enforced when present.
 * day is an explicit UTC YYYY-MM-DD; milestoneId only changes deterministic variety.
 * Quality ratings/votes are not difficulty. Missing/invalid difficulty is excluded.
 * All Kodub/archive imports are excluded: this sidecar navigates regular ranked Extras.
 * Returns fewer than five rather than inventing difficulty or escalating an unknown skill.
 */
const validId = value => typeof value === 'string' && value.length === 64 && /^[a-f0-9]{64}$/.test(value);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const own = (value, key) => Object.hasOwn(value, key);
const DAY = 86400000;
function hash(value) {
  let result = 2166136261;
  for (let i = 0; i < value.length; i++) result = Math.imul(result ^ value.charCodeAt(i), 16777619);
  result ^= result >>> 16; result = Math.imul(result, 0x85ebca6b);
  result ^= result >>> 13; result = Math.imul(result, 0xc2b2ae35);
  return (result ^ result >>> 16) >>> 0;
}
function candidate(row) {
  if (!plain(row) || !validId(row.trackId) || typeof row.name !== 'string' || !row.name.trim() ||
      row.name.length > 200 || /[<>\u0000-\u001f]/.test(row.name) ||
      !Number.isInteger(row.difficulty) || row.difficulty < 1 || row.difficulty > 10 ||
      own(row, 'ranked') && row.ranked !== true ||
      own(row, 'unranked') && row.unranked !== false ||
      own(row, 'archiveImport') && row.archiveImport !== false ||
      row.source === 'Kodub weekly' || Array.isArray(row.tags) && row.tags.includes('kodub-weekly') ||
      own(row, 'weeklyEndsAt')) return null;
  return {trackId: row.trackId, name: row.name.trim(), difficulty: row.difficulty};
}
export function recommendAchievementTracks(input = {}) {
  if (!plain(input)) return [];
  const {catalog, accountId, day, milestoneId = '', profileFinishes = [], snapshotComplete = false,
    localPBs = [], recentTrackIds = []} = input;
  if (!Array.isArray(catalog) || !validId(accountId) || typeof day !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(day) || typeof milestoneId !== 'string' || milestoneId.length > 160) return [];
  const start = Date.parse(day + 'T00:00:00.000Z');
  if (!Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== day) return [];
  const tracks = new Map(), conflicts = new Set();
  for (const row of catalog) {
    if (!plain(row) || !validId(row.trackId)) continue;
    const item = candidate(row);
    // Conflicting aliases are excluded, not resolved by arrival/catalog order.
    if (!item || tracks.has(row.trackId) && JSON.stringify(tracks.get(row.trackId)) !== JSON.stringify(item))
      conflicts.add(row.trackId);
    else tracks.set(row.trackId, item);
  }
  for (const id of conflicts) tracks.delete(id);
  const played = new Set(), recent = new Set(Array.isArray(recentTrackIds) ? recentTrackIds.filter(validId) : []);
  const observe = (rows, local) => {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (!plain(row) || !validId(row.trackId) || !tracks.has(row.trackId) ||
          own(row, 'accountId') && row.accountId !== accountId ||
          own(row, 'ownerAccountId') && row.ownerAccountId !== accountId) continue;
      const time = local && own(row, 'bestMs') ? row.bestMs : row.timeMs;
      if (!positive(time)) continue;
      played.add(row.trackId);
      for (const at of [row.pbAt, row.lastPbAt, row.lastPlayedAt])
        if (Number.isSafeInteger(at) && at >= start - 7 * DAY && at < start + DAY) recent.add(row.trackId);
    }
  };
  if (snapshotComplete === true) observe(profileFinishes, false);
  observe(localPBs, true);
  const completed = [...played].map(id => tracks.get(id).difficulty).sort((a, b) => a - b);
  const known = completed.length >= 2;
  const middle = Math.floor(completed.length / 2);
  const target = known ? (completed[middle] + completed[Math.floor((completed.length - 1) / 2)]) / 2 : 2;
  const seed = accountId + '|' + day + '|' + milestoneId;
  const suitable = [...tracks.values()].filter(item => known
    ? item.difficulty >= Math.max(1, target - 2) && item.difficulty <= Math.min(10, target + 1)
    : item.difficulty <= 3);
  const score = item => [recent.has(item.trackId) ? 1 : 0, played.has(item.trackId) ? 1 : 0,
    Math.floor(Math.abs(item.difficulty - target)), hash(seed + '|' + item.trackId)];
  suitable.sort((a, b) => {
    const left = score(a), right = score(b);
    for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return left[i] - right[i];
    return a.trackId < b.trackId ? -1 : a.trackId > b.trackId ? 1 : 0;
  });
  return suitable.slice(0, 5).map(item => {
    const skill = known ? 'Matched to the difficulty of your supplied completed tracks.' :
      'Skill unknown: beginner difficulty; fewer than two rated completions supplied.';
    const progress = played.has(item.trackId) ? 'A track you have completed.' : snapshotComplete === true
      ? 'No finish in your complete supplied history or local PBs.' : 'Completion history is incomplete.';
    const freshness = recent.has(item.trackId) ? 'Recently played in the supplied history.' :
      'Not marked recently played in the supplied history.';
    return {...item, reason: skill + ' ' + progress + ' ' + freshness};
  });
}
