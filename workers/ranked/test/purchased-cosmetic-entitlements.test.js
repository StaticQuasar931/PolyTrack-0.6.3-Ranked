import test from 'node:test';
import assert from 'node:assert/strict';
import {addPurchase, mergePurchasedEntitlement, mergeEarnedAndPurchasedEntitlements,
  purchasedProfileCosmeticsUnlocked, readPurchasedCosmetics, SHOP_PROFILE_CATALOG} from '../src/purchased-cosmetic-entitlements.js';
import {PROFILE_SHOP_CATALOG_VERSION} from '../../../tools/profile-shop-catalog.mjs';
import {invalidateEntitlements, fenceEntitlementWrites, prepareEntitlementPublication, decodeEntitlementPublication} from '../src/overall-entitlement-cache.js';
const accountId='a'.repeat(64),ownerUid='owner',binding={accountId,ownerUid},at=1700000000000;
const earned=()=>({plate:['block','outline'],stage:['garage','slate'],stripe:['standard','cyan'],theme:['classic'],
  serverIssued:{version:1,cosmeticUnlocks:[],achievements:{version:1,casual:{count:1,ledger:'01'}}}});
const buy=(prior=null,id=SHOP_PROFILE_CATALOG[0].id)=>addPurchase(prior,id,at,binding);

test('catalog is fixed profile-only version2 and distinct from retired native presets',()=>{
 assert.equal(PROFILE_SHOP_CATALOG_VERSION,2);assert.equal(SHOP_PROFILE_CATALOG.length,3);
 assert.deepEqual(SHOP_PROFILE_CATALOG.map(i=>[i.id,i.price,i.grants[0].slot,i.grants[0].value]),[
 ['profile-pitlane-ticket',20,'plate','pitlane-ticket'],['profile-apex-observatory',30,'stage','apex-observatory'],['profile-vector-ribbon',50,'stripe','vector-ribbon']]);
 for(const item of SHOP_PROFILE_CATALOG){assert.equal(item.kind,'profile-cosmetic');assert.equal(item.grants.length,1);assert.equal('style'in item,false);}
});
for(const item of SHOP_PROFILE_CATALOG)test('purchase projects only catalog grant: '+item.id,()=>{
 const prior=earned(),original=structuredClone(prior),next=buy(prior,item.id),{slot,value}=item.grants[0];
 assert.deepEqual(prior,original);assert.deepEqual(next.serverIssued,prior.serverIssued);assert.ok(next[slot].includes(value));
 for(const other of ['plate','stage','stripe'].filter(v=>v!==slot))assert.deepEqual(next[other],prior[other]);
 assert.deepEqual(next.purchased,{version:1,accountId,ownerUid,items:{[item.id]:{catalogVersion:2,acquiredAt:at}}});
});
test('new account gets existing starter allowance, no fake achievements or earned challenge proofs',()=>{
 const next=buy();assert.ok(next.theme.includes('classic'));assert.ok(next.plate.includes('block'));
 assert.equal('serverIssued'in next,false);assert.equal('cosmeticUnlocks'in next,false);
 assert.equal('balance'in next,false);assert.equal('carStyle'in next,false);
});
test('all purchases survive every repeated earned rebuild and unrelated earned revocation',()=>{
 let prior=earned();for(const item of SHOP_PROFILE_CATALOG)prior=buy(prior,item.id);
 const provenance=structuredClone(prior.purchased);prior.plate.push('earned-before');prior.serverIssued.cosmeticUnlocks=['earned-proof'];
 for(let i=0;i<3;i++){const fresh=earned();fresh.serverIssued.achievements.casual.count=i;const next=mergeEarnedAndPurchasedEntitlements(fresh,prior,{accountId});
 assert.deepEqual(next.purchased,provenance);assert.equal(next.plate.includes('earned-before'),false);
 assert.deepEqual(next.serverIssued,fresh.serverIssued);for(const item of SHOP_PROFILE_CATALOG)assert.ok(next[item.grants[0].slot].includes(item.grants[0].value));prior=next;}
});
test('purchase replay preserves provenance acquisition time and does not alias its inputs',()=>{
 const before=buy(),next=addPurchase(before,SHOP_PROFILE_CATALOG[0].id,at+100,binding);
 assert.deepEqual(next,before);next.purchased.items[SHOP_PROFILE_CATALOG[0].id].acquiredAt=5;
 assert.equal(before.purchased.items[SHOP_PROFILE_CATALOG[0].id].acquiredAt,at);
});
test('legacy server-owned allowance without purchase provenance adds no purchased grant',()=>{
 const fresh=earned(),old={...earned(),plate:['block','pitlane-ticket'],unknown:{keep:false}};
 assert.deepEqual(mergeEarnedAndPurchasedEntitlements(fresh,old,{accountId}),fresh);
 assert.equal(readPurchasedCosmetics(old,binding),null);
});
for(const [label,mutate]of [
 ['foreign account',p=>p.accountId='b'.repeat(64)],['foreign owner',p=>p.ownerUid='other'],
 ['wrong provenance version',p=>p.version=2],['retired catalog version1',p=>p.items[SHOP_PROFILE_CATALOG[0].id].catalogVersion=1],
 ['unknown item',p=>p.items['client-grant']={catalogVersion:2,acquiredAt:at}],
 ['injected grant',p=>p.items[SHOP_PROFILE_CATALOG[0].id].grants=[{slot:'badge',value:'betaTester'}]],
 ['invalid date',p=>p.items[SHOP_PROFILE_CATALOG[0].id].acquiredAt=-1],['null provenance',(_p,prior)=>prior.purchased=null],
 ['empty purchases',p=>p.items={}],['extra proof field',p=>p.proof='client']])test('rejects '+label+' rather than erasing or expanding authority',()=>{
 const prior=buy();mutate(prior.purchased,prior);assert.throws(()=>mergeEarnedAndPurchasedEntitlements(earned(),prior,binding),/PURCHASED_COSMETIC_ENTITLEMENT_INVALID/);
 assert.throws(()=>buy(prior),/PURCHASED_COSMETIC_ENTITLEMENT_INVALID/);
});
test('rebuild without owner lookup preserves account-bound ownership; publication enforces current owner',()=>{
 const prior=buy();assert.ok(mergeEarnedAndPurchasedEntitlements(earned(),prior,{accountId}).plate.includes('pitlane-ticket'));
 assert.throws(()=>purchasedProfileCosmeticsUnlocked({plate:'pitlane-ticket'},earned(),prior,{accountId,ownerUid:'new-owner'}));
});
test('server catalog is authority, arbitrary request grant fields cannot mint badge or stage',()=>{
 const next=mergePurchasedEntitlement(earned(),{...binding,item:{id:SHOP_PROFILE_CATALOG[0].id,grants:[{slot:'badge',value:'betaTester'}]},acquiredAt:at});
 assert.equal(next.badge,undefined);assert.ok(!next.stage.includes('apex-observatory'));
 assert.throws(()=>addPurchase(earned(),'mint-rally',at,binding));
});
test('publishing a purchased field still rejects unrelated locked cosmetics',()=>{
 const prior=buy(earned()),good={theme:'classic',plate:'pitlane-ticket',stage:'garage',stripe:'standard'};
 assert.equal(purchasedProfileCosmeticsUnlocked(good,earned(),prior,binding),true);
 for(const bad of [{...good,theme:'beta'},{...good,stage:'apex-observatory'},{...good,stripe:'vector-ribbon'}])
 assert.equal(purchasedProfileCosmeticsUnlocked(bad,earned(),prior,binding),false);
 assert.equal(purchasedProfileCosmeticsUnlocked({plate:'block'},earned(),null,binding),true);
 assert.equal(purchasedProfileCosmeticsUnlocked({badge:'betaTester'},earned(),prior,binding),false);
});
test('cache invalidation forces rebuild authority forward without clearing purchase provenance',()=>{
 const meta={entitlementEpoch:3,entitlementBundle:{version:1,ready:false},other:7},next=invalidateEntitlements(meta,[accountId]);
 assert.equal(next.entitlementEpoch,4);assert.equal(next.dirty,true);assert.equal(meta.entitlementEpoch,3);
 assert.equal(next.entitlementBundle.ready,false);
});
test('concurrent purchased change is rejected by existing canonical payload fence',async()=>{
 const previous=new Map([[accountId,{id:accountId,data:buy(earned()),updateTime:''}]]),newer=buy(previous.get(accountId).data,SHOP_PROFILE_CATALOG[1].id);
 const write={id:accountId,data:mergeEarnedAndPurchasedEntitlements(earned(),previous.get(accountId).data,{accountId})};
 await assert.rejects(fenceEntitlementWrites([write],previous,async()=>new Map([[accountId,{id:accountId,data:newer,updateTime:'new'}]])),/PAYLOAD_CHANGED/);
});
test('rebuilt purchase remains exact in private companion publication and decode',async()=>{
 const data=buy(earned()),documents=new Map([[accountId,{id:accountId,data,updateTime:'v1'}]]),b={scope:'test/documents/entitlements',policyKey:'c'.repeat(64),epoch:2,auditedAt:at};
 const publication=await prepareEntitlementPublication(documents,b),chunks=new Map(publication.documents.map(d=>[d.id,{id:d.id,data:d.data}]));
 const restored=await decodeEntitlementPublication(publication.marker,chunks,b);assert.deepEqual(restored.get(accountId).data,data);
 const next=mergeEarnedAndPurchasedEntitlements(earned(),restored.get(accountId).data,{accountId});assert.ok(next.plate.includes('pitlane-ticket'));
});

