import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {captureOverallProjection, applyCapturedOverallProjection, createOverallCaptureFetch, overallCaptureForBackup, frozenOverallSource} from './capture-overall-projection.mjs';
import {encode} from './verifier/firestore.mjs';
import {runPublicSnapshotBackup,publicTrackBackup,authenticatedOverallTrackBackup,publicTrackConfirmationDigest} from './public-snapshot-backup.mjs';
import {prepareSourcePublication,decodeSourcePublication} from '../workers/ranked/src/overall-source-publication.js';
import {preparePublicationPages} from '../workers/ranked/src/paged-publication.js';
import {computeOverall, trackWeightParts} from '../workers/ranked/src/index.js';
import {updatePublicSnapshot} from './update-public-snapshot.mjs';
import {publishSnapshot, decodeSnapshot, MAX_DECODED_BYTES} from './snapshot-package.mjs';

const base = 'projects/polytrack-052/databases/(default)/documents/';
const endpoint = 'https://firestore.googleapis.com/v1/' + base.slice(0, -1) + ':batchGet';
const point = '2026-10-25T18:49:28.585265Z';
const track = '5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

async function fixture({paged = false, inline = false} = {}) {
  const metadata = {algorithmVersion:'participation-v8-s1', schemaVersion:6, sourceRevision:10, builtRevision:10, updatedAt:1000};
  const binding = {revision:1, sourceRevision:1, updatedAt:1000, signature:'frozen-signature'};
  const board = {...metadata, ...binding, trackId:track, complete:true, totalEntries:2,
    entries:[['a'.repeat(64),10000],['b'.repeat(64),12000]].map(([accountId,timeMs]) => ({accountId, trackId:track, timeMs,
      pbAt:100, weight:Number(trackWeightParts(track,2,1).finalWeight.toFixed(3)), runVerified:true, integrityVerified:true,
      ownerUid:'PRIVATE_OWNER', name:'PRIVATE_SOURCE_NAME'}))};
  const entries = computeOverall([board], [], new Set(), {includePlannerResults:true});
  const overall = {...metadata, complete:true, totalEntries:entries.length, entries, trackSummaries:[],
    trackCatalog:[{trackId:track, updatedAt:1000}], resultBundleLocation:'main_results'};
  const results = {...metadata, resultBundleVersion:1, resultBundleEncoding:'gzip-base64-json-v1', resultBundleComplete:true,
    resultBoardCount:1, resultBoardLimitReached:false,
    resultBundle:gzipSync(JSON.stringify({entries:entries.map(row => ({userId:row.userId,resultSamples:row.resultSamples})),resultTracks:[track]})).toString('base64')};
  const catalog = {version:1,complete:true,scannedAt:10,count:1,tracks:{[track]:binding}};
  const scope = 'https://firestore.googleapis.com/v1/' + base + '0.6.2_s1_leaderboards_track/overall-bundle-loader-v1';
  const payload = {version:1,scopeHash:digest(scope),createdAt:30,catalog,boards:{[track]:board}};
  const marker = {version:1,scopeHash:payload.scopeHash,createdAt:30,digest:digest(payload),catalogHash:digest(catalog)};
  const published = await prepareSourcePublication(JSON.stringify({version:1,payload}),marker);
  const documents = new Map([
    ['0.6.2_s1_release_meta/current',{builtRevision:10,lastOverallBuildAt:1000,sourceBundle:published.marker,dirty:true}],
    ['0.6.2_s1_leaderboards_overall/main',overall],['0.6.2_s1_leaderboards_overall/main_results',results],
    ...published.documents.map(row => [row.collection+'/'+row.id,row.data])]);
  if (inline) {
    delete overall.resultBundleLocation;
    Object.assign(overall, results);
  }
  if (paged) {
    const pages = await preparePublicationPages('overall','main',entries,{sourceRevision:10,sourceComplete:true});
    overall.pagination = pages.pagination; overall.sourceComplete = true;
    for (const row of pages.documents) documents.set(row.collection+'/'+row.id,row.data);
  }
  const requests = [];
  const fetchImpl = async (url, options) => {
    assert.equal(url,endpoint); const body=JSON.parse(options.body); requests.push(body);
    assert.equal(options.method,'POST'); assert.equal(body.documents.length,1);
    if(requests.length===1) assert.equal(body.readTime,undefined); else assert.equal(body.readTime,point);
    const name=body.documents[0],relative=name.slice(base.length),value=documents.get(relative);
    assert.ok(value,'Unexpected document '+relative);
    return Response.json([{found:{name,fields:encode(value).mapValue.fields,updateTime:'2026-10-25T18:46:57.903763Z'},readTime:point}]);
  };
  return {documents,requests,fetchImpl,catalog,board};
}

