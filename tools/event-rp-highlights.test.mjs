import test from 'node:test';
import assert from 'node:assert/strict';
import {buildEventRpHighlights,EVENT_HIGHLIGHT_LIMITS} from './event-rp-highlights.mjs';

const hash=n=>n.toString(16).padStart(64,'0');
const rollingId='permanent-rolling-hills',rollingTrack='fb769ac2ea77e8f19a21a9dd3071742f2342bd49c41e4748d7e8c7903d4f0778';
const entry=(n,rp=100,timeMs=1000+n)=>({accountId:hash(n),timeMs,rp,verified:true});
const finite=(id='weekly',kind='weekly',entries=[entry(1)])=>({id,period:{id,kind,trackId:hash(999),trackName:id+' track',startsAt:100,endsAt:200,maxRp:1000},updatedAt:300,complete:true,totalEntries:entries.length,entries});
const rolling=(entries=[entry(1,900)])=>({id:rollingId,kind:'permanent',trackId:rollingTrack,complete:true,totalEntries:entries.length,entries});
const totals=(...ids)=>ids.map(n=>({accountId:hash(n),rp:2000,finiteEventRp:1100}));
const highlights=(boards,totalsRows=totals(1))=>buildEventRpHighlights({boards,totalsRows}).get(hash(1));

test('top two contain bound Rolling Hills and highest finite saved ERP, with no totals mutation',()=>{
 const boards=[finite('daily','daily',[entry(1,80)]),rolling(),finite('weekly','weekly',[entry(1,100)])],totalsRows=totals(1);
 const before=structuredClone({boards,totalsRows});
 const result=buildEventRpHighlights({boards,totalsRows}).get(hash(1));
 assert.deepEqual(result,[{kind:'permanent',periodId:rollingId,trackId:rollingTrack,name:'Rolling Hills Racer',eventRp:900,rank:1,fieldSize:1},
  {kind:'weekly',periodId:'weekly',trackId:hash(999),name:'weekly track',eventRp:100,rank:1,fieldSize:1}]);
 assert.deepEqual({boards,totalsRows},before);
 assert.deepEqual(Object.keys(result[0]).sort(),['kind','periodId','trackId','name','eventRp','rank','fieldSize'].sort());
 assert.equal(Object.isFrozen(result),true);assert.equal(Object.isFrozen(result[0]),true);
});

test('Kodub wins equal finite points only, and absent Rolling Hills permits the best two finite events',()=>{
 const boards=[finite('a','weekly',[entry(1,100)]),finite('z','kodub',[entry(1,100)]),finite('daily','daily',[entry(1,101)])];
 assert.deepEqual(highlights(boards).map(row=>[row.periodId,row.eventRp]),[['daily',101],['z',100]]);
 assert.deepEqual(highlights([...boards,rolling()]).map(row=>row.periodId),[rollingId,'daily']);
 assert.deepEqual(highlights(boards.slice(0,2)).map(row=>row.periodId),['z','a']);
});

test('complete verified fields use competition ties 1,1,3 and never the all-entrant count',()=>{
 const board=finite('tie','kodub',[entry(3,80,2000),entry(2,90,1000),entry(1,90,1000),{...entry(4),pending:true}, {...entry(5),needsReview:true}]);
 board.racerCount=72;board.sourceTotalEntries=99;
 const result=buildEventRpHighlights({boards:[board],totalsRows:totals(1,2,3,4,5)});
 assert.deepEqual([1,2,3].map(id=>[result.get(hash(id))[0].rank,result.get(hash(id))[0].fieldSize]),[[1,3],[1,3],[3,3]]);
 assert.deepEqual(result.get(hash(4)),[]);assert.deepEqual(result.get(hash(5)),[]);
});

test('Rolling Hills placement uses its complete verified board and excludes unverified rows',()=>{
 const board=rolling([entry(2,900,1000),entry(1,900,1000),entry(3,800,2000),{...entry(4),physicsVerified:false}]);
 board.sourceTotalEntries=150;
 const result=buildEventRpHighlights({boards:[board],totalsRows:totals(1,2,3)});
 assert.deepEqual([1,2,3].map(id=>[result.get(hash(id))[0].rank,result.get(hash(id))[0].fieldSize]),[[1,3],[1,3],[3,3]]);
});

