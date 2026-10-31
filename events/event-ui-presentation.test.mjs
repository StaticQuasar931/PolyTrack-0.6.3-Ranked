import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {eventRowVerified} from './client.mjs';
import {finishOrdinal} from '../tools/finish-presentation.mjs';
const source=fs.readFileSync(new URL('./client.mjs',import.meta.url),'utf8');
const dates=source.slice(source.indexOf('export function eventRunDate('),source.indexOf('export function eventStandingsLabel('));
const ordinals=source.slice(source.indexOf('export function eventOrdinal('),source.indexOf('export function eventTrackName('));
const ui=vm.runInNewContext(`(()=>{${(dates+ordinals).replace(/export function /g,'function ')};return {eventRunDate,eventExactRunAt,eventDisplayRunAt,eventVerificationLabel,decorateEventRowPresentation,eventOrdinal};})()`,{Date,Number,String,Object,Math,eventRowVerified,finishOrdinal});
const now=Date.now(),received=now-3600000;
function rowButton(){
  const element=(tagName='span')=>({nodeType:1,tagName:tagName.toUpperCase(),dataset:{},childNodes:[],attributes:{},setAttribute(key,value){this.attributes[key]=value;},
    replaceChildren(...children){this.childNodes=children;},get textContent(){return this.childNodes.map(node=>node.textContent).join('');},
    set textContent(value){this.childNodes=[{nodeType:3,textContent:value}];}});
  const position=element();position.textContent='1X';
  const state=element();state.childNodes=[{nodeType:3,textContent:'Just now'},{nodeType:1,textContent:'',icon:true}];
  const button={ownerDocument:{createElement:element,createTextNode:textContent=>({nodeType:3,textContent})},
    querySelector:selector=>selector==='.left .position'?position:state};
  return {button,position,state};
}
test('published event receipt time is displayed honestly without changing exact run-time semantics',()=>{
  for(const field of ['submittedAt','receivedAt']){
    const row={[field]:received,updatedAt:now,verifiedAt:now};
    assert.equal(ui.eventExactRunAt(row),null);
    assert.equal(ui.eventDisplayRunAt(row,now),received);
    assert.match(ui.eventVerificationLabel(row,false,'en-US'),/^Received .* - Verified$/);
    assert.match(ui.eventVerificationLabel({...row,pending:true},true,'en-US'),/^Received .* - Pending$/);
    assert.equal(ui.eventRunDate(row,now).label,'1 hour ago');
  }
});
test('published runAt and exact creation timestamps render; publication, verification, age and invalid dates are never substituted',()=>{
  assert.equal(ui.eventDisplayRunAt({runAt:received},now),received);
  assert.doesNotMatch(ui.eventVerificationLabel({runAt:received},false),/^Received /);
  assert.equal(ui.eventDisplayRunAt({pbAt:received-1000,submittedAt:received},now),received-1000);
  for(const row of [{updatedAt:received},{verifiedAt:received},{runAgeMs:1000},
    {submittedAt:now+86400000},{receivedAt:'invalid'},{runAt:Infinity},{submittedAt:-1}]){
    assert.equal(ui.eventDisplayRunAt(row,now),null);
    assert.equal(ui.eventVerificationLabel(row,false),row.verifiedAt?'Verification date '+new Date(received).toLocaleString(undefined,{year:'numeric',month:'2-digit',day:'2-digit',hour:'numeric',minute:'2-digit'})+' - Verified':'Date unavailable - Verified');
  }
});
test('live and archived event rows retain native numeric rank plus quiet suffix markup without changing ranks or points',()=>{
  for(const rank of [1,2,3,4,11,12,13,21,22,23,101,111,112,113]){
    const fixture=rowButton(),row={rank,rp:87,timeMs:20000,submittedAt:received},before=JSON.stringify(row);
    ui.decorateEventRowPresentation(fixture.button,row,now);
    assert.equal(fixture.position.textContent,ui.eventOrdinal(rank));
    assert.equal(fixture.position.childNodes.length,2,'native numeric text followed by suffix span');
    assert.equal(fixture.position.attributes['aria-label'],ui.eventOrdinal(rank));
    assert.equal(fixture.position.childNodes[0].nodeType,3);
    assert.equal(fixture.position.childNodes[0].textContent,String(rank));
    assert.equal(fixture.position.childNodes[1].tagName,'SPAN');
    assert.equal(fixture.position.childNodes[1].textContent,finishOrdinal(rank).suffix);
    assert.equal(fixture.position.childNodes[1].className,undefined,'no custom suffix font class');
    assert.equal(fixture.state.dataset.sqPbAt,undefined,'receipt time must not masquerade as exact PB creation');
    assert.match(fixture.state.dataset.sqNativeDate,/^Received /);
    assert.match(fixture.state.title,/^Received .* - Verified$/);
    assert.equal(JSON.stringify(row),before);
  }
  assert.equal((source.match(/decorateEventRowPresentation\(button,row,now\(\)\)/g)||[]).length,2,'both live and archived native rows use the presentation adapter');
});
test('unknown date correction preserves verification icons and pending state while exact dates remain available to the shared updater',()=>{
  const f=rowButton();ui.decorateEventRowPresentation(f.button,{rank:1,pending:true,updatedAt:now},now);
  assert.equal(f.state.childNodes[0].textContent,'Date unavailable');assert.equal(f.state.childNodes[1].icon,true);
  assert.equal(f.state.dataset.sqRunStatus,'unchecked');assert.equal(f.state.title,'Date unavailable - Pending');
  ui.decorateEventRowPresentation(f.button,{rank:1,pbAt:received},now);
  assert.equal(f.state.dataset.sqRunStatus,'verified');assert.equal(f.state.dataset.sqPbAt,String(received));
});
test('event finish keeps the native plain-text ordinal and stable updates',()=>{
  const f=rowButton(),place={rank:1,fieldSize:4,provisional:false},classes=new Set();
  f.position.querySelector=()=>f.position.childNodes.find(node=>node.className==='sq-event-ordinal-suffix')||null;
  const current={querySelector:()=>f.position,classList:{contains:value=>classes.has(value),toggle:(value,on)=>on?classes.add(value):classes.delete(value)}};
  const root={querySelector:selector=>selector==='.current'?current:null};
  const start=source.indexOf('  function syncFinishPlace(){'),end=source.indexOf('  function tick(',start);
  assert.ok(start>=0&&end>start);
  const sync=vm.runInNewContext(source.slice(start,end)+';syncFinishPlace;',{
    document:{querySelector:()=>root,...f.button.ownerDocument},latestFinish:{periodId:'daily',accountId:'mine'},
    sessions:{current:()=>({periodId:'daily'})},bridge:{accountId:()=> 'mine'},finishPlace:()=>place,eventOrdinal:ui.eventOrdinal,
  });
  sync();assert.equal(f.position.textContent,'1st');assert.equal(f.position.title,'Event place 1 of 4');
  assert.equal(f.position.childNodes.length,1);assert.equal(f.position.childNodes[0].nodeType,3);
  const text=f.position.childNodes[0];sync();assert.equal(f.position.childNodes[0],text,'stable ticks do not replace native text');
  place.rank=21;sync();assert.equal(f.position.textContent,'21st');assert.equal(place.rank,21);
  place.rank=1001;place.fieldSize=2048;sync();assert.equal(f.position.textContent,'1\u202f001st');assert.equal(f.position.childNodes.length,1);
});
