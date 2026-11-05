
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
const require=createRequire(new URL('./verifier/package.json',import.meta.url));
let chromium;try{({chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright'));}catch{}
const root=path.resolve(import.meta.dirname,'..');
test('real published snapshot loads complete Summer 1 and profiles without a full index; browser cache survives generation changes',{skip:!chromium},async()=>{
 const pointer=JSON.parse(await fs.readFile(path.join(root,'snapshot-current.json'),'utf8'));
 const alias='public-snapshots'+(Number(pointer.currentdir.replace('public-snapshots',''))+100000);
 const requests=[];const server=createServer(async(req,res)=>{
  const file=new URL(req.url,'http://localhost').pathname;
  if(file==='/'){res.setHeader('content-type','text/html');res.end('<!doctype html><title>Snapshot reader integration</title>');return;}
  if(!/^\/(?:tools\/[a-z0-9-]+\.mjs|public-snapshots[0-9]+\/(?:[a-f0-9]{64}\.bin|(?:bootstrap-fast|bootstrap-index|index)\.json|lookup-shards\/[a-f0-9]{2}\.json))$/.test(file)){res.writeHead(404).end();return;}
  requests.push(file);try{let bytes=await fs.readFile(path.join(root,file.replace('/'+alias+'/', '/'+pointer.currentdir+'/')));if(file.startsWith('/'+alias+'/')&&file.endsWith('.json')){const value=JSON.parse(bytes);value.generation=Number(alias.replace('public-snapshots',''));bytes=Buffer.from(JSON.stringify(value));}res.setHeader('content-type',file.endsWith('.mjs')?'text/javascript':file.endsWith('.json')?'application/json':'application/octet-stream');res.end(bytes);}catch{res.writeHead(404).end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();await page.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());await page.goto(origin);

  const before=await page.evaluate(async({directory})=>{
   const {createPublicSnapshotReader}=await import('/tools/public-snapshot-client.mjs');
   window.makeReader=dir=>createPublicSnapshotReader({packed:true,bootstrap:true,optimizedIndex:true,baseUrl:location.origin+'/'+dir+'/'});
   const read=makeReader(directory),id='5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038';
   const preview=await read('track-preview',id),board=await read('track',id);window.racer=board.entries[0].accountId;
   const profile=await read('profile',racer);
   const disk=await caches.open('polytrack-snapshot-bytes-v1');for(let i=0;i<50&&(await disk.keys()).length<4;i++)await new Promise(resolve=>setTimeout(resolve,10));
   return {preview:preview.entries.length,total:board.entries.length,complete:board.complete,profile:profile.accountId,verified:board.entries.every(row=>typeof row.integrityVerified==='boolean')};
  },{directory:pointer.currentdir});
  assert.equal(before.preview,15);assert.ok(before.total>=379);assert.equal(before.complete,true);assert.equal(before.verified,true);assert.ok(before.profile);
  assert.ok(!requests.some(p=>p.endsWith('/index.json')),'normal reading never downloads the full legacy index');
  const beforeBins=requests.filter(p=>p.endsWith('.bin')).length;
  // Simulate a later immutable generation without depending on retained old folders.
  const account=await page.evaluate(async directory=> (await makeReader(directory)('profile',racer)).accountId,alias);
  assert.equal(account,before.profile);assert.equal(requests.filter(p=>p.endsWith('.bin')).length,beforeBins,'same profile hash reused across generations without downloading its payload again');
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
});
