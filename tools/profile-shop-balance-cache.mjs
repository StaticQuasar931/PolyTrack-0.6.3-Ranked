const prefix='polytrack-profile-shop-balance-ui-v1:';
const account=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const owner=value=>typeof value==='string'&&value.length>0&&value.length<=128&&!/[\u0000-\u001f\u007f]/.test(value);
const uint=value=>Number.isSafeInteger(value)&&value>=0;
const key=(accountId,ownerUid)=>prefix+accountId+':'+encodeURIComponent(ownerUid);
const valid=(record,accountId,ownerUid)=>record?.schemaVersion===1&&record.accountId===accountId&&
  record.ownerUid===ownerUid&&uint(record.balance)&&uint(record.revision)&&Object.keys(record).length===5;

// Display only. Never feed a stored value back into the Shop session or a quote.
export function createProfileShopBalanceCache(storage){
  function read(accountId,ownerUid){
    if(!account(accountId)||!owner(ownerUid))return null;
    try{
      const raw=storage?.getItem(key(accountId,ownerUid));
      if(typeof raw!=='string'||raw.length>2048)return null;
      const record=JSON.parse(raw);
      return valid(record,accountId,ownerUid)?{accountId,balance:record.balance,revision:record.revision}:null;
    }catch{return null;}
  }
  function remember({accountId,ownerUid,balance,revision}={}){
    const record={schemaVersion:1,accountId,ownerUid,balance,revision};
    if(!account(accountId)||!owner(ownerUid)||!valid(record,accountId,ownerUid))return;
    const previous=read(accountId,ownerUid);
    if(previous&&(previous.revision>revision||previous.revision===revision&&previous.balance===balance))return;
    try{storage?.setItem(key(accountId,ownerUid),JSON.stringify(record));}catch{}
  }
  return {read,remember};
}
