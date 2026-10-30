import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {decodeSnapshot} from './snapshot-package.mjs';
import {validatePublicReplayForPublication} from './public-replay-playback.mjs';
import {archiveSnapshotState} from '../events/archive-view.mjs';

const HASH = /^[a-f0-9]{64}$/;
const RECORD = /^(event-replays|event-playbacks)\/([A-Za-z0-9_-]{1,64})\/([a-f0-9]{64})\.json$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const tally = rows => rows.reduce((counts, row) => {
  counts[row.kind] = (counts[row.kind] || 0) + 1;
  return counts;
}, {});

// Structural integrity and snapshot binding only. No physics or RP verdicts.
export async function inspectSavedEventRecording(key, value) {
  const match = RECORD.exec(key);
  if (!match || !value || value.periodId !== match[2] ||
      !HASH.test(value.accountId || '') || !HASH.test(value.trackId || '') || !HASH.test(value.runId || '') ||
      !HASH.test(value.replayHash || '') ||
      (match[1] === 'event-playbacks' ? value.runId : value.accountId) !== match[3] ||
      !Number.isSafeInteger(value.timeMs) || value.timeMs < 1 || value.timeMs > 300000 || value.frames !== value.timeMs ||
      typeof value.replay !== 'string' || value.replay.length > 65536 ||
      typeof value.carStyle !== 'string' || value.carStyle.length > 256 || digest(value.replay) !== value.replayHash)
    throw Error('Recording identity, path, bounds or hash mismatch');
  const pending = match[1] === 'event-playbacks';
  if (pending && (value.pending !== true || value.verified !== false || value.eventRpEligible !== false ||
      value.verificationStatus !== 'waiting' || !Number.isSafeInteger(value.submittedAt) || value.submittedAt < 1))
    throw Error('Pending recording authority or date mismatch');
  if (!pending && (value.pending === true || value.verified === false || value.eventRpEligible === false ||
      ['status', 'verificationStatus'].some(field => value[field] !== undefined && value[field] !== 'verified')))
    throw Error('Result recording carries non-verified status');
  const structure = await validatePublicReplayForPublication(value.replay, value.frames);
  if (!structure.indexedPlaybackWithinBudget || structure.inflatedBytes > 30015 ||
      structure.transitions > 10000 || structure.maxChannelTransitions > 4096)
    throw Error('Recording exceeds event playback limits');
  return {pending, requiresIndexedPlayback:structure.legacyWork > 30000000};
}

function bindingMatches(value, {period, entry, pending}) {
  return value.periodId === period.id && value.trackId === period.trackId &&
    value.accountId === entry.accountId && value.timeMs === entry.timeMs &&
    (entry.runId === undefined || value.runId === entry.runId) &&
    (entry.replayHash === undefined || value.replayHash === entry.replayHash) &&
    (entry.frames === undefined || value.frames === entry.frames) &&
    (!pending || entry.pending === true && entry.verified === false && entry.eventRpEligible === false &&
      entry.verificationStatus === 'waiting' && value.submittedAt === entry.submittedAt);
}

