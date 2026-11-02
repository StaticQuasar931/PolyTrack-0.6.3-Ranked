const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../polytrack_062_patch.js'),'utf8').replace(/\r\n/g,'\n');
function section(begin,end){
  const first=source.indexOf(begin),last=source.indexOf(end,first);
  assert.ok(first>=0&&last>first,begin);
  return source.slice(first,last);
}
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function harness(){
  let at=1000000,active='acct',user={uid:'uid'},override='',moderationFailure=false,transactionFailure=false;
  let readGate=null,commitGate=null,claim=name=>name;
  const costs={profiles:0,moderation:0,writes:0,auth:0,quota:0,claims:0};
  const disk=new Map(),profiles=new Map();
  const database={
    collection:kind=>({doc:id=>({kind,id,get:async()=>{
      assert.equal(kind,'moderation');costs.moderation++;
      if(readGate){const gate=readGate;readGate=null;await gate.promise;}
      if(moderationFailure)throw Object.assign(new Error('quota'),{code:'resource-exhausted'});
      return {exists:!!override,data:()=>({active:true,replacement:override})};
    }})}),
    runTransaction:async callback=>{
      const staged=[];
      await callback({get:async ref=>{
        costs.profiles++;
        if(readGate){const gate=readGate;readGate=null;await gate.promise;}
        const data=profiles.get(ref.id);
        return {exists:!!data,data:()=>data};
      },set:(ref,data)=>staged.push({ref,data})});
      if(commitGate){const gate=commitGate;commitGate=null;await gate.promise;}
      if(transactionFailure)throw new Error('commit unavailable');
      for(const {ref,data} of staged){profiles.set(ref.id,{...profiles.get(ref.id),...data});costs.writes++;}
    }
  };
  const context={Map,Set,WeakSet,Promise,JSON,String,Number,Math,Error,URL,
    Date:{now:()=>at},MODERATION_REFRESH_MS:600000,
    COLLECTIONS:{moderationNames:'moderation',profilesPublic:'profiles'},
    sanitizeDisplayName:value=>String(value||''),noteFirebaseQuota:()=>costs.quota++,
    activeRankedAccountId:()=>active,
    window:{firebase:{auth:()=>({currentUser:user}),firestore:{FieldValue:{serverTimestamp:()=> 'server'}}}},
    assertCloudOwner:(id,uid,data)=>{if(data?.ownerUid&&data.ownerUid!==uid)throw new Error('owner mismatch');},
    claimCloudProfileName:async(_d,_tx,_id,_uid,_previous,name)=>{costs.claims++;return claim(name);},
    legacyNameTransactions:new WeakSet(),
    db:async()=>{costs.auth++;if(!user)throw new Error('auth unavailable');return database;},
    localStorage:{getItem:key=>disk.get(key)||null,setItem:(key,value)=>{disk.set(key,value);if(key==='polytrack-0.6.2-active-account-id')active=value;}},
    LAST_ACTIVE_NAME_KEY:'name',parsePayload:value=>value,accountIdFromPayload:async value=>value.accountId||'acct',guestAccountId:'acct',
    getOrCreateDefaultDisplayName:()=> 'Racer',enforceSafeDisplayName:async value=>value,
    __pt062NormalizeStyle:value=>value,getDefaultCarStyle:()=> 'car',setLastKnownName(){},
    __pt062RememberStyle(){},invalidateNativePartialReplayAccount(){},showPublicNameAdjustment(){},
    updateOverallIdentity:async()=>{},showCloudOwnerConflict(){},log(){}
  };
  vm.createContext(context);
  vm.runInContext(section('  const manualModerationCache =','  function getLastKnownName('),context);
  vm.runInContext(section('  function runFirebaseTransaction(','  let profileNameModulePromise='),context);
  const start=source.indexOf('  async function mockPayload('),end=source.indexOf('\n  }',start);
  vm.runInContext(source.slice(start,end+4),context);
  return {context,costs,profiles,disk,database,
    moderate:(name='Racer',id='acct')=>context.resolveManualNameOverride(database,id,name),
    sync:(name='Racer',country='US',car='car',id='acct')=>context.syncAcknowledgedPublicIdentity(database,id,name,country,car),
    post:(extra={})=>context.mockPayload(new URL('https://game.invalid/user'),'POST',{nickname:'Racer',countryCode:'US',carStyle:'car',...extra}),
    advance:ms=>{at+=ms;},setUser:value=>{user=value;},setActive:value=>{active=value;},
    override:value=>{override=value;},failModeration:value=>{moderationFailure=value;},failTransaction:value=>{transactionFailure=value;},
    gateRead:()=>{readGate=deferred();return readGate;},gateCommit:()=>{commitGate=deferred();return commitGate;},claim:fn=>{claim=fn;}
  };
}
async function tick(){for(let i=0;i<30;i++)await Promise.resolve();}

