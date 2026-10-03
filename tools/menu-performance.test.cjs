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

test('car hydration skips hidden and detached queued views, then hydrates reopened rows', async () => {
  const start = source.indexOf('  const overallCarRenderCache = new Map();');
  const end = source.indexOf('  function isLocalApiCapableHost(){', start);
  const pending = new Map();
  const calls = [];
  function makeNode(user, style, { visible = true, connected = true } = {}) {
    const image = { src: '', hidden: false, after() {}, classList: { add() {} } };
    const label = { hidden: false, textContent: '', className: '' };
    image.after = value => { Object.assign(label, value); };
    const node = {
      isConnected: connected,
      dataset: { userid: user, renderarg: style },
      getClientRects: () => visible ? [{}] : [],
      querySelectorAll: () => [{ classList: { remove() {} } }, image],
      querySelector: () => image
    };
    return { node, image };
  }
  const a = makeNode('a', 'a'), b = makeNode('b', 'b');
  const hidden = makeNode('hidden', 'hidden', { visible: false });
  const detached = makeNode('detached', 'detached', { connected: false });
  const e = makeNode('e', 'e');
  const root = { isConnected: true, querySelectorAll: () => [a.node, b.node, hidden.node, detached.node, e.node] };
  const context = {
    Date, Promise, Map, WeakMap, Set, Symbol,
    window: { BT: (style, user) => { calls.push(user); return new Promise(resolve => pending.set(user, resolve)); } },
    __pt062NormalizeStyle: value => value,
    __pt062GetRememberedStyle: () => '',
    normalizeCarColorId: () => 'default',
    cleanUserId: value => value,
    normalizeThumbResult: value => value,
    requestIdleCallback: callback => { callback(); return 1; },
    cancelIdleCallback() {},
    setTimeout, clearTimeout
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  context.hydrateOverallCarModels(root);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['u.a', 'u.b']);

  hidden.node.getClientRects = () => [];
  detached.node.isConnected = false;
  context.hydrateOverallCarModels(root);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['u.a', 'u.b']);

  hidden.node.getClientRects = () => [{}];
  context.hydrateOverallCarModels({ isConnected: true, querySelectorAll: () => [hidden.node] });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['u.a', 'u.b']);

  pending.get('u.a')('data:image/png;base64,a');
  await new Promise(resolve => setImmediate(resolve));
  pending.get('u.b')('data:image/png;base64,b');
  await new Promise(resolve => setImmediate(resolve));
  assert(calls.includes('u.hidden'));
  pending.get('u.hidden')('data:image/png;base64,hidden');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(hidden.image.src, 'data:image/png;base64,hidden');
  assert.equal(calls.includes('u.detached'), false);
});

test('same-user car skin changes keep render subscribers isolated', async () => {
  const start = source.indexOf('  const overallCarRenderCache = new Map();');
  const end = source.indexOf('  function isLocalApiCapableHost(){', start);
  const pending = new Map(), calls = [];
  const rendered = { src: '', classList: { add() {} } };
  const placeholder = { classList: { remove() {} } };
  const node = { isConnected: true, dataset: { userid: 'racer', renderarg: 'skin-one' },
    getClientRects: () => [{}], querySelectorAll: () => [placeholder, rendered] };
  const root = { isConnected: true, querySelectorAll: () => [node] };
  const context = {
    Date, Promise, Map, WeakMap, Set, Symbol,
    window: { BT: style => { calls.push(style); return new Promise(resolve => pending.set(style, resolve)); } },
    __pt062NormalizeStyle: value => value, __pt062GetRememberedStyle: () => '',
    normalizeCarColorId: () => 'default', cleanUserId: value => value,
    normalizeThumbResult: value => value, requestIdleCallback: callback => { callback(); return 1; },
    cancelIdleCallback() {}, setTimeout, clearTimeout
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  context.hydrateOverallCarModels(root);
  await new Promise(resolve => setImmediate(resolve));
  node.dataset.renderarg = 'skin-two';
  context.hydrateOverallCarModels(root);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['skin-one', 'skin-two']);
  pending.get('skin-one')('data:image/png;base64,old');
  await new Promise(resolve => setImmediate(resolve));
  assert.notEqual(rendered.src, 'data:image/png;base64,old');
  pending.get('skin-two')('data:image/png;base64,new');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rendered.src, 'data:image/png;base64,new');
});

test('cancelled overall car renders never assign non-string results to image sources', async () => {
  const start = source.indexOf('  const overallCarRenderCache = new Map();');
  const end = source.indexOf('  function isLocalApiCapableHost(){', start);
  let visible = true, rendererCalls = 0;
  const assigned = [];
  const image = { classList: { add() {} }, set src(value) {
    if (typeof value !== 'string') throw new TypeError('image src must be a string');
    assigned.push(value);
  } };
  const placeholder = { classList: { remove() {} } };
  const node = { isConnected: true, dataset: { userid: 'hidden-profile', renderarg: 'skin' },
    getClientRects: () => visible ? [{}] : [], querySelectorAll: () => [placeholder, image] };
  const root = { isConnected: true, querySelectorAll: () => [node] };
  const context = {
    Date, Promise, Map, WeakMap, Set, Symbol,
    window: { BT: () => { rendererCalls++; return 'data:image/png;base64,thumb'; } },
    __pt062NormalizeStyle: value => value, __pt062GetRememberedStyle: () => '',
    normalizeCarColorId: () => 'default', cleanUserId: value => value,
    normalizeThumbResult: value => value, requestIdleCallback: callback => { callback(); return 1; },
    cancelIdleCallback() {}, setTimeout, clearTimeout
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  context.hydrateOverallCarModels(root);
  visible = false;
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rendererCalls, 0);
  assert.deepEqual(assigned, []);
});
