import createClientSourceRunner from './client-source-harness.cjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const runClientSource=createClientSourceRunner(source);
const extract=name=>{const start=source.search(new RegExp('^  (?:async )?function '+name+'\\(','m'));assert.ok(start>=0);return source.slice(start,source.indexOf('\n  }',start)+4);};
test('event fallback keeps newer loaded PBs and verification status without mixing rows',()=>{
 const c=vm.createContext({});runClientSource(extract('chooseEventReadValue'),c);
 const newer={period:{id:'daily',trackId:'track'},updatedAt:200,entries:[{accountId:'a',runVerified:true}],_eventLiveCheckedAt:250};
 const older={period:{id:'daily',trackId:'track'},updatedAt:100,entries:[{accountId:'b',runVerified:false}],_publicBackup:true};
 const kept=c.chooseEventReadValue(newer,older,'daily');assert.equal(kept.entries,newer.entries);assert.equal(kept._eventRefreshFailed,true);assert.equal(kept._eventLiveCheckedAt,250);
 const latest={...older,updatedAt:300,entries:[]};assert.equal(c.chooseEventReadValue(newer,latest,'daily'),latest,'a newer complete empty verdict may remove old racers');
 assert.throws(()=>c.chooseEventReadValue(newer,{...older,period:{id:'daily',trackId:'different'}},'daily'),/binding/);
});
test('failed event refresh neither disables normal Ranked nor repeatedly calls its edge during cooldown',async()=>{
 let now=1000000,calls=0,rankedFailures=0;const saved={period:{id:'daily',trackId:'track'},updatedAt:100,entries:[]};
 const c=vm.createContext({Date:{now:()=>now},eventCloudRetryAt:new Map(),snapshotOnlyForNewAccount:()=>false,readPublicSnapshotBackup:async()=>saved,rankedBrokerUrl:()=> 'https://example.test',AbortSignal,fetch:async()=>{calls++;throw Error('offline');},markRankedEdgeUnavailable:()=>rankedFailures++,log:()=>{},db:async()=>{throw Error('must not query Firebase');}});
 c.eventRequestSignal=milliseconds=>AbortSignal.timeout(milliseconds);
 runClientSource(extract('loadEventCloudRead'),c);
 await c.loadEventCloudRead('/v1/events/daily/snapshot','0.6.2_event_public','daily',true);now+=61000;
 await c.loadEventCloudRead('/v1/events/daily/snapshot','0.6.2_event_public','daily',true);assert.equal(calls,1);assert.equal(rankedFailures,0);
});

test('successful event checks are shared for five minutes instead of polled every minute',async()=>{
 let now=1000000,calls=0;
 const c=vm.createContext({Date:{now:()=>now},eventCloudCache:new Map(),eventCloudRequests:new Map(),eventCloudRetryAt:new Map(),
   loadEventCloudRead:async()=>{calls++;return {period:{id:'daily',trackId:'track'},entries:[],updatedAt:now};},noteFirebaseQuota:()=>{}});
 runClientSource(extract('chooseEventReadValue')+extract('eventCloudRead'),c);
 const read=()=>c.eventCloudRead('/v1/events/daily/snapshot','0.6.2_event_public','daily');
 await Promise.all(Array.from({length:8},read));assert.equal(calls,1);
 now+=61000;await read();assert.equal(calls,1,'reopening an event after a minute reuses its successful check');
 now+=5*60000;await read();assert.equal(calls,2,'fresh checks resume after the bounded TTL');
});
test('direct recovery coalesces requests and retains its five-minute budget across reloads',async()=>{
 let at=1000000,calls=0;const storage=new Map();let resolve;const gate=new Promise(r=>resolve=r),snapshot={exists:true,data:()=>({entries:[]})};
 const c=vm.createContext({window:{POLYTRACK_DIRECT_PUBLIC_READS:true},Date:{now:()=>at},directPublicReads:new Map(),COLLECTIONS:{leaderboardsTrack:'tracks',leaderboardsOverall:'overall'},readJsonStorage:(k,f)=>storage.get(k)||f,writeJsonStorage:(k,v)=>storage.set(k,v),noteDeveloperEvent:()=>{},noteFirebaseQuota:()=>{},db:async()=>({collection:()=>({doc:()=>({get:async()=>{calls++;await gate;return snapshot;}})})})});
 runClientSource(extract('readDirectPublicSnapshot'),c);const a=c.readDirectPublicSnapshot('tracks','a'),b=c.readDirectPublicSnapshot('tracks','a');resolve();assert.equal(await a,snapshot);assert.equal(await b,snapshot);assert.equal(calls,1);
 await c.readDirectPublicSnapshot('tracks','a');assert.equal(calls,1);c.directPublicReads.clear();await assert.rejects(c.readDirectPublicSnapshot('tracks','a'),/cooldown/);at+=300001;await c.readDirectPublicSnapshot('tracks','a');assert.equal(calls,2);
 await assert.rejects(c.readDirectPublicSnapshot('private-reports','a'),/Unsupported/);
});

