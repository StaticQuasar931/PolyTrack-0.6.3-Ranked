import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
import {isDeepStrictEqual} from 'node:util';
import {hydrateStaging} from './update-public-snapshot.mjs';
import {buildSnapshotLookupShards} from './snapshot-package.mjs';
import {buildSnapshotBootstrapIndex, buildSnapshotFastIndex, buildTrackSnapshotPaging,
  buildOverallSnapshotPaging, buildBoardPageManifest} from './track-snapshot-paging.mjs';
import {publicCatalogBackup} from './sync-event-catalog.mjs';
import {publicOverallBackup, publicTrackBackup} from './public-snapshot-backup.mjs';
import {publicEventTotals} from './public-event-totals-backup.mjs';
import {publicDisplayName} from './public-display-name.mjs';

const STATE = 'tools/workflow-capture-state.json';
const FILE_LIMIT = 20 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const timestamp = value => /^\d{13}$/.test(String(value)) ? Number(value) : NaN;
const json = async (root, relative) => JSON.parse((await bytes(root, relative)).toString('utf8'));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function validateCatalog(catalog) {
  if (!object(catalog) || !Array.isArray(catalog.archives) || catalog.archives.length > 5000) throw Error('Invalid saved event catalog');
  publicCatalogBackup({...catalog, archives: []});
  for (let offset = 0; offset < catalog.archives.length; offset += 160)
    publicCatalogBackup({periods: [], archives: catalog.archives.slice(offset, offset + 160)});
  for (const rows of [catalog.periods, catalog.archives]) {
    const seen = new Set();
    for (const row of rows) {
      if (seen.has(row.id) || row.startsAt < 0 || !['daily','weekly','kodub','custom'].includes(row.kind))
        throw Error('Invalid event catalog period schema');
      seen.add(row.id);
    }
  }
}

function validateTotalsArtifact(value) {
  if (!Array.isArray(value?.entries) || value.entries.length <= 200) {publicEventTotals(value);return;}
  if (!object(value) || value.entries.length > 10000 || value.complete !== true || value.totalEntries !== value.entries.length ||
      Object.keys(value).some(key => !['updatedAt','entries','complete','totalEntries'].includes(key))) throw Error('Invalid projected event totals artifact');
  const rows=[], seen=new Set();
  for(let offset=0;offset<value.entries.length;offset+=200){
    const source=value.entries.slice(offset,offset+200);
    const projected=publicEventTotals({updatedAt:value.updatedAt,entries:source}).entries;
    for(let index=0;index<source.length;index++)if(Object.hasOwn(source[index],'nickname')){
      if(typeof source[index].nickname!=='string')throw Error('Invalid public event nickname');
      projected[index].nickname=publicDisplayName(source[index].nickname);
    }
    rows.push(...projected);
  }
  for(const row of rows) {if(seen.has(row.accountId))throw Error('Duplicate projected event total identity');seen.add(row.accountId);}
  if (!isDeepStrictEqual(value,{updatedAt:value.updatedAt,entries:rows,complete:true,totalEntries:rows.length}))
    throw Error('Non-public projected event totals fields');
}

