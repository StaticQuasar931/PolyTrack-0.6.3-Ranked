import {validAchievementCoinReceipt,STYLE_COIN_MILESTONES} from './achievement-coin-schedule.mjs';
import {PROFILE_SHOP_CATALOG,PROFILE_SHOP_CATALOG_VERSION} from './profile-shop-catalog.mjs';
const {WORKSHOP_SHOP_CATALOG, isWorkshopShopItem}=await import(new URL('./workshop-sticker-shop-catalog.mjs'+new URL(import.meta.url).search,import.meta.url).href);
const currentItems=[...PROFILE_SHOP_CATALOG,...WORKSHOP_SHOP_CATALOG];
/** LOCAL DRAFT ONLY. Inject authenticated transport, synchronous Web Storage,
 * getAccountId, makeRequestId, and withAccountLock (createShopBrowserLock).
 * Wallet GET must include account-bound complete current-catalog inventory.
 * Missing inventory/locks fail closed for NEW purchases. Explicit reconciliation
 * remains possible with locks, using the durable original request identity.
 * Parent MUST call syncAccount/reset on every auth transition, including A-B-A.
 * No automatic retries, wallet debits, currency grants, equip or production imports.
 */
export class ShopSessionError extends Error {
  constructor(code) { super(code); this.name = 'ShopSessionError'; this.code = code; }
}
const uint = n => Number.isSafeInteger(n) && n >= 0;
const account = id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);
const item = id => typeof id === 'string' && /^[a-z0-9-]{1,80}$/.test(id);
const request = id => typeof id === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(id);
// Receipt validation only; the server remains the sole award/eligibility authority.
const MILESTONE_AWARDS = Object.freeze(Object.fromEntries(STYLE_COIN_MILESTONES.map(tier=>[tier.rewardId,tier.amount])));
const copy = value => structuredClone(value);
const fail = code => { throw new ShopSessionError(code); };

