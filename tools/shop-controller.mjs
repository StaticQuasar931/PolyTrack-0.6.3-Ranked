/** LOCAL DRAFT: no host integration, SDK, awards, automatic requests or equip.
 * Share one createShopControllerStore across mounted views in one auth context.
 * Host MUST call reset() on every auth transition, including an unobserved A-B-A.
 * getAuthScope returns an opaque non-secret login identity/generation, NOT a token.
 * All methods that perform I/O are explicit user actions. A confirmed purchase
 * performs its explicitly requested completion GET; failures never auto-retry.
 */
import {createShopSession} from './shop-session.mjs';
import {createShopBrowserLock} from './shop-browser-lock.mjs';
export class ShopControllerError extends Error {
  constructor(code) { super(code); this.name = 'ShopControllerError'; this.code = code; }
}
const fail = code => { throw new ShopControllerError(code); };
const copy = value => structuredClone(value);
const validAccount = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function createShopControllerStore({transport, storage, getAccountId, getAuthScope,
  makeRequestId, withAccountLock = createShopBrowserLock(), now, cacheMs, enabled = false} = {}) {
  if (typeof getAuthScope !== 'function' || typeof getAccountId !== 'function') fail('invalid_auth_adapter');
  const session = createShopSession({transport, storage,
    getAccountId: () => { const id = getAccountId(); return validAccount(id) ? id : null; }, makeRequestId,
    withAccountLock, now, cacheMs, enabled});
  let gate = enabled === true, disposed = false, generation = 0, identity = null;
  let read = null, operation = null, phase = gate ? 'idle' : 'disabled', error = null, outcome = null;
  const listeners = new Set();
  function clear() { generation++; read = null; operation = null; error = null; outcome = null; phase = gate ? 'idle' : 'disabled'; }
  function auth() {
    const accountId = getAccountId(), scope = getAuthScope();
    return {accountId: validAccount(accountId) ? accountId : null,
      scope: typeof scope === 'string' && scope.length ? scope : null};
  }
  function synchronize() {
    if (disposed) return;
    const next = auth();
    if (!identity || identity.accountId !== next.accountId || identity.scope !== next.scope) {
      identity = next; clear(); session.reset(); emit();
    }
  }
  function snapshot() {
    // Auth transitions must not sync an invalid account or read its local storage.
    let authorized = !!(!disposed && identity?.scope && identity?.accountId);
    const value = authorized ? session.state() : {
      status: gate && !disposed ? 'signed-out' : 'disabled', enabled: false,
      accountId: null, wallet: null, inventory: null, catalog: null, pending: null,
      result: null, confirmation: null, confirmedPurchases: [], ownedStatus: 'unknown', error: null
    };
    authorized = authorized && value.accountId === identity.accountId;
    return copy({...value, accountId: authorized ? identity.accountId : null,
      wallet: authorized ? value.wallet : null, inventory: authorized ? value.inventory : null,
      catalog: authorized ? value.catalog : null, pending: authorized ? value.pending : null,
      result: authorized ? value.result : null, confirmation: authorized ? value.confirmation : null,
      confirmedPurchases: authorized ? value.confirmedPurchases : [], ownedStatus: authorized ? value.ownedStatus : 'unknown',
      enabled: !!(authorized && gate && value.enabled), disposed, busy: !!operation,
      loading: !!read, phase, error: error || value.error, outcome});
  }
  function emit() {
    const value = snapshot();
    // A broken view must not interrupt receipt cleanup or a confirmed operation.
    for (const listener of listeners) { try { listener(copy(value)); } catch {} }
  }
  function requireReady() {
    if (disposed) fail('disposed'); synchronize();
    if (!identity?.accountId || !identity.scope) fail('authentication_required');
    if (!gate || !session.state().enabled) fail('disabled');
    return {accountId: identity.accountId, generation};
  }
  function check(context) {
    synchronize();
    if (disposed || generation !== context.generation || identity?.accountId !== context.accountId) fail('stale_response');
  }
  function performRead(context, refresh, completion = false) {
    if (read) return read.promise;
    const token = {}; read = token; phase = completion ? 'refreshing' : 'loading'; error = null;
    token.promise = Promise.resolve().then(async () => {
      try {
        check(context); await session.load({refresh,completion}); check(context); phase = 'ready'; return snapshot();
      } catch (caught) {
        if (!disposed && generation === context.generation) { phase = completion ? 'refresh-required' : 'error'; error = caught.code || 'read_failed'; }
        throw caught;
      } finally {
        if (read === token) { read = null; emit(); }
      }
    }).then(() => { check(context); return snapshot(); });
    emit(); return token.promise;
  }
  function load({refresh = false} = {}) {
    if (disposed) fail('disposed'); synchronize();
    if (!identity?.accountId || !identity.scope) return Promise.resolve(snapshot());
    const context = requireReady(); if (operation) fail('purchase_in_flight');
    return performRead(context, refresh);
  }
  async function transact(kind, intent, confirmed) {
    const context = requireReady();
    if (operation) fail('purchase_in_flight'); if (read) fail('read_in_flight');
    if (confirmed !== true) fail('confirmation_required');
    let chosen;
    if (kind === 'purchase') {
      if (!intent || intent.accountId !== context.accountId) fail('confirmation_stale');
      const current = session.state();
      const selected = current.catalog?.items.find(item => item.id === intent.itemId);
      if (!selected || selected.price !== intent.price || current.wallet?.revision !== intent.walletRevision) fail('confirmation_stale');
      chosen = session.preparePurchase(intent.itemId);
      if (chosen.price !== intent.price || chosen.walletRevision !== intent.walletRevision) fail('confirmation_stale');
    }
    const token = {}; operation = token; outcome = null; error = null; phase = kind==='claim'?'claiming':'purchasing'; emit();
    try {
      const result = kind === 'purchase'
        ? await session.confirmPurchase(chosen.id, {confirmed: true})
        : kind==='claim'?await session.claim(intent,{confirmed:true}):await session.reconcilePending({confirmed: true});
      check(context); outcome = {...result.result, outcomeOnly: true}; phase = 'outcome'; emit();
      // Never derive current balance, equip or inventory from historical receipts.
      await performRead(context, true, true); check(context);
      const fresh = snapshot();
      return {confirmed: true, accountId: context.accountId, itemId: result.result.itemId,
        ...(result.result.rewardId?{rewardId:result.result.rewardId}:{}),outcome: copy(outcome), wallet: walletView(fresh), inventory: inventoryView(fresh)};
    } catch (caught) {
      if (!disposed && generation === context.generation) {
        if (phase !== 'refresh-required') phase = session.state().pending ? 'reconciliation-required' : 'error';
        error = caught.code || 'purchase_failed';
      }
      throw caught;
    } finally { if (operation === token) { operation = null; emit(); } }
  }
  function reset() { if (disposed) return; identity = auth(); clear(); session.reset(); emit(); }
  return {
    load,claim:(rewardId,{confirmed=false}={})=>transact('claim',rewardId,confirmed), purchase: (intent, {confirmed = false} = {}) => transact('purchase', intent, confirmed),
    reconcile: ({confirmed = false} = {}) => transact('reconcile', null, confirmed),
    state() { synchronize(); return snapshot(); }, reset,
    subscribe(listener) {
      if (disposed) fail('disposed'); if (typeof listener !== 'function') fail('invalid_listener');
      synchronize(); listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener);
    },
    setEnabled(value) {
      if (disposed) fail('disposed'); gate = value === true; identity = auth(); clear(); session.setEnabled(gate); emit();
    },
    dispose() { if (disposed) return; disposed = true; gate = false; clear(); session.dispose(); emit(); listeners.clear(); }
  };
}
function walletView(state) {
  const w = state.wallet;
  return w ? {status: 'confirmed', accountId: w.accountId, balance: w.balance, revision: w.revision} : {status: 'unknown'};
}
function inventoryView(state) {
  const i = state.inventory;
  return i ? {status: 'confirmed', accountId: i.accountId, ownedIds: [...i.ownedItemIds]} : {status: 'unknown'};
}
/** Mounts without fetching. Host calls open/refresh/reconcile from user actions.
 * onCarPreview({accountId,itemId,previewOnly:true}) resolves an existing native
 * saved livery in the host Garage. No recipe/asset is invented or equipped here.
 * Async preview callbacks MUST honor signal/isCurrent before applying a livery.
 * onRestorePreview MUST synchronously undo/invalidate only its temporary preview;
 * it must not save or grant inventory.
 * Disposing a view does not dispose its shared store (other views may use it).
 */