test('100 concurrent moderation callers share one read and retain their own fallback',async()=>{
  const h=harness(),gate=h.gateRead();
  const pending=Array.from({length:100},(_,i)=>h.moderate('Name'+i));
  assert.equal(h.costs.moderation,1);gate.resolve();
  assert.deepEqual(await Promise.all(pending),Array.from({length:100},(_,i)=>'Name'+i));
  assert.equal(await h.moderate('Latest'),'Latest');assert.equal(h.costs.moderation,1);
});

test('active override is shared, expires, and accounts remain separate',async()=>{
  const h=harness();h.override('StaffName');
  assert.deepEqual(await Promise.all([h.moderate('A'),h.moderate('B')]),['StaffName','StaffName']);
  await h.moderate('Other','other');assert.equal(h.costs.moderation,2);
  h.override('NewStaffName');h.advance(600000);
  assert.equal(await h.moderate(),'NewStaffName');assert.equal(h.costs.moderation,3);
});

test('failed moderation reads coalesce without caching another caller fallback and retry after cooldown',async()=>{
  const h=harness();h.failModeration(true);
  assert.deepEqual(await Promise.all([h.moderate('A'),h.moderate('B')]),['A','B']);
  assert.equal(h.costs.moderation,1);assert.equal(h.costs.quota,1);
  assert.equal(await h.moderate('C'),'C');h.advance(30000);h.failModeration(false);h.override('Fixed');
  assert.equal(await h.moderate(),'Fixed');assert.equal(h.costs.moderation,2);
});

test('100 unchanged user POSTs retain auth and moderation but cost only one profile read',async()=>{
  const h=harness();
  for(let i=0;i<100;i++)await h.post();
  assert.equal(h.costs.auth,100);assert.equal(h.costs.moderation,1);
  assert.equal(h.costs.profiles,1);assert.equal(h.costs.writes,1);
  assert.equal(h.profiles.get('acct').ownerUid,'uid');
});

test('local profile values alone are not proof; an existing exact cloud identity reads once and writes zero',async()=>{
  const h=harness();
  h.profiles.set('acct',{accountId:'acct',ownerUid:'uid',name:'Racer',nickname:'Racer',countryCode:'US',carStyle:'car',isVerifier:false});
  for(let i=0;i<100;i++)await h.post();
  assert.equal(h.costs.profiles,1);assert.equal(h.costs.writes,0);
});

test('profile acknowledgement never overwrites cosmetic or PB fields',async()=>{
  const h=harness();h.profiles.set('acct',{accountId:'acct',ownerUid:'uid',profileCosmetics:{theme:'gold'},pbCount:12});
  await h.post();await h.post();
  assert.deepEqual(h.profiles.get('acct').profileCosmetics,{theme:'gold'});
  assert.equal(h.profiles.get('acct').pbCount,12);assert.equal(h.costs.profiles,1);
});

test('concurrent identical identities wait for acknowledgement instead of duplicating reads',async()=>{
  const h=harness(),gate=h.gateCommit();
  const pending=Array.from({length:100},()=>h.sync());await tick();
  assert.equal(h.costs.profiles,1);assert.equal(h.costs.writes,0);
  gate.resolve();await Promise.all(pending);
  assert.equal(h.costs.profiles,1);assert.equal(h.costs.writes,1);
});

test('A B A identity concurrency is serialized and cannot reuse the first A acknowledgement',async()=>{
  const h=harness();await Promise.all([h.sync('A'),h.sync('B'),h.sync('A')]);
  assert.equal(h.costs.profiles,3);assert.equal(h.profiles.get('acct').name,'A');
  assert.equal(h.costs.writes,3);
});

test('country null versus empty and changed car each require exact validation',async()=>{
  const h=harness();await h.sync('A',null);await h.sync('A','');await h.sync('A','','new');
  assert.equal(h.costs.profiles,3);
});

test('expired acknowledgement revalidates without requiring a changed-profile write',async()=>{
  const h=harness();await h.sync();h.advance(60000);await h.sync();
  assert.equal(h.costs.profiles,2);assert.equal(h.costs.writes,1);
});

test('failed commit never acknowledges and queued retries are not poisoned',async()=>{
  const h=harness();h.failTransaction(true);await assert.rejects(h.sync(),/commit unavailable/);
  assert.equal(h.costs.writes,0);h.failTransaction(false);await h.sync();await h.sync();
  assert.equal(h.costs.profiles,2);assert.equal(h.costs.writes,1);
});

test('failed user POST remains retryable and does not return a cloud-saved flag',async()=>{
  const h=harness();h.failTransaction(true);assert.deepEqual(JSON.parse(JSON.stringify(await h.post())),{});
  h.failTransaction(false);await h.post();assert.equal(h.costs.profiles,2);assert.equal(h.costs.writes,1);
});