test('consistent exact roots/source plus named generation pages build one public artifact',async()=>{
  const f=await fixture({paged:true});const charges=[];
  const result=await captureOverallProjection({fetchImpl:f.fetchImpl,onRead:row=>charges.push(row)});
  assert.equal(result.report.projectionReady,true);assert.equal(result.report.estimatedReads,5);
  assert.equal(result.report.generationPages,1);assert.equal(charges.length,5);
  assert.equal(result.report.metadataDirty,true);assert.equal(result.report.freshness,'last-published-not-a-rebuild');
  assert.deepEqual([...result.files.keys()],['overall.json','overall-results.json','projection-source.json']);
  assert.doesNotMatch(JSON.stringify(result.files.get('projection-source.json')),/PRIVATE_|ownerUid|signature|replay|name/);
  assert.ok(f.requests.every(row=>!row.documents[0].includes('leaderboards_track')));
});

test('source corruption or baseline mismatch withholds projection without disguising published scores',async()=>{
  for(const mutate of [f=>{f.documents.get('0.6.2_s1_overall_sources/main_0').digest='f'.repeat(64);},
    f=>{f.documents.get('0.6.2_s1_leaderboards_overall/main').entries[0].score+=1;}]) {
    const f=await fixture();mutate(f);
    const result=await captureOverallProjection({fetchImpl:f.fetchImpl});
    assert.equal(result.report.projectionReady,false);assert.equal(result.files.has('projection-source.json'),false);
    assert.equal(result.confirmedTracks.size,0);
    assert.ok(result.files.has('overall.json'));assert.ok(result.report.projectionReason);
  }
});

test('mixed result revision, pre-handoff point and mismatched document identity fail closed',async()=>{
  const f=await fixture();f.documents.get('0.6.2_s1_leaderboards_overall/main_results').sourceRevision++;
  await assert.rejects(captureOverallProjection({fetchImpl:f.fetchImpl}),/MISMATCH/);
  const g=await fixture();
  await assert.rejects(captureOverallProjection({fetchImpl:g.fetchImpl,minimumCommitTime:'2026-10-25T18:50:00Z'}),/precedes/);
  assert.equal(g.requests.length,1);
  await assert.rejects(captureOverallProjection({fetchImpl:async()=>Response.json([{found:{name:base+'WRONG',fields:{}},readTime:point}])}),/mismatched/);
});

test('429 stops at one charged attempt; budget exhaustion never refetches or falls back',async()=>{
  let calls=0,charges=0;
  await assert.rejects(captureOverallProjection({fetchImpl:async()=>{calls++;return new Response('',{status:429});},onRead:()=>{charges++;}}),error=>error.status===429);
  assert.equal(calls,1);assert.equal(charges,1);
  const f=await fixture();await assert.rejects(captureOverallProjection({fetchImpl:f.fetchImpl,maxReads:3}),/budget/);
  assert.equal(f.requests.length,3);
});

test('missing optional companion withholds projection but retains latest bound Overall',async()=>{
  const f=await fixture();
  const result=await captureOverallProjection({fetchImpl:(url,options)=>JSON.parse(options.body).documents[0].includes('overall_sources/')
    ? Response.json([{missing:JSON.parse(options.body).documents[0],readTime:point}]) : f.fetchImpl(url,options)});
  assert.equal(result.report.projectionReady,false);assert.equal(result.report.estimatedReads,4);
  assert.equal(result.files.get('overall.json').builtRevision,10);
});

test('updater automatically applies bound capture before export and never invokes it offline',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'overall-update-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const stage=path.join(root,'local-reports','snapshot-staging');await fs.mkdir(stage,{recursive:true});
  await fs.writeFile(path.join(root,'index.html'),'<html><head></head></html>');
  let called=0;
  await updatePublicSnapshot({root,refreshReplays:true,capture:async options=>{
    assert.ok(options.confirmedTracks instanceof Map);
    assert.equal(options.confirmedTracks.size,1);
    await fs.writeFile(path.join(stage,'manifest.json'),JSON.stringify({schemaVersion:1,tracks:{},events:{}}));return {};
  },captureOverall:async()=>{called++;const f=await fixture();f.documents.get('0.6.2_s1_release_meta/current').sourceCatalog=f.catalog;return captureOverallProjection({fetchImpl:f.fetchImpl});},
  exportPublic:async()=>{
    const manifest=JSON.parse(await fs.readFile(path.join(stage,'manifest.json')));
    assert.equal(manifest.overallProjection.available,true);assert.equal(manifest.overallCapture.publishedRevision,10);
    return {complete:false,counts:{},coverage:{complete:false}};
  },log:()=>{}});
  assert.equal(called,1);
  await updatePublicSnapshot({root,offline:true,captureOverall:()=>{throw Error('Offline auth forbidden');},log:()=>{}});
});

