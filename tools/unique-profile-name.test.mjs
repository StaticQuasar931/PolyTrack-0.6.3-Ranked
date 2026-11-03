import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, webcrypto} from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import vm from 'node:vm';
import {pathToFileURL,fileURLToPath} from 'node:url';

// Staged runs can point at the actual helper without copying or modifying it.
const moduleURL=process.env.UNIQUE_PROFILE_NAME_MODULE
  ?pathToFileURL(path.resolve(process.env.UNIQUE_PROFILE_NAME_MODULE)).href
  :new URL('./unique-profile-name.mjs',import.meta.url).href;
const {claimProfileName,claimProfileNameWithLegacyBridge,publicNameKey,foldPublicName,NAME_CLAIMS_COLLECTION}=await import(moduleURL);
const COLLECTION='0.6.2_name_claims',PROFILES='0.6.2_profiles_public';
const NOW=Date.UTC(2026,9,24,12),A='a'.repeat(63)+'1',B='a'.repeat(63)+'2',OTHER='f'.repeat(64);
const hash=value=>createHash('sha256').update(value,'utf8').digest('hex');
const asciiFold=name=>name.replace(/[A-Z]/g,char=>String.fromCharCode(char.charCodeAt(0)+32));
const key=name=>hash(asciiFold(name));
const claimPath=name=>COLLECTION+'/'+key(name),profilePath=id=>PROFILES+'/'+id;
const clone=value=>value===undefined?undefined:structuredClone(value);
const claim=(accountId,name,createdAt=NOW)=>({accountId,name,createdAt});
const profile=(accountId,name,ownerUid='uid-'+accountId)=>({accountId,ownerUid,name,nickname:name});

class FirestoreSimulator{
  documents=new Map();versions=new Map();attempts=[];commits=[];conflicts=0;
  constructor({barrierName=null,failRead=null}={}){
    this.failRead=failRead;this.barrierPath=barrierName?claimPath(barrierName):null;
    this.barrierArrivals=[];this.barrierReleased=false;
  }
  seed(path,data){this.documents.set(path,clone(data));this.versions.set(path,(this.versions.get(path)||0)+1);return this;}
  data(path){return clone(this.documents.get(path));}
  collection(name){
    assert.ok([COLLECTION,PROFILES].includes(name),'unexpected collection '+name);
    return {doc:id=>{assert.equal(typeof id,'string');assert.ok(id&&!id.includes('/'),'document IDs must not contain name slashes');
      if(name===COLLECTION)assert.match(id,/^[a-f0-9]{64}$/);
      return Object.freeze({path:name+'/'+id,id});}};
  }
  async runTransaction(work,{maxAttempts=5}={}){
    for(let number=1;number<=maxAttempts;number++){
      const snapshot=new Map([...this.documents].map(([path,data])=>[path,clone(data)]));
      const versions=new Map(this.versions),reads=new Map(),writes=[];
      const record={number,events:[],writes,committed:false};this.attempts.push(record);
      const tx={
        get:async ref=>{
          assert.equal(writes.length,0,'Firestore forbids reads after scheduling a write');
          reads.set(ref.path,versions.get(ref.path)||0);record.events.push({type:'get',path:ref.path});
          const failure=this.failRead?.(ref.path,record);if(failure)throw failure;
          if(number===1&&ref.path===this.barrierPath&&!this.barrierReleased){
            await new Promise(resolve=>{
              this.barrierArrivals.push(resolve);
              if(this.barrierArrivals.length===2){this.barrierReleased=true;for(const done of this.barrierArrivals)done();}
            });
          }
          const value=snapshot.get(ref.path);
          return {id:ref.id,ref,exists:value!==undefined,data:()=>clone(value)};
        },
        set:(ref,data,options)=>{record.events.push({type:'set',path:ref.path});writes.push({type:'set',path:ref.path,data:clone(data),options});return tx;},
        delete:ref=>{record.events.push({type:'delete',path:ref.path});writes.push({type:'delete',path:ref.path});return tx;},
      };
      let value;
      try{value=await work(tx);}catch(error){record.error=error;throw error;}
      if([...reads].some(([path,version])=>(this.versions.get(path)||0)!==version)){
        record.conflict=true;this.conflicts++;continue;
      }
      // Commit is atomic. Missing-document reads participate in conflict detection.
      for(const write of writes){
        if(write.type==='delete')this.documents.delete(write.path);
        else this.documents.set(write.path,write.options?.merge?{...this.documents.get(write.path),...clone(write.data)}:clone(write.data));
        this.versions.set(write.path,(this.versions.get(write.path)||0)+1);
      }
      record.committed=true;this.commits.push(record);return value;
    }
    throw Object.assign(Error('Transaction conflict retry limit'),{code:'aborted'});
  }
}

