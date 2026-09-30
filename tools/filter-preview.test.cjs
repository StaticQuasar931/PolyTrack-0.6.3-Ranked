const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const menu = fs.readFileSync(path.join(__dirname, 'filter-menu.mjs'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, 'filter-menu.css'), 'utf8');

test('selected racer car previews are hydrated after chip rendering and when the overlay opens', () => {
  assert.match(menu, /chip\.append\(remove\); chips\.append\(chip\);\s*}\s*safeCall\(\(\) => onRenderRacers\(chips\), undefined\);/);
  assert.match(menu, /overlay\.hidden = false;\s*for \(const picker of overlay\.querySelectorAll\('\.fm-user-picker'\)\)/);
  assert.match(css, /\.fm-racer-native-preview \.overall-car-model\.image-container img\.show \{ display: block !important; \}/);
  assert.match(css, /\.fm-racer-native-preview \.overall-car-model\.image-container img \{ display: none !important;/);
  assert.match(css, /width: 58px !important; height: 46px !important;/);
});

test('track previews use contain sizing and expose optional cached aggregate metadata', () => {
  assert.match(css, /\.fm-track-info > img \{ width: 160px; height: 110px; object-fit: contain;/);
  assert.match(css, /\.fm-track-meta \{ display: grid;/);
  assert.match(menu, /\['racerCount', track\?\.complete === true \? 'Racers' : 'Loaded racers'\], \['meanTimeMs', 'Mean PB'\], \['medianTimeMs', 'Median PB'\]/);
  assert.match(menu, /Stats use loaded PBs, not all attempts\./);
  assert.match(menu, /return `\$\{minutes\}:\$\{String\(seconds\)\.padStart\(2, '0'\)\}\.\$\{String\(milliseconds\)\.padStart\(3, '0'\)\}`;/);
});

test('track metadata stacks below the preview on narrow screens', () => {
  assert.match(css, /@media \(max-width: 540px\) \{\s*\.fm-track-info \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(css, /\.fm-track-meta-note \{ grid-column: 2;/);
  assert.match(css, /\.fm-track-meta-note \{ grid-column: 1; \}/);
});

test('customized-profile control stays bound to its filter field in Profile details', () => {
  assert.match(menu, /facetCard\.append\(hideUncustomizedRow\);/);
  assert.doesNotMatch(menu, /displayCard\.append\(hideUncustomizedRow\);/);
  assert.match(menu, /next\.hideUncustomized = hideUncustomized\.checked;/);
});

test('RP suggestions round to at most two localized decimals with restrained states', () => {
  assert.match(menu, /Number\(rp\.toFixed\(2\)\)\.toLocaleString\(undefined, \{ maximumFractionDigits: 2 \}\)/);
  assert.match(css, /\.fm-suggestion:hover, \.fm-suggestion:focus-visible \{ background: #192f58; \}/);
  assert.match(css, /:focus-visible \{ outline: 2px solid var\(--fm-green\);/);
});
