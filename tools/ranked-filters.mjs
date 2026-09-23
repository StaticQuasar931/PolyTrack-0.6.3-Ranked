export const RANKED_FILTER_STORAGE_KEY = 'polytrack-0.6.2-ranked-filter-presets-v1';
export const MAX_RANKED_FILTER_PRESETS = 8;
export const RANKED_FILTER_CATEGORIES = Object.freeze([
  'overall', 'average', 'competitiveAverage', 'tracks', 'medals', 'rising',
  'skill', 'consistency', 'wins', 'podiumRate', 'weight', 'pbs', 'playtime',
  'veterans', 'official', 'community', 'casual'
]);

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const RANGE_FIELDS = Object.freeze([
  ['winsMin', 'winsMax', 1000000, true],
  ['daysActiveMin', 'daysActiveMax', 1000000, true],
  ['playtimeHoursMin', 'playtimeHoursMax', 10000000, false],
  ['tracksMin', 'tracksMax', 1000000, true]
]);
const METRIC_FIELDS = Object.freeze({
  wins: ['trackWins'],
  daysActive: ['daysActive', 'activeDays'],
  playtime: ['totalPlaytimeMs'],
  tracksCompleted: ['tracksCompleted', 'raceCount']
});
export const RANKED_FILTER_CATEGORY_LABELS = Object.freeze({
  overall: 'Overall RP', average: 'Average place', competitiveAverage: 'Competitive average',
  tracks: 'Tracks completed', medals: 'Podium points', rising: 'Rising racers', skill: 'Best 10 skill',
  consistency: 'All-track depth', wins: 'Track wins', podiumRate: 'Podium rate',
  weight: 'Total track weight', pbs: 'PBs set', playtime: 'Active time',
  veterans: 'Racing longest', official: 'Official tracks', community: 'Community tracks', casual: 'Casual RP'
});

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function boundedNumber(value, maximum, integer) {
  if (value === '' || value === null || value === undefined) return null;
  const number = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(number) || number < 0 || number > maximum || integer && !Number.isSafeInteger(number)) return null;
  return number;
}

function normalizeIds(value) {
  const input = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : [];
  const seen = new Set();
  for (const item of input) {
    const id = String(item || '').trim();
    if (ID.test(id)) seen.add(id);
    if (seen.size >= 128) break;
  }
  return [...seen];
}

function normalizedUsername(value) {
  return typeof value === 'string' ? value.normalize('NFKC').trim().toLocaleLowerCase() : '';
}

function resolveRankedFilterUserIds(value, rows) {
  const entries = new Map();
  const knownIds = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = rowId(row);
    if (!id) continue;
    knownIds.add(id);
    const name = typeof row.name === 'string' ? row.name.trim().slice(0, 80) : '';
    if (!name) continue;
    const key = normalizedUsername(name);
    if (!entries.has(key)) entries.set(key, new Set());
    entries.get(key).add(id);
  }

  const ids = new Set();
  const errors = [];
  const resolveToken = token => {
    const candidate = token.trim();
    if (!candidate) return true;
    const matches = entries.get(normalizedUsername(candidate));
    if (matches?.size === 1) { ids.add(matches.values().next().value); return true; }
    if (matches?.size > 1) { errors.push(`Username "${candidate}" is ambiguous; choose an account from suggestions.`); return true; }
    if (knownIds.has(candidate)) { ids.add(candidate); return true; }
    return false;
  };

  for (const part of (Array.isArray(value) ? value : String(value || '').split(','))) {
    const candidate = String(part || '').trim();
    if (!candidate) continue;
    if (entries.has(normalizedUsername(candidate)) || knownIds.has(candidate)) {
      if (!resolveToken(candidate)) errors.push(`No loaded racer matches "${candidate}".`);
      continue;
    }
    const parts = candidate.split(/\s+/);
    if (parts.length > 1 && parts.every(part => knownIds.has(part) || entries.has(normalizedUsername(part)))) {
      for (const part of parts) resolveToken(part);
    } else {
      errors.push(`No loaded racer matches "${candidate}".`);
    }
  }
  return Object.freeze({ ids: Object.freeze([...ids].slice(0, 128)), errors: Object.freeze(errors) });
}

