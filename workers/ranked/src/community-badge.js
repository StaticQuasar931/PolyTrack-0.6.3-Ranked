import {invalidateEntitlements, ENTITLEMENT_COLLECTION} from './overall-entitlement-cache.js';

export const COMMUNITY_CAMPAIGN = 'discord-invite-jW2az4AQUH-v1';
const INVITES = new Set(['jW2az4AQUH', 'https://discord.gg/jW2az4AQUH']);
const plain = value => value !== null && typeof value === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const own = (value, key) => Object.hasOwn(value, key);
const account = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const owner = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
const atValid = value => Number.isSafeInteger(value) && value > 0;
const invalid = () => {throw Error('COMMUNITY_ENTITLEMENT_INVALID');};
export class CommunityBadgeError extends Error {
  constructor(code, httpStatus = 400) {super(code); this.httpStatus = httpStatus;}
}
export function readCommunityClaim(prior, {accountId, ownerUid} = {}) {
  if (prior == null || plain(prior) && !own(prior, 'community')) return null;
  if (!plain(prior)) invalid();
  const claim = prior.community;
  const keys = ['version', 'accountId', 'ownerUid', 'campaign', 'badgeId', 'source', 'membershipVerified', 'claimedAt'];
  if (!plain(claim) || Object.keys(claim).length !== keys.length || !keys.every(key => own(claim, key)) ||
      claim.version !== 1 || !account(accountId) || claim.accountId !== accountId || !owner(claim.ownerUid) ||
      ownerUid !== undefined && (!owner(ownerUid) || claim.ownerUid !== ownerUid) ||
      claim.campaign !== COMMUNITY_CAMPAIGN || claim.badgeId !== 'community' || claim.source !== 'invite-code' ||
      claim.membershipVerified !== false || !atValid(claim.claimedAt)) invalid();
  return structuredClone(claim);
}
export function projectCommunityClaim(allowance, claim) {
  if (!plain(allowance)) invalid();
  const next = structuredClone(allowance);
  if (!claim) return next;
  if (next.badge !== undefined && (!Array.isArray(next.badge) || !next.badge.every(value => typeof value === 'string'))) invalid();
  next.badge = [...new Set([...(next.badge || []), 'community'])];
  next.community = structuredClone(claim);
  return next;
}
export function createCommunityBadgeService({store, grantEntitlement, now = Date.now}) {
  if (typeof store?.transaction !== 'function' || typeof grantEntitlement !== 'function' || typeof now !== 'function')
    throw Error('Invalid Community dependencies');
  return Object.freeze({async claim(uid, body) {
    if (!plain(body) || Object.keys(body).length !== 2 || !own(body, 'accountId') || !own(body, 'inviteCode') ||
        !account(body.accountId)) throw new CommunityBadgeError('invalid_request');
    if (typeof body.inviteCode !== 'string' || !INVITES.has(body.inviteCode)) throw new CommunityBadgeError('invalid_invite_code');
    if (!owner(uid)) throw new CommunityBadgeError('authentication_required', 401);
    const {accountId} = body;
    return store.transaction(async tx => {
      const profile = await tx.get('0.6.2_profiles_public/' + accountId);
      if (profile?.accountId !== accountId || profile.ownerUid !== uid) throw new CommunityBadgeError('profile_not_owned', 403);
      const entitlementPath = ENTITLEMENT_COLLECTION + '/' + accountId;
      const prior = await tx.get(entitlementPath);
      const existing = readCommunityClaim(prior, {accountId, ownerUid: uid});
      const result = {version: 1, accepted: true, accountId, badgeId: 'community', source: 'invite-code',
        membershipVerified: false, alreadyClaimed: existing !== null};
      if (existing) {
        if (!Array.isArray(prior.badge) || !prior.badge.every(value => typeof value === 'string') || !prior.badge.includes('community'))
          throw new CommunityBadgeError('community_entitlement_inconsistent', 503);
        return result;
      }
      const claimedAt = now(); if (!atValid(claimedAt)) throw Error('Invalid Community server clock');
      const entitlement = grantEntitlement(prior, claimedAt, {accountId, ownerUid: uid});
      const metaPath = '0.6.2_s1_release_meta/current';
      const meta = await tx.get(metaPath);
      const nextMeta = invalidateEntitlements(meta || {}, [accountId]);
      await tx.set(entitlementPath, entitlement);
      await tx.set(metaPath, nextMeta);
      return result;
    });
  }});
}
