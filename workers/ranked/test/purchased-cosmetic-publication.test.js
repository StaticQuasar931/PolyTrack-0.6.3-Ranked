import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import worker,{rebuildOverall,handleRequest,sanitizeProfileCosmetics} from '../src/index.js';
import {eventEncode,eventDecode} from '../src/events-store.js';
import {preparePublicationPages,PUBLIC_PAGE_COLLECTION} from '../src/paged-publication.js';
import {addPurchase,SHOP_PROFILE_CATALOG} from '../src/purchased-cosmetic-entitlements.js';
import {invalidateEntitlements,ENTITLEMENT_COLLECTION as ENT,ENTITLEMENT_CACHE_COLLECTION as CACHE} from '../src/overall-entitlement-cache.js';
const accountId='a'.repeat(64),AT=1792000000000,BASE='projects/polytrack-052/databases/(default)/documents/';
const META='0.6.2_s1_release_meta/current',TRACKS='0.6.2_s1_leaderboards_track',OVERALL='0.6.2_s1_leaderboards_overall/main',TRACK='5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038';
const clone=v=>structuredClone(v),isRefinement=writes=>writes.some(w=>w.update.name.includes('/'+CACHE+'/'))&&!writes.some(w=>w.update.name.endsWith(OVERALL));
// Reuse existing offline store/CAS fixtures without importing their test cases.
const rebuildSource=fs.readFileSync(new URL('./overall-entitlement-cache.test.js',import.meta.url),'utf8');
const fixtureBody=rebuildSource.slice(rebuildSource.indexOf('function fixture(count = 2)'),rebuildSource.indexOf('\nfunction reads(',rebuildSource.indexOf('function fixture(count = 2)')));
assert.ok(fixtureBody.startsWith('function fixture('));
const fixture=Function('assert','BASE','META','TRACKS','TRACK','AT','ENT','CACHE','OVERALL','eventEncode','eventDecode','clone','isRefinement',fixtureBody+';return fixture;')(assert,BASE,META,TRACKS,TRACK,AT,ENT,CACHE,OVERALL,eventEncode,eventDecode,clone,isRefinement);
const origin='https://cosmetics-audit.invalid',profilePath='0.6.2_profiles_public/'+accountId,overallPath=OVERALL,jobPath='0.6.2_s1_worker_jobs/profile_'+accountId,cosmeticJobPath='0.6.2_s1_cosmetic_jobs/'+accountId,cosmetics=sanitizeProfileCosmetics({});
const publishSource=fs.readFileSync(new URL('./profile-cosmetics-idempotency.test.js',import.meta.url),'utf8'),start=publishSource.indexOf('async function fixture(t)'),end=publishSource.indexOf("\ntest('three identical",start);
assert.ok(start>=0&&end>start);
const publishFixture=Function('assert','sanitizeProfileCosmetics','eventEncode','eventDecode','preparePublicationPages','PUBLIC_PAGE_COLLECTION','handleRequest','worker','origin','accountId','profilePath','overallPath','jobPath','cosmeticJobPath','cosmetics',publishSource.slice(start,end)+';return fixture;')(assert,sanitizeProfileCosmetics,eventEncode,eventDecode,preparePublicationPages,PUBLIC_PAGE_COLLECTION,handleRequest,worker,origin,accountId,profilePath,overallPath,jobPath,cosmeticJobPath,cosmetics);

