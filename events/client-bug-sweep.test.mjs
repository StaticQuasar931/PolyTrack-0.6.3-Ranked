import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {eventExactRunAt,eventVerificationLabel} from './client.mjs';
import {archiveSnapshotState} from './archive-view.mjs';
import {harness,racer,deferred,until} from './event-replay-test-fixture.mjs';

const source=fs.readFileSync(new URL('./client.mjs',import.meta.url),'utf8');
test('cancelling one selected ghost invalidates an action without reviving loaded ghosts',async()=>{
 const gate=deferred(),h=harness({read:async row=>{await gate.promise;return {...row};}});
 await h.selectTopEventRows(3);const work=h.action('watch');await until(()=>h.reads.length===3);
 await h.select(h.rows[0]);gate.resolve();await work;
 assert.equal(h.pending(),0);assert.equal(h.selected().length,2);assert.equal(h.watches.length,0);
 assert(h.selected().every(row=>row.ghost===null));
});

test('a newer individual selection invalidates Play while retaining the chosen group',async()=>{
 const gate=deferred(),rows=['one','two','three','four'].map((id,i)=>racer(id,1000+i));
 const h=harness({rows,read:async row=>{await gate.promise;return {...row};}});
 await h.selectTopEventRows(3);const work=h.action('play');await until(()=>h.reads.length===3);
 await h.select(rows[3]);gate.resolve();await work;
 assert.equal(h.pending(),0);assert.deepEqual(Array.from(h.selected(),row=>row.targetAccountId),rows.map(row=>row.accountId));
 assert.equal(h.launches.length,0);assert.equal(h.reads.length,3);
});

test('future exact replay timestamps remain unknown in verification labels',()=>{
 const future=Date.now()+86400000;
 for(const row of [{runCreatedAt:future},{pbAt:future},{createdAt:future},{uploadId:future*1000}]){
  assert.equal(eventExactRunAt(row),null);
  assert.equal(eventVerificationLabel(row,false),'Date unavailable - Verified');
 }
 const past=Date.now()-10000;
 assert.equal(eventExactRunAt({runCreatedAt:future,pbAt:past}),past);
});

test('a late archived-track failure cannot clear a newer navigation intent',async()=>{
 const pending=new Map(),messages=[];
 const context={bridge:{accountId:()=> 'viewer',openTrack:track=>new Promise((resolve,reject)=>pending.set(track,{resolve,reject}))},
  sessions:{leave(){}},knownPeriods:new Map(),cache:new Map(),read:()=>null,STORE:'test',
  archiveSnapshotState,close(){},message:text=>messages.push(text),tick(){}};
 const code=source.slice(source.indexOf('  async function openArchivedTrack('),source.indexOf('  let launching='));
 const api=vm.runInNewContext(`(()=>{let entryRequest=0,eventIntent=null,archiveIntent=null,nativeOpenPermit=false;${code};return {openArchivedTrack,current:()=>archiveIntent};})()`,context);
 const first={id:'old',kind:'daily',trackId:'old-track'},second={id:'new',kind:'daily',trackId:'new-track'};
 const a=api.openArchivedTrack(first,{period:first,entries:[]});
 const b=api.openArchivedTrack(second,{period:second,entries:[]});
 const before=messages.length;
 pending.get(first.trackId).reject(Error('old navigation failed'));assert.equal(await a,false);
 assert.equal(api.current()?.periodId,second.id);
 assert.equal(messages.length,before,'obsolete navigation must not overwrite current status');
 pending.get(second.trackId).resolve(true);assert.equal(await b,true);
});

test('an obsolete archived import failure cannot overwrite a newer dialog status',async()=>{
 let reject;const messages=[];
 const context={bridge:{readArchivedTrack:()=>new Promise((_resolve,no)=>{reject=no;})},
  message:text=>messages.push(text),close(){}};
 const code=source.slice(source.indexOf('  async function importArchived('),source.indexOf('  async function totals('));
 const api=vm.runInNewContext(`(()=>{let requestId=0,dialog={};${code};return {importArchived,navigate(){requestId++;}};})()`,context);
 const pending=api.importArchived({id:'old'});api.navigate();const before=messages.length;
 reject(Error('old import failed'));await pending;
 assert.equal(messages.length,before);
});

