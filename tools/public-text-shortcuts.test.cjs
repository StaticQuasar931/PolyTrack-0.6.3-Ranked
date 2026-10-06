const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('Static menu shortcut ignores typing, modifiers and repeated keys', () => {
  const block = html.match(/\(function\(\)\{\s*const idsToToggle[\s\S]*?\}\)\(\);/);
  assert.ok(block, 'production shortcut handler exists');
  let listener;
  const menu = {style: {display: 'none'}};
  const context = {window: {addEventListener: (_, handler) => {listener = handler;}},
    document: {getElementById: () => menu}, getComputedStyle: () => ({display: menu.style.display})};
  vm.runInNewContext(block[0], context);
  const key = (value, other = {}) => listener({key: value, target: {}, ...other});
  for (const ignored of [{target: {closest: () => ({})}}, {target: {isContentEditable: true}},
    {ctrlKey: true}, {altKey: true}, {metaKey: true}, {repeat: true}, {defaultPrevented: true}]) {
    menu.style.display = 'none';
    key('y', ignored); key('u', ignored); key('i', ignored);
    assert.equal(menu.style.display, 'none');
  }
  key('y'); key('u'); key('i');
  assert.equal(menu.style.display, 'flex');
});

test('public descriptions do not advertise an obsolete fixed catalog size', () => {
  assert.doesNotMatch(html, /Race 88 tracks|Race 17 official and 71/);
  const migration = fs.readFileSync(path.join(root, 'docs/migration/README.md'), 'utf8');
  assert.doesNotMatch(migration, /ready for an initial migration|Do not enable Pages|does not automatically discover/);
});
