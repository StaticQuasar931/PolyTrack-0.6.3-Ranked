import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {gzipSync} from 'node:zlib';
import {projectScopedSnapshot} from './overall-local-projection.mjs';
import {createLocalOverallController} from './overall-local-controller.mjs';
import {rankedMetricState,ROLLING_HILLS_ID} from './ranking-scope-model.mjs';
import {computeOverall,trackWeightParts} from '../workers/ranked/src/index.js';

const source=(await fs.readFile(new URL('../polytrack_062_patch.js',import.meta.url),'utf8')).replace(/\r/g,'');
function functionText(text,name){
  const start=text.search(new RegExp('^  (?:async )?function '+name+'\\(','m'));
  assert.ok(start>=0,'Missing integrated function '+name);
  const end=text.indexOf('\n  }',start);
  assert.ok(end>start,'Missing integrated function end '+name);
  return text.slice(start,end+4);
}
const helpers=['localCasualIsVisible','currentLocalCasualResult','attachLocalRankingSidecars','rankingMetricFor']
  .map(name=>functionText(source,name)).join('\n');
const id='5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038';
const clock=2000000000000,clone=x=>JSON.parse(JSON.stringify(x));
const originalFetch=globalThis.fetch;
test.before(()=>{globalThis.fetch=()=>{throw Error('Network forbidden in scoped ranking unit tests');};});
test.after(()=>{globalThis.fetch=originalFetch;});

function dataset(trackId=id){
  const metadata={algorithmVersion:'participation-v8-s1',schemaVersion:6,sourceRevision:10,builtRevision:10,updatedAt:100000};
  const weight=Number(trackWeightParts(trackId,2,1).finalWeight.toFixed(3));
  const board={...metadata,trackId,complete:true,totalEntries:2,entries:[['a',10000],['b',12000]].map(([accountId,timeMs])=>
    ({accountId,userId:accountId,trackId,timeMs,pbAt:100,weight,runVerified:true,integrityVerified:true}))};
  const entries=computeOverall([board],[],new Set(),{includePlannerResults:true});
  const overall={...metadata,entries,complete:true,totalEntries:entries.length,trackCatalog:[{trackId,updatedAt:board.updatedAt}]};
  const encoded={entries:entries.map(row=>({userId:row.userId,resultSamples:row.resultSamples})),resultTracks:[trackId]};
  const results={...metadata,resultBundleVersion:1,resultBundleEncoding:'gzip-base64-json-v1',resultBundleComplete:true,
    resultBoardCount:1,resultBoardLimitReached:false,resultBundle:gzipSync(JSON.stringify(encoded)).toString('base64')};
  return {overall,results,board};
}
function fixture({view='casual',scope='official',visible=true,readOverride}={}){
  const data=dataset(),states=[],calls=[];
  const env={view,scope,visible,account:'new-user',time:clock,info:{generation:57,epoch:0,baseUrl:'fixture://snapshot57/'}};
  const needs=()=>env.visible&&(env.view==='casual'||env.view==='wins'&&env.scope==='official');
  const controller=createLocalOverallController({storage:{getItem:()=>null,setItem(){}},
    packageInfo:()=>env.info,getAccount:()=>env.account,isVisible:()=>env.visible&&(env.view==='overall'||needs()),needsBaseline:needs,
    read:async(kind,trackId)=>{calls.push([kind,trackId]);if(readOverride)return readOverride(kind,data);return clone(kind==='overall'?data.overall:kind==='overall-results'?data.results:data.board);},
    onState:s=>states.push(s),now:()=>env.time});
  return {controller,data,env,states,calls};
}
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function mainHarness(result,mode='casual'){
  const env={hidden:false,visible:true,category:mode,scope:'official',account:'new-user',info:{generation:57,epoch:0,baseUrl:'fixture://snapshot57/'},smart:false};
  const context=vm.createContext({document:{get hidden(){return env.hidden;},getElementById:()=>({})},
    isElementVisible:()=>env.visible,activeRankedAccountId:()=>env.account,
    localOverallReader:{packageInfo:()=>env.info},localOverallState:{status:result.status,accountId:env.account,generation:57,packageEpoch:0,packageBaseUrl:env.info.baseUrl,result},
    personalFilterRuntime:{active:()=>env.smart,getFilter:()=>({mode:'smart'})},
    TRACK_CATALOG:new Map([[id,{id,type:'official'}]]),LEGACY_TRACK_CATALOG:new Map(),ROLLING_HILLS_ID:'rolling',rankedMetricState,
    overallCategory:env.category,overallRankingScope:env.scope});
  vm.runInContext(functionText(source,'localOverallIsVisible')+'\n'+functionText(source,'currentLocalOverallResult')+'\n'+helpers,context);
  return {env,context,setCategory:(category,scope='official')=>{env.category=category;env.scope=scope;context.overallCategory=category;context.overallRankingScope=scope;}};
}

