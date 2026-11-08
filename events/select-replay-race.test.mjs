import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {harness,racer,waiting,deferred,until,clientSource as source} from './event-replay-test-fixture.mjs';
const period={id:'period',trackId:'b'.repeat(64)};
const raceGhostsSource=source.slice(source.indexOf('  function raceGhosts('),source.indexOf('  function resumeRace('));

test('single, repeated, range, top and you selections perform zero fetches and zero decodes',async()=>{
 const rows=Array.from({length:15},(_,i)=>racer(i===13?'viewer':'racer-'+i,1200+i));const h=harness({rows});
 await h.select(rows[0]);assert.equal(h.selected().length,1);assert.equal(h.selected()[0].ghost,null);
 await h.select(rows[0]);assert.equal(h.selected().length,0);
 await h.selectEventRange(3,6);assert.deepEqual(Array.from(h.selected(),r=>r.targetAccountId),rows.slice(2,6).map(r=>r.accountId));
 await h.selectTopEventRows(3);assert.equal(h.selected().length,3);
 await h.selectTopEventRows(3);assert.equal(h.selected().length,0);
 await h.selectEventYouGroup();assert.equal(h.selected().length,10);assert(h.selected().some(r=>r.targetAccountId==='viewer'));
 assert.equal(h.reads.length,0);assert.equal(h.prepares(),0);assert.equal(h.pending(),0);
});

for(const mode of ['play','watch'])test(mode+' alone fetches exact selected bindings and reuses ready ghosts on later actions',async()=>{
 const h=harness();await h.select(h.rows[0]);await h.select(h.rows[1]);assert.equal(h.reads.length,0);
 await h.action(mode);assert.equal(h.reads.length,2);assert.equal(h.prepares(),2);
 assert.equal(mode==='play'?h.launches.length:h.watches.length,1);
 await h.action(mode);assert.equal(h.reads.length,2);assert.equal(h.prepares(),2);
 await h.select(h.rows[0]);await h.select(h.rows[0]);assert(h.selected().find(r=>r.targetAccountId===h.rows[0].accountId).ghost);
 assert.equal(h.reads.length,2);await h.action(mode);assert.equal(h.prepares(),2);
});

test('selection tracks replay hash changes and remains bounded to ten ghosts',async()=>{
 const h=harness({rows:Array.from({length:12},(_,i)=>racer('racer'+i,1000+i))});
 for(const row of h.rows)await h.select(row);
 assert.equal(h.selected().length,10);assert.equal(h.selected()[0].targetAccountId,'racer2');
 const changed={...h.rows[2],replayHash:'replacement'};await h.select(changed);
 assert.equal(h.selected().find(r=>r.targetAccountId==='racer2').targetReplayHash,'replacement');
 assert.equal(h.reads.length,0);assert.equal(h.prepares(),0);
});

test('pending selection defers exact run lookup and keeps verified and waiting payloads isolated',async()=>{
 const row=waiting('racer',1400),h=harness({rows:[row]});await h.select(row);assert.equal(h.reads.length,0);
 await h.action('watch');assert.equal(h.reads.length,1);assert.equal(h.reads[0].args[2],row.runId);
 assert.equal(h.reads[0].args[3].replayHash,row.replayHash);assert.equal(h.reads[0].args[3].trackId,h.period.trackId);
 Object.assign(row,{pending:false,verified:true,runVerified:true,eventRpEligible:true,verificationStatus:'verified'});
 await h.select(row);await h.action('watch');assert.equal(h.reads.length,2);assert.equal(h.reads[1].args[2],null);
});

test('archive selection is lazy and never falls back to live replay transport or its cache',async()=>{
 const h=harness();await h.select(h.rows[0]);await h.action('watch');h.clearEventGhostSelection(h.period.id,'viewer');
 h.archive();h.bridge.readReplay=()=>assert.fail('Archive cannot use live transport');await h.select(h.rows[0]);
 assert.equal(h.reads.length,1);await h.action('watch');assert.equal(h.reads.length,2);assert.equal(h.reads[1].archive,true);
});

for(const mode of ['play','watch'])test(mode+' duplicate clicks join or reject active preparation without extra I/O',async()=>{
 const gate=deferred(),h=harness({read:async row=>{await gate.promise;return {...row};}});await h.select(h.rows[0]);
 const first=h.action(mode);await until(()=>h.reads.length===1);const second=h.action(mode);gate.resolve();await Promise.all([first,second]);
 assert.equal(h.reads.length,1);assert.equal(h.prepares(),1);assert.equal(mode==='play'?h.launches.length:h.watches.length,1);
});

