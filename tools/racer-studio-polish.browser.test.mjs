import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = fs.readFileSync(path.join(root, 'polytrack_062_patch.js'), 'utf8').replace(/\r\n/g, '\n');
const polish = fs.readFileSync(new URL('./racer-studio-polish.css', import.meta.url), 'utf8');
const require = createRequire(import.meta.url);
// Fail rather than silently skip when the pinned browser dependency is unavailable.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/Static/Documents/GitHub/PolyTrack 0.6.3 Ranked/tools/verifier/node_modules/playwright');
const evidence = process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR || 'C:/Users/Static/Documents/Codexstorage/PolyTrack/Projects/Ranked-0.6.3/2026-11-13/evening-update';

function between(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `Missing fixture boundary: ${start}`);
  return source.slice(a, b);
}
const options = between('  const PROFILE_COSMETIC_OPTIONS=', '\n  const profileCosmeticDrafts=');
const defaults = source.match(/  const COSMETIC_DEFAULTS=Object\.freeze\((\{[^\n]+\})\);/)[1];
const renderer = between('  function profileCustomizerMarkup(entry)', '\n\n  function noteDeveloperEvent(');
const setup = between('  function setupRacerStudio(content)', '\n\n  function profileCustomizerMarkup(');
const tabHandler = between("      const studioTab=event.target.closest?.('[data-studio-tab]');", '\n      const podiumChoice=');
const baseCSS = [...source.matchAll(/(?:style|rankedPolish)\.textContent\s*(?:\+=|=)\s*("(?:\\.|[^"\\])*?"|`(?:\\.|[^`\\])*?`)/g)]
  .map(match => vm.runInNewContext(match[1])).join('\n') + '\n' + ['home-ui.css', 'responsive-ui.css'].map(name => fs.readFileSync(path.join(root, name), 'utf8')).join('\n');
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const carImage = fs.readFileSync(path.join(root, 'images/car_thumbnail_placeholder.png')).toString('base64');
const font = fs.readFileSync(path.join(root, 'forced_square.woff2')).toString('base64');
const context = vm.createContext({
  escapeHtml, cleanUserId: String,
  profileCosmeticDrafts: new Map(), profileCosmeticEntries: new Map(),
  sanitizeProfileCosmetics: value => value, cosmeticsForEntry: () => vm.runInContext(`(${defaults})`, context),
  cosmeticUnlocked: requirement => requirement === 0 || requirement === 1,
  cosmeticUnlockReason: requirement => `Earn through racing: ${requirement || 'available now'}`,
  cosmeticTitleText: () => 'Contender', profileBadgeMarkup: () => '',
  safeDisplayName: value => value, trackInfo: () => ({ name: 'Summer 1' }),
  carModelPreview: () => `<span class="overall-car-model image-container"><img class="show" alt="Saved car preview" src="data:image/png;base64,${carImage}"></span>`
});
// The actual catalog and renderer run with explicit local entitlement/identity stubs.
const markup = vm.runInContext(`${options}\n${renderer}\nprofileCustomizerMarkup({userId:'studio-test',name:'APEX RACER'})`, context);

async function fixture(page, withPolish = true) {
  await page.route('**/*', route => route.abort());
  await page.setContent(`<style>@font-face{font-family:ForcedSquare;src:url(data:font/woff2;base64,${font})}body{margin:0;background:#0b1730;color:#fff;font-family:ForcedSquare,sans-serif}main{max-width:1260px;margin:auto;padding:16px;box-sizing:border-box}</style><main>${markup}</main><button id="outside">Outside studio</button>`);
  await page.addStyleTag({ content: baseCSS });
  if (withPolish) await page.addStyleTag({ content: polish });
  await page.addScriptTag({ content: `${setup}\nsetupRacerStudio(document);\ndocument.addEventListener('click',event=>{${tabHandler}});` });
  await page.locator('.profile-customizer').evaluate(node => { node.open = true; });
  await page.evaluate(() => document.fonts.ready);
}

test('actual Racer Studio markup fits desktop, portrait and landscape with readable locked choices', async () => {
  fs.mkdirSync(evidence, { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  const report = [];
  try {
    const page = await browser.newPage();
    await fixture(page);
    for (const [width, height, name] of [[1440, 1000, 'desktop'], [390, 844, 'phone'], [320, 568, 'small-phone'], [844, 390, 'landscape'], [768, 1024, 'tablet']]) {
      await page.setViewportSize({ width, height });
      for (const tab of ['nameplate', 'name', 'car', 'identity']) {
        await page.locator(`[data-studio-tab="${tab}"]`).click();
        const panel = page.locator(`[data-studio-panel="${tab}"]`);
        assert.equal(await panel.isVisible(), true);
        const metrics = await page.evaluate(() => {
          const studio = document.querySelector('.profile-customizer');
          const nodes = [...studio.querySelectorAll('summary,.studio-tabs,.profile-customizer-preview,.profile-customizer-actions,fieldset,button,input')].filter(el => el.getClientRects().length);
          return { documentWidth: document.documentElement.scrollWidth, overflow: nodes.filter(el => el.scrollWidth > el.clientWidth + 2).map(el => el.className), tinyButtons: nodes.filter(el => el.matches('button') && el.getBoundingClientRect().height < 44).map(el => el.className) };
        });
        assert.ok(metrics.documentWidth <= width + 1, `${name}/${tab}: page overflow ${metrics.documentWidth}`);
        assert.deepEqual(metrics.overflow, [], `${name}/${tab}: internal overflow`);
        assert.deepEqual(metrics.tinyButtons, [], `${name}/${tab}: touch targets`);
        assert.equal(await page.locator('.studio-panel:not([hidden])').count(), 1);
        report.push({ width, height, tab, ...metrics });
      }
      await page.locator('[data-studio-tab="nameplate"]').click();
      await page.locator('.profile-customizer > summary').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(evidence, `racer-studio-${name}.png`), fullPage: true });
      await page.locator('.studio-close-bottom').scrollIntoViewIfNeeded();
      const close = await page.locator('.studio-close-bottom').boundingBox();
      assert.ok(close.y >= 0 && close.y + close.height <= height + 1, `${name}: bottom control reachable`);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('[data-studio-tab="nameplate"]').scrollIntoViewIfNeeded();
    await page.locator('[data-studio-tab="nameplate"]').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('[data-studio-tab="name"]').getAttribute('aria-selected'), 'true');
    const focused = await page.locator(':focus').evaluate(el => ({ style: getComputedStyle(el).outlineStyle, width: getComputedStyle(el).outlineWidth, color: getComputedStyle(el).outlineColor, inset: getComputedStyle(el).boxShadow }));
    assert.equal(focused.style, 'solid');
    assert.equal(focused.width, '3px');
    assert.equal(focused.color, 'rgb(255, 218, 131)');
    assert.match(focused.inset, /rgb\(255, 218, 131\).*inset|inset.*rgb\(255, 218, 131\)/);
    await page.screenshot({ path: path.join(evidence, 'racer-studio-keyboard-focus.png') });
    const locked = page.locator('.studio-panel:not([hidden]) [data-cosmetic-locked="true"]').first();
    assert.equal(await locked.getAttribute('aria-disabled'), 'true');
    assert.match(await locked.getAttribute('aria-label'), /Locked/);
    const lockStyle = await locked.evaluate(el => ({ opacity: getComputedStyle(el).opacity, note: getComputedStyle(el.querySelector('small')).fontSize }));
    assert.deepEqual(lockStyle, { opacity: '1', note: '13px' });
    assert.equal(await locked.isDisabled(), true);
    assert.equal(await locked.getAttribute('aria-pressed'), 'false');
    for (const system of [true, false]) {
      await page.emulateMedia({ reducedMotion: system ? 'reduce' : 'no-preference' });
      await page.evaluate(system => document.documentElement.classList.toggle('sq-reduced-effects', !system), system);
      assert.equal(await locked.evaluate(el => getComputedStyle(el).transitionDuration), '0s');
    }
    await page.screenshot({ path: path.join(evidence, 'racer-studio-reduced-motion.png') });
    await page.locator('[data-studio-tab="identity"]').click();
    await page.screenshot({ path: path.join(evidence, 'racer-studio-identity.png'), fullPage: true });
    fs.writeFileSync(path.join(evidence, 'racer-studio-report.json'), JSON.stringify({ renderer: 'profileCustomizerMarkup extracted from polytrack_062_patch.js', network: 'all requests aborted', layouts: report, focus: focused, locks: lockStyle, reducedMotion: 'system and app preference passed' }, null, 2));
  } finally { await browser.close(); }
});

test('studio polish does not repaint saved designs, change plate geometry, or style journal content', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await fixture(page, false);
    await page.locator('.profile-customizer-controls').evaluate(el => el.insertAdjacentHTML('beforeend', '<section data-studio-panel="achievements" class="studio-panel"><article class="achievement-journal">Journal content</article></section>'));
    const snapshot = () => page.evaluate(() => {
      const properties = ['backgroundImage', 'backgroundColor', 'color', 'clipPath', 'transform', 'fontFamily', 'fontSize', 'borderRadius'];
      const read = selector => [...document.querySelectorAll(selector)].map(el => Object.fromEntries(properties.map(key => [key, getComputedStyle(el)[key]])));
      return { plates: read('.showcase-row,.profile-preview-stage,.profile-preview-stage>span,.profile-preview-stage>span>b,.profile-cosmetic-preview'), journal: read('.achievement-journal'), outside: read('#outside') };
    });
    const before = await snapshot();
    await page.addStyleTag({ content: polish });
    assert.deepEqual(await snapshot(), before, 'Saved preview paint, plate shape, samples and unrelated content stay unchanged');
  } finally { await browser.close(); }
});
