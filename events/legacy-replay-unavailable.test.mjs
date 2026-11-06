import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as client from './client.mjs';
import {archivePeriodCounts,archiveSnapshotState,mountArchiveView} from './archive-view.mjs';

const source=fs.readFileSync(new URL('./client.mjs',import.meta.url),'utf8');
const integration=fs.readFileSync(new URL('./archive-client-integration.test.mjs',import.meta.url),'utf8');
const tableTests=fs.readFileSync(new URL('./archive-view.test.mjs',import.meta.url),'utf8');
const section=(start,end)=>{
  const a=source.indexOf(start),b=source.indexOf(end,a);
  assert.ok(a>=0&&b>a);return source.slice(a,b);
};
const period={id:'legacy',kind:'kodub',trackId:'a'.repeat(64),endsAt:100,archived:true,racerCount:2};
const row={accountId:'b'.repeat(64),name:'Legacy racer',timeMs:1234,rank:7,rp:42,submittedAt:1600000000000};
const board=entries=>({period,entries,archived:true,complete:true,updatedAt:1700000000000});
const nativeFixture=vm.runInNewContext(integration.slice(integration.indexOf('function nativeFixture('),integration.indexOf("test('native non-final")).replace('document, selectedGhosts,', 'decorateArchivedReplayUnavailable, document, selectedGhosts,')+';nativeFixture;',
  {...client,vm,archivePeriodCounts,archiveSnapshotState,section,period,row});
const tableFixture=vm.runInNewContext(tableTests.slice(tableTests.indexOf('class TestNode'),tableTests.indexOf("test('archive month"))+';archiveFixture;');

function descendants(node,predicate){return node.children.flatMap(child=>[...(predicate(child)?[child]:[]),...descendants(child,predicate)]);}
function table(entries,cached=true){
  const {root}=tableFixture(),saved=board(entries),snapshots=new Map(cached?[[period.id,saved]]:[]);
  root.querySelectorAll=()=>descendants(root,node=>node.dataset.archiveEventId);
  let notify,disconnected=false;
  class MutationObserver{
    constructor(callback){notify=callback;}
    observe(){}
    disconnect(){disconnected=true;}
  }
  const observe=vm.runInNewContext(section('export function observeArchiveReplayLabels(', 'export function decorateEventRowPresentation(').replace('export function','function')+';observeArchiveReplayLabels;',
    {MutationObserver,archivePeriodCounts,decorateArchivedReplayUnavailable:client.decorateArchivedReplayUnavailable});
  mountArchiveView(root,{periods:[period],snapshots,loadSnapshot:async()=>saved});
  const card=root.querySelectorAll()[0];
  card.querySelectorAll=()=>descendants(card,node=>node.tagName==='LI');
  const observer=observe(root,[period],snapshots);
  return {root,card,saved,snapshots,notify:()=>notify(),observer,disconnected:()=>disconnected};
}

test('archive table labels only the exact boolean flag, preserving tied normal rows and saved fields',()=>{
  for(const flag of [true,false,undefined,'true',1,null]){
    const entries=[{...row,replayUnavailable:flag},{...row,accountId:'c'.repeat(64),name:'Normal racer',rp:41}],before=structuredClone(entries);
    const f=table(entries),items=f.card.querySelectorAll();
    assert.equal(items.length,2);
    assert.equal(items[0].textContent.includes('Replay unavailable'),flag===true);
    assert.equal(items[1].textContent.includes('Replay unavailable'),false);
    assert.equal(items[0].children[0].textContent,'#'+archivePeriodCounts(period,f.saved).verifiedEntries[0].rank);
    assert.equal(items[0].children[2].textContent,'0:01.234');
    assert.equal(items[0].children[3].textContent,'42 RP');
    f.notify();f.notify();
    const labels=descendants(items[0],node=>node.textContent==='Replay unavailable');
    assert.equal(labels.length,flag===true?1:0);
    if(flag===true)assert.match(labels[0].title,/saved archived finish.*not indicate new verification/);
    assert.deepEqual(entries,before);
    f.observer.disconnect();assert.equal(f.disconnected(),true);
  }
});

test('archive table labels lazily loaded standings through the client observer',async()=>{
  const f=table([{...row,replayUnavailable:true}],false);
  f.card.open=true;f.card.emit('toggle');
  await new Promise(resolve=>setTimeout(resolve,0));f.notify();
  assert.match(f.card.querySelectorAll()[0].textContent,/Replay unavailable/);
});

test('native archived rows retain rank, date and ERP, with exact-flag label and no replay selection',()=>{
  for(const flag of [true,false,undefined,'true',1,null]){
    const saved=board([{...row,replayUnavailable:flag}]),before=structuredClone(saved),f=nativeFixture(saved);
    f.sync();const button=f.rendered[0];
    assert.equal(button.status.textContent.includes('Replay unavailable'),flag===true);
    assert.equal(button.attributes['aria-disabled'],String(flag===true));
    assert.equal(button.tabIndex,flag===true?-1:0);
    assert.equal(typeof button.onclick,flag===true?'undefined':'function');
    assert.equal(button.value.rank,7);
    assert.equal(button.status.childNodes[0].textContent,'42 ERP');
    assert.match(button.status.dataset.sqNativeDate,/2020/);
    assert.deepEqual(saved,before);
    if(flag===true)assert.doesNotMatch(button.title,/Select this/);
  }
});

test('native archive rerenders when only replay availability changes',()=>{
  const f=nativeFixture(board([{...row}]));f.sync();const signature=f.view.signature;
  f.view.snapshot.entries[0].replayUnavailable=true;f.sync();
  assert.notEqual(f.view.signature,signature);
  assert.match(f.rendered.at(-1).status.textContent,/Replay unavailable/);
});

test('archive decorator is wired and disconnected on navigation and close; live row rendering stays unchanged',()=>{
  assert.match(section('  async function archives(', '  let nativeView='),/__sqArchiveReplayLabels=observeArchiveReplayLabels/);
  assert.match(section('  function close(', '  function shell('),/__sqArchiveReplayLabels\?\.disconnect/);
  assert.match(section('  function selectView(', '  async function open('),/__sqArchiveReplayLabels\?\.disconnect/);
  const live=section('  function syncNativeBoard(', '  function syncFinishPlace(');
  assert.doesNotMatch(live,/decorateArchivedReplayUnavailable|replayUnavailable/);
});