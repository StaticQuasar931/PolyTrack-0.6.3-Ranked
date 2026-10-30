import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');

test('bounded toolbar rules keep Filters next to Search and only stack on very narrow screens', () => {
  const css = read('extra-tracks/catalog.css').split('/* Keep Search and Filters together;')[1];
  assert.ok(css);
  const [wide, rest] = css.split('@media(max-width:850px)');
  const [medium, narrow] = rest.split('@media(max-width:380px)');
  for (const rules of [wide, medium]) {
    assert.match(rules, /advanced-toggle\{grid-column:2;grid-row:1/);
  }
  assert.match(medium, /search-field\{grid-column:1;grid-row:1/);
  assert.match(medium, /sort-controls\{grid-column:1\/-1;grid-row:2/);
  assert.match(narrow, /advanced-toggle\{grid-column:1\/-1;grid-row:2/);
  assert.match(narrow, /sort-controls\{grid-column:1\/-1;grid-row:3/);
});

test('event interior polish is scoped, readable and does not change card or artwork geometry', () => {
  const css = read('events/events.css').split('/* Bounded interior polish:')[1];
  assert.ok(css);
  assert.match(css, /font-size:18px!important;font-variant-numeric:tabular-nums/);
  assert.match(css, /time\{\s*white-space:nowrap;letter-spacing:\.02em/);
  assert.match(css, /personal-best\{\s*gap:6px 14px;margin-block:8px!important/);
  assert.match(css, /sq-event-card-details\{\s*gap:6px;line-height:1\.35!important/);
  assert.match(css, /@media\(max-width:480px\)/);
  assert.doesNotMatch(css, /(?:^|[;{\s])(?:height|width|grid-template|object-fit|font-family)\s*:/);
  assert.doesNotMatch(css, /(?:^|[;{\s])content\s*:/, 'no invented PB or placement text');
});
