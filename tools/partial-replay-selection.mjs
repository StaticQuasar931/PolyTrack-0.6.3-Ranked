const MAX_SELECTION = 10;
const CACHE_LIMIT = 64;
const CACHE_CHARACTERS = 2 * 1024 * 1024;
const FAILURE_MS = 60000;
const selectionKey = rows => JSON.stringify(rows.map(row => [row.recordingId, row.nickname, row.isSelf]));
const available = check => { try { return check() === true; } catch { return false; } };

// Window capture precedes document capture even if installed later. The parent
// should install this before main if it also adds window-capture shortcuts.
export function installReplayModalKeyboardGuard({document}) {
  const scope = document.defaultView, key = Symbol.for('polytrack.replay-modal-keyboard.v1');
  if (scope[key]) return scope[key];
  const held = new Set();
  const guard = event => {
    const code = event.code || event.key;
    const open = !!document.querySelector('.sq-partial-replay-dialog[open],.sq-snapshot-update-dialog[open]');
    if (open || event.type === 'keyup' && held.has(code)) event.stopImmediatePropagation();
    if (event.type === 'keydown' && open) held.add(code);
    if (event.type === 'keyup') held.delete(code);
  };
  scope.addEventListener('keydown', guard, true);
  scope.addEventListener('keyup', guard, true);
  scope[key] = {dispose() { scope.removeEventListener('keydown', guard, true); scope.removeEventListener('keyup', guard, true); delete scope[key]; }};
  return scope[key];
}

// This is a playback choice, not a verification verdict or authority to award RP.
export function confirmPartialReplaySelection({document, ready, failed, isCurrent, signal, returnFocus, source = 'saved'}) {
  if (!ready.length || !failed.length || !available(isCurrent) || signal?.aborted) return Promise.resolve(false);
  installReplayModalKeyboardGuard({document});
  const dialog = document.createElement('dialog');
  dialog.className = 'sq-partial-replay-dialog';
  dialog.setAttribute('aria-label', 'Some saved replays are unavailable');
  dialog.style.cssText = 'box-sizing:border-box;width:min(520px,calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow:auto;border:2px solid #8ce7ff;border-radius:8px;padding:20px;background:#182449;color:#fff;font:18px ForcedSquare,sans-serif;line-height:1.4;overflow-wrap:anywhere';
  const title = document.createElement('h2');
  title.textContent = 'Some saved replays are unavailable';
  title.style.cssText = 'font:inherit;font-size:24px;margin:0 0 12px';
  const summary = document.createElement('p');
  summary.textContent = `${ready.length} of ${ready.length + failed.length} selected replays are ready. Continue with only these working replays?`;
  const note = document.createElement('p');
  note.textContent = 'Unavailable replays are skipped. Your run and event points are unchanged.';
  const list = document.createElement('ul');
  for (const item of failed) {
    const row = item.row || item;
    const entry = document.createElement('li');
    entry.textContent = String(row.nickname || row.name || 'Racer').slice(0, 256);
    list.append(entry);
  }
  const controls = document.createElement('div');
  controls.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px;margin-top:18px';
  const cancel = document.createElement('button'), proceed = document.createElement('button');
  for (const button of [cancel, proceed]) {
    button.type = 'button';
    button.style.cssText = 'flex:1 1 160px;min-width:0;white-space:normal;padding:12px;border:1px solid #8ce7ff;border-radius:4px;background:#28346a;color:white;font:inherit;cursor:pointer';
  }
  cancel.textContent = 'Cancel';
  proceed.textContent = 'Continue with working replays';
  proceed.dataset.partialReplayContinue = '';
  controls.append(cancel, proceed);
  dialog.append(title, summary, note, list, controls);
  return new Promise(resolve => {
    const scope = document.defaultView;
    let settled = false, timer;
    const finish = accepted => {
      if (settled) return;
      settled = true;
      scope.clearInterval(timer);
      signal?.removeEventListener('abort', abort);
      scope.removeEventListener('pagehide', abort);
      scope.removeEventListener('popstate', abort);
      dialog.remove();
      if (available(isCurrent) && returnFocus?.isConnected && !returnFocus.disabled) returnFocus.focus({preventScroll: true});
      resolve(accepted && available(isCurrent));
    };
    const abort = () => finish(false);
    cancel.onclick = abort;
    proceed.onclick = () => finish(true);
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
    dialog.addEventListener('close', abort);
    signal?.addEventListener('abort', abort, {once: true});
    scope.addEventListener('pagehide', abort);
    scope.addEventListener('popstate', abort);
    document.body.append(dialog);
    try { dialog.showModal(); cancel.focus(); } catch { finish(false); return; }
    timer = scope.setInterval(() => { if (!dialog.isConnected || !available(isCurrent)) finish(false); }, 50);
    if (signal?.aborted || !available(isCurrent)) finish(false);
  });
}