test('stage application preserves fresh tracks, archives and replay lanes and removes stale projection',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'overall-capture-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const preserved={schemaVersion:1,tracks:{fresh:{updatedAt:9999}},events:{archive:{path:'events/old.json'}},eventReplays:{saved:{path:'kept.json'}}};
  await fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify(preserved));
  await fs.mkdir(path.join(directory,'tracks'));await fs.writeFile(path.join(directory,'tracks','fresh.json'),'FRESH');
  const f=await fixture(),capture=await captureOverallProjection({fetchImpl:f.fetchImpl});
  await applyCapturedOverallProjection({directory,capture});
  let manifest=JSON.parse(await fs.readFile(path.join(directory,'manifest.json')));
  for(const key of ['tracks','events','eventReplays'])assert.deepEqual(manifest[key],preserved[key]);
  assert.equal(await fs.readFile(path.join(directory,'tracks','fresh.json'),'utf8'),'FRESH');
  assert.equal(manifest.overallProjection.available,true);
  assert.equal(manifest.overall.sha256,createHash('sha256').update(await fs.readFile(path.join(directory,'overall.json'))).digest('hex'));
  capture.files.delete('projection-source.json');capture.report.projectionReady=false;capture.report.projectionReason='withheld';
  await applyCapturedOverallProjection({directory,capture});
  await assert.rejects(fs.stat(path.join(directory,'projection-source.json')),{code:'ENOENT'});
});

test('Overall above 2 MiB applies as a private monolith and publishes complete bounded pages',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'overall-large-pages-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const directory=path.join(root,'stage');await fs.mkdir(directory);
  await fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify({schemaVersion:1,tracks:{},events:{}}));
  const f=await fixture(),capture=await captureOverallProjection({fetchImpl:f.fetchImpl});
  // Realistic public per-racer result arrays, not oversized unpageable metadata.
  const entries=Array.from({length:800},(_,index)=>({userId:(index+1).toString(16).padStart(64,'0'),name:'Racer',
    rank:index+1,score:800-index,weightedResults:Array.from({length:30},(_,result)=>({trackId:track,
      rank:result+1,fieldSize:800,weight:1,timeMs:10000+index,pbAt:100}))}));
  const overall={...capture.files.get('overall.json'),entries,totalEntries:entries.length,complete:true,sourceComplete:true};
  capture.files.set('overall.json',overall);capture.files.delete('projection-source.json');
  capture.report.projectionReady=false;capture.report.projectionReason='size-only-fixture';
  const expectedBytes=Buffer.byteLength(JSON.stringify(overall)+'\n');
  assert.ok(expectedBytes>MAX_DECODED_BYTES);assert.ok(expectedBytes<=16*1024*1024);
  await applyCapturedOverallProjection({directory,capture});
  assert.equal((await fs.stat(path.join(directory,'overall.json'))).size,expectedBytes);
  const published=await publishSnapshot({root,stagingDirectory:directory});
  const output=path.join(root,published.directory),index=JSON.parse(await fs.readFile(path.join(output,'index.json')));
  assert.equal(index.files['overall.json'],undefined,'large monolith must remain private, never published whole');
  const decode=async logical=>{
    const record=index.files[logical];assert.ok(record,logical);assert.ok(record.decodedBytes<=MAX_DECODED_BYTES);
    const bytes=await decodeSnapshot(await fs.readFile(path.join(output,record.path)));
    assert.ok(bytes.byteLength<=MAX_DECODED_BYTES);return JSON.parse(Buffer.from(bytes).toString('utf8'));
  };
  const manifest=await decode('overall-manifest.json');
  assert.equal(manifest.monolithOmitted,true);assert.equal(manifest.sourceComplete,true);
  assert.equal(manifest.publishedEntries,800);assert.equal(manifest.pageCount,8);
  assert.ok((await decode('snapshot-paging.json')).omittedMonoliths.includes('overall.json'));
  const restored=[];
  for(let page=1;page<=manifest.pageCount;page++)restored.push(...(await decode(`overall-pages/${page}.json`)).entries);
  assert.equal(restored.length,entries.length);
  assert.deepEqual(restored.map(({globalRank,...row})=>row),entries,'all public rows and published order survive paging');
  for(const record of Object.values(index.files))assert.ok(record.decodedBytes<=MAX_DECODED_BYTES);
});

