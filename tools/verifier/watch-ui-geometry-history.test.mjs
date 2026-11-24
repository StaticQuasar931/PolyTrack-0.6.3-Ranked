import test from 'node:test';
import assert from 'node:assert/strict';
import{readFileSync}from'node:fs';
import{reviewedHistoricalGeometry,reviewedWatchUiBaseline}from'./watch-ui-review.mjs';
const geometry=JSON.parse(readFileSync(new URL('./track-geometry.json',import.meta.url)));
const manifest=JSON.parse(readFileSync(new URL('./engine-manifest.json',import.meta.url)));
const clone=()=>structuredClone(geometry);

const extensionIds = [
  '99fe53184c661a29a6b9125af16897c54c6ce228df05b22b8f3cd504ff9e8b37',
  'b978a8ebb3d822bfcafa592234bfe65d6f09181038a07230ef9acfc17151a22f'
];
test('restores the historical geometry without mutating either live extension',()=>{
  const original=JSON.stringify(geometry),{geometry:historical}=reviewedWatchUiBaseline(manifest);
  assert.equal(historical.tracks.length,geometry.tracks.length-2);
  for(const id of extensionIds) {
    assert.equal(geometry.tracks.filter(row=>row.id===id).length,1);
    assert.ok(!historical.tracks.some(row=>row.id===id));
  }
  assert.equal(JSON.stringify(geometry),original);
  assert.deepEqual(reviewedHistoricalGeometry(historical),historical);
});
test('rejects changes to every reviewed extension field and duplicate extensions',()=>{
  for(const id of extensionIds) {
    for(const key of Object.keys(geometry.tracks.find(row=>row.id===id))) {
      const g=clone(),row=g.tracks.find(row=>row.id===id);
      row[key]=typeof row[key]==='number'?row[key]+1:row[key]+'x';
      assert.throws(()=>reviewedHistoricalGeometry(g),undefined,id+' '+key);
    }
    const g=clone();
    g.tracks.push({...g.tracks.find(row=>row.id===id)});
    assert.throws(()=>reviewedHistoricalGeometry(g),/Duplicate/);
  }
});
test('rejects changed, missing or unknown historical geometry rows',()=>{
  for(const mutate of [g=>g.tracks[0].parts++,g=>g.tracks.splice(0,1),g=>g.tracks.push({id:'f'.repeat(64)})]){
    const g=reviewedHistoricalGeometry(clone());
    mutate(g);
    assert.throws(()=>reviewedHistoricalGeometry(g));
  }
});
