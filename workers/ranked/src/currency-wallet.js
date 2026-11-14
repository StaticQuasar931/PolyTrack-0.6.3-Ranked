// REVIEW-ONLY BACKEND: routes default OFF. No automatic awards or seeded funds.
// Requires deny-all client access to these server-owned collections before enable.
// Store MUST implement real serializable transactions, not read/mutate/save.
import {encodeNativeCarStyle} from './native-car-style.js';
import {SERVER_ACHIEVEMENT_VERSION, SERVER_ACHIEVEMENT_CATALOG, SERVER_ACHIEVEMENT_RECOGNIZED_TRACK_COUNT} from './server-achievements.js';

export const CURRENCY_SCHEMA = 1;
export const CURRENCY_RULES_VERSION = 'currency-server-only-v1';
export const CURRENCY_COLLECTIONS = Object.freeze({wallet: '0.6.3_currency_wallets',
  grants: '0.6.3_currency_grants', receipts: '0.6.3_currency_receipts',
  inventory: '0.6.3_shop_inventory', equip: '0.6.3_shop_equipped'});
const recipe = (pattern, rims, exhaust, primaryHex, secondaryHex, frameHex, rimsHex) =>
  Object.freeze({pattern, rims, exhaust, primaryHex, secondaryHex, frameHex, rimsHex});
