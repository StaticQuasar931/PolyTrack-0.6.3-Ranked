import test from 'node:test';
import assert from 'node:assert/strict';
import { installSiteUpdates, installInstalledRevisionNotice, releaseUpdateAge, formatReleaseUpdateAge, bindReleaseUpdateAge, UPDATED_GAME_URL, CANONICAL_SITE_VERSION_URL, CANONICAL_RELEASE_POINTER_URL } from './site-updates.mjs';
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

class FakeElement {
  constructor(tag, document) {
    Object.assign(this, { tag, document, style: {}, dataset: {}, listeners: {}, children: [], isConnected: false });
  }
  setAttribute(name, value) { this[name] = value; }
  removeAttribute(name) { delete this[name]; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  append(...children) {
    for (const child of children) { child.parent = this; child.isConnected = true; this.children.push(child); }
  }
  remove() { this.removed = true; this.isConnected = false; }
  showModal() { if (this.document.dialogFailure) throw Error('dialog unavailable'); this.open = true; }
  close() { this.open = false; }
  focus() { this.document.activeElement = this; }
}
class FakeDocument extends EventTarget {
  constructor() {
    super(); this.visibilityState = 'visible'; this.baseURI = 'https://game.example/path/';
    this.body = new FakeElement('body', this);
    const append = this.body.append.bind(this.body);
    this.body.append = (element) => { append(element); if (element.tag === 'button' || element.tag === 'a') this.button = element; };
  }
  hasFocus() { return true; }
  createElement(tag) { return new FakeElement(tag, this); }
  get dialog() { return this.body.children.find(element => element.tag === 'dialog' && !element.removed); }
}

function harness({ response = { revision: 44 }, isIdle = () => true, revision = 43, ...options } = {}) {
  const document = options.document || new FakeDocument(); let time = 1000, calls = 0, reloadChecks = 0, nextTimer = 0, currentResponse=response;
  const timers = new Map();
  const handle = installSiteUpdates({ revision, document, now: () => time, isIdle, endpoint: 'site-version.json',
    fetch: async (url, options) => { calls++; const parsed=new URL(url);assert.equal(parsed.origin+parsed.pathname,'https://game.example/path/site-version.json');
      assert.equal(parsed.searchParams.get('_updateCheck'),String(time));assert.equal(options.cache, 'no-store'); return { ok: true, json: async () => currentResponse }; },
    setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimeout: (id) => timers.delete(id), canReload: () => { reloadChecks++; return false; }, ...options });
  return { document, handle, timers, get calls() { return calls; }, get reloadChecks() { return reloadChecks; }, setTime: (value) => { time = value; }, setResponse: value => { currentResponse=value; } };
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

test('clears an obsolete update badge when the loaded revision is current', async () => {
  const h=harness();await h.handle.check();
  const badge=h.document.button;assert.equal(badge.dataset.siteUpdate,'available');
  h.setTime(1000+30*60*1000);h.setResponse({revision:'44'});await h.handle.check();
  assert.equal(badge.removed,undefined,'an invalid response must not clear a valid notification');
  h.setTime(1000+60*60*1000);h.setResponse({revision:43});await h.handle.check();
  assert.equal(badge.removed,true);assert.equal(h.document.button,badge);
  h.setTime(1000+90*60*1000);h.setResponse({revision:45});await h.handle.check();
  assert.notEqual(h.document.button,badge);assert.equal(h.document.button.dataset.siteUpdate,'available');
  h.handle.dispose();
});

test('new bootstrap revision clears stale remote state but retains a genuinely newer release',async()=>{
  const h=harness({revision:114,response:{revision:115}});await h.handle.check();
  const badge=h.document.button;assert.ok(badge);
  h.setTime(1000+30*60*1000);h.setResponse({revision:112});await h.handle.check();
  assert.equal(badge.removed,true,'a stale remote manifest cannot leave the old badge visible');
  h.setTime(1000+60*60*1000);h.setResponse({revision:115});await h.handle.check();
  assert.equal(h.document.button.dataset.siteUpdate,'available','a revision newer than the loaded client remains visible');
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

test('rejects invalid revisions and never requests an arbitrary cross-origin endpoint', async () => {
  for (const response of [{ revision: 43 }, { revision: '44' }, { revision: -1 }]) {
    const h = harness({ response }); await h.handle.check(); assert.equal(h.document.button, undefined); h.handle.dispose();
  }
  const document = new FakeDocument();
  const h = installSiteUpdates({ revision: 43, document, endpoint: 'https://other.example/site-version.json',
    fetch: async () => assert.fail('cross-origin request') });
  await h.check(); h.dispose();
});

test('default on a copied build checks only the exact canonical manifest using credential-free CORS', async () => {
  const requests = [];
  const h = harness({revision: 158, endpoint: undefined, fetch: async (url, options) => {
    requests.push({url, options});
    return {ok: true, json: async () => ({revision: 160, minimumSupportedRevision: 159})};
  }});
  await h.handle.check();
  assert.equal(requests.length, 1);
  const {url, options} = requests[0];
  assert.equal(CANONICAL_SITE_VERSION_URL, 'https://staticquasar931.github.io/PolyTrack-0.6.3-Ranked/site-version.json');
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, CANONICAL_SITE_VERSION_URL);
  assert.equal(parsed.search, '?_updateCheck=1000');
  assert.equal(options.method, 'GET');
  assert.equal(options.mode, 'cors');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.redirect, 'error');
  assert.equal(options.referrerPolicy, 'no-referrer');
  assert.equal(options.cache, 'no-store');
  assert.deepEqual(options.headers, {Accept: 'application/json'});
  assert.equal(h.handle.getCompatibility().onlineAllowed, false);
  h.handle.dispose();
});

test('explicit relative and absolute same-origin manifests retain local support', async () => {
  for (const endpoint of ['site-version.json', '/local-version.json', 'https://game.example/test.json?local=1']) {
    let calls = 0;
    const h = harness({endpoint, fetch: async (url, options) => {
      calls++;
      const expected = new URL(endpoint, 'https://game.example/path/');
      const actual = new URL(url);
      assert.equal(actual.origin + actual.pathname, expected.origin + expected.pathname);
      assert.equal(options.credentials, 'omit');
      assert.equal(options.mode, 'same-origin');
      assert.equal(options.redirect, 'error');
      return {ok: true, json: async () => ({revision: 44})};
    }});
    await h.handle.check();
    assert.equal(calls, 1);
    assert.equal(h.document.button.textContent, 'Update available');
    h.handle.dispose();
  }
});

test('cross-origin allowlist excludes every other host, path, scheme, port, query, fragment and userinfo', async () => {
  for (const endpoint of [
    'https://other.example/site-version.json',
    'https://staticquasar931.github.io/another-game/site-version.json',
    'https://staticquasar931.github.io/PolyTrack-0.6.3-Ranked/other.json',
    'https://staticquasar931.github.io/PolyTrack-0.6.3-Ranked/site-version.json/',
    'http://staticquasar931.github.io/PolyTrack-0.6.3-Ranked/site-version.json',
    'https://staticquasar931.github.io:444/PolyTrack-0.6.3-Ranked/site-version.json',
    `${CANONICAL_SITE_VERSION_URL}?redirect=https://other.example`,
    `${CANONICAL_SITE_VERSION_URL}?_updateCheck=1`, `${CANONICAL_SITE_VERSION_URL}#fragment`,
    'https://name:password@staticquasar931.github.io/PolyTrack-0.6.3-Ranked/site-version.json',
    'https://staticquasar931.github.io.attacker.invalid/PolyTrack-0.6.3-Ranked/site-version.json',
    'data:application/json,{"revision":160}', 'file:///tmp/site-version.json'
  ]) {
    let calls = 0;
    const h = harness({endpoint, fetch: async () => { calls++; return {ok: true}; }});
    await h.handle.check();
    assert.equal(calls, 0, endpoint);
    assert.equal(h.handle.getCompatibility().onlineAllowed, true);
    h.handle.dispose();
  }
});

test('canonical errors try only the fixed CDN pointer, then fail open without a fork manifest', async () => {
  for (const failure of ['cors', 'redirect']) {
    let fail = false;
    const requested = [];
    const h = harness({revision: 158, endpoint: CANONICAL_SITE_VERSION_URL, fetch: async url => {
      requested.push(url);
      if (fail && failure === 'cors') throw new TypeError('Failed to fetch');
      return {ok: true, redirected: fail, json: async () => ({revision: 160, minimumSupportedRevision: 159})};
    }});
    await h.handle.check();
    assert.equal(h.handle.getCompatibility().onlineAllowed, false);
    fail = true; h.setTime(1000 + 30 * 60 * 1000); await h.handle.check();
    assert.equal(h.handle.getCompatibility().onlineAllowed, true);
    assert.equal(h.document.dialog, undefined);
    assert.equal(requested.length, 3);
    assert.ok(requested.slice(0,2).every(url => url.startsWith(`${CANONICAL_SITE_VERSION_URL}?_updateCheck=`)));
    assert.equal(requested[2], CANONICAL_RELEASE_POINTER_URL);
    h.handle.dispose();
  }
});

const cdnPointer = {schemaVersion: 1, repository: 'StaticQuasar931/PolyTrack-0.6.3-Ranked',
  commit: 'a'.repeat(40), indexSha256: 'b'.repeat(64), snapshotDirectory: 'public-snapshots69', publishedAt: '2026-10-28T00:00:00.000Z'};
const cdnVersionUrl = `https://cdn.jsdelivr.net/gh/${cdnPointer.repository}@${cdnPointer.commit}/site-version.json`;
const jsonResponse = data => new Response(JSON.stringify(data));

test('school embeds blocked from Pages detect client updates through the existing immutable CDN release', async () => {
  const requested = [];
  const h = harness({revision: 205, endpoint: CANONICAL_SITE_VERSION_URL, fetch: async (url, options) => {
    requested.push(url);
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    assert.equal(options.referrerPolicy, 'no-referrer'); assert.equal(options.cache, 'no-store');
    if (url.startsWith(CANONICAL_SITE_VERSION_URL)) throw TypeError('Blocked by school');
    if (url === CANONICAL_RELEASE_POINTER_URL) return jsonResponse({...cdnPointer, revision: 9999,
      minimumSupportedRevision: 9999, url: 'https://untrusted.invalid/site-version.json'});
    assert.equal(url, cdnVersionUrl); return jsonResponse({revision: 206});
  }});
  await h.handle.check();
  assert.deepEqual(requested, [`${CANONICAL_SITE_VERSION_URL}?_updateCheck=1000`, CANONICAL_RELEASE_POINTER_URL, cdnVersionUrl]);
  assert.equal(h.document.button.textContent, 'Update available');
  assert.equal(h.handle.getCompatibility().latestRevision, 206, 'pointer fields are not version policy');
  assert.equal(h.handle.getCompatibility().onlineAllowed, true);
  await h.handle.check(); assert.equal(requested.length, 3, 'fallback uses the same network cooldown');
  h.handle.dispose(); assert.equal(h.timers.size, 0);
});

test('invalid CDN identity or commit cannot expand the allowlist', async () => {
  for (const replacement of [null, {...cdnPointer, repository: 'other/repo'}, {...cdnPointer, schemaVersion: 2},
    ...['main','a'.repeat(39),'a'.repeat(40)+'/../other','https://evil.test','a'.repeat(40)+'?x=1'].map(commit => ({...cdnPointer, commit})),
    {...cdnPointer, snapshotDirectory: '../public-snapshots69'}, {...cdnPointer, indexSha256: 'bad'}, {...cdnPointer, publishedAt: 'bad'}]) {
    const requested = [];
    const h = harness({endpoint: CANONICAL_SITE_VERSION_URL, fetch: async url => {
      requested.push(url); if (url.startsWith(CANONICAL_SITE_VERSION_URL)) throw Error('blocked');
      assert.equal(url, CANONICAL_RELEASE_POINTER_URL); return jsonResponse(replacement);
    }});
    await h.handle.check(); assert.equal(requested.length, 2); assert.equal(h.document.button, undefined);
    assert.equal(h.handle.getCompatibility().onlineAllowed, true); h.handle.dispose();
  }
});

test('fallback does not run for local endpoints or a successful canonical manifest', async () => {
  for (const endpoint of ['site-version.json', CANONICAL_SITE_VERSION_URL]) {
    let calls = 0;
    const h = harness({endpoint, fetch: async () => { calls++; if (endpoint === 'site-version.json') throw Error('local failed'); return jsonResponse({revision: 43}); }});
    await h.handle.check(); assert.equal(calls, 1); h.handle.dispose();
  }
});

test('CDN pointer redirects, HTTP errors, malformed and oversized JSON stay fail-open and bounded', async () => {
  for (const makeResponse of [() => ({ok: true, redirected: true}), () => ({ok: false}),
    () => new Response('{'), () => jsonResponse({...cdnPointer, padding: 'x'.repeat(17000)}),
    () => new Response('{}', {headers: {'content-length': '17000'}})]) {
    let calls = 0;
    const h = harness({endpoint: CANONICAL_SITE_VERSION_URL, fetch: async url => {
      calls++; if (url.startsWith(CANONICAL_SITE_VERSION_URL)) throw Error('blocked'); return makeResponse();
    }});
    await h.handle.check(); assert.equal(calls, 2); assert.equal(h.document.button, undefined);
    assert.equal(h.handle.getCompatibility().onlineAllowed, true); h.handle.dispose();
  }
});

test('canonical timeout can reach CDN, and disposal during fallback prevents the commit request', async () => {
  let calls = 0;
  const h = harness({endpoint: CANONICAL_SITE_VERSION_URL, fetch: async url => {
    calls++;
    if (url.startsWith(CANONICAL_SITE_VERSION_URL)) return new Promise(() => {});
    return jsonResponse(url === CANONICAL_RELEASE_POINTER_URL ? cdnPointer : {revision: 44});
  }});
  const pending = h.handle.check(); await Promise.resolve();
  [...h.timers.values()].find(timer => timer.delay === 8000).fn(); await pending;
  assert.equal(calls, 3); assert.ok(h.document.button); h.handle.dispose(); assert.equal(h.timers.size, 0);
  let pointerRequested = false, finishPointer;
  const stopped = harness({endpoint: CANONICAL_SITE_VERSION_URL, fetch: async url => {
    if (url.startsWith(CANONICAL_SITE_VERSION_URL)) throw Error('blocked');
    assert.equal(url, CANONICAL_RELEASE_POINTER_URL); pointerRequested = true;
    return new Promise(done => { finishPointer = done; });
  }});
  const request = stopped.handle.check();
  for (let tick = 0; tick < 30 && !pointerRequested; tick++) await Promise.resolve();
  assert.equal(pointerRequested, true); stopped.handle.dispose(); finishPointer(jsonResponse(cdnPointer)); await request;
  assert.equal(stopped.document.button, undefined); assert.equal(stopped.timers.size, 0);
});

test('contains fetch failures and removes the notification on disposal', async () => {
  const h = harness(); await h.handle.check(); h.handle.dispose(); assert.equal(h.document.button.removed, true);
  const document = new FakeDocument();
  const failed = installSiteUpdates({ revision: 43, document, fetch: async () => { throw Error('offline'); } });
  await failed.check(); assert.equal(document.button, undefined); failed.dispose();
});

test('checked-in updater, client loader and published revision agree', () => {
  const root=new URL('../',import.meta.url);
  const revision=JSON.parse(readFileSync(new URL('site-version.json',root),'utf8')).revision;
  const patch=readFileSync(new URL('polytrack_062_patch.js',root),'utf8');
  const index=readFileSync(new URL('index.html',root),'utf8');
  assert.ok(patch.includes(`installSiteUpdates({revision:${revision},`));
  assert.ok(patch.includes(`site-updates.mjs?v=${revision}`));
  assert.ok(index.includes(`polytrack_062_patch.js?v=${revision}`));
});

const INTERVAL = 30 * 60 * 1000;
const unsupported = { revision: 160, minimumSupportedRevision: 159 };
function choices(document) { return document.dialog.children[2].children; }

const memoryStorage = () => {
  const values = new Map();
  return {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value)};
};
function noticeHarness(options = {}) {
  const document = options.document || new FakeDocument();
  document.defaultView ||= new EventTarget();
  const handle = installInstalledRevisionNotice({revision: 205, document, isReady: () => true,
    storage: null, sessionStorage: null, ...options});
  return {document, handle};
}
test('installed notice waits for UI, blocked menu and race, then acknowledges only explicit OK', () => {
  let ready = false, idle = false;
  const storage = memoryStorage();
  const h = noticeHarness({storage, isReady: () => ready, isIdle: () => idle});
  assert.equal(h.document.dialog, undefined);
  ready = true; h.handle.resume(); assert.equal(h.document.dialog, undefined);
  idle = true; h.handle.resume();
  const first = h.document.dialog; assert.ok(first?.open);
  assert.equal(storage.getItem('polytrack-site-update-ack-v1:205'), null);
  for (let i = 0; i < 20; i++) h.handle.resume();
  assert.equal(h.document.dialog, first, 'UI reconciliation does not duplicate the notice');
  idle = false; h.handle.resume(); assert.equal(h.document.dialog, undefined);
  idle = true; h.handle.resume(); assert.notEqual(h.document.dialog, first);
  h.document.dialog.children[3].listeners.click();
  assert.equal(storage.getItem('polytrack-site-update-ack-v1:205'), 'acknowledged');
  h.handle.resume(); assert.equal(h.document.dialog, undefined); h.handle.dispose();
  const refresh = noticeHarness({storage}); assert.equal(refresh.document.dialog, undefined); refresh.handle.dispose();
  const next = noticeHarness({storage, revision: 206}); assert.ok(next.document.dialog); next.handle.dispose();
});

test('Escape acknowledges, but hidden, failed, removed and disposed notices remain pending', () => {
  const storage = memoryStorage(), document = new FakeDocument();
  document.visibilityState = 'hidden';
  const h = noticeHarness({document, storage}); assert.equal(document.dialog, undefined);
  document.visibilityState = 'visible'; document.dialogFailure = true;
  document.dispatchEvent(new Event('visibilitychange')); assert.equal(document.dialog, undefined);
  document.dialogFailure = false; h.handle.resume(); document.dialog.remove();
  h.handle.resume(); assert.ok(document.dialog?.open);
  h.handle.dispose(); assert.equal(storage.getItem('polytrack-site-update-ack-v1:205'), null);
  const retry = noticeHarness({document, storage}); assert.ok(document.dialog);
  let prevented = false;
  document.dialog.listeners.cancel({preventDefault() { prevented = true; }});
  assert.equal(prevented, true); retry.handle.dispose();
  const refreshed = noticeHarness({storage}); assert.equal(refreshed.document.dialog, undefined); refreshed.handle.dispose();
});

test('storage unavailable falls back to session, then memory without repeated in-page notices', () => {
  const broken = {getItem() { throw Error('denied'); }, setItem() { throw Error('quota'); }};
  const sessionStorage = memoryStorage();
  const h = noticeHarness({storage: broken, sessionStorage}); h.document.dialog.children[3].listeners.click(); h.handle.dispose();
  const refresh = noticeHarness({storage: broken, sessionStorage}); assert.equal(refresh.document.dialog, undefined); refresh.handle.dispose();
  const memory = noticeHarness({storage: broken, sessionStorage: broken});
  memory.document.dialog.children[3].listeners.click(); memory.handle.dispose();
  const again = noticeHarness({document: memory.document, storage: broken, sessionStorage: broken});
  assert.equal(again.document.dialog, undefined); again.handle.dispose();
  const document = new FakeDocument(); document.defaultView = new EventTarget();
  for (const key of ['localStorage', 'sessionStorage']) Object.defineProperty(document.defaultView, key, {get() { throw Error('denied'); }});
  const denied = noticeHarness({document, storage: undefined, sessionStorage: undefined});
  assert.ok(document.dialog); document.dialog.children[3].listeners.click(); denied.handle.resume();
  assert.equal(document.dialog, undefined); denied.handle.dispose();
});

test('cross-tab acknowledgement and disposal release notice listeners without polling', () => {
  const storage = memoryStorage(), h = noticeHarness({storage});
  assert.equal(installInstalledRevisionNotice({revision: 205, document: h.document}), h.handle);
  storage.setItem('polytrack-site-update-ack-v1:205', 'acknowledged');
  const event = new Event('storage'); event.key = 'polytrack-site-update-ack-v1:205';
  h.document.defaultView.dispatchEvent(event); assert.equal(h.document.dialog, undefined);
  h.handle.dispose(); h.handle.dispose(); h.document.defaultView.dispatchEvent(new Event('pageshow'));
  assert.equal(h.document.dialog, undefined);
});

test('manifest received during a race resumes immediately without another network check', async () => {
  let idle = true, resolve;
  const h = harness({revision: 158, isIdle: () => idle, fetch: () => new Promise(done => { resolve = done; })});
  const pending = h.handle.check(); await Promise.resolve(); idle = false;
  resolve({ok: true, json: async () => unsupported}); await pending;
  assert.equal(h.document.dialog, undefined); assert.equal(h.document.button, undefined);
  idle = true; h.handle.resume(); assert.ok(h.document.dialog?.open); assert.ok(h.document.button);
  const dialog = h.document.dialog; await h.handle.check(); assert.equal(h.document.dialog, dialog);
  h.handle.dispose(); assert.equal(h.timers.size, 0);
});

test('minimum policy is dormant when absent and boundary revisions remain supported', async () => {
  for (const response of [{ revision: 160 }, { revision: 160, minimumSupportedRevision: 0 },
    { revision: 160, minimumSupportedRevision: 158 }]) {
    const states = [];
    const h = harness({revision: 158, response, onCompatibilityChange: state => states.push(state)});
    await h.handle.check();
    assert.equal(h.handle.getCompatibility().onlineAllowed, true);
    assert.equal(h.document.dialog, undefined);
    assert.equal(states.some(state => !state.onlineAllowed), false);
    assert.equal(h.document.button.textContent, 'Update available');
    h.handle.dispose();
  }
});

test('unsupported client shows labelled native blue square dialog with fixed safe new-tab URL', async () => {
  const h = harness({revision: 158, response: {...unsupported, url: 'javascript:evil()',
    updateUrl: 'https://attacker.invalid', message: '<script>bad</script>'}});
  await h.handle.check();
  const dialog = h.document.dialog;
  assert.equal(dialog.open, true);
  assert.equal(dialog['aria-labelledby'], dialog.children[0].id);
  assert.equal(dialog['aria-describedby'], dialog.children[1].id);
  assert.equal(dialog.style.borderRadius, '0');
  assert.equal(dialog.style.background, '#1c2959');
  assert.equal(dialog.style.font, 'clamp(18px, 5dvh, 22px)/1.35 ForcedSquare, sans-serif');
  const [open, offline] = choices(h.document);
  assert.equal(open.textContent, 'Open updated game');
  assert.equal(open.href, 'https://staticquasar931.github.io/PolyTrack-0.6.3-Ranked/');
  assert.equal(open.href, UPDATED_GAME_URL);
  assert.equal(open.target, '_blank');
  assert.equal(open.rel, 'noopener noreferrer');
  assert.match(open['aria-label'], /new tab/);
  assert.equal(offline.textContent, 'Stay here offline');
  assert.equal(offline.type, 'button');
  assert.equal(h.document.activeElement, offline);
  assert.equal(h.reloadChecks, 0);
  assert.deepEqual(h.handle.getCompatibility(), {onlineAllowed: false, revision: 158,
    latestRevision: 160, minimumSupportedRevision: 159, reason: 'unsupported'});
  h.handle.dispose();
});

test('offline choice and Escape dismiss without reloading, restore focus and avoid repeated nagging', async () => {
  for (const cancel of [false, true]) {
    let idle = false;
    const h = harness({revision: 158, response: unsupported, isIdle: () => idle});
    const previous = h.document.createElement('button');
    h.document.body.append(previous); previous.focus();
    idle = true;
    await h.handle.check();
    const dialog = h.document.dialog;
    if (cancel) {
      let prevented = false;
      dialog.listeners.cancel({preventDefault() { prevented = true; }});
      assert.equal(prevented, true);
    } else choices(h.document)[1].listeners.click();
    assert.equal(h.document.dialog, undefined);
    assert.equal(h.document.activeElement, previous);
    assert.equal(h.handle.getCompatibility().onlineAllowed, false);
    assert.equal(h.handle.getCompatibility().reason, 'offline-selected');
    h.handle.dispose();
  }
  const h = harness({revision: 158, response: unsupported});
  await h.handle.check(); choices(h.document)[1].listeners.click();
  h.setTime(1000 + INTERVAL); await h.handle.check();
  assert.equal(h.document.dialog, undefined);
  assert.equal(h.handle.getCompatibility().reason, 'offline-selected');
  h.setTime(1000 + 2 * INTERVAL); h.setResponse({revision: 161, minimumSupportedRevision: 160});
  await h.handle.check(); assert.ok(h.document.dialog, 'changed minimum gets a new explanation');
  h.handle.dispose();
});

test('valid supported or absent policy restores online compatibility and closes dialog', async () => {
  for (const response of [{revision: 160}, {revision: 160, minimumSupportedRevision: 158}]) {
    const states = [];
    const h = harness({revision: 158, response: unsupported, onCompatibilityChange: s => states.push(s)});
    await h.handle.check();
    assert.equal(states.at(-1).onlineAllowed, false);
    h.setTime(1000 + INTERVAL); h.setResponse(response); await h.handle.check();
    assert.equal(states.at(-1).onlineAllowed, true);
    assert.equal(h.document.dialog, undefined);
    h.handle.dispose();
  }
});

test('same-minimum checks reuse the dialog and offline choice reports the latest manifest', async () => {
  const h = harness({revision: 158, response: unsupported}); await h.handle.check();
  const dialog = h.document.dialog;
  h.setTime(1000 + INTERVAL); h.setResponse({...unsupported, revision: 161}); await h.handle.check();
  assert.equal(h.document.dialog, dialog);
  choices(h.document)[1].listeners.click();
  assert.equal(h.handle.getCompatibility().latestRevision, 161);
  h.handle.dispose();
});

test('dialog keyboard wraps between the explicit choices without affecting other keys', async () => {
  const h = harness({revision: 158, response: unsupported}); await h.handle.check();
  const [open, offline] = choices(h.document);
  let prevented = 0;
  const key = (key, shiftKey = false) => h.document.dialog.listeners.keydown({key, shiftKey,
    preventDefault() { prevented++; }});
  key('Tab'); assert.equal(h.document.activeElement, open);
  key('Tab', true); assert.equal(h.document.activeElement, offline);
  key('ArrowDown'); assert.equal(prevented, 2);
  h.handle.dispose();
});

test('all malformed policy values fail open, including contradictory minimum above release', async () => {
  for (const minimum of [null, '159', -1, 1.5, Infinity, {}, Number.MAX_SAFE_INTEGER + 1, 161]) {
    const h = harness({revision: 158, response: unsupported}); await h.handle.check();
    assert.equal(h.handle.getCompatibility().onlineAllowed, false);
    h.setTime(1000 + INTERVAL); h.setResponse({revision: 160, minimumSupportedRevision: minimum});
    await h.handle.check();
    assert.equal(h.handle.getCompatibility().onlineAllowed, true, String(minimum));
    assert.equal(h.document.dialog, undefined);
    assert.equal(h.document.button.textContent, 'Update available');
    h.handle.dispose();
  }
});

test('malformed dormant policy cannot suppress the ordinary optional update offer', async () => {
  const h = harness({revision: 158, response: {revision: 160, minimumSupportedRevision: '159'}});
  await h.handle.check();
  assert.equal(h.handle.getCompatibility().onlineAllowed, true);
  assert.equal(h.document.button.textContent, 'Update available');
  assert.equal(h.document.button.style.borderRadius, '0');
  assert.equal(h.document.button.style.background, 'var(--button-color, #112052)');
  h.document.button.listeners.click();
  assert.equal(h.reloadChecks, 1);
  h.handle.dispose();
});

test('fetch, HTTP, JSON and timeout failures release an existing compatibility restriction', async () => {
  for (const failure of ['fetch', 'http', 'json', 'timeout']) {
    let failing = false;
    const states = [];
    const h = harness({revision: 158, onCompatibilityChange: state => states.push(state),
      fetch: async () => {
        if (!failing) return {ok: true, json: async () => unsupported};
        if (failure === 'fetch') throw Error('offline');
        if (failure === 'timeout') return new Promise(() => {});
        return {ok: failure !== 'http', json: async () => { throw Error('invalid JSON'); }};
      }});
    await h.handle.check();
    failing = true; h.setTime(1000 + INTERVAL);
    const pending = h.handle.check();
    if (failure === 'timeout') {
      await Promise.resolve();
      const timeout = [...h.timers.values()].find(timer => timer.delay === 8000);
      timeout.fn();
    }
    await pending;
    assert.equal(states.at(-1).onlineAllowed, true, failure);
    assert.equal(h.document.dialog, undefined);
    h.handle.dispose();
  }
});

test('dialog API failures and synchronous/asynchronous callback failures fail open', async () => {
  const h = harness({revision: 158, response: unsupported});
  h.document.dialogFailure = true;
  await h.handle.check();
  assert.equal(h.handle.getCompatibility().onlineAllowed, true);
  assert.equal(h.document.dialog, undefined);
  h.handle.dispose();
  for (const asynchronous of [false, true]) {
    const h = harness({revision: 158, response: unsupported, onCompatibilityChange(state) {
      if (!state.onlineAllowed) {
        if (asynchronous) return Promise.reject(Error('callback failed'));
        throw Error('callback failed');
      }
    }});
    await h.handle.check(); await Promise.resolve();
    assert.equal(h.handle.getCompatibility().onlineAllowed, true);
    assert.equal(h.document.dialog, undefined);
    h.handle.dispose();
  }
});

test('callback payloads cannot mutate state, and disposal releases compatibility and UI', async () => {
  const states = [];
  const h = harness({revision: 158, response: unsupported, onCompatibilityChange: state => states.push(state)});
  await h.handle.check();
  assert.equal(Object.isFrozen(states.at(-1)), true);
  const copy = h.handle.getCompatibility(); copy.onlineAllowed = true;
  assert.equal(h.handle.getCompatibility().onlineAllowed, false);
  const dialog = h.document.dialog;
  h.handle.dispose(); h.handle.dispose();
  assert.equal(states.at(-1).reason, 'disposed');
  assert.equal(states.at(-1).onlineAllowed, true);
  assert.equal(dialog.removed, true);
  assert.equal(h.timers.size, 0);
});

test('no compatibility UI appears while busy, including when run starts during fetch', async () => {
  let idle = false;
  const h = harness({revision: 158, response: unsupported, isIdle: () => idle});
  await h.handle.check(); assert.equal(h.calls, 0);
  assert.equal(h.document.dialog, undefined); h.handle.dispose();
  let resolve;
  idle = true;
  const deferred = harness({revision: 158, isIdle: () => idle,
    fetch: () => new Promise(done => { resolve = done; })});
  const pending = deferred.handle.check(); await Promise.resolve();
  idle = false;
  resolve({ok: true, json: async () => unsupported}); await pending;
  assert.equal(deferred.document.dialog, undefined);
  assert.equal(deferred.handle.getCompatibility().onlineAllowed, true);
  deferred.handle.dispose();
});

test('late response after disposal never reinstates restrictions or creates UI', async () => {
  let resolve;
  const h = harness({revision: 158, fetch: () => new Promise(done => { resolve = done; })});
  const pending = h.handle.check(); await Promise.resolve();
  h.handle.dispose(); resolve({ok: true, json: async () => unsupported}); await pending;
  assert.equal(h.handle.getCompatibility().onlineAllowed, true);
  assert.equal(h.document.dialog, undefined);
  assert.equal(h.document.button, undefined);
  assert.equal(h.timers.size, 0);
});

test('disposing before fetch starts avoids the request; ignored abort still releases timers', async () => {
  const early = harness();
  early.handle.dispose(); await Promise.resolve(); await Promise.resolve();
  assert.equal(early.calls, 0);
  assert.equal(early.timers.size, 0);
  const h = harness({fetch: () => new Promise(() => {})});
  const pending = h.handle.check(); await Promise.resolve();
  h.handle.dispose(); await pending;
  assert.equal(h.timers.size, 0);
  assert.equal(h.handle.getCompatibility().onlineAllowed, true);
});

test('unsafe callback hooks and timer failures cannot leave compatibility blocked', async () => {
  const h = harness({revision: 158, response: unsupported,
    onCompatibilityChange() { throw Error('always fails'); }});
  await h.handle.check();
  assert.equal(h.handle.getCompatibility().onlineAllowed, true);
  h.handle.dispose();
  const broken = harness({setTimeout() { throw Error('timer unavailable'); }});
  await broken.handle.check();
  assert.equal(broken.handle.getCompatibility().onlineAllowed, true);
  broken.handle.dispose();
});

const releaseFixture = {number: 241, revision: 209, preparedAt: '2026-10-01T12:00:00.000Z',
  notes: ['Play a focused racer with Space.', 'Clearer update information.']};
const preparedAt = Date.parse(releaseFixture.preparedAt);
const verifiedAge = {installedCommit:cdnPointer.commit,verifiedSiteCommitMetadata:{
  repository:cdnPointer.repository,commit:cdnPointer.commit,publishedAt:releaseFixture.preparedAt}};

test('local age uses minutes, hours and days, records local date and never invents publication', () => {
  for (const [elapsed, text] of [[0, 'less than a minute'], [60000, '1 minute'], [120000, '2 minutes'],
    [3600000, '1 hour'], [7200000, '2 hours'], [86400000, '1 day'], [1209600000, '14 days']]) {
    const age = releaseUpdateAge({...releaseFixture, publishedAt: '2026-10-02T00:00:00.000Z'}, {...verifiedAge,now: preparedAt + elapsed});
    assert.equal(age.text, `Updated ${text} ago`);
    assert.equal(age.dateTime, releaseFixture.preparedAt);
    assert.equal(age.title, `Updated: ${new Date(preparedAt).toLocaleString()}`);
    assert.ok(age.nextUpdateMs > 0 && age.nextUpdateMs <= 60000);
    assert.equal(age.source, 'updated');
  }
  assert.equal(releaseUpdateAge(releaseFixture, {...verifiedAge,now: preparedAt - 1}).text, 'Device clock is before update time');
  assert.equal(releaseUpdateAge(releaseFixture).text, 'Publication time unavailable');
  assert.equal(formatReleaseUpdateAge(releaseFixture.preparedAt,'prepared').text,'Publication time unavailable');
  for (const value of [undefined, '', 1790856000000, 'bad', '2026-02-30T12:00:00.000Z']) {
    assert.equal(releaseUpdateAge({preparedAt: value}).nextUpdateMs, null);
  }
});

test('Updated age requires an already verified pointer matching the installed commit', () => {
  const verifiedReleasePointer = {...cdnPointer, publishedAt: '2026-10-02T12:00:00.000Z'};
  const options = {now: preparedAt + 86400000 + 3600000, verifiedReleasePointer, installedCommit: cdnPointer.commit};
  assert.equal(releaseUpdateAge(releaseFixture, options).text, 'Updated 1 hour ago');
  for (const replacement of [{installedCommit: 'c'.repeat(40)}, {installedCommit: undefined},
    {verifiedReleasePointer: {...verifiedReleasePointer, repository: 'other/repo'}},
    {verifiedReleasePointer: {...verifiedReleasePointer, publishedAt: 'bad'}}]) {
    assert.equal(releaseUpdateAge(releaseFixture, {...options, ...replacement}).source, 'unknown');
  }
});

test('verified site publication, push and commit dates stay distinct and bound to the installed full commit', () => {
  const date = '2026-10-02T12:00:00Z', now = Date.parse(date) + 3600000;
  for (const [field, source, text] of [['publishedAt','updated','Updated'], ['pushedAt','pushed','Pushed'], ['committedAt','committed','Committed']]) {
    const verifiedSiteCommitMetadata = {repository:cdnPointer.repository, commit:cdnPointer.commit, [field]:date};
    const options = {now, installedCommit:cdnPointer.commit, verifiedSiteCommitMetadata};
    const age = releaseUpdateAge(releaseFixture, options);
    assert.equal(age.text, `${text} 1 hour ago`); assert.equal(age.source, source);
    assert.equal(age.title, `${text}: ${new Date(date).toLocaleString()}`);
    assert.equal(age.dateTime, '2026-10-02T12:00:00.000Z');
    for (const replacement of [{installedCommit:'a'.repeat(7)}, {installedCommit:'c'.repeat(40)},
      {verifiedSiteCommitMetadata:{...verifiedSiteCommitMetadata,repository:'other/repo'}},
      ...['2026-02-30T12:00:00Z','2026-10-02','2026-10-02T12:00:00+00:00',0].map(value=>({verifiedSiteCommitMetadata:{...verifiedSiteCommitMetadata,[field]:value}}))]) {
      assert.equal(releaseUpdateAge(releaseFixture,{...options,...replacement}).source,'unknown');
    }
    assert.equal(releaseUpdateAge({...releaseFixture,...verifiedSiteCommitMetadata},{now}).source,'unknown','ordinary release fields cannot attest publication');
  }
  assert.equal(releaseUpdateAge({}).text,'Publication time unavailable');
  assert.equal(formatReleaseUpdateAge(date,'invented',now).nextUpdateMs,null);
  const preferred = releaseUpdateAge(releaseFixture,{now,installedCommit:cdnPointer.commit,
    verifiedReleasePointer:{...cdnPointer,publishedAt:date},
    verifiedSiteCommitMetadata:{repository:cdnPointer.repository,commit:cdnPointer.commit,committedAt:releaseFixture.preparedAt}});
  assert.equal(preferred.source,'updated','actual pointer publication takes priority over commit/preparation');
});

test('existing canonical CDN fallback supplies a matching automatic launcher age without another request', async () => {
  const document = new FakeDocument(); document.defaultView = new EventTarget();
  document.location = {href:'https://script.googleusercontent.com/userCodeAppPanel'};
  document.baseURI = `https://cdn.jsdelivr.net/gh/${cdnPointer.repository}@${cdnPointer.commit}/`;
  document.defaultView.__polytrackAutomaticLoad = Promise.resolve();
  const element = document.createElement('time'); document.body.append(element);
  let next = 0, calls = 0; const timers = new Map();
  const now = Date.parse(cdnPointer.publishedAt) + 3600000;
  const binding = bindReleaseUpdateAge(element,{document,release:releaseFixture,now:()=>now,
    setTimeout:fn=>{timers.set(++next,fn);return next;},clearTimeout:id=>timers.delete(id)});
  assert.equal(element.textContent,'Publication time unavailable');
  const h = harness({document,endpoint:CANONICAL_SITE_VERSION_URL,fetch:async url=>{
    calls++;
    if (url.startsWith(CANONICAL_SITE_VERSION_URL)) throw TypeError('Blocked Pages');
    if (url === CANONICAL_RELEASE_POINTER_URL) return jsonResponse(cdnPointer);
    assert.equal(url,cdnVersionUrl); return jsonResponse({revision:44});
  }});
  await h.handle.check();
  assert.equal(calls,3); assert.equal(element.textContent,'Updated 1 hour ago');
  assert.equal(timers.size,1);
  assert.equal(releaseUpdateAge(releaseFixture,{document,now}).source,'updated');
  document.location.href='https://foreign.example/';
  assert.equal(releaseUpdateAge(releaseFixture,{document,now}).source,'unknown','a foreign host does not inherit launcher trust');
  h.handle.dispose(); binding.dispose(); assert.equal(timers.size,0);
});

test('Help age binding reuses one local timer and cleans up on hide, pagehide, rebind, detach and disposal', () => {
  const document = new FakeDocument(); document.defaultView = new EventTarget();
  const element = document.createElement('time'); document.body.append(element);
  let time = preparedAt, next = 0; const timers = new Map();
  const options = {document, release: releaseFixture, ...verifiedAge, now: () => time,
    setTimeout: (fn, delay) => { timers.set(++next, {fn, delay}); return next; }, clearTimeout: id => timers.delete(id)};
  const binding = bindReleaseUpdateAge(element, options);
  assert.equal(timers.size, 1); assert.equal(element.textContent, 'Updated less than a minute ago');
  for (let i = 0; i < 20; i++) binding.refresh();
  assert.equal(timers.size, 1);
  time += 3600000; [...timers.values()][0].fn();
  assert.equal(timers.size, 1); assert.equal(element.textContent, 'Updated 1 hour ago');
  document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); assert.equal(timers.size, 0);
  time += 86400000; document.visibilityState = 'visible'; document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(timers.size, 1); assert.equal(element.textContent, 'Updated 1 day ago');
  document.defaultView.dispatchEvent(new Event('pagehide')); assert.equal(timers.size, 0);
  document.defaultView.dispatchEvent(new Event('focus')); assert.equal(timers.size, 0);
  document.defaultView.dispatchEvent(new Event('pageshow')); assert.equal(timers.size, 1);
  const rebound = bindReleaseUpdateAge(element, options); assert.equal(timers.size, 1);
  binding.dispose(); assert.equal(timers.size, 1);
  element.remove(); [...timers.values()][0].fn(); assert.equal(timers.size, 0);
  rebound.dispose(); rebound.dispose(); document.defaultView.dispatchEvent(new Event('focus')); assert.equal(timers.size, 0);
  document.body.append(element);
  const unknown = bindReleaseUpdateAge(element, {...options, release: {},verifiedSiteCommitMetadata:undefined,installedCommit:undefined});
  assert.equal(element.datetime, undefined); assert.equal(timers.size, 0); unknown.dispose();
});

