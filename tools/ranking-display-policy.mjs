export const ROLLING_HILLS_COMMUNITY_ID = 'fb769ac2ea77e8f19a21a9dd3071742f2342bd49c41e4748d7e8c7903d4f0778';

export const TOP_TRACK_SCOPE_OPTIONS = Object.freeze([
  Object.freeze({value: 'all', label: 'ALL'}),
  Object.freeze({value: 'non-official', label: 'NON-OFFICIAL'}),
  Object.freeze({value: 'community', label: 'COMMUNITY'}),
  Object.freeze({value: 'extra', label: 'EXTRAS'})
]);

export function normalizeTopTrackScope(scope) {
  if (scope === 'extras') return 'extra';
  return TOP_TRACK_SCOPE_OPTIONS.some(option => option.value === scope) ? scope : 'all';
}

function membership(values) {
  return new Set(Array.isArray(values) || values instanceof Set ? values : []);
}

/** Canonical registries/trackInfo classify tracks, never a ranking row's type label. */
export function selectTopTrackRows(rows, scope = 'all', {
  officialTrackIds = [], communityTrackIds = [], extraTrackIds = [],
  extraTrackInfoById = null, trackInfo = null
} = {}) {
  if (!Array.isArray(rows)) return [];
  const selected = normalizeTopTrackScope(scope);
  if (selected === 'all') return rows.slice();
  const official = membership(officialTrackIds), community = membership(communityTrackIds), extra = membership(extraTrackIds);
  return rows.filter(row => {
    const id = typeof row?.trackId === 'string' ? row.trackId : typeof row?.userId === 'string' ? row.userId : '';
    if (!id) return false;
    let kind;
    // Top Tracks grouping is presentation policy, not an RP/completion policy change.
    if (id === ROLLING_HILLS_COMMUNITY_ID) kind = 'community';
    else if (extra.has(id) || extraTrackInfoById instanceof Map && extraTrackInfoById.has(id)) kind = 'extra';
    else if (official.has(id)) kind = 'official';
    else if (community.has(id)) kind = 'community';
    else kind = typeof trackInfo === 'function' ? trackInfo(id)?.type : null;
    return selected === 'non-official' ? kind === 'community' || kind === 'extra' : kind === selected;
  });
}

const unknown = reason => ({known: false, value: null, eligible: false, reason});

export function positiveRankingMetric(state) {
  if (state?.known !== true || typeof state.value !== 'number' || !Number.isFinite(state.value)) return unknown('metric_unavailable');
  return {known: true, value: state.value, eligible: state.value > 0, reason: state.value > 0 ? 'positive_metric' : 'nonpositive_metric'};
}

export function accountAgeRankingMetric(entry, {now = Date.now()} = {}) {
  const created = entry?.accountCreatedAt;
  if (!Number.isSafeInteger(now) || now <= 0 || !Number.isSafeInteger(created) || created <= 0 || created > now) return unknown('account_age_unavailable');
  return positiveRankingMetric({known: true, value: now - created});
}

export function podiumPointsRankingMetric(entry) {
  const medals = entry?.medals;
  if (!medals || typeof medals !== 'object' || Array.isArray(medals)) return unknown('medal_counts_unavailable');
  let present = false, points = 0;
  for (const [key, weight] of [['gold', 9], ['silver', 3], ['bronze', 1]]) {
    if (!Object.hasOwn(medals, key)) continue;
    present = true;
    if (!Number.isSafeInteger(medals[key]) || medals[key] < 0) return unknown('invalid_medal_count');
    points += medals[key] * weight;
    if (!Number.isSafeInteger(points)) return unknown('invalid_medal_count');
  }
  return present ? positiveRankingMetric({known: true, value: points}) : unknown('medal_counts_unavailable');
}

const DIRECT_METRICS = Object.freeze({
  tracks: ['raceCount'], official: ['officialCount'], community: ['communityCount'],
  wins: ['trackWins'], podiumRate: ['podiumRate'], weight: ['weightedTracks'],
  pbs: ['pbCount'], playtime: ['totalPlaytimeMs'], skill: ['skillCost'], consistency: ['consistencyCost']
});

/** Supply metricState for scope/group/local/experimental calculations; no score is invented. */
export function rankingRowEligibility(entry, category, options = {}) {
  const {now = Date.now(), metricState} = options;
  if (category === 'veterans') return accountAgeRankingMetric(entry, {now});
  if (category === 'medals') return podiumPointsRankingMetric(entry);
  // These metrics are costs: zero can mean perfect, but never fabricate samples.
  if (['overall', 'skill', 'consistency'].includes(category)) {
    if (!Number.isSafeInteger(entry?.raceCount) || entry.raceCount <= 0) return unknown('cost_samples_unavailable');
    const field = {skill: 'skillCost', consistency: 'consistencyCost'}[category];
    const state = Object.hasOwn(options, 'metricState') ? metricState :
      field ? {known: Object.hasOwn(entry, field), value: entry[field]} : undefined;
    if (state?.known !== true || typeof state.value !== 'number' || !Number.isFinite(state.value) || state.value < 0) return unknown('metric_unavailable');
    return {known: true, value: state.value, eligible: true, reason: 'known_cost_with_samples'};
  }
  if (Object.hasOwn(options, 'metricState')) return positiveRankingMetric(metricState);
  const fields = DIRECT_METRICS[category];
  if (!fields) return unknown('explicit_metric_state_required');
  for (const field of fields) {
    if (!Object.hasOwn(entry || {}, field)) continue;
    if (['tracks', 'official', 'community', 'wins', 'pbs'].includes(category) && !Number.isSafeInteger(entry[field])) return unknown('invalid_count');
    return positiveRankingMetric({known: typeof entry[field] === 'number' && Number.isFinite(entry[field]), value: entry[field]});
  }
  return unknown('metric_unavailable');
}

export function filterEligibleRankingRows(rows, category, {now = Date.now(), metricFor} = {}) {
  if (!Array.isArray(rows)) return [];
  return rows.filter(entry => rankingRowEligibility(entry, category, {
    now, ...(typeof metricFor === 'function' ? {metricState: metricFor(entry, category)} : {})
  }).eligible);
}

/** Call after existing category sorting; global ranks remain separate and unchanged. */
export function rankEligibleCategoryRows(rows, category, options = {}) {
  return filterEligibleRankingRows(rows, category, options).map((entry, index) => ({
    ...entry, globalRank: entry.globalRank ?? entry.rank ?? null, categoryRank: index + 1
  }));
}

const integerRp = new Intl.NumberFormat('en-US', {minimumFractionDigits: 0, maximumFractionDigits: 0, useGrouping: true});

export function formatFieldRp(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value === 0 ? '0' : integerRp.format(value) : 'N/A';
}
