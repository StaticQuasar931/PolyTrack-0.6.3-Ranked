export const TRACK_PAGE_SIZE = 100;
export const TRACK_PREVIEW_SIZE = 15;
export const TRACK_PAGING_VERSION = 1;

const ID = /^[a-f0-9]{64}$/;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => integer(value) && value > 0;
const account = row => row?.accountId || row?.userId;

function captureDate(value) {
  if (positive(value) && Number.isFinite(new Date(value).getTime())) return new Date(value).toISOString();
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) > 0 ? value : null;
}

// Normal-track RP uses ordinal ranks across the full field, even for equal times.
export function buildTrackSnapshotPaging(board, { capturedAt = null } = {}) {
  if (!ID.test(board?.trackId || '') || !Array.isArray(board.entries) ||
      !board.entries.every(row => positive(row?.timeMs))) throw new TypeError('Invalid track paging source');
  const ids = board.entries.map(account);
  const identitiesValid = ids.every((id, index) => ID.test(id || '') &&
    (!board.entries[index].userId || !board.entries[index].accountId || board.entries[index].userId === board.entries[index].accountId)) &&
    new Set(ids).size === ids.length;
  const totalEntries = integer(board.totalEntries) && board.totalEntries >= ids.length ? board.totalEntries : null;
  const sourceComplete = board.complete === true && totalEntries === ids.length && identitiesValid;
  const sorted = [...board.entries].sort((a, b) => a.timeMs - b.timeMs || String(account(a)).localeCompare(String(account(b)), 'en'));
  const suppliedRank = row => row.globalRank ?? row.rank;
  const suppliedRanksExact = board.ranksExact === true && identitiesValid && sorted.every((row, index) =>
    positive(suppliedRank(row)) && (totalEntries === null || suppliedRank(row) <= totalEntries) &&
    (!index || suppliedRank(row) > suppliedRank(sorted[index - 1])));
  const ranksExact = sourceComplete || suppliedRanksExact;
  const entries = sorted.map((row, index) => {
    const globalRank = sourceComplete ? index + 1 : suppliedRanksExact ? suppliedRank(row) : null;
    return { ...row, ...(positive(row.rank) ? { sourceRank: row.rank } : {}), rank: globalRank, globalRank,
      position: sourceComplete ? index + 1 : suppliedRanksExact && positive(row.position) ? row.position : null,
      fieldSize: totalEntries };
  });
  const pageCount = Math.ceil(entries.length / TRACK_PAGE_SIZE);
  const bounds = (rows, offset, pageNumber) => ({ pageNumber, offset, count: rows.length,
    startPosition: rows.length ? offset + 1 : null, endPosition: rows.length ? offset + rows.length : null,
    minTimeMs: rows[0]?.timeMs ?? null, maxTimeMs: rows.at(-1)?.timeMs ?? null,
    firstRank: rows[0]?.globalRank ?? null, lastRank: rows.at(-1)?.globalRank ?? null });
  const pageBounds = Array.from({ length: pageCount }, (_, index) =>
    bounds(entries.slice(index * TRACK_PAGE_SIZE, (index + 1) * TRACK_PAGE_SIZE), index * TRACK_PAGE_SIZE, index + 1));
  const metadata = {};
  for (const key of ['trackId', 'schemaVersion', 'updatedAt', 'builtAt', 'algorithmVersion', 'revision', 'sourceRevision']) {
    if (Object.hasOwn(board, key)) metadata[key] = board[key];
  }
  Object.assign(metadata, { pagingVersion: TRACK_PAGING_VERSION, sourceComplete, totalEntries,
    totalEntriesExact: totalEntries !== null && (sourceComplete || board.totalEntriesExact === true),
    publishedEntries: entries.length, ranksExact, capturedAt: captureDate(capturedAt) || captureDate(board.capturedAt),
    pageSize: TRACK_PAGE_SIZE, pageCount });
  const slice = (rows, offset, pageNumber, kind) => ({ ...metadata, kind,
    complete: sourceComplete && rows.length === totalEntries,
    pageNumber, offset, count: rows.length, bounds: bounds(rows, offset, pageNumber), entries: rows });
  const preview = { ...slice(entries.slice(0, TRACK_PREVIEW_SIZE), 0, null, 'track-preview'),
    previewSize: TRACK_PREVIEW_SIZE, pageBounds };
  const pages = pageBounds.map(({ offset, pageNumber }) => slice(entries.slice(offset, offset + TRACK_PAGE_SIZE), offset, pageNumber, 'track-page'));
  return { preview, pages };
}

