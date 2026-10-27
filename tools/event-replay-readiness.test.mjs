import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import createClientSourceRunner from './client-source-harness.cjs';
const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const from=source.indexOf('  async function readEventReplay('),to=source.indexOf('  async function ensureEventUi(',from);
const run=createClientSourceRunner(source),period='kodub_1793563200000',account='a'.repeat(64),track='b'.repeat(64),runId='c'.repeat(64),hash=createHash('sha256').update('payload').digest('hex');
const waiting={periodId:period,accountId:account,trackId:track,runId,timeMs:38000,frames:38000,replayHash:hash,replay:'payload',pending:true,verified:false,eventRpEligible:false};
const target={trackId:track,timeMs:38000,runId,replayHash:hash};
const reply=(value,status=200,headers={})=>({ok:status===200,status,headers:new Headers(headers),text:async()=>JSON.stringify(value)});
function setup({saved,pending,archived=false,enabled=true,fetchImpl=async()=>reply(waiting)}={}){
 const calls=[],context=vm.createContext({eventReplayRequests:new Map(),compatibilityOnlineAllowed:enabled,crypto:globalThis.crypto,TextEncoder,
 readPublicSnapshotBackup:async kind=>kind==='event'?{archived}:kind==='event-playback'?pending:saved,
 rankedEdgeAvailable:()=>false,markRankedEdgeUnavailable:()=>assert.fail('replay failures must not poison other endpoints'),rankedBrokerUrl:()=> 'https://worker.test',eventRequestSignal:()=>undefined,
 fetch:async(url,options)=>{calls.push(url);return fetchImpl(url,options);}});
 run(source.slice(from,to),context);return {context,calls,read:()=>context.readEventReplay(period,account,runId,target)};
}
test('pending snapshot playback works offline and does not grant verified status or event RP',async()=>{
 const h=setup({pending:waiting});assert.equal(await h.read(),waiting);assert.equal(h.calls.length,0);assert.equal(waiting.verified,false);assert.equal(waiting.eventRpEligible,false);
});
test('explicit pending replay load bypasses unrelated Overall edge cooldown',async()=>{
 const h=setup();const result=await h.read();assert.equal(result.runId,runId);assert.equal(h.calls.length,1);
});
test('exact successful replays are shared concurrently and retained across menu reopens',async()=>{
 const h=setup();await Promise.all([h.read(),h.read(),h.read()]);await h.read();assert.equal(h.calls.length,1);
});
test('pending row can use the exact verified snapshot recording after promotion with zero cloud reads',async()=>{
 const saved={...waiting,pending:false,verified:true};const h=setup({saved});assert.equal(await h.read(),saved);assert.equal(h.calls.length,0);
});
test('pending endpoint promotion race falls back once to the same verified run',async()=>{
 const h=setup({fetchImpl:async url=>url.includes('/playbacks/')?reply({},404):reply({...waiting,pending:false,verified:true})});
 const result=await h.read();assert.equal(result.runId,runId);assert.equal(h.calls.length,2);assert.match(h.calls[1],/\/replays\//);
});
test('promotion fallback never substitutes another run, time, hash, or account',async()=>{
 for(const change of [{runId:'e'.repeat(64)},{timeMs:37000},{replayHash:'e'.repeat(64)},{accountId:'e'.repeat(64)}]){
 const h=setup({fetchImpl:async url=>url.includes('/playbacks/')?reply({},404):reply({...waiting,...change})});await assert.rejects(h.read(),/matching recording/);assert.equal(h.calls.length,2);
 }
});
test('quota response preserves Retry-After and never fans out to another endpoint',async()=>{
 const h=setup({fetchImpl:async()=>reply({},429,{'Retry-After':'120'})});await assert.rejects(h.read(),e=>e.retryAfterMs===120000);assert.equal(h.calls.length,1);
});
test('failed replay is retryable instead of caching a rejected promise',async()=>{
 let attempts=0;const h=setup({fetchImpl:async()=>++attempts===1?reply({},503):reply(waiting)});await assert.rejects(h.read());await h.read();assert.equal(h.calls.length,2);
});
test('archived missing recordings never trigger paid recovery and compatibility lockdown still applies',async()=>{
 const archived=setup({archived:true});await assert.rejects(archived.read(),/Archived replay/);assert.equal(archived.calls.length,0);
 const disabled=setup({enabled:false});await assert.rejects(disabled.read(),/matching recording/);assert.equal(disabled.calls.length,0);
});
test('replay failure UI uses a short retry and respects explicit quota cooldown',()=>{
 const client=fs.readFileSync(new URL('../events/client.mjs',import.meta.url),'utf8');const begin=client.indexOf('  function replayFailure('),end=client.indexOf('  async function selectEventRows(',begin);let now=100;
 const context=vm.createContext({replayFailures:new Map(),now:()=>now});vm.runInContext(client.slice(begin,end),context);
 context.rememberReplayFailure('one',Error('temporary'));assert.equal(context.replayFailures.get('one').until,15100);now=15101;assert.equal(context.replayFailure('one'),null);
 context.rememberReplayFailure('quota',{message:'wait',retryAfterMs:120000});assert.equal(context.replayFailures.get('quota').until,135101);
});

test('corrupt live inputs are rejected before caching and can be fetched again',async()=>{
 let attempts=0;const h=setup({fetchImpl:async()=>reply({...waiting,replay:++attempts===1?'corrupt':'payload'})});await assert.rejects(h.read(),/matching recording/);assert.equal((await h.read()).runId,runId);assert.equal(h.calls.length,2);
});

test('aggregate snapshot completeness remains false when pending payload capture is partial',()=>{
 const updater=fs.readFileSync(new URL('./update-public-snapshot.mjs',import.meta.url),'utf8');const begin=updater.indexOf('function makeCoverage('),end=updater.indexOf('async function updateMeta(',begin);const context=vm.createContext({});vm.runInContext(updater.slice(begin,end),context);
 const manifest={trackBackupsMissing:0,eventsMissing:0,pendingPlaybackCoverage:{known:3,published:2,missing:1,complete:false}},exported={complete:true,coverage:{complete:true,invalid:0,missing:0}};
 const partial=context.makeCoverage({complete:true},manifest,exported,null,null);assert.equal(partial.complete,false);assert.equal(partial.backup.pendingPlaybacks.missing,1);
 manifest.pendingPlaybackCoverage={known:3,published:3,missing:0,complete:true};assert.equal(context.makeCoverage({complete:true},manifest,exported,null,null).complete,true);
});

test('active weekly tracks do not wait seven days for an Overall summary before replay capture',async()=>{
 const {chooseTrackFetches}=await import('./public-snapshot-backup.mjs');const active='1'.repeat(64),other='2'.repeat(64),now=100*86400000;
 const prior={[active]:{path:null,missing:true,checkedAt:now-31*60000}};const summaries=[{trackId:other,updatedAt:now-1000}];
 assert.deepEqual(chooseTrackFetches([active,other],summaries,prior,1,now,[active]),[active]);
 prior[active].checkedAt=now-29*60000;assert.deepEqual(chooseTrackFetches([active,other],summaries,prior,1,now,[active]),[other]);
 prior[active]={path:'tracks/'+active+'.json',sourceUpdatedAt:100,checkedAt:now-31*60000};assert.deepEqual(chooseTrackFetches([active,other],[{trackId:active,updatedAt:100},...summaries],prior,1,now,[active]),[other],'unchanged known boards remain read-free');
 assert.equal(chooseTrackFetches([active,other],summaries,{},0,now,[active]).length,0,'the shared track read cap is unchanged');
});

 test('missing verified replay payloads also keep aggregate snapshot coverage incomplete',()=>{
 const updater=fs.readFileSync(new URL('./update-public-snapshot.mjs',import.meta.url),'utf8'),begin=updater.indexOf('function makeCoverage('),end=updater.indexOf('async function updateMeta(',begin),context=vm.createContext({});vm.runInContext(updater.slice(begin,end),context);
 const manifest={trackBackupsMissing:0,eventsMissing:0,pendingPlaybackCoverage:{complete:true},replayCoverage:{known:2,published:1,missing:1,complete:false}},exported={complete:true,coverage:{complete:true}};
 assert.equal(context.makeCoverage({complete:true},manifest,exported,null,null).complete,false);manifest.replayCoverage.complete=true;assert.equal(context.makeCoverage({complete:true},manifest,exported,null,null).complete,true);
 });