test('actual forced and companion-cache rebuilds preserve all three server purchases',async t=>{
 t.mock.method(globalThis,'fetch',async()=>assert.fail('external network forbidden'));t.mock.method(Date,'now',()=>AT);
 const f=fixture(2),board=f.data.get(TRACKS+'/'+TRACK);board.entries[0].accountId=accountId;f.mutate(TRACKS+'/'+TRACK,board);
 assert.equal((await rebuildOverall(f.env,true)).rebuilt,true);
 let entitlement=f.data.get(ENT+'/'+accountId);assert.ok(entitlement,'fixture must exercise a ranked account entitlement');for(const item of SHOP_PROFILE_CATALOG)entitlement=addPurchase(entitlement,item.id,AT,{accountId,ownerUid:'owner'});
 f.mutate(ENT+'/'+accountId,entitlement);f.mutate(META,invalidateEntitlements(f.data.get(META),[accountId]));const purchased=clone(entitlement.purchased);
 for(let i=0;i<2;i++){f.dirty();assert.equal((await rebuildOverall(f.env,i===0)).rebuilt,true);
 const actual=f.data.get(ENT+'/'+accountId);assert.deepEqual(actual.purchased,purchased);for(const item of SHOP_PROFILE_CATALOG)assert.ok(actual[item.grants[0].slot].includes(item.grants[0].value));}
});
for(const version of [1,7])test('actual current/legacy profile publish accepts owned-only design version'+version,async t=>{
 const f=await publishFixture(t);let entitlement=null;const design={...cosmetics,version};for(const item of SHOP_PROFILE_CATALOG){entitlement=addPurchase(entitlement,item.id,AT,{accountId,ownerUid:'owner'});design[item.grants[0].slot]=item.grants[0].value;}
 for(const item of SHOP_PROFILE_CATALOG)assert.equal(sanitizeProfileCosmetics(design)[item.grants[0].slot],item.grants[0].value,'Worker must recognize new catalog ID without defaulting it');
 f.replace(ENT+'/'+accountId,entitlement);f.replace(profilePath,{...f.db.get(profilePath),profileCosmetics:design});
 const accepted=await f.save(design);assert.equal(accepted.status,202);
 assert.equal((await accepted.json()).accepted,true);
 assert.equal(f.db.get(jobPath).active,false);assert.deepEqual(f.db.get(jobPath).pendingTrackIds,[]);
 assert.equal(f.reads(),11,'paid publication reads canonical provenance once beyond earned-only path plus new identity discovery');
 assert.equal(f.writes.length,version===1?3:2,'legacy normalization may rewrite the profile; neither path rewrites grants');
 const written=f.writes.length,readStart=f.reads();assert.equal((await f.save(design)).status,200);
 assert.equal(f.reads()-readStart,10);assert.equal(f.writes.length,written,'confirmed repeat publishes nothing');
 for(const item of SHOP_PROFILE_CATALOG)assert.equal(f.db.get(overallPath).entries[0].profileCosmetics[item.grants[0].slot],item.grants[0].value);
 assert.deepEqual(f.db.get(ENT+'/'+accountId).purchased,entitlement.purchased);
});


test('actual publisher denies absent, root-only, foreign and malformed purchase provenance without writes',async t=>{
 const f=await publishFixture(t),design={...cosmetics,plate:'pitlane-ticket'};
 const valid=addPurchase(null,SHOP_PROFILE_CATALOG[0].id,AT,{accountId,ownerUid:'owner'});
 for(const mutation of ['absent','root-only','owner','account','unknown','version','time']){
  let entitlement=clone(valid);
  if(mutation==='absent')entitlement=null;
  if(mutation==='root-only')delete entitlement.purchased;
  if(mutation==='owner')entitlement.purchased.ownerUid='foreign';
  if(mutation==='account')entitlement.purchased.accountId='b'.repeat(64);
  if(mutation==='unknown')entitlement.purchased.items.forged={catalogVersion:2,acquiredAt:AT};
  if(mutation==='version')entitlement.purchased.items[SHOP_PROFILE_CATALOG[0].id].catalogVersion=1;
  if(mutation==='time')entitlement.purchased.items[SHOP_PROFILE_CATALOG[0].id].acquiredAt=-1;
  if(entitlement)f.replace(ENT+'/'+accountId,entitlement);else f.db.delete(ENT+'/'+accountId);
  f.replace(profilePath,{...f.db.get(profilePath),profileCosmetics:design});
  const before=clone(f.db),writes=f.writes.length,response=await f.save(design);
  assert.equal(response.status,403,mutation);assert.equal((await response.json()).error,'cosmetic_locked');
  assert.deepEqual(f.db,before);assert.equal(f.writes.length,writes);
 }
});

