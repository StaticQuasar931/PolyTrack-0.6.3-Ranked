// REVIEW-ONLY BACKEND: routes default OFF. No automatic awards or seeded funds.
// Requires deny-all client access to these server-owned collections before enable.
// Store MUST implement real serializable transactions, not read/mutate/save.
import {encodeNativeCarStyle} from './native-car-style.js';
import {PROFILE_SHOP_CATALOG, PROFILE_SHOP_CATALOG_VERSION} from '../../../tools/profile-shop-catalog.mjs';
import {addPurchase, readPurchasedCosmetics} from './purchased-cosmetic-entitlements.js';
import {invalidateEntitlements} from './overall-entitlement-cache.js';
import {SERVER_ACHIEVEMENT_VERSION, SERVER_ACHIEVEMENT_CATALOG, SERVER_ACHIEVEMENT_RECOGNIZED_TRACK_COUNT} from './server-achievements.js';

export const CURRENCY_SCHEMA = 1;
export const CURRENCY_RULES_VERSION = 'currency-server-only-v1';
export const CURRENCY_COLLECTIONS = Object.freeze({wallet: '0.6.3_currency_wallets',
  grants: '0.6.3_currency_grants', receipts: '0.6.3_currency_receipts',
  inventory: '0.6.3_shop_inventory', equip: '0.6.3_shop_equipped'});
const recipe = (pattern, rims, exhaust, primaryHex, secondaryHex, frameHex, rimsHex) =>
  Object.freeze({pattern, rims, exhaust, primaryHex, secondaryHex, frameHex, rimsHex});
