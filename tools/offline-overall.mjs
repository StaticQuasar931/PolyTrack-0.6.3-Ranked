import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {computeOverall, packPlannerResults, rankTrustedTrackEntries, trackWeightParts} from '../workers/ranked/src/index.js';
import {publicOverallBackup} from './public-snapshot-backup.mjs';
import {createOverallProjectionBundle, decodeProjectionResults} from './overall-projection-bundle.mjs';

const MODEL = {algorithmVersion: 'participation-v8-s1', schemaVersion: 6};
const ID = /^[a-f0-9]{64}$/;
const count = n => Number.isSafeInteger(n) && n >= 0;
const positive = n => count(n) && n > 0;
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const digest = v => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const pick = (v, keys) => Object.fromEntries(keys.filter(k => v[k] !== undefined).map(k => [k, v[k]]));
const IDENTITY = ['name', 'countryCode', 'carId', 'carColors', 'carStyle', 'profileCosmetics', 'identityUpdatedAt', 'badges', 'cosmeticUnlocks'];
const NUMBERS = ['pbAt', 'pbCount', 'totalPlaytimeMs', 'accountCreatedAt', 'identityUpdatedAt'];
const COMPANION_LIMIT = 2 * 1024 * 1024;
const OVERALL_LIMIT = 16 * 1024 * 1024;
const INFLATE_LIMIT = 6 * 1024 * 1024;
const BASE64_LIMIT = 1400000;
const SCORING_DIGEST = digest([MODEL, String(computeOverall), String(rankTrustedTrackEntries), String(trackWeightParts), String(packPlannerResults)]);

function artifactBudget(name, value) {
  // Match applyCapturedOverallProjection: Overall is paged by the packager;
  // companions are not. Include its serialized trailing newline in every bound.
  const bytes = Buffer.byteLength(JSON.stringify(value) + '\n');
  const limit = name === 'overall.json' ? OVERALL_LIMIT : COMPANION_LIMIT;
  if (bytes > limit) throw Error(`${name} exceeds ${limit / 1024 / 1024} MB artifact budget (${bytes} bytes)`);
  return bytes;
}

// The sanitizer's legacy direct-board cap is 200. Sanitize every row in bounded
// chunks without inventing pagination manifests or trimming the assembled board.
function sanitizeOverall(value) {
  if (!Array.isArray(value?.entries) || value.entries.length <= 200) return publicOverallBackup(value);
  if (value.entries.length > 10000) throw Error('Invalid baseline entries limit');
  if (value.totalEntries !== value.entries.length || value.complete !== true && value.sourceComplete !== true ||
      value.pagination && (value.pagination.version !== 1 || !ID.test(value.pagination.generation) ||
        value.pagination.complete !== true || value.pagination.pageSize !== 100 ||
        value.pagination.totalEntries !== value.entries.length || value.pagination.pageCount !== Math.ceil(value.entries.length / 100))) throw Error('Incomplete large Overall source');
  const projected = publicOverallBackup({...value, entries: value.entries.slice(0, 200)});
  for (let offset = 200; offset < value.entries.length; offset += 200) {
    projected.snapshot.entries.push(...publicOverallBackup({...value, entries: value.entries.slice(offset, offset + 200)}).snapshot.entries);
  }
  return projected;
}

