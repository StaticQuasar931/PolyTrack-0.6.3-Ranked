import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {needsSnapshot, verifyAndSignal} from './post-verification-run.mjs';
import {drainVerification} from './verifier/throughput.mjs';
import {chooseTrackFetches} from './public-snapshot-backup.mjs';
import {pushPublicCapture} from './push-public-capture.mjs';

const readWorkflow = async name => (await fs.readFile(new URL('../.github/workflows/' + name, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const verifier = await readWorkflow('verify-runs.yml');
const publisher = await readWorkflow('publish-verified-snapshots.yml');
const catalog = await readWorkflow('sync-event-catalog.yml');
const complete = patch => ({countsComplete:true, interruptedRound:false, stop:'no_progress', verified:0, mismatch:0, ...patch});
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'post-verification-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const env = {GITHUB_OUTPUT:path.join(root, 'output'), GITHUB_STEP_SUMMARY:path.join(root, 'summary')};
  return {root, env, output:() => fs.readFile(env.GITHUB_OUTPUT, 'utf8')};
}
const step = (source, name) => {
  const start = source.indexOf('      - name: ' + name + '\n');
  assert.ok(start >= 0, name);
  const next = source.indexOf('\n      - ', start + 1);
  return source.slice(start, next < 0 ? undefined : next);
};
const condition = text => /^    if: (.+)$/m.exec(text)[1];
const evaluate = (expression, context) => vm.runInNewContext(expression, {
  format:(template,value) => template.replace('{0}',value), ...context,
});

test('only confirmed normal public verdict changes request a capture', () => {
  for (const row of [complete({verified:23}), complete({mismatch:1}), complete({verified:1, corrected:1})]) assert.equal(needsSnapshot(row),true);
  for (const row of [undefined, {}, complete(), complete({processed:27,eventChecked:8,unavailable:4}), complete({superseded:2,deferred:2})]) assert.equal(needsSnapshot(row),false);
});

test('unknown, interrupted, throttled and infrastructure outcomes fail closed', () => {
  for (const stop of ['infrastructure_failure','firestore_throttled','event_conflict','request_budget','future_stop',undefined])
    assert.equal(needsSnapshot(complete({verified:23,stop})),false, String(stop));
  for (const patch of [{countsComplete:false},{interruptedRound:true},{deferred:true},{countsComplete:undefined},{interruptedRound:undefined}])
    assert.equal(needsSnapshot(complete({verified:23,...patch})),false);
});

test('valid completed budget and time boundaries preserve committed changes', () => {
  for (const stop of ['round_limit','time_reserve','request_reserve','no_progress','budget_deferred'])
    assert.equal(needsSnapshot(complete({verified:1,stop})),true);
});

test('invalid counts and event-attempt counts do not manufacture publication', () => {
  for (const value of [-1,1.5,'23',NaN,Infinity,Number.MAX_SAFE_INTEGER+1,null]) {
    assert.equal(needsSnapshot(complete({verified:value,mismatch:value})),false);
    assert.equal(needsSnapshot(complete(),value),false);
  }
});

test('wrapper preserves verifier options and adds no fetch or database discovery', async t => {
  const f = await fixture(t); let calls=0;
  const result = await verifyAndSignal({env:f.env,catchUp:true,verify:async options => {
    calls++; assert.equal(options.env,f.env); assert.equal(options.drain,true); assert.equal(options.catchUp,true);
    assert.equal(typeof options.eventRun,'function'); return complete({verified:23,processed:27,eventChecked:8});
  }});
  assert.equal(calls,1); assert.equal(result.snapshotNeeded,true);
  assert.equal(await f.output(),'snapshot_needed=false\nsnapshot_needed=true\n');
  assert.match(await fs.readFile(f.env.GITHUB_STEP_SUMMARY,'utf8'),/completed verdicts, competitive-review holds and archives/);
});

test('wrapper leaves only the false output on thrown verifier failure', async t => {
  const f=await fixture(t);
  await assert.rejects(verifyAndSignal({env:f.env,verify:async()=>{throw Error('offline infrastructure failure');}}),/infrastructure failure/);
  assert.equal(await f.output(),'snapshot_needed=false\n');
});

test('unavailable, superseded and intake-only events do not request snapshots', async t => {
  for (const event of [{results:[{status:'unavailable'},{status:'superseded'}],consumed:4}, {results:[],consumed:4,rejected:true}, {results:[],archived:null}]) {
    const f=await fixture(t);
    const result=await verifyAndSignal({env:f.env,eventRun:async()=>event,verify:async({eventRun})=>{
      assert.equal(await eventRun('offline-db','offline-root',{}),event); return complete();
    }});
    assert.equal(result.snapshotNeeded,false);
  }
});

test('committed event-only verdicts and archives request publication', async t => {
  for (const event of [{results:[{status:'verified'}]}, {results:[{status:'mismatch'}]}, {results:[],archived:'d_20261022'}]) {
    const f=await fixture(t);let calls=0;
    const result=await verifyAndSignal({env:f.env,eventRun:async(...args)=>{
      calls++;assert.deepEqual(args,['offline-db','offline-root',{limit:4}]);return event;
    },verify:async({eventRun})=>{await eventRun('offline-db','offline-root',{limit:4});return complete();}});
    assert.equal(calls,1);assert.equal(result.snapshotNeeded,true);
  }
});

test('events completed before a later interrupted round cannot open the success gate', async t => {
  const f=await fixture(t);
  const result=await verifyAndSignal({env:f.env,eventRun:async()=>({results:[{status:'verified'}]}),verify:async({eventRun})=>{
    await eventRun();return complete({verified:23,countsComplete:false,interruptedRound:true,stop:'event_conflict'});
  }});
  assert.equal(result.snapshotNeeded,false);
});

test('process failure exit status suppresses publication even with a complete summary', async t => {
  const f=await fixture(t), previous=process.exitCode;
  try {
    process.exitCode=1;
    assert.equal((await verifyAndSignal({env:f.env,verify:async()=>complete({verified:23})})).snapshotNeeded,false);
  } finally {process.exitCode=previous;}
});

test('real offline drain aggregation feeds the wrapper without modifying core', async t => {
  const f=await fixture(t);let rounds=0;
  const result=await verifyAndSignal({env:f.env,verify:async()=>drainVerification({requests:()=>345,now:()=>0,log:()=>{},runRound:async()=>{
    rounds++;
    return {processed:27,verified:23,mismatch:0,unavailable:4,events:{checked:8,consumed:0},reasons:{scan_work_limit:4}};
  }})});
  assert.equal(rounds,4);assert.equal(result.summary.verified,92);assert.equal(result.snapshotNeeded,true);
});

test('sidecar CLI rejects unsupported modes before any production connection', () => {
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('./post-verification-run.mjs',import.meta.url)),'--check'],{encoding:'utf8',env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot}});
  assert.equal(result.status,1);assert.match(result.stderr,/Expected --drain/);
});

