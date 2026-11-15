import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {createStaticStandingsPreview,createEventPbPreviews,eventSnapshotFields,eventPendingRows,eventPreviewPlacementPresentation,eventOwnPlacementPresentation} from './client.mjs';
const id=n=>n.toString(16).padStart(64,'0');
const period={id:'w_20261109',kind:'weekly',trackId:id(99),startsAt:100,endsAt:1000};
const board={period,updatedAt:500,fieldSize:2,rows:[[id(1),2000,1],[id(2),3000,2]]};
const artifact={schemaVersion:1,directory:'public-snapshots88',boards:[board]};
const make=(fetcher=async()=>Response.json(artifact))=>{let directory='public-snapshots88',changes=0,calls=0;const preview=createStaticStandingsPreview({directory:()=>directory,fetcher:async(...args)=>{calls++;return fetcher(...args);},onChange:()=>changes++});return {preview,set:value=>directory=value,calls:()=>calls,changes:()=>changes};};
test('one eager static request supplies exact own placement for every saved row, never award proof',async()=>{
 const h=make(async(url,options)=>{assert.match(url,/events\/standings-preview.json/);assert.equal(new URL(url).searchParams.get('snapshot'),'public-snapshots88');assert.equal(options.credentials,'same-origin');return Response.json(artifact);});
 await Promise.all([h.preview.load(),h.preview.load()]);assert.equal(h.calls(),1);assert.equal(h.changes(),1);
 for(const [account,time,rank]of board.rows){const row=h.preview.get(period,account,time);assert.equal(row.cachedPlacement.rank,rank);assert.equal(row.cachedPlacement.fieldSize,2);assert.equal(row.rank,null);assert.equal(row.verified,false);assert.equal(row.eventRpEligible,false);assert.equal(row.replayHash,undefined);assert.match(eventPreviewPlacementPresentation(row).title,/saved complete standings/);}
});
for(const change of [{id:'w_20261116'},{trackId:id(98)},{kind:'daily'},{startsAt:101},{endsAt:1001}])test('period invalidation '+JSON.stringify(change),async()=>{const h=make();await h.preview.load();assert.equal(h.preview.get({...period,...change},id(1),2000),null);});
test('PB mismatch or missing account cannot borrow a saved rank',async()=>{const h=make();await h.preview.load();assert.equal(h.preview.get(period,id(1),1999),null);assert.equal(h.preview.get(period,id(3)),null);});
test('directory change invalidates loaded and in-flight previews',async()=>{
 let resolve;const h=make(()=>new Promise(done=>resolve=done));const pending=h.preview.load();await Promise.resolve();h.set('public-snapshots89');resolve(Response.json(artifact));await pending;assert.equal(h.preview.get(period,id(1)),null);assert.equal(h.changes(),0);
});
test('preview failure leaves no fictional placement and is shared without a fetch loop',async()=>{const h=make(async()=>{throw Error('offline');});await h.preview.load();await h.preview.load();assert.equal(h.calls(),1);assert.equal(h.preview.get(period,id(1)),null);assert.equal(h.changes(),1);});
for(const value of [{...artifact,directory:'public-snapshots87'},{...artifact,schemaVersion:2},{...artifact,boards:[{...board,fieldSize:3}]},{...artifact,boards:[{...board,rows:[[id(1),2000,2],[id(2),3000,1]]}]}])test('malformed preview fails closed '+JSON.stringify(value).slice(0,95),async()=>{const h=make(async()=>Response.json(value));await h.preview.load();assert.equal(h.preview.get(period,id(1)),null);});
test('actual card integration uses static PB only for the same PB, rejects past periods and does not display loading text',async()=>{
 const source=await fs.readFile(new URL('./client.mjs',import.meta.url),'utf8');const h=make();await h.preview.load();let local=null;
 const c={standingsPreview:h.preview,cache:new Map(),pbPreviews:createEventPbPreviews(),bridge:{accountId:()=>id(1),snapshotOnly:()=>true,normalEventSnapshotEpoch:()=>0},ownReceipts:new Map(),localBest:()=>local,read:()=>null,STORE:'events',eventSnapshotFields,eventPendingRows,displayName:r=>r.name||'You',now:()=>500,validEventTimestamp:()=>false,eventOwnPlacementPresentation,eventPreviewPlacementPresentation,displayedRecordPlacement:()=>null,time:String};vm.createContext(c);
 for(const [a,b]of [['  function eventDisplayRows(','  function syncNativeArchiveBoard('],['  function recordMarkup(','  function cardStandings(']])vm.runInContext(source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a))),c);
 assert.match(c.recordMarkup(period),/2000.*1\/2/);assert.doesNotMatch(c.recordMarkup(period),/Loading standings/);
 local={accountId:id(1),timeMs:1900};assert.match(c.recordMarkup(period),/1900/);assert.doesNotMatch(c.recordMarkup(period),/1\/2|Loading standings/);
 assert.doesNotMatch(c.recordMarkup({...period,id:'w_20261116'}),/1\/2|Loading standings/);
 local=null;c.cache.set(period.id,{period,updatedAt:600,complete:true,totalEntries:0,entries:[]});
 assert.doesNotMatch(c.recordMarkup(period),/1\/2|2000/,'complete newer board cannot resurrect missing static PB');
});
test('generated artifact is current-directory bound, display-only, and resolves every captured row',async()=>{
 const artifact=JSON.parse(await fs.readFile(new URL('./standings-preview.json',import.meta.url),'utf8'));
 const pointer=JSON.parse(await fs.readFile(new URL('../snapshot-current.json',import.meta.url),'utf8'));
 assert.equal(artifact.directory,pointer.currentdir);const preview=createStaticStandingsPreview({directory:()=>pointer.currentdir,fetcher:async()=>Response.json(artifact)});await preview.load();for(const board of artifact.boards)for(const [account,time,rank]of board.rows){const own=preview.get(board.period,account,time);assert.equal(own.cachedPlacement.rank,rank);assert.equal(own.cachedPlacement.fieldSize,board.fieldSize);}
 assert.ok(artifact.boards.every(board=>board.rows.every(row=>row.length===3)));
});