async function packOfflineResults(entries, snapshot, options) {
  // Preserve the authoritative packer's exact bytes and metadata for small boards.
  if (entries.length <= 200) return packPlannerResults(entries, snapshot, options);
  const chunks = [];
  let metadata;
  for (let offset = 0; offset < entries.length; offset += 200) {
    const rows = entries.slice(offset, offset + 200);
    const packed = await packPlannerResults(rows, {...snapshot, entries: rows}, options);
    if (!packed.resultBundleComplete) throw Error('Incomplete authoritative planner chunk: ' + packed.resultBundleStatus);
    metadata ??= packed;
    chunks.push(await decodeProjectionResults(packed));
  }
  const resultTracks = [...new Set(chunks.flatMap(chunk => chunk.resultTracks))].sort();
  if (resultTracks.length > options.boardLimit) throw Error('Merged planner track limit exceeded');
  const indices = new Map(resultTracks.map((id, index) => [id, index]));
  const users = new Set();
  const merged = chunks.flatMap(chunk => chunk.entries.map(row => {
    if (users.has(row.userId)) throw Error('Duplicate merged planner user');
    users.add(row.userId);
    const samples = JSON.parse(row.resultData).map(tuple => {
      if (!Array.isArray(tuple) || tuple.length !== 7 || !count(tuple[0]) || tuple[0] >= chunk.resultTracks.length) throw Error('Invalid chunk track index');
      return [indices.get(chunk.resultTracks[tuple[0]]), ...tuple.slice(1)];
    }).sort((a, b) => a[0] - b[0]);
    return {...row, resultData: JSON.stringify(samples)};
  }));
  if (merged.length !== entries.length) throw Error('Incomplete merged planner results');
  const plain = Buffer.from(JSON.stringify({resultTracks, entries: merged}));
  if (plain.length > INFLATE_LIMIT) throw Error('Merged planner exceeds 6 MB inflate budget');
  const resultBundle = gzipSync(plain).toString('base64');
  if (resultBundle.length > BASE64_LIMIT) throw Error('Merged planner exceeds 1.4M base64 budget');
  return {...metadata, resultBundleStatus: 'complete', resultBundle};
}

function model(value) {
  if (value?.algorithmVersion !== MODEL.algorithmVersion || value.schemaVersion !== MODEL.schemaVersion) throw Error('Unsupported scoring version');
}
function publicOnly(value) {
  if (value?.localPending === true || value?.calculationExact === false || value?.estimated === true ||
      value?.overallProjection === true || value?.localEstimate === true || value?._dataSource === 'local' ||
      value?.source === 'client-local' || value?.source === 'local-estimate' ||
      value?.kind === 'scoped-snapshot-v1') throw Error('Client/local estimate is not a trusted public source');
}
function identity(row) {
  const projected = publicOverallBackup({updatedAt: 0, entries: [row], trackSummaries: []}).snapshot.entries[0];
  const result = pick(projected, IDENTITY);
  for (const key of ['name', 'countryCode', 'carId', 'carColors', 'carStyle']) {
    if (result[key] != null && typeof result[key] !== 'string') throw Error('Invalid public identity metadata');
  }
  if (result.profileCosmetics) {
    for (const value of Object.values(result.profileCosmetics)) {
      if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) throw Error('Invalid cosmetic metadata');
    }
  }
  return result;
}

/** Caller supplies already trusted PUBLIC captures, not verification claims from a client.
 * This function performs no I/O and does not establish backend publication or verification.
 * now is a positive millisecond timestamp (or a function returning one).
 */
