/** Pure, presentation-only achievement lanes. No imports, storage, wallet or awards.
 * buildAchievementGoals({confirmed,local,cosmetics}) returns fresh lane objects.
 * confirmed: current authoritative profile counters supplied by the parent.
 * local: exact, account-scoped device counters, never merged with confirmed.
 * Cosmetics are intentionally not interpreted: the existing catalog remains the
 * sole cosmetic unlock policy. This module cannot unlock or claim anything.
 *
 * Additional counters are OPTIONAL. Missing/invalid means unknown, not zero:
 * dailyCompletions: distinct daily periods completed; activeDays: distinct days
 * containing a completed run (not consecutive, using one consistent day boundary);
 * eventParticipations: distinct event periods entered, not clicks/replay opens;
 * eventFormats: distinct supported event kinds; practiceFinishes: completed runs;
 * practiceTracks: distinct tracks finished; pbImprovements: strictly faster PBs;
 * improvedTracks: distinct tracks improved; pbTimeSavedMs: sum of exact, same-track
 * improvement deltas in milliseconds. Retries, imports and aliases are not new PBs.
 * Existing pbCount, raceCount, extraCount, verifiedTracks and trackWins retain
 * their supplied meanings. Never infer these from history length or playtime.
 * The parent must establish counter scope/completeness before supplying a number.
 * This builder does not validate replay proof or establish server authority.
 */
const POINTS = Object.freeze([2,4,6,8,12,20]);

/** Alternative lifetime proposal, NOT additive to earlier shop milestones.
 * Reference-only shop scale: 20/80/240, recurring daily proposal cap 40.
 * Any future award needs a server-owned idempotent tier receipt AND cross-route
 * source deduplication. A local milestone is not a currency entitlement.
 */
export const ACHIEVEMENT_REWARD_PROPOSAL = Object.freeze({
  version:1,status:'proposal-only',claimable:false,spendable:false,
  tierAmounts:POINTS,
  referencePrices:Object.freeze({first:20,common:80,rare:240}),
  referenceRecurringDailyCap:40,
  application:'alternative-not-additive',
  receiptRule:'One lifetime receipt per tier plus source-bound cross-route deduplication.'
});

const LANES = [
  ['daily-completions','daily','Daily finishes','Complete distinct daily periods. Repeating the same period does not add another completion.','dailyCompletions',[1,3,7,14,30,60],'daily'],
  ['active-days','daily','Race days, not streaks','Complete a run on distinct days. Days need not be consecutive; missing a day never resets progress.','activeDays',[1,3,7,15,30,90],'daily'],
  ['event-participation','events','Join the field','Participate in distinct event periods. Reopening results, selecting ghosts and repeated entries do not add participations.','eventParticipations',[1,3,5,10,25,50],'events'],
  ['event-variety','events','Try different events','Participate in distinct supported event formats. Separate periods of the same format count only once here.','eventFormats',[1,2,3],'events'],
  ['practice-finishes','practice','Finish your practice runs','Complete practice runs. Starts, abandoned attempts, imports and replay watches are not finishes.','practiceFinishes',[1,10,25,100,250,1000],'practice'],
  ['practice-variety','practice','Practice beyond one track','Finish practice runs on distinct tracks. Repeated laps still count as one track here.','practiceTracks',[1,3,10,25,50,100],'practice'],
  ['personal-bests','practice','Personal bests','Build your recorded PB milestones using the supplied PB counter. This does not imply replay verification.','pbCount',[1,5,10,25,50,100],'practice'],
  ['pb-improvements','practice','Find a faster line','Set strictly faster personal bests. Identical times, retry aliases and reimported recordings do not count as improvements.','pbImprovements',[1,3,10,25,50,100],'practice'],
  ['improved-tracks','practice','Improve your range','Improve personal bests on distinct tracks. Many improvements on one track count as one track here.','improvedTracks',[1,3,5,10,25,50],'practice'],
  ['time-saved','practice','Win back time','Accumulate exact same-track PB improvement deltas in milliseconds, not replay frames, session duration or estimated gains.','pbTimeSavedMs',[100,500,1000,3000,10000,30000],'practice'],
  ['extra-finishes','discovery','Explore ranked Extras','Finish distinct ranked Extra tracks. Browsing, favorites, unranked imports and duplicate saved runs do not increase this counter.','extraCount',[1,3,5,10,25,50],'discovery'],
  ['ranked-track-collection','discovery','Build your ranked collection','Complete distinct ranked tracks represented by the supplied raceCount metric. Repeat finishes do not expand the collection.','raceCount',[1,3,5,8,12,16],'practice'],
  ['verified-tracks','practice','Proven finishes','Progress from the supplied verified-track counter. A device milestone is not new verification or an event award.','verifiedTracks',[1,3,5,10,25,50],'practice'],
  ['verified-first-places','practice','Lead the board','Hold verified first places represented by trackWins. These are normal leaderboard positions, not event wins or event RP.','trackWins',[1,2,3,5,8,12],'practice']
];