export function normalizeRankedFilter(input = {}, categories = RANKED_FILTER_CATEGORIES) {
  const allowed = new Set(Array.isArray(categories) ? categories : RANKED_FILTER_CATEGORIES);
  const filter = {
    category: allowed.has(input.category) ? input.category : 'overall',
    verification: input.verification === 'verified' ? 'verified' : 'all',
    whitelist: normalizeIds(input.whitelist),
    blacklist: normalizeIds(input.blacklist)
  };
  for (const [minimum, maximum, bound, integer] of RANGE_FIELDS) {
    filter[minimum] = boundedNumber(input[minimum], bound, integer);
    filter[maximum] = boundedNumber(input[maximum], bound, integer);
  }
  return Object.freeze(filter);
}

export function validateRankedFilter(input, categories = RANKED_FILTER_CATEGORIES) {
  const value = normalizeRankedFilter(input, categories);
  const errors = [];
  for (const [minimum, maximum, bound, integer] of RANGE_FIELDS) {
    for (const field of [minimum, maximum]) {
      const raw = input?.[field];
      if (raw !== '' && raw !== null && raw !== undefined && boundedNumber(raw, bound, integer) === null) errors.push(`${field}: invalid value`);
    }
    if (value[minimum] !== null && value[maximum] !== null && value[minimum] > value[maximum]) {
      errors.push(`${minimum.replace('Min', '')}: minimum exceeds maximum`);
    }
  }
  if (input?.category !== undefined && !new Set(categories).has(input.category)) errors.push('category: unsupported value');
  if (input?.verification !== undefined && !['all', 'verified'].includes(input.verification)) errors.push('verification: unsupported value');
  for (const field of ['whitelist', 'blacklist']) {
    const raw = input?.[field];
    const tokens = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,]+/) : [];
    if (tokens.some(token => String(token || '').trim() && !ID.test(String(token).trim()))) errors.push(`${field}: invalid public ID`);
  }
  return Object.freeze({ value, errors: Object.freeze(errors) });
}

function rowId(row) {
  for (const key of ['publicId', 'userId', 'accountId']) {
    const value = row?.[key];
    if (typeof value === 'string' && ID.test(value)) return value;
  }
  return null;
}

