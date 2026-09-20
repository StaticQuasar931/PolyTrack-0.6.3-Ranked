import { compatibleEventEngine } from './event-engine-compatibility.js';
import { canonicalPromotion } from './event-canonical.js';
import { matchesClockRejection } from './event-clock-recovery.js';
import { VERIFIER_ENGINE_DIGEST, VERIFIER_VERSION } from './verification.js';

// Importing this library neither adds routes nor starts work. Authentication,
// origin policy and the existing native verifier remain explicit dependencies.
export const EVENT_VERSION = 'event-rp-v1';
export const EVENT_COLLECTIONS = Object.freeze({
  periods: '0.6.2_event_periods', catalog: '0.6.2_event_catalog',
  owners: '0.6.2_event_owners', quotas: '0.6.2_event_quotas',
  runs: '0.6.2_event_runs', queues: '0.6.2_event_queues',
  pbs: '0.6.2_event_pbs', replays: '0.6.2_event_replays', live: '0.6.2_event_public', archives: '0.6.2_event_archives',
  archiveTracks: '0.6.2_event_archive_tracks',
  softTargets: '0.6.2_event_soft_targets',
  sessions: '0.6.2_event_sessions', inbox: '0.6.2_event_inbox', history: '0.6.2_event_public',
  cursors: '0.6.2_event_cursors', retries: '0.6.2_event_retries', totals: '0.6.2_event_totals', overall: '0.6.2_event_public',
  public: '0.6.2_event_public',
  receipts: '0.6.2_event_receipts',
  profiles: '0.6.2_profiles_public', canonical: '0.6.2_race_results'
});
export const EVENT_LIMITS = Object.freeze({
  catalogPeriods: 120, entrants: 200, submissions: 2048, queued: 512, replayBytesPerPeriod: 16777216,
  replayCharacters: 65536, requestBytes: 70000,
  timeMs: 300000, durationMs: 7 * 86400000, graceMs: 86400000,
  batch: 4, leaseMs: 300000, verificationAttempts: 3, retryMs: 3600000,
  verificationsPerDay: 4096, maxRp: 1000, retentionMs: 90 * 86400000
});
export const EVENT_SERVER_TIMESTAMP = Object.freeze({ __eventServerTimestamp: true });
const C = EVENT_COLLECTIONS, L = EVENT_LIMITS;
const HEX = /^[a-f0-9]{64}$/, ID = /^[A-Za-z0-9_-]{1,64}$/;
const path = (collection, id) => `${collection}/${id}`;
export class EventError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
function demand(ok, code, status) { if (!ok) throw new EventError(code, status); }
function int(value, min = 0, max = Number.MAX_SAFE_INTEGER) { return Number.isSafeInteger(value) && value >= min && value <= max; }
function uid(value) { demand(typeof value === 'string' && value.length > 0 && value.length <= 128, 'authentication_required', 401); return value; }
function id(value) { demand(typeof value === 'string' && ID.test(value), 'invalid_id'); return value; }
function hex(value) { demand(typeof value === 'string' && HEX.test(value), 'invalid_hash'); return value; }
function clock(value) { demand(int(value), 'invalid_server_clock', 503); return value; }
function receiptTime(value) {
  demand(value && typeof value.__firestoreTimestamp === 'string', 'server_receipt_required', 409);
  const ms = Date.parse(value.__firestoreTimestamp); demand(int(ms), 'invalid_server_receipt', 409); return ms;
}
function text(value, max) { return typeof value === 'string' ? value.replace(/[<>\u0000-\u001f]/g, '').slice(0, max) : ''; }
export function publicEventPeriod(p) {
  const privateSoftTarget = p.kind === 'kodub' && p.kodub?.privateSoftScoring === true;
  return { ...(p.kind==='kodub'?{trackName:p.kodub?.name||p.trackName,author:p.kodub?.author||p.author,targetPolicy:'official-fastest-verified-at-import'}:{}),id: p.id, trackId: p.trackId, startsAt: p.startsAt, endsAt: p.endsAt,
    graceMs: p.graceMs, maxRp: p.maxRp, ...(!privateSoftTarget && p.targetMs != null ? { targetMs: p.targetMs } : {}), kind: p.kind || 'custom',
    ...(int(p.racerCount) ? { racerCount: p.racerCount } : {}),
    entrantLimit: p.capacity?.entrants ?? p.entrantLimit,
    label: text(p.label, 80) || `${p.kind === 'weekly' ? 'Weekly' : p.kind === 'daily' ? 'Daily' : 'Event'} ${new Date(p.startsAt).toISOString().slice(0, 10)}` };
}
export function publicEventCatalog(rows, at) {
  return { periods: rows.filter(p => p.enabled === true && !p.archived && p.startsAt <= at && at < p.endsAt).map(publicEventPeriod),
    archives: rows.filter(p => p.archived).sort((a, b) => b.endsAt - a.endsAt).slice(0, 104).map(publicEventPeriod), updatedAt: at };
}
async function sha256(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}

