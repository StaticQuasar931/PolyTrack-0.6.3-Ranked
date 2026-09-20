import crypto from 'node:crypto';
import fs from 'node:fs';
import {decode} from '../firestore.mjs';
import {VERIFICATION_COLLECTION} from '../../../workers/ranked/src/verification.js';

export const REPORT_LIMITS = Object.freeze({trackLimit: 8, runLimit: 64, historyLimit: 64, eventLimit: 32, maxTrackLimit: 16, maxRunLimit: 128, maxHistoryLimit: 128, maxEventLimit: 64});
const AUDIT_COLLECTION = '0.6.2_s1_verification_audit';
const TRACK_COLLECTION = '0.6.2_s1_leaderboards_track';
const EVENT_RUN_COLLECTION = '0.6.2_event_runs';
const EVENT_PUBLIC_COLLECTION = '0.6.2_event_public';
const STATUS_ORDER = new Map([['waiting', 0], ['unavailable', 1], ['mismatch', 2], ['verified', 3]]);
const geometry = JSON.parse(fs.readFileSync(new URL('../track-geometry.json', import.meta.url), 'utf8'));
const trustedTracks = new Map((geometry.tracks || []).map(track => [String(track.id), track]));

function boundedInteger(value, name, minimum, maximum) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw Error(`Invalid ${name}`);
  return result;
}

function millis(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value && typeof value === 'object') {
    for (const key of ['__firestoreTimestamp', 'timestampValue']) {
      if (typeof value[key] === 'string') return millis(value[key]);
    }
  }
  return null;
}

function firstMillis(data, fields) {
  for (const field of fields) {
    const value = millis(data?.[field]);
    if (value !== null) return value;
  }
  return null;
}

function submissionInfo(data, fields = ['submittedAt', 'pbAt', 'ingestedAt']) {
  for (const field of fields) {
    const value = millis(data?.[field]);
    if (value !== null) return {value, source: field};
  }
  return {value: null, source: null};
}

