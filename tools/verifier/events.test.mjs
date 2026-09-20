import test from 'node:test';
import assert from 'node:assert/strict';
import { runEventCoordinator, EVENT_JOB_LIMIT } from './events.mjs';

function fixture(counts, inboxCount = 0, unavailable = false) {
  let intakes = 0, native = 0;
  const batches = [];
  const runtime = { service: {
    processBatch: async (period, verify, limit) => {
      assert(limit <= 4);
      const count = Math.min(counts[period], limit); counts[period] -= count;
      if (!count) return [];
      batches.push({ period, count });
      const jobs = Array.from({ length: count }, (_, i) => ({ resultId: `${period}_${counts[period]}_${i}` }));
      return verify(jobs, { id: period, kind: 'custom', trackId: 'a'.repeat(64) });
    }, archivePeriod: async () => assert.fail('unexpected archive')
  }};
  const options = { verifyBatch: async (_root, jobs) => { native += jobs.length; return jobs.map(j => ({ ...j, reason: unavailable ? 'engine_unavailable' : 'native_exact_finish' })); },
    consumeInbox: async () => ({ consumed: intakes++ < inboxCount ? 1 : 0 }),
    readWork: async () => ({ periodIds: Object.keys(counts), archiveId: null }) };
  return { runtime, options, batches, native: () => native, intakes: () => intakes };
}
test('one event period can consume sixteen jobs in four bounded native batches', async () => {
  const f = fixture({ daily: 100 });
  const result = await runEventCoordinator(f.runtime, '/repo', f.options);
  assert.equal(EVENT_JOB_LIMIT, 16); assert.equal(result.checked, 16);
  assert.equal(f.native(), 16); assert.deepEqual(f.batches.map(b => b.count), [4, 4, 4, 4]);
});
test('daily and weekly share one global sixteen-job budget', async () => {
  const f = fixture({ daily: 100, weekly: 100 });
  const result = await runEventCoordinator(f.runtime, '/repo', f.options);
  assert.equal(result.checked, 16); assert.equal(f.native(), 16);
  assert.deepEqual(f.batches.map(b => b.period), ['daily', 'weekly', 'daily', 'weekly']);
});
test('caller shared native remainder bounds event work exactly', async () => {
  for (const limit of [1, 4, 7, 12, 16]) {
    const f = fixture({ daily: 100, weekly: 100 });
    assert.equal((await runEventCoordinator(f.runtime, '/repo', { ...f.options, limit })).checked, limit);
    assert.equal(f.native(), limit);
  }
});
test('intake stops on empty and never reads more than sixteen receipts', async () => {
  for (const count of [0, 3, 16, 100]) {
    const f = fixture({}, count);
    const result = await runEventCoordinator(f.runtime, '/repo', f.options);
    assert.equal(result.consumed, Math.min(count, 16));
    assert.equal(f.intakes(), Math.min(count + 1, 16));
  }
});
test('invalid job and intake limits fail before any work', async () => {
  const f = fixture({ daily: 100 });
  for (const limit of [0, 17, 1.5]) await assert.rejects(runEventCoordinator(f.runtime, '/repo', { ...f.options, limit }), /limit/);
  await assert.rejects(runEventCoordinator(f.runtime, '/repo', { ...f.options, intakeLimit: 17 }), /limit/);
  assert.equal(f.intakes(), 0); assert.equal(f.native(), 0);
});
test('engine unavailable stops subsequent batches and preserves native reason', async () => {
  const f = fixture({ daily: 100, weekly: 100 }, 0, true);
  const result = await runEventCoordinator(f.runtime, '/repo', f.options);
  assert.equal(result.checked, 4); assert.equal(f.batches.length, 1);
  assert(result.results.every(r => r.reason === 'engine_unavailable'));
});
test('Kodub periods forward only the trusted period descriptor', async () => {
  const trackId = 'a'.repeat(64), codeHash = 'b'.repeat(64), code = 'PolyTrack2ABC';
  const period = { id: 'kodub_period', kind: 'kodub', trackId,
    kodub: { trackCode: code, trackCodeHash: codeHash } };
  const jobs = [{ resultId: 'kodub_result', trackId }];
  let calls = 0, invocation;
  const runtime = { service: {
    processBatch: async (_periodId, verify, limit) => {
      assert(limit <= 4);
      if (calls++) return [];
      return verify(jobs, period);
    },
    archivePeriod: async () => assert.fail('unexpected archive'),
  } };
  const result = await runEventCoordinator(runtime, '/repo', {
    consumeInbox: async () => ({ consumed: 0 }),
    readWork: async () => ({ periodIds: [period.id], archiveId: null }),
    verifyBatch: async (...args) => {
      invocation = args;
      return jobs.map(job => ({ ...job, reason: 'native_exact_finish' }));
    },
  });
  assert.equal(result.checked, 1);
  assert.deepEqual(invocation, ['/repo', jobs, [{ trackId, code, codeHash }]]);
});
test('Kodub periods reject mismatched leased job tracks before verification', async () => {
  const trackId = 'a'.repeat(64);
  const period = { id: 'kodub_period', kind: 'kodub', trackId,
    kodub: { trackCode: 'PolyTrack2ABC', trackCodeHash: 'b'.repeat(64) } };
  const runtime = { service: {
    processBatch: async (_periodId, verify) => verify([
      { resultId: 'kodub_result', trackId: 'c'.repeat(64) },
    ], period),
    archivePeriod: async () => assert.fail('unexpected archive'),
  } };
  await assert.rejects(runEventCoordinator(runtime, '/repo', {
    consumeInbox: async () => ({ consumed: 0 }),
    readWork: async () => ({ periodIds: [period.id], archiveId: null }),
    verifyBatch: async () => assert.fail('mismatched job must not reach verifier'),
  }), /Kodub verifier period mismatch/);
});
test('intake alternates retry priority even under sustained fresh traffic', async () => {
  const f = fixture({}, 100), priorities = [];
  await runEventCoordinator(f.runtime, '/repo', { ...f.options,
    consumeInbox: async (_runtime, { preferRetry }) => { priorities.push(preferRetry); return { consumed: 1 }; } });
  assert.deepEqual(priorities, Array.from({ length: 16 }, (_, i) => i % 2 === 0));
});

