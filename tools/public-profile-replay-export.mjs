import crypto from 'node:crypto';
import {compactExportCheckpoint} from './export-checkpoint.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {publicDisplayName} from './public-display-name.mjs';
import {publicOverallBackup,publicEventBackup,publicEventReplayBackup} from './public-snapshot-backup.mjs';
import {publicEventPlaybackForPublication} from './public-event-playback.mjs';
import {validatePublicReplayForPublication as validatePublicReplayStructure,hasPlayablePublicReplayStatus} from './public-replay-playback.mjs';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const PROFILE_COLLECTION = '0.6.2_profiles_public';
const RACE_COLLECTION = '0.6.2_race_results';
const PROFILE_FIELDS = ['name', 'nickname', 'countryCode', 'profileCosmetics', 'accountCreatedAt',
  'totalPlaytimeMs', 'pbCount', 'latestPbAt', 'updatedAt', 'carStyle', 'carColors'];
const COSMETICS = ['version', 'theme', 'accent', 'finish', 'plate', 'edge', 'stageTint', 'stage',
  'stageEffect', 'stripe', 'emblem', 'emblem2', 'emblem3', 'emblemBackdrop', 'nameFont', 'nameSize',
  'nameWeight', 'nameColor', 'baseSecondary', 'title', 'badge', 'favoriteTrackId', 'overridePodium'];
const RACE_FIELDS = ['accountId', 'trackId', 'name', 'nickname', 'countryCode', 'timeMs', 'frames',
  'raceTimeFrames', 'uploadId', 'verified', 'verifiedState', 'createdAt', 'pbAt', 'updatedAt', 'carStyle',
  'replay', 'replayHash', 'ingestedAt'];
const MAX_DOCUMENTS_PER_RUN = 2000;
const BATCH_GET_SIZE = 20;
const EVENT_REUSE_LIMITS = Object.freeze({records:2000,boards:120,bytes:16*1024*1024});
const MAX_RETRY_DELAY_MS = 86400000;
const MAX_FAILURE_ATTEMPTS = 32;
const DETERMINISTIC_FAILURES = new Set(['missing', 'binding-mismatch', 'upload-conflict', 'output-too-large']);
const FAILURE_REASONS = new Set([...DETERMINISTIC_FAILURES, 'batch-response-mismatch']);
const BINDING_MISMATCH_REASONS = new Set(['source-status', 'source-not-pending', 'account-track-upload', 'time',
  'frames', 'replay-hash', 'replay-size', 'car-style', 'replay-digest', 'replay-structure']);
const failureAttempts = record => Number.isSafeInteger(record?.attempts) && record.attempts > 0
  ? Math.min(MAX_FAILURE_ATTEMPTS, record.attempts) : 1;
const retryDelay = (record, baseMs) => Math.min(MAX_RETRY_DELAY_MS, baseMs * 2 ** (failureAttempts(record) - 1));
const ACCOUNT_ID = /^[a-f0-9]{64}$/;
const TRACK_ID = /^[a-f0-9]{64}$/;
const HASH = /^[a-f0-9]{64}$/;

const SERVER_INGESTION_SOURCE = 'firestore-server-timestamp';
function serverIngestionDate(value, source) {
  if (!(Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000)) {
    if (typeof value !== 'string') return {};
    const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
    const seconds = match && Date.parse(`${match[1]}Z`);
    if (!Number.isFinite(seconds) || Date.parse(value) <= 0 ||
        new Date(seconds).toISOString().slice(0, 19) !== match[1]) return {};
  }
  // Preserve Firestore sub-millisecond precision; never substitute PB/client dates.
  return {ingestedAt: value, ...(source === SERVER_INGESTION_SOURCE ? {ingestedAtSource: source} : {})};
}

function decodeValue(value, depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 12) throw Error('Invalid Firestore value');
  const keys = Object.keys(value);
  if (keys.length !== 1) throw Error('Ambiguous Firestore value');
  const [type] = keys;
  const raw = value[type];
  switch (type) {
    case 'nullValue': return null;
    case 'booleanValue': if (typeof raw !== 'boolean') break; return raw;
    case 'stringValue': if (typeof raw !== 'string') break; return raw;
    case 'integerValue': {
      if (!(typeof raw === 'string' && /^-?(?:0|[1-9]\d*)$/.test(raw))) break;
      const number = Number(raw); if (Number.isSafeInteger(number)) return number; break;
    }
    case 'doubleValue': if (typeof raw === 'number' && Number.isFinite(raw)) return raw; break;
    case 'timestampValue': if (typeof raw === 'string' && Number.isFinite(Date.parse(raw))) return raw; break;
    case 'referenceValue': if (typeof raw === 'string') return raw; break;
    case 'arrayValue': {
      const values = raw?.values || [];
      if (!Array.isArray(values) || values.length > 10000) break;
      return values.map(item => decodeValue(item, depth + 1));
    }
    case 'mapValue': {
      const fields = raw?.fields || {};
      if (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).length > 256) break;
      return Object.fromEntries(Object.entries(fields).map(([key, item]) => [key, decodeValue(item, depth + 1)]));
    }
  }
  throw Error('Unsupported or invalid Firestore value');
}

function decodeDocument(document) {
  if (!document || typeof document.name !== 'string' || !document.fields || typeof document.fields !== 'object') throw Error('Invalid Firestore document');
  const fields = Object.fromEntries(Object.entries(document.fields).map(([key, value]) => [key, decodeValue(value)]));
  const id = document.name.split('/').at(-1);
  if (!id) throw Error('Invalid Firestore document name');
  return {id, fields};
}

async function atomicWrite(directory, relative, value) {
  const destination = path.join(directory, relative);
  const privateCheckpoint = relative === 'export-progress.json';
  const data = Buffer.from(`${JSON.stringify(privateCheckpoint ? compactExportCheckpoint(value) : value)}\n`, 'utf8');
  if (data.byteLength > (privateCheckpoint ? MAX_RESPONSE_BYTES : MAX_FILE_BYTES)) {
    if (privateCheckpoint) throw Error('Private export checkpoint exceeds its size limit');
    return false;
  }
  await fs.mkdir(path.dirname(destination), {recursive: true});
  const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, data, {flag: 'wx'});
    await fs.rename(temporary, destination);
  } catch (error) {
    try { await fs.unlink(temporary); } catch {}
    throw error;
  }
  return true;
}