// Retired version-1 recipes remain read-only historical evidence, never sellable.
// Native availability and ad policy are never bypassed.
const LEGACY_SHOP_CATALOG = Object.freeze([
  Object.freeze({id: 'mint-rally', label: 'Mint Rally preset', price: 20,
    style: recipe(6, 11, 1, 0x167d70, 0xeafff7, 0x171d23, 0xc6e6d8)}),
  Object.freeze({id: 'ember-circuit', label: 'Ember Circuit preset', price: 80,
    style: recipe(3, 9, 3, 0x9f2e18, 0xffd78b, 0x25201e, 0xe8a742)}),
  Object.freeze({id: 'ice-apex', label: 'Ice Apex preset', price: 240,
    style: recipe(11, 6, 7, 0x183e66, 0xd6f4ff, 0x172635, 0x91bedc)})
]);
export const SHOP_CATALOG = PROFILE_SHOP_CATALOG;
export const SHOP_CATALOG_VERSION = PROFILE_SHOP_CATALOG_VERSION;
const ENTITLEMENT_PATH = '0.6.2_s1_cosmetic_entitlements/';
const META_PATH = '0.6.2_s1_release_meta/current';
const MILESTONE_IDS = Object.freeze(['tracks-1', 'tracks-5', 'tracks-20']);
export const CURRENCY_REWARDS = Object.freeze({login: 8, 'tracks-1': 20, 'tracks-5': 30, 'tracks-20': 50});
const account = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const requestKey = value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(value);
const uint = value => Number.isSafeInteger(value) && value >= 0;
// Compatibility reads never grow with the current sellable catalog.
const ORIGINAL_PROFILE_INVENTORY_IDS = Object.freeze([
  'profile-pitlane-ticket', 'profile-apex-observatory', 'profile-vector-ribbon'
]);
const PROFILE_CATALOG_LIMIT = 32;
const path = (kind, id) => CURRENCY_COLLECTIONS[kind] + '/' + id;
export class CurrencyError extends Error {
  // Do not set transport `status`: the shared Firestore adapter retries 409s.
  // Business denials must roll back once, then map to their HTTP response here.
  constructor(code, status = 400) {super(code); this.httpStatus = status; this.notCommitted = false;}
}
// Only explicit domain guards, all before buffered writes, can certify rejection.
// Store/commit errors never get this marker, including lost successful replies.
const domainRejection = (code, status = 400) => {
  const error = new CurrencyError(code, status); error.notCommitted = status >= 400 && status < 500; return error;
};
const demand = (condition, code, status) => {if (!condition) throw domainRejection(code, status);};
const loginClaimClocks = new WeakMap();
const successfulLoginClocks = new WeakMap();
async function hash(parts) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parts))))]
    .map(value => value.toString(16).padStart(2, '0')).join('');
}
function validateWallet(wallet, accountId, uid) {
  if (!wallet) return;
  demand(wallet.schema === CURRENCY_SCHEMA && wallet.accountId === accountId && wallet.ownerUid === uid &&
    uint(wallet.balance) && uint(wallet.revision) &&
    (!Object.hasOwn(wallet, 'equipRevision') || uint(wallet.equipRevision)),
  'wallet_invalid_or_owner_changed', 409);
}
function owned(value, accountId, uid, item) {
  return value?.accountId === accountId && value.ownerUid === uid && value.itemId === item.id && value.catalogVersion === (item.kind === 'profile-cosmetic' ? SHOP_CATALOG_VERSION : 1) &&
    (item.kind !== 'profile-cosmetic' || value.kind === item.kind);
}
function checkedEquip(equipped, accountId, uid, knownRevision = null) {
  if (!equipped) return {item: null, revision: knownRevision ?? 0, projection: null};
  demand(equipped.accountId === accountId && equipped.ownerUid === uid, 'equip_owner_changed', 409);
  const item = LEGACY_SHOP_CATALOG.find(value => value.id === equipped.itemId);
  demand(item && equipped.catalogVersion === 1 && equipped.carStyle === encodeNativeCarStyle(item.style) &&
    uint(equipped.equippedAt), 'equipped_recipe_invalid', 409);
  // The disabled prototype's legacy equip documents had no revision.
  const revision = Object.hasOwn(equipped, 'revision') ? equipped.revision : knownRevision ?? 0;
  demand(uint(revision) && (knownRevision === null || revision === knownRevision), 'equip_revision_invalid', 409);
  return {item, revision, projection: {itemId: item.id, catalogVersion: 1,
    carStyle: equipped.carStyle, equippedAt: equipped.equippedAt, revision}};
}
function milestoneEvidence(entitlement, threshold) {
  const achievements = entitlement?.serverIssued?.achievements;
  const casual = achievements?.casual;
  const bytes = Math.ceil(SERVER_ACHIEVEMENT_RECOGNIZED_TRACK_COUNT / 8);
  demand(achievements?.version === SERVER_ACHIEVEMENT_VERSION && achievements.catalog === SERVER_ACHIEVEMENT_CATALOG &&
    typeof casual?.ledger === 'string' && casual.ledger.length === bytes * 2 && /^[0-9a-f]+$/i.test(casual.ledger) &&
    uint(casual.count) && casual.count <= SERVER_ACHIEVEMENT_RECOGNIZED_TRACK_COUNT, 'server_milestone_required', 403);
  const usedBits = SERVER_ACHIEVEMENT_RECOGNIZED_TRACK_COUNT % 8;
  demand(!usedBits || (Number.parseInt(casual.ledger.slice(-2), 16) & (255 << usedBits)) === 0,
    'server_milestone_required', 403);
  const count = [...casual.ledger].reduce((sum, digit) => sum + Number.parseInt(digit, 16).toString(2).replaceAll('0', '').length, 0);
  demand(count === casual.count && count >= threshold, 'server_milestone_required', 403);
  return {kind: 'permanent-server-track-ledger', catalog: achievements.catalog, threshold};
}

function checkedMilestoneGrant(grant, accountId, uid, rewardId) {
  if (!grant) return;
  demand(grant.accountId === accountId && grant.ownerUid === uid && grant.rewardId === rewardId,
    'grant_owner_changed', 409);
  if (rewardId === 'milestones') {
    const ids = grant.claimedRewardIds;
    demand(Array.isArray(ids) && ids.length > 0 && ids.length <= MILESTONE_IDS.length &&
      new Set(ids).size === ids.length && ids.every(id => MILESTONE_IDS.includes(id)) &&
      grant.delta === ids.reduce((sum, id) => sum + CURRENCY_REWARDS[id], 0), 'grant_invalid', 409);
  }
}

