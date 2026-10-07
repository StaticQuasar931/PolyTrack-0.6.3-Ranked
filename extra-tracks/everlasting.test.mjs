import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {readEmbeddedTrackMetadata} from './sync-code-metadata.mjs';
const root=new URL('../',import.meta.url);
test('Everlasting uses embedded creator credits, requested tags, and a native track preview',()=>{
 const entries=JSON.parse(fs.readFileSync(new URL('extra-tracks/catalog.json',root),'utf8'));
 const row=entries.find(e=>e.id==='everlasting');assert.ok(row);
 const code=fs.readFileSync(new URL(row.trackPath,root),'utf8').trim(),meta=readEmbeddedTrackMetadata(code);
 assert.equal(row.name,meta.codeName);assert.equal(row.author,meta.codeAuthor);assert.equal(row.codeModifiedAt,meta.codeModifiedAt);
 assert.deepEqual(row.tags,['technical','scenic','elite-track']);assert.equal(row.difficulty,3);assert.equal(row.source,'Player submission');assert.equal(row.featuredSubmission,true);
 assert.equal(row.trackId,'7a8afe73c01cf77bf16c9c87f8e0f8732023bdf4b9b6bb4a0120e97553dd447d');
 const png=fs.readFileSync(new URL(row.thumbnailUrl,root));assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(png.readUInt32BE(16),92);assert.equal(png.readUInt32BE(20),60);
 const pin=JSON.parse(fs.readFileSync(new URL('tools/verifier/engine-manifest.json',root),'utf8'));
 assert.equal(pin.tracks[row.trackPath],createHash('sha256').update(code+'\n').digest('hex'));
 assert.ok(!('ownerUid' in row));
});