export function eventPeriod(input) {
  demand(input && typeof input === 'object', 'invalid_period');
  const c = input.capacity;
  demand(c && ID.test(c.policyVersion) && int(c.entrants, 1, L.entrants) && int(c.admissionsPerPeriod, c.entrants, L.submissions) &&
    int(c.replayBytesPerPeriod, 65536, L.replayBytesPerPeriod) && int(c.minIntervalMs, 1000, 60000) &&
    int(c.verificationsPerDay, 1, L.verificationsPerDay), 'reviewed_capacity_required');
  const p = { id: id(input.id), enabled: input.enabled === true, trackId: hex(input.trackId), startsAt: input.startsAt,
    endsAt: input.endsAt, graceMs: input.graceMs, targetMs: input.targetMs,
    maxRp: input.maxRp, kind: input.kind || 'custom', engineDigest: VERIFIER_ENGINE_DIGEST, verifierVersion: VERIFIER_VERSION,
    scoreVersion: EVENT_VERSION, eligibility: input.eligibility, capacity: Object.freeze({ policyVersion: c.policyVersion, entrants: c.entrants,
      admissionsPerPeriod: c.admissionsPerPeriod, replayBytesPerPeriod: c.replayBytesPerPeriod,
      minIntervalMs: c.minIntervalMs, verificationsPerDay: c.verificationsPerDay }) };
  demand(int(p.startsAt, 1) && int(p.endsAt, p.startsAt + 1) && p.endsAt - p.startsAt <= L.durationMs, 'invalid_period_window');
  demand(int(p.graceMs, 0, L.graceMs) && int(p.endsAt + p.graceMs + L.retentionMs), 'invalid_settlement');
  demand(int(p.targetMs, 1, L.timeMs) && int(p.maxRp, 1, L.maxRp), 'invalid_scoring');
  demand(['daily','weekly','custom','kodub'].includes(p.kind), 'invalid_event_kind');
  demand(p.kind !== 'daily' || p.maxRp === 100, 'daily_rp_cap');
  demand(p.kind !== 'weekly' || p.maxRp === 500, 'weekly_rp_cap');
  if(p.kind==='kodub'){
    const k=input.kodub;
    demand(p.maxRp===700,'kodub_rp_cap');
    const privateSoftScoring = k?.privateSoftScoring === true;
    const softBinding = k?.privateSoftScoringBinding;
    demand(k?.source==='kodub-v6-track-of-the-week'&&typeof k.trackCode==='string'&&k.trackCode.length>=32&&k.trackCode.length<=524288&&/^PolyTrack[0-9A-Za-z+/_=-]+$/.test(k.trackCode)&&HEX.test(k.trackCodeHash||'')&&k.officialEndTime===p.endsAt&&int(k.officialFastestVerifiedMs,1,L.timeMs)&&
      (!privateSoftScoring&&k.officialFastestVerifiedMs===p.targetMs||privateSoftScoring&&text(k.name,256)==='La Riviera'&&p.targetMs===57597&&
        softBinding?.periodId===p.id&&softBinding.trackId===p.trackId&&softBinding.trackCodeHash===k.trackCodeHash&&
        softBinding.officialEndTime===p.endsAt&&softBinding.targetMs===p.targetMs),'invalid_kodub_binding');
    p.kodub=Object.freeze({source:k.source,trackCode:k.trackCode,trackCodeHash:k.trackCodeHash,officialTrackAssetHash:hex(k.officialTrackAssetHash),officialEndTime:k.officialEndTime,officialFastestVerifiedMs:k.officialFastestVerifiedMs,name:text(k.name,256),author:text(k.author,256),lastModified:k.lastModified,environment:k.environment,
      ...(privateSoftScoring ? { privateSoftScoring: true, privateSoftScoringBinding: Object.freeze({ ...softBinding }) } : {})});
  }
  demand(p.eligibility === 'best-submitted-during-period', 'event_freshness_policy_unapproved');
  return Object.freeze(p);
}
function periodBinding(p) {
  const normalized = { ...eventPeriod(p), engineDigest: p.engineDigest };
  demand(p.scoreVersion === EVENT_VERSION && compatibleEventEngine(p.engineDigest) &&
    p.verifierVersion === VERIFIER_VERSION, 'event_version_unavailable', 503);
  return JSON.stringify(normalized);
}
export function eventRp(period, timeMs) {
  periodBinding(period); demand(int(timeMs, 1, L.timeMs), 'invalid_time');
  return Math.min(period.maxRp, Number(BigInt(period.maxRp) * BigInt(period.targetMs) / BigInt(timeMs)));
}
export function eventLeaderboard(period, rows) {
  demand(Array.isArray(rows) && rows.length <= period.capacity.entrants, 'leaderboard_capacity', 503);
  const seen = new Set();
  const sorted = rows.map(row => {
    hex(row.accountId); demand(!seen.has(row.accountId), 'duplicate_account', 503); seen.add(row.accountId);
    return { accountId: row.accountId, timeMs: row.timeMs, rp: eventRp(period, row.timeMs), name: text(row.name, 24) || 'Racer', carStyle: typeof row.carStyle==='string'&&/^[A-Za-z0-9_-]{1,256}$/.test(row.carStyle)?row.carStyle:'' };
  }).sort((a, b) => a.timeMs - b.timeMs || (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0));
  let rank = 0;
  return sorted.map((row, index) => {
    if (index === 0 || row.timeMs !== sorted[index - 1].timeMs) rank = index + 1;
    return { ...row, rank };
  });
}
function binding(run) {
  return JSON.stringify([EVENT_VERSION, run.periodBinding, run.runId, run.ownerUid, run.accountId,
    run.attemptId, run.sessionId, run.trackId, run.timeMs, run.replayHash, run.receivedAt]);
}
function pendingPlaybackEntry(run) {
  return { accountId: run.accountId, runId: run.runId, timeMs: run.timeMs, name: text(run.name, 24) || 'Racer',
    carStyle: typeof run.carStyle === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(run.carStyle) ? run.carStyle : '',
    submittedAt: run.receivedAt, verificationStatus: 'waiting', pending: true, verified: false,
    eventRpEligible: false, source: 'pending-event-playback' };
}
function upsertPlayback(rows, candidate, limit) {
  const existing = Array.isArray(rows) ? rows : [];
  return [...existing.filter(row => row.accountId !== candidate.accountId), candidate]
    .sort((a, b) => a.timeMs - b.timeMs || a.accountId.localeCompare(b.accountId)).slice(0, limit);
}
function visiblePendingPlaybacks(rows) {
  return (Array.isArray(rows) ? rows : []).filter(row => row?.verificationStatus === 'waiting' && row.pending === true &&
    row.verified === false && row.eventRpEligible === false && HEX.test(row.runId || '') && HEX.test(row.accountId || ''));
}
function canonicalTime(row) {
  if (!row) return null;
  const raw = row.raceTimeFrames ?? row.frames;
  // Do not repair or compare ambiguous legacy conversions here.
  if (!int(row.timeMs, 1) || raw !== row.timeMs || row.frames != null && row.frames !== raw) return undefined;
  return raw;
}
function validVerdict(run, result, period) {
  demand(['verified', 'mismatch', 'unavailable'].includes(result?.status), 'invalid_verifier_status', 502);
  const expectedId = run.runId || run.resultId;
  demand(result.resultId === expectedId && result.trackId === run.trackId && result.timeMs === run.timeMs &&
    result.replayHash === run.replayHash, 'verifier_input_mismatch', 502);
  if (result.status !== 'unavailable') {
    const b = result.binding;
    demand(result.engineDigest === VERIFIER_ENGINE_DIGEST && b?.engineDigest === VERIFIER_ENGINE_DIGEST &&
      b.verifierVersion === VERIFIER_VERSION && b.resultId === expectedId && b.trackId === run.trackId &&
      b.nativeTrackId === run.trackId && b.timeMs === run.timeMs && b.replayHash === run.replayHash &&
      b.actualReplayHash === run.replayHash, 'verifier_proof_mismatch', 502);
    if (period?.kind === 'kodub') {
      const expectedTrackHash = period.kodub?.trackCodeHash;
      demand(HEX.test(expectedTrackHash || '') && b.trackContentHash === expectedTrackHash &&
        (!Object.prototype.hasOwnProperty.call(result, 'trackContentHash') || result.trackContentHash === expectedTrackHash),
      'verifier_proof_mismatch', 502);
    }
  }
}

