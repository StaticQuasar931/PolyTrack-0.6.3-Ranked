const fs=require('node:fs'),vm=require('node:vm'),test=require('node:test'),assert=require('node:assert/strict');
const source=fs.readFileSync(require('node:path').join(__dirname,'../polytrack_062_patch.js'),'utf8');
const start=source.indexOf('  async function readNativeRecordings(ids){'),end=source.indexOf('  async function loadNativeRecordings(ids){',start);
assert.ok(start>=0&&end>start);
function harness(){
 const calls=[],pending=new Map();
 const context={Map,Set,Promise,playbackWorkerBridgePromise:Promise.resolve(null),nativeRecordingRequests:pending,loadNativeRecordings:ids=>new Promise((resolve,reject)=>calls.push({ids:Array.from(ids),resolve,reject}))};
 vm.createContext(context);vm.runInContext(source.slice(start,end),context);
 return {read:context.readNativeRecordings,calls,pending};
}
test('overlapping replay selections share in-flight IDs and retain caller order',async()=>{
 const h=harness();const first=h.read([1]);const overlap=h.read([2,1,2]);const same=h.read([1]);
 assert.deepEqual(h.calls.map(c=>c.ids),[[1],[2]]);
 const one={recording:'one'},two={recording:'two'};
 h.calls[1].resolve([two]);h.calls[0].resolve([one]);
 assert.deepEqual(Array.from(await first),[one]);assert.deepEqual(Array.from(await overlap),[two,one,two]);assert.deepEqual(Array.from(await same),[one]);
 assert.equal(h.pending.size,0);
});
test('duplicate and empty selections do not add loads',async()=>{
 const h=harness();assert.deepEqual(Array.from(await h.read([])),[]);assert.equal(h.calls.length,0);
 const result=h.read([7,7]);assert.deepEqual(h.calls[0].ids,[7]);h.calls[0].resolve([null]);assert.deepEqual(Array.from(await result),[null,null]);assert.equal(h.pending.size,0);
});
test('failed replay batches release every owned pending ID for a later retry',async()=>{
 const h=harness();const first=h.read([1,2]),overlap=h.read([2]);
 const failed=Promise.allSettled([first,overlap]);h.calls[0].reject(Error('offline'));assert.ok((await failed).every(r=>r.status==='rejected'));assert.equal(h.pending.size,0);
 const retry=h.read([2]);assert.equal(h.calls.length,2);h.calls[1].resolve([{recording:'retry'}]);assert.equal((await retry)[0].recording,'retry');assert.equal(h.pending.size,0);
});
