const projectionUrl=new URL('./overall-local-projection.mjs',import.meta.url);
projectionUrl.search=new URL(import.meta.url).search;
const {projectLocalOverall,projectScopedSnapshot}=await import(projectionUrl.href);

export const LOCAL_OVERALL_RECEIPTS_KEY = 'polytrack-overall-accepted-pbs-v1';
const MAX_RECEIPTS = 128, MAX_BOARDS = 512, MAX_BYTES = 6 * 1024 * 1024;
const MAX_AGE = 28 * 86400000, RETRY_MS = 60000;
const uint = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => uint(value) && value > 0;
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const receiptKey = row => JSON.stringify([row.accountId, row.trackId, row.generation]);

async function decodeResults(data, population) {
  if (data?.resultBundleVersion !== 1 || data.resultBundleEncoding !== 'gzip-base64-json-v1' ||
      data.resultBundleComplete !== true || typeof data.resultBundle !== 'string' || data.resultBundle.length > 1400000) throw Error('invalid_result_bundle');
  const bytes = Uint8Array.from(atob(data.resultBundle), character => character.charCodeAt(0));
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) { await reader.cancel(); throw Error('result_bundle_too_large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const plain = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { plain.set(chunk, offset); offset += chunk.length; }
  const decoded = JSON.parse(new TextDecoder().decode(plain));
  if (!Array.isArray(decoded?.entries) || decoded.entries.length > population ||
      !Array.isArray(decoded.resultTracks) || decoded.resultTracks.length > MAX_BOARDS) throw Error('invalid_decoded_results');
  // The compressed payload may supply rows, never replace trusted source metadata.
  return {...data, entries: decoded.entries, resultTracks: decoded.resultTracks};
}

/** Local presentation controller. acknowledge() requires an application acceptance,
 * not a queued/local save. update()/invalidate() return the coalesced work promise.
 * onState receives {status, accountId, generation, result?, reason?, retryAt?}.
 */
export function createLocalOverallController({storage, read, packageInfo, getAccount,
  isVisible, needsBaseline = () => false, onState = () => {}, now = Date.now} = {}) {
  if (![read, packageInfo, getAccount, isVisible, needsBaseline, onState, now].every(value => typeof value === 'function')) throw TypeError('Invalid local Overall controller callbacks');
  let receipts = [], activeKey = '', revision = 0, baseline = null, running = null, requested = false;
  let failure = null, failures = new Map(), computedKey = '', state = {status: 'idle', accountId: '', generation: null};

  function validReceipt(row) {
    const time = now();
    return validId(row?.accountId) && validId(row.trackId) && row.trackId.length <= 80 &&
      positive(row.timeMs) && row.timeMs <= 36000000 && positive(row.acceptedAt) &&
      row.acceptedAt > time - MAX_AGE && row.acceptedAt <= time + 300000 && positive(row.generation);
  }
  function compact(rows) {
    const best = new Map();
    for (const row of rows) {
      if (!validReceipt(row)) continue;
      const key = receiptKey(row), old = best.get(key);
      if (!old || row.timeMs < old.timeMs || row.timeMs === old.timeMs && row.acceptedAt > old.acceptedAt) best.set(key, row);
    }
    return [...best.values()].sort((a, b) => b.acceptedAt - a.acceptedAt || receiptKey(a).localeCompare(receiptKey(b))).slice(0, MAX_RECEIPTS);
  }
  function save() {
    try { storage?.setItem(LOCAL_OVERALL_RECEIPTS_KEY, JSON.stringify({v: 1, rows: receipts.map(row => [row.accountId, row.trackId, row.timeMs, row.acceptedAt, row.generation])})); } catch {}
  }
  try {
    const raw = storage?.getItem(LOCAL_OVERALL_RECEIPTS_KEY);
    if (typeof raw === 'string' && raw.length <= 65536) {
      const data = JSON.parse(raw);
      if (data?.v === 1 && Array.isArray(data.rows) && data.rows.length <= MAX_RECEIPTS) receipts = compact(data.rows.flatMap(tuple =>
        Array.isArray(tuple) && tuple.length === 5 ? [{accountId: tuple[0], trackId: tuple[1], timeMs: tuple[2], acceptedAt: tuple[3], generation: tuple[4]}] : []));
    }
  } catch {}

  function context() {
    const info = packageInfo(), accountId = getAccount(), visible = Boolean(isVisible());
    const baselineRequested = visible && Boolean(needsBaseline());
    const valid = positive(info?.generation) && uint(info.epoch) && typeof info.baseUrl === 'string' && info.baseUrl.length > 0 && validId(accountId);
    const packageKey = valid ? JSON.stringify([info.generation, info.epoch, info.baseUrl]) : '';
    return {accountId: validId(accountId) ? accountId : '', generation: valid ? info.generation : null,
      workKey:JSON.stringify([packageKey,baselineRequested?'scoped':'overall']),
      packageKey, visible, baselineRequested, valid, key: JSON.stringify([accountId, packageKey, visible, baselineRequested])};
  }
  function emit(ctx, next) {
    state = {...next, accountId: ctx.accountId, generation: ctx.generation};
    try { onState(state); } catch {}
    return state;
  }
  function synchronize(ctx) {
    if (ctx.key !== activeKey) {
      revision++; activeKey = ctx.key; computedKey = '';
      if (ctx.visible && baseline?.key !== ctx.workKey) baseline = null;
      failure = failures.get(ctx.workKey) || null;
      emit(ctx, {status: 'idle'});
    }
  }
  function current(ctx, token) {
    const latest = context();
    return revision === token && latest.key === ctx.key && latest.valid && latest.visible;
  }
  function activeReceipts(ctx) {
    const trimmed = compact(receipts);
    if (trimmed.length !== receipts.length) { receipts = trimmed; save(); }
    return receipts.filter(row => row.accountId === ctx.accountId && row.generation === ctx.generation);
  }
  async function load(ctx, token) {
    const [overall, packed] = await Promise.all([read('overall'), ctx.baselineRequested ? null : read('overall-results')]);
    if (!current(ctx, token)) return null;
    const catalog = overall?.trackCatalog;
    if (!Array.isArray(overall?.entries) || overall.entries.length > 100000 || !Array.isArray(catalog) || catalog.length > MAX_BOARDS ||
        (!ctx.baselineRequested && (!Number.isSafeInteger(packed?.resultBoardCount) || packed.resultBoardCount !== catalog.length || packed.resultBoardLimitReached !== false)) ||
        new Set(catalog.map(item => item?.trackId)).size !== catalog.length || catalog.some(item => !validId(item?.trackId) || item.trackId.length > 80)) throw Error('incomplete_track_catalog');
    const results = ctx.baselineRequested ? null : await decodeResults(packed, overall.entries.length);
    if (!current(ctx, token)) return null;
    const tracks = new Array(catalog.length); let cursor = 0, error = null;
    async function worker() {
      while (!error && current(ctx, token)) {
        const index = cursor++;
        if (index >= catalog.length) return;
        try {
          const board = await read('track', catalog[index].trackId);
          if (!board) throw Error('missing_track');
          tracks[index] = {...board, generation: ctx.generation};
        } catch (caught) { error = caught; }
      }
    }
    // Drain in-flight reads on failure/invalidation before another batch starts.
    await Promise.all(Array.from({length: Math.min(4, catalog.length)}, worker));
    if (error) throw error;
    if (!current(ctx, token)) return null;
    return {key: ctx.workKey, overall: {...overall, generation: ctx.generation},
      results: {...results, generation: ctx.generation}, tracks};
  }
  async function runOnce() {
    const ctx = context(); synchronize(ctx);
    const accepted = activeReceipts(ctx);
    if (!ctx.valid || !ctx.visible || !accepted.length && !ctx.baselineRequested) {
      if (state.status !== 'idle' || state.reason !== (!accepted.length ? 'no_receipts' : 'hidden')) emit(ctx, {status: 'idle', reason: !accepted.length ? 'no_receipts' : 'hidden'});
      return;
    }
    if (failure?.key === ctx.workKey && now() < failure.retryAt) {
      if (state.status !== 'unavailable') emit(ctx, {status: 'unavailable', reason: failure.reason, retryAt: failure.retryAt});
      return;
    }
    const signature = JSON.stringify([ctx.key, accepted.map(row => [row.trackId, row.timeMs, row.acceptedAt])]);
    if (computedKey === signature) return;
    const token = revision;
    emit(ctx, {status: 'loading'});
    try {
      if (!baseline) {
        const loaded = await load(ctx, token);
        if (!loaded) return;
        baseline = loaded;
      }
      // Let menu rendering/input run before the full population calculation.
      await new Promise(resolve => setTimeout(resolve, 0));
      if (!current(ctx, token)) return;
      const latest = activeReceipts(ctx);
      if (!latest.length && !ctx.baselineRequested) { emit(ctx, {status: 'idle', reason: 'no_receipts'}); return; }
      const result = ctx.baselineRequested
        ? projectScopedSnapshot({accountId:ctx.accountId,generation:ctx.generation,overall:baseline.overall,tracks:baseline.tracks})
        : projectLocalOverall({accountId: ctx.accountId, generation: ctx.generation,
        overall: baseline.overall, results: baseline.results, tracks: baseline.tracks,
        acceptedPbs: latest.map(row => ({...row, accepted: true}))});
      if (!current(ctx, token)) return;
      if (result.status === 'unavailable') {
        // Validated static bytes cannot repair a model/version mismatch in place.
        const waitingForSnapshot=['track_binding_mismatch','baseline_mismatch','result_binding_mismatch','generation_mismatch','scoped_mixed_generation','scoped_invalid_board_source','scoped_incomplete_catalog'].includes(result.reason);
        failure = {key: ctx.workKey, retryAt: waitingForSnapshot?Number.MAX_SAFE_INTEGER:now() + RETRY_MS, reason: result.reason};
        failures.set(ctx.workKey,failure);while(failures.size>4)failures.delete(failures.keys().next().value);
        baseline = null;
        emit(ctx, {status: 'unavailable', reason: result.reason, retryAt: failure.retryAt, result});
      } else {
        computedKey = JSON.stringify([ctx.key, latest.map(row => [row.trackId, row.timeMs, row.acceptedAt])]);
        failure = null;failures.delete(ctx.workKey);
        emit(ctx, {status: result.status, result});
      }
    } catch (error) {
      if (!current(ctx, token)) return;
      failure = {key: ctx.workKey, retryAt: now() + RETRY_MS, reason: error?.message || 'static_data_unavailable'};
      failures.set(ctx.workKey,failure);while(failures.size>4)failures.delete(failures.keys().next().value);
      baseline = null;
      emit(ctx, {status: 'unavailable', reason: failure.reason, retryAt: failure.retryAt});
    }
  }
  function update() {
    synchronize(context()); requested = true;
    if (!running) running = Promise.resolve().then(async () => {
      while (requested) { requested = false; await runOnce(); }
      return state;
    }).finally(() => { running = null; });
    return running;
  }
  function acknowledge({accountId, trackId, timeMs, acceptedAt} = {}) {
    const info = packageInfo();
    const receipt = {accountId, trackId, timeMs, acceptedAt, generation: info?.generation};
    if (!validReceipt(receipt) || !uint(info?.epoch) || typeof info.baseUrl !== 'string' || !info.baseUrl) return false;
    const next = compact([...receipts, receipt]);
    if (JSON.stringify(next) !== JSON.stringify(receipts)) { receipts = next; save(); }
    void update();
    return true;
  }
  function invalidate() {
    revision++; baseline = null; computedKey = ''; activeKey = '';
    // Keep the failure budget for this package; explicit invalidation cannot
    // turn repeated render failures into an unbounded retry loop.
    return update();
  }
  return {acknowledge, update, invalidate};
}
