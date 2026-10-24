import { formatActiveTime } from './active-time.mjs';
import { practiceAdvice } from './practice-history.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;
const count = value => Math.floor(num(value));

function time(value) {
  const centiseconds = Math.round(num(value) / 10);
  const seconds = Math.floor(centiseconds / 100);
  const fraction = String(centiseconds % 100).padStart(2, '0');
  if (seconds < 60) return seconds + '.' + fraction + 's';
  return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0') + '.' + fraction;
}

function date(value) {
  const timestamp = num(value);
  if (timestamp < Date.UTC(2020, 0, 1) || timestamp > Date.now()) return '';
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.valueOf())
    ? ''
    : parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function pbAge(value) {
  const timestamp = num(value);
  if (timestamp < Date.UTC(2020, 0, 1) || timestamp > Date.now()) return '';
  const elapsed = Date.now() - timestamp;
  if (elapsed < 0) return '';
  if (elapsed < 60_000) return 'just now';
  if (elapsed < 3_600_000) return Math.floor(elapsed / 60_000) + 'm ago';
  if (elapsed < 86_400_000) return Math.floor(elapsed / 3_600_000) + 'h ago';
  if (elapsed < 30 * 86_400_000) return Math.floor(elapsed / 86_400_000) + 'd ago';
  if (elapsed < 365 * 86_400_000) return Math.floor(elapsed / (30 * 86_400_000)) + 'mo ago';
  return Math.floor(elapsed / (365 * 86_400_000)) + 'y ago';
}

function nameOf(row, lookup) {
  let value = row.trackName ?? row.name;
  if (!value && typeof lookup === 'function' && row.trackId != null) {
    try { value = lookup(row.trackId); } catch {}
  } else if (!value && lookup && row.trackId != null) {
    value = lookup[row.trackId];
  }
  const fallbackId = String(row.trackId ?? '').slice(0, 8);
  return String(value || 'Track ' + (fallbackId || 'unknown'));
}

function art(row, callback) {
  if (typeof callback === 'function' && row.trackId != null) {
    try {
      const value = callback(row.trackId);
      if (typeof value === 'string' && value.trim()) return value;
    } catch {}
  }
  return '<span class="pp-preview-unknown" aria-label="Track preview unavailable">?</span>';
}

function evidenceSource(record) {
  if ((record.local === true || record.localPending === true || record.source === 'local') && record.cloudConfirmed !== true) return 'local';
  if(record.cloudConfirmed===true)return 'cloud';
  if (record.source === 'cloud') return 'cloud';
  if (record.source === 'snapshot' || num(record.snapshotCapturedAt)) return 'snapshot';
  if (record.source === 'saved') return 'saved';
  return 'known';
}

function resultEvidence(results, trackId) {
  const matching = (Array.isArray(results) ? results : [])
    .filter(record => record && record.trackId === trackId && num(record.timeMs));
  const bestBySource = new Map();
  for (const record of matching) {
    const source = evidenceSource(record);
    const current = bestBySource.get(source);
    if (!current || num(record.timeMs) < num(current.timeMs)) bestBySource.set(source, record);
  }
  const order = ['local', 'snapshot', 'cloud', 'saved', 'known'];
  return [...bestBySource.entries()]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([source, record]) => ({ source, record }));
}

function evidenceLabel(source) {
  if (source === 'local') return 'Known PB evidence · Local PB';
  if (source === 'snapshot') return 'Snapshot PB';
  if (source === 'cloud') return 'Submitted PB';
  if (source === 'saved') return 'Saved PB · source not confirmed';
  return 'Known PB evidence';
}

function rankLabel(record) {
  const rank = Number(record.rank);
  const fieldSize = Number(record.fieldSize);
  return Number.isSafeInteger(rank) && rank > 0 &&
    Number.isSafeInteger(fieldSize) && fieldSize >= rank
    ? 'Rank ' + rank + ' of ' + fieldSize
    : 'Placement not available';
}