export function createCurrencyService({store, now = Date.now}) {
  demand(typeof store?.transaction === 'function' && typeof now === 'function', 'transaction_store_required', 503);
  demand(SHOP_CATALOG_VERSION === 2 && SHOP_CATALOG.length >= ORIGINAL_PROFILE_INVENTORY_IDS.length &&
    SHOP_CATALOG.length <= PROFILE_CATALOG_LIMIT && new Set(SHOP_CATALOG.map(item => item.id)).size === SHOP_CATALOG.length &&
    ORIGINAL_PROFILE_INVENTORY_IDS.every(id => SHOP_CATALOG.some(item => item.id === id && item.kind === 'profile-cosmetic')),
  'inventory_catalog_limit', 503);
  return Object.freeze({
    async execute(uid, command) {
      demand(typeof uid === 'string' && uid.length > 0 && uid.length <= 128, 'authentication_required', 401);
      const fields = {wallet: ['op', 'accountId'], claim: ['op', 'accountId', 'requestId', 'rewardId'],
        purchase: ['op', 'accountId', 'requestId', 'itemId', 'catalogVersion', 'expectedPrice', 'expectedWalletRevision'], equip: ['op', 'accountId', 'requestId', 'itemId']};
      demand(command && typeof command.op === 'string' && Object.hasOwn(fields, command.op), 'invalid_command');
      const legacyPurchase = command.op === 'purchase' && LEGACY_SHOP_CATALOG.some(item => item.id === command.itemId) &&
        Object.keys(command).length === 4;
      const allowed = legacyPurchase ? ['op', 'accountId', 'requestId', 'itemId'] : fields[command.op];
      demand(Object.keys(command).length === allowed.length && Object.keys(command).every(key => allowed.includes(key)) &&
        account(command.accountId), 'invalid_command');
      const {op, accountId, requestId, rewardId, itemId, catalogVersion, expectedPrice, expectedWalletRevision} = command;
      if (op === 'purchase' && !legacyPurchase)
        demand(uint(catalogVersion) && uint(expectedPrice) && uint(expectedWalletRevision), 'invalid_quote');
      if (op !== 'wallet') demand(requestKey(requestId), 'invalid_request_id');
      const at = now(); demand(uint(at) && at > 0, 'server_clock_required', 503);
      const day = Math.floor(at / 86400000);
      const item = ['purchase', 'equip'].includes(op) ? SHOP_CATALOG.find(value => value.id === itemId) : null;
      const legacyItem = ['purchase', 'equip'].includes(op) ? LEGACY_SHOP_CATALOG.find(value => value.id === itemId) : null;
      if (['purchase', 'equip'].includes(op)) demand(item || legacyItem, 'unknown_item');
      if (op === 'claim') demand(typeof rewardId === 'string' &&
        (Object.hasOwn(CURRENCY_REWARDS, rewardId) || rewardId === 'milestones'), 'unknown_reward');
      const receiptId = op === 'wallet' ? null : await hash([uid, accountId, requestId]);
      const fingerprint = JSON.stringify([op, accountId, rewardId ?? null, itemId ?? null,
        ...(op === 'purchase' && !legacyPurchase ? [catalogVersion, expectedPrice, expectedWalletRevision] : [])]);
      const grantId = op === 'claim' ? await hash([accountId, rewardId, rewardId === 'login' ? day : 'lifetime']) : null;
      const aggregateId = op === 'claim' && rewardId !== 'login' ? await hash([accountId, 'milestones', 'lifetime']) : null;
      const legacyGrants = rewardId === 'milestones' ? await Promise.all(MILESTONE_IDS.map(async id =>
        [id, await hash([accountId, id, 'lifetime'])])) : [];
      const inventoryId = item || legacyItem ? await hash([accountId, itemId]) : null;
      const compatibilityInventory = op === 'wallet' ? await Promise.all(ORIGINAL_PROFILE_INVENTORY_IDS.map(async id =>
        [SHOP_CATALOG.find(item => item.id === id), await hash([accountId, id])])) : [];
      const outcome = await store.transaction(async tx => {
        const profile = await tx.get('0.6.2_profiles_public/' + accountId);
        demand(profile?.accountId === accountId && profile.ownerUid === uid, 'profile_not_owned', 403);
        const wallet = await tx.get(path('wallet', accountId)); validateWallet(wallet, accountId, uid);
        const balance = wallet?.balance ?? 0, revision = wallet?.revision ?? 0;
        const knownEquipRevision = wallet && Object.hasOwn(wallet, 'equipRevision') ? wallet.equipRevision : null;
        if (op === 'wallet') {
          const equipped = checkedEquip(await tx.get(path('equip', accountId)), accountId, uid, knownEquipRevision);
          demand(equipped.projection || equipped.revision === 0, 'equipped_state_missing', 409);
          const purchased = readPurchasedCosmetics(await tx.get(ENTITLEMENT_PATH + accountId), {accountId, ownerUid: uid});
          const ownedIds = new Set(Object.keys(purchased?.items || {}));
          for (const [selected, id] of compatibilityInventory) {
            const inventory = await tx.get(path('inventory', id));
            if (inventory) {
              demand(owned(inventory, accountId, uid, selected), 'inventory_owner_changed', 409);
              const canonical = purchased?.items[selected.id];
              demand(!canonical || inventory.purchasedAt === canonical.acquiredAt, 'inventory_entitlement_conflict', 409);
              ownedIds.add(selected.id);
            }
          }
          // Canonical purchases cover all new items; only the original three need fallback reads.
          // This read-only union neither repairs legacy provenance nor exposes retired native recipes.
          const ownedItemIds = SHOP_CATALOG.filter(item => ownedIds.has(item.id)).map(item => item.id);
          return {accountId, catalogVersion: SHOP_CATALOG_VERSION, balance, revision, ownedItemIds, inventoryComplete: true,
            equipRevision: equipped.revision, equipped: null};
        }
        const receipt = await tx.get(path('receipts', receiptId));
        if (receipt) {
          demand(receipt.ownerUid === uid && receipt.accountId === accountId && receipt.fingerprint === fingerprint,
            'idempotency_key_reused', 409);
          if (op === 'equip') {
            demand(legacyItem && owned(await tx.get(path('inventory', inventoryId)), accountId, uid, legacyItem),
              'item_not_owned', 403);
            demand(receipt.result?.carStyle === encodeNativeCarStyle(legacyItem.style), 'equipped_recipe_invalid', 409);
          }
          return {...receipt.result, duplicate: true};
        }
        if (op === 'equip') throw domainRejection(item ? 'profile_apply_via_studio' : 'item_retired', 409);
        if (op === 'purchase') {
          demand(item?.kind === 'profile-cosmetic' && !legacyPurchase, 'item_retired', 409);
          // Receipt identity wins over a now-stale quote on exact recovery retries.
          demand(catalogVersion === SHOP_CATALOG_VERSION && expectedPrice === item.price &&
            expectedWalletRevision === revision, 'quote_stale', 409);
        }
        let delta = 0, grant = null, inventory = null, evidence = null, claimedRewardIds = null;
        let purchasedEntitlement = null, nextMeta = null, aggregate = null, aggregateRewardIds = null;
        if (op === 'claim') {
          grant = await tx.get(path('grants', grantId));
          checkedMilestoneGrant(grant, accountId, uid, rewardId);
          if (rewardId === 'login') {
            if (grant) {
              const error = domainRejection('reward_already_claimed', 409);
              const dayEndsAt = (day + 1) * 86400000;
              // This owned grant was read under today's exact server-day key.
              // Legacy receipts and wallet timestamps cannot establish this fact.
              if (uint(dayEndsAt) && dayEndsAt > at)
                loginClaimClocks.set(error, {claimDay: day, serverNow: at, dayEndsAt});
              throw error;
            }
            evidence = {kind: 'authenticated-server-utc-day', day}; delta = CURRENCY_REWARDS.login;
          } else {
            aggregate = rewardId === 'milestones' ? grant : await tx.get(path('grants', aggregateId));
            checkedMilestoneGrant(aggregate, accountId, uid, 'milestones');
            const claimed = new Set(aggregate?.claimedRewardIds || []);
            if (rewardId === 'milestones') {
              for (const [id, key] of legacyGrants) {
                const old = await tx.get(path('grants', key)); checkedMilestoneGrant(old, accountId, uid, id);
                if (old) claimed.add(id);
              }
              const entitlement = await tx.get(ENTITLEMENT_PATH + accountId);
              milestoneEvidence(entitlement, 1);
              const count = entitlement.serverIssued.achievements.casual.count;
              claimedRewardIds = MILESTONE_IDS.filter(id => count >= Number(id.slice(7)) && !claimed.has(id));
              demand(claimedRewardIds.length > 0, 'reward_already_claimed', 409);
              delta = claimedRewardIds.reduce((sum, id) => sum + CURRENCY_REWARDS[id], 0);
              aggregateRewardIds = MILESTONE_IDS.filter(id => claimed.has(id) || claimedRewardIds.includes(id));
              evidence = milestoneEvidence(entitlement, Math.max(...claimedRewardIds.map(id => Number(id.slice(7)))));
            } else {
              demand(!grant && !claimed.has(rewardId), 'reward_already_claimed', 409);
              evidence = milestoneEvidence(await tx.get(ENTITLEMENT_PATH + accountId), Number(rewardId.slice(7)));
              delta = CURRENCY_REWARDS[rewardId];
            }
          }
        } else {
          inventory = await tx.get(path('inventory', inventoryId));
          if (inventory) demand(owned(inventory, accountId, uid, item), 'inventory_owner_changed', 409);
          demand(!inventory, 'item_already_owned', 409);
          demand(balance >= item.price, 'insufficient_funds', 409);
          const prior = await tx.get(ENTITLEMENT_PATH + accountId);
          const meta = await tx.get(META_PATH);
          // A canonical purchased projection and cache fence commit with the money.
          purchasedEntitlement = addPurchase(prior, item.id, at, {accountId, ownerUid: uid});
          demand(!Object.hasOwn(prior?.purchased?.items || {}, item.id), 'inventory_entitlement_conflict', 409);
          nextMeta = invalidateEntitlements(meta || {}, [accountId]);
          delta = -item.price;
        }
        const nextBalance = balance + delta; demand(uint(nextBalance), 'wallet_overflow', 409);
        const nextRevision = revision + 1; demand(uint(nextRevision), 'wallet_revision_overflow', 409);
        const result = {op, accountId, requestId, outcomeOnly: true, delta, balanceAfter: nextBalance, walletRevision: nextRevision,
          ...(rewardId ? {rewardId} : {}), ...(claimedRewardIds ? {claimedRewardIds} : {}),
          ...(item ? {itemId, itemKind: item.kind, catalogVersion: SHOP_CATALOG_VERSION} : {}),
          ...(op === 'claim' ? {alreadyClaimed: false} : {}), ...(op === 'purchase' ? {alreadyOwned: false} : {})};
        // All reads precede all writes, including canonical entitlement/cache CAS.
        await tx.set(path('wallet', accountId), {schema: CURRENCY_SCHEMA, accountId, ownerUid: uid,
          balance: nextBalance, revision: nextRevision, updatedAt: at,
          ...(knownEquipRevision === null ? {} : {equipRevision: knownEquipRevision})});
        if (op === 'claim') {
          const data = {accountId, ownerUid: uid, rewardId, delta: aggregateRewardIds ?
            aggregateRewardIds.reduce((sum, id) => sum + CURRENCY_REWARDS[id], 0) : delta, grantedAt: at, evidence,
            ...(aggregateRewardIds ? {claimedRewardIds: aggregateRewardIds} : {})};
          if (grant) await tx.set(path('grants', grantId), data);
          else await tx.create(path('grants', grantId), data);
        }
        if (op === 'purchase') {
          await tx.create(path('inventory', inventoryId), {accountId, ownerUid: uid, itemId,
            kind: item.kind, catalogVersion: SHOP_CATALOG_VERSION, purchasedAt: at});
          await tx.set(ENTITLEMENT_PATH + accountId, purchasedEntitlement);
          await tx.set(META_PATH, nextMeta);
        }
        await tx.create(path('receipts', receiptId), {accountId, ownerUid: uid, fingerprint, result, createdAt: at});
        return {...result, duplicate: false};
      });
      // Transport-only availability is trustworthy only after a successful commit.
      if (op === 'claim' && rewardId === 'login' && outcome.duplicate === false) {
        const dayEndsAt = (day + 1) * 86400000;
        if (uint(dayEndsAt) && dayEndsAt > at)
          successfulLoginClocks.set(outcome, {claimDay: day, serverNow: at, dayEndsAt});
      }
      return outcome;
    }
  });
}

