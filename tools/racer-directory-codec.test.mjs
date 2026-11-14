import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {gzipSync} from 'node:zlib';
import {encodeRacerDirectory,expandRacerDirectory,RACER_DIRECTORY_WIRE_BYTES,RACER_DIRECTORY_EXPANDED_BYTES} from './racer-directory-codec.mjs';
import {buildProfileSnapshotResults} from './build-profile-snapshot-results.mjs';
import {createPublicSnapshotReader} from './public-snapshot-client.mjs';
import {publishSnapshot,decodeSnapshot,MAX_DECODED_BYTES} from './snapshot-package.mjs';
import {releasePlan} from './publish-cdn-release.mjs';
const account=n=>n.toString(16).padStart(64,'0');
const cosmetics={version:7,theme:'cyan',accent:'amber',finish:'matte',plate:'slant',edge:'double',stage:'mountain',stageTint:'ocean',stripe:'racer',emblem:'target',emblem2:'flag',emblem3:'wings',emblemBackdrop:'hex',nameFont:'square',nameSize:'large',nameWeight:'heavy',nameColor:'gold',baseSecondary:'navy',title:'racer',badge:'none',favoriteTrackId:'a'.repeat(64),overridePodium:false};
const directory=(count=4245)=>({updatedAt:123,entries:Object.fromEntries(Array.from({length:count},(_,n)=>[account(n+1),{updatedAt:123,name:`Racer ${n} \u03a9`,nickname:`Nickname ${n}`,countryCode:n%2?'US':null,carStyle:'standard',carId:'default',carColors:'cyan',profileCosmetics:{...cosmetics},cosmeticContext:{rank:n+1,raceCount:20,pbCount:40,totalPlaytimeMs:1234567,extraCount:2,trackWins:1,cosmeticUnlocks:['emblem:target'],badges:{betaTester:true}}}]))});
const wireSize=value=>Buffer.byteLength(JSON.stringify(value))+1;
const readerFor=(factory,wire)=>factory({baseUrl:'https://fixture.invalid/',fetchImpl:async()=>new Response(JSON.stringify(wire),{headers:{'content-type':'application/json'}})});
async function legacyFactory(){
  // Exercise the real existing reader, removing only the new expansion import/hook.
  let source=await fs.readFile(new URL('./public-snapshot-client.mjs',import.meta.url),'utf8');
  source=source.replace("import {expandRacerDirectory} from './racer-directory-codec.mjs';",'').replace("        if(kind==='racer-directory')value=await expandRacerDirectory(value);",'');
  source=source.replace(/from '(\.\/[^']+)'/g,(_,relative)=>`from '${new URL(relative,import.meta.url).href}'`);
  return (await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))).createPublicSnapshotReader;
}
test('4245 full records round-trip exactly below unchanged wire limit, preserving null/missing fields',async()=>{
 const full=directory();delete full.entries[account(1)].nickname;full.entries[account(2)].profileCosmetics=null;
 assert.ok(wireSize(full)>RACER_DIRECTORY_WIRE_BYTES);const wire=await encodeRacerDirectory(full);
 assert.equal(wire.schemaVersion,1);assert.ok(wireSize(wire)<=RACER_DIRECTORY_WIRE_BYTES);
 assert.equal(Object.keys(wire.entries).length,4245);assert.deepEqual(await expandRacerDirectory(wire),full);
 console.log(JSON.stringify({racerDirectory:{accounts:4245,expandedBytes:wireSize(full)-1,wireBytes:wireSize(wire),wireCap:MAX_DECODED_BYTES}}));
});
test('small legacy directories remain byte-for-byte shape compatible with no details',async()=>{
 const full=directory(3);assert.equal(await encodeRacerDirectory(full),full);assert.equal(await expandRacerDirectory(full),full);
});
test('actual previous reader accepts all minimal identities; new reader returns full details and caches expanded data',async()=>{
 const full=directory(),wire=await encodeRacerDirectory(full),old=await readerFor(await legacyFactory(),wire)('racer-directory');
 assert.ok(old);assert.equal(Object.keys(old.entries).length,4245);
 for(const [id,row]of Object.entries(full.entries))assert.deepEqual(old.entries[id],{updatedAt:row.updatedAt,name:row.name,nickname:row.nickname,countryCode:row.countryCode});
 const read=readerFor(createPublicSnapshotReader,wire),current=await read('racer-directory');
 assert.deepEqual(current.entries,full.entries);assert.equal(Object.hasOwn(current,'details'),false);
 assert.deepEqual((await read('racer-directory')).entries,full.entries);
});
test('malformed, corrupt, truncated, oversized, or mismatched details fail closed',async()=>{
 const wire=await encodeRacerDirectory(directory(2),{forceCompact:true});
 const bads=[{...wire,details:null},{...wire,details:{...wire.details,encoding:'other'}},{...wire,details:{...wire.details,data:'not base64'}},{...wire,details:{...wire.details,sha256:'0'.repeat(64)}},{...wire,details:{...wire.details,decodedBytes:wire.details.decodedBytes-1}},{...wire,details:{...wire.details,decodedBytes:wire.details.decodedBytes+1}},{...wire,details:{...wire.details,decodedBytes:RACER_DIRECTORY_EXPANDED_BYTES+1}},{...wire,entries:{[account(1)]:wire.entries[account(1)]}},{...wire,updatedAt:999}];
 const renamed=structuredClone(wire);renamed.entries[account(1)].name='Wrong name';bads.push(renamed);
 const extra=structuredClone(wire);extra.entries[account(1)].accountId=account(1);bads.push(extra);
 for(const bad of bads){await assert.rejects(expandRacerDirectory(bad));assert.equal(await readerFor(createPublicSnapshotReader,bad)('racer-directory'),null);}
});
test('decompression bomb, full-record oversize, and oversized legacy fallback cannot raise either cap',async()=>{
 const full=directory(1);full.entries[account(1)].name='x'.repeat(RACER_DIRECTORY_EXPANDED_BYTES);
 await assert.rejects(encodeRacerDirectory(full),/expanded limit/);
 const bomb=gzipSync(Buffer.alloc(RACER_DIRECTORY_EXPANDED_BYTES+1,32));
 const wire=await encodeRacerDirectory(directory(1),{forceCompact:true});
 wire.details={encoding:'gzip-base64-v1',decodedBytes:RACER_DIRECTORY_EXPANDED_BYTES,sha256:'0'.repeat(64),data:bomb.toString('base64')};
 await assert.rejects(expandRacerDirectory(wire),/expanded limit/);
 const fallback=directory(1);fallback.entries[account(1)].name='x'.repeat(RACER_DIRECTORY_WIRE_BYTES);
 await assert.rejects(encodeRacerDirectory(fallback),/client limit/);
 assert.equal(RACER_DIRECTORY_WIRE_BYTES,MAX_DECODED_BYTES);assert.equal(MAX_DECODED_BYTES,2097152);
});
test('validly compressed details still pass the existing racer/context validation before exposure',async()=>{
 const bad=directory(1);bad.entries[account(1)].cosmeticContext.raceCount=-1;
 const wire=await encodeRacerDirectory(bad,{forceCompact:true});assert.equal(await readerFor(createPublicSnapshotReader,wire)('racer-directory'),null);
});
test('generator builds 4245 accounts, keeps full cosmetics separate, and packaging retains the 2 MiB cap',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'racer-directory-compat-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const stage=path.join(root,'stage');await fs.mkdir(stage);
 const full=directory();
 // Typical short designs plus a minority using every newer cosmetic field.
 const typical=Object.fromEntries(Object.entries(cosmetics).filter(([key])=>['version','theme','accent','finish','plate','edge','stage','stageTint','stripe','emblem','title','badge','overridePodium'].includes(key)));
 for(const [index,row]of Object.values(full.entries).entries())if(index%4!==0)row.profileCosmetics={...typical};
 await fs.writeFile(path.join(stage,'overall.json'),JSON.stringify({updatedAt:123,entries:Object.entries(full.entries).map(([userId,row])=>({...row,userId,...row.cosmeticContext}))}));
 await buildProfileSnapshotResults(stage);
 const wire=JSON.parse(await fs.readFile(path.join(stage,'racer-directory.json')));assert.ok(wire.details);assert.equal(Object.keys(wire.entries).length,4245);
 const expanded=await expandRacerDirectory(wire);assert.equal(Object.keys(expanded.entries).length,4245);assert.deepEqual(expanded.entries[account(1)].profileCosmetics,cosmetics);
 const separate=JSON.parse(await fs.readFile(path.join(stage,'cosmetic-directory.json')));assert.equal(Object.keys(separate.entries).length,4245);assert.deepEqual(separate.entries[account(1)].value,cosmetics);
 const published=await publishSnapshot({root,stagingDirectory:stage,historyDirectory:path.join(root,'history')});
 const output=path.join(root,published.directory),index=JSON.parse(await fs.readFile(path.join(output,'index.json'))),record=index.files['racer-directory.json'];
 assert.ok(record.decodedBytes<=MAX_DECODED_BYTES);const packed=JSON.parse(Buffer.from(await decodeSnapshot(await fs.readFile(path.join(output,record.path)))).toString());
 assert.deepEqual(await expandRacerDirectory(packed),expanded);assert.ok(Object.values(index.files).every(row=>row.decodedBytes<=MAX_DECODED_BYTES));
 const read=createPublicSnapshotReader({baseUrl:'https://fixture.invalid/public-snapshots1/',packed:true,bootstrap:true,fetchImpl:async url=>{
  try{return new Response(await fs.readFile(path.join(output,path.posix.basename(new URL(url).pathname))));}catch(error){if(error.code==='ENOENT')return new Response('',{status:404});throw error;}
 }});
 assert.deepEqual((await read('racer-directory')).entries,expanded.entries);
});

