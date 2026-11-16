import test from 'node:test';
import assert from 'node:assert/strict';
import {prioritizeNativeTargets,prioritizeFirstProofWarmup} from './native-verification-priority.mjs';
import {ledgerBinding,ledgerKey} from '../native-verification-ledger.mjs';
const id=n=>n.toString(16).padStart(64,'0'),track=id(99);
const normal=(n,ingestedAt)=>({lane:'normal',kind:'normal',accountId:id(n),trackId:track,uploadId:n,
  timeMs:900,frames:900,replayHash:id(77),resultId:id(n)+'_'+track,ingestedAt});
const event=(n,periodId)=>({...normal(n,0),lane:'event',kind:'event-pending',periodId,runId:id(n+100),resultId:id(n+100),uploadId:null});
const board=(id,archived=false)=>({id,archived,state:archived?'archived':'open',period:{id,startsAt:100,endsAt:2000}});

test('live waiting event goes first even after thousands of normal inputs; recent normal follows deterministically',()=>{
  const normals=Array.from({length:2000},(_,i)=>normal(i+1,100+i)),live=event(3000,'weekly'),old=event(3001,'old');
  const jobs=[...normals,old,live],before=jobs.slice();
  const result=prioritizeNativeTargets({jobs,eventBoards:[board('weekly'),board('old',true)],policy:{knownTrackIds:[track]},now:1000});
  assert.equal(result.jobs[0],live);assert.equal(result.jobs[1],normals.at(-1));
  assert.equal(result.jobs.at(-1),old);assert.equal(result.jobs.length,jobs.length);
  assert.deepEqual(jobs,before,'complete review inventory must not be reordered in-place');
  assert.deepEqual(prioritizeNativeTargets({jobs:jobs.toReversed(),eventBoards:[board('weekly'),board('old',true)],policy:{knownTrackIds:[track]},now:1000}).jobs,result.jobs);
});

test('public proof hits, unknown media and holds remain in inventory without gaining authority',()=>{
  const hit=normal(1,500),unknown={...normal(2,999),trackId:id(88)},held={...normal(3,600),needsReview:true},pending=event(4,'daily');
  const jobs=[hit,unknown,held,pending],key=ledgerKey(ledgerBinding(hit));
  const result=prioritizeNativeTargets({jobs,eventBoards:[board('daily')],entries:[{key}],policy:{knownTrackIds:[track]},now:1000});
  assert.deepEqual(result.jobs,[hit,pending,held,unknown]);assert.equal(result.jobs[2].needsReview,true);
  assert.equal(result.counts.exactPublicBinding,1);assert.equal(result.counts.other,1);
  assert.equal(new Set(result.jobs).size,4);assert.equal(hit.verified,undefined);
});

test('exact proof reviews precede any new native workload without removing the full inventory',()=>{const hit=normal(1,1),fresh=normal(2,999),pending=event(3,'daily');const key=ledgerKey(ledgerBinding(hit));const result=prioritizeNativeTargets({jobs:[fresh,pending,hit],eventBoards:[board('daily')],entries:[{key}],policy:{knownTrackIds:[track]},now:1000});assert.deepEqual(result.jobs,[hit,pending,fresh]);assert.equal(result.jobs.length,3);});

test('explicit event-only scheduling puts current Kodub before weekly proof hits and higher rewards before daily',()=>{
 const kodub=event(1,'kodub'),weekly=event(2,'weekly'),daily=event(3,'daily');
 const boards=[{...board('kodub'),period:{...board('kodub').period,kind:'kodub',maxRp:700}},
  {...board('weekly'),period:{...board('weekly').period,kind:'weekly',maxRp:500}},
  {...board('daily'),period:{...board('daily').period,kind:'daily',maxRp:100}}];
 const jobs=[daily,weekly,kodub],result=prioritizeNativeTargets({jobs,eventBoards:boards,eventFirst:true,entries:[{key:ledgerKey(ledgerBinding(weekly))}],now:1000});
 assert.deepEqual(result.jobs,[kodub,weekly,daily]);assert.deepEqual(jobs,[daily,weekly,kodub]);
 assert.equal(kodub.verified,undefined,'scheduling confers no proof');
});

test('known normal tracks use published weight then best time, not recent loading or PB order',()=>{
 const low={...normal(1,999),trackId:id(90),timeMs:100},slow={...normal(2,100),trackId:id(91),timeMs:1000},fast={...normal(3,50),trackId:id(91),timeMs:900};const jobs=[low,slow,fast];
 const result=prioritizeNativeTargets({jobs,normalBoards:[{trackId:id(90),entries:[{weight:2}]},{trackId:id(91),entries:[{weight:10}]}],policy:{knownTrackIds:[id(90),id(91)]},now:1000});assert.deepEqual(result.jobs,[fast,slow,low]);assert.deepEqual(jobs,[low,slow,fast]);
});
test('explicit Rolling Hills priority follows live event proofs without changing verification authority',()=>{
 const hill={...normal(1,1),trackId:id(90)},busy={...normal(2,999),trackId:id(91)},live=event(3,'kodub');const result=prioritizeNativeTargets({jobs:[busy,hill,live],preferredTrackIds:[id(90)],eventBoards:[board('kodub')],normalBoards:[{trackId:id(91),weight:10}],policy:{knownTrackIds:[track,id(90),id(91)]},now:1000,eventFirst:true});assert.deepEqual(result.jobs,[live,hill,busy]);assert.equal(hill.verified,undefined);
 assert.throws(()=>prioritizeNativeTargets({jobs:[],preferredTrackIds:['not-a-track'],now:1000}));
});

