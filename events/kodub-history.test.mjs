import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mergeKodubHistory} from './kodub-history.mjs';
const selection=(letter,name)=>({trackId:letter.repeat(64),name,thumbnailUrl:'assets/'+letter.repeat(64)+'.webp'});
test('weekly capture retains prior artwork, deduplicates and rejects unsafe paths',()=>{
  const old=selection('a','Old'),current=selection('b','Current');
  assert.deepEqual(mergeKodubHistory([old],old,current),[old,current]);
  assert.deepEqual(mergeKodubHistory([], {...current,thumbnailUrl:'../bad.webp'}),[]);
});
test('restored historical Kodub thumbnails point to existing checked-in assets',()=>{
  const history=JSON.parse(fs.readFileSync(new URL('./kodub/history.json',import.meta.url),'utf8'));
  assert.equal(mergeKodubHistory(history).length,history.length);
  for(const item of history)assert.ok(fs.statSync(new URL('./kodub/'+item.thumbnailUrl,import.meta.url)).size>0);
});
