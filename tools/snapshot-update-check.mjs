const {installReplayModalKeyboardGuard}=await import(new URL('./partial-replay-selection.mjs'+new URL(import.meta.url).search,import.meta.url).href);
const POINTER = 'https://cdn.jsdelivr.net/gh/StaticQuasar931/PolyTrack-0.6.3-Ranked@cdn-release/release.json';
const CURRENT = 'https://staticquasar931.github.io/PolyTrack-0.6.3-Ranked/snapshot-current.json';
export const SNAPSHOT_UPDATE_ENDPOINTS = Object.freeze([POINTER, CURRENT]);
const generationOf = value => {
  const match = /^public-snapshots([1-9][0-9]{0,8})$/.exec(value || '');
  return match ? Number(match[1]) : null;
};

export function createSnapshotUpdateCheck({fetchImpl = globalThis.fetch, now = Date.now,
  timeoutMs = 8000, cooldownMs = 60000,
  setTimeout: schedule = globalThis.setTimeout, clearTimeout: unschedule = globalThis.clearTimeout} = {}) {
  let pending = null, saved = null, checkedAt = -Infinity, disposed = false;
  const read = async (url, signal) => {
    const controller = new AbortController();
    let timer, reader, rejectAbort;
    const abort = () => { controller.abort(); rejectAbort?.(Error('Update check cancelled')); };
    try {
      const cancelled = new Promise((_, reject) => { rejectAbort = reject; });
      signal.addEventListener('abort', abort, {once: true});
      if (signal.aborted) abort();
      timer = schedule(abort, timeoutMs);
      return await Promise.race([cancelled, (async () => {
        if (controller.signal.aborted) throw Error('Update check cancelled');
        const response = await fetchImpl(url, {credentials: 'omit', redirect: 'error',
          cache: 'no-cache', referrerPolicy: 'no-referrer', signal: controller.signal,
          headers: {Accept: 'application/json'}});
        if (!response.ok || response.redirected || Number(response.headers.get('content-length')) > 16384) throw Error('Update check unavailable');
        if (controller.signal.aborted) throw Error('Update check cancelled');
        reader = response.body.getReader();
        const chunks = []; let length = 0;
        for (;;) {
          const {value, done} = await reader.read(); if (done) break;
          length += value.byteLength;
          if (length > 16384) throw Error('Update response too large');
          chunks.push(value);
        }
        const bytes = new Uint8Array(length); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        const data = JSON.parse(new TextDecoder().decode(bytes));
        const generation = generationOf(url === POINTER ? data.snapshotDirectory : data.currentdir);
        if (generation === null) throw Error('Invalid snapshot release');
        return generation;
      })()]);
    } finally {
      unschedule(timer); signal.removeEventListener('abort', abort);
      // Do not let a stalled stream's cancel promise hold the UI open.
      try { void reader?.cancel().catch(() => {}); } catch { /* Already closed. */ }
    }
  };
  const cancel = () => { pending?.controller.abort(); pending = null; };
  return Object.freeze({
    cancel,
    dispose() { disposed = true; cancel(); saved = null; },
    async check(currentGeneration, {signal} = {}) {
      if (disposed || signal?.aborted) return {status: 'cancelled'};
      if (!Number.isSafeInteger(currentGeneration) || currentGeneration < 1) return {status: 'unavailable'};
      if (!pending && (!saved || now() - checkedAt >= cooldownMs)) {
        const flight = {controller: new AbortController(), clients: 0};
        pending = flight;
        flight.promise = (async () => {
          let newest = null, successes = 0;
          for (const endpoint of SNAPSHOT_UPDATE_ENDPOINTS) {
            if (flight.controller.signal.aborted) return {status: 'cancelled'};
            try {
              const generation = await read(endpoint, flight.controller.signal);
              newest = Math.max(newest || 0, generation);
              successes++;
            } catch { /* Try the other static host. */ }
          }
          return {generation: newest, complete: successes === SNAPSHOT_UPDATE_ENDPOINTS.length};
        })().then(value => {
          if (disposed || flight.controller.signal.aborted) return {status: 'cancelled'};
          checkedAt = now(); saved = value; return value;
        }).finally(() => { if (pending === flight) pending = null; });
      }
      let value = saved;
      if (pending) {
        const flight = pending;
        flight.clients++;
        let abort;
        try {
          value = await Promise.race([flight.promise, new Promise(resolve => {
            abort = () => resolve({status: 'cancelled'});
            signal?.addEventListener('abort', abort, {once: true});
            if (signal?.aborted) abort();
          })]);
        } finally {
          signal?.removeEventListener('abort', abort);
          if (--flight.clients === 0 && pending === flight) cancel();
        }
      }
      if (disposed || signal?.aborted || value?.status === 'cancelled') return {status: 'cancelled'};
      if (value?.generation > currentGeneration) return {generation: value.generation, status: 'newer'};
      if (!value?.complete) return {status: 'unavailable'};
      return {generation: value.generation, status: value.generation === currentGeneration ? 'current' : 'stale'};
    }
  });
}