test('CDN automatic import closure includes the new directory codec',async()=>{
 const plan=await releasePlan({root:fileURLToPath(new URL('../',import.meta.url)),commit:'a'.repeat(40)});
 assert.ok(plan.files.some(file=>file.path==='tools/racer-directory-codec.mjs'));
});

test('expanded directory cache accounting evicts full details at the existing eight MiB budget',async()=>{
 const full=directory(),wire=await encodeRacerDirectory(full),profile={accountId:account(1),updatedAt:123,name:'x'.repeat(600000)};
 const size=value=>JSON.stringify(value).length*2;
 assert.ok(size(full)+size(profile)>8*1024*1024);
 assert.ok(size(wire)+size(profile)<8*1024*1024,'wire-only accounting would incorrectly retain both');
 let directoryReads=0,profileReads=0;
 const read=createPublicSnapshotReader({baseUrl:'https://fixture.invalid/',now:()=>100,fetchImpl:async url=>{
  const isDirectory=new URL(url).pathname==='/racer-directory.json';if(isDirectory)directoryReads++;else profileReads++;
  return new Response(JSON.stringify(isDirectory?wire:profile),{headers:{'content-type':'application/json'}});
 }});
 assert.deepEqual((await read('racer-directory')).entries,full.entries);
 assert.equal((await read('racer-directory'))._dataSource,'cached');assert.equal(directoryReads,1);
 assert.equal((await read('profile',account(1))).accountId,account(1));assert.equal(profileReads,1);
 assert.deepEqual((await read('racer-directory')).entries,full.entries);assert.equal(directoryReads,2,'expanded directory was evicted, not retained using compressed wire size');
 assert.equal((await read('racer-directory'))._dataSource,'cached');assert.equal(directoryReads,2);
});