test('caller requires successful changed-publication output and preserves an explicit opt-out', () => {
  const call=verifier.slice(verifier.indexOf('  publish_snapshots:'));
  assert.match(call,/needs: verify/);assert.match(call,/uses: \.\/\.github\/workflows\/publish-verified-snapshots.yml/);
  assert.match(call,/contents: write/);assert.match(call,/secrets:\n      FIREBASE_VERIFIER_SERVICE_ACCOUNT: \$\{\{ secrets\.FIREBASE_VERIFIER_SERVICE_ACCOUNT \}\}/);assert.doesNotMatch(call,/secrets: inherit/);
  for (const result of ['success','failure','cancelled','skipped']) for (const needed of ['true','false','',undefined]) for (const enabled of ['true','false','',undefined]) {
    const actual=evaluate(condition(call),{needs:{verify:{result,outputs:{snapshot_needed:needed}}},vars:{POLYTRACK_POST_VERIFY_SNAPSHOTS_ENABLED:enabled}});
    assert.equal(actual,result==='success'&&needed==='true'&&enabled!=='false');
  }
  assert.match(verifier,/snapshot_needed: \$\{\{ steps.verification.outputs.snapshot_needed \}\}/);
  assert.match(step(verifier,'Verify queued runs'),/id: verification/);
  assert.match(step(verifier,'Verify queued runs'),/node tools\/post-verification-run.mjs --drain --catch-up/);
});

