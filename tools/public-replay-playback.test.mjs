import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {preparePublicRecordingPlayback,validatePublicReplayStructure} from './public-replay-playback.mjs';
import {createPublicSnapshotReader} from './public-snapshot-client.mjs';
import {encodeSnapshot} from './snapshot-package.mjs';
import {enrichPublicEventDates} from './public-event-dates.mjs';
const recording=deflateSync(Buffer.alloc(15)).toString('base64url'),replayHash=createHash('sha256').update(recording).digest('hex');
const entry={accountId:'a'.repeat(64),trackId:'b'.repeat(64),uploadId:12,timeMs:5000,frames:5000,raceTimeFrames:5000,replayHash,
 runVerified:false,verified:false,integrityVerified:true,verifiedState:0};
const row={...entry,recording};
test('pending playback is opt-in and never becomes a verification badge or RP proof',async()=>{
 await assert.rejects(preparePublicRecordingPlayback(row,entry));
 const value=await preparePublicRecordingPlayback(row,entry,{allowPending:true});
 assert.equal(value.playbackPending,true);assert.equal(value.verifiedState,0);assert.equal(value.eventRpEligible,false);
 assert.equal(value.verificationStatus,'pending');assert.equal(value.proof,undefined);assert.equal(entry.verified,false);
});
test('terminal and unknown statuses on either payload or selected public row fail closed for pending and verified playback',async()=>{
 for(const field of ['verificationStatus','validationState','status']){
  for(const status of ['rejected','mismatch','unavailable_final','expired','flagged','manual_review','deleted','unknown_status','',null]){
   for(const verified of [false,true]){
    const payload=verified?{...row,runVerified:true,verified:true,verifiedState:1}:row;
    const selected=verified?{...entry,runVerified:true,verified:true,verifiedState:1}:entry;
    await assert.rejects(preparePublicRecordingPlayback({...payload,[field]:status},selected,{allowPending:true}),/status not eligible/);
    await assert.rejects(preparePublicRecordingPlayback(payload,{...selected,[field]:status},{allowPending:true}),/status not eligible/);
   }
  }
 }
});
test('known waiting status remains pending, and valid verified status remains verified',async()=>{
 const pending=await preparePublicRecordingPlayback({...row,verificationStatus:'waiting'},{...entry,validationState:'integrity'},{allowPending:true});
 assert.equal(pending.verifiedState,0);assert.equal(pending.eventRpEligible,false);
 const verified=await preparePublicRecordingPlayback({...row,verifiedState:1,verificationStatus:'verified'},{...entry,runVerified:true,verified:true,verificationStatus:'verified'});
 assert.equal(verified.verifiedState,1);
});
test('pending playback rejects identity/hash/size/frame/status mismatches and private metadata',async()=>{
 for(const patch of [{accountId:'c'.repeat(64)},{trackId:'c'.repeat(64)},{frames:1},{uploadId:99},{recording:'tampered'},{verifiedState:1},{recording:'x'.repeat(850001)}])
  await assert.rejects(preparePublicRecordingPlayback({...row,...patch},entry,{allowPending:true}));
 const value=await preparePublicRecordingPlayback({...row,proof:'private',ownerUid:'private'},entry,{allowPending:true});
 assert.equal(value.ownerUid,undefined);assert.equal(value.proof,undefined);
});
test('verified playback remains verified and cannot approve event RP',async()=>{
 const value=await preparePublicRecordingPlayback({...row,verifiedState:1},{...entry,runVerified:true,verified:true,verifiedState:1});
 assert.equal(value.verifiedState,1);assert.equal(value.playbackPending,false);assert.equal(value.eventRpEligible,false);
});
test('all saved board rows enrich only exact verdict dates, not submission timestamps',()=>{
 const accountId=entry.accountId,periodId='w_20261019',trackId=entry.trackId;
 const board={id:periodId,period:{trackId},entries:[{accountId,timeMs:5000,submittedAt:10},{accountId:'c'.repeat(64),timeMs:6000,submittedAt:20}]};
 const replay={periodId,trackId,accountId,timeMs:5000,frames:5000,runId:'d'.repeat(64),replayHash,verifiedAt:30};
 const result=enrichPublicEventDates(board,[replay]);assert.equal(result.entries[0].verifiedAt,30);assert.equal(result.entries[0].submittedAt,10);
 assert.equal(result.entries[1].verifiedAt,undefined);assert.equal(board.entries[0].verifiedAt,undefined);
 assert.equal(enrichPublicEventDates(board,[{...replay,timeMs:5001}]).entries[0].verifiedAt,undefined);
 assert.equal(enrichPublicEventDates({...board,entries:[{...board.entries[0],pending:true}]},[replay]).entries[0].verifiedAt,undefined);
});
test('malformed compressed structure and trailing/unordered transitions fail closed',async()=>{
 for(const bytes of [Buffer.alloc(14),Buffer.alloc(16),Buffer.from([2,0,0,1,0,0,0,0,0,...Array(12).fill(0)])])
  await assert.rejects(validatePublicReplayStructure(deflateSync(bytes).toString('base64url'),5000));
 await assert.rejects(validatePublicReplayStructure(recording,4000001));
 await assert.rejects(validatePublicReplayStructure('not+base64',5000));
});
test('snapshot reader exposes pending viewing only through opt-in exact public binding and keeps status unchecked',async()=>{
 const data={...row,updatedAt:10},bytes=await encodeSnapshot(data),hash=createHash('sha256').update(bytes).digest('hex');
 const read=createPublicSnapshotReader({packed:true,baseUrl:'https://example.invalid/public-snapshots57/',fetchImpl:async(url,options)=>{
  assert.equal(options.credentials,'omit');
  return String(url).endsWith('index.json')?Response.json({schemaVersion:1,generation:57,encoding:'gzip-xor-a7-v1',files:{'recordings/12.json':{path:hash+'.bin',sha256:hash,decodedBytes:Buffer.byteLength(JSON.stringify(data))}}}):new Response(bytes);
 }});
 assert.equal(await read.recordingPlayback(entry),null);
 assert.equal(await read('recording',12),null,'legacy unbound path cannot bypass pending binding checks');
 const value=await read.recordingPlayback(entry,{allowPending:true});
 assert.equal(value.verifiedState,0);assert.equal(value.playbackPending,true);assert.equal(value.eventRpEligible,false);
 assert.equal(await read.recordingPlayback({...entry,replayHash:'f'.repeat(64)},{allowPending:true}),null);
});

test('release280: public playback retains the exact pre-hash payload and selected binding',async()=>{
 const selected={...entry},input={...row,carStyle:'original'};
 const work=preparePublicRecordingPlayback(input,selected,{allowPending:true});
 input.frames=selected.frames=999;
 input.carStyle='changed';selected.accountId='c'.repeat(64);selected.uploadId=77;
 const value=await work;
 assert.equal(value.frames,row.frames);assert.equal(value.accountId,entry.accountId);
 assert.equal(value.uploadId,entry.uploadId);assert.equal(value.carStyle,'original');
});

test('release280: payload frame and time aliases must not contradict the selected row',async()=>{
 for(const change of [{raceTimeFrames:5001},{timeMs:5001}])
  await assert.rejects(preparePublicRecordingPlayback({...row,...change},entry,{allowPending:true}),/binding/);
});

test('release280: time equality binds time fields, not a frame-to-millisecond conversion',async()=>{
 const selected={...entry,timeMs:1234,frames:100,raceTimeFrames:100};
 for(const timeMs of [undefined,1234]){
  const input={...row,frames:100,raceTimeFrames:100,timeMs};
  assert.equal((await preparePublicRecordingPlayback(input,selected,{allowPending:true})).frames,100);
 }
});