test('partial and contradictory coverage never expose an exact rank or denominator',()=>{
 for(const change of [{complete:false},{complete:undefined},{sourceComplete:false},{sourceComplete:'true'},{publicationPending:true},{publicationPending:0},{totalEntries:2},
  {pagination:{hasMore:true}},{pagination:{complete:false}},{pagination:{totalEntries:2}},{pagination:'bad'},{pagination:null}]){
  const result=highlights([{...finite(),...change}])[0];
  assert.equal(result.rank,null);assert.equal(result.fieldSize,null);assert.equal(result.eventRp,100);
 }
 const board=finite();board.entries.push({accountId:'bad',timeMs:500,rp:1});board.totalEntries=2;
 assert.equal(highlights([board])[0].rank,null,'a malformed competitor makes field coverage unknown');
});

test('every explicit unverified or held status is excluded even when another flag claims verified',()=>{
 const flags=[{pending:true},{playbackPending:true},{verified:false},{runVerified:false},{integrityVerified:false},{physicsVerified:false},
  {replayIntegrityVerified:false},{eventRpEligible:false},{needsReview:true},{reviewHold:true},{status:'waiting'},
  {verificationStatus:'pending'},{verificationStatus:'rejected'},{verificationStatus:'unavailable_final'}];
 for(const flag of flags)assert.deepEqual(highlights([finite('daily','daily',[{...entry(1),...flag}])]),[],JSON.stringify(flag));
 const board=finite('legacy','weekly',[{accountId:hash(1),rp:100,timeMs:1000}]);
 assert.equal(highlights([board])[0].eventRp,100,'legacy entries remain the published verified lane, not pendingPlaybacks');
 board.entries=[];board.totalEntries=0;board.pendingPlaybacks=[entry(1)];assert.deepEqual(highlights([board]),[]);
});

test('period, track, row and replay bindings fail closed',()=>{
 const board=finite();
 for(const change of [{id:'other'},{trackId:hash(88)},{kind:'daily'},{period:{...board.period,trackId:'bad'}},
  {period:{...board.period,id:''}},{period:{...board.period,kind:'unknown'}},{period:{...board.period,endsAt:100}}])
  assert.deepEqual(highlights([{...board,...change}]),[],JSON.stringify(change));
 for(const change of [{periodId:'other'},{eventId:'other'},{trackId:hash(55)},{replayHash:'bad'},{runId:'bad'},
  {frames:2},{raceTimeFrames:3},{timeMs:0},{timeMs:'1000'},{timeMs:300001},{rp:NaN},{rp:-1},{rp:undefined},{rp:1001}])
  assert.deepEqual(highlights([finite('daily','daily',[{...entry(1),...change}])]),[],JSON.stringify(change));
 assert.deepEqual(highlights(new Map([['different',board]])),[]);
});

test('permanent metadata is pinned to the actual Rolling Hills identity',()=>{
 for(const change of [{id:'other'},{kind:'weekly'},{trackId:hash(77)},{period:{id:rollingId,kind:'permanent',trackId:hash(88)}}])
  assert.deepEqual(highlights([{...rolling(),...change}]),[]);
 assert.deepEqual(highlights([finite('other','permanent')]),[]);
});
test('coerced identities and malformed verification flags cannot be treated as verified bindings',()=>{
 for(const change of [{accountId:[hash(1)]},{userId:hash(9)},{verified:1},{verified:'true'},{physicsVerified:null},{pending:'false'},{needsReview:0}])
  assert.deepEqual(highlights([finite('weekly','weekly',[{...entry(1),...change}])]),[]);
 const board=finite();
 for(const period of [null,'metadata',{...board.period,id:['weekly']},{...board.period,trackId:[hash(999)]}])
  assert.deepEqual(highlights([{...board,period}]),[]);
 assert.equal(buildEventRpHighlights({totalsRows:[{accountId:[hash(1)]}],boards:[board]}).size,0);
});

test('duplicate snapshots or duplicate racers never stitch two incompatible fields together',()=>{
 assert.deepEqual(highlights([finite(),finite()]),[]);
 assert.deepEqual(highlights([finite('weekly','weekly',[entry(1),entry(1,50,2000)])]),[]);
 const result=buildEventRpHighlights({boards:[finite()],totalsRows:[...totals(1),...totals(1)]});
 assert.equal(result.has(hash(1)),false);
});

