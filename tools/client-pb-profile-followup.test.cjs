const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {createRequire}=require('node:module');
const source=fs.readFileSync(path.join(__dirname,'../polytrack_062_patch.js'),'utf8');
// Reuse the existing offline mirror fixture without registering its tests.
const fixturePath=path.join(__dirname,'pb-exact-confirmation.test.cjs');
const fixtureSource=fs.readFileSync(fixturePath,'utf8');
const fixtureEnd=fixtureSource.indexOf("test('a committed exact PB");
assert.ok(fixtureEnd>0);
const fixture=vm.createContext({require:createRequire(fixturePath),__dirname,fetch:()=>{throw Error('OFFLINE_ONLY');}});
vm.runInContext(fixtureSource.slice(0,fixtureEnd)+'\nthis.makeMirror=mirrorHarness;this.makePb=pb;',fixture);
function extract(name){
  const start=source.indexOf('  '+(name==='assertCloudOwner'?'function ':'async function ')+name+'(');
  assert.ok(start>=0);return source.slice(start,source.indexOf('\n  }',start)+4);
}
const account='a'.repeat(64),key='polytrack-0.6.2-profile-signature-v1';
const exact=()=>({accountId:account,ownerUid:'uid',name:'Racer',nickname:'Racer',countryCode:null,carStyle:'style',isVerifier:false,pbCount:9,accountCreatedAt:100,totalPlaytimeMs:5000,latestPbAt:900});
function harness({profiles=[exact()],races,failCommit=false,afterRead,afterCommit,claimName}={}){
  const h=fixture.makeMirror({cloud:fixture.makePb(),publicationFails:false});
  const c=h.context,disk=new Map(),cost={raceReads:0,profileReads:0,writes:0,transactions:0,claims:0};
  let user={uid:'uid'},active=account;
  c.window.firebase.auth=()=>({currentUser:user});c.activeRankedAccountId=()=>active;
  c.localStorage={getItem:k=>disk.get(k)||null,setItem:(k,v)=>disk.set(k,v)};
  c.claimCloudProfileName=async(_d,_tx,id,uid,previous,name)=>{
    cost.claims++;
    if(previous&&(previous.accountId!==id||previous.ownerUid!==uid))throw Error('profile identity mismatch');
    return claimName?claimName(name,cost.claims):name;
  };
  vm.runInContext(extract('assertCloudOwner')+'\n'+extract('saveClaimedPublicProfile'),c);
  c.runFirebaseTransaction=async(_db,callback)=>{
    const primary=++cost.transactions===1;
    const attempts=primary?profiles:[profiles.at(-1)];
    for(let i=0;i<attempts.length;i++){
      const staged=[];
      await callback({get:async ref=>{
        const profile=ref.kind==='profiles';cost[profile?'profileReads':'raceReads']++;
        const value=profile?attempts[i]:races?races[i]:fixture.makePb();
        if(profile&&primary)afterRead?.(h,i);
        return {exists:!!value,data:()=>value};
      },set:(ref,value)=>staged.push({ref,value})});
      if(i===attempts.length-1){if(primary&&failCommit)throw Error('commit unavailable');cost.writes+=staged.length;h.writes.push(...staged);}
    }
    if(primary)afterCommit?.(h);
  };
  return Object.assign(h,{cost,disk,setUser:value=>{user=value;},setAccount:value=>{active=value;}});
}
test('fresh exact profile skips only the follow-up: two required reads, zero writes',async()=>{
  const h=harness(),result=await h.run();
  assert.equal(result.saved,false);assert.equal(result.cloudConfirmed,true);
  assert.deepEqual(h.cost,{raceReads:1,profileReads:1,writes:0,transactions:1,claims:0});
  assert.ok(h.disk.get(key));
});
for(const [field,value] of [['name','Other'],['nickname','Other'],['countryCode',''],['carStyle','other'],['isVerifier',true]]){
  test(`exact ${field} mismatch retains the original follow-up transaction`,async()=>{
    const h=harness({profiles:[{...exact(),[field]:value}]});await h.run();
    assert.equal(h.cost.profileReads,2);assert.equal(h.cost.transactions,2);assert.equal(h.cost.writes,1);assert.equal(h.cost.claims,1);
  });
}
test('missing profile retains follow-up creation',async()=>{
  const h=harness({profiles:[null]});await h.run();assert.equal(h.cost.profileReads,2);assert.equal(h.cost.writes,1);
});
test('wrong profile owner is still rejected by the original canonical ownership check',async()=>{
  const h=harness({profiles:[{...exact(),ownerUid:'foreign'}]});await h.run();
  assert.equal(h.cost.transactions,1);assert.equal(h.cost.writes,0);assert.equal(h.disk.has(key),false);
});
for(const change of [{accountId:'foreign'},{ownerUid:undefined}])test('profile identity mismatch cannot establish the shortcut: '+JSON.stringify(change),async()=>{
  const h=harness({profiles:[{...exact(),...change}]});await h.run();
  assert.equal(h.cost.transactions,2);assert.equal(h.cost.profileReads,2);assert.equal(h.cost.writes,0);assert.equal(h.disk.has(key),false);
});
for(const last of [null,{...exact(),nickname:'Changed'}])test('discarded matching attempt cannot acknowledge the final missing/mismatched profile: '+JSON.stringify(last),async()=>{
  const h=harness({profiles:[exact(),last]});await h.run();
  assert.equal(h.cost.raceReads,2);assert.equal(h.cost.profileReads,3);assert.equal(h.cost.transactions,2);assert.equal(h.cost.writes,1);
});
test('the final retry exact profile can suppress follow-up despite an earlier mismatch',async()=>{
  const h=harness({profiles:[{...exact(),name:'Old'},exact()]});await h.run();
  assert.equal(h.cost.profileReads,2);assert.equal(h.cost.transactions,1);assert.equal(h.cost.writes,0);
});
test('name claimed by an aborted improvement attempt is not reused by the winning no-improvement attempt',async()=>{
  const h=harness({profiles:[exact(),exact()],races:[null,fixture.makePb()],claimName:()=> 'AbortedName'});
  await h.run();assert.equal(h.cost.transactions,1);assert.equal(h.cost.writes,0);
  assert.equal(h.disk.get(key),account+'|Racer||style');
});
test('actual name-claim difference still executes follow-up and uses the accepted name',async()=>{
  const h=harness({profiles:[{...exact(),name:'Old',nickname:'Old'}],claimName:()=> 'Accepted'});
  await h.run();assert.equal(h.cost.transactions,2);assert.equal(h.writes[0].value.name,'Accepted');
});
test('failed final transaction cannot use an earlier matching read',async()=>{
  const h=harness({profiles:[exact(),exact()],failCommit:true});await h.run();
  assert.equal(h.cost.transactions,1);assert.equal(h.cost.writes,0);assert.equal(h.disk.has(key),false);
});
for(const when of ['afterRead','afterCommit'])for(const change of ['account','owner'])test(`${change} switch ${when} prevents follow-up and signature acknowledgement`,async()=>{
  const h=harness({[when]:h=>change==='account'?h.setAccount('other'):h.setUser({uid:'other'})});await h.run();
  assert.equal(h.cost.transactions,1);assert.equal(h.cost.writes,0);assert.equal(h.disk.has(key),false);
});
test('new auth object with the same UID must use the original follow-up, not inherit fresh-read proof',async()=>{
  const h=harness({afterCommit:h=>h.setUser({uid:'uid'})});await h.run();
  assert.equal(h.cost.transactions,2);assert.equal(h.cost.profileReads,2);assert.equal(h.cost.writes,1);
});
test('genuine PB improvement retains both reads, both writes and profile counters',async()=>{
  const h=harness({races:[null]});const result=await h.run();
  assert.equal(result.saved,true);assert.equal(h.cost.raceReads,1);assert.equal(h.cost.profileReads,1);assert.equal(h.cost.writes,2);
  const profile=h.writes.find(row=>row.ref.kind==='profiles').value;
  assert.equal(profile.pbCount,10);assert.equal(profile.accountCreatedAt,100);assert.equal(profile.totalPlaytimeMs,5000);
});
