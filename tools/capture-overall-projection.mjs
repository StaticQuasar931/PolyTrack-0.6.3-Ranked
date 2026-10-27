import {createHash, createPrivateKey, sign} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {decode} from './verifier/firestore.mjs';
import {publicOverallBackup, authenticatedOverallTrackBackup, publicTrackConfirmationDigest} from './public-snapshot-backup.mjs';
import {PublicBackupDeferredError} from './public-backup-fetch.mjs';
import {assemblePublishedSnapshotPages} from './published-snapshot-pages.mjs';
import {unpackOverallDetails} from '../workers/ranked/src/overall-details.js';
import {decodePublicationPage, publicationPageId} from '../workers/ranked/src/paged-publication.js';
import {decodeSourcePublication, sourcePublicationIds} from '../workers/ranked/src/overall-source-publication.js';
import {sourceCatalogIsReady, sourceBinding} from '../workers/ranked/src/overall-source-cache.js';
import {createOverallProjectionBundle} from './overall-projection-bundle.mjs';

const BASE = 'https://firestore.googleapis.com/v1/projects/polytrack-052/databases/(default)/documents';
const DOCUMENTS = BASE.slice('https://firestore.googleapis.com/v1/'.length) + '/';
const OAUTH = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/datastore';
const META = '0.6.2_s1_release_meta/current';
const OVERALL = '0.6.2_s1_leaderboards_overall/main';
const RESULTS = '0.6.2_s1_leaderboards_overall/main_results';
const SOURCE_SCOPE = BASE + '/0.6.2_s1_leaderboards_track/overall-bundle-loader-v1';
const MAX_PAGES = 100;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function micros(value) {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?Z$/.exec(value || '');
  const ms = match && Date.parse(match[1] + 'Z');
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== match[1]) throw Error('Invalid Overall capture timestamp');
  return BigInt(ms) * 1000n + BigInt((match[2] || '').padEnd(6, '0'));
}

function validateRequest(url, options) {
  const denied = () => {throw Error('Overall capture request outside named read boundary');};
  if (url !== BASE + ':batchGet' || options?.method !== 'POST' ||
      typeof options.body !== 'string' || Buffer.byteLength(options.body) > 4096) denied();
  let body;
  try { body = JSON.parse(options.body); } catch { denied(); }
  const headers = new Headers(options.headers);
  if ([...headers].some(([key, value]) => key !== 'content-type' || value !== 'application/json')) denied();
  if (!Array.isArray(body?.documents) || body.documents.length !== 1 || typeof body.documents[0] !== 'string') denied();
  const name = body.documents[0];
  if (!name.startsWith(DOCUMENTS)) denied();
  const relative = name.slice(DOCUMENTS.length);
  if (![META, OVERALL, RESULTS].includes(relative) &&
      !/^0\.6\.2_s1_overall_sources\/main_[0-3]$/.test(relative) &&
      !/^0\.6\.2_s1_public_pages\/overall_main_[a-f0-9]{64}_(?:[0-9]|[1-9][0-9])$/.test(relative)) denied();
  if (relative !== META && !body.readTime) denied();
  if (body.readTime) micros(body.readTime);
  if (!isDeepStrictEqual(body, {documents: [name], ...(body.readTime ? {readTime: body.readTime} : {})})) denied();
}

// Same service-account JWT/OAuth implementation as the existing snapshot exporter,
// with a separate exact-document read boundary, no queries, writes or public fallback.
function safeTransportError(error) {
  // Never propagate transport diagnostics that could contain headers or assertions.
  if (['AbortError', 'TimeoutError'].includes(error?.name)) return new DOMException('Overall capture request interrupted', error.name);
  if (error instanceof TypeError && ['fetch failed', 'terminated'].includes(error.message)) return new TypeError(error.message);
  return Error('Overall capture transport failed');
}

