import test from 'node:test';
import assert from 'node:assert/strict';
import {
  exportGroupFilterCode,
  filterGroupRows,
  hasGroupFilters,
  importGroupFilterCode,
  groupFilterRuleCounts,
  normalizeGroupFilter,
  recalculateGroupScores,
  prepareGroupFilterData
} from './filter-groups.mjs';

test('normalizes bounded canonical fields and ignores unknown fields', () => {
  const filter = normalizeGroupFilter({
    mode: 'smart', scope: 'overall', grading: 'group', missing: 'include',
    countryCodes: ['us', 'GB', 'USA'], groupCodes: ['123456', '12345x'],
    whitelist: Array.from({ length: 140 }, (_, index) => `user-${index}`),
    playtimeHoursMin: '2', joinedAfter: 123, color: '#AABBCC', colorLevel: 'everywhere',
    showNotice: false, hideUncustomized: true, createdAt: 100, loadedAt: 200,
    trackWeights: [{ trackId: 'T', weight: 3 }, { trackId: 'T', weight: 9 }, { trackId: 'X', weight: 1001 }], unknown: 'ignored'
  });
  assert.equal(filter.mode, 'smart');
  assert.equal(filter.scope, 'overall');
  assert.equal(filter.grading, 'group');
  assert.equal(filter.missing, 'include');
  assert.deepEqual(filter.countryCodes, ['US', 'GB']);
  assert.deepEqual(filter.groupCodes, ['123456']);
  assert.equal(filter.whitelist.length, 128);
  assert.equal(filter.playtimeHoursMin, null);
  assert.equal(filter.color, '#aabbcc');
  assert.equal(filter.colorLevel, 'everywhere');
  assert.equal(filter.showNotice, false);
  assert.equal(filter.hideUncustomized, true);
  assert.equal(filter.createdAt, 100);
  assert.equal(filter.loadedAt, 200);
  assert.deepEqual(filter.trackWeights, [{ trackId: 'T', weight: 3 }]);
  assert.equal(hasGroupFilters(filter), true);
});

test('share code roundtrips and rejects hostile, oversized, malformed, and inverted imports', () => {
  const filter = normalizeGroupFilter({
    countryCodes: ['ca'], badges: ['gold'], color: '#123ABC', colorLevel: 'menu',
    trackRules: [{ trackId: 'track-a', state: 'completed', minTimeMs: 1000 }]
  });
  const code = exportGroupFilterCode(filter);
  assert.ok(code.startsWith('PTFilter1.StaticQuasar931.'));
  assert.equal(JSON.parse(Buffer.from(code.slice('PTFilter1.StaticQuasar931.'.length), 'base64').toString()).marker, 'StaticQuasar931');
  assert.equal(importGroupFilterCode(code).color, filter.color);
  assert.equal(importGroupFilterCode(code).colorLevel, 'menu');
  assert.equal(importGroupFilterCode(code).createdAt, null);
  const legacy = `PTFilter1.${Buffer.from(JSON.stringify({ version: 1, filter: { whitelist: ['legacy'] } })).toString('base64')}`;
  const intermediate = `StaticQuasar931.${Buffer.from(JSON.stringify({ version: 1, filter: { whitelist: ['intermediate'] } })).toString('base64')}`;
  assert.deepEqual(importGroupFilterCode(legacy).whitelist, ['legacy']);
  assert.deepEqual(importGroupFilterCode(intermediate).whitelist, ['intermediate']);
  assert.equal(importGroupFilterCode(`PTFilter1.${'A'.repeat(50_000)}`), null);
  assert.equal(importGroupFilterCode('PTFilter1.not base64'), null);
  const invertedJson = JSON.stringify({ version: 1, filter: { tracksMin: 5, tracksMax: 2 } });
  const invertedCode = `PTFilter1.${Buffer.from(invertedJson).toString('base64')}`;
  assert.equal(importGroupFilterCode(invertedCode), null);
  assert.throws(() => exportGroupFilterCode({ winsMin: 3, winsMax: 1 }), /inverted/);
  const injected = JSON.stringify({ version: 1, filter: { whitelist: [], unexpected: 'ignored' }, command: 'execute' });
  assert.equal(importGroupFilterCode(`PTFilter1.${Buffer.from(injected).toString('base64')}`).unknown, undefined);
});

test('forced includes bypass every criterion except blacklist', () => {
  const rows = [
    { accountId: 'a', countryCode: 'US', color: '#112233' },
    { accountId: 'b', countryCode: 'CA', color: '#445566' }
  ];
  const included = filterGroupRows(rows, {
    whitelist: ['a'], forcedIncludes: ['b'], countryCodes: ['US'], color: '#112233'
  });
  assert.deepEqual(included.rows.map(row => row.accountId), ['a', 'b']);
  const blocked = filterGroupRows(rows, {
    whitelist: ['a'], forcedIncludes: ['b'], blacklist: ['b']
  });
  assert.deepEqual(blocked.rows.map(row => row.accountId), ['a']);
});

