import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../polytrack_062_patch.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('  function setupRacerStudio(content)');
const end = source.indexOf('\n\n  function profileCustomizerMarkup(', start);
assert.ok(start >= 0 && end > start, 'Racer Studio setup function must be present');
const setupSource = source.slice(start, end);

function studioHarness() {
  const handlers = {};
  const state = { active: 0, prevented: 0, stopped: 0, focused: -1 };
  const tabs = Array.from({ length: 4 }, (_, index) => ({
    getAttribute: () => String(index === state.active),
    click: () => { state.active = index; },
    focus: () => { state.focused = index; }
  }));
  const input = { dataset:{}, addEventListener() {} };
  const list = { dataset:{}, addEventListener() {} };
  const studio = {
    querySelector: selector => selector === '[data-cosmetic-favorite]' ? input : list,
    querySelectorAll: () => tabs,
    addEventListener: (name, handler) => { handlers[name] = handler; }
  };
  const content = { querySelector: () => studio };
  const context = vm.createContext({
    Array,
    cleanUserId: value => String(value || ''),
    renderStudioFavorite() {},
    TRACK_CATALOG: new Map(),
    profileCosmeticDrafts: new Map(),
    sanitizeProfileCosmetics: value => value || {},
    trackInfo: () => ({ name: '' }),
    escapeHtml: value => String(value)
  });
  vm.runInContext(`${setupSource}\nsetupRacerStudio`, context)(content);
  return {
    state,
    key(targetSelector, key, { shiftKey = false, code = '' } = {}) {
      let prevented = false;
      let stopped = false;
      handlers.keydown({
        altKey: false, ctrlKey: false, metaKey: false, shiftKey, code, key,
        target: { closest: selector => selector === targetSelector ? {} : null },
        preventDefault: () => { prevented = true; state.prevented++; },
        stopPropagation: () => { stopped = true; state.stopped++; }
      });
      return { prevented, stopped };
    }
  };
}

test('Racer Studio arrow shortcuts switch tabs only from the tablist', () => {
  const studio = studioHarness();
  const choiceResult = studio.key('[data-cosmetic-choice]', 'ArrowRight');
  assert.deepEqual(choiceResult, { prevented: false, stopped: false });
  assert.equal(studio.state.active, 0);

  const tabResult = studio.key('[data-studio-tab]', 'ArrowRight');
  assert.deepEqual(tabResult, { prevented: true, stopped: true });
  assert.equal(studio.state.active, 1);
  assert.equal(studio.state.focused, 1);
});

test('Racer Studio Shift+number shortcuts remain available outside form fields', () => {
  const studio = studioHarness();
  const result = studio.key('[data-cosmetic-choice]', '2', { shiftKey: true, code: 'Digit2' });
  assert.deepEqual(result, { prevented: true, stopped: true });
  assert.equal(studio.state.active, 1);
  assert.equal(studio.state.focused, 1);
});