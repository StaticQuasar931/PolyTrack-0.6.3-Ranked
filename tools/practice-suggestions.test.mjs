import test from 'node:test';
import assert from 'node:assert/strict';
import {localPracticeSuggestions as suggest} from './practice-suggestions.mjs';
import {practiceAdvice} from './practice-history.mjs';
const at=Date.UTC(2026,10,7),day=86400000;
const base={trackId:'a',attempts:8,activeMs:120000,lastPlayedAt:at,finishes:4,bestMs:10000};
const recentFinishes=Array.from({length:4},(_,i)=>({at:at-10000+i*1000,timeMs:10100+i}));
test('three distinct actionable prompts are stable under row, run and route reordering',()=>{
  const rows=[{...base,trackId:'stale',lastPlayedAt:at-10*day},
    {...base,trackId:'consistent',recentFinishes},
    {...base,trackId:'unfinished',bestMs:0,finishes:0}];
  const routes=[{trackId:'unfinished',value:2,simulationComplete:true,targetRank:6}];
  const result=suggest(rows,{at,routes});
  assert.deepEqual(result.map(row=>row.kind),['unfinished','stale','consistent']);
  assert.match(result[0].text,/#6/);
  assert.match(result[1].text,/baseline run/);
  assert.match(result[2].text,/one section/);
  assert.deepEqual(suggest([...rows].reverse().map(row=>({...row,recentFinishes:row.recentFinishes?.slice().reverse()})),{at,routes:[...routes].reverse()}),result);
  assert.doesNotMatch(JSON.stringify(result),/easy|guaranteed|success probability|other tracks improved/i);
});
test('stale means no recent play or PB, not a recently fetched cache',()=>{
  const row={...base,lastPlayedAt:at-10*day};
  assert.equal(suggest([row],{at})[0].kind,'stale');
  assert.equal(suggest([row],{at,results:[{trackId:'a',timeMs:9000,pbAt:at-day}]}).length,0);
  assert.equal(suggest([{...row,lastPbAt:at-day}],{at}).length,0);
  assert.equal(suggest([row],{at,results:[{trackId:'a',timeMs:9000,cachedAt:at}]}).length,1);
  assert.equal(suggest([{...row,lastPlayedAt:at+day}],{at}).length,0);
});
test('unfinished value must be supplied by complete positive planner simulation; known PB is not unfinished',()=>{
  const row={...base,finishes:0,bestMs:0},route={trackId:'a',value:2,simulationComplete:true,targetRank:6};
  for(const routes of [[],[{...route,simulationComplete:false}],[{...route,value:0}],[{...route,targetRank:0}]])
    assert.deepEqual(suggest([row],{at,routes}),[]);
  assert.equal(suggest([row],{at,routes:[route]}).length,1);
  assert.deepEqual(suggest([row],{at,routes:[route],results:[{trackId:'a',timeMs:9000}]}),[]);
});
test('consistent requires real recent reliable runs above an actual PB, not an easy-win claim',()=>{
  assert.equal(practiceAdvice({...base,recentFinishes},at).kind,'consistent');
  for(const runs of [recentFinishes.slice(0,3),recentFinishes.map(run=>({...run,timingNote:true})),
    recentFinishes.map(run=>({...run,at:at+1})),recentFinishes.map(run=>({...run,at:0})),
    recentFinishes.map(run=>({...run,at:at-31*day})),recentFinishes.map(run=>({...run,timeMs:10000})),
    recentFinishes.map(run=>({...run,at:at-1000})),[{...recentFinishes[0],timeMs:12000},...recentFinishes.slice(1)]])
    assert.deepEqual(suggest([{...base,recentFinishes:runs}],{at}),[]);
});
test('empty/sparse/legacy-only history and zero limit invent nothing',()=>{
  for(const rows of [[],null,[null],[{}],[{...base,attempts:2}],[{...base,activeMs:0}]])
    assert.deepEqual(suggest(rows,{at}),[]);
  assert.deepEqual(suggest([{...base,lastPlayedAt:at-10*day}],{at,limit:0}),[]);
  assert.deepEqual(practiceAdvice(null,at),{factor:1,text:''});
});
