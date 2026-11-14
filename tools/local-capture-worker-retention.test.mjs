import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {createLedgerEntry,ledgerBinding,ledgerKey} from './native-verification-ledger.mjs';
import {createLocalCanonicalRetention,runLocalSnapshotBackup} from './local-capture-worker.mjs';
import {createFirestoreCaller,encode} from './verifier/firestore.mjs';
import {createFullSnapshotReadFence} from './full-snapshot-read-fence.mjs';
test.beforeEach(t=>t.mock.method(globalThis,'fetch',()=>assert.fail('No live network permitted')));
const sha=value=>createHash('sha256').update(value).digest('hex');
const track='b'.repeat(64),account='a'.repeat(64),engine='c'.repeat(64),content='d'.repeat(64),fingerprint='e'.repeat(64),manifestHash='f'.repeat(64);
function fixture(){
 const replay=deflateSync(Buffer.alloc(15)).toString('base64url'),replayHash=sha(replay),geometry={parts:20,spanX:100,spanZ:120};
 const policy={engineDigest:engine,compatibleEngines:[],verifierVersion:'polytrack-native-bounded-v1',verifierFingerprint:fingerprint,resourceProfiles:['standard'],reviewPolicyVersions:['review-v1'],trackContentHashes:{[track]:content},trackGeometries:{[track]:{geometryPolicy:'default',trackGeometry:geometry}}};
 const job={lane:'normal',accountId:account,trackId:track,timeMs:15000,frames:900,uploadId:10,replayHash,replay,resultId:account+'_'+track};
 const binding={verifierVersion:policy.verifierVersion,verifierFingerprint:fingerprint,resourceProfile:'standard',resultId:job.resultId,trackId:track,timeMs:job.timeMs,replayHash,actualReplayHash:replayHash,nativeTrackId:track,trackContentHash:content,engineDigest:engine};
 const nativeResult={resultId:job.resultId,trackId:track,timeMs:job.timeMs,replayHash,status:'verified',reason:'native_exact_finish',deterministic:true,engineDigest:engine,trackContentHash:content,trackGeometry:geometry,geometryPolicy:'default',binding,boundInputFingerprint:sha(JSON.stringify(binding))};
 const review={complete:true,disposition:'approved',bindingKey:ledgerKey(ledgerBinding(job)),policyVersion:'review-v1',attestationHash:sha('review')};
 const proof=createLedgerEntry({job,result:nativeResult,nativeResult,review,verifiedAt:100,lane:'normal',policy});
 const row={...job,runVerified:true,verified:true,verifiedState:1,nativeLedgerKey:proof.key,nativeLedgerManifestHash:manifestHash};delete row.replay;
 const prior={trackId:track,complete:true,sourceComplete:true,totalEntriesExact:true,ranksExact:true,totalEntries:1,updatedAt:1,revision:1,entries:[row]};
 return {ledger:{manifestHash,entries:[proof]},prior,board:{...prior,totalEntries:0,entries:[]},canonical:{...job,verified:false,verifiedState:0}};
}
function transport(f,{initialDirectReservations=0,status=200,change=value=>value}={}){
 let calls=0,connects=0;
 const name='projects/polytrack-052/databases/(default)/documents/0.6.2_race_results/'+account+'_'+track;
 const fence=createFullSnapshotReadFence({initialDirectReservations,fetchImpl:async(url,options)=>{
  calls++;assert.equal(url,'https://firestore.googleapis.com/v1/'+name.split('/0.6.2_race_results/')[0]+':batchGet');
  assert.equal(options.method,'POST');assert.deepEqual(JSON.parse(options.body),{documents:[name]});
  return Response.json(change([{found:{name,fields:encode(f.canonical).mapValue.fields,updateTime:'2026-11-14T08:00:01Z'}}]),{status});
 }});
 const db=createFirestoreCaller({base:'https://firestore.googleapis.com/v1/projects/polytrack-052/databases/(default)/documents',access:'fixture',fetchImpl:fence.fetch,mode:'scheduled',maxReadRetries:0,documentReadLimit:32,documentWriteLimit:1});
 const connectImpl=async(credential,options)=>{connects++;assert.equal(credential,'synthetic-only');assert.deepEqual(options,{env:{},mode:'scheduled',maxReadRetries:0,documentReadLimit:32,documentWriteLimit:1});return db;};
 return {connectImpl,fence,db,calls:()=>calls,connects:()=>connects};
}
const input=f=>({trackId:track,prior:f.prior,board:f.board});
test('local backup wrapper installs proof-gated retention through caller and unchanged POST fence',async()=>{
 const f=fixture(),tr=transport(f),logs=[];let backups=0;
 const result=await runLocalSnapshotBackup({nativeVerification:{ledger:f.ledger},marker:1},{serviceAccount:'synthetic-only',connectImpl:tr.connectImpl,log:v=>logs.push(JSON.parse(v)),backup:async options=>{
  backups++;assert.equal(options.marker,1);return options.reconcileCanonicalTrack(input(f));
 }});
 assert.equal(backups,1);assert.equal(result.retained.length,1);assert.equal(result.board.entries[0].runVerified,true);
 assert.equal(tr.calls(),1);assert.equal(tr.fence.report().directDocumentReadReservations,1);assert.equal(tr.db.writeAttempts(),0);
 assert.equal(logs[0].localCanonicalRetention.maxDocuments,32);assert.equal(logs[0].replayDocumentLimit,1000);
});
test('no missing accounts and stale ledger proofs never authenticate',async()=>{
 const f=fixture(),tr=transport(f),retention=createLocalCanonicalRetention({ledger:f.ledger,serviceAccount:'synthetic-only',connectImpl:tr.connectImpl});
 await retention.reconcile({...input(f),board:f.prior});f.prior.entries[0].nativeLedgerManifestHash='0'.repeat(64);
 await assert.rejects(retention.reconcile(input(f)),/native proof/);assert.equal(tr.connects(),0);assert.equal(tr.calls(),0);
});
test('local helper retains 32-read sublimit and shares remaining transport reservations',async()=>{
 const f=fixture(),tr=transport(f),helper=createLocalCanonicalRetention({ledger:f.ledger,serviceAccount:'synthetic-only',connectImpl:tr.connectImpl});
 for(let i=0;i<32;i++)await helper.reconcile(input(f));
 await assert.rejects(helper.reconcile(input(f)),/budget/);assert.equal(tr.calls(),32);assert.equal(tr.connects(),1);
 const capped=transport(f,{initialDirectReservations:25000}),denied=createLocalCanonicalRetention({ledger:f.ledger,serviceAccount:'synthetic-only',connectImpl:capped.connectImpl});
 await assert.rejects(denied.reconcile(input(f)),/budget/);assert.equal(capped.calls(),0);assert.equal(capped.fence.report().maxWorkerRequests,1024);
});
for(const kind of ['missing','wrong-name','extra','quota','auth','forbidden'])test('exact POST retention fails closed without retry: '+kind,async()=>{
 const f=fixture(),tr=transport(f,{status:kind==='quota'?429:kind==='auth'?401:kind==='forbidden'?403:200,change:rows=>{
  if(kind==='missing')return [{missing:rows[0].found.name}];if(kind==='wrong-name')rows[0].found.name+='bad';if(kind==='extra')rows.push(rows[0]);return rows;
 }}),helper=createLocalCanonicalRetention({ledger:f.ledger,serviceAccount:'synthetic-only',connectImpl:tr.connectImpl});
 await assert.rejects(helper.reconcile(input(f)));await assert.rejects(helper.reconcile(input(f)),/stopped/);
 assert.equal(tr.calls(),1);assert.deepEqual(helper.report().retained,[]);assert.equal(tr.db.writeAttempts(),0);
});
for(const kind of ['time','replay','held'])test('local wiring cannot bypass canonical binding/replay/status validation: '+kind,async()=>{
 const f=fixture();if(kind==='time')f.canonical.timeMs++;if(kind==='replay')f.canonical.replay='AAAA';if(kind==='held')f.canonical.reviewHold=true;
 const tr=transport(f),helper=createLocalCanonicalRetention({ledger:f.ledger,serviceAccount:'synthetic-only',connectImpl:tr.connectImpl});
 await assert.rejects(helper.reconcile(input(f)));assert.equal(tr.calls(),1);assert.deepEqual(helper.report().retained,[]);
});
test('invalid ledger and injected callback fail before backup or authentication',async()=>{
 const connectImpl=()=>assert.fail('No authentication'),backup=()=>assert.fail('No backup');
 await assert.rejects(runLocalSnapshotBackup({},{connectImpl,backup}),/Invalid canonical/);
 await assert.rejects(runLocalSnapshotBackup({reconcileCanonicalTrack:()=>{}},{connectImpl,backup}),/locally bound/);
});
