const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const source=fs.readFileSync(path.join(__dirname,'../polytrack_062_patch.js'),'utf8');
function extract(name){
  const start=source.search(new RegExp('^  (?:async )?function '+name+'\\(','m'));
  assert.ok(start>=0,name);
  const tail=source.slice(start);
  for(const match of tail.matchAll(/^  }[^\n]*$/gm)){
    const candidate=tail.slice(0,match.index+match[0].length);
    try{new vm.Script(candidate);return candidate;}catch(error){if(!(error instanceof SyntaxError))throw error;}
  }
  assert.fail('No complete function: '+name);
}

function harness(){
  let now=Date.UTC(2026,9,26,18),listenerError;
  const storage=new Map(),logs=[],stats={gets:0,transactions:0,transactionReads:0,sets:0,deletes:0,listens:0,unsubscribes:0};
  const failures={};
  const profile={accountId:'acct',ownerUid:'uid',name:'Racer',nickname:'Racer',countryCode:null,carStyle:'style',isVerifier:false};
  const database={
    collection(collection){
      return {
        doc(){return {
          collection,
          async get(){stats.gets++;if(failures.get)throw failures.get;return {exists:true,data:()=>profile};},
          async delete(){stats.deletes++;}
        };},
        where(){return this;},
        onSnapshot(_next,error){stats.listens++;listenerError=error;return ()=>stats.unsubscribes++;}
      };
    },
    async runTransaction(callback){
      stats.transactions++;
      await callback({
        async get(){stats.transactionReads++;if(failures.read)throw failures.read;return {exists:true,data:()=>profile};},
        set(){stats.sets++;}
      });
      if(failures.commit)throw failures.commit;
    }
  };
  class Clock extends Date{static now(){return now;}}
  const localStorage={getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,String(value))};
  localStorage.setItem('name','Racer');
  localStorage.setItem('polytrack-0.6.2-active-account-id','acct');
  localStorage.setItem('polytrack-0.6.2-last-active-car-style','style');
  const context={
    Date:Clock,Intl,Error,EventTarget,Event,MessageEvent,
    CloseEvent:class extends Event{constructor(type,init){super(type);Object.assign(this,init);}},
    crypto:{randomUUID:()=> 'socket'},setTimeout,localStorage,
    window:{firebase:{auth:()=>({currentUser:{uid:'uid'}})}},
    FIREBASE_QUOTA_PAUSE_KEY:'quota',firestorePromise:Promise.resolve(database),firebaseRetryAt:0,
    assertOnlineCompatibility:()=>{},observeFirestore:value=>value,
    ensureFirebaseAuthApp:()=>assert.fail('Unexpected SDK bootstrap'),loadScript:()=>assert.fail('Unexpected SDK load'),
    readJsonStorage:(key,fallback)=>storage.has(key)?JSON.parse(storage.get(key)):fallback,
    writeJsonStorage:(key,value)=>{storage.set(key,JSON.stringify(value));return true;},
    COLLECTIONS:{profilesPublic:'profiles',moderationNames:'moderation',multiplayerMessages:'messages',multiplayerSessions:'sessions'},
    manualModerationCache:new Map(),MODERATION_REFRESH_MS:600000,sanitizeDisplayName:value=>value,
    LAST_ACTIVE_NAME_KEY:'name',guestAccountId:'acct',parsePayload:value=>value,
    accountIdFromPayload:async()=> 'acct',getOrCreateDefaultDisplayName:()=> 'Racer',
    enforceSafeDisplayName:async value=>value,__pt062NormalizeStyle:value=>value,getDefaultCarStyle:()=> 'style',
    setLastKnownName:()=>{},__pt062RememberStyle:()=>{},assertCloudOwner:()=>{},
    claimCloudProfileName:async(_d,_tx,_id,_uid,_previous,name)=>name,
    showPublicNameAdjustment:()=>{},showCloudOwnerConflict:()=>logs.push(['owner-conflict']),
    updateOverallIdentity:async()=>{},scheduleLocalPbCloudReconcile:()=>{},snapshotOnlyForNewAccount:()=>false,
    makeUserPayload:value=>({nickname:value?.nickname||'local fallback'}),
    log:(...args)=>logs.push(args)
  };
  vm.createContext(context);
  for(const name of ['firebaseQuotaRetryAt','firebaseQuotaPaused','noteFirebaseQuota','db','runFirebaseTransaction','resolveManualNameOverride','mockPayload'])vm.runInContext(extract(name),context);
  const start=source.indexOf('  class FirebaseSignalingSocket'),end=source.indexOf('  FirebaseSignalingSocket.CONNECTING',start);
  assert.ok(start>=0&&end>start);
  vm.runInContext(source.slice(start,end)+'\nthis.Socket=FirebaseSignalingSocket;',context);
  return {
    context,stats,failures,logs,storage,
    advance:ms=>{now+=ms;},
    expiry:()=>context.readJsonStorage('quota',0),
    get:()=>context.mockPayload(new URL('https://local/user'),'GET',{}),
    save:()=>context.mockPayload(new URL('https://local/user'),'POST',{nickname:'Changed',carStyle:'style'}),
    moderation:async()=>context.resolveManualNameOverride(await context.db(),'acct','Racer'),
    listenerError:error=>{assert.equal(typeof listenerError,'function');listenerError(error);}
  };
}
function failure(code,message=code){return Object.assign(new Error(message),{code});}
function counts(h){return {...h.stats};}