async function validateConsumerPackage(root, directory, index) {
  const equal = async (relative, expected) => {
    if (!isDeepStrictEqual(await json(root, directory + '/' + relative), expected)) throw Error('Invalid consumer artifact: ' + relative);
  };
  if (index.lookupShardsVersion !== 1) throw Error('Invalid lookup shard version');
  await equal('bootstrap-index.json', buildSnapshotBootstrapIndex(index));
  await equal('bootstrap-fast.json', buildSnapshotFastIndex(index));
  for (const [bucket, shard] of buildSnapshotLookupShards(index)) await equal('lookup-shards/' + bucket + '.json', shard);
  for (const required of ['manifest.json', 'coverage.json', 'public-export-summary.json', 'event-totals.json',
    'track-statistics.json', 'snapshot-paging.json', 'overall-manifest.json', 'overall-preview.json'])
    if (!Object.hasOwn(index.files, required)) throw Error('Missing consumer artifact: ' + required);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'polytrack-receipt-'));
  try {
    // Existing hydration validates logical paths, hashes, codec, decoded JSON/lengths,
    // paging descriptors and omitted-board reconstruction. Never hydrate into the checkout.
    await hydrateStaging(root, temporary);
    const read = relative => json(temporary, relative);
    const overall = await read('overall.json');
    publicOverallBackup(overall);
    validateTotalsArtifact(await read('event-totals.json'));
    const coverage = await read('coverage.json'), summary = await read('public-export-summary.json');
    if (!object(coverage) || coverage.schemaVersion !== 1 || typeof coverage.complete !== 'boolean' ||
        !object(summary) || typeof summary.complete !== 'boolean' || !object(summary.counts) ||
        ['profiles','canonical','recordings'].some(key => !Number.isSafeInteger(summary.counts[key]) || summary.counts[key] < 0))
      throw Error('Invalid capture coverage metadata');
    const manifest = await read('manifest.json'), statistics = await read('track-statistics.json');
    if (!object(manifest) || manifest.schemaVersion !== 1 || !object(manifest.tracks) || !object(statistics) || statistics.schemaVersion !== 1)
      throw Error('Invalid capture manifest/statistics');
    const paging = await read('snapshot-paging.json');
    const expectedPaging = new Set(['snapshot-paging.json']);
    const tracks = new Map();
    for (const logical of Object.keys(index.files).filter(value => /^tracks\/[a-f0-9]{64}\.json$/.test(value))) {
      const id = logical.slice(7, -5), board = await read(logical);
      publicTrackBackup(board, id);tracks.set(id, board);
    }
    for (const id of Object.keys(paging.tracks)) if (!tracks.has(id)) tracks.set(id, await read('tracks/' + id + '.json'));
    const validateBoard = async (id, board) => {
      const manifestPath = id ? `track-manifests/${id}.json` : 'overall-manifest.json';
      const saved = await read(manifestPath);
      expectedPaging.add(manifestPath);
      expectedPaging.add(id ? `track-previews/${id}.json` : 'overall-preview.json');
      for (const bound of saved.pageBounds) expectedPaging.add(bound.path);
      if (saved.monolithOmitted) {
        // Hydration has already validated every reconstructed page and descriptor.
        // Paging is lossy for original rank fields, so do not repaginate derived rows.
        const previewPath = id ? `track-previews/${id}.json` : 'overall-preview.json';
        if (!Object.hasOwn(index.files, previewPath)) throw Error('Missing paging preview: ' + previewPath);
        const preview = await read(previewPath), rows = board.entries.slice(0, 15);
        const bounds = {pageNumber: null, offset: 0, count: rows.length, startPosition: rows.length ? 1 : null,
          endPosition: rows.length || null, ...(id ? {minTimeMs: rows[0]?.timeMs ?? null, maxTimeMs: rows.at(-1)?.timeMs ?? null} : {}),
          firstRank: rows[0]?.globalRank ?? null, lastRank: rows.at(-1)?.globalRank ?? null};
        const keys = ['pagingVersion','sourceComplete','totalEntries','totalEntriesExact','publishedEntries','ranksExact',
          'capturedAt','pageSize','pageCount','trackId','schemaVersion','revision','sourceRevision','algorithmVersion','updatedAt','builtAt'];
        if (preview.kind !== (id ? 'track-preview' : 'overall-preview') || preview.previewSize !== 15 ||
            preview.pageNumber !== null || preview.offset !== 0 || preview.count !== rows.length ||
            preview.complete !== (saved.sourceComplete && rows.length === saved.totalEntries) ||
            !isDeepStrictEqual(preview.entries, rows) || !isDeepStrictEqual(preview.bounds, bounds) ||
            !isDeepStrictEqual(preview.pageBounds, saved.pageBounds.map(({path, ...bound}) => bound)) ||
            keys.some(key => Object.hasOwn(saved, key) && !isDeepStrictEqual(preview[key], saved[key])))
          throw Error('Invalid omitted-board preview: ' + previewPath);
        return;
      }
      const source = {...saved.boardMetadata, entries: board.entries};
      const {preview, pages} = id ? buildTrackSnapshotPaging(source, {capturedAt: saved.capturedAt})
        : buildOverallSnapshotPaging(source, {capturedAt: saved.capturedAt});
      const check = async (logical, expected) => {
        if (!Object.hasOwn(index.files, logical) || !isDeepStrictEqual(await read(logical), expected))
          throw Error('Invalid paging consumer artifact: ' + logical);
      };
      await check(manifestPath, buildBoardPageManifest(source, preview, saved.monolithOmitted));
      await check(id ? `track-previews/${id}.json` : 'overall-preview.json', preview);
      for (const page of pages) await check(id ? `track-pages/${id}/${page.pageNumber}.json` : `overall-pages/${page.pageNumber}.json`, page);
      if (!saved.monolithOmitted && !isDeepStrictEqual(saved.boardMetadata, Object.fromEntries(
        Object.entries(board).filter(([key]) => key !== 'entries')))) throw Error('Paging/monolith metadata mismatch');
      // Source and derived pages must contain the same rows, not just matching metadata.
      if (!saved.monolithOmitted) {
        const expected = id ? buildTrackSnapshotPaging(board, {capturedAt: saved.capturedAt}) : buildOverallSnapshotPaging(board, {capturedAt: saved.capturedAt});
        if (!isDeepStrictEqual(expected.pages, pages)) throw Error('Paging/monolith row mismatch');
      }
    };
    await validateBoard(null, overall);
    for (const [id, board] of tracks) {
      publicTrackBackup(board, id);
      if (Object.hasOwn(paging.tracks, id)) await validateBoard(id, board);
    }
    for (const logical of Object.keys(index.files))
      if (/^(?:overall-(?:manifest|preview)\.json|overall-pages\/|track-(?:manifests|previews|pages)\/)/.test(logical) && !expectedPaging.has(logical))
        throw Error('Unbacked paging consumer artifact: ' + logical);
    // Replay coverage may intentionally be bounded/incomplete. Source coherence is independent.
    if (overall.complete !== true || overall.sourceComplete === false) return {reusable: false, coherenceReason: 'incomplete_overall_source'};
    if (!Array.isArray(overall.trackCatalog)) return {reusable: false, coherenceReason: 'overall_track_catalog_unavailable'};
    for (const row of overall.trackCatalog) {
      const board = tracks.get(row.trackId);
      if (!board || row.updatedAt !== (board.updatedAt ?? board.builtAt ?? 0))
        return {reusable: false, coherenceReason: 'track_binding_mismatch'};
      if (board.complete !== true || board.sourceComplete === false) return {reusable: false, coherenceReason: 'incomplete_track_source'};
    }
    if (manifest.trackSummaryMismatches !== undefined && !Array.isArray(manifest.trackSummaryMismatches)) throw Error('Invalid track mismatch metadata');
    if (manifest.trackSummaryMismatches?.length) return {reusable: false, coherenceReason: 'track_binding_mismatch'};
    if (Object.hasOwn(index.files, 'overall-results.json')) {
      const results = await read('overall-results.json');
      if (!object(results)) throw Error('Invalid Overall results');
      if (['sourceRevision', 'builtRevision', 'updatedAt', 'algorithmVersion'].some(key => results[key] !== overall[key]))
        return {reusable: false, coherenceReason: 'result_binding_mismatch'};
    }
    return {reusable: true, coherenceReason: 'source_bound'};
  } finally {
    if (path.dirname(temporary) !== path.resolve(os.tmpdir())) throw Error('Unsafe temporary cleanup path');
    await fs.rm(temporary, {recursive: true, force: true});
  }
}