async function save(db,{accountId=A,ownerUid='uid-'+accountId,requestedName='SwiftOtter',isNameAllowed=()=>true}={}){
  const ref=db.collection(PROFILES).doc(accountId);
  return db.runTransaction(async tx=>{
    const snapshot=await tx.get(ref),previous=snapshot.exists?snapshot.data():null;
    const name=await claimProfileName({tx,db,accountId,ownerUid,previous,requestedName,now:NOW,crypto:webcrypto,isNameAllowed});
    assert.equal(typeof name,'string');
    tx.set(ref,{...previous,accountId,ownerUid,name,nickname:name},{merge:true});
    return name;
  });
}
const reads=db=>db.attempts.flatMap(attempt=>attempt.events.filter(event=>event.type==='get'&&event.path.startsWith(COLLECTION+'/')));
const registryWrites=db=>db.attempts.flatMap(attempt=>attempt.writes.filter(write=>write.path.startsWith(COLLECTION+'/')));
const suffixName=(name,id,length)=>name.slice(0,23-length)+'-'+hash(id).slice(0,length);

test('registry key is SHA-256 of ASCII-folded UTF-8; Unicode case and slash characters are preserved',async()=>{
  assert.equal(NAME_CLAIMS_COLLECTION,COLLECTION);
  for(const name of ['SwiftOtter','SWIFTOTTER','Éclair/雪','ÉCLAIR/雪','éclair/雪','İzmir/雪','ÄÖÜẞΣ/雪','Lap/One','😀/Lap']){
    assert.equal(foldPublicName(name),asciiFold(name));
    assert.equal(await publicNameKey(name,webcrypto),key(name));
    const db=new FirestoreSimulator();assert.equal(await save(db,{requestedName:name}),name);
    assert.deepEqual(db.data(claimPath(name)),claim(A,name));
    assert.equal(reads(db)[0].path.split('/').length,2);
  }
  assert.notEqual(await publicNameKey('Éclair/雪',webcrypto),await publicNameKey('éclair/雪',webcrypto),'non-ASCII case remains distinct');
  assert.equal(await publicNameKey('ÉCLAIR/雪',webcrypto),await publicNameKey('Éclair/雪',webcrypto),'ASCII case still folds inside Unicode names');
  assert.equal(foldPublicName('ÄÖÜİẞΣ/雪😀'),'ÄÖÜİẞΣ/雪😀');
  assert.notEqual(await publicNameKey('İ',webcrypto),await publicNameKey('i\u0307',webcrypto));
  assert.notEqual(await publicNameKey('é',webcrypto),await publicNameKey('e\u0301',webcrypto),'do not introduce Unicode normalization');
});

test('concurrent same-name first claims collide, retry against fresh data, and atomically assign distinct names',{timeout:10000},async()=>{
  const db=new FirestoreSimulator({barrierName:'SwiftOtter'});
  const names=await Promise.all([save(db,{accountId:A}),save(db,{accountId:B})]);
  assert.equal(new Set(names.map(asciiFold)).size,2);
  assert.ok(names.includes('SwiftOtter'));assert.ok(db.conflicts>=1);assert.ok(db.attempts.some(row=>row.number===2));
  for(const [index,id] of [A,B].entries()){
    const name=names[index];assert.equal(db.data(profilePath(id)).name,name);
    assert.equal(db.data(profilePath(id)).nickname,name);assert.equal(db.data(claimPath(name)).accountId,id);
  }
  const owner=db.data(claimPath('SwiftOtter')).accountId;
  assert.ok(owner===A||owner===B);
  assert.equal(db.commits.length,2,'conflicted staged writes must not commit');
});

test('concurrent case variants share one key rather than creating two exact-name claims',{timeout:10000},async()=>{
  const db=new FirestoreSimulator({barrierName:'SwiftOtter'});
  const names=await Promise.all([save(db,{accountId:A,requestedName:'SwiftOtter'}),save(db,{accountId:B,requestedName:'SWIFTOTTER'})]);
  assert.notEqual(asciiFold(names[0]),asciiFold(names[1]));assert.ok(db.conflicts>=1);
});

