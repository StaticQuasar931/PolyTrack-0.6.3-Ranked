import test from 'node:test';
import assert from 'node:assert/strict';
import { installSiteUpdates } from './site-updates.mjs';

class FakeDocument extends EventTarget {
  constructor() {
    super(); this.visibilityState = 'visible'; this.baseURI = 'https://game.example/path/';
    this.body = { append: (element) => { this.button = element; } };
  }
  hasFocus() { return true; }
  createElement() { return { style: {}, dataset: {}, listeners: {}, setAttribute(name, value) { this[name] = value; },
    addEventListener(name, fn) { this.listeners[name] = fn; }, remove() { this.removed = true; } }; }
}

function harness({ response = { revision: 44 }, isIdle = () => true } = {}) {
  const document = new FakeDocument(); let time = 1000, calls = 0, reloadChecks = 0, nextTimer = 0;
  const timers = new Map();
  const handle = installSiteUpdates({ revision: 43, document, now: () => time, isIdle,
    fetch: async (url, options) => { calls++; assert.equal(url, 'https://game.example/path/site-version.json');
      assert.equal(options.cache, 'no-store'); return { ok: true, json: async () => response }; },
    setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimeout: (id) => timers.delete(id), canReload: () => { reloadChecks++; return false; } });
  return { document, handle, timers, get calls() { return calls; }, get reloadChecks() { return reloadChecks; }, setTime: (value) => { time = value; } };
}

test('checks same-origin version and offers reload only from a user-clickable notification', async () => {
  const h = harness(); await h.handle.check();
  assert.equal(h.calls, 1); assert.equal(h.document.button.textContent, 'Update available');
  assert.equal(h.document.button.dataset.siteUpdate, 'available');
  assert.equal(h.reloadChecks, 0, 'finding an update must not interrupt the current session');
  h.document.button.listeners.click();
  assert.equal(h.reloadChecks, 1, 'reload safety is checked only after an explicit click');
  h.handle.dispose();
});

test('deduplicates installations and throttles interval and visibility-resume checks', async () => {
  const h = harness();
  assert.equal(installSiteUpdates({ revision: 43, document: h.document, fetch: async () => assert.fail('duplicate') }), h.handle);
  await h.handle.check(); assert.equal(h.calls, 1);
  h.document.dispatchEvent(new Event('visibilitychange')); await Promise.resolve(); assert.equal(h.calls, 1);
  h.setTime(1000 + 30 * 60 * 1000); await h.handle.check(); assert.equal(h.calls, 2); h.handle.dispose();
});

test('does not check while hidden or not idle', async () => {
  let idle = false; const h = harness({ isIdle: () => idle }); await h.handle.check();
  h.document.visibilityState = 'hidden'; idle = true; await h.handle.check(); assert.equal(h.calls, 0);
  h.document.visibilityState = 'visible'; await h.handle.check(); assert.equal(h.calls, 1); h.handle.dispose();
});

test('rejects invalid revisions and never requests a cross-origin endpoint', async () => {
  for (const response of [{ revision: 43 }, { revision: '44' }, { revision: -1 }]) {
    const h = harness({ response }); await h.handle.check(); assert.equal(h.document.button, undefined); h.handle.dispose();
  }
  const document = new FakeDocument();
  const h = installSiteUpdates({ revision: 43, document, endpoint: 'https://other.example/site-version.json',
    fetch: async () => assert.fail('cross-origin request') });
  await h.check(); h.dispose();
});

test('contains fetch failures and removes the notification on disposal', async () => {
  const h = harness(); await h.handle.check(); h.handle.dispose(); assert.equal(h.document.button.removed, true);
  const document = new FakeDocument();
  const failed = installSiteUpdates({ revision: 43, document, fetch: async () => { throw Error('offline'); } });
  await failed.check(); assert.equal(document.button, undefined); failed.dispose();
});
