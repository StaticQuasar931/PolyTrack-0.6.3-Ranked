const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const CODE_PREFIX = 'PTFilter1.StaticQuasar931.';
const INTERMEDIATE_CODE_PREFIX = 'StaticQuasar931.';
const LEGACY_CODE_PREFIX = 'PTFilter1.';
const MAX_CODE_BYTES = 32 * 1024;
const MAX_ID_LIST = 128;
const MAX_LABEL_LIST = 32;
const MAX_GROUP_CODES = 16;
const MAX_TRACK_RULES = 8;
const MAX_TRACK_WEIGHT = 1000;
const MAX_TRACK_RULE_WEIGHT = 100;
const MAX_TRACK_WEIGHTS = 128;
const MAX_RANGE = 1_000_000_000_000;
const HOUR_MS = 3_600_000;

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function list(value) {
  return Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : [];
}

function uniqueStrings(value, limit, pattern = null, transform = value => value) {
  const result = [];
  const seen = new Set();
  for (const raw of list(value)) {
    if (typeof raw !== 'string') continue;
    const item = transform(raw.trim());
    if (!item || item.length > 128 || pattern && !pattern.test(item) || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
    if (result.length === limit) break;
  }
  return result;
}

function boundedNumber(value, maximum = MAX_RANGE) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum) return null;
  return value;
}

function epoch(value) {
  const number = boundedNumber(value, 8_640_000_000_000_000);
  return number !== null && Number.isSafeInteger(number) ? number : null;
}

function normalizeTrackRules(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();
  for (const raw of value) {
    const rule = asRecord(raw);
    const trackId = typeof rule.trackId === 'string' ? rule.trackId.trim().slice(0, 128) : '';
    if (!trackId || seen.has(trackId)) continue;
    const state = ['completed', 'missing', 'any'].includes(rule.state) ? rule.state : 'any';
    result.push({
      trackId,
      state,
      minTimeMs: boundedNumber(rule.minTimeMs),
      maxTimeMs: boundedNumber(rule.maxTimeMs),
      weight: boundedNumber(rule.weight, MAX_TRACK_RULE_WEIGHT)
    });
    seen.add(trackId);
    if (result.length === MAX_TRACK_RULES) break;
  }
  return result;
}

function normalizeTrackWeights(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();
  for (const raw of value) {
    const rule = asRecord(raw);
    const trackId = typeof rule.trackId === 'string' ? rule.trackId.trim().slice(0, 128) : '';
    const weight = boundedNumber(rule.weight, MAX_TRACK_WEIGHT);
    if (!trackId || seen.has(trackId) || weight === null) continue;
    result.push(Object.freeze({ trackId, weight }));
    seen.add(trackId);
    if (result.length === MAX_TRACK_WEIGHTS) break;
  }
  return result;
}

function normalizedColor(value) {
  if (typeof value !== 'string') return null;
  const color = value.trim();
  return /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(color) ? color.toLowerCase() : null;
}

