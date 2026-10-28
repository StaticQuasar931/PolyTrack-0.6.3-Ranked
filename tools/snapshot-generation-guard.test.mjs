import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {createPublicSnapshotReader} from './public-snapshot-client.mjs';
import {encodeSnapshot} from './snapshot-package.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function fixture({beforeGenerationChange,holdTotals=false}={}){
  const files={},payloads=new Map(),requests=[],changes=[],totals=deferred(),started=deferred();
  for(const [logical,value] of Object.entries({
    'overall.json':{updatedAt:7,entries:[]},
    'event-totals.json':{updatedAt:7,entries:[]},
    'racer-directory.json':{updatedAt:7,entries:{}}
  })){
    const bytes=await encodeSnapshot(value),sha256=createHash('sha256').update(bytes).digest('hex');
    files[logical]={path:sha256+'.bin',sha256,decodedBytes:Buffer.byteLength(JSON.stringify(value))};
    payloads.set(files[logical].path,{logical,bytes});
  }
  const read=createPublicSnapshotReader({packed:true,baseUrl:'https://example.test/public-snapshots7/',now:()=>1000,
    beforeGenerationChange,onGenerationChange:change=>changes.push(change),fetchImpl:async url=>{
      const path=new URL(url).pathname;requests.push(path);
      if(path==='/snapshot-current.json')return Response.json({currentdir:'public-snapshots8'});
      assert.ok(path.startsWith('/public-snapshots7/'),'veto must never fetch the new package');
      if(path.endsWith('/index.json'))return Response.json({schemaVersion:1,encoding:'gzip-xor-a7-v1',files});
      const entry=payloads.get(path.split('/').at(-1));assert.ok(entry);
      if(entry.logical==='racer-directory.json')return new Response('',{status:404});
      if(entry.logical==='event-totals.json'&&holdTotals){started.resolve();await totals.promise;}
      return new Response(entry.bytes);
    }});
  return {read,requests,changes,totals,started};
}

test('manual veto preserves warm package data and epoch without invoking invalidation',async()=>{
  const attempts=[],f=await fixture({beforeGenerationChange:change=>{attempts.push(change);return false;}});
  assert.equal((await f.read('overall')).updatedAt,7);
  const before=f.read.packageInfo(),count=f.requests.length;
  const results=await Promise.allSettled([f.read.refresh(),f.read.refresh(),f.read.refresh()]);
  assert.ok(results.every(result=>result.status==='rejected'&&/requires a reload/.test(result.reason.message)));
  assert.deepEqual(f.read.packageInfo(),before);
  assert.equal((await f.read('overall')).updatedAt,7);
  assert.equal(f.requests.length,count+1,'warm board remains cached; only pointer was fetched');
  assert.equal(f.changes.length,0);assert.equal(attempts.length,1);
  assert.deepEqual(attempts[0],{previousBaseUrl:before.baseUrl,baseUrl:'https://example.test/public-snapshots8/',generation:1});
});

test('automatic 404 recovery veto preserves old in-flight reads and coalesces pointer checks',async()=>{
  let vetoes=0;const f=await fixture({holdTotals:true,beforeGenerationChange:()=>{vetoes++;return false;}});
  const pending=f.read('event-totals');await f.started.promise;
  const missing=await Promise.all(Array.from({length:12},()=>f.read('racer-directory')));
  assert.ok(missing.every(value=>value===null));
  assert.equal(f.read.packageInfo().generation,7);assert.equal(f.read.packageInfo().epoch,0);
  f.totals.resolve();assert.equal((await pending).updatedAt,7);
  assert.equal((await f.read('event-totals')).updatedAt,7);
  assert.equal(vetoes,1);assert.equal(f.changes.length,0);
  assert.equal(f.requests.filter(path=>path==='/snapshot-current.json').length,1);
});

test('throwing or non-boolean guard cannot partially adopt a package',async()=>{
  for(const guard of [()=>{throw Error('guard failed');},()=>undefined,()=>Promise.resolve(true)]){
    const f=await fixture({beforeGenerationChange:guard});
    await assert.rejects(f.read.refresh(),/guard failed|requires a reload/);
    assert.equal(f.read.packageInfo().generation,7);assert.equal(f.read.packageInfo().epoch,0);
    assert.equal(f.changes.length,0);
  }
});

const patch=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const start=patch.indexOf('  function allowSnapshotGenerationChange(){');
const end=patch.indexOf('  async function readPublicSnapshotBackup(',start);
assert.ok(start>=0&&end>start);
function patchGuard(state={}){
  const notices=[],document={getElementById:id=>notices.find(node=>node.id===id),
    createElement:()=>({style:{},setAttribute(key,value){this[key]=value;}}),
    body:{appendChild:node=>notices.push(node)}};
  const context=vm.createContext({eventUi:null,eventUiPromise:null,document,...state});
  const guard=vm.runInContext(`(()=>{${patch.slice(start,end)};return allowSnapshotGenerationChange;})()`,context);
  return {guard,notices,context};
}

test('patch allows transition before event initialization without a notice',()=>{
  const f=patchGuard();assert.equal(f.guard(),true);assert.equal(f.notices.length,0);
  assert.match(patch,/beforeGenerationChange:allowSnapshotGenerationChange/);
});

test('loaded and loading event UI veto without touching sessions, local PBs or receipts',()=>{
  const untouched=new Proxy({},{get(){throw Error('must not touch the event session');}});
  for(const state of [{eventUi:untouched},{eventUiPromise:Promise.resolve()}]){
    const f=patchGuard(state);
    assert.equal(f.guard(),false);assert.equal(f.guard(),false);
    assert.equal(f.notices.length,1);assert.equal(f.notices[0].role,'status');
    assert.match(f.notices[0].textContent,/Keeping this session on its saved package/);
    assert.match(f.notices[0].textContent,/Finish your race, then reload/);
    assert.match(f.notices[0].style.cssText,/pointer-events:none/);
  }
});

test('event initialization during pointer fetch is checked at adoption, not at request start',async()=>{
  const f=patchGuard(),pointer=deferred(),started=deferred();
  const read=createPublicSnapshotReader({packed:true,baseUrl:'https://example.test/public-snapshots7/',
    beforeGenerationChange:f.guard,fetchImpl:async()=>{started.resolve();await pointer.promise;return Response.json({currentdir:'public-snapshots8'});}});
  const pending=read.refresh();await started.promise;
  f.context.eventUiPromise=Promise.resolve();pointer.resolve();
  await assert.rejects(pending,/requires a reload/);
  assert.equal(read.packageInfo().generation,7);assert.equal(f.notices.length,1);
});
