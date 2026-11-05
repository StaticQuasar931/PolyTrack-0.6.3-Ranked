import test from 'node:test';
import assert from 'node:assert/strict';
import {captureCost, backendRebuildCost, dailyCostPlan, breakEven, main} from './snapshot-daily-cost-plan.mjs';
const capture = (changes = {}) => ({
  overall: {rootDocuments: 3, sourcePartDocuments: 4, pageDocuments: 100},
  published: {trackRootDocuments: 0, trackPageDocuments: 0, eventRootDocuments: 0, eventPageDocuments: 0, catalogTotalsDocuments: 0},
  normalReplays: {missingBindings: 100, documentLimit: 100},
  eventReplays: {verifiedRequests: 0, pendingRequests: 0, readsPerVerifiedRequest: 5, readsPerPendingRequest: 2},
  workerRouteOverhead: {reads: 0, writes: 0}, otherCapture: {reads: 0, writes: 0}, httpRequests: null, ...changes});
const input = (changes = {}) => ({capture: capture(), capturesPerDay: 2,
  budget: {reads: 49000, writes: 9000}, playerReserve: {reads: 10000, writes: 3000},
  uploadsPerDay: 0, uploadCost: {reads: null, writes: null},
  backgroundDaily: {reads: 0, writes: 0}, otherDaily: {reads: 0, writes: 0}, ...changes});
