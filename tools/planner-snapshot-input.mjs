const positive = n => typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
const dated = row => positive(row?.serverUpdatedAt) || positive(row?.cachedAt) || positive(row?.updatedAt);
const placed = row => row?.local !== true && row?.localPending !== true && row?.pending !== true &&
  row?.ranksExact !== false && row?.sourceComplete !== false && row?.totalEntriesExact !== false &&
  Number.isSafeInteger(row?.rank) && row.rank > 0 &&
  Number.isSafeInteger(row.fieldSize) && row.fieldSize >= Math.max(2, row.rank);
const rejected = row => [row?.status, row?.runStatus, row?.validationState, row?.verificationStatus]
  .some(value => /^(rejected|mismatch)$/i.test(String(value || '')));
const canonical = value => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const rows = value => Array.isArray(value) ? value.filter(row => row?.trackId && !rejected(row)) : [];

// Observation time orders published placements. PB time is never a fetch/check timestamp.
function choosePublished(input) {
  const byTrack = new Map();
  for (const row of rows(input).filter(placed).sort((a, b) =>
    dated(b) - dated(a) || canonical(a).localeCompare(canonical(b)))) {
    if (!byTrack.has(row.trackId)) byTrack.set(row.trackId, {...row});
  }
  return [...byTrack.values()].sort((a, b) => String(a.trackId).localeCompare(String(b.trackId)));
}

/** Pure boundary for the planner. Pass the full packaged profile, not browsed track pages. */
export function buildPlannerSnapshotInput({
  snapshotResults = [], snapshotComplete = false, snapshotUpdatedAt = 0,
  summarySamples = [], cachedResults = [], localResults = [], expectedCount = null,
  trackSummaries = [], statistics = {}
} = {}) {
  const published = rows(snapshotResults).map(row => ({...row, cachedAt: dated(row) || positive(snapshotUpdatedAt)}));
  const finishes = choosePublished(snapshotComplete ? published :
    [...published, ...rows(summarySamples), ...rows(cachedResults).filter(row =>
      row.complete === true && row.ranksExact !== false && row.sourceComplete !== false &&
      row.totalEntriesExact !== false && dated(row) >= positive(snapshotUpdatedAt))]);
  const byTrack = new Map(finishes.map(row => [row.trackId, row]));
  const localPBs = new Map();
  for (const row of rows(localResults).filter(row => positive(row.timeMs)).sort((a, b) =>
    a.timeMs - b.timeMs || positive(b.pbAt) - positive(a.pbAt) || canonical(a).localeCompare(canonical(b)))) {
    const prior = byTrack.get(row.trackId);
    if (localPBs.has(row.trackId) || positive(prior?.timeMs) && row.timeMs >= prior.timeMs) continue;
    localPBs.set(row.trackId, {trackId: row.trackId, timeMs: row.timeMs, pbAt: positive(row.pbAt),
      rank: null, fieldSize: null, weight: null, local: true, localPending: true});
  }
  const fields = rows(trackSummaries).filter(row =>
    Number.isSafeInteger(row.fieldSize) && row.fieldSize >= 2 && positive(row.weight));
  for (const [trackId, row] of Object.entries(statistics || {})) {
    if (row?.complete !== true || !Number.isSafeInteger(row.players) || row.players < 2 ||
      row.count !== row.players || row.totalEntries !== row.players || !positive(row.weight) ||
      !Number.isSafeInteger(row.updatedAt) || row.updatedAt < 0) continue;
    fields.push({trackId, fieldSize: row.players, weight: row.weight, updatedAt: row.updatedAt});
  }
  const summaries = new Map();
  for (const row of fields.sort((a, b) => dated(b) - dated(a) || canonical(a).localeCompare(canonical(b)))) {
    if (!summaries.has(row.trackId)) summaries.set(row.trackId, {...row, rank: 0});
  }
  const played = [...new Set([...rows(snapshotResults), ...rows(summarySamples), ...finishes,
    ...localPBs.values()].map(row => row.trackId))].sort();
  return {finishes, localPBs: [...localPBs.values()].sort((a,b) => a.trackId.localeCompare(b.trackId)),
    played, fields: [...summaries.values()].sort((a,b) => a.trackId.localeCompare(b.trackId)),
    complete: snapshotComplete === true && Number.isSafeInteger(expectedCount) &&
      expectedCount >= 0 && finishes.length === expectedCount};
}
