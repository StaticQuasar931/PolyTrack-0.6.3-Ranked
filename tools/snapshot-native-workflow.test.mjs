import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import vm from 'node:vm';
const root=fileURLToPath(new URL('../',import.meta.url));
const load=async name=>(await fs.readFile(new URL('../.github/workflows/'+name,import.meta.url),'utf8')).replace(/\r\n/g,'\n');
const verify=await load('verify-runs.yml'),capture=await load('publish-verified-snapshots.yml');
function step(source,name) {
  const value=source.split(/(?=^      - )/m).find(block=>block.startsWith('      - name: '+name+'\n'));
  assert.ok(value,name);return value.split(/^  [a-z_]+:\n/m)[0];
}
const condition=value=>/^        if: (.+)$/m.exec(value)?.[1];
const evaluate=(expression,context)=>vm.runInNewContext(expression,context);

test('authority selection is explicit, default legacy, and invalid input never falls back',()=>{
  for(const [value,expected] of [['','firestore'],['firestore','firestore'],['snapshot-native','snapshot-native'],['typo',null],['snapshot-native ',null]]) {
    const result=spawnSync(process.execPath,[path.join(root,'tools/verifier/local-snapshot-verification.mjs'),'--authority',value],{encoding:'utf8'});
    assert.equal(result.status===0,expected!==null,result.stderr);
    if(expected) assert.equal(result.stdout.trim(),expected);
  }
  assert.match(step(verify,'Select verification authority'),/vars.POLYTRACK_VERIFICATION_AUTHORITY/);
  assert.match(capture,/verification_authority:\n[\s\S]*?default: ''/);
  assert.match(step(verify,'Select verification authority'),/readRepositoryVerificationAuthority\(process.cwd\(\),process.env.POLYTRACK_VERIFICATION_AUTHORITY\)/);
  assert.match(step(capture,'Validate verification authority'),/readRepositoryVerificationAuthority\(process.cwd\(\),value \|\| override\)/);
  assert.match(step(capture,'Validate verification authority'),/if\(value\)verificationAuthority\(value\)/);
  assert.match(step(capture,'Validate verification authority'),/if\(override\)verificationAuthority\(override\)/);
});

test('external mode cannot run due-queue reads or legacy verdict publication even with stale work output',()=>{
  for(const mode of ['firestore','snapshot-native']) for(const has_work of ['true','false','']) {
    const context={steps:{authority:{outputs:{mode}},queue:{outputs:{has_work}}}};
    assert.equal(evaluate(condition(step(verify,'Check for due verification work')),context),mode==='firestore');
    assert.equal(evaluate(condition(step(verify,'Verify queued runs')),context),mode==='firestore'&&has_work==='true');
  }
  assert.match(step(verify,'Verify queued runs'),/node tools\/post-verification-run.mjs --drain/);
  assert.match(verify,/verification_authority: \$\{\{ steps.authority.outputs.mode \}\}/);
  assert.match(verify,/verification_authority: \$\{\{ needs.verify.outputs.verification_authority \}\}/);
});