function evidenceMarkup(evidence) {
  const { source, record } = evidence;
  const rank = rankLabel(record);
  const age = pbAge(record.pbAt);
  return '<p class="pp-evidence pp-evidence-known pp-evidence-' + source + '">' +
    '<strong>' + esc(evidenceLabel(source)) + '</strong>' +
    '<b>' + time(record.timeMs) + '</b>' +
    (rank !== 'Placement not available' ? '<span>' + esc(rank) + '</span>' : '') +
    (age ? '<small class="pp-pb-age" title="Based on the PB timestamp in the saved result">PB recorded ' + esc(age) + '</small>' : '') +
    '</p>';
}

function sessionDetailsMarkup(rows, lookup) {
  const tracks = rows.map(row => {
    const observations = row.observationVersion === 1
      ? [
          ['Focused', row.focusedMs],
          ['Paused', row.pausedMs],
          ['Hidden / unfocused', row.hiddenMs],
          ['Observed moving', row.movingMs],
          ['Stationary', row.stationaryMs], ['Unobserved gaps', row.unobservedGapMs]
        ].filter(([, value]) => num(value) > 0)
      : [];
    if (num(row.longestHuntMs)) observations.push(['Longest hunt', row.longestHuntMs, formatActiveTime]);
    if (num(row.biggestObservedImprovementMs)) observations.push(['Largest observed improvement', row.biggestObservedImprovementMs, time]);
    if (num(row.biggestPbImprovementMs)) observations.push(['Largest driven PB gain', row.biggestPbImprovementMs, time]);
    return { row, observations };
  }).filter(item => item.observations.length);

  if (!tracks.length) return '';

  const items = tracks.map(({ row, observations }) => {
    const name = nameOf(row, lookup);
    const values = observations.map(([label, value, format]) =>
      '<span><small>' + esc(label) + '</small><b>' + (format || formatActiveTime)(value) + '</b></span>'
    ).join('');
    return '<details class="pp-more pp-session-row" data-pp-details-key="session:' + esc(row.trackId) + '"><summary>' +
      '<strong>' + esc(name) + '</strong><small>' + observations.length +
      (observations.length === 1 ? ' measurement' : ' measurements') +
      '</small></summary><div class="pp-observations">' + values + '</div></details>';
  }).join('');

  return '<details class="pp-session-details"><summary>Session details <span>' +
    tracks.length + (tracks.length === 1 ? ' track' : ' tracks') +
    '</span></summary><div class="pp-session-rows">' + items + '</div></details>';
}

function cardDetails(row, evidence) {
  const observations = row.observationVersion === 1 ? [
    ['Focused', row.focusedMs], ['Paused', row.pausedMs],
    ['Hidden / unfocused', row.hiddenMs], ['Observed moving', row.movingMs],
    ['Stationary', row.stationaryMs]
  ].filter(([, value]) => num(value) > 0) : [];
  const recent = (Array.isArray(row.recentFinishes) ? row.recentFinishes : [])
    .filter(run => run && num(run.timeMs)).slice(-8);
  const earlier = Math.min(num(row.activeMs), num(row.legacyActiveMs));
  const raceTime = row.activeTimeVersion === 2 ? Math.max(0, num(row.activeMs) - earlier) : 0;
  const practical = [
    ...(earlier ? [['Earlier time estimate', formatActiveTime(earlier)]] : []),
    ...(raceTime && earlier ? [['New race progress', formatActiveTime(raceTime)]] : []),
    ...(recent.length ? [['Latest finish', time(recent.at(-1).timeMs)]] : []),
    ...(recent.length > 1 ? [['Recent finish range', time(Math.min(...recent.map(run => num(run.timeMs)))) + ' to ' + time(Math.max(...recent.map(run => num(run.timeMs))))]] : []),
    ...(count(row.furthestCheckpoint) ? [['Checkpoint progress', String(count(row.furthestCheckpoint))]] : [])
  ];
  const additional = evidence.slice(1).map(evidenceMarkup).join('');
  if (!additional && !observations.length && !practical.length) return '';
  return '<details class="pp-card-details" data-pp-details-key="track:' + esc(row.trackId) + '">' +
    '<summary aria-label="More history for ' + esc(row.trackName || row.trackId) + '">More history</summary>' +
    (additional ? '<div class="pp-extra-evidence">' + additional + '</div>' : '') +
    (observations.length ? '<dl class="pp-card-observations">' + observations.map(([label, value]) =>
      '<div><dt>' + esc(label) + '</dt><dd>' + formatActiveTime(value) + '</dd></div>').join('') + '</dl>' : '') +
    (practical.length ? '<dl class="pp-card-observations">' + practical.map(([label, value]) =>
      '<div><dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd></div>').join('') + '</dl>' : '') +
    '</details>';
}

