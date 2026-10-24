import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fetchPublicBackupJson as fetchJson, PublicBackupDeferredError} from './public-backup-fetch.mjs';
import {publicDisplayName} from './public-display-name.mjs';
import {assemblePublishedSnapshotPages} from './published-snapshot-pages.mjs';

export const PUBLIC_SNAPSHOT_LIMITS = Object.freeze({trackFetches: 100, eventFetches: 120, eventReplayFetches: 30, pageFetches: 100,
  eventReplaysPerPeriod: 500, eventReplayResponseBytes: 70 * 1024, responseBytes: 2 * 1024 * 1024, concurrency: 4});
const WORKER = 'https://polytrack-ranked-worker.staticquasar931.workers.dev';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = path.join(root, 'local-reports', 'snapshot-staging');
const TRACK_ID = /^[a-f0-9]{64}$/;
const EVENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PUBLIC_ACCOUNT_ID = /^[a-f0-9]{64}$/;
const MAX_PENDING_EVENT_ROWS = 512;
const MAX_EVENT_TIME_MS = 300000;

const overallFields = ['updatedAt', 'builtAt', 'revision', 'builtRevision', 'sourceRevision', 'algorithmVersion',
  'schemaVersion', 'averagePlacementVersion', 'derivedMetricsVersion', 'serverAchievementVersion', 'complete',
  'totalEntries', 'totalEntriesExact', 'publishedEntries', 'entryLimit', 'trackLimit', 'resultBundleVersion',
  'resultBundleEncoding', 'resultBundleComplete', 'resultBundleStatus', 'resultBoardCount', 'resultBoardLimit',
  'resultBoardLimitReached', 'resultCoverage', 'resultBundleLocation', 'sourceComplete', 'paginatedSource', 'pagination'];
const overallEntryFields = ['userId', 'name', 'countryCode', 'carId', 'carColors', 'carStyle', 'profileCosmetics',
  'cosmeticUnlocks', 'serverAchievements', 'accountCreatedAt', 'totalPlaytimeMs', 'latestPbAt', 'groupCode', 'groupCodeUpdatedAt',
  'score', 'raceCount', 'eligibleTrackCount', 'provisional', 'totalTracks', 'officialCount', 'communityCount',
  'customCount', 'extraCount', 'weightedTracks', 'skillCost', 'coverageCost', 'consistencyCost', 'averageFinish',
  'averageFinishVersion', 'averagePlacement', 'averagePlacementVersion', 'competitiveAveragePlacement',
  'competitiveAverageEligibleTracks', 'podiumEligibleTracks', 'podiumRate', 'trackWins', 'pbCount', 'bestTracks',
  'strongestTrack', 'worstTrack', 'improvementTrack', 'weightedResults', 'opportunityTracks', 'medals', 'bestTrackId',
  'bestTrackRank', 'bestTrackField', 'rankTier', 'rankModel', 'timingVersion', 'badges', 'rank', 'movement',
  'movementAt', 'rankSince', 'scoreDelta', 'identityUpdatedAt'];
const trackEntryFields = ['id', 'uploadId', 'replayHash', 'trackId', 'accountId', 'userId', 'name', 'nickname', 'countryCode',
  'carId', 'carColors', 'carStyle', 'profileCosmetics', 'timeMs', 'frames', 'raceTimeFrames', 'rankModel', 'timingVersion',
  'pbAt', 'createdAt', 'accountCreatedAt', 'totalPlaytimeMs', 'pbCount', 'rank', 'position', 'fieldSize', 'weight',
  'competition', 'integrityVerified', 'runVerified', 'verified', 'validationState', 'verificationStatus', 'verifiedState', 'unranked', 'identityUpdatedAt'];
const finishFields = ['trackId', 'rank', 'fieldSize', 'weight', 'placementCost', 'contribution', 'improvementValue',
  'timeMs', 'pbAt', 'type', 'competition', 'timingVersion'];
const cosmeticFields = ['version', 'theme', 'accent', 'finish', 'plate', 'edge', 'stage', 'stageTint', 'stripe',
  'stageEffect', 'emblem', 'emblem2', 'emblem3', 'emblemBackdrop', 'nameFont', 'nameSize', 'nameWeight', 'nameColor',
  'baseSecondary', 'title', 'badge', 'favoriteTrackId', 'overridePodium'];
const summaryFields = ['trackId', 'type', 'fieldSize', 'weight', 'recordMs', 'updatedAt'];
const leaderFields = ['accountId', 'name', 'countryCode', 'carStyle', 'timeMs', 'rank'];
const periodFields = ['id', 'trackId', 'startsAt', 'endsAt', 'graceMs', 'maxRp', 'targetMs', 'kind', 'racerCount',
  'entrantLimit', 'label', 'trackName', 'author', 'targetPolicy'];
const eventEntryFields = ['accountId', 'name', 'carStyle', 'timeMs', 'rp', 'rank', 'countryCode', 'frames', 'runAt',
  'runAgeMs', 'eventRpContribution', 'normalRpEligible', 'physicsVerified', 'replayIntegrityVerified'];
const eventFields = ['id', 'kind', 'trackId', 'period', 'scoreVersion', 'targetPolicy', 'targetMs', 'maxRp', 'sourceRevision',
  'updatedAt', 'archived', 'state', 'racerCount', 'complete', 'totalEntries', 'sourceTotalEntries', 'sourceCompleteness',
  'contributions', 'eventRpComplete', 'entries', 'sourceComplete', 'paginatedSource', 'pagination', 'publicationPending'];
const pendingEventFields = ['accountId', 'runId', 'timeMs', 'name', 'carStyle', 'submittedAt'];

