const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const patchPath = process.env.POLYTRACK_PATCH_PATH || path.join(__dirname, '..', 'polytrack_062_patch.js');
const source = fs.readFileSync(patchPath, 'utf8');

function extract(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is present`);
  const parameters = source.indexOf('(', start);
  let parameterDepth = 0;
  let body = -1;
  for (let index = parameters; index < source.length; index += 1) {
    if (source[index] === '(') parameterDepth += 1;
    if (source[index] === ')' && --parameterDepth === 0) { body = source.indexOf('{', index); break; }
  }
  let depth = 0;
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

test('Ranked click invokes the guarded panel opener', async () => {
  let opens = 0;
  const context = vm.createContext({ openRankedPanel: () => { opens += 1; return Promise.resolve(); } });
  vm.runInContext(`${extract('handleRankedButtonClick')};`, context);
  let prevented = 0;
  let stopped = 0;
  context.handleRankedButtonClick({ preventDefault: () => { prevented += 1; }, stopPropagation: () => { stopped += 1; } });
  await Promise.resolve();
  assert.equal(opens, 1);
  assert.equal(prevented, 1);
  assert.equal(stopped, 1);
});

test('Ranked panel stays visible and shows retry when opening rejects', async () => {
  const list = { innerHTML: '' };
  const panel = { style: { display: 'none' }, querySelector: selector => selector === '#overallLeaderboardList' ? list : null };
  const logs = [];
  const context = vm.createContext({
    document: { getElementById: id => id === 'overallLeaderboardPanel' ? panel : null },
    ensurePanel: () => {},
    openPanel: async () => { throw new Error('filter render failed'); },
    log: (...args) => logs.push(args)
  });
  vm.runInContext(`${extract('rankedPanelOpenFailed')};${extract('openRankedPanel')};`, context);
  assert.equal(await context.openRankedPanel(), null);
  assert.equal(panel.style.display, 'flex');
  assert.match(list.innerHTML, /Ranked could not finish opening/);
  assert.match(list.innerHTML, /data-rank-retry/);
  assert.match(logs[0].join(' '), /filter render failed/);
});

test('throwing filter adapter is disabled without aborting leaderboard rendering', () => {
  const root = { textContent: '' };
  const logs = [];
  const context = vm.createContext({
    rankedFiltersUi: { update: () => { throw new Error('bad saved filter'); } },
    rankedFilterResult: { stale: true },
    rankedFiltersSyncing: false,
    document: { getElementById: id => id === 'overallFilterPanel' ? root : null },
    log: (...args) => logs.push(args)
  });
  vm.runInContext(`${extract('syncRankedFilterRows')};${extract('syncRankedFilterRowsSafely')};`, context);
  assert.equal(context.syncRankedFilterRowsSafely([]), null);
  assert.equal(context.rankedFiltersUi, null);
  assert.equal(context.rankedFilterResult, null);
  assert.equal(context.rankedFiltersSyncing, false);
  assert.equal(root.textContent, 'Saved filters are unavailable.');
  assert.match(logs[0].join(' '), /bad saved filter/);
});

test('reconciliation cannot hide Ranked through Verified-only ancestor text', () => {
  assert.doesNotMatch(source, /function hideVerifiedOnlyToggle\s*\(/);
  assert.doesNotMatch(source, /querySelectorAll\(['"]label,button,div,span['"]\)/);
  assert.doesNotMatch(extract('reconcileUiContents'), /hideVerifiedOnlyToggle/);
  assert.match(source, /function ensureNativeAllRunsDefault\s*\(/);
  assert.match(extract('decorateNativeLeaderboardCosmetics'), /ensureNativeAllRunsDefault\(host\)/);
});

test('patch UI does not expose scoring formula constants', () => {
  for (const pattern of [/Overall RP is 68%/, /20% diminishing track coverage/, /12% protected all-track depth/, /Official tracks use 1\.6x/, /1\.6x type/, /1\.0x type/, /0\.6x type/, /award 9 for first/, /100 points for each/, /base field weight/, /base multiplier is/]) {
    assert.doesNotMatch(source, pattern);
  }
  assert.match(source, /function rankedPlacementCost\(/);
  assert.match(source, /function rankedTrackWeightParts\(/);
  assert.match(source, /warning\.style\.top = '-32px'/);
});
