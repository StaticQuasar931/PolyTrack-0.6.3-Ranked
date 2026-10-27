import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import {generateKeyPairSync} from 'node:crypto';
import {updatePublicSnapshot} from './update-public-snapshot.mjs';
import {DRAIN_LIMITS, CATCH_UP_LIMITS, budgetDatabase} from './verifier/throughput.mjs';

const names=['sync-event-catalog.yml','publish-verified-snapshots.yml','sync-kodub-weekly.yml',
  'publish-cdn-release.yml','verify-runs.yml'];
const workflows=Object.fromEntries(await Promise.all(names.map(async name=>[name,
  (await fs.readFile(new URL('../.github/workflows/'+name,import.meta.url),'utf8')).replace(/\r\n/g,'\n')])));
const captures=names.slice(0,3),cdn=workflows['publish-cdn-release.yml'],verifier=workflows['verify-runs.yml'];
const steps=source=>source.split(/(?=^      - )/m).slice(1).map(value=>value.split(/^  [a-z_]+:\n/m)[0]);
function step(source,name){const value=steps(source).find(value=>value.startsWith('      - name: '+name+'\n'));assert.ok(value,name);return value;}
function job(source,name){const start=source.indexOf('  '+name+':\n');assert.ok(start>=0,name);
  const end=source.slice(start+1).search(/^  [a-z_]+:\n/m);return source.slice(start,end<0?undefined:start+1+end);}
const condition=text=>/^    if: (.+)$/m.exec(text)?.[1];
const evaluate=(expression,context)=>vm.runInNewContext(expression,{
  format:(template,value)=>template.replace('{0}',value),...context});
const script=text=>{const match=/^        run: \|\n([\s\S]*?)(?=^      - |^  [a-z_]+:|$(?![\s\S]))/m.exec(text);
  assert.ok(match,'multiline shell script');return match[1].replace(/^          /gm,'');};
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'workflow-release-contract-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
const bash=process.platform==='win32'&&existsSync('C:/Program Files/Git/bin/bash.exe')?'C:/Program Files/Git/bin/bash.exe':'bash';