for (const [missing, two, four] of [[0, 214, 428], [100, 414, 828], [1000, 2214, 4428]]) {
  test(`Overall max107 plus only ${missing} missing docs: two/four component scenarios`, () => {
    const c = capture({normalReplays: {missingBindings: missing, documentLimit: missing === 1000 ? 1000 : 100}});
    assert.equal(dailyCostPlan(input({capture: c})).sourceCapture.reads, two);
    assert.equal(dailyCostPlan(input({capture: c, capturesPerDay: 4})).sourceCapture.reads, four);
  });
}
test('actual roots/parts/pages replace max107, not added twice', () => {
  const c = captureCost(capture({overall: {rootDocuments: 2, sourcePartDocuments: 1, pageDocuments: 8}}));
  assert.equal(c.components.overallDocuments, 11); assert.equal(c.reads, 111);
});
test('unchanged exact pairs need zero replay reads, independent of board row count', () => {
  const c = captureCost(capture({normalReplays: {missingBindings: 0, documentLimit: 1000}}));
  assert.equal(c.components.normalReplayDocuments, 0); assert.equal(c.reads, 107);
});
test('normal replay cap defers work instead of claiming complete coverage', () => {
  const c = captureCost(capture({normalReplays: {missingBindings: 7452, documentLimit: 100}}));
  assert.equal(c.components.normalReplayDocuments, 100); assert.equal(c.normalReplayDeferredBindings, 7352);
});
test('published documents and verified/pending event route counts add once, not HTTP counts', () => {
  const c = captureCost(capture({published: {trackRootDocuments: 20, trackPageDocuments: 12, eventRootDocuments: 8, eventPageDocuments: 6, catalogTotalsDocuments: 3},
    eventReplays: {verifiedRequests: 20, pendingRequests: 10, readsPerVerifiedRequest: 5, readsPerPendingRequest: 2}, httpRequests: 1}));
  assert.equal(c.components.eventReplayDocuments, 120); assert.equal(c.reads, 376); assert.equal(c.httpRequests, 1);
});
test('unknown Worker overhead retains subtotal without claiming complete capture cost', () => {
  const p = dailyCostPlan(input({capture: capture({workerRouteOverhead: {reads: null, writes: 0}})}));
  assert.equal(p.perCapture.modeledReadSubtotal, 207); assert.equal(p.sourceCaptureKnownReadLowerBound, 414);
  assert.equal(p.sourceCapture.reads, null); assert.equal(p.fitsDeclaredEnvelope, null); assert.equal(p.maxCapturesPerDay, null);
});
test('unknown published pages and nonzero event routes stay unknown', () => {
  const c = capture(); c.published.eventPageDocuments = null;
  c.eventReplays.readsPerVerifiedRequest = null; c.eventReplays.verifiedRequests = 1;
  assert.equal(captureCost(c).reads, null);
});
test('uploads, background and player reserve add once; offline costs zero', () => {
  const p = dailyCostPlan(input({uploadsPerDay: 100, uploadCost: {reads: 8, writes: 4}, backgroundDaily: {reads: 1200, writes: 200}}));
  assert.equal(p.consumed.reads, 2414); assert.equal(p.withReserve.reads, 12414); assert.equal(p.withReserve.writes, 3600);
  assert.equal(p.maxCapturesPerDay, 178); assert.deepEqual(p.offlineCalculation, {reads: 0, writes: 0, httpRequests: 0});
  assert.equal(p.billingAttribution, false); assert.equal(p.forecast, false);
});
test('unknown uploads/background block total and cap', () => {
  const p = dailyCostPlan(input({uploadsPerDay: 1, backgroundDaily: {reads: 7, writes: null}}));
  assert.equal(p.consumed.reads, null); assert.equal(p.consumed.writes, null); assert.equal(p.fitsDeclaredEnvelope, null); assert.equal(p.maxCapturesPerDay, null);
});
test('3N is backend full rebuild, never accepted as daily source capture', () => {
  const b = backendRebuildCost({rows: 7732, reusedRows: 0, readsPerFetchedRow: 3, writesPerFetchedRow: 0, emptyQueries: 0, fixed: {reads: 0, writes: 0}, httpRequests: 1});
  assert.equal(b.reads, 23196); assert.equal(b.model, 'backend-rebuild-not-source-capture');
  assert.throws(() => dailyCostPlan(input({capture: {rows: 7732, readsPerFetchedRow: 3}})));
  assert.equal(dailyCostPlan(input()).perCapture.model, 'published-source-capture');
});
test('write budget can bind, known overrun fails despite unknown read overhead', () => {
  const p = dailyCostPlan(input({capture: capture({workerRouteOverhead: {reads: null, writes: 4000}})}));
  assert.equal(p.fitsDeclaredEnvelope, false); assert.equal(p.maxCapturesPerDay, null);
  assert.equal(dailyCostPlan(input({capture: capture({otherCapture: {reads: 0, writes: 1000}})})).maxCapturesPerDay, 6);
});
test('source-root break-even stays separate from capture and publication writes', () => {
  assert.deepEqual(breakEven({rows: 385, fullFixedReads: 0, fullReadsPerRow: 1, keyedFixedReads: 1, keyedReadsPerChange: 1}),
    {fullReads: 385, maxChangesStrictlyCheaper: 383, equalityAtChanges: 384});
});
test('invalid counts, absent reserve and exceeded component caps are rejected', () => {
  for (const n of [-1, 0.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => captureCost(capture({normalReplays: {missingBindings: n, documentLimit: 100}})));
  assert.throws(() => captureCost(capture({overall: {rootDocuments: 4, sourcePartDocuments: 4, pageDocuments: 100}})));
  assert.throws(() => captureCost(capture({overall: {rootDocuments: 3, sourcePartDocuments: 5, pageDocuments: 100}})));
  assert.throws(() => captureCost(capture({eventReplays: {verifiedRequests: 30, pendingRequests: 1}})));
  assert.throws(() => captureCost(capture({normalReplays: {missingBindings: 1, documentLimit: 0}})));
  assert.throws(() => dailyCostPlan(input({playerReserve: {reads: null, writes: 0}})));
});
test('CLI describes separate models and provides no capture action', () => {
  assert.match(main(['--help']), /backendRebuildCost is separate/); assert.match(main(['--help']), /No network or writes/);
  assert.throws(() => main([])); assert.throws(() => main(['--capture']));
});
