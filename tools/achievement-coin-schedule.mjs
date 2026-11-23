/** Immutable cosmetic-achievement coin policy. No I/O, storage, clock or awards.
 * One bonus per requirement, shared by title/style rows with the same condition.
 * This is additive to the existing recognized-track ledger rewards, not an alias.
 * UI eligibility hints are never inputs to the server's entitlement checks.
 */
export const ACHIEVEMENT_COIN_POLICY_VERSION = 1;
export const ACHIEVEMENT_COIN_CLAIM_ID = 'achievements';
const row = (id, metric, threshold, amount, journalIds, markers, evidence = 'earned-allowances') => Object.freeze({
  id, metric, threshold, amount, supported: true, claimRewardId: ACHIEVEMENT_COIN_CLAIM_ID, evidence,
  journalIds: Object.freeze(journalIds), markers: Object.freeze(markers.map(([slot,value]) => Object.freeze({slot,value})))
});
export const ACHIEVEMENT_COIN_SCHEDULE = Object.freeze([
  row('achievement-ranked-1','raceCount',1,2,['style:1'],[['theme','ocean'],['accent','lime']]),
  row('achievement-ranked-3','raceCount',3,4,['style:3'],[['theme','ice'],['finish','split']]),
  row('achievement-ranked-5','raceCount',5,6,['style:5','titles:5'],[['theme','sunset'],['finish','gloss']]),
  row('achievement-ranked-8','raceCount',8,8,['style:8','titles:8'],[['theme','forest'],['finish','carbon']]),
  row('achievement-ranked-12','raceCount',12,12,['style:12'],[['theme','ember'],['stripe','scan']]),
  row('achievement-ranked-16','raceCount',16,20,['style:16'],[['theme','crimson'],['emblem3','wings']]),
  row('achievement-extra-1','extraCount',1,8,['discovery:extra:1'],[['stage','storm'],['stripe','circuit']]),
  row('achievement-extra-3','extraCount',3,16,['discovery:extra:3'],[['stage','aurora'],['stripe','blocks']]),
  row('achievement-wins-1','trackWins',1,12,['style:wins:1'],[['emblem2','crown'],['emblemBackdrop','hex']]),
  row('achievement-wins-5','trackWins',5,24,['style:wins:5'],[['nameColor','sunset'],['baseSecondary','ice']]),
  row('achievement-podium','podium',1,30,['style:podium','titles:podium'],[['theme','podium'],['stage','podium']]),
  row('achievement-beta','beta',1,20,['style:beta','titles:beta'],[['theme','beta'],['badge','betaTester']],'typed-beta'),
  row('achievement-owner-1','unlock',1,20,['style:unlock:emblem:target'],[['emblem','target']],'owner-stage'),
  row('achievement-owner-3','unlock',3,40,['style:unlock:stripe:overdrive'],[['stripe','overdrive']],'owner-stage')
]);
export const UNSUPPORTED_ACHIEVEMENT_COINS = Object.freeze([
  {metric:'pbCount',thresholds:[10,25,50],reason:'PB counters are client-originated; cosmetic eligibility is not a verified PB-improvement ledger.'},
  {metric:'totalPlaytimeMs',thresholds:[3600000,18000000],reason:'Playtime is client-reported, not currency-grade elapsed-time evidence.'},
  {metric:'device-and-event-lanes',thresholds:[],reason:'Practice, active-day, visit and event participation observations lack a canonical deduplicated award ledger.'},
  {metric:'lost-historical-eligibility',thresholds:[],reason:'Former standings or revoked allowances absent from current canonical evidence cannot be reconstructed here.'}
].map(value=>Object.freeze({...value,thresholds:Object.freeze(value.thresholds)})));
export function achievementCoinForJournalId(id) {
  return ACHIEVEMENT_COIN_SCHEDULE.find(entry=>entry.journalIds.includes(id)) ?? null;
}
export function validAchievementCoinReceipt(value) {
  const ids=value?.claimedRewardIds;
  return value?.policyVersion===ACHIEVEMENT_COIN_POLICY_VERSION && Array.isArray(ids) && ids.length>0 &&
    ids.length<=ACHIEVEMENT_COIN_SCHEDULE.length && new Set(ids).size===ids.length &&
    ids.every(id=>typeof id==='string'&&ACHIEVEMENT_COIN_SCHEDULE.some(entry=>entry.id===id)) &&
    Number.isSafeInteger(value.delta) && value.delta>0 &&
    ids.reduce((sum,id)=>sum+ACHIEVEMENT_COIN_SCHEDULE.find(entry=>entry.id===id).amount,0)===value.delta;
}

// Permanent reward IDs: new tiers must be additive and old amounts unchanged.
export const STYLE_COIN_MILESTONES=Object.freeze([[1,20],[5,30],[20,50],[24,6],[30,10],[35,30],[42,12],[46,14],[50,40],[60,16],[65,20],[70,50],[75,24],[85,30],[89,60]].map(([threshold,amount])=>Object.freeze({rewardId:"tracks-"+threshold,threshold,amount})));
