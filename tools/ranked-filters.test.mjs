import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_RANKED_FILTER_PRESETS,
  RANKED_FILTER_CATEGORIES,
  RANKED_FILTER_CATEGORY_LABELS,
  deleteRankedFilterPreset,
  filterRankedRows,
  inspectRankedFilterAvailability,
  normalizeRankedFilter,
  mountRankedFilterPanel,
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

class MockElement {
  constructor(tag, document) {
    this.tagName = tag;
    this.ownerDocument = document;
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.className = '';
    this.classList = { toggle: (name, enabled) => {
      const classes = new Set(this.className.split(/\s+/).filter(Boolean));
      if (enabled) classes.add(name); else classes.delete(name);
      this.className = [...classes].join(' ');
    } };
  }
  append(...nodes) { this.children.push(...nodes); }
  prepend(...nodes) { this.children.unshift(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
  dispatch(name, event = {}) {
    for (const listener of this.listeners[name] || []) listener({ preventDefault() {}, ...event });
  }
  focus() {}
  get options() { return this.children; }
  get elements() {
    return new Proxy({}, { get: (_, name) => {
      const find = node => node.name === name ? node : node.children.map(find).find(Boolean);
      return this.children.map(find).find(Boolean);
    } });
  }
}

function mockDocument() {
  const document = { createElement: tag => new MockElement(tag, document) };
  return document;
}

function findElement(root, predicate) {
  if (predicate(root)) return root;
  for (const child of root.children) {
    const found = findElement(child, predicate);
    if (found) return found;
  }
  return null;
}

test('filter category names match the actual Ranked leaderboard labels', () => {
  assert.deepEqual(Object.keys(RANKED_FILTER_CATEGORY_LABELS), [...RANKED_FILTER_CATEGORIES]);
  assert.deepEqual(RANKED_FILTER_CATEGORY_LABELS, {
    overall: 'Overall RP', average: 'Average place', competitiveAverage: 'Competitive average',
    tracks: 'Tracks completed', medals: 'Podium points', rising: 'Rising racers', skill: 'Best 10 skill',
    consistency: 'All-track depth', wins: 'Track wins', podiumRate: 'Podium rate',
    weight: 'Total track weight', pbs: 'PBs set', playtime: 'Active time',
    veterans: 'Racing longest', official: 'Official tracks', community: 'Community tracks', casual: 'Casual RP'
  });
});

const rows = [
  { userId: 'alpha', rank: 3, trackWins: 5, daysActive: 20, totalPlaytimeMs: 10 * 3600000, raceCount: 12, runVerified: true },
  { userId: 'bravo', rank: 8, trackWins: 2, daysActive: 8, totalPlaytimeMs: 3 * 3600000, raceCount: 6, runVerified: false },
  { userId: 'charlie', rank: 11, trackWins: 8, daysActive: 40, totalPlaytimeMs: 30 * 3600000, raceCount: 20, runVerified: true }
];

test('filter panel resolves typed usernames and groups content beneath the summary trigger', () => {
  const document = mockDocument();
  const root = new MockElement('root', document);
  const updates = [];
  const panel = mountRankedFilterPanel({
    root,
    storage: storage(),
    rows: [
      { userId: 'alice-id', name: 'Alice Smith', rank: 1 },
      { userId: 'user-3', name: 'Same Name', rank: 2 },
      { userId: 'user-4', name: ' same name ', rank: 3 }
    ],
    isComplete: metric => metric === 'snapshot' || metric === 'identity' || metric === 'rank' || metric.startsWith('category:'),
    onChange: result => updates.push(result)
  });
  const details = root.children[0];
  const summary = details.children[0];
  const content = details.children[1];
  assert.equal(content.className, 'ranked-filter-content');
  assert.equal(summary.tagName, 'summary');
  assert(content.children.some(child => child.className === 'ranked-filter-form'));
  assert(content.children.some(child => child.className === 'ranked-filter-presets'));
  assert(content.children.some(child => child.className === 'ranked-filter-status'));

  const input = findElement(content, node => node.name === 'whitelist');
  input.value = 'Alice Smith';
  const form = findElement(content, node => node.className === 'ranked-filter-form');
  form.dispatch('submit');
  assert.deepEqual(updates.at(-1).filter.whitelist, ['alice-id']);
  assert.equal(panel.getFilter().whitelist[0], 'alice-id');

  const blacklist = findElement(content, node => node.name === 'blacklist');
  const status = findElement(content, node => node.className === 'ranked-filter-status');
  blacklist.value = 'Same Name';
  form.dispatch('submit');
  assert.match(status.textContent, /ambiguous/i);
  assert.deepEqual(panel.getFilter().whitelist, ['alice-id']);
  blacklist.value = 'Nobody';
  form.dispatch('submit');
  assert.match(status.textContent, /No loaded racer matches/);
});

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

test('loaded-results mode keeps username filtering usable on incomplete snapshots', () => {
  const document = mockDocument();
  const root = new MockElement('root', document);
  const updates = [];
  mountRankedFilterPanel({
    root, storage: storage(), rows: [
      { userId: 'alice-id', name: 'Alice Smith', rank: 1 },
      { userId: 'bob-id', name: 'Bob', rank: 2 }
    ],
    isComplete: () => false,
    allowPartial: true,
    onChange: result => updates.push(result)
  });
  const input = findElement(root, node => node.name === 'whitelist');
  assert.equal(input.disabled, false);
  assert.equal(findElement(root, node => node.className === 'ranked-filter-scope').hidden, false);
  assert.equal(findElement(root, node => node.tagName === 'fieldset').hidden, true);
  input.value = 'Alice Smith';
  findElement(root, node => node.className === 'ranked-filter-form').dispatch('submit');
  assert.equal(updates.at(-1).available, true);
  assert.deepEqual(updates.at(-1).rows.map(row => row.userId), ['alice-id']);
  assert.match(findElement(root, node => node.className === 'ranked-filter-status').textContent, /loaded racers/);
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
