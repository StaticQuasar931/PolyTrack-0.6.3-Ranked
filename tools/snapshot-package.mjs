import {deriveEventRecordings} from './snapshot-event-recordings.mjs';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { buildTrackSnapshotPaging, buildOverallSnapshotPaging, buildBoardPageManifest, buildSnapshotBootstrapIndex, buildSnapshotFastIndex, isBootstrapSnapshotPath } from './track-snapshot-paging.mjs';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

function compactTrackLeader(snapshot, trackId, complete, record) {
  if (!complete || snapshot.trackId !== trackId || snapshot.sourceComplete === false ||
      snapshot.ranksExact === false || snapshot.totalEntriesExact === false ||
      snapshot.authoritative === false || snapshot.sourceAuthoritative === false ||
      record?.complete === false || record?.sourceComplete === false || record?.ranksExact === false ||
      record?.totalEntriesExact === false || record?.missing === true ||
      (record?.path != null && record.path !== `tracks/${trackId}.json`) || !snapshot.entries.length) return null;
  const entries = snapshot.entries;
  const account = row => row.accountId || row.userId;
  if (entries.some(row => !Number.isSafeInteger(row?.timeMs) || row.timeMs <= 0 ||
      row.accountId && row.userId && row.accountId !== row.userId ||
      row.local === true || row.localPending === true || row.pending === true ||
      [row.status, row.runStatus, row.validationState, row.verificationStatus].some(value =>
        /^(rejected|mismatch)$/i.test(String(value || ''))))) return null;
  // Match complete-board paging's ordinal time/account tie order; never trust array load order.
  const first = entries.reduce((best, row) => !best || row.timeMs < best.timeMs ||
    row.timeMs === best.timeMs && String(account(row)).localeCompare(String(account(best)), 'en') < 0 ? row : best, null);
  const ranks = row => [row.rank, row.globalRank, row.position].filter(value => value != null);
  if (ranks(first).some(rank => rank !== 1) ||
      entries.some(row => row !== first && ranks(row).some(rank => rank === 1))) return null;
  const rawName = typeof first.name === 'string' ? first.name : typeof first.nickname === 'string' ? first.nickname : '';
  const name = rawName.normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, 24).replace(/[\uD800-\uDBFF]$/, '');
  const pbAt = [first.pbAt, first.createdAt].find(value =>
    Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000) ?? null;
  return {accountId: account(first), name, timeMs: first.timeMs, pbAt,
    ...(typeof first.runVerified === 'boolean' ? {runVerified: first.runVerified} : {})};
}

