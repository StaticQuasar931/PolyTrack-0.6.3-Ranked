import {readCommunityClaim, projectCommunityClaim, COMMUNITY_CAMPAIGN} from './community-badge.js';
import {PROFILE_SHOP_CATALOG, PROFILE_SHOP_CATALOG_VERSION} from '../../../tools/profile-shop-catalog.mjs';

export const SHOP_PROFILE_CATALOG = PROFILE_SHOP_CATALOG;
const plain = value => value !== null && typeof value === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const account = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const owner = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
const timestamp = value => Number.isSafeInteger(value) && value > 0;
const fail = () => { throw Error('PURCHASED_COSMETIC_ENTITLEMENT_INVALID'); };
const requireValid = value => { if (!value) fail(); };
const exactKeys = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => owns(value, key));
const copy = value => structuredClone(value);
const starter = Object.freeze({theme: ['classic', 'cyan'], accent: ['cyan', 'white'], finish: ['gradient', 'solid'],
  plate: ['block', 'outline'], edge: ['accent', 'none'], stage: ['garage', 'slate'], stageTint: ['natural', 'blue'],
  stripe: ['standard', 'cyan'], emblem: ['none', 'bolt'], emblem2: ['none'], emblem3: ['none'],
  emblemBackdrop: ['none'], stageEffect: ['none'], nameFont: ['classic'], nameSize: ['normal'],
  nameWeight: ['regular'], nameColor: ['default'], baseSecondary: ['auto'], title: ['auto'], badge: ['auto', 'none']});

function itemFor(id) {
  const item = PROFILE_SHOP_CATALOG.find(item => item.id === id);
  requireValid(item && item.kind === 'profile-cosmetic' && item.grants.length === 1 &&
    ['plate', 'stage', 'stripe'].includes(item.grants[0].slot));
  return item;
}

// Only server-owned canonical entitlement documents may supply this provenance.
// Unknown/foreign records stop the operation instead of silently losing purchases.
export function readPurchasedCosmetics(prior, {accountId, ownerUid} = {}) {
  if (prior == null || plain(prior) && !owns(prior, 'purchased')) return null;
  requireValid(plain(prior));
  const value = prior.purchased;
  requireValid(exactKeys(value, ['version', 'accountId', 'ownerUid', 'items']) && value.version === 1 &&
    account(accountId) && value.accountId === accountId && owner(value.ownerUid) &&
    (ownerUid === undefined || owner(ownerUid) && value.ownerUid === ownerUid) && plain(value.items) &&
    Object.keys(value.items).length > 0 && Object.keys(value.items).length <= PROFILE_SHOP_CATALOG.length);
  for (const [id, record] of Object.entries(value.items)) {
    itemFor(id);
    requireValid(exactKeys(record, ['catalogVersion', 'acquiredAt']) &&
      record.catalogVersion === PROFILE_SHOP_CATALOG_VERSION && timestamp(record.acquiredAt));
  }
  return copy(value);
}

function projectPurchased(earned, purchased) {
  requireValid(plain(earned));
  const result = copy(earned);
  if (!purchased) return result;
  for (const id of Object.keys(purchased.items).sort()) {
    for (const {slot, value} of itemFor(id).grants) {
      requireValid(result[slot] === undefined || Array.isArray(result[slot]) &&
        result[slot].every(value => typeof value === 'string'));
      result[slot] = [...new Set([...(result[slot] || []), value])];
    }
  }
  result.purchased = copy(purchased);
  return result;
}

export function mergeEarnedAndPurchasedEntitlements(earned, prior, binding = {}) {
  // Never retain stale prior arrays or achievements as earned authority.
  return projectCommunityClaim(projectPurchased(earned, readPurchasedCosmetics(prior, binding)),
    readCommunityClaim(prior, binding));
}

export function addPurchase(prior, itemId, acquiredAt, {accountId, ownerUid} = {}) {
  requireValid(account(accountId) && owner(ownerUid) && timestamp(acquiredAt) &&
    (prior == null || plain(prior)));
  itemFor(itemId);
  const purchased = readPurchasedCosmetics(prior, {accountId, ownerUid}) ||
    {version: 1, accountId, ownerUid, items: {}};
  if (!owns(purchased.items, itemId)) purchased.items[itemId] =
    {catalogVersion: PROFILE_SHOP_CATALOG_VERSION, acquiredAt};
  return projectCommunityClaim(projectPurchased(prior || starter, purchased),
    readCommunityClaim(prior, {accountId, ownerUid}));
}

export function mergePurchasedEntitlement(prior, {accountId, ownerUid, item, acquiredAt} = {}) {
  return addPurchase(prior, typeof item === 'string' ? item : item?.id, acquiredAt, {accountId, ownerUid});
}

// Pass the worker's normalized design and freshly computed earned allowance.
// A purchase cannot mask a locked unrelated field or grant any server achievement.
export function purchasedProfileCosmeticsUnlocked(cosmetics, earned, prior, binding = {}) {
  requireValid(plain(cosmetics) && plain(earned));
  const allowance = mergeEarnedAndPurchasedEntitlements(earned, prior, binding);
  for (const slot of Object.keys(starter)) {
    if (!owns(cosmetics, slot)) continue;
    if (!Array.isArray(allowance[slot]) || !allowance[slot].includes(cosmetics[slot])) return false;
  }
  return true;
}


export function addCommunityBadge(prior, claimedAt, {accountId, ownerUid} = {}) {
  requireValid(account(accountId) && owner(ownerUid) && timestamp(claimedAt) && (prior == null || plain(prior)));
  const binding = {accountId, ownerUid};
  const community = readCommunityClaim(prior, binding) || {version: 1, accountId, ownerUid,
    campaign: COMMUNITY_CAMPAIGN, badgeId: 'community', source: 'invite-code', membershipVerified: false, claimedAt};
  return projectCommunityClaim(projectPurchased(prior || starter, readPurchasedCosmetics(prior, binding)), community);
}