test('installed notice shows only the public release, bounds local notes and disposes age without acknowledging', () => {
  let next = 0; const timers = new Map(), storage = memoryStorage();
  const h = noticeHarness({storage, ...verifiedAge, release: {...releaseFixture, notes: ['a'.repeat(500), ...Array(20).fill('Short note.')]},
    now: () => preparedAt, setTimeout: fn => { timers.set(++next, fn); return next; }, clearTimeout: id => timers.delete(id)});
  const dialog = h.document.dialog;
  assert.equal(dialog.children[0].textContent, 'PolyTrack Ranked - Update 241');
  assert.doesNotMatch(String(dialog.children[1].textContent || ''), /saved runs|client|209/i);
  assert.equal(dialog.children[2].children.length, 4);
  assert.ok(dialog.children[2].children.every(item => item.textContent.length <= 220));
  assert.equal(timers.size, 1);
  h.document.visibilityState = 'hidden'; h.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(timers.size, 0); assert.equal(storage.getItem('polytrack-site-update-ack-v1:205'), null);
  h.document.visibilityState = 'visible'; h.handle.resume(); assert.equal(timers.size, 1);
  h.handle.dispose(); assert.equal(timers.size, 0);
});

test('installed notice forwards the explicit local release commit date to its live binding', () => {
  let next=0,time=preparedAt+3600000; const timers=new Map();
  const h=noticeHarness({release:releaseFixture,verifiedReleaseCommitAt:releaseFixture.preparedAt,
    now:()=>time,setTimeout:fn=>{timers.set(++next,fn);return next;},clearTimeout:id=>timers.delete(id)});
  const age=h.document.dialog.children[1].children[0];
  assert.equal(age.textContent,'Committed 1 hour ago'); assert.equal(timers.size,1);
  h.document.dispatchEvent(new Event('polytrack-release-publication'));
  assert.equal(age.textContent,'Committed 1 hour ago'); assert.equal(timers.size,1);
  time+=86400000; [...timers.values()][0]();
  assert.equal(age.textContent,'Committed 1 day ago'); assert.equal(timers.size,1);
  h.handle.dispose(); assert.equal(timers.size,0);
});