const activeDialogs = new WeakMap(), feedback = new WeakMap();
const noop = Object.freeze({dispose() {}});
let feedbackId = 0;
function showInlineResult(result, {document, origin, signal, isCurrent}) {
  if (!origin?.isConnected || !origin.parentNode || !origin.matches('button,[role="button"]')) return noop;
  feedback.get(origin)?.dispose();
  const status = document.createElement('span');
  status.id = `sq-snapshot-check-status-${++feedbackId}`;
  status.className = 'sq-snapshot-check-status';
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.setAttribute('aria-atomic', 'true');
  Object.assign(status.style, {display: 'inline-block', maxWidth: '100%', boxSizing: 'border-box',
    padding: '4px 8px', borderLeft: '2px solid #7ee7ff', color: 'inherit', font: 'inherit', fontSize: '0.85em'});
  // Keep CURRENT feedback accessible without adding a visible label or shifting the row.
  if (result.status === 'current') Object.assign(status.style, {position: 'absolute', width: '1px',
    height: '1px', padding: '0', margin: '-1px', overflow: 'hidden', clipPath: 'inset(50%)',
    whiteSpace: 'nowrap', border: '0'});
  origin.insertAdjacentElement('afterend', status);
  const description = origin.getAttribute('aria-describedby');
  origin.setAttribute('aria-describedby', [description, status.id].filter(Boolean).join(' '));
  let animation = null, announcement = null, disposed = false;
  const view = document.defaultView;
  const dispose = () => {
    if (disposed) return; disposed = true;
    if (announcement !== null) view.clearTimeout(announcement);
    animation?.cancel(); status.remove();
    const remaining = (origin.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && id !== status.id).join(' ');
    if (remaining) origin.setAttribute('aria-describedby', remaining); else origin.removeAttribute('aria-describedby');
    signal?.removeEventListener('abort', dispose); view?.removeEventListener('pagehide', dispose);
    if (feedback.get(origin)?.dispose === dispose) feedback.delete(origin);
  };
  const handle = Object.freeze({dispose}); feedback.set(origin, handle);
  signal?.addEventListener('abort', dispose, {once: true}); view?.addEventListener('pagehide', dispose, {once: true});
  // A separate task lets assistive technology register the empty live region.
  announcement = view.setTimeout(() => {
    announcement = null;
    if (disposed) return;
    if (signal?.aborted || !origin.isConnected || !isCurrent()) { dispose(); return; }
    status.textContent = result.status === 'current' ? 'No newer snapshot reported.' : result.status === 'stale'
      ? 'Release files are older than this snapshot. Try later.' : 'Snapshot check failed. Try again later.';
    const reduced = !view?.matchMedia || view.matchMedia('(prefers-reduced-motion: reduce)').matches ||
      document.documentElement.classList.contains('sq-reduced-effects') || document.body.classList.contains('sq-reduced-effects');
    if (result.status === 'current' && !reduced && typeof origin.animate === 'function') {
      try { animation = origin.animate([{translate: '0px'}, {translate: '-3px'}, {translate: '3px'},
        {translate: '-2px'}, {translate: '2px'}, {translate: '0px'}], {duration: 280, iterations: 1, easing: 'ease-out'}); } catch { /* The live announcement remains available without motion. */ }
    }
  }, 30);
  return handle;
}
export function showSnapshotUpdateResult(result, {document = globalThis.document, reload = () => globalThis.location.reload(),
  origin = document?.activeElement, signal, isCurrent = () => true} = {}) {
  if (signal?.aborted || result?.status === 'cancelled' || !isCurrent() || !origin?.isConnected) return noop;
  if (result?.status !== 'newer') return showInlineResult(result || {}, {document, origin, signal, isCurrent});
  feedback.get(origin)?.dispose();
  installReplayModalKeyboardGuard({document});
  const active = activeDialogs.get(document);
  if (active?.node.isConnected) return active.handle;
  const prior = origin, dialog = document.createElement('dialog');
  dialog.className = 'sq-snapshot-update-dialog';
  Object.assign(dialog.style, {width: 'min(640px, calc(100vw - 24px))', maxHeight: 'calc(100dvh - 24px)',
    boxSizing: 'border-box', overflow: 'auto', padding: 'clamp(12px, 3dvh, 24px)', border: '2px solid #6389bf',
    borderRadius: '0', background: '#1c2959', color: '#fff', font: 'clamp(18px, 5dvh, 22px)/1.35 ForcedSquare, sans-serif'});
  dialog.setAttribute('aria-labelledby', 'sq-snapshot-update-title');
  dialog.setAttribute('aria-describedby', 'sq-snapshot-update-description');
  const heading = document.createElement('h2'); heading.id = 'sq-snapshot-update-title';
  heading.textContent = `Snapshot ${result.generation} available`;
  Object.assign(heading.style, {fontSize: 'clamp(22px, min(4vw, 7dvh), 30px)', fontWeight: 'normal', lineHeight: '1.15',
    margin: '0 0 14px', paddingBottom: '12px', borderBottom: '2px solid #a7d5ff'});
  const text = document.createElement('p'); text.id = 'sq-snapshot-update-description';
  text.textContent = 'A static release file reports a newer snapshot. You can try reloading this page. Pinned links and embedded games may reopen the same build; reopen the game from its launcher to check for an updated version. Reloading does not delete your saved runs.';
  const actions = document.createElement('div');
  Object.assign(actions.style, {display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: '10px'});
  const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Close';
  close.onclick = () => dialog.close(); actions.append(close);
  const update = document.createElement('button'); update.type = 'button'; update.textContent = 'Reload this page';
  for (const button of [close, update]) Object.assign(button.style, {minHeight: '44px', padding: '8px 16px',
    border: '2px solid #7e9bd1', borderRadius: '0', background: '#28346a', color: '#fff',
    font: 'inherit', cursor: 'pointer', boxShadow: 'inset 0 -3px 0 #17234f'});
  update.onclick = () => { if (signal?.aborted || !isCurrent() || !prior.isConnected) { dispose(); return; } dialog.close(); reload(); }; actions.append(update);
  dialog.addEventListener('keydown', event => { event.stopPropagation(); });
  let disposed = false;
  const cleanup = (restore = false) => {
    if (disposed) return; disposed = true;
    dialog.remove();
    if (activeDialogs.get(document)?.node === dialog) activeDialogs.delete(document);
    signal?.removeEventListener('abort', dispose); document.defaultView?.removeEventListener('pagehide', dispose);
    if (restore && prior?.isConnected && isCurrent()) prior.focus();
  };
  const dispose = () => cleanup();
  const handle = Object.freeze({dispose}); activeDialogs.set(document, {node: dialog, handle});
  dialog.addEventListener('close', () => cleanup(true), {once: true});
  signal?.addEventListener('abort', dispose, {once: true}); document.defaultView?.addEventListener('pagehide', dispose, {once: true});
  dialog.append(heading, text, actions); document.body.append(dialog);
  try { dialog.showModal(); close.focus(); } catch { cleanup(); return showInlineResult({status: 'unavailable'}, {document, origin, signal, isCurrent}); }
  return handle;
}