export function normalizeGroupFilter(input = {}) {
  const source = asRecord(input);
  return Object.freeze({
    enabled: source.enabled !== false,
    mode: source.mode === 'smart' ? 'smart' : 'normal',
    scope: source.scope === 'overall' ? 'overall' : 'all',
    grading: source.grading === 'group' ? 'group' : 'global',
    missing: source.missing === 'include' ? 'include' : 'exclude',
    whitelist: Object.freeze(uniqueStrings(source.whitelist, MAX_ID_LIST, ID_PATTERN)),
    blacklist: Object.freeze(uniqueStrings(source.blacklist, MAX_ID_LIST, ID_PATTERN)),
    forcedIncludes: Object.freeze(uniqueStrings(source.forcedIncludes, MAX_ID_LIST, ID_PATTERN)),
    countryCodes: Object.freeze(uniqueStrings(source.countryCodes, MAX_LABEL_LIST, /^[A-Z]{2}$/, value => value.toUpperCase())),
    badges: Object.freeze(uniqueStrings(source.badges, MAX_LABEL_LIST)),
    groupCodes: Object.freeze(uniqueStrings(source.groupCodes, MAX_GROUP_CODES, /^\d{6}$/)),
    color: normalizedColor(source.color),
    colorLevel: ['dropdown', 'menu', 'everywhere'].includes(source.colorLevel) ? source.colorLevel : 'dropdown',
    hideUncustomized: source.hideUncustomized === true,
    showNotice: source.showNotice !== false,
    createdAt: epoch(source.createdAt),
    loadedAt: epoch(source.loadedAt),
    trackWeights: Object.freeze(normalizeTrackWeights(source.trackWeights)),
    rpMin: boundedNumber(source.rpMin),
    rpMax: boundedNumber(source.rpMax),
    playtimeHoursMin: boundedNumber(source.playtimeHoursMin),
    playtimeHoursMax: boundedNumber(source.playtimeHoursMax),
    tracksMin: boundedNumber(source.tracksMin),
    tracksMax: boundedNumber(source.tracksMax),
    winsMin: boundedNumber(source.winsMin),
    winsMax: boundedNumber(source.winsMax),
    daysActiveMin: boundedNumber(source.daysActiveMin),
    daysActiveMax: boundedNumber(source.daysActiveMax),
    joinedAfter: epoch(source.joinedAfter),
    joinedBefore: epoch(source.joinedBefore),
    trackRules: Object.freeze(normalizeTrackRules(source.trackRules).map(rule => Object.freeze(rule)))
  });
}

function hasRange(filter, minimum, maximum) {
  return filter[minimum] !== null || filter[maximum] !== null;
}

export function hasGroupFilters(input) {
  const filter = normalizeGroupFilter(input);
  const hasTrackCriterion = filter.trackRules.some(rule => rule.state !== 'any' || rule.minTimeMs !== null || rule.maxTimeMs !== null);
  const hasSmartWeight = filter.mode === 'smart' && (filter.trackWeights.length > 0 || filter.trackRules.some(rule => rule.weight !== null));
  return filter.whitelist.length > 0 || filter.blacklist.length > 0 || filter.forcedIncludes.length > 0 || filter.countryCodes.length > 0 ||
    filter.badges.length > 0 || filter.groupCodes.length > 0 || filter.hideUncustomized || hasTrackCriterion || hasSmartWeight ||
    ['rpMin', 'rpMax', 'playtimeHoursMin', 'playtimeHoursMax', 'tracksMin', 'tracksMax', 'winsMin', 'winsMax',
      'daysActiveMin', 'daysActiveMax', 'joinedAfter', 'joinedBefore'].some(key => filter[key] !== null);
}

function inverted(input, filter) {
  const ranges = [
    ['rpMin', 'rpMax'], ['playtimeHoursMin', 'playtimeHoursMax'], ['tracksMin', 'tracksMax'],
    ['winsMin', 'winsMax'], ['daysActiveMin', 'daysActiveMax'], ['joinedAfter', 'joinedBefore']
  ];
  return ranges.some(([min, max]) => filter[min] !== null && filter[max] !== null && filter[min] > filter[max]);
}

function encodeBase64(bytes) {
  if (typeof globalThis.btoa === 'function') {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return globalThis.btoa(binary);
  }
  return Buffer.from(bytes).toString('base64');
}

function decodeBase64(value) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  try {
    if (typeof globalThis.atob === 'function') {
      const binary = globalThis.atob(value);
      return Uint8Array.from(binary, character => character.charCodeAt(0));
    }
    return Uint8Array.from(Buffer.from(value, 'base64'));
  } catch {
    return null;
  }
}

export function exportGroupFilterCode(input) {
  const filter = normalizeGroupFilter(input);
  if (inverted(input, filter)) throw new TypeError('Filter ranges cannot be inverted');
  const sharedFilter = { ...filter, createdAt: null, loadedAt: null };
  const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, marker: 'StaticQuasar931', filter: sharedFilter }));
  if (bytes.byteLength > MAX_CODE_BYTES) throw new RangeError('Filter code exceeds 32 KB');
  return CODE_PREFIX + encodeBase64(bytes);
}

