import test from'node:test';import assert from'node:assert/strict';import{createCarEquipPolicy}from'./car-earned-policy.mjs';
const id='a'.repeat(64),other='b'.repeat(64),free=q=>q.category==='finish'&&q.id==='original';
test('new car cosmetics require account-matched published progress without local substitutions',()=>{let active=id,row={userId:id,raceCount:5,medals:{gold:1,silver:0,bronze:0}};const allow=createCarEquipPolicy({getAccountId:()=>active,getPublishedProfile:()=>row,isFree:free});const front={accountId:id,category:'front',id:'rearbar'},crest={accountId:id,category:'emblem',id:'crest'};assert(allow(front));assert(allow(crest));assert(!allow({...front,id:'future-product'}));assert(allow({accountId:id,category:'finish',id:'original'}));for(const bad of [null,{...row,userId:other},{...row,accountId:other},{...row,raceCount:'5'},{...row,local:true},{...row,localPending:true},{...row,localOnly:true},{...row,localEstimateOrigin:{}}]){row=bad;assert(!allow(front));}row={userId:id,raceCount:4,medals:{gold:0,silver:0,bronze:0}};assert(!allow(front));assert(!allow(crest));row={userId:id,raceCount:5,medals:{gold:1,silver:0,bronze:0}};active=other;assert(!allow(front));assert(!allow({accountId:id,category:'finish',id:'original'}));});
test('podium crown requires confirmed published medals and never local counts',()=>{let row={userId:id,raceCount:200,medals:{gold:0,silver:0,bronze:0}};const allow=createCarEquipPolicy({getAccountId:()=>id,getPublishedProfile:()=>row,isFree:free}),choice={accountId:id,category:'accessory',id:'crown'};assert(!allow(choice));row.medals.bronze=1;assert(allow(choice));row.localPending=true;assert(!allow(choice));delete row.localPending;row.medals.silver='1';assert(!allow(choice));});
test('legacy front and independent rear reflector slots both require five confirmed tracks, never a free bypass',()=>{
 let active=id,row={userId:id,raceCount:4};
 // A stale/free adapter must not turn an explicitly earned item into a free grant.
 const allow=createCarEquipPolicy({getAccountId:()=>active,getPublishedProfile:()=>row,isFree:()=>true});
 for(const category of ['front','rear']){
  const choice={accountId:id,category,id:'rearbar'};row={userId:id,raceCount:4};assert(!allow(choice));row.raceCount=5;assert(allow(choice));
  for(const bad of [null,{userId:id,raceCount:'5'},{userId:other,raceCount:5},{userId:id,accountId:other,raceCount:5},{userId:id,raceCount:5,local:true},{userId:id,raceCount:5,localOnly:true},{userId:id,raceCount:5,localPending:true},{userId:id,raceCount:5,localEstimateOrigin:{}}]){row=bad;assert(!allow(choice));}
  row={userId:id,raceCount:5};active=other;assert(!allow(choice));active=id;
 }
 row={userId:id,raceCount:5,medals:{gold:0,silver:0,bronze:0}};assert(!allow({accountId:id,category:'accessory',id:'crown'}));assert(!allow({accountId:id,category:'emblem',id:'crest'}));
});