function metricValue(row, metric) {
  for (const key of METRIC_FIELDS[metric] || []) {
    if (!own(row, key)) continue;
    const value = row[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
    if (metric !== 'playtime' && !Number.isSafeInteger(value)) return null;
    return value;
  }
  return null;
}

function verifiedValue(row) {
  for (const key of ['runVerified', 'verified', 'integrityVerified']) {
    if (own(row, key)) return typeof row[key] === 'boolean' ? row[key] : null;
  }
  return null;
}

function explicitComplete(isComplete, metric, rows) {
  if (typeof isComplete !== 'function') return false;
  try {
    const result = isComplete(metric, rows);
    return result === true || result?.complete === true;
  } catch {
    return false;
  }
}

export function inspectRankedFilterAvailability(rows, isComplete, options = {}) {
  const source = Array.isArray(rows) ? rows : [];
  const snapshot = explicitComplete(isComplete, 'snapshot', source);
  const allowPartial = options.allowPartial === true;
  const availability = { snapshot: { available: snapshot, reason: snapshot ? '' : 'Complete snapshot required' } };
  const checks = {
    identity: row => rowId(row) !== null,
    rank: row => Number.isSafeInteger(row?.rank) && row.rank > 0,
    wins: row => metricValue(row, 'wins') !== null,
    daysActive: row => metricValue(row, 'daysActive') !== null,
    playtime: row => metricValue(row, 'playtime') !== null,
    tracksCompleted: row => metricValue(row, 'tracksCompleted') !== null,
    verification: row => verifiedValue(row) !== null
  };
  for (const [metric, hasValue] of Object.entries(checks)) {
    const declared = allowPartial || (snapshot && explicitComplete(isComplete, metric, source));
    const present = source.length > 0 && source.every(hasValue);
    availability[metric] = {
      available: declared && present,
      reason: !declared ? (snapshot ? 'Metric completeness was not declared' : 'Complete snapshot required') : !present ? (allowPartial ? 'Not included in the loaded rankings' : 'Metric is unavailable in this snapshot') : ''
    };
  }
  return Object.freeze(availability);
}

function activeMetrics(filter) {
  const metrics = new Set();
  if (filter.whitelist.length || filter.blacklist.length) metrics.add('identity');
  if (filter.winsMin !== null || filter.winsMax !== null) metrics.add('wins');
  if (filter.daysActiveMin !== null || filter.daysActiveMax !== null) metrics.add('daysActive');
  if (filter.playtimeHoursMin !== null || filter.playtimeHoursMax !== null) metrics.add('playtime');
  if (filter.tracksMin !== null || filter.tracksMax !== null) metrics.add('tracksCompleted');
  if (filter.verification === 'verified') metrics.add('verification');
  if (metrics.size || filter.category !== 'overall') metrics.add('rank');
  return metrics;
}

function inRange(value, minimum, maximum) {
  return (minimum === null || value >= minimum) && (maximum === null || value <= maximum);
}

function rankedRows(rows) {
  return rows.map((row, index) => ({
    ...row,
    globalRank: Number.isSafeInteger(row?.globalRank) && row.globalRank > 0
      ? row.globalRank
      : Number.isSafeInteger(row?.rank) && row.rank > 0 ? row.rank : null,
    filteredRank: index + 1,
    filteredTotal: rows.length
  }));
}

export function filterRankedRows(rows, input, options = {}) {
  const source = Array.isArray(rows) ? rows.filter(row => row && typeof row === 'object') : [];
  const validation = validateRankedFilter(input, options.categories);
  const allowPartial = options.allowPartial === true;
  const availability = inspectRankedFilterAvailability(source, options.isComplete, options);
  const required = activeMetrics(validation.value);
  const hasActiveFilter = required.size > 0 || validation.value.category !== 'overall';
  const unavailable = validation.errors.map(reason => ({ metric: 'filter', reason }));
  if (hasActiveFilter && !availability.snapshot.available && !allowPartial) unavailable.push({ metric: 'snapshot', reason: availability.snapshot.reason });
  for (const metric of required) if (!(allowPartial && metric === 'rank') && !availability[metric].available) unavailable.push({ metric, reason: availability[metric].reason });
  if (hasActiveFilter && !allowPartial && !explicitComplete(options.isComplete, `category:${validation.value.category}`, source)) {
    unavailable.push({ metric: 'category', reason: `${validation.value.category} category is unavailable in this snapshot` });
  }
  if (unavailable.length) return Object.freeze({
    rows: Object.freeze(source.slice()),
    sourceCount: source.length,
    filteredCount: source.length,
    filter: validation.value,
    availability,
    available: false,
    unavailable: Object.freeze(unavailable)
  });

  const whitelist = new Set(validation.value.whitelist);
  const blacklist = new Set(validation.value.blacklist);
  const filtered = source.filter(row => {
    const id = rowId(row);
    if (whitelist.size && !whitelist.has(id)) return false;
    if (blacklist.has(id)) return false;
    if (!inRange(metricValue(row, 'wins'), validation.value.winsMin, validation.value.winsMax)) return false;
    if (!inRange(metricValue(row, 'daysActive'), validation.value.daysActiveMin, validation.value.daysActiveMax)) return false;
    const playtimeHours = metricValue(row, 'playtime') / 3600000;
    if (!inRange(playtimeHours, validation.value.playtimeHoursMin, validation.value.playtimeHoursMax)) return false;
    if (!inRange(metricValue(row, 'tracksCompleted'), validation.value.tracksMin, validation.value.tracksMax)) return false;
    return validation.value.verification !== 'verified' || verifiedValue(row) === true;
  });
  return Object.freeze({
    rows: Object.freeze(hasActiveFilter ? rankedRows(filtered) : filtered.slice()),
    sourceCount: source.length,
    filteredCount: filtered.length,
    filter: validation.value,
    availability,
    available: true,
    unavailable: Object.freeze([])
  });
}

function normalizePreset(value, categories) {
  if (!value || typeof value !== 'object') return null;
  const name = typeof value.name === 'string' ? value.name.trim().slice(0, 32) : '';
  if (!name) return null;
  const checked = validateRankedFilter(value.filter, categories);
  if (checked.errors.length) return null;
  const updatedAt = Number.isSafeInteger(value.updatedAt) && value.updatedAt >= 0 ? value.updatedAt : 0;
  const id = typeof value.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value.id)
    ? value.id
    : `preset-${updatedAt.toString(36)}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'filter'}`;
  return Object.freeze({ id, name, filter: checked.value, updatedAt });
}

