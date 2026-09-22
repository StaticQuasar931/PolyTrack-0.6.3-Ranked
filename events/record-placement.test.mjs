import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {eventOrdinal,eventPlacementPresentation,eventRecordPlacement,eventTrackName,readEventPlacementSettings} from './client.mjs';

const account=n=>n.toString(16).padStart(64,'0');
const period={id:'daily-fixture',trackId:'a'.repeat(64),entrantLimit:5};
const verified=(id,timeMs,rank)=>({accountId:account(id),timeMs,rank,rp:1});
const waiting=(id,timeMs,run=id+100)=>({accountId:account(id),runId:account(run),timeMs,verificationStatus:'waiting',pending:true,verified:false,eventRpEligible:false,source:'pending-event-playback'});
const board=(entries,pendingPlaybacks=[])=>({period,updatedAt:10,entries,pendingPlaybacks,racerCount:99});

test('event placement settings default on/all and preserve verified-only and off choices',()=>{
  const values=new Map(),storage={getItem:key=>values.get(key)??null};
  assert.deepEqual(readEventPlacementSettings(storage),{enabled:true,policy:'all'});
  values.set('polytrack-0.6.2-pb-podiums-verified-only','1');assert.deepEqual(readEventPlacementSettings(storage),{enabled:true,policy:'verified'});
  values.set('polytrack-0.6.2-pb-podiums','0');assert.deepEqual(readEventPlacementSettings(storage),{enabled:false,policy:'verified'});
  assert.deepEqual(readEventPlacementSettings({getItem(){throw Error('blocked');}}),{enabled:true,policy:'all'});
});

test('all policy ranks a validated waiting recording provisionally without inventing field size',()=>{
  const result=eventRecordPlacement({board:board([verified(1,1000,1),verified(2,1300,2)],[waiting(3,1100)]),period,accountId:account(3),timeMs:1100,policy:'all'});
  assert.deepEqual(result,{rank:2,fieldSize:null,knownFieldSize:3,provisional:true,policy:'all'});
  const shown=eventPlacementPresentation(result);assert.equal(shown.text,'#2*');assert.equal(shown.className,'sq-event-place silver');assert.match(shown.title,/Provisional event place #2/);assert.equal(shown.ariaLabel,shown.title);assert.doesNotMatch(shown.text,/\//);
});

test('all policy lets waiting records affect a published PB while verified policy does not',()=>{
  const snapshot=board([verified(1,1000,1),verified(2,1200,2)],[waiting(3,1100)]);
  assert.equal(eventRecordPlacement({board:snapshot,period,accountId:account(2),timeMs:1200,policy:'all'}).rank,3);
  assert.deepEqual(eventRecordPlacement({board:snapshot,period,accountId:account(2),timeMs:1200,policy:'verified'}),{rank:2,fieldSize:null,knownFieldSize:2,provisional:false,policy:'verified'});
  assert.equal(eventRecordPlacement({board:snapshot,period,accountId:account(3),timeMs:1100,policy:'verified'}),null);
});

test('competition ties and top-three presentation stay deterministic',()=>{
  const snapshot=board([verified(1,1000,1),verified(2,1200,2),verified(3,1200,2)]);
  const place=eventRecordPlacement({board:snapshot,period,accountId:account(3),timeMs:1200,policy:'verified'});
  assert.equal(place.rank,2);assert.equal(eventPlacementPresentation(place).className,'sq-event-place silver');
  assert.equal(eventPlacementPresentation({...place,rank:3}).className,'sq-event-place bronze');
  assert.equal(eventPlacementPresentation({...place,rank:4}).className,'sq-event-place');
});
test('native event places use correct ordinal suffixes, including teens',()=>{
  assert.deepEqual([1,2,3,4,11,12,13,21,22,23].map(eventOrdinal),['1st','2nd','3rd','4th','11th','12th','13th','21st','22nd','23rd']);
  assert.equal(eventOrdinal(0),'');assert.equal(eventOrdinal(1.5),'');
});

test('pending placement fails closed for malformed, legacy, duplicate, or over-bound snapshots',()=>{
  const own=waiting(3,1100),entries=[verified(1,1000,1)];
  const place=input=>eventRecordPlacement({board:input,period,accountId:account(3),timeMs:1100,policy:'all'});
  assert.equal(place({...board(entries),playbacks:[own]}),null,'legacy playbacks are not authoritative placement input');
  assert.equal(place(board(entries,[{...own,eventRpEligible:true}])),null);
  assert.equal(place(board(entries,[own,{...waiting(4,1200),runId:own.runId}])),null);
  assert.equal(place({...board(entries,[own]),pendingPlaybacks:Array.from({length:6},(_,i)=>waiting(i+10,1200+i,i+50))}),null);
  assert.equal(place({...board(entries,[own]),updatedAt:'10'}),null);
});

test('public archive track names win before catalog and generic labels',()=>{
  const lookup=()=>({name:'Custom track aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'});
  assert.equal(eventTrackName({trackId:period.trackId,trackName:'La Riviera',label:'Kodub weekly'},lookup),'La Riviera');
  assert.equal(eventTrackName({trackId:period.trackId,label:'Kodub weekly'},()=>({name:'Catalog name'})),'Catalog name');
  assert.equal(eventTrackName({trackId:period.trackId,label:'Kodub weekly'},()=>({})),'Kodub weekly');
});

test('cards, event detail, and archive adapter share the public-name resolver',()=>{
  const source=fs.readFileSync(new URL('./client.mjs',import.meta.url),'utf8');
  assert.match(source,/resolveName:periodName/);
  assert.match(source,/escape\(periodName\(p\)\)/);
  assert.match(source,/escape\(periodName\(period\)\)/);
});