test('public cloud recovery is disabled by default without touching Firebase or its budget',async()=>{
 let calls=0;const c=vm.createContext({window:{},COLLECTIONS:{leaderboardsTrack:'tracks',leaderboardsOverall:'overall'},db:()=>calls++});
 runClientSource(extract('readDirectPublicSnapshot'),c);
 await assert.rejects(c.readDirectPublicSnapshot('tracks','a'),/Direct public Firebase reads disabled/);assert.equal(calls,0);
});

test('official snapshot-only daily event has no live fallback even when missing or forced',async()=>{
 const start=Date.UTC(2026,9,27),period={id:'d_20261027',kind:'daily',trackId:'a'.repeat(64),startsAt:start,endsAt:start+86400000,maxRp:100};
 for(const force of [false,true])for(const available of [false,true]){
  let calls=0;const published=available?{period,entries:[],updatedAt:start}:null;
  const c=vm.createContext({Date:{now:()=>start+1000},encodeURIComponent,snapshotOnlyForNewAccount:()=>true,
   readPublicSnapshotBackup:async()=>published,readEventCatalog:async()=>({periods:[period]}),currentDailyEventPeriod:()=>period,
   readEventSnapshot:(value,p)=>value?.period===p,rankedFetch:async()=>{calls++;throw Error('must not call live backend');}});
  runClientSource(extract('loadEventCloudRead'),c);
  if(available)assert.equal(await c.loadEventCloudRead('/v1/events/'+period.id+'/snapshot','unused',period.id,force),published);
  else await assert.rejects(c.loadEventCloudRead('/v1/events/'+period.id+'/snapshot','unused',period.id,force),/Saved standings/);
  assert.equal(calls,0);
 }
});
test('event replay recovery never silently reads live data in official snapshot-only mode',async()=>{
 let calls=0;const c=vm.createContext({eventReplayRequests:new Map(),readPublicSnapshotBackup:async()=>null,
  snapshotOnlyForNewAccount:()=>true,compatibilityOnlineAllowed:true,rankedFetch:async()=>{calls++;throw Error('must not read live');}});
 runClientSource(extract('readEventReplay'),c);
 await assert.rejects(c.readEventReplay('kodub_1793102400000','a'.repeat(64)),/not in this snapshot/);
 assert.equal(calls,0);
});


test('missing packaged catalog never falls back to live services for an official client',async()=>{
 let calls=0;const c=vm.createContext({snapshotOnlyForNewAccount:()=>true,readEventCatalog:async()=>{throw Error('static unavailable');},readPublicSnapshotBackup:async()=>{calls++;},rankedFetch:async()=>{calls++;}});
 runClientSource(extract('loadEventCloudRead'),c);
 await assert.rejects(c.loadEventCloudRead('/v1/events/catalog','unused','catalog'),/Saved event catalog/);assert.equal(calls,0);
});


test('a bound official snapshot replaces legacy live cache as one whole board',()=>{
 const c=vm.createContext({snapshotOnlyForNewAccount:()=>true});runClientSource(extract('chooseEventReadValue'),c);
 const previous={period:{id:'period',trackId:'track'},updatedAt:999,entries:[{accountId:'old'}]},incoming={period:previous.period,updatedAt:10,_dataSource:'snapshot',entries:[]};
 assert.equal(c.chooseEventReadValue(previous,incoming,'period'),incoming);assert.equal(previous.entries.length,1);
});