function project(source, fields) {
  const result = {};
  for (const field of fields) if (Object.hasOwn(source || {}, field)) result[field] = ['name', 'nickname', 'author'].includes(field) ? publicDisplayName(source[field]) : source[field];
  return result;
}
function eventDates(source) {
  const result = {};
  for (const field of ['submittedAt', 'verifiedAt']) {
    if (Number.isSafeInteger(source?.[field]) && source[field] > 0) result[field] = source[field];
  }
  return result;
}
function applyReplayDates(entry, replay) {
  // A PB submission date and a successful verification date are different evidence.
  const dates = eventDates(replay);
  if (dates.verifiedAt) entry.verifiedAt = dates.verifiedAt;
  if (!entry.submittedAt && dates.submittedAt) entry.submittedAt = dates.submittedAt;
}
function projectCosmetics(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? project(value, cosmeticFields) : undefined;
}
function projectFinish(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? project(value, finishFields) : value;
}

function projectOverallEntry(entry) {
  const result = project(entry, overallEntryFields);
  if (result.profileCosmetics) result.profileCosmetics = projectCosmetics(result.profileCosmetics);
  for (const key of ['bestTracks', 'weightedResults', 'opportunityTracks']) {
    if (Array.isArray(result[key])) result[key] = result[key].map(projectFinish);
  }
  for (const key of ['strongestTrack', 'worstTrack', 'improvementTrack']) if (result[key]) result[key] = projectFinish(result[key]);
  if (result.badges && typeof result.badges === 'object') result.badges = { ...(result.badges.betaTester === true ? {betaTester: true} : {}) };
  if (Array.isArray(result.cosmeticUnlocks)) result.cosmeticUnlocks = result.cosmeticUnlocks
    .filter(value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}:[A-Za-z0-9_-]{1,64}$/.test(value)).slice(0, 32);
  if (result.serverAchievements && typeof result.serverAchievements === 'object') {
    const beatOwner = result.serverAchievements.beatOwner;
    const casual = result.serverAchievements.casual;
    const projectedAchievements = {};
    if (casual && typeof casual === 'object' && !Array.isArray(casual)) {
      projectedAchievements.casual = {
        ...(Number.isSafeInteger(casual.count) && casual.count >= 0 ? {count: casual.count} : {}),
        ...(casual.scoringVersion === 2 && Number.isFinite(casual.rp) && casual.rp >= 0 ? {rp: casual.rp} : {}),
        ...(casual.scoringVersion === 2 ? {scoringVersion: 2} : {})
      };
      if (!Object.keys(projectedAchievements.casual).length) delete projectedAchievements.casual;
    }
    if (beatOwner && typeof beatOwner === 'object' && !Array.isArray(beatOwner)) projectedAchievements.beatOwner = {
      ...(TRACK_ID.test(beatOwner.targetAccountId || '') ? {targetAccountId: beatOwner.targetAccountId} : {}),
      ...(Number.isSafeInteger(beatOwner.count) && beatOwner.count >= 0 ? {count: beatOwner.count} : {}),
      unlocks: (Array.isArray(beatOwner.unlocks) ? beatOwner.unlocks : []).filter(row =>
        typeof row?.cosmeticId === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}:[A-Za-z0-9_-]{1,64}$/.test(row.cosmeticId))
        .slice(0, 32).map(row => ({cosmeticId: row.cosmeticId,
          ...(Number.isSafeInteger(row.unlockedAt) && row.unlockedAt >= 0 ? {unlockedAt: row.unlockedAt} : {})}))
    };
    result.serverAchievements = Object.keys(projectedAchievements).length ? projectedAchievements : undefined;
  }
  return result;
}

function validBoardLength(value, legacyLimit) {
  if (!Array.isArray(value?.entries)) return false;
  if (value.entries.length <= legacyLimit) return true;
  const p = value.pagination;
  return value.entries.length <= 10000 && value.paginatedSource === true && typeof value.sourceComplete === 'boolean' &&
    typeof value.complete === 'boolean' && value.totalEntries === value.entries.length && p?.version === 1 &&
    /^[a-f0-9]{64}$/.test(p.generation || '') && p.complete === true && p.pageSize === 100 &&
    p.totalEntries === value.entries.length && p.pageCount === Math.ceil(value.entries.length / 100);
}