test('all five workflow entry jobs are canonical/default-branch guarded, with pinned external actions',()=>{
  for(const name of names){
    const source=workflows[name],primary=job(source,name==='publish-cdn-release.yml'?'publish':name==='verify-runs.yml'?'verify':'sync');
    assert.match(primary,/github.repository == 'StaticQuasar931\/PolyTrack-0.6.3-Ranked'/,name);
    assert.match(primary,/github.ref == format\('refs\/heads\/\{0\}', github.event.repository.default_branch\)/,name);
    assert.doesNotMatch(source,/pull_request_target:|workflow_run:|repository_dispatch:|secrets: inherit/,name);
    for(const [,action] of source.matchAll(/uses: ([^\s#]+)/g)){
      if(action.startsWith('./'))assert.equal(action,'./.github/workflows/'+(name==='verify-runs.yml'?'publish-verified-snapshots.yml':'publish-cdn-release.yml'));
      else assert.match(action,/^[\w-]+\/[\w/-]+@[a-f0-9]{40}$/,name);
    }
    for(const repository of ['StaticQuasar931/PolyTrack-0.6.3-Ranked','untrusted/fork'])for(const ref of ['refs/heads/main','refs/heads/untrusted']){
      const enabled=evaluate(condition(primary),{github:{repository,ref,event:{repository:{default_branch:'main'}}},
        vars:{POLYTRACK_VERIFIER_ENABLED:'true'},inputs:{publication_changed:true}});
      assert.equal(enabled,repository==='StaticQuasar931/PolyTrack-0.6.3-Ranked'&&ref==='refs/heads/main',name);
    }
  }
});

test('capture serialization remains shared/non-cancelling and CDN uses a separate latest-default-branch lock',()=>{
  for(const name of captures){
    assert.match(workflows[name],/group: public-repository-captures-\$\{\{ github.repository \}\}/);
    assert.match(workflows[name],/cancel-in-progress: false/);
    assert.match(workflows[name],/ref: \$\{\{ github.event.repository.default_branch \}\}/);
  }
  assert.match(cdn,/group: polytrack-cdn-release-\$\{\{ github.repository \}\}/);
  assert.doesNotMatch(cdn,/group: public-repository-captures-/);
  assert.match(cdn,/cancel-in-progress: false/);
  assert.match(cdn,/ref: \$\{\{ github.event.repository.default_branch \}\}/);
  assert.match(cdn,/fetch-depth: 0/);
});

test('all three bot-push publishers expose publication.changed and require a successful changed sync before CDN',()=>{
  for(const name of captures){
    const source=workflows[name],sync=job(source,'sync'),downstream=job(source,'publish_cdn_release');
    assert.match(sync,/outputs:\n      publication_changed: \$\{\{ steps.publication.outputs.changed \}\}/);
    const commit=step(source,name==='sync-kodub-weekly.yml'?'Commit changed capture':'Commit changed assignments');
    assert.match(commit,/id: publication/);assert.match(commit,/changed=false/);assert.match(commit,/changed=true/);
    assert.ok(commit.indexOf('git add')<commit.indexOf('git diff --cached --quiet'),'stage new files before no-op detection');
    assert.ok(commit.indexOf("echo 'changed=true'")>commit.indexOf('node tools/push-public-capture.mjs'));
    assert.match(downstream,/needs: sync/);assert.match(downstream,/uses: \.\/\.github\/workflows\/publish-cdn-release.yml/);
    for(const result of ['success','failure','cancelled','skipped'])for(const changed of ['true','false','',undefined]){
      assert.equal(evaluate(condition(downstream),{needs:{sync:{result,outputs:{publication_changed:changed}}}}),
        result==='success'&&changed==='true',name);
    }
    assert.doesNotMatch(downstream,/secrets:|refresh_only:/);
    assert.match(source,/tools\/workflow-release-contract.test.mjs/);
  }
});

test('actual commit scripts mark no-op false, successful bot push true, and never claim success after push failure',async t=>{
  const root=await fixture(t);await fs.writeFile(path.join(root,'snapshot-current.json'),'{}');
  for(const name of captures)for(const [changed,pushExit,expected] of [['false','0','changed=false\n'],['true','0','changed=true\n'],['true','1','']]){
    const commit=step(workflows[name],name==='sync-kodub-weekly.yml'?'Commit changed capture':'Commit changed assignments');
    // Execute the real YAML shell body. Both network-capable commands are shell mocks.
    const mock=`git(){ printf 'git %s\\n' "$*" >> calls; if [ "$1" = diff ]; then [ "$TEST_CHANGED" = false ]; else return 0; fi; }
node(){ printf 'node %s\\n' "$*" >> calls; return "$TEST_PUSH_EXIT"; }
`;
    await fs.writeFile(path.join(root,'calls'),'');await fs.writeFile(path.join(root,'output'),'');
    const result=spawnSync(bash,['--noprofile','--norc','-e','-o','pipefail','-c',mock+script(commit)],{
      cwd:root,encoding:'utf8',env:{...process.env,GITHUB_OUTPUT:'output',TEST_CHANGED:changed,TEST_PUSH_EXIT:pushExit}});
    assert.ifError(result.error);assert.equal(result.status,changed==='true'?Number(pushExit):0,result.stderr);
    assert.equal(await fs.readFile(path.join(root,'output'),'utf8'),expected,name);
    const calls=await fs.readFile(path.join(root,'calls'),'utf8');
    assert.equal(calls.includes('node tools/push-public-capture.mjs'),changed==='true',name);
  }
});

test('deferred or failed captures cannot open publication; weekly catalog-only publication remains valid',()=>{
  for(const name of captures.slice(0,2)){
    const commit=step(workflows[name],'Commit changed assignments'),expression=/^        if: (.+)$/m.exec(commit)[1];
    for(const catalogStatus of ['complete','deferred',''])for(const snapshotStatus of ['complete','deferred','']){
      assert.equal(evaluate(expression,{success:()=>true,github:{event_name:'workflow_dispatch',event:{}},
        steps:{catalog:{outputs:{capture_status:catalogStatus}},snapshot:{outputs:{capture_status:snapshotStatus},outcome:'success'}}}),
      catalogStatus==='complete'&&snapshotStatus==='complete',name);
    }
    assert.equal(evaluate(expression,{success:()=>false,github:{event_name:'workflow_dispatch',event:{}},
      steps:{catalog:{outputs:{capture_status:'complete'}},snapshot:{outputs:{capture_status:'complete'},outcome:'success'}}}),false);
    if(name==='sync-event-catalog.yml')assert.equal(evaluate(expression,{success:()=>true,
      github:{event_name:'schedule',event:{schedule:'19 20 * * 0'}},
      steps:{catalog:{outputs:{capture_status:'complete'}},snapshot:{outputs:{capture_status:''},outcome:'skipped'}}}),true);
  }
});

test('quarter-hour CDN recovery has typed opt-in dispatch/call modes, twenty-minute timeout, and no Firebase exposure',async t=>{
  assert.match(cdn,/schedule:\n(?:    #[^\n]*\n)*    - cron: '13,28,43,58 \* \* \* \*'/);
  assert.equal((cdn.match(/refresh_only:\n        description:[^\n]*\n        type: boolean\n        required: false\n        default: false/g)||[]).length,2);
  assert.match(job(cdn,'publish'),/timeout-minutes: 20/);
  assert.doesNotMatch(cdn.replace(/^\s*#.*$/gm,''),/FIREBASE|secrets\.|secrets:|firestore\.googleapis|tools\/verifier\/|post-verification|update-public-snapshot\.mjs|sync-event-catalog\.mjs/i);
  const publish=step(cdn,'Validate immutable assets, publish pointer, and confirm CDN refresh');
  assert.match(publish,/id: publication/);
  assert.match(job(cdn,'publish'),/outputs:\n      cdn_status: \$\{\{ steps.publication.outputs.cdn_status \}\}/);
  assert.match(cdn,/cdn_status:\n        description:[^\n]*\n        value: \$\{\{ jobs.publish.outputs.cdn_status \}\}/);
  assert.doesNotMatch(publish,/continue-on-error:|\|\| true|\|\| exit 0/);
  const optional=steps(cdn).filter(value=>/continue-on-error: true/.test(value));
  assert.equal(optional.length,2);assert.ok(optional.every(value=>/actions\/cache\/(restore|save)@/.test(value)));
  const mode=/CDN_REFRESH_ONLY: \$\{\{ (.+) \}\}/.exec(publish)[1];
  const root=await fixture(t);
  for(const event_name of ['schedule','workflow_dispatch','push','workflow_call'])for(const refresh_only of [true,false,undefined]){
    const expected=event_name==='schedule'||refresh_only===true;
    const value=evaluate(mode,{github:{event_name},inputs:{refresh_only}});assert.equal(value,expected?'true':'false');
    const result=spawnSync(bash,['--noprofile','--norc','-e','-o','pipefail','-c',
      'node(){ printf "%s\\n" "$*"; }\n'+script(publish)],{cwd:root,encoding:'utf8',env:{...process.env,CDN_REFRESH_ONLY:value}});
    assert.ifError(result.error);assert.equal(result.status,0,result.stderr);
    assert.equal(result.stdout.trim(),'tools/publish-cdn-release.mjs'+(expected?' --refresh-only':''));
  }
  const allowed=['actions/checkout','actions/setup-node','actions/cache/restore','actions/cache/save'];
  for(const [,action] of cdn.matchAll(/uses: ([^@\s]+)@/g))assert.ok(allowed.includes(action));
});

test('CDN-only purge checkpoint persists cooldown even on failure and contains no release credentials',()=>{
  const restore=step(cdn,'Restore CDN pointer purge cooldown'),save=step(cdn,'Save CDN pointer purge cooldown');
  assert.match(restore,/restore-keys:/);assert.match(save,/if: always\(\) && !cancelled\(\)/);
  assert.match(restore,/cdn-pointer-purge-v1-\$\{\{ github.repository_id \}\}/);
  assert.match(save,/\$\{\{ github.run_id \}\}-\$\{\{ github.run_attempt \}\}/);
  for(const value of [restore,save])assert.match(value,/path: \$\{\{ runner.temp \}\}\/polytrack-cdn-purge\/state.json/);
  assert.match(step(cdn,'Validate immutable assets, publish pointer, and confirm CDN refresh'),/CDN_PURGE_STATE_FILE:/);
});

test('the existing privileged secret is step-scoped and forwarded explicitly, never passed to CDN or Kodub',()=>{
  for(const name of captures.slice(0,2)){
    const exposed=steps(workflows[name]).filter(value=>/secrets\./.test(value));assert.equal(exposed.length,1);
    assert.match(exposed[0],/name: Capture bounded public snapshots/);
    assert.match(exposed[0],/FIREBASE_VERIFIER_SERVICE_ACCOUNT: \$\{\{ secrets.FIREBASE_VERIFIER_SERVICE_ACCOUNT \}\}/);
    assert.match(exposed[0],/node tools\/update-public-snapshot.mjs --refresh-replays/);
    assert.doesNotMatch(exposed[0],/--full-public|--admin|--archive|continue-on-error/);
  }
  const call=job(verifier,'publish_snapshots');
  assert.match(call,/secrets:\n      FIREBASE_VERIFIER_SERVICE_ACCOUNT: \$\{\{ secrets.FIREBASE_VERIFIER_SERVICE_ACCOUNT \}\}/);
  assert.match(workflows['publish-verified-snapshots.yml'],/workflow_call:\n    secrets:\n      FIREBASE_VERIFIER_SERVICE_ACCOUNT:\n        required: true/);
  assert.doesNotMatch(workflows['sync-kodub-weekly.yml'],/FIREBASE|secrets\./);
  const exposed=steps(verifier).filter(value=>/secrets\./.test(value));
  assert.equal(exposed.length,2);assert.match(exposed[0],/name: Check for due verification work/);assert.match(exposed[1],/name: Verify queued runs/);
});

test('real updater and exporter stop incremental replay reads at 100 documents using only mocked authenticated requests',async t=>{
  const root=await fixture(t),track='b'.repeat(64),directory=path.join(root,'local-reports/snapshot-staging/tracks');
  await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(root,'index.html'),'<html><head></head></html>');
  const entries=Array.from({length:101},(_,i)=>({accountId:(i+1).toString(16).padStart(64,'0'),trackId:track,
    uploadId:i+1,frames:900,timeMs:15000,replayHash:'a'.repeat(64),runVerified:true,integrityVerified:true}));
  await fs.writeFile(path.join(directory,track+'.json'),JSON.stringify({trackId:track,entries}));
  const privateKey=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'});
  let documents=0,requests=0,exchanges=0;
  const result=await updatePublicSnapshot({root,refreshReplays:true,capture:async()=>({}),log:()=>{},
    exportAuth:{serviceAccount:{type:'service_account',project_id:'polytrack-052',
      client_email:'fixture@polytrack-052.iam.gserviceaccount.com',private_key:privateKey},
      oauthFetch:async()=>{exchanges++;return Response.json({access_token:'fixture-token',token_type:'Bearer',expires_in:3600});}},
    exportFetch:async(url,options)=>{
      assert.equal(url,'https://firestore.googleapis.com/v1/projects/polytrack-052/databases/(default)/documents:batchGet');
      assert.equal(options.method,'POST');assert.equal(options.redirect,'error');assert.equal(options.headers.get('authorization'),'Bearer fixture-token');
      const body=JSON.parse(options.body);assert.ok(body.documents.length<=20);documents+=body.documents.length;requests++;
      return Response.json(body.documents.map(missing=>({missing})));
    }});
  assert.equal(documents,100);assert.equal(requests,5);assert.equal(exchanges,1);
  assert.equal(result.profileReplay.fetchedDocumentsThisRun,100);assert.equal(result.profileReplay.budgetReached,true);
  assert.equal(result.profileReplay.knownVerifiedBindings,101);assert.equal(result.coverage.complete,false);
});

test('normal verifier budget enforces 400 requests and expanded catch-up remains manual-only',async()=>{
  assert.equal(DRAIN_LIMITS.requests,400);assert.equal(CATCH_UP_LIMITS.requests,1200);
  let calls=0;const db=budgetDatabase({call:async()=>{calls++;return null;}});
  for(let i=0;i<400;i++)await db.call('/mock/document');
  await assert.rejects(db.call('/mock/overflow'),/verification_request_budget/);assert.equal(calls,400);
  const verify=step(verifier,'Verify queued runs');
  const catchUp=/VERIFIER_CATCH_UP: \$\{\{ (.+) \}\}/.exec(verify)[1];
  for(const event_name of ['schedule','workflow_dispatch','push'])for(const catch_up of [true,false,undefined]){
    assert.equal(evaluate(catchUp,{github:{event_name},inputs:{catch_up}}),event_name==='workflow_dispatch'&&catch_up===true?'true':'false');
  }
  assert.match(verify,/if \[ "\$VERIFIER_CATCH_UP" = "true" \]; then\n            node tools\/post-verification-run.mjs --drain --catch-up\n          else\n            node tools\/post-verification-run.mjs --drain/);
  const runtime=await fs.readFile(new URL('./verifier/run.mjs',import.meta.url),'utf8');
  assert.match(runtime,/catchUp && env.GITHUB_EVENT_NAME !== 'workflow_dispatch'/);
  assert.ok(runtime.indexOf("catchUp && env.GITHUB_EVENT_NAME !== 'workflow_dispatch'")<runtime.indexOf('const raw = env.FIREBASE_VERIFIER_SERVICE_ACCOUNT'));
});


test('queue and publication regression gates run offline before verifier preflight',()=>{
 const guard=step(verifier,'Test queue and publication contracts before quota access');
 assert.match(guard,/node --test tools\/verifier\/queue.test.mjs tools\/verifier\/publication-queue.test.mjs/);
 assert.doesNotMatch(guard,/FIREBASE_VERIFIER_SERVICE_ACCOUNT|if:|secrets\./);
 assert.ok(verifier.indexOf(guard)<verifier.indexOf(step(verifier,'Check for due verification work')));
});