/** store must provide a real serializable transaction with get/create/set/patch/delete.
 * All reads precede writes. Only trusted server code may call admin or verifier methods.
 */
export function createEventService({ store, now = Date.now, hash = sha256, randomId = () => crypto.randomUUID() }) {
  demand(typeof store?.transaction === 'function' && [now, hash, randomId].every(f => typeof f === 'function'), 'event_dependencies_required', 503);
  const periodPath = value => path(C.periods, id(value));
  const stamp = () => clock(now());
  async function readPeriod(tx, periodId) {
    const p = await tx.get(periodPath(periodId)); demand(p, 'event_not_found', 404); periodBinding(p); return p;
  }
  async function checkOwner(tx, ownerUid, accountId) {
    const owner = await tx.get(path(C.owners, hex(accountId)));
    demand(owner?.ownerUid === ownerUid && owner.accountId === accountId, 'event_account_not_owned', 403);
  }
  async function readRun(tx, periodId, runId) {
    const run = await tx.get(path(C.runs, hex(runId)));
    demand(run && run.periodId === periodId && run.eventKey === binding(run), 'event_run_not_found', 404); return run;
  }
  const service = {
    // Server-only provisioning from an existing owner-protected profile. No public route.
    async bindOwner(ownerUid, accountId) {
      uid(ownerUid); hex(accountId);
      return store.transaction(async tx => {
        const ownerPath = path(C.owners, accountId), existing = await tx.get(ownerPath);
        if (existing) { demand(existing.ownerUid === ownerUid && existing.accountId === accountId, 'owner_immutable', 409); return existing; }
        const profile = await tx.get(path(C.profiles, accountId));
        demand(profile?.ownerUid === ownerUid && profile.accountId === accountId, 'profile_not_owned', 403);
        const owner = { ownerUid, accountId, createdAt: stamp() };
        await tx.create(ownerPath, owner); return owner;
      });
    },
    async createPeriod(input, { currentUtc = false } = {}) {
      const p = eventPeriod(input);
      return store.transaction(async tx => {
        demand(p.startsAt > stamp() || currentUtc && p.startsAt <= stamp() && stamp() < p.endsAt, 'period_must_be_future');
        const catalogPath = path(C.catalog, 'main'), catalog = await tx.get(catalogPath) || { periods: [] };
        const publicPath = path(C.public, 'catalog'); await tx.get(publicPath);
        const existing = await tx.get(periodPath(p.id));
        const livePath = path(C.live, p.id); await tx.get(livePath);
        demand(!existing && !catalog.periods.some(row => row.id === p.id), 'period_immutable', 409);
        demand(catalog.periods.length < L.catalogPeriods, 'event_retention_capacity', 429);
        demand(!catalog.periods.some(row => (row.kind || 'custom') === p.kind && p.startsAt < row.endsAt && p.endsAt > row.startsAt), 'period_overlap', 409);
        await tx.create(periodPath(p.id), p);
        await tx.create(path(C.queues, p.id), { slots: [], runIds: [], subjects: [], admitted: 0, entrants: 0, replayBytes: 0 });
        const rows = [...catalog.periods, { ...publicEventPeriod(p), enabled: p.enabled, archived: false }];
        await tx.set(catalogPath, { periods: rows });
        await tx.set(publicPath, publicEventCatalog(rows, stamp()));
        await tx.set(livePath, { period: publicEventPeriod(p), entries: [], pendingPlaybacks: [], racerCount: 0, archived: false, updatedAt: stamp() });
        return p;
      });
    },
    async submit(periodId, ownerUid, input, inboxDocument = null) {
      uid(ownerUid); id(periodId);
      demand(input && typeof input === 'object', 'invalid_submission');
      const accountId = hex(input.accountId), trackId = hex(input.trackId), attemptId = id(input.attemptId);
      const sessionId = null;
      const timeMs = input.timeMs;
      demand(int(timeMs, 1, L.timeMs) && input.frames === timeMs, 'native_time_required');
      const replay = input.replay;
      demand(typeof replay === 'string' && replay.length > 0 && replay.length <= L.replayCharacters &&
        /^[A-Za-z0-9_-]+$/.test(replay) && replay.length % 4 !== 1, 'invalid_replay');
      const replayHash = hex(await hash(replay));
      const ownerHash = hex(await hash(ownerUid));
      const runId = hex(await hash(JSON.stringify([periodId, ownerUid, attemptId])));
      const carStyle = text(input.carStyle, 256);
      return store.transaction(async tx => {
        let receivedAt = stamp();
        const p = await readPeriod(tx, periodId);
        demand(p.enabled === true, 'events_disabled', 503);
        const receiptPath = path(C.receipts, `${periodId}_${accountId}`), receipt = await tx.get(receiptPath);
        const inboxPath = path(C.inbox, `${periodId}_${accountId}`);
        const cursorPath = path(C.cursors, `${periodId}_${accountId}`);
        let cursorReceipt, clockRecovery = false;
        if (inboxDocument) {
          const current = await tx.get(inboxPath);
          demand(current && current.ownerUid === ownerUid && current.accountId === accountId &&
            (current.sessionId ?? null) === sessionId && current.attemptId === attemptId && current.replay === replay &&
            current.timeMs === timeMs && current.frames === timeMs && current.periodId === periodId &&
            current.trackId === trackId && current.carStyle === input.carStyle &&
            current.receivedAt?.__firestoreTimestamp === inboxDocument.receivedAt?.__firestoreTimestamp, 'inbox_superseded', 409);
          const cursor = await tx.get(cursorPath);
          cursorReceipt = current.receivedAt;
          clockRecovery = matchesClockRejection(current, cursor, receipt);
          if (!clockRecovery && cursor?.attemptId === attemptId && cursor.receivedAt?.__firestoreTimestamp === cursorReceipt.__firestoreTimestamp) return { duplicate: true, runId: cursor.runId, status: cursor.status };
          receivedAt = receiptTime(current.receivedAt);
          demand(receivedAt <= stamp() && stamp() < p.endsAt + p.graceMs, 'inbox_receipt_expired', 409);
        }
        demand(p.trackId === trackId, 'event_track_mismatch', 409);
        const ownerPath = path(C.owners, accountId), owner = await tx.get(ownerPath);
        if (owner) demand(owner.ownerUid === ownerUid && owner.accountId === accountId, 'event_account_not_owned', 403);
        const profile = await tx.get(path(C.profiles, accountId));
        demand(profile?.ownerUid === ownerUid && profile.accountId === accountId, 'profile_owner_changed', 403);
        const runPath = path(C.runs, runId), existing = await tx.get(runPath);
        if (existing) {
          demand(existing.ownerUid === ownerUid && existing.accountId === accountId && existing.timeMs === timeMs &&
            existing.replayHash === replayHash && existing.trackId === trackId && existing.sessionId === sessionId && existing.periodBinding === periodBinding(p), 'attempt_conflict', 409);
          if (inboxDocument) await tx.set(cursorPath, { receivedAt: cursorReceipt, attemptId, status: existing.status, runId });
          return { runId, status: existing.status, duplicate: true };
        }
        demand(receivedAt >= p.startsAt && receivedAt < p.endsAt, 'event_closed', 409);
        const archived = await tx.get(path(C.archives, periodId)); demand(!archived, 'event_archived', 409);
        const quotaPath = path(C.quotas, `${periodId}_${ownerHash}`), quota = await tx.get(quotaPath);
        demand(!quota || quota.accountId === accountId, 'one_account_per_period', 409);
        const eventPb = await tx.get(path(C.pbs, `${periodId}_${accountId}`));
        const canonical = await tx.get(path(C.canonical, `${accountId}_${trackId}`));
        const normalTime = canonicalTime(canonical);
        if (eventPb && int(eventPb.timeMs, 1) && eventPb.timeMs <= timeMs &&
          normalTime != null && normalTime <= timeMs) {
          if (inboxDocument) await tx.set(cursorPath, { receivedAt: cursorReceipt, attemptId, status: 'no_improvement', runId: null });
          return { runId: null, status: 'no_improvement', duplicate: false };
        }
        demand(!quota || receivedAt - quota.lastAt >= p.capacity.minIntervalMs, 'event_submit_rate', 429);
        const queuePath = path(C.queues, periodId), queue = await tx.get(queuePath);
        demand(queue, 'event_queue_unavailable', 503);
        demand(queue.admitted < p.capacity.admissionsPerPeriod, 'event_admission_capacity', 429);
        demand(queue.slots.length < L.queued, 'event_queue_capacity', 429);
        demand(queue.replayBytes + replay.length <= p.capacity.replayBytesPerPeriod, 'event_replay_capacity', 429);
        demand(quota || queue.entrants < p.capacity.entrants, 'event_entrant_capacity', 429);
        const livePath = path(C.live, periodId), board = await tx.get(livePath);
        const run = { runId, periodId, periodBinding: periodBinding(p), ownerUid, accountId, trackId, attemptId, sessionId,
          timeMs, frames: timeMs, replay, replayHash, carStyle, name: text(profile.name || profile.nickname, 24) || 'Racer',
          receivedAt, status: 'waiting', attempts: 0 };
        if (clockRecovery) run.clockRecovery = { rejectedAt: receipt.updatedAt, recoveredAt: stamp() };
        run.eventKey = binding(run);
        if (!owner) await tx.create(ownerPath, { ownerUid, accountId, createdAt: stamp() });
        await tx.create(runPath, run);
        await tx.create(path(C.replays, `${periodId}_run_${runId}`), { periodId, accountId, trackId, runId,
          timeMs, replayHash, replay, carStyle, periodBinding: run.periodBinding, submittedAt: receivedAt,
          verificationStatus: 'waiting', verified: false, eventRpEligible: false, eventRpAwarded: false });
        await tx.set(quotaPath, { ownerUid, accountId, count: (quota?.count || 0) + 1, lastAt: receivedAt });
        await tx.set(queuePath, { ...queue, runIds: [...(queue.runIds || []), runId],
          subjects: quota ? queue.subjects : [...(queue.subjects || []), { accountId, ownerHash }],
          admitted: queue.admitted + 1, replayBytes: queue.replayBytes + replay.length, entrants: queue.entrants + (quota ? 0 : 1),
          slots: [...queue.slots, { runId, notBefore: receivedAt, attempts: 0, lease: null, leaseUntil: 0 }] });
        if (!receipt || timeMs < receipt.timeMs || clockRecovery) await tx.set(receiptPath,
          { ownerUid, accountId, periodId, attemptId, runId, timeMs, status: 'waiting', reason: '', updatedAt: stamp() });
        const pendingPlaybacks = upsertPlayback(board?.pendingPlaybacks || board?.playbacks, pendingPlaybackEntry(run), p.capacity.entrants);
        await tx.set(livePath, { ...(board || {}), period: publicEventPeriod(p), entries: board?.entries || [], pendingPlaybacks,
          racerCount: queue.entrants + (quota ? 0 : 1), archived: false, updatedAt: stamp() });
        if (inboxDocument) await tx.set(cursorPath, { receivedAt: cursorReceipt, attemptId, status: 'waiting', runId });
        return { runId, status: 'waiting', duplicate: false };
      });
    },
    async consumeInbox(document) {
      demand(document && typeof document === 'object', 'invalid_inbox');
      return service.submit(document.periodId, document.ownerUid, document, document);
    },
    async current() {
      const catalog = await store.transaction(tx => tx.get(path(C.catalog, 'main')));
      const at = stamp(), periods = (catalog?.periods || []).filter(p => !p.archived && p.startsAt <= at && at < p.endsAt + p.graceMs);
      const events = [];
      for (const p of periods.slice(0, 4)) events.push(await service.snapshot(p.id));
      return { events };
    },
    async catalog() {
      return store.transaction(async tx => {
        const catalog = await tx.get(path(C.catalog, 'main'));
        const overall = await tx.get(path(C.overall, 'totals'));
        return { ...publicEventCatalog(catalog?.periods || [], stamp()), totals: overall?.entries || [] };
      });
    },
    async totals() {
      return await store.transaction(tx => tx.get(path(C.public, 'totals'))) || { entries: [], updatedAt: 0,complete:true,totalEntries:0 };
    },
    async ownReceipt(periodId, ownerUid, accountId) {
      uid(ownerUid); id(periodId); hex(accountId);
      return store.transaction(async tx => {
        const profile = await tx.get(path(C.profiles, accountId));
        demand(profile?.ownerUid === ownerUid && profile.accountId === accountId, 'profile_not_owned', 403);
        const receipt = await tx.get(path(C.receipts, `${periodId}_${accountId}`));
        demand(!receipt || receipt.ownerUid === ownerUid, 'receipt_not_owned', 403);
        return receipt;
      });
    },
    async archiveMonth(month) {
      demand(typeof month === 'string' && /^\d{4}(0[1-9]|1[0-2])$/.test(month), 'invalid_archive_month');
      return await store.transaction(tx => tx.get(path(C.public, 'archive_' + month))) || { month, periods: [], updatedAt: 0 };
    },
    async replay(periodId, accountId) {
      id(periodId); hex(accountId);
      return store.transaction(async tx => {
        const retained = await tx.get(path(C.replays, `${periodId}_${accountId}`));
        demand(retained, 'event_replay_not_found', 404);
        const p = await readPeriod(tx, periodId);
        const archive = await tx.get(path(C.archives, periodId));
        const board = await tx.get(path(C.live, periodId));
        demand(retained.periodId === periodId && retained.accountId === accountId && retained.trackId === p.trackId &&
          retained.periodBinding === periodBinding(p) && typeof retained.runId === 'string' && HEX.test(retained.runId) &&
          int(retained.timeMs, 1, L.timeMs) && typeof retained.replayHash === 'string' && HEX.test(retained.replayHash) &&
          typeof retained.replay === 'string' && retained.replay.length > 0 &&
          retained.replay.length <= L.replayCharacters && await hash(retained.replay) === retained.replayHash &&
          typeof retained.carStyle === 'string' && retained.carStyle.length <= 256 &&
          int(retained.verifiedAt, 1), 'event_replay_corrupt', 503);
        demand(board && board.archived === !!archive && (board.entries || []).some(row =>
          row.accountId === accountId && row.timeMs === retained.timeMs), 'event_replay_identity_mismatch', 503);
        return { periodId, accountId, trackId: retained.trackId, runId: retained.runId,
          timeMs: retained.timeMs, frames: retained.timeMs, replayHash: retained.replayHash, replay: retained.replay,
          carStyle: retained.carStyle, verifiedAt: retained.verifiedAt, verificationStatus: 'verified', verified: true,
          eventRpEligible: true, source: 'verified-event-recording' };
      });
    },
    async playback(periodId, runId) {
      id(periodId); hex(runId);
      return store.transaction(async tx => {
        const retained = await tx.get(path(C.replays, `${periodId}_run_${runId}`));
        demand(retained, 'event_playback_not_found', 404);
        demand(retained.verificationStatus === 'waiting' && retained.verified === false && retained.eventRpEligible === false,
          'event_playback_not_found', 404);
        const p = await readPeriod(tx, periodId);
        demand(retained.periodId === periodId && retained.runId === runId && HEX.test(retained.accountId || '') &&
          retained.trackId === p.trackId && retained.periodBinding === periodBinding(p) && int(retained.timeMs, 1, L.timeMs) &&
          HEX.test(retained.replayHash || '') && typeof retained.replay === 'string' && retained.replay.length > 0 &&
          retained.replay.length <= L.replayCharacters && await hash(retained.replay) === retained.replayHash &&
          typeof retained.carStyle === 'string' && retained.carStyle.length <= 256,
        'event_playback_corrupt', 503);
        return { periodId, accountId: retained.accountId, trackId: retained.trackId, runId,
          timeMs: retained.timeMs, frames: retained.timeMs, replayHash: retained.replayHash, replay: retained.replay,
          carStyle: retained.carStyle, submittedAt: retained.submittedAt, verificationStatus: 'waiting', pending: true,
          verified: false, eventRpEligible: false, source: 'pending-event-recording' };
      });
    },
    async archivedTrack(periodId) {
      id(periodId);
      return store.transaction(async tx => {
        const asset = await tx.get(path(C.archiveTracks, periodId));
        demand(asset, 'event_track_not_found', 404);
        demand(asset.periodId === periodId && HEX.test(asset.trackId || '') && HEX.test(asset.trackCodeHash || '') &&
          typeof asset.trackCode === 'string' && asset.trackCode.length >= 32 && asset.trackCode.length <= 524288 &&
          /^PolyTrack[0-9A-Za-z+/_=-]+$/.test(asset.trackCode) && await hash(asset.trackCode) === asset.trackCodeHash,
        'event_track_corrupt', 503);
        return { periodId, trackId: asset.trackId, trackCode: asset.trackCode, trackCodeHash: asset.trackCodeHash,
          environment: asset.environment, playMode: 'unranked', scoringDisabled: true, archived: true };
      });
    },
    // No GET route exposes private candidates, leases, UIDs or proofs.
    async snapshot(periodId) {
      return store.transaction(async tx => {
        const history = await tx.get(path(C.history, id(periodId)));
        if (history?.archived === true) return { period: history.period, entries: history.entries,
          pendingPlaybacks: [], racerCount: history.racerCount ?? history.entries?.length ?? 0,
          archived: true, updatedAt: history.archivedAt };
        const p = await readPeriod(tx, periodId), at = stamp();
        demand(at >= p.startsAt && at < p.endsAt + p.graceMs, 'event_not_public', 404);
        demand(!await tx.get(path(C.archives, periodId)), 'event_not_public', 404);
        const board = await tx.get(path(C.live, periodId));
        return { period: publicEventPeriod({ ...p, racerCount: board?.racerCount || 0 }), archived: false, updatedAt: board?.updatedAt || 0,
          racerCount: board?.racerCount || 0, pendingPlaybacks: visiblePendingPlaybacks(board?.pendingPlaybacks || board?.playbacks),
          state: at < p.endsAt ? 'open' : 'settling', entries: eventLeaderboard(p, board?.entries || []) };
      });
    },
    async status(periodId, ownerUid, runId) {
      uid(ownerUid);
      return store.transaction(async tx => {
        const run = await readRun(tx, id(periodId), runId);
        demand(run.ownerUid === ownerUid, 'event_run_not_owned', 403);
        const p = await readPeriod(tx, periodId);
        demand(stamp() < p.endsAt + p.graceMs && !await tx.get(path(C.archives, periodId)), 'event_not_public', 404);
        return { runId, status: run.status, eventImproved: run.eventImproved === true,
          canonicalImproved: run.canonicalImproved === true, canonicalDeferred: run.canonicalDeferred === true };
      });
    },
    async leaseJobs(periodId, limit = L.batch) {
      demand(int(limit, 1, L.batch), 'batch_limit');
      const lease = id(randomId());
      return store.transaction(async tx => {
        const p = await readPeriod(tx, periodId), at = stamp();
        if (!p.enabled || at >= p.endsAt + p.graceMs + 7 * 86400000) return [];
        const archive = await tx.get(path(C.archives, periodId));
        if (archive?.cleaned) return [];
        const queuePath = path(C.queues, periodId), queue = await tx.get(queuePath);
        const budgetPath = path(C.quotas, 'verification_global'), budget = await tx.get(budgetPath);
        const day = Math.floor(at / 86400000), used = budget?.day === day ? budget.used : 0;
        const allowance = Math.min(limit, Math.max(0, p.capacity.verificationsPerDay - used));
        const chosen = queue.slots.filter(s => s.notBefore <= at && s.leaseUntil <= at && s.attempts < L.verificationAttempts).slice(0, allowance);
        const jobs = [];
        for (const slot of chosen) {
          const run = await readRun(tx, periodId, slot.runId);
          demand(run.periodBinding === periodBinding(p) && typeof run.replay === 'string' && await hash(run.replay) === run.replayHash, 'event_replay_integrity', 503);
          jobs.push({ lease, eventKey: run.eventKey, resultId: run.runId, trackId: run.trackId,
            timeMs: run.timeMs, replayHash: run.replayHash, replay: run.replay });
        }
        if (chosen.length) {
          await tx.set(budgetPath, { day, used: used + chosen.length });
          await tx.set(queuePath, { ...queue,
            slots: queue.slots.map(s => chosen.some(c => c.runId === s.runId) ? { ...s, lease, leaseUntil: at + L.leaseMs, attempts: s.attempts + 1 } : s) });
        }
        return jobs;
      });
    },
    // Trusted verifier transport ONLY. There is deliberately no HTTP completion route.
    async completeJob(periodId, job, result) {
      demand(job && typeof job === 'object', 'invalid_job'); hex(job.resultId); id(job.lease);
      return store.transaction(async tx => {
        const at = stamp(), p = await readPeriod(tx, periodId), run = await readRun(tx, periodId, job.resultId);
        demand(run.periodBinding === periodBinding(p) && job.eventKey === run.eventKey, 'event_binding_changed', 409);
        if (['verified', 'mismatch', 'expired', 'unavailable_final'].includes(run.status)) return { status: run.status, duplicate: true };
        const queuePath = path(C.queues, periodId), queue = await tx.get(queuePath);
        const slot = queue.slots.find(s => s.runId === run.runId);
        demand(slot?.lease === job.lease && at < slot.leaseUntil, 'event_lease_lost', 409);
        validVerdict(run, result, p);
        demand(await hash(run.replay) === run.replayHash, 'event_replay_integrity', 503);
        await checkOwner(tx, run.ownerUid, run.accountId);
        const archived = await tx.get(path(C.archives, periodId));
        const eventOpen = !archived && at < p.endsAt + p.graceMs;
        const eventPath = path(C.pbs, `${periodId}_${run.accountId}`), eventPb = await tx.get(eventPath);
        const replayPath = path(C.replays, `${periodId}_${run.accountId}`), retainedReplay = await tx.get(replayPath);
        const playbackPath = path(C.replays, `${periodId}_run_${run.runId}`), retainedPlayback = await tx.get(playbackPath);
        const livePath = path(C.live, periodId), board = await tx.get(livePath);
        const normalPath = path(C.canonical, `${run.accountId}_${run.trackId}`), canonical = await tx.get(normalPath);
        const totalPath = path(C.totals, run.accountId), priorTotal = await tx.get(totalPath);
        const overallPath = path(C.public, 'totals'), overall = await tx.get(overallPath);
        const receiptPath = path(C.receipts, `${periodId}_${run.accountId}`), receipt = await tx.get(receiptPath);
        if (canonical) demand(canonical.ownerUid === run.ownerUid && canonical.accountId === run.accountId && canonical.trackId === run.trackId, 'canonical_owner_mismatch', 409);
        if (eventPb) demand(eventPb.ownerUid === run.ownerUid && eventPb.accountId === run.accountId && eventPb.periodId === periodId && int(eventPb.timeMs, 1), 'event_pb_corrupt', 503);
        if (retainedReplay) demand(retainedReplay.periodId === periodId && retainedReplay.accountId === run.accountId &&
          retainedReplay.trackId === run.trackId, 'event_replay_corrupt', 503);
        demand(retainedPlayback?.periodId === periodId && retainedPlayback.runId === run.runId &&
          retainedPlayback.replayHash === run.replayHash, 'event_playback_corrupt', 503);
        const verified = result.status === 'verified';
        const eventImproved = verified && eventOpen && (!eventPb || run.timeMs < eventPb.timeMs);
        const oldTime = canonicalTime(canonical), canonicalDeferred = p.kind!=='kodub' && verified && oldTime === undefined;
        const canonicalImproved = p.kind!=='kodub' && verified && !canonicalDeferred && (oldTime === null || run.timeMs < oldTime);
        const retry = result.status === 'unavailable' && at < p.endsAt + p.graceMs + 7 * 86400000 && slot.attempts < L.verificationAttempts;
        const status = retry ? 'waiting' : result.status === 'unavailable' ? 'unavailable_final' : result.status;
        const proof = { key: run.eventKey, verifierVersion: VERIFIER_VERSION, engineDigest: result.engineDigest || null,
          status: result.status, checkedAt: at, reason: text(result.reason, 100) };
        let entries;
        if (eventImproved) entries = eventLeaderboard(p, [...(board?.entries || []).filter(e => e.accountId !== run.accountId), run]);
        const priorPending = board?.pendingPlaybacks || board?.playbacks;
        const pendingPlaybacks = status === 'waiting' ? upsertPlayback(priorPending, pendingPlaybackEntry(run), p.capacity.entrants) :
          visiblePendingPlaybacks(priorPending).filter(row => row.runId !== run.runId);
        if (canonicalImproved) {
          const profilePath = path(C.profiles, run.accountId), profile = await tx.get(profilePath);
          demand(profile?.ownerUid === run.ownerUid && profile.accountId === run.accountId, 'profile_owner_changed', 409);
          const { fields, profileFields } = canonicalPromotion(run, canonical, profile, at, EVENT_SERVER_TIMESTAMP);
          // Both writes share the proof-checked transaction. Unrelated canonical fields stay untouched.
          await tx.patch(normalPath, fields);
          await tx.patch(profilePath, profileFields);
        }
        if (eventImproved) {
          const total = { accountId: run.accountId, name: run.name,
            rp: (priorTotal?.rp || 0) + eventRp(p, run.timeMs) - (eventPb?.rp || 0),
            events: (priorTotal?.events || 0) + (eventPb ? 0 : 1) };
          demand(int(total.rp) && int(total.events), 'event_total_overflow', 503);
          const ranked = [...(overall?.entries || []).filter(row => row.accountId !== run.accountId), total]
            .sort((a, b) => b.rp - a.rp || a.accountId.localeCompare(b.accountId)).slice(0, 200);
          let rank = 0;
          const totals = ranked.map((row, i) => {
            if (!i || row.rp !== ranked[i - 1].rp) rank = i + 1;
            return { accountId: row.accountId, name: row.name, rp: row.rp, events: row.events, rank };
          });
          await tx.set(totalPath, total);
          await tx.set(overallPath, { entries: totals, updatedAt: at, complete:totals.length<200&&overall?.complete!==false,totalEntries:totals.length });
          await tx.set(eventPath, { periodId, accountId: run.accountId, ownerUid: run.ownerUid,
            trackId: run.trackId, timeMs: run.timeMs, runId: run.runId, replayHash: run.replayHash, rp: eventRp(p, run.timeMs) });
          await tx.set(replayPath, { periodId, accountId: run.accountId, trackId: run.trackId, runId: run.runId,
            timeMs: run.timeMs, replayHash: run.replayHash, replay: run.replay, carStyle: run.carStyle,
            periodBinding: run.periodBinding, verifiedAt: at });
          await tx.set(livePath, { ...(board || {}), periodId, period: publicEventPeriod({ ...p, racerCount: board?.racerCount || 0 }),
            entries, pendingPlaybacks, racerCount: board?.racerCount || 0, archived: false, updatedAt: at });
        } else if (eventOpen) {
          await tx.set(livePath, { ...(board || {}), periodId, period: publicEventPeriod({ ...p, racerCount: board?.racerCount || 0 }),
            entries: board?.entries || [], pendingPlaybacks, racerCount: board?.racerCount || 0, archived: false, updatedAt: at });
        }
        await tx.patch(playbackPath, { verificationStatus: status, verified, eventRpEligible: verified && eventOpen,
          eventRpAwarded: eventImproved, verifiedAt: verified ? at : null });
        await tx.patch(path(C.runs, run.runId), { status, attempts: slot.attempts, proof, replay: retry ? run.replay : null,
          eventImproved, canonicalImproved, canonicalDeferred, completedAt: at });
        if (receipt?.attemptId === run.attemptId && receipt.timeMs === run.timeMs) await tx.patch(receiptPath,
          { status, reason: text(result.reason, 100), eventImproved, canonicalImproved, updatedAt: at });
        await tx.set(queuePath, { ...queue, replayBytes: Math.max(0, queue.replayBytes - (retry ? 0 : run.replay.length)), slots: retry ? queue.slots.map(s => s.runId === run.runId ?
          { ...s, lease: null, leaseUntil: 0, notBefore: at + L.retryMs } : s) : queue.slots.filter(s => s.runId !== run.runId) });
        return { status, eventImproved, canonicalImproved, canonicalDeferred, eventClosed: !eventOpen };
      });
    },
    async processBatch(periodId, verifyBatch, limit = L.batch) {
      demand(typeof verifyBatch === 'function', 'trusted_verifier_required', 503);
      const jobs = await service.leaseJobs(periodId, limit);
      if (!jobs.length) return [];
      // No internal secrets or ownership data cross into the simulation runner.
      const inputs = jobs.map(({ lease, eventKey, ...input }) => input);
      const trustedPeriod=await store.transaction(tx=>readPeriod(tx,periodId));
      demand(jobs.every(job=>job.trackId===trustedPeriod.trackId),'verifier_period_mismatch',503);
      const results = await verifyBatch(inputs,trustedPeriod);
      demand(Array.isArray(results) && results.length === jobs.length && new Set(results.map(r => r?.resultId)).size === jobs.length,
        'incomplete_verifier_batch', 502);
      for (const job of jobs) {
        const result = results.find(r => r?.resultId === job.resultId);
        validVerdict(job, result, trustedPeriod); // Validate all identities before publishing any.
      }
      const published = [];
      for (const job of jobs) {
        const result = results.find(r => r.resultId === job.resultId);
        published.push({ ...await service.completeJob(periodId, job, result), resultId: result.resultId, reason: text(result.reason, 100) });
      }
      return published;
    },
    async cleanupPeriod(periodId) {
      return store.transaction(async tx => {
        const p = await readPeriod(tx, periodId), at = stamp();
        demand(at >= p.endsAt + p.graceMs + 7 * 86400000, 'event_retention_open', 409);
        const archivePath = path(C.archives, periodId), archive = await tx.get(archivePath);
        demand(archive, 'event_archive_required', 409);
        const queuePath = path(C.queues, periodId), queue = await tx.get(queuePath);
        const catalogPath = path(C.catalog, 'main'), catalog = await tx.get(catalogPath);
        const catalogEntry = catalog?.periods.find(row => row.id === periodId);
        demand(catalogEntry, 'event_cleanup_catalog_required', 409);
        if (archive.cleaned && !catalogEntry.extrasCleaned) return { cleaned: true, extrasPending: true };
        if (archive.cleaned && at < p.endsAt + L.retentionMs) return { cleaned: true };
        if (archive.cleaned && !catalogEntry.replaysCleaned) return { cleaned: true, replaysPending: true };
        const publicCatalogPath = path(C.public, 'catalog');
        if (archive.cleaned) {
          await tx.get(publicCatalogPath);
          await tx.delete(periodPath(periodId)); await tx.delete(archivePath);
          const rows = catalog.periods.filter(row => row.id !== periodId);
          await tx.set(catalogPath, { ...catalog, periods: rows });
          await tx.set(publicCatalogPath, publicEventCatalog(rows, at));
          return { purged: true };
        }
        const paths = [ ...(queue?.runIds || []).map(runId => path(C.runs, runId)),
          ...(queue?.subjects || []).flatMap(({ accountId, ownerHash }) => [
            path(C.quotas, `${periodId}_${ownerHash}`), path(C.pbs, `${periodId}_${accountId}`),
            path(C.inbox, `${periodId}_${accountId}`), path(C.cursors, `${periodId}_${accountId}`), path(C.retries, `${periodId}_${accountId}`), path(C.receipts, `${periodId}_${accountId}`)]),
          path(C.cursors, 'provision_' + periodId) ];
        const start = archive.cleanupCursor || 0, batch = paths.slice(start, start + 8);
        const existing = [];
        for (const target of batch) if (await tx.get(target)) existing.push(target);
        const cleaned = start + batch.length >= paths.length;
        for (const target of existing) await tx.delete(target);
        await tx.patch(archivePath, { cleanupCursor: start + batch.length, cleaned });
        if (cleaned) {
          if (queue) await tx.delete(queuePath);
          await tx.set(catalogPath, { ...catalog, periods: catalog.periods.map(row => row.id === periodId ? { ...row, cleaned: true } : row) });
        }
        return { cleaned, deleted: existing.length };
      });
    },
    async archivePeriod(periodId) {
      return store.transaction(async tx => {
        const p = await readPeriod(tx, periodId), at = stamp();
        demand(at >= p.endsAt + p.graceMs, 'event_settlement_open', 409);
        const archivePath = path(C.archives, periodId), existing = await tx.get(archivePath);
        if (existing) return { archived: true, duplicate: true };
        const board = await tx.get(path(C.live, periodId)), queue = await tx.get(path(C.queues, periodId));
        const catalogPath = path(C.catalog, 'main'), catalog = await tx.get(catalogPath);
        const publicPath = path(C.public, 'catalog'); await tx.get(publicPath);
        const historyPath = path(C.history, periodId), priorHistory = await tx.get(historyPath);
        const archiveTrackPath = path(C.archiveTracks, periodId), priorArchiveTrack = await tx.get(archiveTrackPath);
        const racerCount = queue?.entrants || board?.racerCount || 0;
        const publicPeriod = publicEventPeriod({ ...p, racerCount });
        const month = new Date(p.endsAt).toISOString().slice(0, 7).replace('-', '');
        const monthPath = path(C.public, 'archive_' + month), monthIndex = await tx.get(monthPath);
        const monthPeriods = [...(monthIndex?.periods || []).filter(row => row.id !== periodId), publicPeriod]
          .sort((a, b) => b.endsAt - a.endsAt || a.id.localeCompare(b.id));
        demand(monthPeriods.length <= 120, 'archive_month_capacity', 503);
        const entries = eventLeaderboard(p, board?.entries || []);
        // Remaining candidates remain private, explicitly unscored at cutoff.
        await tx.create(archivePath, { period: p, archivedAt: at, entries, racerCount,
          unresolvedRunIds: queue?.slots.map(s => s.runId) || [], settled: queue?.slots.length === 0, cleanupCursor: 0 });
        await tx.set(historyPath, { periodId, period: publicPeriod, archived: true, updatedAt: at,
          archivedAt: at, racerCount, entries, pendingPlaybacks: [], winner: entries[0] || null });
        if (p.kind === 'kodub' && !priorArchiveTrack) await tx.create(archiveTrackPath, { periodId, trackId: p.trackId,
          trackCode: p.kodub.trackCode, trackCodeHash: p.kodub.trackCodeHash, environment: p.kodub.environment, archivedAt: at });
        await tx.set(monthPath, { month, periods: monthPeriods, updatedAt: at });
        if (catalog) {
          const rows = catalog.periods.map(row => row.id === periodId ? { ...row, racerCount, archived: true } : row);
          await tx.set(catalogPath, { ...catalog, periods: rows });
          await tx.set(publicPath, publicEventCatalog(rows, at));
        }
        return { archived: true, duplicate: false };
      });
    }
  };
  return Object.freeze(service);
}

