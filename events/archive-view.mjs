const KIND_LABELS = Object.freeze({
  daily: 'Daily',
  weekly: 'Weekly',
  kodub: 'Kodub weekly',
  custom: 'Event'
});
const PERMANENT_ROLLING_ID = 'permanent-rolling-hills';

function finiteInteger(value, fallback = 0) {
  return Number.isSafeInteger(value) ? value : fallback;
}

function snapshotFor(snapshots, id) {
  if (snapshots instanceof Map) return snapshots.get(id);
  return snapshots && typeof snapshots === 'object' ? snapshots[id] : undefined;
}

function validEntries(snapshot) {
  return Array.isArray(snapshot?.entries)
    ? snapshot.entries.filter(row => row && typeof row === 'object')
    : [];
}

function isPending(row) {
  return row.pending === true || row.status === 'pending';
}

function racerIdentity(row, index) {
  return typeof row.accountId === 'string' && row.accountId ? `account:${row.accountId}` : `anonymous:${index}`;
}

function dedupeVerifiedEntries(snapshot) {
  const best = new Map();
  for (const [index, row] of validEntries(snapshot).entries()) {
    if (isPending(row)) continue;
    const key = racerIdentity(row, index);
    const prior = best.get(key);
    const time = Number.isFinite(row.timeMs) && row.timeMs > 0 ? row.timeMs : Number.POSITIVE_INFINITY;
    const priorTime = Number.isFinite(prior?.timeMs) && prior.timeMs > 0 ? prior.timeMs : Number.POSITIVE_INFINITY;
    if (!prior || time < priorTime) best.set(key, row);
  }
  const rows = [...best.values()].sort((a, b) => {
    const aTime = Number.isFinite(a.timeMs) && a.timeMs > 0 ? a.timeMs : Number.POSITIVE_INFINITY;
    const bTime = Number.isFinite(b.timeMs) && b.timeMs > 0 ? b.timeMs : Number.POSITIVE_INFINITY;
    return aTime - bTime || String(a.accountId || '').localeCompare(String(b.accountId || ''));
  });
  let rank = 0;
  return rows.map((row, index) => {
    if (!index || row.timeMs !== rows[index - 1].timeMs) rank = index + 1;
    return Object.freeze({ ...row, rank });
  });
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function declaredRacerCount(value) {
  if (!value || typeof value !== 'object') return null;
  return safeCount(value.racerCount) ?? safeCount(value.entrantCount);
}

export function archivePeriodCounts(period, snapshot) {
  const entries = validEntries(snapshot);
  const verifiedEntries = dedupeVerifiedEntries(snapshot);
  const uniqueRacers = new Set(entries.map(racerIdentity));
  const racers = declaredRacerCount(snapshot) ?? declaredRacerCount(snapshot?.period) ??
    declaredRacerCount(period) ?? (snapshot ? uniqueRacers.size : null);
  return Object.freeze({ racers, verified: snapshot ? verifiedEntries.length : null, verifiedEntries, winner: verifiedEntries[0] || null });
}

export function normalizeArchivePeriods(periods) {
  const unique = new Map();
  for (const value of Array.isArray(periods) ? periods : []) {
    if (!value || typeof value.id !== 'string' || !value.id || value.id === PERMANENT_ROLLING_ID || value.kind === 'permanent') continue;
    const period = {
      ...value,
      kind: KIND_LABELS[value.kind] ? value.kind : 'custom',
      startsAt: finiteInteger(value.startsAt),
      endsAt: finiteInteger(value.endsAt),
      maxRp: Math.max(0, finiteInteger(value.maxRp))
    };
    if (period.endsAt <= 0) continue;
    const prior = unique.get(period.id);
    if (!prior || period.endsAt > prior.endsAt) unique.set(period.id, period);
    else if (period.endsAt === prior.endsAt) unique.set(period.id, { ...prior, ...period });
  }
  return [...unique.values()].sort((a, b) => b.endsAt - a.endsAt || a.id.localeCompare(b.id));
}

export function catalogArchivePeriods(catalog, now = Date.now()) {
  const periods = Array.isArray(catalog?.periods) ? catalog.periods : [];
  const archives = Array.isArray(catalog?.archives) ? catalog.archives : [];
  const ended = periods.filter(period => period?.archived === true || Number.isSafeInteger(period?.endsAt) && period.endsAt <= now);
  return normalizeArchivePeriods([...ended, ...archives]);
}

export function paginateArchivePeriods(periods, page = 1, pageSize = 12) {
  const items = Array.isArray(periods) ? periods : [];
  const size = Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : 12;
  const pageCount = Math.max(1, Math.ceil(items.length / size));
  const requested = Number.isSafeInteger(page) ? page : 1;
  const currentPage = Math.min(pageCount, Math.max(1, requested));
  const start = (currentPage - 1) * size;
  return Object.freeze({
    page: currentPage,
    pageCount,
    pageSize: size,
    total: items.length,
    periods: items.slice(start, start + size)
  });
}

export function summarizeArchives(periods, snapshots = new Map()) {
  const normalized = normalizeArchivePeriods(periods);
  const kindCounts = { daily: 0, weekly: 0, kodub: 0, custom: 0 };
  const racers = new Set();
  let loadedEvents = 0;
  let verifiedFinishes = 0;
  for (const period of normalized) {
    kindCounts[period.kind] += 1;
    const snapshot = snapshotFor(snapshots, period.id);
    if (!snapshot) continue;
    loadedEvents += 1;
    const counts = archivePeriodCounts(period, snapshot);
    verifiedFinishes += counts.verified;
    for (const row of counts.verifiedEntries) if (typeof row.accountId === 'string' && row.accountId) racers.add(row.accountId);
  }
  return Object.freeze({
    events: normalized.length,
    loadedEvents,
    verifiedFinishes,
    uniqueRacers: racers.size,
    kindCounts: Object.freeze(kindCounts)
  });
}

function appendText(document, parent, tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  parent.append(node);
  return node;
}

function formatDate(value, locale) {
  if (!Number.isSafeInteger(value) || value <= 0) return 'Date unavailable';
  try {
    return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', year: 'numeric' }).format(value);
  } catch {
    return 'Date unavailable';
  }
}

function defaultTime(value) {
  if (!Number.isFinite(value) || value <= 0) return 'No time';
  const minutes = Math.floor(value / 60000);
  const seconds = Math.floor(value % 60000 / 1000);
  const milliseconds = Math.floor(value % 1000);
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`;
}

function renderStats(document, target, periods, snapshots) {
  const summary = summarizeArchives(periods, snapshots);
  const values = [
    ['Events', summary.events],
    ['Daily', summary.kindCounts.daily],
    ['Weekly', summary.kindCounts.weekly + summary.kindCounts.kodub],
    [summary.loadedEvents === summary.events ? 'Verified finishes' : 'Finishes loaded', summary.verifiedFinishes]
  ];
  target.replaceChildren();
  for (const [label, value] of values) {
    const item = document.createElement('div');
    item.className = 'sq-archive-stat';
    appendText(document, item, 'dt', '', label);
    appendText(document, item, 'dd', '', String(value));
    target.append(item);
  }
  target.dataset.loadedEvents = String(summary.loadedEvents);
  target.dataset.totalEvents = String(summary.events);
}

function renderRows(document, target, entries, formatTime, accountId) {
  target.replaceChildren();
  if (!entries.length) {
    appendText(document, target, 'p', 'sq-archive-empty', 'No verified finishes were recorded.');
    return;
  }
  const list = document.createElement('ol');
  list.className = 'sq-event-results';
  for (const [index, row] of entries.entries()) {
    const item = document.createElement('li');
    appendText(document, item, 'b', '', `#${finiteInteger(row.rank, index + 1)}`);
    const racer = appendText(document, item, 'span', '', typeof row.name === 'string' && row.name ? row.name : 'Racer');
    if (accountId && row.accountId === accountId) {
      racer.append(document.createTextNode(' '));
      appendText(document, racer, 'strong', 'sq-event-you', 'YOU');
    }
    appendText(document, item, 'time', '', formatTime(row.timeMs));
    appendText(document, item, 'strong', '', `${Math.max(0, finiteInteger(row.rp))} RP`);
    list.append(item);
  }
  target.append(list);
}