function projectProfile(accountId, row) {
  const allowed = {};
  for (const field of PROFILE_FIELDS) if (Object.hasOwn(row, field)) allowed[field] = row[field];
  const projected = publicOverallBackup({updatedAt: 0, entries: [{userId: accountId, ...allowed}], trackSummaries: []}).snapshot.entries[0];
  const profile = {accountId, updatedAt: Number.isSafeInteger(row.updatedAt) && row.updatedAt >= 0 ? row.updatedAt : 0};
  for (const field of ['name', 'nickname', 'countryCode', 'carStyle', 'carColors']) {
    if (Object.hasOwn(allowed, field)) {
      const value = field === 'name' || field === 'nickname' ? publicDisplayName(allowed[field]) : projected[field];
      if (typeof value === 'string' && value.length <= 256) profile[field] = value;
    }
  }
  for (const field of ['accountCreatedAt', 'totalPlaytimeMs', 'pbCount', 'latestPbAt']) {
    if (Number.isFinite(row[field]) && row[field] >= 0) profile[field] = row[field];
  }
  const cosmetics = projected.profileCosmetics;
  if (cosmetics && typeof cosmetics === 'object' && !Array.isArray(cosmetics)) {
    profile.profileCosmetics = Object.fromEntries(COSMETICS.filter(key => Object.hasOwn(cosmetics, key)).flatMap(key => {
      const value = cosmetics[key];
      if (typeof value === 'string' && value.length <= 256) return [[key, value]];
      if (typeof value === 'number' && Number.isFinite(value)) return [[key, value]];
      if (typeof value === 'boolean') return [[key, value]];
      return [];
    }));
  }
  return profile;
}

function validRace(row) {
  const frames = row.frames ?? row.raceTimeFrames;
  return row.verified === true && ACCOUNT_ID.test(row.accountId || '') && TRACK_ID.test(row.trackId || '') &&
    Number.isSafeInteger(row.uploadId) && row.uploadId >= 1 && Number.isSafeInteger(row.timeMs) && row.timeMs > 0 &&
    Number.isSafeInteger(frames) && frames > 0 && frames <= 4000000 &&
    (row.frames === undefined || row.frames === frames) && (row.raceTimeFrames === undefined || row.raceTimeFrames === frames) &&
    typeof row.replay === 'string' && row.replay.length > 0 && Buffer.byteLength(row.replay, 'utf8') <= 850000 &&
    typeof row.carStyle === 'string' && row.carStyle.length <= 256 && HASH.test(row.replayHash || '') &&
    crypto.createHash('sha256').update(row.replay, 'utf8').digest('hex') === row.replayHash;
}

function queryBody(collection, fields, cursor, pageSize) {
  const structuredQuery = {from: [{collectionId: collection}],
    select: {fields: [...fields, '__name__'].map(fieldPath => ({fieldPath}))},
    orderBy: [{field: {fieldPath: '__name__'}, direction: 'ASCENDING'}], limit: pageSize};
  if (cursor) structuredQuery.startAt = {values: [{referenceValue: cursor}], before: false};
  return {structuredQuery};
}

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function safeBinding(entry, snapshotTrackId, includePendingReplays = false) {
  if (!hasPlayablePublicReplayStatus(entry)) return null;
  const playbackPending = includePendingReplays && entry?.runVerified === false && entry?.verified === false &&
    entry?.verifiedState === 0 && entry?.integrityVerified === true;
  if (!playbackPending && (entry?.runVerified !== true || entry?.integrityVerified !== true)) return null;
  const frames = entry.frames ?? entry.raceTimeFrames;
  if (!ACCOUNT_ID.test(entry.accountId || '') || !TRACK_ID.test(entry.trackId || '') || entry.trackId !== snapshotTrackId ||
      !Number.isSafeInteger(entry.uploadId) || entry.uploadId < 1 || !Number.isSafeInteger(frames) || frames < 1 || frames > 4000000 ||
      entry.frames !== undefined && entry.frames !== frames || entry.raceTimeFrames !== undefined && entry.raceTimeFrames !== frames ||
      !HASH.test(entry.replayHash || '')) return {invalid: true};
  const binding = {accountId: entry.accountId, trackId: entry.trackId, uploadId: entry.uploadId, frames, replayHash: entry.replayHash, playbackPending,
    promotionEligible: entry.runVerified === true && entry.integrityVerified === true &&
      entry.verified !== false && entry.verifiedState === 1,
    metadata: Object.fromEntries(['name', 'nickname', 'countryCode', 'carStyle', 'timeMs', 'createdAt', 'pbAt']
      .filter(key => Object.hasOwn(entry, key)).map(key => [key,
        ['name', 'nickname'].includes(key) ? publicDisplayName(entry[key]) : entry[key]]))};
  binding.signature = JSON.stringify([binding.accountId, binding.trackId, binding.uploadId, binding.frames, binding.replayHash]);
  return binding;
}

