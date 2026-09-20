const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const start = source.indexOf("const menu = document.getElementById('staticMenu');");
const end = source.indexOf('      })();', start);
assert.ok(start >= 0 && end > start, 'lobby observer script region must exist');
const region = source.slice(start, end);

test('lobby observer avoids polling and document-wide style observation', () => {
  assert.doesNotMatch(region, /setInterval\s*\(/);
  assert.doesNotMatch(region, /observe\(document\.documentElement/);
  assert.doesNotMatch(region, /attributeFilter:\s*\[['"]class['"],\s*['"]style['"]\]/);
  assert.doesNotMatch(region, /localStorage/);
});

test('lobby menu display writes are guarded against observer re-entry', () => {
  assert.match(region, /const display = lobby \? 'flex' : 'none'/);
  assert.match(region, /if\s*\(menu\.style\.display\s*!==\s*display\)\s*menu\.style\.display\s*=\s*display/);
  assert.match(region, /const structureObserver = new MutationObserver\(queueSync\)/);
  assert.match(region, /visualObserver = new MutationObserver\(queueSync\)/);
});
