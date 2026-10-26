import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicSnapshotReader} from './public-snapshot-client.mjs';
const entry={uploadId:42,accountId:'a'.repeat(64),trackId:'b'.repeat(64)};
const row={...entry,updatedAt:1,recording:'AAAA',frames:1000,verifiedState:1};

test('playback failures report safe classifications, not error text or public identities',async()=>{
 for(const [message,code]of [['Public replay work limit','REPLAY_BUDGET'],['Public recording hash mismatch','REPLAY_INTEGRITY'],['Worker attestation failed','REPLAY_ENGINE'],['binding changed','REPLAY_BINDING'],['unknown private debug content','REPLAY_UNAVAILABLE']]){
  const events=[];
  const read=createPublicSnapshotReader({baseUrl:'https://fixture.invalid/public-snapshots60/',fetchImpl:async()=>Response.json(row),prepareRecording:()=>{throw Error(message);},onPlaybackFailure:event=>events.push(event)});
  assert.equal(await read.recordingPlayback(entry),null);assert.deepEqual(events,[{code}]);
 }
});

test('missing recordings report once and diagnostic observer failures cannot break playback handling',async()=>{
 const events=[];
 const read=createPublicSnapshotReader({baseUrl:'https://fixture.invalid/public-snapshots60/',fetchImpl:async()=>new Response('',{status:404}),onPlaybackFailure:event=>events.push(event)});
 assert.equal(await read.recordingPlayback(entry),null);assert.deepEqual(events,[{code:'REPLAY_UNAVAILABLE'}]);
 const broken=createPublicSnapshotReader({baseUrl:'https://fixture.invalid/public-snapshots60/',fetchImpl:async()=>Response.json(row),prepareRecording:()=>{throw Error('bad hash');},onPlaybackFailure:()=>{throw Error('observer failed');}});
 assert.equal(await broken.recordingPlayback(entry),null);
});
