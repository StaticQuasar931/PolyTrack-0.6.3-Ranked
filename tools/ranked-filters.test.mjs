import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_RANKED_FILTER_PRESETS,
  deleteRankedFilterPreset,
  filterRankedRows,
  inspectRankedFilterAvailability,
  normalizeRankedFilter,
  readRankedFilterPresets,
  saveRankedFilterPreset,
  validateRankedFilter
} from './ranked-filters.mjs';

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, value),
    value: key => values.get(key)
  };
}

const complete = () => true;
const rows = [
  { userId: 'alpha', rank: 3, trackWins: 5, daysActive: 20, totalPlaytimeMs: 10 * 3600000, raceCount: 12, runVerified: true },
  { userId: 'bravo', rank: 8, trackWins: 2, daysActive: 8, totalPlaytimeMs: 3 * 3600000, raceCount: 6, runVerified: false },
  { userId: 'charlie', rank: 11, trackWins: 8, daysActive: 40, totalPlaytimeMs: 30 * 3600000, raceCount: 20, runVerified: true }
];

test('normalization bounds values, public IDs and categories', () => {
  assert.deepEqual(normalizeRankedFilter({
    category: 'wins', verification: 'bad', winsMin: '-1', winsMax: '9', playtimeHoursMin: '1.5',
    whitelist: 'alpha, bad/id alpha bravo', blacklist: ['charlie', '', 'bad id']
  }), {
    category: 'wins', verification: 'all', whitelist: ['alpha', 'bravo'], blacklist: ['charlie'],
    winsMin: null, winsMax: 9, daysActiveMin: null, daysActiveMax: null,
    playtimeHoursMin: 1.5, playtimeHoursMax: null, tracksMin: null, tracksMax: null
  });
  assert.deepEqual(validateRankedFilter({ winsMin: 10, winsMax: 2 }).errors, ['wins: minimum exceeds maximum']);
  assert.deepEqual(validateRankedFilter({ winsMin: 'nope', whitelist: 'valid bad/id' }).errors,
    ['winsMin: invalid value', 'whitelist: invalid public ID']);
});

test('complete in-memory filtering preserves global rank and adds filtered rank', () => {
  const result = filterRankedRows(rows, {
    category: 'wins', winsMin: 4, winsMax: 9, daysActiveMin: 10,
    playtimeHoursMin: 5, tracksMin: 10, verification: 'verified',
    whitelist: ['alpha', 'charlie'], blacklist: ['charlie']
  }, { isComplete: complete });
  assert.equal(result.available, true);
  assert.equal(result.sourceCount, 3);
  assert.equal(result.filteredCount, 1);
  assert.deepEqual(result.rows.map(row => ({ id: row.userId, globalRank: row.globalRank, filteredRank: row.filteredRank, filteredTotal: row.filteredTotal })), [
    { id: 'alpha', globalRank: 3, filteredRank: 1, filteredTotal: 1 }
  ]);
  assert.equal(result.filter.category, 'wins');
});

test('incomplete or missing metrics are unavailable and never treated as zero', () => {
  const incomplete = filterRankedRows(rows, { winsMin: 1 }, { isComplete: () => false });
  assert.equal(incomplete.available, false);
  assert.equal(incomplete.rows.length, rows.length);
  assert.equal('filteredRank' in incomplete.rows[0], false);
  assert(incomplete.unavailable.some(item => item.metric === 'snapshot'));
  assert.equal(filterRankedRows(rows, { category: 'wins' }, { isComplete: () => false }).available, false);

  const missing = rows.map(row => ({ ...row }));
  delete missing[1].daysActive;
  const unavailable = filterRankedRows(missing, { daysActiveMin: 1 }, { isComplete: complete });
  assert.equal(unavailable.available, false);
  assert(unavailable.unavailable.some(item => item.metric === 'daysActive' && /unavailable/.test(item.reason)));
  assert.equal(inspectRankedFilterAvailability(missing, complete).daysActive.available, false);
});

test('verified-only requires an explicit boolean for every loaded row', () => {
  const missing = rows.map(row => ({ ...row }));
  delete missing[2].runVerified;
  const result = filterRankedRows(missing, { verification: 'verified' }, { isComplete: complete });
  assert.equal(result.available, false);
  assert(result.unavailable.some(item => item.metric === 'verification'));
});

test('active filters require real source ranks and category completeness', () => {
  const rankless = rows.map(row => ({ ...row }));
  delete rankless[0].rank;
  assert.equal(filterRankedRows(rankless, { winsMin: 1 }, { isComplete: complete }).available, false);
  const noCasual = filterRankedRows(rows, { category: 'casual' }, {
    isComplete: metric => metric !== 'category:casual'
  });
  assert.equal(noCasual.available, false);
  assert(noCasual.unavailable.some(item => item.metric === 'category'));
});

test('presets survive malformed storage, validate input and stay bounded to eight', () => {
  const store = storage({ broken: '{not json' });
  assert.deepEqual(readRankedFilterPresets(store, 'broken'), []);
  let presets = [];
  for (let index = 0; index < 10; index++) {
    presets = saveRankedFilterPreset(store, { name: `Preset ${index}`, filter: { winsMin: index } }, 'filters');
  }
  assert.equal(presets.length, MAX_RANKED_FILTER_PRESETS);
  assert.equal(readRankedFilterPresets(store, 'filters').length, 8);
  const unchanged = saveRankedFilterPreset(store, { name: '', filter: { winsMin: 1 } }, 'filters');
  assert.equal(unchanged.length, 8);
  const malformed = saveRankedFilterPreset(store, { name: 'Bad', filter: { winsMin: 'nope' } }, 'filters');
  assert.equal(malformed.length, 8);
  const next = deleteRankedFilterPreset(store, presets[0].id, 'filters');
  assert.equal(next.length, 7);
});

test('preset storage failures leave the existing list unchanged', () => {
  const broken = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
  assert.deepEqual(saveRankedFilterPreset(broken, { name: 'Local', filter: {} }), []);
  assert.deepEqual(deleteRankedFilterPreset(broken, 'missing'), []);
});