export function createShopSession({transport, storage, getAccountId, makeRequestId,
  withAccountLock, now = Date.now, cacheMs = 30000, enabled = false, workshopStickers = false,
  getRewardOwner = () => null, monotonicNow = () => globalThis.performance?.now?.() ?? Date.now(), collectionCooldownMs = 900000} = {}) {
  if (typeof transport !== 'function' || typeof getAccountId !== 'function' ||
      typeof makeRequestId !== 'function' || !uint(cacheMs) || typeof now !== 'function' || typeof monotonicNow !== 'function' ||
      !uint(collectionCooldownMs) || collectionCooldownMs < 900000 || collectionCooldownMs > 86400000 ||
      (withAccountLock !== undefined && typeof withAccountLock !== 'function')) fail('invalid_dependencies');
  let active = null, epoch = 0, on = enabled === true, busy = false;
  let confirmation = null, sequence = 0, disposed = false, controller = new AbortController();
  let catalogMemory = null;
  const caches = new Map(), reads = new Map(), purchases = new Map(), collections = new Map(), loginWindows = new Map();
  const blank = id => ({status: on ? (id ? 'idle' : 'signed-out') : 'disabled',
    accountId: id, catalog: null, wallet: null, inventory: null, pending: null, error: null, result: null, rewardSync: 'idle'});
  let state = blank(null);
  const key = id => 'polytrack-shop-pending-v1:' + id;
  const fresh = entry => {
    const at = now();
    return entry && uint(at) && at >= entry.at && at - entry.at < cacheMs;
  };
  const elapsedSince = entry => {
    const at = monotonicNow();
    return entry && Number.isFinite(at) && at >= entry.at ? at - entry.at : Infinity;
  };
  function rewardProbeKey(id,rewardIds){
    try{
      const uid=getRewardOwner();
      return typeof uid==='string'&&uid.length>0&&uid.length<=128?'polytrack-shop-reward-check-v1:'+id+':'+encodeURIComponent(uid)+':'+[...rewardIds].sort().join(','):null;
    }catch{return null;}
  }
  function collectionFresh(id,rewardIds){
    const signature=[...rewardIds].sort().join(',');
    if(elapsedSince(collections.get(id+':'+signature))<collectionCooldownMs)return true;
    const durable=rewardProbeKey(id,rewardIds),at=now();
    if(!durable||!uint(at))return false;
    try{const raw=storage?.getItem(durable);if(!/^\d{1,16}$/.test(raw||''))return false;const prior=Number(raw);return uint(prior)&&at>=prior&&at-prior<collectionCooldownMs;}catch{return false;}
  }
  function rememberCollection(id,rewardIds){
    const signature=[...rewardIds].sort().join(','),durable=rewardProbeKey(id,rewardIds),at=now();
    collections.set(id+':'+signature,{at:monotonicNow()});
    if(durable&&uint(at))try{storage?.setItem(durable,String(at));}catch{}
  }
  const loginKnownForWindow = id => elapsedSince(loginWindows.get(id)) < (loginWindows.get(id)?.remaining ?? 0);
  function rememberLoginWindow(value, id, sentAt) {
    const {claimDay,serverNow,dayEndsAt}=value||{};
    if (![claimDay,serverNow,dayEndsAt].every(uint) || serverNow < 1 || claimDay !== Math.floor(serverNow/86400000) ||
        dayEndsAt !== (claimDay+1)*86400000 || serverNow >= dayEndsAt || !Number.isFinite(sentAt)) return;
    // Request-start anchoring is conservative across response latency. This only suppresses probes, never grants money.
    loginWindows.set(id,{at:sentAt,remaining:dayEndsAt-serverNow});
  }
  function pending(id) {
    let raw;
    try { raw = storage.getItem(key(id)); } catch { fail('storage_unavailable'); }
    if (raw === null || raw === undefined) return null;
    let p;
    try { p = JSON.parse(raw); } catch { fail('invalid_pending'); }
    if(p?.schemaVersion===3){
      if(p.accountId!==id||!request(p.requestId)||!['login','milestones','achievements'].includes(p.rewardId)||Object.keys(p).sort().join(',')!=='accountId,requestId,rewardId,schemaVersion')fail('invalid_pending');
      return p;
    }
    if (![1,2].includes(p?.schemaVersion) || p.accountId !== id || !request(p.requestId) || !item(p.itemId) ||
        ![1,PROFILE_SHOP_CATALOG_VERSION].includes(p.catalogVersion) || !uint(p.price) ||
        (p.schemaVersion===2 && (p.catalogVersion!==PROFILE_SHOP_CATALOG_VERSION || !uint(p.expectedWalletRevision))) ||
        (p.schemaVersion===1 && p.catalogVersion!==1) || Object.keys(p).sort().join(',') !==
        (p.schemaVersion===2?'accountId,catalogVersion,expectedWalletRevision,itemId,price,requestId,schemaVersion':'accountId,catalogVersion,itemId,price,requestId,schemaVersion')) fail('invalid_pending');
    return p;
  }
  function invalidate(id) {
    controller.abort(); controller = new AbortController(); epoch++; confirmation = null; catalogMemory = null;
    caches.clear(); purchases.clear(); collections.clear(); loginWindows.clear(); active = id; state = blank(id);
  }
  function sync() {
    if (disposed) return null;
    const raw = getAccountId(), id = account(raw) ? raw : null;
    if (active !== id) invalidate(id);
    if (raw != null && !id) fail('invalid_account');
    if (on && id) state.pending = pending(id);
    return id;
  }
  const current = (id, g) => !disposed && on && epoch === g && getAccountId() === id && active === id;
  const check = (id, g) => { if (!current(id, g)) fail('stale_response'); };
  function requireOn() {
    if (disposed) fail('disposed'); if (!on) fail('disabled');
    const id = sync(); if (!id) fail('account_required'); return id;
  }
  function disabled() {
    const saved = state.pending; on = false; invalidate(active);
    state.pending = saved; state.error = 'currency_disabled';
  }
  function catalog(value) {
    if (![1,PROFILE_SHOP_CATALOG_VERSION].includes(value?.version) || !Array.isArray(value.items) || value.items.length > 128) fail('invalid_catalog');
    const seen = new Set();
    const items = value.items.map(row => {
      if (!item(row?.id) || seen.has(row.id) || typeof row.label !== 'string' ||
          row.label.length > 200 || !uint(row.price)) fail('invalid_catalog');
      seen.add(row.id);
      if(value.version===1&&WORKSHOP_SHOP_CATALOG.some(item=>item.id===row.id))fail('invalid_catalog');
      if(value.version===PROFILE_SHOP_CATALOG_VERSION){
        const fixed=currentItems.find(item=>item.id===row.id);
        if(!fixed||(isWorkshopShopItem(fixed)&&workshopStickers!==true)||row.kind!==fixed.kind||row.price!==fixed.price||JSON.stringify(row.grants)!==JSON.stringify(fixed.grants))fail('invalid_catalog');
        return {...copy(fixed),label:row.label,category:isWorkshopShopItem(fixed)?'workshop':'profile'};
      }
      return {id: row.id, label: row.label, price: row.price};
    });
    return {version: value.version, items};
  }
  function wallet(value, id, c) {
    if (!uint(value?.balance) || !uint(value?.revision) || !uint(value?.equipRevision) ||
        !Object.hasOwn(value, 'equipped')) fail('invalid_wallet');
    if (value.inventoryComplete !== true) fail('invalid_inventory');
    const owned = inventory(value, id, c);
    const e = value.equipped;
    if (e !== null && (!e || !owned.ownedItemIds.includes(e.itemId) || e.catalogVersion !== c.version ||
        typeof e.carStyle !== 'string' || !e.carStyle || e.carStyle.length > 2048 ||
        !uint(e.equippedAt) || e.revision !== value.equipRevision)) fail('invalid_wallet');
    return {accountId: id, catalogVersion: c.version, balance: value.balance, revision: value.revision,
      inventoryComplete: true, ownedItemIds: owned.ownedItemIds, equipRevision: value.equipRevision,
      equipped: e === null ? null : {itemId: e.itemId, catalogVersion: e.catalogVersion,
        carStyle: e.carStyle, equippedAt: e.equippedAt, revision: e.revision}};
  }
  function inventory(value, id, c) {
    if (value?.accountId !== id || value.catalogVersion !== c.version ||
        !Array.isArray(value.ownedItemIds) || value.ownedItemIds.length > c.items.length) fail('invalid_inventory');
    const seen = new Set(), known = new Set(c.items.map(row => row.id));
    for (const entry of value.ownedItemIds) {
      if (!item(entry) || !known.has(entry) || seen.has(entry)) fail('invalid_inventory'); seen.add(entry);
    }
    return {accountId: id, catalogVersion: c.version, ownedItemIds: [...seen]};
  }
  async function serverState(id, signal, reusedCatalog = null) {
    const walletPath = '/v1/currency/wallet?accountId=' + id;
    const catalogPath = '/v1/shop/catalog' + (workshopStickers === true ? '?workshop=1' : '');
    const readCatalog = reusedCatalog ? Promise.resolve(copy(reusedCatalog)) : transport({path: catalogPath, method: 'GET', signal}).then(catalog);
    // The old Worker ignores the catalog opt-in but rejects unknown wallet parameters.
    const [c, w] = await Promise.all([readCatalog, workshopStickers === true
      ? readCatalog.then(c => transport({path: walletPath + (c.items.some(row => isWorkshopShopItem(row)) ? '&workshop=1' : ''), method: 'GET', signal}))
      : transport({path: walletPath, method: 'GET', signal})]);
    const nextWallet = wallet(w, id, c);
    return {catalog: c, wallet: nextWallet, inventory: inventory(nextWallet, id, c)};
  }
  function persist(p) {
    const raw = JSON.stringify(p);
    try {
      if (storage.getItem(key(p.accountId)) !== null) fail('pending_exists');
      storage.setItem(key(p.accountId), raw);
      if (storage.getItem(key(p.accountId)) !== raw) fail('storage_unavailable');
    } catch (error) { if (error instanceof ShopSessionError) throw error; fail('storage_unavailable'); }
  }
  function remove(p) {
    try {
      const saved = pending(p.accountId);
      if (!saved || saved.requestId !== p.requestId || saved.itemId !== p.itemId || saved.schemaVersion!==p.schemaVersion || saved.rewardId!==p.rewardId || saved.catalogVersion!==p.catalogVersion || saved.price!==p.price || saved.expectedWalletRevision!==p.expectedWalletRevision) return false;
      storage.removeItem(key(p.accountId)); return storage.getItem(key(p.accountId)) === null;
    } catch { return false; }
  }
  function snapshot() {
    return copy({...state, enabled: on, busy, ownedStatus: state.inventory ? 'confirmed' : 'unknown',
      confirmedPurchases: purchases.get(active) || [], confirmation});
  }
  async function collectOpeningRewards(id, g, rewardIds) {
    if (state.pending) { state.rewardSync = 'pending'; return; }
    if (!withAccountLock) { state.rewardSync = 'unavailable'; return; }
    state.rewardSync = 'checking';
    try {
      await locked(id, g, async signal => {
        const saved = pending(id);
        if (saved) { state.pending = saved; state.rewardSync = 'pending'; return snapshot(); }
        if(collectionFresh(id,rewardIds)){state.rewardSync='settled';return snapshot();}
        for (const rewardId of rewardIds) {
          check(id, g);
          if (rewardId === 'login' && loginKnownForWindow(id)) continue;
          const requestId = makeRequestId(); if (!request(requestId)) fail('invalid_request_id');
          const p = {schemaVersion:3,accountId:id,requestId,rewardId};
          persist(p); state.pending = p;
          try { await sendClaim(p, id, g, signal, false); }
          catch (error) {
            // Only explicit server-certified no-write denials may continue the bounded batch.
            if (!(error.ambiguous === false && error.notCommitted === true && !state.pending &&
                ['reward_already_claimed','server_milestone_required','server_achievement_required','achievement_coins_disabled'].includes(error.code))) throw error;
          }
        }
        check(id,g);rememberCollection(id,rewardIds);state.rewardSync = 'settled'; return snapshot();
      });
    } catch (error) {
      if (!['shop_busy','shop_locks_unavailable','shop_lock_cancelled'].includes(error.code)) throw error;
      check(id, g); state.rewardSync = 'unavailable';
    }
  }
  function load({refresh = false, completion = false, collectRewards = false, rewardIds = ['login','milestones']} = {}) {
    if (collectRewards && (!Array.isArray(rewardIds) || rewardIds.length > 3 || new Set(rewardIds).size !== rewardIds.length ||
        rewardIds.some(id => !['login','milestones','achievements'].includes(id)))) fail('invalid_reward');
    const id = requireOn(), g = epoch, readKey = id + ':' + g, signal = controller.signal;
    if (busy) fail('purchase_in_flight'); if (reads.has(readKey)) return reads.get(readKey);
    state.status = state.pending ? 'reconciliation-required' : 'loading'; state.error = null;
    const work = (async () => {
      // Yield before cache hits too, so finally cannot outrun reads.set().
      await Promise.resolve();
      try {
        check(id, g);
        const cached = caches.get(id);
        const collectionDue = collectRewards === true && !collectionFresh(id,rewardIds);
        const reused = !refresh && completion !== true && fresh(cached) && !collectionDue;
        // A versioned catalog is presentation/quote input, never ownership proof.
        // Only mutation completion may reuse it; wallet/inventory are always read.
        const reusedCatalog = (completion === true || collectRewards === true && !refresh) && catalogMemory?.accountId === id && catalogMemory.epoch === g &&
          catalogMemory.value.version === PROFILE_SHOP_CATALOG_VERSION ? catalogMemory.value : null;
        if (!reused && collectionDue) {
          await collectOpeningRewards(id, g, rewardIds); check(id, g);
        }
        const next = reused ? copy(cached.value) : await serverState(id, signal, reusedCatalog);
        check(id, g);
        if (!reused) {
          caches.set(id, {value: next, at: now()});
          if (!reusedCatalog) catalogMemory = next.catalog.version === PROFILE_SHOP_CATALOG_VERSION
            ? {accountId: id, epoch: g, value: copy(next.catalog)} : null;
        }
        Object.assign(state, next); state.error = null; state.status = state.pending ? 'reconciliation-required' : 'ready';
        return snapshot();
      } catch (error) {
        if (current(id, g)) {
          if (error.code === 'currency_disabled') disabled();
          else { caches.delete(id); catalogMemory = null; state.status = 'error'; state.error = error.code || 'read_failed'; state.wallet = null; state.catalog = null; state.inventory = null; }
        }
        throw error;
      } finally { reads.delete(readKey); }
    })();
    reads.set(readKey, work); return work;
  }
  function preparePurchase(itemId) {
    const id = requireOn();
    if (busy) fail('purchase_in_flight'); if (state.pending) fail('reconciliation_required');
    if (state.status !== 'ready' || !state.catalog || !state.wallet) fail('wallet_unknown');
    if (!state.inventory) fail('inventory_unknown');
    if (!withAccountLock) fail('shop_locks_unavailable');
    if (!fresh(caches.get(id))) fail('refresh_required');
    const selected = state.catalog.items.find(row => row.id === itemId);
    if (!selected) fail('unknown_item');
    if (state.inventory.ownedItemIds.includes(itemId)) fail('already_owned');
    if (state.wallet.balance < selected.price) fail('insufficient_funds');
    confirmation = {id: 'confirm-' + epoch + '-' + (++sequence), accountId: id, itemId,
      price: selected.price, catalogVersion: state.catalog.version,
      walletRevision: state.wallet.revision, label: selected.label};
    return copy(confirmation);
  }
  function receipt(result, p) {
    const quoted=p.catalogVersion===PROFILE_SHOP_CATALOG_VERSION;
    const kind=quoted?currentItems.find(row=>row.id===p.itemId)?.kind:null;
    if (result?.op !== 'purchase' || result.accountId !== p.accountId || result.itemId !== p.itemId ||
        !uint(result.balanceAfter) || !uint(result.walletRevision) || typeof result.alreadyOwned !== 'boolean' ||
        typeof result.duplicate !== 'boolean' || result.delta !== (result.alreadyOwned ? 0 : -p.price) ||
        (quoted?(!kind||result.itemKind!==kind||result.catalogVersion!==PROFILE_SHOP_CATALOG_VERSION):(typeof result.carStyle !== 'string' || result.carStyle.length > 2048)) ||
        (result.requestId !== undefined && result.requestId !== p.requestId) ||
        (result.outcomeOnly !== undefined && result.outcomeOnly !== true)) fail('invalid_purchase_response');
    return {op: 'purchase', accountId: p.accountId, itemId: p.itemId, requestId: p.requestId,
      balanceAfter: result.balanceAfter, walletRevision: result.walletRevision,
      alreadyOwned: result.alreadyOwned, duplicate: result.duplicate, delta: result.delta, ...(quoted?{itemKind:kind,catalogVersion:PROFILE_SHOP_CATALOG_VERSION}:{carStyle: result.carStyle})};
  }
  async function send(p, id, g, signal, reconciling) {
    if(p.schemaVersion===3)return sendClaim(p,id,g,signal,reconciling);
    state.status = 'purchasing'; state.pending = p; state.error = null;
    try {
      const result = receipt(await transport({path: '/v1/shop/purchase', method: 'POST',
        body: {accountId: id, requestId: p.requestId, itemId: p.itemId,...(p.schemaVersion===2?{catalogVersion:p.catalogVersion,expectedPrice:p.price,expectedWalletRevision:p.expectedWalletRevision}:{})}, signal}), p);
      check(id, g);
      const cleaned = remove(p); state.pending = cleaned ? null : p; state.result = result;
      const list = purchases.get(id) || [];
      if (!list.some(row => row.requestId === p.requestId)) purchases.set(id, [...list, result]);
      // Receipt confirms a transaction, not a current inventory list or old balance.
      state.inventory = null;
      state.wallet = null;
      caches.delete(id); state.status = cleaned ? 'purchased' : 'reconciliation-required';
      return snapshot();
    } catch (error) {
      if (current(id, g)) {
        // A later definite denial cannot disprove an earlier ambiguous commit.
        const cleaned = !reconciling && error.ambiguous === false && (p.schemaVersion===1||error.notCommitted===true) && remove(p);
        state.pending = cleaned ? null : p; state.status = cleaned ? 'error' : 'reconciliation-required';
        state.error = error.code || 'purchase_ambiguous'; state.wallet = null; state.inventory = null; caches.delete(id);
        if (error.code === 'currency_disabled') disabled();
      }
      throw error;
    }
  }
  async function locked(id, g, work) {
    if (!withAccountLock) fail('shop_locks_unavailable');
    busy = true;
    let result;
    try {
      result = await withAccountLock(id, async () => { check(id, g); return work(controller.signal); }, {signal: controller.signal});
    } catch (error) {
      if (current(id, g)) {
        if (error.code === 'currency_disabled') disabled();
        else if (!state.pending && !['shop_busy', 'shop_lock_cancelled'].includes(error.code)) {
          state.status = 'error'; state.error = error.code || 'purchase_failed';
          state.wallet = null; state.inventory = null; caches.delete(id);
        }
      }
      throw error;
    } finally { busy = false; }
    return {...result, busy: false};
  }
  async function confirmPurchase(confirmationId, {confirmed = false} = {}) {
    const id = requireOn(), g = epoch;
    if (busy) fail('purchase_in_flight'); if (state.pending) fail('reconciliation_required');
    if (confirmed !== true || !confirmation || confirmation.id !== confirmationId || confirmation.accountId !== id) fail('confirmation_required');
    if (state.status !== 'ready' || reads.has(id + ':' + g) || !fresh(caches.get(id))) fail('confirmation_stale');
    const chosen = confirmation; confirmation = null;
    return locked(id, g, async signal => {
      const existing = pending(id);
      if (existing) { state.pending = existing; state.status = 'reconciliation-required'; fail('reconciliation_required'); }
      const quoted=chosen.catalogVersion===PROFILE_SHOP_CATALOG_VERSION;
      const next = quoted?{catalog:state.catalog,wallet:state.wallet,inventory:state.inventory}:await serverState(id, signal);check(id,g);
      if(!quoted){Object.assign(state,next);caches.set(id,{value:next,at:now()});}
      if (!next.inventory) fail('inventory_unknown');
      const selected = next.catalog.items.find(row => row.id === chosen.itemId);
      if (!selected || next.catalog.version !== chosen.catalogVersion || selected.price !== chosen.price ||
          next.wallet.revision !== chosen.walletRevision || next.wallet.balance < chosen.price) fail('confirmation_stale');
      if (next.inventory.ownedItemIds.includes(chosen.itemId)) fail('already_owned');
      const requestId = makeRequestId(); if (!request(requestId)) fail('invalid_request_id');
      const p = {schemaVersion: quoted?2:1, accountId: id, requestId, itemId: chosen.itemId,
        catalogVersion: chosen.catalogVersion, price: chosen.price,...(quoted?{expectedWalletRevision:chosen.walletRevision}:{})};
      persist(p); state.pending = p; check(id, g);
      return send(p, id, g, signal, false);
    });
  }
  async function reconcilePending({confirmed = false} = {}) {
    const id = requireOn(), g = epoch;
    if (busy) fail('purchase_in_flight'); if (confirmed !== true) fail('confirmation_required');
    if (reads.has(id + ':' + g)) fail('read_in_flight');
    return locked(id, g, signal => {
      const p = pending(id); if (!p) fail('no_pending_purchase');
      return send(p, id, g, signal, true);
    });
  }
  async function sendClaim(p,id,g,signal,reconciling){
    const sentAt=monotonicNow();
    state.status='claiming';state.pending=p;state.error=null;
    try{
      const result=await transport({path:'/v1/currency/claim',method:'POST',body:{accountId:id,requestId:p.requestId,rewardId:p.rewardId},signal});
      if(result?.op!=='claim'||result.accountId!==id||result.requestId!==p.requestId||result.rewardId!==p.rewardId||result.outcomeOnly!==true||!uint(result.balanceAfter)||!uint(result.walletRevision)||typeof result.duplicate!=='boolean'||result.alreadyClaimed!==false||!uint(result.delta)||result.delta<1)fail('invalid_claim_response');
      if(p.rewardId==='login'&&result.delta!==8)fail('invalid_claim_response');
      if(p.rewardId==='achievements'&&!validAchievementCoinReceipt(result))fail('invalid_claim_response');
      if(p.rewardId==='milestones'){
        const awards=MILESTONE_AWARDS,ids=result.claimedRewardIds;
        if(!Array.isArray(ids)||ids.length<1||ids.length>Object.keys(awards).length||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!Object.hasOwn(awards,id))||ids.reduce((n,id)=>n+awards[id],0)!==result.delta)fail('invalid_claim_response');
      }
      check(id,g);if(p.rewardId==='login'&&result.duplicate===false)rememberLoginWindow(result,id,sentAt);const cleaned=remove(p);state.pending=cleaned?null:p;state.result=copy(result);state.wallet=null;state.inventory=null;caches.delete(id);state.status=cleaned?'claimed':'reconciliation-required';return snapshot();
    }catch(error){
      if(current(id,g)){if(p.rewardId==='login'&&error.code==='reward_already_claimed'&&error.ambiguous===false&&error.notCommitted===true)rememberLoginWindow(error.loginClaimWindow,id,sentAt);const cleaned=!reconciling&&error.ambiguous===false&&error.notCommitted===true&&remove(p);state.pending=cleaned?null:p;state.status=cleaned?'error':'reconciliation-required';state.error=error.code||'claim_ambiguous';state.wallet=null;state.inventory=null;caches.delete(id);if(error.code==='currency_disabled')disabled();}
      throw error;
    }
  }
  async function claim(rewardId,{confirmed=false}={}){
    const id=requireOn(),g=epoch;
    if(confirmed!==true)fail('confirmation_required');if(!['login','milestones','achievements'].includes(rewardId))fail('invalid_reward');
    if(busy)fail('purchase_in_flight');if(state.pending)fail('reconciliation_required');if(state.status!=='ready'||!state.wallet||reads.has(id+':'+g))fail('wallet_unknown');
    return locked(id,g,async signal=>{const old=pending(id);if(old){state.pending=old;fail('reconciliation_required');}const requestId=makeRequestId();if(!request(requestId))fail('invalid_request_id');const p={schemaVersion:3,accountId:id,requestId,rewardId};persist(p);state.pending=p;check(id,g);return sendClaim(p,id,g,signal,false);});
  }
  function reset() { invalidate(null); }
  return {load, preparePurchase, confirmPurchase, reconcilePending,claim,
    state() { sync(); return snapshot(); }, syncAccount() { sync(); return snapshot(); }, reset,
    setEnabled(value) { if (disposed) fail('disposed'); on = value === true; reset(); return snapshot(); },
    dispose() { on = false; disposed = true; reset(); }
  };
}




