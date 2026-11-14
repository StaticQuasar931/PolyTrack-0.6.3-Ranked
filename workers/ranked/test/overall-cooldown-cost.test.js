import test from 'node:test';
import assert from 'node:assert/strict';
import {OWNER_CHALLENGE_POLICY_VERSION} from '../src/server-achievements.js';
import {rebuildOverall} from '../src/index.js';
import {eventEncode} from '../src/events-store.js';

const modern = {ownerChallengePolicyVersion:OWNER_CHALLENGE_POLICY_VERSION, plannerPublicationVersion:999, plannerBundleVersion:999, cosmeticEntitlementVersion:999,
  averagePlacementVersion:999, derivedMetricsVersion:999, builtRevision:12};
function fixture(meta) {
  const calls = [];
  return {calls, env:{__TEST_FIRESTORE:async(route)=>{
    calls.push(route);
    if (route !== '/0.6.2_s1_release_meta/current') throw Error('SCAN_STARTED');
    return {fields:eventEncode(meta).mapValue.fields,updateTime:'v1'};
  }}};
}

for (const catalog of [undefined,{version:1,complete:false}]) {
  test('incomplete catalog cannot bypass 30-minute successful rebuild cooldown: '+JSON.stringify(catalog), async()=>{
    const f = fixture({...modern,dirty:true,sourceCatalog:catalog ?? null,lastOverallBuildAt:Date.now()-5*60000});
    for (let i=0;i<12;i++) assert.equal((await rebuildOverall(f.env)).reason,'cooldown');
    assert.deepEqual(f.calls,Array(12).fill('/0.6.2_s1_release_meta/current'));
  });
}

test('exhausted incomplete revision waits six hours with one metadata read and no writes', async()=>{
  const f = fixture({...modern,dirty:false,overallRetryExhausted:true,sourceCatalog:{complete:false},
    lastOverallBuildAt:Date.now()-3600000});
  for (let i=0;i<12;i++) assert.equal((await rebuildOverall(f.env)).reason,'incomplete_cooldown');
  assert.deepEqual(f.calls,Array(12).fill('/0.6.2_s1_release_meta/current'));
});

for (const change of ['forced','new_revision','rescan_due','metrics_upgrade']) test(change+' still permits repair', async()=>{
  const meta = {...modern,dirty:false,overallRetryExhausted:true,sourceCatalog:{complete:false},
    lastOverallBuildAt:Date.now()-3600000};
  if (change === 'new_revision') meta.dirty = true;
  if (change === 'rescan_due') meta.lastOverallBuildAt -= 6*3600000;
  if (change === 'metrics_upgrade') meta.derivedMetricsVersion = 0;
  const f = fixture(meta);
  await assert.rejects(rebuildOverall(f.env,change === 'forced'),/SCAN_STARTED/);
  assert.ok(f.calls.includes(':runQuery'),'an authoritative scan is attempted');
});