export async function auditSavedEventFiles({keys, read, catalog = {}, at = Date.now()}) {
  const boards = new Map(), references = new Map(), issues = [];
  for (const key of keys.filter(key => /^events\/[^/]+\.json$/.test(key))) {
    const value = await read(key);
    if (key === 'events/permanent-rolling-hills.json') continue;
    if (!value?.period?.id || key !== `events/${value.period.id}.json` || !Array.isArray(value.entries)) {
      issues.push({key, reason:'Invalid event board'}); continue;
    }
    boards.set(value.period.id, value);
    for (const [rows, pending] of [[value.entries, false], [value.pendingPlaybacks || [], true]]) {
      if (!Array.isArray(rows)) { issues.push({key, reason:'Invalid pending list'}); continue; }
      for (const entry of rows) {
        const name = pending ? entry?.runId : entry?.accountId;
        if (!HASH.test(name || '')) { issues.push({key, reason:'Invalid row identity'}); continue; }
        const file = `${pending ? 'event-playbacks' : 'event-replays'}/${value.period.id}/${name}.json`;
        if (references.has(file)) issues.push({key:file, reason:'Duplicate board reference'});
        references.set(file, {period:value.period, entry, pending});
      }
    }
  }
  const files = [], savedKeys = new Set(keys.filter(key => /^event-(replays|playbacks)\//.test(key)));
  for (const key of savedKeys) {
    const reference = references.get(key);
    const result = {key, referenced:!!reference, integrity:'invalid', binding:reference ? 'invalid' : 'unreferenced'};
    try {
      const value = await read(key);
      Object.assign(result, await inspectSavedEventRecording(key, value), {
        integrity:'valid', periodId:value.periodId, accountId:value.accountId, runId:value.runId,
      });
      if (reference) {
        result.binding = bindingMatches(value, reference) ? 'matches' : 'invalid';
        result.rowHasRunHashBinding = HASH.test(reference.entry.runId || '') && HASH.test(reference.entry.replayHash || '');
      } else if (result.pending) {
        const board = boards.get(value.periodId);
        result.matchesPublishedResult = board?.entries.some(entry => HASH.test(entry.runId || '') &&
          HASH.test(entry.replayHash || '') && bindingMatches(value, {period:board.period,entry,pending:false})) || false;
      }
    } catch (error) { result.reason = error.message; }
    files.push(result);
  }
  const missing = [...references].filter(([key]) => !savedKeys.has(key)).map(([key, ref]) => ({
    key, periodId:ref.period.id, pending:ref.pending, accountId:ref.entry.accountId,
  }));
  const catalogPeriods = [...(catalog.periods || []), ...(catalog.archives || [])];
  const periods = new Map(catalogPeriods.map(period => [period.id, period]));
  for (const board of boards.values()) if (!periods.has(board.period.id)) periods.set(board.period.id, board.period);
  const periodReports = [...periods.values()].map(period => {
    const board = boards.get(period.id);
    const observedRacers = board ? new Set([...(board.entries || []), ...(board.pendingPlaybacks || [])]
      .map(row => row.accountId).filter(id => typeof id === 'string' && id)).size : null;
    const declared = board?.racerCount ?? board?.period?.racerCount ?? period.racerCount;
    const countUnderreported = Number.isSafeInteger(declared) && observedRacers !== null && declared < observedRacers;
    if (countUnderreported) issues.push({key:`events/${period.id}.json`, reason:'Event racer count is smaller than its saved participants'});
    return {id:period.id, kind:period.kind, trackName:period.trackName || null, trackId:period.trackId,
      endsAt:period.endsAt, ended:period.endsAt <= at, inCatalog:catalogPeriods.some(p => p.id === period.id),
      state:archiveSnapshotState(period, board), catalogRacers:period.racerCount ?? null,
      capturedRacers:board?.racerCount ?? null, observedRacers, countUnderreported, resultRows:board?.entries?.length ?? null,
      pendingRows:board ? board.pendingPlaybacks?.length || 0 : null, capturedAt:board?.updatedAt ?? null};
  });
  const categories = {};
  for (const [label, pending] of [['results',false],['pending',true]]) {
    const refs = [...references.values()].filter(ref => ref.pending === pending);
    const selected = files.filter(file => file.key.startsWith(pending ? 'event-playbacks/' : 'event-replays/'));
    categories[label] = {referenced:refs.length, saved:selected.length,
      bound:selected.filter(file => file.integrity === 'valid' && file.binding === 'matches').length,
      missing:missing.filter(file => file.pending === pending).length,
      invalid:selected.filter(file => file.integrity === 'invalid' || file.binding === 'invalid').length,
      unreferenced:selected.filter(file => !file.referenced).length};
  }
  return {networkRequests:0, physicsVerificationPerformed:false, at,
    catalog:{archives:(catalog.archives || []).length, kinds:tally(catalog.archives || [])},
    timedBoards:boards.size, finalBoards:periodReports.filter(p => p.state === 'final').length,
    endedNonFinalBoards:periodReports.filter(p => p.ended && p.state === 'non-final').length,
    activeBoards:periodReports.filter(p => !p.ended && boards.has(p.id)).length,
    replayCoverage:categories, indexedPlaybackFiles:files.filter(f => f.requiresIndexedPlayback).length,
    rowBindingsWithoutRunHash:files.filter(f => f.binding === 'matches' && !f.rowHasRunHashBinding).length,
    missing, unreferenced:files.filter(file => !file.referenced), issues, periods:periodReports, files};
}

export async function auditArchiveData({root = fileURLToPath(new URL('../',import.meta.url)), snapshotDirectory, at} = {}) {
  let pointerGeneration;
  if (snapshotDirectory === undefined) {
    const pointer = JSON.parse(await fs.readFile(path.join(root,'snapshot-current.json'),'utf8'));
    if (!pointer || typeof pointer.currentdir !== 'string' || !/^public-snapshots[1-9]\d*$/.test(pointer.currentdir))
      throw Error('Current snapshot pointer is invalid');
    snapshotDirectory = pointer.currentdir;
    pointerGeneration = Number(snapshotDirectory.slice('public-snapshots'.length));
    if (!Number.isSafeInteger(pointerGeneration)) throw Error('Current snapshot pointer is invalid');
  }
  if (typeof snapshotDirectory !== 'string' || !/^public-snapshots\d+$/.test(snapshotDirectory)) throw Error('Expected a local snapshot directory name');
  const directory = path.join(root, snapshotDirectory);
  const index = JSON.parse(await fs.readFile(path.join(directory,'index.json'),'utf8'));
  if (pointerGeneration !== undefined && (index.schemaVersion !== 1 || index.encoding !== 'gzip-xor-a7-v1' || index.generation !== pointerGeneration))
    throw Error('Current snapshot index does not match its pointer');
  const cache = new Map();
  const read = async key => {
    if (cache.has(key)) return cache.get(key);
    const ref = index.files?.[key];
    if (!ref) return null;
    if (!HASH.test(ref.sha256 || '') || ref.path !== `${ref.sha256}.bin`) throw Error('Invalid snapshot blob path');
    const encoded = await fs.readFile(path.join(directory,ref.path));
    if (digest(encoded) !== ref.sha256) throw Error('Snapshot blob hash mismatch');
    const decoded = await decodeSnapshot(encoded);
    if (ref.decodedBytes !== decoded.length) throw Error('Snapshot decoded size mismatch');
    const value = JSON.parse(Buffer.from(decoded).toString('utf8'));
    cache.set(key,value); return value;
  };
  const catalog = JSON.parse(await fs.readFile(path.join(root,'events/public-catalog.json'),'utf8'));
  const report = await auditSavedEventFiles({keys:Object.keys(index.files || {}),read,catalog,at});
  const kodub = [];
  for (const period of report.periods.filter(p => p.kind === 'kodub')) {
    const ordinary = await read(`tracks/${period.trackId}.json`);
    kodub.push({...period, ordinaryTrackRows:ordinary?.entries?.length ?? null,
      ordinaryTrackComplete:ordinary?.complete === true});
  }
  return {snapshot:snapshotDirectory, ...report, kodub};
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const at = process.argv[3] ? Date.parse(process.argv[3]) : Date.now();
  if (!Number.isFinite(at) || process.argv.length > 4) throw Error('Usage: node tools/archive-data-audit.mjs [public-snapshotsN] [ISO time]');
  console.log(JSON.stringify(await auditArchiveData({snapshotDirectory:process.argv[2],at}),null,2));
}