for(const [label,error] of [
  ['resource-exhausted',failure('resource-exhausted')],
  ['HTTP 429 message',failure('unknown','HTTP 429')]
]){
  test('profile GET propagates '+label+' and repeated GET/save stop before SDK',async()=>{
    const h=harness();h.failures.get=error;
    assert.equal((await h.get()).nickname,'local fallback');
    assert.equal(h.stats.gets,1);assert.ok(h.expiry()>h.context.Date.now());
    const before=counts(h),expiry=h.expiry();
    await h.get();await h.save();
    assert.deepEqual(counts(h),before);assert.equal(h.expiry(),expiry);
    h.advance(expiry-h.context.Date.now()+1);delete h.failures.get;
    assert.equal((await h.get()).nickname,'Racer');assert.equal(h.stats.gets,2);
  });
}

for(const stage of ['read','commit']){
  test('profile save '+stage+' quota failure pauses subsequent callers',async()=>{
    const h=harness();h.failures[stage]=failure('resource-exhausted');
    // Keep this test focused on the profile transaction, not moderation lookup.
    h.context.manualModerationCache.set('acct',{name:'',expiresAt:h.context.Date.now()+600000});
    assert.equal(JSON.stringify(await h.save()),'{}');
    assert.equal(h.stats.transactions,1);assert.equal(h.stats.transactionReads,1);
    assert.ok(h.expiry()>h.context.Date.now());
    const before=counts(h);
    await h.save();await h.get();
    assert.deepEqual(counts(h),before);
  });
}

test('moderation quota failure retains fallback but pauses new SDK callers',async()=>{
  const h=harness();h.failures.get=failure('resource-exhausted');
  assert.equal(await h.moderation(),'Racer');assert.equal(h.stats.gets,1);
  assert.equal(h.context.manualModerationCache.get('acct').name,'Racer');
  assert.ok(h.expiry()>h.context.Date.now());
  const before=counts(h);
  await assert.rejects(h.moderation(),error=>error.code==='local-quota-cooldown');
  await h.save();await h.get();
  assert.deepEqual(counts(h),before);
});

for(const code of ['permission-denied','unavailable']){
  test('nonquota profile GET '+code+' preserves fallback without cooldown',async()=>{
    const h=harness();h.failures.get=failure(code);
    for(let i=0;i<2;i++)assert.equal((await h.get()).nickname,'local fallback');
    assert.equal(h.stats.gets,2);assert.equal(h.expiry(),0);
    assert.equal(h.logs.filter(row=>row[1]==='[FB402] profile lookup failed').length,2);
  });
  test('nonquota profile save '+code+' preserves success-shaped fallback and retries',async()=>{
    const h=harness();h.failures.commit=failure(code);
    h.context.manualModerationCache.set('acct',{name:'',expiresAt:h.context.Date.now()+600000});
    for(let i=0;i<2;i++)assert.equal(JSON.stringify(await h.save()),'{}');
    assert.equal(h.stats.transactions,2);assert.equal(h.expiry(),0);
    assert.equal(h.logs.filter(row=>row[1]==='[FB402] profiles_public.set failed').length,2);
  });
}

test('profile ownership conflict still displays its notice and does not pause Firebase',async()=>{
  const h=harness();h.failures.read=failure('account-session-conflict');
  await h.save();
  assert.equal(h.logs.filter(row=>row[0]==='owner-conflict').length,1);
  assert.equal(h.expiry(),0);
});