test('Overall above 16 MiB or either companion above 2 MiB rejects before any stage write',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'overall-size-reject-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  for(const [name,limit] of [['overall.json',16],['overall-results.json',2],['projection-source.json',2]]) {
    const directory=path.join(root,name);await fs.mkdir(directory);
    const originals={'manifest.json':JSON.stringify({schemaVersion:1,tracks:{},events:{}}),
      'overall.json':'OLD_OVERALL','overall-results.json':'OLD_RESULTS','projection-source.json':'OLD_PROJECTION','untouched.json':'UNRELATED'};
    for(const [file,bytes]of Object.entries(originals))await fs.writeFile(path.join(directory,file),bytes);
    const capture={files:new Map([['overall.json',{updatedAt:1000,sourceRevision:10,entries:[]}],
      ['overall-results.json',{}],['projection-source.json',{}]]),report:{projectionReady:true}};
    capture.files.set(name,{padding:'x'.repeat(limit*1024*1024)});
    await assert.rejects(applyCapturedOverallProjection({directory,capture}),/Overall public file too large/);
    assert.deepEqual((await fs.readdir(directory)).sort(),Object.keys(originals).sort(),'no extra or temporary output');
    for(const [file,bytes]of Object.entries(originals))
      assert.equal(await fs.readFile(path.join(directory,file),'utf8'),bytes,name+' rejection must leave '+file+' byte-identical');
  }
});

test('auth validates raw canonical document names before OAuth and uses synthetic RSA key only',async()=>{
  let oauth=0,reads=0;
  const privateKey=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'});
  const auth=createOverallCaptureFetch({serviceAccount:{type:'service_account',project_id:'polytrack-052',
    client_email:'fixture@polytrack-052.iam.gserviceaccount.com',private_key:privateKey},
    oauthFetch:async()=>{oauth++;return Response.json({token_type:'Bearer',access_token:'synthetic-token',expires_in:3600});},
    fetchImpl:async(url,options)=>{reads++;assert.equal(options.redirect,'error');assert.equal(options.headers.get('authorization'),'Bearer synthetic-token');return Response.json([]);}});
  for(const relative of ['0.6.2_s1_release_meta/../current','0.6.2_s1_release_meta/%2e%2e/current','0.6.2_s1_leaderboards_track/'+track])
    await assert.rejects(auth(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({documents:[base+relative]})}),/boundary/);
  assert.equal(oauth,0);assert.equal(reads,0);
  await auth(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({documents:[base+'0.6.2_s1_release_meta/current']})});
  assert.equal(oauth,1);assert.equal(reads,1);
});


test('inline results ignore an unused stale sidecar and save one named document read',async()=>{
  const f=await fixture({paged:true,inline:true});f.documents.get('0.6.2_s1_leaderboards_overall/main_results').sourceRevision--;
  const capture=await captureOverallProjection({fetchImpl:async(url,options)=>{
    assert.ok(!JSON.parse(options.body).documents[0].endsWith('/main_results'),'unused sidecar must never be requested');
    return f.fetchImpl(url,options);
  }});
  assert.equal(capture.report.resultSource,'inline');assert.equal(capture.report.rootDocuments,2);
  assert.equal(capture.report.estimatedReads,4);assert.equal(capture.report.generationPages,1);
  assert.equal(capture.report.projectionReady,true);assert.equal(capture.files.get('overall-results.json').sourceRevision,10);
});

test('inline results do not depend on a sidecar existing or being readable',async()=>{
  const f=await fixture({inline:true});f.documents.delete('0.6.2_s1_leaderboards_overall/main_results');
  const capture=await captureOverallProjection({fetchImpl:f.fetchImpl});
  assert.equal(capture.report.estimatedReads,3);assert.equal(capture.report.projectionReady,true);
  assert.equal(f.requests.some(row=>row.documents[0].endsWith('/main_results')),false);
});

test('referenced sidecar remains mandatory and mismatches stop before source or generation page reads',async()=>{
  const f=await fixture({paged:true});f.documents.get('0.6.2_s1_leaderboards_overall/main_results').builtRevision++;
  await assert.rejects(captureOverallProjection({fetchImpl:f.fetchImpl}),/RESULT_BUNDLE_SOURCE_MISMATCH/);
  assert.equal(f.requests.length,3);assert.equal(f.requests.some(row=>/overall_sources|public_pages/.test(row.documents[0])),false);
});

