const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;
const installations = new WeakMap();
export const UPDATED_GAME_URL = 'https://staticquasar931.github.io/PolyTrack-0.6.3-Ranked/';
export const CANONICAL_SITE_VERSION_URL = `${UPDATED_GAME_URL}site-version.json`;

const validRevision = value => Number.isSafeInteger(value) && value >= 0;
function themeControl(element) {
  Object.assign(element.style, { padding: '10px 14px', minHeight: '44px', boxSizing: 'border-box',
    border: '2px solid #7e9bd1', borderRadius: '0', background: '#28346a', color: '#ffffff',
    font: 'inherit', cursor: 'pointer', textAlign: 'center', textDecoration: 'none' });
}

function isVisible(document) { return document.visibilityState !== 'hidden'; }
function defaultIdle(document) { return isVisible(document) && (typeof document.hasFocus !== 'function' || document.hasFocus()); }

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
 * manifest URL is accepted. Cross-origin requests omit credentials; redirects fail.
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
  let compatibility = null;
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
      Object.assign(node.style, { width: 'min(480px, calc(100vw - 32px))', maxHeight: 'calc(100dvh - 32px)',
        overflow: 'auto', boxSizing: 'border-box', padding: '24px', border: '2px solid #7e9bd1',
        borderRadius: '0', background: '#17274d', color: '#f5f7ff',
        fontFamily: 'ForcedSquare, sans-serif', fontSize: '18px', lineHeight: '1.5' });
      const title = document.createElement('h2');
      title.id = 'pt-site-compatibility-title';
      title.textContent = 'Update needed for online play';
      Object.assign(title.style, { margin: '0 0 12px', fontSize: '24px' });
      const description = document.createElement('p');
      description.id = 'pt-site-compatibility-description';
      description.textContent = 'This version is no longer supported for online play. Open the updated game in a new tab, or stay here offline. Your current session will not reload.';
      const actions = document.createElement('div');
      Object.assign(actions.style, { display: 'flex', flexWrap: 'wrap', gap: '12px' });
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
  const check = async () => {
    if (disposed) return;
    try { if (!isVisible(document) || !isIdle(document)) return; }
    catch { failOpen(); return; }
    if (inFlight) return inFlight;
    let startedAt;
    try { startedAt = now(); } catch { failOpen(); return; }
    if (startedAt - lastCheckedAt < intervalMs) return;
    lastCheckedAt = startedAt;
    inFlight = Promise.resolve().then(async () => {
      let timeout = null;
      try {
        if (disposed) return;
        controller = new AbortController();
        const url = new URL(endpoint, document.baseURI);
        const sameOrigin = url.origin === new URL(document.baseURI).origin;
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
            (!sameOrigin && url.href !== CANONICAL_SITE_VERSION_URL)) throw new Error('Disallowed update endpoint');
        url.searchParams.set('_updateCheck', String(startedAt));
        const request = async () => {
          const response = await fetchImpl(url.href, { method: 'GET', credentials: sameOrigin ? 'same-origin' : 'omit',
            mode: sameOrigin ? 'same-origin' : 'cors', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store',
            headers: { Accept: 'application/json' }, signal: controller.signal });
          if (!response?.ok || response.redirected) throw new Error('Update request failed');
          return response.json();
        };
        const data = await Promise.race([request(), new Promise((_, reject) => {
          cancelRequest = () => reject(new Error('Update check disposed'));
          timeout = schedule(() => { controller?.abort(); reject(new Error('Update request timed out')); }, timeoutMs);
        })]);
        if (disposed) return;
        if (!validRevision(data?.revision) || !document.body) throw new Error('Invalid update manifest');
        // A request may finish after a run starts. Do not open a modal then.
        if (!isVisible(document) || !isIdle(document)) { failOpen('deferred'); return; }
        // Invalid compatibility policy must not suppress an otherwise valid update offer.
        try { applyCompatibility(data); } catch { failOpen(); }
        if (data.revision <= revision) {
          button?.remove();
          button = null;
          return;
        }
        if (button) return;
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
      } catch {
        // Update checks are best-effort and must not affect gameplay.
        if (!disposed) failOpen();
      } finally {
        try { if (timeout !== null) unschedule(timeout); } catch { if (!disposed) failOpen(); }
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
  const handle = Object.freeze({ check, getCompatibility: () => ({ ...compatibility }), dispose() {
    if (disposed) return;
    disposed = true;
    document.removeEventListener('visibilitychange', onVisibilityChange);
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
