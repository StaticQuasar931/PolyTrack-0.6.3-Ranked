import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { installNativeRankedAuditFixture, auditNativeRankedClick } from './native-ranked-audit-fixture.mjs';

const url = String(process.env.POLYTRACK_NATIVE_AUDIT_URL || '').trim();

test('native home Ranked button opens the real panel with offline Firebase', { skip: !url }, async () => {
  const require = createRequire(new URL('./verifier/package.json', import.meta.url));
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    const localOrigin = new URL(url).origin;
    await page.route('**/*', route => {
      const request = route.request();
      const requestUrl = new URL(request.url());
      if (requestUrl.pathname === '/v6/user') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
      }
      if (requestUrl.origin === localOrigin && ['GET', 'HEAD'].includes(request.method())) return route.continue();
      return route.abort('blockedbyclient');
    });
    await installNativeRankedAuditFixture(page);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const result = await auditNativeRankedClick(page);
    console.log(JSON.stringify({ nativeRankedAudit: result }));
    assert.equal(result.clicks, 1, 'the native Ranked button must receive the click');
    assert.equal(result.buttonVisible, true, 'Ranked must remain visible after reconciliation');
    assert.equal(result.panelConnected, true, 'the real Ranked panel must remain connected');
    assert.equal(result.panelDisplay, 'flex', 'the real Ranked panel must be visible');
    assert.doesNotMatch(result.listText, /Ranked could not finish opening/);
    assert.deepEqual(result.pageErrors, []);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.rejections, []);
  } finally {
    await browser.close();
  }
});
