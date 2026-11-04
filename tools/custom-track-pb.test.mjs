import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {syncPersonalBestRecord, installRecordPlacement} from './record-placement.mjs';

const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const A='a'.repeat(64),B='b'.repeat(64);
const extract=name=>{const start=source.indexOf('  function '+name+'(');assert.ok(start>=0,name);return source.slice(start,source.indexOf('\n  }',start)+4);};
const format=value=>`${String(Math.floor(value/60000)).padStart(2,'0')}:${String(Math.floor(value%60000/1000)).padStart(2,'0')}.${String(value%1000).padStart(3,'0')}`;
function fixture(){
  const data={rows:[],board:null};
  const c=vm.createContext({Map,Number,String,Array,Math,JSON,extraTrackKnownIds:{},profileSnapshotResults:new Map(),
    activeRankedAccountId:()=> 'me',cleanUserId:x=>x,canonicalRaceTimeMs:row=>row?.timeMs||0,
    localRaceRowsForTrack:id=>data.rows.filter(row=>row.trackId===id),readTrackSnapshotCache:()=>data.board,
    readJsonStorage:()=>({}),unrankedExtraBestKey:'unranked'});
  vm.runInContext(extract('savedTrackPersonalBest')+'\n'+extract('extraTrackPersonalBest'),c);
  return {c,data};
}

test('Custom/Extra times survive missing or evicted boards using the existing durable PB JSON',()=>{
  const f=fixture();f.data.rows=[{accountId:'me',trackId:A,timeMs:12000},{accountId:'other',trackId:A,timeMs:1000}];
  assert.equal(f.c.savedTrackPersonalBest(A,'me').timeMs,12000);
  assert.equal(f.c.savedTrackPersonalBest(A,'me').place,null);
  f.data.board={entries:[{accountId:'me',timeMs:13000,rank:8}]};
  assert.equal(f.c.extraTrackPersonalBest({trackId:A}).timeMs,12000);
  f.data.board=null;
  assert.equal(f.c.extraTrackPersonalBest({trackId:A}).timeMs,12000);
  const reopened=fixture();reopened.data.rows=JSON.parse(JSON.stringify(f.data.rows));
  assert.equal(reopened.c.savedTrackPersonalBest(A,'me').timeMs,12000);
  assert.equal(reopened.c.savedTrackPersonalBest(A,'unknown'),null);
});

test('fresh local improvements are read without reopening the catalog, and a faster published PB wins',()=>{
  const f=fixture();f.data.rows=[{accountId:'me',trackId:A,timeMs:12000}];
  assert.equal(f.c.extraTrackPersonalBest({trackId:A}).timeMs,12000);
  f.data.rows=[{accountId:'me',trackId:A,timeMs:11000}];
  assert.equal(f.c.extraTrackPersonalBest({trackId:A}).timeMs,11000);
  f.data.board={entries:[{accountId:'me',timeMs:10000,rank:3}]};
  assert.equal(f.c.extraTrackPersonalBest({trackId:A}).timeMs,10000);
  assert.equal(f.c.extraTrackPersonalBest({trackId:A}).place,3);
});

test('saved profile results do not require a board and cannot leak another account or track',()=>{
  const f=fixture();f.c.profileSnapshotResults.set('me',{accountId:'me',results:[{trackId:A,timeMs:11000,rank:3}]});
  assert.equal(f.c.savedTrackPersonalBest(A,'me').timeMs,11000);
  f.c.profileSnapshotResults.set('me',{accountId:'other',results:[{trackId:A,timeMs:9000}]});
  assert.equal(f.c.savedTrackPersonalBest(A,'me'),null);
  f.data.board={entries:[{accountId:'me',trackId:B,timeMs:1000}]};
  assert.equal(f.c.savedTrackPersonalBest(A,'me'),null);
  for(const status of ['rejected','unavailable','unavailable_track']){
    f.data.rows=[{accountId:'me',trackId:A,timeMs:5000,status:'pending',verificationStatus:status}];
    assert.equal(f.c.savedTrackPersonalBest(A,'me'),null);
  }
});

