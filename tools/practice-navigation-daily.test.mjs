import createClientSourceRunner from './client-source-harness.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto,createHash} from 'node:crypto';
import {readKodubPracticeTrack} from './kodub-practice-track.mjs';
import {eventVerificationLabel} from '../events/client.mjs';
const patch=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const runClientSource=createClientSourceRunner(patch);
const id='60e247f90d43ecaa8b56a4677307094ab0259f36151af23e09fdc824741d3e48';
const extract=name=>{const start=patch.search(new RegExp('  (?:async )?function '+name+'\\('));assert.ok(start>=0,name);return patch.slice(start,patch.indexOf('\n  }',start)+4);};
const assets=new URL('../events/kodub/',import.meta.url);
const record=JSON.parse(fs.readFileSync(new URL('trusted-tracks.json',assets),'utf8')).find(row=>row.trackId===id);
const code=fs.readFileSync(new URL(record.assetPath,assets));
const target={id,codeHash:record.codeHash,trackUrl:'https://game.test/events/kodub/'+record.assetPath};
const decode=()=>({trackData:{getId:()=>id}});
const read=(overrides={})=>readKodubPracticeTrack(target,{crypto:webcrypto,baseUrl:'https://game.test/events/client.mjs',decode,fetcher:async()=>new Response(code),...overrides});
test('saved Spite content hash matches manifest and native decoded track ID is required',async()=>{
 assert.equal(createHash('sha256').update(code).digest('hex'),record.codeHash);
 assert.equal(await read(),code.toString().trim());
 await assert.rejects(read({decode:()=>({trackData:{getId:()=> 'f'.repeat(64)}})}),/does not match/);
 await assert.rejects(read({fetcher:async()=>new Response('PolyTrack1WRONG')}),/integrity/);
});
test('weekly import rejects oversized streams, foreign origin, and late cancelled reads',async()=>{
 await assert.rejects(read({fetcher:async()=>new Response(new Uint8Array(262145))}),/too large/);
 await assert.rejects(readKodubPracticeTrack({...target,trackUrl:'https://wrong.test/'+record.assetPath},{baseUrl:'https://game.test/',fetcher:()=>{throw Error('Unexpected network');}}),/same-origin/);
 assert.equal(await read({isCurrent:()=>false}),null);
});
function navigation(overrides={}){
 const notices=[],listeners=new Map();let imports=0;
 const context={Map,Error,String,Date,Promise,setTimeout:fn=>{fn();},activeRankedAccountId:()=> 'account',eventUi:{leave(){}},eventTrackReturnContext:null,eventTrackReturnEpoch:0,localInsights:null,warmPracticeTrack(){},loadKodubTrackHistory:async()=>{},trackInfo:()=>({type:'official',name:'Missing'}),nativeWeeklySelection:null,kodubTrackHistory:new Map(),document:{addEventListener:(type,fn)=>listeners.set(type,fn),removeEventListener:type=>listeners.delete(type),getElementById:()=>null,querySelector:()=>null,querySelectorAll:()=>[]},closeOverallPanel(){},log(){},showRankedTrackNavigationError:value=>notices.push(value),...overrides};
 const navigationSource=extract('focusTrackFromRanked');
 const focus=navigationSource.replace(/await import\(new URL\('\.\.\/tools\/kodub-practice-track\.mjs\?v=\d+',eventsModuleUrl\)\.href\)/,'await loadTrackReader()');
 assert.notEqual(focus,navigationSource,'mock the reader module independently of the client release query');
 vm.createContext(context);runClientSource('let rankedTrackNavigationEpoch=0;'+focus,context);
 return {context,notices,listeners,imports:()=>imports};
}
test('missing track navigation resolves false with a friendly error instead of rejecting',async()=>{
 const h=navigation();assert.equal(await h.context.focusTrackFromRanked(id),false);assert.match(h.notices[0],/try again/);assert.equal(h.listeners.size,0);
});
test('Escape during history loading prevents delayed navigation and removes listeners',async()=>{
 let release;const h=navigation({trackInfo:()=>({type:'custom'}),loadKodubTrackHistory:()=>new Promise(resolve=>release=resolve)});
 const pending=h.context.focusTrackFromRanked(id);h.listeners.get('keydown')({key:'Escape'});release();assert.equal(await pending,false);assert.equal(h.notices.length,0);assert.equal(h.listeners.size,0);
});
test('history loading failure is handled for fire-and-forget callers',async()=>{
 const h=navigation({trackInfo:()=>({type:'custom'}),loadKodubTrackHistory:async()=>{throw Error('History offline');}});assert.equal(await h.context.focusTrackFromRanked(id),false);assert.equal(h.notices[0],'History offline');
});
for(const current of [true,false])test((current?'current':'archived')+' Spite practice opens its hash-bound file without any card or title lookup',async()=>{
 let imported=null,readId=null;
 const h=navigation({URL,eventsModuleUrl:'https://game.test/events/client.mjs',trackInfo:()=>({type:'custom',name:'A deliberately wrong display name'}),nativeWeeklySelection:current?{trackId:id}:null,kodubTrackHistory:new Map([[id,target]]),loadTrackReader:async()=>({readKodubPracticeTrack:async record=>{readId=record.id;return code.toString();}}),importRankedTrackCode:async value=>{imported=value;return true;}});
 assert.equal(await h.context.focusTrackFromRanked(id),true);assert.equal(readId,id);assert.equal(imported,code.toString());assert.equal(h.notices.length,0);
});
test('Summer 1 to historical Spite disposes the owned native panel before importing a new one',async()=>{
 const steps=[];let oldVisible=true,imported=0;
 const board={isConnected:true,__pt062OpponentSelection:{version:1,trackId:()=> 'a'.repeat(64)},querySelector:()=>({click(){steps.push('native Back');oldVisible=false;board.isConnected=false;}})};
 const h=navigation({URL,eventsModuleUrl:'https://game.test/events/client.mjs',isElementVisible:()=>oldVisible,trackInfo:()=>({type:'custom',name:'Spite'}),kodubTrackHistory:new Map([[id,target]]),loadTrackReader:async()=>({readKodubPracticeTrack:async()=>{steps.push('read Spite');return code.toString();}}),importRankedTrackCode:async()=>{assert.equal(board.isConnected,false);steps.push('import Spite');imported++;return true;}});
 h.context.document.querySelectorAll=selector=>selector==='.track-info-ui > .leaderboard-ui'?[board]:[];
 assert.equal(await h.context.focusTrackFromRanked(id,{source:'practice'}),true);assert.equal(imported,1);assert.deepEqual(steps,['native Back','read Spite','import Spite']);assert.equal(h.notices.length,0);
});
test('a stale native panel that cannot dispose blocks import instead of stacking track panels',async()=>{
 let imported=0;const board={isConnected:true,__pt062OpponentSelection:{version:1,trackId:()=> 'a'.repeat(64)},querySelector:()=>({click(){}})};
 const h=navigation({isElementVisible:()=>true,trackInfo:()=>({type:'official',name:'Other'}),importRankedTrackCode:async()=>{imported++;}});h.context.document.querySelectorAll=selector=>selector==='.track-info-ui > .leaderboard-ui'?[board]:[];
 assert.equal(await h.context.focusTrackFromRanked(id),false);assert.equal(imported,0);assert.match(h.notices[0],/did not close/);
});
test('cancelling during native Back disposal never resumes a delayed track import',async()=>{
 let release,imported=0;const board={isConnected:true,__pt062OpponentSelection:{version:1,trackId:()=> 'a'.repeat(64)},querySelector:()=>({click(){}})};
 const h=navigation({isElementVisible:()=>true,trackInfo:()=>({type:'official',name:'Other'}),setTimeout:resolve=>release=resolve,importRankedTrackCode:async()=>{imported++;}});h.context.document.querySelectorAll=selector=>selector==='.track-info-ui > .leaderboard-ui'?[board]:[];
 const pending=h.context.focusTrackFromRanked(id);assert.equal(typeof release,'function');h.listeners.get('keydown')({key:'Escape'});board.isConnected=false;release();assert.equal(await pending,false);assert.equal(imported,0);assert.equal(h.notices.length,0);
});
test('reopening the same native track reuses its owned panel without another import',async()=>{
 let closed=0;const board={__pt062OpponentSelection:{version:1,trackId:()=>id},querySelector:()=>({click(){closed++;}})};
 const h=navigation({isElementVisible:()=>true,trackInfo:()=>({type:'official',name:'Track'})});h.context.document.querySelectorAll=selector=>selector==='.track-info-ui > .leaderboard-ui'?[board]:[];
 assert.equal(await h.context.focusTrackFromRanked(id),true);assert.equal(closed,0);assert.equal(h.notices.length,0);
});