test('nonquota moderation error retains the original 30-second fallback cache',async()=>{
  const h=harness();h.failures.get=failure('permission-denied');
  assert.equal(await h.moderation(),'Racer');
  assert.equal(await h.moderation(),'Racer');assert.equal(h.stats.gets,1);
  h.advance(30001);
  assert.equal(await h.moderation(),'Racer');assert.equal(h.stats.gets,2);
  assert.equal(h.expiry(),0);
});

test('multiplayer listener quota closes once, unsubscribes, and blocks new SDK callers',async()=>{
  const h=harness(),socket=new h.context.Socket('/multiplayer/host');
  await new Promise(setImmediate);
  assert.equal(socket.readyState,1);
  let errors=0,closes=0;
  socket.addEventListener('error',()=>errors++);socket.addEventListener('close',event=>{closes++;assert.equal(event.code,1011);});
  await socket._listen('uid');
  h.listenerError(failure('resource-exhausted'));
  assert.equal(socket.readyState,3);assert.equal(errors,1);assert.equal(closes,1);
  assert.equal(h.stats.unsubscribes,1);assert.ok(h.expiry()>h.context.Date.now());
  const before=counts(h),expiry=h.expiry();
  await h.get();await h.save();
  const next=new h.context.Socket('/multiplayer/host');
  await new Promise(setImmediate);
  assert.equal(next.readyState,3);assert.deepEqual(counts(h),before);assert.equal(h.expiry(),expiry);
});

test('late multiplayer quota error after close still propagates without duplicate events',async()=>{
  const h=harness(),socket=new h.context.Socket('/multiplayer/host');
  await new Promise(setImmediate);socket.close();
  let errors=0,closes=0;
  socket.addEventListener('error',()=>errors++);socket.addEventListener('close',()=>closes++);
  socket._fail(failure('resource-exhausted'));
  assert.ok(h.expiry()>h.context.Date.now());assert.equal(errors,0);assert.equal(closes,0);
  await assert.rejects(h.context.db(),error=>error.code==='local-quota-cooldown');
});

test('nonquota multiplayer failure preserves error/close behavior and permits later SDK access',async()=>{
  const h=harness(),socket=new h.context.Socket('/multiplayer/host');
  await new Promise(setImmediate);await socket._listen('uid');
  let errors=0,closes=0;
  socket.addEventListener('error',()=>errors++);socket.addEventListener('close',event=>{closes++;assert.equal(event.code,1011);});
  h.listenerError(failure('permission-denied'));
  await new Promise(setImmediate);
  assert.equal(socket.readyState,3);assert.equal(errors,1);assert.equal(closes,1);
  assert.equal(h.stats.unsubscribes,1);assert.equal(h.expiry(),0);
  assert.equal((await h.get()).nickname,'Racer');assert.equal(h.stats.gets,1);
});

function pbHarness(rows){
  const h=harness(),c=h.context,timers=new Map(),reads=[];
  let timerId=0,uid='uid',denied=true,uploadDenied=false;
  Object.assign(c,{
    LOCAL_PB_RECONCILE_STATE_KEY:'pb-state',OVERALL_PB_DIRTY_KEY:'dirty',
    localPbReconcilePromises:new Map(),localPbReconcileTimers:new Map(),
    cleanUserId:value=>String(value||''),activeRankedAccountId:()=> 'acct',
    localBestRowsForAccount:()=>rows,canonicalRaceTimeMs:row=>Number(row?.timeMs)||0,
    window:{addEventListener:()=>{},firebase:{auth:()=>({currentUser:uid?{uid}:null})}},
    document:{visibilityState:'visible',addEventListener:()=>{}},navigator:{onLine:true},compatibilityOnlineAllowed:true,
    setTimeout:(fn,delay)=>{const id=++timerId;timers.set(id,{fn,delay});return id;},clearTimeout:id=>timers.delete(id),
    cloudOwnerConflicts:new Map(),readRecordingStore:()=>[],safeRecordingId:value=>value,
    normalizeReplayPayloadString:value=>String(value||''),safePositiveInt:value=>Number(value)||1,
    getLastKnownName:()=> 'Racer',addLocalRaceRow:()=>{},overallLoadState:{},
    db:async()=>({collection:()=>({doc:id=>({get:async()=>{
      reads.push(id);
      if(denied&&id.endsWith('_denied'))throw failure('permission-denied');
      return uploadDenied?{exists:false}:{exists:true,data:()=>({...rows.find(row=>id.endsWith('_'+row.trackId))})};
    }})})}),
    mirrorRaceResult:async(_url,row)=>{
      if(uploadDenied)return {saved:false,permissionDenied:true};
      c.rememberConfirmedLocalPb('acct',row);return {saved:true};
    }
  });
  const start=source.indexOf('  function localPbSyncSignature(row){'),end=source.indexOf('  function hookLegacyNetworking(){',start);
  vm.runInContext(source.slice(start,end),c);
  return {...h,reads,rows,timers,
    run:()=>c.reconcileLocalPersonalBestsToCloud('acct'),
    state:()=>c.readJsonStorage('pb-state',{}).acct,
    setUid:value=>{uid=value;},allow:()=>{denied=false;uploadDenied=false;},
    denyUploads:()=>{denied=false;uploadDenied=true;}
  };
}
function pb(trackId='denied',timeMs=10000){return {trackId,timeMs,replayHash:'hash',replay:'replay'};}

