const positive = value => Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000;
const sourceTime = value => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
const date = value => typeof value === 'string' && positive(Date.parse(value)) ? Date.parse(value) : null;

export function matchingTrackStatistics(board, record) {
  return positive(date(record?.capturedAt)) && Number.isSafeInteger(board.revision) &&
    record.revision === board.revision && record.updatedAt === board.updatedAt &&
    record.complete === (board.sourceComplete ?? board.complete) &&
    record.count === (board.publishedEntries ?? board.entries?.length);
}

// Confirmation belongs to the bound published data, never to browser hydration.
export function snapshotConfirmationTime(kind, board, {manifest, statistics} = {}) {
  if(kind==='event-totals'){
    const checked=date(board.capturedAt);
    return sourceTime(board.updatedAt)&&checked!==null&&checked>=board.updatedAt?checked:null;
  }
  const track = kind === 'track' || kind.startsWith('track-');
  const overall = kind === 'overall' || kind.startsWith('overall-');
  const event = kind === 'event';
  if (!track && !overall && !event) return null;
  const path = track ? `tracks/${board.trackId}.json` : event ? `events/${board.id}.json` : 'overall.json';
  const record = track ? manifest?.tracks?.[board.trackId] : event ? manifest?.events?.[board.id] : manifest?.overall;
  const revision = board.revision ?? board.sourceRevision;
  const bound = record?.path === path && sourceTime(board.updatedAt) && record.updatedAt === board.updatedAt &&
    (!Object.hasOwn(record, 'sourceUpdatedAt') || record.sourceUpdatedAt === board.updatedAt) &&
    (!Object.hasOwn(record, 'revision') || Number.isSafeInteger(revision) && record.revision === revision);
  const candidates = [];
  if (bound && positive(record.checkedAt)) candidates.push(record.checkedAt);
  if (track && matchingTrackStatistics(board, statistics)) candidates.push(date(statistics.capturedAt));
  // Track paging capture dates are derived from that track's check, not export time.
  if (track && board.pagingVersion === 1 && date(board.capturedAt)) candidates.push(date(board.capturedAt));
  const capture = manifest?.overallCapture;
  if (overall && bound && Number.isSafeInteger(revision) && capture?.publishedRevision === revision &&
      capture.source === 'authenticated-published-overall' && date(capture.readTime)) candidates.push(date(capture.readTime));
  // A published Overall catalog can be historical (metadataDirty). It is not a
  // current source-catalog validation and cannot reconfirm individual tracks.
  const confirmed = candidates.filter(at => at >= board.updatedAt);
  return confirmed.length ? Math.max(...confirmed) : null;
}
