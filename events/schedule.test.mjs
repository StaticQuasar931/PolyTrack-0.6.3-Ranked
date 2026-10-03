import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {utcEventCandidates,scheduledCatalog} from './schedule.mjs';
import {utcEventCandidates as serverCandidates} from '../workers/ranked/src/events-runtime.js';
const registry=JSON.parse(fs.readFileSync(new URL('./rotation.json',import.meta.url),'utf8'));
test('browser and server share the same date rotation across UTC resets',()=>{
  for(let day=0;day<370;day++){
    const at=Date.UTC(2026,9,1)+day*86400000;
    assert.deepEqual(utcEventCandidates(at,registry.officialIds,registry.allIds),serverCandidates(at,registry.officialIds,registry.allIds));
    const [daily,weekly]=utcEventCandidates(at,registry.officialIds,registry.allIds);
    assert.equal(daily.endsAt-daily.startsAt,86400000);assert.equal(weekly.endsAt-weekly.startsAt,7*86400000);
    assert.equal(registry.officialIds.includes(daily.trackId),false);assert.ok(registry.officialIds.includes(weekly.trackId));
  }
});
test('published immutable periods override scheduled candidates until their exact reset',()=>{
  const at=Date.UTC(2026,9,3);const candidates=utcEventCandidates(at,registry.officialIds,registry.allIds);
  const published={periods:[{...candidates[0],trackId:'a'.repeat(64),targetMs:21000}],archives:[]};
  const now=scheduledCatalog(registry,published,at);
  assert.equal(now.periods.find(p=>p.kind==='daily').trackId,'a'.repeat(64));
  const next=scheduledCatalog(registry,published,candidates[0].endsAt);
  assert.notEqual(next.periods.find(p=>p.kind==='daily').id,candidates[0].id);
  assert.equal(next.periods.find(p=>p.kind==='daily').scheduleOnly,true);
  assert.equal(next.periods.find(p=>p.kind==='daily').targetMs,undefined);
});
test('bundled registry matches the server registry exactly',()=>{
  const source=fs.readFileSync(new URL('../workers/ranked/src/index.js',import.meta.url),'utf8');
  const ids=name=>JSON.parse(source.match(new RegExp('const '+name+' = new Set\\((\\[[^;]+\\])\\);'))[1]);
  assert.deepEqual(registry.officialIds,ids('OFFICIAL_IDS'));
  assert.deepEqual(registry.allIds,[...ids('OFFICIAL_IDS'),...ids('COMMUNITY_IDS')]);
});
