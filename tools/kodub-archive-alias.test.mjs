import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const read=name=>JSON.parse(fs.readFileSync(new URL('../events/kodub/'+name,import.meta.url),'utf8'));
const selections=read('selections.json'),trusted=read('trusted-tracks.json'),history=read('history.json');
const aliases=selections.map(row=>{
  const trust=trusted.find(item=>item.trackId===row.trackId);assert.ok(trust);
  return {id:'kodub-'+row.trackId,trackId:row.trackId,name:row.name,source:'Kodub weekly',archiveImport:true,codeHash:trust.codeHash,trackPath:'events/kodub/'+trust.assetPath};
});
const A='a'.repeat(64),legacy={id:'legacy-extra',trackId:A,name:'Legacy Extra',trackPath:'extra-tracks/track-data/test/test.track'};
const challenge={id:'challenge',trackId:'b'.repeat(64),name:'Challenge',ranked:false,trackPath:'extra-tracks/challenges/test.track'};
function extract(name){const start=source.search(new RegExp('^  (?:async )?function '+name+'\\(','m'));assert.ok(start>=0,name);return source.slice(start,source.indexOf('\n  }',start)+4);}
function catalogFixture(rows){
  const calls=[],c=vm.createContext({URL,AbortSignal,extraTracksCatalogPromise:null,extraTracksBaseUrl:new URL('https://offline.test/project/extra-tracks/'),
    eventsModuleUrl:new URL('https://offline.test/project/events/events.mjs'),extraCatalogRevision:'224',unrankedExtraTrackIds:new Set(),extraTrackInfoById:new Map(),
    kodubTrackHistory:new Map(),kodubHistoryLoad:null,nativeWeeklySelection:null,TRACK_CATALOG:new Map(),LEGACY_TRACK_CATALOG:new Map(),
    document:{querySelectorAll:()=>[]},eventRequestSignal:()=>AbortSignal.timeout(4000),
    fetch:async(url,options)=>{calls.push({url:String(url),method:options?.method||'GET'});const path=new URL(url).pathname;
      const value=path.endsWith('/extra-tracks/catalog.json')?rows:path.endsWith('/events/kodub/history.json')?history:path.endsWith('/events/kodub/trusted-tracks.json')?trusted:assert.fail('Non-static read: '+url);
      return {ok:true,json:async()=>value};}});
  vm.runInContext(extract('loadKodubTrackHistory')+'\n'+extract('trackInfo')+'\n'+extract('loadExtraTracksCatalog'),c);
  return {c,calls};
}

test('all eight aliases load canonical history before catalog delivery without extra or unranked classification',async()=>{
  const {c,calls}=catalogFixture([...aliases,legacy,challenge]);const pending=c.loadExtraTracksCatalog();
  const joined=c.loadExtraTracksCatalog();
  const rows=await pending;assert.equal(await joined,rows);assert.equal(rows.length,aliases.length+2);
  for(const alias of aliases){const info=c.trackInfo(alias.trackId);assert.equal(info.name,alias.name);assert.equal(info.type,'custom');assert.equal(info.source,'kodub');
    assert.equal(c.extraTrackInfoById.has(alias.trackId),false);assert.equal(c.unrankedExtraTrackIds.has(alias.trackId),false);}
  assert.equal(c.extraTrackInfoById.get(legacy.trackId).type,'extra');assert.equal(c.unrankedExtraTrackIds.has(challenge.trackId),true);
  assert.equal(c.extraTrackInfoById.size,2);assert.equal(calls.length,3);assert.ok(calls.every(call=>call.method==='GET'&&call.url.startsWith('https://offline.test/project/')));
});

test('catalog rejects mismatched paths, hashes, flags, identities and sources without globally downgrading old Kodub rows',async()=>{
  const base=aliases[0];const changes=[{source:'Other'},{archiveImport:false},{archiveImport:'true'},{codeHash:A},{codeHash:'INVALID'},
    {trackPath:'https://foreign.test/events/kodub/assets/'+base.codeHash+'.track'},{trackPath:'events/kodub/assets/../'+base.codeHash+'.track'},
    {trackPath:base.trackPath+'?x=1'},{trackPath:base.trackPath+'#x'},{trackPath:'extra-tracks/challenges/fake.track'},
    {trackId:'invalid'},{id:'../bad'},{ranked:false},{unranked:true}];
  for(const change of changes){const {c}=catalogFixture([{...base,...change}]);assert.equal((await c.loadExtraTracksCatalog()).length,0,JSON.stringify(change));assert.equal(c.unrankedExtraTrackIds.size,0);assert.equal(c.extraTrackInfoById.size,0);}
  const {c}=catalogFixture([{...base,archiveImport:undefined,ranked:false,trackPath:'extra-tracks/challenges/old-kodub.track'}]);
  assert.equal((await c.loadExtraTracksCatalog()).length,0);assert.equal(c.unrankedExtraTrackIds.size,0);
});

