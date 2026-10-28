import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const sourceRoot=process.env.ARCHIVE_SOURCE_REPO||fileURLToPath(new URL('../',import.meta.url));
import {createHash} from 'node:crypto';
const read=async url=>JSON.parse(await fs.readFile(url,'utf8'));
test('recovered history adds only evidence-backed periods and retains canonical racer totals',async()=>{
 const source=await read(new URL('./fixtures/archive-catalog-baseline.json',import.meta.url));
 const staged=await read(new URL('../events/public-catalog.json',import.meta.url));
 const byId=new Map(staged.archives.map(period=>[period.id,period]));
 for(const period of source.archives){
  const updated=byId.get(period.id);assert.ok(updated);
  for(const field of ['trackId','kind','startsAt','endsAt','racerCount','maxRp','targetMs','scoringVersion'])assert.equal(updated[field],period[field],`${period.id} ${field}`);
 }
 const selections=await read(new URL('../events/kodub/selections.json',import.meta.url));
 const extra=staged.archives.filter(period=>!source.archives.some(row=>row.id===period.id));
 assert.ok(extra.length>=1);
 const earliest=extra.find(period=>period.trackName==='going back in time');assert.ok(earliest);
 assert.equal(earliest.racerCount,undefined);assert.equal(earliest.targetMs,undefined);
 assert.equal(new Set(staged.archives.map(period=>period.id)).size,staged.archives.length);
 for(const period of extra){
  assert.match(period.trackId,/^[a-f0-9]{64}$/);assert.ok(period.endsAt>period.startsAt);
  if(period.kind==='kodub'){
   const selected=selections.find(row=>Date.parse(row.endTime)===period.endsAt);
   assert.ok(selected,period.id);assert.equal(selected.trackId,period.trackId);assert.equal(selected.name,period.trackName);
  }else assert.match(period.id,/^[dw]_\d{8}$/);
 }
});
test('every locally captured weekly selection has hash-matching packaged import assets',async()=>{
 const selections=await read(new URL('../events/kodub/selections.json',import.meta.url));
 const trusted=await read(new URL('../events/kodub/trusted-tracks.json',import.meta.url));
 assert.ok(selections.length>=6);assert.equal(new Set(selections.map(row=>row.endTime)).size,selections.length);
 for(const selection of selections){
  const entry=trusted.find(row=>row.trackId===selection.trackId);assert.ok(entry,selection.name);
  assert.match(entry.codeHash,/^[a-f0-9]{64}$/);assert.equal(entry.assetPath,`assets/${entry.codeHash}.track`);
  const bytes=await fs.readFile(path.join(sourceRoot,'events/kodub',entry.assetPath));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),entry.codeHash);
 }
});