test('front-page exposure outranks a deep run on a slightly heavier track',()=>{
 const popular=id(90),other=id(91),first={...normal(1,5),trackId:popular,timeMs:900},
  deep={...normal(2,999),trackId:popular,timeMs:2000},second={...normal(3,1),trackId:other,timeMs:1000};
 const jobs=[deep,second,first],normalBoards=[{trackId:popular,weight:10,entries:[
  {accountId:first.accountId,rank:1},{accountId:deep.accountId,rank:3012}]},
  {trackId:other,weight:9,entries:[{accountId:second.accountId,rank:2}]}];
 const result=prioritizeNativeTargets({jobs,normalBoards,policy:{knownTrackIds:[popular,other]},now:1000});
 assert.deepEqual(result.jobs,[first,second,deep]);assert.deepEqual(jobs,[deep,second,first]);
 assert.deepEqual(prioritizeNativeTargets({jobs:jobs.toReversed(),normalBoards,policy:{knownTrackIds:[popular,other]},now:1000}).jobs,result.jobs);
});

test('Rolling Hills preference applies to first place, not every run on that board',()=>{
 const hill=id(90),busy=id(91),top={...normal(1,1),trackId:hill},deep={...normal(2,999),trackId:hill},front={...normal(3,2),trackId:busy};
 const result=prioritizeNativeTargets({jobs:[deep,front,top],preferredTrackIds:[hill],normalBoards:[
  {trackId:hill,weight:2,entries:[{accountId:top.accountId,rank:1},{accountId:deep.accountId,rank:500}]},
  {trackId:busy,weight:10,entries:[{accountId:front.accountId,rank:2}]}],policy:{knownTrackIds:[hill,busy]},now:1000});
 assert.deepEqual(result.jobs,[top,front,deep]);
});


test('first-proof warmup moves the first known short candidate only, preserving all timed-out target order',()=>{
 const times=[81959,83529,126665,3634748,45001,45000,900];
 const jobs=times.map((timeMs,i)=>({...normal(i+1,100),timeMs})),before=structuredClone(jobs);
 const output=prioritizeFirstProofWarmup({jobs,policy:{knownTrackIds:[track]},firstProofCheckpoint:()=>{}});
 assert.equal(output[0],jobs[5]);assert.deepEqual(output.slice(1),[...jobs.slice(0,5),jobs[6]]);
 assert.equal(output.length,jobs.length);assert.equal(new Set(output).size,jobs.length);assert.deepEqual(jobs,before);
 assert.deepEqual(prioritizeFirstProofWarmup({jobs,policy:{knownTrackIds:[track]},firstProofCheckpoint:()=>{}}),output);
 assert.ok(output.every(job=>job.verified===undefined),'scheduling grants no verification');
});
test('warmup is disabled without the existing gate and never displaces an event-first target',()=>{
 const jobs=[{...normal(1,0),timeMs:81959},normal(2,0)];
 assert.equal(prioritizeFirstProofWarmup({jobs,policy:{knownTrackIds:[track]}}),jobs);
 const events=[{...event(3,'current'),timeMs:90000},...jobs];
 assert.equal(prioritizeFirstProofWarmup({jobs:events,policy:{knownTrackIds:[track]},firstProofCheckpoint:()=>{}}),events);
});
test('warmup requires exact known policy/time and skips explicit holds or exclusions without removing them',()=>{
 const patches=[{trackId:id(88)},{timeMs:0},{timeMs:45001},{timeMs:'900'},{timeMs:NaN},{reviewHold:true},{needsReview:true},{excluded:true},{disposition:'held'},{status:'rejected'},{verificationStatus:'mismatch'},{review:{disposition:'excluded'}}];
 const jobs=[...patches.map((patch,i)=>({...normal(i+1,0),...patch})),normal(90,0)];
 const output=prioritizeFirstProofWarmup({jobs,policy:{trackContentHashes:{[track]:id(1)}},firstProofCheckpoint:()=>{}});
 assert.equal(output[0],jobs.at(-1));assert.deepEqual(output.slice(1),jobs.slice(0,-1));
 assert.equal(prioritizeFirstProofWarmup({jobs:jobs.slice(0,-1),policy:{trackContentHashes:{[track]:id(1)}},firstProofCheckpoint:()=>{}})[0],jobs[0]);
 const none=[{...normal(1,0),timeMs:81959}];assert.equal(prioritizeFirstProofWarmup({jobs:none,policy:{knownTrackIds:[track]},firstProofCheckpoint:()=>{}}),none);
});
test('phase warmup hook follows retention event sort and preserves the exact inventory assertion and full review',async()=>{
 const fs=await import('node:fs/promises');const source=await fs.readFile(new URL('../native-snapshot-phase.mjs',import.meta.url),'utf8');
 const sort=source.indexOf('const orderedTargets=publishedRetention?priority.jobs.sort('),hook=source.indexOf('const targets=prioritizeFirstProofWarmup({jobs:orderedTargets,policy:context.policy,firstProofCheckpoint});');
 const assertion=source.indexOf('if(publishedRetention)assertPublishedTargetJobs(publishedRetention,targets);',hook);
 assert.ok(sort>=0&&hook>sort&&assertion>hook);assert.match(source,/allJobs:inputs.jobs/);assert.match(source,/reviewFactory\(\{jobs:value.allJobs/);
});