test('unranked challenge PB remains in its existing separate device-only bucket',()=>{
  const f=fixture();f.c.readJsonStorage=()=>({['me|'+A]:9000});
  assert.equal(f.c.extraTrackPersonalBest({trackId:A,ranked:false}).timeMs,9000);
  assert.equal(f.c.extraTrackPersonalBest({trackId:A}),null);
});

function record(text='No record'){
  const node={nodeType:3,textContent:text};
  return {childNodes:[node],title:'Original native title'};
}
const sync=(r,best,extra={})=>syncPersonalBestRecord(r,{accountId:'me',trackId:A,best,formatTime:format,...extra});

test('PB fallback changes only the native time text and preserves badge elements',()=>{
  const r=record(),badge={nodeType:1,textContent:'22',hasAttribute:()=>true};r.childNodes.push(badge);
  sync(r,{timeMs:12000,local:true});assert.equal(r.childNodes[0].textContent,'00:12.000');
  assert.equal(r.childNodes[1],badge);assert.equal(r.title,'Local PB on this device');
  sync(r,{timeMs:11000,local:true});assert.equal(r.childNodes[0].textContent,'00:11.000');
  sync(r,null,{accountId:'other'});assert.equal(r.childNodes[0].textContent,'No record');assert.equal(r.title,'');
});

test('faster native records are never replaced; native async updates invalidate the fallback',()=>{
  const r=record('00:09.000');sync(r,{timeMs:12000});assert.equal(r.childNodes[0].textContent,'00:09.000');
  const q=record();sync(q,{timeMs:12000,local:true});q.childNodes=[{nodeType:3,textContent:'00:08.000'}];
  sync(q,{timeMs:12000,local:true});assert.equal(q.childNodes[0].textContent,'00:08.000');assert.equal(q.title,'Original native title');
  const native=record('00:10.000');sync(native,{timeMs:9000,local:true});sync(native,{timeMs:12000,local:true});
  assert.equal(native.childNodes[0].textContent,'00:10.000','a reset local store cannot replace the faster original native PB');
});

test('invalid/missing PB and changed identity restore only this fallback, not native content',()=>{
  for(const invalid of [null,{}, {timeMs:0},{timeMs:NaN}]){
    const r=record();sync(r,{timeMs:12000});sync(r,invalid);assert.equal(r.childNodes[0].textContent,'No record');
  }
  const r=record();sync(r,{timeMs:12000});sync(r,{timeMs:15000},{accountId:'other'});
  assert.equal(r.childNodes[0].textContent,'00:15.000');sync(r,null);assert.equal(r.childNodes[0].textContent,'No record');
  const played=record('00:10.000');sync(played,{timeMs:9000,local:true});sync(played,{timeMs:15000},{accountId:'other'});
  assert.equal(played.childNodes[0].textContent,'00:15.000','an old native time cannot override another account PB');
  sync(played,null);assert.equal(played.childNodes[0].textContent,'---','do not restore the previous account native time');
});

test('actual saved custom code establishes identity, not a colliding catalog title',()=>{
  let raw=JSON.stringify({data:'code-a'}),decodes=0;
  const c=vm.createContext({Map,String,JSON,customTrackIdentityCache:new Map(),localStorage:{getItem:key=>{assert.equal(key,'polytrack_v5_prod_track_My track');return raw;}},
    __pt062WebpackRequire:()=>()=>({A:{fromExportString:code=>{decodes++;return{trackMetadata:{name:'My track'},trackData:{getId:()=>code==='code-a'?A:B}};}}})});
  vm.runInContext(extract('customTrackIdentityForTitle'),c);
  const title={textContent:'My track',closest:()=>({})};
  assert.equal(c.customTrackIdentityForTitle(title),A);assert.equal(c.customTrackIdentityForTitle(title),A);assert.equal(decodes,1);
  raw=JSON.stringify({data:'code-b'});assert.equal(c.customTrackIdentityForTitle(title),B);
  raw='broken';assert.equal(c.customTrackIdentityForTitle(title),'');
  assert.equal(c.customTrackIdentityForTitle({...title,closest:()=>null}),'');
});