function exactCounter(input,key) {
  if(!input || typeof input!=='object' || Array.isArray(input)) return null;
  const descriptor=Object.getOwnPropertyDescriptor(input,key);
  const value=descriptor && Object.hasOwn(descriptor,'value') ? descriptor.value : null;
  return typeof value==='number' && Number.isSafeInteger(value) && value>=0 ? (value===0?0:value) : null;
}

/** UI contract: unknown lanes stay navigable; tier status is progress, not money.
 * value chooses a known confirmed counter first, including zero; localValue is
 * separate and is never added or substituted into a known confirmed value.
 * Tier status 'device' means reached only on this device, NOT upload pending.
 * rewardPoints is always a proposal; no earned-points total or wallet is exposed.
 */
export function buildAchievementGoals({confirmed={},local={}}={}) {
  return LANES.map(([slug,family,title,description,metric,targets,navigate])=>{
    const id='achievement:v1:'+slug;
    const confirmedValue=exactCounter(confirmed,metric),localValue=exactCounter(local,metric);
    const value=confirmedValue ?? localValue;
    const source=confirmedValue!==null?'confirmed':localValue!==null?'device':'unknown';
    const tiers=targets.map((target,index)=>{
      const status=confirmedValue!==null && confirmedValue>=target?'confirmed':
        localValue!==null && localValue>=target?'device':value===null?'unknown':'in-progress';
      const tierId=id+':'+target;
      return {id:tierId,target,rewardPoints:POINTS[index],
        difficulty:index<Math.ceil(targets.length/2)?'casual':'advanced',status,
        rewardKey:tierId,rewardStatus:'proposal-only',claimable:false};
    });
    return {id,family,title,description,metric,unit:metric==='pbTimeSavedMs'?'milliseconds':'count',
      tiers,value,confirmedValue,localValue,source,navigate,rewardStatus:'proposal-only',claimable:false,
      nextTierId:tiers.find(tier=>tier.status==='unknown'||tier.status==='in-progress')?.id ?? null};
  });
}
/** Aggregate only an explicit account-scoped practiceHistory.list(accountId).
 * Totals cover retained device observations, not a complete lifetime/account log.
 * Duplicate identical tracks count once; conflicting duplicates fail closed.
 * pbs includes a possible initial PB. With gains > 0, pbs===1 is exactly one
 * improvement; larger pbs values are ambiguous without an initial-PB marker.
 * No recent-finish dates, daily/event counts, identities or track IDs are returned.
 */
export function aggregateAchievementPractice(rows) {
  const empty=()=>({practiceFinishes:null,practiceTracks:null,pbCount:null,pbImprovements:null,improvedTracks:null,pbTimeSavedMs:null});
  if(!Array.isArray(rows))return empty();
  const tracks=new Map();
  for(const row of rows){
    if(!row||typeof row!=='object'||Array.isArray(row))return empty();
    const track=Object.getOwnPropertyDescriptor(row,'trackId')?.value;
    if(typeof track!=='string'||!/^[a-f0-9]{64}$/.test(track))return empty();
    const values=[exactCounter(row,'finishes'),exactCounter(row,'pbs'),exactCounter(row,'improvedMs')];
    if(tracks.has(track)){
      if(values.some((value,index)=>value!==tracks.get(track)[index]))return empty();
    }else tracks.set(track,values);
  }
  const result={practiceFinishes:0,practiceTracks:0,pbCount:0,pbImprovements:0,improvedTracks:0,pbTimeSavedMs:0};
  const add=(key,value)=>{result[key]=result[key]===null||value===null||!Number.isSafeInteger(result[key]+value)?null:result[key]+value;};
  for(const [finishes,pbs,gain] of tracks.values()){
    add('practiceFinishes',finishes);add('practiceTracks',finishes===null?null:Number(finishes>0));
    const consistentPbs=pbs!==null&&(finishes===null||pbs<=finishes)?pbs:null;
    add('pbCount',consistentPbs);
    const consistentGain=gain!==null&&!(gain>0&&(finishes===0||pbs===0))?gain:null;
    add('improvedTracks',consistentGain===null?null:Number(consistentGain>0));add('pbTimeSavedMs',consistentGain);
    add('pbImprovements',consistentPbs===null||consistentGain===null?null:consistentGain===0||consistentPbs===0?0:consistentPbs===1?1:null);
  }
  return result;
}