test('reusable publisher is default-branch/repository restricted and cannot wake itself', () => {
  assert.match(publisher,/on:\n  workflow_call:/);
  assert.doesNotMatch(publisher,/^  (schedule|workflow_run|workflow_dispatch|pull_request|pull_request_target|repository_dispatch):/m);
  assert.doesNotMatch(publisher,/secrets: inherit|download-artifact|github\.event\.workflow_run\./);
  const guard=condition(publisher);
  for (const publication_changed of [true,false]) for (const enabled of ['true','false','',undefined]) for (const repository of ['StaticQuasar931/PolyTrack-0.6.3-Ranked','other/fork']) for (const ref of ['refs/heads/main','refs/heads/untrusted']) {
    const actual=evaluate(guard,{inputs:{publication_changed},vars:{POLYTRACK_POST_VERIFY_SNAPSHOTS_ENABLED:enabled},github:{repository,ref,event:{repository:{default_branch:'main'}}}});
    assert.equal(actual,publication_changed&&enabled!=='false'&&repository==='StaticQuasar931/PolyTrack-0.6.3-Ranked'&&ref==='refs/heads/main');
  }
  assert.match(publisher,/ref: \$\{\{ github.event.repository.default_branch \}\}/);
});

test('publisher and other capture workflows share a non-cancelling serialization lock', async () => {
  for (const source of [publisher,catalog,await readWorkflow('sync-kodub-weekly.yml')]) {
    assert.match(source,/group: public-repository-captures-\$\{\{ github.repository \}\}/);
    assert.match(source,/cancel-in-progress: false/);
  }
  assert.match(verifier,/group: polytrack-run-verifier/);
});

test('publisher reuses the tested retry sanitizer byte-for-byte, never the raw private checkpoint', () => {
  const embedded=source=>source.match(/<<'NODE'\n([\s\S]*?)^          NODE$/m)?.[1];
  assert.ok(embedded(publisher));assert.equal(embedded(publisher),embedded(catalog));
  const paths=[...publisher.matchAll(/^          path: (.+)$/gm)].map(match=>match[1]);
  assert.deepEqual(paths,['${{ runner.temp }}/polytrack-replay-retries/history.json','${{ runner.temp }}/polytrack-replay-retries/history.json']);
  assert.match(publisher,/replay-retries-v1-\$\{\{ github.repository_id \}\}-\$\{\{ github.event.repository.default_branch \}\}/);
  assert.doesNotMatch(publisher,/git add[^\n]*(?:local-reports|export-progress|history\.json)/);
  assert.match(step(publisher,'Retain validated private replay retry ledger'),/steps.snapshot.outcome == 'failure'/);
});

test('all publisher actions are pinned and only bounded read-only export is enabled', () => {
  for (const match of publisher.matchAll(/uses: (actions\/[^\s]+)/g)) assert.match(match[1],/@[a-f0-9]{40}$/);
  assert.match(step(publisher,'Capture bounded public snapshots'),/node tools\/update-public-snapshot.mjs --refresh-replays/);
  assert.doesNotMatch(publisher,/--full-public|archiveExport|FIREBASE_ADMIN/);
});

test('deferred public captures cannot publish and public commits reuse the robust push helper', () => {
  const commit=step(publisher,'Commit changed assignments');
  assert.match(commit,/if: success\(\) && steps.catalog.outputs.capture_status == 'complete' && steps.snapshot.outputs.capture_status == 'complete'/);
  assert.match(commit,/git add -- events\/public-catalog.json/);
  assert.match(commit,/git add -- index.html snapshot-current.json/);
  assert.match(commit,/git add -A -- ':\(glob\)public-snapshots\[0-9\]\*\/\*\*'/);
  assert.match(commit,/node tools\/push-public-capture.mjs/);
  assert.doesNotMatch(commit,/git push|--force|git add \./);
});

