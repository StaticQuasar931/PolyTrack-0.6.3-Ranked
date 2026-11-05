const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../polytrack_062_patch.js'),'utf8');
const start=source.indexOf('  async function flushPendingCosmeticPublishes(');
const end=source.indexOf('  async function saveRankedProfileCosmetics(',start);
assert.ok(start>0&&end>start);
function harness({replaceAt='',failCommit=false,foreignOwner=false,switchAccount=false,retry=false,ackWritable=true}={}){
  const draft=id=>({accountId:'account',ownerUid:'uid',draftId:id,cosmetics:{theme:id},nextAttemptAt:0});
  let pending=draft('old'),active='account',replaced=false;
  const cost={reads:0,writes:0,jobs:0,worker:0,ownership:0},committed=[],acks=[];
  const replace=()=>{if(!replaced){pending=draft('new');replaced=true;}};
  let user={uid:'uid',getIdToken:async()=> 'offline-token'},clock=1000000;
  const timers=new Map();let timerId=0;
  const context=vm.createContext({
    navigator:{onLine:true},Date:{now:()=>clock},Promise,
    clearTimeout:id=>timers.delete(id),setTimeout:(fn,delay)=>{const id=++timerId;timers.set(id,{fn,delay});return id;},
    firebaseQuotaPaused:()=>false,
    activeRankedAccountId:()=>active,
    readCosmeticPublishQueue:()=>({entries:pending?{account:pending}:{}}),
    cosmeticPublishIdentityMatches:(item,account,uid)=>!!item&&item.accountId===account&&item.ownerUid===uid,
    db:async()=>({collection:()=>({doc:()=>({set:async()=>{cost.jobs++;}})})}),
    window:{firebase:{auth:()=>({currentUser:user}),firestore:{FieldValue:{serverTimestamp:()=> 'server'}}}},
    runFirebaseTransaction:async(_db,callback)=>{
      if(replaceAt==='before-read')replace();
      const attempt=async()=>{
        const staged=[];
        const result=await callback({
          get:async()=>{cost.reads++;if(replaceAt==='during-read')replace();if(switchAccount)active='other';return {exists:true,data:()=>({ownerUid:foreignOwner?'foreign':'uid'})};},
          set:(_ref,value)=>staged.push(value)
        });
        return {result,staged};
      };
      let attemptResult=await attempt();
      if(retry&&committed.length===0&&!replaced){replace();attemptResult=await attempt();}
      if(failCommit)throw Error('offline commit failure');
      cost.writes+=attemptResult.staged.length;committed.push(...attemptResult.staged);
      return attemptResult.result;
    },
    assertCloudOwner:(_account,uid,data)=>{cost.ownership++;if(data.ownerUid!==uid)throw Error('foreign owner');},
    transitionCosmeticPublishQueue:action=>{if(action.type==='ack'){acks.push(action.draftId);if(!ackWritable)return null;if(pending?.draftId===action.draftId)pending=null;}return {entries:pending?{account:pending}:{}};},
    readCosmeticDirectory:()=>({entries:{}}),writeCosmeticDirectory:()=>{},
    rankedBrokerUrl:()=> 'https://offline.invalid',rankedEdgeAvailable:()=>true,
    rankedFetch:async()=>{cost.worker++;return {status:200,ok:true,json:async()=>({accepted:true})};},
    withTimeout:promise=>promise,clearRankedEdgeFailure:()=>{},markRankedEdgeUnavailable:()=>{},
    noteFirebaseQuota:()=>{},log:()=>{},showCloudOwnerConflict:()=>{},
    fetch:()=>{throw Error('NO_NETWORK_ALLOWED');}
  });
  const extract=name=>{const at=source.indexOf('  function '+name+'(');assert.ok(at>0);return source.slice(at,source.indexOf('\n  }',at)+4);};
  vm.runInContext('let cosmeticPublishPromise=null,cosmeticPublishTimer=0;\n'+
    ['cosmeticPublishBackoff','matchingCosmeticCommitReceipt','scheduleCosmeticPublishRetry'].map(extract).join('\n')+'\n'+
    source.slice(start,end)+'\nthis.flush=flushPendingCosmeticPublishes;',context);
  return {run:options=>context.flush(options),cost,committed,acks,pending:()=>pending,context,timers,
    advance:ms=>{clock+=ms;},setAckWritable:value=>{ackWritable=value;},
    setDraft:id=>{pending=draft(id);},setAccount:value=>{active=value;},
    setUser:value=>{user=value;},receipts:()=>context.flush.receipts};
}
for(const replaceAt of ['before-read','during-read'])test('superseded cosmetic draft avoids obsolete writes: '+replaceAt,async()=>{
  const h=harness({replaceAt}),result=await h.run();
  assert.equal(result.published,true);assert.equal(result.queued,false);
  assert.equal(h.cost.reads,replaceAt==='before-read'?1:2);
  assert.equal(h.cost.writes,1);assert.equal(h.cost.jobs,1);assert.equal(h.cost.worker,1);
  assert.deepEqual(h.committed.map(row=>row.profileCosmetics.theme),['new']);
  assert.deepEqual(h.acks,['new']);assert.equal(h.pending(),null);
});
test('transaction retry cannot commit an already superseded draft',async()=>{
  const h=harness({retry:true}),result=await h.run();
  assert.equal(result.published,true);assert.equal(h.cost.reads,2);assert.equal(h.cost.writes,1);
  assert.deepEqual(h.committed.map(row=>row.profileCosmetics.theme),['new']);assert.deepEqual(h.acks,['new']);
});
test('unchanged draft retains ownership read, public write and optional follow-ups',async()=>{
  const h=harness(),result=await h.run();assert.equal(result.published,true);
  assert.deepEqual(h.cost,{reads:1,writes:1,jobs:1,worker:1,ownership:1});assert.deepEqual(h.acks,['old']);
});
for(const option of ['failCommit','foreignOwner','switchAccount'])test(option+' cannot acknowledge or publish',async()=>{
  const h=harness({[option]:true}),result=await h.run();assert.equal(result.published,false);
  assert.equal(h.cost.writes,0);assert.equal(h.cost.jobs,0);assert.equal(h.cost.worker,0);
  assert.deepEqual(h.acks,[]);assert.ok(h.pending());
});

