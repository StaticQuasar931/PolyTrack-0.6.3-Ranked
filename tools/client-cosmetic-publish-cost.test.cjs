const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../polytrack_062_patch.js'),'utf8');
const start=source.indexOf('  async function flushPendingCosmeticPublishes(');
const end=source.indexOf('  async function saveRankedProfileCosmetics(',start);
assert.ok(start>0&&end>start);
function harness({replaceAt='',failCommit=false,foreignOwner=false,switchAccount=false,retry=false}={}){
  const draft=id=>({accountId:'account',ownerUid:'uid',draftId:id,cosmetics:{theme:id},nextAttemptAt:0});
  let pending=draft('old'),active='account',replaced=false;
  const cost={reads:0,writes:0,jobs:0,worker:0,ownership:0},committed=[],acks=[];
  const replace=()=>{if(!replaced){pending=draft('new');replaced=true;}};
  const user={uid:'uid',getIdToken:async()=> 'offline-token'};
  const context=vm.createContext({
    navigator:{onLine:true},Date,Promise,
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
    transitionCosmeticPublishQueue:action=>{if(action.type==='ack'){acks.push(action.draftId);if(pending?.draftId===action.draftId)pending=null;}},
    readCosmeticDirectory:()=>({entries:{}}),writeCosmeticDirectory:()=>{},
    rankedBrokerUrl:()=> 'https://offline.invalid',rankedEdgeAvailable:()=>true,
    rankedFetch:async()=>{cost.worker++;return {status:200,ok:true,json:async()=>({accepted:true})};},
    withTimeout:promise=>promise,clearRankedEdgeFailure:()=>{},markRankedEdgeUnavailable:()=>{},
    noteFirebaseQuota:()=>{},cosmeticPublishBackoff:()=>15000,log:()=>{},
    showCloudOwnerConflict:()=>{},scheduleCosmeticPublishRetry:()=>{},
    fetch:()=>{throw Error('NO_NETWORK_ALLOWED');}
  });
  vm.runInContext('let cosmeticPublishPromise=null;\n'+source.slice(start,end)+'\nthis.flush=flushPendingCosmeticPublishes;',context);
  return {run:()=>context.flush(),cost,committed,acks,pending:()=>pending};
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
