const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;
const installations = new WeakMap();

function isVisible(document) { return document.visibilityState !== 'hidden'; }
function defaultIdle(document) { return isVisible(document) && (typeof document.hasFocus !== 'function' || document.hasFocus()); }

export function installSiteUpdates({ revision, document = globalThis.document, fetch: fetchImpl = globalThis.fetch,
  now = Date.now, setTimeout: schedule = globalThis.setTimeout, clearTimeout: unschedule = globalThis.clearTimeout,
  isIdle = defaultIdle, canReload = () => true, endpoint = 'site-version.json',
  intervalMs = CHECK_INTERVAL_MS, timeoutMs = REQUEST_TIMEOUT_MS }) {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new TypeError('revision must be a non-negative safe integer');
  if (!document || typeof document.addEventListener !== 'function') throw new TypeError('document is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required');
  const existing = installations.get(document);
  if (existing) return existing;

  let lastCheckedAt = -Infinity, inFlight = null, timer = null, disposed = false, button = null;
  const check = async () => {
    if (disposed || !isVisible(document) || !isIdle(document)) return;
    if (inFlight) return inFlight;
    const startedAt = now();
    if (startedAt - lastCheckedAt < intervalMs) return;
    lastCheckedAt = startedAt;
    inFlight = (async () => {
      const controller = new AbortController();
      const timeout = schedule(() => controller.abort(), timeoutMs);
      try {
        const url = new URL(endpoint, document.baseURI);
        if (url.origin !== new URL(document.baseURI).origin) return;
        const response = await fetchImpl(url.href, { method: 'GET', credentials: 'same-origin', cache: 'no-store',
          headers: { Accept: 'application/json' }, signal: controller.signal });
        if (!response?.ok) return;
        const data = await response.json();
        if (!Number.isSafeInteger(data?.revision) || data.revision <= revision || disposed || button || !document.body) return;
        button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Update available';
        button.setAttribute('aria-label', 'Update available. Reload to update.');
        button.dataset.siteUpdate = 'available';
        Object.assign(button.style, { position: 'fixed', right: '16px', bottom: '16px', zIndex: '2147483647',
          padding: '9px 13px', border: '1px solid currentColor', borderRadius: '6px', background: 'Canvas',
          color: 'CanvasText', font: 'inherit', cursor: 'pointer', opacity: '0.88' });
        button.addEventListener('click', () => { if (isVisible(document) && canReload()) globalThis.location?.reload(); });
        document.body.append(button);
      } catch {
        // Update checks are best-effort and must not affect gameplay.
      } finally {
        unschedule(timeout);
        inFlight = null;
      }
    })();
    return inFlight;
  };
  const scheduleNext = () => {
    if (disposed) return;
    timer = schedule(async () => { await check(); scheduleNext(); }, intervalMs);
  };
  const onVisibilityChange = () => { if (isVisible(document)) void check(); };
  document.addEventListener('visibilitychange', onVisibilityChange);
  void check();
  scheduleNext();
  const handle = Object.freeze({ check, dispose() {
    if (disposed) return;
    disposed = true;
    document.removeEventListener('visibilitychange', onVisibilityChange);
    if (timer !== null) unschedule(timer);
    button?.remove();
    installations.delete(document);
  } });
  installations.set(document, handle);
  return handle;
}