test('foreign hosts offer only a fixed explicit new-tab link, and click safety still applies', async () => {
  const h = harness({endpoint: CANONICAL_SITE_VERSION_URL, fetch: async () => jsonResponse({revision: 44})});
  await h.handle.check(); const offer = h.document.button;
  assert.equal(offer.tag, 'a'); assert.equal(offer.href, UPDATED_GAME_URL);
  assert.equal(offer.target, '_blank'); assert.equal(offer.rel, 'noopener noreferrer');
  assert.match(offer['aria-label'], /new tab/);
  let prevented = false; offer.listeners.click({preventDefault() { prevented = true; }});
  assert.equal(prevented, true); assert.equal(h.reloadChecks, 1); h.handle.dispose();
});

test('acknowledgement follows the manual release number, not the internal client revision', () => {
  const storage = memoryStorage(); storage.setItem('polytrack-site-update-ack-v1:209', 'acknowledged');
  const first = noticeHarness({revision: 209, release: releaseFixture, storage});
  assert.ok(first.document.dialog, 'an old client acknowledgement cannot hide a new manual release');
  first.document.dialog.children[3].listeners.click(); first.handle.dispose();
  assert.equal(storage.getItem('polytrack-site-update-ack-release-v1:241'), 'acknowledged');
  const same = noticeHarness({revision: 210, release: releaseFixture, storage});
  assert.equal(same.document.dialog, undefined); same.handle.dispose();
  const next = noticeHarness({revision: 209, release: {...releaseFixture, number: 242}, storage});
  assert.ok(next.document.dialog); next.handle.dispose();
});