function card(row, lookup, preview, results, rows, trackType) {
  const name = nameOf(row, lookup);
  const attempts = count(row.attempts);
  const finishes = count(row.finishes);
  const tracked = num(row.trackedBestMs);
  const evidence = resultEvidence(results, row.trackId).sort((a, b) => num(a.record.timeMs) - num(b.record.timeMs));
  if(num(row.bestMs)>0&&(!tracked||num(row.bestMs)<tracked)&&(!evidence.length||num(row.bestMs)<num(evidence[0].record.timeMs)))evidence.unshift({source:'known',record:{timeMs:row.bestMs}});
  const improvement = num(row.improvedMs ?? row.improvementMs);
  const metrics = [
    attempts ? { sort: 'attempts', text: attempts + (attempts === 1 ? ' attempt' : ' attempts') } : null,
    count(row.finishes) ? { sort: 'finishes', text: count(row.finishes) + (count(row.finishes) === 1 ? ' finish' : ' finishes') } : null,
    count(row.restarts) ? { text: count(row.restarts) + (count(row.restarts) === 1 ? ' reset' : ' resets') } : null,
    count(row.pbs) ? { text: count(row.pbs) + (count(row.pbs) === 1 ? ' recorded best' : ' recorded bests') } : null,
    count(row.respawns) ? { text: count(row.respawns) + (count(row.respawns) === 1 ? ' checkpoint respawn' : ' checkpoint respawns') } : null,
    improvement ? { sort: 'improvement', text: time(improvement) + ' driven PB gain' } :
      { sort: 'improvement', zero: true, text: 'No driven PB gain recorded' }
  ].filter(Boolean);
  if (num(row.longestHuntMs)) metrics.push({ sort: 'longest-hunt', text: formatActiveTime(row.longestHuntMs) + ' longest hunt' });
  if (num(row.biggestObservedImprovementMs)) metrics.push({sort:'observed-gain',text:time(row.biggestObservedImprovementMs)+' largest observed gain'});
  if (num(row.biggestPbImprovementMs)) metrics.push({sort:'driven-gain',text:time(row.biggestPbImprovementMs)+' largest driven PB gain'});
  const advice = practiceAdvice(row, Date.now(), { otherTracks: rows });
  const guidance = advice.factor !== 1 && date(row.lastPlayedAt) ? advice.text : '';
  const includesEarlier = num(row.legacyActiveMs) > 0;
  const playedDate=date(row.lastPlayedAt);
  const lastPlayed=playedDate?playedDate+' '+new Date(row.lastPlayedAt).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'}):'';
  const official=row.official===true||row.type==='official'||(typeof trackType==='function'&&trackType(row.trackId)==='official');
  const completed=finishes>0||tracked>0||evidence.length>0||num(row.bestMs)>0;
  const activeTime = num(row.activeMs) ? formatActiveTime(row.activeMs) : 'Not measured';
  const knownResults = evidence.length
    ? evidenceMarkup(evidence[0])
    : '';
  const trackedHistory = tracked || finishes ? '<p class="pp-evidence pp-evidence-tracked">' +
    '<strong>Tracked history</strong>' +
    (tracked ? '<b>best ' + time(tracked) + '</b>' : '') +
    (finishes ? '<span>' + finishes + ' recorded ' + (finishes === 1 ? 'finish' : 'finishes') + '</span>' : '') +
    '</p>' : '';
  return '<li class="pp-track" data-pp-track-id="' + esc(row.trackId) +
    '" data-track-name="' + esc(name.toLocaleLowerCase()) +
    '" data-active-ms="' + num(row.activeMs) +
    '" data-attempts="' + attempts +
    '" data-finishes="' + finishes +
    '" data-longest-hunt-ms="' + num(row.longestHuntMs) +
    '" data-last-played="' + (playedDate?num(row.lastPlayedAt):0) +
    '" data-observed-gain-ms="' + num(row.biggestObservedImprovementMs) +
    '" data-driven-gain-ms="' + num(row.biggestPbImprovementMs) +
    '" data-official="' + official + '" data-completed="' + completed +
    '" data-improvement-ms="' + improvement + '">' +
    '<div class="pp-track-top"><button type="button" class="pp-art pp-track-open" data-track-id="' + esc(row.trackId) +
    '" aria-label="Open track ' + esc(name) + '">' + art(row, preview) +
    '</button><div class="pp-track-main"><h3><button type="button" class="pp-track-name-button" data-track-id="' + esc(row.trackId) +
    '">' + esc(name) + '</button></h3>' +
    '<p class="pp-last-played pp-sort-metric pp-sort-recent"><small>Last played</small><strong>' +
    (lastPlayed ? esc(lastPlayed) : 'Date not recorded') + '</strong></p>' +
    '<p class="pp-active pp-sort-metric pp-sort-active" title="' +
    (includesEarlier ? 'Includes earlier time estimates. See More history for the split.' : 'Focused race-clock progress; excludes pauses and time away. Observed movement is shown in More history.') +
    '"><small>' + (includesEarlier ? 'Practice time' : 'Active race time') + '</small><strong>' +
    esc(activeTime) + '</strong></p></div></div>' +
    (knownResults || trackedHistory ? '<div class="pp-results">' + knownResults + trackedHistory + '</div>' : '') +
    (metrics.length ? '<p class="pp-track-data">' + metrics.map(value => '<span' +
      (value.sort ? ' class="pp-sort-' + value.sort + (value.zero ? ' pp-zero' : '') + '"' : '') + '>' + esc(value.text) + '</span>').join('') + '</p>' : '') +
    (num(row.sincePbMs)
      ? '<p class="pp-since-pb" title="Practice time since a PB observed by tracking; may include earlier estimates">' +
        esc(formatActiveTime(row.sincePbMs)) + (num(row.lastPbAt) >= Date.UTC(2020, 0, 1) && num(row.lastPbAt) <= Date.now() ? ' since last recorded best' : ' without a tracked PB') + '</p>'
      : '') +
    (guidance ? '<p class="pp-note" aria-label="Practice suggestion">' + esc(guidance) + '</p>' : '') +
    cardDetails(row, evidence) + '</li>';
}