test('daily and manual captures always reconcile regardless of combined-publishing variables', () => {
  const capture=step(catalog,'Capture bounded public snapshots');
  assert.match(capture,/run: node tools\/update-public-snapshot.mjs --refresh-replays/);
  assert.doesNotMatch(capture,/COMBINED_SNAPSHOTS|vars\.|Catalog-only|echo 'capture_status=complete'/);
  const gate=/^        if: (.+)$/m.exec(capture)[1];
  for(const verifierEnabled of ['true','false','',undefined]) for(const combined of ['true','false','',undefined]) {
    const vars={POLYTRACK_VERIFIER_ENABLED:verifierEnabled,POLYTRACK_POST_VERIFY_SNAPSHOTS_ENABLED:combined};
    for(const [event_name,schedule,expected] of [['schedule','20 0 * * *',true],['workflow_dispatch',undefined,true],['schedule','19 20 * * 0',false]]) {
      assert.equal(evaluate(gate,{vars,github:{event_name,event:{schedule}},steps:{coordination:{outputs:{reuse:'false'}},catalog:{outputs:{capture_status:'complete'}}}}),expected);
    }
    assert.equal(evaluate(gate,{vars,github:{event_name:'schedule',event:{schedule:'20 0 * * *'}},steps:{coordination:{outputs:{reuse:'false'}},catalog:{outputs:{capture_status:'deferred'}}}}),false);
  }
});

test('incremental capture selection does not re-read unchanged published tracks', () => {
  const a='a'.repeat(64),b='b'.repeat(64);
  const previous={[a]:{path:'tracks/'+a+'.json',sourceUpdatedAt:5},[b]:{path:'tracks/'+b+'.json',sourceUpdatedAt:5}};
  assert.deepEqual(chooseTrackFetches([a,b],[{trackId:a,updatedAt:5},{trackId:b,updatedAt:5}],previous),[]);
  assert.deepEqual(chooseTrackFetches([a,b],[{trackId:a,updatedAt:6},{trackId:b,updatedAt:5}],previous),[a]);
});

test('newer main snapshot cannot be overwritten by an older post-verification publisher', async t => {
  const f=await fixture(t), config=path.join(f.root,'empty.gitconfig');await fs.writeFile(config,'');
  const env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:config,GIT_TERMINAL_PROMPT:'0',GIT_EDITOR:'true',GIT_SEQUENCE_EDITOR:'true'};
  const git=(cwd,...args)=>execFileSync('git',['-c','safe.directory='+cwd,...args],{cwd,env,stdio:'pipe'});
  const remote=path.join(f.root,'remote.git'),a=path.join(f.root,'a'),b=path.join(f.root,'b');
  git(f.root,'init','--bare','--initial-branch=main',remote);git(f.root,'clone',remote,a);
  git(a,'config','user.email','offline@example.invalid');git(a,'config','user.name','Offline Test');
  await fs.writeFile(path.join(a,'snapshot-current.json'),'{"currentdir":"public-snapshots1"}\n');
  git(a,'add','.');git(a,'commit','-m','base');git(a,'push','origin','main');git(f.root,'clone',remote,b);
  git(b,'config','user.email','offline@example.invalid');git(b,'config','user.name','Offline Test');
  for (const [repo,generation] of [[a,3],[b,2]]) {
    await fs.writeFile(path.join(repo,'snapshot-current.json'),JSON.stringify({currentdir:'public-snapshots'+generation})+'\n');
    git(repo,'add','.');git(repo,'commit','-m','snapshot'+generation);
  }
  pushPublicCapture({branch:'main',run:(_,args)=>git(a,...args)});
  assert.throws(()=>pushPublicCapture({branch:'main',run:(_,args)=>git(b,...args)}),/conflict/);
  assert.equal(JSON.parse(git(f.root,'--git-dir='+remote,'show','main:snapshot-current.json').toString()).currentdir,'public-snapshots3');
  assert.equal(git(b,'status','--porcelain').toString(),'');
});

