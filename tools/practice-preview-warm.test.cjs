const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../polytrack_062_patch.js'),'utf8');
const code=source.slice(source.indexOf('  let practiceFullWarmTimer'),source.indexOf('  let practiceProfileRefreshTimer'));
function fixture(){
 let now=1000,next='B';
 const requests=[],document={visibilityState:'visible',body:{classList:{contains:()=>false}}},connection={saveData:false};
 const context={document,navigator:{connection},clearTimeout(){},Date:{now:()=>now},localInsights:{play:()=>true,predict:()=>({trackId:next}),action(){}},readPublicSnapshotBackup(kind,id){assert.equal(kind,'track-preview');return new Promise((resolve,reject)=>requests.push({id,resolve,reject}));}};
 vm.runInNewContext(code,context);
 return {document,connection,requests,warm:id=>context.warmPracticeTrack(id),play:()=>context.warmPlayedTrack('A'),next:id=>next=id,advance:ms=>now+=ms};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('only real prediction requests spend the rolling two-per-minute allowance',async()=>{
 const f=fixture();f.document.visibilityState='hidden';f.play();assert.equal(f.requests.length,0);
 f.document.visibilityState='visible';f.play();assert.deepEqual(f.requests.map(r=>r.id),['A','B']);
 f.requests.forEach(r=>r.resolve({}));await settle();
 f.next('C');f.play();f.requests.at(-1).resolve({});await settle();
 f.next('D');f.play();assert.deepEqual(f.requests.map(r=>r.id),['A','B','C']);
 f.advance(60000);f.play();assert.equal(f.requests.at(-1).id,'D');
});
test('deduplicates in-flight and cached previews, with bounded retry after a transient failure',async()=>{
 const f=fixture();f.connection.saveData=true;assert.equal(f.warm('A'),false);assert.equal(f.requests.length,0);
 f.connection.saveData=false;assert.equal(f.warm('A'),true);assert.equal(f.warm('A'),false);
 f.requests[0].reject(Error('transient'));await settle();
 assert.equal(f.warm('A'),false);f.advance(15000);assert.equal(f.warm('A'),true);
 assert.equal(f.warm('B'),true);assert.equal(f.warm('C'),false);
 f.requests[1].resolve({});await settle();assert.equal(f.warm('A'),false);assert.equal(f.warm('C'),true);
});