function finishItems(rows, lookup) {
  return rows.flatMap(row =>
    (Array.isArray(row.recentFinishes) ? row.recentFinishes : [])
      .filter(run => run && num(run.timeMs))
      .map(run => ({ run, name: nameOf(row, lookup) }))
  ).sort((a, b) => num(b.run.at) - num(a.run.at)).slice(0, 6).map(({ run, name }) =>
    '<li class="pp-finish"><span><strong>' + esc(name) + '</strong><small>' +
    esc(date(run.at) || 'Date unavailable') +
    (num(run.practiceMs) ? ' · ' + esc(formatActiveTime(run.practiceMs)) + ' practice' : '') +
    '</small></span><b>' + time(run.timeMs) + '</b>' +
    (run.timingNote === true ? '<small class="pp-note">Practice and finish clocks differed on this run.</small>' : '') +
    '</li>'
  ).join('');
}

function coverageMarkup(coverage) {
  if (!Number.isFinite(coverage?.coverageFraction)) return '';
  const percent = Math.round(Math.max(0, Math.min(1, coverage.coverageFraction)) * 100);
  const description = percent < 10
    ? 'Less than 10% of visible time is covered. This history describes only the recorded practice.'
    : percent < 60
      ? 'Partial evidence: some visible time is covered.'
      : 'Good evidence: most visible time is covered.';
  return '<details class="pp-coverage-details"><summary>About history coverage</summary>' +
    '<p class="pp-coverage-note">' + percent + '% visible-time coverage. ' + esc(description) +
    ' Active race time is focused race-clock progress, including stationary attempts. Earlier estimates are retained separately in More history. Saved PBs do not imply a tracked finish.</p></details>';
}

