import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSnapshotPublication,readSnapshotPublicationMeta,snapshotPublicationTime} from './snapshot-publication.mjs';
import {createPublicSnapshotReader} from './public-snapshot-client.mjs';
import {encodeSnapshot} from './snapshot-package.mjs';
import {createHash} from 'node:crypto';

const publication={generation:68,publishedAt:1000,sourceCommit:'a'.repeat(40)};
test('legacy publication metadata is bounded and bound to its exact package generation',()=>{
 assert.deepEqual(parseSnapshotPublication(JSON.stringify(publication)),publication);
 assert.equal(snapshotPublicationTime(publication,'https://example.test/public-snapshots68/',{generation:68},2000),1000);
 for(const [base,index] of [['https://example.test/public-snapshots69/',{generation:69}],['https://example.test/public-snapshots68/',{generation:69}],['https://example.test/public-snapshots/',{generation:68}]])assert.equal(snapshotPublicationTime(publication,base,index,2000),0);
 assert.equal(snapshotPublicationTime({...publication,publishedAt:99999999},'https://example.test/public-snapshots68/',{generation:68},2000),0);
 for(const text of ['bad',null,'x'.repeat(513),JSON.stringify({...publication,generation:0}),JSON.stringify({...publication,sourceCommit:'main'})])assert.equal(parseSnapshotPublication(text),null);
 assert.deepEqual(readSnapshotPublicationMeta({querySelector:()=>({content:JSON.stringify(publication)})}),publication);
});

test('legacy package age uses supplied publication metadata without an extra request or fake board confirmation',async()=>{
 const board={updatedAt:10,entries:[],trackSummaries:[]},bytes=await encodeSnapshot(board),hash=createHash('sha256').update(bytes).digest('hex');let calls=0;
 const read=createPublicSnapshotReader({baseUrl:'https://example.test/public-snapshots68/',packed:true,publication,now:()=>2000,fetchImpl:async url=>{
  calls++;if(String(url).endsWith('index.json'))return Response.json({schemaVersion:1,generation:68,encoding:'gzip-xor-a7-v1',files:{'overall.json':{path:hash+'.bin',sha256:hash,decodedBytes:Buffer.byteLength(JSON.stringify(board))}}});
  if(String(url).endsWith(hash+'.bin'))return new Response(bytes);return new Response('',{status:404});
 }});
 const result=await read('overall');assert.equal(result._snapshotPackageAt,1000);assert.equal(result._snapshotCapturedAt,undefined);assert.equal(result.updatedAt,10);assert.equal(calls,2);
});
