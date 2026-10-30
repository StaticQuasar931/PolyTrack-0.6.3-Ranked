import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {capturePublicEventTotals,publicEventTotals} from './public-event-totals-backup.mjs';

test('event totals allowlist removes personal and unrelated fields',()=>{
  const projected=publicEventTotals({updatedAt:1,ownerUid:'secret',entries:[{accountId:'a'.repeat(64),name:'Racer',rp:50,rank:1,events:2,ownerUid:'secret'}]});
  assert.equal(projected.ownerUid,undefined);assert.equal(projected.entries[0].ownerUid,undefined);
  assert.throws(()=>publicEventTotals({updatedAt:1,entries:[{accountId:'bad'}]}));
});

test('event totals never fall back to backend-only Firestore after a Worker denial',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'polytrack-event-totals-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const value={updatedAt:1,entries:[{accountId:'a'.repeat(64),name:'Racer',rp:50,rank:1,events:2}]};
  await capturePublicEventTotals({directory,fetchImpl:async()=>Response.json(value)});
  const before=await fs.readFile(path.join(directory,'event-totals.json'),'utf8');
  for(const status of [403,404]){
    let calls=0;await assert.rejects(capturePublicEventTotals({directory,fetchImpl:async url=>{
      calls++;assert.equal(new URL(url).hostname,'polytrack-ranked-worker.staticquasar931.workers.dev');return new Response('',{status});
    }}));assert.equal(calls,1);assert.equal(await fs.readFile(path.join(directory,'event-totals.json'),'utf8'),before);
  }
  const result=await capturePublicEventTotals({directory,fetchImpl:async()=>new Response('',{status:429})});
  assert.equal(result.deferred,true);assert.equal(await fs.readFile(path.join(directory,'event-totals.json'),'utf8'),before);
});

test('event totals retain sanitized public appearance without leaking private profile fields',()=>{
 const row=publicEventTotals({updatedAt:1,entries:[{accountId:'a'.repeat(64),name:'Racer',rank:7,rp:50,events:2,carStyle:'public-style',profileCosmetics:{theme:'cyan',ownerUid:'private'},badges:{betaTester:true,secret:true},ownerUid:'private',replay:'private'}]}).entries[0];
 assert.equal(row.carStyle,'public-style');assert.deepEqual(row.profileCosmetics,{theme:'cyan'});
 assert.deepEqual(row.badges,{betaTester:true});assert.equal(row.ownerUid,undefined);assert.equal(row.replay,undefined);
 assert.deepEqual([row.rank,row.rp,row.events],[7,50,2]);
});

const totalsValue=()=>({updatedAt:7,complete:true,totalEntries:1,entries:[{accountId:'a'.repeat(64),name:'Racer',rp:50,rank:1,events:2}]});
async function totalsFixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'polytrack-totals-outcome-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const target=path.join(directory,'event-totals.json'),before=JSON.stringify(totalsValue())+'\n';
  await fs.writeFile(target,before);
  return {directory,target,unchanged:async()=>assert.equal(await fs.readFile(target,'utf8'),before)};
}

test('successful totals capture has an explicit complete outcome and replaces validated data',async t=>{
  const f=await totalsFixture(t),value={...totalsValue(),updatedAt:8};let requests=0;
  const result=await capturePublicEventTotals({directory:f.directory,now:()=>2000,fetchImpl:async()=>{requests++;return Response.json(value);}});
  assert.deepEqual(result,{deferred:false,entries:1,updatedAt:8,pageRequests:0});
  assert.equal(requests,1);assert.deepEqual(JSON.parse(await fs.readFile(f.target,'utf8')),{...value,capturedAt:new Date(2000).toISOString()});
});

test('expected totals HTTP failures defer once without replacing prior data',async t=>{
  const f=await totalsFixture(t);
  for(const status of [408,429,500,502,503,504]){
    let requests=0;const result=await capturePublicEventTotals({directory:f.directory,fetchImpl:async()=>{requests++;return new Response('',{status});}});
    assert.equal(result.deferred,true);assert.equal(result.status,status);assert.equal(result.previousPreserved,true);
    assert.equal(requests,1);await f.unchanged();
  }
});