export function importGroupFilterCode(code) {
  if (typeof code !== 'string') return null;
  const prefix = code.startsWith(CODE_PREFIX) ? CODE_PREFIX :
    code.startsWith(INTERMEDIATE_CODE_PREFIX) ? INTERMEDIATE_CODE_PREFIX :
      code.startsWith(LEGACY_CODE_PREFIX) ? LEGACY_CODE_PREFIX : null;
  if (!prefix || code.length > Math.ceil(MAX_CODE_BYTES / 3) * 4 + prefix.length) return null;
  const bytes = decodeBase64(code.slice(prefix.length));
  if (!bytes || bytes.byteLength > MAX_CODE_BYTES) return null;
  try {
    const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!payload || payload.version !== 1 || !payload.filter || typeof payload.filter !== 'object' || Array.isArray(payload.filter)) return null;
    const filter = normalizeGroupFilter(payload.filter);
    if (inverted(payload.filter, filter)) return null;
    return filter;
  } catch {
    return null;
  }
}

function safeValue(object, key) {
  try {
    return object?.[key];
  } catch {
    return undefined;
  }
}

function rowId(row) {
  for (const key of ['accountId', 'userId', 'publicId']) {
    const value = safeValue(row, key);
    if (typeof value === 'string' && ID_PATTERN.test(value)) return value;
  }
  return null;
}

function indexById(values) {
  const index = new Map();
  if (values instanceof Map) {
    for (const [key, value] of values) if (typeof key === 'string') index.set(key, value);
    return index;
  }
  if (Array.isArray(values)) {
    for (const value of values) {
      const id = rowId(value);
      if (id) index.set(id, value);
    }
  }
  return index;
}

function mergedProfile(row, profiles) {
  const id = rowId(row);
  const profile = id ? profiles.get(id) : null;
  return profile && typeof profile === 'object' ? { ...profile, ...row } : row;
}

function metric(source, keys, { integer = false } = {}) {
  for (const key of keys) {
    const value = safeValue(source, key);
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || integer && !Number.isSafeInteger(value)) continue;
    return value;
  }
  return null;
}

function finishIndex(finishes) {
  const result = new Map();
  const add = (id, finish) => {
    const trackId = safeValue(finish, 'trackId');
    if (typeof id !== 'string' || typeof trackId !== 'string' || !trackId) return;
    const timeMs = metric(finish, ['timeMs']);
    if (!result.has(id)) result.set(id, new Map());
    if (timeMs !== null) result.get(id).set(trackId, { ...finish, timeMs });
  };
  if (finishes instanceof Map) {
    for (const [id, value] of finishes) {
      if (Array.isArray(value)) for (const finish of value) add(id, finish);
      else if (value instanceof Map) for (const [trackId, finish] of value) add(id, { ...finish, trackId });
      else if (value && typeof value === 'object') {
        for (const [trackId, finish] of Object.entries(value)) add(id, { ...finish, trackId });
      }
    }
  } else if (Array.isArray(finishes)) {
    for (const finish of finishes) add(rowId(finish), finish);
  }
  return result;
}

export function prepareGroupFilterData({ profiles, finishes } = {}) {
  return {
    profileIndex: indexById(profiles),
    finishIndex: finishIndex(finishes)
  };
}

function isComplete(options, metricName, trackId) {
  if (options.complete === true) return true;
  if (options.complete instanceof Set) return options.complete.has(trackId ?? metricName);
  if (Array.isArray(options.complete)) return options.complete.includes(trackId ?? metricName);
  if (typeof options.complete === 'function') {
    try {
      const result = options.complete(trackId ?? metricName, metricName);
      return result === true || result?.complete === true;
    } catch {
      return false;
    }
  }
  if (typeof options.isComplete === 'function') {
    try {
      return options.isComplete(metricName, trackId) === true;
    } catch {
      return false;
    }
  }
  return false;
}