export function createOverallCaptureFetch({fetchImpl = fetch, oauthFetch = fetchImpl,
  serviceAccount = process.env.FIREBASE_VERIFIER_SERVICE_ACCOUNT, now = Date.now} = {}) {
  let account, key, token, expiresAt = 0, pending;
  async function issue() {
    if (!serviceAccount) throw Error('Overall capture authentication required: FIREBASE_VERIFIER_SERVICE_ACCOUNT is missing; use --offline for local packaging');
    try {
      if (!account) {
        account = typeof serviceAccount === 'string' ? JSON.parse(serviceAccount) : serviceAccount;
        if (account?.type !== 'service_account' || account.project_id !== 'polytrack-052' ||
            typeof account.client_email !== 'string' || !/^[a-zA-Z0-9._-]+@polytrack-052\.iam\.gserviceaccount\.com$/.test(account.client_email) ||
            typeof account.private_key !== 'string') throw Error();
        key = createPrivateKey(account.private_key);
        if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048) throw Error();
      }
      if (!key) throw Error();
    } catch { throw Error('Invalid snapshot export service-account credential'); }
    const issuedAt = Math.floor(now() / 1000);
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = encode({alg: 'RS256', typ: 'JWT'}) + '.' + encode({iss: account.client_email,
      scope: SCOPE, aud: OAUTH, iat: issuedAt, exp: issuedAt + 3600});
    let assertion;
    try { assertion = unsigned + '.' + sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url'); }
    catch { throw Error('Overall capture credential signing failed'); }
    let response, payload;
    try {
      response = await oauthFetch(OAUTH, {method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
        headers: {'content-type': 'application/x-www-form-urlencoded'},
        body: new URLSearchParams({grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion}).toString()});
      if (!response?.ok) throw Error();
      const text = await response.text();
      if (Buffer.byteLength(text) > 16384) throw Error();
      payload = JSON.parse(text);
      if (payload.token_type !== 'Bearer' || typeof payload.access_token !== 'string' ||
          !/^[A-Za-z0-9._~+/-]{1,8192}={0,2}$/.test(payload.access_token) ||
          !Number.isSafeInteger(payload.expires_in) || payload.expires_in <= 60 || payload.expires_in > 3600) throw Error();
    } catch { throw Error('Overall capture OAuth authentication failed; no public fallback attempted'); }
    token = payload.access_token;
    expiresAt = issuedAt * 1000 + payload.expires_in * 1000;
  }
  return async (url, options) => {
    validateRequest(url, options);
    const body = options.body, signal = options.signal ?? AbortSignal.timeout(12000);
    const headers = new Headers(options.headers);
    if (!token || now() >= expiresAt - 60000) {
      pending ||= issue().finally(() => {pending = undefined;});
      await pending;
    }
    headers.set('authorization', 'Bearer ' + token);
    let response;
    try {
      // Construct options explicitly. No caller credentials, redirect mode, or URL can escape.
      response = await fetchImpl(url, {method: 'POST', body, headers, redirect: 'error', signal});
    } catch (error) { throw safeTransportError(error); }
    if ([401, 403].includes(response.status)) {
      token = undefined; expiresAt = 0;
      throw Error('Overall capture authentication required or read permission denied (' + response.status + '); no public fallback attempted');
    }
    return {ok: response.ok, status: response.status, text: async () => {
      try { return await response.text(); } catch (error) { throw safeTransportError(error); }
    }};
  };
}