test('loadout color settings are metadata and never affect group membership or rule counts', () => {
  const rows = [
    { accountId: 'a', color: '#ff0000', colorLevel: 'menu' },
    { accountId: 'b', color: '#00ff00', colorLevel: 'everywhere' }
  ];
  const filter = { color: '#FF0000', colorLevel: 'menu' };
  const result = filterGroupRows(rows, filter);
  assert.deepEqual(result.rows.map(row => row.accountId), ['a', 'b']);
  assert.equal(result.active, false);
  assert.deepEqual(groupFilterRuleCounts(rows, filter).rules, []);
  assert.equal(hasGroupFilters(filter), false);
  assert.equal(normalizeGroupFilter({ color: 'red' }).color, null);
  assert.equal(normalizeGroupFilter({ colorLevel: 2 }).colorLevel, 'dropdown');
  assert.equal(normalizeGroupFilter({}).showNotice, true);
});

test('hide uncustomized checks non-default cosmetic selections, not metadata or object presence', () => {
  const rows = [
    { accountId: 'default', profileCosmetics: { version: 99, theme: 'classic', accent: 'cyan', badge: 'betaTester', title: 'auto', betaTester: true } },
    { accountId: 'empty', profileCosmetics: {} },
    { accountId: 'custom', profileCosmetics: { version: 1, theme: 'ocean', badge: 'auto' } }
  ];
  assert.deepEqual(filterGroupRows(rows, { hideUncustomized: true }).rows.map(row => row.accountId), ['custom']);
});

test('track weight-only configuration activates smart scoring but not membership filtering', () => {
  assert.equal(hasGroupFilters({ mode: 'normal', trackWeights: [{ trackId: 'T', weight: 2 }] }), false);
  assert.equal(hasGroupFilters({ mode: 'smart', trackWeights: [{ trackId: 'T', weight: 2 }] }), true);
  assert.equal(hasGroupFilters({ mode: 'smart', trackRules: [{ trackId: 'T', state: 'any', weight: 2 }] }), true);
});

test('per-rule counts distinguish raw qualification from qualification conditional on other rules', () => {
  const rows = [
    { accountId: 'a', countryCode: 'US' }, { accountId: 'b', countryCode: 'CA' },
    { accountId: 'c', countryCode: 'US' }, { accountId: 'd', countryCode: 'CA' }
  ];
  const counts = groupFilterRuleCounts(rows, { whitelist: ['a', 'b'], countryCodes: ['US'] });
  assert.equal(counts.sourceCount, 4);
  assert.deepEqual(counts.rules.map(rule => ({
    key: rule.key, qualifiedCount: rule.qualifiedCount, sourceCount: rule.sourceCount,
    conditionalQualifiedCount: rule.conditionalQualifiedCount, othersQualifiedCount: rule.othersQualifiedCount
  })), [
    { key: 'whitelist', qualifiedCount: 2, sourceCount: 4, conditionalQualifiedCount: 1, othersQualifiedCount: 2 },
    { key: 'countryCodes', qualifiedCount: 2, sourceCount: 4, conditionalQualifiedCount: 1, othersQualifiedCount: 2 }
  ]);
});

test('per-rule range counts keep paired bounds together and handle max-only ranges and joined dates', () => {
  const rows = [
    { accountId: 'a', wins: 1, accountCreatedAt: 1000 },
    { accountId: 'b', wins: 5, accountCreatedAt: 2000 },
    { accountId: 'c', wins: 9, accountCreatedAt: 3000 },
    { accountId: 'd', wins: 7, accountCreatedAt: 4000 }
  ];
  const paired = groupFilterRuleCounts(rows, {
    winsMin: 3, winsMax: 7, joinedAfter: 1500, joinedBefore: 3500
  });
  assert.deepEqual(paired.rules.map(rule => ({
    key: rule.key, qualifiedCount: rule.qualifiedCount, sourceCount: rule.sourceCount,
    conditionalQualifiedCount: rule.conditionalQualifiedCount, othersQualifiedCount: rule.othersQualifiedCount
  })), [
    { key: 'winsMin', qualifiedCount: 2, sourceCount: 4, conditionalQualifiedCount: 1, othersQualifiedCount: 2 },
    { key: 'joinedAfter', qualifiedCount: 2, sourceCount: 4, conditionalQualifiedCount: 1, othersQualifiedCount: 2 }
  ]);

  const maxOnly = groupFilterRuleCounts(rows, { winsMax: 7, joinedBefore: 2000 });
  assert.deepEqual(maxOnly.rules.map(rule => ({ key: rule.key, qualifiedCount: rule.qualifiedCount })), [
    { key: 'winsMin', qualifiedCount: 3 },
    { key: 'joinedAfter', qualifiedCount: 2 }
  ]);
});