test('known fetch and stream interruptions defer totals without swallowing implementation errors',async t=>{
  const f=await totalsFixture(t);
  for(const fetchImpl of [
    async()=>{throw new TypeError('fetch failed');},
    async()=>{throw new DOMException('timeout','TimeoutError');},
    async()=>({ok:true,status:200,text:async()=>{throw new TypeError('terminated');}}),
    async()=>({ok:true,status:200,text:async()=>{throw new DOMException('abort','AbortError');}}),
  ]){
    const result=await capturePublicEventTotals({directory:f.directory,fetchImpl});
    assert.equal(result.deferred,true);assert.equal(result.status,null);await f.unchanged();
  }
});

test('malformed totals, incomplete coverage, permissions and unexpected failures remain fatal',async t=>{
  const f=await totalsFixture(t);
  for(const fetchImpl of [
    async()=>new Response('',{status:401}),
    async()=>new Response('',{status:403}),
    async()=>new Response('',{status:404}),
    async()=>new Response('not JSON'),
    async()=>Response.json(null),
    async()=>Response.json({...totalsValue(),updatedAt:-1}),
    async()=>Response.json({...totalsValue(),entries:[{accountId:'bad'}]}),
    async()=>Response.json({...totalsValue(),entries:[...totalsValue().entries,...totalsValue().entries]}),
    async()=>Response.json({...totalsValue(),entries:[{...totalsValue().entries[0],rp:-1}]}),
    async()=>Response.json({...totalsValue(),complete:false}),
    async()=>Response.json({...totalsValue(),complete:'true'}),
    async()=>Response.json({...totalsValue(),totalEntries:2}),
    async()=>new Response('x'.repeat(2*1024*1024+1)),
    async()=>{throw Error('unexpected implementation failure');},
    async()=>{throw new TypeError('invalid option');},
    async()=>({ok:true,status:200,text:async()=>{throw Error('unexpected reader failure');}}),
  ]){
    await assert.rejects(capturePublicEventTotals({directory:f.directory,fetchImpl}));await f.unchanged();
  }
});

function pagedTotals(){
  const generation='b'.repeat(64),totalEntries=101,pageCount=2;
  const pages=Array.from({length:2},(_,page)=>({generation,page,pageSize:100,pageCount,totalEntries,complete:true,sourceRevision:7,
    entries:Array.from({length:page?1:100},(_,index)=>({accountId:(page*100+index+1).toString(16).padStart(64,'0'),rank:page*100+index+1,rp:1}))}));
  const value={updatedAt:7,entries:[],sourceRevision:7,totalEntries,pagination:{version:1,generation,pageSize:100,pageCount,totalEntries,complete:true}};
  return {value,pages};
}

test('totals pagination publishes only a validated complete generation',async t=>{
  const f=await totalsFixture(t),{value,pages}=pagedTotals();let requests=0;
  const result=await capturePublicEventTotals({directory:f.directory,fetchImpl:async url=>{
    requests++;const page=new URL(url).searchParams.get('page');return Response.json(page===null?value:pages[Number(page)]);
  }});
  assert.deepEqual(result,{deferred:false,entries:101,updatedAt:7,pageRequests:2});assert.equal(requests,3);
  const saved=JSON.parse(await fs.readFile(f.target,'utf8'));assert.equal(saved.complete,true);assert.equal(saved.entries.length,101);
});

test('mid-pagination transient, malformed and mixed-generation totals never replace previous data',async t=>{
  const f=await totalsFixture(t);
  for(const mode of ['429','network','json','generation','revision','missing','unexpected']){
    const {value,pages}=pagedTotals();let requests=0;
    const capture=capturePublicEventTotals({directory:f.directory,fetchImpl:async url=>{
      requests++;const page=new URL(url).searchParams.get('page');
      if(page===null)return Response.json(value);if(page==='0')return Response.json(pages[0]);
      if(mode==='429')return new Response('',{status:429});
      if(mode==='network')throw new TypeError('fetch failed');
      if(mode==='unexpected')throw new TypeError('invalid option');
      if(mode==='json')return new Response('not JSON');
      return Response.json({...pages[1],...(mode==='generation'?{generation:'c'.repeat(64)}:mode==='revision'?{sourceRevision:8}:{entries:[]})});
    }});
    if(['429','network'].includes(mode))assert.equal((await capture).deferred,true);
    else await assert.rejects(capture);
    assert.equal(requests,3);await f.unchanged();
  }
});