function listHasAny(value, choices) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return values.some(item => choices.includes(item));
}

function badgesFor(profile) {
  const badges = new Set();
  const add = value => {
    if (typeof value === 'string' && value) badges.add(value);
    else if (value && typeof value === 'object') {
      for (const key of ['id', 'badgeId', 'badge']) {
        const item = safeValue(value, key);
        if (typeof item === 'string' && item) badges.add(item);
      }
    }
  };
  const raw = safeValue(profile, 'badges');
  if (Array.isArray(raw)) raw.forEach(add);
  else if (raw && typeof raw === 'object') Object.keys(raw).filter(key => raw[key]).forEach(add);
  add(safeValue(safeValue(profile, 'profileCosmetics'), 'badge'));
  return badges;
}

function matchesRange(value, minimum, maximum) {
  return value !== null && (minimum === null || value >= minimum) && (maximum === null || value <= maximum);
}

const DEFAULT_PROFILE_COSMETICS = Object.freeze({
  theme: 'classic', accent: 'cyan', finish: 'gradient', plate: 'block', edge: 'accent', stage: 'garage',
  stageTint: 'natural', stripe: 'standard', emblem: 'none', emblem2: 'none', emblem3: 'none',
  emblemBackdrop: 'none', stageEffect: 'none', nameFont: 'classic', nameSize: 'normal',
  nameWeight: 'regular', nameColor: 'default', baseSecondary: 'auto'
});

function hasNonDefaultCosmetics(profile) {
  const cosmetics = safeValue(profile, 'profileCosmetics');
  if (!cosmetics || typeof cosmetics !== 'object' || Array.isArray(cosmetics)) return false;
  return Object.entries(DEFAULT_PROFILE_COSMETICS).some(([key, defaultValue]) => {
    const selected = safeValue(cosmetics, key);
    return selected !== undefined && selected !== null && selected !== defaultValue;
  });
}

function addMissing(missing, id, reason) {
  missing.push({ id, reason });
}

