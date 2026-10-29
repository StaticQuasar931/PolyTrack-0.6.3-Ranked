const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;
const installations = new WeakMap();
const noticeInstallations = new WeakMap();
const acknowledgedRevisions = new WeakMap();
export const UPDATED_GAME_URL = 'https://staticquasar931.github.io/PolyTrack-0.6.3-Ranked/';
export const CANONICAL_SITE_VERSION_URL = `${UPDATED_GAME_URL}site-version.json`;
const CDN_REPOSITORY = 'StaticQuasar931/PolyTrack-0.6.3-Ranked';
const CDN_BASE = `https://cdn.jsdelivr.net/gh/${CDN_REPOSITORY}@`;
export const CANONICAL_RELEASE_POINTER_URL = `${CDN_BASE}cdn-release/release.json`;

function releaseVersionUrl(pointer) {
  if (pointer?.schemaVersion !== 1 || pointer.repository !== CDN_REPOSITORY ||
      !/^[a-f0-9]{40}$/.test(pointer.commit || '') || !/^[a-f0-9]{64}$/.test(pointer.indexSha256 || '') ||
      !/^public-snapshots[1-9][0-9]{0,8}$/.test(pointer.snapshotDirectory || '') ||
      typeof pointer.publishedAt !== 'string' || !Number.isFinite(Date.parse(pointer.publishedAt))) {
    throw new TypeError('Invalid CDN release pointer');
  }
  // Ignore all URLs in the pointer. Only the immutable commit controls this path.
  return new URL(`${CDN_BASE}${pointer.commit}/site-version.json`);
}