test('totals write failures are fatal and first-capture deferral creates no totals file',async t=>{
  const f=await totalsFixture(t),blocked=path.join(f.directory,'blocked');await fs.writeFile(blocked,'not a directory');
  await assert.rejects(capturePublicEventTotals({directory:blocked,fetchImpl:async()=>Response.json(totalsValue())}));
  const missing=path.join(f.directory,'missing');
  assert.equal((await capturePublicEventTotals({directory:missing,fetchImpl:async()=>new Response('',{status:503})})).deferred,true);
  await assert.rejects(fs.stat(missing),{code:'ENOENT'});await f.unchanged();
});

test('unchanged totals confirm again without changing standings or adding requests',async t=>{
 const f=await totalsFixture(t);let requests=0;
 for(const at of [2000,3000]){await capturePublicEventTotals({directory:f.directory,now:()=>at,fetchImpl:async()=>{requests++;return Response.json(totalsValue());}});
 const saved=JSON.parse(await fs.readFile(f.target,'utf8'));assert.equal(saved.updatedAt,7);assert.equal(saved.capturedAt,new Date(at).toISOString());}
 assert.equal(requests,2);
 await assert.rejects(capturePublicEventTotals({directory:f.directory,now:()=>1,fetchImpl:async()=>Response.json(totalsValue())}),/confirmation time/);
 assert.equal(JSON.parse(await fs.readFile(f.target,'utf8')).capturedAt,new Date(3000).toISOString());
});

const highlightTrack='fb769ac2ea77e8f19a21a9dd3071742f2342bd49c41e4748d7e8c7903d4f0778';
function highlightBoards(){
 const entries=[{accountId:'a'.repeat(64),rp:20,timeMs:1000,verified:true}];
 return [{id:'permanent-rolling-hills',kind:'permanent',trackId:highlightTrack,entries,complete:true,totalEntries:1},
  {id:'weekly-fixture',period:{id:'weekly-fixture',kind:'weekly',trackId:'c'.repeat(64),trackName:'Saved weekly',startsAt:1,endsAt:2},entries,complete:true,totalEntries:1}];
}

test('totals projection appends only derived bounded highlights and never modifies awarded ERP',()=>{
 const input={...totalsValue(),entries:[{...totalsValue().entries[0],eventHighlights:[{name:'Injected',eventRp:99999,ownerUid:'private'}]}]};
 const before=structuredClone(input),projected=publicEventTotals(input,{capturedBoards:highlightBoards()});
 assert.equal(projected.entries[0].rp,50);assert.equal(projected.entries[0].eventHighlights.length,2);
 assert.deepEqual(projected.entries[0].eventHighlights.map(row=>[row.kind,row.eventRp,row.rank,row.fieldSize]),[['permanent',20,1,1],['weekly',20,1,1]]);
 assert.equal(JSON.stringify(projected).includes('Injected'),false);assert.equal(JSON.stringify(projected).includes('private'),false);
 assert.equal(publicEventTotals(input).entries[0].eventHighlights,undefined);assert.deepEqual(input,before);
});

test('totals capture derives highlights from existing manifest boards without another request',async t=>{
 const f=await totalsFixture(t),boards=highlightBoards();let requests=0;
 await fs.mkdir(path.join(f.directory,'events'));
 await fs.writeFile(path.join(f.directory,'manifest.json'),JSON.stringify({events:Object.fromEntries(boards.map(board=>[board.id,{path:`events/${board.id}.json` }]))}));
 for(const board of boards)await fs.writeFile(path.join(f.directory,'events',board.id+'.json'),JSON.stringify(board));
 await capturePublicEventTotals({directory:f.directory,now:()=>2000,fetchImpl:async()=>{requests++;return Response.json(totalsValue());}});
 const saved=JSON.parse(await fs.readFile(f.target,'utf8'));
 assert.equal(requests,1);assert.equal(saved.entries[0].rp,50);assert.equal(saved.entries[0].eventHighlights.length,2);
 assert.equal(saved.entries[0].eventHighlights[0].name,'Rolling Hills Racer');
 assert.deepEqual([saved.entries[0].eventHighlights[0].rank,saved.entries[0].eventHighlights[0].fieldSize],[1,1]);
});