test('suffix uses the hash of the full account ID, never its common prefix; generated duplicates remain within 24 characters',async()=>{
  const generated='abcdefghijklmnopqrstuvwx';assert.equal(generated.length,24);
  assert.equal(A.slice(0,60),B.slice(0,60));assert.notEqual(hash(A).slice(0,4),hash(B).slice(0,4));
  const assigned=[];
  for(const id of [A,B,A]){
    const db=new FirestoreSimulator().seed(claimPath(generated),claim(OTHER,generated));
    const name=await save(db,{accountId:id,requestedName:generated});assigned.push(name);
    assert.equal(name,suffixName(generated,id,4));assert.equal(name.length,24);assert.equal(db.data(claimPath(generated)).accountId,OTHER);
  }
  assert.notEqual(assigned[0],assigned[1]);assert.equal(assigned[0],assigned[2]);
});

test('4/6/8/12/16 suffix collisions escalate deterministically without overwriting foreign claims',async()=>{
  for(const selectedLength of [4,6,8,12,16]){
    const requestedName='SwiftOtter',db=new FirestoreSimulator().seed(claimPath(requestedName),claim(OTHER,requestedName));
    for(const length of [4,6,8,12,16].filter(length=>length<selectedLength)){
      const name=suffixName(requestedName,A,length);db.seed(claimPath(name),claim(OTHER,name));
    }
    const assigned=await save(db,{requestedName});assert.equal(assigned,suffixName(requestedName,A,selectedLength));
    for(const [path,data] of db.documents)if(path.startsWith(COLLECTION+'/')&&data.accountId!==A)assert.equal(data.accountId,OTHER);
  }
});

test('unchanged exact name and nickname have no registry reads or writes, even for legacy profiles with no claim',async()=>{
  const db=new FirestoreSimulator().seed(profilePath(A),profile(A,'SwiftOtter'));
  assert.equal(await save(db),'SwiftOtter');assert.equal(reads(db).length,0);assert.equal(registryWrites(db).length,0);
  const repaired=new FirestoreSimulator().seed(profilePath(A),{...profile(A,'SwiftOtter'),nickname:'OldAlias'});
  assert.equal(await save(repaired),'SwiftOtter');assert.ok(reads(repaired).length>0,'mismatching nickname is not an unchanged-name fast path');
});

test('owner/account mismatch is rejected before any write, including the unchanged-name fast path',async()=>{
  for(const previous of [profile(A,'SwiftOtter','someone-else'),profile(B,'SwiftOtter','uid-'+A)]){
    const db=new FirestoreSimulator().seed(profilePath(A),previous);
    await assert.rejects(save(db),error=>error.code==='account-session-conflict');
    assert.equal(reads(db).length,0);assert.equal(db.attempts[0].writes.length,0);assert.equal(db.commits.length,0);
    assert.deepEqual(db.data(profilePath(A)),previous);
  }
});

test('collision retains an allowed owned current profile name before creating a suffix',async()=>{
  const previous=profile(A,'CurrentRacer'),db=new FirestoreSimulator().seed(profilePath(A),previous)
    .seed(claimPath('CurrentRacer'),claim(A,'CurrentRacer',NOW-1000)).seed(claimPath('Requested'),claim(OTHER,'Requested'));
  assert.equal(await save(db,{requestedName:'Requested'}),'CurrentRacer');
  assert.equal(db.data(claimPath('CurrentRacer')).createdAt,NOW-1000);assert.equal(registryWrites(db).length,0);
});

test('blocked previous cloud name is never restored by collision fallback',async()=>{
  const db=new FirestoreSimulator().seed(profilePath(A),profile(A,'BlockedLegacy'))
    .seed(claimPath('BlockedLegacy'),claim(A,'BlockedLegacy')).seed(claimPath('Requested'),claim(OTHER,'Requested'));
  const assigned=await save(db,{requestedName:'Requested',isNameAllowed:name=>!name.startsWith('Blocked')});
  assert.equal(assigned,suffixName('Requested',A,4));assert.notEqual(assigned,'BlockedLegacy');
  assert.equal(db.data(claimPath('BlockedLegacy')),undefined,'release a blocked old claim only when actually owned');
});