test('country, badges, sharing groups, and profile ID joins filter without coercing absent values', () => {
  const rows = [
    { accountId: 'a', rp: 100, countryCode: 'US', profileCosmetics: { badge: 'veteran' } },
    { userId: 'b', rp: 80 },
    { publicId: 'c', rp: 70, countryCode: 'CA', badges: ['gold'] },
    { accountId: 'd', rp: 60, countryCode: 'US' }
  ];
  const result = filterGroupRows(rows, { countryCodes: ['us'], badges: ['veteran'] }, {
    profiles: [{ publicId: 'b', countryCode: 'US', badges: ['veteran'] }]
  });
  assert.deepEqual(result.rows.map(row => row.accountId || row.userId || row.publicId), ['a', 'b']);
  assert.equal(result.missingCount, 1);
  assert.equal(result.incomplete, true);
  assert.deepEqual(filterGroupRows(rows, { countryCodes: ['ca'] }).rows.map(row => row.publicId), ['c']);
});

test('joined date, playtime, and overall-only scope are explicit', () => {
  const rows = [
    { accountId: 'a', totalPlaytimeMs: 7_200_000, accountCreatedAt: 1000, rp: 10, timeMs: 900 },
    { accountId: 'b', accountCreatedAt: 1000, rp: 5, timeMs: 1100 }
  ];
  const range = filterGroupRows(rows, { playtimeHoursMin: 2, joinedAfter: 500, joinedBefore: 1500 });
  assert.deepEqual(range.rows.map(row => row.accountId), ['a']);
  assert.equal(range.missingCount, 1);
  const overall = filterGroupRows(rows, { scope: 'overall', whitelist: ['a'] }, { trackId: 'track' });
  assert.equal(overall.active, false);
  assert.equal(overall.filteredCount, 2);
  const overallEventTotals = filterGroupRows(rows, { scope: 'overall', whitelist: ['a'] }, { event: true, overall: true });
  assert.equal(overallEventTotals.filteredCount, 1);
});

test('missing completion is unknown unless the exact track cache is declared complete', () => {
  const rows = [{ accountId: 'a', rp: 4 }, { accountId: 'b', rp: 3 }];
  const filter = { trackRules: [{ trackId: 'T', state: 'missing' }] };
  const partial = filterGroupRows(rows, filter);
  assert.equal(partial.filteredCount, 0);
  assert.equal(partial.incomplete, true);
  const complete = filterGroupRows(rows, filter, { complete: ['T'] });
  assert.equal(complete.filteredCount, 2);
  assert.equal(complete.incomplete, false);
  const knownFinish = filterGroupRows(rows, filter, {
    complete: ['T'], finishes: [{ accountId: 'a', trackId: 'T', timeMs: 900 }]
  });
  assert.deepEqual(knownFinish.rows.map(row => row.accountId), ['b']);
});

test('prepared profile and finish indexes are reusable across filter calls', () => {
  const prepared = prepareGroupFilterData({
    profiles: [{ accountId: 'a', countryCode: 'CA' }],
    finishes: [{ accountId: 'a', trackId: 'T', timeMs: 900 }]
  });
  assert.ok(prepared.profileIndex instanceof Map);
  assert.ok(prepared.finishIndex instanceof Map);
  const rows = [{ accountId: 'a', rp: 5 }];
  const options = {
    profileIndex: prepared.profileIndex,
    finishIndex: prepared.finishIndex,
    profiles: [{ accountId: 'a', countryCode: 'US' }],
    finishes: [],
    complete: ['T']
  };
  const byProfile = filterGroupRows(rows, { countryCodes: ['CA'] }, options);
  assert.equal(byProfile.filteredCount, 1);
  const byFinish = filterGroupRows(rows, { trackRules: [{ trackId: 'T', state: 'completed' }] }, options);
  assert.equal(byFinish.filteredCount, 1);
  assert.equal(byFinish.missingCount, 0);
});

test('track and event group ranks preserve global rank and use integer competition ranks on ties', () => {
  const rows = [
    { accountId: 'a', rank: 1, globalRank: 9, timeMs: 1000 },
    { accountId: 'b', rank: 2, globalRank: 10, timeMs: 1000 },
    { accountId: 'c', rank: 3, globalRank: 11, timeMs: 1200 }
  ];
  const result = filterGroupRows(rows, { blacklist: ['c'] }, { trackId: 'T' });
  assert.deepEqual(result.rows.map(row => row.groupRank), [1, 1]);
  assert.deepEqual(result.rows.map(row => row.globalRank), [9, 10]);
  assert.deepEqual(result.rows.map(row => row.rank), [1, 2]);
});

