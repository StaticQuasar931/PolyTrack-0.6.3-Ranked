import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readSavedArchiveTrack} from './archive-track.mjs';
import {mergeWeeklySelections} from '../tools/archive-weekly-selections.mjs';
import {matchingEventRuns} from './session.mjs';
const id='a'.repeat(64),code='PolyTrack'+'A'.repeat(80),hash=createHash('sha256').update(code).digest('hex');
function fixture({manifest=[{trackId:id,codeHash:hash,assetPath:`assets/${hash}.track`}],body=code,decodeId=id}={}) {
 const requests=[];
 return {requests,options:{baseUrl:'https://saved.test/events/client.mjs',decode:()=>({trackData:{getId:()=>decodeId}}),fetcher:async url=>{
   requests.push(String(url));return new Response(String(url).endsWith('.json')?JSON.stringify(manifest):body);
 }}};
}
test('archive imports use exactly a packaged manifest and hash-verified identity-bound track',async()=>{
 const f=fixture();assert.equal(await readSavedArchiveTrack({trackId:id},f.options),code);
 assert.deepEqual(f.requests,['https://saved.test/events/kodub/trusted-tracks.json',`https://saved.test/events/kodub/assets/${hash}.track`]);
});
test('missing tracks, malicious paths, corrupt bytes and wrong decoded identities fail closed',async()=>{
 for(const options of [{manifest:[]},{manifest:[{trackId:id,codeHash:hash,assetPath:'https://evil.test/track'}]},{body:code+'A'},{decodeId:'b'.repeat(64)}]){
  const f=fixture(options);await assert.rejects(readSavedArchiveTrack({trackId:id},f.options));
  assert.ok(f.requests.every(url=>url.startsWith('https://saved.test/events/kodub/')));assert.ok(f.requests.length<=2);
 }
});
test('canceled archive imports never hand back a code',async()=>{
 const f=fixture();assert.equal(await readSavedArchiveTrack({trackId:id},{...f.options,isCurrent:()=>false}),null);
 assert.equal(f.requests.length,0);
});

test('canceling while the manifest loads does not start a second asset read',async()=>{
 const f=fixture();let current=true;
 const fetcher=async(...args)=>{const result=await f.options.fetcher(...args);current=false;return result;};
 assert.equal(await readSavedArchiveTrack({trackId:id},{...f.options,fetcher,isCurrent:()=>current}),null);
 assert.equal(f.requests.length,1);
});

test('missing track assets do not promise that final standings exist',async()=>{
 const f=fixture({manifest:[]});
 await assert.rejects(readSavedArchiveTrack({trackId:id},f.options),/standings, if available/);
});
test('saved selections preserve repeated tracks in different weeks and all details',()=>{
 const first={trackId:id,name:'Old track',author:'Author',environment:1,endTime:'2026-09-20T20:00:00Z',trackUrl:`assets/${hash}.track`};
 const second={...first,endTime:'2026-09-27T20:00:00Z'};
 const rows=mergeWeeklySelections([first],second);assert.equal(rows.length,2);assert.equal(rows[0].author,'Author');
 assert.throws(()=>mergeWeeklySelections(rows,{...first,trackId:'b'.repeat(64)}),/Conflicting/);
});
test('old weekly practice and archived replay finishes cannot alter closed Event RP',()=>{
 const period={id:'old',kind:'kodub',trackId:id,startsAt:100,endsAt:200};
 const run={raceId:'practice-or-replay',accountId:id,trackId:id,timeMs:1};
 for(const at of [200,201,100000])assert.deepEqual(matchingEventRuns(run,[period],id,at),[]);
 assert.deepEqual(matchingEventRuns(run,[{...period,archived:true}],id,150),[]);
});