export async function handleCurrencyRequest(request, {env, store, authenticate, admit, headers, now = Date.now}) {
  const respond = (status, value) => {
    const output = new Headers(headers); output.set('Content-Type', 'application/json');
    output.set('Cache-Control', 'private, no-store');
    return new Response(JSON.stringify(value), {status, headers: output});
  };
  // Operational review gate, NOT a replacement for actual server-only rules.
  if (env.CURRENCY_ENABLED !== 'true' || env.CURRENCY_RULES_VERSION !== CURRENCY_RULES_VERSION ||
      env.RANKED_WRITES_ENABLED === 'false') return respond(503, {error: 'currency_disabled'});
  try {
    let uid; try {uid = await authenticate(request);} catch {throw domainRejection('authentication_required', 401);}
    const denial = await admit(uid); if (denial) return denial;
    const url = new URL(request.url), pathname = url.pathname.replace(/\/+$/, '');
    if (request.method === 'GET' && pathname === '/v1/shop/catalog') {
      return respond(200, {version: SHOP_CATALOG_VERSION, kind: 'profile-cosmetic', items: SHOP_CATALOG});
    }
    let command;
    if (request.method === 'GET' && pathname === '/v1/currency/wallet') {
      demand([...url.searchParams.keys()].every(key => key === 'accountId') && url.searchParams.getAll('accountId').length === 1,
        'invalid_command');
      command = {op: 'wallet', accountId: url.searchParams.get('accountId')};
    } else {
      const ops = {'/v1/currency/claim': 'claim', '/v1/shop/purchase': 'purchase', '/v1/shop/equip': 'equip'};
      demand(request.method === 'POST' && Object.hasOwn(ops, pathname), 'not_found', 404);
      const reader = request.body?.getReader(); demand(reader, 'invalid_body');
      const chunks = []; let length = 0;
      try {
        for (;;) {const {done, value} = await reader.read(); if (done) break;
          length += value.byteLength; demand(length <= 2048, 'body_too_large', 413); chunks.push(value);}
      } finally {await reader.cancel().catch(() => {});}
      let body; try {body = JSON.parse(new TextDecoder().decode(Uint8Array.from(chunks.flatMap(chunk => [...chunk]))));}
      catch {throw domainRejection('invalid_body');}
      demand(body && typeof body === 'object' && !Array.isArray(body) && !Object.hasOwn(body, 'op'), 'invalid_body');
      command = {op: ops[pathname], ...body};
    }
    const outcome = await createCurrencyService({store, now}).execute(uid, command);
    return respond(200, {...outcome,
      ...(command.op === 'claim' && command.rewardId === 'login' && outcome.duplicate === false ?
        successfulLoginClocks.get(outcome) : {})});
  } catch (error) {
    return respond(error instanceof CurrencyError ? error.httpStatus : 503,
      {error: error instanceof CurrencyError ? error.message : 'currency_unavailable',
        ...(error instanceof CurrencyError && error.notCommitted === true && error.httpStatus < 500 ? {notCommitted: true} : {}),
        ...(error instanceof CurrencyError && error.notCommitted === true && error.httpStatus === 409 &&
          error.message === 'reward_already_claimed' ? loginClaimClocks.get(error) : {})});
  }
}
