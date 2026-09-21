const FIREBASE_COMPAT_SDK = /^https:\/\/www\.gstatic\.com\/firebasejs\/10\.12\.2\/firebase-(?:app|auth|firestore)-compat\.js$/;

const FIREBASE_AUDIT_BOOTSTRAP = `(() => {
  if (window.__ptNativeRankedAuditBootstrap) return;
  window.__ptNativeRankedAuditBootstrap = true;
  window.__ptNativeRankedAudit = { errors: [], rejections: [] };
  window.addEventListener('error', event => window.__ptNativeRankedAudit.errors.push(String(event.error?.stack || event.message || event.error || 'error')));
  window.addEventListener('unhandledrejection', event => window.__ptNativeRankedAudit.rejections.push(String(event.reason?.stack || event.reason || 'rejection')));

  const emptyQuerySnapshot = () => ({ empty: true, size: 0, docs: [], forEach() {} });
  const emptyDocumentSnapshot = id => ({ exists: false, id: String(id || ''), data: () => undefined });
  const query = id => ({
    id: String(id || ''),
    where() { return this; }, orderBy() { return this; }, limit() { return this; }, startAfter() { return this; },
    async get() { return this.id ? emptyDocumentSnapshot(this.id) : emptyQuerySnapshot(); },
    async set() {}, async update() {}, async delete() {},
    doc(nextId) { return query(nextId); },
    collection() { return query(''); },
    onSnapshot(next) { queueMicrotask(() => next(emptyQuerySnapshot())); return () => {}; }
  });
  const firestore = {
    settings() {}, collection() { return query(''); },
    async runTransaction(callback) {
      const transaction = { get: async ref => ref.get(), set() {}, update() {}, delete() {} };
      return callback(transaction);
    }
  };
  const user = { uid: 'native-ranked-audit', isAnonymous: true, getIdToken: async () => 'native-ranked-audit-token' };
  const auth = {
    currentUser: null,
    async authStateReady() {},
    async signInAnonymously() { this.currentUser = user; return { user }; },
    onAuthStateChanged(next) { queueMicrotask(() => next(this.currentUser)); return () => {}; }
  };
  class Timestamp {
    constructor(seconds = 0, nanoseconds = 0) { this.seconds = seconds; this.nanoseconds = nanoseconds; }
    toMillis() { return this.seconds * 1000 + Math.floor(this.nanoseconds / 1000000); }
  }
  const firestoreFactory = () => firestore;
  firestoreFactory.Timestamp = Timestamp;
  firestoreFactory.FieldPath = { documentId: () => '__name__' };
  firestoreFactory.FieldValue = { serverTimestamp: () => ({ __auditServerTimestamp: true }) };
  const app = { auth: () => auth, firestore: firestoreFactory };
  const firebase = {
    apps: [],
    initializeApp() { if (!this.apps.length) this.apps.push(app); return app; },
    app: () => app,
    auth: () => auth,
    firestore: firestoreFactory
  };
  window.firebase = firebase;
})();`;

export async function installNativeRankedAuditFixture(page) {
  if (!page || typeof page.route !== 'function' || typeof page.addInitScript !== 'function') {
    throw new TypeError('A Playwright page is required.');
  }
  await page.route(FIREBASE_COMPAT_SDK, route => route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: '/* Firebase compat is supplied by native-ranked-audit-fixture.mjs. */'
  }));
  await page.addInitScript({ content: FIREBASE_AUDIT_BOOTSTRAP });
}

async function clickNativeMenuButton(page, label, timeout) {
  const button = page.locator('button').filter({ hasText: new RegExp(`^\\s*${label}\\s*$`, 'i') }).last();
  await button.waitFor({ state: 'visible', timeout });
  await button.click({ timeout });
}

export async function auditNativeRankedClick(page, { timeout = 45000, reconciliationDelay = 2200 } = {}) {
  if (!page || typeof page.waitForSelector !== 'function') throw new TypeError('A Playwright page is required.');
  const pageErrors = [];
  const onPageError = error => pageErrors.push(String(error?.stack || error));
  page.on('pageerror', onPageError);
  try {
    await clickNativeMenuButton(page, 'Exit', timeout);
    await clickNativeMenuButton(page, 'Back', timeout);
    await page.waitForSelector('#injectedRankingsBtn.ranked-ready', { state: 'visible', timeout });
    await page.waitForTimeout(reconciliationDelay);
    await page.waitForSelector('#injectedRankingsBtn.ranked-ready', { state: 'visible', timeout });
    await page.evaluate(() => {
      const button = document.getElementById('injectedRankingsBtn');
      window.__ptNativeRankedAudit.clicks = 0;
      button.addEventListener('click', () => { window.__ptNativeRankedAudit.clicks += 1; }, { capture: true, once: true });
    });
    await page.locator('#injectedRankingsBtn').click({ timeout });
    await page.waitForFunction(() => document.getElementById('overallLeaderboardPanel')?.style.display === 'flex', null, { timeout });
    await page.waitForTimeout(reconciliationDelay);
    const state = await page.evaluate(() => {
      const panel = document.getElementById('overallLeaderboardPanel');
      const list = document.getElementById('overallLeaderboardList');
      const button = document.getElementById('injectedRankingsBtn');
      const buttonStyle = button ? getComputedStyle(button) : null;
      return {
        clicks: window.__ptNativeRankedAudit.clicks,
        buttonClass: button?.className || '',
        buttonVisible: Boolean(button && buttonStyle?.display !== 'none' && buttonStyle?.visibility !== 'hidden' && button.getClientRects().length),
        panelDisplay: panel?.style.display || '',
        panelConnected: Boolean(panel?.isConnected),
        listText: String(list?.textContent || '').trim().slice(0, 300),
        errors: [...window.__ptNativeRankedAudit.errors],
        rejections: [...window.__ptNativeRankedAudit.rejections]
      };
    });
    return { ...state, pageErrors };
  } finally {
    page.off('pageerror', onPageError);
  }
}
