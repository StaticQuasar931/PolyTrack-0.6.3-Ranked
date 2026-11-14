import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {publishedEventAwardPresentation} from '../tools/event-award-presentation.mjs';
const eventAwardRowRestricted=row=>publishedEventAwardPresentation(row).status==='held';

export const clientSource=fs.readFileSync(new URL('./client.mjs',import.meta.url),'utf8');
export const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
export const racer=(id,timeMs=1000)=>({accountId:id,name:id,timeMs,replayHash:'hash-'+id,verified:true,runVerified:true,integrityVerified:true,eventRpEligible:true});
export const waiting=(id,timeMs=1000)=>({...racer(id,timeMs),pending:true,runId:'a'.repeat(64),verified:false,runVerified:false,eventRpEligible:false,verificationStatus:'waiting'});
export async function until(predicate){for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setImmediate(resolve));}assert.fail('Synthetic action did not reach its expected boundary');}

export function harness(options={}){
  const period={id:'period',trackId:'b'.repeat(64),endsAt:100000};
  const initial={periodId:period.id,trackId:period.trackId,accountId:'viewer',endsAt:period.endsAt};
  let session=initial,account='viewer',clock=1000,prepares=0,handshakes=0;
  const rows=options.rows||[racer('first',1200),racer('second',1300),racer('third',1400)],reads=[],messages=[],launches=[],watches=[],offers=[];
  const button={disabled:false,addEventListener(_type,listener){this.listener=listener;},removeEventListener(){this.listener=null;},click(){this.listener?.();}};
  const root={isConnected:true,querySelector:()=>button,__pt062EventWatch:{version:1,trackId:period.trackId,open:ghosts=>watches.push(ghosts)}};
  const view={root,period,periodId:period.id,page:0,onlyVerified:false,visibleRows:rows,snapshot:{entries:rows}};
  const bridge={accountId:()=>account,require:()=>({}),supportsEventGhost:()=>!!options.own,
    readReplay:async(...args)=>{reads.push({archive:false,args});const row=rows.find(row=>row.accountId===args[1]);return options.read?options.read(row,args):{...row};},
    readArchivedReplay:async(...args)=>{reads.push({archive:true,args});const row=rows.find(row=>row.accountId===args[1]);return options.read?options.read(row,args):{...row};},
    startEventRace:async(value,invoke,current)=>{if(options.handoff)await options.handoff();assert(current());invoke();assert(current());launches.push(value);},
    watchEvent:(_session,ghosts)=>watches.push(ghosts)};
  const context=vm.createContext({bridge,sessions:{current:()=>session},archiveIntent:null,eventIntent:initial,nativeView:view,
    knownPeriods:new Map([[period.id,period]]),catalog:{periods:[period]},bestRecords:options.bestRecords||{},
    eventDisplayRows:()=>({rows}),archivePeriodCounts:()=>({verifiedEntries:rows}),
    document:{querySelector:()=>root,activeElement:button},getOwnReplay:()=>options.own?.()||null,
    now:()=>clock,message:text=>messages.push(text),tick(){},syncNativeBoard(){},displayName:row=>row.name,
    eventAwardRowRestricted,eventRowVerified:row=>!!row&&!row.pending&&!eventAwardRowRestricted(row)&&row.verified!==false&&row.runVerified!==false&&row.eventRpEligible!==false,
    prepareOwnEventGhost:options.prepareOwn||(()=>assert.fail('No local replay should be prepared in this fixture')),
    preparePublishedEventGhost:async({row,entry,viewer})=>{
      prepares++;if(options.prepare)await options.prepare(row,entry);
      if(!row||row.accountId!==entry.accountId||row.timeMs!==entry.timeMs||row.replayHash!==entry.replayHash)throw Error('Published replay hash does not match standings.');
      return {nickname:entry.name,racerId:entry.accountId,isSelf:entry.accountId===viewer,
        ...(options.indexed?{requiredPlaybackEngine:{fixture:true}}:{}),recording:{serialize:()=>entry.replayHash},time:{numberOfFrames:entry.timeMs}};
    },
    getPlaybackWorkerBridge:options.workerBridge||(()=>({prepareEventRecording:async()=>{handshakes++;if(options.handshake)await options.handshake();}})),
    confirmPartialReplaySelection:async offer=>{offers.push(offer);return options.confirm?options.confirm(offer):true;}});
  const start=clientSource.indexOf('  const replayContextActive='),end=clientSource.indexOf('  const ownReceipts=',start);
  assert(start>=0&&end>start);
  const api=vm.runInContext(`(()=>{let selectedGhost=null,replayRequest=0,topSelectionToken=0,launching=false,nativePlayPermit=false;
    const selectedGhosts=new Map(),pendingGhosts=new Map(),replayCache=new Map(),preparedGhosts=new Map(),preparedOwnGhosts=new Map(),replayFailures=new Map();
    ${clientSource.slice(start,end)}
    return {selectReplay,selectTopEventRows,selectEventRange,selectEventYouGroup,clearEventGhostSelection,playEvent,watchEvent,
      selected:()=>[...selectedGhosts.values()],pending:()=>pendingGhosts.size,raceGhosts,resumeRace};})()`,context);
  return {...api,period,rows,reads,messages,launches,watches,offers,bridge,view,root,
    prepares:()=>prepares,handshakes:()=>handshakes,clock:value=>{clock=value;},
    select:row=>api.selectReplay(period,row),action:mode=>mode==='watch'?api.watchEvent():api.playEvent(),
    archive:()=>{context.archiveIntent={...initial,archive:true};session=null;view.archive=true;},
    change:kind=>{
      if(kind==='account')account='other';else if(kind==='session')session={...initial};
      else if(kind==='page')view.page++;else if(kind==='filter')view.onlyVerified=!view.onlyVerified;
      else if(kind==='navigation')root.isConnected=false;else if(kind==='track')period.trackId='c'.repeat(64);
      else if(kind==='standings')rows[0].replayHash+='-changed';else if(kind==='hold')rows[0].reviewHold=true;
      else if(kind==='verdict')rows[0].eventRpEligible=false;else if(kind==='selection')api.clearEventGhostSelection(period.id,account);
    }};
}