export async function frozenOverallSource({meta, overall, results, documents, now = Date.now(),
  confirmationAt = null, confirmedTracks = null}) {
  const marker = meta?.sourceBundle;
  if (!Number.isSafeInteger(overall?.builtRevision) || overall.builtRevision < 1 ||
      overall.sourceRevision !== overall.builtRevision || meta.builtRevision !== overall.builtRevision ||
      meta.lastOverallBuildAt !== overall.updatedAt || marker?.scopeHash !== digest(SOURCE_SCOPE) ||
      !Number.isSafeInteger(marker.createdAt) || marker.createdAt > now || !sourcePublicationIds(marker).length)
    throw Error('FROZEN_OVERALL_SOURCE_UNAVAILABLE_OR_STALE');
  for (const key of ['sourceRevision', 'builtRevision', 'updatedAt', 'algorithmVersion'])
    if (results?.[key] !== overall[key]) throw Error('RESULT_BUNDLE_SOURCE_MISMATCH');
  if (results.resultBundleComplete !== true || !Array.isArray(overall.trackCatalog)) throw Error('INCOMPLETE_OVERALL_SOURCE');
  const envelope = JSON.parse(await decodeSourcePublication(marker, documents));
  const payload = envelope?.payload;
  if (envelope.version !== 1 || payload?.version !== 1 || payload.scopeHash !== marker.scopeHash ||
      payload.createdAt !== marker.createdAt || digest(payload) !== marker.digest ||
      digest(payload.catalog) !== marker.catalogHash || !sourceCatalogIsReady(payload.catalog) ||
      !payload.boards || typeof payload.boards !== 'object' || Array.isArray(payload.boards)) throw Error('FROZEN_SOURCE_DIGEST_MISMATCH');
  const ids = Object.keys(payload.catalog.tracks);
  if (Object.keys(payload.boards).length !== ids.length) throw Error('FROZEN_SOURCE_CATALOG_MISMATCH');
  for (const id of ids) {
    const board = payload.boards[id], binding = payload.catalog.tracks[id];
    if (!board || !Array.isArray(board.entries) || board.trackId !== undefined && board.trackId !== id ||
        board.complete !== true && board.sourceComplete !== true || board.totalEntries !== board.entries.length)
      throw Error('FROZEN_BOARD_INCOMPLETE');
    if (!Object.hasOwn(binding, 'updateTime') && digest(sourceBinding({id, data: board}, {newWrite: true})) !== digest(binding))
      throw Error('FROZEN_BOARD_BINDING_MISMATCH');
  }
  const seen = new Set(), boards = [];
  for (const row of overall.trackCatalog) {
    const board = payload.boards[row?.trackId];
    if (!/^[a-f0-9]{64}$/.test(row?.trackId || '') || seen.has(row.trackId) || !board ||
        row.updatedAt !== (board.updatedAt ?? board.builtAt ?? 0)) throw Error('FROZEN_TRACK_CATALOG_MISMATCH');
    seen.add(row.trackId); boards.push([board, row.trackId]);
  }
  if (ids.filter(id => /^[a-f0-9]{64}$/.test(id)).length !== boards.length) throw Error('FROZEN_TRACK_CATALOG_MISMATCH');
  const normalized = boards.map(([board, trackId]) => authenticatedOverallTrackBackup(board, trackId));
  // Compare CURRENT metadata to the authenticated frozen binding, not the
  // historical Overall trackCatalog. Never publish the private binding itself.
  if (confirmedTracks instanceof Map && Number.isSafeInteger(confirmationAt) && confirmationAt > 0 &&
      sourceCatalogIsReady(meta.sourceCatalog) && meta.sourceCatalog.scannedAt <= confirmationAt) {
    for (const board of normalized) {
      const id = board.trackId;
      if (isDeepStrictEqual(meta.sourceCatalog.tracks[id], payload.catalog.tracks[id]) && board.updatedAt <= confirmationAt)
        confirmedTracks.set(id, {sha256: publicTrackConfirmationDigest(board, id),
          updatedAt: board.updatedAt, checkedAt: confirmationAt});
    }
  }
  return normalized;
}

