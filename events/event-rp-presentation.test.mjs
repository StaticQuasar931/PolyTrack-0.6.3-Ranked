import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createKodubErpFixtureV1} from './native-kodub-erp-fixture-v1.mjs';
import {eventRpPresentation,eventSnapshotRows} from './client.mjs';

const hash=n=>n.toString(16).padStart(64,'0');
test('event RP distinguishes published zero, numeric strings, absent fields and invalid values',()=>{
  for(const [value,label] of [[0,'0 ERP'],[84,'84 ERP'],['84','84 ERP'],['0','0 ERP']]){
    const row={rp:value},before=structuredClone(row);
    assert.equal(eventRpPresentation(row).text,label);
    assert.deepEqual(row,before);
  }
  for(const value of [undefined,null,'',' ',false,true,-1,1.5,NaN,Infinity,{},[],Number.MAX_SAFE_INTEGER+1,'1e2','84oops']){
    assert.equal(eventRpPresentation({rp:value}).text,'ERP unavailable');
  }
  assert.equal(eventRpPresentation({}).text,'ERP unavailable');
});
test('group ERP never falls back to global ERP when an explicit group score is invalid',()=>{
  assert.equal(eventRpPresentation({rp:84,groupRp:0}).text,'0 Group ERP');
  assert.equal(eventRpPresentation({rp:84,groupRp:'42'}).text,'42 Group ERP');
  assert.equal(eventRpPresentation({rp:84,groupRp:'bad'}).text,'Group ERP unavailable');
  assert.equal(eventRpPresentation({rp:84,groupRp:null}).text,'84 ERP');
});
test('scores never promote pending, held, rejected or explicitly unverified results',()=>{
  for(const flags of [{pending:true},{verified:false},{eventRpEligible:false},{needsReview:true},{reviewHold:true},{verificationStatus:'waiting'},{status:'rejected'}]){
    const row={rp:84,groupRp:90,...flags},before=structuredClone(row);
    assert.equal(eventRpPresentation(row),null);
    assert.deepEqual(row,before);
  }
});
test('snapshot rows retain score absence separately from zero without changing verification proof',()=>{
  const entries=[{accountId:hash(1),timeMs:100,rp:0},{accountId:hash(2),timeMs:200},{accountId:hash(3),timeMs:300,rp:'84'}];
  const saved={entries},before=structuredClone(saved),{rows}=eventSnapshotRows(saved);
  assert.deepEqual(rows.map(row=>eventRpPresentation(row).text),['0 ERP','ERP unavailable','84 ERP']);
  assert.equal(Object.hasOwn(rows[1],'rp'),false);
  assert.deepEqual(saved,before);
});
test('synthetic v1 Kodub, weekly and daily RP uses published event rows, not lifetime totals',()=>{
  const {eventBoard}=createKodubErpFixtureV1();
  for(const kind of ['kodub','weekly','daily']){
    const board=structuredClone(eventBoard);board.period.kind=kind;board.period.id=kind+'_synthetic_v1';
    for(const row of board.entries)row.periodId=board.period.id;
    const before=structuredClone(board),totals=board.entries.map(row=>({accountId:row.accountId,rp:row.rp+1000}));
    const {rows}=eventSnapshotRows(board,{onlyVerified:true});assert.equal(rows.length,22);
    for(const row of rows){
      const published=board.entries.find(entry=>entry.accountId===row.accountId);
      assert.equal(eventRpPresentation(row).text,published.rp+' ERP');
      assert.notEqual(eventRpPresentation(row).text,totals.find(entry=>entry.accountId===row.accountId).rp+' ERP');
    }
    assert.deepEqual(board,before);
  }
});
test('fallback event list uses the same zero and unavailable rules as native rows',()=>{
  const source=fs.readFileSync(new URL('./client.mjs',import.meta.url),'utf8');
  const start=source.indexOf('  function rows(entries)'),end=source.indexOf('  async function openPermanent()',start);
  assert.ok(start>=0&&end>start);
  const render=vm.runInNewContext(source.slice(start,end)+';rows;',{eventRpPresentation,displayName:()=> 'Racer',escape:value=>value,time:String,bridge:{accountId:()=> 'viewer'}});
  for(const [row,label] of [[{rp:0},'0 ERP'],[{},'ERP unavailable'],[{rp:'84'},'84 ERP'],[{rp:10,groupRp:0},'0 Group ERP'],[{rp:99,pending:true},'ERP pending']]){
    assert.ok(render([{timeMs:100,rank:1,...row}]).includes('<strong>'+label+'</strong>'));
  }
});