test('failed local acknowledgement retries local storage only, even when forced',async()=>{
  const h=harness({ackWritable:false});
  const first=await h.run();
  assert.equal(first.published,true);assert.equal(first.queued,true);assert.equal(first.ackPending,true);
  const cost={...h.cost};
  assert.deepEqual(cost,{reads:1,writes:1,jobs:1,worker:1,ownership:1});
  assert.equal([...h.timers.values()][0].delay,15000);
  await h.run({force:true});assert.equal(h.acks.length,1);
  for(const delay of [15000,60000,300000,900000,3600000,3600000]){
    h.advance(delay);await h.run();assert.deepEqual(h.cost,cost);
    assert.ok([...h.timers.values()][0].delay>0);
    assert.ok([...h.timers.values()][0].delay<=3600000);
  }
  h.setAckWritable(true);h.advance(3600000);
  const result=await h.run();assert.equal(result.published,true);assert.equal(result.queued,false);
  assert.equal(h.pending(),null);assert.equal(h.receipts().size,0);assert.equal(h.timers.size,0);
  assert.deepEqual(h.cost,cost);
});

test('replacement draft cannot inherit a committed draft receipt',async()=>{
  const h=harness({ackWritable:false});await h.run();h.setDraft('replacement');h.setAckWritable(true);
  await h.run();assert.equal(h.cost.reads,2);assert.equal(h.cost.writes,2);
  assert.equal(h.committed.at(-1).profileCosmetics.theme,'replacement');assert.equal(h.pending(),null);
});

test('account and auth-session changes cannot acknowledge using an old receipt',async()=>{
  const h=harness({ackWritable:false});await h.run();h.advance(15000);h.setAccount('other');
  const result=await h.run();assert.equal(result.published,false);assert.equal(h.acks.length,1);
  h.setAccount('account');h.setUser({uid:'uid',getIdToken:async()=> 'new-session'});h.setAckWritable(true);
  await h.run();assert.equal(h.cost.reads,2);assert.equal(h.cost.writes,2);
});

test('commit failure never creates a receipt or claims publication',async()=>{
  const h=harness({failCommit:true,ackWritable:false});const result=await h.run();
  assert.equal(result.published,false);assert.equal(h.receipts()?.size||0,0);
});

test('cosmetic receipts remain bounded across accounts',async()=>{
  const h=harness({ackWritable:false});await h.run();
  for(let i=0;i<20;i++)h.receipts().set('stale-'+i,{});
  h.setDraft('replacement');await h.run();assert.ok(h.receipts().size<=8);
});