async function boundedBody(request) {
  const length = request.headers.get('Content-Length');
  demand(!length || /^\d+$/.test(length) && Number(length) <= L.requestBytes, 'request_too_large', 413);
  demand((request.headers.get('Content-Type') || '').split(';')[0].trim() === 'application/json', 'json_required', 415);
  const reader = request.body?.getReader(); demand(reader, 'body_required');
  const chunks = []; let size = 0;
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength; demand(size <= L.requestBytes, 'request_too_large', 413); chunks.push(value); }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new EventError('invalid_json'); }
}

/** Default OFF. allowRequest must implement bounded pre-storage ingress policy.
 * Verifier/admin methods are deliberately not routable by browser credentials.
 */
export function createEventHandler({ service, authenticate, allowedOrigins, allowRequest, enabled = () => false }) {
  demand(service && [authenticate, allowRequest, enabled].every(f => typeof f === 'function') && allowedOrigins instanceof Set,
    'event_http_dependencies_required', 503);
  return async request => {
    const origin = request.headers.get('Origin') || '';
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin' };
    const respond = (status, body) => new Response(JSON.stringify(body), { status, headers });
    try {
      demand(allowedOrigins.has(origin), 'origin_not_allowed', 403);
      headers['Access-Control-Allow-Origin'] = origin;
      demand(enabled() === true, 'events_disabled', 503);
      const url = new URL(request.url);
      const archiveMonth = /^\/v1\/events\/archives\/(\d{6})$/.exec(url.pathname);
      if (request.method === 'GET' && archiveMonth) {
        demand(await allowRequest({ request, ownerUid: null }) === true, 'event_ingress_limit', 429);
        return respond(200, await service.archiveMonth(archiveMonth[1]));
      }
      if (request.method === 'GET' && ['/v1/events/catalog','/v1/events/current','/v1/events/totals'].includes(url.pathname)) {
        demand(await allowRequest({ request, ownerUid: null }) === true, 'event_ingress_limit', 429);
        return respond(200, url.pathname.endsWith('/totals') ? await service.totals() : await service.catalog());
      }
      const match = /^\/v1\/events\/([A-Za-z0-9_-]{1,64})\/(snapshot|runs|receipt|replays|playbacks|track)(?:\/([a-f0-9]{64}|close))?$/.exec(url.pathname);
      demand(match, 'not_found', 404);
      if (request.method === 'OPTIONS') {
        headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
        headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
        return new Response(null, { status: 204, headers });
      }
      const [, periodId, resource, runId] = match;
      demand((request.method === 'GET' && (resource === 'receipt' && !runId || resource === 'snapshot' && !runId || resource === 'runs' && runId || resource === 'replays' && runId || resource === 'playbacks' && runId || resource === 'track' && !runId)) ||
        request.method === 'POST' && (resource === 'runs' && !runId), 'not_found', 404);
      let ownerUid = null;
      if (!['snapshot', 'replays', 'playbacks', 'track'].includes(resource)) {
        try { ownerUid = uid(await authenticate(request)); } catch { throw new EventError('authentication_failed', 401); }
      }
      demand(await allowRequest({ request, ownerUid }) === true, 'event_ingress_limit', 429);
      if (request.method === 'POST') {
        const body = await boundedBody(request);
        return respond(202, await service.submit(periodId, ownerUid, body));
      }
      return respond(200, resource === 'receipt' ? await service.ownReceipt(periodId, ownerUid, url.searchParams.get('accountId')) :
        resource === 'snapshot' ? await service.snapshot(periodId) : resource === 'replays' ? await service.replay(periodId, runId) :
          resource === 'playbacks' ? await service.playback(periodId, runId) : resource === 'track' ? await service.archivedTrack(periodId) :
          await service.status(periodId, ownerUid, runId));
    } catch (error) { return respond(error instanceof EventError ? error.status : 503, { error: error instanceof EventError ? error.code : 'events_unavailable' }); }
  };
}
