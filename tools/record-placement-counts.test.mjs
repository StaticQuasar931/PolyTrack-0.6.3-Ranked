import test from 'node:test';
import assert from 'node:assert/strict';
import {computeRecordPlayerCount, installRecordPlacement, readRecordPlacementSettings, RECORD_PLACEMENT_SETTINGS} from './record-placement.mjs';

const trackId='track-a';
const stats=(players=3,revision=4)=>({complete:true,players,count:players,totalEntries:players,revision});
const board=(entries=[{accountId:'other',timeMs:900},{accountId:'me',timeMs:1000}],extra={})=>({
  authoritative:true,source:'public-backup',complete:true,revision:4,totalEntries:entries.length,entries,...extra
});

function fixture({names=['Track A'],text='No record',...options}={}){
  const cards=names.map(name=>{
    const classes=new Set(),native={nodeType:3,textContent:text};
    const record={child:null,childNodes:[native],classList:{contains:value=>classes.has(value),add:value=>classes.add(value),remove:value=>classes.delete(value)},
      querySelector:()=>record.child,appendChild(node){record.child=node;node.parentElement=record;record.childNodes.push(node);}};
    Object.defineProperty(record,'textContent',{get:()=>record.childNodes.map(node=>node.textContent).join(''),set:value=>{native.textContent=value;record.childNodes=[native];record.child=null;}});
    const title={textContent:name,closest:()=>({querySelector:()=>record})};
    return {title,record,classes};
  });
  const styles=new Map(),requests=[],reads=[];
  const document={head:{appendChild:node=>styles.set(node.id,node)},getElementById:id=>styles.get(id)||null,
    createElement:()=>({nodeType:1,dataset:{},setAttribute(name,value){this[name]=value;},hasAttribute:name=>name==='data-record-placement',remove(){
      if(this.parentElement){const host=this.parentElement;host.child=null;host.childNodes=host.childNodes.filter(node=>node!==this);this.parentElement=null;}
      styles.delete(this.id);
    }}),querySelectorAll:selector=>selector==='.track-title p'?cards.map(card=>card.title):selector==='[data-record-placement]'?cards.map(card=>card.record.child).filter(Boolean):selector==='.sq-record-placement-host'?cards.filter(card=>card.classes.has('sq-record-placement-host')).map(card=>card.record):[]};
  const api=installRecordPlacement({document,autoUpdate:false,tracks:[{id:trackId,name:'Track A'}],requestSnapshot:(...args)=>requests.push(args),
    readTrackStatistics:()=>{reads.push('statistics');return {[trackId]:stats()};},...options});
  return {api,cards,requests,reads,get badge(){return cards[0].record.child;}};
}

test('unplayed player counts default off, require explicit opt-in and tolerate blocked storage',()=>{
  assert.equal(readRecordPlacementSettings().showPlayerCounts,false);
  assert.equal(readRecordPlacementSettings({getItem(){throw Error('blocked');}}).showPlayerCounts,false);
  for(const value of [null,'0','true','garbage'])assert.equal(readRecordPlacementSettings({getItem:()=>value}).showPlayerCounts,false);
  assert.equal(readRecordPlacementSettings({getItem:key=>key===RECORD_PLACEMENT_SETTINGS.showPlayerCounts?'1':null}).showPlayerCounts,true);
  const f=fixture();f.api.update({snapshots:{[trackId]:board()}});
  assert.equal(f.badge,null);assert.deepEqual(f.reads,[]);assert.deepEqual(f.requests,[]);
});

test('only complete coherent public statistics count; unknown does not become zero',()=>{
  assert.equal(computeRecordPlayerCount({trackId,statistics:stats()}),3);
  assert.equal(computeRecordPlayerCount({trackId,statistics:stats(0)}),0);
  for(const change of [{complete:false},{players:null},{count:2},{totalEntries:null},{players:-1},{players:'3'},{players:NaN},{revision:0},{revision:null},{trackId:'another-track'}]){
    assert.equal(computeRecordPlayerCount({trackId,statistics:{...stats(),...change}}),null,JSON.stringify(change));
  }
  assert.equal(computeRecordPlayerCount({trackId}),null);
});

test('complete boards provide exact unique non-excluded fields without an account or statistics',()=>{
  const snapshot=board([{accountId:'a',timeMs:900,runVerified:false},{accountId:'b',timeMs:1000,runVerified:true},{accountId:'c',timeMs:1100,status:'rejected'}]);
  assert.equal(computeRecordPlayerCount({trackId,snapshot}),2);
  assert.equal(computeRecordPlayerCount({trackId,snapshot:board([])}),0);
  for(const change of [{complete:false},{totalEntries:200},{source:'local'},{trackId:'wrong'},
    {entries:[{accountId:'a',timeMs:900},{accountId:'a',timeMs:1000}]},
    {entries:[{accountId:'a',timeMs:900},{accountId:'b',timeMs:1000,localPending:true}]}]){
    assert.equal(computeRecordPlayerCount({trackId,snapshot:{...board(),...change}}),null);
  }
});

test('counts respect model/schema constraints just like PB placements',()=>{
  const snapshot=board(undefined,{schemaVersion:5,algorithmVersion:'current'});
  assert.equal(computeRecordPlayerCount({trackId,snapshot,minSchemaVersion:6}),null);
  assert.equal(computeRecordPlayerCount({trackId,snapshot,expectedAlgorithmVersion:'other'}),null);
});