test('permission-denied row retries exponentially from five minutes to a six-hour cap',async()=>{
  const h=pbHarness([pb()]);
  for(const minutes of [5,10,20,40,80,160,320,360,360]){
    const before=h.reads.length;
    const outcome=await h.run();assert.equal(outcome.failed,1);
    const entry=h.state().permissionDenied.denied;
    assert.equal(entry.ownerUid,'uid');assert.equal(entry.signature,h.context.localPbSyncSignature(h.rows[0]));
    assert.equal(entry.retryAt-h.context.Date.now(),minutes*60000);
    assert.ok(h.state().retryAt<=h.context.Date.now(),'permission failure must not delay the account');
    assert.equal([...h.timers.values()][0].delay,minutes*60000);
    assert.equal((await h.run()).deferred,true);assert.equal(h.reads.length,before+1);
    h.advance(minutes*60000-1);
    assert.equal((await h.run()).deferred,true);assert.equal(h.reads.length,before+1);
    h.advance(1);
  }
  assert.equal(h.state().permissionDenied.denied.attempts,8);
});

test('persisted denied ledger suppresses SDK reads after reload',async()=>{
  const first=pbHarness([pb()]);await first.run();
  const next=pbHarness([pb()]);
  next.storage.set('pb-state',first.storage.get('pb-state'));
  assert.equal((await next.run()).deferred,true);assert.equal(next.reads.length,0);
});

test('denied rows never delay unrelated new PBs before their retry is due',async()=>{
  const h=pbHarness([pb()]);await h.run();
  h.rows.push(pb('valid'));
  const outcome=await h.run();
  assert.equal(outcome.checked,1);assert.deepEqual(h.reads,['acct_denied','acct_valid']);
  assert.equal(h.state().confirmed.valid,h.context.localPbSyncSignature(h.rows[1]));
  assert.equal(h.state().permissionDenied.denied.attempts,1);
});

test('a denied batch does not impose a global cooldown on the next batch',async()=>{
  const h=pbHarness(Array.from({length:17},(_,i)=>pb(i===16?'valid':'denied'+i)));
  // Distinct permanently denied tracks fill the first batch.
  h.context.db=async()=>({collection:()=>({doc:id=>({get:async()=>{
    h.reads.push(id);if(id!=='acct_valid')throw failure('permission-denied');
    return {exists:true,data:()=>h.rows[16]};
  }})})});
  await h.run();assert.equal(h.reads.length,16);
  const second=await h.run();assert.equal(second.checked,1);
  assert.equal(h.reads.length,17);assert.equal(h.reads[16],'acct_valid');
});

test('changed PB time or replay signature immediately resets its denied retry budget',async()=>{
  for(const change of [row=>row.timeMs--,row=>row.replayHash='new-hash']){
    const h=pbHarness([pb()]);await h.run();
    change(h.rows[0]);await h.run();
    assert.equal(h.reads.length,2);assert.equal(h.state().permissionDenied.denied.attempts,1);
    assert.equal(h.state().permissionDenied.denied.signature,h.context.localPbSyncSignature(h.rows[0]));
  }
});

test('Firebase UID change immediately resets denied rows and their attempt counters',async()=>{
  const h=pbHarness([pb()]);await h.run();h.setUid('new-owner');await h.run();
  assert.equal(h.reads.length,2);assert.equal(h.state().permissionDenied.denied.ownerUid,'new-owner');
  assert.equal(h.state().permissionDenied.denied.attempts,1);
});