function compareRow(row, filter, options, profiles, finishes, missing) {
  const id = rowId(row);
  const profile = mergedProfile(row, profiles);
  const note = reason => addMissing(missing, id, reason);
  const unknown = reason => {
    note(reason);
    return filter.missing === 'include';
  };

  if (filter.blacklist.length) {
    if (!id) {
      if (!unknown('identity unavailable')) return false;
    } else {
      if (filter.blacklist.includes(id)) return false;
    }
  }

  if (id && filter.forcedIncludes.includes(id)) return true;

  if (filter.whitelist.length) {
    if (!id) {
      if (!unknown('identity unavailable')) return false;
    } else if (!filter.whitelist.includes(id)) return false;
  }

  if (filter.countryCodes.length) {
    const country = safeValue(profile, 'countryCode');
    if (typeof country !== 'string' || !country.trim()) {
      if (!unknown('country unavailable')) return false;
    } else if (!filter.countryCodes.includes(country.toUpperCase())) return false;
  }

  if (filter.badges.length) {
    const badges = badgesFor(profile);
    const hasBadgeData = Array.isArray(safeValue(profile, 'badges')) ||
      typeof safeValue(safeValue(profile, 'profileCosmetics'), 'badge') === 'string' ||
      safeValue(profile, 'badges') && typeof safeValue(profile, 'badges') === 'object';
    if (!hasBadgeData) {
      if (!unknown('badges unavailable')) return false;
    } else if (!filter.badges.some(badge => badges.has(badge))) return false;
  }

  if (filter.hideUncustomized && !hasNonDefaultCosmetics(profile)) return false;

  if (filter.groupCodes.length) {
    const groups = safeValue(profile, 'groupCodes') ?? safeValue(profile, 'groupCode');
    const values = Array.isArray(groups) ? groups : typeof groups === 'string' ? [groups] : [];
    if (!values.length) {
      const knownGroupMetadata = own(profile, 'groupCodes') || own(profile, 'groupCode');
      if (knownGroupMetadata) return false;
      if (!unknown('group code unavailable')) return false;
    } else if (!filter.groupCodes.some(code => values.includes(code))) return false;
  }

  const rpMin = filter.rpMin;
  const rpMax = filter.rpMax;
  if (rpMin !== null || rpMax !== null) {
    const hasOriginalScore = own(profile, 'score') || own(profile, 'globalScore');
    const rp = metric(profile, ['score', 'globalScore']) ?? (hasOriginalScore ? null : metric(profile, ['rp']));
    if (!matchesRange(rp, rpMin, rpMax)) {
      if (rp === null) {
        if (!unknown(filter.mode === 'smart' ? 'group RP unavailable' : 'RP unavailable')) return false;
      } else return false;
    }
  }

  const ranges = [
    ['playtimeHoursMin', 'playtimeHoursMax', ['totalPlaytimeMs'], value => value / HOUR_MS, 'playtime unavailable'],
    ['tracksMin', 'tracksMax', ['tracksCompleted', 'raceCount', 'eligibleTrackCount'], value => value, 'track count unavailable'],
    ['winsMin', 'winsMax', ['trackWins', 'wins'], value => value, 'win count unavailable'],
    ['daysActiveMin', 'daysActiveMax', ['daysActive', 'activeDays'], value => value, 'active days unavailable']
  ];
  for (const [min, max, keys, transform, reason] of ranges) {
    if (!hasRange(filter, min, max)) continue;
    const value = metric(profile, keys, { integer: min !== 'playtimeHoursMin' });
    if (value === null) {
      if (!unknown(reason)) return false;
    } else if (!matchesRange(transform(value), filter[min], filter[max])) return false;
  }

  if (filter.joinedAfter !== null || filter.joinedBefore !== null) {
    const joined = metric(profile, ['accountCreatedAt'], { integer: true });
    if (joined === null) {
      if (!unknown('joined date unavailable')) return false;
    } else if (!matchesRange(joined, filter.joinedAfter, filter.joinedBefore)) return false;
  }

  for (const rule of filter.trackRules) {
    if (rule.state === 'any' && rule.minTimeMs === null && rule.maxTimeMs === null) continue;
    const finish = id ? finishes.get(id)?.get(rule.trackId) : null;
    if (finish) {
      if (rule.state === 'missing') return false;
      if (!matchesRange(finish.timeMs, rule.minTimeMs, rule.maxTimeMs)) return false;
      continue;
    }
    const complete = isComplete(options, 'track', rule.trackId);
    if (rule.state === 'completed' || rule.minTimeMs !== null || rule.maxTimeMs !== null) {
      if (complete) return false;
      if (!unknown(`finish cache incomplete for ${rule.trackId}`)) return false;
    } else if (rule.state === 'missing') {
      if (!complete) {
        if (!unknown(`finish cache incomplete for ${rule.trackId}`)) return false;
      }
    }
  }
  return true;
}

const CRITERION_FIELDS = [
  'whitelist', 'blacklist', 'countryCodes', 'badges', 'groupCodes',
  'hideUncustomized', 'rpMin', 'rpMax', 'playtimeHoursMin', 'playtimeHoursMax', 'tracksMin', 'tracksMax',
  'winsMin', 'winsMax', 'daysActiveMin', 'daysActiveMax', 'joinedAfter', 'joinedBefore', 'trackRules'
];

