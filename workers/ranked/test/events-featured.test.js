import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {eventWorkerMaintenance} from '../src/events-worker.js';
import {EVENT_COLLECTIONS as C} from '../src/events.js';
import {eventEncode,eventDecode} from '../src/events-store.js';
import {utcEventCandidates} from '../src/events-runtime.js';
const rolling='fb769ac2ea77e8f19a21a9dd3071742f2342bd49c41e4748d7e8c7903d4f0778';
const official='a'.repeat(64), at=Date.parse('2026-09-14T00:00:00Z');
const capacity={policyVersion:'test',entrants:200,admissionsPerPeriod:2048,replayBytesPerPeriod:16777216,minIntervalMs:5000,verificationsPerDay:1536};
function fixture(target,existing=false) {
  const candidates=utcEventCandidates(at,[official],[rolling]);
  const daily=candidates.find(p=>p.kind==='daily'),weekly=candidates.find(p=>p.kind==='weekly');
  const data=new Map([[C.periods+'/'+daily.id,{id:daily.id,trackId:official}],
    [C.archives+'/w_20260907',{entries:[{rp:123}],archived:true}]]);
  if(existing)data.set(C.periods+'/'+weekly.id,{id:weekly.id,trackId:official,targetMs:12345});
  const calls=[],lookups=[],writes=[];
  const request=async(path,init)=>{
    calls.push(path);
    if(path===':beginTransaction')return {transaction:'fixture'};
    if(path===':rollback')return {};
    if(path===':commit') {
      const body=JSON.parse(init.body);assert.equal(body.transaction,'fixture');
      for(const write of body.writes) {
        const key=write.update.name.split('/documents/')[1];writes.push(key);
        data.set(key,eventDecode({mapValue:{fields:write.update.fields}}));
      }
      return {};
    }
    const key=path.slice(1).split('?')[0];
    return data.has(key)?{name:'projects/polytrack-052/databases/(default)/documents/'+key,
      updateTime:'2026-09-14T00:00:00Z',fields:eventEncode(data.get(key)).mapValue.fields}:null;
  };
  return {data,calls,lookups,writes,weekly,daily,run:()=>eventWorkerMaintenance({EVENTS_ENABLED:'true',
    EVENT_WEEKLY_TRACK_ID:rolling,EVENT_CAPACITY_JSON:JSON.stringify(capacity)},
    {request,officialIds:[official],allIds:[rolling,official],at,now:()=>at,
      targetForTrack:async id=>{lookups.push(id);return target;}})};
}
test('daily and weekly stay in disjoint registries across dates',()=>{
 for(let day=1;day<=30;day++) {
  const candidates=utcEventCandidates(Date.UTC(2026,8,day),[official],[rolling,official]);
  assert.equal(candidates.find(p=>p.kind==='daily').trackId,rolling);
  assert.equal(candidates.find(p=>p.kind==='weekly').trackId,official);
 }
 const config=JSON.parse(fs.readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
 assert.equal(config.vars.EVENT_WEEKLY_TRACK_ID,undefined);
});

test('official weekly waits for legitimate target and never falls back to another track',async()=>{
  for(const target of [null,0,NaN,300001]) {
    const f=fixture(target),result=await f.run();
    assert.equal(result.created,null);assert.equal(result.reason,'no_verified_target_in_bounded_scan');
    assert.deepEqual(f.lookups,[official]);assert.equal(f.data.has(C.periods+'/'+f.weekly.id),false);
    assert.ok(f.writes.every(p=>p.startsWith(C.cursors+'/')));assert.ok(f.calls.length<=8);
  }
});
test('official weekly uses trusted lookup target and preserves archive and normal score collections',async()=>{
  const f=fixture(21000),archive=structuredClone(f.data.get(C.archives+'/w_20260907'));
  const result=await f.run();assert.equal(result.created,f.weekly.id);
  const period=f.data.get(C.periods+'/'+f.weekly.id);
  assert.equal(period.trackId,official);assert.equal(period.targetMs,21000);assert.equal(period.maxRp,500);
  assert.equal(period.kind,'weekly');assert.equal(period.eligibility,'best-submitted-during-period');
  assert.deepEqual(f.data.get(C.archives+'/w_20260907'),archive);
  assert.ok(!f.writes.some(p=>p.startsWith(C.archives+'/')||p.startsWith(C.canonical+'/')||p.startsWith(C.totals+'/')));
  f.lookups.length=0;f.writes.length=0;await f.run();assert.deepEqual(f.lookups,[]);assert.deepEqual(f.writes,[]);
});
test('new featured configuration never changes an existing weekly period',async()=>{
  const f=fixture(19997,true),before=structuredClone([...f.data]);await f.run();
  assert.deepEqual([...f.data],before);assert.deepEqual(f.lookups,[]);assert.deepEqual(f.writes,[]);
});
