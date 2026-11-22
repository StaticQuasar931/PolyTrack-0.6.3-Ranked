import test from 'node:test';
import assert from 'node:assert/strict';
import {createProfileShopBalanceCache} from './profile-shop-balance-cache.mjs';

const accountId='a'.repeat(64),otherAccount='b'.repeat(64),ownerUid='owner:a';
const record={accountId,ownerUid,balance:1234,revision:6};
function fixture(){
  const data=new Map(),storage={getItem:key=>data.get(key),setItem:(key,value)=>data.set(key,value)};
  return {data,storage,cache:createProfileShopBalanceCache(storage)};
}

test('last confirmed balance survives remount and is partitioned by racer and Cloud Save owner',()=>{
  const {data,storage,cache}=fixture();
  cache.remember({...record,token:'not stored',ownedItemIds:['not-stored']});
  const other=createProfileShopBalanceCache(storage);
  assert.deepEqual(other.read(accountId,ownerUid),{accountId,balance:1234,revision:6});
  for(const [id,uid] of [[otherAccount,ownerUid],[accountId,'owner:b'],[accountId,null],[accountId,'']]){
    assert.equal(other.read(id,uid),null);
  }
  assert.deepEqual(JSON.parse([...data.values()][0]),{schemaVersion:1,...record});
  cache.remember({...record,balance:99,revision:5});
  assert.equal(other.read(accountId,ownerUid).balance,1234);
  cache.remember({...record,balance:0,revision:7});
  assert.deepEqual(other.read(accountId,ownerUid),{accountId,balance:0,revision:7});
});

test('invalid, cross-owner, and unavailable storage never render a balance',()=>{
  const {cache,data}=fixture();cache.remember(record);
  const [key]=data.keys();
  for(const raw of ['{',JSON.stringify({schemaVersion:1,...record,ownerUid:'other'}),
    JSON.stringify({schemaVersion:1,...record,balance:-1}),JSON.stringify({schemaVersion:1,...record,revision:1.5}),
    JSON.stringify({schemaVersion:1,...record,accountId:otherAccount}),JSON.stringify({schemaVersion:1,...record,receipt:{}})]){
    data.set(key,raw);
    assert.equal(cache.read(accountId,ownerUid),null);
  }
  const blocked=createProfileShopBalanceCache({getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}});
  assert.doesNotThrow(()=>blocked.remember(record));
  assert.equal(blocked.read(accountId,ownerUid),null);
});