export function renderPracticeProfile({ rows = [], coverage = null, trackName, trackPreview, trackType, results = [] } = {}) {
  const safe = Array.isArray(rows) ? rows.filter(row => row && typeof row === 'object') : [];
  const observed = safe.filter(row => num(row.activeMs) || count(row.attempts) || count(row.finishes));
  const total = observed.reduce((sum, row) => sum + num(row.activeMs), 0);
  const finishes = finishItems(observed, trackName);
  const details = sessionDetailsMarkup(observed, trackName);

  const summaryStats = [
    ['Longest hunt', Math.max(0, ...observed.map(row => num(row.longestHuntMs))), 'moving time on one track', formatActiveTime],
    ['Largest observed gain', Math.max(0, ...observed.map(row => num(row.biggestObservedImprovementMs))), 'known best decrease, including sync', time],
    ['Largest driven PB gain', Math.max(0, ...observed.map(row => num(row.biggestPbImprovementMs))), 'improvement from an observed finish', time]
  ].filter(([, value]) => value > 0).map(([label, value, note, format]) =>
    '<span><small>' + esc(label) + '</small><strong>' + format(value) + '</strong><small>' +
    esc(note) + '</small></span>'
  ).join('');

  const first = observed.filter(row => row.firstPlacement?.exact === true &&
    row.firstPlacement?.complete === true && row.firstPlacement?.authoritative === true &&
    Number.isSafeInteger(row.firstPlacement.rank) && row.firstPlacement.rank > 0 &&
    Number.isSafeInteger(row.firstPlacement.total) && row.firstPlacement.total >= Math.max(2, row.firstPlacement.rank)
  ).sort((a, b) =>
    (a.firstPlacement.rank - 1) / (a.firstPlacement.total - 1) -
    (b.firstPlacement.rank - 1) / (b.firstPlacement.total - 1) ||
    b.firstPlacement.total - a.firstPlacement.total
  )[0];
  const firstStat = first
    ? '<span><small>Best first recorded place</small><strong>#' + first.firstPlacement.rank +
      ' of ' + first.firstPlacement.total + '</strong><small>' + esc(nameOf(first, trackName)) +
      ' · first known during tracking, not first-ever</small></span>'
    : '';
  const cards = observed.map(row => card(row, trackName, trackPreview, results, observed, trackType)).join('');

  const body = observed.length
    ? '<div class="pp-summary" aria-label="Practice summary">' +
      '<span><small>' + (observed.some(row => num(row.legacyActiveMs)) ? 'PRACTICE TIME' : 'ACTIVE RACE TIME') + '</small><strong>' + formatActiveTime(total) + '</strong></span>' +
      '<span><small>TRACKS DRIVEN</small><strong>' + observed.length + '</strong></span>' +
      summaryStats + firstStat + '</div>' + coverageMarkup(coverage) +
      '<div class="pp-toolbar">' +
      '<label>Search tracks <input type="search" data-pp-search placeholder="Track name or ID" autocomplete="off"></label>' +
      '<div class="pp-sort-control"><label>Sort by <select data-pp-sort>' +
      '<option value="recent">Last played</option><option value="active" aria-label="Active race time">Active time</option>' +
      '<option value="attempts">Attempts</option>' +
      (observed.some(row => count(row.finishes)) ? '<option value="finishes">Finishes</option>' : '') +
      (observed.some(row => num(row.longestHuntMs)) ? '<option value="longest-hunt">Longest hunt</option>' : '') +
      (observed.some(row => num(row.improvedMs ?? row.improvementMs)) ? '<option value="improvement">Driven PB gain</option>' : '') +
      (observed.some(row => num(row.biggestObservedImprovementMs)) ? '<option value="observed-gain">Largest observed gain</option>' : '') +
      (observed.some(row => num(row.biggestPbImprovementMs)) ? '<option value="driven-gain">Largest driven PB gain</option>' : '') +
      '<option value="name">Name</option>' +
      '</select></label><button type="button" class="pp-direction" data-pp-direction="desc" aria-label="Sort descending" title="Sort descending">\u2193</button></div>' +
      '<div role="group" aria-label="Track layout">' +
      '<button type="button" data-pp-view="grid" aria-pressed="true">Grid</button>' +
      '<button type="button" data-pp-view="list" aria-pressed="false">List</button></div>' +
      '<div class="pp-filters" role="group" aria-label="Practice track filters"><button type="button" data-pp-official aria-pressed="false">Official only</button><button type="button" data-pp-finished aria-pressed="false" title="Includes a tracked finish or a saved personal best">Finished only</button></div>' +
      '<p data-pp-count aria-live="polite">' + observed.length + ' ' +
      (observed.length === 1 ? 'track' : 'tracks') + '</p></div>' +
      '<section class="pp-tracks pp-view-grid" data-pp-sort-key="recent" aria-labelledby="pp-tracks-title">' +
      '<h2 id="pp-tracks-title">Practice tracks</h2>' +
      '<p class="pp-no-results" hidden>No tracks match these filters.</p><ul>' + cards + '</ul></section>'
    : '<p class="pp-empty">Drive a track to start building your practice history.</p>';

  const finishCount = Math.min(6, observed.reduce((sum, row) =>
    sum + (Array.isArray(row.recentFinishes)
      ? row.recentFinishes.filter(run => run && num(run.timeMs)).length
      : 0), 0));

  return '<details class="polytrack-practice-profile">' +
    '<summary class="pp-heading"><span class="pp-heading-copy">' +
    '<strong>Practice history</strong><small>Local driving record</small>' +
    '</span><span class="pp-caret" aria-hidden="true"></span></summary>' +
    '<div class="pp-content">' + body +
    (details ? details : '') +
    (finishes
      ? '<details class="pp-finishes"><summary>Recent finishes <span>' + finishCount +
        '</span></summary><ul>' + finishes + '</ul></details>'
      : '') +
    '<details class="pp-manage"><summary>Manage local history</summary>' +
    '<p>Removes this racer’s practice observations from this device. Personal bests and saved tracks are not changed.</p>' +
    '<button type="button" data-clear-practice-history>Clear practice history</button></details>' +
    '</div></details>';
}