const patchSource=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const importSource=source.slice(source.indexOf('  async function importArchived('),source.indexOf('  async function totals('));
const closeSource=source.slice(source.indexOf('  function close('),source.indexOf('  function shell('));
const bridgeStart=patchSource.indexOf('        importTrackCode:');
const bridgeSource=patchSource.slice(bridgeStart,patchSource.indexOf('        readPermanent:',bridgeStart)).trim().replace(/,$/,'');
assert.ok(bridgeStart>=0&&bridgeSource.includes('field.focus()'),'actual parent importer callback is present');
function archiveImportFixture(options={}){
 const state={messages:[],leaves:0,removed:0,focus:'archive',fieldOpen:false,intent:true};
 let api,id=0;
 const field={readOnly:false,value:'',dispatchEvent(){options.onInput?.(api);},focus(){state.focus='field';}};
 const button={querySelector:()=>true,click(){state.fieldOpen=!options.missingField;options.onClick?.(api);}};
 const context={state,read:options.read|| (async()=> 'saved-track-code'),customImport:options.importer,
  makeDialog:()=>({id:++id,remove(){state.removed++;}}),message:text=>state.messages.push(text),
  eventUi:{leave(){state.leaves++;state.intent=false;options.onLeave?.(api);}},
  document:{querySelectorAll:selector=>selector==='textarea'?(state.fieldOpen?[field]:[]):options.missingButton?[]:[button]},
  isElementVisible:()=>true,Event:class Event{}};
 api=vm.runInNewContext(`(()=>{let requestId=0,entryRequest=0,selected=null,dialog=makeDialog(),returnFocus={isConnected:true,focus(){state.focus='return';}};const parent={${bridgeSource}};const bridge={readArchivedTrack:read,importTrackCode:customImport||parent.importTrackCode};${closeSource}${importSource};return {importArchived,close,current:()=>dialog,navigate(){requestId++;dialog=makeDialog();state.focus='new-view';return dialog;}};})()`,context);
 return {...api,state,field};
}

test('archived import missing native controls preserves its dialog, intent and actionable error',async()=>{
 for(const options of [{missingButton:true},{missingField:true}]){
  const f=archiveImportFixture(options),dialog=f.current();await f.importArchived({id:'old'});
  assert.equal(f.current(),dialog);assert.equal(f.state.leaves,0);assert.equal(f.state.intent,true);
  assert.match(f.state.messages.at(-1),options.missingButton?/Open Community tracks/:/Native track importer is unavailable/);
 }
});

test('archived import successful native handoff leaves once, closes once and preserves field focus',async()=>{
 const f=archiveImportFixture();await f.importArchived({id:'old'});
 assert.equal(f.current(),null);assert.equal(f.state.leaves,1);assert.equal(f.state.removed,1);
 assert.equal(f.field.value,'saved-track-code');assert.equal(f.state.focus,'field');
});

test('archived import sync reentrant navigation or self-close is not closed again',async()=>{
 for(const replace of [false,true]){
  let f,newDialog;
  f=archiveImportFixture({importer:()=>{f.close();if(replace)newDialog=f.navigate();}});
  await f.importArchived({id:'old'});
  assert.equal(f.current(),replace?newDialog:null);assert.equal(f.state.removed,1);
 }
});

test('archived native handoff stops before leaving or focusing after reentrant navigation',async()=>{
 for(const boundary of ['onClick','onInput','onLeave']){
  let newer;
  const f=archiveImportFixture({[boundary]:api=>{newer=api.navigate();}});
  await f.importArchived({id:'old'});
  assert.equal(f.current(),newer);assert.equal(f.state.focus,'new-view');
  assert.equal(f.state.leaves,boundary==='onLeave'?1:0);
 }
});

test('archived import promise success waits for handoff and late completion preserves newer views',async()=>{
 for(const navigate of [false,true]){
  let resolve,started;
  const ready=new Promise(done=>{started=done;});
  const f=archiveImportFixture({importer:()=>{started();return new Promise(done=>{resolve=done;});}});
  const original=f.current(),pending=f.importArchived({id:'old'});await ready;
  assert.equal(f.current(),original);
  const newer=navigate?f.navigate():null;resolve(true);await pending;
  assert.equal(f.current(),navigate?newer:null);
 }
});

test('archived import promise rejection reports only to the still-owned dialog',async()=>{
 for(const navigate of [false,true]){
  let reject,started;
  const ready=new Promise(done=>{started=done;});
  const f=archiveImportFixture({importer:()=>{started();return new Promise((_done,no)=>{reject=no;});}});
  const original=f.current(),pending=f.importArchived({id:'old'});await ready;
  const newer=navigate?f.navigate():original,before=f.state.messages.length;
  reject(Error('handoff failed'));await pending;
  assert.equal(f.current(),newer);
  if(navigate)assert.equal(f.state.messages.length,before);else assert.equal(f.state.messages.at(-1),'handoff failed');
 }
});

test('archived import false handoff retains the dialog and reports retry instead of closing',async()=>{
 const f=archiveImportFixture({importer:()=>false}),original=f.current();await f.importArchived({id:'old'});
 assert.equal(f.current(),original);assert.match(f.state.messages.at(-1),/could not be imported/);
});