export function readRankedFilterPresets(storage = globalThis.localStorage, key = RANKED_FILTER_STORAGE_KEY, categories = RANKED_FILTER_CATEGORIES) {
  try {
    const parsed = JSON.parse(storage?.getItem(key) || 'null');
    const values = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.presets) ? parsed.presets : [];
    const unique = new Map();
    for (const value of values) {
      const preset = normalizePreset(value, categories);
      if (preset && !unique.has(preset.id)) unique.set(preset.id, preset);
    }
    return [...unique.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name)).slice(0, MAX_RANKED_FILTER_PRESETS);
  } catch {
    return [];
  }
}

function writePresets(storage, key, presets) {
  try {
    storage?.setItem(key, JSON.stringify({ version: 1, presets }));
    return true;
  } catch {
    return false;
  }
}

export function saveRankedFilterPreset(storage, value, key = RANKED_FILTER_STORAGE_KEY, categories = RANKED_FILTER_CATEGORIES) {
  const current = readRankedFilterPresets(storage, key, categories);
  const updatedAt = Date.now();
  const preset = normalizePreset({ ...value, updatedAt }, categories);
  if (!preset) return current;
  const remaining = current.filter(item => item.id !== preset.id && item.name.toLowerCase() !== preset.name.toLowerCase());
  const next = [preset, ...remaining].slice(0, MAX_RANKED_FILTER_PRESETS);
  return writePresets(storage, key, next) ? next : current;
}

export function deleteRankedFilterPreset(storage, id, key = RANKED_FILTER_STORAGE_KEY, categories = RANKED_FILTER_CATEGORIES) {
  const current = readRankedFilterPresets(storage, key, categories);
  const next = current.filter(preset => preset.id !== id);
  return writePresets(storage, key, next) ? next : current;
}

function addText(document, parent, tag, text, className = '') {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  parent.append(node);
  return node;
}

function addInput(document, parent, name, placeholder) {
  const input = document.createElement('input');
  input.type = 'number';
  input.name = name;
  input.min = '0';
  input.step = name.startsWith('playtime') ? '0.25' : '1';
  input.placeholder = placeholder;
  input.style.minWidth = '0';
  parent.append(input);
  return input;
}

