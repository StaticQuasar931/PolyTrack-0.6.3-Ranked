import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {publicationAddArgvBatches,estimatePublicationCommandChars,MAX_PUBLICATION_COMMAND_CHARS,MAX_PUBLICATION_BATCH_FILES} from './local-publication-argv.mjs';

test('43,776 canonical package files take 171 bounded mock Git calls instead of 438',async()=>{
 const files=Array.from({length:43776},(_,i)=>'public-snapshots91/'+i.toString(16).padStart(64,'0')+'.bin'),calls=[];
 const git=async args=>{calls.push(args);};
 for(const args of publicationAddArgvBatches(files))await git(args);
 assert.equal(calls.length,171);assert.equal(Math.ceil(files.length/100),438);
 assert.deepEqual(calls.flatMap(args=>args.slice(2)),files);
 for(const args of calls){
  assert.deepEqual(args.slice(0,2),['add','--']);assert.ok(args.length-2<=256);
  assert.ok(estimatePublicationCommandChars(args.slice(2))<=24000);
  assert.ok(Buffer.byteLength(['git',...args].join(' ')+'\0','utf16le')<=24000*2);
 }
});
test('file-count bound and last short batch preserve order without mutating inputs',()=>{
 const files=Array.from({length:513},(_,i)=>'files/'+i+'.bin'),copy=[...files],batches=publicationAddArgvBatches(files);
 assert.deepEqual(batches.map(a=>a.length-2),[256,256,1]);assert.deepEqual(batches.flatMap(a=>a.slice(2)),copy);assert.deepEqual(files,copy);
 assert.equal(MAX_PUBLICATION_BATCH_FILES,256);assert.equal(MAX_PUBLICATION_COMMAND_CHARS,24000);
});
test('long canonical paths split by command characters before the file-count limit',()=>{
 const files=Array.from({length:100},(_,i)=>'files/'+i+'x'.repeat(1000)),batches=publicationAddArgvBatches(files);
 assert.ok(batches.length>1);assert.ok(batches.every(args=>args.length-2<256&&estimatePublicationCommandChars(args.slice(2))<=24000));
 assert.deepEqual(batches.flatMap(args=>args.slice(2)),files);
});
test('exact command-character boundary fits and one character beyond rejects',()=>{
 const length=24000-estimatePublicationCommandChars(['x'])+1,exact='x'.repeat(length);
 assert.equal(estimatePublicationCommandChars([exact]),24000);assert.deepEqual(publicationAddArgvBatches([exact]),[['add','--',exact]]);
 assert.throws(()=>publicationAddArgvBatches([exact+'x']),/Oversize/);
});
test('empty inventory produces no Git calls',()=>assert.deepEqual(publicationAddArgvBatches([]),[]));
for(const invalid of ['',null,3,'a b','a\tb','a\nb','a\n','a\r','a\r\n','a\0b','a"b',"a'b",'a\\b','/absolute','C:/absolute','../escape','a/../b','a/./b','a//b','a/','\u00e9.bin','a*','a?','a[0]','a:attr','.','..','a.','a/con.txt']){
 test('rejects noncanonical path '+JSON.stringify(invalid)+' before any mock staging',async()=>{
  let calls=0;const files=[...Array.from({length:257},(_,i)=>'safe/'+i+'.bin'),invalid],git=async()=>{calls++;};
  await assert.rejects(async()=>{for(const args of publicationAddArgvBatches(files))await git(args);});assert.equal(calls,0);
 });
}
for(const pair of [['a.bin','a.bin'],['a.bin','A.bin']])test('duplicate paths reject rather than silently omit '+pair.join('/'),()=>assert.throws(()=>publicationAddArgvBatches(pair),/Duplicate/));
test('oversize final entry is rejected before the first mock Git call',async()=>{
 let calls=0;await assert.rejects(async()=>{for(const args of publicationAddArgvBatches(['safe.bin','x'.repeat(24000)])){calls++;void args;}});assert.equal(calls,0);
});
test('array required; sparse arrays fail rather than omit entries',()=>{for(const value of [null,'a.bin',{},new Array(2)])assert.throws(()=>publicationAddArgvBatches(value));});
test('failed mock staging stops without starting later batches',async()=>{
 let calls=0;await assert.rejects(async()=>{for(const args of publicationAddArgvBatches(Array.from({length:800},(_,i)=>'a/'+i))){assert.ok(args.length<=258);if(++calls===2)throw Error('bounded Git failure');}},/bounded Git failure/);assert.equal(calls,2);
});
test('real staging loop uses helper before Git and retains deletion/allowlist guards',async()=>{
 const source=await fs.readFile(new URL('./local-overnight-capture.mjs',import.meta.url),'utf8');
 assert.match(source,/import \{publicationAddArgvBatches\} from '\.\/local-publication-argv\.mjs'/);
 const publication=source.slice(source.indexOf('publish:async(result,onState)=>'));
 assert.ok(publication.indexOf('const stagingArgv=publicationAddArgvBatches(files)')<publication.indexOf("await git(['diff'"));
 assert.match(publication,/for\(const args of stagingArgv\)await git\(args\)/);
 assert.match(publication,/await git\(\['add','-u','--',':\(glob\)public-snapshots\[0-9\]\*\/\*\*'\]\)/);
 assert.match(publication,/if\(staged\.some\(file=>!allowed\.has\(file\)\)\)/);
 const pinned=await fs.readFile(new URL('./local-capture-publication.mjs',import.meta.url),'utf8');assert.match(pinned,/'tools\/local-publication-argv\.mjs'/);
});