test('visible Casual without receipts loads a validated baseline for a brand-new account',async()=>{
  const f=fixture();const state=await f.controller.update();
  assert.equal(state.status,'scoped-snapshot');assert.equal(state.accountId,'new-user');assert.equal(f.calls.length,2);
  assert.equal(state.result.publicRank,null);assert.equal(state.result.localPending,false);
  assert.ok(state.result.casualRacers.every(row=>row.casualProjection.known&&row.trackResults.length===row.raceCount));
  assert.doesNotMatch(JSON.stringify(state.result),/"(?:rank|runVerified|integrityVerified)":/);
});
test('visible scoped wins loads baseline; Total wins and Overall without receipts do not',async()=>{
  assert.equal((await fixture({view:'wins'}).controller.update()).status,'scoped-snapshot');
  for(const options of [{view:'overall'},{view:'wins',scope:'total'},{view:'casual',visible:false},{view:'skill'}]){
    const f=fixture(options);assert.equal((await f.controller.update()).status,'idle');assert.equal(f.calls.length,0);
  }
});
test('cached baseline is shared across visible scoped categories without repeated reads',async()=>{
  const f=fixture();await f.controller.update();for(let i=0;i<5;i++)await f.controller.update();assert.equal(f.calls.length,2);
  f.env.view='wins';await f.controller.update();assert.equal(f.calls.length,2);
  f.env.scope='total';assert.equal((await f.controller.update()).status,'idle');assert.equal(f.calls.length,2);
  f.env.view='casual';assert.equal((await f.controller.update()).status,'scoped-snapshot');assert.equal(f.calls.length,2);
});
test('default controller behavior is unchanged: no opt-in and no receipts means zero reads',async()=>{
  let calls=0;
  const c=createLocalOverallController({read:async()=>{calls++;},packageInfo:()=>({generation:57,epoch:0,baseUrl:'fixture://s/'}),getAccount:()=> 'new',isVisible:()=>true});
  assert.equal((await c.update()).status,'idle');assert.equal(calls,0);
});
test('account switch during baseline read cannot publish another account result',async()=>{
  const gate=deferred(),started=deferred();
  const f=fixture({readOverride:async(kind,data)=>{if(kind==='track'){started.resolve();await gate.promise;}return clone(kind==='overall'?data.overall:kind==='overall-results'?data.results:data.board);}});
  const work=f.controller.update();await started.promise;f.env.account='other-user';const marker=f.states.length;
  const next=f.controller.update();gate.resolve();await Promise.all([work,next]);
  assert.ok(f.states.slice(marker).every(s=>s.accountId==='other-user'));assert.equal(f.states.at(-1).status,'scoped-snapshot');
});
for(const change of ['generation','epoch','baseUrl'])test(change+' change fences late baseline results',async()=>{
  const gate=deferred(),started=deferred();
  const f=fixture({readOverride:async(kind,data)=>{if(kind==='track'){started.resolve();await gate.promise;}return clone(kind==='overall'?data.overall:kind==='overall-results'?data.results:data.board);}});
  const work=f.controller.update();await started.promise;const previous=f.env.info;
  f.env.info={...previous,[change]:change==='baseUrl'?'fixture://replacement/':previous[change]+1};
  const marker=f.states.length,next=f.controller.update();gate.resolve();await Promise.all([work,next]);
  assert.ok(f.states.slice(marker).filter(s=>s.result).every(s=>s.generation===f.env.info.generation));
  assert.equal(f.states.at(-1).status,'scoped-snapshot');assert.equal(f.calls.length,4);
});
test('hiding a scoped ranking mid-read suppresses late result and starts no further baseline batch',async()=>{
  const gate=deferred(),started=deferred();
  const f=fixture({readOverride:async(kind,data)=>{if(kind==='track'){started.resolve();await gate.promise;}return clone(kind==='overall'?data.overall:kind==='overall-results'?data.results:data.board);}});
  const work=f.controller.update();await started.promise;f.env.visible=false;const next=f.controller.update();gate.resolve();await Promise.all([work,next]);
  assert.equal(f.states.at(-1).status,'idle');assert.ok(!f.states.some(s=>s.status==='unchanged'));
});
test('baseline failures retain the existing one-minute retry budget',async()=>{
  const f=fixture({readOverride:async()=>{throw Error('static_failure');}});
  assert.equal((await f.controller.update()).status,'unavailable');const reads=f.calls.length;
  await f.controller.invalidate();await f.controller.update();assert.equal(f.calls.length,reads);
  f.env.time+=60000;await f.controller.update();assert.equal(f.calls.length,reads+1);
});
test('fenced accessor accepts unchanged/projected only and leaves Overall accessor overall-only',async()=>{
  const result=(await fixture().controller.update()).result,h=mainHarness(result);
  assert.ok(h.context.currentLocalCasualResult());assert.equal(h.context.currentLocalOverallResult(),null);
  for(const key of ['account','generation','epoch','baseUrl']){
    const saved=clone(h.env.info),account=h.env.account;
    if(key==='account')h.env.account='different';else h.env.info={...h.env.info,[key]:key==='baseUrl'?'changed':h.env.info[key]+1};
    assert.equal(h.context.currentLocalCasualResult(),null,key);h.env.info=saved;h.env.account=account;
  }
  h.context.localOverallState.status='loading';assert.equal(h.context.currentLocalCasualResult(),null);
  h.context.localOverallState.status='unchanged';h.setCategory('overall');assert.equal(h.context.currentLocalCasualResult(),null);
});
test('scoped receipts stay excluded when no matched Overall projection is used',async()=>{
  const f=fixture();
  f.controller.acknowledge({accountId:'new-user',trackId:id,timeMs:9000,acceptedAt:clock});
  const state=await f.controller.update();assert.equal(state.status,'scoped-snapshot');
  assert.equal(state.result.acceptedPbsApplied,false);assert.equal(state.result.overallProjection,false);
  const h=mainHarness(state.result);assert.ok(h.context.currentLocalCasualResult());
  const [row]=h.context.attachLocalRankingSidecars([{userId:'a',rank:10}]);
  assert.equal(h.context.rankingMetricFor(row).localPending,false);assert.equal(row.rank,10);
  h.setCategory('overall');assert.equal(h.context.currentLocalOverallResult(),null);
});