export function publicOverallBackup(value) {
  if (!value || typeof value !== 'object' || !Number.isSafeInteger(value.updatedAt) || !Array.isArray(value.entries) ||
      !validBoardLength(value, 200) || !Array.isArray(value.trackSummaries) || value.trackSummaries.length > 500) {
    throw Error('Invalid public overall snapshot');
  }
  const snapshot = project(value, overallFields);
  snapshot.entries = value.entries.map(projectOverallEntry);
  snapshot.trackSummaries = value.trackSummaries.map(row => ({...project(row, summaryFields),
    ...(row?.leader && typeof row.leader === 'object' ? {leader: project(row.leader, leaderFields)} : {})}));
  if (value.trackCatalog !== undefined) {
    if (!Array.isArray(value.trackCatalog) || value.trackCatalog.length > 500) throw Error('Invalid public track catalog');
    const seen = new Set();
    snapshot.trackCatalog = value.trackCatalog.map(row => {
      if (!TRACK_ID.test(row?.trackId || '') || seen.has(row.trackId) || !Number.isSafeInteger(row.updatedAt) || row.updatedAt < 0) throw Error('Invalid public track catalog entry');
      seen.add(row.trackId);
      return {trackId: row.trackId, updatedAt: row.updatedAt};
    });
  }
  let planner = {available: false, reason: 'not-present'};
  if (typeof value.resultBundle === 'string' && value.resultBundle && value.resultBundleComplete === true &&
      Number.isSafeInteger(value.resultBundleVersion) && typeof value.algorithmVersion === 'string' &&
      Number.isSafeInteger(value.sourceRevision) && Number.isSafeInteger(value.builtRevision)) {
    snapshot.resultBundleLocation = 'main_results';
    delete snapshot.resultBundle;
    planner = {available: true, reason: 'inline-bundle', document: {
      resultBundle: value.resultBundle, resultBundleVersion: value.resultBundleVersion,
      resultBundleEncoding: value.resultBundleEncoding, resultBundleComplete: true, resultBundleStatus: 'complete',
      resultCoverage: value.resultCoverage, resultBoardCount: value.resultBoardCount,
      resultBoardLimit: value.resultBoardLimit, resultBoardLimitReached: value.resultBoardLimitReached,
      sourceRevision: value.sourceRevision, builtRevision: value.builtRevision,
      updatedAt: value.updatedAt, algorithmVersion: value.algorithmVersion
    }};
  } else if (value.resultBundleLocation === 'main_results') {
    delete snapshot.resultBundleLocation;
    snapshot.resultBundleComplete = false;
    snapshot.resultBundleStatus = 'sidecar_unavailable';
    planner = {available: false, reason: 'sidecar-not-in-public-response'};
  }
  delete snapshot.resultBundle;
  return {snapshot, planner};
}

export function publicTrackBackup(value, trackId) {
  if (!TRACK_ID.test(trackId) || !value || typeof value !== 'object' || value.trackId !== trackId ||
      !Number.isSafeInteger(value.updatedAt) || !validBoardLength(value, 500)) {
    throw Error('Invalid public track snapshot');
  }
  const snapshot = project(value, ['trackId', 'complete', 'totalEntries', 'updatedAt', 'builtAt', 'schemaVersion',
    'algorithmVersion', 'revision', 'sourceRevision', 'sourceComplete', 'paginatedSource', 'pagination']);
  snapshot.entries = value.entries.map(entry => {
    const result = project(entry, trackEntryFields);
    if (result.profileCosmetics) result.profileCosmetics = projectCosmetics(result.profileCosmetics);
    return result;
  });
  return snapshot;
}

function projectPeriod(value) {
  const result = project(value, periodFields);
  if (!EVENT_ID.test(result.id || '') || !TRACK_ID.test(result.trackId || '') ||
      !Number.isSafeInteger(result.startsAt) || !Number.isSafeInteger(result.endsAt) || result.endsAt <= result.startsAt) {
    throw Error('Invalid public event period');
  }
  return result;
}

function projectPendingEventRows(rows, eventId, period) {
  if (!Array.isArray(rows) || rows.length > MAX_PENDING_EVENT_ROWS || !period || period.id !== eventId ||
      !TRACK_ID.test(period.trackId || '') || !['daily', 'weekly', 'custom', 'kodub'].includes(period.kind) ||
      !Number.isSafeInteger(period.startsAt) || !Number.isSafeInteger(period.endsAt) || period.endsAt <= period.startsAt) return null;
  const runs = new Set(), projected = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row) ||
        !PUBLIC_ACCOUNT_ID.test(row.accountId || '') || !/^[a-f0-9]{64}$/.test(row.runId || '') ||
        runs.has(row.runId) ||
        !Number.isSafeInteger(row.timeMs) || row.timeMs < 1 || row.timeMs > MAX_EVENT_TIME_MS ||
        typeof row.name !== 'string' || row.name.length > 24 ||
        typeof row.carStyle !== 'string' || row.carStyle.length > 256 || row.carStyle && !/^[A-Za-z0-9_-]+$/.test(row.carStyle) ||
        !Number.isSafeInteger(row.submittedAt) || row.submittedAt < period.startsAt || row.submittedAt >= period.endsAt ||
        row.verificationStatus !== 'waiting' || row.pending !== true || row.verified !== false ||
        row.eventRpEligible !== false || row.source !== 'pending-event-playback' ||
        row.periodId !== undefined && row.periodId !== eventId || row.trackId !== undefined && row.trackId !== period.trackId) return null;
    runs.add(row.runId);
    projected.push({...project(row, pendingEventFields), name: publicDisplayName(row.name),
      verificationStatus: 'waiting', pending: true, verified: false, eventRpEligible: false,
      source: 'pending-event-playback'});
  }
  return projected;
}

export function publicEventBackup(value, eventId) {
  if (!EVENT_ID.test(eventId) || !value || typeof value !== 'object' || !Number.isSafeInteger(value.updatedAt) ||
      !validBoardLength(value, 500) && !(eventId === 'permanent-rolling-hills' && Array.isArray(value.entries) && value.entries.length <= 10000 && value.complete === true && value.totalEntries === value.entries.length && value.sourceCompleteness === 'paged-source-manifest')) throw Error('Invalid public event snapshot');
  if (value.id && value.id !== eventId) throw Error('Public event identity mismatch');
  if (value.period && value.period.id !== eventId) throw Error('Public event period mismatch');
  const result = project(value, eventFields);
  if (value.period) result.period = projectPeriod(value.period);
  result.id = eventId;
  result.entries = value.entries.map(row => {
    const entry = {...project(row, eventEntryFields), ...eventDates(row)};
    for (const key of ['runId', 'replayHash']) if (typeof row?.[key] === 'string' && TRACK_ID.test(row[key])) entry[key] = row[key];
    return entry;
  });
  if (value.archived !== true && Array.isArray(value.pendingPlaybacks) && value.pendingPlaybacks.length) {
    const pending = projectPendingEventRows(value.pendingPlaybacks, eventId, value.period);
    if (pending) result.pendingPlaybacks = pending;
  }
  if (result.contributions && typeof result.contributions === 'object') result.contributions = project(result.contributions, ['normalRp', 'eventRp']);
  if (result.dynamicComponents && typeof result.dynamicComponents === 'object') {
    const rolling = result.dynamicComponents.permanentRollingHills;
    result.dynamicComponents = rolling && typeof rolling === 'object' ? {permanentRollingHills: project(rolling,
      ['status', 'id', 'trackId', 'scoreVersion', 'targetPolicy', 'targetMs', 'maxRp', 'sourceRevision', 'updatedAt'])} : {};
  }
  return result;
}