export function buildTrackStatistics(files) {
  const byPath = new Map(files.map(({ logicalPath, value }) => [logicalPath, value]));
  const manifest = byPath.get('manifest.json');
  const exportSummary = byPath.get('public-export-summary.json');
  const overall = byPath.get('overall.json');
  const manifestTracks = manifest?.tracks && typeof manifest.tracks === 'object' && !Array.isArray(manifest.tracks) ? manifest.tracks : {};
  const tracks = {};
  let present = 0;
  let allComplete = true;
  for (const [trackId, record] of Object.entries(manifestTracks)) {
    if (!/^[a-f0-9]{64}$/.test(trackId)) continue;
    const snapshot = byPath.get(`tracks/${trackId}.json`);
    if (!snapshot || record?.path === null || !Array.isArray(snapshot.entries)) {
      tracks[trackId] = { count: null, players: null, totalEntries: null, complete: false, weight: null,
        revision: Number.isSafeInteger(record?.revision) ? record.revision : null,
        updatedAt: Number.isSafeInteger(record?.sourceUpdatedAt) ? record.sourceUpdatedAt : null,
        capturedAt: Number.isSafeInteger(record?.checkedAt) && record.checkedAt > 0 ? new Date(record.checkedAt).toISOString() : null };
      allComplete = false;
      continue;
    }
    present += 1;
    const entries = snapshot.entries;
    const accountIds = entries.map(row => row?.accountId || row?.userId);
    const uniqueIds = new Set(accountIds);
    const totalEntries = Number.isSafeInteger(snapshot.totalEntries) && snapshot.totalEntries >= 0 ? snapshot.totalEntries : null;
    const complete = snapshot.complete === true && totalEntries === entries.length &&
      accountIds.every(id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)) && uniqueIds.size === entries.length;
    const weights = [...new Set(entries.map(row => row?.weight).filter(value => Number.isFinite(value) && value >= 0))];
    const weight = entries.length && weights.length === 1 && entries.every(row => Number.isFinite(row?.weight) && row.weight >= 0 && row.weight === weights[0]) ? weights[0] : null;
    tracks[trackId] = { count: entries.length, players: complete ? uniqueIds.size : null, totalEntries, complete, weight,
      revision: Number.isSafeInteger(snapshot.revision) ? snapshot.revision : Number.isSafeInteger(record?.revision) ? record.revision : null,
      updatedAt: Number.isSafeInteger(snapshot.updatedAt) ? snapshot.updatedAt : null,
      capturedAt: Number.isSafeInteger(record?.checkedAt) && record.checkedAt > 0 ? new Date(record.checkedAt).toISOString() : null };
    const leader = compactTrackLeader(snapshot, trackId, complete, record);
    if (leader) tracks[trackId].leader = leader;
    if (!complete) allComplete = false;
  }
  const tracksKnown = Number.isSafeInteger(manifest?.trackIdsKnown) && manifest.trackIdsKnown >= 0 ? manifest.trackIdsKnown : null;
  return { schemaVersion: 1, complete: tracksKnown !== null && present === tracksKnown && Object.keys(tracks).length === tracksKnown && allComplete,
    tracksKnown, tracksPresent: present,
    capturedAt: typeof exportSummary?.capturedAt === 'string' ? exportSummary.capturedAt : null,
    revision: Number.isSafeInteger(overall?.revision) ? overall.revision : Number.isSafeInteger(overall?.sourceRevision) ? overall.sourceRevision : null,
    updatedAt: Number.isSafeInteger(overall?.updatedAt) ? overall.updatedAt : null, tracks };
}

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_DECODED_BYTES = 2 * 1024 * 1024;
export const SNAPSHOT_XOR_KEY = 0xa7;
export const SNAPSHOT_CODEC = Object.freeze({
  name: 'gzip-xor-a7-v1',
  version: 1,
  compression: 'gzip',
  xorByte: '0xA7',
  obfuscation: 'single-byte XOR; reversible and not encryption',
  security: 'non-security cosmetic obfuscation only',
});

function xorBytes(bytes) {
  const result = Buffer.from(bytes);
  for (let i = 0; i < result.length; i += 1) result[i] ^= SNAPSHOT_XOR_KEY;
  return result;
}

function jsonBytes(value) {
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  if (json === undefined) throw new TypeError('Snapshot value must be JSON-serializable');
  return Buffer.from(json, 'utf8');
}

export async function encodeSnapshot(value) {
  const decoded = jsonBytes(value);
  if (decoded.byteLength > MAX_DECODED_BYTES) throw new RangeError(`Decoded snapshot exceeds ${MAX_DECODED_BYTES} bytes`);
  const encoded = xorBytes(await gzipAsync(decoded, { level: 9, mtime: 0 }));
  if (encoded.byteLength > MAX_FILE_BYTES) throw new RangeError(`Encoded snapshot exceeds ${MAX_FILE_BYTES} bytes`);
  return new Uint8Array(encoded);
}