test('sidecars attach to real ranking rows, resolve Official Casual, and retain public identity/rank',async()=>{
  const result=(await fixture().controller.update()).result,h=mainHarness(result);
  const rows=[{userId:'a',rank:7,name:'Public name',raceCount:99},{userId:'missing',rank:8}];
  const attached=h.context.attachLocalRankingSidecars(rows);
  assert.equal(attached[0].rank,7);assert.equal(attached[0].name,'Public name');assert.equal(attached[0].raceCount,99);
  assert.equal(rows[0].casualProjection,undefined);assert.ok(attached[0].casualProjection.known);
  const state=h.context.rankingMetricFor(attached[0]);assert.equal(state.known,true);assert.equal(state.localPending,false);assert.ok(state.value>=0);
  assert.equal(attached[1],rows[1]);assert.equal(h.context.rankingMetricFor(attached[1]).known,false);
  h.setCategory('wins');assert.equal(h.context.rankingMetricFor(attached[0]).value,0);
  assert.doesNotMatch(JSON.stringify(attached[0].localRankingFinishes),/"rank":/);
  h.env.smart=true;assert.equal(h.context.attachLocalRankingSidecars(rows),rows);
});
test('complete scoped finish sidecar supplies eligible official wins when public samples are partial',()=>{
  const result={status:'unchanged',generation:57,calculationExact:true,publicRank:null,localPending:false,projection:null,
    casualRacers:[{userId:'a',raceCount:1,trackResults:[{trackId:id,projectedRank:1,fieldSize:5}]}]};
  const h=mainHarness(result,'wins'),[row]=h.context.attachLocalRankingSidecars([{userId:'a',raceCount:100,resultSamples:[]}]);
  assert.equal(h.context.rankingMetricFor(row).value,1);
  h.setCategory('wins','total');assert.equal(h.context.currentLocalCasualResult(),null);
});
test('sync lazy initialization bypasses missing/blocked receipt storage only for visible baseline categories',async()=>{
  for(const category of ['overall','casual','wins'])for(const scope of ['total','official']){
    let initialized=0;
    const context=vm.createContext({overallCategory:category,overallRankingScope:scope,
      document:{hidden:false,getElementById:()=>({})},isElementVisible:()=>true,localOverallController:null,
      renderLocalOverallProjection:()=>{},localStorage:{getItem(){throw Error('blocked');}},
      ensureLocalOverallController:async()=>{initialized++;return {update:async()=>({status:'unchanged'})};}});
    vm.runInContext(functionText(source,'localOverallIsVisible')+'\n'+helpers+'\n'+
      source.slice(source.indexOf('  async function syncLocalOverallProjection(){'),source.indexOf('\n  async function acknowledgeLocalOverallPb(',source.indexOf('  async function syncLocalOverallProjection(){'))),context);
    await context.syncLocalOverallProjection();assert.equal(initialized,category==='casual'||category==='wins'&&scope==='official'?1:0);
  }
});
test('integrated wiring opts into scoped baseline without widening the Overall accessor',()=>{
  const overallAccessor=functionText(source,'currentLocalOverallResult');
  assert.match(overallAccessor,/localOverallIsVisible\(\)/);
  assert.doesNotMatch(overallAccessor,/localCasualIsVisible/);
  assert.match(functionText(source,'ensureLocalOverallController'),/needsBaseline:localCasualIsVisible/);
  assert.match(functionText(source,'sortedOverallEntries'),/attachLocalRankingSidecars/);
  assert.doesNotThrow(()=>new Function(source));
});

