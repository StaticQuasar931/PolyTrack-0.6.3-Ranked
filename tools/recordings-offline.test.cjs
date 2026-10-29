const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const test=require('node:test');
const assert=require('node:assert/strict');

const source=fs.readFileSync(path.join(__dirname,'..','polytrack_062_patch.js'),'utf8');

function extract(name){
  const start=source.search(new RegExp('^  (?:async )?function '+name+'\\(','m'));
  assert.ok(start>=0,name);
  const bodyStart=source.indexOf('{',start);
  let depth=0;
  for(let index=bodyStart;index<source.length;index++){
    if(source[index]==='{')depth++;
    else if(source[index]==='}'&&--depth===0)return source.slice(start,index+1);
  }
  throw Error('Could not extract '+name);
}

function harness(localRows,readSnapshot=async()=>null){
  let dbCalls=0;
  const context={
    Map,Promise,nativeRecordingEpoch:0,currentTrackLoadState:{trackId:''},playbackWorkerBridgePromise:Promise.resolve(null),nativeRecordingMemory:new Map(),nativeRecordingRequests:new Map(),nativeRecordingRetryAt:new Map(),rememberNativeRecording:()=>{},noteFirebaseQuota:()=>{},
    readRecordingStore:ids=>ids.map(id=>localRows.get(id)||null),
    normalizeReplayPayloadString:value=>String(value),
    safePositiveInt:(value,fallback)=>Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):fallback,
    __pt062NormalizeStyle:value=>value||'default-style',
    readPublicSnapshotBackup:readSnapshot,
    getDefaultCarStyle:()=> 'default-style',
    safeRecordingId:value=>Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):null,
    canonicalRaceTimeMs:row=>Number(row.timeMs)||0,
    normalizeCarColorId:value=>value||'default-colors',
    cleanCarId:value=>value||'',
    COLLECTIONS:{raceResults:'race-results'},
    log:()=>{},
    db:async()=>{dbCalls++;throw Error('offline');}
  };
  vm.createContext(context);
  vm.runInContext(extract('cachedNativeRecording')+'\n'+extract('loadNativeRecordings')+'\n'+extract('readNativeRecordings'),context);
  return {read:context.readNativeRecordings,dbCalls:()=>dbCalls,context};
}

test('all cached native recordings bypass an unavailable database',async()=>{
  const local=new Map([[7,{recording:'cached',frames:123,verifiedState:0,carStyle:'style'}]]);
  const fixture=harness(local),rows=await fixture.read([7]);
  assert.equal(fixture.dbCalls(),0);
  assert.deepEqual(JSON.parse(JSON.stringify(rows)),[{recording:'cached',frames:123,verifiedState:0,playbackPending:false,carStyle:'style'}]);
});

test('mixed offline recording batches preserve cached rows and leave only misses null',async()=>{
  const local=new Map([[7,{recording:'cached',frames:123,verifiedState:0,carStyle:'style'}]]);
  const fixture=harness(local),rows=await fixture.read([7,8]);
  assert.equal(fixture.dbCalls(),0);
  assert.deepEqual(JSON.parse(JSON.stringify(rows)),[{recording:'cached',frames:123,verifiedState:0,playbackPending:false,carStyle:'style'},null]);
  assert.equal(rows[0].verifiedState,0);
});
test('saved replay snapshot fills an offline cache miss without querying the database',async()=>{
  const saved={recording:'snapshot-replay',frames:456,verifiedState:0,carStyle:'snapshot-style'};let snapshotReads=0;
  const fixture=harness(new Map(),async(kind,id)=>{assert.equal(kind,'recording');assert.equal(id,'8');snapshotReads++;return saved;});
  const rows=await fixture.read([8]);
  assert.equal(snapshotReads,1);assert.equal(fixture.dbCalls(),0);
  assert.deepEqual(JSON.parse(JSON.stringify(rows)),[{...saved,playbackPending:false}]);
});

test('repeated unavailable recording clicks never query the database',async()=>{
  const fixture=harness(new Map());await fixture.read([8]);await fixture.read([8]);
  assert.equal(fixture.dbCalls(),0);
});

test('downloaded snapshot replay is reused without another snapshot or database query',async()=>{
  const fixture=harness(new Map()),ctx=fixture.context;let reads=0;
  ctx.readPublicSnapshotBackup=async()=>{reads++;return{recording:'recording',frames:100};};
  ctx.rememberNativeRecording=(id,row)=>ctx.nativeRecordingMemory.set(id,row);
  const first=await fixture.read([8]);await fixture.read([8]);assert.equal(reads,1);assert.equal(first[0].recording,'recording');assert.equal(fixture.dbCalls(),0);
});
