const STORAGE_KEY = 'polytrack-advanced-filter-loadouts-v1';
const BACKUP_KEY = 'polytrack-advanced-filter-backup-v1';
const MAX_LIST = 128;
const MAX_TRACK_RULES = 8;
const MAX_TRACK_WEIGHTS = 64;
const MAX_TRACK_TIME_MS = 36000000;
const MAX_TRACK_TIME_SECONDS = MAX_TRACK_TIME_MS / 1000;
const COUNTRY_LABELS = typeof Intl !== 'undefined' && Intl.DisplayNames
  ? new Intl.DisplayNames(['en'], { type: 'region' })
  : null;

const DEFAULT_FILTER = Object.freeze({
  enabled: true,
  mode: 'normal',
  scope: 'all',
  grading: 'global',
  missing: 'include',
  hideUncustomized: false,
  showNotice: true,
  whitelist: [],
  blacklist: [],
  forcedIncludes: [],
  countryCodes: [],
  badges: [],
  color: '',
  colorLevel: 'dropdown',
  trackWeights: [],
  groupCodes: [],
  rpMin: null,
  rpMax: null,
  playtimeHoursMin: null,
  playtimeHoursMax: null,
  tracksMin: null,
  tracksMax: null,
  winsMin: null,
  winsMax: null,
  daysActiveMin: null,
  daysActiveMax: null,
  joinedAfter: null,
  joinedBefore: null,
  trackRules: []
});

const RANGE_FIELDS = Object.freeze([
  ['rpMin', 'rpMax', 1e9, false],
  ['playtimeHoursMin', 'playtimeHoursMax', 1e7, false],
  ['tracksMin', 'tracksMax', 1e7, true],
  ['winsMin', 'winsMax', 1e7, true],
  ['daysActiveMin', 'daysActiveMax', 1e7, true]
]);

function safeCall(fn, fallback) {
  try { return typeof fn === 'function' ? fn() : fallback; } catch { return fallback; }
}

function cleanString(value, max = 128) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function localImageSource(value) {
  const source = cleanString(value, 2048);
  if (/^data:image\/(?:png|jpeg|webp|gif|svg\+xml);/i.test(source) || /^blob:/i.test(source)) return source;
  if (!source || /^(?:[a-z]+:|\/\/)/i.test(source) || /[\u0000-\u001f]/.test(source)) return '';
  return source;
}

function bounded(value, max, integer = false) {
  if (value === '' || value == null) return null;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number < 0 || number > max || (integer && !Number.isSafeInteger(number))) return null;
  return number;
}

function uniqueStrings(value, pattern, limit = MAX_LIST) {
  const input = Array.isArray(value) ? value : [];
  const result = [];
  const seen = new Set();
  for (const item of input) {
    const text = cleanString(item);
    if (!text || !pattern.test(text) || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= limit) break;
  }
  return result;
}

function normalizeFilter(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const value = { ...DEFAULT_FILTER };
  value.enabled = source.enabled !== false;
  value.createdAt = bounded(source.createdAt, 8640000000000000, true);
  value.loadedAt = bounded(source.loadedAt, 8640000000000000, true);
  value.mode = source.mode === 'smart' ? 'smart' : 'normal';
  value.scope = source.scope === 'overall' ? 'overall' : 'all';
  value.grading = source.grading === 'group' ? 'group' : 'global';
  value.missing = source.missing === 'exclude' ? 'exclude' : 'include';
  value.hideUncustomized = source.hideUncustomized === true;
  value.showNotice = source.showNotice !== false;
  value.whitelist = uniqueStrings(source.whitelist, /^[A-Za-z0-9_.:-]{1,128}$/);
  value.blacklist = uniqueStrings(source.blacklist, /^[A-Za-z0-9_.:-]{1,128}$/);
  value.forcedIncludes = uniqueStrings(source.forcedIncludes, /^[A-Za-z0-9_.:-]{1,128}$/);
  value.countryCodes = uniqueStrings((Array.isArray(source.countryCodes) ? source.countryCodes : []).map(code => String(code).toUpperCase()), /^[A-Z]{2}$/);
  value.badges = uniqueStrings(source.badges, /^[A-Za-z0-9_.:-]{1,128}$/);
  value.color = /^#[0-9A-F]{6}$/i.test(source.color) ? source.color.toUpperCase() : '';
  value.colorLevel = ['dropdown', 'menu', 'everywhere'].includes(source.colorLevel) ? source.colorLevel : 'dropdown';
  const weightEntries = Array.isArray(source.trackWeights) ? source.trackWeights
    : source.trackWeights && typeof source.trackWeights === 'object' ? Object.entries(source.trackWeights).map(([trackId, weight]) => ({ trackId, weight })) : [];
  const seenTrackWeights = new Set();
  value.trackWeights = weightEntries.slice(0, MAX_TRACK_WEIGHTS).map(entry => ({ trackId: cleanString(entry?.trackId), weight: bounded(entry?.weight, 1000) }))
    .filter(entry => entry.trackId && entry.weight !== null && !seenTrackWeights.has(entry.trackId) && seenTrackWeights.add(entry.trackId));
  value.groupCodes = uniqueStrings(source.groupCodes, /^\d{6}$/);
  for (const [min, max, cap, integer] of RANGE_FIELDS) {
    value[min] = bounded(source[min], cap, integer);
    value[max] = bounded(source[max], cap, integer);
  }
  value.joinedAfter = bounded(source.joinedAfter, 8640000000000000, true);
  value.joinedBefore = bounded(source.joinedBefore, 8640000000000000, true);
  const tracks = Array.isArray(source.trackRules) ? source.trackRules : [];
  value.trackRules = tracks.slice(0, MAX_TRACK_RULES).map(rule => ({
    trackId: cleanString(rule?.trackId),
    state: ['completed', 'missing', 'any'].includes(rule?.state) ? rule.state : 'any',
    minTimeMs: bounded(rule?.minTimeMs, MAX_TRACK_TIME_MS),
    maxTimeMs: bounded(rule?.maxTimeMs, MAX_TRACK_TIME_MS)
  })).filter(rule => rule.trackId);
  return value;
}

function validateFilter(filter) {
  const errors = [];
  for (const [min, max] of RANGE_FIELDS) {
    if (filter[min] !== null && filter[max] !== null && filter[min] > filter[max]) {
      errors.push(`${min.replace('Min', '')}: minimum must not exceed maximum.`);
    }
  }
  if (filter.joinedAfter !== null && filter.joinedBefore !== null && filter.joinedAfter > filter.joinedBefore) {
    errors.push('Joined date: start must not be after end.');
  }
  for (const [index, rule] of filter.trackRules.entries()) {
    if (rule.minTimeMs !== null && rule.maxTimeMs !== null && rule.minTimeMs > rule.maxTimeMs) {
      errors.push(`Track rule ${index + 1}: minimum time must not exceed maximum.`);
    }
  }
  return errors;
}

function asRows(value) {
  return Array.isArray(value) ? value.filter(row => row && typeof row === 'object') : [];
}

function rowId(row) {
  for (const key of ['accountId', 'userId', 'publicId']) {
    const id = cleanString(row?.[key]);
    if (id && /^[A-Za-z0-9_.:-]{1,128}$/.test(id)) return id;
  }
  return '';
}

function rowName(row) { return cleanString(row?.nickname || row?.displayName || row?.name || row?.username, 80); }
function normName(value) { return cleanString(value, 80).normalize('NFKC').toLocaleLowerCase(); }
function initials(value) {
  const parts = cleanString(value, 80).split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts.length > 1 ? `${parts[0][0]}${parts.at(-1)[0]}` : parts[0].slice(0, 2)).toLocaleUpperCase();
}

function dateInputValue(epoch) {
  if (!Number.isSafeInteger(epoch)) return '';
  const date = new Date(epoch);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

function epochFromDate(value, endOfDay = false) {
  if (!value) return null;
  const epoch = Date.parse(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
  return Number.isSafeInteger(epoch) ? epoch : null;
}

function loadLocal(storage) {
  let stored = null;
  try {
    stored = JSON.parse(storage?.getItem(STORAGE_KEY) || 'null');
  } catch {
    stored = null;
  }
  const paused = stored?.paused === true;
  const presets = [];
  const names = new Set();
  const addPreset = item => {
    const name = cleanString(item?.name, 32);
    const key = name.toLocaleLowerCase();
    if (!name || names.has(key) || !item?.filter || typeof item.filter !== 'object') return;
    names.add(key);
    presets.push({ name, filter: normalizeFilter(item.filter), favorite: item.favorite === true, usageCount: bounded(item.usageCount, 1e9, true) || 0,lastUsedAt:bounded(item.lastUsedAt,8640000000000000,true)||0 });
  };
  const currentEntries = Array.isArray(stored?.presets) ? stored.presets : [];
  for (const item of currentEntries) {
    addPreset(item);
    if (presets.length === 30) break;
  }
  if (!presets.length) {
    try {
      const legacyValue = JSON.parse(storage?.getItem('polytrack-0.6.2-ranked-filter-presets-v1') || 'null');
      const legacyEntries = Array.isArray(legacyValue) ? legacyValue : Array.isArray(legacyValue?.presets) ? legacyValue.presets : [];
      for (const item of legacyEntries) {
        const oldFilter = item?.filter;
        if (!oldFilter || typeof oldFilter !== 'object') continue;
        addPreset({
          name: item.name,
          filter: {
            ...oldFilter,
            mode: 'normal', scope: 'all', grading: 'global', missing: 'include',
            countryCodes: [], badges: [], groupCodes: [], trackRules: []
          }
        });
        if (presets.length === 30) break;
      }
      if (presets.length) saveLocal(storage, { paused, presets });
    } catch {}
  }
  return { paused, presets, sort: ['recent','name','used'].includes(stored?.sort)?stored.sort:'used' };
}

function saveLocal(storage, data) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify({ version: 2, paused: data.paused, sort: ['name','used'].includes(data.sort)?data.sort:'recent', presets: data.presets }));
    return true;
  } catch {
    return false;
  }
}

