const fs=require('node:fs'),vm=require('node:vm'),test=require('node:test'),assert=require('node:assert/strict');
const source=fs.readFileSync(require('node:path').join(__dirname,'../polytrack_062_patch.js'),'utf8');
const start=source.indexOf('  async function loadNativeRecordings(ids){'),end=source.indexOf('  function invalidateNativePartialReplay(',start);
assert.ok(start>0&&end>start);
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({track='',cache=new Map(),read}={}){
  const calls=[],remembered=[],gates=new Map();let active=0,maxActive=0;
  const context={nativeRecordingEpoch:0,currentTrackLoadState:{trackId:track},nativeRecordingMemory:cache,nativeRecordingRetryAt:new Map(),
    readRecordingStore:ids=>ids.map(()=>null),cachedNativeRecording:row=>row,
    rememberNativeRecording:(id,row)=>remembered.push([id,row]),publicSnapshotReaderPromise:Promise.resolve({recordingPlayback:async entry=>({recording:'bound-'+entry.uploadId})}),
    readPublicSnapshotBackup:async(kind,id)=>{
      calls.push([kind,id]);if(read)return read(kind,id);
      active++;maxActive=Math.max(active,maxActive);const gate=deferred();gates.set(Number(id),gate);
      try{return await gate.promise;}finally{active--;}
    }};
  vm.createContext(context);vm.runInContext(source.slice(start,end),context);
  return {context,calls,gates,remembered,load:context.loadNativeRecordings,maxActive:()=>maxActive};
}
test('a slow replay does not leave free slots idle; concurrency stays at four and order is preserved',async()=>{
  const f=fixture(),ids=Array.from({length:10},(_,i)=>i+1),pending=f.load(ids);
  assert.deepEqual(f.calls.map(row=>Number(row[1])),[1,2,3,4]);
  for(const id of [2,3,4])f.gates.get(id).resolve({recording:String(id)});
  await turn();assert.deepEqual(f.calls.map(row=>Number(row[1])),[1,2,3,4,5,6,7]);
  for(const id of [5,6,7])f.gates.get(id).resolve({recording:String(id)});
  await turn();assert.equal(f.calls.length,10);
  for(const id of [1,8,9,10])f.gates.get(id).resolve({recording:String(id)});
  assert.deepEqual(Array.from(await pending,row=>row.recording),ids.map(String));assert.equal(f.maxActive(),4);
});
test('one shared board lookup still binds every replay independently',async()=>{
  const track='b'.repeat(64),ids=[1,2,3,4,5,6,7,8,9,10];
  const f=fixture({track,read:async kind=>kind==='track'?{entries:ids.map(uploadId=>({trackId:track,uploadId}))}:{recording:'unbound'}});
  assert.deepEqual(Array.from(await f.load(ids),row=>row.recording),ids.map(id=>'bound-'+id));
  assert.equal(f.calls.filter(([kind])=>kind==='track').length,1);
  assert.equal(f.calls.filter(([kind])=>kind==='recording').length,10);
});
test('navigation cancels queued work and cannot cache stale replays',async()=>{
  const f=fixture(),pending=f.load([1,2,3,4,5,6]);f.context.nativeRecordingEpoch++;
  for(const [id,gate]of f.gates)gate.resolve({recording:String(id)});
  assert.deepEqual(Array.from(await pending),[null,null,null,null,null,null]);assert.equal(f.calls.length,4);assert.equal(f.remembered.length,0);
});
test('a rejected load stops queued work without swallowing the error',async()=>{
  const f=fixture(),pending=f.load([1,2,3,4,5]);f.gates.get(1).reject(Error('offline'));
  await assert.rejects(pending,/offline/);
  for(const [id,gate]of f.gates)if(id!==1)gate.resolve(null);
  await turn();assert.equal(f.calls.length,4);
});
test('cached and empty selections need no snapshot requests',async()=>{
  const row={recording:'cached'},f=fixture({cache:new Map([[1,row]])});
  assert.deepEqual(Array.from(await f.load([1])),[row]);assert.equal((await f.load([])).length,0);assert.equal(f.calls.length,0);
});
