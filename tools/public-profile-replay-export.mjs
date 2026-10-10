import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {publicDisplayName} from './public-display-name.mjs';
import {publicOverallBackup} from './public-snapshot-backup.mjs';

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
  'replay', 'replayHash'];
const MAX_DOCUMENTS_PER_RUN = 2000;
const BATCH_GET_SIZE = 20;
const ACCOUNT_ID = /^[a-f0-9]{64}$/;
const TRACK_ID = /^[a-f0-9]{64}$/;
const HASH = /^[a-f0-9]{64}$/;

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
  const data = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  if (data.byteLength > MAX_FILE_BYTES) return false;
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

function safeBinding(entry, snapshotTrackId) {
  if (entry?.runVerified !== true || entry?.integrityVerified !== true) return null;
  const frames = entry.frames ?? entry.raceTimeFrames;
  if (!ACCOUNT_ID.test(entry.accountId || '') || !TRACK_ID.test(entry.trackId || '') || entry.trackId !== snapshotTrackId ||
      !Number.isSafeInteger(entry.uploadId) || entry.uploadId < 1 || !Number.isSafeInteger(frames) || frames < 1 || frames > 4000000 ||
      entry.frames !== undefined && entry.frames !== frames || entry.raceTimeFrames !== undefined && entry.raceTimeFrames !== frames ||
      !HASH.test(entry.replayHash || '')) return {invalid: true};
  const binding = {accountId: entry.accountId, trackId: entry.trackId, uploadId: entry.uploadId, frames, replayHash: entry.replayHash,
    metadata: Object.fromEntries(['name', 'nickname', 'countryCode', 'carStyle', 'timeMs', 'createdAt', 'pbAt']
      .filter(key => Object.hasOwn(entry, key)).map(key => [key,
        ['name', 'nickname'].includes(key) ? publicDisplayName(entry[key]) : entry[key]]))};
  binding.signature = JSON.stringify([binding.accountId, binding.trackId, binding.uploadId, binding.frames, binding.replayHash]);
  return binding;
}

