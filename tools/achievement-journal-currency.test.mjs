import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {STYLE_COIN_MILESTONES,buildStyleCoinAchievements} from './achievement-journal-currency.mjs';
import {CURRENCY_MILESTONES,CURRENCY_REWARDS} from '../workers/ranked/src/currency-wallet.js';
test('pure browser Style Coin tiers exactly match the wallet constants',async()=>{
 assert.deepEqual(STYLE_COIN_MILESTONES,CURRENCY_MILESTONES);
 assert.deepEqual(STYLE_COIN_MILESTONES.map(x=>[x.threshold,x.amount]),[[1,20],[5,30],[20,50],[24,6],[30,10],[35,30],[42,12],[46,14],[50,40],[60,16],[65,20],[70,50],[75,24],[85,30],[89,60]]);
 for(const tier of STYLE_COIN_MILESTONES){assert.equal(tier.amount,CURRENCY_REWARDS[tier.rewardId]);assert(Object.isFrozen(tier));}
 assert(Object.isFrozen(STYLE_COIN_MILESTONES));
 const source=await fs.readFile(new URL('./achievement-journal-currency.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(source,/fetch\s*\(|localStorage|indexedDB|firebase|balance\s*=/);
});
test('coin eligibility never becomes claimed, earned, or a local award',()=>{
 for(const confirmed of [{},{raceCount:89},{casualCompletionCount:'89'},{casualCompletionCount:-1},{casualCompletionCount:90},{casualCompletionCount:2.5}]){
  const rows=buildStyleCoinAchievements(confirmed);assert.equal(rows.length,15);assert.ok(rows.every(x=>x.value===null&&!x.earned&&!x.eligible));
 }
 const input={casualCompletionCount:20,claimedRewardIds:['tracks-1','tracks-5','tracks-20']},before=JSON.stringify(input),rows=buildStyleCoinAchievements(input);
 assert.deepEqual(rows.filter(x=>x.eligible).map(x=>x.reward.rewardId),['tracks-1','tracks-5','tracks-20']);
 assert.ok(rows.every(x=>!x.earned&&x.source==='currency'));assert.equal(JSON.stringify(input),before);
});
