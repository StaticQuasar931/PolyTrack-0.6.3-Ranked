const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../polytrack_062_patch.js'),'utf8').replace(/\r\n/g,'\n');
function extract(name){
  const start=source.search(new RegExp('^  (?:async )?function '+name+'\\(','m'));
  const end=source.indexOf('\n  }',start);
  assert.ok(start>=0&&end>start,name);
  return source.slice(start,end+4);
}

test('snapshot-only unranked Extra Tracks use the shared cache path, not a live route',async()=>{
  const reachedCache=Error('shared snapshot/cache path');let requests=0;
  const c={trackLoadGeneration:0,unrankedExtraTrackIds:new Set(['extra-fixture']),snapshotOnlyForNewAccount:()=>true,
    readTrackSnapshotCache:()=>{throw reachedCache;},rankedFetch:async()=>{requests++;throw Error('unexpected network');}};
  vm.createContext(c);vm.runInContext(extract('loadTrackEntries'),c);
  await assert.rejects(c.loadTrackEntries('extra-fixture'),error=>error===reachedCache);
  assert.equal(requests,0);
});

test('cached database access revalidates authentication without reading a document',async()=>{
  const database={};let checks=0,observations=0;
  const c={firestorePromise:Promise.resolve(database),assertOnlineCompatibility(){},firebaseQuotaPaused:()=>false,
    ensureFirebaseAuthApp:async()=>{checks++;},observeFirestore:async value=>{observations++;return value;}};
  vm.createContext(c);vm.runInContext(extract('db'),c);
  assert.equal(await c.db(),database);assert.equal(checks,1);assert.equal(observations,1);
  c.ensureFirebaseAuthApp=async()=>{throw Error('auth unavailable');};
  await assert.rejects(c.db(),/auth unavailable/);assert.equal(observations,1);
});

function repair({race=false,switchUser=false,failure=null}={}){
  const account='a'.repeat(64),track='b'.repeat(64),initialUser={uid:'owner'};
  let user=initialUser,advanced=false,row={accountId:account,ownerUid:'owner',trackId:track,uploadId:8,replay:'old'};
  const cost={reads:0,writes:0,attempts:0};
  const database={collection:()=>({doc:id=>({id})})};
  const c={activeRankedAccountId:()=>account,
    window:{firebase:{auth:()=>({currentUser:user}),firestore:{FieldValue:{serverTimestamp:()=>0}}}},
    readLocalRaceRows:()=>[{accountId:account,trackId:track,uploadId:8}],safeRecordingId:Number,
    COLLECTIONS:{raceResults:'races'},recordingRepairPatch:()=>({replay:'old-repair'}),
    runFirebaseTransaction:async(_database,callback)=>{
      for(let attempt=0;attempt<3;attempt++){
        cost.attempts++;let write;
        const outcome=await callback({get:async()=>{
          cost.reads++;if(failure)throw failure;
          return {exists:true,data:()=>({...row})};
        },set:(_ref,value)=>{write=value;}});
        if(!advanced&&(race||switchUser)){
          advanced=true;
          if(race)row={...row,uploadId:9,replay:'new-pb'};
          if(switchUser)user={uid:'other'};
          continue;
        }
        if(write){Object.assign(row,write);cost.writes++;}
        return outcome;
      }
      throw Error('fixture retry bound');
    }};
  vm.createContext(c);vm.runInContext(extract('repairOwnNativeRecording'),c);
  return {cost,row:()=>row,run:()=>c.repairOwnNativeRecording(database,8,'old-repair',{},'style',null,null),pending:()=>c.repairOwnNativeRecording.requests?.get(database)?.size||0};
}
test('repair transaction retains the ordinary one-read one-write path',async()=>{
  const h=repair();assert.equal(await h.run(),1);
  assert.deepEqual(h.cost,{reads:1,writes:1,attempts:1});assert.equal(h.row().replay,'old-repair');assert.equal(h.pending(),0);
});
test('repair retry cannot overwrite a concurrently improved PB',async()=>{
  const h=repair({race:true});assert.equal(await h.run(),0);
  assert.equal(h.row().uploadId,9);assert.equal(h.row().replay,'new-pb');
  assert.deepEqual(h.cost,{reads:2,writes:0,attempts:2});assert.equal(h.pending(),0);
});
test('repair retry after an account switch cannot write or acknowledge a match',async()=>{
  const h=repair({switchUser:true});assert.equal(await h.run(),0);
  assert.equal(h.row().replay,'old');assert.equal(h.cost.writes,0);assert.equal(h.cost.reads,1);
});
test('failed repair releases its in-flight slot without claiming saved data',async()=>{
  const h=repair({failure:Object.assign(Error('quota'),{code:'resource-exhausted'})});
  await assert.rejects(h.run(),/quota/);assert.equal(h.row().replay,'old');assert.equal(h.pending(),0);assert.equal(h.cost.writes,0);
});

function fetchBridge(){
  let call,forwarded=0;
  const c={Request,Response,URL,window:{fetch:async()=>{forwarded++;return 'forwarded';}},XMLHttpRequest:class {},
    parseTarget:value=>new URL(value),compatibilityCloudTarget:()=>false,shouldMock:url=>url.hostname==='offline.invalid',
    log(){},mockPayload:async(...args)=>{call=args;return {};}};
  c.XMLHttpRequest.prototype.open=function(){};c.XMLHttpRequest.prototype.send=function(){};
  vm.createContext(c);vm.runInContext(extract('hookLegacyNetworking'),c);c.hookLegacyNetworking();
  return {fetch:c.window.fetch,call:()=>call,forwarded:()=>forwarded};
}
test('legacy fetch bridge preserves Request POST body without consuming its caller',async()=>{
  const h=fetchBridge(),request=new Request('https://offline.invalid/user',{method:'POST',body:'{"nickname":"fixture"}'});
  await h.fetch(request);assert.equal(h.call()[1],'POST');assert.equal(h.call()[2],'{"nickname":"fixture"}');assert.equal(request.bodyUsed,false);
});
test('explicit fetch options override the Request method and payload',async()=>{
  const h=fetchBridge();await h.fetch(new Request('https://offline.invalid/user',{method:'POST',body:'old'}),{method:'PUT',body:'replacement'});
  assert.equal(h.call()[1],'PUT');assert.equal(h.call()[2],'replacement');
});
test('non-mocked requests retain the original fetch path',async()=>{
  const h=fetchBridge();assert.equal(await h.fetch(new Request('https://elsewhere.invalid/',{method:'POST',body:'original'})),'forwarded');assert.equal(h.forwarded(),1);assert.equal(h.call(),undefined);
});