export async function decodeSnapshot(encoded) {
  return new Uint8Array(await gunzipAsync(xorBytes(encoded), { maxOutputLength: MAX_DECODED_BYTES }));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function safeRelativePath(value) {
  const normalized = value.split(path.sep).join('/');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Unsafe snapshot path: ${value}`);
  }
  return normalized;
}

async function collectJsonFiles(directory) {
  const entries = [];
  async function walk(current, relative = '') {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const fullPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Snapshot staging cannot contain symlinks: ${nextRelative}`);
      if (entry.isDirectory()) await walk(fullPath, nextRelative);
      else if (entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'export-progress.json' && nextRelative !== 'track-statistics.json' &&
          !/^(?:track-previews|track-pages|track-manifests|overall-pages)\//.test(nextRelative) &&
          !['bootstrap-fast.json', 'bootstrap-index.json', 'snapshot-paging.json', 'overall-manifest.json', 'overall-preview.json'].includes(nextRelative)) {
        const logicalPath = safeRelativePath(nextRelative);
        const bytes = await fs.readFile(fullPath);
        const pageable = /^tracks\/[a-f0-9]{64}\.json$/.test(logicalPath) || logicalPath === 'overall.json';
        if (!pageable && bytes.byteLength > MAX_DECODED_BYTES) throw new RangeError(`${logicalPath} exceeds decoded limit (${MAX_DECODED_BYTES} bytes)`);
        let value;
        try { value = JSON.parse(bytes.toString('utf8')); } catch (error) { throw new Error(`${logicalPath} is not valid JSON`, { cause: error }); }
        entries.push({ logicalPath, bytes, value });
      }
    }
  }
  await walk(directory);
  for(const file of await deriveEventRecordings(entries)) entries.push({...file,bytes:jsonBytes(file.value)});
  const byPath = new Map(entries.map(entry => [entry.logicalPath, entry.value]));
  const catalog = { schemaVersion: 1, pagingVersion: 1, pageSize: 100, legacyMonolithCoverageComplete: true, omittedMonoliths: [], tracks: {}, overall: null };
  function addDerived(logicalPath, value) {
    const bytes = jsonBytes(value);
    if (bytes.byteLength > MAX_DECODED_BYTES) throw new RangeError(`${logicalPath} exceeds decoded limit`);
    entries.push({ logicalPath, bytes, value });
  }
  function describe(manifestPath, manifest) {
    if (manifest.monolithOmitted) { catalog.legacyMonolithCoverageComplete = false; catalog.omittedMonoliths.push(manifest.sourceLogicalPath); }
    return { manifestPath, fullBoardPath: manifest.fullBoardPath, monolithOmitted: manifest.monolithOmitted,
      pageCount: manifest.pageCount, publishedEntries: manifest.publishedEntries, totalEntries: manifest.totalEntries,
      sourceComplete: manifest.sourceComplete, ranksExact: manifest.ranksExact };
  }
  for (const { logicalPath, value, bytes } of [...entries]) {
    const match = /^tracks\/([a-f0-9]{64})\.json$/.exec(logicalPath);
    // Legacy audit-only boards without usable times remain available as monoliths.
    if (!match || value?.trackId !== match[1] || !Array.isArray(value.entries) ||
        !value.entries.every(row => Number.isSafeInteger(row?.timeMs) && row.timeMs > 0)) continue;
    const { preview, pages } = buildTrackSnapshotPaging(value, { capturedAt: byPath.get('manifest.json')?.tracks?.[match[1]]?.checkedAt });
    const manifestPath = `track-manifests/${match[1]}.json`;
    const manifest = buildBoardPageManifest(value, preview, bytes.byteLength > MAX_DECODED_BYTES);
    catalog.tracks[match[1]] = describe(manifestPath, manifest);
    addDerived(manifestPath, manifest);
    addDerived(`track-previews/${match[1]}.json`, preview);
    for (const page of pages) addDerived(`track-pages/${match[1]}/${page.pageNumber}.json`, page);
  }
  const overallEntry = entries.find(entry => entry.logicalPath === 'overall.json');
  if (Array.isArray(overallEntry?.value?.entries) &&
      (Number.isSafeInteger(overallEntry.value.totalEntries) || overallEntry.bytes.byteLength > MAX_DECODED_BYTES)) {
    const { preview, pages } = buildOverallSnapshotPaging(overallEntry.value, { capturedAt: byPath.get('public-export-summary.json')?.capturedAt });
    const manifest = buildBoardPageManifest(overallEntry.value, preview, overallEntry.bytes.byteLength > MAX_DECODED_BYTES);
    catalog.overall = describe('overall-manifest.json', manifest);
    addDerived('overall-manifest.json', manifest);
    addDerived('overall-preview.json', preview);
    for (const page of pages) addDerived(`overall-pages/${page.pageNumber}.json`, page);
  }
  const statistics = buildTrackStatistics(entries.filter(entry => entry.logicalPath !== 'track-statistics.json'));
  const statisticsBytes = Buffer.from(`${JSON.stringify(statistics)}\n`, 'utf8');
  if (statisticsBytes.byteLength > MAX_DECODED_BYTES) throw new RangeError('track-statistics.json exceeds decoded limit');
  entries.push({ logicalPath: 'track-statistics.json', bytes: statisticsBytes, value: statistics });
  if (Object.keys(catalog.tracks).length || catalog.overall) addDerived('snapshot-paging.json', catalog);
  // Only private staging may contain a large monolith. All public records stay bounded.
  for (let i = entries.length - 1; i >= 0; i -= 1) if (entries[i].bytes.byteLength > MAX_DECODED_BYTES) {
    if (!catalog.omittedMonoliths.includes(entries[i].logicalPath)) throw new RangeError(`${entries[i].logicalPath} exceeds decoded limit and cannot be paged`);
    entries.splice(i, 1);
  }
  entries.sort((a, b) => a.logicalPath.localeCompare(b.logicalPath, 'en'));
  if (!entries.length) throw new Error('Staging directory contains no JSON snapshots');
  return entries;
}

