import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
function section(start,end){const i=source.indexOf(start);assert.ok(i>=0);const j=source.indexOf(end,i);assert.ok(j>i);return source.slice(i,j);}
function finishContext(rows,local=[]){
  const accountId='me';
  const context=vm.createContext({Date,Math,Number,String,Boolean,Array,Map,
    trackId:'summer1',hinted:{accountId},guestAccountId:accountId,body:'',urlObj:new URL('https://example.test/leaderboard'),
    eventUi:null,getTrackEntries:async()=>rows,readTrackSnapshotCache:()=>({entries:rows,complete:true}),
    accountIdFromPayload:async()=>accountId,log:()=>{},ensurePersonalFilters:async()=>{},
    applyPersonalFilters:entries=>({rows:entries}),canonicalRaceTimeMs:row=>row?.timeMs||0,
    readLocalRaceRows:()=>local,safeRecordingId:id=>id,buildRecordingId:()=>99,nextUploadId:()=>99,
    mirrorRaceResult:async()=>{local.push({accountId,trackId:'summer1',timeMs:55,frames:55,uploadId:99});return {accountId,timeMs:55,uploadId:99};}});
  vm.runInContext(section('  function localTrackDisplayEntries(', '  function computeTrackTopEntries('),context);
  const start=source.indexOf('        const preEntries = eventUi?.isEntered(trackId)');
  const end=source.indexOf('\n      }\n      hinted.userTokenHash',start);
  assert.ok(start>0&&end>start);
  vm.runInContext('async function finish(){'+source.slice(start,end)+'\n}',context);
  return context;
}

test('first snapshot finish supplies native animation from last place to new position',async()=>{
  const rows=Array.from({length:200},(_,i)=>({accountId:'r'+i,timeMs:(i+1)*10,rank:i+1}));
  const result=await finishContext(rows).finish();
  assert.equal(result.previousPosition,200);assert.equal(result.newPosition,6);
});
test('repeat local PB animates from previous local position, not snapshot last place',async()=>{
  const rows=Array.from({length:20},(_,i)=>({accountId:'r'+i,timeMs:(i+1)*10,rank:i+1}));
  const result=await finishContext(rows,[{accountId:'me',trackId:'summer1',timeMs:95,frames:95,uploadId:98}]).finish();
  assert.equal(result.previousPosition,10);assert.equal(result.newPosition,6);
});
test('empty known leaderboard finishes at first without invalid positions',async()=>{
  const result=await finishContext([]).finish();
  assert.equal(result.previousPosition,1);assert.equal(result.newPosition,1);
});
test('published verified PB is retained until a genuinely faster local PB exists',()=>{
  const design={version:7,theme:'crimson'};
  const published={accountId:'me',timeMs:55,frames:55,runVerified:true,profileCosmetics:design};
  const local=[{accountId:'me',trackId:'summer1',timeMs:55,frames:55,uploadId:98}];
  const context=finishContext([published],local);
  assert.equal(context.localTrackDisplayEntries('summer1',[published],'me')[0].runVerified,true);
  local.push({accountId:'me',trackId:'summer1',timeMs:45,frames:45,uploadId:99});
  const rows=context.localTrackDisplayEntries('summer1',[published],'me');
  assert.equal(rows.length,1);assert.equal(rows[0].localPending,true);assert.equal(rows[0].runVerified,false);
  assert.equal(rows[0].profileCosmetics,design);assert.equal(rows[0].timeMs,45);
});
test('track row conversion keeps published cosmetic designs without profile reads',()=>{
  const design={version:7,theme:'crimson'};
  const context=vm.createContext({Map,Array,String,Number,Math,
    safePositiveInt:(x,f)=>Number(x)||f,canonicalRaceTimeMs:row=>row.timeMs,
    safeDisplayName:x=>x,getLastKnownName:()=>'',__pt062NormalizeStyle:x=>x,__pt062GetRememberedStyle:()=>'',
    safeRecordingId:id=>id,extractCarId:()=>'',normalizeCarColorId:x=>x,pbTimestamp:()=>1,buildRecordingId:()=>99});
  vm.runInContext(section('  function computeTrackTopEntries(', '  async function hydrateDisplayNames('),context);
  const rows=context.computeTrackTopEntries([{accountId:'other',trackId:'summer1',timeMs:10,frames:10,profileCosmetics:design}], 'summer1');
  assert.equal(rows[0].profileCosmetics,design);
});
test('native snapshot and local rows identify only the current racer as self',()=>{
  const context=vm.createContext({Date,String,Number,Array,Boolean,
    safePositiveInt:(x,f)=>Number(x)||f,canonicalRaceTimeMs:row=>row.timeMs,buildRecordingId:()=>1,
    safeRecordingId:id=>id,getLastKnownName:()=>'',__pt062NormalizeStyle:x=>x,__pt062GetRememberedStyle:()=>'',
    pbTimestamp:()=>1,normalizeCarColorId:x=>x,extractCarId:()=>'',activeRankedAccountId:()=> 'me'});
  vm.runInContext(section('  function enrichLegacyLeaderboardEntries(', '\n  function '),context);
  const rows=context.enrichLegacyLeaderboardEntries([{userId:'other',timeMs:10},{accountId:'me',timeMs:20,localPending:true}]);
  assert.equal(rows[0].isSelf,false);assert.equal(rows[1].isSelf,true);
});
test('missing cosmetic lookup preserves native verified state; local PB stays pending',()=>{
  const make=(verified,status)=>{const classes=new Set(verified?['verified']:['pending']);const label={textContent:''};const icon={getAttribute:()=>'',hidden:false};return {dataset:status?{sqRunStatus:status}:{},childNodes:[],classList:{contains:x=>classes.has(x),toggle:(x,on)=>on?classes.add(x):classes.delete(x)},querySelector:x=>x==='img'?icon:label,getAttribute:()=>'',setAttribute:()=>{},label,classes};};
  const verified=make(true),local=make(false,'local'),waiting=make(false);
  const context=vm.createContext({document:{querySelectorAll:()=>[verified,local,waiting]},Node:{TEXT_NODE:3},Array});
  vm.runInContext(section('  function syncIntegrityStateLabels(', '\n  let nativeDecorationLookupCache'),context);
  context.syncIntegrityStateLabels();
  assert.equal(verified.classes.has('verified'),true);assert.equal(verified.label.textContent,'');
  assert.equal(local.label.textContent,'LOCAL PB');assert.equal(waiting.label.textContent,'WAITING');
});
