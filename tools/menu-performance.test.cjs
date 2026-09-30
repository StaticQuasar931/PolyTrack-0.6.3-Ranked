const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.join(__dirname, '../polytrack_062_patch.js'), 'utf8');
const start = source.indexOf('  let rankingsSyncHandle = 0;');
const end = source.indexOf('  function syncRankingsButtonAnimation(', start);
assert.ok(start >= 0 && end > start);

test('menu animation sync does not restart on repeated reconciliation', () => {
  const frames = [];
  let visible = true;
  let syncs = 0;
  const context = {
    Date,
    rankingsSpawnedOnce: false,
    requestAnimationFrame(callback) { frames.push(callback); return frames.length; },
    isElementVisible() { return visible; },
    syncRankingsButtonAnimation() { syncs++; }
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  const button = { isConnected: true };
  const container = { isConnected: true };
  context.scheduleRankingsSync(button, container);
  context.scheduleRankingsSync(button, container);
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.equal(syncs, 1);
  assert.equal(frames.length, 1);
  visible = false;
  frames.shift()();
  assert.equal(syncs, 1);
  assert.equal(frames.length, 0);
  visible = true;
  context.scheduleRankingsSync(button, container);
  assert.equal(frames.length, 1);
});

test('footer branding mutation work coalesces to one animation frame', () => {
  const start = source.indexOf('  let footerBrandingFrame=0;');
  const end = source.indexOf('  function ensurePersistentInfoBranding(){', start);
  assert.ok(start >= 0 && end > start);
  const frames = [];
  let reconciles = 0;
  const context = {
    requestAnimationFrame(callback) { frames.push(callback); return frames.length; },
    ensurePersistentInfoBranding() { reconciles++; }
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  context.schedulePersistentInfoBranding();
  context.schedulePersistentInfoBranding();
  context.schedulePersistentInfoBranding();
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.equal(reconciles, 1);
  context.schedulePersistentInfoBranding();
  assert.equal(frames.length, 1);
});

test('car hydration attaches one completion handler per card and render key', async () => {
  const start = source.indexOf('  const overallCarRenderCache = new Map();');
  const end = source.indexOf('  function isLocalApiCapableHost(){', start);
  assert.ok(start >= 0 && end > start);
  let finishRender;
  let renderedAdds = 0;
  let placeholderRemoves = 0;
  const rendered = { src: '', classList: { add() { renderedAdds++; } } };
  const placeholder = { classList: { remove() { placeholderRemoves++; } } };
  const node = {
    isConnected: true,
    dataset: { userid: 'racer', renderarg: 'style' },
    querySelectorAll() { return [placeholder, rendered]; }
  };
  const root = { isConnected: true, querySelectorAll() { return [node]; } };
  const context = {
    Date,
    Promise,
    Map,
    WeakMap,
    window: { BT: () => new Promise(resolve => { finishRender = resolve; }) },
    __pt062NormalizeStyle: value => value,
    __pt062GetRememberedStyle: () => '',
    normalizeCarColorId: () => 'default',
    cleanUserId: value => value,
    normalizeThumbResult: value => value
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  context.hydrateOverallCarModels(root);
  context.hydrateOverallCarModels(root);
  await Promise.resolve();
  assert.equal(typeof finishRender, 'function');
  finishRender('data:image/png;base64,thumb');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rendered.src, 'data:image/png;base64,thumb');
  assert.equal(renderedAdds, 1);
  assert.equal(placeholderRemoves, 1);
});