test('failed new navigation supersedes older pending navigation',async()=>{
 let release;const h=navigation({trackInfo:()=>({type:'custom'}),loadKodubTrackHistory:()=>new Promise(resolve=>release=resolve)});
 const first=h.context.focusTrackFromRanked(id);assert.equal(await h.context.focusTrackFromRanked('bad-id'),false);release();assert.equal(await first,false);assert.equal(h.notices.length,1);
});
test('native import fills only the importer after cancellation checks',async()=>{
 let clicks=0,opened=false,typed='';const field={set value(value){typed=value;},dispatchEvent(){}},confirm={querySelector:()=>true,click:()=>clicks++};
 const importer={querySelector:()=>true,click:()=>opened=true};const dialog={querySelector:()=>field,querySelectorAll:()=>[confirm]};
 const ctx=vm.createContext({Event,Promise,setTimeout:fn=>fn(),document:{querySelector:selector=>selector.includes('track-export-ui')?(opened?dialog:null):{classList:{contains:()=>true}},querySelectorAll:()=>[importer]}});
 runClientSource(extract('importRankedTrackCode'),ctx);assert.equal(await ctx.importRankedTrackCode(code.toString(),()=>true),true);assert.equal(clicks,1);assert.equal(typed,code.toString());
 assert.equal(await ctx.importRankedTrackCode(code.toString(),()=>false),false);assert.equal(clicks,1);
});
function events({saved=null,payload,fetcher}={}){
 let now=Date.UTC(2026,9,22,12),calls=0,resolveFetch;
 const period={id:'d_20261022',kind:'daily',trackId:'a'.repeat(64),startsAt:Date.UTC(2026,9,22),endsAt:Date.UTC(2026,9,23),maxRp:100};
 const ctx={Map,Date:class extends Date{static now(){return now;}},Number,Math,Error,Promise,URL,encodeURIComponent,eventCloudRequests:new Map(),eventCloudCache:new Map(),eventCloudRetryAt:new Map(),eventRequestSignal:()=>undefined,rankedBrokerUrl:()=> 'https://worker.test',snapshotOnlyForNewAccount:()=>true,localEventCatalog:async()=>({periods:[period],archives:[]}),readPublicSnapshotBackup:async()=>saved,noteFirebaseQuota(){},log(){},fetch:async()=>{calls++;if(fetcher)return fetcher();return {ok:true,status:200,headers:new Headers({'content-type':'application/json'}),json:async()=>payload||{period,updatedAt:now,entries:[]}};}};
 vm.createContext(ctx);
 const start=patch.indexOf('  function chooseEventReadValue('),end=patch.indexOf('  const archiveMonthReads=',start);runClientSource(patch.slice(start,end),ctx);
 return {ctx,period,calls:()=>calls,advance:value=>now+=value,read:force=>ctx.eventCloudRead('/v1/events/'+period.id+'/snapshot','0.6.2_event_public',period.id,force)};
}
test('missing current daily snapshot uses one coalesced Worker read even for a new account',async()=>{
 const h=events();const values=await Promise.all([h.read(),h.read(),h.read()]);assert.equal(h.calls(),1);assert.equal(values[0].period.id,h.period.id);assert.ok(values[0]._eventLiveCheckedAt);await h.read();assert.equal(h.calls(),1);
});
test('wrong day, track, kind or time boundaries never become confirmed live standings',async()=>{
 for(const field of ['id','trackId','kind','startsAt','endsAt']){const h=events();h.ctx.fetch=async()=>({ok:true,status:200,headers:new Headers({'content-type':'application/json'}),json:async()=>({period:{...h.period,[field]:typeof h.period[field]==='number'?h.period[field]+1:'wrong'},updatedAt:Date.now(),entries:[]})});await assert.rejects(h.read(),/not included/);await assert.rejects(h.read(),/retry paused/);}
});
test('valid static daily needs no live read and missing expired daily never requests Worker',async()=>{
 const h=events();h.ctx.readPublicSnapshotBackup=async()=>({period:h.period,updatedAt:1,entries:[]});await h.read();assert.equal(h.calls(),0);
 const expired=events();expired.advance(86400000);expired.ctx.localEventCatalog=async()=>({periods:[],archives:[]});await assert.rejects(expired.read(),/Archived/);assert.equal(expired.calls(),0);
});
test('daily 429 coalesces and honors Retry-After without a direct Firebase fallback',async()=>{
 const h=events({fetcher:async()=>({ok:false,status:429,headers:new Headers({'retry-after':'120'})})});await assert.rejects(h.read(),/rate limited/);await assert.rejects(h.read(),/retry paused/);assert.equal(h.calls(),1);h.advance(120001);await assert.rejects(h.read(),/rate limited/);assert.equal(h.calls(),2);
});
test('missing historical weekly and Kodub snapshots never request Worker',async()=>{
 for(const key of ['w_20261012','kodub_'+Date.UTC(2026,9,20)]){const h=events();await assert.rejects(h.ctx.eventCloudRead('/v1/events/'+key+'/snapshot','0.6.2_event_public',key,true),/Archived/);assert.equal(h.calls(),0);}
});
test('an explicit frozen daily stays static even when catalog and client clock say it is current',async()=>{
 const h=events(),archive={id:h.period.id,period:h.period,archived:true,updatedAt:100,entries:[]};let catalogReads=0;
 h.ctx.localEventCatalog=async()=>{catalogReads++;throw Error('must not consult catalog for frozen data');};h.ctx.readPublicSnapshotBackup=async()=>archive;
 assert.equal(await h.read(true),archive);assert.equal(h.calls(),0);assert.equal(catalogReads,0);
});
test('an immutable daily archive replaces a newer cached live board without reopening live reads',async()=>{
 const h=events();await h.read();const archive={id:h.period.id,period:h.period,archived:true,updatedAt:1,entries:[]};h.ctx.readPublicSnapshotBackup=async()=>archive;
 assert.equal(await h.read(true),archive);assert.equal(h.calls(),1,'only initial current-day load contacted Worker');
});
test('a malformed explicit archive cannot fall through to Worker or a cached live board',async()=>{
 const h=events();await h.read();h.ctx.readPublicSnapshotBackup=async()=>({id:'wrong',period:h.period,archived:true,updatedAt:1,entries:[]});
 await assert.rejects(h.read(true),/archived standings do not match/);assert.equal(h.calls(),1);
});
test('an old daily ID shifted into the current catalog time window never uses Worker',async()=>{
 const h=events(),old={...h.period,id:'d_20261021'};h.ctx.localEventCatalog=async()=>({periods:[old]});
 await assert.rejects(h.ctx.eventCloudRead('/v1/events/'+old.id+'/snapshot','0.6.2_event_public',old.id),/Archived/);assert.equal(h.calls(),0);
});
test('current daily ID with shifted dates or an archived catalog marker is not live eligible',async()=>{
 for(const change of [{startsAt:Date.UTC(2026,9,21)},{endsAt:Date.UTC(2026,9,24)},{archived:true},{enabled:false}]){const h=events();h.ctx.localEventCatalog=async()=>({periods:[{...h.period,...change}]});await assert.rejects(h.read(),/Archived/);assert.equal(h.calls(),0);}
});
test('UTC boundary helper agrees with the shared schedule and rejects a late prior-day response',async()=>{
 const {utcEventCandidates}=await import('../events/schedule.mjs');const h=events();
 for(const at of [Date.UTC(2026,9,22)-1,Date.UTC(2026,9,22),Date.UTC(2026,9,23),Date.UTC(2028,1,29,12)]){const expected=utcEventCandidates(at,['a'.repeat(64)],['a'.repeat(64),'b'.repeat(64)]).find(row=>row.kind==='daily'),actual=h.ctx.currentDailyEventPeriod(at);assert.equal(actual.id,expected.id);assert.equal(actual.startsAt,expected.startsAt);assert.equal(actual.endsAt,expected.endsAt);}
 h.ctx.fetch=async()=>{h.advance(12*3600000);return {status:200,ok:true,headers:new Headers({'content-type':'application/json'}),json:async()=>({period:h.period,updatedAt:1,entries:[]})};};
 await assert.rejects(h.read(),/not included/);
});