async function readManifest(response) {
  if (!response?.ok || response.redirected || Number(response.headers?.get('content-length')) > 16384) throw Error('Update request failed');
  if (!response.body?.getReader) return response.json();
  const reader = response.body.getReader(), chunks = [];
  let length = 0;
  try {
    for (;;) {
      const {value, done} = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > 16384) throw Error('Update response too large');
      chunks.push(value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally { void reader.cancel().catch(() => {}); }
}

const validRevision = value => Number.isSafeInteger(value) && value >= 0;
function themeControl(element) {
  Object.assign(element.style, { padding: '10px 14px', minHeight: '44px', boxSizing: 'border-box',
    border: '2px solid #7e9bd1', borderRadius: '0', background: '#28346a', color: '#ffffff',
    font: 'clamp(18px, 5dvh, 22px)/1.25 ForcedSquare, sans-serif', cursor: 'pointer', textAlign: 'center', textDecoration: 'none',
    boxShadow: 'inset 0 -3px 0 #17234f' });
}

function themeDialog(node, title, description) {
  Object.assign(node.style, {width: 'min(640px, calc(100vw - 24px))', maxHeight: 'calc(100dvh - 24px)',
    overflow: 'auto', boxSizing: 'border-box', padding: 'clamp(12px, 3dvh, 24px)', border: '2px solid #6389bf',
    borderRadius: '0', background: '#1c2959', color: '#fff', font: 'clamp(18px, 5dvh, 22px)/1.35 ForcedSquare, sans-serif'});
  Object.assign(title.style, {margin: '0 0 14px', paddingBottom: '12px', borderBottom: '2px solid #a7d5ff',
    fontSize: 'clamp(22px, min(4vw, 7dvh), 30px)', fontWeight: 'normal', lineHeight: '1.15'});
  Object.assign(description.style, {margin: '0 0 18px'});
}

function isVisible(document) { return document.visibilityState !== 'hidden'; }
function defaultIdle(document) { return isVisible(document) && (typeof document.hasFocus !== 'function' || document.hasFocus()); }

/** Local installed-build notice, independent of the remote manifest/check interval.
 * Parent must supply gameplay-aware readiness/safety predicates and call resume()
 * after UI transitions. Mounting is NOT acknowledgement; only OK/Escape is.
 * Local storage persists across refreshes, session storage is the fallback, and
 * memory is the final fallback when both stores are denied (this page only).
 */
export function installInstalledRevisionNotice({revision, release = {}, document = globalThis.document,
  isReady = () => false, isIdle = defaultIdle, storage, sessionStorage} = {}) {
  if (!validRevision(revision)) throw new TypeError('revision must be a non-negative safe integer');
  if (!document?.addEventListener) throw new TypeError('document is required');
  const existing = noticeInstallations.get(document);
  if (existing) return existing;
  const view = document.defaultView;
  const key = `polytrack-site-update-ack-v1:${revision}`;
  let remembered = acknowledgedRevisions.get(document);
  if (!remembered) acknowledgedRevisions.set(document, remembered = new Set());
  const stores = () => {
    const result = [];
    for (const [provided, name] of [[storage, 'localStorage'], [sessionStorage, 'sessionStorage']]) {
      try { const store = provided === undefined ? view?.[name] : provided; if (store) result.push(store); } catch { /* Sandboxed/blocked storage. */ }
    }
    return result;
  };
  const acknowledged = () => {
    if (remembered.has(revision)) return true;
    for (const store of stores()) {
      try { if (store.getItem(key) === 'acknowledged') { remembered.add(revision); return true; } } catch { /* Try next store. */ }
    }
    return false;
  };
  let disposed = false, dialog = null, previousFocus = null;
  const close = (restoreFocus = false) => {
    const node = dialog; dialog = null;
    if (!node) return;
    try { node.close?.(); } catch { /* Removal is sufficient. */ }
    node.remove();
    if (restoreFocus && previousFocus?.isConnected) { try { previousFocus.focus(); } catch { /* Best effort. */ } }
  };
  const acknowledge = () => {
    if (disposed || !dialog?.isConnected) return;
    remembered.add(revision);
    for (const store of stores()) { try { store.setItem(key, 'acknowledged'); } catch { /* Keep the in-page acknowledgement. */ } }
    close(true);
  };
  const resume = () => {
    if (disposed) return;
    if (acknowledged()) { close(); return; }
    let safe = false;
    try { safe = !!document.body && isVisible(document) && isReady(document) && isIdle(document); } catch { /* Defer. */ }
    if (!safe) { close(); return; }
    if (dialog?.isConnected && dialog.open) return;
    close();
    const node = document.createElement('dialog');
    dialog = node; previousFocus = document.activeElement;
    node.dataset.siteInstalledRevision = String(revision);
    node.setAttribute('aria-labelledby', 'pt-installed-update-title');
    node.setAttribute('aria-describedby', 'pt-installed-update-description');
    const title = document.createElement('h2'); title.id = 'pt-installed-update-title';
    title.textContent = validRevision(release.number) ? `PolyTrack update ${release.number}` : 'PolyTrack updated';
    const description = document.createElement('p'); description.id = 'pt-installed-update-description';
    description.textContent = `You are running client revision ${revision}. Your saved runs are unchanged.`;
    themeDialog(node, title, description);
    const notes = document.createElement('ul');
    Object.assign(notes.style, {margin: '0 0 18px', paddingLeft: '24px'});
    for (const text of (Array.isArray(release.notes) ? release.notes : []).filter(text => typeof text === 'string' && text.trim()).slice(0, 8)) {
      const item = document.createElement('li'); item.textContent = text; notes.append(item);
    }
    const ok = document.createElement('button'); ok.type = 'button'; ok.textContent = 'OK'; themeControl(ok);
    Object.assign(ok.style, {display: 'block', marginLeft: 'auto', minWidth: '88px'});
    ok.addEventListener('click', acknowledge);
    node.addEventListener('cancel', event => { event.preventDefault(); acknowledge(); });
    node.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Tab') { event.preventDefault(); ok.focus(); }
    });
    node.append(title, description, notes, ok); document.body.append(node);
    try { node.showModal(); ok.focus(); } catch { close(); }
  };
  // Stop game shortcuts, including the keyup following Escape/Enter dismissal.
  const held = new Set();
  const guard = event => {
    const code = event.code || event.key;
    if (dialog?.open || event.type === 'keyup' && held.has(code)) event.stopImmediatePropagation();
    if (dialog?.open && event.type === 'keydown') {
      held.add(code);
      if (event.key === 'Tab') { event.preventDefault(); dialog.children[3].focus(); }
    }
    if (event.type === 'keyup') held.delete(code);
  };
  const storageChanged = event => { if (event.key === key || event.key === null) resume(); };
  document.addEventListener('visibilitychange', resume);
  for (const type of ['focus', 'pageshow']) view?.addEventListener(type, resume);
  for (const type of ['keydown', 'keyup']) view?.addEventListener(type, guard, true);
  view?.addEventListener('storage', storageChanged);
  const handle = Object.freeze({resume, dispose() {
    if (disposed) return;
    disposed = true; close(); held.clear();
    document.removeEventListener('visibilitychange', resume);
    for (const type of ['focus', 'pageshow']) view?.removeEventListener(type, resume);
    for (const type of ['keydown', 'keyup']) view?.removeEventListener(type, guard, true);
    view?.removeEventListener('storage', storageChanged);
    noticeInstallations.delete(document);
  }});
  noticeInstallations.set(document, handle); resume(); return handle;
}

