import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {gzipSync} from 'node:zlib';
import {createPublicSnapshotReader} from './public-snapshot-client.mjs';
import {createLocalOverallController} from './overall-local-controller.mjs';
import {computeOverall,trackWeightParts} from '../workers/ranked/src/index.js';
const source=await readFile(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
function fn(name){const start=source.search(new RegExp('^  (?:async )?function '+name+'\\(','m'));assert.ok(start>=0,name);return source.slice(start,source.indexOf('\n  }',start)+4);}
const trackId='5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038';

test('packageInfo is read-only, reports the pathname generation, and follows pointer changes without data reads',async()=>{
  let calls=0;
  const read=createPublicSnapshotReader({baseUrl:'https://example.test/game/public-snapshots43/',packed:true,
    fetchImpl:async url=>{calls++;assert.equal(String(url),'https://example.test/game/snapshot-current.json');return Response.json({currentdir:'public-snapshots44'});}});
  const first=read.packageInfo();assert.deepEqual(first,{generation:43,epoch:0,baseUrl:'https://example.test/game/public-snapshots43/'});assert.equal(calls,0);
  assert.throws(()=>{first.generation=99;},TypeError);assert.throws(()=>{read.packageInfo=()=>({});},TypeError);
  assert.equal(await read.refresh(),true);assert.deepEqual(read.packageInfo(),{generation:44,epoch:1,baseUrl:'https://example.test/game/public-snapshots44/'});
  assert.equal(first.generation,43);assert.equal(calls,1);
});
test('unknown package names cannot masquerade as a numbered static generation',()=>{
  const read=createPublicSnapshotReader({baseUrl:'https://example.test/public-snapshots/',fetchImpl:()=>assert.fail('No reads needed')});
  assert.equal(read.packageInfo().generation,0);
});
test('confirmed-PB hook acknowledges only a new confirmed signature',async()=>{
  const saved={},acks=[];
  const ctx=vm.createContext({LOCAL_PB_RECONCILE_STATE_KEY:'sync',readJsonStorage:()=>saved,writeJsonStorage:(_key,next)=>Object.assign(saved,next),
    localPbSyncSignature:row=>`${row.timeMs}|${row.replayHash}`,canonicalRaceTimeMs:row=>row.timeMs,
    acknowledgeLocalOverallPb:async(...args)=>acks.push(args),Date});
  vm.runInContext(fn('rememberConfirmedLocalPb'),ctx);
  const row={trackId,timeMs:10000,replayHash:'first'};
  ctx.rememberConfirmedLocalPb('b',row);ctx.rememberConfirmedLocalPb('b',row);await Promise.resolve();
  assert.equal(acks.length,1);assert.equal(acks[0][0],'b');assert.equal(acks[0][1],row);assert.ok(acks[0][2]>0);
  ctx.rememberConfirmedLocalPb('b',{...row,timeMs:9000,replayHash:'second'});await Promise.resolve();assert.equal(acks.length,2);
});

function hooksFixture(){
  const nodes=new Map(),storage=new Map([['polytrack-0.6.2-active-account-id','b']]),listeners={};let reads=0;
  const element=()=>({dataset:{},style:{},innerHTML:'',textContent:'',setAttribute(){},remove(){nodes.delete(this.id);}});
  const top={insertAdjacentElement(_position,node){nodes.set(node.id,node);}};
  const panel={style:{display:'flex'},querySelector:selector=>selector==='.overall-top'?top:null};nodes.set('overallLeaderboardPanel',panel);
  const freshness=element();nodes.set('overallFreshness',freshness);
  const metadata={algorithmVersion:'participation-v8-s1',schemaVersion:6,sourceRevision:10,builtRevision:10,updatedAt:100000};
  const weight=Number(trackWeightParts(trackId,2,1).finalWeight.toFixed(3));
  const board={...metadata,trackId,complete:true,totalEntries:2,entries:[['a',10000],['b',12000]].map(([accountId,timeMs])=>({accountId,userId:accountId,trackId,timeMs,pbAt:100,weight,runVerified:true,integrityVerified:true}))};
  const entries=computeOverall([board],[],new Set(),{includePlannerResults:true});
  const overall={...metadata,entries,complete:true,totalEntries:entries.length,trackCatalog:[{trackId,updatedAt:board.updatedAt}]};
  const results={...metadata,resultBundleVersion:1,resultBundleEncoding:'gzip-base64-json-v1',resultBundleComplete:true,resultBoardCount:1,resultBoardLimitReached:false,
    resultBundle:gzipSync(JSON.stringify({entries:entries.map(row=>({userId:row.userId,resultSamples:row.resultSamples})),resultTracks:[trackId]})).toString('base64')};
  let info={generation:43,epoch:0,baseUrl:'https://example.test/public-snapshots43/'};
  const reader=async kind=>{reads++;return kind==='overall'?overall:kind==='overall-results'?results:kind==='overall-projection'?null:board;};reader.packageInfo=()=>({...info});
  const ctx=vm.createContext({Promise,Date,setTimeout,clearTimeout,clearInterval,queueMicrotask,MutationObserver:class{observe(){}},
    document:{hidden:false,getElementById:id=>nodes.get(id)||null,createElement:()=>element(),head:{appendChild:node=>nodes.set(node.id,node)},addEventListener:(name,callback)=>{listeners[name]=callback;}},
    window:{addEventListener:(name,callback)=>{listeners[name]=callback;}},
    localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)},
    renderEntries:()=>{},overallCategory:'overall',overallLoadState:{status:'snapshot',serverUpdatedAt:100000},publicSnapshotCapturedAt:100000,
    rankedManualRefreshFailed:false,rankedFreshnessTimer:0,publicSnapshotReaderPromise:Promise.resolve(reader),guestAccountId:'',
    cleanUserId:String,escapeHtml:String,canonicalRaceTimeMs:row=>row.timeMs,readLocalRaceRows:()=>[],formatRp:value=>Number(value).toFixed(3),ageLabel:()=> '1h ago',
    readOverallSnapshotCache:()=>({source:'public-backup'}),applyRankedRefreshCooldown:()=>{},
    isElementVisible:node=>Boolean(node&&node.style.display!=='none'),
    loadControllerModule:async()=>({createLocalOverallController})});
  const start=source.indexOf('  let localOverallController=null'),end=source.indexOf('  let publicSnapshotReaderPromise=null;',start);
  assert.ok(start>=0&&end>start);
  const hooks=source.slice(start,end).replace(/import\('\.\/tools\/overall-local-controller\.mjs\?v=\d+'\)/,'loadControllerModule()');
  vm.runInContext(hooks+'\n'+fn('activeRankedAccountId')+'\n'+fn('updateRankedFreshness')+'\n'+fn('closeOverallPanel'),ctx);
  return {ctx,nodes,storage,overall,panel,reads:()=>reads,setInfo:value=>{info=value;},listeners};
}
test('real controller hooks expose inline estimates without cards, preserve canonical rows, and reuse baseline on reopen',async()=>{
  const f=hooksFixture(),before=JSON.stringify(f.overall);
  await f.ctx.syncLocalOverallProjection();assert.equal(f.reads(),0);
  await f.ctx.acknowledgeLocalOverallPb('b',{trackId,timeMs:9000},Date.now());await f.ctx.syncLocalOverallProjection();
  assert.equal(f.nodes.has('localOverallEstimate'),false);assert.ok(f.ctx.currentLocalOverallResult()?.projection);
  assert.equal(f.ctx.currentLocalOverallResult().projection.localPending,true);
  assert.match(f.nodes.get('overallFreshness').textContent,/Snapshot \+ local recalculation/);
  assert.equal(JSON.stringify(f.overall),before);const count=f.reads();
  f.ctx.closeOverallPanel(f.panel);await f.ctx.syncLocalOverallProjection();assert.equal(f.nodes.has('localOverallEstimate'),false);
  f.panel.style.display='flex';await f.ctx.syncLocalOverallProjection();assert.ok(f.ctx.currentLocalOverallResult());assert.equal(f.nodes.has('localOverallEstimate'),false);assert.equal(f.reads(),count);
});
test('account and package changes immediately discard inline estimates and the local freshness label',async()=>{
  const f=hooksFixture();await f.ctx.acknowledgeLocalOverallPb('b',{trackId,timeMs:9000},Date.now());await f.ctx.syncLocalOverallProjection();
  f.storage.set('polytrack-0.6.2-active-account-id','a');f.ctx.activeRankedAccountId();await new Promise(resolve=>setTimeout(resolve,5));
  await f.ctx.syncLocalOverallProjection();assert.equal(f.nodes.has('localOverallEstimate'),false);
  assert.doesNotMatch(f.nodes.get('overallFreshness').textContent,/local recalculation/);
  f.storage.set('polytrack-0.6.2-active-account-id','b');await f.ctx.syncLocalOverallProjection();assert.ok(f.ctx.currentLocalOverallResult());assert.equal(f.nodes.has('localOverallEstimate'),false);
  const count=f.reads();f.setInfo({generation:44,epoch:1,baseUrl:'https://example.test/public-snapshots44/'});
  await f.ctx.syncLocalOverallProjection();assert.equal(f.nodes.has('localOverallEstimate'),false);assert.equal(f.reads(),count);
});
test('other ranking categories do not display or preload local Overall projections',async()=>{
  const f=hooksFixture();f.ctx.overallCategory='events';await f.ctx.acknowledgeLocalOverallPb('b',{trackId,timeMs:9000},Date.now());
  await f.ctx.syncLocalOverallProjection();assert.equal(f.reads(),0);assert.equal(f.nodes.has('localOverallEstimate'),false);
});
test('a package transition during lazy controller import discards the waiting receipt',async()=>{
  const f=hooksFixture();f.ctx.loadControllerModule=async()=>{f.setInfo({generation:44,epoch:1,baseUrl:'https://example.test/public-snapshots44/'});return {createLocalOverallController};};
  await f.ctx.acknowledgeLocalOverallPb('b',{trackId,timeMs:9000},Date.now());await f.ctx.syncLocalOverallProjection();
  assert.equal(f.storage.has('polytrack-overall-accepted-pbs-v1'),false);assert.equal(f.reads(),0);
});
test('controller child import carries the release query and remains executable with that query',async()=>{
  const text=await readFile(new URL('./overall-local-controller.mjs',import.meta.url),'utf8');
  assert.match(text,/projectionUrl\.search=new URL\(import\.meta\.url\)\.search/);
  const module=await import(new URL('./overall-local-controller.mjs?integration-release=175',import.meta.url));
  assert.equal(typeof module.createLocalOverallController,'function');
});

test('inline presentation uses isolated copies and keeps snapshot comparison accessible',()=>{
 assert.match(fn('sortedOverallEntries'),/localEstimateOrigin:\{score:row.score,rank:row.rank\}/);
 assert.match(fn('renderEntryRow'),/Local RP-/);assert.match(fn('renderEntryRow'),/Verified RP-/);
 assert.match(fn('renderEntryRow'),/escapeHtml\(estimateTitle\)/);
 assert.doesNotMatch(fn('renderLocalOverallProjection'),/\.id\s*=\s*['"]localOverallEstimate['"]|insertAdjacentElement/);
 assert.match(fn('renderLocalOverallProjection'),/scopedRankingSnapshotNotice/);
});