/**
 * Mounts a complete archive browser into root. Snapshots are fetched only when
 * an event is expanded; pass a Map in snapshots to seed already-cached boards.
 */
export function mountArchiveView(root, options = {}) {
  if (!root || typeof root.replaceChildren !== 'function') throw new TypeError('Archive root is required.');
  const document = root.ownerDocument;
  const periods = normalizeArchivePeriods(options.periods);
  const snapshots = options.snapshots instanceof Map ? options.snapshots : new Map(Object.entries(options.snapshots || {}));
  const loadSnapshot = typeof options.loadSnapshot === 'function' ? options.loadSnapshot : null;
  const formatTime = typeof options.formatTime === 'function' ? options.formatTime : defaultTime;
  const resolveName = typeof options.resolveName === 'function'
    ? options.resolveName
    : period => period.trackName || period.label || 'Archived event';
  const renderThumbnail = typeof options.renderThumbnail === 'function' ? options.renderThumbnail : null;
  const locale = options.locale;

  const view = document.createElement('section');
  view.className = 'sq-archive-view';
  const toolbar = document.createElement('div');
  toolbar.className = 'sq-archive-toolbar';
  const intro = document.createElement('div');
  appendText(document, intro, 'h3', '', options.title || 'Past events');
  appendText(document, intro, 'p', '', 'Final verified standings by event.');
  toolbar.append(intro);
  if (typeof options.onMonthChange === 'function') {
    const form = document.createElement('form');
    form.className = 'sq-event-archive-filter';
    const label = appendText(document, form, 'label', '', 'Month ');
    const input = document.createElement('input');
    input.type = 'month';
    input.name = 'archive-month';
    input.value = typeof options.month === 'string' ? options.month : '';
    input.setAttribute('aria-label', 'Archive month');
    label.append(input);
    const submit = appendText(document, form, 'button', 'button', 'View month');
    submit.type = 'submit';
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (/^\d{4}-\d{2}$/.test(input.value)) options.onMonthChange(input.value);
    });
    toolbar.append(form);
  }
  view.append(toolbar);

  const stats = document.createElement('dl');
  stats.className = 'sq-archive-stats';
  view.append(stats);
  renderStats(document, stats, periods, snapshots);

  const events = document.createElement('div');
  events.className = 'sq-archive-events';
  view.append(events);

  const pagination = document.createElement('nav');
  pagination.className = 'sq-archive-pagination';
  pagination.setAttribute('aria-label', 'Archive pages');
  view.append(pagination);

  function renderPeriod(period) {
    const details = document.createElement('details');
    details.className = 'sq-archive-event';
    details.dataset.archiveEventId = period.id;
    const summary = document.createElement('summary');
    summary.className = 'sq-archive-event-summary';
    const thumbnail = document.createElement('span');
    thumbnail.className = 'sq-archive-thumb';
    const artwork = renderThumbnail?.(period);
    if (artwork && typeof artwork.nodeType === 'number') thumbnail.append(artwork);
    summary.append(thumbnail);
    const title = document.createElement('span');
    title.className = 'sq-archive-title';
    appendText(document, title, 'strong', '', String(resolveName(period) || 'Archived event'));
    appendText(document, title, 'small', '', `${KIND_LABELS[period.kind]} | ${formatDate(period.endsAt, locale)} | Up to ${period.maxRp} RP`);
    summary.append(title);
    const initialRacers = declaredRacerCount(period);
    const count = appendText(document, summary, 'span', 'sq-archive-count',
      initialRacers === null ? 'Open standings' : `${initialRacers} ${initialRacers === 1 ? 'racer' : 'racers'}`);
    details.append(summary);
    const board = document.createElement('div');
    board.className = 'sq-archive-board';
    if (typeof options.onOpenPeriod === 'function') {
      const actions = document.createElement('div');
      actions.className = 'sq-event-actions sq-archive-actions';
      const open = appendText(document, actions, 'button', 'button', 'Track details / practice');
      open.type = 'button';
      open.addEventListener('click', () => options.onOpenPeriod(period));
      board.append(actions);
    }
    const results = document.createElement('div');
    results.className = 'sq-archive-standings';
    board.append(results);
    details.append(board);
    events.append(details);

    let loading = null;
    const showSnapshot = snapshot => {
      const counts = archivePeriodCounts(period, snapshot);
      snapshots.set(period.id, snapshot);
      count.replaceChildren();
      appendText(document, count, 'span', 'sq-archive-racer-count', `${counts.racers} ${counts.racers === 1 ? 'racer' : 'racers'}`);
      count.append(document.createTextNode(' | '));
      appendText(document, count, 'span', 'sq-archive-verified-count', `${counts.verified} verified`);
      if (counts.winner) {
        count.append(document.createTextNode(' | '));
        const winnerName = typeof counts.winner.name === 'string' && counts.winner.name ? counts.winner.name : 'Racer';
        appendText(document, count, 'span', 'sq-archive-winner', `Winner ${winnerName} ${formatTime(counts.winner.timeMs)}`);
      }
      renderRows(document, results, counts.verifiedEntries, formatTime, options.accountId || '');
      renderStats(document, stats, periods, snapshots);
    };
    if (snapshots.has(period.id)) showSnapshot(snapshots.get(period.id));

    details.addEventListener('toggle', () => {
      if (!details.open || snapshots.has(period.id) || loading) return;
      if (!loadSnapshot) {
        results.replaceChildren();
        appendText(document, results, 'p', 'sq-archive-error', 'Final standings are unavailable in this view.');
        return;
      }
      results.replaceChildren();
      appendText(document, results, 'p', 'sq-archive-loading', 'Loading final standings...');
      loading = Promise.resolve(loadSnapshot(period))
        .then(snapshot => {
          if (!snapshot || !Array.isArray(snapshot.entries)) throw new Error('Invalid archive snapshot');
          showSnapshot(snapshot);
        })
        .catch(() => {
          results.replaceChildren();
          appendText(document, results, 'p', 'sq-archive-error', 'Final standings could not be loaded. Close and reopen this event to retry.');
        })
        .finally(() => { loading = null; });
    });
  }

  let currentPage = 1;
  function renderPage(page = currentPage) {
    const pageInfo = paginateArchivePeriods(periods, page);
    currentPage = pageInfo.page;
    events.replaceChildren();
    if (!pageInfo.total) {
      appendText(document, events, 'p', 'sq-archive-empty', 'No archived events in this view.');
      pagination.replaceChildren();
      return;
    }
    for (const period of pageInfo.periods) renderPeriod(period);
    pagination.replaceChildren();
    if (pageInfo.pageCount < 2) return;
    const previous = appendText(document, pagination, 'button', 'button', 'Previous');
    previous.type = 'button';
    previous.disabled = pageInfo.page === 1;
    previous.addEventListener('click', () => renderPage(currentPage - 1));
    const pageLabel = appendText(document, pagination, 'span', 'sq-archive-page-count', `Page ${pageInfo.page} of ${pageInfo.pageCount}`);
    pageLabel.setAttribute('aria-live', 'polite');
    const next = appendText(document, pagination, 'button', 'button', 'Next');
    next.type = 'button';
    next.disabled = pageInfo.page === pageInfo.pageCount;
    next.addEventListener('click', () => renderPage(currentPage + 1));
  }

  renderPage();

  root.replaceChildren(view);
  return Object.freeze({ element: view, periods, snapshots });
}