async function bytes(root, relative) {
  const file = path.join(root, relative);
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.size > FILE_LIMIT) throw Error('Invalid capture file: ' + relative);
  return fs.readFile(file);
}

// Bind the receipt to the existing public package, never to a cache success flag.
export async function captureBinding(root) {
  const pointer = await bytes(root, 'snapshot-current.json');
  const directory = JSON.parse(pointer).currentdir;
  if (!/^public-snapshots[1-9]\d*$/.test(directory)) throw Error('Invalid snapshot pointer');
  if (!(await fs.lstat(path.join(root, directory))).isDirectory()) throw Error('Invalid snapshot directory');
  const indexBytes = await bytes(root, directory + '/index.json');
  const index = JSON.parse(indexBytes);
  if (index.schemaVersion !== 1 || index.generation !== Number(directory.slice(16)) ||
      index.encoding !== 'gzip-xor-a7-v1' || !index.files || Array.isArray(index.files) ||
      typeof index.files !== 'object' || !Object.keys(index.files).length) throw Error('Invalid snapshot index');
  const html = await bytes(root, 'index.html');
  if (!html.toString().includes(`name="polytrack-snapshot" content="./${directory}/"`))
    throw Error('Entry point and snapshot pointer disagree');
  const checked = new Set();
  for (const entry of Object.values(index.files)) {
    if (!/^[a-f0-9]{64}$/.test(entry?.sha256 || '') || entry.path !== entry.sha256 + '.bin' ||
        !Number.isSafeInteger(entry.decodedBytes) || entry.decodedBytes < 1 || entry.decodedBytes > 2 * 1024 * 1024)
      throw Error('Invalid immutable snapshot binding');
    if (checked.has(entry.path)) continue;
    if (hash(await bytes(root, directory + '/' + entry.path)) !== entry.sha256) throw Error('Snapshot hash mismatch');
    checked.add(entry.path);
  }
  const catalogBytes = await bytes(root, 'events/public-catalog.json');
  validateCatalog(JSON.parse(catalogBytes.toString('utf8')));
  const validity = await validateConsumerPackage(root, directory, index);
  return {directory, pointerSha256: hash(pointer), indexSha256: hash(indexBytes),
    catalogSha256: hash(catalogBytes), ...validity};
}

