const validCount = value => Number.isSafeInteger(value) && value >= 0;

// Only the published statistics artifact can establish exact racer counts.
export function snapshotPopularity(statistics) {
  const counts = new Map();
  const tracks = statistics?.tracks;
  if (statistics?.schemaVersion !== 1 || !tracks || typeof tracks !== 'object' || Array.isArray(tracks)) return counts;
  for (const [trackId, row] of Object.entries(tracks)) {
    if (!/^[a-f0-9]{64}$/.test(trackId) || row?.complete !== true || row.totalEntriesExact === false ||
        !validCount(row.players) || !validCount(row.count) || !validCount(row.totalEntries) ||
        row.players !== row.count || row.count !== row.totalEntries) continue;
    counts.set(trackId, row.players);
  }
  return counts;
}
