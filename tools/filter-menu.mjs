const STORAGE_KEY = 'polytrack-advanced-filter-loadouts-v1';
const MAX_LIST = 128;
const MAX_TRACK_RULES = 8;
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
  whitelist: [],
  blacklist: [],
  countryCodes: [],
  badges: [],
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
  value.mode = source.mode === 'smart' ? 'smart' : 'normal';
  value.scope = source.scope === 'overall' ? 'overall' : 'all';
  value.grading = source.grading === 'group' ? 'group' : 'global';
  value.missing = source.missing === 'exclude' ? 'exclude' : 'include';
  value.whitelist = uniqueStrings(source.whitelist, /^[A-Za-z0-9_.:-]{1,128}$/);
  value.blacklist = uniqueStrings(source.blacklist, /^[A-Za-z0-9_.:-]{1,128}$/);
  value.countryCodes = uniqueStrings((Array.isArray(source.countryCodes) ? source.countryCodes : []).map(code => String(code).toUpperCase()), /^[A-Z]{2}$/);
  value.badges = uniqueStrings(source.badges, /^[A-Za-z0-9_.:-]{1,128}$/);
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
    presets.push({ name, filter: normalizeFilter(item.filter) });
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
  return { paused, presets };
}

function saveLocal(storage, data) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify({ version: 1, paused: data.paused, presets: data.presets }));
    return true;
  } catch {
    return false;
  }
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
  exportCode = filter => JSON.stringify(filter),
  importCode = code => JSON.parse(code)
} = {}) {
  if (!document?.createElement || !root?.append) throw new TypeError('A document and mount root are required.');

  const local = loadLocal(storage);
  let filter = normalizeFilter(safeCall(getFilter, DEFAULT_FILTER));
  let rows = asRows(safeCall(getRows, []));
  const initialTracks = safeCall(getTracks, []);
  let tracks = Array.isArray(initialTracks) ? initialTracks.filter(track => track && track.id != null) : [];
  let activeSection = 'group';
  let busy = false;
  let destroyed = false;
  let priorFocus = null;
  let selectedUsers = { whitelist: [], blacklist: [] };
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
  const clearButton = button('Clear rules', 'fm-button fm-button-quiet');
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
    const values = new Set();
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
        if (value && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)) values.add(value);
      }
    }
    return [...values].sort((a, b) => a.localeCompare(b)).map(value => [value, value]);
  }, 'badges');
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
  const trackRuleList = el('div', 'fm-track-rules');
  const addTrackButton = button('Add track rule', 'fm-button fm-button-secondary');
  trackCard.append(trackRuleList, addTrackButton);

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
  const importCodeButton = button('Import code', 'fm-button fm-button-secondary');
  shareActions.append(exportCodeButton, copyCodeButton, importCodeButton);
  shareCard.append(labelFor('Code', shareArea), shareActions);

  const loadoutCard = card(sharePanel, 'Local loadouts', 'Names and filters stay in this browser. Up to 30 loadouts are stored under the PolyTrack advanced-filter local key.');
  const loadoutSelect = document.createElement('select'); loadoutSelect.setAttribute('aria-label', 'Saved loadouts');
  const loadoutName = document.createElement('input'); loadoutName.type = 'text'; loadoutName.maxLength = 32; loadoutName.placeholder = 'Preset name'; loadoutName.setAttribute('aria-label', 'Loadout name');
  const loadoutRow = el('div', 'fm-inline'); loadoutRow.append(labelFor('Saved loadouts', loadoutSelect), labelFor('Preset name', loadoutName));
  const loadoutActions = el('div', 'fm-actions');
  const loadButton = button('Load selected', 'fm-button fm-button-secondary');
  const saveButton = button('Save current', 'fm-button fm-button-secondary');
  const deleteButton = button('Delete selected', 'fm-button fm-button-quiet');
  loadoutActions.append(loadButton, saveButton, deleteButton);
  const importExportArea = document.createElement('textarea'); importExportArea.rows = 5;
  importExportArea.setAttribute('aria-label', 'Loadout import and export data');
  importExportArea.placeholder = 'Exported loadouts appear here. Paste exported data to import.';
  const loadoutTransfer = el('div', 'fm-actions');
  const exportLoadoutsButton = button('Export loadouts', 'fm-button fm-button-quiet');
  const importLoadoutsButton = button('Import loadouts', 'fm-button fm-button-quiet');
  loadoutTransfer.append(exportLoadoutsButton, importLoadoutsButton);
  loadoutCard.append(loadoutRow, loadoutActions, labelFor('Loadout data', importExportArea), loadoutTransfer);

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
    };
    add.addEventListener('click', addToken);
    input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addToken(); } });
    function renderTokenChips() {
      chips.replaceChildren();
      for (const value of filter[field]) {
        const chip = el('span', 'fm-chip'); chip.append(el('span', '', value));
        const remove = button('Remove', 'fm-chip-remove'); remove.setAttribute('aria-label', `Remove group tag ${value}`);
        remove.addEventListener('click', () => { filter[field] = filter[field].filter(item => item !== value); renderTokenChips(); });
        chip.append(remove); chips.append(chip);
      }
    }
    return { render: renderTokenChips };
  }

  function makeCheckPicker(parent, title, getOptions, field) {
    const details = document.createElement('details'); details.className = 'fm-check-picker';
    const summary = el('summary', '', title);
    const list = el('div', 'fm-check-list'); list.setAttribute('role', 'group'); list.setAttribute('aria-label', title);
    details.append(summary, list); parent.append(details);
    function render() {
      list.replaceChildren();
      const options = getOptions();
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
        row.append(input, el('span', '', label)); list.append(row);
      }
    }
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
    for (const row of rows) {
      const id = rowId(row); const name = rowName(row);
      if (!id || omit.has(id) || seen.has(id)) continue;
      const matched = q && (idSearch.query
        ? id.toLocaleLowerCase().includes(idSearch.query)
        : normName(name).includes(q));
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
    input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('aria-expanded', 'false');
    const chips = el('div', 'fm-chips'); chips.setAttribute('aria-label', `${title} selected`);
    container.append(labelFor(title, input), popup, chips); parent.append(container);
    const refreshSelected = () => {
      const ids = new Set(filter[field]);
      selectedUsers[field] = [...ids].map(id => {
        const row = rows.find(item => rowId(item) === id);
        return { id, name: row ? rowName(row) || 'Unnamed racer' : 'Racer no longer loaded' };
      });
      chips.replaceChildren();
      for (const entry of selectedUsers[field]) {
        const chip = el('span', 'fm-chip'); chip.append(el('span', 'fm-initials', initials(entry.name)), el('span', '', entry.name));
        const remove = button('Remove', 'fm-chip-remove'); remove.setAttribute('aria-label', `Remove ${entry.name} from ${field === 'whitelist' ? 'include' : 'exclude'} list`);
        remove.addEventListener('click', () => { filter[field] = filter[field].filter(id => id !== entry.id); renderSuggestions(); refreshSelected(); });
        chip.append(remove); chips.append(chip);
      }
    };
    function renderSuggestions() {
      popup.replaceChildren();
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
        person.append(el('span', 'fm-initials', initials(candidate.name)), el('span', 'fm-suggestion-name', candidate.name));
        option.append(person);
        if (idSearch.showId) option.append(el('span', 'fm-suggestion-id', candidate.id));
        option.addEventListener('click', () => {
          filter[field] = [...new Set([...filter[field], candidate.id])].slice(0, MAX_LIST);
          input.value = ''; popup.hidden = true; input.setAttribute('aria-expanded', 'false'); refreshSelected(); input.focus();
        });
        popup.append(option);
      }
      popup.hidden = !search || popup.childElementCount === 0;
      input.setAttribute('aria-expanded', String(!popup.hidden));
    }
    input.addEventListener('input', renderSuggestions);
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
      const select = document.createElement('select'); select.setAttribute('aria-label', `Track for rule ${index + 1}`);
      const empty = document.createElement('option'); empty.value = ''; empty.textContent = 'Choose track'; select.append(empty);
      for (const track of tracks) {
        const option = document.createElement('option'); option.value = String(track.id); option.textContent = cleanString(track.name || track.id); select.append(option);
      }
      select.value = rule.trackId;
      select.addEventListener('change', () => { rule.trackId = select.value; });
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
      remove.addEventListener('click', () => { filter.trackRules.splice(index, 1); renderTrackRules(); });
      row.append(select, state, min, max, remove); trackRuleList.append(row);
    }
  }
  addTrackButton.addEventListener('click', () => {
    if (filter.trackRules.length < MAX_TRACK_RULES && tracks.length) {
      filter.trackRules.push({ trackId: String(tracks[0].id), state: 'any', minTimeMs: null, maxTimeMs: null }); renderTrackRules();
    }
  });

  function writeForm(value) {
    filter = normalizeFilter(value);
    for (const [key, control] of Object.entries(rangeControls)) control.value = filter[key] ?? '';
    joinedAfter.value = dateInputValue(filter.joinedAfter);
    joinedBefore.value = dateInputValue(filter.joinedBefore);
    modeSelect.value = filter.mode; scopeSelect.value = filter.scope; gradeSelect.value = filter.grading; missingSelect.value = filter.missing;
    codeList.render(); countryPicker.render(); badgePicker.render(); whitelistPicker.refresh(); blacklistPicker.refresh(); renderTrackRules();
  }
  function readForm() {
    const next = normalizeFilter(filter);
    next.mode = modeSelect.value; next.scope = scopeSelect.value; next.grading = gradeSelect.value; next.missing = missingSelect.value;
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

  function renderLoadouts(selectedName = '') {
    loadoutSelect.replaceChildren();
    const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Choose a saved loadout'; loadoutSelect.append(placeholder);
    for (const preset of local.presets) {
      const option = document.createElement('option'); option.value = preset.name; option.textContent = preset.name; loadoutSelect.append(option);
    }
    loadoutSelect.value = selectedName;
  }

  async function applyCurrent() {
    const checked = readForm();
    if (checked.errors.length) { setStatus(checked.errors.join(' '), true); return null; }
    filter = checked.value;
    applyButton.disabled = true;
    try {
      const result = await onApply({ ...filter, whitelist: [...filter.whitelist], blacklist: [...filter.blacklist], countryCodes: [...filter.countryCodes], badges: [...filter.badges], groupCodes: [...filter.groupCodes], trackRules: filter.trackRules.map(rule => ({ ...rule })) });
      const unavailable = Array.isArray(result?.unavailable) ? result.unavailable : Array.isArray(result?.warnings) ? result.warnings : [];
      const hasIncompleteData = result?.incomplete === true || Number(result?.missingCount || 0) > 0;
      warning.hidden = unavailable.length === 0 && !hasIncompleteData;
      setStatus(warning.hidden ? 'Filters applied.' : 'Filters applied. Some requested rules or group scores are unavailable in the loaded data.');
      return result;
    } catch (error) {
      setStatus(error?.message || 'Filters could not be applied.', true);
      return null;
    } finally { applyButton.disabled = false; }
  }
  applyButton.addEventListener('click', applyCurrent);
  clearButton.addEventListener('click', () => {
    writeForm({ ...DEFAULT_FILTER, enabled: filter.enabled }); warning.hidden = true; setStatus('Rules cleared. Apply to update the leaderboard.');
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
      writeForm(imported); showSection('scoring'); setStatus('Code imported into the editor. Apply filters to use it.');
    } catch (error) { setStatus(error?.message || 'This share code could not be imported.', true); }
  });

  loadButton.addEventListener('click', () => {
    const preset = local.presets.find(item => item.name === loadoutSelect.value);
    if (!preset) { setStatus('Choose a saved loadout first.', true); return; }
    writeForm(preset.filter); loadoutName.value = preset.name; setStatus('Loadout loaded into the editor. Apply filters to use it.');
  });
  saveButton.addEventListener('click', () => {
    const name = cleanString(loadoutName.value, 32); const checked = readForm();
    if (!name) { setStatus('Enter a name for this loadout.', true); loadoutName.focus(); return; }
    if (checked.errors.length) { setStatus(checked.errors.join(' '), true); return; }
    local.presets = [{ name, filter: checked.value }, ...local.presets.filter(item => item.name.toLocaleLowerCase() !== name.toLocaleLowerCase())].slice(0, 30);
    if (!saveLocal(storage, local)) { setStatus('Loadout could not be saved in this browser.', true); return; }
    renderLoadouts(name); setStatus(`“${name}” saved on this device.`);
  });
  deleteButton.addEventListener('click', () => {
    const name = loadoutSelect.value;
    if (!name) { setStatus('Choose a saved loadout first.', true); return; }
    local.presets = local.presets.filter(item => item.name !== name);
    if (!saveLocal(storage, local)) { setStatus('Loadout could not be deleted.', true); return; }
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
      const merged = new Map(local.presets.map(item => [item.name.toLocaleLowerCase(), item]));
      for (const item of incoming.slice(0, 30)) {
        const name = cleanString(item?.name, 32);
        if (!name || !item?.filter || typeof item.filter !== 'object') continue;
        merged.set(name.toLocaleLowerCase(), { name, filter: normalizeFilter(item.filter) });
      }
      local.presets = [...merged.values()].slice(0, 30);
      if (!saveLocal(storage, local)) throw new Error('Loadouts could not be saved in this browser.');
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
  closeButton.addEventListener('click', close);

  function open() {
    if (destroyed) return;
    writeForm(refresh());
    priorFocus = document.activeElement;
    overlay.hidden = false;
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
    countryPicker.render(); badgePicker.render(); renderTrackRules();
    groupCodeInput.value = cleanString(safeCall(getGroupCode, groupCodeInput.value), 6);
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

  return Object.freeze({ open, close, refresh, destroy });
}
