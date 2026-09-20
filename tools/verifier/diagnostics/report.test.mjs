import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {encode} from '../firestore.mjs';
import {createDiagnosticReport, schedulerDiagnosis, trustedTracks} from './report.mjs';

const knownTrack = trustedTracks.keys().next().value;
const unknownTrack = 'f'.repeat(64);
const auditId = key => crypto.createHash('sha256').update(key).digest('hex');

test('bounded report joins queue, canonical, audit and published place without replay or private fields', async () => {
  const verifiedKey = 'verified-binding';
  const waitingKey = 'waiting-binding';
  const queue = {trackId: knownTrack, pending: true, notBefore: 0, slots: {
    racer: {accountId: 'racer', resultId: 'racer_' + knownTrack, trackId: knownTrack, key: verifiedKey, status: 'verified', checkedAt: 3500},
    waiting: {accountId: 'waiting', resultId: 'waiting_' + unknownTrack, trackId: unknownTrack, key: waitingKey, status: 'unavailable', reason: 'missing_trusted_track', retryAt: Number.MAX_SAFE_INTEGER}
  }};
  const canonical = new Map([
    ['racer_' + knownTrack, {data: {accountId: 'racer', trackId: knownTrack, timeMs: 1200, uploadId: 7, pbAt: 1000, replay: 'must-not-appear', replayHash: 'private'}}],
    ['waiting_' + unknownTrack, {data: {accountId: 'waiting', trackId: unknownTrack, timeMs: 2200, uploadId: 8, pbAt: 2000, ownerUid: 'private'}}]
  ]);
  const audits = new Map([
    [auditId(verifiedKey), {data: {status: 'verified', reason: 'native_exact_finish', checkedAt: 3500}}],
    [auditId(waitingKey), {data: {status: 'unavailable', reason: 'missing_trusted_track', checkedAt: 3000}}]
  ]);
  const boards = new Map([[knownTrack, {data: {entries: [{accountId: 'racer', timeMs: 1200, uploadId: 7, rank: 2, fieldSize: 9, name: 'private name'}]}}]]);
  const calls = [];
  const db = {
    call: async (path, body) => {
      calls.push({path, body});
      assert.equal(path, ':runQuery');
      const collection = body.structuredQuery.from[0].collectionId;
      if (collection === '0.6.2_s1_verification') return [{document: {name: `queues/${knownTrack}`, fields: encode(queue).mapValue.fields}}];
      return [];
    },
    get: async (collection, id) => collection === '0.6.2_race_results' ? canonical.get(id) :
      collection === '0.6.2_s1_verification_audit' ? audits.get(id) :
      collection === '0.6.2_s1_leaderboards_track' ? boards.get(id) : null
  };
  const report = await createDiagnosticReport(db, {now: 10000, runLimit: 8});
  assert.equal(calls.find(call => call.body.structuredQuery.from[0].collectionId === '0.6.2_s1_verification').body.structuredQuery.limit, 8);
  assert.equal(calls.length, 3);
  assert.equal(report.summary.runs, 2);
  assert.equal(report.summary.verified, 1);
  assert.equal(report.summary.waiting, 1);
  assert.equal(report.summary.missingTrustedTracks, 1);
  assert.equal(report.summary.published, 1);
  assert.equal(report.summary.verificationLatencyMs.averageMs, 2500);
  assert.equal(report.summary.waitingAgeMs.averageMs, 8000);
  assert.deepEqual(report.runs.find(row => row.accountId === 'racer').place, {rank: 2, fieldSize: 9});
  assert.equal(report.runs.find(row => row.accountId === 'waiting').trustedTrack, false);
  assert.equal(report.runs.find(row => row.accountId === 'waiting').reason, 'missing_trusted_track');
  assert.doesNotMatch(JSON.stringify(report), /must-not-appear|private name|ownerUid|replayHash/);
});