// Public files and separate in-memory digest confirmations; private bindings never
// leave this capture. The caller publishes files, not the confirmation Map.
export async function captureOverallProjection({fetchImpl, auth = {}, minimumCommitTime,
  maxReads = 107, now = Date.now, buildBundle = createOverallProjectionBundle, onRead = () => {}} = {}) {
  if (!Number.isSafeInteger(maxReads) || maxReads < 3 || maxReads > 107) throw Error('Invalid Overall capture read budget');
  const transport = fetchImpl || createOverallCaptureFetch(auth);
  let readTime, reads = 0, halted = false;
  const read = async (relative, {optional = false} = {}) => {
    if (halted || reads >= maxReads) throw Error('Overall capture stopped or read budget exhausted');
    const body = {documents: [DOCUMENTS + relative], ...(readTime ? {readTime} : {})};
    const options = {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)};
    validateRequest(BASE + ':batchGet', options);
    // Charge before transport, including failed/missing attempts. Never retry.
    reads++; await onRead({estimatedReads: reads, document: relative});
    let response;
    try {
      response = await transport(BASE + ':batchGet', options);
      if ([408, 429, 500, 502, 503, 504].includes(response.status))
        throw new PublicBackupDeferredError('Overall capture unavailable; no retry or public fallback', response.status);
      if (optional && response.status === 404) return null;
      if (!response.ok) throw Error('Overall capture document read failed (' + response.status + ')');
      const text = await response.text();
      if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw Error('Overall capture response exceeds byte limit');
      const rows = JSON.parse(text);
      if (!Array.isArray(rows) || rows.length !== 1) throw Error('Invalid Overall batchGet response');
      const row = rows[0];
      if (optional && row.missing === DOCUMENTS + relative && micros(row.readTime) === micros(readTime)) return null;
      if (!row.found || row.found.name !== DOCUMENTS + relative || !row.found.fields) throw Error('Missing or mismatched Overall capture document');
      const point = micros(row.readTime);
      if (readTime && point !== micros(readTime) || micros(row.found.updateTime) > point) throw Error('Overall capture read-time mismatch');
      if (!readTime) {
        readTime = row.readTime;
        if (minimumCommitTime && point < micros(minimumCommitTime)) throw Error('Overall capture precedes verifier handoff');
      }
      return decode({mapValue: {fields: row.found.fields}});
    } catch (error) { halted = true; throw error; }
  };
  const meta = await read(META);
  let overall = await unpackOverallDetails(await read(OVERALL));
  const usesSidecar = overall.resultBundleLocation === 'main_results';
  const boundResults = usesSidecar ? await read(RESULTS) : null;
  const rootReads = reads;
  const results = usesSidecar ? boundResults : overall;
  for (const key of ['sourceRevision', 'builtRevision', 'updatedAt', 'algorithmVersion'])
    if (results?.[key] !== overall[key]) throw Error('RESULT_BUNDLE_SOURCE_MISMATCH');
  if (meta.builtRevision !== overall.builtRevision || meta.lastOverallBuildAt !== overall.updatedAt ||
      overall.sourceRevision !== overall.builtRevision) throw Error('OVERALL_METADATA_BINDING_MISMATCH');
  const parts = new Map();
  const partIds = sourcePublicationIds(meta.sourceBundle);
  for (const id of partIds) {
    const data = await read('0.6.2_s1_overall_sources/' + id, {optional: true});
    if (data) parts.set(id, {data});
  }
  overall = await assemblePublishedSnapshotPages(overall, {maxPages: MAX_PAGES, fetchPage: async (page, generation) =>
    decodePublicationPage(await read('0.6.2_s1_public_pages/' + publicationPageId('overall', 'main', generation, page)))});
  // Immutable page metadata must still agree with the selected root/result source.
  for (const key of ['sourceRevision', 'builtRevision', 'updatedAt', 'algorithmVersion'])
    if (results?.[key] !== overall[key]) throw Error('RESULT_BUNDLE_SOURCE_MISMATCH');
  const rawPublic = {...overall, ...Object.fromEntries(Object.entries(results).filter(([key]) => key.startsWith('result')))};
  const projected = publicOverallBackup(rawPublic);
  if (!projected.planner.available) throw Error('Published Overall results unavailable');
  const files = new Map([['overall.json', projected.snapshot], ['overall-results.json', projected.planner.document]]);
  let projectionReady = false, projectionReason = null, projectionFailureStage = null, projectionFailureCode = null;
  const confirmedTracks = new Map(), capturedTracks = new Map();
  try {
    projectionFailureStage = 'frozen-source';
    const tracks = await frozenOverallSource({meta, overall, results, documents: parts, now: now(),
      confirmationAt: Date.parse(readTime), confirmedTracks});
    projectionFailureStage = 'baseline';
    const bundle = await buildBundle({overall: projected.snapshot, results: projected.planner.document, tracks});
    files.set('projection-source.json', bundle); projectionReady = true; projectionFailureStage = null;
    for(const board of tracks)capturedTracks.set(board.trackId,board);
  } catch (error) {
    const message = typeof error?.message === 'string' ? error.message : '';
    const sourceCodes = ['FROZEN_OVERALL_SOURCE_UNAVAILABLE_OR_STALE', 'RESULT_BUNDLE_SOURCE_MISMATCH', 'INCOMPLETE_OVERALL_SOURCE', 'FROZEN_SOURCE_DIGEST_MISMATCH', 'FROZEN_SOURCE_CATALOG_MISMATCH', 'FROZEN_BOARD_INCOMPLETE', 'FROZEN_BOARD_BINDING_MISMATCH', 'FROZEN_TRACK_CATALOG_MISMATCH', 'OVERALL_SOURCE_PUBLICATION_INVALID', 'OVERALL_SOURCE_PUBLICATION_INFLATE_LIMIT'];
    const bundleCodes = new Map([['Invalid authenticated Overall track snapshot', 'AUTHENTICATED_TRACK_INVALID'], ['Invalid Overall projection source', 'PROJECTION_SOURCE_INVALID'], ['Duplicate Overall projection source', 'PROJECTION_SOURCE_DUPLICATE'], ['Invalid Overall projection board', 'PROJECTION_BOARD_INVALID'], ['Invalid Overall projection row', 'PROJECTION_ROW_INVALID'], ['Incomplete Overall source board', 'PROJECTION_BOARD_INCOMPLETE'], ['Missing bound Overall source boards', 'PROJECTION_BOARDS_MISSING'], ['Overall projection source exceeds snapshot file limit', 'PROJECTION_SOURCE_TOO_LARGE'], ['Invalid projection result bundle', 'PROJECTION_RESULTS_INVALID'], ['Invalid decoded projection results', 'PROJECTION_RESULTS_INVALID'], ['Projection results too large', 'PROJECTION_RESULTS_TOO_LARGE']]);
    const baselineCodes = ['invalid_account', 'invalid_generation', 'generation_mismatch', 'unsupported_model', 'result_binding_mismatch', 'incomplete_overall', 'incomplete_track_catalog', 'incomplete_track_bindings', 'invalid_track_bindings', 'invalid_results', 'invalid_track_catalog', 'track_binding_mismatch', 'unsupported_track', 'incomplete_track', 'invalid_track_rows', 'track_weight_mismatch', 'baseline_mismatch'];
    const baselineCode = message.startsWith('Overall projection baseline mismatch: ') ? message.slice('Overall projection baseline mismatch: '.length) : '';
    projectionFailureCode = sourceCodes.includes(message) ? message : bundleCodes.get(message) || (baselineCodes.includes(baselineCode) ? baselineCode : 'unclassified');
    // Published scores remain accurate even when a coherent local projection is unavailable.
    projectionReason = 'bound-source-or-baseline-unavailable';
  }
  return {files, confirmedTracks, capturedTracks, report: {readTime, estimatedReads: reads, httpRequests: reads, maxReads,
    rootDocuments: rootReads, resultSource: usesSidecar ? 'main_results' : 'inline',
    rootAndSourceReadLimit: rootReads + 4, generationPages: reads - rootReads - partIds.length, projectionReady, projectionReason,
    projectionFailureStage, projectionFailureCode,
    publishedRevision: overall.builtRevision, metadataDirty: meta.dirty === true,
    source: 'authenticated-published-overall', freshness: 'last-published-not-a-rebuild'}};
}

