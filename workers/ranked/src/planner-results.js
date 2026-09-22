export const PLANNER_BUNDLE_VERSION = 1;
export const PLANNER_PUBLICATION_VERSION = 2;
export const PLANNER_DOCUMENT_BUDGET = 900000;
const utf8 = new TextEncoder();

// Includes a conservative document-name allowance. Matches the types emitted by encodeFields.
export function plannerDocumentBytes(document) {
  function size(value) {
    if (value == null || typeof value === 'boolean') return 1;
    if (typeof value === 'number') return 8;
    if (typeof value === 'string') return utf8.encode(value).length + 1;
    if (Array.isArray(value)) return value.reduce((sum, item) => sum + size(item), 0);
    return 32 + Object.entries(value).reduce((sum, [key, item]) =>
      item === undefined ? sum : sum + utf8.encode(key).length + 1 + size(item), 0);
  }
  return 1024 + size(document);
}

export async function packPlannerResults(entries, snapshot, {boardCount = 0, boardLimit = 100} = {}) {
  const metadata = {
    resultBundleVersion: PLANNER_BUNDLE_VERSION,
    resultBundleEncoding: 'gzip-base64-json-v1',
    resultBundleComplete: false,
    resultBundleStatus: 'invalid_results',
    resultBoardCount: boardCount,
    resultBoardLimit: boardLimit,
    resultBoardLimitReached: boardCount >= boardLimit,
    resultCoverage: 'snapshot_boards'
  };
  if (!Array.isArray(entries) || entries.length > 200) return metadata;
  const users = new Set(), tracks = new Set();
  for (const entry of entries) {
    if (typeof entry.userId !== 'string' || !entry.userId || users.has(entry.userId) ||
        !Array.isArray(entry.resultSamples) || entry.resultSamples.length > boardLimit) return metadata;
    users.add(entry.userId);
    const seen = new Set();
    for (const sample of entry.resultSamples) {
      if (!sample || typeof sample.trackId !== 'string' || !sample.trackId || seen.has(sample.trackId) ||
          !Number.isSafeInteger(sample.rank) || sample.rank < 1 ||
          !Number.isSafeInteger(sample.fieldSize) || sample.fieldSize < sample.rank ||
          !Number.isFinite(sample.weight) || sample.weight <= 0 ||
          !Number.isFinite(sample.competition) || sample.competition <= 0 ||
          !Number.isSafeInteger(sample.timeMs) || sample.timeMs <= 0 ||
          !Number.isSafeInteger(sample.pbAt) || sample.pbAt < 0) return metadata;
      seen.add(sample.trackId); tracks.add(sample.trackId);
    }
  }
  if (tracks.size > boardLimit) return metadata;
  const resultTracks = [...tracks].sort();
  const trackIndex = new Map(resultTracks.map((id, i) => [id, i]));
  const payload = {resultTracks, entries: entries.map(entry => ({userId: entry.userId,
    resultData: JSON.stringify(entry.resultSamples.map(sample => [trackIndex.get(sample.trackId),
      sample.rank, sample.fieldSize, sample.weight, sample.competition, sample.timeMs, sample.pbAt])
      .sort((a, b) => a[0] - b[0]))}))};
  let compressed;
  try {
    const stream = new Blob([JSON.stringify(payload)]).stream().pipeThrough(new CompressionStream('gzip'));
    compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return {...metadata, resultBundleStatus: 'compression_unavailable'};
  }
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < compressed.length; offset += chunkSize) {
    binary += String.fromCharCode(...compressed.subarray(offset, offset + chunkSize));
  }
  const resultBundle = btoa(binary);
  const packed = {...metadata, resultBundleComplete: true, resultBundleStatus: 'complete', resultBundle};
  // Never trim results to meet the budget, and never carry forward a stale bundle.
  if (plannerDocumentBytes({...snapshot, ...packed}) >= PLANNER_DOCUMENT_BUDGET) {
    if (plannerDocumentBytes({...packed, sourceRevision: snapshot.sourceRevision, builtRevision: snapshot.builtRevision,
      updatedAt: snapshot.updatedAt, algorithmVersion: snapshot.algorithmVersion}) >= PLANNER_DOCUMENT_BUDGET) {
      return {...metadata, resultBundleStatus: 'size_limit'};
    }
    return {...packed, resultBundleStatus: 'sidecar'};
  }
  return packed;
}
