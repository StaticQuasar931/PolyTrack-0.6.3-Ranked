import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {RELEASE_INFO} from './release-info.mjs';
import { installNativeRankedAuditFixture } from './native-ranked-audit-fixture.mjs';

const fixtureSource = fs.readFileSync(new URL('./native-ranked-audit-fixture.mjs', import.meta.url), 'utf8');
const browserSource = fs.readFileSync(new URL('./native-ranked-menu.browser.test.mjs', import.meta.url), 'utf8');

test('native audit fixture intercepts only the pinned Firebase compat SDK', async () => {
  let routePattern = null;
  let routeHandler = null;
  const initScripts = [];
  const page = {
    async route(pattern, handler) { routePattern = pattern; routeHandler = handler; },
    async addInitScript(value, argument) { initScripts.push({value, argument}); }
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
  const bootstrap = initScripts.find(script => script.value.content)?.value;
  assert.match(bootstrap.content, /native-ranked-audit/);
  assert.match(bootstrap.content, /window\.firebase = firebase/);
  const acknowledgement = initScripts.find(script => typeof script.value === 'function');
  assert.equal(acknowledgement.argument.releaseNumber, RELEASE_INFO.number);
  const stored = new Map();
  const original = globalThis.localStorage;
  try {
    globalThis.localStorage = {setItem: (key, value) => stored.set(key, value)};
    acknowledgement.value(acknowledgement.argument);
    assert.equal(stored.get(`polytrack-site-update-ack-release-v1:${RELEASE_INFO.number}`), 'acknowledged');
    assert.equal(stored.get(`polytrack-site-update-ack-v1:${acknowledgement.argument.revision}`), 'acknowledged');
  } finally {
    if (original === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = original;
  }
});

test('update-notice audits can leave the installed release unacknowledged', async () => {
  const scripts = [];
  await installNativeRankedAuditFixture({async route() {}, async addInitScript(value) {scripts.push(value);}}, {acknowledgeInstalledRevision:false});
  assert.equal(scripts.some(value => typeof value === 'function'), false);
  assert.ok(scripts.some(value => value.content));
});

test('native audit fixture rejects non-Playwright callers', async () => {
  await assert.rejects(() => installNativeRankedAuditFixture({}), /Playwright page/);
});

test('native audit exercises Exit, Back, and Ranked after reconciliation', () => {
  const exit = fixtureSource.indexOf('await startup.click({timeout})');
  const back = fixtureSource.indexOf("clickNativeMenuButton(page,'Back',timeout)");
  const ranked = fixtureSource.indexOf("locator('#injectedRankingsBtn').click");
  assert(exit >= 0 && back > exit && ranked > back, 'audit navigation order is Exit, Back, Ranked');
  assert.match(fixtureSource, /waitForTimeout\(reconciliationDelay\)/);
  assert.match(fixtureSource, /buttonVisible:/);
  assert.match(browserSource, /assert\.equal\(result\.buttonVisible, true/);
  assert.match(browserSource, /doesNotMatch\(result\.listText, \/Ranked could not finish opening\//);
});