test('purchase requires exact account/owner/timestamp and never accepts scalar prior records',()=>{
 for(const override of [{accountId:'legacy-account'},{ownerUid:''},{ownerUid:'x'.repeat(129)}])
 assert.throws(()=>addPurchase(null,SHOP_PROFILE_CATALOG[0].id,at,{...binding,...override}));
 for(const invalid of [0,-1,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>addPurchase(null,SHOP_PROFILE_CATALOG[0].id,invalid,binding));
 for(const prior of [[],false,'owned',42])assert.throws(()=>addPurchase(prior,SHOP_PROFILE_CATALOG[0].id,at,binding));
});

test('known update-time CAS remains attached to rebuilt purchased allowance',async()=>{
 const data=buy(earned()),previous=new Map([[accountId,{id:accountId,data,updateTime:'before-purchase'}]]);
 const allowance=mergeEarnedAndPurchasedEntitlements(earned(),data,{accountId});
 const fenced=await fenceEntitlementWrites([{id:accountId,data:allowance}],previous,async()=>assert.fail('known version must not bless newer canonical payload'));
 assert.equal(fenced.canonicalReads,0);assert.deepEqual(fenced.writes[0].prior,{updateTime:'before-purchase'});
 assert.deepEqual(fenced.writes[0].data.purchased,data.purchased);
});