test('private board validates and sorts once across repeated account and PB lookups',async()=>{
 const h=make();await h.preview.load();const original=Array.prototype.sort;let sorts=0;
 try{Array.prototype.sort=function(...args){sorts++;return original.apply(this,args);};
  for(let i=0;i<100;i++){assert.equal(h.preview.get(period,id(1),2000).cachedPlacement.rank,1);assert.equal(h.preview.get(period,id(2),3000).cachedPlacement.rank,2);assert.equal(h.preview.get(period,id(1),1999),null);}
 }finally{Array.prototype.sort=original;}
 assert.equal(sorts,1);
});
test('preview growth keeps only newest four per kind and exposes omitted whole boards',async()=>{
 const {selectEventStandingsPreview}=await import('../tools/build-event-standings-preview.mjs');
 const boards=['daily','weekly','kodub'].flatMap(kind=>Array.from({length:300},(_,i)=>({...board,period:{...period,id:kind+'-'+i,kind,endsAt:1000+i}})));
 const selected=selectEventStandingsPreview(boards,{directory:'public-snapshots88'});
 assert.equal(selected.boards.length,12);assert.equal(selected.omittedCount,888);
 for(const kind of ['daily','weekly','kodub'])assert.deepEqual(selected.boards.filter(b=>b.period.kind===kind).map(b=>b.period.endsAt),[1299,1298,1297,1296]);
 const bytes=JSON.stringify(selected);assert.equal(JSON.stringify(selectEventStandingsPreview([...boards].reverse(),{directory:'public-snapshots88'})),bytes,'stable selection independent of enumeration order');
});
test('preview byte budget omits whole older boards, never truncates rows or invents places',async()=>{
 const {selectEventStandingsPreview}=await import('../tools/build-event-standings-preview.mjs');
 const newer={...board,period:{...period,id:'new',endsAt:2000}},older={...board,period:{...period,id:'old',endsAt:1000}};
 const one=selectEventStandingsPreview([newer],{directory:'public-snapshots88',omittedCount:1});
 const budget=Buffer.byteLength(JSON.stringify(one)+'\n');
 const result=selectEventStandingsPreview([older,newer],{directory:'public-snapshots88',maxBytes:budget});
 assert.equal(result.boards.length,1);assert.equal(result.omittedCount,1);assert.equal(result.boards[0],newer);assert.equal(result.boards[0].rows,board.rows);
});
test('builder still throws on corrupt bound event payload before writing preview',async()=>{
 const {buildEventStandingsPreview}=await import('../tools/build-event-standings-preview.mjs');
 const {tmpdir}=await import('node:os');const path=await import('node:path');const root=await fs.mkdtemp(path.join(tmpdir(),'event-preview-corrupt-'));
 await fs.mkdir(path.join(root,'public-snapshots88'));await fs.writeFile(path.join(root,'snapshot-current.json'),JSON.stringify({currentdir:'public-snapshots88'}));
 const filename='a'.repeat(64)+'.bin';await fs.writeFile(path.join(root,'public-snapshots88',filename),'corrupt');
 await fs.writeFile(path.join(root,'public-snapshots88','index.json'),JSON.stringify({schemaVersion:1,generation:88,encoding:'gzip-xor-a7-v1',files:{'events/w_20261109.json':{path:filename,sha256:'a'.repeat(64),decodedBytes:20}}}));
 await assert.rejects(buildEventStandingsPreview(root),/digest mismatch/);
});