test('actual publisher never uses one paid field to authorize unrelated paid or status cosmetics',async t=>{
 const f=await publishFixture(t),entitlement=addPurchase(null,SHOP_PROFILE_CATALOG[0].id,AT,{accountId,ownerUid:'owner'});
 f.replace(ENT+'/'+accountId,entitlement);
 for(const change of [{stage:'apex-observatory'},{stripe:'vector-ribbon'},{badge:'betaTester'},{theme:'podium'},{emblem:'crown'}]){
  const design={...cosmetics,plate:'pitlane-ticket',...change};f.replace(profilePath,{...f.db.get(profilePath),profileCosmetics:design});
  const before=clone(f.db),response=await f.save(design);assert.equal(response.status,403);assert.deepEqual(f.db,before);
 }
 assert.equal(f.writes.length,0);
});

test('actual rebuild CAS conflict cannot erase a purchase arriving after calculation',async t=>{
 t.mock.method(globalThis,'fetch',async()=>assert.fail('external network forbidden'));t.mock.method(Date,'now',()=>AT);
 const f=fixture(2),board=f.data.get(TRACKS+'/'+TRACK);board.entries[0].accountId=accountId;f.mutate(TRACKS+'/'+TRACK,board);
 await rebuildOverall(f.env,true);
 let entitlement=addPurchase(f.data.get(ENT+'/'+accountId),SHOP_PROFILE_CATALOG[0].id,AT,{accountId,ownerUid:'owner'});
 f.mutate(ENT+'/'+accountId,entitlement);f.mutate(META,invalidateEntitlements(f.data.get(META),[accountId]));f.dirty();
 const before=clone(f.data.get(OVERALL));
 f.beforeCommit=async writes=>{
  if(!writes.some(w=>w.update.name.endsWith(OVERALL)))return;
  f.beforeCommit=null;entitlement=addPurchase(f.data.get(ENT+'/'+accountId),SHOP_PROFILE_CATALOG[1].id,AT+1,{accountId,ownerUid:'owner'});
  f.mutate(ENT+'/'+accountId,entitlement);f.mutate(META,invalidateEntitlements(f.data.get(META),[accountId]));
 };
 await assert.rejects(rebuildOverall({...f.env}),/409/);assert.deepEqual(f.data.get(OVERALL),before);
 assert.deepEqual(f.data.get(ENT+'/'+accountId).purchased,entitlement.purchased);
 assert.ok(f.data.get(META).entitlementInvalidations.accountIds.includes(accountId));
 assert.equal((await rebuildOverall({...f.env},true)).rebuilt,true);
 const repaired=f.data.get(ENT+'/'+accountId);assert.deepEqual(repaired.purchased,entitlement.purchased);
 for(const item of SHOP_PROFILE_CATALOG.slice(0,2))assert.ok(repaired[item.grants[0].slot].includes(item.grants[0].value));
});

test('actual rebuild fails closed on corrupt purchase provenance instead of deleting it',async t=>{
 t.mock.method(globalThis,'fetch',async()=>assert.fail('external network forbidden'));t.mock.method(Date,'now',()=>AT);
 const f=fixture(2),board=f.data.get(TRACKS+'/'+TRACK);board.entries[0].accountId=accountId;f.mutate(TRACKS+'/'+TRACK,board);
 await rebuildOverall(f.env,true);
 const entitlement=addPurchase(f.data.get(ENT+'/'+accountId),SHOP_PROFILE_CATALOG[0].id,AT,{accountId,ownerUid:'owner'});
 entitlement.purchased.accountId='b'.repeat(64);f.mutate(ENT+'/'+accountId,entitlement);f.mutate(META,invalidateEntitlements(f.data.get(META),[accountId]));
 const overall=clone(f.data.get(OVERALL));f.dirty();await assert.rejects(rebuildOverall({...f.env},true),/PURCHASED_COSMETIC_ENTITLEMENT_INVALID/);
 assert.deepEqual(f.data.get(ENT+'/'+accountId),entitlement);assert.deepEqual(f.data.get(OVERALL),overall);
});