test('identity cache stays bounded and refuses wrong-name or oversized native data',()=>{
  let name='Track',raw='';const cache=new Map();
  const c=vm.createContext({Map,String,JSON,customTrackIdentityCache:cache,localStorage:{getItem:()=>raw},
    __pt062WebpackRequire:()=>()=>({A:{fromExportString:()=>({trackMetadata:{name},trackData:{getId:()=>A}})}})});
  vm.runInContext(extract('customTrackIdentityForTitle'),c);
  for(let i=0;i<300;i++){name='Track '+i;raw=JSON.stringify({data:'code'+i});assert.equal(c.customTrackIdentityForTitle({textContent:name,closest:()=>({})}),A);}
  assert.ok(cache.size<=256);
  for(let i=0;i<20;i++){name='Large '+i;raw=JSON.stringify({data:'x'.repeat(100000)});assert.equal(c.customTrackIdentityForTitle({textContent:name,closest:()=>({})}),A);}
  assert.ok(Array.from(cache.values()).reduce((sum,row)=>sum+row.raw.length*2,0)<=1048576);
  raw=JSON.stringify({data:'code'});assert.equal(c.customTrackIdentityForTitle({textContent:'Other name',closest:()=>({})}),'');
  raw='x'.repeat(600001);assert.equal(c.customTrackIdentityForTitle({textContent:name,closest:()=>({})}),'');
});

test('large unchanged visible collections decode once and offscreen cards do not decode',()=>{
  let current='',decodes=0,reads=0;
  const c=vm.createContext({Map,String,JSON,customTrackIdentityCache:new Map(),window:{innerWidth:1000,innerHeight:800},
    localStorage:{getItem:key=>{reads++;return JSON.stringify({data:key});}},
    __pt062WebpackRequire:()=>()=>({A:{fromExportString:()=>{decodes++;return{trackMetadata:{name:current},trackData:{getId:()=>A}};}}})});
  vm.runInContext(extract('customTrackIdentityForTitle'),c);
  const title=(top=0)=>({textContent:current,closest:selector=>selector==='button'?{getBoundingClientRect:()=>({top,bottom:top+100,left:0,right:200})}:{}});
  for(let pass=0;pass<2;pass++)for(let i=0;i<100;i++){current='Track '+i;assert.equal(c.customTrackIdentityForTitle(title()),A);}
  assert.equal(decodes,100,'second render reuses all decoded identities');
  const priorReads=reads;
  for(let i=0;i<100;i++){current='Offscreen '+i;assert.equal(c.customTrackIdentityForTitle(title(1200)),'');}
  assert.equal(decodes,100);assert.equal(reads,priorReads,'offscreen cards do not read raw track codes');
});

test('offscreen custom cards are left untouched rather than clearing their saved PB fallback',()=>{
  const start=source.indexOf('          findRecordElement:title=>'),end=source.indexOf('          readSnapshots:',start);
  assert.ok(start>=0&&end>start);
  const expression=source.slice(start,end).trim().replace(/^findRecordElement:/,'').replace(/,$/,'');
  const find=vm.runInNewContext('('+expression+')',{window:{innerWidth:1000,innerHeight:800}});
  const value={textContent:'00:12.000'};let top=1000;
  const title={closest:selector=>selector==='button'?{getBoundingClientRect:()=>({top,bottom:top+100,left:0,right:200}),querySelector:()=>value}:selector==='.tracks-container.no-group-containers'?{}:null};
  assert.equal(find(title),null);assert.equal(value.textContent,'00:12.000');
  top=100;assert.equal(find(title),value);
});

test('PB display callbacks are independent of placement settings and do not request a board',()=>{
  const r=record(),title={textContent:'Custom',closest:()=>({querySelector:()=>r})};
  const doc={querySelectorAll:selector=>selector==='.track-title p'?[title]:[]};
  const api=installRecordPlacement({document:doc,autoUpdate:false,tracks:[],storage:{getItem:()=>null},
    readAccountId:()=> 'me',resolveTrackId:()=>A,readPersonalBest:()=>({timeMs:12000,local:true}),formatPersonalBest:format,
    requestSnapshot:()=>assert.fail('No display-only read may request a board')});
  api.update({enabled:false});assert.equal(r.childNodes[0].textContent,'00:12.000');api.destroy();
});