test('real Chromium reader restores exact 4245 records and rejects corrupt details and stream bombs without external requests',{skip:!process.env.PLAYWRIGHT_MODULE,timeout:30000},async t=>{
 const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE);
 const server=http.createServer(async(req,res)=>{
  try{
   const name=new URL(req.url,'http://localhost').pathname;
   if(name==='/'){res.setHeader('content-type','text/html');res.end('<!doctype html><title>Local codec test</title>');return;}
   if(!/^\/tools\/[a-zA-Z0-9_.-]+\.mjs$/.test(name)){res.writeHead(404).end();return;}
   const source=await fs.readFile(new URL('./'+path.posix.basename(name),import.meta.url));res.setHeader('content-type','text/javascript');res.end(source);
  }catch{res.writeHead(404).end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
 const page=await browser.newPage(),base=`http://127.0.0.1:${server.address().port}`;let external=0;
 await page.route('**/*',route=>route.request().url().startsWith(base+'/')?route.continue():(external++,route.abort()));await page.goto(base);
 const full=directory(),wire=await encodeRacerDirectory(full);
 const bomb=structuredClone(wire);bomb.details={encoding:'gzip-base64-v1',decodedBytes:RACER_DIRECTORY_EXPANDED_BYTES,sha256:'0'.repeat(64),data:gzipSync(Buffer.alloc(RACER_DIRECTORY_EXPANDED_BYTES+1,32)).toString('base64')};
 const results=await page.evaluate(async({wire,full,bomb})=>{
  const {createPublicSnapshotReader}=await import('/tools/public-snapshot-client.mjs');
  const read=value=>createPublicSnapshotReader({baseUrl:location.origin+'/',fetchImpl:async()=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}})})('racer-directory');
  const actual=await read(wire),corrupt=structuredClone(wire);corrupt.details.sha256='0'.repeat(64);
  return {exact:JSON.stringify(actual?.entries)===JSON.stringify(full.entries),count:Object.keys(actual?.entries||{}).length,corrupt:await read(corrupt),bomb:await read(bomb)};
 },{wire,full,bomb});
 assert.deepEqual(results,{exact:true,count:4245,corrupt:null,bomb:null});assert.equal(external,0);
});
