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
const CATEGORY_LABELS = Object.freeze({ overall: 'Overall RP', casual: 'Casual RP' });

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

export function inspectRankedFilterAvailability(rows, isComplete) {
  const source = Array.isArray(rows) ? rows : [];
  const snapshot = explicitComplete(isComplete, 'snapshot', source);
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
    const declared = snapshot && explicitComplete(isComplete, metric, source);
    const present = source.length > 0 && source.every(hasValue);
    availability[metric] = {
      available: declared && present,
      reason: !snapshot ? 'Complete snapshot required' : !declared ? 'Metric completeness was not declared' : !present ? 'Metric is unavailable in this snapshot' : ''
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
  const availability = inspectRankedFilterAvailability(source, options.isComplete);
  const required = activeMetrics(validation.value);
  const hasActiveFilter = required.size > 0 || validation.value.category !== 'overall';
  const unavailable = validation.errors.map(reason => ({ metric: 'filter', reason }));
  if (hasActiveFilter && !availability.snapshot.available) unavailable.push({ metric: 'snapshot', reason: availability.snapshot.reason });
  for (const metric of required) if (!availability[metric].available) unavailable.push({ metric, reason: availability[metric].reason });
  if (hasActiveFilter && !explicitComplete(options.isComplete, `category:${validation.value.category}`, source)) {
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

  const panel = document.createElement('details');
  panel.className = 'ranked-filter-panel';
  addText(document, panel, 'summary', 'Leaderboard filters');
  const form = document.createElement('form');
  form.className = 'ranked-filter-form';
  form.style.display = 'grid';
  form.style.gridTemplateColumns = 'repeat(auto-fit,minmax(150px,1fr))';
  form.style.gap = '8px';
  form.style.padding = '8px 0';
  panel.append(form);

  const categoryLabel = addText(document, form, 'label', 'Category');
  categoryLabel.style.display = 'grid';
  const category = document.createElement('select');
  category.name = 'category';
  for (const value of categories) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = CATEGORY_LABELS[value] || value.replace(/([A-Z])/g, ' $1').replace(/^./, letter => letter.toUpperCase());
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
    const unavailable = addText(document, group, 'small', 'Unavailable in this snapshot');
    unavailable.hidden = true;
    form.append(group);
    metricInputs[metric] = { group, min, max, unavailable };
  }

  const listInputs = {};
  for (const [name, label] of [['whitelist', 'Only public IDs'], ['blacklist', 'Exclude public IDs']]) {
    const field = addText(document, form, 'label', label);
    field.style.display = 'grid';
    const input = document.createElement('textarea');
    input.name = name; input.rows = 2; input.placeholder = 'Comma or space separated'; input.style.resize = 'vertical';
    field.append(input); listInputs[name] = { field, input };
  }

  const actions = document.createElement('div');
  actions.style.display = 'flex'; actions.style.flexWrap = 'wrap'; actions.style.gap = '6px'; actions.style.alignItems = 'end';
  const apply = addText(document, actions, 'button', 'Apply', 'button'); apply.type = 'submit';
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
  panel.append(presets);
  const status = addText(document, panel, 'p', '', 'ranked-filter-status');
  status.setAttribute('role', 'status');
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
  }

  function readForm() {
    const value = { category: category.value, verification: verification.value };
    for (const [, , minimum, maximum] of ranges) {
      value[minimum] = form.elements[minimum].value;
      value[maximum] = form.elements[maximum].value;
    }
    value.whitelist = listInputs.whitelist.input.value;
    value.blacklist = listInputs.blacklist.input.value;
    return validateRankedFilter(value, categories);
  }

  function refreshAvailability() {
    const available = inspectRankedFilterAvailability(rows, options.isComplete);
    for (const [metric, controls] of Object.entries(metricInputs)) {
      controls.group.disabled = !available[metric].available;
      controls.unavailable.hidden = available[metric].available;
    }
    const identityAvailable = available.identity.available;
    for (const controls of Object.values(listInputs)) {
      controls.input.disabled = !identityAvailable;
      controls.field.title = identityAvailable ? '' : available.identity.reason;
    }
    verification.options[1].disabled = !available.verification.available;
    verification.title = available.verification.available ? '' : available.verification.reason;
    return available;
  }

  function emit() {
    const result = filterRankedRows(rows, filter, { isComplete: options.isComplete, categories });
    status.textContent = result.available
      ? `${result.filteredCount} of ${result.sourceCount} racers shown`
      : `Filters unavailable: ${[...new Set(result.unavailable.map(item => `${item.metric}: ${item.reason}`))].join('; ')}`;
    options.onChange?.(result);
    return result;
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    const checked = readForm();
    if (checked.errors.length) { status.textContent = checked.errors.join('; '); return; }
    filter = checked.value;
    emit();
  });
  clear.addEventListener('click', () => { filter = normalizeRankedFilter({}, categories); writeForm(filter); emit(); });
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
    update(nextRows) { rows = Array.isArray(nextRows) ? nextRows : []; refreshAvailability(); return emit(); }
  });
}