// Named saved presets ONLY. Existing native availability/ad policies stay intact.
// These are proposed SKUs for review, not exclusive new assets or quality tiers.
export const SHOP_CATALOG = Object.freeze([
  Object.freeze({id: 'mint-rally', label: 'Mint Rally preset', price: 20,
    style: recipe(6, 11, 1, 0x167d70, 0xeafff7, 0x171d23, 0xc6e6d8)}),
  Object.freeze({id: 'ember-circuit', label: 'Ember Circuit preset', price: 80,
    style: recipe(3, 9, 3, 0x9f2e18, 0xffd78b, 0x25201e, 0xe8a742)}),
  Object.freeze({id: 'ice-apex', label: 'Ice Apex preset', price: 240,
    style: recipe(11, 6, 7, 0x183e66, 0xd6f4ff, 0x172635, 0x91bedc)})
]);
export const CURRENCY_REWARDS = Object.freeze({login: 8, 'tracks-1': 20, 'tracks-5': 30, 'tracks-20': 50});
const account = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const requestKey = value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(value);
const uint = value => Number.isSafeInteger(value) && value >= 0;
const path = (kind, id) => CURRENCY_COLLECTIONS[kind] + '/' + id;
export class CurrencyError extends Error {
  // Do not set transport `status`: the shared Firestore adapter retries 409s.
  // Business denials must roll back once, then map to their HTTP response here.
  constructor(code, status = 400) {super(code); this.httpStatus = status;}
}
const demand = (condition, code, status) => {if (!condition) throw new CurrencyError(code, status);};
async function hash(parts) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parts))))]
    .map(value => value.toString(16).padStart(2, '0')).join('');
}
function validateWallet(wallet, accountId, uid) {
  if (!wallet) return;
  demand(wallet.schema === CURRENCY_SCHEMA && wallet.accountId === accountId && wallet.ownerUid === uid &&
    uint(wallet.balance) && uint(wallet.revision) && wallet.revision < Number.MAX_SAFE_INTEGER,
  'wallet_invalid_or_owner_changed', 409);
}
function owned(value, accountId, uid, item) {
  return value?.accountId === accountId && value.ownerUid === uid && value.itemId === item.id && value.catalogVersion === 1;
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

export function createCurrencyService({store, now = Date.now}) {
  demand(typeof store?.transaction === 'function' && typeof now === 'function', 'transaction_store_required', 503);
  return Object.freeze({
    async execute(uid, command) {
      demand(typeof uid === 'string' && uid.length > 0 && uid.length <= 128, 'authentication_required', 401);
      const fields = {wallet: ['op', 'accountId'], claim: ['op', 'accountId', 'requestId', 'rewardId'],
        purchase: ['op', 'accountId', 'requestId', 'itemId'], equip: ['op', 'accountId', 'requestId', 'itemId']};
      demand(command && typeof command.op === 'string' && Object.hasOwn(fields, command.op), 'invalid_command');
      demand(Object.keys(command).length === fields[command.op].length &&
        Object.keys(command).every(key => fields[command.op].includes(key)) && account(command.accountId), 'invalid_command');
      const {op, accountId, requestId, rewardId, itemId} = command;
      if (op !== 'wallet') demand(requestKey(requestId), 'invalid_request_id');
      const at = now(); demand(uint(at), 'server_clock_required', 503);
      const day = Math.floor(at / 86400000);
      const item = ['purchase', 'equip'].includes(op) ? SHOP_CATALOG.find(value => value.id === itemId) : null;
      if (['purchase', 'equip'].includes(op)) demand(item, 'unknown_item');
      if (op === 'claim') demand(typeof rewardId === 'string' && Object.hasOwn(CURRENCY_REWARDS, rewardId), 'unknown_reward');
      // Operation receipt is UID/account scoped; grant/inventory uniqueness is
      // account scoped so changing request IDs cannot create another award/item.
      const receiptId = op === 'wallet' ? null : await hash([uid, accountId, requestId]);
      const fingerprint = JSON.stringify([op, accountId, rewardId ?? null, itemId ?? null]);
      const grantId = op === 'claim' ? await hash([accountId, rewardId, rewardId === 'login' ? day : 'lifetime']) : null;
      const inventoryId = item ? await hash([accountId, itemId]) : null;
      return store.transaction(async tx => {
        const profile = await tx.get('0.6.2_profiles_public/' + accountId);
        demand(profile?.accountId === accountId && profile.ownerUid === uid, 'profile_not_owned', 403);
        const wallet = await tx.get(path('wallet', accountId)); validateWallet(wallet, accountId, uid);
        const balance = wallet?.balance ?? 0, revision = wallet?.revision ?? 0;
        if (op === 'wallet') {
          const equipped = await tx.get(path('equip', accountId));
          if (equipped) {
            demand(equipped.accountId === accountId && equipped.ownerUid === uid, 'equip_owner_changed', 409);
            const selected = SHOP_CATALOG.find(item => item.id === equipped.itemId);
            demand(selected && equipped.catalogVersion === 1 && equipped.carStyle === encodeNativeCarStyle(selected.style),
              'equipped_recipe_invalid', 409);
            const inventory = await tx.get(path('inventory', await hash([accountId, selected.id])));
            demand(owned(inventory, accountId, uid, selected), 'equipped_item_not_owned', 409);
          }
          return {balance, revision, equipped: equipped || null};
        }
        const receipt = await tx.get(path('receipts', receiptId));
        if (receipt) {
          demand(receipt.ownerUid === uid && receipt.accountId === accountId && receipt.fingerprint === fingerprint,
            'idempotency_key_reused', 409);
          // Historical success is not current permission to expose/equip a SKU.
          if (op === 'equip') {
            const inventory = await tx.get(path('inventory', inventoryId));
            demand(owned(inventory, accountId, uid, item), 'item_not_owned', 403);
            demand(receipt.result?.carStyle === encodeNativeCarStyle(item.style), 'equipped_recipe_invalid', 409);
          }
          return {...receipt.result, duplicate: true};
        }
        let delta = 0, grant = null, inventory = null, oldEquip = null, evidence = null;
        if (op === 'claim') {
          grant = await tx.get(path('grants', grantId));
          if (grant) {
            demand(grant.accountId === accountId && grant.ownerUid === uid && grant.rewardId === rewardId,
              'grant_owner_changed', 409);
            // Unreserved aliases are failed operations, not successful receipts
            // whose result could silently change at the next UTC day boundary.
            throw new CurrencyError('reward_already_claimed', 409);
          }
          else {
            if (rewardId === 'login') evidence = {kind: 'authenticated-server-utc-day', day};
            else evidence = milestoneEvidence(await tx.get('0.6.2_s1_cosmetic_entitlements/' + accountId),
              Number(rewardId.slice(7)));
            delta = CURRENCY_REWARDS[rewardId];
          }
        } else {
          inventory = await tx.get(path('inventory', inventoryId));
          if (inventory) demand(owned(inventory, accountId, uid, item), 'inventory_owner_changed', 409);
          if (op === 'purchase' && !inventory) {
            demand(balance >= item.price, 'insufficient_funds', 409); delta = -item.price;
          }
          if (op === 'equip') {
            demand(owned(inventory, accountId, uid, item), 'item_not_owned', 403);
            oldEquip = await tx.get(path('equip', accountId));
            if (oldEquip) demand(oldEquip.accountId === accountId && oldEquip.ownerUid === uid, 'equip_owner_changed', 409);
          }
        }
        const nextBalance = balance + delta;
        demand(uint(nextBalance), 'wallet_overflow', 409);
        const changed = delta !== 0;
        const carStyle = item ? encodeNativeCarStyle(item.style) : null;
        const result = {op, accountId, delta, balanceAfter: nextBalance, walletRevision: revision + (changed ? 1 : 0),
          ...(rewardId ? {rewardId} : {}), ...(item ? {itemId, carStyle} : {}),
          ...(op === 'claim' ? {alreadyClaimed: Boolean(grant)} : {}),
          ...(op === 'purchase' ? {alreadyOwned: Boolean(inventory)} : {})};
        // Every read precedes every write. The transaction adapter persists these
        // together or none, and retries the entire function on write conflicts.
        if (changed) await tx.set(path('wallet', accountId), {schema: CURRENCY_SCHEMA, accountId, ownerUid: uid,
          balance: nextBalance, revision: revision + 1, updatedAt: at});
        if (op === 'claim' && !grant) await tx.create(path('grants', grantId),
          {accountId, ownerUid: uid, rewardId, delta, grantedAt: at, evidence});
        if (op === 'purchase' && !inventory) await tx.create(path('inventory', inventoryId),
          {accountId, ownerUid: uid, itemId, catalogVersion: 1, purchasedAt: at});
        if (op === 'equip') await tx.set(path('equip', accountId),
          {accountId, ownerUid: uid, itemId, catalogVersion: 1, carStyle, equippedAt: at});
        await tx.create(path('receipts', receiptId), {accountId, ownerUid: uid, fingerprint, result, createdAt: at});
        return {...result, duplicate: false};
      });
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
    let uid; try {uid = await authenticate(request);} catch {throw new CurrencyError('authentication_required', 401);}
    const denial = await admit(uid); if (denial) return denial;
    const url = new URL(request.url), pathname = url.pathname.replace(/\/+$/, '');
    if (request.method === 'GET' && pathname === '/v1/shop/catalog') {
      return respond(200, {version: 1, kind: 'saved-native-presets-not-exclusive-parts', items: SHOP_CATALOG});
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
      catch {throw new CurrencyError('invalid_body');}
      demand(body && typeof body === 'object' && !Array.isArray(body) && !Object.hasOwn(body, 'op'), 'invalid_body');
      command = {op: ops[pathname], ...body};
    }
    return respond(200, await createCurrencyService({store, now}).execute(uid, command));
  } catch (error) {
    return respond(error instanceof CurrencyError ? error.httpStatus : 503,
      {error: error instanceof CurrencyError ? error.message : 'currency_unavailable'});
  }
}