test('totals-only fields cannot manufacture a highlight, points or placement',()=>{
 const rows=[{accountId:hash(1),rp:2000,permanentRollingHillsRp:900,rollingHillsTimeMs:1001,
  eventHighlights:[{rank:1,fieldSize:999999,eventRp:999999}]}];
 assert.deepEqual(highlights([],rows),[]);
 for(const change of [{permanentRollingHillsRp:800},{rollingHillsEventRpContribution:800},{rollingHillsTimeMs:2000}])
  assert.deepEqual(highlights([rolling()],[{...rows[0],...change}]),[]);
 assert.deepEqual(highlights([finite()],[{accountId:hash(1),rp:50}]),[],'a component cannot exceed the captured total');
});

test('finite ERP and Rolling Hills must fit the captured aggregate together, regardless of board order',()=>{
 const rows=[{accountId:hash(1),rp:1000,permanentRollingHillsRp:900}];
 const boards=[rolling(),finite('stale','kodub',[entry(1,200)]),finite('safe','daily',[entry(1,100)])];
 for(const input of [boards,[...boards].reverse()]){
  const result=highlights(input,rows);
  assert.deepEqual(result.map(row=>[row.periodId,row.eventRp]),[[rollingId,900],['safe',100]]);
  assert.equal(result.reduce((sum,row)=>sum+row.eventRp,0),1000);
 }
});

test('missing Rolling Hills board still reserves its known totals contribution',()=>{
 const boards=[finite('stale','kodub',[entry(1,200)]),finite('safe','daily',[entry(1,80)])];
 for(const field of ['permanentRollingHillsRp','rollingHillsEventRpContribution']){
  const result=highlights(boards,[{accountId:hash(1),rp:1000,[field]:900}]);
  assert.deepEqual(result.map(row=>row.periodId),['safe']);
  assert.ok(900+result.reduce((sum,row)=>sum+row.eventRp,0)<=1000);
 }
 assert.deepEqual(highlights(boards,[{accountId:hash(1),rp:1000}]),[],'unknown RH is not zero RH');
});

test('explicit finite budget is retained and bounds both finite selections cumulatively',()=>{
 const boards=[finite('first','daily',[entry(1,70)]),finite('second','weekly',[entry(1,60)]),finite('fits','kodub',[entry(1,30)])];
 for(const components of [{finiteEventRp:100},{permanentRollingHillsRp:900},{finiteEventRp:100,permanentRollingHillsRp:900}]){
  const result=highlights(boards,[{accountId:hash(1),rp:1000,...components}]);
  assert.deepEqual(result.map(row=>[row.periodId,row.eventRp]),[['first',70],['fits',30]]);
  assert.equal(result.reduce((sum,row)=>sum+row.eventRp,0),100);
 }
 assert.deepEqual(highlights(boards,[{accountId:hash(1),rp:100,permanentRollingHillsRp:0}]).map(row=>row.periodId),['first','fits']);
});

test('inconsistent, invalid or overflowing component budgets cannot produce highlights',()=>{
 const boards=[rolling(),finite()];
 for(const components of [{finiteEventRp:200,permanentRollingHillsRp:900},{finiteEventRp:1001},
  {permanentRollingHillsRp:1001},{permanentRollingHillsRp:900,rollingHillsEventRpContribution:800},
  {finiteEventRp:-1},{finiteEventRp:null},{finiteEventRp:'100'},{permanentRollingHillsRp:NaN}])
  assert.deepEqual(highlights(boards,[{accountId:hash(1),rp:1000,...components}]),[],JSON.stringify(components));
 const total={accountId:hash(1),rp:Number.MAX_SAFE_INTEGER,finiteEventRp:Number.MAX_SAFE_INTEGER,permanentRollingHillsRp:1};
 assert.deepEqual(highlights(boards,[total]),[]);
 assert.deepEqual(highlights(boards,[{accountId:hash(1)}]),undefined,'missing aggregate cannot prove any component budget');
});