export async function buildOfflineOverall({tracks, previousOverall, previousCalculation = null, expectedTrackIds, now} = {}) {
  now = typeof now === 'function' ? now() : now;
  if (!positive(now)) throw Error('Invalid calculation time');
  model(previousOverall); publicOnly(previousOverall);
  sanitizeOverall(previousOverall);
  if (!positive(previousOverall.sourceRevision) || !positive(previousOverall.updatedAt) ||
      previousOverall.builtRevision !== previousOverall.sourceRevision) throw Error('Invalid baseline source binding');
  if (!Array.isArray(expectedTrackIds) || !expectedTrackIds.length || expectedTrackIds.length > 500 ||
      expectedTrackIds.some(id => !ID.test(id)) || new Set(expectedTrackIds).size !== expectedTrackIds.length) throw Error('Invalid expected track catalog');
  const expected = new Set(expectedTrackIds);
  for (const row of previousOverall.trackCatalog || []) if (!expected.has(row.trackId)) throw Error('Missing expected known track');
  if (!Array.isArray(tracks) || tracks.length !== expected.size || tracks.length > 500) throw Error('Missing or incomplete track boards');
  if (!Array.isArray(previousOverall.entries) || previousOverall.entries.length > 10000) throw Error('Invalid baseline entries limit');
  const priorIds = new Set();
  const prior = previousOverall.entries.map(row => {
    publicOnly(row);
    if (!ID.test(row?.userId) || priorIds.has(row.userId) || !count(row.rank) || !Number.isFinite(row.score) || row.score < 0 ||
        ['movementAt', 'rankSince', 'latestPbAt', 'identityUpdatedAt'].some(k => row[k] !== undefined && !count(row[k]))) throw Error('Invalid baseline row metadata');
    priorIds.add(row.userId);
    return {...pick(row, ['userId', 'rank', 'score', 'movementAt', 'rankSince', 'latestPbAt']), ...identity(row)};
  }).sort((a, b) => a.userId.localeCompare(b.userId));
  const seen = new Set(); let totalRows = 0;
  const sourceBoards = tracks.map(board => {
    model(board); publicOnly(board);
    if (!ID.test(board.trackId) || !expected.has(board.trackId) || seen.has(board.trackId)) throw Error('Duplicate or unexpected track board');
    seen.add(board.trackId);
    if (!positive(board.sourceRevision) || !count(board.updatedAt) ||
        board.revision !== undefined && board.revision !== board.sourceRevision ||
        board.builtRevision !== undefined && board.builtRevision !== board.sourceRevision) throw Error('Invalid track source binding');
    if ((board.complete !== true && board.sourceComplete !== true) || board.complete === false || board.sourceComplete === false ||
        board.totalEntriesExact === false || board.ranksExact === false || !Array.isArray(board.entries) ||
        board.totalEntries !== board.entries.length || board.entries.length > 10000 || (totalRows += board.entries.length) > 100000 ||
        board.pagination && (board.pagination.complete !== true || board.pagination.totalEntries !== board.entries.length)) throw Error('Incomplete track board or absurd row limit');
    const accounts = new Set();
    const entries = board.entries.map(row => {
      publicOnly(row);
      const accountId = row?.accountId || row?.userId;
      if (!ID.test(accountId) || accounts.has(accountId) || row.userId && row.userId !== accountId || row.trackId && row.trackId !== board.trackId ||
          !positive(row.timeMs) || row.timeMs > 36000000 || typeof row.runVerified !== 'boolean' || typeof row.integrityVerified !== 'boolean' ||
          !Number.isFinite(row.weight) || row.weight < 0 || row.weight > 100 ||
          NUMBERS.some(k => row[k] !== undefined && !count(row[k])) ||
          ['rank', 'position', 'fieldSize'].some(k => row[k] !== undefined && (!positive(row[k]) || row[k] > board.entries.length)) ||
          row.competition !== undefined && (!Number.isFinite(row.competition) || row.competition <= 0 || row.competition > 100)) throw Error('Invalid track row metadata');
      accounts.add(accountId);
      const held = row.unranked === true || row.verified === false || row.verifiedState === 0 ||
        ['held', 'changed', 'pending', 'rejected', 'unverified'].some(s => [row.verificationStatus, row.validationState].includes(s));
      return {accountId, trackId: board.trackId, timeMs: row.timeMs, weight: row.weight,
        ...pick(row, ['rank', 'position', 'fieldSize', 'competition', 'timingVersion', 'verified', 'verifiedState', 'unranked', 'verificationStatus', 'validationState']),
        runVerified: row.runVerified && !held, integrityVerified: row.integrityVerified,
        ...Object.fromEntries(NUMBERS.map(k => [k, row[k] ?? 0])), ...identity({...row, userId: accountId})};
    }).sort((a, b) => a.timeMs - b.timeMs || a.accountId.localeCompare(b.accountId));
    const ranked = rankTrustedTrackEntries(entries, board.trackId);
    for (let i = 0; i < entries.length; i++) {
      for (const key of ['rank', 'position', 'fieldSize', 'weight', 'competition', 'timingVersion']) {
        if (entries[i][key] !== undefined && entries[i][key] !== ranked[i][key]) throw Error('Invalid track rank/weight metadata');
      }
    }
    return {...MODEL, trackId: board.trackId, sourceRevision: board.sourceRevision, updatedAt: board.updatedAt,
      complete: true, sourceComplete: true, totalEntries: entries.length, entries};
  }).sort((a, b) => a.trackId.localeCompare(b.trackId));
  const inputDigest = digest({scoringDigest: SCORING_DIGEST, sourceBoards, prior, expectedTrackIds: [...expected].sort()});
  if (previousCalculation !== null) model(previousCalculation);
  if (previousCalculation !== null && (previousCalculation.version !== 1 || previousCalculation.source !== 'snapshot-computed-overall' ||
      !ID.test(previousCalculation.inputDigest) || !ID.test(previousCalculation.scoringDigest) ||
      !positive(previousCalculation.revision) || !positive(previousCalculation.updatedAt) || !positive(previousCalculation.backendRevision))) throw Error('Invalid previous calculation receipt');
  const unchanged = previousCalculation?.inputDigest === inputDigest && previousCalculation.scoringDigest === SCORING_DIGEST &&
    previousCalculation.backendRevision === previousOverall.sourceRevision;
  const revision = unchanged ? previousCalculation.revision : Math.max(previousOverall.sourceRevision, (previousCalculation?.revision ?? 0) + 1);
  const updatedAt = unchanged ? previousCalculation.updatedAt : now;
  if (!positive(revision) || revision < previousOverall.sourceRevision) throw Error('Invalid or exhausted calculation revision');
  const boards = sourceBoards.map(board => {
    const entries = rankTrustedTrackEntries(board.entries.filter(row => row.runVerified && row.integrityVerified), board.trackId);
    return {...board, totalEntries: entries.length, totalEntriesExact: true, entries};
  });
  const entries = computeOverall(boards, prior, new Set(), {includePlannerResults: true});
  if (!entries.length) throw Error('Empty Overall cannot pass projection baseline validation');
  if (entries.length > 10000) throw Error('Overall exceeds 10000 users');
  const previous = new Map(prior.map(row => [row.userId, row]));
  for (const row of entries) {
    const before = previous.get(row.userId);
    row.movementAt = row.movement ? updatedAt : before?.movementAt ?? 0;
    row.rankSince = before?.rank === row.rank ? before.rankSince || updatedAt : updatedAt;
    if (before) Object.assign(row, pick(before, IDENTITY));
  }
  const metadata = {...MODEL, sourceRevision: revision, builtRevision: revision, revision, updatedAt, builtAt: updatedAt};
  const raw = {...metadata, entries, trackSummaries: [], trackCatalog: boards.map(b => ({trackId: b.trackId, updatedAt: b.updatedAt})),
    complete: true, sourceComplete: true, totalEntriesExact: true, totalEntries: entries.length, publishedEntries: entries.length,
    entryLimit: entries.length <= 200 ? 200 : 10000, trackLimit: 500, averagePlacementVersion: 2};
  const packed = await packOfflineResults(entries, raw, {boardCount: boards.length, boardLimit: 500, boardLimitReached: false});
  if (!packed.resultBundleComplete) throw Error('Incomplete authoritative planner bundle: ' + packed.resultBundleStatus);
  const {snapshot: overall, planner} = sanitizeOverall({...raw, ...packed});
  Object.assign(overall, {ranksExact: true, catalogComplete: true, trackCatalogComplete: true});
  if (!planner.available) throw Error('Public planner sanitizer rejected results');
  const results = {...planner.document, schemaVersion: MODEL.schemaVersion};
  if (results.resultBundle.length > BASE64_LIMIT) throw Error('Planner exceeds 1.4M base64 budget');
  await decodeProjectionResults(results);
  const artifactBytes = {'overall.json': artifactBudget('overall.json', overall),
    'overall-results.json': artifactBudget('overall-results.json', results)};
  const bundle = await createOverallProjectionBundle({overall, results, tracks: boards});
  artifactBytes['projection-source.json'] = artifactBudget('projection-source.json', bundle);
  const calculation = {version: 1, source: 'snapshot-computed-overall', ...MODEL, scoringDigest: SCORING_DIGEST,
    inputDigest, sourceFingerprint: inputDigest, revision, sourceRevision: revision, updatedAt, backendRevision: previousOverall.sourceRevision};
  return {files: new Map([['overall.json', overall], ['overall-results.json', results], ['projection-source.json', bundle]]), calculation,
    report: {source: 'snapshot-computed-overall', firestorePublished: false, backendRevision: previousOverall.sourceRevision,
      revision, updatedAt, unchanged, complete: true, catalogComplete: true, ranksExact: true, totalEntries: entries.length,
      boardCount: boards.length, sourceRows: totalRows, trustedRows: boards.reduce((n, b) => n + b.entries.length, 0),
      artifactBytes, projectionReady: true, networkRequests: 0, writes: 0}};
}
