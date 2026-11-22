// REVIEW-ONLY BACKEND: routes default OFF. No automatic awards or seeded funds.
// Requires deny-all client access to these server-owned collections before enable.
// Store MUST implement real serializable transactions, not read/mutate/save.
import {ACHIEVEMENT_COIN_POLICY_VERSION, ACHIEVEMENT_COIN_SCHEDULE, validAchievementCoinReceipt} from '../../../tools/achievement-coin-schedule.mjs';
import {CLIENT_REVISION_HEADER} from './client-access-policy.js';
import {encodeNativeCarStyle} from './native-car-style.js';
import {PROFILE_SHOP_CATALOG, PROFILE_SHOP_CATALOG_VERSION} from '../../../tools/profile-shop-catalog.mjs';
import {WORKSHOP_STICKER_SHOP_CATALOG} from '../../../tools/workshop-sticker-shop-catalog.mjs';
import {addPurchase, readPurchasedCosmetics} from './purchased-cosmetic-entitlements.js';
import {invalidateEntitlements} from './overall-entitlement-cache.js';
import {SERVER_ACHIEVEMENT_VERSION, SERVER_ACHIEVEMENT_CATALOG, SERVER_ACHIEVEMENT_RECOGNIZED_TRACK_COUNT, OWNER_PUBLIC_ID, BEAT_OWNER_STAGES} from './server-achievements.js';

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
// Keep the existing response for clients that do not opt into Workshop offers.
export const SHOP_CATALOG = PROFILE_SHOP_CATALOG;
export const SHOP_CATALOG_VERSION = PROFILE_SHOP_CATALOG_VERSION;
const ALL_SHOP_ITEMS = Object.freeze([...SHOP_CATALOG, ...WORKSHOP_STICKER_SHOP_CATALOG]);
const ORIGINAL_WORKSHOP_ITEMS = Object.freeze(ALL_SHOP_ITEMS.filter(item=>item.kind!=='workshop-sticker'||['workshop-sticker-solar-flare','workshop-sticker-tide-mark'].includes(item.id)));
// Browsers validate each catalog ID against their own immutable client bundle.
function compatibleWorkshopItems(request,requested){
 const raw=request.headers.get(CLIENT_REVISION_HEADER),revision=Number(raw);
 if(!requested||!/^\d+$/.test(raw||'')||!Number.isSafeInteger(revision)||revision<376)return SHOP_CATALOG;
 return revision>=382?ALL_SHOP_ITEMS:ORIGINAL_WORKSHOP_ITEMS;
}
const ENTITLEMENT_PATH = '0.6.2_s1_cosmetic_entitlements/';
const META_PATH = '0.6.2_s1_release_meta/current';
// Historical amounts/IDs are immutable. Only these three have separate legacy grant documents.
const LEGACY_MILESTONE_IDS = Object.freeze(['tracks-1', 'tracks-5', 'tracks-20']);
export const CURRENCY_REWARDS = Object.freeze({login: 8, 'tracks-1': 20, 'tracks-5': 30, 'tracks-20': 50,
  'tracks-35': 30, 'tracks-50': 40, 'tracks-70': 50, 'tracks-89': 60});
export const CURRENCY_MILESTONES = Object.freeze([1, 5, 20, 35, 50, 70, 89].map(threshold =>
  Object.freeze({rewardId: 'tracks-' + threshold, threshold, amount: CURRENCY_REWARDS['tracks-' + threshold]})));
