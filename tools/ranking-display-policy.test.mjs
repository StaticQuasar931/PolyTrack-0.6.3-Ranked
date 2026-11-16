import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLLING_HILLS_COMMUNITY_ID as RHR, TOP_TRACK_SCOPE_OPTIONS, normalizeTopTrackScope, selectTopTrackRows,
  positiveRankingMetric, accountAgeRankingMetric, podiumPointsRankingMetric, rankingRowEligibility,
  filterEligibleRankingRows, rankEligibleCategoryRows, formatFieldRp
} from './ranking-display-policy.mjs';

const now = Date.UTC(2026, 10, 16);
const options = {
  officialTrackIds: ['official', RHR], communityTrackIds: ['community'], extraTrackIds: new Set(['extra']),
  extraTrackInfoById: new Map([['dynamic-extra', {}]]),
  trackInfo: id => ({type: ({'legacy-community': 'community', 'custom': 'custom', 'official': 'official'})[id] || 'custom'})
};
const rows = ['official', 'community', 'extra', 'dynamic-extra', RHR, 'legacy-community', 'custom'].map((trackId, index) => Object.freeze({trackId, rank: index + 1, type: 'official'}));
const ids = rows => rows.map(row => row.trackId);

test('Top Tracks choices replace official-only with the four exact requested scopes', () => {
  assert.deepEqual(TOP_TRACK_SCOPE_OPTIONS.map(o => [o.value, o.label]), [
    ['all', 'ALL'], ['non-official', 'NON-OFFICIAL'], ['community', 'COMMUNITY'], ['extra', 'EXTRAS']
  ]);
  assert.equal(normalizeTopTrackScope('extras'), 'extra');
  assert.equal(normalizeTopTrackScope('official'), 'all');
  assert.equal(normalizeTopTrackScope('invalid'), 'all');
  assert(Object.isFrozen(TOP_TRACK_SCOPE_OPTIONS));
  assert(TOP_TRACK_SCOPE_OPTIONS.every(Object.isFrozen));
});

test('non-official is community including RHR plus extras, not arbitrary custom rows', () => {
  assert.deepEqual(ids(selectTopTrackRows(rows, 'non-official', options)), ['community', 'extra', 'dynamic-extra', RHR, 'legacy-community']);
  assert.deepEqual(ids(selectTopTrackRows(rows, 'community', options)), ['community', RHR, 'legacy-community']);
  assert.deepEqual(ids(selectTopTrackRows(rows, 'extra', options)), ['extra', 'dynamic-extra']);
  assert.deepEqual(ids(selectTopTrackRows(rows, 'all', options)), ids(rows));
});

test('canonical extras and RHR override legacy presentation labels and preserve source order', () => {
  assert.deepEqual(ids(selectTopTrackRows([{userId: 'extra'}, {trackId: RHR}], 'non-official', options)), [undefined, RHR]);
  assert.equal(selectTopTrackRows([{trackId: RHR}], 'community', {...options, extraTrackIds: [RHR]}).length, 1);
  assert.equal(selectTopTrackRows([{trackId: RHR}], 'extra', {...options, extraTrackIds: [RHR]}).length, 0);
  assert.equal(selectTopTrackRows([{trackId: 'custom', type: 'community'}], 'community', options).length, 0);
  assert.deepEqual(selectTopTrackRows(null, 'all', options), []);
  assert.deepEqual(selectTopTrackRows([null, {}, {trackId: ''}], 'community', options), []);
});

test('scope filtering does not mutate inputs or leak filtered ranks into global ranks', () => {
  const before = JSON.stringify(rows);
  const all = selectTopTrackRows(Object.freeze(rows), 'all', options);
  assert.notEqual(all, rows);assert.equal(all[0], rows[0]);
  assert.equal(JSON.stringify(rows), before);
});

