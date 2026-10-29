const fs=require('node:fs'),vm=require('node:vm'),test=require('node:test'),assert=require('node:assert/strict');
const source=fs.readFileSync(require('node:path').join(__dirname,'../polytrack_062_patch.js'),'utf8');
const start=source.indexOf('  async function repairOwnNativeRecording('),end=source.indexOf('\n  const LOCAL_RACE_STORE_KEY',start);
assert.ok(start>0&&end>start);
const account='a'.repeat(64),other='c'.repeat(64),track='b'.repeat(64);
function harness({rows=[{accountId:account,trackId:track,uploadId:8}],cloud={},switchIdentity=false}={}){
 const reads=[],writes=[];let current=account;
 const context={Set,Promise,activeRankedAccountId:()=>current,window:{firebase:{auth:()=>({currentUser:{uid:'owner'}}),firestore:{FieldValue:{serverTimestamp:()=> 'server-time'}}}},
  readLocalRaceRows:()=>rows,safeRecordingId:value=>Number(value)||null,COLLECTIONS:{raceResults:'race-results'},
  recordingRepairPatch:()=>({replay:'repaired'})};
 vm.createContext(context);vm.runInContext(source.slice(start,end),context);
 const database={collection:name=>{assert.equal(name,'race-results');return {doc:id=>({get:async()=>{reads.push(id);if(switchIdentity)current=other;return{exists:true,data:()=>({ownerUid:'owner',accountId:account,trackId:track,uploadId:8,...cloud})};},set:async patch=>writes.push({id,patch})})};}};
 return {run:()=>context.repairOwnNativeRecording(database,8,'replay',{},'style',null,null),reads,writes};
}
test('recording repair addresses the owned PB key rather than querying public uploads',async()=>{
 const h=harness({rows:[{accountId:other,trackId:track,uploadId:8},{accountId:account,trackId:track,uploadId:8},{accountId:account,trackId:track,uploadId:8}]});
 assert.equal(await h.run(),1);assert.deepEqual(h.reads,[account+'_'+track]);assert.equal(h.writes.length,1);
 assert.doesNotMatch(source.slice(start,end),/\.where\(/);
});
test('unknown recording has no Firebase document reads',async()=>{const h=harness({rows:[]});assert.equal(await h.run(),0);assert.equal(h.reads.length,0);});
test('colliding upload IDs cannot modify another owner, account, track or recording',async()=>{
 for(const cloud of [{ownerUid:'foreign'},{accountId:other},{trackId:'d'.repeat(64)},{uploadId:9}]){const h=harness({cloud});assert.equal(await h.run(),0);assert.equal(h.writes.length,0);}
});
test('profile switches during a read prevent the stale repair write',async()=>{const h=harness({switchIdentity:true});assert.equal(await h.run(),0);assert.equal(h.writes.length,0);});
test('public recording and profile fallbacks no longer use Firebase collection scans',()=>{
 const replay=source.slice(source.indexOf('  async function loadNativeRecordings(ids){'),start);
 assert.doesNotMatch(replay,/await db\(|\.collection\(/);
 assert.doesNotMatch(source,/collection\(COLLECTIONS\.raceResults\)\.where\(/);
 const cosmetics=source.slice(source.indexOf('  async function syncCosmeticDirectory('),source.indexOf('  function sanitizeProfileCosmetics('));
 assert.doesNotMatch(cosmetics,/await db\(|\.collection\(/);
});