test('canonical page reloads its own document only after an explicit safe click', async () => {
  const document = new FakeDocument(); document.baseURI = UPDATED_GAME_URL;
  let reloads = 0; document.defaultView = new EventTarget(); document.defaultView.location = {reload() { reloads++; }};
  const h = harness({document, endpoint: CANONICAL_SITE_VERSION_URL, canReload: () => true,
    fetch: async () => jsonResponse({revision: 44})});
  await h.handle.check(); const offer = document.button;
  assert.equal(offer.tag, 'button'); assert.equal(reloads, 0);
  offer.listeners.click(); assert.equal(reloads, 1); h.handle.dispose();
});

test('audited Apps Script and CDN automatic launchers reload in place and expire only pointer discovery', async () => {
  for (const href of ['https://script.google.com/macros/s/deployment/exec',
    'https://script.googleusercontent.com/userCodeAppPanel',
    'https://n-example-script.googleusercontent.com/userCodeAppPanel',
    'https://script.googleusercontent.com/macros/echo?user_content_key=test',
    'https://cdn.jsdelivr.net/gh/StaticQuasar931/PolyTrack-0.6.3-Ranked@main/apps-script/index.html']) {
    const document = new FakeDocument(); document.location = {href}; document.baseURI = `https://cdn.jsdelivr.net/gh/${cdnPointer.repository}@${cdnPointer.commit}/`;
    let reloads = 0, safe = false;
    const storage = memoryStorage(), cached = {sha: cdnPointer.commit, indexSha256: cdnPointer.indexSha256, checkedAt: 12345};
    storage.setItem('polytrack-automatic-release-v2', JSON.stringify(cached)); storage.setItem('saved-run', 'keep');
    document.defaultView = new EventTarget();
    Object.assign(document.defaultView, {__polytrackAutomaticLoad: Promise.resolve(), localStorage: storage, location: {reload() { reloads++; }}});
    const h = harness({document, endpoint: CANONICAL_SITE_VERSION_URL, canReload: () => safe, fetch: async () => jsonResponse({revision: 44})});
    await h.handle.check(); const offer = document.button;
    assert.equal(offer.tag, 'button', href); assert.equal(offer.href, undefined); assert.equal(reloads, 0);
    offer.listeners.click({preventDefault() {}}); assert.equal(reloads, 0);
    assert.equal(JSON.parse(storage.getItem('polytrack-automatic-release-v2')).checkedAt, 12345);
    safe = true; offer.listeners.click(); assert.equal(reloads, 1);
    assert.deepEqual(JSON.parse(storage.getItem('polytrack-automatic-release-v2')), {...cached, checkedAt: 0});
    assert.equal(storage.getItem('saved-run'), 'keep'); h.handle.dispose();
  }
});