function filterForCriterion(filter, key, trackRuleIndex = -1) {
  const result = { ...filter };
  result.forcedIncludes = [];
  const retained = new Set([key]);
  for (const [minimum, maximum] of [
    ['rpMin', 'rpMax'], ['playtimeHoursMin', 'playtimeHoursMax'], ['tracksMin', 'tracksMax'],
    ['winsMin', 'winsMax'], ['daysActiveMin', 'daysActiveMax'], ['joinedAfter', 'joinedBefore']
  ]) if (key === minimum || key === maximum) {
    retained.add(minimum);
    retained.add(maximum);
  }
  for (const field of CRITERION_FIELDS) {
    if (retained.has(field)) continue;
    if (field === 'trackRules') {
      result.trackRules = trackRuleIndex >= 0 ? [filter.trackRules[trackRuleIndex]] : [];
    } else if (['whitelist', 'blacklist', 'forcedIncludes', 'countryCodes', 'badges', 'groupCodes'].includes(field)) {
      result[field] = [];
    } else if (field === 'hideUncustomized') result[field] = false;
    else result[field] = null;
  }
  if (key === 'trackRules') result.trackRules = [filter.trackRules[trackRuleIndex]];
  return result;
}

function configuredCriteria(filter) {
  const criteria = [];
  const add = (key, label, index = -1) => criteria.push({
    key: index >= 0 ? `trackRules[${index}]` : key,
    label,
    filter: filterForCriterion(filter, key, index)
  });
  for (const key of ['whitelist', 'blacklist', 'countryCodes', 'badges', 'groupCodes']) {
    if (filter[key].length) add(key, key);
  }
  if (filter.hideUncustomized) add('hideUncustomized', 'hideUncustomized');
  for (const [minimum, maximum, label] of [
    ['rpMin', 'rpMax', 'rp'], ['playtimeHoursMin', 'playtimeHoursMax', 'playtimeHours'],
    ['tracksMin', 'tracksMax', 'tracks'], ['winsMin', 'winsMax', 'wins'],
    ['daysActiveMin', 'daysActiveMax', 'daysActive'], ['joinedAfter', 'joinedBefore', 'joined']
  ]) if (filter[minimum] !== null || filter[maximum] !== null) add(minimum, label);
  filter.trackRules.forEach((rule, index) => {
    if (rule.state !== 'any' || rule.minTimeMs !== null || rule.maxTimeMs !== null) add('trackRules', `track:${rule.trackId}`, index);
  });
  return criteria;
}

export function groupFilterRuleCounts(rows, input, options = {}) {
  const filter = normalizeGroupFilter(input);
  const source = Array.isArray(rows) ? rows.filter(row => row && typeof row === 'object') : [];
  const criteria = configuredCriteria(filter);
  const profiles = options.profileIndex instanceof Map ? options.profileIndex : indexById(options.profiles);
  const finishes = options.finishIndex instanceof Map ? options.finishIndex : finishIndex(options.finishes);
  const passes = (row, candidate) => compareRow(row, candidate, options, profiles, finishes, []);
  const rules = criteria.map(criterion => {
    const raw = source.reduce((count, row) => count + Number(passes(row, criterion.filter)), 0);
    const othersFilter = { ...filter };
    if (criterion.key.startsWith('trackRules[')) {
      const index = Number(criterion.key.slice(11, -1));
      othersFilter.trackRules = filter.trackRules.filter((_, ruleIndex) => ruleIndex !== index);
    } else {
      const field = criterion.key;
      if (['whitelist', 'blacklist', 'countryCodes', 'badges', 'groupCodes'].includes(field)) othersFilter[field] = [];
      else if (field === 'hideUncustomized') othersFilter[field] = false;
      else if (field === 'rpMin') { othersFilter.rpMin = null; othersFilter.rpMax = null; }
      else if (field === 'playtimeHoursMin') { othersFilter.playtimeHoursMin = null; othersFilter.playtimeHoursMax = null; }
      else if (field === 'tracksMin') { othersFilter.tracksMin = null; othersFilter.tracksMax = null; }
      else if (field === 'winsMin') { othersFilter.winsMin = null; othersFilter.winsMax = null; }
      else if (field === 'daysActiveMin') { othersFilter.daysActiveMin = null; othersFilter.daysActiveMax = null; }
      else if (field === 'joinedAfter') { othersFilter.joinedAfter = null; othersFilter.joinedBefore = null; }
    }
    const others = source.filter(row => passes(row, othersFilter));
    const conditional = others.reduce((count, row) => count + Number(passes(row, criterion.filter)), 0);
    return { key: criterion.key, label: criterion.label, qualifiedCount: raw, sourceCount: source.length,
      conditionalQualifiedCount: conditional, othersQualifiedCount: others.length };
  });
  return { filter, sourceCount: source.length, rules };
}