async function loadStagedBindings(directory, snapshotDirectory, includePendingReplays) {
  const candidates = [path.join(snapshotDirectory, 'staging', 'tracks'), path.join(snapshotDirectory, 'tracks'),
    path.join(moduleRoot, 'public-snapshots', 'tracks')];
  let trackDirectory;
  for (const candidate of [...new Set(candidates)]) {
    try { if ((await fs.stat(candidate)).isDirectory()) { trackDirectory = candidate; break; } } catch {}
  }
  if (!trackDirectory) throw Error('Staged public track snapshots were not found');
  const files = (await fs.readdir(trackDirectory)).filter(file => file.endsWith('.json')).sort();
  const bindings = new Map();
  const uploadOwners = new Map();
  const conflictedUploads = new Set();
  let invalid = 0;
  const fingerprint = crypto.createHash('sha256');
  fingerprint.update(trackDirectory);
  for (const file of files) {
    const filePath = path.join(trackDirectory, file);
    const bytes = await fs.readFile(filePath);
    if (bytes.byteLength > MAX_RESPONSE_BYTES) { invalid++; fingerprint.update(file).update('oversized'); continue; }
    fingerprint.update(file).update(bytes);
    let snapshot;
    try { snapshot = JSON.parse(bytes.toString('utf8')); } catch { invalid++; continue; }
    const snapshotTrackId = file.slice(0, -5);
    if (!TRACK_ID.test(snapshotTrackId) || snapshot?.trackId !== snapshotTrackId || !Array.isArray(snapshot.entries)) { invalid++; continue; }
    for (const entry of snapshot.entries) {
      const binding = safeBinding(entry, snapshotTrackId, includePendingReplays);
      if (!binding) continue;
      if (binding.invalid) { invalid++; continue; }
      const uploadOwner = uploadOwners.get(binding.uploadId);
      if (uploadOwner && uploadOwner !== binding.signature) {
        bindings.delete(uploadOwner);
        bindings.delete(binding.signature);
        conflictedUploads.add(binding.uploadId);
        continue;
      }
      if (conflictedUploads.has(binding.uploadId)) { bindings.delete(binding.signature); continue; }
      uploadOwners.set(binding.uploadId, binding.signature);
      const prior = bindings.get(binding.signature);
      if (prior && (prior.accountId !== binding.accountId || prior.trackId !== binding.trackId || prior.uploadId !== binding.uploadId)) {
        invalid++; continue;
      }
      bindings.set(binding.signature, binding);
    }
  }
  return {trackDirectory, bindings: [...bindings.values()].sort((a, b) => a.signature.localeCompare(b.signature)),
    fingerprint: fingerprint.digest('hex'), invalid};
}

function raceDocumentName(projectId, accountId, trackId) {
  return `projects/${projectId}/databases/(default)/documents/${RACE_COLLECTION}/${accountId}_${trackId}`;
}

function boundRaceMismatch(row, binding) {
  if (!hasPlayablePublicReplayStatus(row)) return 'source-status';
  if (binding.playbackPending && !(row.verified === false && row.verifiedState === 0)) return 'source-not-pending';
  if (row.accountId !== binding.accountId || row.trackId !== binding.trackId || row.uploadId !== binding.uploadId) return 'account-track-upload';
  if (!Number.isSafeInteger(row.timeMs) || row.timeMs <= 0 ||
      binding.metadata.timeMs !== undefined && row.timeMs !== binding.metadata.timeMs) return 'time';
  const frames = row.frames ?? row.raceTimeFrames;
  if (!Number.isSafeInteger(frames) || frames !== binding.frames ||
      row.frames !== undefined && row.frames !== binding.frames ||
      row.raceTimeFrames !== undefined && row.raceTimeFrames !== binding.frames) return 'frames';
  if (row.replayHash !== binding.replayHash || !HASH.test(row.replayHash || '')) return 'replay-hash';
  if (typeof row.replay !== 'string' || !row.replay.length || Buffer.byteLength(row.replay, 'utf8') > 850000) return 'replay-size';
  if (row.carStyle !== undefined && !(typeof row.carStyle === 'string' && row.carStyle.length <= 256)) return 'car-style';
  if (crypto.createHash('sha256').update(row.replay, 'utf8').digest('hex') !== binding.replayHash) return 'replay-digest';
  return null;
}

async function retireStaleCanonical(directory,binding) {
  const relative=`canonical/${binding.trackId}/${binding.accountId}.json`,file=path.join(directory,relative);
  let bytes,value;
  try{
    const info=await fs.lstat(file);
    if(!info.isFile()||info.isSymbolicLink()||info.size>MAX_FILE_BYTES)return false;
    bytes=await fs.readFile(file);value=JSON.parse(bytes);
  }catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)return false;throw error;}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  // Only retire an older binding owned by this exact account/track. Malformed
  // or foreign inputs remain fatal to the independent native input validator.
  const frames=value.frames??value.raceTimeFrames;
  if(value.accountId!==binding.accountId||value.trackId!==binding.trackId||
    !Number.isSafeInteger(value.uploadId)||value.uploadId<1||!Number.isSafeInteger(value.timeMs)||value.timeMs<1||
    !Number.isSafeInteger(frames)||frames<1||!HASH.test(value.replayHash||'')||
    !Number.isSafeInteger(binding.metadata.timeMs)||binding.metadata.timeMs<1)return false;
  if(value.uploadId===binding.uploadId&&value.timeMs===binding.metadata.timeMs&&frames===binding.frames&&value.replayHash===binding.replayHash)return false;
  const quarantine=path.join(directory,'.retired-canonical');
  await fs.mkdir(quarantine,{recursive:true});
  const stat=await fs.lstat(quarantine);
  if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Unsafe canonical quarantine');
  // Non-JSON quarantine bytes are not eligible for snapshot publication.
  const target=path.join(quarantine,crypto.createHash('sha256').update(bytes).digest('hex')+'.bin');
  try{await fs.writeFile(target,bytes,{flag:'wx',mode:0o600});}catch(error){
    if(error.code!=='EEXIST')throw error;
    const prior=await fs.lstat(target);
    if(!prior.isFile()||prior.isSymbolicLink()||prior.size!==bytes.length||!bytes.equals(await fs.readFile(target)))throw Error('Unsafe canonical quarantine target');
  }
  if(!bytes.equals(await fs.readFile(file)))throw Error('Canonical changed while retiring stale input');
  await fs.unlink(file);
  return true;
}

function savedRecordingMatches(replay, binding) {
  return hasPlayablePublicReplayStatus(replay) && replay.accountId === binding.accountId && replay.trackId === binding.trackId &&
    (replay.uploadId === undefined || replay.uploadId === binding.uploadId) &&
    (replay.timeMs === undefined || replay.timeMs === binding.metadata.timeMs) &&
    (replay.raceTimeFrames === undefined || replay.raceTimeFrames === binding.frames) &&
    replay.frames === binding.frames && replay.replayHash === binding.replayHash &&
    typeof replay.recording === 'string' && replay.recording.length > 0 && Buffer.byteLength(replay.recording, 'utf8') <= 850000 &&
    crypto.createHash('sha256').update(replay.recording, 'utf8').digest('hex') === binding.replayHash;
}