function commitLocal(storage, local, candidate) {
  if (!saveLocal(storage, candidate)) return false;
  local.paused = candidate.paused;
  local.sort = candidate.sort;
  local.presets = candidate.presets;
  return true;
}

/** Mounts a local-only, full-screen advanced filter editor. */
export function mountFilterMenu({
  document = globalThis.document,
  root = document?.body,
  storage = globalThis.localStorage,
  getRows = () => [],
  getTracks = () => [],
  getFilter = () => DEFAULT_FILTER,
  onApply = () => undefined,
  onToggle = () => undefined,
  getGroupCode = () => '',
  onGroupCodeSave = async () => undefined,
  renderRacer = () => '',
  onRenderRacers = () => undefined,
  getRuleCounts = () => null,
  showNotice = true,
  exportCode = filter => JSON.stringify(filter),
  importCode = code => JSON.parse(code)
} = {}) {
  if (!document?.createElement || !root?.append) throw new TypeError('A document and mount root are required.');

  const local = loadLocal(storage);
  local.sort = local.sort === 'name' ? 'name' : 'recent';
  let noticeVisible = showNotice === true;
  let ruleNoticeTimer = null;
  let filter = normalizeFilter(safeCall(getFilter, DEFAULT_FILTER));
  let rows = asRows(safeCall(getRows, []));
  const initialTracks = safeCall(getTracks, []);
  let tracks = Array.isArray(initialTracks) ? initialTracks.filter(track => track && track.id != null) : [];
  let activeSection = 'group';
  let busy = false;
  let destroyed = false;
  let priorFocus = null;
  let selectedUsers = { whitelist: [], blacklist: [] };
  let activeUserSearch = null;
  let generatedCode = '';
  const invalidTrackTimeInputs = new WeakSet();

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (label, cls = 'fm-button', type = 'button') => {
    const node = el('button', cls, label);
    node.type = type;
    return node;
  };
  const labelFor = (label, control) => {
    const labelNode = el('label', 'fm-field');
    labelNode.append(el('span', 'fm-label', label), control);
    return labelNode;
  };
  const setStatus = (message, error = false) => {
    status.textContent = message;
    status.dataset.kind = error ? 'error' : 'info';
  };

  const overlay = el('div', 'pt-group-filter-menu');
  overlay.hidden = true;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'pt-filter-title');
  const shell = el('div', 'fm-shell');
  const header = el('header', 'fm-header');
  const titleWrap = el('div', 'fm-heading');
  titleWrap.append(el('p', 'fm-kicker', 'POLYTRACK / RANKED'), el('h1', '', 'Advanced filters'));
  titleWrap.lastChild.id = 'pt-filter-title';
  const headerActions = el('div', 'fm-header-actions');
  const pauseButton = button('Pause filters', 'fm-button fm-button-pause');
  pauseButton.setAttribute('aria-pressed', String(local.paused || !filter.enabled));
  const closeButton = button('Close', 'fm-button fm-button-quiet');
  closeButton.setAttribute('aria-label', 'Close advanced filters');
  headerActions.append(pauseButton, closeButton);
  header.append(titleWrap, headerActions);
  const body = el('div', 'fm-body');
  const nav = el('nav', 'fm-nav');
  nav.setAttribute('aria-label', 'Filter menu sections');
  const content = el('main', 'fm-content');
  const status = el('div', 'fm-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const footer = el('footer', 'fm-footer');
  const clearButton = button('Quick reset', 'fm-button fm-button-quiet');
  const applyButton = button('Apply filters', 'fm-button fm-button-primary');
  footer.append(clearButton, applyButton);
  shell.append(header, body, status, footer);
  body.append(nav, content);
  overlay.append(shell);
  root.append(overlay);

  const sections = [
    ['group', 'Player group'],
    ['rules', 'Rules'],
    ['scoring', 'Display and scoring'],
    ['share', 'Share and loadouts']
  ];
  const navButtons = new Map();
  for (const [key, label] of sections) {
    const item = button(label, 'fm-nav-button');
    item.dataset.section = key;
    item.setAttribute('aria-current', key === activeSection ? 'page' : 'false');
    item.addEventListener('click', () => showSection(key));
    nav.append(item);
    navButtons.set(key, item);
  }

  const sectionsContent = new Map();
  for (const [key, label] of sections) {
    const panel = el('section', 'fm-section');
    panel.dataset.section = key;
    panel.setAttribute('aria-label', label);
    panel.hidden = key !== activeSection;
    sectionsContent.set(key, panel);
    content.append(panel);
  }
  function showSection(key) {
    if (!sectionsContent.has(key)) return;
    activeSection = key;
    for (const [name, panel] of sectionsContent) {
      panel.hidden = name !== key;
      navButtons.get(name).setAttribute('aria-current', name === key ? 'page' : 'false');
    }
    sectionsContent.get(key).querySelector('input,select,button,textarea')?.focus({ preventScroll: true });
  }
  function heading(panel, title, description) {
    panel.append(el('h2', '', title));
    if (description) panel.append(el('p', 'fm-intro', description));
  }
  function card(panel, title, description) {
    const node = el('section', 'fm-card');
    node.append(el('h3', '', title));
    if (description) node.append(el('p', 'fm-help', description));
    panel.append(node);
    return node;
  }

  const playerPanel = sectionsContent.get('group');
  heading(playerPanel, 'Player group', 'Choose who is included and define a public group tag. All matching happens against data already loaded by PolyTrack.');
  const ruleNotice = el('p', 'fm-rule-notice');
  ruleNotice.hidden = !noticeVisible;
  playerPanel.append(ruleNotice);
  const groupCard = document.createElement('details');
  groupCard.className = 'fm-card fm-collapsible';
  const groupSummary = el('summary', 'fm-card-summary');
  groupSummary.append(el('span', 'fm-card-title', 'Optional public group tag'), el('span', 'fm-card-subtitle', 'Add or filter by shared six-digit tags'));
  groupCard.append(groupSummary, el('p', 'fm-help', 'Saving updates the profile once. Typing does not save automatically.'));
  playerPanel.append(groupCard);
  const groupCodeInput = document.createElement('input');
  groupCodeInput.type = 'text'; groupCodeInput.inputMode = 'numeric'; groupCodeInput.maxLength = 6;
  groupCodeInput.autocomplete = 'off'; groupCodeInput.placeholder = '123456'; groupCodeInput.setAttribute('aria-label', 'Public shared group tag');
  groupCodeInput.value = cleanString(safeCall(getGroupCode, ''), 6);
  const groupRow = el('div', 'fm-inline');
  const groupSaveButton = button('Save group tag');
  groupRow.append(labelFor('Your public shared group tag', groupCodeInput), groupSaveButton);
  groupCard.append(groupRow);
  const codeList = makeTokenPicker(groupCard, 'Group tags to include', 'groupCodes', 'Enter a six-digit code');

  const playerPickCard = card(playerPanel, 'Racers', 'Include and exclude loaded profiles by username. Account IDs are accepted only when typed into search.');
  const whitelistPicker = makeUserPicker(playerPickCard, 'Include racers', 'whitelist');
  const blacklistPicker = makeUserPicker(playerPickCard, 'Exclude racers', 'blacklist');

  const facetCard = card(playerPanel, 'Profile details', 'Country and badge choices come from profiles currently loaded in the leaderboard.');
  const countryPicker = makeCheckPicker(facetCard, 'Countries', () => {
    const values = new Map();
    for (const row of rows) {
      const code = cleanString(row.countryCode, 2).toUpperCase();
      if (/^[A-Z]{2}$/.test(code)) values.set(code, COUNTRY_LABELS?.of(code) || code);
    }
    return [...values].sort((a, b) => a[1].localeCompare(b[1]));
  }, 'countryCodes');
  const badgePicker = makeCheckPicker(facetCard, 'Badges', () => {
    const values = new Map();
    for (const row of rows) {
      const rawBadges = row.badges;
      const badges = Array.isArray(rawBadges) ? rawBadges
        : rawBadges && typeof rawBadges === 'object' ? Object.keys(rawBadges).filter(key => rawBadges[key])
          : rawBadges ? [rawBadges] : [];
      if (row.badge) badges.push(row.badge);
      if (row.profileCosmetics?.badge) badges.push(row.profileCosmetics.badge);
      for (const badge of badges) {
        const id = typeof badge === 'string' ? badge : badge?.id || badge?.badgeId || badge?.badge || badge?.code || badge?.name;
        const value = cleanString(id);
        if (value && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)) {
          const label = typeof badge === 'object' ? cleanString(badge.displayName || badge.label || badge.title || badge.name, 80) : '';
          values.set(value, label || value);
        }
      }
    }
    return [...values].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => [value, label]);
  }, 'badges');
  const hideUncustomized = document.createElement('input'); hideUncustomized.type = 'checkbox';
  hideUncustomized.setAttribute('aria-label', 'Hide uncustomized profiles');
  const hideUncustomizedRow = el('label', 'fm-toggle-row'); hideUncustomizedRow.append(hideUncustomized, el('span', '', 'Hide uncustomized profiles'));
  facetCard.append(hideUncustomizedRow);
  facetCard.append(el('p', 'fm-help', 'Only badges present in saved profiles are listed. Selected countries are alternatives, and selected badges are alternatives. Country and badge criteria must both match; include/exclude racers and group tags further narrow the result.'));
  playerPanel.append(groupCard);

  const rulesPanel = sectionsContent.get('rules');
  heading(rulesPanel, 'Rules', 'Set profile ranges and up to eight track-specific conditions. Empty bounds do not constrain results.');
  const rangeCard = card(rulesPanel, 'Profile ranges', 'Values are filters only. Published RP is lower-is-better: a smaller RP value means a better leaderboard placement. These rules never change actual RP.');
  const rangeGrid = el('div', 'fm-range-grid');
  const rangeControls = {};
  const rangeSpecs = [
    ['rpMin', 'rpMax', 'Published RP', 'number', '0.1'],
    ['playtimeHoursMin', 'playtimeHoursMax', 'Playtime (hours)', 'number', '0.25'],
    ['tracksMin', 'tracksMax', 'Tracks completed', 'number', '1'],
    ['winsMin', 'winsMax', 'Wins', 'number', '1'],
    ['daysActiveMin', 'daysActiveMax', 'Days active', 'number', '1']
  ];
  for (const [minKey, maxKey, label, type, step] of rangeSpecs) {
    const fieldset = el('fieldset', 'fm-range');
    fieldset.append(el('legend', '', label));
    const pair = el('div', 'fm-range-pair');
    const min = makeNumber(minKey, step, 'Min');
    const max = makeNumber(maxKey, step, 'Max');
    pair.append(labelFor('Minimum', min), labelFor('Maximum', max));
    fieldset.append(pair); rangeGrid.append(fieldset);
    rangeControls[minKey] = min; rangeControls[maxKey] = max;
  }
  rangeCard.append(rangeGrid);
  const datesCard = card(rulesPanel, 'Joined date', 'Dates are interpreted in UTC.');
  const datePair = el('div', 'fm-range-pair');
  const joinedAfter = document.createElement('input'); joinedAfter.type = 'date'; joinedAfter.setAttribute('aria-label', 'Joined after');
  const joinedBefore = document.createElement('input'); joinedBefore.type = 'date'; joinedBefore.setAttribute('aria-label', 'Joined before');
  datePair.append(labelFor('After', joinedAfter), labelFor('Before', joinedBefore)); datesCard.append(datePair);
  const trackCard = card(rulesPanel, 'Track rules', 'Completion state and optional record-time bounds. Enter seconds from 0 to 36,000; values are stored in milliseconds.');
  const noticeToggle = document.createElement('input'); noticeToggle.type = 'checkbox'; noticeToggle.checked = noticeVisible;
  noticeToggle.setAttribute('aria-label', 'Show rule count notices');
  const noticeToggleRow = el('label', 'fm-notice-toggle'); noticeToggleRow.append(noticeToggle, el('span', '', 'Show rule count notices'));
  trackCard.append(noticeToggleRow);
  noticeToggle.addEventListener('change', () => { noticeVisible = noticeToggle.checked; updateRuleNotice(); });
  const trackRuleList = el('div', 'fm-track-rules');
  const addTrackButton = button('Add track rule', 'fm-button fm-button-secondary');
  trackCard.append(trackRuleList, addTrackButton);
  const trackWeightsCard = card(rulesPanel, 'Track weight overrides', 'Optional per-track overrides. Leave a field empty to keep the supplied default weight.');
  const trackWeightsList = el('div', 'fm-track-weights');
  const trackWeightSelect = document.createElement('select'); trackWeightSelect.setAttribute('aria-label', 'Track to override');
  const addTrackWeightButton = button('Add override', 'fm-button fm-button-secondary');
  const trackWeightAddRow = el('div', 'fm-inline');
  trackWeightAddRow.append(labelFor('Choose track', trackWeightSelect), addTrackWeightButton);
  trackWeightsCard.append(trackWeightAddRow, trackWeightsList);

  const scoringPanel = sectionsContent.get('scoring');
  heading(scoringPanel, 'Display and scoring', 'These choices control which racers are shown and how their scores are evaluated.');
  const displayCard = card(scoringPanel, 'Score mode', 'Normal mode hides racers outside your chosen group and keeps each published score. Smart mode recalculates personal group scores using only the selected group.');
  const modeSelect = makeSelect([['normal', 'Normal: published scores'], ['smart', 'Smart: personal group scores']], 'Score mode');
  displayCard.append(labelFor('Mode', modeSelect));
  const scopeSelect = makeSelect([['all', 'All rankings'], ['overall', 'Overall only']], 'Ranking scope');
  displayCard.append(labelFor('Scope', scopeSelect));
  const gradeSelect = makeSelect([['global', 'Grade against global field'], ['group', 'Grade against selected group']], 'Grading basis');
  displayCard.append(labelFor('Grading', gradeSelect));
  const missingSelect = makeSelect([['include', 'Include racers with missing data'], ['exclude', 'Exclude racers with missing data']], 'Missing data handling');
  displayCard.append(labelFor('Missing data', missingSelect));
  const showLeaderboardNotice = document.createElement('input'); showLeaderboardNotice.type = 'checkbox';
  showLeaderboardNotice.setAttribute('aria-label', 'Show filter notice on leaderboard');
  const showLeaderboardNoticeRow = el('label', 'fm-toggle-row'); showLeaderboardNoticeRow.append(showLeaderboardNotice, el('span', '', 'Show filter notice on leaderboard'));
  displayCard.append(showLeaderboardNoticeRow);
  const colorSelect = makeSelect([['', 'Default'], ['#FFFFFF', 'White'], ['#FF5C5C', 'Red'], ['#FFB347', 'Orange'], ['#FFE45E', 'Yellow'], ['#55D98A', 'Green'], ['#55C7FF', 'Blue'], ['#C58BFF', 'Violet']], 'Filter accent color');
  colorSelect.classList.add('fm-color-select');
  const colorSwatch = el('span', 'fm-color-swatch');
  const colorControl = el('div', 'fm-color-control'); colorControl.append(colorSelect, colorSwatch);
  const colorLevelSelect = makeSelect([['dropdown', 'Dropdown only'], ['menu', 'Menu only'], ['everywhere', 'Everywhere']], 'Color display scope');
  displayCard.append(labelFor('Accent color', colorControl), labelFor('Apply color to', colorLevelSelect));
  const applyColorPresentation = () => {
    const color = colorSelect.value;
    colorSwatch.style.backgroundColor = color || 'transparent';
    colorSelect.style.borderColor = color || '';
    for (const option of colorSelect.options) if (option.value) option.style.color = option.value;
    overlay.style.setProperty('--fm-green', color && colorLevelSelect.value !== 'dropdown' ? color : '#54f09a');
  };
  colorSelect.addEventListener('change', applyColorPresentation);
  colorLevelSelect.addEventListener('change', applyColorPresentation);
  displayCard.append(el('p', 'fm-callout', 'Normal mode hides racers outside the selected group and keeps published scores. Smart mode recalculates personal group scores; group scores sort locally. With Global grading, displayed positions remain global. Group ERP is provisional and can be unknown when loaded profiles or results are incomplete. Smart mode never edits or awards RP.'));
  const warning = el('p', 'fm-warning');
  warning.hidden = true;
  warning.textContent = 'Some requested rules cannot be evaluated with the currently loaded data. Those rules may not affect this result.';
  displayCard.append(warning);

  const sharePanel = sectionsContent.get('share');
  heading(sharePanel, 'Share and loadouts', 'Share a filter code with another player or save named presets locally on this device.');
  const shareCard = card(sharePanel, 'Shared filter code', 'Codes are passed to the supplied import/export functions. Nothing is sent over the network.');
  const shareArea = document.createElement('textarea'); shareArea.rows = 4; shareArea.spellcheck = false;
  shareArea.setAttribute('aria-label', 'Shared filter code'); shareArea.placeholder = 'Export a code or paste one here to import.';
  const shareActions = el('div', 'fm-actions');
  const exportCodeButton = button('Create share code', 'fm-button fm-button-secondary');
  const copyCodeButton = button('Copy code', 'fm-button fm-button-quiet');
  const downloadCodeButton = button('Download code', 'fm-button fm-button-quiet');
  const importCodeButton = button('Import code', 'fm-button fm-button-secondary');
  const restoreBackupButton = button('Restore previous filter', 'fm-button fm-button-quiet');
  shareActions.append(exportCodeButton, copyCodeButton, downloadCodeButton, importCodeButton, restoreBackupButton);
  shareCard.append(labelFor('Code', shareArea), shareActions);

  const loadoutCard = card(sharePanel, 'Local loadouts', 'Save up to 30 sets on this device. Star your preferred set for quick racer actions.');
  const loadoutSelect = document.createElement('select'); loadoutSelect.setAttribute('aria-label', 'Saved loadouts');
  const loadoutSort = makeSelect([['recent', 'Recent / favorites first'], ['used', 'Most used'], ['name', 'Name A to Z']], 'Loadout sort order');
  loadoutSort.value = local.sort;
  const loadoutName = document.createElement('input'); loadoutName.type = 'text'; loadoutName.maxLength = 32; loadoutName.placeholder = 'Preset name'; loadoutName.setAttribute('aria-label', 'Loadout name');
  const loadoutRow = el('div', 'fm-inline'); loadoutRow.append(labelFor('Saved loadouts', loadoutSelect), labelFor('Preset name', loadoutName));
  const loadoutSortLabel = labelFor('Sort loadouts', loadoutSort);
  const loadoutActions = el('div', 'fm-actions');
  const loadButton = button('Load selected', 'fm-button fm-button-secondary');
  const saveButton = button('Save current', 'fm-button fm-button-secondary');
  const favoritePresetButton = button('☆ Favorite', 'fm-button fm-button-quiet');
  const deleteButton = button('Delete selected', 'fm-button fm-button-quiet');
  loadoutActions.append(loadButton, saveButton, favoritePresetButton, deleteButton);
  const importExportArea = document.createElement('textarea'); importExportArea.rows = 5;
  importExportArea.setAttribute('aria-label', 'Loadout import and export data');
  importExportArea.placeholder = 'Exported loadouts appear here. Paste exported data to import.';
  const loadoutTransfer = el('div', 'fm-actions');
  const exportLoadoutsButton = button('Export loadouts', 'fm-button fm-button-quiet');
  const importLoadoutsButton = button('Import loadouts', 'fm-button fm-button-quiet');
  loadoutTransfer.append(exportLoadoutsButton, importLoadoutsButton);
  loadoutCard.append(loadoutRow, loadoutSortLabel, loadoutActions, labelFor('Loadout data', importExportArea), loadoutTransfer);

  function makeSelect(options, ariaLabel) {
    const select = document.createElement('select'); select.setAttribute('aria-label', ariaLabel);
    for (const [value, label] of options) {
      const option = document.createElement('option'); option.value = value; option.textContent = label; select.append(option);
    }
    return select;
  }
  function makeNumber(name, step, placeholder) {
    const input = document.createElement('input'); input.type = 'number'; input.min = '0'; input.step = step;
    input.placeholder = placeholder; input.dataset.filterField = name; return input;
  }

  function makeTokenPicker(parent, title, field, placeholder) {
    const wrap = el('div', 'fm-picker');
    const input = document.createElement('input'); input.type = 'text'; input.maxLength = 6; input.inputMode = 'numeric';
    input.placeholder = placeholder; input.setAttribute('aria-label', title); input.autocomplete = 'off';
    const add = button('Add', 'fm-button fm-button-quiet');
    const chips = el('div', 'fm-chips'); chips.setAttribute('aria-label', `${title} selected`);
    wrap.append(labelFor(title, input), add, chips); parent.append(wrap);
    const addToken = () => {
      const value = input.value.trim();
      if (!/^\d{6}$/.test(value)) { setStatus('Group tags must contain exactly six digits.', true); return; }
      const values = new Set(filter[field]); values.add(value); filter[field] = [...values].slice(0, MAX_LIST); input.value = ''; renderTokenChips();
      scheduleRuleNotice(null, true);
    };
    add.addEventListener('click', addToken);
    input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addToken(); } });
    function renderTokenChips() {
      chips.replaceChildren();
      for (const value of filter[field]) {
        const chip = el('span', 'fm-chip'); chip.append(el('span', '', value));
        const remove = button('Remove', 'fm-chip-remove'); remove.setAttribute('aria-label', `Remove group tag ${value}`);
        remove.addEventListener('click', () => { filter[field] = filter[field].filter(item => item !== value); renderTokenChips(); scheduleRuleNotice(null, true); });
        chip.append(remove); chips.append(chip);
      }
    }
    return { render: renderTokenChips };
  }

  function makeCheckPicker(parent, title, getOptions, field) {
    const details = document.createElement('details'); details.className = 'fm-check-picker';
    const summary = el('summary', '', title);
    const search = document.createElement('input');
    search.type = 'search'; search.className = 'fm-check-search'; search.placeholder = `Search ${title.toLocaleLowerCase()}`;
    search.setAttribute('aria-label', `Search ${title.toLocaleLowerCase()}`); search.autocomplete = 'off';
    const list = el('div', 'fm-check-list'); list.setAttribute('role', 'group'); list.setAttribute('aria-label', title);
    details.append(summary, search, list); parent.append(details);
    function render() {
      list.replaceChildren();
      const options = getOptions().filter(([value, label]) => !search.value.trim() || `${value} ${label}`.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()));
      if (!options.length) { list.append(el('p', 'fm-empty', 'No values available in loaded profiles.')); return; }
      const selected = new Set(filter[field]);
      for (const [value, label] of options) {
        const row = el('label', 'fm-check-option');
        const input = document.createElement('input'); input.type = 'checkbox'; input.value = value; input.checked = selected.has(value);
        input.addEventListener('change', () => {
          const next = new Set(filter[field]);
          if (input.checked) next.add(value); else next.delete(value);
          filter[field] = [...next].slice(0, MAX_LIST);
        });
        if (field === 'countryCodes') {
          const flag = document.createElement('img'); flag.className = 'fm-country-flag'; flag.src = `images/countries/${String(value).toLowerCase()}.svg`; flag.alt = ''; flag.loading = 'lazy';
          flag.addEventListener('error', () => flag.remove(), { once: true }); row.append(input, flag, el('span', '', label));
        } else row.append(input, el('span', '', label));
        list.append(row);
      }
    }
    search.addEventListener('input', render);
    render();
    return { render, details };
  }

  function getIdSearch(value) {
    const search = value.trim();
    const prefixed = /^id\s*:\s*(.*)$/i.exec(search);
    if (prefixed) return { query: prefixed[1].trim().toLocaleLowerCase(), showId: true };
    if (/^[a-f\d]{32,}$/i.test(search)) return { query: search.toLocaleLowerCase(), showId: true };
    return { query: '', showId: false };
  }
  function userCandidates(search, omit) {
    const q = normName(search);
    const idSearch = getIdSearch(search);
    const seen = new Set();
    const candidates = [];
    const source = search.trim() ? rows : [...rows].sort((a, b) => {
      const rank = row => bounded(row.overallRank ?? row.rank, 1e9, true);
      const rp = row => bounded(row.overallRp ?? row.overallRP ?? row.overallScore ?? row.rp ?? row.score, 1e9);
      const ar = rank(a), br = rank(b);
      if (ar !== null || br !== null) return (ar ?? Infinity) - (br ?? Infinity);
      return (rp(a) ?? Infinity) - (rp(b) ?? Infinity);
    });
    for (const row of source) {
      const id = rowId(row); const name = rowName(row);
      if (!id || omit.has(id) || seen.has(id)) continue;
      const matched = !search.trim() || (q && (idSearch.query
        ? id.toLocaleLowerCase().includes(idSearch.query)
        : normName(name).includes(q)));
      if (!matched) continue;
      seen.add(id); candidates.push({ id, name: name || 'Unnamed racer', row });
      if (candidates.length >= 12) break;
    }
    return candidates;
  }
  function makeUserPicker(parent, title, field) {
    const container = el('div', 'fm-user-picker');
    const input = document.createElement('input'); input.type = 'search'; input.autocomplete = 'off'; input.maxLength = 80;
    input.placeholder = 'Type a username or account ID'; input.setAttribute('aria-label', title);
    const popup = el('div', 'fm-suggestions'); popup.hidden = true; popup.setAttribute('role', 'listbox');
    const suggestionStatus = el('span', 'fm-suggestion-status');
    suggestionStatus.setAttribute('role', 'status'); suggestionStatus.setAttribute('aria-live', 'polite'); suggestionStatus.setAttribute('aria-atomic', 'true');
    input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('aria-expanded', 'false');
    const chips = el('div', 'fm-chips'); chips.setAttribute('aria-label', `${title} selected`);
    container.append(labelFor(title, input), popup, suggestionStatus, chips); parent.append(container);
    const refreshSelected = () => {
      const ids = new Set(filter[field]);
      selectedUsers[field] = [...ids].map(id => {
        const row = rows.find(item => rowId(item) === id);
        return { id, name: row ? rowName(row) || 'Unnamed racer' : 'Racer no longer loaded' };
      });
      chips.replaceChildren();
      for (const entry of selectedUsers[field]) {
        const chip = el('span', 'fm-chip');
        const row=rows.find(item=>rowId(item)===entry.id),preview=row?safeCall(()=>renderRacer(row),''):'';
        if(preview){const car=el('span','fm-racer-native-preview');car.innerHTML=preview;chip.append(car);}
        else {const initialsBadge=el('span','fm-initials',initials(entry.name));initialsBadge.setAttribute('aria-hidden','true');chip.append(initialsBadge);}
        chip.append(el('span', '', entry.name));
        const remove = button('Remove', 'fm-chip-remove'); remove.setAttribute('aria-label', `Remove ${entry.name} from ${field === 'whitelist' ? 'include' : 'exclude'} list`);
        remove.addEventListener('click', () => { filter[field] = filter[field].filter(id => id !== entry.id); renderSuggestions(); refreshSelected(); scheduleRuleNotice(null, true); });
        chip.append(remove); chips.append(chip);
      }
      safeCall(() => onRenderRacers(chips), undefined);
    };
    function renderSuggestions() {
      popup.replaceChildren();
      if (activeUserSearch !== input || document.activeElement !== input) {
        popup.hidden = true; input.setAttribute('aria-expanded', 'false'); return;
      }
      const search = input.value.trim();
      const idSearch = getIdSearch(search);
      const exact = rows.find(row => rowId(row) && (idSearch.query
        ? rowId(row).toLocaleLowerCase() === idSearch.query
        : normName(rowName(row)) === normName(search)));
      const selected = new Set(filter[field]);
      if (exact && selected.has(rowId(exact))) {
        const already = el('div', 'fm-suggestion fm-suggestion-disabled', `${rowName(exact) || (idSearch.showId ? rowId(exact) : 'Racer')} · Already selected`);
        already.setAttribute('role', 'option'); already.setAttribute('aria-disabled', 'true'); popup.append(already);
      }
      const candidates = userCandidates(search, selected);
      for (const candidate of candidates) {
        const option = button('', 'fm-suggestion'); option.setAttribute('role', 'option');
        const person = el('span', 'fm-suggestion-person');
        const nativePreview = String(safeCall(() => renderRacer(candidate.row), '') || '');
        if (nativePreview) {
          const preview = el('span', 'fm-racer-native-preview'); preview.innerHTML = nativePreview; person.append(preview);
        } else {
          const preview = candidate.row.preview || candidate.row.image;
          const previewSrc = localImageSource(typeof preview === 'string' ? preview : preview?.src || preview?.url || preview?.dataUrl || '');
          if (previewSrc) {
            const image = document.createElement('img'); image.className = 'fm-racer-preview'; image.src = previewSrc; image.alt = ''; image.loading = 'lazy';
            image.addEventListener('error', () => image.remove(), { once: true }); person.append(image);
          } else person.append(el('span', 'fm-initials', initials(candidate.name)));
        }
        person.append(el('span', 'fm-suggestion-name', candidate.name));
        option.append(person);
        const rp = bounded(candidate.row.overallRp ?? candidate.row.overallRP ?? candidate.row.overallScore ?? candidate.row.rp ?? candidate.row.score, 1e9);
        const rank = bounded(candidate.row.overallRank ?? candidate.row.rank, 1e9, true);
        if (rank !== null || rp !== null) {
          const formattedRp = rp === null ? '' : `${Number(rp.toFixed(2)).toLocaleString(undefined, { maximumFractionDigits: 2 })} RP`;
          option.append(el('span', 'fm-suggestion-id', [rank !== null ? `#${rank}` : '', formattedRp].filter(Boolean).join(' · ')));
        }
        if (idSearch.showId) option.append(el('span', 'fm-suggestion-id', candidate.id));
        option.addEventListener('click', () => {
          filter[field] = [...new Set([...filter[field], candidate.id])].slice(0, MAX_LIST);
          suggestionStatus.textContent = `${candidate.name} selected.`;
          scheduleRuleNotice(null, true);
          input.value = ''; popup.hidden = true; input.setAttribute('aria-expanded', 'false'); refreshSelected(); input.focus();
        });
        popup.append(option);
      }
      popup.hidden = popup.childElementCount === 0;
      popup.dataset.mode = search ? 'search' : 'top';
      input.setAttribute('aria-expanded', String(!popup.hidden));
      suggestionStatus.textContent = popup.hidden ? 'No racers found.' : `${candidates.length} racer${candidates.length === 1 ? '' : 's'} found.`;
      if (!popup.hidden) safeCall(() => onRenderRacers(popup), undefined);
    }
    input.addEventListener('input', renderSuggestions);
    input.addEventListener('focus', () => {
      activeUserSearch = input;
      for (const other of overlay.querySelectorAll('.fm-user-picker')) {
        const otherInput = other.querySelector('input'); const otherPopup = other.querySelector('.fm-suggestions');
        if (otherInput !== input && otherPopup) { otherPopup.hidden = true; otherInput?.setAttribute('aria-expanded', 'false'); }
      }
      renderSuggestions();
      safeCall(()=>onRenderRacers(chips),undefined);
    });
    input.addEventListener('blur', () => setTimeout(() => {
      if (activeUserSearch === input && document.activeElement !== input && !popup.contains(document.activeElement)) {
        activeUserSearch = null; popup.hidden = true; input.setAttribute('aria-expanded', 'false');
      }
    }, 100));
    popup.addEventListener('pointerdown', event => { if (event.target.closest?.('button')) event.preventDefault(); });
    input.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !popup.hidden) { popup.hidden = true; input.setAttribute('aria-expanded', 'false'); }
      if (event.key === 'Enter' && !popup.hidden) {
        const first = [...popup.querySelectorAll('button')].find(item => !item.disabled);
        if (first) { event.preventDefault(); first.click(); }
      }
    });
    refreshSelected();
    return { refresh: refreshSelected, input };
  }

  function renderTrackRules() {
    trackRuleList.replaceChildren();
    addTrackButton.disabled = filter.trackRules.length >= MAX_TRACK_RULES || tracks.length === 0;
    if (!filter.trackRules.length) trackRuleList.append(el('p', 'fm-empty', 'No track rules added.'));
    for (const [index, rule] of filter.trackRules.entries()) {
      const row = el('div', 'fm-track-rule');
      const track = tracks.find(item => String(item.id) === String(rule.trackId));
      const select = document.createElement('select'); select.setAttribute('aria-label', `Track for rule ${index + 1}`);
      const empty = document.createElement('option'); empty.value = ''; empty.textContent = 'Choose track'; select.append(empty);
      for (const track of tracks) {
        const option = document.createElement('option'); option.value = String(track.id); option.textContent = cleanString(track.name || track.id); select.append(option);
      }
      select.value = rule.trackId;
      select.addEventListener('change', () => { rule.trackId = select.value; renderTrackRules(); trackRuleList.querySelector('select')?.focus(); });
      const state = makeSelect([['any', 'Any completion'], ['completed', 'Completed'], ['missing', 'Not completed']], `Completion for rule ${index + 1}`);
      state.value = rule.state; state.addEventListener('change', () => { rule.state = state.value; });
      const min = document.createElement('input'); min.type = 'number'; min.min = '0'; min.max = String(MAX_TRACK_TIME_SECONDS); min.step = '0.01'; min.placeholder = 'Min seconds'; min.value = rule.minTimeMs == null ? '' : String(rule.minTimeMs / 1000);
      min.setAttribute('aria-label', `Minimum seconds for rule ${index + 1}`);
      min.addEventListener('input', () => {
        if (min.validity.badInput) invalidTrackTimeInputs.add(min); else invalidTrackTimeInputs.delete(min);
        const seconds = min.value === '' ? null : bounded(Number(min.value), MAX_TRACK_TIME_SECONDS);
        rule.minTimeMs = seconds === null ? null : seconds * 1000;
      });
      const max = document.createElement('input'); max.type = 'number'; max.min = '0'; max.max = String(MAX_TRACK_TIME_SECONDS); max.step = '0.01'; max.placeholder = 'Max seconds'; max.value = rule.maxTimeMs == null ? '' : String(rule.maxTimeMs / 1000);
      max.setAttribute('aria-label', `Maximum seconds for rule ${index + 1}`);
      max.addEventListener('input', () => {
        if (max.validity.badInput) invalidTrackTimeInputs.add(max); else invalidTrackTimeInputs.delete(max);
        const seconds = max.value === '' ? null : bounded(Number(max.value), MAX_TRACK_TIME_SECONDS);
        rule.maxTimeMs = seconds === null ? null : seconds * 1000;
      });
      const remove = button('Remove', 'fm-button fm-button-quiet'); remove.setAttribute('aria-label', `Remove track rule ${index + 1}`);
      remove.addEventListener('click', () => { filter.trackRules.splice(index, 1); renderTrackRules(); scheduleRuleNotice(null, true); });
      row.append(select, state, min, max, remove);
      const previewUrl = localImageSource(track?.previewUrl || track?.preview || track?.image || track?.thumbnailUrl);
      const metadata = [];
      const hasBest = track?.bestTimeMs != null && Number.isFinite(Number(track.bestTimeMs));
      const hasPb = track?.pbTimeMs != null && Number.isFinite(Number(track.pbTimeMs));
      const hasWeight = track?.weight != null && Number.isFinite(Number(track.weight));
      const formatTrackTime = value => {
        const totalMs = Math.round(Number(value));
        const minutes = Math.floor(totalMs / 60000);
        const seconds = Math.floor(totalMs / 1000) % 60;
        const milliseconds = totalMs % 1000;
        return `${minutes}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`;
      };
      if (hasBest) metadata.push(`Best ${formatTrackTime(track.bestTimeMs)}`);
      if (hasPb) metadata.push(`Your PB ${formatTrackTime(track.pbTimeMs)}`);
      if (hasWeight) metadata.push(`Weight ${Number(track.weight).toFixed(2)}x`);
      for (const [key, label] of [['racerCount', track?.complete === true ? 'Racers' : 'Loaded racers'], ['meanTimeMs', 'Mean PB'], ['medianTimeMs', 'Median PB']]) {
        if (track?.[key] != null && Number.isFinite(Number(track[key]))) {
          metadata.push(`${label} ${key.endsWith('TimeMs') ? formatTrackTime(track[key]) : Number(track[key]).toLocaleString()}`);
        }
      }
      if (previewUrl || metadata.length) {
        const info = el('div', 'fm-track-info');
        if (previewUrl) {
          const image = document.createElement('img'); image.src = previewUrl; image.alt = ''; image.loading = 'lazy';
          image.addEventListener('error', () => image.remove(), { once: true }); info.append(image);
        }
        if (metadata.length) {
          const metaGrid = el('span', 'fm-track-meta');
          for (const item of metadata) metaGrid.append(el('span', '', item));
          info.append(metaGrid);
          if (track?.racerCount != null || track?.meanTimeMs != null || track?.medianTimeMs != null) {
            info.append(el('span', 'fm-track-meta-note', 'Stats use loaded PBs, not all attempts.'));
          }
        }
        row.append(info);
      }
      trackRuleList.append(row);
    }
  }
  addTrackButton.addEventListener('click', () => {
    if (filter.trackRules.length < MAX_TRACK_RULES && tracks.length) {
      filter.trackRules.push({ trackId: String(tracks[0].id), state: 'any', minTimeMs: null, maxTimeMs: null }); renderTrackRules();
      scheduleRuleNotice(null, true);
    }
  });

  function renderTrackWeights() {
    const selected = trackWeightSelect.value;
    trackWeightSelect.replaceChildren();
    const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Choose a track'; trackWeightSelect.append(placeholder);
    for (const track of tracks) {
      const option = document.createElement('option'); option.value = String(track.id); option.textContent = cleanString(track.name || track.id); trackWeightSelect.append(option);
    }
    trackWeightSelect.value = tracks.some(track => String(track.id) === selected) ? selected : '';
    addTrackWeightButton.disabled = tracks.length === 0 || filter.trackWeights.length >= MAX_TRACK_WEIGHTS;
    trackWeightsList.replaceChildren();
    if (!tracks.length) { trackWeightsList.append(el('p', 'fm-empty', 'Track weights are unavailable until track data is loaded.')); return; }
    if (!filter.trackWeights.length) trackWeightsList.append(el('p', 'fm-empty', 'No track weight overrides.'));
    for (const entry of filter.trackWeights) {
      const id = entry.trackId;
      const track = tracks.find(item => String(item.id) === id);
      const name = cleanString(track?.name || id, 100);
      const base = track?.weight != null && Number.isFinite(Number(track.weight)) ? `Default ${Number(track.weight).toFixed(2)}x` : 'Default unavailable';
      const input = document.createElement('input'); input.type = 'number'; input.min = '0'; input.max = '1000'; input.step = '0.01';
      input.value = entry.weight;
      input.placeholder = base; input.setAttribute('aria-label', `Weight override for ${name}`);
      input.addEventListener('input', () => {
        const weight = bounded(Number(input.value), 1000);
        if (weight === null) return;
        entry.weight = weight;
      });
      const row = el('div', 'fm-track-weight-row');
      const remove = button('Remove', 'fm-button fm-button-quiet');
      remove.addEventListener('click', () => { filter.trackWeights = filter.trackWeights.filter(item => item.trackId !== id); renderTrackWeights(); });
      row.append(el('span', 'fm-track-weight-name', name), el('span', 'fm-track-weight-base', base), input, remove);
      trackWeightsList.append(row);
    }
  }
  addTrackWeightButton.addEventListener('click', () => {
    const id = trackWeightSelect.value;
    const track = tracks.find(item => String(item.id) === id);
    if (!track) { setStatus('Choose a track with a supplied default weight.', true); return; }
    if (filter.trackWeights.some(item => item.trackId === id)) { setStatus('This track already has a weight override.', true); return; }
    if (track.weight == null || !Number.isFinite(Number(track.weight))) { setStatus('No default weight was supplied for this track.', true); return; }
    filter.trackWeights.push({ trackId: id, weight: Number(track.weight) });
    renderTrackWeights(); setStatus(`Weight override added for ${cleanString(track.name || id)}.`);
  });

  function writeForm(value) {
    filter = normalizeFilter(value);
    for (const [key, control] of Object.entries(rangeControls)) control.value = filter[key] ?? '';
    joinedAfter.value = dateInputValue(filter.joinedAfter);
    joinedBefore.value = dateInputValue(filter.joinedBefore);
    modeSelect.value = filter.mode; scopeSelect.value = filter.scope; gradeSelect.value = filter.grading; missingSelect.value = filter.missing;
    hideUncustomized.checked = filter.hideUncustomized;
    showLeaderboardNotice.checked = filter.showNotice;
    colorSelect.value = filter.color; colorLevelSelect.value = filter.colorLevel;
    applyColorPresentation();
    codeList.render(); countryPicker.render(); badgePicker.render(); whitelistPicker.refresh(); blacklistPicker.refresh(); renderTrackRules(); renderTrackWeights();
  }
  function readForm() {
    const next = normalizeFilter(filter);
    next.mode = modeSelect.value; next.scope = scopeSelect.value; next.grading = gradeSelect.value; next.missing = missingSelect.value;
    next.hideUncustomized = hideUncustomized.checked;
    next.showNotice = showLeaderboardNotice.checked;
    next.color = colorSelect.value; next.colorLevel = colorLevelSelect.value;
    for (const [key, control] of Object.entries(rangeControls)) {
      const spec = RANGE_FIELDS.find(([min, max]) => key === min || key === max);
      const value = bounded(control.value, spec[2], spec[3]);
      if (control.value !== '' && value === null) return { value: next, errors: [`${key}: enter a valid non-negative ${spec[3] ? 'whole number' : 'number'}.`] };
      next[key] = value;
    }
    next.joinedAfter = epochFromDate(joinedAfter.value, false);
    next.joinedBefore = epochFromDate(joinedBefore.value, true);
    next.trackRules = filter.trackRules.map((rule, index) => {
      const row = trackRuleList.children[index];
      const inputs = row?.querySelectorAll('input') || [];
      const minInput = inputs[0];
      const maxInput = inputs[1];
      const minSeconds = minInput?.value ?? '';
      const maxSeconds = maxInput?.value ?? '';
      const minValue = minSeconds === '' ? null : bounded(Number(minSeconds), MAX_TRACK_TIME_SECONDS);
      const maxValue = maxSeconds === '' ? null : bounded(Number(maxSeconds), MAX_TRACK_TIME_SECONDS);
      if (minInput?.validity?.badInput || minInput && invalidTrackTimeInputs.has(minInput) || minSeconds !== '' && minValue === null) return { ...rule, minTimeMs: Number.NaN };
      if (maxInput?.validity?.badInput || maxInput && invalidTrackTimeInputs.has(maxInput) || maxSeconds !== '' && maxValue === null) return { ...rule, maxTimeMs: Number.NaN };
      const min = minValue === null ? null : minValue * 1000;
      const max = maxValue === null ? null : maxValue * 1000;
      return { ...rule, minTimeMs: min, maxTimeMs: max };
    });
    if (next.trackRules.some(rule => Number.isNaN(rule.minTimeMs) || Number.isNaN(rule.maxTimeMs))) {
      return { value: next, errors: ['Track time bounds must be valid numbers between 0 and 36000 seconds.'] };
    }
    const errors = validateFilter(next);
    return { value: next, errors };
  }

  function backupCurrentFilter(reason, sourceFilter = null) {
    const current = overlay.hidden ? null : readForm();
    const snapshot = sourceFilter ? normalizeFilter(sourceFilter) : current && !current.errors.length ? current.value : normalizeFilter(filter);
    let backups = [];
    try { backups = JSON.parse(storage?.getItem(BACKUP_KEY) || '[]'); } catch {}
    if (!Array.isArray(backups)) backups = [];
    backups.unshift({ savedAt: Date.now(), reason: cleanString(reason, 40), filter: snapshot });
    try { storage?.setItem(BACKUP_KEY, JSON.stringify(backups.slice(0, 20))); } catch {}
  }

  function updateRuleNotice(candidateFilter = filter) {
    if (!noticeVisible) { ruleNotice.hidden = true; return; }
    const counts = safeCall(() => getRuleCounts(rows, candidateFilter), null);
    ruleNotice.hidden = counts == null;
    if (counts && typeof counts === 'object' && Array.isArray(counts.rules)) {
      const rowLoadedAt = rows.map(row => row.loadedAt).filter(value => value != null).sort((a, b) => Number(b) - Number(a))[0];
      const loadedAt = counts.loadedAt ?? counts.filter?.loadedAt ?? rowLoadedAt;
      const loadedDate = typeof loadedAt === 'number' ? new Date(loadedAt) : new Date(loadedAt || NaN);
      const ageMs = Number.isNaN(loadedDate.getTime()) ? null : Math.max(0, Date.now() - loadedDate.getTime());
      const ageLabel = ageMs == null ? '' : ` · loaded ${ageMs < 60000 ? `${Math.floor(ageMs / 1000)}s ago` : ageMs < 3600000 ? `${Math.floor(ageMs / 60000)}m ago` : ageMs < 86400000 ? `${Math.floor(ageMs / 3600000)}h ago` : `${Math.floor(ageMs / 86400000)}d ago`}`;
      ruleNotice.replaceChildren(el('strong', '', `${counts.filter?.mode === 'smart' ? 'Smart filter' : 'Filter'} · ${counts.sourceCount ?? rows.length} racers${ageLabel}`));
      for (const [index, rule] of counts.rules.entries()) {
        const line = el('span', 'fm-rule-count-line');
        const labels={whitelist:'Only selected racers',blacklist:'Excluded racers',forcedIncludes:'Always included racers',countryCodes:'Countries',badges:'Badges',groupCodes:'Group tags',hideUncustomized:'Customized profiles',rp:'Published RP',playtimeHours:'Playtime',tracks:'Completed tracks',wins:'Wins',daysActive:'Active days',joined:'Joined dates'};
        const rawLabel=rule.label || rule.name || rule.field || rule.rule;
        const name=String(rawLabel||'').startsWith('track:')?tracks.find(track=>String(track.id)===String(rawLabel).slice(6))?.name||'Track requirement':labels[rawLabel]||cleanString(rawLabel,64)||`Rule ${index+1}`;
        const qualified = rule.qualifiedCount != null && Number.isFinite(Number(rule.qualifiedCount)) ? rule.qualifiedCount : '?';
        const source = rule.sourceCount != null && Number.isFinite(Number(rule.sourceCount)) ? rule.sourceCount : counts.sourceCount ?? rows.length;
        const conditional = rule.conditionalQualifiedCount != null && Number.isFinite(Number(rule.conditionalQualifiedCount)) ? ` · with this rule: ${rule.conditionalQualifiedCount}` : '';
        const others = rule.othersQualifiedCount != null && Number.isFinite(Number(rule.othersQualifiedCount)) ? ` · other rules: ${rule.othersQualifiedCount}` : '';
        const conditionalCount = rule.conditionalQualifiedCount != null && Number.isFinite(Number(rule.conditionalQualifiedCount)) ? Number(rule.conditionalQualifiedCount) : null;
        const otherCount = rule.othersQualifiedCount != null && Number.isFinite(Number(rule.othersQualifiedCount)) ? Number(rule.othersQualifiedCount) : null;
        const conditionalLabel = conditionalCount !== null && otherCount !== null ? ` · ${conditionalCount}/${otherCount} with other rules (${Math.max(0, otherCount - conditionalCount)} removed)` : '';
        line.textContent = `${name}: raw ${qualified}/${source}${conditionalLabel}`; ruleNotice.append(line);
      }
    } else if (counts && typeof counts === 'object') {
      ruleNotice.textContent = 'Rule counts are available from the loaded leaderboard.';
    }
  }

  function scheduleRuleNotice(event, force = false) {
    const target = event?.target;
    if (target?.matches?.('.fm-check-search') || (target?.matches?.('input[type="search"]') && target.closest?.('.fm-user-picker'))) return;
    const relevant = target?.closest?.('.fm-range, .fm-check-picker, .fm-track-rules, .fm-user-picker')
      || target?.matches?.('input[type="date"], [data-filter-field]')
      || [modeSelect, scopeSelect, gradeSelect, missingSelect, hideUncustomized, showLeaderboardNotice].includes(target);
    if (!force && !relevant) return;
    clearTimeout(ruleNoticeTimer);
    ruleNoticeTimer = setTimeout(() => {
      ruleNoticeTimer = null;
      const checked = readForm();
      if (!checked.errors.length) updateRuleNotice(checked.value);
    }, 150);
  }

  function renderLoadouts(selectedName = '') {
    loadoutSelect.replaceChildren();
    const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Choose a saved loadout'; loadoutSelect.append(placeholder);
    const presets = [...local.presets];
    if (local.sort === 'name') presets.sort((a, b) => a.name.localeCompare(b.name));
    else if(local.sort==='used')presets.sort((a,b)=>Number(b.usageCount||0)-Number(a.usageCount||0));
    else presets.sort((a, b) => Number(b.favorite) - Number(a.favorite)||Number(b.lastUsedAt||0)-Number(a.lastUsedAt||0));
    for (const preset of presets) {
      const option = document.createElement('option'); option.value = preset.name; option.textContent = `${preset.favorite ? '★ ' : ''}${preset.name}`; loadoutSelect.append(option);
      if(preset.filter.color){option.style.color=preset.filter.color;option.textContent='● '+option.textContent;}
    }
    loadoutSelect.value = selectedName;
    const selected = local.presets.find(item => item.name === loadoutSelect.value);
    loadoutSelect.style.borderColor=selected?.filter.color||'';
    favoritePresetButton.textContent = selected?.favorite ? '★ Favorited' : '☆ Favorite';
    favoritePresetButton.disabled = !selected;
  }

  async function applyCurrent() {
    const checked = readForm();
    if (checked.errors.length) { setStatus(checked.errors.join(' '), true); return null; }
    filter = checked.value;
    applyButton.disabled = true;
    try {
      const result = await onApply({ ...filter, whitelist: [...filter.whitelist], blacklist: [...filter.blacklist], forcedIncludes: [...filter.forcedIncludes], countryCodes: [...filter.countryCodes], badges: [...filter.badges], groupCodes: [...filter.groupCodes], trackRules: filter.trackRules.map(rule => ({ ...rule })) });
      const unavailable = Array.isArray(result?.unavailable) ? result.unavailable : Array.isArray(result?.warnings) ? result.warnings : [];
      const hasIncompleteData = result?.incomplete === true || Number(result?.missingCount || 0) > 0;
      warning.hidden = unavailable.length === 0 && !hasIncompleteData;
      updateRuleNotice();
      setStatus(warning.hidden ? 'Filters applied.' : 'Filters applied. Some requested rules or group scores are unavailable in the loaded data.');
      return result;
    } catch (error) {
      setStatus(error?.message || 'Filters could not be applied.', true);
      return null;
    } finally { applyButton.disabled = false; }
  }
  applyButton.addEventListener('click', applyCurrent);
  clearButton.addEventListener('click', () => {
    backupCurrentFilter('before reset');
    writeForm({ ...DEFAULT_FILTER, enabled: filter.enabled }); warning.hidden = true; applyCurrent();
  });
  modeSelect.addEventListener('change', () => {
    const switchingToSmart = modeSelect.value === 'smart' && filter.mode !== 'smart';
    filter.mode = modeSelect.value;
    if (switchingToSmart) { gradeSelect.value = 'group'; filter.grading = 'group'; }
  });
  scopeSelect.addEventListener('change', () => { filter.scope = scopeSelect.value; });
  gradeSelect.addEventListener('change', () => { filter.grading = gradeSelect.value; });
  missingSelect.addEventListener('change', () => { filter.missing = missingSelect.value; });

  groupSaveButton.addEventListener('click', async () => {
    const code = groupCodeInput.value.trim();
    if (code && !/^\d{6}$/.test(code)) { setStatus('Group tag must contain exactly six digits.', true); groupCodeInput.focus(); return; }
    groupSaveButton.disabled = true; groupCodeInput.disabled = true;
    try {
      await onGroupCodeSave(code);
      setStatus(code ? 'Group tag saved to your profile.' : 'Group tag cleared from your profile.');
    } catch (error) { setStatus(error?.message || 'Group tag could not be saved.', true); }
    finally { groupSaveButton.disabled = false; groupCodeInput.disabled = false; }
  });
  pauseButton.addEventListener('click', async () => {
    if (busy) return;
    busy = true; pauseButton.disabled = true;
    try {
      const result = await onToggle();
      local.paused = result === false ? false : !local.paused;
      if (result && typeof result === 'object' && typeof result.enabled === 'boolean') local.paused = !result.enabled;
      filter = normalizeFilter(safeCall(getFilter, { ...filter, enabled: !local.paused }));
      if (typeof filter.enabled === 'boolean') local.paused = !filter.enabled;
      pauseButton.textContent = local.paused ? 'Resume filters' : 'Pause filters';
      pauseButton.setAttribute('aria-pressed', String(local.paused));
      saveLocal(storage, local);
      setStatus(local.paused ? 'Filters paused. Published scores remain unchanged.' : 'Filters resumed.');
    } catch (error) { setStatus(error?.message || 'Could not change filter state.', true); }
    finally { busy = false; pauseButton.disabled = false; }
  });

  exportCodeButton.addEventListener('click', () => {
    try {
      const checked = readForm(); if (checked.errors.length) { setStatus(checked.errors.join(' '), true); return; }
      generatedCode = String(exportCode(checked.value)); shareArea.value = generatedCode;
      setStatus('Share code created. Copy it or send it to another player.');
    } catch (error) { setStatus(error?.message || 'Share code could not be created.', true); }
  });
  downloadCodeButton.addEventListener('click', () => {
    if (!shareArea.value.trim()) { setStatus('Create a share code first.', true); return; }
    try {
      const blob = new Blob([shareArea.value], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob); const link = document.createElement('a');
      link.href = url; link.download = 'polytrack-filter-code.txt'; link.click(); URL.revokeObjectURL(url);
      setStatus('Share code downloaded to this device.');
    } catch (error) { setStatus(error?.message || 'Share code could not be downloaded.', true); }
  });
  copyCodeButton.addEventListener('click', async () => {
    if (!shareArea.value) { setStatus('Create or paste a share code first.', true); return; }
    try {
      if (typeof globalThis.navigator?.clipboard?.writeText !== 'function') throw new Error('Clipboard unavailable.');
      await globalThis.navigator.clipboard.writeText(shareArea.value);
      setStatus('Share code copied.');
    } catch { shareArea.focus(); shareArea.select(); setStatus('Clipboard access is unavailable. The code is selected so you can copy it.'); }
  });
  importCodeButton.addEventListener('click', () => {
    try {
      const imported = importCode(shareArea.value.trim());
      if (!imported || typeof imported !== 'object') throw new TypeError('The code did not contain a filter.');
      backupCurrentFilter('before code import');
      const importedAt = Date.now();
      writeForm({ ...imported, createdAt: imported.createdAt ?? importedAt, loadedAt: imported.loadedAt ?? importedAt });
      showSection('scoring'); setStatus('Code imported into the editor. Apply filters to use it.');
    } catch (error) { setStatus(error?.message || 'This share code could not be imported.', true); }
  });
  restoreBackupButton.addEventListener('click', () => {
    let backups = [];
    try { backups = JSON.parse(storage?.getItem(BACKUP_KEY) || '[]'); } catch {}
    const backup = Array.isArray(backups) ? backups[0] : null;
    if (!backup?.filter) { setStatus('No filter backup is available on this device.', true); return; }
    backupCurrentFilter('before backup restore');
    writeForm(backup.filter); showSection('scoring');
    setStatus(`Previous filter restored to the editor${backup.reason ? ` (${backup.reason})` : ''}. Apply filters to use it.`);
  });

  loadButton.addEventListener('click', () => {
    const preset = local.presets.find(item => item.name === loadoutSelect.value);
    if (!preset) { setStatus('Choose a saved loadout first.', true); return; }
    const nextPresets = local.presets.map(item => item === preset
      ? { ...item, usageCount: (item.usageCount || 0) + 1, lastUsedAt: Date.now() }
      : item);
    if (!commitLocal(storage, local, { ...local, presets: nextPresets })) { setStatus('Loadout usage could not be saved locally.', true); return; }
    backupCurrentFilter('before loadout load');
    writeForm(preset.filter); loadoutName.value = preset.name; setStatus('Loadout loaded into the editor. Apply filters to use it.');
  });
  saveButton.addEventListener('click', () => {
    const name = cleanString(loadoutName.value, 32); const checked = readForm();
    if (!name) { setStatus('Enter a name for this loadout.', true); loadoutName.focus(); return; }
    if (checked.errors.length) { setStatus(checked.errors.join(' '), true); return; }
    const existing = local.presets.find(item => item.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (existing && !document.defaultView?.confirm?.(`Replace the saved loadout “${existing.name}”?`)) { setStatus('Saved loadout was not changed.'); return; }
    const presets = [{ name, filter: checked.value, favorite: existing?.favorite === true }, ...local.presets.filter(item => item.name.toLocaleLowerCase() !== name.toLocaleLowerCase())].slice(0, 30);
    if (!commitLocal(storage, local, { ...local, presets })) { setStatus('Loadout could not be saved in this browser.', true); return; }
    renderLoadouts(name); setStatus(`“${name}” saved on this device.`);
  });
  favoritePresetButton.addEventListener('click', () => {
    const preset = local.presets.find(item => item.name === loadoutSelect.value);
    if (!preset) return;
    const favorite = !preset.favorite;
    const presets = local.presets.map(item => ({ ...item, favorite: item === preset ? favorite : favorite ? false : item.favorite }));
    if (!commitLocal(storage, local, { ...local, presets })) { setStatus('Favorite could not be saved locally.', true); return; }
    renderLoadouts(preset.name); setStatus(favorite ? 'Loadout added to favorites.' : 'Loadout removed from favorites.');
  });
  loadoutSort.addEventListener('change', () => {
    const sort = ['name','used'].includes(loadoutSort.value) ? loadoutSort.value : 'recent';
    if (!commitLocal(storage, local, { ...local, sort })) { loadoutSort.value = local.sort; setStatus('Loadout sort could not be saved locally.', true); return; }
    renderLoadouts(loadoutSelect.value);
  });
  deleteButton.addEventListener('click', () => {
    const name = loadoutSelect.value;
    if (!name) { setStatus('Choose a saved loadout first.', true); return; }
    const presets = local.presets.filter(item => item.name !== name);
    if (!commitLocal(storage, local, { ...local, presets })) { setStatus('Loadout could not be deleted.', true); return; }
    renderLoadouts(); loadoutName.value = ''; setStatus('Loadout deleted from this device.');
  });
  exportLoadoutsButton.addEventListener('click', () => {
    importExportArea.value = JSON.stringify({ version: 1, presets: local.presets }, null, 2);
    setStatus('Local loadouts exported to the text area.');
  });
  importLoadoutsButton.addEventListener('click', () => {
    try {
      const parsed = JSON.parse(importExportArea.value);
      const incoming = Array.isArray(parsed) ? parsed : parsed?.presets;
      if (!Array.isArray(incoming)) throw new TypeError('Loadout data must contain a presets list.');
      const collisions = incoming.filter(item => local.presets.some(saved => saved.name.toLocaleLowerCase() === cleanString(item?.name, 32).toLocaleLowerCase()));
      if (collisions.length && !document.defaultView?.confirm?.(`Replace ${collisions.length} matching saved loadout(s)?`)) { setStatus('Loadout import canceled.'); return; }
      const merged = new Map(local.presets.map(item => [item.name.toLocaleLowerCase(), item]));
      for (const item of incoming.slice(0, 30)) {
        const name = cleanString(item?.name, 32);
        if (!name || !item?.filter || typeof item.filter !== 'object') continue;
        merged.set(name.toLocaleLowerCase(), { name, filter: normalizeFilter(item.filter), favorite: item.favorite === true });
      }
      const presets = [...merged.values()].slice(0, 30);
      if (!commitLocal(storage, local, { ...local, presets })) throw new Error('Loadouts could not be saved in this browser.');
      backupCurrentFilter('before loadout import');
      renderLoadouts(); setStatus('Loadouts imported and saved locally.');
    } catch (error) { setStatus(error?.message || 'Loadouts could not be imported.', true); }
  });

  function focusable() {
    return [...overlay.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex]:not([tabindex="-1"])')]
      .filter(item => !item.hidden && item.getAttribute('aria-hidden') !== 'true' && item.getClientRects?.().length !== 0);
  }
  function onKeydown(event) {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key !== 'Tab') return;
    const items = focusable();
    if (!items.length) { event.preventDefault(); overlay.focus(); return; }
    const first = items[0]; const last = items[items.length - 1];
    if (event.shiftKey && (document.activeElement === first || !overlay.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !overlay.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  }
  function onOverlayClick(event) { if (event.target === overlay) close(); }
  function onOverlayPointerDown(event) {
    if (event.target.closest?.('.fm-user-picker')) return;
    activeUserSearch = null;
    for (const picker of overlay.querySelectorAll('.fm-user-picker')) {
      const input = picker.querySelector('input');
      const popup = picker.querySelector('.fm-suggestions');
      if (popup && !popup.hidden) {
        popup.hidden = true;
        input?.setAttribute('aria-expanded', 'false');
      }
    }
  }
  overlay.addEventListener('keydown', onKeydown);
  overlay.addEventListener('click', onOverlayClick);
  overlay.addEventListener('pointerdown', onOverlayPointerDown);
  overlay.addEventListener('input', scheduleRuleNotice);
  overlay.addEventListener('change', scheduleRuleNotice);
  closeButton.addEventListener('click', close);

  function open() {
    if (destroyed) return;
    writeForm(refresh());
    priorFocus = document.activeElement;
    overlay.hidden = false;
    for (const picker of overlay.querySelectorAll('.fm-user-picker')) {
      const chips = picker.querySelector('.fm-chips');
      if (chips) safeCall(() => onRenderRacers(chips), undefined);
    }
  document.body?.classList.add('pt-group-filter-menu-open');
    (closeButton || focusable()[0])?.focus({ preventScroll: true });
  }
  function close() {
    if (destroyed || overlay.hidden) return;
    overlay.hidden = true;
    document.body?.classList.remove('pt-group-filter-menu-open');
    if (priorFocus?.isConnected) priorFocus.focus({ preventScroll: true });
  }
  function refresh() {
    if (destroyed) return;
    rows = asRows(safeCall(getRows, []));
    const currentTracks = safeCall(getTracks, []);
    tracks = Array.isArray(currentTracks) ? currentTracks.filter(track => track && track.id != null) : [];
    const current = normalizeFilter(safeCall(getFilter, filter));
    filter = current;
    for (const userPicker of [whitelistPicker, blacklistPicker]) userPicker.refresh();
    countryPicker.render(); badgePicker.render(); renderTrackRules(); renderTrackWeights();
    groupCodeInput.value = cleanString(safeCall(getGroupCode, groupCodeInput.value), 6);
    updateRuleNotice();
    local.paused = !current.enabled;
    pauseButton.textContent = local.paused ? 'Resume filters' : 'Pause filters';
    pauseButton.setAttribute('aria-pressed', String(local.paused));
    return filter;
  }
  function destroy() {
    if (destroyed) return;
    close(); destroyed = true;
    overlay.removeEventListener('keydown', onKeydown);
    overlay.removeEventListener('click', onOverlayClick);
    overlay.removeEventListener('pointerdown', onOverlayPointerDown);
    overlay.removeEventListener('input', scheduleRuleNotice);
    overlay.removeEventListener('change', scheduleRuleNotice);
    clearTimeout(ruleNoticeTimer); ruleNoticeTimer = null;
    overlay.remove(); document.body?.classList.remove('pt-group-filter-menu-open');
  }

  writeForm(filter);
  renderLoadouts();
  renderTrackRules();
  if (local.paused !== !filter.enabled) {
    local.paused = !filter.enabled;
    saveLocal(storage, local);
  }
  pauseButton.textContent = local.paused ? 'Resume filters' : 'Pause filters';
  pauseButton.setAttribute('aria-pressed', String(local.paused));

  async function updateRacer(id, action = 'include') {
    const safeId = cleanString(id);
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(safeId)) return false;
    const kind = typeof action === 'string' ? action : cleanString(action?.action || action?.type, 32);
    const targetHint = typeof action === 'object' ? cleanString(action.target, 32) : '';
    if (overlay.hidden) filter = normalizeFilter(safeCall(getFilter, filter));
    else {
      const checked = readForm();
      if (checked.errors.length) { setStatus(`Finish correcting the current form first. ${checked.errors.join(' ')}`, true); return false; }
      filter = checked.value;
    }
    const previous = normalizeFilter(filter);
    const favorite = local.presets.find(item => item.favorite);
    const mostUsed = [...local.presets].filter(item => Number(item.usageCount || 0) > 0).sort((a, b) => Number(b.usageCount || 0) - Number(a.usageCount || 0))[0];
    const targetPreset = ['current', 'current-filter'].includes(targetHint) ? null : targetHint === 'mostused' || targetHint === 'most-used' ? (mostUsed || favorite) : favorite || mostUsed;
    const target = targetPreset ? normalizeFilter(targetPreset.filter) : previous;
    backupCurrentFilter('before racer rule update', previous);
    if (kind === 'exclude' || kind === 'blacklist') {
      target.forcedIncludes = target.forcedIncludes.filter(value => value !== safeId);
      target.whitelist = target.whitelist.filter(value => value !== safeId);
      target.blacklist = [...new Set([...target.blacklist, safeId])].slice(0, MAX_LIST);
    } else if (kind === 'include' || kind === 'forcedInclude' || kind === 'forced-includes' || kind === 'force-include' || kind === 'current-filter') {
      target.blacklist = target.blacklist.filter(value => value !== safeId);
      target.forcedIncludes = [...new Set([...target.forcedIncludes, safeId])].slice(0, MAX_LIST);
    } else if (kind === 'remove') {
      for (const key of ['whitelist', 'blacklist', 'forcedIncludes']) target[key] = target[key].filter(value => value !== safeId);
    } else return false;
    try {
      filter = target;
      await onApply({ ...filter, whitelist: [...filter.whitelist], blacklist: [...filter.blacklist], forcedIncludes: [...filter.forcedIncludes], countryCodes: [...filter.countryCodes], badges: [...filter.badges], groupCodes: [...filter.groupCodes], trackRules: filter.trackRules.map(rule => ({ ...rule })) });
      let savedPreset = true;
      if (targetPreset) {
        const presets = local.presets.map(item => item === targetPreset ? { ...item, filter: normalizeFilter(filter) } : item);
        savedPreset = commitLocal(storage, local, { ...local, presets });
      }
      if (!overlay.hidden) writeForm(filter);
      updateRuleNotice();
      const actionLabel = kind === 'exclude' || kind === 'blacklist' ? 'Racer excluded' : kind === 'remove' ? 'Racer rule removed' : 'Racer forced into results';
      if (targetPreset && !savedPreset) {
        setStatus(`${actionLabel} in the active filter, but saved loadout "${targetPreset.name}" could not be updated. The saved loadout is unchanged.`, true);
      } else {
        setStatus(`${actionLabel}${targetPreset ? ` in “${targetPreset.name}”` : ' in the current filter'}.`);
      }
      return true;
    } catch (error) {
      filter = previous;
      if (!overlay.hidden) writeForm(previous);
      setStatus(error?.message || 'Racer rule could not be applied.', true);
      return false;
    }
  }

  return Object.freeze({ open, close, refresh, destroy, updateRacer });
}
