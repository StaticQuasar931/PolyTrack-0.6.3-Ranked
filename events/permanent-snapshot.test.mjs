import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {permanentRollingPolicy,permanentRollingReward,permanentRollingRunPresentation,preferPermanentRollingSource} from './client.mjs';
import {archivePeriodCounts} from './archive-view.mjs';
import {publishedEventAwardPresentation} from '../tools/event-award-presentation.mjs';

const source = fs.readFileSync(new URL('./client.mjs', import.meta.url), 'utf8');
const loadPermanentSource = source.slice(source.indexOf('  async function loadPermanent()'), source.indexOf('  async function loadCatalog('));
const trackId = 'fb769ac2ea77e8f19a21a9dd3071742f2342bd49c41e4748d7e8c7903d4f0778';

function fixture(value) {
  const context = {
    preferPermanentRollingSource,permanentRollingPolicy,permanentAcceptedSource:null,read:()=>null,permanent: null,
    permanentAt: 0,
    permanentFetching: null,
    cached: [],
    bridge: { readPermanent: async () => value },
    now: () => 500000,
    ROLLING_TRACK_ID: trackId,
    cacheWrite: (...args) => context.cached.push(args),
    STORE: 'events',
    tick() {}
  };
  return vm.runInNewContext(`(${loadPermanentSource.trim()})()`, context).then(() => context);
}

test('permanent snapshot binding rejects complete boards for another track or event kind', async () => {
  const base = { id: 'permanent-rolling-hills', kind: 'permanent', trackId, complete: true, entries: [], maxRp: 1001 };
  for (const invalid of [{ ...base, trackId: 'a'.repeat(64) }, { ...base, kind: 'weekly' }]) {
    const result = await fixture(invalid);
    assert.equal(result.permanent, null);
  }
});

test('permanent snapshot binding accepts the complete Rolling Hills board', async () => {
  const result = await fixture({ id: 'permanent-rolling-hills', kind: 'permanent', trackId, complete: true, entries: [], maxRp: 1001, sourceRevision: 1 });
  assert.equal(result.permanent.id, 'permanent-rolling-hills');
});

const V1='rolling-hills-live-verified-v1',V2='rolling-hills-pace-placement-v2';
const board=(change={})=>({id:'permanent-rolling-hills',kind:'permanent',trackId,complete:true,totalEntries:2,
 scoreVersion:V2,maxRp:10101,targetMs:10000,sourceRevision:1,entries:[
 {accountId:'a',timeMs:10000,rank:1,rp:10101,physicsVerified:true,replayIntegrityVerified:true},
 {accountId:'b',timeMs:11000,rank:2,rp:5050,physicsVerified:true,replayIntegrityVerified:true}],...change});