test('caller-supplied captured boards need no manifest and preserve unknown partial placement',async t=>{
 const f=await totalsFixture(t),capturedBoards=highlightBoards();let requests=0;
 capturedBoards[0].complete=false;
 await fs.writeFile(path.join(f.directory,'manifest.json'),'invalid and never needed');
 await capturePublicEventTotals({directory:f.directory,capturedBoards,now:()=>2000,fetchImpl:async()=>{requests++;return Response.json(totalsValue());}});
 const saved=JSON.parse(await fs.readFile(f.target,'utf8'));
 assert.equal(requests,1);assert.equal(saved.entries[0].eventHighlights.length,2);
 assert.deepEqual([saved.entries[0].eventHighlights[0].rank,saved.entries[0].eventHighlights[0].fieldSize],[null,null]);
});

test('missing, corrupt, unsafe and misbound local captures never trigger network recovery',async t=>{
 const f=await totalsFixture(t);let requests=0;
 await fs.mkdir(path.join(f.directory,'events'));
 const invalid={...highlightBoards()[1],id:'another-period'};
 await fs.writeFile(path.join(f.directory,'events','misbound.json'),JSON.stringify(invalid));
 await fs.writeFile(path.join(f.directory,'events','corrupt.json'),'not JSON');
 const events={missing:{path:'events/missing.json'},corrupt:{path:'events/corrupt.json'},misbound:{path:'events/misbound.json'},
  'unsafe':{path:'../credentials.json'},'../escape':{path:'events/../escape.json'}};
 await fs.writeFile(path.join(f.directory,'manifest.json'),JSON.stringify({events}));
 await capturePublicEventTotals({directory:f.directory,now:()=>2000,fetchImpl:async()=>{requests++;return Response.json(totalsValue());}});
 assert.equal(requests,1);assert.equal(JSON.parse(await fs.readFile(f.target,'utf8')).entries[0].eventHighlights,undefined);
});

test('capture preserves finite ERP evidence and rejects components that collectively exceed the total',async t=>{
 const f=await totalsFixture(t),capturedBoards=highlightBoards();let requests=0;
 capturedBoards[0].entries=[{accountId:'a'.repeat(64),rp:900,timeMs:1000,verified:true}];
 capturedBoards[1].entries=[{accountId:'a'.repeat(64),rp:200,timeMs:1000,verified:true}];
 const source={...totalsValue(),entries:[{accountId:'a'.repeat(64),rp:1000,finiteEventRp:100,permanentRollingHillsRp:900}]};
 await capturePublicEventTotals({directory:f.directory,capturedBoards,now:()=>2000,fetchImpl:async()=>{requests++;return Response.json(source);}});
 const row=JSON.parse(await fs.readFile(f.target,'utf8')).entries[0];
 assert.equal(requests,1);assert.equal(row.rp,1000);assert.equal(row.finiteEventRp,100);
 assert.deepEqual(row.eventHighlights.map(highlight=>[highlight.kind,highlight.eventRp]),[['permanent',900]]);
 assert.ok(row.eventHighlights.reduce((sum,highlight)=>sum+highlight.eventRp,0)<=row.rp);
});

test('projection reserves unloaded RH contribution and does not treat unknown RH as zero',()=>{
 const finite=highlightBoards()[1];finite.entries=[{accountId:'a'.repeat(64),rp:200,timeMs:1000,verified:true}];
 const source={...totalsValue(),entries:[{accountId:'a'.repeat(64),rp:1000,rollingHillsEventRpContribution:900}]};
 assert.equal(publicEventTotals(source,{capturedBoards:[finite]}).entries[0].eventHighlights,undefined);
 finite.entries[0].rp=80;
 const row=publicEventTotals(source,{capturedBoards:[finite]}).entries[0];
 assert.equal(row.eventHighlights[0].eventRp,80);assert.ok(900+row.eventHighlights[0].eventRp<=row.rp);
 delete source.entries[0].rollingHillsEventRpContribution;
 assert.equal(publicEventTotals(source,{capturedBoards:[finite]}).entries[0].eventHighlights,undefined);
});