test('RP bounds always use original score and never depend on recomputed group RP', () => {
  const rows = [{ accountId: 'a', score: 45, globalScore: 46, rp: 10, groupRp: 90 }];
  const normal = filterGroupRows(rows, { rpMin: 40 });
  assert.equal(normal.rows[0].rp, 10);
  assert.equal(filterGroupRows(rows, { mode: 'smart', rpMin: 40 }).filteredCount, 1);
  assert.equal(filterGroupRows(rows, { mode: 'smart', rpMin: 46 }).filteredCount, 0);
  assert.equal(filterGroupRows([{ accountId: 'b', groupRp: 100 }], { mode: 'smart', rpMin: 0 }).missingCount, 1);
  assert.equal(filterGroupRows([{ accountId: 'c', rp: 50 }], { rpMin: 40 }).filteredCount, 1);
});

test('group scoring uses the exact softened placement cost, weighted average, ties, and isolated fields', () => {
  const rows = [
    { accountId: 'a', rp: 100, globalRank: 1 },
    { accountId: 'b', rp: 90, globalRank: 2 },
    { accountId: 'c', rp: 80, globalRank: 3 }
  ];
  const result = recalculateGroupScores(rows, ['a', 'b', 'c'], {
    boards: [{ trackId: 'T', weight: 2, complete: true, entries: [
      { accountId: 'a', timeMs: 100 }, { accountId: 'b', timeMs: 100 }, { accountId: 'c', timeMs: 200 }
    ] }]
  });
  assert.equal(result.complete, true);
  assert.equal(result.knownTracks, 1);
  assert.deepEqual(result.rows.map(row => row.groupFinishes[0].rank), [1, 1, 3]);
  const expected = 50 + (2 / 8) * (100 * (1 - 1) / 2 - 50);
  assert.equal(result.rows[0].groupCost, expected);
  assert.equal(result.rows[0].groupRp, 100 - expected);
  assert.equal(result.rows[0].rp, 100);
  assert.equal(result.rows[0].globalRank, 1);
  assert.equal(result.rows[0].groupWeightedCost, expected * 2);
});

test('local score recalculation honors bounded track weight overrides without changing source boards', () => {
  const board = { trackId: 'T', weight: 2, complete: true, entries: [
    { accountId: 'a', timeMs: 100 }, { accountId: 'b', timeMs: 200 }
  ] };
  const result = recalculateGroupScores([{ accountId: 'a' }], ['a'], {
    boards: [board], trackRules: [{ trackId: 'T', state: 'any', weight: 3 }]
  });
  assert.equal(result.rows[0].groupWeightSum, 3);
  assert.equal(board.weight, 2);
});

test('single-racer cost is 50, empty caches are incomplete, and event RP needs explicit maxRp', () => {
  const row = { accountId: 'solo', rp: 12 };
  const empty = recalculateGroupScores([row], ['solo'], { boards: [] });
  assert.equal(empty.complete, false);
  assert.equal(empty.rows[0].groupRp, null);
  const board = { trackId: 'event', weight: 1, complete: true, entries: [{ accountId: 'solo', timeMs: 1000 }] };
  const noCap = recalculateGroupScores([row], ['solo'], { boards: [board], event: true });
  assert.equal(noCap.rows[0].groupCost, 50);
  assert.equal(noCap.rows[0].groupRp, null);
  const withCap = recalculateGroupScores([row], ['solo'], { boards: [board], event: true, maxRp: 700 });
  assert.equal(withCap.rows[0].groupRp, 700);
  assert.equal(withCap.rows[0].rp, 12);
});

test('completion callback receives the track ID and empty group code is a known nonmember', () => {
  const rows = [{ accountId: 'a', groupCode: '', rp: 2 }, { accountId: 'b', rp: 1 }];
  const codeFilter = filterGroupRows(rows, { groupCodes: ['123456'] });
  assert.equal(codeFilter.filteredCount, 0);
  assert.equal(codeFilter.missingCount, 1);
  const missingTrack = filterGroupRows([{ accountId: 'a', rp: 1 }], {
    trackRules: [{ trackId: 'T', state: 'missing' }]
  }, { complete: trackId => trackId === 'T' });
  assert.equal(missingTrack.filteredCount, 1);
  assert.equal(missingTrack.incomplete, false);
});

test('joined date ignores createdAt when accountCreatedAt is absent', () => {
  const result = filterGroupRows([{ accountId: 'a', createdAt: 1000, rp: 5 }], { joinedAfter: 500 });
  assert.equal(result.filteredCount, 0);
  assert.equal(result.missingCount, 1);
});
