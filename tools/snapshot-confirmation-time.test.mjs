import test from 'node:test';
import assert from 'node:assert/strict';
import {snapshotConfirmationTime} from './snapshot-confirmation-time.mjs';
import {createPublicSnapshotReader} from './public-snapshot-client.mjs';
import {buildTrackSnapshotPaging,buildOverallSnapshotPaging,buildBoardPageManifest} from './track-snapshot-paging.mjs';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';

const id='a'.repeat(64),changed=1000,checked=2000;
const track={trackId:id,updatedAt:changed,revision:7,complete:true,totalEntries:0,entries:[]};
const record={path:`tracks/${id}.json`,updatedAt:changed,revision:7,checkedAt:checked};
const manifest={schemaVersion:1,tracks:{[id]:record}};

test('unchanged board checks advance confirmation without changing standings',()=>{
  for(const at of [2000,3000]){
    const m={...manifest,tracks:{[id]:{...record,checkedAt:at}}};
    assert.equal(snapshotConfirmationTime('track',track,{manifest:m}),at);
    assert.equal(track.updatedAt,changed);
  }
});

test('wrong path, revision, source timestamp, missing binding and invalid check cannot reconfirm a board',()=>{
  for(const patch of [{path:null},{path:'tracks/wrong.json'},{updatedAt:999},{sourceUpdatedAt:999},
    {revision:8},{checkedAt:NaN},{checkedAt:'2000'},{checkedAt:-1},{checkedAt:999}]){
    assert.equal(snapshotConfirmationTime('track',track,{manifest:{tracks:{[id]:{...record,...patch}}}}),null);
  }
    assert.equal(snapshotConfirmationTime('track',track,{manifest:{tracks:{[id]:{checkedAt:checked}}}}),null);
});

test('bound statistics preserve exact check times without using the statistics package date',()=>{
  const statistics={revision:7,updatedAt:changed,complete:true,count:0,capturedAt:new Date(checked).toISOString()};
  assert.equal(snapshotConfirmationTime('track',track,{statistics}),checked);
  for(const patch of [{revision:8},{updatedAt:999},{count:1},{complete:false},{capturedAt:null}])
    assert.equal(snapshotConfirmationTime('track',track,{statistics:{...statistics,...patch}}),null);
});

test('all Overall shapes use the precise bound capture, never global export or hydration dates',()=>{
  const board={updatedAt:changed,revision:7,complete:true,totalEntries:0,entries:[]};
  const m={tracks:{},overall:{path:'overall.json',revision:7,updatedAt:changed},
    overallCapture:{publishedRevision:7,source:'authenticated-published-overall',readTime:'2026-10-27T13:03:05.188938Z',metadataDirty:true}};
  const paging=buildOverallSnapshotPaging(board,{capturedAt:'2026-10-27T12:50:09.219Z'});
  for(const [kind,value] of [['overall',board],['overall-preview',paging.preview],
    ['overall-manifest',buildBoardPageManifest(board,paging.preview,true)]]){
    assert.equal(snapshotConfirmationTime(kind,value,{manifest:m}),Date.parse(m.overallCapture.readTime));
    assert.equal(value.updatedAt,changed);
    assert.equal(snapshotConfirmationTime(kind,value),null);
    assert.equal(snapshotConfirmationTime(kind,value,{manifest:{...m,overall:{...m.overall,revision:8}}}),null);
  }
});

test('published Overall catalogs do not substitute for current source-catalog validation',()=>{
  const m={...manifest,overallCapture:{publishedRevision:7,readTime:new Date(9000).toISOString()},
    trackCatalog:[{trackId:id,updatedAt:changed}]};
  assert.equal(snapshotConfirmationTime('track',track,{manifest:m}),checked);
});

test('event confirmation binds path and standings timestamp independently',()=>{
  const board={id:'d_test',updatedAt:changed,entries:[]};
  const m={events:{d_test:{path:'events/d_test.json',updatedAt:changed,checkedAt:checked}}};
  assert.equal(snapshotConfirmationTime('event',board,{manifest:m}),checked);
  assert.equal(snapshotConfirmationTime('event',{...board,updatedAt:3000},{manifest:m}),null);
  assert.equal(board.updatedAt,changed);
});

test('checked empty event can have a known confirmation while its standings-change timestamp stays zero',async()=>{
  const board={id:'d_empty',updatedAt:0,entries:[]};
  const metadata={schemaVersion:1,tracks:{},events:{d_empty:{path:'events/d_empty.json',updatedAt:0,checkedAt:checked}}};
  assert.equal(snapshotConfirmationTime('event',board,{manifest:metadata}),checked);
  const f=readerFixture({'manifest.json':metadata,'events/d_empty.json':board});
  const result=await f.read('event','d_empty');
  assert.equal(result._snapshotCapturedAt,checked);assert.equal(result.updatedAt,0);
  for(const updatedAt of [-1,0.5,'0',null,undefined])
    assert.equal(snapshotConfirmationTime('event',{...board,updatedAt},{manifest:metadata}),null);
});