test('all four existing windows request combined capture in external mode without treating the queue as empty',()=>{
  assert.match(verify,/cron: '50 0,8,12,20 \* \* \*'/);
  const request=condition(step(verify,'Timestamp the scheduled or changed capture request'));
  for(const event_name of ['schedule','workflow_dispatch']) {
    const context={github:{event_name},steps:{authority:{outputs:{mode:'snapshot-native'}},queue:{outputs:{}},verification:{outputs:{}}}};
    assert.equal(evaluate(request,context),true);
  }
  assert.match(verify,/needs.verify.result == 'success' && \(needs.verify.outputs.verification_authority == 'snapshot-native' \|\|/);
  assert.match(step(capture,'Reuse a later published bounded capture'),/steps.authority.outputs.mode == 'firestore' && inputs.capture_requested_at \|\| ''/);
});

test('explicit authority flag reaches the parent capture hook; default command remains byte-identical',()=>{
  const command=step(capture,'Capture bounded public snapshots');
  assert.match(command,/if \[ "\$VERIFICATION_AUTHORITY" = "snapshot-native" \]; then\n            node tools\/update-public-snapshot.mjs --refresh-replays --verification-authority snapshot-native\n          else\n            node tools\/update-public-snapshot.mjs --refresh-replays\n          fi/);
  assert.ok(capture.indexOf(step(capture,'Validate verification authority'))<capture.indexOf(command));
  assert.match(command,/credential-scrubbed offline capability before final rebuild\/package/);
});

test('source commit is pinned before capture and separate locks remain non-cancelling',()=>{
  const pin=step(capture,'Pin offline verification source commit');
  assert.match(pin,/SNAPSHOT_NATIVE_SOURCE_COMMIT=\$\(git rev-parse --verify HEAD\)/);
  assert.ok(capture.indexOf(pin)<capture.indexOf(step(capture,'Capture public event assignments')));
  assert.match(capture,/group: public-repository-captures-\$\{\{ github.repository \}\}/);
  assert.match(verify,/group: polytrack-run-verifier/);
  for(const source of [verify,capture]) assert.match(source,/cancel-in-progress: false/);
});

test('native setup and unit tests never receive the source credential, and CDN receives no inherited secrets',()=>{
  for(const name of ['Test offline native authority contracts','Install offline native dependencies','Cache the pinned offline browser','Install the pinned offline browser','Allow the pinned offline browser sandbox']) {
    const value=step(capture,name);
    assert.equal(condition(value),"steps.authority.outputs.mode == 'snapshot-native'");
    assert.doesNotMatch(value,/FIREBASE|secrets\./);
  }
  assert.doesNotMatch(capture,/secrets: inherit/);
  const exposed=capture.split(/(?=^      - )/m).filter(value=>value.startsWith('      - ')&&/secrets\./.test(value));
  assert.equal(exposed.length,2);
  assert.match(exposed[0],/Capture public event assignments/);assert.match(exposed[1],/Capture bounded public snapshots/);
  const downstream=capture.slice(capture.indexOf('  publish_cdn_release:'));
  assert.match(downstream,/needs.sync.result == 'success' && needs.sync.outputs.publication_changed == 'true'/);
  assert.doesNotMatch(downstream,/secrets:/);
});

test('inherited reusable callers branch only on resolved authority before any credential exposure',()=>{
  const resolver=step(capture,'Validate verification authority');
  assert.match(resolver,/id: authority/);
  assert.ok(capture.indexOf(resolver)<capture.indexOf(step(capture,'Capture public event assignments')));
  assert.doesNotMatch(capture,/if: inputs.verification_authority/);
  assert.match(step(capture,'Capture bounded public snapshots'),/VERIFICATION_AUTHORITY: \$\{\{ steps.authority.outputs.mode \}\}/);
  assert.equal(condition(step(capture,'Pin offline verification source commit')),
    "steps.authority.outputs.mode == 'snapshot-native' || hashFiles('verification-ledger-current.json') != ''");
});

test('stored root proof pins/stages the ledger in Firestore mode without enabling native setup or changing server authority',async t=>{
  const pin=step(capture,'Pin offline verification source commit'),commit=step(capture,'Commit changed assignments');
  const safeguard=step(capture,'Test snapshot integrity and resumable capture');
  assert.match(safeguard,/tools\/update-public-snapshot-overlay.test.mjs/);
  assert.equal(condition(safeguard),undefined,'stored-proof safety tests run for both server modes');
  assert.ok(capture.indexOf(safeguard)<capture.indexOf(step(capture,'Capture public event assignments')));
  const predicate=/^          if (.+); then$/m.exec(commit)?.[1];
  assert.equal(predicate,'[ "$VERIFICATION_AUTHORITY" = "snapshot-native" ] || [ -f verification-ledger-current.json ]');
  assert.match(commit,/const files=await nativeLedgerPublicationFiles\(process.cwd\(\)\)/);
  assert.match(commit,/execFileSync\('git',\['add','--',\.\.\.files\]/);
  assert.doesNotMatch(commit,/git add[^\n]*verification-ledger|git add \./);
  assert.match(commit,/SNAPSHOT_NATIVE_SOURCE_COMMIT: \$\{\{ env.SNAPSHOT_NATIVE_SOURCE_COMMIT \}\}/);
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'workflow-proof-overlay-'));
  t.after(async()=>{assert.equal(path.dirname(directory),os.tmpdir());await fs.rm(directory,{recursive:true,force:true});});
  const bash=process.platform==='win32'&&existsSync('C:/Program Files/Git/bin/bash.exe')?'C:/Program Files/Git/bin/bash.exe':'bash';
  for(const present of [false,true]){
    if(present)await fs.writeFile(path.join(directory,'verification-ledger-current.json'),'{}');
    for(const mode of ['firestore','snapshot-native']){
      const expected=mode==='snapshot-native'||present;
      assert.equal(evaluate(condition(pin),{steps:{authority:{outputs:{mode}}},hashFiles:file=>{
        assert.equal(file,'verification-ledger-current.json');return present?'pinned-file-hash':'';
      }}),expected);
      const result=spawnSync(bash,['--noprofile','--norc','-e','-o','pipefail','-c',`if ${predicate}; then printf 'ledger'; fi`],
        {cwd:directory,encoding:'utf8',env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,VERIFICATION_AUTHORITY:mode}});
      assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,expected?'ledger':'');
      for(const name of ['Install offline native dependencies','Install the pinned offline browser'])
        assert.equal(evaluate(condition(step(capture,name)),{steps:{authority:{outputs:{mode}}}}),mode==='snapshot-native');
    }
  }
});