function eventNavigationContext(){
 const client=fs.readFileSync(new URL('../events/client.mjs',import.meta.url),'utf8'),start=client.indexOf('  function isTrackNavigationCurrent('),end=client.indexOf('\n  }',start)+4;
 assert.ok(start>=0&&end>start,'production navigation context facade exists');
 let session=null,account='account';const state=vm.createContext({sessions:{current:()=>session},archiveIntent:{trackId:id,accountId:account,archive:true},bridge:{accountId:()=>account}});
 runClientSource(client.slice(start,end),state);
 const ui={isEntered:trackId=>session?.trackId===trackId,isTrackNavigationCurrent:state.isTrackNavigationCurrent,leave(){session=null;state.archiveIntent=null;}};
 return {state,ui,setSession:value=>session=value,setAccount:value=>account=value};
}
test('archive context facade authorizes exact normal-practice navigation while isEntered stays false',async()=>{
 const event=eventNavigationContext();let clicks=0;
 const h=navigation({eventUi:event.ui,rememberEventTrackSelection(){}});h.context.trackInfo=()=>({type:'official',name:'Fixture'});h.context.document.querySelectorAll=selector=>selector.includes('track-title')?[{textContent:'Fixture',closest:()=>({click(){clicks++;}})}]:[];
 assert.equal(await h.context.focusTrackFromRanked(id,{event:true}),true);assert.equal(clicks,1);assert.equal(event.ui.isEntered(id),false);assert.equal(h.notices.length,0);
});
test('leaving an archive invalidates a pending navigation and never selects a delayed native track',async()=>{
 const event=eventNavigationContext();let release,clicks=0;
 const h=navigation({eventUi:event.ui,rememberEventTrackSelection(){},setTimeout:resolve=>release=resolve});h.context.trackInfo=()=>({type:'official',name:'Fixture'});
 const pending=h.context.focusTrackFromRanked(id,{event:true});assert.equal(typeof release,'function');event.ui.leave();assert.equal(event.ui.isTrackNavigationCurrent(id,'account'),false);
 h.context.document.querySelectorAll=()=>[{textContent:'Fixture',closest:()=>({click(){clicks++;}})}];release();assert.equal(await pending,false);assert.equal(clicks,0);assert.equal(h.notices.length,0);assert.equal(h.listeners.size,0);
});
test('event navigation facade rejects mismatched tracks/accounts and accepts an exact active session',()=>{
 const event=eventNavigationContext();assert.equal(event.ui.isTrackNavigationCurrent(id,'other'),false);assert.equal(event.ui.isTrackNavigationCurrent('b'.repeat(64),'account'),false);
 event.setAccount('other');assert.equal(event.ui.isTrackNavigationCurrent(id,'account'),false);event.setAccount('account');event.ui.leave();assert.equal(event.ui.isTrackNavigationCurrent(id,'account'),false);
 event.setSession({trackId:id,accountId:'account'});assert.equal(event.ui.isTrackNavigationCurrent(id,'account'),true);assert.equal(event.ui.isEntered(id),true);event.ui.leave();assert.equal(event.ui.isTrackNavigationCurrent(id,'account'),false);
});

test('event verification labels put the local run date first and status last without inventing dates',()=>{
 const at=Date.UTC(2026,9,20,18,44,1),date=new Date(at).toLocaleString('en-US',{year:'numeric',month:'2-digit',day:'2-digit',hour:'numeric',minute:'2-digit'});
 assert.equal(eventVerificationLabel({pbAt:at},false,'en-US'),date+' - Verified');
 assert.equal(eventVerificationLabel({runCreatedAt:at,pending:true},undefined,'en-US'),date+' - Pending');
 assert.equal(eventVerificationLabel({submittedAt:at,updatedAt:at},false,'en-US'),'Received '+date+' - Verified');
 assert.equal(eventVerificationLabel({updatedAt:at},false,'en-US'),'Date unavailable - Verified');
 assert.equal(eventVerificationLabel({verifiedAt:at},false,'en-US'),'Verification date '+date+' - Verified');
});