test('newer sources win; conflicting or newer incomplete fields cannot borrow stale counts',()=>{
  assert.equal(computeRecordPlayerCount({trackId,snapshot:board(),statistics:stats(7,5)}),7);
  assert.equal(computeRecordPlayerCount({trackId,snapshot:board(),statistics:stats(7,3)}),2);
  assert.equal(computeRecordPlayerCount({trackId,snapshot:board(),statistics:stats(7,4)}),null);
  assert.equal(computeRecordPlayerCount({trackId,snapshot:board(undefined,{complete:false,revision:5}),statistics:stats(7,4)}),null);
  assert.equal(computeRecordPlayerCount({trackId,snapshot:board(undefined,{complete:false,revision:3}),statistics:stats(7,4)}),7);
});

test('unplayed badges use neutral counts and concise ARIA, never a rank or verification claim',()=>{
  const f=fixture();f.api.update({showPlayerCounts:true});
  assert.equal(f.badge.textContent,'3');assert.equal(f.badge['aria-label'],'No record - 3 players');
  assert.equal(f.badge.className,'sq-record-placement player-count');assert.doesNotMatch(f.badge.title,/#|verified|live/i);
  const same=f.badge;f.api.update({showPlayerCounts:true});assert.equal(f.badge,same,'the badge text must not contaminate no-record detection');
  assert.deepEqual(f.requests,[],'known counts must never warm boards');
});

test('zero and singular known counts are shown but missing counts stay absent',()=>{
  const f=fixture();
  for(const [count,label] of [[0,'0'],[1,'1']]){
    f.api.update({showPlayerCounts:true,trackStatistics:{[trackId]:stats(count)}});assert.equal(f.badge.textContent,label);
  }
  f.api.update({showPlayerCounts:true,trackStatistics:{}});assert.equal(f.badge,null);assert.equal(f.cards[0].classes.size,0);
});

test('switching counts off removes badge and host style; unknown settings never opt in',()=>{
  const f=fixture();f.api.update({showPlayerCounts:true});assert.ok(f.badge);
  f.api.update({showPlayerCounts:false});assert.equal(f.badge,null);assert.equal(f.cards[0].classes.size,0);
  f.api.update({showPlayerCounts:'true'});assert.equal(f.badge,null);
});

test('played cards retain exact PB badges, verified policy and time checks when counts are enabled',()=>{
  const f=fixture({text:'00:01.000'}),snapshots={[trackId]:board([{accountId:'other',timeMs:900},{accountId:'me',timeMs:1000,runVerified:true}])};
  f.api.update({accountId:'me',showPlayerCounts:true,snapshots});assert.equal(f.badge.textContent,'2/2');
  f.api.update({accountId:'me',showPlayerCounts:true,snapshots,policy:'verified'});assert.equal(f.badge.textContent,'1/1');
  f.cards[0].record.textContent='00:00.950';f.api.update({accountId:'me',showPlayerCounts:true,snapshots});assert.equal(f.badge,null);
});

test('unplayed counts stay an explicitly all-player field under verified PB placement policy',()=>{
  const f=fixture();f.api.update({showPlayerCounts:true,policy:'verified',snapshots:{[trackId]:board([{accountId:'a',timeMs:900},{accountId:'b',timeMs:1000,runVerified:true}])},trackStatistics:{}});
  assert.equal(f.badge.textContent,'2');assert.doesNotMatch(f.badge.title,/verified/i);
});

test('count badges are independent of disabled PB colors and do not run personal rank mapping',()=>{
  const f=fixture({mapPlacement(){assert.fail('counts are not own placements');}});
  f.api.update({enabled:false,showPlayerCounts:true});assert.equal(f.badge.textContent,'3');
  f.api.update({enabled:false,showPlayerCounts:false});assert.equal(f.badge,null);
});

test('disabled PB badges cannot be resurrected by an estimate or invalidation',()=>{
  let estimates=0;const f=fixture({text:'00:00.950',estimatePlacement:()=>{estimates++;return {trackId,accountId:'me',timeMs:950,rank:1,fieldSize:3,label:'~1/3',estimated:true};}});
  f.api.update({accountId:'me'});assert.equal(f.badge.textContent,'~1/3');
  f.api.update({accountId:'me',enabled:false});assert.equal(f.badge,null);
  f.api.invalidate(trackId);assert.equal(f.badge,null);assert.equal(estimates,1);
});

test('counts cannot turn stale state back on after invalidation or an older source arrives',()=>{
  const f=fixture();f.api.update({showPlayerCounts:true});assert.ok(f.badge);
  f.api.invalidate(trackId);assert.equal(f.badge,null);
  f.api.update({showPlayerCounts:true});assert.equal(f.badge,null);
  f.api.update({showPlayerCounts:true,trackStatistics:{[trackId]:stats(4,5)}});assert.equal(f.badge.textContent,'4');
  f.api.update({showPlayerCounts:true,trackStatistics:{[trackId]:stats(3,4)}});assert.equal(f.badge,null);
});

test('ambiguous track names never attach another track player count or PB placement',()=>{
  const f=fixture({tracks:[{id:trackId,name:'Track A'},{id:'track-b',name:'Track A'}]});
  f.api.update({showPlayerCounts:true});assert.equal(f.badge,null);
});

test('native timer placeholders may show counts but malformed PB text is not treated as unplayed',()=>{
  const f=fixture({text:'--:--.---'});f.api.update({showPlayerCounts:true});assert.equal(f.badge.textContent,'3');
  for(const text of ['00:99.999','00:00.000','Loading...','']){
    f.cards[0].record.textContent=text;f.api.update({showPlayerCounts:true});assert.equal(f.badge,null);
  }
});

test('destroy clears count badge and host class without changing native No record text',()=>{
  const f=fixture();f.api.update({showPlayerCounts:true});f.api.destroy();
  assert.equal(f.badge,null);assert.equal(f.cards[0].record.textContent,'No record');assert.equal(f.cards[0].classes.size,0);
});