test('budget exhaustion defers event work before any lease or discovery read',async()=>{
  const f=fixture({daily:10},100);
  f.options.readWork=async()=>assert.fail('discovery must be deferred');
  const result=await runEventCoordinator(f.runtime,'/repo',{...f.options,canSpend:()=>false});
  assert.equal(result.budgetDeferred,true);assert.equal(result.checked,0);assert.equal(result.archived,null);
  assert.equal(f.intakes(),0);assert.equal(f.native(),0);
});

test('sustained intake preserves request allowance for a leased event batch',async()=>{
  let remaining=400,intakes=0,batches=0;
  const runtime={service:{processBatch:async(_period,_verify,limit)=>{
    assert.ok(remaining>=128,'must reserve before lease');remaining-=128;batches++;
    return Array.from({length:limit},()=>({reason:'native_exact_finish'}));
  },archivePeriod:async()=>assert.fail('archive must be deferred')}};
  const result=await runEventCoordinator(runtime,'/repo',{limit:4,canSpend:n=>n<=remaining,
    consumeInbox:async()=>{remaining-=48;intakes++;return {consumed:1};},
    readWork:async()=>{remaining-=24;return {periodIds:['daily'],archiveId:'old'};},
    verifyBatch:async()=>assert.fail('fixture batch simulates native accounting')});
  assert.equal(intakes,5);assert.equal(batches,1);assert.equal(result.checked,4);
  assert.equal(result.archived,null);assert.equal(result.budgetDeferred,true);assert.equal(remaining,8);
});

test('insufficient completion reserve never leases another event batch',async()=>{
  const f=fixture({daily:20});let remaining=127;
  const result=await runEventCoordinator(f.runtime,'/repo',{...f.options,canSpend:n=>n<=remaining});
  assert.equal(f.native(),0);assert.equal(f.batches.length,0);assert.equal(result.budgetDeferred,true);
});
