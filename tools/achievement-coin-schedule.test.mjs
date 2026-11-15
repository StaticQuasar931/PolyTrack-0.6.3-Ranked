import test from 'node:test';
import assert from 'node:assert/strict';
import {ACHIEVEMENT_COIN_POLICY_VERSION as version, ACHIEVEMENT_COIN_SCHEDULE as schedule,
  UNSUPPORTED_ACHIEVEMENT_COINS, achievementCoinForJournalId, validAchievementCoinReceipt as valid} from './achievement-coin-schedule.mjs';
import {PROFILE_SHOP_CATALOG} from './profile-shop-catalog.mjs';

test('bounded immutable14-condition schedule is222 extra coins, additive not duplicate recognized-track keys',()=>{
 assert.equal(version,1);assert.equal(schedule.length,14);assert.equal(new Set(schedule.map(row=>row.id)).size,14);
 assert.equal(schedule.reduce((sum,row)=>sum+row.amount,0),222);
 assert.ok(Object.isFrozen(schedule)&&schedule.every(row=>Object.isFrozen(row)&&Object.isFrozen(row.markers)&&row.markers.every(Object.isFrozen)));
 assert.ok(schedule.every(row=>row.id.startsWith('achievement-')&&row.claimRewardId==='achievements'));
 for(const row of schedule)for(const marker of row.markers)assert.equal(PROFILE_SHOP_CATALOG.some(item=>item.grants.some(grant=>grant.slot===marker.slot&&grant.value===marker.value)),false);
});

test('title/style conditions share one key and unsupported self-reported counters have no award',()=>{
 assert.equal(achievementCoinForJournalId('style:5'),achievementCoinForJournalId('titles:5'));
 assert.equal(achievementCoinForJournalId('style:podium'),achievementCoinForJournalId('titles:podium'));
 assert.equal(achievementCoinForJournalId('style:beta'),achievementCoinForJournalId('titles:beta'));
 assert.equal(achievementCoinForJournalId('style:pb:10'),null);
 assert.equal(achievementCoinForJournalId('style:playtime:3600000'),null);
 assert.ok(UNSUPPORTED_ACHIEVEMENT_COINS.some(row=>row.metric==='pbCount'));
 assert.ok(UNSUPPORTED_ACHIEVEMENT_COINS.some(row=>row.metric==='lost-historical-eligibility'));
});

test('pure receipt validation accepts immutable sums only, not unknown IDs or legacy reward keys',()=>{
 for(const rows of [schedule,...schedule.map(row=>[row]),schedule.filter((_,i)=>i%2===0)]){
  const receipt={policyVersion:version,claimedRewardIds:rows.map(row=>row.id),delta:rows.reduce((sum,row)=>sum+row.amount,0)};
  assert.equal(valid(receipt),true);assert.equal(valid({...receipt,delta:receipt.delta+1}),false);
 }
 for(const receipt of [null,{}, {policyVersion:2,claimedRewardIds:[schedule[0].id],delta:2},
  {policyVersion:1,claimedRewardIds:['tracks-1'],delta:20},{policyVersion:1,claimedRewardIds:[{},schedule[0].id],delta:2},
  {policyVersion:1,claimedRewardIds:[schedule[0].id,schedule[0].id],delta:4},
  {policyVersion:1,claimedRewardIds:[],delta:0}])assert.equal(valid(receipt),false);
});

test('deployment configuration retains the reviewed achievement feature without changing currency policy',async()=>{const fs=await import('node:fs/promises');const config=JSON.parse(await fs.readFile(new URL('../workers/ranked/wrangler.jsonc',import.meta.url),'utf8'));assert.equal(config.vars.CURRENCY_ACHIEVEMENTS_ENABLED,'true');assert.equal(config.vars.CURRENCY_RULES_VERSION,'currency-server-only-v1');assert.equal(config.vars.PUBLIC_FIRESTORE_READ_MODE,'capture-only');});
