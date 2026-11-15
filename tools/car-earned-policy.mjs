/** Local visual eligibility from an account-matched published profile, never a wallet grant. */
export function createCarEquipPolicy({getAccountId,getPublishedProfile,isFree}={}){
 if([getAccountId,getPublishedProfile,isFree].some(fn=>typeof fn!=='function'))throw TypeError('Car policy adapters required');
 return choice=>{
  if(!choice||!/^[a-f0-9]{64}$/.test(choice.accountId||'')||choice.accountId!==getAccountId())return false;
  const reflector=(choice.category==='front'||choice.category==='rear')&&choice.id==='rearbar';
  const podium=choice.category==='emblem'&&choice.id==='crest'||choice.category==='accessory'&&choice.id==='crown';
  if(!reflector&&!podium&&isFree(choice)===true)return true;
  const row=getPublishedProfile(choice.accountId);
  if(!row||row.localOnly===true||row.localPending===true||row.local===true||row.localEstimateOrigin||
    (row.userId??row.accountId)!==choice.accountId||row.accountId!==undefined&&row.accountId!==choice.accountId)return false;
  if(reflector)return Number.isSafeInteger(row.raceCount)&&row.raceCount>=5;
  if(podium)return ['gold','silver','bronze'].every(k=>Number.isSafeInteger(row.medals?.[k])&&row.medals[k]>=0)&&row.medals.gold+row.medals.silver+row.medals.bronze>=1;
  return false;
 };
}