export function installPracticeProfileControls(root) {
  if (!root || typeof root.querySelector !== 'function') return () => {};
  const search = root.querySelector('[data-pp-search]');
  const sort = root.querySelector('[data-pp-sort]');
  const direction = root.querySelector('[data-pp-direction]');
  const list = root.querySelector('.pp-tracks ul');
  const section = root.querySelector('.pp-tracks');
  const countLabel = root.querySelector('[data-pp-count]');
  const empty = root.querySelector('.pp-no-results');
  const official=root.querySelector('[data-pp-official]'),finished=root.querySelector('[data-pp-finished]');
  if (!list || !section) return () => {};

  const filter = () => {
    const query = (search?.value || '').trim().toLocaleLowerCase();
    const items = [...list.querySelectorAll('.pp-track')];
    for (const item of items) {
      item.hidden = official?.getAttribute('aria-pressed')==='true'&&item.dataset.official!=='true'||finished?.getAttribute('aria-pressed')==='true'&&item.dataset.completed!=='true'||!(
        (item.dataset.trackName || '') + ' ' +
        (item.dataset.ppTrackId || '') + ' ' +
        (item.textContent || '')
      ).toLocaleLowerCase().includes(query);
    }
    const visible = items.filter(item => !item.hidden);
    const key = sort?.value || 'recent';
    const sign = direction?.dataset.ppDirection === 'asc' ? 1 : -1;
    if (direction) {
      const selected = sort?.selectedOptions?.[0];
      const label = selected?.getAttribute('aria-label') || selected?.textContent || 'Practice history';
      const order = sign === 1 ? 'ascending' : 'descending';
      direction.textContent = sign === 1 ? '\u2191' : '\u2193';
      direction.setAttribute('aria-label', label + ', ' + order + '. Switch to ' + (sign === 1 ? 'descending' : 'ascending'));
      direction.title = direction.getAttribute('aria-label');
    }
    const attribute = { active: 'activeMs', attempts: 'attempts', finishes: 'finishes', 'longest-hunt': 'longestHuntMs', improvement: 'improvementMs', 'observed-gain':'observedGainMs','driven-gain':'drivenGainMs', recent: 'lastPlayed' }[key] || 'lastPlayed';
    section.dataset.ppSortKey = key;
    visible.sort((a, b) => {
      const names = (a.dataset.trackName || '').localeCompare(b.dataset.trackName || '');
      if(key==='recent'&&Boolean(num(a.dataset[attribute]))!==Boolean(num(b.dataset[attribute])))return num(a.dataset[attribute])?-1:1;
      const comparison = key === 'name' ? names : num(a.dataset[attribute]) - num(b.dataset[attribute]);
      return sign * comparison || names || (a.dataset.ppTrackId || '').localeCompare(b.dataset.ppTrackId || '');
    });
    for (const item of visible) list.append(item);
    if (countLabel) countLabel.textContent = visible.length + ' of ' + items.length + ' tracks';
    if (empty) empty.hidden = visible.length !== 0;
  };

  const onView = event => {
    const toggle=event.target.closest?.('[data-pp-official],[data-pp-finished]');
    if(toggle){toggle.setAttribute('aria-pressed',String(toggle.getAttribute('aria-pressed')!=='true'));filter();return;}
    const button = event.target.closest?.('[data-pp-view]');
    if (!button) return;
    section.classList.toggle('pp-view-list', button.dataset.ppView === 'list');
    section.classList.toggle('pp-view-grid', button.dataset.ppView === 'grid');
    root.querySelectorAll('[data-pp-view]').forEach(item =>
      item.setAttribute('aria-pressed', String(item === button))
    );
  };

  const onDirection = () => {
    const next = direction.dataset.ppDirection === 'asc' ? 'desc' : 'asc';
    direction.dataset.ppDirection = next;
    direction.textContent = next === 'asc' ? '\u2191' : '\u2193';
    direction.setAttribute('aria-label', 'Sort ' + (next === 'asc' ? 'ascending' : 'descending'));
    direction.title = direction.getAttribute('aria-label');
    filter();
  };

  search?.addEventListener('input', filter);
  sort?.addEventListener('change', filter);
  direction?.addEventListener('click', onDirection);
  root.addEventListener('click', onView);
  filter();
  return () => {
    search?.removeEventListener('input', filter);
    sort?.removeEventListener('change', filter);
    direction?.removeEventListener('click', onDirection);
    root.removeEventListener('click', onView);
  };
}


