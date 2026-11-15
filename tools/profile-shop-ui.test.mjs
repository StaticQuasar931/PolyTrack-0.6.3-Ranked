import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PROFILE_SHOP_CATALOG} from './profile-shop-catalog.mjs';
import {createProfileShopHost,priceForUi} from './profile-shop-host.mjs';

test('display prices follow every canonical grant without auth, storage, network or wallet arithmetic',()=>{
 let io=0;const forbidden=()=>{io++;throw Error('Unexpected I/O');};
 const host=createProfileShopHost({document:{},getAccountId:()=> 'a'.repeat(64),getAuth:forbidden,storage:{getItem:forbidden,setItem:forbidden,removeItem:forbidden},fetch:forbidden,revision:1});
 for(const item of PROFILE_SHOP_CATALOG)for(const grant of item.grants){assert.equal(priceForUi(grant.slot,grant.value),item.price);assert.equal(host.priceForUi(grant.slot,grant.value),item.price);}
 for(const [slot,value]of [[null,'x'],['theme',null],['__proto__','constructor'],['unknown','missing'],['plate','missing']])assert.equal(priceForUi(slot,value),null);
 assert.equal(io,0);host.dispose();assert.equal(io,0);
});

test('Style Coins presentation has no I/O or legacy CP labels, and leaves generic shop APIs intact',()=>{
 const source=fs.readFileSync(new URL('./profile-shop-ui.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(source,/\bCP\b|Three original|fetch\(|XMLHttpRequest|firebase|localStorage|sessionStorage|indexedDB/);
 assert.match(source,/export function mountProfileShopUi/);assert.match(source,/walletRevision:revision/);
 assert.match(source,/draftOnly:true/);assert.match(source,/item\.price===known\.price/);
 const host=fs.readFileSync(new URL('./profile-shop-host.mjs',import.meta.url),'utf8');
 assert.match(host,/profile-shop-ui\.mjs.*new URL\(import\.meta\.url\)\.search/);assert.match(source,/profile-shop-art\.mjs.*new URL\(import\.meta\.url\)\.search/);assert.match(host,/profile-shop-ui\.css/);
 assert.doesNotMatch(host,/profile-achievement-journey|version:2,items:PROFILE_SHOP_CATALOG/);
});

test('Shop sorting is stable and never mutates products, prices or ownership',async()=>{
 const {sortProfileShopItems}=await import('./profile-shop-ui.mjs');
 const items=[{id:'a',label:'Zulu',price:30},{id:'b',label:'Alpha',price:20},{id:'c',label:'Beta',price:20}];
 const before=JSON.stringify(items);
 assert.deepEqual(sortProfileShopItems(items,'price').map(x=>x.id),['b','c','a']);
 assert.deepEqual(sortProfileShopItems(items,'name').map(x=>x.id),['b','c','a']);
 assert.deepEqual(sortProfileShopItems(items,'unowned',['a']).map(x=>x.id),['b','c','a']);
 assert.deepEqual(sortProfileShopItems(items,'unknown').map(x=>x.id),['a','b','c']);
 assert.equal(JSON.stringify(items),before);
});