function importFixture(entry=aliases[0],{raw,decodedId=entry.trackId,historyHash=entry.codeHash}={}){
  const events=[],writes=[],known={};let current=true,closed=0;
  const code=raw??fs.readFileSync(new URL('../'+entry.trackPath,import.meta.url),'utf8');
  const field={value:'',dispatchEvent:event=>events.push(event.type)};
  const dialog={isConnected:true,querySelector:()=>field,querySelectorAll:()=>[confirm]};
  const confirm={querySelector:()=>({}),click:()=>{events.push('confirm');dialog.isConnected=false;}};
  const button={querySelector:()=>({}),click:()=>events.push('native-import')};
  const c=vm.createContext({URL,AbortSignal,Headers,Event,TextEncoder,crypto:webcrypto,
    extraTracksBaseUrl:new URL('https://offline.test/project/extra-tracks/'),kodubTrackHistory:new Map(),
    loadKodubTrackHistory:async()=>{events.push('history');c.kodubTrackHistory.set(entry.trackId,{codeHash:historyHash});},
    fetch:async(url,options)=>{events.push('GET '+url);assert.equal(options.method,undefined);return{ok:true,headers:new Headers(),text:async()=>code};},
    __pt062WebpackRequire:()=>()=>({A:{fromExportString:value=>{events.push('decode');assert.equal(value,code.trim());return{trackData:{getId:()=>decodedId},trackMetadata:{name:entry.name}};}}}),
    extraTrackIds:()=>known,extraTrackIdsKey:'known',extraTrackKnownIds:{},localStorage:{setItem:(...args)=>writes.push(args)},
    extraTracksUi:{close:()=>closed++},volatileLeaderboardCache:new Map(),jsonStorageCache:new Map(),
    storageModule:{reserveTrackSpace:()=>events.push('reserve')},document:{querySelector:selector=>selector.includes('track-export-ui')?dialog:null,querySelectorAll:selector=>selector.includes('track-title')?[]:[button]}});
  const anchor="await import(new URL('../tools/track-import-storage.mjs?v=133',eventsModuleUrl).href)";
  const body=extract('importExtraTrack');assert.equal(body.split(anchor).length,2);
  vm.runInContext(extract('sha256Hex')+'\n'+body.replace(anchor,'await Promise.resolve(storageModule)'),c);
  return {c,events,writes,known,field,closed:()=>closed,options:{isCurrent:()=>current},cancel:()=>current=false};
}

test('archive native import validates raw asset hash and decoded canonical ID before the existing import handoff',async()=>{
  const alias=aliases.find(row=>row.name==='Hydropower');assert.ok(alias);
  const f=importFixture(alias);await f.c.importExtraTrack(alias,f.options);
  assert.deepEqual(f.events.slice(0,3),['history','GET https://offline.test/project/'+alias.trackPath,'decode']);
  assert.ok(f.events.includes('native-import'));assert.ok(f.events.includes('confirm'));assert.equal(f.known[alias.id],alias.trackId);
  assert.equal(f.writes.length,1);assert.equal(f.closed(),1);
  assert.equal(f.field.value,fs.readFileSync(new URL('../'+alias.trackPath,import.meta.url),'utf8').trim());
});

test('archive import rejects spoofed metadata before fetching or touching native UI',async()=>{
  const alias=aliases[0];
  for(const change of [{source:'Other'},{codeHash:A},{codeHash:'invalid'},{trackId:'bad'},{ranked:false},{unranked:true},
    {trackPath:'//foreign.test/x'},{trackPath:alias.trackPath+'?x=1'},{trackPath:'events/kodub/assets/../'+alias.codeHash+'.track'},{trackPath:'extra-tracks/track-data/test/test.track'}]){
    const f=importFixture(alias);await assert.rejects(f.c.importExtraTrack({...alias,...change},f.options),/unavailable/);assert.deepEqual(f.events,[]);assert.equal(f.writes.length,0);
  }
  const f=importFixture(alias,{historyHash:A});await assert.rejects(f.c.importExtraTrack(alias,f.options),/saved weekly history/);assert.deepEqual(f.events,['history']);
});