export function buildOverallSnapshotPaging(board, { capturedAt = null } = {}) {
  if (!board || !Array.isArray(board.entries)) throw new TypeError('Invalid overall paging source');
  const ids = board.entries.map(account);
  const identitiesValid = ids.every((id, index) => ID.test(id || '') &&
    (!board.entries[index].userId || !board.entries[index].accountId || board.entries[index].userId === board.entries[index].accountId)) && new Set(ids).size === ids.length;
  const totalEntries = integer(board.totalEntries) && board.totalEntries >= ids.length ? board.totalEntries : null;
  const sourceComplete = board.complete === true && totalEntries === ids.length && identitiesValid;
  const ranksExact = board.ranksExact !== false && identitiesValid && board.entries.every(row => integer(row?.rank));
  // Overall order and ranks belong to the scoring backend, not the static packager.
  const entries = board.entries.map(row => ({ ...row, globalRank: ranksExact ? row.rank : null }));
  const pageCount = Math.ceil(entries.length / TRACK_PAGE_SIZE);
  const bounds = (rows, offset, pageNumber) => ({ pageNumber, offset, count: rows.length,
    startPosition: rows.length ? offset + 1 : null, endPosition: rows.length ? offset + rows.length : null,
    firstRank: rows[0]?.globalRank ?? null, lastRank: rows.at(-1)?.globalRank ?? null });
  const pageBounds = Array.from({ length: pageCount }, (_, index) =>
    bounds(entries.slice(index * TRACK_PAGE_SIZE, (index + 1) * TRACK_PAGE_SIZE), index * TRACK_PAGE_SIZE, index + 1));
  const metadata = { pagingVersion: TRACK_PAGING_VERSION, sourceComplete, totalEntries,
    totalEntriesExact: totalEntries !== null && (sourceComplete || board.totalEntriesExact === true),
    publishedEntries: entries.length, ranksExact, capturedAt: captureDate(capturedAt) || captureDate(board.capturedAt),
    pageSize: TRACK_PAGE_SIZE, pageCount };
  for (const key of ['schemaVersion', 'updatedAt', 'builtAt', 'algorithmVersion', 'revision', 'sourceRevision']) {
    if (Object.hasOwn(board, key)) metadata[key] = board[key];
  }
  const slice = (rows, offset, pageNumber, kind) => ({ ...metadata, kind, complete: sourceComplete && rows.length === totalEntries,
    pageNumber, offset, count: rows.length, bounds: bounds(rows, offset, pageNumber), entries: rows });
  const preview = { ...slice(entries.slice(0, TRACK_PREVIEW_SIZE), 0, null, 'overall-preview'), previewSize: TRACK_PREVIEW_SIZE, pageBounds };
  const pages = pageBounds.map(({ offset, pageNumber }) => slice(entries.slice(offset, offset + TRACK_PAGE_SIZE), offset, pageNumber, 'overall-page'));
  return { preview, pages };
}

export function buildBoardPageManifest(board, preview, monolithOmitted) {
  const { entries, bounds, count, offset, pageNumber, previewSize, ...metadata } = preview;
  const { entries: sourceEntries, ...boardMetadata } = board;
  const track = preview.kind === 'track-preview';
  const sourceLogicalPath = track ? `tracks/${board.trackId}.json` : 'overall.json';
  return { ...metadata, kind: track ? 'track-manifest' : 'overall-manifest', complete: preview.sourceComplete,
    sourceLogicalPath, fullBoardPath: monolithOmitted ? null : sourceLogicalPath, monolithOmitted, boardMetadata,
    pageBounds: preview.pageBounds.map(bound => ({ ...bound,
      path: track ? `track-pages/${board.trackId}/${bound.pageNumber}.json` : `overall-pages/${bound.pageNumber}.json` })) };
}

export function isBootstrapSnapshotPath(logicalPath) {
  return !/^(?:profiles|profile-results|canonical|recordings|event-replays)\//.test(logicalPath);
}

export function buildSnapshotBootstrapIndex(index) {
  return { schemaVersion: index.schemaVersion, generation: index.generation, encoding: index.encoding,
    ...(index.lookupShardsVersion === 1 ? { lookupShardsVersion: 1 } : {}),
    partial: true, fallbackIndex: 'index.json',
    files: Object.fromEntries(Object.entries(index.files).filter(([logicalPath]) => isBootstrapSnapshotPath(logicalPath))) };
}

export function buildSnapshotFastIndex(index) {
  const bootstrap=buildSnapshotBootstrapIndex(index);
  return {...bootstrap,compactIndexVersion:1,files:Object.fromEntries(Object.entries(bootstrap.files)
    .map(([logical,record])=>[logical,[record.sha256,record.decodedBytes]]))};
}
