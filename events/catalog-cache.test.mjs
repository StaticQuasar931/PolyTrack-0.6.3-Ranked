import test from 'node:test';
import assert from 'node:assert/strict';
import {eventCatalogFreshUntil} from './client.mjs';

test('catalog refresh is capped at the next active event start or reset',()=>{
 const now=1_000_000;
 const periods=[
  {id:'active',kind:'daily',startsAt:now-1000,endsAt:now+30_000},
  {id:'scheduled',kind:'weekly',startsAt:now+12_000,endsAt:now+7*86400000,scheduleOnly:true}
 ];
 assert.equal(eventCatalogFreshUntil(periods,now),now+12_000,'a period start before the normal TTL forces refresh');
 assert.equal(eventCatalogFreshUntil([periods[0]],now),now+30_000,'an active event reset forces refresh');
});

test('catalog cache retains the normal TTL when no event boundary is near',()=>{
 const now=1_000_000;
 assert.equal(eventCatalogFreshUntil([{id:'later',kind:'weekly',startsAt:now+600_000,endsAt:now+7*86400000}],now),now+300_000);
 assert.equal(eventCatalogFreshUntil([],now),now+300_000);
});