test('foreign copies cannot gain launcher reload privileges from a base tag or marker alone', async () => {
  for (const [href, base, marker] of [
    ['https://foreign.example/', `https://cdn.jsdelivr.net/gh/${cdnPointer.repository}@${cdnPointer.commit}/`, Promise.resolve()],
    ['https://script.googleusercontent.com.attacker.invalid/userCodeAppPanel', `https://cdn.jsdelivr.net/gh/${cdnPointer.repository}@${cdnPointer.commit}/`, Promise.resolve()],
    ['https://script.googleusercontent.com/userCodeAppPanel', 'https://cdn.jsdelivr.net/gh/other/repo@main/', Promise.resolve()],
    ['https://script.googleusercontent.com/userCodeAppPanel', `https://cdn.jsdelivr.net/gh/${cdnPointer.repository}@${cdnPointer.commit}/`, undefined],
    ['https://cdn.jsdelivr.net/gh/other/repo@main/index.html', `https://cdn.jsdelivr.net/gh/${cdnPointer.repository}@${cdnPointer.commit}/`, Promise.resolve()]
  ]) {
    const document = new FakeDocument(); document.location = {href}; document.baseURI = base;
    document.defaultView = new EventTarget(); document.defaultView.__polytrackAutomaticLoad = marker;
    const h = harness({document, endpoint: CANONICAL_SITE_VERSION_URL, fetch: async () => jsonResponse({revision: 44})});
    await h.handle.check(); assert.equal(document.button.tag, 'a', href); assert.equal(document.button.href, UPDATED_GAME_URL); h.handle.dispose();
  }
});