test('old claim is read before writes and deleted only when owned and its key differs',async()=>{
  for(const oldOwner of [A,OTHER,null]){
    const db=new FirestoreSimulator().seed(profilePath(A),profile(A,'OldName'));
    if(oldOwner)db.seed(claimPath('OldName'),claim(oldOwner,'OldName'));
    assert.equal(await save(db,{requestedName:'NewName'}),'NewName');
    const trace=db.commits[0].events,firstWrite=trace.findIndex(event=>event.type!=='get');
    assert.ok(trace.slice(0,firstWrite).some(event=>event.path===claimPath('OldName')));
    assert.ok(trace.slice(firstWrite).every(event=>event.type!=='get'));
    assert.equal(registryWrites(db).filter(write=>write.type==='delete').length,oldOwner===A?1:0);
    if(oldOwner===OTHER)assert.equal(db.data(claimPath('OldName')).accountId,OTHER);
  }
  const db=new FirestoreSimulator().seed(profilePath(A),profile(A,'Racer')).seed(claimPath('Racer'),claim(A,'Racer',NOW-123));
  assert.equal(await save(db,{requestedName:'RACER'}),'RACER');
  assert.equal(registryWrites(db).filter(write=>write.type==='delete').length,0,'case-only rename keeps the same key');
  assert.equal(db.data(claimPath('Racer')).createdAt,NOW-123);
});

test('quota/permission failures on requested or old claim abort atomically without a fallback name or retry bypass',async()=>{
  for(const code of ['resource-exhausted','permission-denied'])for(const failOld of [false,true]){
    const failure=Object.assign(Error(code),{code});
    const db=new FirestoreSimulator({failRead:path=>path===claimPath(failOld?'OldName':'Requested')?failure:null})
      .seed(profilePath(A),profile(A,'OldName')).seed(claimPath('OldName'),claim(A,'OldName'));
    await assert.rejects(save(db,{requestedName:'Requested'}),error=>error===failure||error.code===code);
    assert.equal(db.attempts.length,1);assert.equal(db.commits.length,0);assert.equal(db.attempts[0].writes.length,0);
    assert.equal(db.data(claimPath('Requested')),undefined);assert.equal(db.data(profilePath(A)).name,'OldName');
  }
});

test('fully colliding registry fails closed with at most eight claim reads',async()=>{
  const db=new FirestoreSimulator();
  const original=db.runTransaction.bind(db);
  db.runTransaction=work=>original(tx=>{
    const get=tx.get;tx.get=async ref=>{
      const snapshot=await get(ref);
      return ref.path.startsWith(COLLECTION+'/')?{...snapshot,exists:true,data:()=>claim(OTHER,'Taken')}:snapshot;
    };return work(tx);
  });
  await assert.rejects(save(db),error=>error.code==='public-name-unavailable');
  assert.ok(reads(db).length<=8,'claim reads='+reads(db).length);assert.equal(registryWrites(db).length,0);
});

test('eight-read bound also covers legacy profiles whose name and nickname differ',async()=>{
  const requestedName='Requested',previous={...profile(A,'CurrentRacer'),nickname:'OldAlias'},db=new FirestoreSimulator().seed(profilePath(A),previous)
    .seed(claimPath(requestedName),claim(OTHER,requestedName)).seed(claimPath(previous.name),claim(OTHER,previous.name))
    .seed(claimPath(previous.nickname),claim(A,previous.nickname));
  for(const length of [4,6,8,12]){
    const candidate=suffixName(requestedName,A,length);db.seed(claimPath(candidate),claim(OTHER,candidate));
  }
  const assigned=await save(db,{requestedName});
  assert.ok(assigned.length<=24);
  assert.ok(reads(db).length<=8,'legacy name/nickname requires '+reads(db).length+' claim reads');
});