test('dual version loader accepts only exact policy/cap combinations without reweighting rows',async()=>{
 for(const value of [board(),board({scoreVersion:V1,maxRp:1001}),board({scoreVersion:undefined,maxRp:1001})]){
  const before=structuredClone(value),result=await fixture(value);assert.deepEqual(result.permanent,value);assert.deepEqual(value,before);
 }
 for(const change of [{scoreVersion:undefined},{scoreVersion:V1},{scoreVersion:'future-v3'},
  {maxRp:1001},{maxRp:'10101'},{maxRp:10102},{sourceComplete:false},{publicationPending:true}])
  assert.equal((await fixture(board(change))).permanent,null);
});
test('only explicit complete v2 totals metadata may advertise the new cap; hybrid totals outrank an older v1 board',()=>{
 const component={status:'complete',id:'permanent-rolling-hills',trackId,scoreVersion:V2,maxRp:10101};
 const total={complete:true,eventRpComplete:true,dynamicComponents:{permanentRollingHills:component}};
 assert.match(permanentRollingReward(null,total).text,/10,101/);
 for(const change of [{scoreVersion:undefined},{scoreVersion:V1},{maxRp:1001},{status:'pending'},{trackId:'wrong'}])
  assert.match(permanentRollingReward(null,{...total,dynamicComponents:{permanentRollingHills:{...component,...change}}}).text,/1,001/);
 assert.match(permanentRollingReward(null,{...total,eventRpComplete:false}).text,/1,001/);
 assert.match(permanentRollingReward(board({scoreVersion:V1,maxRp:1001}),total).text,/10,101/);
 assert.match(permanentRollingReward().text,/1,001/);
});
test('verified actual ERP is never recalculated from rank, field, cap or totals',()=>{
 const row={...board().entries[1],rp:1234,rank:1};
 const result=permanentRollingRunPresentation(row,board());
 assert.equal(result.text,'1,234 ERP');assert.equal(result.estimated,false);assert.equal(result.title,'ERP: 1,234');
 assert.equal(permanentRollingRunPresentation({...row,rp:0},board()).text,'0 ERP');
});
test('pending preview uses hybrid pace and competition rank only against complete explicit v2 and is never a verified award',()=>{
 const pending={accountId:'pending',timeMs:11000,pending:true,verified:false,eventRpEligible:false,verificationStatus:'waiting'};
 const before=structuredClone(pending),result=permanentRollingRunPresentation(pending,board());
 assert.equal(result.text,'Estimated '+Math.floor(10101*(10000/11000)**2/2**.75).toLocaleString('en-US')+' ERP if verified');
 assert.match(result.title,/^Estimated ERP: 4,963 if verified/);assert.equal(result.estimated,true);assert.match(result.title,/Not awarded yet/);
 assert.deepEqual(pending,before);
 for(const value of [null,board({scoreVersion:V1,maxRp:1001}),board({totalEntries:3}),board({ranksExact:false}),board({sourceComplete:false})]){
  const presentation=permanentRollingRunPresentation(pending,value);assert.equal(presentation.estimated,false);assert.equal(presentation.text,'ERP pending');
 }
 assert.equal(permanentRollingRunPresentation({...pending,reviewHold:true},board()).estimated,false);
});
test('permanent card uses published policy, earned run score and explicitly estimated pending preview',()=>{
 const start=source.indexOf('  function permanentCard('),end=source.indexOf('  function selectView(',start);
 for(const value of [board(),board({scoreVersion:V1,maxRp:1001})]){
  const pending={accountId:'a',timeMs:10000,pending:true,verified:false,eventRpEligible:false,verificationStatus:'waiting'};
  const render=vm.runInNewContext(source.slice(start,end)+';permanentCard;',{
   permanent:{...value,pendingPlaybacks:[pending]},PERMANENT_ROLLING:{id:value.id,kind:value.kind,trackId},
   permanentRollingPolicy,permanentRollingReward,permanentReward:()=>permanentRollingReward(value),permanentRollingRunPresentation,publishedEventAwardPresentation,
   archivePeriodCounts,bridge:{accountId:()=> 'a',thumbnail:()=> ''},time:String,escape:String,read:()=>null,STORE:'events',ROLLING_TRACK_ID:trackId});
  const html=render();assert.match(html,value.scoreVersion===V2?/up to 10,101/:/up to 1,001/);
  assert.match(html,/10,101 ERP/,'actual published award is retained even if it differs from the cap');
  assert.match(html,/ERP: 10,101/);
  if(value.scoreVersion===V2)assert.match(html,/Estimated 10,101 ERP if verified/);else assert.doesNotMatch(html,/Estimated/);
 }
});