test('paged tracks retain their specific check time with unchanged standings',()=>{
  const {preview}=buildTrackSnapshotPaging(track,{capturedAt:checked});
  assert.equal(snapshotConfirmationTime('track-preview',preview),checked);
  assert.equal(preview.updatedAt,changed);
});

function readerFixture(files,{packed=false,now=()=>9000}={}){
  const calls=[];
  const read=createPublicSnapshotReader({baseUrl:'https://example.test/public-snapshots68/',packed,now,
    fetchImpl:async url=>{
      const path=new URL(url).pathname.split('/public-snapshots68/')[1];calls.push(path);
      const value=typeof files[path]==='function'?files[path]():files[path];
      return value?Response.json(value):new Response('',{status:404});
    }});
  return {read,calls};
}

test('local hydration, repeat reads and failed refreshes never advance the source confirmation',async()=>{
  let now=9000,fail=false;
  const f=readerFixture({'manifest.json':manifest,[record.path]:()=>fail?null:track},{now:()=>now});
  const first=await f.read('track',id);assert.equal(first._snapshotCapturedAt,checked);
  now+=600001;fail=true;
  const cached=await f.read('track',id);
  assert.equal(cached._snapshotCapturedAt,checked);assert.equal(cached.updatedAt,changed);
});

test('reader exposes event check time and shares the same-origin metadata request',async()=>{
  const f=readerFixture({'manifest.json':{...manifest,events:{d_test:{path:'events/d_test.json',updatedAt:changed,checkedAt:checked}}},
    'events/d_test.json':{id:'d_test',updatedAt:changed,entries:[]}});
  const [a,b]=await Promise.all([f.read('event','d_test'),f.read('event','d_test')]);
  assert.equal(a,b);assert.equal(a._snapshotCapturedAt,checked);assert.equal(a.updatedAt,changed);
  assert.equal(f.calls.filter(path=>path==='manifest.json').length,1);
});

test('missing metadata does not invent a confirmation from updatedAt or the local clock',async()=>{
  const f=readerFixture({[record.path]:track});
  assert.equal((await f.read('track',id))._snapshotCapturedAt,undefined);
});

test('snapshot 68 packaged Overall, track and event clocks reflect their own confirmation evidence',async()=>{
  const root=new URL('../public-snapshots68/',import.meta.url);
  const index=JSON.parse(readFileSync(new URL('index.json',root)));
  const decode=logical=>{
    const bytes=readFileSync(new URL(index.files[logical].path,root));
    for(let i=0;i<bytes.length;i++)bytes[i]^=0xa7;
    return JSON.parse(gunzipSync(bytes));
  };
  const metadata=decode('manifest.json');
  const read=createPublicSnapshotReader({baseUrl:'https://example.test/public-snapshots68/',packed:true,now:()=>Date.UTC(2030,0,1),
    fetchImpl:async url=>{
      const name=new URL(url).pathname.split('/public-snapshots68/')[1];
      return new Response(readFileSync(new URL(name,root)));
    }});
  for(const [kind,id,page] of [['overall'],['overall-preview'],['overall-manifest'],['overall-page','',1]]){
    const board=await read(kind,id,page);
    assert.ok(board);
    assert.equal(board._snapshotCapturedAt,Date.parse(metadata.overallCapture.readTime));
    assert.equal(board.updatedAt,metadata.overall.updatedAt);
  }
  const [trackId,trackRecord]=Object.entries(metadata.tracks).find(([,row])=>row.path&&row.checkedAt&&index.files[row.path]);
  for(const kind of ['track','track-preview','track-manifest']){
    const board=await read(kind,trackId);
    assert.ok(board);
    assert.equal(board._snapshotCapturedAt,trackRecord.checkedAt);
    assert.equal(board.updatedAt,trackRecord.updatedAt);
  }
  const [eventId,eventRecord]=Object.entries(metadata.events).find(([,row])=>row.path&&row.checkedAt&&index.files[row.path]);
  const event=await read('event',eventId);
  assert.equal(event._snapshotCapturedAt,eventRecord.checkedAt);
  assert.equal(event.updatedAt,eventRecord.updatedAt);
});

test('Event RP totals use only their own confirmation, never unrelated package time',async()=>{
 assert.equal(snapshotConfirmationTime('event-totals',{updatedAt:1000,capturedAt:new Date(2000).toISOString()}),2000);
 for(const capturedAt of [undefined,'invalid',new Date(999).toISOString()])assert.equal(snapshotConfirmationTime('event-totals',{updatedAt:1000,capturedAt},{manifest:{capturedAt:new Date(9000).toISOString()}}),null);
 const read=createPublicSnapshotReader({baseUrl:'https://example.test/',fetchImpl:async url=>{assert.ok(String(url).endsWith('/event-totals.json'));return Response.json({updatedAt:1000,capturedAt:new Date(2000).toISOString(),entries:[]});}});
 assert.equal((await read('event-totals'))._snapshotCapturedAt,2000);
});