test('tampered bytes and a different decoded identity cannot reach the native importer',async()=>{
  const alias=aliases[0];
  const tampered=importFixture(alias,{raw:'PolyTrack123'});await assert.rejects(tampered.c.importExtraTrack(alias,tampered.options),/content hash/);
  assert.ok(!tampered.events.includes('decode'));assert.equal(tampered.writes.length,0);
  const wrong=importFixture(alias,{decodedId:A});await assert.rejects(wrong.c.importExtraTrack(alias,wrong.options),/no longer matches/);
  assert.ok(!wrong.events.includes('native-import'));assert.equal(wrong.writes.length,0);
});

test('stale archive imports stop after history loading without asset or native UI work',async()=>{
  const alias=aliases[0],f=importFixture(alias),pending=f.c.importExtraTrack(alias,f.options);f.cancel();await pending;
  assert.deepEqual(f.events,['history']);assert.equal(f.writes.length,0);
});

test('canonical archive PB display reads existing snapshot/local rows, never the unranked bucket or network',()=>{
  const c=vm.createContext({extraTrackKnownIds:{},activeRankedAccountId:()=> 'racer',readJsonStorage:()=>assert.fail('Unranked bucket read'),
    unrankedExtraBestKey:'unranked',extraTrackRaceRows:[],cleanUserId:x=>x,canonicalRaceTimeMs:row=>row.timeMs,
    readTrackSnapshotCache:()=>({entries:[{accountId:'racer',timeMs:12345,rank:3},{accountId:'other',timeMs:1000,rank:1}]})});
  vm.runInContext(extract('extraTrackPersonalBest'),c);
  for(const alias of aliases){const best=c.extraTrackPersonalBest(alias);assert.equal(best.timeMs,12345);assert.equal(best.place,3);}
  c.extraTrackRaceRows=[{accountId:'racer',trackId:aliases[0].trackId,timeMs:12000}];
  assert.equal(c.extraTrackPersonalBest(aliases[0]).timeMs,12000);
});

test('archive bridge does not alter existing upload, event admission or Extra completion-count gates',()=>{
  const gate=extract('localExtraTrackCount');assert.match(gate,/extraTrackInfoById.has\(trackId\)/);
  for(const name of ['loadExtraTracksCatalog','importExtraTrack','extraTrackPersonalBest'])assert.doesNotMatch(extract(name),/firebase|rankedFetch\(|queueCosmetic|mirrorRaceResult\(|sendRankedNotification\(/i);
});


test('imported canonical aliases do not increase device-local Extra completion totals',async()=>{
  const {c}=catalogFixture([...aliases,legacy]);await c.loadExtraTracksCatalog();
  const known=Object.fromEntries([...aliases,legacy].map(row=>[row.id,row.trackId]));
  Object.assign(c,{cleanUserId:x=>x,activeRankedAccountId:()=> 'racer',extraTrackIds:()=>known,localRaceGeneration:1,localExtraProgressCache:{key:'',count:0},
    readLocalRaceRows:()=>[...aliases,legacy].map(row=>({accountId:'racer',trackId:row.trackId,timeMs:1000})),canonicalRaceTimeMs:row=>row.timeMs});
  vm.runInContext(extract('localExtraTrackCount'),c);
  assert.equal(c.localExtraTrackCount({userId:'racer'}),1,'only the ordinary Extra entry counts');
});

test('the current eight-row catalog uses only canonical trusted archive aliases',async()=>{
  const catalog=JSON.parse(fs.readFileSync(new URL('../extra-tracks/catalog.json',import.meta.url),'utf8'));
  const weekly=catalog.filter(row=>row.source==='Kodub weekly');assert.equal(weekly.length,aliases.length);
  for(const row of weekly){assert.equal(row.archiveImport,true,row.name);assert.notEqual(row.ranked,false,row.name);assert.notEqual(row.unranked,true,row.name);assert.equal(row.trackPath,'events/kodub/assets/'+row.codeHash+'.track');}
  const {c}=catalogFixture(catalog),loaded=await c.loadExtraTracksCatalog();
  for(const row of weekly){assert.ok(loaded.some(entry=>entry.trackId===row.trackId));assert.equal(c.extraTrackInfoById.has(row.trackId),false);assert.equal(c.unrankedExtraTrackIds.has(row.trackId),false);}
});