export function createPartialReplaySelection({readRecordings, validateRecording, confirm, status = () => {}, now = Date.now, timeoutMs = 15000}) {
  if (typeof readRecordings !== 'function' || typeof validateRecording !== 'function' || typeof confirm !== 'function') throw Error('Replay reader, validation and confirmation callbacks are required');
  const cache = new Map();
  let active = null;
  const invalidate = () => { active?.abort.abort(); active = null; };
  const trim = () => {
    let characters = 0;
    for (const item of cache.values()) characters += item.characters || 0;
    for (const [key, item] of cache) {
      if (cache.size <= CACHE_LIMIT && characters <= CACHE_CHARACTERS) break;
      if (item.pending) continue;
      characters -= item.characters || 0;
      cache.delete(key);
    }
  };
  const failure = (item, error) => {
    item.error = error;
    item.payload = null;
    item.characters = 0;
    item.until = now() + Math.max(FAILURE_MS, Math.min(900000, Number(error?.retryAfterMs) || FAILURE_MS));
  };
  function load(rows, context) {
    const keys = rows.map(row => JSON.stringify([context.accountId, context.trackId, context.revision, row.recordingId]));
    const missing = [];
    keys.forEach((key, index) => {
      const old = cache.get(key);
      if (old && (old.pending || old.until > now())) return;
      const item = {pending: true, characters: 0};
      cache.delete(key); cache.set(key, item);
      missing.push({item, row: rows[index]});
    });
    if (missing.length) {
      let timer;
      const request = Promise.race([
        Promise.resolve().then(() => readRecordings(missing.map(({row}) => row.recordingId), context)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Saved replay loading timed out.')), timeoutMs); })
      ]).then(payloads => {
        if (!Array.isArray(payloads) || payloads.length !== missing.length) throw Error('Replay response order or length is invalid.');
        return payloads;
      }).finally(() => clearTimeout(timer));
      missing.forEach(({item}, index) => {
        item.promise = request.then(payloads => {
          const payload = payloads[index];
          if (!payload) throw Error('Saved replay unavailable.');
          // Retain the exact positional payload; never filter before pairing it with its racer.
          item.payload = Object.freeze({...payload});
          item.characters = typeof payload.recording === 'string' ? payload.recording.length : 0;
          item.until = now() + FAILURE_MS;
        }).catch(error => failure(item, error)).then(() => { item.pending = false; trim(); return item; });
      });
    }
    return Promise.all(keys.map(key => cache.get(key).promise));
  }
  async function run({selection, revision, isCurrent, mode, returnFocus, invokeNative}) {
    invalidate();
    const job = {abort: new AbortController()}; active = job;
    let context, rows, expected;
    const current = () => active === job && !job.abort.signal.aborted && available(isCurrent) &&
      selection.trackId() === context.trackId && selection.accountId() === context.accountId && selectionKey(selection.get()) === expected;
    try {
      if (!['play', 'watch'].includes(mode) || revision === undefined || !['string', 'number'].includes(typeof revision)) throw Error('Replay context revision and mode are required.');
      context = Object.freeze({trackId: selection.trackId(), accountId: selection.accountId(), revision});
      rows = selection.get().map(row => Object.freeze({...row}));
      expected = selectionKey(rows);
      if (!rows.length || rows.length > MAX_SELECTION || new Set(rows.map(row => row.recordingId)).size !== rows.length || rows.some(row => !Number.isSafeInteger(row.recordingId) || row.recordingId <= 0 || typeof row.nickname !== 'string' || row.nickname.length > 256 || typeof row.isSelf !== 'boolean')) throw Error('Invalid replay selection.');
      if (!available(current)) return 'cancelled';
      status('Loading and validating selected saved replays...');
      const loaded = await load(rows, context);
      if (!available(current)) return 'cancelled';
      const checked = await Promise.all(loaded.map(async (item, index) => {
        if (!item.error) try {
          // Required on cache hits too: cached bytes do not establish a live engine capability.
          if (await validateRecording(item.payload, rows[index], context) !== true) throw Error('Saved replay failed playback validation.');
        } catch (error) { failure(item, error); }
        return item.error ? {row: rows[index], error: item.error} : {row: rows[index], payload: item.payload};
      }));
      if (!available(current)) return 'cancelled';
      const ready = checked.filter(item => !item.error), failed = checked.filter(item => item.error);
      if (!ready.length) { status('Saved replays unavailable or failed playback validation. No selected replay can be used.', true); return 'all-failed'; }
      if (mode === 'watch' && ready.length > 2) { status('Watch supports 2 replays. Choose Play to race all selected ghosts, or select at most 2 for Watch.', true); return 'watch-limit'; }
      if (failed.length) {
        const accepted = await confirm({ready, failed, isCurrent: current, signal: job.abort.signal, returnFocus});
        if (!available(current)) return 'cancelled';
        if (accepted !== true) { status('Replay launch cancelled. Your selection was not changed.'); return 'declined'; }
      }
      if (!available(current)) return 'cancelled';
      if (failed.length) {
        expected = selectionKey(ready.map(item => item.row));
        selection.set(ready.map(item => item.row), context);
        if (!available(current)) return 'cancelled';
      }
      // Native getRecordings still enforces determinism and parses again. Its existing
      // request helper must reuse the preloaded successes and refresh engine guards.
      invokeNative();
      return 'launched';
    } catch (error) {
      if (active === job && !job.abort.signal.aborted && available(isCurrent)) status(error?.message || 'Replay launch could not start safely.', true);
      return 'error';
    } finally {
      if (active === job) active = null;
      job.abort.abort();
    }
  }
  return {run, invalidate, clearCache() { invalidate(); cache.clear(); }, cacheSize: () => cache.size};
}

export function installPartialReplaySelection({document, getContext, readRecordings, validateRecording, status, confirm = options => confirmPartialReplaySelection({document, ...options})}) {
  installReplayModalKeyboardGuard({document});
  const controller = createPartialReplaySelection({readRecordings, validateRecording, confirm, status});
  let permit = null, pending = null;
  const cancel = () => { controller.invalidate(); pending = null; };
  const capture = event => {
    if (event.target?.closest?.('.sq-partial-replay-dialog')) return;
    const button = event.target?.closest?.('.track-info-ui .side-panel button.play,.track-info-ui .side-panel button.watch');
    if (button && permit === button) return;
    if (!button) { if (pending) cancel(); return; }
    let context;
    try {
      context = getContext(button);
      if (context && !context.selection.get().length) { if (pending) cancel(); return; }
    } catch {
      event.preventDefault(); event.stopImmediatePropagation(); cancel();
      status?.('Replay selection could not be checked safely. Reopen this track.', true);
      return;
    }
    // Parent excludes events, including an event whose native panel is still opening.
    if (!context) { if (pending) cancel(); return; }
    event.preventDefault(); event.stopImmediatePropagation();
    if (button.disabled || pending) return;
    const job = {}; pending = job;
    const current = () => button.isConnected && !button.disabled && context.isCurrent() &&
      getContext(button)?.revision === context.revision && getContext(button)?.selection === context.selection;
    void controller.run({...context, isCurrent: current, mode: button.classList.contains('watch') ? 'watch' : 'play', returnFocus: button,
      invokeNative: () => { permit = button; try { button.click(); } finally { permit = null; } }
    }).finally(() => { if (pending === job) pending = null; });
  };
  const escape = event => { if (event.key === 'Escape' && !event.target?.closest?.('.sq-partial-replay-dialog')) cancel(); };
  document.addEventListener('click', capture, true);
  document.addEventListener('keydown', escape, true);
  document.defaultView.addEventListener('pagehide', cancel);
  document.defaultView.addEventListener('popstate', cancel);
  return {...controller, invalidate: cancel, clearCache() { cancel(); controller.clearCache(); }, dispose() {
    cancel(); document.removeEventListener('click', capture, true); document.removeEventListener('keydown', escape, true);
    document.defaultView.removeEventListener('pagehide', cancel); document.defaultView.removeEventListener('popstate', cancel);
  }};
}
