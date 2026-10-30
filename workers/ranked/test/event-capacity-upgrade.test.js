import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {eventCapacityUpgradeRequired} from '../src/event-capacity.js';
import {eventPeriod, EVENT_COLLECTIONS as C} from '../src/events.js';
import {provisionEvent, utcEventCandidates} from '../src/events-runtime.js';
import {eventEncode} from '../src/events-store.js';

const config=JSON.parse(fs.readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
const capacity=JSON.parse(config.vars.EVENT_CAPACITY_JSON);
const prior={...capacity,policyVersion:'event-200-v1',storageVersion:undefined,entrants:200};
const at=Date.UTC(2026,9,30,12),trackId='a'.repeat(64);
const options={officialIds:[trackId],allIds:[trackId,'b'.repeat(64)],capacity,
  targetForTrack:()=>assert.fail('existing events must not rediscover targets')};
const candidates=utcEventCandidates(at,options.officialIds,options.allIds);
const period=candidate=>eventPeriod({...candidate,enabled:true,targetMs:10000,capacity:prior,
  eligibility:'best-submitted-during-period',graceMs:86400000});

test('2,000-racer policy retains the existing admission, storage, rate and verification budgets',()=>{
  assert.equal(capacity.entrants,2000);assert.equal(capacity.storageVersion,2);
  assert.equal(capacity.admissionsPerPeriod,2048);
  assert.equal(capacity.replayBytesPerPeriod,16777216);
  assert.equal(capacity.minIntervalMs,5000);assert.equal(capacity.verificationsPerDay,1536);
  assert.equal(eventPeriod({...period(candidates[0]),storageVersion:2,capacity}).capacity.entrants,2000);
});

test('only active monotonic capacity upgrades are selected',()=>{
  const p=period(candidates[0]);assert.equal(eventCapacityUpgradeRequired(p,capacity,at),true);
  for(const changed of [{archived:true},{enabled:false},{startsAt:at+1},{endsAt:at},{endsAt:undefined},
    {capacity:{...prior,entrants:3000}},{capacity:{...prior,admissionsPerPeriod:3000}},
    {storageVersion:2,capacity}])assert.equal(eventCapacityUpgradeRequired({...p,...changed},capacity,at),false);
  assert.equal(eventCapacityUpgradeRequired(p,{...capacity,storageVersion:1},at),false);
});

test('scheduled provisioning upgrades at most one event and repeated upgraded checks add no writes or extra reads',async()=>{
  const documents=new Map(candidates.map(candidate=>[candidate.id,period(candidate)]));
  let reads=0,writes=0;
  const runtime={now:()=>at,request:async route=>{
    reads++;assert.ok(route.startsWith('/'+C.periods+'/'));
    const value=documents.get(route.split('/').at(-1));
    return value?{fields:eventEncode(value).mapValue.fields}:null;
  },service:{upgradeCapacity:async(id,next)=>{
    writes++;documents.set(id,{...documents.get(id),storageVersion:2,capacity:next});
    return {upgraded:true,storageVersion:2,entrants:next.entrants};
  }}};
  for(let i=0;i<2;i++){
    const before=writes,result=await provisionEvent(runtime,options);
    assert.equal(writes,before+1);assert.ok(result.capacityUpgraded);
  }
  reads=0;writes=0;
  await provisionEvent(runtime,options);
  assert.equal(reads,2);assert.equal(writes,0);
});