export function createShopController({root, mountShopPreview, store, onCarPreview,
  onRestorePreview, onGarage, onStudio, onApply, onClose} = {}) {
  if (typeof mountShopPreview !== 'function' || !store || typeof store.subscribe !== 'function') fail('invalid_view_adapter');
  let cleanup, disposed = false, previewAccount = null, previewGeneration = 0, previewAbort = null;
  let accountId = null, renderGeneration = 0;
  const requireView = () => { if (disposed) fail('disposed'); };
  function restore() {
    const hadPreview = previewAccount !== null; previewAccount = null; previewGeneration++;
    previewAbort?.abort(); previewAbort = null;
    if (hadPreview) { try { onRestorePreview?.(); } catch {} }
  }
  async function preview(item) {
    const state = store.state();
    if (disposed || !state.enabled || !state.accountId || state.busy || state.loading) fail('preview_unavailable');
    const selected = state.catalog?.items.find(entry => entry.id === item?.id);
    if (!selected || typeof onCarPreview !== 'function' || typeof onRestorePreview !== 'function') fail('preview_unavailable');
    restore(); previewAccount = state.accountId; const token = previewGeneration;
    previewAbort = new AbortController(); const signal = previewAbort.signal;
    const isCurrent = () => !disposed && token === previewGeneration && !signal.aborted &&
      store.state().accountId === state.accountId && store.state().enabled;
    try {
      await onCarPreview({accountId: state.accountId, itemId: selected.id, previewOnly: true, signal, isCurrent});
      const current = store.state();
      if (disposed || token !== previewGeneration || current.accountId !== state.accountId || !current.enabled) {
        // Parent preview callbacks MUST honor isCurrent before applying async work.
        if (token === previewGeneration) restore(); fail('stale_response');
      }
    } catch (caught) { if (token === previewGeneration) restore(); throw caught; }
  }
  function options(state) {
    const version = ++renderGeneration;
    const guard = () => { requireView(); if (version !== renderGeneration) fail('stale_view'); };
    const actions = {
      onPurchase: async intent => { guard(); restore(); return store.purchase(intent, {confirmed: true}); },
      onClaim: async intent => {guard();restore();const state=store.state();if(intent.accountId!==state.accountId||intent.walletRevision!==state.wallet?.revision)fail('confirmation_stale');return store.claim(intent.rewardId,{confirmed:true});},
      onRefresh: async () => {guard();restore();try{return await store.load({refresh:true});}catch{}},
      onReconcile: async () => {guard();restore();try{return await store.reconcile({confirmed:true});}catch{}},
      onApply: typeof onApply==='function'?async intent=>{guard();restore();const state=store.state();if(intent.accountId!==state.accountId||intent.draftOnly!==true||!state.inventory?.ownedItemIds.includes(intent.itemId)||state.busy||state.loading||state.pending)fail('ownership_required');return onApply({...intent,isCurrent:()=>!disposed&&version===renderGeneration&&store.state().accountId===intent.accountId&&store.state().inventory?.ownedItemIds.includes(intent.itemId)===true});}:undefined,
      onPreview: typeof onCarPreview === 'function' && typeof onRestorePreview === 'function'
        ? async item => { guard(); return preview(item); } : undefined,
      onGarage: typeof onGarage === 'function' ? () => { guard(); restore(); return onGarage(); } : undefined,
      onStudio: typeof onStudio === 'function' ? () => { guard(); restore(); return onStudio(); } : undefined,
      onClose: () => { guard(); controller.dispose(); onClose?.(); }
    };
    return {accountId: state.accountId, catalog: state.catalog || {version:2,items:[]},
      wallet: walletView(state), inventory: inventoryView(state),
      purchaseEnabled: state.enabled && !state.busy && !state.loading && !state.pending,
      refreshEnabled: state.enabled && !state.busy && !state.loading,
      claimsEnabled: state.enabled && !state.busy && !state.loading && !state.pending,
      reconciliationRequired: !!state.pending,
      actions};
  }
  const unsubscribe = store.subscribe(state => {
    if (disposed) return;
    if (state.accountId !== accountId || !state.enabled || state.loading || state.busy) restore(); accountId = state.accountId;
    const next = options(state);
    if (cleanup) cleanup.update(next); else cleanup = mountShopPreview(root, next);
  });
  const controller = {
    open: () => { requireView(); return store.load(); },
    refresh: () => { requireView(); return store.load({refresh: true}); },
    reconcile: options => { requireView(); return store.reconcile(options); }, state: () => store.state(),
    reset() { requireView(); restore(); store.reset(); },
    dispose() { if (disposed) return; disposed = true; restore(); unsubscribe(); cleanup?.(); }
  };
  return controller;
}