test('post-verification capture is single-shot, projected read-only, and never requests archive recovery', () => {
  const capture=step(publisher,'Capture bounded public snapshots');
  assert.equal((capture.match(/node tools\/update-public-snapshot.mjs --refresh-replays/g)||[]).length,1);
  assert.doesNotMatch(capture,/continue-on-error|while |until |--full-public|--archive|--admin|curl |sleep /);
  assert.doesNotMatch(publisher,/archiveExport:|--repair-archives|--rebuild|forceRebuild/);
});

test('helper explicitly warns that capture is not a published-revision freshness barrier', async () => {
  const source=await fs.readFile(new URL('./post-verification-run.mjs',import.meta.url),'utf8');
  assert.match(source,/does not force rebuilds or wait for a published revision/);
  assert.match(source,/new package is not proof of aggregate freshness/);
});

test('one daily reconciliation prevents last-verdict staleness without adding idle polling', () => {
  const cron=[...catalog.matchAll(/cron: '([^']+)'/g)].map(match=>match[1]);
  assert.deepEqual(cron,['20 0 * * *','19 20 * * 0']);
  assert.equal((catalog.match(/node tools\/update-public-snapshot.mjs --refresh-replays/g)||[]).length,1);
  assert.doesNotMatch(step(catalog,'Capture bounded public snapshots'),/--full-public|while |until |sleep |continue-on-error/);
  assert.match(step(publisher,'Capture bounded public snapshots'),/steps.catalog.outputs.capture_status == 'complete'/);
  assert.doesNotMatch(publisher,/^  schedule:/m);
});

test('daily reconciliation stays at 00:20 UTC and Sunday catalog follows bounded Kodub capture', async () => {
  assert.match(catalog,/cron: '20 0 \* \* \*'/);
  assert.doesNotMatch(catalog,/30 10 \* \* \*/);
  assert.match(catalog,/cron: '19 20 \* \* 0'/);
  assert.match(await readWorkflow('sync-kodub-weekly.yml'),/cron: "3 20 \* \* \*"/);
  assert.equal((catalog.match(/'20 0 \* \* \*'/g)||[]).length,4);
});


test('committed competitive-review holds request snapshots without treating generic unavailability as a change',()=>{
 const reason='similar_replay_pending_manual_review';
 assert.equal(needsSnapshot(complete({unavailable:1,reasons:{[reason]:1}})),true);
 for(const value of [0,-1,'1',NaN])assert.equal(needsSnapshot(complete({unavailable:1,reasons:{[reason]:value}})),false);
 assert.equal(needsSnapshot(complete({unavailable:1,reasons:{engine_unavailable:1}})),false);
 assert.equal(needsSnapshot(complete({unavailable:1,reasons:{[reason]:1},countsComplete:false})),false);
});

test('only committed terminal event review holds request capture, not attempts or duplicate completion',async t=>{
 for(const [row,expected]of [
  [{status:'unavailable_final',reason:'similar_replay_pending_manual_review'},true],
  [{status:'unavailable_final',reason:'similar_replay_pending_manual_review',duplicate:true},false],
  [{status:'unavailable',reason:'similar_replay_pending_manual_review'},false],
  [{status:'waiting',reason:'similar_replay_pending_manual_review'},false],
  [{status:'unavailable_final',reason:'engine_unavailable'},false]]){
  const f=await fixture(t);let calls=0;
  const result=await verifyAndSignal({env:f.env,eventRun:async()=>{calls++;return {results:[row]};},verify:async({eventRun})=>{await eventRun();return complete();}});
  assert.equal(result.snapshotNeeded,expected);assert.equal(calls,1);
 }
});
