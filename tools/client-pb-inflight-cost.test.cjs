const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {createRequire}=require('node:module');

// Reuse only the offline fixture definitions, without registering its tests.
const fixturePath=path.join(__dirname,'pb-exact-confirmation.test.cjs');
const fixtureSource=fs.readFileSync(fixturePath,'utf8');
const end=fixtureSource.indexOf("test('a committed exact PB");
assert.ok(end>0);
const fixture=vm.createContext({require:createRequire(fixturePath),__dirname,
  fetch:()=>{throw Error('NO_NETWORK_ALLOWED');}});
vm.runInContext(fixtureSource.slice(0,end)+'\nthis.make=mirrorHarness;this.makePb=pb;',fixture);

function harness({cloud=fixture.makePb()}={}){
  const h=fixture.make({cloud,publicationFails:false}),c=h.context;
  let user={uid:'uid'},active='a'.repeat(64),fail=false,gate=null;
  const cost={transactions:0,reads:0,activity:0,notifications:0,previews:0};
  c.window.firebase.auth=()=>({currentUser:user});
  c.activeRankedAccountId=()=>active;
  c.recordDailyActivity=()=>{cost.activity++;return null;};
  let upload=0;c.nextUploadId=()=>++upload;
  c.sendRankedNotification=async()=>{cost.notifications++;};
  c.syncExactCarPreview=async()=>{cost.previews++;};
  const original=c.runFirebaseTransaction;
  c.runFirebaseTransaction=async(db,callback)=>{
    cost.transactions++;
    if(gate)await gate;
    if(fail){fail=false;throw Error('offline transaction failure');}
    return original(db,tx=>callback({...tx,get:ref=>{cost.reads++;return tx.get(ref);}}));
  };
  const run=(extra={},guard=null)=>c.mirrorRaceResult('fixture',{
    accountId:'a'.repeat(64),trackId:'b'.repeat(64),timeMs:1000,frames:1000,
    recording:'local-replay',nickname:'Racer',carStyle:'style',...extra},guard);
  return {h,c,cost,run,advance:h.advance,setUser:value=>{user=value;},setAccount:value=>{active=value;},
    failNext:()=>{fail=true;},hold:()=>{let release;gate=new Promise(resolve=>{release=resolve;});return ()=>{gate=null;release();};}};
}

test('simultaneous exact PBs share cloud reads but retain both finish activities',async()=>{
  const f=harness(),results=await Promise.all([f.run(),f.run()]);
  assert.equal(f.cost.transactions,1);assert.equal(f.cost.reads,2);assert.equal(f.cost.activity,2);
  assert.equal(f.h.writes.length,0);assert.ok(results.every(row=>row.cloudConfirmed));
  assert.equal(f.c.mirrorRaceResult.cloudState.pending.size,0);
  await f.run();assert.equal(f.cost.reads,2);assert.equal(f.cost.activity,3);
});

test('fresh simultaneous identical improvements commit and notify only once',async()=>{
  const f=harness({cloud:null});const results=await Promise.all([f.run(),f.run()]);
  assert.ok(results.every(row=>row.saved&&row.cloudConfirmed));
  assert.equal(f.cost.transactions,1);assert.equal(f.cost.reads,2);assert.equal(f.h.writes.length,2);
  assert.equal(f.cost.notifications,1);assert.equal(f.cost.previews,1);assert.equal(f.cost.activity,2);
});

for(const [field,value] of [['recording','other-replay'],['timeMs',999],['frames',999],
  ['nickname','Other'],['carStyle','other-style'],['countryCode','US'],['trackId','c'.repeat(64)]]){
  test('different '+field+' does not share PB cloud work',async()=>{
    const f=harness();await Promise.all([f.run(),f.run({[field]:value})]);
    assert.equal(f.cost.transactions,2);assert.equal(f.cost.activity,2);
  });
}

test('different same-length replay is not suppressed after a completed submission',async()=>{
  const f=harness();await f.run();await f.run({recording:'other-replay'});
  assert.equal(f.cost.transactions,2);assert.equal(f.cost.activity,2);
});

test('a distinct improvement invalidates the prior completed receipt',async()=>{
  const f=harness();await f.run();await f.run({timeMs:999,frames:999});await f.run();
  assert.equal(f.cost.transactions,3);assert.equal(f.cost.activity,3);
});

test('failed shared work releases its slot and does not create a successful receipt',async()=>{
  const f=harness();f.failNext();const results=await Promise.all([f.run(),f.run()]);
  assert.equal(f.cost.transactions,1);assert.ok(results.every(row=>!row.saved&&!row.cloudConfirmed));
  assert.equal(f.c.mirrorRaceResult.cloudState.pending.size,0);
  assert.equal(f.c.mirrorRaceResult.cloudState.recent.size,0);
  assert.equal((await f.run()).cloudConfirmed,true);assert.equal(f.cost.transactions,2);
});

test('a waiting caller cannot inherit a result after its account changes',async()=>{
  const f=harness(),release=f.hold();
  const leader=f.run(),follower=f.run();
  while(f.cost.transactions===0)await Promise.resolve();
  await Promise.resolve();f.setAccount('d'.repeat(64));release();
  await leader;const result=await follower;
  assert.equal(result.cancelled,true);assert.equal(result.saved,false);assert.ok(!result.cloudConfirmed);
  assert.equal(f.c.mirrorRaceResult.cloudState.pending.size,0);
});

test('a new auth object with the same UID cannot share pending PB work',async()=>{
  const f=harness(),release=f.hold(),first=f.run();
  while(f.cost.transactions===0)await Promise.resolve();
  f.setUser({uid:'uid'});const second=f.run();
  while(f.cost.transactions<2)await Promise.resolve();
  release();await Promise.all([first,second]);assert.equal(f.cost.transactions,2);
  assert.equal(f.c.mirrorRaceResult.cloudState.pending.size,0);
});

test('reconciliation and a real finish do not share accounting or cloud work',async()=>{
  const f=harness();await Promise.all([f.run(),f.run({}, {accountId:'a'.repeat(64),ownerUid:'uid'})]);
  assert.equal(f.cost.transactions,2);assert.equal(f.cost.activity,1);
});

test('completed receipts expire and remain bounded',async()=>{
  const f=harness();await f.run();f.advance(4000);await f.run();assert.equal(f.cost.transactions,2);
  for(let i=0;i<40;i++)await f.run({nickname:'Racer '+i});
  assert.ok(f.c.mirrorRaceResult.cloudState.recent.size<=32);
  assert.ok(f.c.mirrorRaceResult.cloudState.latest.size<=32);
  assert.equal(f.c.mirrorRaceResult.cloudState.pending.size,0);
});

test('pending work stays bounded without dropping distinct submissions',async()=>{
  const f=harness(),release=f.hold();
  const work=Array.from({length:40},(_,i)=>f.run({nickname:'Racer '+i}));
  while(f.cost.transactions<40)await Promise.resolve();
  assert.equal(f.c.mirrorRaceResult.cloudState.pending.size,32);
  release();await Promise.all(work);
  assert.equal(f.cost.transactions,40);assert.equal(f.cost.activity,40);
  assert.equal(f.c.mirrorRaceResult.cloudState.pending.size,0);
});