async function restorePendingCanonical(directory, binding, replay) {
  if (!binding.playbackPending || !Number.isSafeInteger(binding.metadata.timeMs) || binding.metadata.timeMs < 1 ||
      typeof binding.metadata.carStyle !== 'string' || binding.metadata.carStyle.length > 256 || replay.carStyle !== binding.metadata.carStyle ||
      replay.verifiedState !== 0 || replay.verified === true || replay.runVerified === true || replay.integrityVerified === false) return false;
  try {
    const root = await fs.realpath(directory), file = path.join(directory, 'recordings', binding.uploadId + '.json');
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES || !(await fs.realpath(file)).startsWith(root + path.sep)) return false;
    for (const relative of ['canonical', 'canonical/' + binding.trackId]) {
      const folder = path.join(directory, relative);
      let info; try { info = await fs.lstat(folder); } catch (error) { if (error.code === 'ENOENT') break; throw error; }
      if (!info.isDirectory() || info.isSymbolicLink() || !(await fs.realpath(folder)).startsWith(root + path.sep)) return false;
    }
    await validatePublicReplayStructure(replay.recording, binding.frames);
  } catch { return false; }
  // The current pending board binds existing bytes, not a verdict or an ingestion date.
  const canonical = {...binding.metadata, accountId: binding.accountId, trackId: binding.trackId,
    uploadId: binding.uploadId, timeMs: binding.metadata.timeMs, frames: binding.frames, raceTimeFrames: binding.frames,
    replayHash: binding.replayHash, carStyle: replay.carStyle,
    updatedAt: Number.isSafeInteger(replay.updatedAt) && replay.updatedAt >= 0 ? replay.updatedAt : 0,
    runVerified: false, integrityVerified: true, verified: false, verifiedState: 0,
    playbackPending: true, verificationStatus: 'pending', eventRpEligible: false};
  return atomicWrite(directory, `canonical/${binding.trackId}/${binding.accountId}.json`, canonical);
}