// Keep only this profile's local view state; never persist it across racer identities.
export function capturePracticeProfileView(root) {
  if (!root) return null;
  const active = root.ownerDocument?.activeElement;
  const controls = ['[data-pp-search]', '[data-pp-sort]', '[data-pp-direction]', '[data-pp-view="grid"]', '[data-pp-view="list"]', '[data-pp-official]', '[data-pp-finished]', '.pp-heading', '.pp-coverage-details > summary', '.pp-session-details > summary', '.pp-finishes > summary', '.pp-manage > summary'];
  const focus = controls.find(selector => root.querySelector(selector) === active) || null;
  const track = active?.closest?.('.pp-track');
  const trackFocus = track && root.contains(active) ? {id: track.dataset.ppTrackId, selector: active.matches('.pp-art') ? '.pp-art' : active.matches('.pp-track-name-button') ? '.pp-track-name-button' : active.matches('.pp-card-details > summary') ? '.pp-card-details > summary' : null} : null;
  const detailFocus=active?.closest?.('[data-pp-details-key]');
  const disclosures = ['.pp-coverage-details', '.pp-session-details', '.pp-finishes', '.pp-manage'];
  return {open: root.open, official:root.querySelector('[data-pp-official]')?.getAttribute('aria-pressed')==='true',finished:root.querySelector('[data-pp-finished]')?.getAttribute('aria-pressed')==='true', search: root.querySelector('[data-pp-search]')?.value || '',
    sort: root.querySelector('[data-pp-sort]')?.value || 'recent',
    direction: root.querySelector('[data-pp-direction]')?.dataset.ppDirection || 'desc',
    list: root.querySelector('[data-pp-view="list"]')?.getAttribute('aria-pressed') === 'true', focus, trackFocus, detailFocus:detailFocus&&active===detailFocus.querySelector(':scope > summary')?detailFocus.dataset.ppDetailsKey:null,
    selection: focus === '[data-pp-search]' ? [active.selectionStart, active.selectionEnd] : null,
    openDisclosures: disclosures.filter(selector => root.querySelector(selector)?.open),
    openTracks: [...root.querySelectorAll('[data-pp-details-key]')].filter(node => node.open).map(node => node.dataset.ppDetailsKey)
  };
}