for(const mode of ['play','watch'])for(const change of ['account','session','page','filter','navigation','track','standings','hold','verdict','selection'])
 test(mode+' discards fetched bytes after '+change+' changes',async()=>{
  const gate=deferred(),h=harness({read:async row=>{const saved={...row};await gate.promise;return saved;}});await h.select(h.rows[0]);
  const work=h.action(mode);await until(()=>h.reads.length===1);h.change(change);gate.resolve();await work;
  assert.equal(h.launches.length,0);assert.equal(h.watches.length,0);assert.equal(h.prepares(),0);
 });

for(const mode of ['play','watch'])test(mode+' cancellation during decode prevents cached readiness or native handoff',async()=>{
 const gate=deferred(),h=harness({prepare:()=>gate.promise});await h.select(h.rows[0]);const work=h.action(mode);
 await until(()=>h.prepares()===1);h.change('selection');gate.resolve();await work;
 assert.equal(h.selected().length,0);assert.equal(h.launches.length,0);assert.equal(h.watches.length,0);
 await h.select(h.rows[0]);assert.equal(h.selected()[0].ghost,null);
});

for(const mode of ['play','watch'])test(mode+' reauthorizes cached indexed ghosts only on explicit actions',async()=>{
 const h=harness({indexed:true});await h.select(h.rows[0]);assert.equal(h.handshakes(),0);
 await h.action(mode);await h.action(mode);assert.equal(h.prepares(),1);assert.equal(h.reads.length,1);assert.equal(h.handshakes(),2);
});

test('held and explicitly revoked cached rows do not launch or refetch',async()=>{
 for(const change of ['hold','verdict']){const h=harness();await h.select(h.rows[0]);await h.action('watch');h.change(change);
 await h.action('play');assert.equal(h.launches.length,0);assert.equal(h.reads.length,1);assert.equal(h.prepares(),1);}
});

test('resume refuses an unloaded selection instead of silently racing without selected ghosts',async()=>{
 const h=harness();await h.select(h.rows[0]);let resumed=0;
 assert.equal(h.resumeRace(h.period.trackId,()=>resumed++),true);assert.equal(resumed,0);assert.equal(h.reads.length,0);
 assert.match(h.messages.at(-1),/Use Event Play/);
});

test('local event ghost parses once until its replay or saved best changes',()=>{
 const replay={attemptId:'attempt-1',timeMs:1200,frames:1200,replay:'encoded-replay',carStyle:'encoded-style'};
 const best={attemptId:'attempt-1',timeMs:1200};
 const ghost={recording:{},carStyle:{},time:{numberOfFrames:1200},isSelf:true};
 let prepares=0;
 const context=vm.createContext({
  bridge:{supportsEventGhost:()=>true,require:()=>({})},
  knownPeriods:new Map([['period',period]]),
  eventDisplayRows:()=>({rows:[]}),
  getOwnReplay:()=>replay,
  bestRecords:{'period_viewer':best},
  prepareOwnEventGhost:()=>{prepares++;return ghost;}
 });
 const race=vm.runInContext(`(()=>{const selectedGhosts=new Map(),pendingGhosts=new Map(),preparedOwnGhosts=new Map();${raceGhostsSource};return raceGhosts;})()`,context);
 const session={periodId:'period',trackId:period.trackId,accountId:'viewer'};
 assert.equal(race(session).ownGhost,ghost);
 assert.equal(race(session).ownGhost,ghost);
 assert.equal(prepares,1,'repeated play/watch/resume preparation reuses the validated native replay');
 replay.replay='replacement-replay';
 assert.equal(race(session).ownGhost,ghost);
 assert.equal(prepares,2,'changed replay bytes are parsed and validated again');
 context.bestRecords.period_viewer={attemptId:'attempt-2',timeMs:1100};
 replay.attemptId='attempt-2';replay.timeMs=1100;replay.frames=1100;
 assert.equal(race(session).ownGhost,ghost);
 assert.equal(prepares,3,'changed PB identity is parsed and validated again');
});

test('refresh drops a selected ghost when time, run ID or waiting status changes',()=>{
 for(const change of [{timeMs:1300},{runId:'new'},{pending:false},{replayHash:'new-hash'}]){
  const row={accountId:'racer',timeMs:1200,runId:'old',pending:true};
  const selection={periodId:'period',accountId:'viewer',targetAccountId:'racer',targetTimeMs:1200,targetRunId:'old',targetPending:true,targetReplayHash:null,ghost:{isSelf:false}};
  const selectedGhosts=new Map([['racer',selection]]),ctx=vm.createContext({knownPeriods:new Map([['period',period]]),eventDisplayRows:()=>({rows:[{...row,...change}]}),selectedGhosts,bridge:{supportsEventGhost:()=>false}});
  vm.runInContext(raceGhostsSource,ctx);const result=ctx.raceGhosts({periodId:'period',accountId:'viewer'});
  assert.equal(selectedGhosts.size,0);assert.equal(result.opponents.length,0);
 }
});