test('report can target one queue and keeps the read bounded', async () => {
  let requested;
  const db = {
    call: async (_path, body) => {
      assert.notEqual(body.structuredQuery.from[0].collectionId, '0.6.2_s1_verification');
      return [];
    },
    get: async (collection, id) => {
      if (collection === '0.6.2_s1_verification') { requested = [collection, id]; return {data: {trackId: id, pending: false, slots: {}}}; }
      return null;
    }
  };
  const report = await createDiagnosticReport(db, {trackId: knownTrack, runLimit: 1});
  assert.deepEqual(requested, ['0.6.2_s1_verification', knownTrack]);
  assert.equal(report.scope.queueDocuments, 1);
  assert.equal(report.scope.selectedRuns, 0);
});

test('recent audit history includes a verified run after its queue slot is gone', async () => {
  const key = 'archived-binding';
  const resultId = 'archived_' + knownTrack;
  const db = {
    call: async (_path, body) => {
      const collection = body.structuredQuery.from[0].collectionId;
      if (collection === '0.6.2_s1_verification') return [];
      if (collection === '0.6.2_s1_verification_audit') return [{document: {name: 'audit/doc', fields: encode({
        accountId: 'archived', trackId: knownTrack, resultId, key, status: 'verified', reason: 'native_exact_finish', checkedAt: 9000
      }).mapValue.fields}}];
      return [];
    },
    get: async (collection, id) => collection === '0.6.2_race_results' && id === resultId ? {data: {
      accountId: 'archived', trackId: knownTrack, timeMs: 1700, uploadId: 3, pbAt: 4000
    }} : null
  };
  const report = await createDiagnosticReport(db, {now: 10000, historyLimit: 1, eventLimit: 0});
  assert.equal(report.summary.runs, 1);
  assert.equal(report.summary.verified, 1);
  assert.equal(report.runs[0].source, 'audit_history');
  assert.equal(report.runs[0].submissionTimestampSource, 'pbAt');
  assert.equal(report.runs[0].verificationLatencyMs, 5000);
});

test('bounded event run visibility reports received-to-proof latency and event place', async () => {
  const db = {
    call: async (_path, body) => {
      const collection = body.structuredQuery.from[0].collectionId;
      if (collection === '0.6.2_event_runs') return [{document: {name: 'events/run-1', fields: encode({
        runId: 'run-1', periodId: 'period-1', accountId: 'event-racer', trackId: knownTrack, timeMs: 1800,
        receivedAt: 4000, status: 'verified', proof: {status: 'verified', reason: 'native_exact_finish', checkedAt: 9000}, completedAt: 9000
      }).mapValue.fields}}];
      return [];
    },
    get: async (collection, id) => collection === '0.6.2_event_public' && id === 'period-1' ? {data: {
      entries: [{accountId: 'event-racer', timeMs: 1800, rank: 1}]
    }} : null
  };
  const report = await createDiagnosticReport(db, {now: 10000, historyLimit: 0, eventLimit: 1});
  assert.equal(report.summary.eventRuns, 1);
  assert.equal(report.summary.verified, 1);
  assert.equal(report.runs[0].kind, 'event');
  assert.equal(report.runs[0].submissionTimestampSource, 'receivedAt');
  assert.equal(report.runs[0].verificationLatencyMs, 5000);
  assert.deepEqual(report.runs[0].place, {rank: 1, fieldSize: null});
});

test('scheduler diagnosis distinguishes the old misleading stop from the safe stop', () => {
  const old = schedulerDiagnosis({stop: 'no_progress', events: {budgetDeferred: true}, rounds: 3, processed: 22, verified: 2, eventChecked: 16});
  assert.equal(old.status, 'action_required');
  assert.equal(old.finding, 'legacy_budget_deferred_was_reported_as_no_progress');
  const current = schedulerDiagnosis({stop: 'budget_deferred', events: {budgetDeferred: true}, rounds: 3});
  assert.equal(current.status, 'observed');
  assert.equal(current.finding, 'budget_deferred_is_explicit_and_safe_to_retry');
  assert.deepEqual(current.reservation, {eventNativeSlotsPerRound: 4, normalNativeSlotsPerRound: 12, borrowUnusedEventSlots: true, eventStageFirst: true});
});