async function readIndex(directory) {
  try {
    const bytes = await fs.readFile(path.join(directory, 'index.json'));
    if (bytes.byteLength > MAX_FILE_BYTES) return null;
    const index = JSON.parse(bytes.toString('utf8'));
  return index?.schemaVersion === 1 && index.files && typeof index.files === 'object' ? index : null;
  } catch { return null; }
}


export function buildSnapshotLookupShards(index) {
  const shards = new Map();
  for (const [logical, record] of Object.entries(index.files)) {
    if (isBootstrapSnapshotPath(logical)) continue;
    const bucket = sha256(Buffer.from(logical)).slice(0, 2);
    if (!shards.has(bucket)) shards.set(bucket, { schemaVersion: 1, generation: index.generation,
      encoding: index.encoding, lookupShardsVersion: 1, compactIndexVersion: 2, bucket, files: {} });
    shards.get(bucket).files[logical] = [Buffer.from(record.sha256, 'hex').toString('base64url'), record.decodedBytes];
  }
  return shards;
}
async function writeSnapshotLookupShards(index, directory) {
  const shards = buildSnapshotLookupShards(index);
  if (shards.size) await fs.mkdir(path.join(directory, 'lookup-shards'), { recursive: true });
  for (const [bucket, shard] of shards) await fs.writeFile(path.join(directory, 'lookup-shards', bucket + '.json'), JSON.stringify(shard) + '\n', { flag: 'wx' });
}
async function matchesPublished(entries, index, directory) {
  if (index.lookupShardsVersion !== 1) return false;
  if (index.encoding !== 'gzip-xor-a7-v1' || Object.keys(index.files).length !== entries.length) return false;
  for (const { logicalPath, bytes } of entries) {
    const item = index.files[logicalPath];
    if (!item || item.decodedBytes !== bytes.byteLength) return false;
    const expectedHash = sha256(xorBytes(await gzipAsync(bytes, { level: 9, mtime: 0 })));
    if (item.sha256 !== expectedHash || item.path !== `${expectedHash}.bin`) return false;
    try {
      const published = await fs.readFile(path.join(directory, item.path));
      if (sha256(published) !== item.sha256) return false;
    } catch { return false; }
  }
  if (entries.some(entry => entry.logicalPath === 'snapshot-paging.json')) {
    try {
      const bootstrap = await fs.readFile(path.join(directory, 'bootstrap-index.json'), 'utf8');
      if (await fs.readFile(path.join(directory, 'bootstrap-fast.json'), 'utf8') !== JSON.stringify(buildSnapshotFastIndex(index)) + '\n') return false;
      if (bootstrap !== `${JSON.stringify(buildSnapshotBootstrapIndex(index))}\n`) return false;
    } catch { return false; }
  }
  for (const [bucket, shard] of buildSnapshotLookupShards(index)) {
    try { if (await fs.readFile(path.join(directory, 'lookup-shards', bucket + '.json'), 'utf8') !== JSON.stringify(shard) + '\n') return false; }
    catch { return false; }
  }
  return true;
}