test('a successful inline capture publishes through the real updater despite an obsolete unused sidecar',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'overall-inline-update-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const stage=path.join(root,'local-reports','snapshot-staging');await fs.mkdir(stage,{recursive:true});
  await fs.writeFile(path.join(root,'index.html'),'<html><head></head></html>');
  const f=await fixture({inline:true});f.documents.get('0.6.2_s1_leaderboards_overall/main_results').updatedAt--;
  const result=await updatePublicSnapshot({root,refreshReplays:true,capture:async()=>{
    await fs.writeFile(path.join(stage,'manifest.json'),JSON.stringify({schemaVersion:1,tracks:{},events:{}}));return {};
  },captureOverall:()=>captureOverallProjection({fetchImpl:f.fetchImpl}),exportPublic:async()=>({complete:false,counts:{},coverage:{complete:false}}),log:()=>{}});
  assert.equal(result.generation,1);assert.equal(result.changed,true);
  const manifest=JSON.parse(await fs.readFile(path.join(stage,'manifest.json')));
  assert.equal(manifest.overallCapture.resultSource,'inline');assert.equal(manifest.overallProjection.available,true);
});


test('source mismatch stops before ordinary capture or replay export and preserves publication',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'overall-fail-first-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const stage=path.join(root,'local-reports','snapshot-staging');await fs.mkdir(stage,{recursive:true});
 await fs.writeFile(path.join(root,'index.html'),'<html><head></head></html>');
 const f=await fixture({paged:true});f.documents.get('0.6.2_s1_leaderboards_overall/main_results').sourceRevision--;
 let ordinary=0,exports=0;
 await assert.rejects(updatePublicSnapshot({root,refreshReplays:true,
  captureOverall:()=>captureOverallProjection({fetchImpl:f.fetchImpl}),
  capture:async()=>{ordinary++;return {};},exportPublic:async()=>{exports++;},log:()=>{}}),/RESULT_BUNDLE_SOURCE_MISMATCH/);
 assert.equal(ordinary,0);assert.equal(exports,0);assert.equal(f.requests.length,3);
 await assert.rejects(fs.access(path.join(root,'snapshot-current.json')),/ENOENT/);
});


test('backup reuses the bound Overall capture without Worker root or page requests',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'overall-reuse-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const f=await fixture({paged:true,inline:true}),capture=await captureOverallProjection({fetchImpl:f.fetchImpl});
 const bound=overallCaptureForBackup(capture),calls=[];
 assert.equal(bound.entries.length,2);assert.equal(bound.resultBundleComplete,true);
 let metrics;const result=await runPublicSnapshotBackup({directory:root,capturedOverall:bound,trackIds:[],log:value=>{metrics=JSON.parse(value).publicSnapshotBackup;},
  fetchImpl:async input=>{const u=new URL(input);calls.push(u.pathname);
   if(u.pathname==='/v1/events/catalog')return Response.json({periods:[],archives:[]});
   assert.ok(['/v1/snapshot/track','/v1/events/permanent-rolling-hills/snapshot'].includes(u.pathname));return new Response('',{status:404});}});
 assert.notEqual(result.deferred,true);assert.equal(calls.length,3);assert.equal(calls.some(p=>p.includes('/overall')),false);assert.equal(metrics.workerRequests,3);
 const saved=JSON.parse(await fs.readFile(path.join(root,'overall-results.json')));
 assert.equal(saved.resultBundle,bound.resultBundle);assert.equal(saved.sourceRevision,10);
 const invalid={...capture,files:new Map(capture.files)};
 invalid.files.set('overall-results.json',{...saved,sourceRevision:9});
 assert.throws(()=>overallCaptureForBackup(invalid),/binding mismatch/);
});

test('current exact source binding confirms unchanged public boards with zero additional reads even when dirty',async()=>{
  const f=await fixture(),meta=f.documents.get('0.6.2_s1_release_meta/current');
  meta.sourceCatalog=structuredClone(f.catalog);
  const capture=await captureOverallProjection({fetchImpl:f.fetchImpl});
  assert.equal(meta.dirty,true);
  assert.equal(f.requests.length,4);assert.equal(capture.report.estimatedReads,4);
  const confirmation=capture.confirmedTracks.get(track);
  assert.deepEqual(confirmation,{sha256:publicTrackConfirmationDigest(f.board,track),updatedAt:1000,checkedAt:Date.parse(point)});
  assert.doesNotMatch(JSON.stringify([...capture.confirmedTracks]),/signature|PRIVATE_|ownerUid|entries|sourceCatalog/);
  assert.doesNotMatch(JSON.stringify(capture.report),/confirmedTracks|signature|sourceCatalog/);
});