/**
 * Manifest: {revision: N, minimumSupportedRevision?: M}, with 0 <= M <= N.
 * Omit the minimum to leave compatibility policy inactive. Errors fail open.
 * onCompatibilityChange receives {onlineAllowed, revision, latestRevision,
 * minimumSupportedRevision, reason}. Parent must default to allowed and gate NEW
 * online actions when false, without interrupting a run or deleting queued data.
 * Supply a gameplay-aware isIdle; document focus alone does not identify a run.
 * This UI policy cannot affect older clients lacking this code and is not security.
 * Default endpoint is canonical, including on copied builds. Pass 'site-version.json'
 * explicitly for local testing. Only same-origin HTTP(S) or the exact canonical
 * manifest URL is accepted. If canonical fails, try the fixed CDN release pointer
 * and its validated immutable commit's site-version.json (at most 3 requests).
 * No fallback for explicit local endpoints. All requests omit credentials, reject
 * redirects, and have bounded time/body size. The pointer supplies no policy.
 */
export function installSiteUpdates({ revision, document = globalThis.document, fetch: fetchImpl = globalThis.fetch,
  now = Date.now, setTimeout: schedule = globalThis.setTimeout, clearTimeout: unschedule = globalThis.clearTimeout,
  isIdle = defaultIdle, canReload = () => true, endpoint = CANONICAL_SITE_VERSION_URL,
  intervalMs = CHECK_INTERVAL_MS, timeoutMs = REQUEST_TIMEOUT_MS, onCompatibilityChange = () => {} }) {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new TypeError('revision must be a non-negative safe integer');
  if (!document || typeof document.addEventListener !== 'function') throw new TypeError('document is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required');
  const existing = installations.get(document);
  if (existing) return existing;

  let lastCheckedAt = -Infinity, inFlight = null, timer = null, disposed = false, button = null;
  let dialog = null, offlineMinimum = null, controller = null, cancelRequest = null;
  let compatibility = null, pendingManifest = null;
  const clearDialog = () => {
    if (!dialog) return;
    const { node, previousFocus } = dialog;
    dialog = null;
    try { node.close?.(); } catch { /* Removal still releases the dialog. */ }
    node.remove();
    try { if (previousFocus?.isConnected) previousFocus.focus(); } catch { /* Focus is best-effort. */ }
  };
  const publish = (next, recover = true) => {
    if (compatibility && Object.keys(next).every(key => compatibility[key] === next[key])) return;
    compatibility = Object.freeze(next);
    const failed = () => {
      if (recover && !disposed && compatibility === next) failOpen('callback-failed', false);
    };
    try { Promise.resolve(onCompatibilityChange(next)).catch(failed); } catch { failed(); }
  };
  const failOpen = (reason = 'check-failed', recover = true) => {
    clearDialog();
    offlineMinimum = null;
    publish({ onlineAllowed: true, revision, latestRevision: null, minimumSupportedRevision: null, reason }, recover);
  };
  const applyCompatibility = (data) => {
    // The optional manifest field is dormant when absent. No remote navigation URL is accepted.
    const minimum = data.minimumSupportedRevision;
    if (minimum !== undefined && (!validRevision(minimum) || minimum > data.revision)) {
      throw new TypeError('Invalid minimumSupportedRevision');
    }
    const unsupported = minimum !== undefined && revision < minimum;
    const state = { onlineAllowed: !unsupported, revision, latestRevision: data.revision,
      minimumSupportedRevision: minimum ?? null,
      reason: unsupported ? 'unsupported' : minimum === undefined ? 'inactive' : 'supported' };
    if (!unsupported) { clearDialog(); offlineMinimum = null; publish(state); return; }
    const stayOffline = () => {
      offlineMinimum = minimum;
      clearDialog();
      publish({ ...compatibility, onlineAllowed: false, minimumSupportedRevision: minimum, reason: 'offline-selected' });
    };
    if (offlineMinimum === minimum) { publish({ ...state, reason: 'offline-selected' }); return; }
    if (dialog?.minimum !== minimum) {
      clearDialog();
      const node = document.createElement('dialog');
      dialog = { node, minimum, previousFocus: document.activeElement };
      node.dataset.siteCompatibility = 'unsupported';
      node.setAttribute('aria-labelledby', 'pt-site-compatibility-title');
      node.setAttribute('aria-describedby', 'pt-site-compatibility-description');
      const title = document.createElement('h2');
      title.id = 'pt-site-compatibility-title';
      title.textContent = 'Update needed for online play';
      const description = document.createElement('p');
      description.id = 'pt-site-compatibility-description';
      description.textContent = 'This version is no longer supported for online play. Open the updated game in a new tab, or stay here offline. Your current session will not reload.';
      themeDialog(node, title, description);
      const actions = document.createElement('div');
      Object.assign(actions.style, { display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: '10px' });
      const open = document.createElement('a');
      open.href = UPDATED_GAME_URL;
      open.target = '_blank';
      open.rel = 'noopener noreferrer';
      open.textContent = 'Open updated game';
      open.setAttribute('aria-label', 'Open updated game (opens in a new tab)');
      themeControl(open);
      const offline = document.createElement('button');
      offline.type = 'button';
      offline.textContent = 'Stay here offline';
      themeControl(offline);
      offline.addEventListener('click', stayOffline);
      node.addEventListener('cancel', event => { event.preventDefault(); stayOffline(); });
      node.addEventListener('keydown', event => {
        if (event.key !== 'Tab') return;
        if (!event.shiftKey && document.activeElement === offline) {
          event.preventDefault(); open.focus();
        } else if (event.shiftKey && document.activeElement === open) {
          event.preventDefault(); offline.focus();
        }
      });
      actions.append(open, offline);
      node.append(title, description, actions);
      document.body.append(node);
      // Native dialog supplies modal semantics, focus containment and inert background.
      // Unsupported dialog APIs fail open rather than emulate an inaccessible modal.
      node.showModal();
      offline.focus();
    }
    publish(state);
  };
  const resume = () => {
    if (disposed || !pendingManifest) return;
    try {
      if (!document.body || !isVisible(document) || !isIdle(document)) return;
      const data = pendingManifest;
      pendingManifest = null;
      // Invalid policy must not suppress an otherwise valid optional update offer.
      try { applyCompatibility(data); } catch { failOpen(); }
      if (data.revision <= revision) { button?.remove(); button = null; return; }
      if (button?.isConnected) return;
      button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Update available';
      button.setAttribute('aria-label', 'Update available. Reload to update.');
      button.dataset.siteUpdate = 'available';
      themeControl(button);
      Object.assign(button.style, { position: 'fixed', right: '16px', bottom: '16px', maxWidth: 'calc(100vw - 32px)',
        zIndex: '2147483647', fontFamily: 'ForcedSquare, sans-serif' });
      button.addEventListener('click', () => {
        try { if (isVisible(document) && canReload()) globalThis.location?.reload(); } catch { failOpen(); }
      });
      document.body.append(button);
    } catch { /* Keep gameplay independent of notification UI. */ }
  };
  const check = async () => {
    if (disposed) return;
    resume();
    try { if (!isVisible(document) || !isIdle(document)) return; }
    catch { failOpen(); return; }
    if (inFlight) return inFlight;
    let startedAt;
    try { startedAt = now(); } catch { failOpen(); return; }
    if (startedAt - lastCheckedAt < intervalMs) return;
    lastCheckedAt = startedAt;
    inFlight = Promise.resolve().then(async () => {
      const read = async url => {
        if (disposed) throw Error('Update check disposed');
        controller = new AbortController();
        let timeout = null;
        try {
          const request = async () => {
            const response = await fetchImpl(url.href, {method: 'GET', credentials: 'omit',
              mode: url.origin === new URL(document.baseURI).origin ? 'same-origin' : 'cors',
              redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store',
              headers: {Accept: 'application/json'}, signal: controller.signal});
            return readManifest(response);
          };
          return await Promise.race([request(), new Promise((_, reject) => {
            cancelRequest = () => reject(new Error('Update check disposed'));
            timeout = schedule(() => { controller?.abort(); reject(new Error('Update request timed out')); }, timeoutMs);
          })]);
        } finally {
          if (timeout !== null) unschedule(timeout);
          cancelRequest = null;
        }
      };
      const version = async url => {
        const data = await read(url);
        if (!validRevision(data?.revision)) throw new Error('Invalid update manifest');
        return data;
      };
      try {
        if (disposed) return;
        const url = new URL(endpoint, document.baseURI);
        const sameOrigin = url.origin === new URL(document.baseURI).origin;
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
            (!sameOrigin && url.href !== CANONICAL_SITE_VERSION_URL)) throw new Error('Disallowed update endpoint');
        const canonical = url.href === CANONICAL_SITE_VERSION_URL;
        url.searchParams.set('_updateCheck', String(startedAt));
        let data;
        try { data = await version(url); }
        catch (error) {
          if (disposed || !canonical) throw error;
          const pointer = await read(new URL(CANONICAL_RELEASE_POINTER_URL));
          data = await version(releaseVersionUrl(pointer));
        }
        if (disposed) return;
        // A run/menu may start during fetch. Retain the result, independently of
        // the network cooldown, until the parent reports a safe UI transition.
        pendingManifest = data;
        resume();
      } catch {
        // Update checks are best-effort and must not affect gameplay.
        if (!disposed) failOpen();
      } finally {
        controller = null;
        cancelRequest = null;
      }
    }).finally(() => { inFlight = null; });
    return inFlight;
  };
  const scheduleNext = () => {
    if (disposed) return;
    try { timer = schedule(async () => { await check(); scheduleNext(); }, intervalMs); }
    catch { failOpen(); }
  };
  const onVisibilityChange = () => { if (isVisible(document)) void check(); };
  document.addEventListener('visibilitychange', onVisibilityChange);
  document.defaultView?.addEventListener('focus', resume);
  document.defaultView?.addEventListener('pageshow', resume);
  const handle = Object.freeze({ check, resume, getCompatibility: () => ({ ...compatibility }), dispose() {
    if (disposed) return;
    disposed = true;
    document.removeEventListener('visibilitychange', onVisibilityChange);
    document.defaultView?.removeEventListener('focus', resume);
    document.defaultView?.removeEventListener('pageshow', resume);
    pendingManifest = null;
    try { if (timer !== null) unschedule(timer); } catch { /* Disposal must still release compatibility. */ }
    controller?.abort();
    cancelRequest?.();
    clearDialog();
    publish({ onlineAllowed: true, revision, latestRevision: null, minimumSupportedRevision: null, reason: 'disposed' });
    button?.remove();
    installations.delete(document);
  } });
  installations.set(document, handle);
  failOpen('inactive');
  void check();
  scheduleNext();
  return handle;
}
