import {PROFILE_SHOP_CATALOG,PROFILE_SHOP_CATALOG_VERSION} from './profile-shop-catalog.mjs';
const prefix='polytrack-profile-shop-owned-ui-v1:';
const ids=new Set(PROFILE_SHOP_CATALOG.map(item=>item.id));
const account=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const owner=value=>typeof value==='string'&&value.length>0&&value.length<=128&&!/[\u0000-\u001f\u007f]/.test(value);
const uint=value=>Number.isSafeInteger(value)&&value>=0;
const key=(accountId,ownerUid)=>prefix+accountId+':'+encodeURIComponent(ownerUid);
const fields=['schemaVersion','catalogVersion','accountId','ownerUid','revision','ownedItemIds'];
function valid(record,accountId,ownerUid){
  return record&&typeof record==='object'&&!Array.isArray(record)&&Object.keys(record).length===fields.length&&Object.keys(record).every(field=>fields.includes(field))&&
    record.schemaVersion===1&&record.catalogVersion===PROFILE_SHOP_CATALOG_VERSION&&record.accountId===accountId&&record.ownerUid===ownerUid&&uint(record.revision)&&
    Array.isArray(record.ownedItemIds)&&record.ownedItemIds.length<=ids.size&&new Set(record.ownedItemIds).size===record.ownedItemIds.length&&record.ownedItemIds.every(id=>ids.has(id));
}
/** UI hint from a previously validated COMPLETE inventory GET. Editable device
 * storage is NOT proof of ownership, a wallet, or permission to publish/buy.
 * No balance, token, receipt, grant or optimistic purchase result is stored.
 */
export function createProfileShopOwnedCache(storage){
  function read(accountId,ownerUid){
    if(!account(accountId)||!owner(ownerUid))return null;
    try{const raw=storage?.getItem(key(accountId,ownerUid));if(typeof raw!=='string'||raw.length>2048)return null;const record=JSON.parse(raw);return valid(record,accountId,ownerUid)?record:null;}catch{return null;}
  }
  function remember({accountId,ownerUid,catalogVersion,revision,ownedItemIds,complete}={}){
    if(complete!==true||catalogVersion!==PROFILE_SHOP_CATALOG_VERSION||!account(accountId)||!owner(ownerUid))return false;
    const record={schemaVersion:1,catalogVersion,accountId,ownerUid,revision,ownedItemIds};
    if(!valid(record,accountId,ownerUid))return false;
    const previous=read(accountId,ownerUid);if(previous&&previous.revision>revision)return false;
    // These fixed purchased designs are permanent. Reconciliation adds confirmed
    // items; a stale/missing projection must not silently relock a prior purchase.
    if(previous)record.ownedItemIds=PROFILE_SHOP_CATALOG.map(item=>item.id).filter(id=>previous.ownedItemIds.includes(id)||ownedItemIds.includes(id));
    try{const raw=JSON.stringify(record);storage.setItem(key(accountId,ownerUid),raw);return storage.getItem(key(accountId,ownerUid))===raw;}catch{return false;}
  }
  return {read,remember,owns(accountId,ownerUid,unlockId){
    const record=read(accountId,ownerUid);return !!record&&PROFILE_SHOP_CATALOG.some(item=>record.ownedItemIds.includes(item.id)&&item.grants.some(grant=>grant.slot+':'+grant.value===unlockId));
  }};
}