test('selected metadata always stays within aggregate and finite budgets across captured component combinations',()=>{
 const boards=[rolling(),...[0,30,80,100,200,700,1000].map((rp,index)=>finite('finite-'+index,'daily',[entry(1,rp)]))];
 for(const rp of [0,100,500,1000,2000])for(const knownRolling of [0,100,900])for(const finiteEventRp of [undefined,0,100,1000]){
  const total={accountId:hash(1),rp,permanentRollingHillsRp:knownRolling,...(finiteEventRp!==undefined?{finiteEventRp}:{})};
  for(const captured of [boards,boards.slice(1)]){
   const result=highlights(captured,[total]),finiteSum=result.filter(row=>row.kind!=='permanent').reduce((sum,row)=>sum+row.eventRp,0);
   assert.ok(result.length<=2);assert.ok(result.reduce((sum,row)=>sum+row.eventRp,0)<=rp);
   if(knownRolling<=rp)assert.ok(finiteSum<=rp-knownRolling);
   if(finiteEventRp!==undefined)assert.ok(finiteSum<=finiteEventRp);
   if(knownRolling>rp||finiteEventRp!==undefined&&finiteEventRp>rp-knownRolling)assert.deepEqual(result,[]);
  }
 }
});

test('only requested valid accounts appear and private row fields cannot escape the allowlist',()=>{
 const board=finite('daily','daily',[{...entry(1),ownerUid:'secret',replay:'private',proof:{private:true}},entry(2)]);
 const result=buildEventRpHighlights({boards:[board],totalsRows:[...totals(1),{accountId:'bad'},{accountId:hash(3),userId:hash(4)}]});
 assert.deepEqual([...result.keys()],[hash(1)]);
 assert.equal(JSON.stringify([...result]).includes('private'),false);assert.equal(JSON.stringify([...result]).includes('secret'),false);
});

test('bounded plain-text event names fall back without returning player identity',()=>{
 const board=finite();board.period.trackName='<b>Track</b>\u0000'+'x'.repeat(200);
 const result=highlights([board])[0];assert.equal(result.name.length,120);assert.doesNotMatch(result.name,/[<>\u0000]/);
 delete board.period.trackName;board.period.label='  Saved event  ';assert.equal(highlights([board])[0].name,'Saved event');
 delete board.period.label;assert.equal(highlights([board])[0].name,'Weekly event');
});

test('input order does not change selection and a Map of captured boards is accepted',()=>{
 const boards=[rolling(),finite('z','weekly',[entry(1,120)]),finite('a','weekly',[entry(1,120)])];
 const expected=highlights(boards);
 assert.deepEqual(highlights([...boards].reverse()),expected);
 assert.deepEqual(highlights(new Map(boards.map(board=>[board.id,board]))),expected);
});

test('zero saved ERP remains zero and missing ERP is not recalculated from target time',()=>{
 const board=finite('zero','daily',[entry(1,0)]);board.period.targetMs=1000;
 assert.equal(highlights([board])[0].eventRp,0);
 delete board.entries[0].rp;assert.deepEqual(highlights([board]),[]);
});

test('pure projection performs no fetch or other asynchronous work',t=>{
 let requests=0;const previous=globalThis.fetch;globalThis.fetch=()=>{requests++;throw Error('Forbidden network');};t.after(()=>{globalThis.fetch=previous;});
 const result=buildEventRpHighlights({boards:[finite()],totalsRows:totals(1)});
 assert.equal(result instanceof Map,true);assert.equal(requests,0);
});

test('public input limits are enforced rather than silently truncating the best result',()=>{
 assert.throws(()=>buildEventRpHighlights({totalsRows:null}),TypeError);
 assert.throws(()=>buildEventRpHighlights({boards:{}}),TypeError);
 assert.throws(()=>buildEventRpHighlights({totalsRows:Array(EVENT_HIGHLIGHT_LIMITS.accounts+1)}),RangeError);
 assert.throws(()=>highlights(Array(EVENT_HIGHLIGHT_LIMITS.boards+1)),RangeError);
 const tooMany=finite();tooMany.entries=Array(EVENT_HIGHLIGHT_LIMITS.rowsPerBoard+1);
 assert.throws(()=>highlights([tooMany]),RangeError);
 assert.throws(()=>highlights(Array.from({length:101},(_,i)=>({...finite('event-'+i),entries:Array(10000)}))),RangeError);
});
