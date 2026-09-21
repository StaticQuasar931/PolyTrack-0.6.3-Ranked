import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installNativeRankedAuditFixture } from './native-ranked-audit-fixture.mjs';

const fixtureSource = fs.readFileSync(new URL('./native-ranked-audit-fixture.mjs', import.meta.url), 'utf8');
const browserSource = fs.readFileSync(new URL('./native-ranked-menu.browser.test.mjs', import.meta.url), 'utf8');

test('native audit fixture intercepts only the pinned Firebase compat SDK', async () => {
  let routePattern = null;
  let routeHandler = null;
  let initScript = null;
  const page = {
    async route(pattern, handler) { routePattern = pattern; routeHandler = handler; },
    async addInitScript(value) { initScript = value; }
  };
  await installNativeRankedAuditFixture(page);
  assert(routePattern.test('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js'));
  assert(routePattern.test('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js'));
  assert(routePattern.test('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js'));
  assert.equal(routePattern.test('https://www.gstatic.com/firebasejs/10.12.3/firebase-app-compat.js'), false);
  assert.equal(routePattern.test('https://example.com/firebase-app-compat.js'), false);
  let response = null;
  await routeHandler({ fulfill: value => { response = value; } });
  assert.equal(response.status, 200);
  assert.equal(response.contentType, 'application/javascript');
  assert.match(initScript.content, /native-ranked-audit/);
  assert.match(initScript.content, /window\.firebase = firebase/);
});

test('native audit fixture rejects non-Playwright callers', async () => {
  await assert.rejects(() => installNativeRankedAuditFixture({}), /Playwright page/);
});

test('native audit exercises Exit, Back, and Ranked after reconciliation', () => {
  const exit = fixtureSource.indexOf("clickNativeMenuButton(page, 'Exit'");
  const back = fixtureSource.indexOf("clickNativeMenuButton(page, 'Back'");
  const ranked = fixtureSource.indexOf("locator('#injectedRankingsBtn').click");
  assert(exit >= 0 && back > exit && ranked > back, 'audit navigation order is Exit, Back, Ranked');
  assert.match(fixtureSource, /waitForTimeout\(reconciliationDelay\)/);
  assert.match(fixtureSource, /buttonVisible:/);
  assert.match(browserSource, /assert\.equal\(result\.buttonVisible, true/);
  assert.match(browserSource, /doesNotMatch\(result\.listText, \/Ranked could not finish opening\//);
});