test('missing, zero, invalid and future creation dates are not account-age competitors', () => {
  for (const accountCreatedAt of [undefined, null, 0, -1, '', String(now - 1000), NaN, Infinity, now + 1, now - .5]) {
    const row = accountCreatedAt === undefined ? {} : {accountCreatedAt};
    assert.equal(accountAgeRankingMetric(row, {now}).eligible, false, String(accountCreatedAt));
  }
  assert.equal(accountAgeRankingMetric({accountCreatedAt: now}, {now}).eligible, false);
  assert.equal(accountAgeRankingMetric({accountCreatedAt: now - 1}, {now}).value, 1);
  assert.equal(accountAgeRankingMetric({accountCreatedAt: 1}, {now}).eligible, true);
  assert.equal(accountAgeRankingMetric({accountCreatedAt: 1}, {now: NaN}).eligible, false);
});

test('zero podium points, absent counts and malformed counts cannot render/rank', () => {
  for (const medals of [undefined, null, {}, [], {gold: 0, silver: 0, bronze: 0}, {gold: '1'}, {silver: -1}, {bronze: .5}, {gold: Infinity}, {gold: Number.MAX_SAFE_INTEGER}]) {
    assert.equal(podiumPointsRankingMetric({medals}).eligible, false, JSON.stringify(medals));
  }
  assert.equal(podiumPointsRankingMetric({medals: {gold: 1}}).value, 9);
  assert.equal(podiumPointsRankingMetric({medals: {silver: 1}}).value, 3);
  assert.equal(podiumPointsRankingMetric({medals: {gold: 1, silver: 2, bronze: 3}}).value, 18);
});

test('all selected ranking metrics exclude unknown, zero, negative and nonnumeric states', () => {
  for (const value of [undefined, null, '', '5', 0, -1, NaN, Infinity]) assert.equal(positiveRankingMetric({known: true, value}).eligible, false);
  assert.equal(positiveRankingMetric({known: false, value: 99}).eligible, false);
  assert.equal(positiveRankingMetric({known: true, value: .01}).eligible, true);
  for (const [category, field] of Object.entries({tracks: 'raceCount', official: 'officialCount', community: 'communityCount', wins: 'trackWins', podiumRate: 'podiumRate', weight: 'weightedTracks', pbs: 'pbCount', playtime: 'totalPlaytimeMs'})) {
    assert.equal(rankingRowEligibility({}, category).eligible, false);
    assert.equal(rankingRowEligibility({[field]: 0}, category).eligible, false);
    assert.equal(rankingRowEligibility({[field]: 2}, category).eligible, true);
  }
});