/** Mounts a local-only filter panel. This module never performs network reads. */
export function mountRankedFilterPanel(options = {}) {
  const root = options.root;
  if (!root || typeof root.replaceChildren !== 'function') throw new TypeError('Filter root is required.');
  const document = root.ownerDocument;
  const categories = Array.isArray(options.categories) && options.categories.length ? options.categories : RANKED_FILTER_CATEGORIES;
  const storage = options.storage ?? globalThis.localStorage;
  let rows = Array.isArray(options.rows) ? options.rows : [];
  let filter = normalizeRankedFilter(options.initialFilter, categories);
  let enabled = true;

  const panel = document.createElement('details');
  panel.className = 'ranked-filter-panel';
  const summary = addText(document, panel, 'summary', 'Filters');
  const content = document.createElement('div');
  content.className = 'ranked-filter-content';
  panel.append(content);
  const activeIndicator = addText(document, summary, 'span', 'Inactive', 'ranked-filter-active');
  activeIndicator.setAttribute('aria-live', 'polite');
  activeIndicator.style.marginInlineStart = '8px';
  activeIndicator.style.padding = '2px 6px';
  activeIndicator.style.borderRadius = '999px';
  activeIndicator.style.fontSize = '0.75em';
  const form = document.createElement('form');
  form.className = 'ranked-filter-form';
  form.style.display = 'grid';
  form.style.gridTemplateColumns = 'repeat(auto-fit,minmax(220px,1fr))';
  form.style.gap = '14px';
  form.style.padding = '14px 0';
  content.append(form);

  const categoryLabel = addText(document, form, 'label', 'Category');
  categoryLabel.style.display = 'grid';
  const category = document.createElement('select');
  category.name = 'category';
  for (const value of categories) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = RANKED_FILTER_CATEGORY_LABELS[value] || value.replace(/([A-Z])/g, ' $1').replace(/^./, letter => letter.toUpperCase());
    category.append(option);
  }
  categoryLabel.append(category);

  const verificationLabel = addText(document, form, 'label', 'Runs');
  verificationLabel.style.display = 'grid';
  const verification = document.createElement('select');
  verification.name = 'verification';
  for (const [value, label] of [['all', 'All'], ['verified', 'Verified only']]) {
    const option = document.createElement('option'); option.value = value; option.textContent = label; verification.append(option);
  }
  verificationLabel.append(verification);

  const metricInputs = {};
  const ranges = [
    ['wins', 'Wins', 'winsMin', 'winsMax'],
    ['daysActive', 'Days active', 'daysActiveMin', 'daysActiveMax'],
    ['playtime', 'Playtime hours', 'playtimeHoursMin', 'playtimeHoursMax'],
    ['tracksCompleted', 'Tracks completed', 'tracksMin', 'tracksMax']
  ];
  for (const [metric, label, minimum, maximum] of ranges) {
    const group = document.createElement('fieldset');
    group.style.minWidth = '0';
    group.style.margin = '0';
    group.style.padding = '4px 6px';
    addText(document, group, 'legend', label);
    const pair = document.createElement('span');
    pair.style.display = 'grid'; pair.style.gridTemplateColumns = '1fr 1fr'; pair.style.gap = '4px';
    const min = addInput(document, pair, minimum, 'Min');
    const max = addInput(document, pair, maximum, 'Max');
    group.append(pair);
    const unavailable = addText(document, group, 'small', 'Not included in the loaded rankings');
    unavailable.hidden = true;
    form.append(group);
    metricInputs[metric] = { group, min, max, unavailable };
  }

  const suggestions = new Map();
  const filterInstanceId = Math.random().toString(36).slice(2);
  const listInputs = {};
  for (const [name, label] of [['whitelist', 'Only these racers'], ['blacklist', 'Exclude these racers']]) {
    const field = document.createElement('div');
    field.style.display = 'grid';
    field.style.position = 'relative';
    field.style.gap = '5px';
    const inputId = `ranked-filter-${filterInstanceId}-${name}`;
    const fieldLabel = addText(document, field, 'label', label);
    const input = document.createElement('input');
    input.id = inputId;
    input.name = name; input.type = 'text'; input.placeholder = 'Username or public ID, comma separated';
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('aria-autocomplete', 'list');
    fieldLabel.setAttribute('for', inputId);
    const popup = document.createElement('div');
    popup.id = `${inputId}-suggestions`;
    popup.className = 'ranked-filter-user-suggestions';
    popup.setAttribute('role', 'listbox');
    popup.hidden = true;
    input.setAttribute('aria-controls', popup.id);
    input.setAttribute('aria-expanded', 'false');
    Object.assign(popup.style, {
      position: 'absolute', insetInline: '0', top: '100%', zIndex: '20',
      maxHeight: '180px', overflowY: 'auto', padding: '6px',
      background: 'var(--ranked-filter-popup-bg, #20242b)',
      color: 'var(--ranked-filter-popup-fg, #fff)',
      border: '1px solid var(--ranked-filter-popup-border, #68717d)',
      borderRadius: '4px', boxShadow: '0 4px 12px rgba(0,0,0,.3)'
    });
    const selected = document.createElement('small');
    selected.className = 'ranked-filter-selected-users';
    selected.setAttribute('aria-live', 'polite');
    selected.style.lineHeight = '1.4';
    selected.style.padding = '4px 7px';
    selected.style.borderRadius = '4px';
    selected.style.background = 'rgba(67, 176, 112, 0.18)';
    selected.style.fontWeight = '600';
    selected.hidden = true;
    field.append(input, selected, popup);
    form.append(field);
    listInputs[name] = { field, input, popup, selected };
    suggestions.set(name, popup);
  }

  const actions = document.createElement('div');
  actions.style.display = 'flex'; actions.style.flexWrap = 'wrap'; actions.style.gap = '6px'; actions.style.alignItems = 'end';
  const apply = addText(document, actions, 'button', 'Apply', 'button'); apply.type = 'submit';
  const toggle = addText(document, actions, 'button', 'Pause filters', 'button ranked-filter-toggle'); toggle.type = 'button';
  toggle.setAttribute('aria-pressed', 'true');
  const clear = addText(document, actions, 'button', 'Clear', 'button'); clear.type = 'button';
  form.append(actions);

  const presets = document.createElement('div');
  presets.className = 'ranked-filter-presets';
  presets.style.display = 'flex'; presets.style.flexWrap = 'wrap'; presets.style.gap = '6px';
  const presetSelect = document.createElement('select'); presetSelect.setAttribute('aria-label', 'Saved filter preset');
  const presetName = document.createElement('input'); presetName.maxLength = 32; presetName.placeholder = 'Preset name'; presetName.setAttribute('aria-label', 'Preset name');
  const load = addText(document, presets, 'button', 'Load', 'button'); load.type = 'button';
  const save = addText(document, presets, 'button', 'Save', 'button'); save.type = 'button';
  const remove = addText(document, presets, 'button', 'Delete', 'button'); remove.type = 'button';
  presets.prepend(presetSelect, presetName);
  content.append(presets);
  const status = addText(document, content, 'p', '', 'ranked-filter-status');
  status.setAttribute('role', 'status');
  const scope = addText(document, content, 'p', '', 'ranked-filter-scope');
  root.replaceChildren(panel);

  function renderPresets(selected = '') {
    const values = readRankedFilterPresets(storage, options.storageKey, categories);
    presetSelect.replaceChildren();
    const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = values.length ? 'Choose preset' : 'No saved presets';
    presetSelect.append(placeholder);
    for (const preset of values) {
      const option = document.createElement('option'); option.value = preset.id; option.textContent = preset.name; presetSelect.append(option);
    }
    if (values.some(preset => preset.id === selected)) presetSelect.value = selected;
    return values;
  }

  function writeForm(value) {
    category.value = value.category;
    verification.value = value.verification;
    for (const [, , minimum, maximum] of ranges) {
      form.elements[minimum].value = value[minimum] ?? '';
      form.elements[maximum].value = value[maximum] ?? '';
    }
    listInputs.whitelist.input.value = value.whitelist.join(', ');
    listInputs.blacklist.input.value = value.blacklist.join(', ');
    for (const name of Object.keys(listInputs)) refreshSelectedUsers(name);
  }

  function loadedUsers() {
    const users = new Map();
    for (const row of rows) {
      const id = rowId(row);
      if (!id || users.has(id)) continue;
      const name = typeof row.name === 'string' ? row.name.trim().slice(0, 80) : '';
      users.set(id, name);
    }
    return users;
  }

  function refreshSelectedUsers(name) {
    const { input, selected } = listInputs[name];
    const ids = [...new Set([...filter[name], ...resolveRankedFilterUserIds(input.value, rows).ids])];
    const users = loadedUsers();
    selected.hidden = !ids.length;
    selected.textContent = ids.length
      ? `Selected (${ids.length}): ${ids.slice(0, 3).map(id => users.get(id) ? `${users.get(id)} (${id})` : id).join(', ')}${ids.length > 3 ? `, +${ids.length - 3} more` : ''}`
      : '';
  }

  function getUserSuggestions(query) {
    const search = normalizedUsername(query);
    return [...loadedUsers()].filter(([id, name]) => search &&
      (normalizedUsername(name).includes(search) || id.toLocaleLowerCase().includes(search)));
  }

  function refreshUserSuggestions(name) {
    const { input, popup } = listInputs[name];
    const raw = input.value;
    const prefix = raw.slice(0, raw.lastIndexOf(',') + 1);
    const query = raw.slice(raw.lastIndexOf(',') + 1).trim();
    const matches = getUserSuggestions(query);
    const selectedIds = new Set([...filter[name], ...resolveRankedFilterUserIds(prefix, rows).ids]);
    const available = matches.filter(([id]) => !selectedIds.has(id)).slice(0, 8);
    const selectedMatch = !available.length && (
      matches.find(([id, username]) => selectedIds.has(id) &&
        (normalizedUsername(username) === normalizedUsername(query) || id.toLocaleLowerCase() === query.toLocaleLowerCase())) ||
      (matches.length === 1 && selectedIds.has(matches[0][0]) ? matches[0] : null)
    );
    refreshSelectedUsers(name);
    popup.replaceChildren();
    popup.hidden = !query || (!available.length && !selectedMatch);
    input.setAttribute('aria-expanded', String(!popup.hidden));
    for (const [id, username] of selectedMatch ? [selectedMatch] : available) {
      const option = document.createElement('button');
      option.type = 'button';
      option.setAttribute('role', 'option');
      const alreadySelected = !!selectedMatch;
      option.textContent = `${username ? `${username} (${id})` : id}${alreadySelected ? ' - Already selected' : ''}`;
      option.disabled = alreadySelected;
      option.setAttribute('aria-selected', String(alreadySelected));
      option.style.display = 'block';
      option.style.width = '100%';
      option.style.textAlign = 'start';
      option.style.padding = '8px 10px';
      option.style.margin = '0';
      option.style.opacity = alreadySelected ? '0.7' : '1';
      if (alreadySelected) option.style.fontWeight = '600';
      option.addEventListener('mousedown', event => event.preventDefault());
      option.addEventListener('click', () => {
        if (alreadySelected) return;
        input.value = `${prefix ? `${prefix.trimEnd()} ` : ''}${id}, `;
        popup.hidden = true;
        input.setAttribute('aria-expanded', 'false');
        refreshSelectedUsers(name);
        input.focus();
      });
      popup.append(option);
    }
  }

  function refreshActiveIndicator() {
    const active = activeMetrics(filter).size > 0 || filter.category !== 'overall';
    activeIndicator.textContent = !enabled && active ? 'Paused' : active ? 'Filters active' : 'Inactive';
    activeIndicator.classList.toggle('is-active', enabled && active);
    activeIndicator.style.backgroundColor = enabled && active ? 'rgba(67, 176, 112, 0.2)' : 'rgba(128, 128, 128, 0.16)';
    activeIndicator.setAttribute('aria-label', !enabled && active ? 'Filters paused' : active ? 'Filters active' : 'No filters active');
    panel.dataset.active = String(enabled && active);
    toggle.textContent = enabled ? 'Pause filters' : 'Resume filters';
    toggle.setAttribute('aria-pressed', String(enabled));
  }

  function readForm() {
    const value = { category: category.value, verification: verification.value };
    for (const [, , minimum, maximum] of ranges) {
      value[minimum] = form.elements[minimum].value;
      value[maximum] = form.elements[maximum].value;
    }
    const whitelist = resolveRankedFilterUserIds(listInputs.whitelist.input.value, rows);
    const blacklist = resolveRankedFilterUserIds(listInputs.blacklist.input.value, rows);
    value.whitelist = whitelist.ids;
    value.blacklist = blacklist.ids;
    const checked = validateRankedFilter(value, categories);
    return Object.freeze({
      value: checked.value,
      errors: Object.freeze([
        ...whitelist.errors.map(error => `Only these racers: ${error}`),
        ...blacklist.errors.map(error => `Exclude these racers: ${error}`),
        ...checked.errors
      ])
    });
  }

  function refreshAvailability() {
    const available = inspectRankedFilterAvailability(rows, options.isComplete, options);
    for (const [metric, controls] of Object.entries(metricInputs)) {
      controls.group.disabled = !available[metric].available;
      controls.group.hidden = !available[metric].available;
      controls.unavailable.hidden = available[metric].available;
    }
    const identityAvailable = available.identity.available;
    for (const controls of Object.values(listInputs)) {
      controls.input.disabled = !identityAvailable;
      controls.field.title = identityAvailable ? '' : available.identity.reason;
    }
    verification.options[1].disabled = !available.verification.available;
    verification.title = available.verification.available ? '' : available.verification.reason;
    scope.textContent = available.snapshot.available ? '' : 'Filters use loaded racers only. Results may change as more racers load.';
    scope.hidden = available.snapshot.available;
    return available;
  }

  function emit() {
    refreshActiveIndicator();
    const applied = enabled ? filter : { category: filter.category };
    const result = filterRankedRows(rows, applied, { isComplete: options.isComplete, categories, allowPartial: options.allowPartial });
    status.textContent = !enabled
      ? `Filters paused. ${result.sourceCount} loaded racers shown.`
      : result.available
      ? `${result.filteredCount} of ${result.sourceCount} ${result.availability.snapshot.available ? 'racers shown' : 'loaded racers shown'}`
      : `${result.unavailable.some(item => item.metric === 'snapshot') ? 'Complete leaderboard snapshot unavailable. Filters were not applied. ' : ''}Filters unavailable: ${[...new Set(result.unavailable.map(item => `${item.metric}: ${item.reason}`))].join('; ')}`;
    options.onChange?.(result);
    return result;
  }

  for (const [name, controls] of Object.entries(listInputs)) {
    controls.input.addEventListener('input', () => refreshUserSuggestions(name));
    controls.input.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        controls.popup.hidden = true;
        controls.input.setAttribute('aria-expanded', 'false');
      }
    });
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    const checked = readForm();
    if (checked.errors.length) { status.textContent = checked.errors.join('; '); return; }
    filter = checked.value;
    enabled = true;
    emit();
  });
  toggle.addEventListener('click', () => { enabled = !enabled; emit(); });
  clear.addEventListener('click', () => { filter = normalizeRankedFilter({}, categories); enabled = true; writeForm(filter); emit(); });
  load.addEventListener('click', () => {
    const preset = readRankedFilterPresets(storage, options.storageKey, categories).find(value => value.id === presetSelect.value);
    if (!preset) { status.textContent = 'Choose a saved preset first.'; return; }
    filter = preset.filter; presetName.value = preset.name; writeForm(filter); emit();
  });
  save.addEventListener('click', () => {
    const checked = readForm();
    if (!presetName.value.trim() || checked.errors.length) { status.textContent = checked.errors[0] || 'Enter a preset name.'; return; }
    const values = saveRankedFilterPreset(storage, { id: presetSelect.value || undefined, name: presetName.value, filter: checked.value }, options.storageKey, categories);
    const saved = values.find(value => value.name.toLowerCase() === presetName.value.trim().toLowerCase());
    renderPresets(saved?.id); status.textContent = saved ? 'Preset saved locally.' : 'Preset could not be saved.';
  });
  remove.addEventListener('click', () => {
    if (!presetSelect.value) { status.textContent = 'Choose a saved preset first.'; return; }
    deleteRankedFilterPreset(storage, presetSelect.value, options.storageKey, categories); renderPresets(); presetName.value = ''; status.textContent = 'Preset deleted.';
  });

  writeForm(filter);
  renderPresets();
  refreshAvailability();
  const initialResult = emit();
  return Object.freeze({
    element: panel,
    initialResult,
    getFilter: () => filter,
    setFilter(value) { filter = normalizeRankedFilter(value, categories); writeForm(filter); return emit(); },
    update(nextRows) {
      rows = Array.isArray(nextRows) ? nextRows : [];
      for (const name of Object.keys(listInputs)) refreshSelectedUsers(name);
      refreshAvailability();
      return emit();
    }
  });
}