function tieRanks(rows, valueOf) {
  const sorted = rows.map((row, index) => ({ row, index, value: valueOf(row) }))
    .sort((a, b) => (a.value ?? Infinity) - (b.value ?? Infinity) || a.index - b.index);
  const ranks = new Map();
  for (let index = 0; index < sorted.length;) {
    const value = sorted[index].value;
    let end = index + 1;
    while (end < sorted.length && value !== null && sorted[end].value === value) end++;
    const rank = index + 1;
    for (let cursor = index; cursor < end; cursor++) ranks.set(sorted[cursor].index, rank);
    index = end;
  }
  return ranks;
}

export function filterGroupRows(rows, input, options = {}) {
  const filter = normalizeGroupFilter(input);
  const source = Array.isArray(rows) ? rows.filter(row => row && typeof row === 'object') : [];
  const inScope = filter.scope === 'all' || options.overall === true || (!options.trackId && options.event !== true);
  const active = filter.enabled && inScope && hasGroupFilters(filter);
  if (!filter.enabled || !active) return {
    rows: source.slice(), filter, sourceCount: source.length, filteredCount: source.length,
    active: false, missingCount: 0, missingReasons: [], incomplete: false
  };

  const profiles = options.profileIndex instanceof Map ? options.profileIndex : indexById(options.profiles);
  const finishes = options.finishIndex instanceof Map ? options.finishIndex : finishIndex(options.finishes);
  const missing = [];
  const selected = source.filter(row => compareRow(row, filter, options, profiles, finishes, missing));
  let outputRows = selected.map(row => ({ ...row, globalRank: Number.isSafeInteger(row.globalRank) ? row.globalRank : Number.isSafeInteger(row.rank) ? row.rank : null }));
  if (options.trackId || options.event) {
    const ranks = tieRanks(outputRows, row => metric(row, ['timeMs']));
    outputRows = outputRows.map((row, index) => ({ ...row, groupRank: ranks.get(index) ?? null }));
  } else if (filter.grading === 'group') {
    const ranks = tieRanks(outputRows, row => {
      const score = filter.mode === 'smart' ? metric(row, ['groupRp']) : metric(row, ['globalRp', 'rp']);
      return score === null ? null : -score;
    });
    outputRows = outputRows.map((row, index) => ({ ...row, groupRank: ranks.get(index) ?? null }));
  }
  const reasonCounts = new Map();
  for (const item of missing) reasonCounts.set(item.reason, (reasonCounts.get(item.reason) || 0) + 1);
  const incomplete = missing.length > 0 || (filter.trackRules.some(rule => rule.state === 'missing') &&
    filter.trackRules.some(rule => !isComplete(options, 'track', rule.trackId)));
  return {
    rows: outputRows,
    filter,
    sourceCount: source.length,
    filteredCount: outputRows.length,
    active: true,
    missingCount: missing.length,
    missingReasons: [...reasonCounts].map(([reason, count]) => ({ reason, count })),
    incomplete
  };
}

function boardEntryId(entry) {
  return rowId(entry);
}

function placementCost(rank, fieldSize) {
  if (fieldSize < 2) return 50;
  return 50 + ((fieldSize - 1) / (fieldSize + 5)) * (100 * (rank - 1) / (fieldSize - 1) - 50);
}