const MILESTONE_IDS = Object.freeze(CURRENCY_MILESTONES.map(tier => tier.rewardId));
const account = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const requestKey = value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(value);
const uint = value => Number.isSafeInteger(value) && value >= 0;
// Compatibility reads never grow with the current sellable catalog.
const ORIGINAL_PROFILE_INVENTORY_IDS = Object.freeze([
  'profile-pitlane-ticket', 'profile-apex-observatory', 'profile-vector-ribbon'
]);
const PROFILE_CATALOG_LIMIT = 32;
// Pinned to the publisher's official-track registry; no live track lookups in claims.
const COIN_OWNER_TRACK_BITS = new Map([["5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038",0],["7eac4fee1111152cfba4d3737410264ca0f22c7f5a2211e79f0099589b8b48c0",1],["148826aa16ffaa23dbc453b32cff05e025ddbce1773fc7733cc13d218926515a",2],["93c7363dfea7fb09ca1d23b72cad5df43a30841d41c8ff25fb544c85bb03c7ae",3],["7603aaeffa1989a649dfaa8e1804bed4481b49df233e377687d0669899566e52",4],["c117823cf6788e3247b9ee63a0c091c07352bbe352c650a7790dc6718148c2fa",5],["e4bcaca3a583bb0eb62a700a69d14e89c852f0c5bf740fca76e0519ebdfc9ab1",6],["7239b17057127936907a805b0caa5d8c6f6c97eca9bdabf1a5312dce479629b7",7],["99864b635d1891d22e17eb9267527a07a92c49c0f02893729fa2ded90e3ca0f9",8],["a5341fe706097cff2a3812a3fc0d87399254557328351ae8e5c882700fc1a196",9],["7d134c939df80c676a258266201beedd3b93572d5603f3ff4339ff8679803715",10],["2fe4bd46b0075cc25fc770ce50adbb68447cf493c999635bb272d231811dd264",11],["c20b4ee3cd517ca6cae7e43f047548757287fbd08ba81b97892a3ef520159a34",12],["88647ea04145fbbbb19b55f1590e038fb0378acb2571110f02cb545cc46b0d57",13],["2806030c503abb41a1a26fa9a570888be14296172bb273798ef0ad87a108a2ec",14],["4697ea67b18c3f49b30a3d8884602115536650bc5435c88e3732e64d21a72d33",15],["e5d084e06db4ab71196fea44efeceb23c8561266a78669c324a38f92581fe2db",16],["fb769ac2ea77e8f19a21a9dd3071742f2342bd49c41e4748d7e8c7903d4f0778",17]]);
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
  return value?.accountId === accountId && value.ownerUid === uid && value.itemId === item.id && value.catalogVersion === (item.kind ? SHOP_CATALOG_VERSION : 1) &&
    (!item.kind || value.kind === item.kind);
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

function eligibleAchievementCoins(entitlement) {
  if (entitlement?.serverIssued?.version !== SERVER_ACHIEVEMENT_VERSION) return [];
  return ACHIEVEMENT_COIN_SCHEDULE.filter(entry => {
    // An earned marker must never be purchasable, including in a future catalog expansion.
    if (!entry.markers.every(({slot,value}) => Array.isArray(entitlement[slot]) &&
        entitlement[slot].every(item => typeof item === 'string') && entitlement[slot].includes(value) &&
        !SHOP_CATALOG.some(item => item.grants.some(grant => grant.slot === slot && grant.value === value)))) return false;
    if (entry.evidence === 'typed-beta') {
      const beta = entitlement.serverIssued.beta;
      return beta?.id === 'beta-tester' && ['open-beta-release','release-migration','ranked-overall-snapshot','legacy-cosmetic-entitlement'].includes(beta.source) &&
        uint(beta.sourceRevision) && beta.sourceRevision > 0 && uint(beta.issuedAt) && beta.issuedAt > 0 && uint(beta.cutoffAt) &&
        (beta.source !== 'open-beta-release' || beta.cutoffAt > 0 && beta.issuedAt <= beta.cutoffAt);
    }
    if (entry.evidence === 'owner-stage') {
      const achievements = entitlement.serverIssued.achievements, owner = achievements?.beatOwner;
      const stage = BEAT_OWNER_STAGES.find(stage => stage.threshold === entry.threshold);
      if (!stage || achievements?.version !== SERVER_ACHIEVEMENT_VERSION || achievements.catalog !== SERVER_ACHIEVEMENT_CATALOG ||
          owner?.targetAccountId !== OWNER_PUBLIC_ID || !Array.isArray(owner.unlocks) || owner.unlocks.length > BEAT_OWNER_STAGES.length ||
          new Set(owner.unlocks.map(proof => proof?.id)).size !== owner.unlocks.length ||
          !owner.unlocks.every(proof => BEAT_OWNER_STAGES.some(known => proof?.id === known.id && proof.threshold === known.threshold && proof.cosmeticId === known.cosmeticId)) ||
          !Array.isArray(entitlement.serverIssued.cosmeticUnlocks) || !entitlement.serverIssued.cosmeticUnlocks.includes(stage.cosmeticId)) return false;
      try { milestoneEvidence({serverIssued:{achievements:{...achievements,casual:owner}}},entry.threshold); } catch { return false; }
      const allowedBits = new Set(COIN_OWNER_TRACK_BITS.values());
      for (let bit = 0; bit < SERVER_ACHIEVEMENT_RECOGNIZED_TRACK_COUNT; bit++)
        if ((Number.parseInt(owner.ledger.slice((bit >> 3) * 2, (bit >> 3) * 2 + 2),16) & (1 << (bit & 7))) && !allowedBits.has(bit)) return false;
      const proof = owner.unlocks.find(proof => proof.id === stage.id);
      return proof?.threshold === stage.threshold && proof.cosmeticId === stage.cosmeticId && proof.source === 'ranked-track-snapshot' &&
        COIN_OWNER_TRACK_BITS.has(proof.trackId) &&
        (Number.parseInt(owner.ledger.slice((COIN_OWNER_TRACK_BITS.get(proof.trackId) >> 3) * 2, (COIN_OWNER_TRACK_BITS.get(proof.trackId) >> 3) * 2 + 2),16) & (1 << (COIN_OWNER_TRACK_BITS.get(proof.trackId) & 7))) !== 0 && ['sourceRevision','sourceUpdatedAt','unlockedAt','playerTimeMs','targetTimeMs'].every(key => uint(proof[key]) && proof[key] > 0) &&
        proof.playerTimeMs <= proof.targetTimeMs && typeof proof.sourceSignature === 'string' && proof.sourceSignature.length >= 16 && proof.sourceSignature.length <= 128 && !/[^A-Za-z0-9_-]/.test(proof.sourceSignature);
    }
    return entry.evidence === 'earned-allowances';
  });
}
function checkedAchievementGrant(grant, accountId, uid) {
  if (!grant) return;
  demand(grant.accountId === accountId && grant.ownerUid === uid && grant.rewardId === 'achievements', 'grant_owner_changed', 409);
  demand(validAchievementCoinReceipt(grant), 'grant_invalid', 409);
}