const patchPath=process.env.UNIQUE_PROFILE_NAME_PATCH||path.resolve(path.dirname(fileURLToPath(moduleURL)),'../polytrack_062_patch.js');
const patch=fs.readFileSync(patchPath,'utf8');
function section(start,end){const a=patch.indexOf(start),b=patch.indexOf(end,a+start.length);assert.ok(a>=0&&b>a,'integration source boundary '+start);return patch.slice(a,b);}
function actualWrapper(){
  const context={cloudOwnerConflicts:new Map(),profileNameModulePromise:Promise.resolve({claimProfileName,claimProfileNameWithLegacyBridge}),legacyNameTransactions:new WeakSet(),
    moderationDecision:name=>({blocked:name==='BlockedLegacy'}),eventsModuleUrl:'https://unused.invalid/events/client.mjs'};
  return vm.runInNewContext(section('  function assertCloudOwner(','  function showCloudOwnerConflict(')+
    section('  async function claimCloudProfileName(','  async function saveClaimedPublicProfile(')+';claimCloudProfileName;',context);
}
test('actual integration wrapper preserves the unchanged-name read optimization without bypassing owner/account checks',async()=>{
  for(const previous of [profile(A,'SwiftOtter','someone-else'),profile(B,'SwiftOtter','uid-'+A)]){
    const db=new FirestoreSimulator().seed(profilePath(A),previous),wrapper=actualWrapper();
    await assert.rejects(db.runTransaction(async tx=>{
      const ref=db.collection(PROFILES).doc(A),snapshot=await tx.get(ref);
      const name=await wrapper(db,tx,A,'uid-'+A,snapshot.data(),'SwiftOtter');
      tx.set(ref,{accountId:A,ownerUid:'uid-'+A,name,nickname:name});
    }),error=>error.code==='account-session-conflict');
    assert.equal(db.commits.length,0);assert.equal(registryWrites(db).length,0);
  }
});
test('actual moderator name-policy callback does not allow a blocked previous name when a reserved requested name collides',()=>{
  const region=section('const chosen=await (await profileNameModulePromise).claimProfileNameWithLegacyBridge(','            tx.set(profileRef,');
  const match=/isNameAllowed:([\s\S]*?)\}\);/.exec(region);assert.ok(match,'moderator policy callback exists');
  const allowed=vm.runInNewContext('('+match[1]+')',{
    isReservedOwnerName:true,requestedClean:'StaticQuasar931',replacement:'StaticQuasar931',
    moderationDecision:name=>({blocked:name==='BlockedLegacy'||name==='StaticQuasar931'}),
  });
  assert.equal(allowed('StaticQuasar931'),true,'the explicitly authorized reserved request remains allowed');
  assert.equal(allowed('BlockedLegacy'),false,'reserved-name exception must not apply to arbitrary previous-name fallbacks');
});
test('actual profile POST, PB transaction, repair and moderator paths claim names; cosmetic-only writes do not rename',()=>{
  const post=section("if (urlObj.pathname === '/user' || urlObj.pathname === '/v6/user') {","    if (urlObj.pathname === '/leaderboardUserEntry'");
  assert.match(post,/safeName=await syncAcknowledgedPublicIdentity\(d,accountId,safeName,countryCode,carStyle\)/);
  const identity=section('  function syncAcknowledgedPublicIdentity(','  let profileNameModulePromise=');
  assert.match(identity,/acceptedName=await claimCloudProfileName\(d,tx,accountId,ownerUid,data,name\)/);
  assert.ok(identity.indexOf('const previous=await tx.get(profileRef)')<identity.indexOf('await claimCloudProfileName('));
  assert.ok(identity.indexOf('await claimCloudProfileName(')<identity.indexOf('tx.set(profileRef,'));
  const pb=section('      const currentSnap = await tx.get(ref);','      // A receipt is written only after Firebase has committed');
  assert.ok(pb.indexOf('await tx.get(profileRef)')<pb.indexOf('await claimCloudProfileName('));
  assert.ok(pb.indexOf('await claimCloudProfileName(')<pb.indexOf('tx.set(ref,'));
  assert.match(patch,/name=await saveClaimedPublicProfile\(d,accountId,ownerUid,/);
  const repair=section('  async function saveClaimedPublicProfile(','  function overallFooterLayoutCss(');
  assert.ok(repair.indexOf('await claimCloudProfileName(')<repair.indexOf('tx.set(profileRef,'));
  const cosmetic=section('        const profileRef=fire.collection(\'0.6.2_profiles_public\')','        const latest=readCosmeticPublishQueue()');
  assert.doesNotMatch(cosmetic,/name:|nickname:/);
  assert.match(patch,/chosen=await \(await profileNameModulePromise\).claimProfileNameWithLegacyBridge/);
});

test('rollout bridge only downgrades a tagged registry read denial; quota and ownership failures remain fatal',async()=>{
  const db=new FirestoreSimulator();const denied=Object.assign(Error('not deployed'),{code:'permission-denied'});
  const writes=[];const tx={get:async()=>{throw denied;},set:(...x)=>writes.push(x),delete:(...x)=>writes.push(x)};
  const options={db,tx,accountId:A,ownerUid:'owner',requestedName:'NewRacer',crypto:webcrypto};
  assert.deepEqual(await claimProfileNameWithLegacyBridge(options),{name:'NewRacer',legacy:true});
  assert.equal(writes.length,0);
  for(const code of ['resource-exhausted','unavailable','public-name-unavailable']){
    const error=Object.assign(Error(code),{code});
    await assert.rejects(claimProfileNameWithLegacyBridge({...options,tx:{...tx,get:async()=>{throw error;}}}),cause=>cause===error);
  }
  await assert.rejects(claimProfileNameWithLegacyBridge({...options,ownerUid:''}),error=>error.code==='account-session-conflict');
});