export function recalculateGroupScores(rows, filteredIds, options = {}) {
  const selectedIds = filteredIds instanceof Set ? filteredIds : new Set(Array.isArray(filteredIds) ? filteredIds : []);
  const source = Array.isArray(rows) ? rows : [];
  const boards = Array.isArray(options.boards) ? options.boards : [];
  const normalizedWeights = normalizeGroupFilter({ trackWeights: options.trackWeights, trackRules: options.trackRules });
  const weightOverrides = new Map(normalizedWeights.trackRules.filter(rule => rule.weight !== null).map(rule => [rule.trackId, rule.weight]));
  for (const override of normalizedWeights.trackWeights) weightOverrides.set(override.trackId, override.weight);
  const accumulators = new Map();
  for (const row of source) {
    const id = rowId(row);
    if (!id || !selectedIds.has(id)) continue;
    accumulators.set(id, { row, finishes: [], weightedCost: 0, weightSum: 0 });
  }

  const missingTracks = [];
  let knownTracks = 0;
  for (const board of boards) {
    const trackId = typeof board?.trackId === 'string' ? board.trackId : '';
    const boardWeight = weightOverrides.has(trackId) ? weightOverrides.get(trackId) : board?.weight;
    const weight = typeof boardWeight === 'number' && Number.isFinite(boardWeight) && boardWeight > 0 ? boardWeight : null;
    const entries = Array.isArray(board?.entries) ? board.entries.filter(entry => entry && typeof entry === 'object') : [];
    const boardComplete = board?.complete === true || isComplete(options, 'board', trackId);
    if (!trackId || !weight || !boardComplete) {
      if (trackId) missingTracks.push(trackId);
      continue;
    }
    const deduped = new Map();
    for (const entry of entries) {
      const id = boardEntryId(entry);
      const timeMs = metric(entry, ['timeMs']);
      if (!id || timeMs === null || !accumulators.has(id)) continue;
      const prior = deduped.get(id);
      if (!prior || timeMs < prior.timeMs) deduped.set(id, { ...entry, timeMs, id });
    }
    if (!deduped.size) {
      knownTracks++;
      continue;
    }
    const ordered = [...deduped.values()].sort((a, b) => a.timeMs - b.timeMs);
    const ranks = new Map();
    for (let index = 0; index < ordered.length;) {
      let end = index + 1;
      while (end < ordered.length && ordered[end].timeMs === ordered[index].timeMs) end++;
      const rank = index + 1;
      for (let cursor = index; cursor < end; cursor++) ranks.set(ordered[cursor].id, rank);
      index = end;
    }
    const fieldSize = ordered.length;
    for (const entry of ordered) {
      const rank = ranks.get(entry.id);
      const cost = placementCost(rank, fieldSize);
      const accumulator = accumulators.get(entry.id);
      const finish = { trackId, rank, fieldSize, timeMs: entry.timeMs, weight, placementCost: cost };
      accumulator.finishes.push(finish);
      accumulator.weightedCost += cost * weight;
      accumulator.weightSum += weight;
    }
    knownTracks++;
  }

  const eventScoring = options.event === true && typeof options.maxRp === 'number' && Number.isFinite(options.maxRp) && options.maxRp > 0;
  const eventTimes = [...accumulators.values()].flatMap(accumulator => accumulator.finishes.map(finish => finish.timeMs));
  const firstEventTime = eventScoring && eventTimes.length ? Math.min(...eventTimes) : null;
  const output = [];
  for (const [id, accumulator] of accumulators) {
    const groupCost = accumulator.weightSum > 0 ? accumulator.weightedCost / accumulator.weightSum : null;
    output.push({
      ...accumulator.row,
      groupFinishes: accumulator.finishes,
      groupWeightedCost: accumulator.weightedCost,
      groupWeightSum: accumulator.weightSum,
      groupCost,
      groupRp: options.event
        ? eventScoring && firstEventTime !== null && accumulator.finishes.length
          ? Math.floor(options.maxRp * firstEventTime / Math.min(...accumulator.finishes.map(finish => finish.timeMs)))
          : null
        : groupCost === null ? null : 100 - groupCost
    });
  }
  return {
    rows: output,
    complete: boards.length > 0 && missingTracks.length === 0 && options.complete !== false,
    knownTracks,
    missingTracks: [...new Set(missingTracks)]
  };
}