test('missing, incomplete, changed or future current source catalog never confirms a frozen board',async()=>{
  for(const mutate of [meta=>{delete meta.sourceCatalog;},meta=>{meta.sourceCatalog.complete=false;},
    meta=>{meta.sourceCatalog.tracks[track].signature='changed';},meta=>{meta.sourceCatalog.tracks[track].revision++;},
    meta=>{meta.sourceCatalog.tracks[track].sourceRevision++;},meta=>{meta.sourceCatalog.tracks[track].updatedAt++;},
    meta=>{meta.sourceCatalog.tracks={};meta.sourceCatalog.count=0;},meta=>{meta.sourceCatalog.scannedAt=Date.parse(point)+1;}]){
    const f=await fixture(),meta=f.documents.get('0.6.2_s1_release_meta/current');
    meta.sourceCatalog=structuredClone(f.catalog);mutate(meta);
    const capture=await captureOverallProjection({fetchImpl:f.fetchImpl});
    assert.equal(capture.report.projectionReady,true);
    assert.equal(capture.confirmedTracks.size,0);assert.equal(f.requests.length,4);
  }
});

test('legacy source updateTime bindings require exact current equality',async()=>{
  for(const changed of [false,true]){
    const input=await bound(2,({payload,meta,id})=>{
      payload.catalog.tracks[id]={updateTime:'2026-10-24T00:00:00.123456Z'};
      meta.sourceCatalog=structuredClone(payload.catalog);
      if(changed)meta.sourceCatalog.tracks[id].updateTime='2026-10-24T00:00:00.123457Z';
    });
    const confirmedTracks=new Map();
    await frozenOverallSource({...input,confirmationAt:Date.parse(point),confirmedTracks});
    assert.equal(confirmedTracks.size,changed?0:1);
  }
});

test('backup advances only exact retained public bytes and preserves source timestamps without fetching tracks',async t=>{
  for(const scenario of ['exact','digest-mismatch','changed-binding','missing-evidence','wrong-path','newer-cached','missing-board','older-check',
    'future-check','invalid-check','manifest-mismatch','incomplete-cache']){
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),'track-confirmation-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
    const f=await fixture(),meta=f.documents.get('0.6.2_s1_release_meta/current');
    meta.sourceCatalog=structuredClone(f.catalog);
    if(scenario==='changed-binding')meta.sourceCatalog.tracks[track].signature='new-source';
    if(scenario==='missing-evidence')delete meta.sourceCatalog;
    const capture=await captureOverallProjection({fetchImpl:f.fetchImpl});
    if(scenario==='future-check')capture.confirmedTracks.get(track).checkedAt=Date.parse(point)+101;
    if(scenario==='invalid-check')capture.confirmedTracks.get(track).checkedAt=NaN;
    const board=publicTrackBackup(f.board,track);
    if(scenario==='digest-mismatch')board.entries[0].timeMs++;
    if(scenario==='newer-cached')board.updatedAt++;
    if(scenario==='incomplete-cache')board.complete=false;
    const relative=`tracks/${track}.json`,previousCheck=scenario==='older-check'?Date.parse(point)+1:2000;
    const record={path:scenario==='wrong-path'?'tracks/wrong.json':relative,revision:board.revision,
      sourceUpdatedAt:board.updatedAt,updatedAt:board.updatedAt,checkedAt:previousCheck};
    if(scenario==='manifest-mismatch')record.sourceUpdatedAt--;
    await fs.mkdir(path.join(directory,'tracks'));
    const before=JSON.stringify(board)+'\n';
    if(scenario!=='missing-board')await fs.writeFile(path.join(directory,relative),before);
    await fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify({schemaVersion:1,tracks:{[track]:record},events:{}}));
    const calls=[];
    const result=await runPublicSnapshotBackup({directory,capturedOverall:overallCaptureForBackup(capture),
      confirmedTracks:capture.confirmedTracks,trackFetchLimit:0,trackIds:[],now:Date.parse(point)+100,log:()=>{},
      fetchImpl:async input=>{
        const p=new URL(input).pathname;calls.push(p);
        if(p==='/v1/events/catalog')return Response.json({periods:[],archives:[]});
        assert.equal(p,'/v1/events/permanent-rolling-hills/snapshot');return new Response('',{status:404});
      }});
    assert.equal(result.deferred,undefined);assert.equal(calls.length,2);
    const saved=result.tracks[track];
    assert.equal(saved.checkedAt,scenario==='exact'?Date.parse(point):['wrong-path','missing-board'].includes(scenario)?undefined:previousCheck,scenario);
    assert.equal(saved.updatedAt,record.updatedAt);assert.equal(saved.sourceUpdatedAt,record.sourceUpdatedAt);
    if(scenario!=='missing-board')assert.equal(await fs.readFile(path.join(directory,relative),'utf8'),before);
    assert.doesNotMatch(JSON.stringify(result),/confirmedTracks|sourceCatalog|signature|PRIVATE_/);
  }
});