// Optional local browser verification. No install/download and no external requests.
let chromium;
try { if (process.env.POLYTRACK_UNIT_ONLY !== '1') ({chromium} = createRequire(new URL('./verifier/package.json', import.meta.url))(
  process.env.PLAYWRIGHT_MODULE || 'playwright')); } catch { /* Unit tests remain dependency-free. */ }
test('installed revision notice uses native keyboard focus, waits for safe menus and persists explicit acknowledgement',
  {skip: !chromium}, async () => {
    const browser = await chromium.launch({headless: true});
    try {
      const page = await browser.newPage();
      const source = readFileSync(new URL('./site-updates.mjs', import.meta.url), 'utf8');
      let external = 0;
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.hostname !== 'notice.test') { external++; return route.abort(); }
        return route.fulfill({contentType: url.pathname.endsWith('.mjs') ? 'text/javascript' : 'text/html',
          body: url.pathname.endsWith('.mjs') ? source : '<button id="play">Play</button><div id="menu" hidden>Settings</div>'});
      });
      const install = async () => page.evaluate(async () => {
        window.module = await import('/site-updates.mjs'); window.ready = false; window.racing = false;
        window.nativeKeys = [];
        document.addEventListener('keydown', event => nativeKeys.push(event.key), true);
        document.addEventListener('keyup', event => nativeKeys.push(event.key), true);
        document.getElementById('play').focus();
        window.notice = module.installInstalledRevisionNotice({revision: 205,
          release: {number: 236, notes: ['Fixture update note.']},
          isReady: () => ready, isIdle: () => !racing && document.getElementById('menu').hidden});
      });
      await page.goto('https://notice.test/'); await install();
      assert.equal(await page.locator('dialog').count(), 0);
      await page.evaluate(() => { ready = true; document.getElementById('menu').hidden = false; notice.resume(); });
      assert.equal(await page.locator('dialog').count(), 0);
      await page.evaluate(() => { document.getElementById('menu').hidden = true; racing = true; notice.resume(); });
      assert.equal(await page.locator('dialog').count(), 0);
      await page.evaluate(() => { racing = false; notice.resume(); });
      assert.equal(await page.getByRole('dialog', {name: 'PolyTrack Ranked - Update 236'}).count(), 1);
      assert.equal(await page.locator('dialog').evaluate(node=>getComputedStyle(node).fontSize),'22px');
      assert.equal(await page.getByRole('button',{name:'OK',exact:true}).evaluate(node=>getComputedStyle(node).borderRadius),'0px');
      for (const [width,height] of [[320,568],[844,320],[1366,768]]) {
        await page.setViewportSize({width,height});
        assert.equal(await page.locator('dialog').evaluate(node => {
          const rect = node.getBoundingClientRect();
          return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight && node.scrollWidth <= node.clientWidth;
        }), true);
      }
      for (const key of ['Tab','Shift+Tab','=','y']) await page.keyboard.press(key);
      assert.equal(await page.evaluate(() => document.activeElement.textContent), 'OK');
      assert.deepEqual(await page.evaluate(() => nativeKeys), []);
      assert.equal(await page.evaluate(() => localStorage.getItem('polytrack-site-update-ack-v1:205')), null);
      await page.reload(); await install(); await page.evaluate(() => { ready = true; notice.resume(); });
      assert.equal(await page.locator('dialog').count(), 1, 'merely showing the notice does not consume it');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('dialog').count(), 0);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'play');
      assert.deepEqual(await page.evaluate(() => nativeKeys), []);
      await page.reload(); await install(); await page.evaluate(() => { ready = true; notice.resume(); });
      assert.equal(await page.locator('dialog').count(), 0, 'acknowledgement survives a real refresh');
      await page.evaluate(() => { notice.dispose(); window.notice = module.installInstalledRevisionNotice({revision: 206, isReady: () => true, isIdle: () => true}); });
      assert.equal(await page.locator('dialog').count(), 1, 'a different installed revision gets one notice');
      await page.keyboard.press('Enter'); assert.equal(await page.locator('dialog').count(), 0);
      await page.keyboard.press('='); assert.ok((await page.evaluate(() => nativeKeys)).includes('='));
      await page.evaluate(() => notice.dispose()); assert.equal(external, 0);
    } finally { await browser.close(); }
  });