// Reuse the already authenticated, fully assembled public root without a second Worker/page read.
export function overallCaptureForBackup(capture) {
  const overall=capture?.files?.get?.('overall.json'),results=capture?.files?.get?.('overall-results.json');
  if(!overall||!results)throw Error('Missing captured public Overall files');
  for(const key of ['sourceRevision','builtRevision','updatedAt','algorithmVersion'])
    if(results[key]!==overall[key])throw Error('Captured public Overall binding mismatch');
  const value={...overall,...Object.fromEntries(Object.entries(results).filter(([key])=>key.startsWith('result')))};
  if(!publicOverallBackup(value).planner.available)throw Error('Captured public Overall results unavailable');
  return value;
}

export async function applyCapturedOverallProjection({directory, capture}) {
  if (!(capture?.files instanceof Map) || !capture.files.has('overall.json') || !capture.files.has('overall-results.json') ||
      capture.report?.projectionReady !== capture.files.has('projection-source.json') ||
      [...capture.files.keys()].some(name => !['overall.json', 'overall-results.json', 'projection-source.json'].includes(name)))
    throw Error('Invalid Overall capture application');
  const serialized = new Map([...capture.files].map(([name, value]) => [name, JSON.stringify(value) + '\n']));
  // Overall is paged by the packager; the compact companion files are not.
  if ([...serialized].some(([name,text]) => Buffer.byteLength(text) > (name==='overall.json'?16:2) * 1024 * 1024)) throw Error('Overall public file too large');
  const manifestPath = path.join(directory, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  for (const [name, bytes] of serialized) await fs.writeFile(path.join(directory, name), bytes);
  if (!capture.report.projectionReady) await fs.unlink(path.join(directory, 'projection-source.json')).catch(error => {if (error.code !== 'ENOENT') throw error;});
  const overall = capture.files.get('overall.json');
  manifest.overall = {path: 'overall.json', revision: Number(overall.revision || overall.sourceRevision || 0),
    updatedAt: overall.updatedAt, sha256: sha256(serialized.get('overall.json'))};
  manifest.overallResults = {path: 'overall-results.json', available: true};
  manifest.overallProjection = {path: capture.report.projectionReady ? 'projection-source.json' : null,
    available: capture.report.projectionReady, reason: capture.report.projectionReason,
    ...(capture.report.projectionReady ? {sha256: sha256(serialized.get('projection-source.json'))} : {})};
  manifest.overallCapture = capture.report;
  const bindings = new Map([...(overall.trackSummaries || []), ...(overall.trackCatalog || [])]
    .map(row => [row.trackId, row.updatedAt]));
  manifest.trackSummaryMismatches = [...bindings].filter(([id, updatedAt]) =>
    manifest.tracks?.[id]?.path && (manifest.tracks[id].sourceUpdatedAt ?? manifest.tracks[id].updatedAt) !== updatedAt)
    .map(([id]) => id).sort();
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return capture.report;
}
