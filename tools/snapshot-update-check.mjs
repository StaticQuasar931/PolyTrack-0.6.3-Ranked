const {installReplayModalKeyboardGuard}=await import(new URL('./partial-replay-selection.mjs'+new URL(import.meta.url).search,import.meta.url).href);
const POINTER = 'https://cdn.jsdelivr.net/gh/StaticQuasar931/PolyTrack-0.6.3-Ranked@cdn-release/release.json';
const CURRENT = 'https://staticquasar931.github.io/PolyTrack-0.6.3-Ranked/snapshot-current.json';
export const SNAPSHOT_UPDATE_ENDPOINTS = Object.freeze([POINTER, CURRENT]);
const generationOf = value => {
  const match = /^public-snapshots([1-9][0-9]{0,8})$/.exec(value || '');
  return match ? Number(match[1]) : null;
};

export function createSnapshotUpdateCheck({fetchImpl = globalThis.fetch, now = Date.now,
  timeoutMs = 8000, cooldownMs = 60000} = {}) {
  let pending = null, saved = null, checkedAt = -Infinity;
  const read = async url => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {credentials: 'omit', redirect: 'error',
        cache: 'no-cache', referrerPolicy: 'no-referrer', signal: controller.signal,
        headers: {Accept: 'application/json'}});
      if (!response.ok || response.redirected || Number(response.headers.get('content-length')) > 16384) throw Error('Update check unavailable');
      const reader = response.body.getReader(), chunks = []; let length = 0;
      try {
        for (;;) {
          const {value, done} = await reader.read(); if (done) break;
          length += value.byteLength;
          if (length > 16384) throw Error('Update response too large');
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const data = JSON.parse(new TextDecoder().decode(bytes));
      const generation = generationOf(url === POINTER ? data.snapshotDirectory : data.currentdir);
      if (generation === null) throw Error('Invalid snapshot release');
      return generation;
    } finally { clearTimeout(timer); }
  };
  return Object.freeze({
    async check(currentGeneration) {
      if (!Number.isSafeInteger(currentGeneration) || currentGeneration < 1) return {status: 'unavailable'};
      if (!pending && (!saved || now() - checkedAt >= cooldownMs)) {
        checkedAt = now();
        pending = (async () => {
          let newest = null;
          for (const endpoint of SNAPSHOT_UPDATE_ENDPOINTS) {
            try {
              const generation = await read(endpoint);
              newest = Math.max(newest || 0, generation);
              if (generation > currentGeneration) return {generation};
            } catch { /* Try the other static host. */ }
          }
          return newest ? {generation: newest} : {status: 'unavailable'};
        })().then(value => (saved = value)).finally(() => { pending = null; });
      }
      const value = pending ? await pending : saved;
      return value?.generation ? {...value, status: value.generation > currentGeneration ? 'newer' : value.generation === currentGeneration ? 'current' : 'stale'} : {status: 'unavailable'};
    }
  });
}

let activeDialog = null;
export function showSnapshotUpdateResult(result, {document = globalThis.document, reload = () => globalThis.location.reload()} = {}) {
  installReplayModalKeyboardGuard({document});
  if (activeDialog?.isConnected) { activeDialog.querySelector('button')?.focus(); return; }
  const prior = document.activeElement, dialog = document.createElement('dialog'); activeDialog = dialog;
  dialog.className = 'sq-snapshot-update-dialog';
  dialog.setAttribute('aria-labelledby', 'sq-snapshot-update-title');
  dialog.setAttribute('aria-describedby', 'sq-snapshot-update-description');
  const heading = document.createElement('h2'); heading.id = 'sq-snapshot-update-title';
  heading.textContent = result.status === 'newer' ? `Snapshot ${result.generation} available` : result.status === 'current' ? 'No newer snapshot reported' : 'Update check unavailable';
  const text = document.createElement('p'); text.id = 'sq-snapshot-update-description';
  text.textContent = result.status === 'newer' ? 'A static release file reports a newer snapshot. You can try reloading this page. Pinned links and embedded games may reopen the same build; reopen the game from its launcher to check for an updated version. Reloading does not delete your saved runs.' : result.status === 'current' ? 'The reachable release files report no newer snapshot. CDN updates may take time to appear.' : 'Keeping your current snapshot. Try again later.';
  const actions = document.createElement('div');
  const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Close';
  close.onclick = () => dialog.close(); actions.append(close);
  if (result.status === 'newer') {
    const update = document.createElement('button'); update.type = 'button'; update.textContent = 'Reload this page';
    update.onclick = () => { dialog.close(); reload(); }; actions.append(update);
  }
  dialog.addEventListener('keydown', event => { event.stopPropagation(); });
  dialog.addEventListener('close', () => { dialog.remove(); if (activeDialog === dialog) activeDialog = null; if (prior?.isConnected) prior.focus(); }, {once: true});
  dialog.append(heading, text, actions); document.body.append(dialog); dialog.showModal(); close.focus();
}