async function savedMatchExists(directory, binding) {
  let replay, canonical, canonicalMissing = false;
  try {
    replay = JSON.parse(await fs.readFile(path.join(directory, `recordings/${binding.uploadId}.json`), 'utf8'));
    if (!savedRecordingMatches(replay, binding)) return false;
    try { canonical = JSON.parse(await fs.readFile(path.join(directory, `canonical/${binding.trackId}/${binding.accountId}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') canonicalMissing = true; else throw error; }
  } catch { return false; }
  if (canonicalMissing) return restorePendingCanonical(directory, binding, replay);
  try {
    if (!hasPlayablePublicReplayStatus(canonical)) return false;
    const exact = canonical.accountId === binding.accountId && canonical.trackId === binding.trackId &&
      canonical.uploadId === binding.uploadId && canonical.frames === binding.frames &&
      (canonical.raceTimeFrames === undefined || canonical.raceTimeFrames === binding.frames) &&
      canonical.timeMs > 0 && Number.isSafeInteger(canonical.timeMs) &&
      (binding.metadata.timeMs === undefined || canonical.timeMs === binding.metadata.timeMs) &&
      canonical.integrityVerified === true && canonical.replayHash === binding.replayHash;
    if (!exact) return false;
    const pendingMarkers = [replay, canonical].some(row => row.playbackPending === true ||
      row.verificationStatus !== undefined && row.verificationStatus !== 'verified');
    if ((binding.playbackPending || !pendingMarkers) && replay.verifiedState === (binding.playbackPending ? 0 : 1) &&
        canonical.verified === !binding.playbackPending && canonical.runVerified === !binding.playbackPending &&
        (canonical.verifiedState === undefined || canonical.verifiedState === (binding.playbackPending ? 0 : 1))) return true;
    // Only the fresh public board authorizes a status change. Old status never
    // supplies proof; immutable bytes and canonical time must bind independently.
    const pending = canonical.verified === false && canonical.runVerified === false && canonical.verifiedState === 0;
    const verified = canonical.verified === true && canonical.runVerified === true && canonical.verifiedState === 1;
    if ((!binding.playbackPending && !binding.promotionEligible) || !Number.isSafeInteger(binding.metadata.timeMs) ||
        binding.metadata.timeMs < 1 || ![0, 1].includes(replay.verifiedState) || !pending && !verified) return false;
    if (binding.playbackPending && (typeof binding.metadata.carStyle !== 'string' || binding.metadata.carStyle.length > 256 ||
        replay.carStyle !== binding.metadata.carStyle || canonical.carStyle !== binding.metadata.carStyle)) return false;
    await validatePublicReplayStructure(replay.recording, binding.frames);
  } catch { return false; }
  const updatedAt = Number.isSafeInteger(replay.updatedAt) && replay.updatedAt >= 0 ? replay.updatedAt : 0;
  const carStyle = typeof replay.carStyle === 'string' && replay.carStyle.length <= 256 ? replay.carStyle : '';
  const verified = !binding.playbackPending, state = verified ? 1 : 0;
  const status = verified ? {} : {playbackPending:true, verificationStatus:'pending', eventRpEligible:false};
  const promotedReplay = {recording: replay.recording, frames: binding.frames, verifiedState: state, carStyle,
    accountId: binding.accountId, trackId: binding.trackId, replayHash: binding.replayHash, updatedAt, ...status};
  const promotedCanonical = {...binding.metadata, ...serverIngestionDate(canonical.ingestedAt, canonical.ingestedAtSource),
    accountId: binding.accountId, trackId: binding.trackId,
    timeMs: binding.metadata.timeMs, frames: binding.frames, raceTimeFrames: binding.frames, uploadId: binding.uploadId,
    replayHash: binding.replayHash, carStyle, updatedAt, runVerified: verified, integrityVerified: true,
    verified, verifiedState: state, ...status};
  // Each write is atomic; a stopped pair rewrite is revalidated and completed on resume.
  if (!await atomicWrite(directory, `recordings/${binding.uploadId}.json`, promotedReplay)) return false;
  return atomicWrite(directory, `canonical/${binding.trackId}/${binding.accountId}.json`, promotedCanonical);
}

function currentRaceState(bindings, fingerprint, invalid, previous) {
  // Retry state belongs to exact current bindings, not snapshot display metadata.
  // Revalidate all successful files below instead of trusting covered flags.
  const records = {};
  for (const binding of bindings) {
    const prior = previous?.records?.[binding.signature];
    if (prior?.available === false && FAILURE_REASONS.has(prior.reason) &&
        (!Object.hasOwn(prior, 'bindingTimeMs') || prior.bindingTimeMs === (binding.metadata.timeMs ?? null))) {
      records[binding.signature] = {signature: binding.signature, available: false, reason: prior.reason,
        checkedAt: Number.isSafeInteger(prior.checkedAt) && prior.checkedAt >= 0 ? prior.checkedAt : null,
        attempts: failureAttempts(prior), bindingTimeMs: binding.metadata.timeMs ?? null,
        ...(prior.reason === 'binding-mismatch' && BINDING_MISMATCH_REASONS.has(prior.mismatchReason)
          ? {mismatchReason: prior.mismatchReason} : {})};
    }
  }
  return {fingerprint, pending: [], covered: {}, records, invalid, responseInvalid: 0, known: bindings.length};
}

const eventReuseKey = binding => JSON.stringify([binding.accountId,binding.trackId,binding.metadata.timeMs,
  binding.frames,binding.replayHash,binding.metadata.carStyle]);

async function eventReplayReuseIndex(directory,bindings) {
  const index=new Map(),needed=new Set(bindings.filter(row=>row.playbackPending).map(eventReuseKey));
  const targets=new Set(bindings.filter(row=>row.playbackPending).map(row=>JSON.stringify([row.accountId,row.metadata.timeMs,row.replayHash])));
  let bytes=0,visited=0;const boards=new Map();
  const root=await fs.realpath(directory);
  const read=async relative=>{
    if(!/^(?:manifest\.json|events\/[A-Za-z0-9_-]{1,64}\.json|event-(?:playbacks|replays)\/[A-Za-z0-9_-]{1,64}\/[a-f0-9]{64}\.json)$/.test(relative))throw Error('Invalid public event cache path');
    const file=path.join(directory,...relative.split('/')),stat=await fs.lstat(file);
    const real=await fs.realpath(file);
    if(!stat.isFile()||stat.isSymbolicLink()||!real.startsWith(root+path.sep)||stat.size>MAX_FILE_BYTES||
        bytes+stat.size>EVENT_REUSE_LIMITS.bytes)throw Error('Public event cache read limit');
    const body=await fs.readFile(file);bytes+=body.length;
    if(body.length>MAX_FILE_BYTES||bytes>EVENT_REUSE_LIMITS.bytes)throw Error('Public event cache read limit');
    return JSON.parse(body.toString('utf8'));
  };
  let manifest;try{manifest=await read('manifest.json');}catch{return index;}
  if(manifest?.schemaVersion!==1)return index;
  for(const [lane,pending]of [['eventPlaybacks',true],['eventReplays',false]]){
    const records=manifest[lane];if(!records||typeof records!=='object'||Array.isArray(records))continue;
    for(const [relative,record]of Object.entries(records)){
      if(++visited>EVENT_REUSE_LIMITS.records||bytes>=EVENT_REUSE_LIMITS.bytes)return index;
      if(!record||record.path!==relative||!targets.has(JSON.stringify([record.accountId,record.timeMs,record.replayHash])))continue;
      const match=new RegExp(`^${pending?'event-playbacks':'event-replays'}/([A-Za-z0-9_-]{1,64})/([a-f0-9]{64})\\.json$`).exec(relative);
      if(!match||match[1]!==record.periodId||match[2]!==record[pending?'runId':'accountId'])continue;
      try{
        const id=match[1];let board=boards.get(id);
        if(!boards.has(id)){
          if(boards.size>=EVENT_REUSE_LIMITS.boards)return index;
          boards.set(id,null);
          if(manifest.events?.[id]?.path!==`events/${id}.json`)continue;
          const raw=await read(`events/${id}.json`);board=publicEventBackup(raw,id);
          if(!isDeepStrictEqual(raw,board)||manifest.events[id].updatedAt!==board.updatedAt)continue;
          boards.set(id,board);
        }
        if(!board||board.period?.id!==id||!TRACK_ID.test(board.period.trackId||'')||pending&&board.archived===true)continue;
        const entry=(pending?board.pendingPlaybacks:board.entries)?.find(row=>row.accountId===record.accountId&&
          row.timeMs===record.timeMs&&row.replayHash===record.replayHash&&HASH.test(row.runId||'')&&
          (!record.runId||record.runId===row.runId));
        if(!entry||!pending&&(entry.physicsVerified!==true||entry.replayIntegrityVerified!==true))continue;
        const raw=await read(relative);let value;
        if(pending)value=await publicEventPlaybackForPublication(raw,{periodId:id,trackId:board.period.trackId,entry});
        else{
          if(!hasPlayablePublicReplayStatus(raw)||raw.pending===true||raw.verified===false||raw.eventRpEligible===false)continue;
          value=publicEventReplayBackup({...raw,verificationStatus:'verified',verified:true,eventRpEligible:true},
            {periodId:id,trackId:board.period.trackId,entry});
        }
        if(!isDeepStrictEqual(raw,value)||value.frames!==value.timeMs||value.replayHash!==record.replayHash||
            value.accountId!==record.accountId||value.timeMs!==record.timeMs||entry.carStyle!==value.carStyle||
            entry.frames!==undefined&&entry.frames!==value.frames)continue;
        const structure=await validatePublicReplayStructure(value.replay,value.frames);
        if(structure?.indexedPlaybackWithinBudget===false)continue;
        const key=eventReuseKey({accountId:value.accountId,trackId:value.trackId,frames:value.frames,replayHash:value.replayHash,
          metadata:{timeMs:value.timeMs,carStyle:value.carStyle}});
        if(needed.has(key))index.set(key,value);
      }catch{ /* Untrusted, oversized or changed public cache is not a reuse source. */ }
    }
  }
  return index;
}

async function reuseEventReplay(directory,binding,index) {
  if(!binding.playbackPending||!Number.isSafeInteger(binding.metadata.timeMs)||binding.metadata.timeMs<1||
      typeof binding.metadata.carStyle!=='string'||binding.metadata.carStyle.length>256)return false;
  const cached=index.get(eventReuseKey(binding));if(!cached)return false;
  const replayPath=`recordings/${binding.uploadId}.json`,canonicalPath=`canonical/${binding.trackId}/${binding.accountId}.json`;
  const read=async relative=>{
    try{const stat=await fs.lstat(path.join(directory,relative));if(!stat.isFile()||stat.size>MAX_FILE_BYTES)throw Error('Invalid normal cache');
      return JSON.parse(await fs.readFile(path.join(directory,relative),'utf8'));}
    catch(error){if(error.code==='ENOENT')return null;throw error;}
  };
  let savedIngestionDate = {};
  try{
    const replay=await read(replayPath),canonical=await read(canonicalPath);
    if(replay&&canonical)return false;
    if(replay&&(!hasPlayablePublicReplayStatus(replay)||replay.accountId!==binding.accountId||replay.trackId!==binding.trackId||
        replay.frames!==binding.frames||replay.replayHash!==binding.replayHash||replay.recording!==cached.replay||
        replay.carStyle!==cached.carStyle||replay.verifiedState!==0||replay.verified===true||
        replay.uploadId!==undefined&&replay.uploadId!==binding.uploadId||
        replay.timeMs!==undefined&&replay.timeMs!==binding.metadata.timeMs||
        replay.raceTimeFrames!==undefined&&replay.raceTimeFrames!==binding.frames))return false;
    if(canonical&&(!hasPlayablePublicReplayStatus(canonical)||canonical.accountId!==binding.accountId||canonical.trackId!==binding.trackId||
        canonical.uploadId!==binding.uploadId||canonical.frames!==binding.frames||canonical.timeMs!==binding.metadata.timeMs||
        canonical.replayHash!==binding.replayHash||canonical.carStyle!==cached.carStyle||canonical.verified!==false||
        canonical.runVerified!==false||canonical.verifiedState!==0||canonical.integrityVerified!==true||
        canonical.raceTimeFrames!==undefined&&canonical.raceTimeFrames!==binding.frames))return false;
    savedIngestionDate = serverIngestionDate(canonical?.ingestedAt, canonical?.ingestedAtSource);
  }catch{return false;}
  const updatedAt=[cached.submittedAt,cached.pbAt,cached.createdAt].find(value=>Number.isSafeInteger(value)&&value>=0)??0;
  const status={playbackPending:true,verificationStatus:'pending',eventRpEligible:false};
  const recording={recording:cached.replay,frames:binding.frames,verifiedState:0,carStyle:cached.carStyle,
    accountId:binding.accountId,trackId:binding.trackId,replayHash:binding.replayHash,updatedAt,...status};
  const canonical={...binding.metadata,...savedIngestionDate,accountId:binding.accountId,trackId:binding.trackId,uploadId:binding.uploadId,
    timeMs:binding.metadata.timeMs,frames:binding.frames,raceTimeFrames:binding.frames,replayHash:binding.replayHash,
    carStyle:cached.carStyle,updatedAt,runVerified:false,integrityVerified:true,verified:false,verifiedState:0,...status};
  if(!await atomicWrite(directory,replayPath,recording))return false;
  return atomicWrite(directory,canonicalPath,canonical);
}

export async function exportPublicProfilesAndReplays({fetchImpl = fetch, directory, projectId = 'polytrack-052', maxDocuments = 2000,
  pageSize = 100, log = () => {}, fullSnapshot = false, includeProfiles = true, snapshotDirectory = directory,
  retryInvalidAfterMs = 3600000, now = Date.now(), includePendingReplays = false, trustServerIngestedAt = false} = {}) {
  if (typeof fetchImpl !== 'function' || typeof directory !== 'string' || !directory || typeof snapshotDirectory !== 'string' ||
      !Number.isSafeInteger(maxDocuments) || maxDocuments < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 ||
      typeof includeProfiles !== 'boolean' || typeof includePendingReplays !== 'boolean' || typeof trustServerIngestedAt !== 'boolean' || fullSnapshot && !includeProfiles ||
      !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(retryInvalidAfterMs) || retryInvalidAfterMs < 0 || retryInvalidAfterMs > 86400000 ||
      typeof projectId !== 'string' || !/^[a-z][a-z0-9-]{4,62}[a-z0-9]$/.test(projectId)) throw Error('Invalid public export options');
  maxDocuments = Math.min(maxDocuments, MAX_DOCUMENTS_PER_RUN);
  await fs.mkdir(directory, {recursive: true});
  const progressPath = path.join(directory, 'export-progress.json');
  let previous = {};
  try { previous = JSON.parse(await fs.readFile(progressPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  let savedSummary = {};
  if (!includeProfiles) {
    try { savedSummary = JSON.parse(await fs.readFile(path.join(directory, 'public-export-summary.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  }
  const progress = {schemaVersion: 2, projectId,
    profiles: {cursor: fullSnapshot ? null : previous.profiles?.cursor ?? previous.cursors?.profiles ?? null,
      complete: fullSnapshot ? false : previous.profiles?.complete ?? previous.complete?.profiles === true,
      scanned: fullSnapshot ? 0 : previous.profiles?.scanned ?? previous.scanned ?? 0,
      ids: fullSnapshot ? [] : previous.profiles?.ids ?? []},
    profileCount: fullSnapshot ? 0 : previous.profileCount ?? previous.counts?.profiles ?? savedSummary.counts?.profiles ?? 0,
    profileSkipped: fullSnapshot ? 0 : previous.profileSkipped ?? 0,
    fullSnapshotPending: fullSnapshot || previous.fullSnapshotPending === true,
    raceExport: null};
  const staged = await loadStagedBindings(directory, snapshotDirectory, includePendingReplays);
  const race = currentRaceState(staged.bindings, staged.fingerprint, staged.invalid, previous.raceExport);
  // Profile checkpoints must retain replay retry history even if a later request fails.
  progress.raceExport = race;
  let usedThisRun = 0, budgetReached = false, incompletePage = false;
  const base = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents`;
  if (includeProfiles && !progress.profiles.complete) {
    while (usedThisRun < maxDocuments) {
      const limit = Math.min(pageSize, maxDocuments - usedThisRun);
      const response = await fetchImpl(`${base}:runQuery`, {method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify(queryBody(PROFILE_COLLECTION, PROFILE_FIELDS, progress.profiles.cursor, limit)), signal: AbortSignal.timeout(12000)});
      if (!response?.ok) throw Error(`Firestore public profile query failed (${response?.status || 'unknown'})`);
      const body = await response.text();
      if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) throw Error('Firestore response exceeds byte limit');
      let page; try { page = JSON.parse(body); } catch { throw Error('Invalid Firestore query JSON'); }
      if (!Array.isArray(page) || page.length > limit) throw Error('Invalid Firestore query page');
      if (page.length && page.every(item => !item?.document && typeof item?.readTime === 'string') || page.length === 0) {
        progress.profiles.complete = true; break;
      }
      if (page.some(item => !item?.document)) throw Error('Firestore query row has no document cursor');
      let cursor = progress.profiles.cursor;
      for (const item of page) {
        const prefix = `projects/${projectId}/databases/(default)/documents/${PROFILE_COLLECTION}/`;
        const name = item.document.name;
        if (typeof name !== 'string' || !name.startsWith(prefix) || name.slice(prefix.length).includes('/') || cursor && name <= cursor) {
          throw Error('Firestore document name is outside the ordered profile query');
        }
        cursor = name;
        let profile;
        try {
          const decoded = decodeDocument(item.document);
          if (!ACCOUNT_ID.test(decoded.id)) progress.profileSkipped++;
          else profile = projectProfile(decoded.id, decoded.fields);
        } catch { progress.profileSkipped++; }
        if (profile) {
          let written;
          try { written = await atomicWrite(directory, `profiles/${profile.accountId}.json`, profile); }
          catch (error) {
            // Retain the saved prefix, but never checkpoint past a failed write.
            await atomicWrite(directory, 'export-progress.json', progress);
            throw error;
          }
          if (written) {
            progress.profileCount++;
            if (!progress.profiles.ids.includes(profile.accountId)) progress.profiles.ids.push(profile.accountId);
          }
          else progress.profileSkipped++;
        }
        progress.profiles.cursor = name;
        progress.profiles.scanned++;
        usedThisRun++;
      }
      if (page.length < limit) progress.profiles.complete = true;
      else if (usedThisRun >= maxDocuments) { budgetReached = true; incompletePage = true; }
      await atomicWrite(directory, 'export-progress.json', progress);
      if (progress.profiles.complete) break;
      if (budgetReached) break;
    }
  }

  const bindingBySignature = new Map(staged.bindings.map(binding => [binding.signature, binding]));
  const deferredBindings = new Set();
  const savedBindings = new Set(), unresolvedBindings = [];
  for (const binding of staged.bindings) {
    if (await savedMatchExists(directory, binding)) savedBindings.add(binding.signature);
    else unresolvedBindings.push(binding);
  }
  // Do not spend the bounded event-cache reads on already reusable normal pairs.
  let eventReuseIndex;
  for (const binding of staged.bindings) {
    const signature = binding.signature;
    let available=savedBindings.has(signature);
    if(!available&&binding.playbackPending){
      eventReuseIndex??=eventReplayReuseIndex(directory,unresolvedBindings);
      available=await reuseEventReplay(directory,binding,await eventReuseIndex);
    }
    if (available) {
      race.records[signature] = {signature, available: true, replayPath: `recordings/${binding.uploadId}.json`,
        canonicalPath: `canonical/${binding.trackId}/${binding.accountId}.json`};
      race.covered[signature] = true;
    } else {
      const failure = race.records[signature];
      if (DETERMINISTIC_FAILURES.has(failure?.reason) && Number.isSafeInteger(failure.checkedAt) && failure.checkedAt <= now &&
          now - failure.checkedAt < retryDelay(failure, retryInvalidAfterMs)) deferredBindings.add(signature);
      delete race.covered[signature];
    }
  }
  race.pending = staged.bindings.map(binding => binding.signature).filter(signature => !race.covered[signature] && !deferredBindings.has(signature))
    .sort((a, b) => Number(!!race.records[a]) - Number(!!race.records[b]) ||
      (race.records[a]?.checkedAt ?? 0) - (race.records[b]?.checkedAt ?? 0) || a.localeCompare(b));
  progress.raceExport = race;
  await atomicWrite(directory, 'export-progress.json', progress);
  while (race.pending.length && usedThisRun < maxDocuments) {
    const count = Math.min(BATCH_GET_SIZE, pageSize, maxDocuments - usedThisRun, race.pending.length);
    const signatures = race.pending.slice(0, count);
    const batchBindings = signatures.map(signature => bindingBySignature.get(signature));
    const names = batchBindings.map(binding => raceDocumentName(projectId, binding.accountId, binding.trackId));
    const response = await fetchImpl(`${base}:batchGet`, {method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({documents: names, mask: {fieldPaths: RACE_FIELDS}}), signal: AbortSignal.timeout(12000)});
    if (!response?.ok) throw Error(`Firestore public batchGet failed (${response?.status || 'unknown'})`);
    const body = await response.text();
    if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) throw Error('Firestore response exceeds byte limit');
    let rows; try { rows = JSON.parse(body); } catch { throw Error('Invalid Firestore batchGet JSON'); }
    if (!Array.isArray(rows)) throw Error('Invalid Firestore batchGet response');
    const byName = new Map();
    for (const result of rows) {
      const name = result?.found?.name || result?.missing;
      if (typeof name !== 'string' || !names.includes(name) || byName.has(name) ||
          !!result.found === (typeof result.missing === 'string')) { race.responseInvalid++; continue; }
      byName.set(name, result);
    }
    for (let index = 0; index < batchBindings.length; index++) {
      const binding = batchBindings[index], name = names[index], signature = binding.signature;
      const priorFailure = race.records[signature];
      const result = byName.get(name);
      if (!result || result.missing === name) {
        race.records[signature] = {signature, available: false,
          reason: !result ? 'batch-response-mismatch' : 'missing'};
      } else {
        let row;
        try { row = decodeDocument(result.found).fields; } catch { row = null; }
        const mismatchReason = row ? boundRaceMismatch(row, binding) : null;
        let structureValid = true;
        if (row && !mismatchReason && binding.playbackPending) {
          try { await validatePublicReplayStructure(row.replay, binding.frames); } catch { structureValid = false; }
        }
        if (!row || mismatchReason || !structureValid) {
          race.records[signature] = {signature, available: false, reason: row ? 'binding-mismatch' : 'batch-response-mismatch',
            ...(row ? {mismatchReason: mismatchReason || 'replay-structure'} : {})};
        } else {
          const updatedAt = [row.updatedAt, row.pbAt, row.createdAt, binding.metadata.pbAt, binding.metadata.createdAt]
            .find(value => Number.isSafeInteger(value) && value >= 0) ?? 0;
          const replay = {recording: row.replay, frames: binding.frames, verifiedState: binding.playbackPending ? 0 : 1,
            carStyle: row.carStyle ?? binding.metadata.carStyle ?? '', accountId: binding.accountId,
            trackId: binding.trackId, replayHash: binding.replayHash, updatedAt};
          // A REST timestamp discriminator is necessary, but rules must also forbid
          // client backdating. Only a trusted caller's explicit rule gate stamps origin.
          const rawIngestedAt = result.found.fields.ingestedAt;
          const ingestionDate = typeof rawIngestedAt?.timestampValue === 'string'
            ? serverIngestionDate(rawIngestedAt.timestampValue, trustServerIngestedAt ? SERVER_INGESTION_SOURCE : undefined) : {};
          const canonical = {...binding.metadata, ...ingestionDate,
            accountId: binding.accountId, trackId: binding.trackId,
            timeMs: row.timeMs, frames: binding.frames, raceTimeFrames: binding.frames, uploadId: binding.uploadId,
            replayHash: binding.replayHash, carStyle: row.carStyle ?? binding.metadata.carStyle ?? '', updatedAt,
            runVerified: !binding.playbackPending, integrityVerified: true, verified: !binding.playbackPending,
            verifiedState: binding.playbackPending ? 0 : 1};
          if (binding.playbackPending) {
            replay.playbackPending = canonical.playbackPending = true;
            replay.verificationStatus = canonical.verificationStatus = 'pending';
            replay.eventRpEligible = canonical.eventRpEligible = false;
          }
          const replayPath = `recordings/${binding.uploadId}.json`;
          const canonicalPath = `canonical/${binding.trackId}/${binding.accountId}.json`;
          let conflict = false;
          try {
            const prior = JSON.parse(await fs.readFile(path.join(directory, replayPath), 'utf8'));
            conflict = prior.accountId !== binding.accountId || prior.trackId !== binding.trackId || prior.replayHash !== binding.replayHash;
          } catch (error) { if (error.code !== 'ENOENT') conflict = true; }
          if (conflict) race.records[signature] = {signature, available: false, reason: 'upload-conflict'};
          else {
            const replayWritten = await atomicWrite(directory, replayPath, replay);
            const canonicalWritten = await atomicWrite(directory, canonicalPath, canonical);
            race.records[signature] = replayWritten && canonicalWritten
              ? {signature, available: true, replayPath, canonicalPath}
              : {signature, available: false, reason: 'output-too-large'};
          }
        }
      }
      if (race.records[signature]?.available) race.covered[signature] = true;
      else {
        delete race.covered[signature];
        Object.assign(race.records[signature], {checkedAt: now, bindingTimeMs: binding.metadata.timeMs ?? null,
          attempts: priorFailure ? Math.min(MAX_FAILURE_ATTEMPTS, failureAttempts(priorFailure) + 1) : 1});
      }
      usedThisRun++;
    }
    race.pending = race.pending.slice(count);
    await atomicWrite(directory, 'export-progress.json', progress);
  }
  if (usedThisRun >= maxDocuments && (!progress.profiles.complete || race.pending.length)) budgetReached = true;
  incompletePage ||= budgetReached && race.pending.length > 0;
  if (progress.fullSnapshotPending && progress.profiles.complete && progress.profileSkipped === 0) {
    const profileDirectory = path.join(directory, 'profiles');
    const keep = new Set(progress.profiles.ids);
    for (const file of await fs.readdir(profileDirectory).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))) {
      const match = /^([a-f0-9]{64})\.json$/.exec(file);
      if (match && !keep.has(match[1])) await fs.unlink(path.join(profileDirectory, file));
    }
    progress.fullSnapshotPending = false;
  }
  let retiredCanonical=0;
  for(const binding of staged.bindings)if(!race.records[binding.signature]?.available&&await retireStaleCanonical(directory,binding))retiredCanonical++;
  progress.raceExport = race;
  await atomicWrite(directory, 'export-progress.json', progress);
  const records = Object.values(race.records);
  const available = records.filter(record => record.available).length;
  const missing = records.filter(record => record.reason === 'missing').length;
  const bindingMismatchReasons = {};
  for (const record of records) if (record.reason === 'binding-mismatch') {
    const reason = BINDING_MISMATCH_REASONS.has(record.mismatchReason) ? record.mismatchReason : 'legacy-unspecified';
    bindingMismatchReasons[reason] = (bindingMismatchReasons[reason] || 0) + 1;
  }
  const recordInvalid = records.filter(record =>
    ['binding-mismatch', 'batch-response-mismatch', 'upload-conflict', 'output-too-large'].includes(record.reason)).length;
  const invalid = staged.invalid + Math.max(race.responseInvalid, recordInvalid);
  const scanComplete = progress.profiles.complete && race.pending.length === 0;
  const coverageComplete = scanComplete && missing === 0 && invalid === 0 && available === race.known && progress.profileSkipped === 0;
  const replayCoverageComplete = race.pending.length === 0 && missing === 0 && invalid === 0 && available === race.known;
  const result = {counts: {profiles: progress.profileCount, canonical: available, recordings: available, missing,
      skipped: progress.profileSkipped + invalid}, scanned: progress.profiles.scanned + records.length,
    fetchedDocumentsThisRun: usedThisRun, knownVerifiedBindings: race.known, retiredCanonical,
    deferredBindingRetries: deferredBindings.size, bindingMismatchReasons,
    totalCoverage: {available, missing, invalid, complete: replayCoverageComplete,
      scope: 'current-staged-track-snapshots'}, scanComplete, complete: coverageComplete, budgetReached, incompletePage};
  log(JSON.stringify({publicProfileReplayExport: result}));
  return result;
}

// Shared public allowlist for bounded incremental profile captures.
export {projectProfile as projectCapturedPublicProfile};
