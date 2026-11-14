import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeCommunityInvite,validateCommunityBadgeResponse} from './community-badge.mjs';
const accountId='a'.repeat(64),valid={version:1,accepted:true,accountId,badgeId:'community',source:'invite-code',membershipVerified:false,alreadyClaimed:false};
test('community invite normalization is local, bounded and restricted to Discord invite hosts',()=>{
  for(const value of ['jW2az4AQUH',' https://discord.gg/jW2az4AQUH ','discord.gg/jW2az4AQUH','https://discord.com/invite/jW2az4AQUH?utm_source=test'])assert.equal(normalizeCommunityInvite(value),'jW2az4AQUH');
  for(const value of ['',null,{},'x'.repeat(257),'https://evil.test/jW2az4AQUH','https://discord.gg.evil.test/jW2az4AQUH','https://user@discord.gg/jW2az4AQUH','javascript:alert(1)','https://discord.gg/code/extra','https://discord.gg:4433/code'])assert.equal(normalizeCommunityInvite(value),null);
});
test('only exact honest same-account community claim schema is accepted',()=>{
  assert.deepEqual(validateCommunityBadgeResponse(valid,accountId),valid);assert.ok(Object.isFrozen(validateCommunityBadgeResponse(valid,accountId)));
  assert.equal(validateCommunityBadgeResponse({...valid,alreadyClaimed:true},accountId).alreadyClaimed,true);
  for(const change of [{version:2},{accepted:false},{accountId:'b'.repeat(64)},{badgeId:'betaTester'},{source:'membership'},{membershipVerified:true},{alreadyClaimed:1},{alreadyClaimed:undefined},{balance:8},{owned:true}])assert.equal(validateCommunityBadgeResponse({...valid,...change},accountId),null);
  for(const key of Object.keys(valid)){const copy={...valid};delete copy[key];assert.equal(validateCommunityBadgeResponse(copy,accountId),null);}
});
