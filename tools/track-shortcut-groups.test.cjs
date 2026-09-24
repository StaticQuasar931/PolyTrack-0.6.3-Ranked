const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'polytrack_062_patch.js'), 'utf8');
const start = source.indexOf('  let nativeTopSelectToken=0,');
const end = source.indexOf('  function handleOverallLeaderboardShortcut(', start);
assert(start >= 0 && end > start, 'track shortcut source exists');
const handler = source.slice(start, end);

function fixture() {
  const rows = Array.from({ length: 10 }, (_, index) => ({
    index, selected: false,
    classList: { contains(name) { return name === 'selected' && rows[index].selected; } },
    getAttribute() { return null; },
    click() { this.selected = !this.selected; }
  }));
  const pages = { querySelectorAll: () => [{ classList: { contains: () => true }, textContent: '1' }] };
  const board = {
    isConnected: true,
    classList: { contains: () => false },
    querySelectorAll: () => rows,
    querySelector: selector => selector.includes('button.page.selected') ? { textContent: '1' } : pages
  };
  const document = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [board]
  };
  const pageJumps = [];
  const context = vm.createContext({
    document,
    isElementVisible: value => Boolean(value),
    HTMLInputElement: class {}, HTMLTextAreaElement: class {}, HTMLSelectElement: class {},
    requestAnimationFrame: callback => callback(),
    jumpNativeLeaderboardPage: async (_, page) => { pageJumps.push(page); }
  });
  const api = vm.runInContext(`(()=>{${handler};return {handleTrackLeaderboardShortcut,handleTrackLeaderboardDigitRelease};})()`, context);
  function event(key, { shiftKey = false, code = '' } = {}) {
    return { key, code, shiftKey, target: null, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
  }
  function down(key, options = {}) {
    const input = event(key, options);
    assert.equal(api.handleTrackLeaderboardShortcut(input), true);
    assert.equal(input.defaultPrevented, true);
  }
  function up(key, options = {}) {
    const input = event(key, options);
    api.handleTrackLeaderboardDigitRelease(input);
  }
  async function press(key, options = {}) {
    down(key, options); up(key, options);
    await new Promise(resolve => setImmediate(resolve));
  }
  return { rows, pageJumps, down, up, press, selected: () => rows.filter(row => row.selected).map(row => row.index + 1) };
}

test('one number toggles one racer, T-number toggles top N, overlapping numbers select a range', async () => {
  const h = fixture();
  await h.press('7', { code: 'Digit7' });
  assert.deepEqual(h.selected(), [7]);
  await h.press('7', { code: 'Digit7' });
  assert.deepEqual(h.selected(), []);
  await h.press('t', { code: 'KeyT' });
  await h.press('3', { code: 'Numpad3' });
  assert.deepEqual(h.selected(), [1, 2, 3]);
  await h.press('t', { code: 'KeyT' });
  await h.press('3', { code: 'Numpad3' });
  assert.deepEqual(h.selected(), []);
  await h.press('0', { code: 'Digit0' });
  assert.deepEqual(h.selected(), [10]);
  await h.press('c', { code: 'KeyC' });
  assert.deepEqual(h.selected(), []);
  h.down('3', { code: 'Digit3' });
  h.down('6', { code: 'Digit6' });
  assert.deepEqual(h.selected(), [3, 4, 5, 6]);
  h.up('3', { code: 'Digit3' });h.up('6', { code: 'Digit6' });
  h.down('6', { code: 'Digit6' });h.down('3', { code: 'Digit3' });
  h.up('6', { code: 'Digit6' });h.up('3', { code: 'Digit3' });
  assert.deepEqual(h.selected(), []);
  await h.press('2', { code: 'Digit2', shiftKey: true });
  assert.deepEqual(h.pageJumps.at(-1), 2);
});