for (const category of ['overall', 'skill', 'consistency']) test(category + ' retains a known perfect zero cost only with real positive sample count', () => {
  const samples = {raceCount: 3};
  for (const value of [0, .01, 1234]) {
    const state = rankingRowEligibility(samples, category, {metricState: {known: true, value}});
    assert.equal(state.eligible, true);assert.equal(state.value, value);
  }
  for (const raceCount of [undefined, null, 0, -1, .5, '3', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    for (const value of [0, 1234]) assert.equal(rankingRowEligibility({raceCount}, category, {metricState: {known: true, value}}).eligible, false);
  }
  for (const value of [undefined, null, '', '0', NaN, Infinity, -1]) assert.equal(rankingRowEligibility(samples, category, {metricState: {known: true, value}}).eligible, false);
  assert.equal(rankingRowEligibility(samples, category, {metricState: {known: false, value: 0}}).eligible, false);
  assert.equal(rankingRowEligibility(samples, category, {metricState: undefined}).eligible, false);
  assert.equal(rankingRowEligibility({raceCount: 0}, category, {metricState: {known: true, value: 0, count: 3}}).eligible, false);
  if (category !== 'overall') {
    const field = category === 'skill' ? 'skillCost' : 'consistencyCost';
    assert.equal(rankingRowEligibility({...samples, [field]: 0}, category).eligible, true);
    assert.equal(rankingRowEligibility({...samples, [field]: 5}, category).eligible, true);
    assert.equal(rankingRowEligibility({...samples, [field]: 5}, category, {metricState: {known: false, value: 5}}).eligible, false);
  } else {
    assert.equal(rankingRowEligibility({...samples, score: 0}, category).eligible, false, 'Overall still requires the actual resolved cost state');
  }
  const input = [{userId: 'empty', raceCount: 0}, {userId: 'perfect', raceCount: 3}, {userId: 'positive', raceCount: 4}];
  const metricFor = row => ({known: true, value: row.userId === 'positive' ? 10 : 0});
  assert.deepEqual(rankEligibleCategoryRows(input, category, {metricFor}).map(row => [row.userId, row.categoryRank]), [['perfect', 1], ['positive', 2]]);
});

test('perfect-cost exception does not admit zero count or positive-point metrics', () => {
  for (const category of ['tracks', 'official', 'community', 'wins', 'podiumRate', 'weight', 'pbs', 'playtime', 'field', 'casual']) {
    assert.equal(rankingRowEligibility({raceCount: 3}, category, {metricState: {known: true, value: 0}}).eligible, false, category);
  }
  assert.equal(rankingRowEligibility({raceCount: 3, medals: {gold: 0, silver: 0, bronze: 0}}, 'medals').eligible, false);
});

test('scope-aware calculated metrics must use their explicit known state, not a stale row value', () => {
  assert.equal(rankingRowEligibility({trackWins: 5}, 'wins', {metricState: {known: false, value: null}}).eligible, false);
  assert.equal(rankingRowEligibility({trackWins: 5}, 'wins', {metricState: undefined}).eligible, false);
  assert.equal(rankingRowEligibility({trackWins: 5}, 'wins', {metricState: {known: true, value: 0}}).eligible, false);
  assert.equal(rankingRowEligibility({score: 500}, 'field').eligible, false);
  assert.equal(rankingRowEligibility({}, 'field', {metricState: {known: true, value: 123.4}}).eligible, true);
  for (const [category, field] of [['tracks', 'raceCount'], ['wins', 'trackWins'], ['pbs', 'pbCount']]) assert.equal(rankingRowEligibility({[field]: .5}, category).eligible, false);
});

test('filter before category ranks/pagination; preserve global rank and source rows', () => {
  const input = Object.freeze([
    Object.freeze({userId: 'zero', rank: 1, medals: {gold: 0}}),
    Object.freeze({userId: 'a', rank: 8, medals: {bronze: 1}}),
    Object.freeze({userId: 'missing', rank: 9}),
    Object.freeze({userId: 'b', rank: 20, globalRank: 15, medals: {gold: 1}})
  ]);
  const filtered = filterEligibleRankingRows(input, 'medals');
  const ranked = rankEligibleCategoryRows(input, 'medals');
  assert.equal(filtered.length, 2);
  assert.deepEqual(ranked.map(r => [r.userId, r.categoryRank, r.globalRank]), [['a', 1, 8], ['b', 2, 15]]);
  assert.equal(input[1].categoryRank, undefined);
  assert.deepEqual(filterEligibleRankingRows(null, 'medals'), []);
});

test('account age filter and displayed rank population agree for known positive ages', () => {
  const input = [{userId: 'unknown'}, {userId: 'zero', accountCreatedAt: 0}, {userId: 'known', accountCreatedAt: now - 1000}];
  const ranked = rankEligibleCategoryRows(input, 'veterans', {now});
  assert.deepEqual(ranked.map(r => [r.userId, r.categoryRank]), [['known', 1]]);
});

test('calculated metric eligibility uses the same callback for all rows', () => {
  const input = [{userId: 'a'}, {userId: 'b'}, {userId: 'c'}];
  const metricFor = row => ({known: row.userId !== 'c', value: row.userId === 'a' ? 0 : 100});
  assert.deepEqual(filterEligibleRankingRows(input, 'field', {metricFor}).map(r => r.userId), ['b']);
  assert.deepEqual(filterEligibleRankingRows([{trackWins: 5}], 'wins', {metricFor: () => undefined}), []);
});

test('Field RP is rounded to integers with stable en-US commas; missing is not zero', () => {
  for (const [value, text] of [[0, '0'], [1, '1'], [999.49, '999'], [999.5, '1,000'], [1234.56, '1,235'], [1234567, '1,234,567']]) assert.equal(formatFieldRp(value), text);
  for (const value of [undefined, null, '', '1234', NaN, Infinity, -1]) assert.equal(formatFieldRp(value), 'N/A');
  assert.equal(formatFieldRp(-0), '0');
});
