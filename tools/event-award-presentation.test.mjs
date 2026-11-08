import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {decodeSnapshot} from './snapshot-package.mjs';
import {eventAwardPresentation,publishedEventAwardPresentation} from './event-award-presentation.mjs';

const hash=n=>n.toString(16).padStart(64,'0'),accountId=hash(1),trackId=hash(2),replayHash=hash(3);
const period={id:'snapshot77_shape',kind:'kodub',trackId,startsAt:1000,endsAt:10000};
const award=(extra={})=>({accountId,runId:hash(4),timeMs:51459,replayHash,rp:489,submittedAt:2000,
  verified:true,runVerified:true,physicsVerified:true,replayIntegrityVerified:true,integrityVerified:true,
  eventRpEligible:true,pending:false,verificationStatus:'verified',...extra});
const normal=(extra={})=>({accountId,trackId,timeMs:51459,replayHash,runVerified:true,...extra});
const board=(entries=[award()],extra={})=>({id:period.id,period,entries,complete:true,totalEntries:entries.length,...extra});
const waiting=(extra={})=>({accountId,runId:hash(5),timeMs:51000,replayHash:hash(6),submittedAt:2100,
  pending:true,verified:false,eventRpEligible:false,verificationStatus:'waiting',source:'pending-event-playback',...extra});
const show=(extra={})=>eventAwardPresentation({period,trackId,normalRow:normal(),board:board(),formatTime:n=>'time-'+n,...extra});

test('snapshot77 exact award is compact, verified, immutable and sourced only from event RP',()=>{
  const input={period,trackId,normalRow:normal(),board:board()},before=structuredClone(input),result=eventAwardPresentation(input);
  assert.equal(result.status,'awarded');assert.equal(result.text,'489 ERP');assert.equal(result.verified,true);
  assert.equal(result.relation,'exact');assert.equal(result.eventTimeMs,51459);assert.equal(result.eventPbText,null);
  assert.equal(result.pairedText,'489 ERP');assert(Object.isFrozen(result));assert.deepEqual(input,before);
});

test('snapshot77 separate Event PB pairs its own time, never the faster normal PB time',()=>{
  for(const [normalTime,eventTime,rp]of [[52165,52423,465],[65877,73582,39]]){
    const result=show({normalRow:normal({timeMs:normalTime,replayHash:hash(8)}),board:board([award({timeMs:eventTime,rp})])});
    assert.equal(result.text,rp+' ERP');assert.equal(result.eventTimeMs,eventTime);assert.equal(result.separate,true);
    assert.equal(result.eventPbText,'Event PB time-'+eventTime);assert.equal(result.pairedText,'Event PB \u00b7 '+rp+' ERP');
    assert(result.title.includes('time-'+eventTime));
    assert(!result.pairedText.includes('time-'+normalTime));assert.match(result.title,/not to the ordinary leaderboard run/);
  }
});

test('equal times with different or missing replay hashes remain separate Event PBs',()=>{
  for(const replayHash of [undefined,'',hash(9)])assert.equal(show({normalRow:normal({replayHash})}).relation,'separate');
  assert.equal(show({board:board([award({replayHash:undefined})])}).relation,'separate');
  assert.equal(show({formatTime:()=>{throw Error('formatter failed');},normalRow:normal({replayHash:hash(9)})}).eventPbText,'Separate Event PB');
});

test('normal verification, normal RP and lifetime/group values cannot invent an event award',()=>{
  for(const flags of [{verified:true},{runVerified:true},{physicsVerified:true},{rp:9999,eventRp:9999,groupRp:9999}]){
    const result=show({normalRow:normal(flags),board:board([])});
    assert.equal(result.status,'none');assert.equal(result.text,'No event result');assert.equal(result.score,null);assert.equal(result.verified,false);
  }
  assert.equal(show({board:board([award({groupRp:9999})])}).text,'489 ERP');
});

test('published zero is an award, while absent or invalid scores are unavailable, never zero',()=>{
  for(const rp of [0,'0',84,'84'])assert.equal(show({board:board([award({rp})])}).text,Number(rp)+' ERP');
  for(const rp of [undefined,null,'',' ',false,true,-1,1.5,NaN,Infinity,{},[],Number.MAX_SAFE_INTEGER+1,'1e2']){
    const result=show({board:board([award({rp})])});assert.equal(result.status,'unavailable');assert.equal(result.verified,false);assert.equal(result.score,null);
  }
  assert.equal(publishedEventAwardPresentation({rp:489}).status,'unavailable');
});

