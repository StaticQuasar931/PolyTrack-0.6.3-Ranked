import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {eventPeriodDisplayName,eventPreviewPlacementPresentation,createEventPbPreviews,rollingEventBadgePresentation,createRollingEventErpDecorator} from './client.mjs';
const hash=n=>n.toString(16).padStart(64,'0'),trackId='fb769ac2ea77e8f19a21a9dd3071742f2342bd49c41e4748d7e8c7903d4f0778';
const p={id:'weekly-preview',kind:'weekly',trackId:hash(99),trackName:'Summer1',startsAt:100,endsAt:10000};
const source=fs.readFileSync(new URL('./client.mjs',import.meta.url),'utf8');
test('ranking labels carry the category while event card labels contain only the track',()=>{
 assert.equal(eventPeriodDisplayName(p),'Weekly Summer1');assert.equal(eventPeriodDisplayName({...p,kind:'daily'}),'Daily Summer1');
 assert.equal(eventPeriodDisplayName(p,null,'card'),'Summer1');
 const start=source.indexOf('  function cards('),end=source.indexOf('  function permanentCard(',start);
 const render=vm.runInNewContext(source.slice(start,end)+';cards;',{
  knownPeriods:new Map(),escape:String,bridge:{thumbnail:()=>''},recordMarkup:()=>'',periodName:value=>eventPeriodDisplayName(value,null,'card'),
  eventRewardLabel:()=>'',reset:()=>'',now:()=>1000,cardStandings:()=>''});
 const html=render([p]);assert.ok(html.includes('<small>WEEKLY EVENT</small><strong>Summer1</strong>'));assert.doesNotMatch(html,/<strong>Weekly/);
});
test('cached PB placement retains exact numerator/denominator without giving the preview rank/proof/ERP authority',()=>{
 const entries=[{accountId:hash(2),timeMs:1000,rank:1},{accountId:hash(1),timeMs:2000,rank:2}];
 const board={period:p,entries,totalEntries:2,complete:true,updatedAt:200,_eventSnapshotEpoch:1};
 const cache=createEventPbPreviews();cache.get({period:p,accountId:hash(1),epoch:1,board});
 const preview=cache.get({period:p,accountId:hash(1),epoch:1});
 assert.equal(preview.rank,null);assert.equal(preview.verified,false);assert.equal(preview.eventRpEligible,false);assert.equal(preview.rp,undefined);
 const label=eventPreviewPlacementPresentation(preview);assert.equal(label.text,'2/2');assert.equal(label.ariaLabel,'Cached event placement 2/2');assert.match(label.title,/Current standings are loading/);
 assert.equal(cache.get({period:p,accountId:hash(1),epoch:2}),null);
 assert.equal(eventPreviewPlacementPresentation({...preview,cachedPlacement:{rank:3,fieldSize:2}}),null);
});
const entry=(n,timeMs,rank,rp)=>({accountId:hash(n),timeMs,rank,rp,replayHash:hash(n+10),physicsVerified:true,replayIntegrityVerified:true});
const rolling=()=>({id:'permanent-rolling-hills',kind:'permanent',trackId,complete:true,totalEntries:2,sourceRevision:2,updatedAt:200,
 scoreVersion:'rolling-hills-pace-placement-v2',maxRp:10101,targetMs:10000,entries:[entry(1,10000,1,4321),entry(2,11000,2,5050)]});
test('normal RHR badge attributes only the exact published PB award, never the cap or a same-time hash mismatch',()=>{
 const board=rolling(),normal={...board.entries[0],trackId};
 const actual=rollingEventBadgePresentation(normal,board,trackId);assert.equal(actual.text,'4,321 ERP');assert.equal(actual.estimated,false);assert.match(actual.title,/exact PB/);
 assert.equal(rollingEventBadgePresentation({...normal,replayHash:hash(88),physicsVerified:false},board,trackId),null);
 assert.equal(rollingEventBadgePresentation({...normal,reviewHold:true},board,trackId),null);
 assert.equal(rollingEventBadgePresentation(normal,board,hash(99)),null);
});
test('eligible normal RHR estimate is explicitly not an award and requires complete consistent hybrid metadata',()=>{
 const board=rolling(),normal={...entry(3,12000,90,99999),trackId};
 const estimate=rollingEventBadgePresentation(normal,board,trackId);assert.equal(estimate.estimated,true);assert.match(estimate.text,/Estimated .* ERP if verified/);assert.match(estimate.title,/not published earned ERP/);
 for(const value of [{...board,complete:false},{...board,targetMs:9000},{...board,totalEntries:3}])assert.equal(rollingEventBadgePresentation(normal,value,trackId),null);
 assert.equal(rollingEventBadgePresentation({...normal,localPending:true},board,trackId),null);
});
test('existing normal-row callback can decorate and safely clear RHR hover without any fetch',()=>{
 let board=rolling();const icon={title:'Verified icon'},state={title:'Verified',querySelector:()=>icon};
 const button={closest:()=>({classList:{contains:()=>false}}),querySelector:()=>state};
 const decorator=createRollingEventErpDecorator({currentTrackId:()=>trackId},()=>board);
 decorator.decorate(button,{...board.entries[0],trackId},trackId);assert.match(icon.title,/4,321 ERP/);
 board=null;decorator.decorate(button,null,trackId);assert.equal(icon.title,'Verified icon');assert.equal(state.title,'Verified');
});
test('initial native and promoted TOTW containment is defined in owned CSS, before any layout resize hook',()=>{
 const css=fs.readFileSync(new URL('./events.css',import.meta.url),'utf8'),last=css.slice(css.lastIndexOf('/* First layout:'));
 assert.match(last,/track.track-of-the-week>.button/);assert.match(last,/object-fit:contain!important/);assert.match(last,/height:auto!important/);assert.match(last,/position:static!important/);
 assert.doesNotMatch(source,/Saved event PB; standings loading|Saved PB; standings loading/);
 assert.match(css,/.sq-event-preview-loading{[^}]*text-align:center!important/);
});