test('late auth initialization honors the authenticated UID ledger before reading a row',async()=>{
  const h=pbHarness([pb()]);await h.run();h.setUid('');
  const original=h.context.db;h.context.db=async()=>{h.setUid('uid');return original();};
  await h.run();assert.equal(h.reads.length,1);
  assert.equal(h.state().permissionDenied.denied.attempts,1);
});

test('successful confirmation clears denied ledger immediately, including direct PB saves',async()=>{
  const h=pbHarness([pb()]);await h.run();
  h.context.rememberConfirmedLocalPb('acct',h.rows[0]);
  assert.equal(h.state().permissionDenied.denied,undefined);
  const retried=pbHarness([pb()]);await retried.run();retried.advance(300000);retried.allow();await retried.run();
  assert.equal(retried.state().permissionDenied.denied,undefined);
  assert.equal(retried.state().confirmed.denied,retried.context.localPbSyncSignature(retried.rows[0]));
});

test('removed rows prune their permission ledger even when no PBs remain',async()=>{
  const h=pbHarness([pb()]);await h.run();h.rows.length=0;await h.run();
  assert.equal(Object.keys(h.state().permissionDenied).length,0);
});

test('upload permission denial, not only document reads, uses the row ledger',async()=>{
  const h=pbHarness([pb()]);h.denyUploads();await h.run();
  assert.equal(h.state().permissionDenied.denied.attempts,1);
  assert.equal((await h.run()).deferred,true);assert.equal(h.reads.length,1);
  h.advance(300000);await h.run();assert.equal(h.state().permissionDenied.denied.attempts,2);
});

test('unavailable PB reads retain ordinary five-minute retry and do not create a denial',async()=>{
  const h=pbHarness([pb()]);
  h.context.db=async()=>({collection:()=>({doc:()=>({get:async()=>{h.reads.push('read');throw failure('unavailable');}})})});
  const result=await h.run();assert.equal(result.failed,1);assert.equal(result.permissionDenied,0);
  assert.equal(h.state().retryAt-h.context.Date.now(),300000);
  assert.equal(Object.keys(h.state().permissionDenied).length,0);
  assert.equal((await h.run()).deferred,true);assert.equal(h.reads.length,1);
});

test('PB quota failures stop the batch and use shared quota cooldown, not the denial ledger',async()=>{
  const h=pbHarness([pb(),pb('valid')]);
  h.context.db=async()=>({collection:()=>({doc:()=>({get:async()=>{h.reads.push('read');throw failure('resource-exhausted');}})})});
  await assert.rejects(h.run(),error=>error.code==='resource-exhausted');
  assert.equal(h.reads.length,1);assert.ok(h.expiry()>h.context.Date.now());
  assert.equal(Object.keys(h.state().permissionDenied).length,0);
  assert.equal((await h.run()).deferred,true);assert.equal(h.reads.length,1);
});

test('actual mirror catch propagates only permission-denied while retaining local-save behavior',async()=>{
  const start=source.indexOf("      if(error?.code==='local-pb-account-changed')"),end=source.indexOf('\n    }\n  }',start);
  assert.ok(start>=0&&end>start);
  for(const code of ['permission-denied','unavailable','resource-exhausted']){
    const c={error:failure(code),accountId:'acct',trackId:'track',timeMs:10000,frames:10000,name:'Racer',carStyle:'style',
      uploadId:1,priorLocal:null,dailyRecorded:false,raceRow:{},replayData:'r',
      noteFirebaseQuota:()=>{},recordDailyActivity:()=>{},addLocalRaceRow:()=>{},writeRecordingStore:()=>{},
      retainTrackSnapshotAfterLocalPb:()=>{},log:()=>{},showCloudOwnerConflict:()=>{},
      scheduleLocalPbCloudReconcile:()=>{},firebaseQuotaPaused:()=>false};
    const result=await vm.runInNewContext('(async()=>{'+source.slice(start,end)+'})()',c);
    assert.equal(result.localSaved,true);assert.equal(result.permissionDenied,code==='permission-denied');
  }
});

test('PB reconciliation tolerates a loaded Firebase SDK before its app is initialized',async()=>{
  const h=pbHarness([pb()]),c=h.context,auth=c.window.firebase.auth,connect=c.db;
  let ready=false;
  c.window.firebase.auth=()=>{if(!ready)throw Error('No Firebase App has been created');return auth();};
  c.db=async()=>{ready=true;return connect();};
  const result=await h.run();assert.equal(result.failed,1);assert.equal(h.reads.length,1);
  assert.equal(h.state().permissionDenied.denied.ownerUid,'uid');
});