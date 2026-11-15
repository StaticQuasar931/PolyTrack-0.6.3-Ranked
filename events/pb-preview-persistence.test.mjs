import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {Socket} from 'node:net';
import {createEventPbPreviews,eventSnapshotFields,eventPendingRows,eventOwnPlacementPresentation,eventPreviewPlacementPresentation} from './client.mjs';
globalThis.fetch=()=>assert.fail('No network or replay prefetch');
Socket.prototype.connect=globalThis.fetch;
const source=fs.readFileSync(new URL('./client.mjs',import.meta.url),'utf8');
const hash=n=>n.toString(16).padStart(64,'0'),accountId=hash(1);
const periodFor=kind=>({id:kind+'-preview',kind,trackId:hash(99),startsAt:100,endsAt:10000});
const own=(period,change={})=>({accountId,periodId:period.id,trackId:period.trackId,timeMs:2000,rank:2,rp:42,
 physicsVerified:true,replayIntegrityVerified:true,...change});
const board=(period,change={})=>({period,updatedAt:1000,complete:true,totalEntries:1,entries:[own(period)],...change});
function harness(period){
 const cache=new Map([[period.id,board(period)]]);let account=accountId,epoch=1,receipt=null,local=null;
 const c={cache,pbPreviews:createEventPbPreviews(),bridge:{accountId:()=>account,snapshotOnly:()=>true,normalEventSnapshotEpoch:()=>epoch},
  ownReceipts:new Map(),localBest:()=>local,read:()=>null,STORE:'events',eventSnapshotFields,eventPendingRows,
  displayName:r=>r.name||'You',now:()=>1000,validEventTimestamp:()=>false,eventOwnPlacementPresentation,eventPreviewPlacementPresentation,displayedRecordPlacement:()=>null,time:String};
 vm.createContext(c);
 const a=source.indexOf('  function eventDisplayRows('),b=source.indexOf('  function syncNativeArchiveBoard(',a);
 const r=source.indexOf('  function recordMarkup('),end=source.indexOf('  function cardStandings(',r);
 vm.runInContext(source.slice(a,b)+source.slice(r,end),c);
 return {cache,rows:()=>c.eventDisplayRows(period),markup:()=>c.recordMarkup(period),setAccount:value=>account=value,setEpoch:value=>epoch=value,
  receipt:value=>{c.ownReceipts.set(period.id+'_'+accountId,value);},local:value=>local=value};
}
for(const kind of ['daily','weekly','kodub'])test(kind+' PB survives leave/reopen and partial loading without becoming proof, points or a replay',()=>{
 const period=periodFor(kind),h=harness(period);
 assert.match(h.markup(),/2000/);h.cache.delete(period.id);
 const reopened=h.rows();assert.equal(reopened.rows.length,0);assert.equal(reopened.previewOwn.timeMs,2000);
 assert.equal(reopened.previewOwn.previewOnly,true);assert.equal(reopened.previewOwn.verified,false);assert.equal(reopened.previewOwn.eventRpEligible,false);
 for(const field of ['rp','replay','replayHash','runId'])assert.equal(reopened.previewOwn[field],undefined);
 assert.equal(reopened.previewOwn.rank,null);assert.doesNotMatch(h.markup(),/Loading standings|Placement unavailable/);
 h.cache.set(period.id,board(period,{entries:[],complete:false,totalEntries:20,updatedAt:2000}));assert.equal(h.rows().previewOwn.timeMs,2000);
 h.cache.set(period.id,board(period,{entries:[own(period,{timeMs:1900})],updatedAt:3000}));assert.equal(h.rows().previewOwn.timeMs,1900);
 h.cache.set(period.id,board(period,{entries:[],totalEntries:0,updatedAt:4000}));assert.equal(h.rows().previewOwn,null);
});
test('previews are fenced by account, exact period dates/track/kind, and package epoch',()=>{
 const period=periodFor('daily'),h=harness(period);h.rows();h.cache.clear();
 h.setAccount(hash(2));assert.equal(h.rows().previewOwn,null);h.setAccount(accountId);
 h.setEpoch(2);assert.equal(h.rows().previewOwn,null);h.setEpoch(1);
 const cache=createEventPbPreviews();cache.get({period,accountId,epoch:1,board:board(period)});
 for(const change of [{id:'next-daily'},{trackId:hash(90)},{kind:'weekly'},{startsAt:101},{endsAt:10001}])
  assert.equal(cache.get({period:{...period,...change},accountId,epoch:1}),null);
});
for(const restriction of [{reviewHold:true},{needsReview:true},{status:'private_hold'},{status:'rejected'},{verificationStatus:'mismatch'}])
 test('hold/rejection immediately invalidates a previously saved preview: '+JSON.stringify(restriction),()=>{
  const period=periodFor('weekly'),h=harness(period);h.rows();h.cache.clear();
  h.receipt({...restriction});h.local(own(period,{attemptId:'local-held',pending:true}));assert.equal(h.rows().rows.length,0);assert.equal(h.rows().previewOwn,null);assert.doesNotMatch(h.markup(),/2000/);
 });
test('held public rows and malformed complete replacement cannot resurrect or erase previews',()=>{
 const period=periodFor('kodub'),cache=createEventPbPreviews();cache.get({period,accountId,board:board(period)});
 assert.equal(cache.get({period,accountId,board:board(period,{entries:[{accountId:'bad',timeMs:1}]})}).timeMs,2000);
 assert.equal(cache.get({period,accountId,board:board(period,{complete:false,entries:[own(period,{reviewHold:true})]})}),null);
 assert.equal(cache.get({period,accountId}),null);
});
