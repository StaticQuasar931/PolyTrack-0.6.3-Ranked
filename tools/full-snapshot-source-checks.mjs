const ID=/^[a-f0-9]{64}$/;
export const FULL_TRACK_CHECK_LIMIT=512;
export function selectFullTrackChecks(ids,records,{notBefore,limit=FULL_TRACK_CHECK_LIMIT}={}){
 if(!Number.isSafeInteger(notBefore)||notBefore<1||!Number.isSafeInteger(limit)||limit<1||limit>FULL_TRACK_CHECK_LIMIT)throw Error('Invalid full source check bounds');
 const unique=[...new Set(ids)];if(unique.length>FULL_TRACK_CHECK_LIMIT||unique.some(id=>!ID.test(id)))throw Error('Full source track inventory exceeds bound');
 const pending=unique.filter(id=>!(records[id]?.path&&records[id].missing!==true&&Number.isSafeInteger(records[id].checkedAt)&&records[id].checkedAt>=notBefore));
 if(pending.length>limit)throw Error('Full track source budget cannot cover current inventory');
 return pending.sort();
}
export function assertFullTrackChecks(ids,records,notBefore){
 const pending=selectFullTrackChecks(ids,records,{notBefore});
 const unavailable=pending.filter(id=>!records[id]?.path&&records[id]?.missing===true&&records[id].checkedAt>=notBefore);
 const unchecked=pending.filter(id=>!unavailable.includes(id));
 if(unchecked.length)throw Error('Full snapshot has '+unchecked.length+' unconfirmed retained track sources');
 return {known:ids.length,confirmed:ids.length-unavailable.length,unavailable:unavailable.length,checkedAtOrAfter:notBefore};
}
