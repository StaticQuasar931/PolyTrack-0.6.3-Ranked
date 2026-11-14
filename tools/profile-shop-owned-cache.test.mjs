import test from 'node:test';
import assert from 'node:assert/strict';
import {createProfileShopOwnedCache} from './profile-shop-owned-cache.mjs';
const A='a'.repeat(64),B='b'.repeat(64),owner='auth-owner-a';
const confirmed={accountId:A,ownerUid:owner,catalogVersion:2,revision:3,complete:true,ownedItemIds:['profile-pitlane-ticket']};
function fixture(){const data=new Map();const storage={getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)};return {data,storage,cache:createProfileShopOwnedCache(storage)};}
test('reload restores only known inventory UI hints bound to both account and auth owner',()=>{
 const f=fixture();assert.equal(f.cache.remember(confirmed),true);const reload=createProfileShopOwnedCache(f.storage);
 assert.equal(reload.owns(A,owner,'plate:pitlane-ticket'),true);assert.equal(reload.owns(B,owner,'plate:pitlane-ticket'),false);assert.equal(reload.owns(A,'different-owner','plate:pitlane-ticket'),false);assert.equal(reload.owns(A,null,'plate:pitlane-ticket'),false);
 assert.equal(reload.owns(A,owner,'stage:apex-observatory'),false);assert.equal(reload.owns(A,owner,'badge:admin'),false);
 assert.doesNotMatch([...f.data.values()].join(''),/balance|token|grant|wallet|price|credits|requestId/);
});
test('unknown/partial/legacy/malformed inputs never promote local guesses or overwrite a confirmation',()=>{
 const f=fixture();f.cache.remember(confirmed);
 for(const patch of [{complete:false},{catalogVersion:1},{revision:-1},{ownedItemIds:['mint-rally']},{ownedItemIds:['profile-pitlane-ticket','profile-pitlane-ticket']},{accountId:'bad'},{ownerUid:''}])assert.equal(f.cache.remember({...confirmed,...patch}),false);
 assert.equal(f.cache.owns(A,owner,'plate:pitlane-ticket'),true);
 for(const [key]of f.data){f.data.set(key,'{broken');assert.equal(f.cache.read(A,owner),null);f.data.set(key,JSON.stringify({...confirmed,schemaVersion:1,balance:999}));assert.equal(f.cache.read(A,owner),null);}
});
test('permanent purchases survive missing projections; explicit complete GET can add known items but older results cannot',()=>{
 const f=fixture();f.cache.remember(confirmed);assert.equal(f.cache.remember({...confirmed,revision:4,ownedItemIds:[]}),true);assert.equal(f.cache.owns(A,owner,'plate:pitlane-ticket'),true);
 assert.equal(f.cache.remember({...confirmed,revision:5,ownedItemIds:['profile-apex-observatory']}),true);assert.equal(f.cache.owns(A,owner,'stage:apex-observatory'),true);
 assert.equal(f.cache.remember({...confirmed,revision:3,ownedItemIds:['profile-vector-ribbon']}),false);assert.equal(f.cache.owns(A,owner,'stripe:vector-ribbon'),false);
});
test('blocked or full storage fails closed without throwing',()=>{
 const cache=createProfileShopOwnedCache({getItem(){throw Error('blocked');},setItem(){throw Error('full');}});
 assert.equal(cache.read(A,owner),null);assert.equal(cache.remember(confirmed),false);assert.equal(cache.owns(A,owner,'plate:pitlane-ticket'),false);
});