export function isReusableArchivedEventBackup(value, eventId) {
  try {
    publicEventBackup(value, eventId);
    if (value.archived !== true || eventId === 'permanent-rolling-hills') return false;
    for (const field of ['complete', 'sourceComplete'])
      if (value[field] !== undefined && value[field] !== true) return false;
    if (value.publicationPending !== undefined && value.publicationPending !== false) return false;
    for (const field of ['totalEntries', 'sourceTotalEntries'])
      if (value[field] !== undefined && value[field] !== value.entries.length) return false;
    if (value.pagination !== undefined || value.paginatedSource === true) {
      const p = value.pagination;
      if (value.complete !== true || value.paginatedSource !== true || p?.version !== 1 ||
          !TRACK_ID.test(p.generation || '') || p.complete !== true || p.pageSize !== 100 ||
          p.totalEntries !== value.entries.length || p.pageCount !== Math.ceil(value.entries.length / 100))
        return false;
    }
    if (value.complete === true) return true;
    // Legacy frozen archives omit completeness metadata. An exact, validated
    // racer count establishes coverage without inventing complete:true.
    if (!value.period || !Number.isSafeInteger(value.racerCount) || value.racerCount < 0 ||
        value.racerCount !== value.entries.length) return false;
    const limit = value.period.entrantLimit;
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || value.racerCount > limit)) return false;
    const seen = new Set();
    for (const row of value.entries) {
      if (!PUBLIC_ACCOUNT_ID.test(row?.accountId || '') || seen.has(row.accountId) ||
          !Number.isSafeInteger(row.timeMs) || row.timeMs < 1 || row.timeMs > MAX_EVENT_TIME_MS) return false;
      seen.add(row.accountId);
    }
    return true;
  } catch { return false; }
}

// Explicit manual capture only: credentials never go to public/live URLs,
// redirects or arbitrary hosts. The Worker independently enforces frozen data.
export function createAdminArchiveCaptureFetch({fetchImpl = fetch, token, periodIds, maxRequests = 16} = {}) {
  if (typeof token !== 'string' || !token || token.trim() !== token || token.length > 4096 ||
      !Array.isArray(periodIds) || !periodIds.length || periodIds.length > 120 ||
      periodIds.some(id => !EVENT_ID.test(id) || id === 'permanent-rolling-hills') ||
      new Set(periodIds).size !== periodIds.length ||
      !Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 120)
    throw Error('Invalid bounded admin archive capture options');
  const ids = new Set(periodIds);
  let requests = 0, documentReads = 0;
  const captureFetch = async (input, init = {}) => {
    const url = new URL(input);
    if (url.origin !== new URL(WORKER).origin) throw Error('Unexpected archive capture host');
    const match = /^\/v1\/events\/([A-Za-z0-9_-]{1,64})\/(.+)$/.exec(url.pathname);
    if (!match || !ids.has(match[1])) return fetchImpl(input, init);
    if ((init.method || 'GET') !== 'GET' ||
        !/^(snapshot(?:\/page)?|track|replays\/[a-f0-9]{64})$/.test(match[2]))
      throw Error('Unsupported admin archive capture resource');
    if (requests >= maxRequests) throw new PublicBackupDeferredError('Admin archive capture request budget reached');
    requests++;
    url.pathname = '/v1/events/admin/archive-export/' + match[1] + '/' + match[2];
    const headers = new Headers(init.headers);
    headers.set('Origin', 'https://staticquasar931.github.io');
    headers.set('X-Admin-Token', token);
    const response = await fetchImpl(url.href, {...init, method:'GET', headers, redirect:'error'});
    const reads = response.headers.get('X-Archive-Document-Reads');
    if (!/^[0-6]$/.test(reads || '')) {
      documentReads += 6;
      throw new PublicBackupDeferredError('Admin archive capture read accounting unavailable');
    }
    documentReads += Number(reads);
    return response;
  };
  return {fetch: captureFetch, stats: () => ({requests, documentReads, documentReadCeiling:maxRequests * 6})};
}

export function publicEventReplayBackup(value, {periodId, trackId, entry}) {
  if (!EVENT_ID.test(periodId || '') || !TRACK_ID.test(trackId || '') || !PUBLIC_ACCOUNT_ID.test(entry?.accountId || '') ||
      !Number.isSafeInteger(entry?.timeMs) || !value || typeof value !== 'object' || value.periodId !== periodId ||
      value.trackId !== trackId || value.accountId !== entry.accountId || value.timeMs !== entry.timeMs ||
      entry.runId && value.runId !== entry.runId || entry.replayHash && value.replayHash !== entry.replayHash ||
      value.verificationStatus !== 'verified' || value.verified !== true || value.eventRpEligible !== true ||
      value.frames !== entry.timeMs || typeof value.runId !== 'string' || !/^[a-f0-9]{64}$/.test(value.runId) ||
      typeof value.replay !== 'string' || !value.replay.length || Buffer.byteLength(value.replay) > 65536 ||
      typeof value.replayHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.replayHash) ||
      typeof value.carStyle !== 'string' || value.carStyle.length > 256 || sha256(value.replay) !== value.replayHash) {
    throw Error('Invalid or unbound public event replay');
  }
  return {periodId, trackId, accountId: entry.accountId, runId: value.runId, timeMs: entry.timeMs,
    frames: entry.timeMs, replay: value.replay, replayHash: value.replayHash, carStyle: value.carStyle,
    ...eventDates(value)};
}

