import test from 'node:test';
import assert from 'node:assert/strict';
import {kickoffOvernightSnapshot} from './overnight-kickoff.mjs';
import {OVERNIGHT_SNAPSHOT as N} from './overnight-snapshot-plan.mjs';

const sha='a'.repeat(40),receipt={ready:true,targetDate:N.date,oneOffAuthority:'snapshot-native',testedCommit:sha,evidence:['test-receipt']};
const response=(status,value)=>({status,json:async()=>value});
function fixture({head=sha,claimed=false,active=[],post=204,networkFailure=false,lock=true,guard}={}){
  const calls=[],records=[];let guarded=false;
  const fetchImpl=async(url,options)=>{
    calls.push({url,...options});assert.ok(url.startsWith('https://api.github.com/repos/StaticQuasar931/PolyTrack-0.6.3-Ranked/'));
    assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer test-token');
    if(url.endsWith('/git/ref/heads/main'))return response(200,{object:{sha:head}});
    if(url.includes('/git/ref/tags/'))return response(claimed?200:404,{ref:'refs/tags/polytrack-oneoff-'+N.date,object:{sha}});
    if(url.includes('/actions/runs?'))return response(200,{workflow_runs:active});
    assert.equal(options.method,'POST');assert.equal(guarded,true);assert.equal(records[0].status,'dispatch-requested');
    assert.deepEqual(JSON.parse(options.body),{ref:'main',inputs:{overnight_capture:true,expected_source_commit:sha,catch_up:false}});
    if(networkFailure)throw Error('mock transport');return response(post,{});
  };
  return {calls,records,options:{receipt,now:N.start,token:'test-token',fetchImpl,acquireGuard:async()=>{guarded=guard?await guard():lock;return guarded;},record:async value=>records.push(value)}};
}

test('local kickoff dispatches only typed capture-first input after metadata and exclusive guard',async()=>{
  const f=fixture();assert.equal((await kickoffOvernightSnapshot(f.options)).status,'dispatched');
  assert.equal(f.calls.filter(x=>x.method==='POST').length,1);assert.equal(f.calls.length,8);
  assert.equal(f.records.at(-1).httpStatus,204);
});

test('bad readiness and time windows do not make any request',async()=>{
  for(const patch of [{receipt:{...receipt,ready:false}},{receipt:{...receipt,targetDate:'2026-11-04'}},{receipt:{...receipt,evidence:[]}},
    {now:N.start-1},{now:N.latestCaptureStart}]){
    const f=fixture();await assert.rejects(kickoffOvernightSnapshot({...f.options,...patch}));assert.equal(f.calls.length,0);
  }
});

test('changed source, claimed run, active work and a local guard prevent dispatch',async()=>{
  for(const options of [{head:'b'.repeat(40)},{claimed:true},{active:[{name:'Verify PolyTrack runs and refresh public snapshots',id:7}]},{lock:false},
    {active:Array.from({length:100},()=>({name:'Publish CDN release'}))}]){
    const f=fixture(options),result=await kickoffOvernightSnapshot(f.options);assert.notEqual(result.status,'dispatched');
    assert.equal(f.calls.filter(x=>x.method==='POST').length,0);assert.equal(f.records.length,0);
  }
});

test('passive CDN recovery does not prevent the independent capture kickoff',async()=>{
  const f=fixture({active:[{name:'Publish CDN release',id:1}]});assert.equal((await kickoffOvernightSnapshot(f.options)).status,'dispatched');
});

test('ambiguous or failed dispatch is recorded without any automatic repeat',async()=>{
  for(const options of [{post:403},{post:500},{networkFailure:true}]){
    const f=fixture(options);await assert.rejects(kickoffOvernightSnapshot(f.options));
    assert.equal(f.calls.filter(x=>x.method==='POST').length,1);assert.equal(f.records.length,2);
    assert.ok(['dispatch-failed','dispatch-outcome-unknown'].includes(f.records.at(-1).status));
  }
});

test('a persistent guard rejects a second local attempt even before the hosted claim appears',async()=>{
  let taken=false;
  const f=fixture({guard:async()=>{if(taken)return false;taken=true;return true;}});
  assert.equal((await kickoffOvernightSnapshot(f.options)).status,'dispatched');
  assert.equal((await kickoffOvernightSnapshot(f.options)).status,'blocked');
  assert.equal(f.calls.filter(x=>x.method==='POST').length,1);
});
