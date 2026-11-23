import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const css = fs.readFileSync(new URL('../home-ui.css', import.meta.url), 'utf8');
const patchSource = fs.readFileSync(new URL('../polytrack_062_patch.js', import.meta.url), 'utf8');
// Layout and contrast are exercised with actual native markup in track-info-card.browser.test.mjs.

test('source states and locked refresh styling are present and interaction-neutral', async () => {
  for (const source of ['snapshot', 'mixed', 'cache', 'live', 'local', 'error']) assert.match(css, new RegExp(`data-source="${source}"`));
  assert.match(css, /position:\s*fixed\s*!important/);
  assert.doesNotMatch(css, /\.sq-track-data-inline\s*\{/);
  assert.match(css, /--sq-track-data-bg:\s*#253a75/);
  assert.match(css, /data-source="snapshot"[\s\S]*?--sq-track-data-bg:\s*#253a4d/);
  assert.match(css, /border-left:\s*0\.25em solid #7ee7ff/);
  assert.match(css, /clip-path:\s*none\s*!important/);
  assert.match(css, /border:\s*1px solid rgba\(205, 226, 255, \.46\)\s*!important/);
  assert.match(css, /box-shadow:\s*0 0\.4em 1\.2em rgba\(0, 0, 0, \.3\)/);
  assert.match(css, /width:\s*fit-content !important/);
  assert.match(css, /max-width:\s*min\(31em, var\(--sq-track-data-width, 31em\), calc\(100vw - 1\.25em\)\) !important/);
  assert.match(css, /font-size:\s*max\(15px, calc\(16px \* var\(--sq-ui-scale, 1\)\)\) !important/);
  assert.match(patchSource, /Snapshot \$\{old\(capturedAt\)\}/);
  assert.doesNotMatch(patchSource, /const bannerHtml=.*snapshotCaptureLabel\(\)/);
  assert.match(patchSource, /const sourceHtml=.*trackFreshnessSourceHtml\(baseSource,sourceLine\)/);
  assert.match(patchSource, /const bannerHtml=.*track-data-update/);
  assert.ok(patchSource.includes('const pbStatusHtml=cloudConfirmed?'));
  assert.ok(patchSource.includes('track-data-pb-status">WAITING'));
  assert.ok(patchSource.includes("baseSource!=='snapshot'&&checkedAt?"));
  assert.doesNotMatch(patchSource, /track-data-age/);
  assert.match(patchSource, /const layout=gutter>=.*'horizontal'.*'vertical'/);
  assert.match(patchSource, /banner\.dataset\.layout=layout/);
  assert.match(css, /data-layout="vertical"/);
  assert.match(css, /border-radius:\s*0/);
  assert.match(css, /\[data-sq-snapshot-refresh-lock\]:hover/);
  assert.match(css, /\[data-sq-snapshot-refresh-lock\][\s\S]*?cursor:\s*default\s*!important/);
  assert.match(css, /\[data-sq-snapshot-refresh-lock\][\s\S]*?transform:\s*none\s*!important/);
});

test('track age uses only the selected track confirmation and omits unknown age',()=>{
 const start=patchSource.indexOf('  function trackFreshnessPresentation(');
 const end=patchSource.indexOf('\n  function trackFreshnessSourceHtml(',start);
 assert.ok(start>=0&&end>start);
 const present=Function('durationLabel','ageLabel',patchSource.slice(start,end)+';return trackFreshnessPresentation;')(
   milliseconds=>Math.floor(milliseconds/86400000)+'d',()=> '16 days ago');
 const state={status:'snapshot',fetchedAt:Date.now()-16*86400000};
 const now=Date.now();
 assert.equal(present(state,{snapshotCapturedAt:now-12*86400000},false).sourceLine,'Snapshot 12d old');
 assert.equal(present(state,{snapshotGeneration:94},true,'submitted PB').sourceLine,'Snapshot + submitted PB');
 assert.equal(present(state,{},false).updateLine,'Standings changed 16 days ago');
});