test('known waiting Event PB and known absence are distinct from unavailable or partial data',()=>{
  const result=show({board:board([],{pendingPlaybacks:[waiting()]})});
  assert.equal(result.status,'pending');assert.equal(result.text,'ERP pending');assert.equal(result.verified,false);
  assert.equal(result.eventTimeMs,51000);assert.equal(result.eventPbText,'Event PB time-51000');assert.equal(result.score,null);
  for(const b of [null,board([],{complete:false}),board([],{complete:undefined,sourceComplete:undefined}),
    board([],{totalEntries:1}),board([],{totalEntries:undefined}),board([],{sourceComplete:false}),board([],{pendingPlaybacks:{}})])assert.equal(show({board:b}).status,'unavailable');
  assert.equal(show({board:board([])}).status,'none');
  assert.equal(show({normalRow:normal({timeMs:600000}),board:board([])}).status,'none');
});

test('a faster pending event run does not replace or add to an older published award',()=>{
  const result=show({board:board([award()],{pendingPlaybacks:[waiting()]})});
  assert.equal(result.text,'489 ERP');assert.equal(result.eventTimeMs,51459);assert.equal(result.hasPending,true);
  assert.equal(result.pendingTimeMs,51000);assert.equal(result.verified,true);assert.match(result.title,/does not replace/);
});

for(const patch of [{needsReview:true},{reviewHold:true},{excluded:true},{unscored:true},{status:'held'},
  {verificationStatus:'waiting'},{validationState:'mismatch'},{verifiedState:0},{verified:false},{eventRpEligible:false},
  {reason:'held'},{reason:'unavailable_final'}])test('event award cannot be verified under restriction '+JSON.stringify(patch),()=>{
  const result=show({board:board([award(patch)])});assert.equal(result.verified,false);assert.equal(result.score,null);assert.notEqual(result.status,'awarded');
});

test('held pending data is neither awarded nor described as ordinary waiting verification',()=>{
  const result=show({board:board([],{pendingPlaybacks:[waiting({reviewHold:true})]})});
  assert.equal(result.status,'held');assert.equal(result.text,'ERP held');assert.equal(result.verified,false);
});

test('event/track/account context and duplicate published accounts fail closed',()=>{
  for(const input of [{trackId:hash(99)},{normalRow:normal({trackId:hash(99)})},{normalRow:normal({userId:hash(99)})},
    {period:{...period,id:'another_period'}},{period:{...period,startsAt:1001}},{period:{...period,endsAt:10001}},
    {board:board([award(),award()])},{board:board([award({periodId:'another_period'})])},
    {board:board([award({trackId:hash(99)})])},{board:board([award({submittedAt:period.endsAt})])}])
    assert.equal(show(input).status,'unavailable');
  assert.equal(show({normalRow:{userId:accountId,trackId,timeMs:51459,replayHash}}).relation,'exact');
});

test('snapshot77 static latest Kodub rows preserve published score and exact versus separate identity',async()=>{
  const root=new URL('../public-snapshots77/',import.meta.url),indexBytes=await fs.readFile(new URL('index.json',root));
  const sha=value=>createHash('sha256').update(value).digest('hex');
  assert.equal(sha(indexBytes),'fe8e85d0955c71396e78ac658d768921a41b82c68ee777c4597fe015a3a4035c');
  const index=JSON.parse(indexBytes);let reads=0;
  const load=async logical=>{
    const entry=index.files[logical];assert(entry);assert(++reads<=180);assert(entry.decodedBytes<=4*1024*1024);
    const encoded=await fs.readFile(new URL(entry.path,root));assert.equal(sha(encoded),entry.sha256);
    const decoded=await decodeSnapshot(encoded);assert.equal(decoded.length,entry.decodedBytes);return JSON.parse(Buffer.from(decoded));
  };
  const manifest=await load('manifest.json'),events=[];
  for(const record of Object.values(manifest.events)){const event=await load(record.path);if(event.period?.kind==='kodub')events.push(event);}
  events.sort((a,b)=>b.period.startsAt-a.period.startsAt);const event=events[0];assert(event);
  const ordinary=await load(manifest.tracks[event.period.trackId].path),counts={exact:0,separate:0,none:0};
  for(const row of ordinary.entries){
    const result=eventAwardPresentation({board:event,period:event.period,trackId:event.period.trackId,normalRow:row});
    const saved=event.entries.find(value=>value.accountId===(row.accountId||row.userId));
    if(!saved){assert.equal(result.status,'none');counts.none++;continue;}
    assert.equal(result.status,'awarded');assert.equal(result.score,saved.rp);assert.equal(result.eventTimeMs,saved.timeMs);
    const exact=row.timeMs===saved.timeMs&&row.replayHash===saved.replayHash;
    assert.equal(result.relation,exact?'exact':'separate');counts[exact?'exact':'separate']++;
  }
  assert.deepEqual(counts,{exact:21,separate:3,none:62});
});