async function archiveGeneration(sourceDirectory, historyDirectory, generation) {
  const indexBytes = await fs.readFile(path.join(sourceDirectory, 'index.json'));
  if (indexBytes.byteLength > MAX_FILE_BYTES) throw new RangeError('Published index exceeds file limit');
  const index = JSON.parse(indexBytes.toString('utf8'));
  const files = {};
  for (const [logicalPath, item] of Object.entries(index.files)) {
    const payloadName = path.basename(item.path);
    if (payloadName !== item.path || !payloadName.endsWith('.bin')) throw new Error('Published index contains an unsafe payload name');
    const bytes = await fs.readFile(path.join(sourceDirectory, payloadName));
    if (bytes.byteLength > MAX_FILE_BYTES) throw new RangeError(`${payloadName} exceeds file limit`);
    if (sha256(bytes) !== item.sha256) throw new Error(`Published payload hash mismatch: ${logicalPath}`);
    files[payloadName] = bytes.toString('base64');
  }
  let bootstrapIndex;
  try { bootstrapIndex = JSON.parse(await fs.readFile(path.join(sourceDirectory, 'bootstrap-index.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const archive = await gzipAsync(Buffer.from(JSON.stringify({ schemaVersion: 1, generation, index, files, bootstrapIndex }), 'utf8'), { level: 9, mtime: 0 });
  await fs.mkdir(historyDirectory, { recursive: true });
  const target = path.join(historyDirectory, `generation-${generation}.snapshot.gz`);
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, archive, { flag: 'wx' });
  await fs.rename(temporary, target);
  return target;
}

export async function restoreSnapshotArchive(archivePath, destinationDirectory) {
  const contents = JSON.parse((await gunzipAsync(await fs.readFile(archivePath))).toString('utf8'));
  if (contents.schemaVersion !== 1 || !contents.index?.files || typeof contents.index.files !== 'object') throw new Error('Invalid snapshot history archive');
  await fs.mkdir(destinationDirectory, { recursive: true });
  await fs.writeFile(path.join(destinationDirectory, 'index.json'), JSON.stringify(contents.index, null, 2));
  if (contents.bootstrapIndex && contents.index.lookupShardsVersion === 1) await fs.writeFile(path.join(destinationDirectory, 'bootstrap-fast.json'), JSON.stringify(buildSnapshotFastIndex(contents.index)) + '\n', { flag: 'wx' });
  if (contents.bootstrapIndex) await fs.writeFile(path.join(destinationDirectory, 'bootstrap-index.json'), `${JSON.stringify(contents.bootstrapIndex)}\n`, { flag: 'wx' });
  for (const item of Object.values(contents.index.files)) {
    const name = path.basename(item.path);
    if (name !== item.path || !Object.hasOwn(contents.files, name)) throw new Error('Invalid payload in snapshot history archive');
    const bytes = Buffer.from(contents.files[name], 'base64');
    if (bytes.byteLength > MAX_FILE_BYTES) throw new RangeError(`${name} exceeds file limit`);
    await fs.writeFile(path.join(destinationDirectory, name), bytes, { flag: 'wx' });
  }
  if (contents.index.lookupShardsVersion === 1) await writeSnapshotLookupShards(contents.index, destinationDirectory);
  return contents.index;
}

function sameCandidate(stat, identity) {
  return stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === identity.dev && stat.ino === identity.ino &&
    stat.birthtimeMs === identity.birthtimeMs && stat.mode === identity.mode;
}

async function assertAbsent(destination) {
  try { await fs.lstat(destination); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw Object.assign(new Error('Snapshot generation destination already exists'), {code: 'EEXIST'});
}

async function assertCandidate(directory, identity, expected) {
  const invalid = () => { throw new Error('Snapshot publication candidate changed'); };
  if (!sameCandidate(await fs.lstat(directory), identity)) invalid();
  const seen = new Set(), buffer = Buffer.alloc(64 * 1024);
  async function walk(current, prefix = '') {
    for (const entry of await fs.readdir(current, {withFileTypes: true})) {
      const relative = prefix + entry.name, file = path.join(current, entry.name);
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) invalid();
      if (stat.isDirectory()) {
        if (relative !== 'lookup-shards' || ![...expected.keys()].some(name => name.startsWith('lookup-shards/'))) invalid();
        await walk(file, relative + '/'); continue;
      }
      const wanted = expected.get(relative);
      if (!stat.isFile() || stat.nlink !== 1 || !wanted || stat.size !== wanted.bytes || stat.size > MAX_FILE_BYTES) invalid();
      const handle = await fs.open(file, 'r');
      try {
        const opened = await handle.stat(), hash = createHash('sha256');
        if (opened.dev !== stat.dev || opened.ino !== stat.ino) invalid();
        let total = 0;
        for (;;) {
          const {bytesRead} = await handle.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          total += bytesRead;
          if (total > wanted.bytes) invalid();
          hash.update(buffer.subarray(0, bytesRead));
        }
        const after = await fs.lstat(file);
        if (total !== wanted.bytes || hash.digest('hex') !== wanted.sha256 || after.isSymbolicLink() ||
            after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size ||
            after.mtimeMs !== stat.mtimeMs || after.mode !== stat.mode) invalid();
      } finally { await handle.close(); }
      seen.add(relative);
    }
  }
  await walk(directory);
  if (seen.size !== expected.size || !sameCandidate(await fs.lstat(directory), identity)) invalid();
}

// Local directory commit only: never rerun capture, encoding, or native work.
// The caller must exclusively own the publication root, as for pointer commit.
async function renameGeneration(source, destination, identity, expected) {
  const waits = [100, 500, 1000];
  const parent = path.dirname(source), parentIdentity = await fs.lstat(parent);
  if (parent !== path.dirname(destination) || !sameCandidate(parentIdentity, parentIdentity)) {
    throw new Error('Unsafe snapshot publication parent');
  }
  for (let attempt = 0;; attempt++) {
    if (attempt) {
      await delay(waits[attempt - 1]);
      await assertCandidate(source, identity, expected);
    }
    if (!sameCandidate(await fs.lstat(parent), parentIdentity)) throw new Error('Snapshot publication parent changed');
    await assertAbsent(destination);
    try { await fs.rename(source, destination); return; }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EBUSY'].includes(error.code) || attempt === waits.length) throw error;
    }
  }
}

export async function publishSnapshot({ root, stagingDirectory, historyDirectory = path.join(root, 'local-reports', 'snapshot-history'), now = Date.now }) {
  if (!root || !stagingDirectory) throw new TypeError('root and stagingDirectory are required');
  const absoluteRoot = path.resolve(root);
  const entries = await collectJsonFiles(path.resolve(stagingDirectory));
  const contentDigest = sha256(Buffer.from(entries.map(({ logicalPath, bytes }) => `${logicalPath}\0${sha256(bytes)}`).join('\n')));
  const pointerPath = path.join(absoluteRoot, 'snapshot-current.json');
  let current = null;
  try { current = JSON.parse(await fs.readFile(pointerPath, 'utf8')); } catch {}
  const currentDirectory = typeof current?.currentdir === 'string' && /^public-snapshots[1-9]\d*$/.test(current.currentdir)
    ? current.currentdir
    : null;
  const currentIndex = currentDirectory ? await readIndex(path.join(absoluteRoot, currentDirectory)) : null;
  if (currentIndex && await matchesPublished(entries, currentIndex, path.join(absoluteRoot, currentDirectory))) {
    return { changed: false, generation: currentIndex.generation, directory: currentDirectory, contentDigest };
  }

  let maxGeneration = Number.isSafeInteger(current?.generation) ? current.generation : 0;
  for (const name of await fs.readdir(absoluteRoot).catch(() => [])) {
    const match = /^public-snapshots([1-9]\d*)$/.exec(name);
    if (match) maxGeneration = Math.max(maxGeneration, Number(match[1]));
  }
  const generation = maxGeneration + 1;
  const directoryName = `public-snapshots${generation}`;
  const finalDirectory = path.join(absoluteRoot, directoryName);
  const stagingPublish = path.join(absoluteRoot, `.${directoryName}.${process.pid}.tmp`);
  const files = {};
  const expected = new Map();
  const remember = (name, bytes) => expected.set(name, {bytes: bytes.byteLength, sha256: sha256(bytes)});
  let candidateIdentity = null;
  try {
    await fs.mkdir(stagingPublish, { recursive: false });
    candidateIdentity = await fs.lstat(stagingPublish);
    for (let i = 0; i < entries.length; i += 1) {
      const { logicalPath, bytes } = entries[i];
      const payload = `snapshot-${String(i + 1).padStart(4, '0')}.bin`;
      const encoded = xorBytes(await gzipAsync(bytes, { level: 9, mtime: 0 }));
      if (encoded.byteLength > MAX_FILE_BYTES) throw new RangeError(`${logicalPath} encoded file exceeds ${MAX_FILE_BYTES} bytes`);
      await fs.writeFile(path.join(stagingPublish, payload), encoded, { flag: 'wx' });
      const payloadHash = sha256(encoded);
      const payloadName = `${payloadHash}.bin`;
      await fs.rename(path.join(stagingPublish, payload), path.join(stagingPublish, payloadName));
      expected.set(payloadName, {bytes: encoded.byteLength, sha256: payloadHash});
      files[logicalPath] = { path: payloadName, sha256: payloadHash, decodedBytes: bytes.byteLength };
    }
    const publishedAt=now();if(!Number.isSafeInteger(publishedAt)||publishedAt<=0||publishedAt>8640000000000000)throw Error('Invalid snapshot package publication time');
    const index = { schemaVersion: 1, generation, publishedAt, encoding: 'gzip-xor-a7-v1', lookupShardsVersion: 1, files };
    await writeSnapshotLookupShards(index, stagingPublish);
    for (const [bucket, shard] of buildSnapshotLookupShards(index)) {
      remember(`lookup-shards/${bucket}.json`, Buffer.from(JSON.stringify(shard) + '\n'));
    }
    const indexBytes = Buffer.from(`${JSON.stringify(index)}\n`, 'utf8');
    if (indexBytes.byteLength > MAX_FILE_BYTES) throw new RangeError(`index.json exceeds ${MAX_FILE_BYTES} bytes`);
    await fs.writeFile(path.join(stagingPublish, 'index.json'), indexBytes, { flag: 'wx' });
    remember('index.json', indexBytes);
    if (entries.some(entry => entry.logicalPath === 'snapshot-paging.json')) {
      const bootstrapBytes = Buffer.from(`${JSON.stringify(buildSnapshotBootstrapIndex(index))}\n`, 'utf8');
      if (bootstrapBytes.byteLength > MAX_DECODED_BYTES) throw new RangeError('bootstrap-index.json exceeds compact index limit');
      await fs.writeFile(path.join(stagingPublish, 'bootstrap-index.json'), bootstrapBytes, { flag: 'wx' });
      remember('bootstrap-index.json', bootstrapBytes);
      const fastBytes = Buffer.from(JSON.stringify(buildSnapshotFastIndex(index)) + '\n');
      await fs.writeFile(path.join(stagingPublish, 'bootstrap-fast.json'), fastBytes, { flag: 'wx' });
      remember('bootstrap-fast.json', fastBytes);
    }

    let archivePath = null;
    if (currentDirectory && currentIndex) {
      const previousPath = path.join(absoluteRoot, currentDirectory);
      archivePath = await archiveGeneration(previousPath, path.resolve(historyDirectory), currentIndex.generation);
    }
    await renameGeneration(stagingPublish, finalDirectory, candidateIdentity, expected);
    const pointer = Buffer.from(`${JSON.stringify({ currentdir: directoryName }, null, 2)}\n`, 'utf8');
    const pointerTemp = `${pointerPath}.${process.pid}.tmp`;
    await fs.writeFile(pointerTemp, pointer, { flag: 'wx' });
    await fs.rename(pointerTemp, pointerPath);
    return { changed: true, generation, directory: directoryName, contentDigest, archivePath };
  } catch (error) {
    // Do not remove a pre-existing or replaced candidate owned by another run.
    if (candidateIdentity && path.dirname(stagingPublish) === absoluteRoot) {
      const currentCandidate = await fs.lstat(stagingPublish).catch(() => null);
      if (currentCandidate && sameCandidate(currentCandidate, candidateIdentity)) {
        await fs.rm(stagingPublish, { recursive: true, force: true }).catch(() => {});
      }
    }
    throw error;
  }
}