function parseSet(source, name) {
  const match = new RegExp(`(?:const|export const)\\s+${name}\\s*=\\s*new Set\\(\\[([^\\]]*)\\]\\)`).exec(source);
  if (!match) throw Error(`Missing track registry ${name}`);
  // Parse only literal track IDs, never evaluate JavaScript from a registry.
  const literal = `(?:'[a-f0-9]{64}'|"[a-f0-9]{64}")`;
  if (!new RegExp(`^\\s*(?:${literal}(?:\\s*,\\s*${literal})*\\s*,?)?\\s*$`).test(match[1])) {
    throw Error(`Invalid track registry ${name}`);
  }
  return [...match[1].matchAll(/['"]([a-f0-9]{64})['"]/g)].map(row => row[1]);
}

export function publicTrackRegistry(indexSource, extraSource) {
  const ids = new Set([...parseSet(indexSource, 'OFFICIAL_IDS'), ...parseSet(indexSource, 'COMMUNITY_IDS'),
    ...parseSet(indexSource, 'LEGACY_COMMUNITY_IDS')]);
  for (const id of parseSet(extraSource || '', 'EXTRA_TRACK_IDS')) ids.add(id);
  return [...ids].sort();
}

export function chooseTrackFetches(trackIds, summaries, previous = {}, limit = PUBLIC_SNAPSHOT_LIMITS.trackFetches, now = Date.now()) {
  const summaryById = new Map((Array.isArray(summaries) ? summaries : []).filter(row => TRACK_ID.test(row?.trackId || '') &&
    Number.isSafeInteger(row?.updatedAt)).map(row => [row.trackId, row]));
  const candidates = [...new Set(trackIds)].filter(id => TRACK_ID.test(id)).map(id => {
    const prior = previous[id], summary = summaryById.get(id);
    const same = !!prior?.path && !!summary && Number(prior.sourceUpdatedAt) === summary.updatedAt;
    const dirty = !!summary && !same;
    const missing = !prior?.path && (!prior?.missing || now - Number(prior.checkedAt || 0) >= 7 * 86400000);
    const staleWithoutSummary = !summary && prior?.path && now - Number(prior.checkedAt || 0) >= 7 * 86400000;
    return {id, prior, summary, dirty, missing, needsFetch: !same && (dirty || missing || staleWithoutSummary)};
  }).filter(row => row.needsFetch);
  const day = Math.floor(now / 86400000);
  candidates.sort((a, b) => Number(b.dirty) - Number(a.dirty) || Number(!a.prior?.path) - Number(!b.prior?.path) ||
    (a.dirty && b.dirty ? Number(a.summary.updatedAt) - Number(b.summary.updatedAt) : 0) ||
    Number(a.prior?.checkedAt || 0) - Number(b.prior?.checkedAt || 0) ||
    crypto.createHash('sha256').update(`${day}:${a.id}`).digest('hex').localeCompare(
      crypto.createHash('sha256').update(`${day}:${b.id}`).digest('hex')));
  return candidates.slice(0, Math.max(0, Math.min(limit, PUBLIC_SNAPSHOT_LIMITS.trackFetches))).map(row => row.id);
}

function selectEventIds(catalog) {
  if (!catalog || !Array.isArray(catalog.periods) || !Array.isArray(catalog.archives) ||
      catalog.periods.length > 160 || catalog.archives.length > 160) throw Error('Invalid public event catalog');
  const periods = catalog.periods.map(projectPeriod);
  const archives = catalog.archives.map(projectPeriod).sort((a, b) => b.endsAt - a.endsAt || a.id.localeCompare(b.id));
  return [...new Set([...periods.map(row => row.id), ...archives.map(row => row.id), 'permanent-rolling-hills'])];
}

async function mapLimit(values, limit, fn) {
  const result = new Array(values.length);
  let index = 0;
  let stopped = false;
  await Promise.all(Array.from({length: Math.min(limit, values.length)}, async () => {
    for (;;) {
      const current = index++;
      if (stopped || current >= values.length) return;
      try { result[current] = await fn(values[current]); }
      catch (error) { stopped = true; throw error; }
    }
  }));
  return result;
}

async function readManifest(directory) {
  try {
    const value = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
    if (value?.schemaVersion !== 1 || !value.tracks || typeof value.tracks !== 'object' || Array.isArray(value.tracks)) throw Error('Invalid public snapshot manifest');
    for (const id of Object.keys(value.tracks)) if (!TRACK_ID.test(id)) throw Error('Invalid track in public snapshot manifest');
    for (const [id, record] of Object.entries(value.events || {})) {
      if (!EVENT_ID.test(id) || record?.path !== `events/${id}.json`) throw Error('Invalid event in public snapshot manifest');
    }
    for (const [key, record] of Object.entries(value.eventReplays || {})) {
      if (!EVENT_ID.test(record?.periodId || '') || !PUBLIC_ACCOUNT_ID.test(record?.accountId || '') ||
          key !== `event-replays/${record.periodId}/${record.accountId}.json` || record.path !== key) throw Error('Invalid replay in public snapshot manifest');
    }
    return value;
  } catch (error) { if (error.code === 'ENOENT') return {schemaVersion: 1, tracks: {}, events: {}}; throw error; }
}

function jsonText(value) { return JSON.stringify(value) + '\n'; }
function sha256(text) { return crypto.createHash('sha256').update(text).digest('hex'); }

async function writeJsonIfChanged(directory, relative, value) {
  const absolute = path.resolve(directory, relative);
  if (!absolute.startsWith(path.resolve(directory) + path.sep)) throw Error('Invalid public snapshot path');
  const text = jsonText(value);
  try { if (await fs.readFile(absolute, 'utf8') === text) return {changed: false, sha256: sha256(text)}; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(path.dirname(absolute), {recursive: true});
  const temporary = absolute + '.' + crypto.randomUUID() + '.tmp';
  await fs.writeFile(temporary, text, {flag: 'wx'});
  await fs.rename(temporary, absolute);
  return {changed: true, sha256: sha256(text)};
}

async function capturePublicSnapshotBackup({fetchImpl = fetch, directory = outputDirectory, now = Date.now(),
  trackIds = null, log = console.log, archiveExport = null} = {}) {
  const adminCapture = archiveExport ? createAdminArchiveCaptureFetch({...archiveExport, fetchImpl}) : null;
  if (adminCapture) fetchImpl = adminCapture.fetch;
  const previous = await readManifest(directory);
  let pageFetches = 0;
  const assemble = (value, endpoint) => assemblePublishedSnapshotPages(value, {fetchPage: (page, generation) => {
    if (pageFetches >= PUBLIC_SNAPSHOT_LIMITS.pageFetches) throw new PublicBackupDeferredError('Public snapshot page budget reached');
    pageFetches++;
    const url = new URL(endpoint, WORKER);url.searchParams.set('generation', generation);url.searchParams.set('page', String(page));
    return fetchJson(fetchImpl, url.href);
  }});
  const overallRaw = await assemble(await fetchJson(fetchImpl, `${WORKER}/v1/snapshot/overall`), '/v1/snapshot/overall/page');
  const {snapshot: overall, planner} = publicOverallBackup(overallRaw);
  const catalog = await fetchJson(fetchImpl, `${WORKER}/v1/events/catalog`);
  const selectedEvents = selectEventIds(catalog);
  if (!catalog.periods.length && !catalog.archives.length && Object.keys(previous.events || {}).length) {
    throw new PublicBackupDeferredError('Empty event catalog; retaining saved event backups');
  }
  const liveIds = new Set((catalog.periods || []).filter(row=>!(Number.isFinite(row.endsAt)&&row.endsAt+Math.max(0,Number(row.graceMs)||0)<=now)).map(row => row.id));
  const archiveRepairIds=new Set(adminCapture?archiveExport.periodIds:[]);
  const eventFetchIds = [];
  let archivedEventsReused = 0, archivedEventsUnavailable = 0;
  for (const id of selectedEvents) {
    const record = previous.events?.[id];
    let reusable = false;
    if (!liveIds.has(id) && id !== 'permanent-rolling-hills' && record?.path === `events/${id}.json` &&
        Number(record.checkedAt) > 0) {
      try {
        const cached = JSON.parse(await fs.readFile(path.join(directory, record.path), 'utf8'));
        // Completed finite event standings are immutable. Repair only missing,
        // invalid or incomplete captures, not every archive on a rolling timer.
        reusable = isReusableArchivedEventBackup(cached, id);
      } catch { /* A missing or invalid backup must be fetched again. */ }
    }
    if (reusable) archivedEventsReused++;
    else if(!liveIds.has(id)&&id!=='permanent-rolling-hills'&&!archiveRepairIds.has(id))archivedEventsUnavailable++;
    else eventFetchIds.push(id);
  }
  // Missing and oldest archives go first, so a catalog larger than one batch
  // eventually gets complete coverage without increasing the request budget.
  eventFetchIds.sort((a, b) => Number(liveIds.has(b) || b === 'permanent-rolling-hills') - Number(liveIds.has(a) || a === 'permanent-rolling-hills') ||
    Number(previous.events?.[a]?.checkedAt || 0) - Number(previous.events?.[b]?.checkedAt || 0));
  eventFetchIds.splice(PUBLIC_SNAPSHOT_LIMITS.eventFetches);
  let registry = trackIds;
  if (!registry) {
    const [indexSource, extraSource] = await Promise.all([
      fs.readFile(path.join(root, 'workers/ranked/src/index.js'), 'utf8'),
      fs.readFile(path.join(root, 'workers/ranked/src/extra-track-ids.js'), 'utf8')
    ]);
    registry = publicTrackRegistry(indexSource, extraSource);
  }
  // Weekly tracks may have a public board before they enter Overall summaries.
  const eventTrackIds = [...catalog.periods, ...catalog.archives].map(row => projectPeriod(row).trackId);
  const allTrackIds = [...new Set([...registry, ...eventTrackIds, ...(overall.trackCatalog || []).map(row => row.trackId), ...overall.trackSummaries.map(row => row.trackId), ...Object.keys(previous.tracks)])]
    .filter(id => TRACK_ID.test(id)).sort();
  const cachedTracks = {...previous.tracks};
  for (const id of allTrackIds) {
    const record = cachedTracks[id];
    if (!record?.path) continue;
    try {
      if (record.path !== `tracks/${id}.json`) throw Error('Unexpected cached track path');
      const cached = JSON.parse(await fs.readFile(path.join(directory, record.path), 'utf8'));
      const projected = publicTrackBackup(cached, id);
      if (JSON.stringify(projected) !== JSON.stringify(cached)) throw Error('Cached track is not a public projection');
    } catch {
      cachedTracks[id] = {...record, path: null, missing: false};
      delete cachedTracks[id].checkedAt;
    }
  }
  const selectedTracks = chooseTrackFetches(allTrackIds, [...(overall.trackCatalog || []), ...overall.trackSummaries], cachedTracks,
    PUBLIC_SNAPSHOT_LIMITS.trackFetches, now);
  const trackRows = await mapLimit(selectedTracks, PUBLIC_SNAPSHOT_LIMITS.concurrency, async id => {
    const value = await fetchJson(fetchImpl, `${WORKER}/v1/snapshot/track?trackId=${encodeURIComponent(id)}`, {optional: true});
    const full = value ? await assemble(value, `/v1/snapshot/track/page?trackId=${encodeURIComponent(id)}`) : null;
    return {id, value: full ? publicTrackBackup(full, id) : null};
  });
  const eventRows = await mapLimit(eventFetchIds, PUBLIC_SNAPSHOT_LIMITS.concurrency, async id => {
    const url = id === 'permanent-rolling-hills'
      ? `${WORKER}/v1/events/permanent-rolling-hills/snapshot`
      : `${WORKER}/v1/events/${encodeURIComponent(id)}/snapshot`;
    const value = await fetchJson(fetchImpl, url, {optional: true});
    const full = value ? await assemble(value, url + '/page') : null;
    return {id, value: full ? publicEventBackup(full, id) : null};
  });

  const eventValues = new Map();
  for (const [id, record] of Object.entries(previous.events || {})) {
    if (!EVENT_ID.test(id) || record.path !== `events/${id}.json`) continue;
    try { eventValues.set(id, publicEventBackup(JSON.parse(await fs.readFile(path.join(directory, record.path), 'utf8')), id)); } catch {}
  }
  for (const {id, value} of eventRows) if (value) eventValues.set(id, value);
  const replayCandidates = [], retainedReplays = {};
  const replayEvents = [...eventValues].sort(([a],[b]) => Number(liveIds.has(b)) - Number(liveIds.has(a)));
  for (const [id, value] of replayEvents) {
    if (!TRACK_ID.test(value.period?.trackId || '')) continue;
    for (const entry of value.entries.slice(0, PUBLIC_SNAPSHOT_LIMITS.eventReplaysPerPeriod)) {
      if (!PUBLIC_ACCOUNT_ID.test(entry.accountId || '') || !Number.isSafeInteger(entry.timeMs)) continue;
      if (entry.physicsVerified === false || entry.replayIntegrityVerified === false) continue;
      const relative = `event-replays/${id}/${entry.accountId}.json`, prior = previous.eventReplays?.[relative];
      if (prior?.path === relative && prior.timeMs === entry.timeMs) {
        try {
          const replay = JSON.parse(await fs.readFile(path.join(directory, relative), 'utf8'));
          const projected=publicEventReplayBackup({...replay, verificationStatus:'verified', verified:true, eventRpEligible:true}, {periodId:id, trackId:value.period.trackId, entry});
          if (JSON.stringify(projected) !== JSON.stringify(replay)) throw Error('Replay is not a public projection');
          retainedReplays[relative] = prior; entry.runId = replay.runId; entry.replayHash = replay.replayHash;
          applyReplayDates(entry, replay);
          // Repair legacy live metadata within the existing fetch cap, retaining good bytes on failure.
          const dateCheckAge = now - Number(prior.verdictDateCheckedAt);
          const dateCheckFresh = Number.isSafeInteger(prior.verdictDateCheckedAt) && dateCheckAge >= 0 && dateCheckAge < 7 * 86400000;
          if (!liveIds.has(id) || Number.isSafeInteger(replay.verifiedAt) && replay.verifiedAt > 0 || dateCheckFresh) continue;
        } catch { /* A changed or corrupt replay must be replaced. */ }
      }
      // Frozen history is never a paid fallback during routine publication.
      if(!liveIds.has(id)&&id!=='permanent-rolling-hills'&&!archiveRepairIds.has(id))continue;
      if (replayCandidates.length >= PUBLIC_SNAPSHOT_LIMITS.eventReplayFetches) continue;
      replayCandidates.push({periodId: id, trackId: value.period.trackId, entry});
    }
  }
  const replayRows = await mapLimit(replayCandidates, PUBLIC_SNAPSHOT_LIMITS.concurrency, async candidate => {
    try {
      const url = `${WORKER}/v1/events/${encodeURIComponent(candidate.periodId)}/replays/${encodeURIComponent(candidate.entry.accountId)}`;
      const replay = await fetchJson(fetchImpl, url, {optional: true, maxBytes: PUBLIC_SNAPSHOT_LIMITS.eventReplayResponseBytes});
      return {candidate, value: replay ? publicEventReplayBackup(replay, candidate) : null};
    } catch (error) {
      if (error instanceof PublicBackupDeferredError) throw error;
      return {candidate, value: null};
    }
  });

  const nextTracks = {...cachedTracks}, nextEvents = {...previous.events};
  const pendingWrites = new Map([['overall.json', overall]]);
  let missingTracks = 0, missingEvents = 0;
  const trackSummaryMismatches = [];
  for (const {id, value} of trackRows) {
    if (!value) {
      missingTracks++;
      // A failed fetch must not freshen a retained board or resurrect an invalid path.
      if (nextTracks[id]?.path) nextTracks[id] = {...nextTracks[id], missing: true};
      else nextTracks[id] = {...nextTracks[id], path: null, checkedAt: now, missing: true};
      continue;
    }
    const relative = `tracks/${id}.json`;
    pendingWrites.set(relative, value);
    const summary = overall.trackSummaries.find(row => row.trackId === id);
    if (summary && summary.updatedAt !== value.updatedAt) trackSummaryMismatches.push(id);
    nextTracks[id] = {path: relative, revision: Number(value.revision || value.sourceRevision || 0),
      sourceUpdatedAt: value.updatedAt, updatedAt: value.updatedAt, checkedAt: now};
  }
  for (const {id, value} of eventRows) {
    if (!value) { missingEvents++; continue; }
    const relative = `events/${id}.json`;
    pendingWrites.set(relative, value);
    nextEvents[id] = {path: relative, updatedAt: value.updatedAt, checkedAt: now};
  }
  const eventReplays = {...retainedReplays};
  for (const {candidate, value} of replayRows) {
    if (!value) continue;
    const event = eventValues.get(candidate.periodId);
    const entry = event?.entries.find(row => row.accountId === candidate.entry.accountId && row.timeMs === candidate.entry.timeMs);
    if (!entry) continue;
    entry.replayHash = value.replayHash;
    entry.runId = value.runId;
    applyReplayDates(entry, value);
    const relative = `event-replays/${candidate.periodId}/${candidate.entry.accountId}.json`;
    pendingWrites.set(relative, value);
    eventReplays[relative] = {path: relative, periodId: candidate.periodId, accountId: candidate.entry.accountId,
      timeMs: candidate.entry.timeMs, replayHash: value.replayHash, verdictDateCheckedAt: now};
  }
  // Keep valid historical standings even when the cloud catalog rolls its
  // bounded recent-history window forward. Generate month indexes locally.
  const months = new Map();
  for (const [id, value] of eventValues) {
    pendingWrites.set(`events/${id}.json`, value);
    if (!nextEvents[id]) nextEvents[id] = {path:`events/${id}.json`, updatedAt:value.updatedAt};
    if (value.archived !== true || !value.period) continue;
    const month = new Date(value.period.startsAt).toISOString().slice(0, 7);
    if (!months.has(month)) months.set(month, []);
    months.get(month).push({...value.period, racerCount:value.entries.length});
  }
  for (const [month, periods] of months) pendingWrites.set(`archives/${month}.json`, {updatedAt:Math.max(...periods.map(p => eventValues.get(p.id).updatedAt)), periods:periods.sort((a,b)=>b.startsAt-a.startsAt)});
  let overallResults = {path: null, available: false, reason: planner.reason};
  if (planner.available) {
    pendingWrites.set('overall-results.json', planner.document);
    overallResults = {path: 'overall-results.json', available: true};
  }

  const records = {};
  let tracksChanged = 0, eventsChanged = 0;
  for (const [relative, value] of pendingWrites) {
    const written = await writeJsonIfChanged(directory, relative, value);
    records[relative] = written;
    if (relative.startsWith('tracks/') && written.changed) tracksChanged++;
    if (relative.startsWith('events/') && written.changed) eventsChanged++;
  }
  if (!planner.available) {
    try { await fs.unlink(path.join(directory, 'overall-results.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  const replayPaths = new Set(Object.keys(eventReplays));
  for (const record of Object.values(previous.eventReplays || {})) {
    if (record.path && !replayPaths.has(record.path)) {
      try { await fs.unlink(path.join(directory, record.path)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  const manifest = {schemaVersion: 1, source: 'public-ranked-worker',
    overall: {path: 'overall.json', revision: Number(overall.revision || overall.sourceRevision || 0), updatedAt: overall.updatedAt,
      sha256: records['overall.json'].sha256},
    overallResults, tracks: nextTracks, trackFetchLimit: PUBLIC_SNAPSHOT_LIMITS.trackFetches,
    trackIdsKnown: allTrackIds.length, tracksFetched: trackRows.length, tracksMissing: missingTracks,
    trackBackupsPresent: Object.values(nextTracks).filter(row => row.path).length,
    trackBackupsMissing: Math.max(0, allTrackIds.length - Object.values(nextTracks).filter(row => row.path).length),
    events: nextEvents, eventFetchLimit: PUBLIC_SNAPSHOT_LIMITS.eventFetches, eventIdsFetched: eventRows.length,
    eventsMissing: missingEvents + archivedEventsUnavailable, archivedEventsUnavailable, eventReplays, eventReplayLimit: 30,
    trackSummaryMismatches,
    permanentRollingHills: nextEvents['permanent-rolling-hills'] || null};
  await writeJsonIfChanged(directory, 'manifest.json', manifest);
  log(JSON.stringify({publicSnapshotBackup: {workerRequests: 2 + trackRows.length + eventRows.length + replayCandidates.length + pageFetches, pageFetches,
    trackFetches: trackRows.length, tracksChanged, tracksMissing: missingTracks,
    eventFetches: eventRows.length, archivedEventsReused, archivedEventsUnavailable, eventsChanged, eventsMissing: missingEvents,
    ...(adminCapture ? {adminArchiveCapture:adminCapture.stats()} : {}),
    eventReplayCandidates: replayCandidates.length, eventReplays: Object.keys(eventReplays).length,
    plannerAvailable: planner.available, plannerReason: planner.reason}}));
  return manifest;
}

export async function runPublicSnapshotBackup(options = {}) {
  try { return await capturePublicSnapshotBackup(options); }
  catch (error) {
    if (!(error instanceof PublicBackupDeferredError)) throw error;
    const result = {deferred: true, reason: error.message, status: error.status, previousBackupsPreserved: true};
    (options.log || console.log)(JSON.stringify({publicSnapshotBackup: result}));
    return result;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await runPublicSnapshotBackup();
