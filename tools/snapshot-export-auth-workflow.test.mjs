import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const read=async name=>(await fs.readFile(new URL('../.github/workflows/'+name,import.meta.url),'utf8')).replace(/\r\n/g,'\n');
test('only trusted capture steps receive the single existing credential',async()=>{
  for(const file of ['publish-verified-snapshots.yml','sync-event-catalog.yml']) {
    const source=await read(file);
    assert.doesNotMatch(source,/secrets: inherit/);
    assert.match(source,/github.repository == 'StaticQuasar931\/PolyTrack-0.6.3-Ranked'/);
    assert.match(source,/github.ref == format\('refs\/heads\/\{0\}', github.event.repository.default_branch\)/);
    assert.match(source,/ref: \$\{\{ github.event.repository.default_branch \}\}/);
    const steps=source.split(/(?=^      - )/m);
    const exposed=steps.filter(step=>/secrets\./.test(step));
    assert.equal(exposed.length,2);assert.match(exposed[0],/name: Capture public event assignments/);
    assert.match(exposed[0],/await checkWorkerCaptureAccess\(\)/);
    assert.match(exposed[1],/name: Capture bounded public snapshots/);
    for(const step of exposed){
      assert.match(step,/FIREBASE_VERIFIER_SERVICE_ACCOUNT: \$\{\{ secrets.FIREBASE_VERIFIER_SERVICE_ACCOUNT \}\}/);
      assert.doesNotMatch(step,/--full-public|continue-on-error/);
    }
    assert.match(exposed[1],/run: node tools\/update-public-snapshot.mjs --refresh-replays/);
    assert.deepEqual([...source.matchAll(/secrets\.([A-Z_]+)/g)].map(m=>m[1]),['FIREBASE_VERIFIER_SERVICE_ACCOUNT','FIREBASE_VERIFIER_SERVICE_ACCOUNT']);
    assert.match(source,/tools\/snapshot-export-auth.test.mjs tools\/snapshot-export-auth-workflow.test.mjs/);
  }
});
test('workflow_call declares and caller explicitly forwards only the verifier service account',async()=>{
  const publisher=await read('publish-verified-snapshots.yml');
  assert.match(publisher,/workflow_call:\n    secrets:\n      FIREBASE_VERIFIER_SERVICE_ACCOUNT:\n        required: true/);
  const verifier=await read('verify-runs.yml'),call=verifier.slice(verifier.indexOf('  publish_snapshots:'));
  assert.doesNotMatch(call,/secrets: inherit/);
  assert.match(call,/    secrets:\n      FIREBASE_VERIFIER_SERVICE_ACCOUNT: \$\{\{ secrets.FIREBASE_VERIFIER_SERVICE_ACCOUNT \}\}/);
  assert.equal((call.match(/secrets\./g)||[]).length,1);
  assert.equal(/^    if: (.+)$/m.exec(call)?.[1],
    "needs.verify.result == 'success' && ((github.event_name == 'schedule' && (needs.verify.outputs.queue_has_work == 'false' || (needs.verify.outputs.queue_has_work == 'true' && needs.verify.outputs.capture_ready == 'true'))) || needs.verify.outputs.snapshot_needed == 'true') && vars.POLYTRACK_POST_VERIFY_SNAPSHOTS_ENABLED != 'false'");
  assert.doesNotMatch(publisher,/public endpoints only|no secrets inheritance/);
});