test('hybrid estimates refuse missing or contradictory target, rank, time and field metadata',()=>{
 const pending={accountId:'pending',timeMs:11000,pending:true,verified:false,eventRpEligible:false,verificationStatus:'waiting'};
 for(const change of [{targetMs:undefined},{targetMs:9000},{targetMs:10000.5},{targetMs:'10000'},
   {entries:[{...board().entries[0],rank:2},board().entries[1]]},
   {entries:[board().entries[0],{...board().entries[1],timeMs:10000,rank:2}]}])
  assert.equal(permanentRollingRunPresentation(pending,board(change)).estimated,false);
 for(const change of [{rank:1},{timeMs:9000},{timeMs:11000.5},{timeMs:'11000'},{trackId:'wrong'}])
  assert.equal(permanentRollingRunPresentation({...pending,...change},board()).estimated,false);
 const tied=board({entries:[board().entries[0],{...board().entries[1],timeMs:10000,rank:1}]});
 const estimate=permanentRollingRunPresentation({...pending,timeMs:10000,rank:1},tied);
 assert.equal(estimate.text,'Estimated 10,101 ERP if verified');
});

test('accepted hybrid snapshot cannot be replaced or cached over by live v1 with a higher revision',async()=>{
 const snapshot=board({sourceRevision:1,updatedAt:123,_snapshotPackageAt:456,_publicBackup:true,capturedAt:789});
 const olderPolicy=board({scoreVersion:V1,maxRp:1001,sourceRevision:999,updatedAt:999999});
 for(const snapshotOnly of [false,true]){
  const c={permanent:snapshot,permanentAcceptedSource:snapshot,permanentAt:0,permanentFetching:null,
   permanentRollingPolicy,preferPermanentRollingSource,read:()=>null,now:()=>500000,ROLLING_TRACK_ID:trackId,
   bridge:{readPermanent:async()=>olderPolicy,snapshotOnly:()=>snapshotOnly},cacheWrite:()=>assert.fail('v1 downgrade cached'),tick(){},STORE:'events'};
  const before=structuredClone(snapshot);
  await vm.runInNewContext('('+loadPermanentSource.trim()+')()',c);
  assert.equal(c.permanent,snapshot);assert.deepEqual(c.permanent,before);
  assert.equal(c.permanent.updatedAt,123);assert.equal(c.permanent._snapshotPackageAt,456);assert.equal(c.permanent.capturedAt,789);
 }
});
test('hybrid totals alone block an older live board and remain preferred after source replacement',async()=>{
 const component={status:'complete',id:'permanent-rolling-hills',trackId,scoreVersion:V2,maxRp:10101,sourceRevision:1,updatedAt:123};
 const totals={complete:true,eventRpComplete:true,dynamicComponents:{permanentRollingHills:component},entries:[]};
 const legacy=board({scoreVersion:V1,maxRp:1001,sourceRevision:999});
 const c={permanent:null,permanentAcceptedSource:totals,permanentAt:0,permanentFetching:null,
  permanentRollingPolicy,preferPermanentRollingSource,read:()=>totals,now:()=>500000,ROLLING_TRACK_ID:trackId,
  bridge:{readPermanent:async()=>legacy},cacheWrite:()=>assert.fail('v1 board cached after v2 totals'),tick(){},STORE:'events'};
 await vm.runInNewContext('('+loadPermanentSource.trim()+')()',c);
 assert.equal(c.permanent,null);assert.equal(c.permanentAcceptedSource,totals);
 assert.match(permanentRollingReward(legacy,null,totals).text,/10,101/);
 assert.equal(preferPermanentRollingSource(totals,{...totals,dynamicComponents:{permanentRollingHills:{...component,scoreVersion:V1,maxRp:1001,sourceRevision:999}}}),totals);
});
test('hybrid upgrade outranks legacy revision but same-policy older revisions cannot replace snapshots',()=>{
 const legacy=board({scoreVersion:V1,maxRp:1001,sourceRevision:999});
 const hybrid=board({sourceRevision:2,updatedAt:123});
 assert.equal(preferPermanentRollingSource(legacy,hybrid),hybrid);
 assert.equal(preferPermanentRollingSource(hybrid,board({sourceRevision:1,updatedAt:999999})),hybrid);
 assert.equal(preferPermanentRollingSource(hybrid,board({sourceRevision:2,updatedAt:100})),hybrid);
});
