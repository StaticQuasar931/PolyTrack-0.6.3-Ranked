const {workshopStickerOffer}=await import(new URL('./workshop-sticker-shop-catalog.mjs'+new URL(import.meta.url).search,import.meta.url).href);

const {OWNER_CHALLENGE_WORKSHOP_REWARDS,confirmedOwnerChallengeCount}=await import(new URL('./achievement-recommendations.mjs'+new URL(import.meta.url).search,import.meta.url).href);

/** Local visual eligibility from owner-scoped Shop UI state or published earned progress. */
export function createCarEquipPolicy({getAccountId,getPublishedProfile,getPublishedRank,isFree,ownsForUi}={}){
 if([getAccountId,getPublishedProfile,isFree].some(fn=>typeof fn!=='function'))throw TypeError('Car policy adapters required');
 const profile=id=>{if(!/^[a-f0-9]{64}$/.test(id||'')||id!==getAccountId())return null;const row=getPublishedProfile(id);return !row||row.localOnly===true||row.localPending===true||row.local===true||row.localEstimateOrigin||(row.userId??row.accountId)!==id||row.accountId!==undefined&&row.accountId!==id?null:row;};
 const tier=row=>['gold','silver','bronze'].every(k=>Number.isSafeInteger(row?.medals?.[k])&&row.medals[k]>=0)?['gold','silver','bronze'].find(k=>row.medals[k]>0)||null:null;
 const equip=choice=>{
  if(!choice||!/^[a-f0-9]{64}$/.test(choice.accountId||'')||choice.accountId!==getAccountId())return false;
  const offer=workshopStickerOffer(choice);
  if(offer)return ownsForUi?.(choice.accountId,offer.grants[0].slot+':'+choice.id)===true;
  const reflector=(choice.category==='front'||choice.category==='rear')&&choice.id==='rearbar';
  const podium=choice.category==='emblem'&&choice.id==='crest'||choice.category==='accessory'&&choice.id==='crown'||choice.category==='sticker'&&choice.id==='laurel';
  const ownerReward=OWNER_CHALLENGE_WORKSHOP_REWARDS.find(item=>item.category===choice.category&&item.id===choice.id);
  if(!reflector&&!podium&&!ownerReward&&isFree(choice)===true)return true;
  const row=profile(choice.accountId);if(!row)return false;
  if(ownerReward)return (confirmedOwnerChallengeCount(row)??0)>=ownerReward.target;
  if(reflector)return Number.isSafeInteger(row.raceCount)&&row.raceCount>=5;
  if(podium)return tier(row)!==null;
  return false;
 };
 equip.podiumTier=id=>tier(profile(id));
 equip.overallRank=id=>{if(!profile(id))return null;const rank=getPublishedRank?.(id);return Number.isSafeInteger(rank)&&rank>0?rank:null;};
 return equip;
}