test('transaction quota failures remain observable, cannot acknowledge, and retry after recovery',async()=>{
  const h=harness(),original=h.database.runTransaction;
  h.database.runTransaction=async()=>{throw Object.assign(new Error('quota'),{code:'resource-exhausted'});};
  await h.post();
  assert.equal(h.costs.quota,1);assert.equal(h.context.runFirebaseTransaction.identityPending,0);
  h.database.runTransaction=original;await h.sync();assert.equal(h.costs.profiles,1);
});

test('synchronous SDK transaction failure releases invalidation state and permits retry',async()=>{
  const h=harness(),original=h.database.runTransaction;
  h.database.runTransaction=()=>{throw new Error('SDK unavailable');};
  await assert.rejects(h.sync(),/SDK unavailable/);
  assert.equal(h.context.runFirebaseTransaction.identityPending,0);
  h.database.runTransaction=original;await h.sync();assert.equal(h.costs.profiles,1);
});

test('another transaction invalidates acknowledgement, including failed transactions',async()=>{
  const h=harness();await h.sync();
  await h.context.runFirebaseTransaction(h.database,async()=>{});await h.sync();
  h.failTransaction(true);await assert.rejects(h.context.runFirebaseTransaction(h.database,async()=>{}));
  h.failTransaction(false);await h.sync();assert.equal(h.costs.profiles,3);
});

test('an outstanding external transaction prevents cached identity suppression',async()=>{
  const h=harness();await h.sync();const gate=h.gateCommit();
  const other=h.context.runFirebaseTransaction(h.database,async()=>{});await tick();
  await h.sync();assert.equal(h.costs.profiles,2);
  gate.resolve();await other;await h.sync();assert.equal(h.costs.profiles,3);
});

test('new Firebase user object with the same UID must revalidate; different UID cannot inherit proof',async()=>{
  const h=harness();await h.sync();h.setUser({uid:'uid'});await h.sync();
  assert.equal(h.costs.profiles,2);h.setUser({uid:'other'});
  await assert.rejects(h.sync(),/owner mismatch/);assert.equal(h.costs.profiles,3);
});

test('auth disappearance does not reuse an acknowledgement or bypass db on POST',async()=>{
  const h=harness();await h.post();h.setUser(null);await h.post();
  assert.equal(h.costs.auth,2);assert.equal(h.costs.profiles,1);
  await assert.rejects(h.sync(),/identity changed/);
});

test('account switch while awaiting server read rejects before staging writes',async()=>{
  const h=harness();await h.moderate();const gate=h.gateRead(),pending=h.sync();
  await tick();h.setActive('other');gate.resolve();await assert.rejects(pending,/identity changed/);
  assert.equal(h.costs.writes,0);h.setActive('acct');await h.sync();assert.equal(h.costs.profiles,2);
});

test('user switch during commit cannot establish a reusable acknowledgement',async()=>{
  const h=harness(),gate=h.gateCommit(),pending=h.sync();await tick();
  h.setUser({uid:'uid'});gate.resolve();await assert.rejects(pending,/identity changed/);
  await h.sync();assert.equal(h.costs.profiles,2);
});

test('claimed replacement acknowledges only the accepted name, not the rejected request',async()=>{
  const h=harness();h.claim(name=>name==='Taken'?'Accepted':name);
  assert.equal(await h.sync('Taken'),'Accepted');assert.equal(await h.sync('Accepted'),'Accepted');
  assert.equal(h.costs.profiles,1);await h.sync('Taken');assert.equal(h.costs.profiles,2);
});

test('moderation refresh still changes the profile after idle suppression',async()=>{
  const h=harness();await h.post();h.override('Moderated');h.advance(600000);await h.post();
  assert.equal(h.costs.moderation,2);assert.equal(h.profiles.get('acct').name,'Moderated');
});

test('latest concurrent POST owns local identity even when an earlier request completes later',async()=>{
  const h=harness(),gate=h.gateCommit(),first=h.post({nickname:'First'});await tick();
  const last=h.post({nickname:'Last'});await tick();gate.resolve();await Promise.all([first,last]);
  assert.equal(h.disk.get('name'),'Last');assert.equal(h.profiles.get('acct').name,'Last');
});

test('PB confirmation proof is not promoted into an idle upload shortcut',()=>{
  const mirror=section('  async function mirrorRaceResult(','  function localBestRowsForAccount(');
  assert.match(mirror,/const currentSnap = await tx.get\(ref\)/);
  assert.match(mirror,/const profileSnap = await tx.get\(profileRef\)/);
  assert.doesNotMatch(mirror,/profileIdentityAcknowledgement|syncAcknowledgedPublicIdentity/);
});