async function loadStagedBindings(directory, snapshotDirectory) {
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
      if (entry?.runVerified !== true || entry?.integrityVerified !== true) continue;
      const binding = safeBinding(entry, snapshotTrackId);
      if (!binding) { invalid++; continue; }
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

function validBoundRace(row, binding) {
  const frames = row.frames ?? row.raceTimeFrames;
  return row.accountId === binding.accountId && row.trackId === binding.trackId && row.uploadId === binding.uploadId &&
    Number.isSafeInteger(row.timeMs) && row.timeMs > 0 && Number.isSafeInteger(frames) && frames === binding.frames &&
    (row.frames === undefined || row.frames === binding.frames) &&
    (row.raceTimeFrames === undefined || row.raceTimeFrames === binding.frames) &&
    row.replayHash === binding.replayHash && HASH.test(row.replayHash || '') && typeof row.replay === 'string' &&
    row.replay.length > 0 && Buffer.byteLength(row.replay, 'utf8') <= 850000 &&
    (row.carStyle === undefined || typeof row.carStyle === 'string' && row.carStyle.length <= 256) &&
    crypto.createHash('sha256').update(row.replay, 'utf8').digest('hex') === binding.replayHash;
}

async function savedMatchExists(directory, binding) {
  try {
    const replay = JSON.parse(await fs.readFile(path.join(directory, `recordings/${binding.uploadId}.json`), 'utf8'));
    const canonical = JSON.parse(await fs.readFile(path.join(directory, `canonical/${binding.trackId}/${binding.accountId}.json`), 'utf8'));
    return replay.accountId === binding.accountId && replay.trackId === binding.trackId &&
      replay.frames === binding.frames && replay.verifiedState === 1 && replay.replayHash === binding.replayHash &&
      typeof replay.recording === 'string' && replay.recording.length > 0 && Buffer.byteLength(replay.recording, 'utf8') <= 850000 &&
      crypto.createHash('sha256').update(replay.recording, 'utf8').digest('hex') === binding.replayHash &&
      canonical.accountId === binding.accountId && canonical.trackId === binding.trackId &&
      canonical.uploadId === binding.uploadId && canonical.frames === binding.frames &&
      (canonical.raceTimeFrames === undefined || canonical.raceTimeFrames === binding.frames) &&
      canonical.timeMs > 0 && Number.isSafeInteger(canonical.timeMs) && canonical.runVerified === true &&
      (binding.metadata.timeMs === undefined || canonical.timeMs === binding.metadata.timeMs) &&
      canonical.integrityVerified === true && canonical.verified === true && canonical.replayHash === binding.replayHash;
  } catch { return false; }
}

function currentRaceState(bindings, fingerprint, invalid, previous) {
  const same = previous?.fingerprint === fingerprint;
  const state = same ? previous : {fingerprint, pending: [], covered: {}, records: {}, invalid,
    responseInvalid: 0, known: bindings.length};
  if (!same) {
    state.pending = [];
    state.covered = {};
    state.records = {};
    state.responseInvalid = 0;
  }
  state.fingerprint = fingerprint;
  state.invalid = invalid;
  state.known = bindings.length;
  return state;
}

export async function exportPublicProfilesAndReplays({fetchImpl = fetch, directory, projectId = 'polytrack-052', maxDocuments = 2000,
  pageSize = 100, log = () => {}, fullSnapshot = false, snapshotDirectory = directory} = {}) {
  if (typeof fetchImpl !== 'function' || typeof directory !== 'string' || !directory || typeof snapshotDirectory !== 'string' ||
      !Number.isSafeInteger(maxDocuments) || maxDocuments < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 ||
      typeof projectId !== 'string' || !/^[a-z][a-z0-9-]{4,62}[a-z0-9]$/.test(projectId)) throw Error('Invalid public export options');
  maxDocuments = Math.min(maxDocuments, MAX_DOCUMENTS_PER_RUN);
  await fs.mkdir(directory, {recursive: true});
  const progressPath = path.join(directory, 'export-progress.json');
  let previous = {};
  try { previous = JSON.parse(await fs.readFile(progressPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  const progress = {schemaVersion: 2, projectId,
    profiles: {cursor: fullSnapshot ? null : previous.profiles?.cursor ?? previous.cursors?.profiles ?? null,
      complete: fullSnapshot ? false : previous.profiles?.complete ?? previous.complete?.profiles === true,
      scanned: fullSnapshot ? 0 : previous.profiles?.scanned ?? previous.scanned ?? 0,
      ids: fullSnapshot ? [] : previous.profiles?.ids ?? []},
    profileCount: fullSnapshot ? 0 : previous.profileCount ?? previous.counts?.profiles ?? 0,
    profileSkipped: fullSnapshot ? 0 : previous.profileSkipped ?? 0,
    fullSnapshotPending: fullSnapshot || previous.fullSnapshotPending === true,
    raceExport: null};
  const staged = await loadStagedBindings(directory, snapshotDirectory);
  let usedThisRun = 0, budgetReached = false, incompletePage = false;
  const base = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents`;
  if (!progress.profiles.complete) {
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
        try {
          const decoded = decodeDocument(item.document);
          if (!ACCOUNT_ID.test(decoded.id)) progress.profileSkipped++;
          else {
            const profile = projectProfile(decoded.id, decoded.fields);
            if (await atomicWrite(directory, `profiles/${decoded.id}.json`, profile)) {
              progress.profileCount++;
              if (!progress.profiles.ids.includes(decoded.id)) progress.profiles.ids.push(decoded.id);
            }
            else progress.profileSkipped++;
          }
        } catch { progress.profileSkipped++; }
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

  const race = currentRaceState(staged.bindings, staged.fingerprint, staged.invalid, previous.raceExport);
  race.responseInvalid = Number.isSafeInteger(race.responseInvalid) ? race.responseInvalid : 0;
  race.known = staged.bindings.length;
  race.invalid = staged.invalid;
  const bindingBySignature = new Map(staged.bindings.map(binding => [binding.signature, binding]));
  for (const binding of staged.bindings) {
    const signature = binding.signature;
    if (await savedMatchExists(directory, binding)) {
      race.records[signature] = {signature, available: true, replayPath: `recordings/${binding.uploadId}.json`,
        canonicalPath: `canonical/${binding.trackId}/${binding.accountId}.json`};
      race.covered[signature] = true;
    } else {
      delete race.records[signature];
      delete race.covered[signature];
    }
  }
  race.pending = staged.bindings.map(binding => binding.signature).filter(signature => !race.covered[signature]).sort();
  progress.raceExport = race;
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
    let unexpectedBatchResult = false;
    for (const result of rows) {
      const name = result?.found?.name || result?.missing;
      if (typeof name !== 'string' || !names.includes(name) || byName.has(name)) { race.responseInvalid++; unexpectedBatchResult = true; continue; }
      byName.set(name, result);
    }
    for (let index = 0; index < batchBindings.length; index++) {
      const binding = batchBindings[index], name = names[index], signature = binding.signature;
      const result = byName.get(name);
      if (!result || result.missing === name) {
        race.records[signature] = {signature, available: false,
          reason: !result && unexpectedBatchResult ? 'batch-response-mismatch' : 'missing'};
      } else {
        let row;
        try { row = decodeDocument(result.found).fields; } catch { row = null; }
        if (!row || !validBoundRace(row, binding)) {
          race.records[signature] = {signature, available: false, reason: 'binding-mismatch'};
        } else {
          const updatedAt = [row.updatedAt, row.pbAt, row.createdAt, binding.metadata.pbAt, binding.metadata.createdAt]
            .find(value => Number.isSafeInteger(value) && value >= 0) ?? 0;
          const replay = {recording: row.replay, frames: binding.frames, verifiedState: 1,
            carStyle: row.carStyle ?? binding.metadata.carStyle ?? '', accountId: binding.accountId,
            trackId: binding.trackId, replayHash: binding.replayHash, updatedAt};
          const canonical = {...binding.metadata, accountId: binding.accountId, trackId: binding.trackId,
            timeMs: row.timeMs, frames: binding.frames, raceTimeFrames: binding.frames, uploadId: binding.uploadId,
            replayHash: binding.replayHash, carStyle: row.carStyle ?? binding.metadata.carStyle ?? '', updatedAt,
            runVerified: true, integrityVerified: true, verified: true, verifiedState: 1};
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
      else delete race.covered[signature];
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
  progress.raceExport = race;
  await atomicWrite(directory, 'export-progress.json', progress);
  const records = Object.values(race.records);
  const available = records.filter(record => record.available).length;
  const missing = records.filter(record => record.reason === 'missing').length;
  const recordInvalid = records.filter(record =>
    ['binding-mismatch', 'batch-response-mismatch', 'upload-conflict', 'output-too-large'].includes(record.reason)).length;
  const invalid = staged.invalid + Math.max(race.responseInvalid, recordInvalid);
  const scanComplete = progress.profiles.complete && race.pending.length === 0;
  const coverageComplete = scanComplete && missing === 0 && invalid === 0 && available === race.known && progress.profileSkipped === 0;
  const result = {counts: {profiles: progress.profileCount, canonical: available, recordings: available, missing,
      skipped: progress.profileSkipped + invalid}, scanned: progress.profiles.scanned + records.length,
    fetchedDocumentsThisRun: usedThisRun, knownVerifiedBindings: race.known,
    totalCoverage: {available, missing, invalid, complete: coverageComplete,
      scope: 'current-staged-track-snapshots'}, scanComplete, complete: coverageComplete, budgetReached, incompletePage};
  log(JSON.stringify({publicProfileReplayExport: result}));
  return result;
}
