import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {createLedgerEntry,ledgerBinding,ledgerKey} from './native-verification-ledger.mjs';
import {createCanonicalRetentionCapture} from './canonical-retention-capture.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex'),track='b'.repeat(64),account='a'.repeat(64),engine='c'.repeat(64),content='d'.repeat(64),fingerprint='e'.repeat(64),manifestHash='f'.repeat(64);
function fixture(){
 const replay=deflateSync(Buffer.alloc(15)).toString('base64url'),replayHash=sha(replay),geometry={parts:20,spanX:100,spanZ:120};
 const policy={engineDigest:engine,compatibleEngines:[],verifierVersion:'polytrack-native-bounded-v1',verifierFingerprint:fingerprint,resourceProfiles:['standard'],reviewPolicyVersions:['review-v1'],trackContentHashes:{[track]:content},trackGeometries:{[track]:{geometryPolicy:'default',trackGeometry:geometry}}};
 const job={lane:'normal',accountId:account,trackId:track,timeMs:15000,frames:900,uploadId:10,replayHash,replay,resultId:account+'_'+track};
 const binding={verifierVersion:policy.verifierVersion,verifierFingerprint:fingerprint,resourceProfile:'standard',resultId:job.resultId,trackId:track,timeMs:job.timeMs,replayHash,actualReplayHash:replayHash,nativeTrackId:track,trackContentHash:content,engineDigest:engine};
 const nativeResult={resultId:job.resultId,trackId:track,timeMs:job.timeMs,replayHash,status:'verified',reason:'native_exact_finish',deterministic:true,engineDigest:engine,trackContentHash:content,trackGeometry:geometry,geometryPolicy:'default',binding,boundInputFingerprint:sha(JSON.stringify(binding))};
 const review={complete:true,disposition:'approved',bindingKey:ledgerKey(ledgerBinding(job)),policyVersion:'review-v1',attestationHash:sha('review')};
 const proof=createLedgerEntry({job,result:nativeResult,nativeResult,review,verifiedAt:100,lane:'normal',policy});
 const row={...job,runVerified:true,verified:true,verifiedState:1,nativeLedgerKey:proof.key,nativeLedgerManifestHash:manifestHash};delete row.replay;
 const board={trackId:track,complete:true,sourceComplete:true,totalEntriesExact:true,ranksExact:true,totalEntries:1,updatedAt:1,revision:1,entries:[row]},current={...board,totalEntries:0,entries:[]};
 return {ledger:{manifestHash,entries:[proof]},row,prior:board,board:current,canonical:{...job,verified:false,verifiedState:0}};
}
test('current exact proof gates retention and the shared budget leaves replay allowance',async()=>{
 const f=fixture();let reads=0;const capture=createCanonicalRetentionCapture({ledger:f.ledger,readLimit:2,readCanonical:async()=>{reads++;return{data:f.canonical};}});
 const result=await capture.reconcile({trackId:track,prior:f.prior,board:f.board});assert.equal(result.retained.length,1);assert.equal(result.board.entries[0].runVerified,true);assert.equal(capture.usedDocuments(),1);assert.equal(reads,1);
 await assert.rejects(capture.reconcile({trackId:track,prior:f.prior,board:f.board}),/budget/);assert.equal(reads,1);assert.equal(2-capture.usedDocuments(),1);
 assert.equal(createCanonicalRetentionCapture({ledger:f.ledger,readLimit:1000,readCanonical:async()=>null}).report().maxDocuments,32);
});
test('stale ledger stamps or altered bindings never issue a canonical read',async()=>{
 for(const change of [{nativeLedgerManifestHash:'0'.repeat(64)},{nativeLedgerKey:'0'.repeat(64)},{timeMs:15001}]){
  const f=fixture();f.prior.entries=[{...f.row,...change}];let reads=0;const capture=createCanonicalRetentionCapture({ledger:f.ledger,readLimit:100,readCanonical:async()=>{reads++;return{data:f.canonical};}});
  await assert.rejects(capture.reconcile({trackId:track,prior:f.prior,board:f.board}),/native proof/);assert.equal(reads,0);
 }
});
test('invalid shared budgets are rejected without credentials or transport',()=>{
 const f=fixture();for(const readLimit of [0,1,-1,2001,Infinity,NaN])assert.throws(()=>createCanonicalRetentionCapture({ledger:f.ledger,readLimit,readCanonical:async()=>null}),/Invalid/);
});