export function requestedAfter({requestedAt = '', eventName, schedule, now = Date.now()} = {}) {
  if (requestedAt !== '') {
    const at = timestamp(requestedAt);
    if (!Number.isSafeInteger(at) || at > now) throw Error('Invalid capture request timestamp');
    return at;
  }
  if (eventName !== 'schedule' || schedule !== '20 0 * * *') return null;
  const day = new Date(now); day.setUTCHours(0, 20, 0, 0);
  // A severely delayed daily run crossing midnight must not reuse yesterday's capture.
  return day.getTime() <= now ? day.getTime() : null;
}

export async function checkCapture({root, now = Date.now(), ...request}) {
  const after = requestedAfter({...request, now});
  if (after === null) return {reuse: false, startedAt: now, reason: 'explicit or catalog-only capture'};
  let state;
  try { state = JSON.parse(await bytes(root, STATE)); }
  catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    return {reuse: false, startedAt: now, reason: 'no valid published receipt'};
  }
  if (!object(state) || state.schemaVersion !== 2 || state.reusable !== true || !Number.isSafeInteger(state.startedAt) ||
      !Number.isSafeInteger(state.completedAt) || state.startedAt < after ||
      state.completedAt < state.startedAt || state.completedAt > now)
    return {reuse: false, startedAt: now, reason: 'receipt does not cover this request'};
  const binding = await captureBinding(root);
  if (!binding.reusable) return {reuse: false, startedAt: now, reason: binding.coherenceReason};
  if (Object.entries(binding).some(([key, value]) => state[key] !== value))
    return {reuse: false, startedAt: now, reason: 'published capture binding changed'};
  return {reuse: true, startedAt: now, reason: 'reuse a later successful bounded capture; not an aggregate revision barrier'};
}

export async function recordCapture({root, startedAt, now = Date.now()}) {
  const start = timestamp(startedAt);
  if (!Number.isSafeInteger(start) || start > now) throw Error('Invalid capture start timestamp');
  const state = {schemaVersion: 2, startedAt: start, completedAt: now, ...await captureBinding(root)};
  const temporary = path.join(root, STATE + '.' + randomUUID() + '.tmp');
  try {
    await fs.writeFile(temporary, JSON.stringify(state, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
    await fs.rename(temporary, path.join(root, STATE));
  } finally {await fs.unlink(temporary).catch(error => {if (error.code !== 'ENOENT') throw error;});}
  return state;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || !['check', 'record'].includes(mode)) throw Error('Expected check or record');
  const env = process.env, root = process.cwd();
  if (mode === 'record') {
    const state = await recordCapture({root, startedAt: env.CAPTURE_STARTED_AT});
    if (!state.reusable) console.warn('::warning::Capture publication may continue, but its receipt is nonreusable: ' + state.coherenceReason);
  }
  else {
    const result = await checkCapture({root, requestedAt: env.CAPTURE_REQUESTED_AT || '',
      eventName: env.GITHUB_EVENT_NAME, schedule: env.CAPTURE_SCHEDULE});
    console.log(result.reason);
    if (env.GITHUB_OUTPUT) await fs.appendFile(env.GITHUB_OUTPUT,
      `reuse=${result.reuse}\nstarted_at=${result.startedAt}\n`);
    if (env.GITHUB_STEP_SUMMARY) await fs.appendFile(env.GITHUB_STEP_SUMMARY, 'Capture coordination: ' + result.reason + '\n');
  }
}