test('scoped source rejects invalid Overall directory metadata without requiring matching board timestamps',()=>{
 const data=dataset(),base={accountId:'a',generation:57,overall:{...data.overall,generation:57},tracks:[{...data.board,generation:57}]};
 for(const patch of [{sourceRevision:0},{updatedAt:-1}])assert.equal(projectScopedSnapshot({...base,overall:{...base.overall,...patch}}).status,'unavailable');
 assert.equal(projectScopedSnapshot({...base,overall:{...base.overall,updatedAt:data.overall.updatedAt+1}}).status,'scoped-snapshot');
});

test('Rolling Hills is counted once in Total Casual and never in Official Casual',()=>{
  const {overall,board}=dataset(ROLLING_HILLS_ID),generation=57;
  const result=projectScopedSnapshot({generation,accountId:'a',overall:{...overall,generation},tracks:[{...board,generation}]});
  assert.equal(result.status,'scoped-snapshot',result.reason);
  const row=result.casualRacers.find(r=>r.userId==='a');
  assert.equal(row.casualProjection.casualCompletionCount,1);
  assert.ok(row.casualProjection.casualRp>0);
  assert.equal(row.casualProjection.officialCasualRp,0);
  assert.equal(row.casualProjection.officialCasualCompletionCount,0);
});