export function restorePracticeProfileView(root, state) {
  if (!root || !state) return;
  root.open = state.open;
  const search = root.querySelector('[data-pp-search]'), sort = root.querySelector('[data-pp-sort]');
  if (search) search.value = state.search;
  for(const key of ['official','finished'])root.querySelector('[data-pp-'+key+']')?.setAttribute('aria-pressed',String(state[key]===true));
  if (sort && [...sort.options].some(option => option.value === state.sort)) sort.value = state.sort;
  const direction = root.querySelector('[data-pp-direction]');
  if (direction) direction.dataset.ppDirection = state.direction === 'asc' ? 'asc' : 'desc';
  const Event = root.ownerDocument.defaultView.Event;
  (sort || search)?.dispatchEvent(new Event(sort ? 'change' : 'input', {bubbles: true}));
  if (state.list) root.querySelector('[data-pp-view="list"]')?.click();
  for (const selector of state.openDisclosures || []) {
    const node = root.querySelector(selector); if (node) node.open = true;
  }
  for (const node of root.querySelectorAll('[data-pp-details-key]')) node.open = (state.openTracks || []).includes(node.dataset.ppDetailsKey);
  if(state.detailFocus){const node=[...root.querySelectorAll('[data-pp-details-key]')].find(e=>e.dataset.ppDetailsKey===state.detailFocus);node?.querySelector(':scope > summary')?.focus({preventScroll:true});}
  if (state.focus || state.trackFocus?.selector) {
    const track = state.trackFocus ? [...root.querySelectorAll('.pp-track')].find(node => node.dataset.ppTrackId === state.trackFocus.id) : null;
    const field = state.focus ? root.querySelector(state.focus) : track?.querySelector(state.trackFocus.selector); field?.focus({preventScroll: true});
    if (state.selection && field?.setSelectionRange) field.setSelectionRange(...state.selection);
  }
}
