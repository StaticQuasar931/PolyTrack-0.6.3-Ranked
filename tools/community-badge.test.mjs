import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeCommunityCode,normalizeCommunityInvite,validateCommunityBadgeResponse} from './community-badge.mjs';
const accountId='a'.repeat(64),valid={version:1,accepted:true,accountId,badgeId:'community',source:'relay-code',membershipVerified:false,alreadyClaimed:false};
test('relay code is exactly sixteen uppercase Base32 characters; old export is an alias',()=>{
  assert.equal(normalizeCommunityInvite,normalizeCommunityCode);
  for(const value of ['ABCDEFGHIJKLMNOP',' ABCDEFGHIJKLMNOP ','ABCDEFGH234567AB'])assert.equal(normalizeCommunityCode(value),value.trim());
  for(const value of ['',null,{},'A'.repeat(15),'A'.repeat(17),'A'.repeat(193),'abcdefghijklmnop','ABCDEFGHIJKLMNO0','ABCDEFGHIJKLMNO1','ABCDEFGHIJKLMNO8','ABCDEFGHIJKLMNO9','ABCDEFGH IJKLMNO','https://discord.gg/fixtureInvite','discord.gg/fixtureInvite','https://discord.com/invite/fixtureInvite','https://evil.test/code','javascript:alert(1)'])assert.equal(normalizeCommunityCode(value),null);
});

test('only exact honest same-account community claim schema is accepted',()=>{
  assert.deepEqual(validateCommunityBadgeResponse(valid,accountId),valid);assert.ok(Object.isFrozen(validateCommunityBadgeResponse(valid,accountId)));
  assert.equal(validateCommunityBadgeResponse({...valid,alreadyClaimed:true},accountId).alreadyClaimed,true);
  for(const change of [{version:2},{accepted:false},{accountId:'b'.repeat(64)},{badgeId:'betaTester'},{source:'membership'},{source:'invite-code'},{membershipVerified:true},{alreadyClaimed:1},{alreadyClaimed:undefined},{balance:8},{owned:true}])assert.equal(validateCommunityBadgeResponse({...valid,...change},accountId),null);
  for(const key of Object.keys(valid)){const copy={...valid};delete copy[key];assert.equal(validateCommunityBadgeResponse(copy,accountId),null);}
});