export function createCurrencyService({store, now = Date.now, achievementCoinsEnabled = false, workshopStickersEnabled = false, includeWorkshopStickers = false, visibleWorkshopItems}) {
  demand(typeof store?.transaction === 'function' && typeof now === 'function', 'transaction_store_required', 503);
  demand(SHOP_CATALOG_VERSION === 2 && SHOP_CATALOG.length >= ORIGINAL_PROFILE_INVENTORY_IDS.length &&
    SHOP_CATALOG.length <= PROFILE_CATALOG_LIMIT && new Set(ALL_SHOP_ITEMS.map(item => item.id)).size === ALL_SHOP_ITEMS.length &&
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
      const item = ['purchase', 'equip'].includes(op) ? ALL_SHOP_ITEMS.find(value => value.id === itemId) : null;
      const legacyItem = ['purchase', 'equip'].includes(op) ? LEGACY_SHOP_CATALOG.find(value => value.id === itemId) : null;
      if (['purchase', 'equip'].includes(op)) demand(item || legacyItem, 'unknown_item');
      if (op === 'claim') demand(typeof rewardId === 'string' &&
        (Object.hasOwn(CURRENCY_REWARDS, rewardId) || rewardId === 'milestones' || rewardId === 'achievements'), 'unknown_reward');
      if (op === 'claim' && rewardId === 'achievements') demand(achievementCoinsEnabled === true, 'achievement_coins_disabled', 409);
      const receiptId = op === 'wallet' ? null : await hash([uid, accountId, requestId]);
      const fingerprint = JSON.stringify([op, accountId, rewardId ?? null, itemId ?? null,
        ...(op === 'purchase' && !legacyPurchase ? [catalogVersion, expectedPrice, expectedWalletRevision] : [])]);
      // New individual tier aliases share the aggregate; they never create per-tier documents.
      const grantRewardId = op === 'claim' && rewardId !== 'login' && rewardId !== 'achievements' && !LEGACY_MILESTONE_IDS.includes(rewardId)
        ? 'milestones' : rewardId;
      const grantId = op === 'claim' ? await hash([accountId, grantRewardId, rewardId === 'login' ? day : 'lifetime']) : null;
      const aggregateId = op === 'claim' && rewardId !== 'login' ? await hash([accountId, 'milestones', 'lifetime']) : null;
      const legacyGrants = rewardId === 'milestones' ? await Promise.all(LEGACY_MILESTONE_IDS.map(async id =>
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
          const ownedItemIds = (visibleWorkshopItems ?? (includeWorkshopStickers ? ALL_SHOP_ITEMS : SHOP_CATALOG)).filter(item => ownedIds.has(item.id)).map(item => item.id);
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
        if (op === 'equip') throw domainRejection(item?.kind === 'workshop-sticker' ? 'workshop_equip_local' : item ? 'profile_apply_via_studio' : 'item_retired', 409);
        if (op === 'purchase') {
          demand(item && !legacyPurchase, 'item_retired', 409);
          if (item.kind === 'workshop-sticker') demand(workshopStickersEnabled === true, 'workshop_stickers_disabled', 409);
          // Receipt identity wins over a now-stale quote on exact recovery retries.
          demand(catalogVersion === SHOP_CATALOG_VERSION && expectedPrice === item.price &&
            expectedWalletRevision === revision, 'quote_stale', 409);
        }
        let delta = 0, grant = null, inventory = null, evidence = null, claimedRewardIds = null;
        let purchasedEntitlement = null, nextMeta = null, aggregate = null, aggregateRewardIds = null;
        if (op === 'claim') {
          grant = await tx.get(path('grants', grantId));
          if (rewardId === 'achievements') checkedAchievementGrant(grant, accountId, uid);
          else checkedMilestoneGrant(grant, accountId, uid, grantRewardId);
          if (rewardId === 'achievements') {
            const entitlement = await tx.get(ENTITLEMENT_PATH + accountId);
            readPurchasedCosmetics(entitlement, {accountId, ownerUid: uid});
            const eligible = eligibleAchievementCoins(entitlement), claimed = new Set(grant?.claimedRewardIds || []);
            claimedRewardIds = eligible.filter(entry => !claimed.has(entry.id)).map(entry => entry.id);
            demand(claimedRewardIds.length > 0, eligible.length ? 'reward_already_claimed' : 'server_achievement_required', eligible.length ? 409 : 403);
            delta = ACHIEVEMENT_COIN_SCHEDULE.filter(entry => claimedRewardIds.includes(entry.id)).reduce((sum,entry) => sum + entry.amount,0);
            aggregateRewardIds = ACHIEVEMENT_COIN_SCHEDULE.filter(entry => claimed.has(entry.id) || claimedRewardIds.includes(entry.id)).map(entry => entry.id);
            evidence = {kind:'canonical-earned-entitlement', policyVersion:ACHIEVEMENT_COIN_POLICY_VERSION};
          } else if (rewardId === 'login') {
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
            aggregate = grantRewardId === 'milestones' ? grant : await tx.get(path('grants', aggregateId));
            checkedMilestoneGrant(aggregate, accountId, uid, 'milestones');
            const claimed = new Set(aggregate?.claimedRewardIds || []);
            if (grantRewardId === 'milestones') {
              for (const [id, key] of legacyGrants) {
                const old = await tx.get(path('grants', key)); checkedMilestoneGrant(old, accountId, uid, id);
                if (old) claimed.add(id);
              }
              const entitlement = await tx.get(ENTITLEMENT_PATH + accountId);
              milestoneEvidence(entitlement, rewardId === 'milestones' ? 1 : Number(rewardId.slice(7)));
              const count = entitlement.serverIssued.achievements.casual.count;
              claimedRewardIds = MILESTONE_IDS.filter(id => (rewardId === 'milestones' || id === rewardId) &&
                count >= Number(id.slice(7)) && !claimed.has(id));
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
          ...(rewardId === 'achievements' ? {policyVersion:ACHIEVEMENT_COIN_POLICY_VERSION} : {}),
          ...(item ? {itemId, itemKind: item.kind, catalogVersion: SHOP_CATALOG_VERSION} : {}),
          ...(op === 'claim' ? {alreadyClaimed: false} : {}), ...(op === 'purchase' ? {alreadyOwned: false} : {})};
        // All reads precede all writes, including canonical entitlement/cache CAS.
        await tx.set(path('wallet', accountId), {schema: CURRENCY_SCHEMA, accountId, ownerUid: uid,
          balance: nextBalance, revision: nextRevision, updatedAt: at,
          ...(knownEquipRevision === null ? {} : {equipRevision: knownEquipRevision})});
        if (op === 'claim') {
          const data = {accountId, ownerUid: uid, rewardId: grantRewardId, delta: aggregateRewardIds ?
            aggregateRewardIds.reduce((sum, id) => sum + (rewardId === 'achievements' ? ACHIEVEMENT_COIN_SCHEDULE.find(entry => entry.id === id).amount : CURRENCY_REWARDS[id]), 0) : delta, grantedAt: at, evidence,
            ...(rewardId === 'achievements' ? {policyVersion:ACHIEVEMENT_COIN_POLICY_VERSION} : {}),
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
    const workshopStickersEnabled = env.CURRENCY_WORKSHOP_STICKERS_ENABLED === 'true';
    const workshop = url.searchParams.getAll('workshop');
    const includeWorkshopStickers = workshop.length === 1 && workshop[0] === '1';
    const visibleWorkshopItems=compatibleWorkshopItems(request,workshopStickersEnabled&&includeWorkshopStickers);
    if (request.method === 'GET' && pathname === '/v1/shop/catalog') {
      return respond(200, {version: SHOP_CATALOG_VERSION, kind: 'profile-cosmetic',
        items: visibleWorkshopItems});
    }
    let command;
    if (request.method === 'GET' && pathname === '/v1/currency/wallet') {
      demand([...url.searchParams.keys()].every(key => key === 'accountId' || key === 'workshop') && url.searchParams.getAll('accountId').length === 1 &&
        (workshop.length === 0 || workshop.length === 1 && workshop[0] === '1'),
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
    const outcome = await createCurrencyService({store, now, achievementCoinsEnabled: env.CURRENCY_ACHIEVEMENTS_ENABLED === 'true',
      workshopStickersEnabled, includeWorkshopStickers, visibleWorkshopItems}).execute(uid, command);
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
