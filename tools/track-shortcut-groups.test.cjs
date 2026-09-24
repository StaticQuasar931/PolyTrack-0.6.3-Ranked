const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'polytrack_062_patch.js'), 'utf8');
const start = source.indexOf('  let nativeTopSelectToken=0;');
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
  const api = vm.runInContext(`(()=>{${handler};return {handleTrackLeaderboardShortcut};})()`, context);
  async function press(key, { shiftKey = false, code = '' } = {}) {
    const event = { key, code, shiftKey, target: null, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
    const handled = api.handleTrackLeaderboardShortcut(event);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(handled, true);
    assert.equal(event.defaultPrevented, true);
  }
  return { rows, pageJumps, press, selected: () => rows.filter(row => row.selected).map(row => row.index + 1) };
}

test('number and T-number toggle the top N racers; zero means ten', async () => {
  const h = fixture();
  await h.press('7', { code: 'Digit7' });
  assert.deepEqual(h.selected(), [1, 2, 3, 4, 5, 6, 7]);
  await h.press('7', { code: 'Digit7' });
  assert.deepEqual(h.selected(), []);
  await h.press('t', { code: 'KeyT' });
  await h.press('3', { code: 'Numpad3' });
  assert.deepEqual(h.selected(), [1, 2, 3]);
  await h.press('0', { code: 'Digit0' });
  assert.deepEqual(h.selected(), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  await h.press('c', { code: 'KeyC' });
  assert.deepEqual(h.selected(), []);
  await h.press('2', { code: 'Digit2', shiftKey: true });
  assert.deepEqual(h.pageJumps.at(-1), 2);
});
