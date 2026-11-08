import {createHash} from 'node:crypto';
import {capturedEventLeaderboard, capturedEventRp, eventRp} from '../workers/ranked/src/events.js';
import {derivePermanentRollingHills, mergePermanentRollingIntoTotals, PERMANENT_ROLLING_HILLS} from '../workers/ranked/src/permanent-rolling-hills.js';
import {publicEventBackup, publicEventReplayBackup} from './public-snapshot-backup.mjs';
import {publicEventPlaybackForPublication} from './public-event-playback.mjs';
import {validatePublicReplayForPublication} from './public-replay-playback.mjs';
import {publicEventTotals} from './public-event-totals-backup.mjs';
import {buildEventRpHighlights} from './event-rp-highlights.mjs';
import {applyLedgerToBoard, ledgerBinding, ledgerKey, ledgerDisposition} from './native-verification-ledger.mjs';
import {assertTrustedPublishedEventTotalsBaseline} from './published-event-totals-baseline.mjs';

const VERSION = 'native-event-overlay-v1';
const compiled = new WeakSet();
const capturedRollingBoards = new WeakSet();
const HEX = /^[a-f0-9]{64}$/;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const clone = value => structuredClone(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const frozenEventPolicy = period => Object.fromEntries(Object.entries(period)
  .filter(([key]) => !['racerCount', 'label', 'trackName', 'author'].includes(key)));
const demand = (condition, message) => {if (!condition) throw Error(message);};
const held = value => value?.needsReview === true || value?.reviewHold === true;
const freeze = value => {
  if (value && typeof value === 'object') {for (const child of Object.values(value)) freeze(child); Object.freeze(value);}
  return value;
};

function complete(value) {
  demand(value && Array.isArray(value.entries) && value.entries.length <= 10000 && value.complete === true &&
    value.totalEntries === value.entries.length && value.sourceComplete !== false && value.publicationPending !== true &&
    (!value.pagination || value.pagination.hasMore !== true && value.pagination.complete !== false &&
      (value.pagination.totalEntries === undefined || value.pagination.totalEntries === value.entries.length)), 'Exact complete server baseline required');
  demand(!value.nativeEventOverlay, 'Overlaid data is not a pristine server baseline');
}

/** Local normalization of the Worker's live inline-empty published lane.
 * Its endpoint returns every inline entry but may omit first-publication metadata.
 * Never infer completeness for nonempty, paged, partial or archived boards.
 * Intake racer counts include waiting runs, not just published verified entries.
 */
export function completeCapturedEmptyEventBoard({serverBoard,checkedAt}={}) {
  const b=serverBoard,p=b?.period;
  if(!b||b.archived!==false||!Array.isArray(b.entries)||b.entries.length!==0||b.nativeEventOverlay||
    !p||!['daily','weekly','kodub'].includes(p.kind)||!integer(checkedAt)||!integer(b.updatedAt)||b.updatedAt>checkedAt||
    !integer(p.startsAt)||!integer(p.endsAt)||p.endsAt<=p.startsAt||checkedAt<p.startsAt||
    !integer(p.graceMs??0)||checkedAt>=p.endsAt+(p.graceMs??0)||
    !(b.state==='open'&&checkedAt<p.endsAt||b.state==='settling'&&checkedAt>=p.endsAt)||
    !integer(b.racerCount)||!integer(p.entrantLimit)||p.entrantLimit<1||p.entrantLimit>2000||b.racerCount>p.entrantLimit||
    b.complete===false||b.sourceComplete===false||b.publicationPending===true||b.pagination||b.paginatedSource===true||
    b.totalEntries!==undefined&&b.totalEntries!==0||b.sourceTotalEntries!==undefined&&b.sourceTotalEntries!==0)return null;
  return {...clone(b),complete:true,sourceComplete:true,totalEntries:0,sourceCompleteness:'captured-live-empty-inline'};
}

function totalsDigest(serverTotals) {
  complete(serverTotals);
  projectAssembledEventTotals(serverTotals); // No fabricated source pagination.
  return digest(serverTotals);
}

/** A complete, already assembled capture needs no surviving pagination marker.
 * Chunking is validation only, not a claim that these were server page responses.
 */
export function projectAssembledEventTotals(value, {capturedBoards = []} = {}) {
  complete(value);
  demand(integer(value.updatedAt), 'Invalid assembled event totals timestamp');
  const seen = new Set(), entries = [];
  for (let offset = 0; offset < value.entries.length; offset += 200) {
    const chunk = publicEventTotals({updatedAt: value.updatedAt, entries: value.entries.slice(offset, offset + 200)});
    for (const row of chunk.entries) {
      demand(!seen.has(row.accountId), 'Duplicate event total identity across chunks');
      seen.add(row.accountId); entries.push(row);
    }
  }
  const highlights = buildEventRpHighlights({totalsRows: entries, boards: capturedBoards});
  for (const row of entries) if (highlights.get(row.accountId)?.length) row.eventHighlights = highlights.get(row.accountId);
  return {updatedAt: value.updatedAt, entries, complete: value.complete, totalEntries: value.totalEntries};
}

function validLane(rows, period) {
  const seen = new Set();
  for (const row of rows) {
    demand(HEX.test(row.accountId || '') && !seen.has(row.accountId) && integer(row.timeMs) && row.timeMs > 0 &&
      integer(row.rp) && row.rp === capturedEventRp(period, row.timeMs) && !held(row) &&
      ['pending', 'playbackPending'].every(key => row[key] !== true) &&
      ['verified', 'physicsVerified', 'replayIntegrityVerified', 'runVerified', 'integrityVerified', 'eventRpEligible'].every(key => row[key] !== false) &&
      (row.verificationStatus === undefined || row.verificationStatus === 'verified'), 'Invalid server verified lane');
    seen.add(row.accountId);
  }
}

/** Stable object digest, to compare with an independently trusted capture receipt.
 * For a receipt pinning file bytes instead, supply those bytes to the constructor.
 * A hash calculated from untrusted input alone establishes no source authority.
 */
export function nativeEventSourceHash(serverBoard) {
  return digest(serverBoard);
}

function sourcePin(serverBoard, expectedSourceHash, sourceBytes) {
  demand(HEX.test(expectedSourceHash || ''), 'Trusted event source hash required');
  if (sourceBytes === undefined) {
    demand(digest(serverBoard) === expectedSourceHash, 'Event source hash mismatch');
    return {sourceHash: expectedSourceHash, sourceHashMode: 'canonical-json'};
  }
  demand(typeof sourceBytes === 'string' || sourceBytes instanceof Uint8Array, 'Invalid event source bytes');
  const bytes = Buffer.from(sourceBytes);
  demand(bytes.length <= 8 * 1024 * 1024 && createHash('sha256').update(bytes).digest('hex') === expectedSourceHash,
    'Event source hash mismatch');
  demand(digest(JSON.parse(bytes.toString('utf8'))) === digest(serverBoard), 'Event source bytes do not match board');
  return {sourceHash: expectedSourceHash, sourceHashMode: 'file-bytes'};
}

/** Explicit LOCAL captured-native source, never a Worker attestation adapter.
 * The independent hash pin must identify the complete reranked native-authority
 * board, not an arbitrary response with client-supplied verification flags.
 * No signature/builtAt/sourceSignature is synthesized to bypass Worker gates.
 */
export function deriveCapturedNativeRollingHills({board, expectedSourceHash, sourceBytes} = {}) {
  const snapshot = clone(board), pin = sourcePin(snapshot, expectedSourceHash, sourceBytes), p = PERMANENT_ROLLING_HILLS;
  complete(snapshot);
  demand(snapshot.trackId === p.trackId && snapshot.algorithmVersion === p.algorithmVersion &&
    integer(snapshot.schemaVersion) && snapshot.schemaVersion >= p.minimumSchemaVersion &&
    integer(snapshot.revision) && snapshot.revision > 0 && snapshot.sourceRevision === snapshot.revision &&
    integer(snapshot.updatedAt) && snapshot.updatedAt > 0 && snapshot.ranksExact !== false && snapshot.totalEntriesExact !== false,
  'Invalid captured-native Rolling Hills source');
  demand(snapshot.builtAt === undefined || integer(snapshot.builtAt) && snapshot.builtAt > 0, 'Invalid captured-native source build time');
  const seen = new Set(), eligible = [];
  let updatedAt = snapshot.updatedAt;
  for (const source of snapshot.entries) {
    const accountId = source.accountId || source.userId;
    demand(HEX.test(accountId || '') && !seen.has(accountId) &&
      (source.accountId === undefined || source.userId === undefined || source.accountId === source.userId),
    'Duplicate or invalid captured-native Rolling Hills account');
    seen.add(accountId);
    if (source.runVerified !== true || source.integrityVerified !== true || Object.keys(restrictions(source)).length ||
      source.pending === true || source.playbackPending === true || source.verified === false ||
      source.physicsVerified === false || source.replayIntegrityVerified === false ||
      source.verificationStatus !== undefined && source.verificationStatus !== 'verified') continue;
    const frames = source.raceTimeFrames ?? source.frames;
    // Normal verification permits longer finishes. Existing Rolling ERP skips
    // these (and any other ineligible finish), rather than invalidating the board.
    if (source.trackId !== p.trackId || !integer(source.timeMs) || source.timeMs < 1 || source.timeMs > 300000 ||
      frames !== source.timeMs || source.frames !== undefined && source.raceTimeFrames !== undefined && source.frames !== source.raceTimeFrames ||
      !HEX.test(source.replayHash || '')) continue;
    demand(source.verifiedAt === undefined || integer(source.verifiedAt) && source.verifiedAt > 0, 'Invalid captured-native proof time');
    if (source.verifiedAt !== undefined) updatedAt = Math.max(updatedAt, source.verifiedAt);
    eligible.push({source, accountId, frames});
  }
  demand(eligible.length > 0, 'No captured-native verified Rolling Hills entries');
  const targetMs = Math.min(...eligible.map(row => row.source.timeMs));
  const text = (value, max) => typeof value === 'string' ? value.replace(/[<>\u0000-\u001f]/g, '').slice(0, max) : '';
  const rows = eligible.map(({source, accountId, frames}) => {
    // Exact existing Rolling Hills ERP: floor(1001 * fastestVerified / time).
    const rp = Math.min(p.maxRp, Number(BigInt(p.maxRp) * BigInt(targetMs) / BigInt(source.timeMs)));
    const runAt = integer(source.pbAt) && source.pbAt > 0 ? source.pbAt : integer(source.createdAt) && source.createdAt > 0 ? source.createdAt : 0;
    return {accountId, trackId: p.trackId, timeMs: source.timeMs, frames, rp, eventRpContribution: rp, normalRpEligible: true,
      runAt, runAgeMs: runAt ? Math.max(0, updatedAt - runAt) : null,
      name: text(source.name || source.nickname, 24) || 'Racer', countryCode: text(source.countryCode, 8).toUpperCase(),
      carStyle: text(source.carStyle, 256), replayHash: source.replayHash,
      physicsVerified: true, replayIntegrityVerified: true};
  }).sort((a, b) => a.timeMs - b.timeMs || a.accountId.localeCompare(b.accountId));
  let rank = 0;
  const entries = rows.map((row, index) => {if (!index || row.timeMs !== rows[index - 1].timeMs) rank = index + 1; return {...row, rank};});
  const result = freeze({id: p.id, kind: 'permanent', trackId: p.trackId, scoreVersion: p.scoreVersion,
    targetPolicy: 'live-fastest-physics-verified', targetMs, maxRp: p.maxRp,
    sourceRevision: snapshot.sourceRevision, updatedAt, complete: true, totalEntries: entries.length,
    sourceTotalEntries: snapshot.totalEntries, sourceCompleteness: 'captured-native-complete',
    contributions: {normalRp: true, eventRp: true}, entries,
    capturedNativeSource: {kind: 'captured-native-content-v1', ...pin, sourceUpdatedAt: snapshot.updatedAt,
      ...(snapshot.builtAt === undefined ? {} : {sourceBuiltAt: snapshot.builtAt})}});
  capturedRollingBoards.add(result);
  return result;
}

/** Private companion. Persist separately from the publishable board, before overlay.
 * Public mode uses the exact captured public policy and a pinned source hash.
 * No private Worker capacity, engine, kodub code or periodBinding is reconstructed.
 * Full private-period callers retain the existing validation path as an option.
 * serverTotals is the pristine totals capture paired with this server board.
 */
export function createNativeEventBaseline({serverBoard, period = serverBoard?.period, serverTotals, expectedSourceHash, sourceBytes} = {}) {
  complete(serverBoard);
  demand(period && period.id !== 'permanent-rolling-hills' && serverBoard.period?.id === period.id &&
    HEX.test(period.trackId || '') && serverBoard.period.trackId === period.trackId, 'Event period baseline mismatch');
  // Even the optional full-period path cannot fill gaps in captured scoring.
  capturedEventRp(serverBoard.period, serverBoard.period.targetMs);
  capturedEventLeaderboard(serverBoard.period, []);
  demand(['daily', 'weekly', 'custom', 'kodub'].includes(serverBoard.period.kind), 'Invalid captured event kind');
  demand((serverBoard.period.scoringVersion ?? 'time-ratio-v1') === (period.scoringVersion ?? 'time-ratio-v1'),
    'Event policy baseline mismatch');
  const privatePeriod = period.capacity !== undefined;
  let pin = {};
  if (privatePeriod) {
    eventRp(period, period.targetMs); // Optional old API, still fully validated.
    if (expectedSourceHash !== undefined || sourceBytes !== undefined) pin = sourcePin(serverBoard, expectedSourceHash, sourceBytes);
  } else {
    pin = sourcePin(serverBoard, expectedSourceHash, sourceBytes);
    for (const key of ['startsAt', 'endsAt', 'targetMs', 'maxRp', 'entrantLimit', 'kind', 'scoringVersion']) {
      demand(period[key] === serverBoard.period[key], 'Public policy must exactly match captured source');
    }
    demand(Number.isSafeInteger(period.entrantLimit) && period.entrantLimit > 0, 'Explicit captured entrant limit required');
  }
  capturedEventRp(period, period.targetMs);
  capturedEventLeaderboard(period, []);
  for (const key of ['startsAt', 'endsAt', 'targetMs', 'maxRp', 'kind', 'scoringVersion', 'entrantLimit']) {
    demand(serverBoard.period[key] === undefined || serverBoard.period[key] === period[key], 'Event policy baseline mismatch');
  }
  validLane(serverBoard.entries, period);
  const board = publicEventBackup(serverBoard, period.id);
  demand((serverBoard.pendingPlaybacks?.length || 0) === (board.pendingPlaybacks?.length || 0), 'Invalid pending baseline');
  // Preserve explicit public hold markers, never convert them to an admission.
  for (const row of board.pendingPlaybacks || []) {
    const raw = serverBoard.pendingPlaybacks.find(value => value.runId === row.runId);
    for (const key of ['needsReview', 'reviewHold']) if (raw[key] === true) row[key] = true;
  }
  return freeze({version: VERSION, policyMode: privatePeriod ? 'private-full-period' : 'captured-public-period', ...pin,
    period: clone(period), periodDigest: digest(period), board,
    boardDigest: digest(board), totalsDigest: totalsDigest(serverTotals)});
}

function checkBaseline(baseline) {
  demand(baseline?.version === VERSION && digest(baseline.board) === baseline.boardDigest &&
    digest(baseline.period) === baseline.periodDigest &&
    HEX.test(baseline.totalsDigest || ''), 'Invalid event baseline companion');
  demand(['private-full-period', 'captured-public-period'].includes(baseline.policyMode) &&
    (baseline.policyMode !== 'captured-public-period' || HEX.test(baseline.sourceHash || '') &&
      ['canonical-json', 'file-bytes'].includes(baseline.sourceHashMode)), 'Invalid captured policy source pin');
  complete(baseline.board);
  capturedEventRp(baseline.period, baseline.period.targetMs);
  capturedEventLeaderboard(baseline.period, []);
  validLane(baseline.board.entries, baseline.period);
}

const bindingFields = ['periodId', 'runId', 'accountId', 'trackId', 'timeMs', 'replayHash', 'submittedAt'];
const sameBinding = (a, b) => bindingFields.every(key => a?.[key] === b?.[key]);
function boundRecordings(recordings, binding, allowProtectedDate = false) {
  return recordings.filter(value => bindingFields.slice(0, -1).every(key => value?.[key] === binding[key])).flatMap(value => {
    // Legacy replay exports omitted their submission date. Only an existing
    // hash-pinned visible row plus its exact canonical binding may supply it.
    for (const key of ['submittedAt', 'runCreatedAt']) {
      demand(value[key] === undefined || value[key] === binding.submittedAt, 'Retained event original date conflict');
    }
    if (value.submittedAt === undefined && !allowProtectedDate) return [];
    return [{...value, submittedAt: binding.submittedAt}];
  });
}
const restrictions = row => Object.fromEntries(Object.entries(row || {}).filter(([key, value]) =>
  ['needsReview', 'reviewHold', 'excluded', 'unscored'].includes(key) && value === true ||
  ['status', 'verificationStatus', 'validationState', 'verifiedState', 'reason'].includes(key) &&
    typeof value === 'string' && /held|hold|review|excluded|rejected|mismatch|unavailable_final/.test(value)));

function priorSnapshot(retainedNativeEntries, period) {
  if (retainedNativeEntries === undefined) return null;
  const {expectedSourceHash, sourceBytes} = retainedNativeEntries || {};
  demand(retainedNativeEntries?.previousBoard && Array.isArray(retainedNativeEntries.recordings) &&
    retainedNativeEntries.recordings.length <= 10000, 'Invalid retained native event inputs');
  const previousBoard = clone(retainedNativeEntries.previousBoard), recordings = clone(retainedNativeEntries.recordings);
  const pin = sourcePin(previousBoard, expectedSourceHash, sourceBytes);
  // Previous overlays are intentional here. They must never become ERP baselines.
  complete({...previousBoard, nativeEventOverlay: undefined});
  demand(previousBoard.period?.id === period.id && previousBoard.period.trackId === period.trackId, 'Retained event period mismatch');
  for (const key of ['startsAt', 'endsAt', 'targetMs', 'maxRp', 'kind']) {
    demand(previousBoard.period[key] === period[key], 'Retained event frozen policy mismatch');
  }
  demand((previousBoard.period.scoringVersion ?? 'time-ratio-v1') === (period.scoringVersion ?? 'time-ratio-v1'),
    'Retained event scoring policy mismatch');
  const publicBoard = publicEventBackup(previousBoard, period.id);
  demand((previousBoard.pendingPlaybacks?.length || 0) === (publicBoard.pendingPlaybacks?.length || 0), 'Invalid retained event pending lane');
  return {previousBoard, recordings, pin};
}

/** Existing visible rows ONLY. Unknown coverage stays unknown. This is NOT a
 * complete-period projection and can never be passed into the totals compiler.
 * No pending admissions, missing-row restoration, rank/RP/order changes, or ERP
 * adjustments. Missing legacy bytes leave original rows untouched.
 */
export async function projectRetainedEventVerifications({serverBoard, expectedSourceHash, sourceBytes,
  ledger, canonicalRows = [], recordings = [], policy} = {}) {
  const board = clone(serverBoard), current = clone(canonicalRows), media = clone(recordings);
  const pin = sourcePin(board, expectedSourceHash, sourceBytes), period = board.period;
  demand(Array.isArray(board.entries) && board.entries.length <= 10000 && Array.isArray(current) && current.length <= 10000 &&
    Array.isArray(media) && media.length <= 10000 && period && HEX.test(period.trackId || '') &&
    typeof period.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(period.id) && integer(period.startsAt) &&
    period.startsAt > 0 && integer(period.endsAt) && period.endsAt > period.startsAt, 'Invalid retained verification source');
  applyLedgerToBoard({board: {entries: []}, ledger, canonicalRows: [], recordings: [], policy, lane: 'event'});
  const report = {verified: 0, held: 0, excluded: 0, unavailable: 0};
  const replayUpdates = [];
  for (let index = 0; index < board.entries.length; index++) {
    const row = board.entries[index];
    demand(HEX.test(row.accountId || '') && integer(row.timeMs) && row.timeMs > 0, 'Invalid existing event row');
    if(row.pending===true||row.playbackPending===true||row.source==='pending-event-playback'){report.unavailable++;continue;}
    const dated = integer(row.submittedAt) && row.submittedAt >= period.startsAt && row.submittedAt < period.endsAt;
    if(row.submittedAt!==undefined&&!dated)throw Error('Existing event original submission mismatch');
    if(!dated&&(!HEX.test(row.runId||'')||!HEX.test(row.replayHash||''))){report.unavailable++;continue;}
    const matches = current.filter(value => value.periodId === period.id && value.trackId === period.trackId &&
      value.accountId === row.accountId && value.timeMs === row.timeMs && (!dated||value.submittedAt===row.submittedAt) &&
      (row.runId === undefined || row.runId === value.runId) &&
      (row.replayHash === undefined || row.replayHash === value.replayHash));
    if (matches.length !== 1) {report.unavailable++; continue;}
    const source = matches[0], binding = ledgerBinding(source, 'event');
    demand(binding.frames === row.timeMs && row.timeMs<=300000,
      'Existing event original submission mismatch');
    const retained = dated?boundRecordings(media,source,true):media.filter(value=>
      bindingFields.slice(0,-1).every(key=>value?.[key]===source[key]));
    demand(retained.length <= 1, 'Duplicate existing event retained recording');
    if (!retained.length) {report.unavailable++; continue;}
    const raw = retained[0];
    if(!dated&&source.submittedAt!==undefined){
      for(const key of ['submittedAt','runCreatedAt'])demand(raw[key]===undefined||raw[key]===source.submittedAt,'Retained event original date conflict');
    }
    demand(raw.frames === row.timeMs && (raw.uploadId === undefined || raw.uploadId === binding.uploadId), 'Existing event replay timing mismatch');
    const gate = applyLedgerToBoard({board: {periodId: period.id, trackId: period.trackId, entries: [{...row, ...binding}]},
      ledger, canonicalRows: [source], recordings: [{...raw, uploadId: binding.uploadId}], policy, lane: 'event'});
    const proof = gate.board.entries[0];
    if (gate.report.held || gate.report.excluded) {
      board.entries[index] = {...row, runVerified: false, verified: false, verifiedState: 0,
        verificationStatus: proof.verificationStatus, verifiedAt: null, eventRpEligible: false,
        ...(proof.needsReview ? {needsReview: true} : {}), ...(proof.excluded ? {excluded: true} : {})};
      report.held += gate.report.held; report.excluded += gate.report.excluded; continue;
    }
    if (gate.report.verified !== 1) {report.unavailable++; continue;}
    const waitingEntry = {...row, ...binding, verificationStatus: 'waiting', pending: true, verified: false,
      eventRpEligible: false, source: 'pending-event-playback'};
    demand(raw.verificationStatus === undefined || ['waiting', 'verified'].includes(raw.verificationStatus), 'Invalid existing event replay status');
    if(dated){
      await publicEventPlaybackForPublication({...raw, verificationStatus: 'waiting', pending: true, verified: false,
        eventRpEligible: false, source: 'pending-event-recording'}, {periodId: period.id, trackId: period.trackId, entry: waitingEntry});
    }else{
      // Existing standings establish prior admission, not an unknown admission
      // date. Bind native proof and bytes without passing through a dated
      // pending-admission validator or making up a submission timestamp.
      publicEventReplayBackup({...raw,verificationStatus:'verified',verified:true,eventRpEligible:true},
        {periodId:period.id,trackId:period.trackId,entry:{...row,...binding}});
      const structure=await validatePublicReplayForPublication(raw.replay,raw.frames);
      demand(structure.indexedPlaybackWithinBudget&&structure.inflatedBytes<=30015&&structure.transitions<=10000&&
        structure.maxChannelTransitions<=4096,'Invalid existing event replay limits');
    }
    demand(integer(proof.verifiedAt)&&proof.verifiedAt>0&&(!dated||proof.verifiedAt>=row.submittedAt),'Invalid existing event proof timestamp');
    board.entries[index] = {...row, runId: binding.runId, replayHash: binding.replayHash,
      physicsVerified: true, replayIntegrityVerified: true, runVerified: true, integrityVerified: true,
      verified: true, verifiedState: 1, verificationStatus: 'verified', verifiedAt: proof.verifiedAt,
      eventRpEligible: row.eventRpEligible===undefined?true:row.eventRpEligible, pending: false};
    replayUpdates.push(publicEventReplayBackup({...raw, verificationStatus: 'verified', verified: true,
      eventRpEligible: true, verifiedAt: proof.verifiedAt}, {periodId: period.id, trackId: period.trackId, entry: {...row, ...binding}}));
    report.verified++;
  }
  return freeze({mode: 'existing-verifications-only', board, promotedReplays: replayUpdates, report,
    source: pin, adjustments: [], totalsEligible: false});
}

/** No reads/writes. ledger is a branded, manifest-pinned Kepler ledger; policy is
 * its explicit engine/track/review policy. canonicalRows are current exact event
 * run bindings, including uploadId:null where the event has no upload identity.
 * Submission dates come from the exact server row AND retained bytes. New proof
 * dates come from the admission gate's actual approval witness, never capture time.
 * Optional retainedNativeEntries:{previousBoard,recordings,expectedSourceHash,
 * sourceBytes?} pins a trusted pre-capture snapshot. Its admitted original rows
 * may survive server queue replacement/archive cleanup, but are rechecked against
 * the current root ledger and current restrictions. Collect before overwriting
 * previous snapshots or replay files. Its rows are NEVER subtracted from totals.
 */
export async function projectNativeEventSnapshot({baseline, ledger, canonicalRows = [], recordings = [], policy, retainedNativeEntries} = {}) {
  checkBaseline(baseline);
  demand(Array.isArray(canonicalRows) && canonicalRows.length <= 10000 && Array.isArray(recordings) && recordings.length <= 10000,
    'Invalid event ledger dependencies');
  const {period} = baseline, source = baseline.board;
  const prior = priorSnapshot(retainedNativeEntries, period);
  const best = new Map(source.entries.map(row => [row.accountId, clone(row)]));
  const remaining = [], replayUpdates = new Map(), report = {admitted: 0, admittedExisting: 0, improved: 0,
    held: 0, removedExisting: 0, unmatched: 0, unavailableRecording: 0, unavailableExisting: 0,
    retainedAdmitted: 0, retainedBlocked: 0, retainedUnmatched: 0, unavailableRetained: 0};
  let updatedAt = source.updatedAt;
  // Brand/policy validation is mandatory even for an empty pending lane.
  applyLedgerToBoard({board: {entries: []}, ledger, canonicalRows: [], recordings: [], policy, lane: 'event'});
  const ledgerEntries = new Map(ledger.entries.map(entry => [entry.key, entry]));
  async function admissionFor(row, existing, recordPool = canonicalRows, recordingPool = recordings, allowProtectedDate = existing) {
    const records = recordPool.filter(record => record.periodId === period.id && record.trackId === period.trackId &&
      record.accountId === row.accountId && record.timeMs === row.timeMs && integer(row.submittedAt) &&
      record.submittedAt === row.submittedAt && (row.runId === undefined || row.runId === record.runId) &&
      (row.replayHash === undefined || row.replayHash === record.replayHash));
    if (existing && records.length !== 1) {report.unavailableExisting++; return null;}
    demand(records.length <= 1, 'Duplicate exact current event binding');
    const record = records[0];
    if (!record) {report.unmatched++; return null;}
    const binding = {periodId: period.id, trackId: period.trackId, accountId: row.accountId, runId: record.runId,
      timeMs: row.timeMs, replayHash: record.replayHash, submittedAt: row.submittedAt, frames: row.timeMs};
    demand(HEX.test(binding.runId || '') && HEX.test(binding.replayHash || '') && integer(binding.submittedAt) &&
      binding.submittedAt >= period.startsAt && binding.submittedAt < period.endsAt && record.frames === binding.timeMs,
    'Invalid exact event ledger binding');
    const key = ledgerKey(ledgerBinding(record, 'event')), witness = ledgerEntries.get(key);
    const retained = boundRecordings(recordingPool, binding, allowProtectedDate);
    demand(retained.length <= 1, 'Duplicate exact retained event recording');
    // A flagless original remains an original, not an inferred native approval.
    // An exact ledger hold can revoke its ERP even if bytes are now unavailable;
    // incomplete source identities must first be bound by the retained recording.
    const ledgerBlocked = witness && ledgerDisposition(witness) !== 'verified';
    if (existing && ledgerBlocked && row.runId === binding.runId && row.replayHash === binding.replayHash) {
      report.removedExisting++; report.held++; return {remove: true};
    }
    if (!existing && ledgerBlocked) {report.held++; return null;}
    if (held(row) || held(record)) {report.held++; return {blocked: true};}
    if (!retained.length) {
      if (existing) report.unavailableExisting++;
      else if (witness) report.unavailableRecording++;
      else report.unmatched++;
      return null;
    }
    const raw = retained[0];
    demand(raw.frames === row.timeMs, 'Retained event frames mismatch');
    demand(raw.uploadId === undefined || raw.uploadId === record.uploadId, 'Retained event upload mismatch');
    if (raw.verificationStatus === 'verified') publicEventReplayBackup(raw, {periodId: period.id, trackId: period.trackId, entry: {...row, ...binding}});
    else demand(raw.verificationStatus === undefined || raw.verificationStatus === 'waiting' && raw.pending === true && raw.verified === false &&
      raw.eventRpEligible === false && raw.source === 'pending-event-recording', 'Invalid retained event status');
    const waitingEntry = {...row, ...binding, verificationStatus: 'waiting', pending: true, verified: false,
      eventRpEligible: false, source: 'pending-event-playback'};
    // De-authorizing a verified envelope for structural validation does not change its binding or dates.
    await publicEventPlaybackForPublication({...raw, verificationStatus: 'waiting', pending: true, verified: false,
      eventRpEligible: false, source: 'pending-event-recording'}, {periodId: period.id, trackId: period.trackId, entry: waitingEntry});
    if (existing && ledgerBlocked) {report.removedExisting++; report.held++; return {remove: true};}
    const gate = applyLedgerToBoard({board: {periodId: period.id, trackId: period.trackId,
      entries: [{...row, ...binding, uploadId: record.uploadId}]}, ledger,
    canonicalRows: [record], recordings: [{...raw, uploadId: record.uploadId}], policy, lane: 'event'});
    if (gate.report.verified !== 1) {
      report.held += gate.report.held + gate.report.excluded;
      report.unmatched += gate.report.skipped;
      return {blocked: gate.report.held + gate.report.excluded > 0};
    }
    const verified = {...row, ...binding, physicsVerified: true, replayIntegrityVerified: true, runVerified: true,
      integrityVerified: true, verified: true, eventRpEligible: true, pending: false, verificationStatus: 'verified',
      runCreatedAt: binding.submittedAt};
    const approvalAt = gate.board.entries[0].verifiedAt;
    demand(integer(approvalAt) && approvalAt >= binding.submittedAt, 'Invalid ledger approval timestamp');
    verified.verifiedAt = approvalAt;
    updatedAt = Math.max(updatedAt, verified.verifiedAt);
    const replay = publicEventReplayBackup({...raw, verifiedAt: verified.verifiedAt, runCreatedAt: binding.submittedAt,
      verificationStatus: 'verified', verified: true, eventRpEligible: true}, {periodId: period.id, trackId: period.trackId, entry: verified});
    replayUpdates.set(key, replay);
    return {verified};
  }
  for (const row of source.entries) {
    const admission = await admissionFor(row, true);
    if (admission?.remove) best.delete(row.accountId);
    else if (admission?.verified) {best.set(row.accountId, admission.verified); report.admittedExisting++;}
  }
  if (prior) {
    const seen = new Set();
    const priorRows = [...prior.previousBoard.entries, ...(prior.previousBoard.pendingPlaybacks || [])];
    demand(priorRows.length <= 20000, 'Retained event candidate limit');
    for (const row of priorRows) {
      const priorVisible=prior.previousBoard.entries.includes(row);
      // The root proof does not bind submission dates. Both protected source
      // metadata and exact retained bytes must bind this original admission.
      demand(HEX.test(row.accountId || '') && integer(row.timeMs) && row.timeMs > 0, 'Invalid retained event source row');
      const witnesses = ledger.entries.filter(entry => {
        const b = entry.binding;
        return b.lane === 'event' && b.periodId === period.id && b.trackId === period.trackId && b.accountId === row.accountId &&
          b.timeMs === row.timeMs && b.frames === row.timeMs && (row.runId === undefined || row.runId === b.runId) &&
          (row.replayHash === undefined || row.replayHash === b.replayHash);
      });
      if (!witnesses.length) {report.retainedUnmatched++; continue;}
      if (witnesses.every(entry => ledgerDisposition(entry) !== 'verified')) {report.retainedBlocked++; continue;}
      demand(integer(row.submittedAt) && row.submittedAt >= period.startsAt && row.submittedAt < period.endsAt,
        'Retained event requires original submittedAt');
      let media = prior.recordings.filter(value => value.periodId === period.id && value.trackId === period.trackId &&
        value.accountId === row.accountId && value.timeMs === row.timeMs &&
        (value.submittedAt === row.submittedAt || priorVisible && value.submittedAt === undefined) &&
        (row.runId === undefined || row.runId === value.runId) && (row.replayHash === undefined || row.replayHash === value.replayHash));
      demand(media.length <= 1, 'Ambiguous retained native event recording');
      // A proof completed after context preparation can use its exact current
      // source payload. Missing old media alone is never permission to admit.
      if (!media.length && HEX.test(row.runId || '') && HEX.test(row.replayHash || '') &&
          Object.keys(restrictions(row)).length === 0) {
        const binding = {...row, periodId: period.id, trackId: period.trackId};
        const records = canonicalRows.filter(value => sameBinding(value, binding) && witnesses.some(entry =>
          ledgerDisposition(entry) === 'verified' && ledgerKey(ledgerBinding(value, 'event')) === entry.key));
        demand(records.length <= 1, 'Duplicate current retained event binding');
        const sourceRows = [...source.entries, ...(source.pendingPlaybacks || [])].filter(value =>
          value.accountId === row.accountId && value.timeMs === row.timeMs && value.submittedAt === row.submittedAt &&
          (value.runId === undefined || value.runId === row.runId) &&
          (value.replayHash === undefined || value.replayHash === row.replayHash));
        if (records.length === 1 && sourceRows.length === 1 &&
            [records[0], sourceRows[0]].every(value => Object.keys(restrictions(value)).length === 0)) {
          const currentMedia = boundRecordings(recordings, records[0]);
          demand(currentMedia.length <= 1, 'Ambiguous current retained event recording');
          if (currentMedia.length === 1 && Object.keys(restrictions(currentMedia[0])).length === 0) media = currentMedia;
        }
      }
      if (!media.length) {
        if(row.runId&&row.replayHash)boundRecordings(prior.recordings,{...row,periodId:period.id,trackId:period.trackId},priorVisible);
        const exact = witnesses.filter(entry => entry.binding.runId === row.runId && entry.binding.replayHash === row.replayHash);
        if (exact.some(entry => ledgerDisposition(entry) === 'verified')) report.unavailableRetained++;
        else if (exact.length) report.retainedBlocked++;
        else report.retainedUnmatched++;
        continue;
      }
      const raw = media[0];
      const exact = witnesses.filter(entry => entry.binding.runId === raw.runId && entry.binding.replayHash === raw.replayHash &&
        (raw.uploadId === undefined || raw.uploadId === entry.binding.uploadId));
      demand(exact.length <= 1, 'Ambiguous retained native event ledger binding');
      if (!exact.length) {report.retainedUnmatched++; continue;}
      const witness = exact[0];
      if (seen.has(witness.key)) continue;
      seen.add(witness.key);
      if (ledgerDisposition(witness) !== 'verified') {report.retainedBlocked++; continue;}
      const bound = {...row, ...witness.binding, submittedAt: row.submittedAt};
      // A new hold for this SAME run vetoes retention; another, faster pending
      // run for the account must not erase the prior approved PB.
      const current = canonicalRows.filter(value => {
        try {return ledgerKey(ledgerBinding(value, 'event')) === witness.key;} catch {return false;}
      });
      demand(current.length <= 1, 'Duplicate current retained event binding');
      if (current.length) demand(current[0].submittedAt === bound.submittedAt, 'Retained event original date conflict');
      const currentMedia = recordings.filter(value => sameBinding(value, bound));
      const currentRows = [...source.entries, ...(source.pendingPlaybacks || [])].filter(value => value.accountId === bound.accountId &&
        value.runId === bound.runId && value.replayHash === bound.replayHash && value.timeMs === bound.timeMs);
      const veto = Object.assign({}, ...[...current, ...currentMedia, ...currentRows].map(restrictions));
      const record = {...bound, ...veto};
      const admission = await admissionFor(bound, false, [record], [raw], priorVisible);
      if (!admission?.verified) {
        if (admission?.blocked) report.retainedBlocked++;
        else report.unavailableRetained++;
        continue;
      }
      const previous = best.get(bound.accountId);
      if (!previous || bound.timeMs < previous.timeMs || bound.timeMs === previous.timeMs &&
        previous.runId === bound.runId && previous.replayHash === bound.replayHash) best.set(bound.accountId, admission.verified);
      report.retainedAdmitted++;
    }
  }
  for (const pending of source.pendingPlaybacks || []) {
    const admission = await admissionFor(pending, false);
    if (!admission?.verified) {remaining.push(clone(pending)); continue;}
    const previous = best.get(pending.accountId);
    if (!previous || pending.timeMs < previous.timeMs) {best.set(pending.accountId, admission.verified); report.improved++;}
    report.admitted++;
  }
  const entries = capturedEventLeaderboard(period, [...best.values()]);
  const board = publicEventBackup({...source, entries, pendingPlaybacks: remaining, updatedAt,
    complete: true, totalEntries: entries.length, sourceComplete: true, pagination: undefined}, period.id);
  for (const row of board.entries) {
    const ranked = entries.find(entry => entry.accountId === row.accountId);
    for (const key of ['runVerified', 'integrityVerified', 'verified', 'eventRpEligible', 'pending', 'verificationStatus']) {
      if (ranked[key] !== undefined) row[key] = ranked[key];
    }
  }
  // Keep held pending payloads selectable under the caller's unchanged pending policy.
  if (remaining.length) board.pendingPlaybacks = remaining;
  board.nativeEventOverlay = {version: VERSION, baselineDigest: baseline.boardDigest};
  const before = new Map(source.entries.map(row => [row.accountId, row]));
  const after = new Map(entries.map(row => [row.accountId, row]));
  const adjustments = [...new Set([...before.keys(), ...after.keys()])].map(accountId => ({accountId,
    beforeRp: before.get(accountId)?.rp ?? 0, afterRp: after.get(accountId)?.rp ?? 0,
    deltaRp: (after.get(accountId)?.rp ?? 0) - (before.get(accountId)?.rp ?? 0),
    deltaEvents: Number(after.has(accountId)) - Number(before.has(accountId))}))
    .filter(row => row.deltaRp || row.deltaEvents);
  const selectedByAccount=new Map(board.entries.map(row=>[row.accountId,row]));
  const selectedReplays=[...replayUpdates.values()].filter(replay=>{
    const selected=selectedByAccount.get(replay.accountId);
    return selected&&selected.runId===replay.runId&&selected.replayHash===replay.replayHash&&selected.timeMs===replay.timeMs;
  });
  const result = freeze({baseline, board, boardDigest: digest(board), adjustments, promotedReplays: selectedReplays, report,
    ...(prior ? {retainedSource: prior.pin} : {}), ready: report.unavailableRecording === 0 && report.unavailableRetained === 0});
  compiled.add(result);
  return result;
}

/** Reapply ONLY to pristine serverTotals. Unknown historical finite contributions
 * remain in that aggregate; they are never rebuilt from an incomplete catalog.
 * Fresh totals require freshly paired per-period companions, even if cached
 * visible boards already contain yesterday's overlay.
 */
export function projectNativeEventTotals({serverTotals, projections = [], rollingNormalBoard, capturedRollingBoard} = {}) {
  const pairedDigest = totalsDigest(serverTotals);
  demand(Array.isArray(projections) && projections.length <= 1024, 'Invalid event projection list');
  const rows = new Map();
  for (const row of serverTotals.entries) {
    // The public route merges Rolling Hills. Never count that component twice.
    demand(integer(row.finiteEventRp) && integer(row.rp) && integer(row.events), 'Explicit finite totals baseline required');
    const rolling = row.permanentRollingHillsRp ?? row.rollingHillsEventRpContribution;
    demand(integer(rolling) && row.rp === row.finiteEventRp + rolling &&
      (row.permanentRollingHillsRp === undefined || row.permanentRollingHillsRp === rolling) &&
      (row.rollingHillsEventRpContribution === undefined || row.rollingHillsEventRpContribution === rolling), 'Conflicting totals component baseline');
    rows.set(row.accountId, {...clone(row), rp: row.finiteEventRp});
  }
  const periods = new Set();
  const knownContributions = new Map();
  for (const projection of projections) {
    demand(compiled.has(projection) && projection.ready, 'Ready ledger-compiled event projection required');
    checkBaseline(projection.baseline);
    demand(projection.baseline.totalsDigest === pairedDigest && digest(projection.board) === projection.boardDigest &&
      !periods.has(projection.baseline.period.id), 'Event totals baseline mismatch or duplicate period');
    periods.add(projection.baseline.period.id);
    const before = new Map(projection.baseline.board.entries.map(row => [row.accountId, row]));
    for (const row of before.values()) {
      const known = knownContributions.get(row.accountId) || {rp: 0, events: 0};
      knownContributions.set(row.accountId, {rp: known.rp + row.rp, events: known.events + 1});
    }
    validLane(projection.board.entries, projection.baseline.period);
    const after = new Map(projection.board.entries.map(row => [row.accountId, row]));
    for (const accountId of new Set([...before.keys(), ...after.keys()])) {
      const entry = after.get(accountId), old = before.get(accountId), delta = (entry?.rp ?? 0) - (old?.rp ?? 0);
      const deltaEvents = Number(!!entry) - Number(!!old);
      if (!delta && !deltaEvents) continue;
      const prior = rows.get(accountId);
      // A complete totals baseline proves absence, not unknown archived zeroes.
      demand(prior || !old, 'Server totals omit a known period contribution');
      const next = prior || {accountId, name: entry.name, carStyle: entry.carStyle, rp: 0, events: 0};
      demand(next.rp >= (old?.rp ?? 0) && next.events >= (old ? 1 : 0) && integer(next.rp + delta) && integer(next.events + deltaEvents), 'Inconsistent finite totals baseline');
      rows.set(accountId, {...next, rp: next.rp + delta, events: next.events + deltaEvents});
    }
  }
  const original = new Map(serverTotals.entries.map(row => [row.accountId, row]));
  for (const [accountId, known] of knownContributions) {
    demand(original.has(accountId) && original.get(accountId).finiteEventRp >= known.rp &&
      original.get(accountId).events >= known.events, 'Captured period contributions exceed server totals baseline');
  }
  const finite = {...clone(serverTotals), entries: [...rows.values()], complete: true, totalEntries: rows.size};
  delete finite.pagination; delete finite.paginatedSource;
  // Drop old dynamic component metadata before the shared policy replaces it.
  for (const row of finite.entries) for (const key of ['finiteEventRp', 'permanentRollingHillsRp', 'dynamicEventRp',
    'rollingHillsTimeMs', 'rollingHillsRunAgeMs', 'rollingHillsEventRpContribution', 'eventHighlights']) delete row[key];
  demand(capturedRollingBoard === undefined || rollingNormalBoard === undefined, 'Choose one explicit Rolling Hills source');
  if (capturedRollingBoard !== undefined) demand(capturedRollingBoards.has(capturedRollingBoard), 'Pinned captured-native Rolling Hills result required');
  const rollingBoard = capturedRollingBoard ?? derivePermanentRollingHills(rollingNormalBoard);
  const merged = mergePermanentRollingIntoTotals(finite, rollingBoard);
  const totals = projectAssembledEventTotals(merged, {capturedBoards: [...projections.map(value => value.board), rollingBoard]});
  totals.nativeEventOverlay = {version: VERSION, totalsBaselineDigest: pairedDigest,
    ...(rollingBoard.capturedNativeSource ? {rollingSource: rollingBoard.capturedNativeSource} : {})};
  return freeze({totals, rollingBoard, serverTotalsBaseline: clone(serverTotals), totalsBaselineDigest: pairedDigest});
}

/** Explicit offline recovery, separate from the pristine-backend delta compiler.
 * publishedBaseline MUST come from loadTrustedPublishedEventTotalsBaseline.
 * serverTotals only pairs the current proof projections; its stale scores are
 * never added or subtracted. Returned boards are the scoring companions, including
 * retained periods, so the next pinned generation can subtract the same awards.
 * Only complete branded projections are accepted. Missing periods retain prior
 * contributions and are reported as stale. Do not filter known partial or
 * totals-ineligible projections and then publish these retained boards over the
 * current captures: current pending lanes and holds require explicit reconciliation.
 */
export function rebaseNativeEventTotalsFromPublished({publishedBaseline, serverTotals, projections = [],
  rollingNormalBoard, capturedRollingBoard} = {}) {
  const previous = assertTrustedPublishedEventTotalsBaseline(publishedBaseline);
  const pairedDigest = totalsDigest(serverTotals);
  demand(Array.isArray(projections) && projections.length <= 1024, 'Invalid event projection list');
  const priorBoards = new Map(previous.boards.map(value => [value.board.id, value]));
  const boards = new Map(previous.boards.map(value => [value.board.id, value.board]));
  const rows = new Map(previous.totals.entries.map(row => [row.accountId, {...clone(row), rp: 0, events: 0}]));
  for (const residual of previous.residuals) {
    Object.assign(rows.get(residual.accountId), {rp: residual.rp, events: residual.events});
  }
  const periods = new Set(), newPeriodIds = [];
  for (const projection of projections) {
    demand(compiled.has(projection) && projection.ready, 'Ready ledger-compiled event projection required');
    checkBaseline(projection.baseline);
    const id = projection.baseline.period.id, prior = priorBoards.get(id);
    demand(projection.baseline.totalsDigest === pairedDigest && digest(projection.board) === projection.boardDigest &&
      !periods.has(id), 'Event totals baseline mismatch or duplicate period');
    validLane(projection.board.entries, projection.baseline.period);
    demand(integer(projection.board.period.entrantLimit) && projection.board.period.entrantLimit > 0,
      'Published recovery requires explicit captured entrant limit');
    if (prior) {
      demand(digest(frozenEventPolicy(prior.board.period)) === digest(frozenEventPolicy(projection.baseline.board.period)),
        'Published event frozen period policy mismatch: ' + id);
      demand(prior.replaceable, 'Cannot replace a prior period with unknown contribution coverage: ' + id);
    } else {
      // An old missing period could already be inside the unknown residual. Even
      // an empty replacement would falsely establish zero for the next rebase.
      // Totals.updatedAt is not a coverage watermark; use pinned publication time.
      demand(integer(previous.provenance.publishedAt) && projection.baseline.period.startsAt > previous.provenance.publishedAt ||
        previous.residuals.every(row => row.events === 0), 'Missing prior period may overlap historical residual: ' + id);
      newPeriodIds.push(id);
    }
    periods.add(id);
    boards.set(id, projection.board);
  }
  demand(boards.size <= 1024, 'Rebased event board limit exceeded');
  let updatedAt = previous.totals.updatedAt, rowCount = 0;
  for (const [id, board] of boards) {
    rowCount += board.entries.length;
    demand(rowCount <= 1000000, 'Rebased event contribution limit exceeded');
    if (periods.has(id)) updatedAt = Math.max(updatedAt, board.updatedAt);
    for (const entry of board.entries) {
      const row = rows.get(entry.accountId) || {...clone(entry), rp: 0, events: 0};
      demand(integer(row.rp + entry.rp) && integer(row.events + 1), 'Rebased finite totals overflow');
      row.rp += entry.rp; row.events++;
      rows.set(entry.accountId, row);
    }
  }
  demand(rows.size <= 10000, 'Rebased totals account limit exceeded');
  const finite = {updatedAt, entries: [...rows.values()], complete: true, totalEntries: rows.size};
  for (const row of finite.entries) for (const key of ['finiteEventRp', 'permanentRollingHillsRp', 'dynamicEventRp',
    'rollingHillsTimeMs', 'rollingHillsRunAgeMs', 'rollingHillsEventRpContribution', 'eventHighlights']) delete row[key];
  demand(capturedRollingBoard === undefined || rollingNormalBoard === undefined, 'Choose one explicit Rolling Hills source');
  if (capturedRollingBoard !== undefined) demand(capturedRollingBoards.has(capturedRollingBoard), 'Pinned captured-native Rolling Hills result required');
  const rollingBoard = capturedRollingBoard ?? derivePermanentRollingHills(rollingNormalBoard);
  const merged = mergePermanentRollingIntoTotals(finite, rollingBoard);
  for (const row of merged.entries) demand(integer(row.rp), 'Rebased total RP overflow');
  const totals = projectAssembledEventTotals(merged, {capturedBoards: [...boards.values(), rollingBoard]});
  const retainedPeriodIds = [...priorBoards.keys()].filter(id => !periods.has(id)).sort();
  totals.nativeEventOverlay = {version: VERSION, source: 'trusted-published-rebase',
    totalsBaselineDigest: pairedDigest, publishedBaseline: clone(previous.provenance), backendPairingDigest: pairedDigest,
    finiteCoverage: 'projected-periods-with-retained-history', retainedPeriodIds,
    ...(rollingBoard.capturedNativeSource ? {rollingSource: rollingBoard.capturedNativeSource} : {})};
  return freeze({totals, rollingBoard, boards: [...boards.values()], publishedBaseline: previous,
    report: {source: 'trusted-published-rebase', priorGeneration: previous.provenance.generation,
      projectedPeriodIds: [...periods].sort(), retainedPeriodIds, newPeriodIds: newPeriodIds.sort(),
      residualAccounts: previous.residuals.filter(row => row.rp || row.events).length}});
}

function retentionRestrictions(row) {
  const result = restrictions(row);
  for (const key of ['pending', 'playbackPending']) if (row[key] === true) result[key] = true;
  for (const key of ['verified', 'physicsVerified', 'replayIntegrityVerified', 'runVerified', 'integrityVerified', 'eventRpEligible']) {
    if (row[key] === false) result[key] = false;
  }
  if (row.verificationStatus !== undefined && row.verificationStatus !== 'verified') result.verificationStatus = row.verificationStatus;
  if (row.verifiedState === 0 || row.verifiedState === false) result.verifiedState = row.verifiedState;
  return result;
}

/** Compile integration entry point: pass ALL current period projections, never
 * prefilter totalsEligible:false. These non-scoring observations grant no proof
 * authority: only the pinned prior board is published for a retained period.
 * Stable/subset legacy rows and already represented pending rows are safe to
 * retain. A changed scoring binding, new restriction, or unrepresented pending
 * row blocks the entire candidate with the offending period ID, not a silent
 * per-period omission. No pending rows are promoted, merged, or newly scored.
 * Publish publicationProjections (including their replay lists), not the input
 * projections: proof-only current replay updates must not overwrite retained PBs.
 */
export function reconcileNativeEventTotalsFromPublished({publishedBaseline, projections = [], ...options} = {}) {
  const previous = assertTrustedPublishedEventTotalsBaseline(publishedBaseline);
  demand(Array.isArray(projections) && projections.length <= 1024, 'Invalid event projection list');
  const priorBoards = new Map(previous.boards.map(value => [value.board.id, value.board]));
  const eligible = [], seen = new Set(), retainedCurrentPeriodIds = [];
  for (const projection of projections) {
    const current = projection?.board, id = current?.id;
    demand(typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id) && !seen.has(id),
      'Invalid or duplicate current event period: ' + id);
    seen.add(id);
    if (projection.totalsEligible !== false) {eligible.push(projection); continue;}
    const prior = priorBoards.get(id);
    const check = (condition, reason) => demand(condition, 'Retained event publication blocked [' + id + ']: ' + reason);
    check(projection.ready !== false, 'current proof projection is not ready');
    check(prior && current.period && current.period.id === id, 'pinned prior period required');
    check(digest(frozenEventPolicy(current.period)) === digest(frozenEventPolicy(prior.period)), 'frozen period policy changed');
    check(Array.isArray(current.entries) && current.entries.length <= 10000, 'invalid current scoring lane');
    const represented = new Map(prior.entries.map(row => [row.accountId, row])), accounts = new Set();
    const unchangedRestrictions = (row, old) => Object.entries(retentionRestrictions(row)).every(([key, value]) => old[key] === value);
    check(unchangedRestrictions(current, prior), 'new board restriction requires complete reconciliation');
    for (const row of current.entries) {
      check(row && HEX.test(row.accountId || '') && !accounts.has(row.accountId), 'invalid or duplicate current scoring account');
      accounts.add(row.accountId);
      const old = represented.get(row.accountId);
      check((row.periodId === undefined || row.periodId === id) &&
        (row.trackId === undefined || row.trackId === current.period.trackId) &&
        ['frames', 'raceTimeFrames'].every(key => row[key] === undefined || row[key] === row.timeMs) &&
        ['runId', 'replayHash'].every(key => row[key] === undefined || HEX.test(row[key])), 'invalid current scoring binding');
      check(old && row.timeMs === old.timeMs && row.rp === old.rp &&
        (row.rank === undefined || row.rank === old.rank), 'current scoring contribution differs from pinned prior');
      for (const key of ['runId', 'replayHash', 'submittedAt', 'runCreatedAt', 'frames', 'raceTimeFrames', 'trackId', 'periodId']) {
        check(row[key] === undefined || old[key] === undefined || row[key] === old[key], 'current scoring binding/date changed: ' + key);
      }
      check(unchangedRestrictions(row, old), 'new scoring restriction requires complete reconciliation');
      check(row.replayUnavailable === undefined || row.replayUnavailable === old.replayUnavailable,
        'current replay availability differs from pinned prior');
    }
    check(current.pendingPlaybacks === undefined || Array.isArray(current.pendingPlaybacks) && current.pendingPlaybacks.length <= 512,
      'invalid current pending lane');
    const pending = prior.pendingPlaybacks || [], runs = new Set();
    for (const row of current.pendingPlaybacks || []) {
      check(row && HEX.test(row.runId || '') && !runs.has(row.runId), 'invalid or duplicate current pending run');
      runs.add(row.runId);
      check(pending.some(old => old.runId === row.runId && digest(old) === digest(row)),
        'new or changed pending row would be lost; retain it unscored before publication');
    }
    retainedCurrentPeriodIds.push(id);
  }
  const combined = rebaseNativeEventTotalsFromPublished({...options, publishedBaseline, projections: eligible});
  const projected = new Map(eligible.map(value => [value.board.id, value]));
  const publicationProjections = combined.boards.map(board => ({board,
    promotedReplays: projected.get(board.id)?.promotedReplays ?? [], totalsEligible: projected.has(board.id)}));
  return freeze({...combined, publicationProjections,
    report: {...combined.report, retainedCurrentPeriodIds: retainedCurrentPeriodIds.sort()}});
}