test('native dialog keyboard focus, mobile fit and new-tab navigation preserve the current page',
  {skip: !chromium}, async () => {
    const browser = await chromium.launch({headless: true});
    try {
      const context = await browser.newContext();
      await context.route('**/*', route => route.fulfill({contentType: 'text/html', body: '<title>Updated game fixture</title>'}));
      const font = readFileSync(new URL('../forced_square.woff2', import.meta.url));
      await context.route('**/forced_square.woff2', route => route.fulfill({contentType: 'font/woff2', body: font}));
      const page = await context.newPage();
      await page.goto('https://game.example/');
      await page.setContent(`<base href="https://game.example/"><style>
        @font-face {font-family:ForcedSquare;src:url('/forced_square.woff2') format('woff2')}
        body {margin:0;padding:24px;background:#101a35;color:#f5f7ff;font:18px ForcedSquare,sans-serif}
        #before {padding:12px;border:2px solid #7e9bd1;background:#28346a;color:white;font:inherit}
      </style><button id="before">Existing game</button>`);
      const source = readFileSync(new URL('./site-updates.mjs', import.meta.url), 'utf8');
      await page.evaluate(async source => {
        document.getElementById('before').focus();
        const blob = URL.createObjectURL(new Blob([source], {type: 'text/javascript'}));
        const {installSiteUpdates} = await import(blob);
        URL.revokeObjectURL(blob);
        localStorage.setItem('polytrack-qa-progress', JSON.stringify({track: 'fixture', best: 1234}));
        sessionStorage.setItem('polytrack-qa-session', 'preserve-current-session');
        window.runSentinel = {frames: 4321, track: 'fixture'};
        window.compatibilityOnlineAllowed = true;
        window.compatibilityStates = [];
        window.updater = installSiteUpdates({revision: 158, isIdle: () => true,
          fetch: async () => ({ok: true, json: async () => ({revision: 160, minimumSupportedRevision: 159})}),
          onCompatibilityChange: state => {
            window.compatibilityStates.push(state);
            window.compatibilityOnlineAllowed = state.onlineAllowed !== false;
          }});
        await window.updater.check();
        await document.fonts.ready;
      }, source);
      const session = () => page.evaluate(() => ({local: {...localStorage}, session: {...sessionStorage},
        run: window.runSentinel}));
      const before = await session();
      const dialog = page.getByRole('dialog', {name: 'Update needed for online play'});
      assert.equal(await dialog.isVisible(), true);
      assert.equal(await dialog.evaluate(node=>getComputedStyle(node).fontSize),'22px');
      assert.equal(await dialog.locator('h2').evaluate(node=>getComputedStyle(node).fontWeight),'400');
      assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Stay here offline');
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Open updated game');
      await page.keyboard.press('Shift+Tab');
      assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Stay here offline');
      for (const [width, height] of [[320, 568], [568, 320], [1366, 900]]) {
        await page.setViewportSize({width, height});
        assert.equal(await dialog.evaluate(node => {
          const rect = node.getBoundingClientRect();
          return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight &&
            node.scrollWidth <= node.clientWidth;
        }), true, `dialog fits ${width}x${height}`);
        if (process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR && (width === 320 || width === 1366)) {
          const directory = resolve(process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR);
          mkdirSync(directory, {recursive: true});
          await page.screenshot({path: resolve(directory, `site-compatibility-${width === 320 ? '320px' : 'desktop'}.png`)});
        }
      }
      const [popup] = await Promise.all([page.waitForEvent('popup'),
        page.getByRole('link', {name: 'Open updated game (opens in a new tab)', exact: true}).click()]);
      await popup.waitForLoadState();
      assert.equal(popup.url(), UPDATED_GAME_URL);
      assert.equal(page.url(), 'https://game.example/');
      assert.equal(await popup.evaluate(() => window.opener), null);
      assert.deepEqual(await session(), before, 'opening official URL preserves storage and in-memory session');
      await popup.close(); await page.bringToFront();
      await page.keyboard.press('Escape');
      assert.equal(await dialog.count(), 0);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'before');
      assert.equal(await page.evaluate(() => window.updater.getCompatibility().onlineAllowed), false);
      assert.equal(await page.evaluate(() => window.compatibilityOnlineAllowed), false);
      assert.deepEqual(await session(), before, 'staying offline preserves all fixture data');
      await page.evaluate(() => window.updater.dispose());
      assert.deepEqual(await session(), before, 'disposal does not clear local data');
    } finally { await browser.close(); }
  });