function average(values) {
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

function range(values) {
  return values.length ? {count: values.length, minMs: Math.min(...values), maxMs: Math.max(...values), averageMs: average(values)} :
    {count: 0, minMs: null, maxMs: null, averageMs: null};
}

function queryDocument(item) {
  if (!item?.document) return null;
  return {...item.document, data: decode({mapValue: {fields: item.document.fields || {}}})};
}

function documentTrackId(document) {
  const name = String(document?.name || '');
  return String(document?.data?.trackId || name.split('/').at(-1) || '');
}

function auditId(key) {
  return crypto.createHash('sha256').update(String(key || '')).digest('hex');
}

async function queueDocuments(db, {now, trackId, trackLimit, dueOnly}) {
  if (trackId) {
    const document = await db.get(VERIFICATION_COLLECTION, trackId);
    return document ? [{...document, data: document.data || {}}] : [];
  }
  const structuredQuery = {
    from: [{collectionId: VERIFICATION_COLLECTION}],
    where: dueOnly ? {fieldFilter: {field: {fieldPath: 'notBefore'}, op: 'LESS_THAN_OR_EQUAL', value: {integerValue: String(now)}}} :
      {fieldFilter: {field: {fieldPath: 'pending'}, op: 'EQUAL', value: {booleanValue: true}}},
    orderBy: [{field: {fieldPath: 'notBefore'}, direction: 'ASCENDING'}, {field: {fieldPath: '__name__'}, direction: 'ASCENDING'}],
    limit: trackLimit
  };
  const rows = await db.call(':runQuery', {structuredQuery});
  if (!Array.isArray(rows)) throw Error('Unexpected verification queue response');
  return rows.map(queryDocument).filter(Boolean);
}

async function recentAuditDocuments(db, {trackId, historyLimit}) {
  const structuredQuery = {
    from: [{collectionId: AUDIT_COLLECTION}],
    ...(trackId ? {where: {fieldFilter: {field: {fieldPath: 'trackId'}, op: 'EQUAL', value: {stringValue: String(trackId)}}}} : {}),
    select: {fields: ['accountId', 'trackId', 'resultId', 'key', 'status', 'reason', 'checkedAt'].map(fieldPath => ({fieldPath}))},
    orderBy: [{field: {fieldPath: 'checkedAt'}, direction: 'DESCENDING'}, {field: {fieldPath: '__name__'}, direction: 'DESCENDING'}],
    limit: historyLimit
  };
  const rows = await db.call(':runQuery', {structuredQuery});
  if (!Array.isArray(rows)) throw Error('Unexpected verification audit response');
  return rows.map(queryDocument).filter(Boolean);
}

async function recentEventRuns(db, {trackId, eventLimit}) {
  const fields = ['runId', 'periodId', 'accountId', 'trackId', 'timeMs', 'receivedAt', 'status', 'proof', 'completedAt'];
  const structuredQuery = {
    from: [{collectionId: EVENT_RUN_COLLECTION}],
    ...(trackId ? {where: {fieldFilter: {field: {fieldPath: 'trackId'}, op: 'EQUAL', value: {stringValue: String(trackId)}}}} : {}),
    select: {fields: fields.map(fieldPath => ({fieldPath}))},
    orderBy: [{field: {fieldPath: 'receivedAt'}, direction: 'DESCENDING'}, {field: {fieldPath: '__name__'}, direction: 'DESCENDING'}],
    limit: eventLimit
  };
  const rows = await db.call(':runQuery', {structuredQuery});
  if (!Array.isArray(rows)) throw Error('Unexpected event run response');
  return rows.map(queryDocument).filter(Boolean);
}

function selectedSlots(documents, runLimit) {
  const slots = [];
  let total = 0;
  for (const document of documents) {
    const values = Object.values(document.data?.slots || {}).filter(slot => slot && typeof slot === 'object');
    total += values.length;
    for (const slot of values) slots.push({...slot, trackId: String(slot.trackId || document.data.trackId || documentTrackId(document))});
  }
  slots.sort((a, b) => (STATUS_ORDER.get(String(a.status)) ?? 9) - (STATUS_ORDER.get(String(b.status)) ?? 9) ||
    Number(a.checkedAt || 0) - Number(b.checkedAt || 0) || String(a.accountId || '').localeCompare(String(b.accountId || '')) ||
    String(a.trackId).localeCompare(String(b.trackId)));
  return {slots: slots.slice(0, runLimit), total, truncated: total > runLimit};
}

function publicPlace(entry) {
  if (!entry) return null;
  const rank = Number(entry.rank || entry.position);
  const fieldSize = Number(entry.fieldSize);
  return Number.isSafeInteger(rank) && rank > 0 ? {
    rank,
    fieldSize: Number.isSafeInteger(fieldSize) && fieldSize > 0 ? fieldSize : null
  } : null;
}

function matchingPublishedEntry(board, {accountId, timeMs, uploadId = 0}) {
  const entries = Array.isArray(board?.data?.entries) ? board.data.entries : [];
  return entries.find(entry => String(entry?.accountId || entry?.userId || '') === accountId &&
    Number(entry?.timeMs) === timeMs && (!uploadId || Number(entry?.uploadId || entry?.id || 0) === uploadId)) || null;
}

function bindingIdentity({key, resultId, accountId, trackId}) {
  return String(key || `${resultId || ''}|${accountId || ''}|${trackId || ''}`);
}

function schedulerDiagnosis(lastRun) {
  if (!lastRun || typeof lastRun !== 'object') return {
    status: 'not_provided',
    reservation: {eventNativeSlotsPerRound: 4, normalNativeSlotsPerRound: 12, borrowUnusedEventSlots: true, eventStageFirst: true}
  };
  const eventBudgetDeferred = lastRun.events?.budgetDeferred === true || lastRun.budgetDeferred === true;
  const noProgress = lastRun.stop === 'no_progress';
  const finding = eventBudgetDeferred && noProgress ? 'legacy_budget_deferred_was_reported_as_no_progress' :
    lastRun.stop === 'budget_deferred' ? 'budget_deferred_is_explicit_and_safe_to_retry' : 'none';
  return {
    status: finding === 'legacy_budget_deferred_was_reported_as_no_progress' ? 'action_required' : 'observed',
    finding,
    stop: typeof lastRun.stop === 'string' ? lastRun.stop : null,
    budgetDeferred: eventBudgetDeferred,
    reservation: {eventNativeSlotsPerRound: 4, normalNativeSlotsPerRound: 12, borrowUnusedEventSlots: true, eventStageFirst: true},
    lastRun: {
      rounds: Number.isSafeInteger(Number(lastRun.rounds)) ? Number(lastRun.rounds) : null,
      processed: Number.isSafeInteger(Number(lastRun.processed)) ? Number(lastRun.processed) : null,
      verified: Number.isSafeInteger(Number(lastRun.verified)) ? Number(lastRun.verified) : null,
      eventChecked: Number.isSafeInteger(Number(lastRun.eventChecked)) ? Number(lastRun.eventChecked) : null,
      requests: Number.isSafeInteger(Number(lastRun.requests)) ? Number(lastRun.requests) : null,
      interruptedRound: lastRun.interruptedRound === true,
      countsComplete: lastRun.countsComplete !== false
    }
  };
}

export async function createDiagnosticReport(db, {
  now = Date.now(), trackId = null, trackLimit = REPORT_LIMITS.trackLimit, runLimit = REPORT_LIMITS.runLimit,
  historyLimit = REPORT_LIMITS.historyLimit, eventLimit = REPORT_LIMITS.eventLimit, dueOnly = false, lastRun = null
} = {}) {
  if (!db || typeof db.get !== 'function' || typeof db.call !== 'function') throw Error('Diagnostic Firestore connection required');
  const at = millis(now);
  if (at === null) throw Error('Invalid report time');
  trackLimit = boundedInteger(trackLimit, 'track limit', 1, REPORT_LIMITS.maxTrackLimit);
  runLimit = boundedInteger(runLimit, 'run limit', 1, REPORT_LIMITS.maxRunLimit);
  historyLimit = boundedInteger(historyLimit, 'history limit', 0, REPORT_LIMITS.maxHistoryLimit);
  eventLimit = boundedInteger(eventLimit, 'event limit', 0, REPORT_LIMITS.maxEventLimit);
  if (trackId !== null && !/^[A-Za-z0-9_-]{1,80}$/.test(String(trackId))) throw Error('Invalid track id');
  const queues = await queueDocuments(db, {now: at, trackId, trackLimit, dueOnly});
  const selected = selectedSlots(queues, runLimit);
  const audits = historyLimit ? await recentAuditDocuments(db, {trackId, historyLimit}) : [];
  const eventDocuments = eventLimit ? await recentEventRuns(db, {trackId, eventLimit}) : [];
  const boardCache = new Map();
  const eventBoardCache = new Map();
  const rows = [];
  const seenBindings = new Set();
  const readBoard = async currentTrackId => {
    if (!boardCache.has(currentTrackId)) boardCache.set(currentTrackId, await db.get(TRACK_COLLECTION, currentTrackId));
    return boardCache.get(currentTrackId);
  };
  const normalRow = async (candidate, source, auditData = null) => {
    const slot = candidate.slot || candidate;
    const id = String(slot.accountId || slot.userId || auditData?.accountId || '');
    const resultId = String(slot.resultId || auditData?.resultId || (id && slot.trackId ? `${id}_${slot.trackId}` : ''));
    const canonical = resultId ? await db.get('0.6.2_race_results', resultId) : null;
    const canonicalData = canonical?.data || null;
    const currentTrackId = String(canonicalData?.trackId || slot.trackId || auditData?.trackId || '');
    const audit = auditData || (slot.key ? (await db.get(AUDIT_COLLECTION, auditId(slot.key)))?.data || null : null);
    const publishedEntry = matchingPublishedEntry(await readBoard(currentTrackId), {
      accountId: String(canonicalData?.accountId || canonicalData?.userId || id),
      timeMs: Number(canonicalData?.timeMs),
      uploadId: Number(canonicalData?.uploadId || canonicalData?.id || 0)
    });
    const status = String(audit?.status || slot.status || 'unknown');
    const reason = String(audit?.reason || slot.reason || '') || null;
    const submitted = submissionInfo(canonicalData);
    const checkedAt = firstMillis(audit, ['verifiedAt', 'checkedAt']) ?? firstMillis(slot, ['checkedAt']);
    const verifiedAt = status === 'verified' ? checkedAt : null;
    const inventory = trustedTracks.get(currentTrackId);
    return {
      kind: 'normal', source, accountId: id, resultId, trackId: currentTrackId, trackName: inventory?.name || null,
      trustedTrack: Boolean(inventory), status, reason, submissionTimestampSource: submitted.source,
      submittedAt: submitted.value === null ? null : new Date(submitted.value).toISOString(),
      waitAgeMs: submitted.value === null ? null : Math.max(0, at - submitted.value),
      verifiedAt: verifiedAt === null ? null : new Date(verifiedAt).toISOString(),
      verificationLatencyMs: verifiedAt === null || submitted.value === null ? null : Math.max(0, verifiedAt - submitted.value),
      published: Boolean(publishedEntry), place: publicPlace(publishedEntry),
      missingTrustedTrack: reason === 'missing_trusted_track' || reason === 'track_identity_mismatch' || !inventory
    };
  };
  for (const slot of selected.slots) {
    seenBindings.add(bindingIdentity(slot));
    rows.push(await normalRow({slot}, 'queue'));
  }
  for (const auditDocument of audits) {
    const audit = auditDocument.data || {};
    if (seenBindings.has(bindingIdentity(audit))) continue;
    seenBindings.add(bindingIdentity(audit));
    rows.push(await normalRow({slot: audit}, 'audit_history', audit));
  }
  for (const document of eventDocuments) {
    const event = document.data || {};
    const periodId = String(event.periodId || '');
    const runId = String(event.runId || String(document.name || '').split('/').at(-1) || '');
    const currentTrackId = String(event.trackId || '');
    if (!eventBoardCache.has(periodId)) eventBoardCache.set(periodId, await db.get(EVENT_PUBLIC_COLLECTION, periodId));
    const proof = event.proof && typeof event.proof === 'object' ? event.proof : {};
    const status = String(event.status || proof.status || 'unknown');
    const reason = String(proof.reason || event.reason || '') || null;
    const submitted = submissionInfo(event, ['submittedAt', 'receivedAt']);
    const checkedAt = firstMillis(proof, ['verifiedAt', 'checkedAt']) ?? firstMillis(event, ['verifiedAt', 'completedAt']);
    const verifiedAt = status === 'verified' ? checkedAt : null;
    const inventory = trustedTracks.get(currentTrackId);
    const publishedEntry = matchingPublishedEntry(eventBoardCache.get(periodId), {accountId: String(event.accountId || ''), timeMs: Number(event.timeMs)});
    rows.push({
      kind: 'event', source: 'event_run', accountId: String(event.accountId || ''), resultId: runId, periodId, trackId: currentTrackId,
      trackName: inventory?.name || null, trustedTrack: Boolean(inventory), status, reason, submissionTimestampSource: submitted.source,
      submittedAt: submitted.value === null ? null : new Date(submitted.value).toISOString(),
      waitAgeMs: submitted.value === null ? null : Math.max(0, at - submitted.value),
      verifiedAt: verifiedAt === null ? null : new Date(verifiedAt).toISOString(),
      verificationLatencyMs: verifiedAt === null || submitted.value === null ? null : Math.max(0, verifiedAt - submitted.value),
      published: Boolean(publishedEntry), place: publicPlace(publishedEntry),
      missingTrustedTrack: reason === 'missing_trusted_track' || reason === 'track_identity_mismatch' || !inventory
    });
  }
  const people = new Map(), tracks = new Map(), latency = [], waitingAge = [], reasonCounts = {};
  for (const row of rows) {
    const person = people.get(row.accountId) || {accountId: row.accountId, runs: 0, verified: 0, waiting: 0, tracks: new Set()};
    person.runs++; person.verified += row.status === 'verified' ? 1 : 0; person.waiting += ['waiting', 'unavailable', 'unavailable_final'].includes(row.status) ? 1 : 0; person.tracks.add(row.trackId); people.set(row.accountId, person);
    const track = tracks.get(row.trackId) || {trackId: row.trackId, trackName: row.trackName, trustedTrack: row.trustedTrack, runs: 0, verified: 0, waiting: 0, missingTrustedTrack: 0, published: 0};
    track.runs++; track.verified += row.status === 'verified' ? 1 : 0; track.waiting += ['waiting', 'unavailable', 'unavailable_final'].includes(row.status) ? 1 : 0; track.missingTrustedTrack += row.missingTrustedTrack ? 1 : 0; track.published += row.published ? 1 : 0; tracks.set(row.trackId, track);
    if (row.verificationLatencyMs !== null) latency.push(row.verificationLatencyMs);
    if (row.status === 'waiting' || row.status === 'unavailable' || row.status === 'unavailable_final') if (row.waitAgeMs !== null) waitingAge.push(row.waitAgeMs);
    if (row.reason) reasonCounts[row.reason] = (reasonCounts[row.reason] || 0) + 1;
  }
  return {
    generatedAt: new Date(at).toISOString(),
    scope: {queueDocuments: queues.length, queueLimit: trackLimit, runLimit, historyLimit, eventLimit, dueOnly, selectedRuns: rows.length, queueRuns: selected.slots.length, auditRecordsRead: audits.length, auditHistoryRuns: rows.filter(row => row.source === 'audit_history').length, eventRuns: eventDocuments.length, totalRunsSeen: selected.total, auditHistoryMayBeTruncated: historyLimit > 0 && audits.length >= historyLimit, eventHistoryMayBeTruncated: eventLimit > 0 && eventDocuments.length >= eventLimit, truncated: selected.truncated || queues.length >= trackLimit || historyLimit > 0 && audits.length >= historyLimit || eventLimit > 0 && eventDocuments.length >= eventLimit},
    engine: {geometrySchema: geometry.schemaVersion, trustedTrackCount: trustedTracks.size},
    scheduler: schedulerDiagnosis(lastRun),
    summary: {
      runs: rows.length,
      normalRuns: rows.filter(row => row.kind === 'normal').length,
      eventRuns: rows.filter(row => row.kind === 'event').length,
      auditHistoryRuns: rows.filter(row => row.source === 'audit_history').length,
      people: people.size,
      tracks: tracks.size,
      verified: rows.filter(row => row.status === 'verified').length,
      waiting: rows.filter(row => ['waiting', 'unavailable', 'unavailable_final'].includes(row.status)).length,
      published: rows.filter(row => row.published).length,
      missingTrustedTracks: rows.filter(row => row.missingTrustedTrack).length,
      reasons: reasonCounts,
      verificationLatencyMs: range(latency),
      waitingAgeMs: range(waitingAge)
    },
    people: [...people.values()].map(person => ({...person, tracks: [...person.tracks].sort()})).sort((a, b) => a.accountId.localeCompare(b.accountId)),
    tracks: [...tracks.values()].sort((a, b) => a.trackId.localeCompare(b.trackId)),
    runs: rows
  };
}

export {millis, schedulerDiagnosis, trustedTracks};
