import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const begin=source.indexOf('  async function syncExtraTrackStatistics(){');
const end=source.indexOf('\n  function ',begin+1);
assert.ok(begin>=0&&end>begin);
const body=source.slice(begin,end);
function harness({reject=false,missing=false}={}){
  const calls=[],updates=[];let info={generation:69,epoch:1,baseUrl:'https://example.test/public-snapshots69/'};
  let resolve;const gate=new Promise(done=>{resolve=done;});
  const reader=async kind=>{calls.push(kind);if(reject)throw Error('offline');return gate;};
  reader.packageInfo=()=>({...info});
  const context={publicSnapshotReaderPromise:missing?null:Promise.resolve(reader),readPublicSnapshotBackup:async()=>{calls.push('bootstrap');context.publicSnapshotReaderPromise=Promise.resolve(reader);},extraTracksUi:{setSnapshotStatistics:value=>updates.push(value)}};
  const sync=vm.runInNewContext(body+';syncExtraTrackStatistics',context);
  return {sync,calls,updates,resolve,change:next=>{info={...info,...next};}};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('Extra Tracks uses one statistics artifact, never per-track boards or replays',async()=>{
  const h=harness(),pending=h.sync();await tick();h.resolve({schemaVersion:1,tracks:{}});await pending;
  assert.deepEqual(h.calls,['track-statistics']);assert.equal(h.updates[0].generation,69);
  assert.equal(h.updates[0].statistics.schemaVersion,1);
});
for(const change of [{generation:70},{epoch:2},{baseUrl:'https://example.test/other/'}])test('late popularity results cannot cross snapshot identity '+JSON.stringify(change),async()=>{
  const h=harness(),pending=h.sync();await tick();h.change(change);h.resolve({schemaVersion:1,tracks:{}});await pending;
  assert.deepEqual(h.updates,[]);
});
test('an unopened reader bootstraps locally and metadata failures do not reject UI actions',async()=>{
  const h=harness({missing:true}),pending=h.sync();await tick();h.resolve({schemaVersion:1,tracks:{}});await pending;
  assert.deepEqual(h.calls,['bootstrap','track-statistics']);assert.equal(h.updates.length,1);
  await assert.doesNotReject(harness({reject:true}).sync());
});