async function bound(count=501,mutate=()=>{}){
  const f=await fixture(),meta=f.documents.get('0.6.2_s1_release_meta/current');
  const overall=f.documents.get('0.6.2_s1_leaderboards_overall/main'),results=f.documents.get('0.6.2_s1_leaderboards_overall/main_results');
  const documents=new Map([...f.documents].filter(([key])=>key.startsWith('0.6.2_s1_overall_sources/')).map(([key,data])=>[key.split('/')[1],{data}]));
  const envelope=JSON.parse(await decodeSourcePublication(meta.sourceBundle,documents)),payload=envelope.payload;
  const id=overall.trackCatalog[0].trackId,board=payload.boards[id];
  board.entries=Array.from({length:count},(_,index)=>({...board.entries[0],accountId:(index+1).toString(16).padStart(64,'0'),timeMs:10000+index}));
  board.totalEntries=count;mutate({payload,board,overall,meta,results,id});
  const publication=await prepareSourcePublication(JSON.stringify(envelope),{...meta.sourceBundle,digest:digest(payload),catalogHash:digest(payload.catalog)});
  meta.sourceBundle=publication.marker;
  return {meta,overall,results,documents:new Map(publication.documents.map(row=>[row.id,{data:row.data}])),board,id};
}

test('authenticated signed 501-entry full source is accepted after exact catalog validation, with no invented paging flags',async()=>{
  const input=await bound(),before=JSON.stringify(input.board);
  const tracks=await frozenOverallSource(input);
  assert.equal(tracks.length,1);assert.equal(tracks[0].entries.length,501);assert.equal(tracks[0].totalEntries,501);
  assert.equal(Object.hasOwn(tracks[0],'pagination'),false);assert.equal(Object.hasOwn(tracks[0],'paginatedSource'),false);
  assert.doesNotMatch(JSON.stringify(tracks),/ownerUid|signature/);assert.equal(JSON.stringify(input.board),before);
  assert.throws(()=>publicTrackBackup(input.board,input.id),/Invalid public track snapshot/);
});

test('public legacy default stays 500; authenticated internal maximum is exactly 10000',async()=>{
  const input=await bound(500);assert.equal(publicTrackBackup(input.board,input.id).entries.length,500);
  const template=input.board.entries[0];
  for(const count of [501,10000]){
    const board={...input.board,totalEntries:count,entries:Array.from({length:count},()=>({...template}))};
    assert.throws(()=>publicTrackBackup(board,input.id),/Invalid public track snapshot/);
    assert.equal(authenticatedOverallTrackBackup(board,input.id).entries.length,count);
  }
  const board={...input.board,totalEntries:10001,entries:Array.from({length:10001},()=>({...template}))};
  assert.throws(()=>authenticatedOverallTrackBackup(board,input.id),/Invalid authenticated Overall track snapshot/);
});

test('malformed authenticated count, completeness, identity and entry container are rejected',async()=>{
  const {board,id}=await bound();
  for(const change of [{totalEntries:500},{totalEntries:501.5},{complete:false,sourceComplete:false},{trackId:'a'.repeat(64)},{entries:{}},{updatedAt:'1000'}]){
    assert.throws(()=>authenticatedOverallTrackBackup({...board,...change},id),/Invalid authenticated Overall track snapshot/);
  }
});

test('signed malformed source count and incomplete board are rejected before projection',async()=>{
  for(const mutate of [({board})=>{board.totalEntries--;},({board})=>{board.complete=false;board.sourceComplete=false;}]){
    await assert.rejects(frozenOverallSource(await bound(501,mutate)),/FROZEN_BOARD_INCOMPLETE/);
  }
  await assert.rejects(frozenOverallSource(await bound(10001)),/Invalid authenticated Overall track snapshot/);
});

test('hash, exact track binding and complete catalog guards remain mandatory for the 501 lane',async()=>{
  const input=await bound();input.meta.sourceBundle.digest='f'.repeat(64);
  await assert.rejects(frozenOverallSource(input),/OVERALL_SOURCE_PUBLICATION_INVALID/);
  await assert.rejects(frozenOverallSource(await bound(501,({board})=>{board.updatedAt++;})),/FROZEN_BOARD_BINDING_MISMATCH/);
  await assert.rejects(frozenOverallSource(await bound(501,({overall})=>{overall.trackCatalog[0].updatedAt++;})),/FROZEN_TRACK_CATALOG_MISMATCH/);
  await assert.rejects(frozenOverallSource(await bound(501,({overall})=>{overall.trackCatalog=[];})),/FROZEN_TRACK_CATALOG_MISMATCH/);
});

test('public valid assembled pagination still follows the existing public validation contract',async()=>{
  const {board,id}=await bound();
  const paged={...board,sourceComplete:true,paginatedSource:true,pagination:{version:1,generation:'a'.repeat(64),complete:true,pageSize:100,totalEntries:501,pageCount:6}};
  assert.equal(publicTrackBackup(paged,id).entries.length,501);
  assert.throws(()=>publicTrackBackup({...paged,pagination:{...paged.pagination,pageCount:5}},id),/Invalid public track snapshot/);
});


test('successful frozen baseline has no failure diagnosis and uses the same reads',async()=>{
  const f=await fixture();const result=await captureOverallProjection({fetchImpl:f.fetchImpl});
  assert.equal(result.report.projectionReady,true);assert.equal(result.report.projectionFailureStage,null);
  assert.equal(result.report.projectionFailureCode,null);assert.equal(result.report.estimatedReads,4);
});
test('missing frozen marker is identified without source scans, retries or fabricated projection',async()=>{
  const f=await fixture();delete f.documents.get('0.6.2_s1_release_meta/current').sourceBundle;
  const result=await captureOverallProjection({fetchImpl:f.fetchImpl});
  assert.equal(result.report.projectionReady,false);assert.equal(result.report.projectionFailureStage,'frozen-source');
  assert.equal(result.report.projectionFailureCode,'FROZEN_OVERALL_SOURCE_UNAVAILABLE_OR_STALE');
  assert.equal(result.report.estimatedReads,3);assert.equal(result.files.has('projection-source.json'),false);
});
test('exact-baseline failure is distinguished from frozen-marker failure',async()=>{
  const f=await fixture();const result=await captureOverallProjection({fetchImpl:f.fetchImpl,
    buildBundle:async()=>{throw Error('Overall projection baseline mismatch: baseline_mismatch');}});
  assert.equal(result.report.projectionFailureStage,'baseline');assert.equal(result.report.projectionFailureCode,'baseline_mismatch');
  assert.equal(result.report.projectionReason,'bound-source-or-baseline-unavailable');assert.equal(result.report.estimatedReads,4);
});
test('unknown exception text is not copied to public diagnostics',async()=>{
  for(const message of ['PRIVATE_HEADERS_AND_CREDENTIAL_CANARY','FROZEN_PRIVATE_ACCOUNT_CANARY','Overall projection baseline mismatch: private_account_canary']){
    const f=await fixture();const result=await captureOverallProjection({fetchImpl:f.fetchImpl,
      buildBundle:async()=>{throw Error(message);}});
    assert.equal(result.report.projectionFailureCode,'unclassified');assert.doesNotMatch(JSON.stringify(result.report),/CANARY|private_account_canary/);
  }
});
test('mixed publication digest is classified at the frozen-source stage',async()=>{
  const f=await fixture();f.documents.get('0.6.2_s1_release_meta/current').sourceBundle.digest='f'.repeat(64);
  const result=await captureOverallProjection({fetchImpl:f.fetchImpl});
  assert.equal(result.report.projectionFailureStage,'frozen-source');assert.equal(result.report.projectionFailureCode,'OVERALL_SOURCE_PUBLICATION_INVALID');
  assert.equal(result.report.estimatedReads,4);assert.equal(result.files.has('projection-source.json'),false);
});
test('invalid board and oversized result errors map to fixed public codes',async()=>{
  for(const [message,code] of [['Invalid Overall projection board','PROJECTION_BOARD_INVALID'],['Projection results too large','PROJECTION_RESULTS_TOO_LARGE']]){
    const f=await fixture();const result=await captureOverallProjection({fetchImpl:f.fetchImpl,buildBundle:async()=>{throw Error(message);}});
    assert.equal(result.report.projectionFailureStage,'baseline');assert.equal(result.report.projectionFailureCode,code);
  }
});
