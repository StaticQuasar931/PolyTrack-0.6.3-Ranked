import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createFirestoreCaller, decode} from './verifier/firestore.mjs';
import {eventReplayCoverage} from './event-replay-coverage.mjs';
import {publicEventReplayBackup} from './public-snapshot-backup.mjs';
import {validatePublicReplayForPublication} from './public-replay-playback.mjs';
import {eventPeriod, EVENT_VERSION} from '../workers/ranked/src/events.js';
import {compatibleEventEngine} from '../workers/ranked/src/event-engine-compatibility.js';
import {VERIFIER_VERSION} from '../workers/ranked/src/verification.js';

export const ARCHIVE_REPAIR_NOT_BEFORE = Date.parse('2026-11-06T00:05:00-08:00');
export const ARCHIVE_REPAIR_COLLECTION = '0.6.2_event_replays';
const BASE = 'https://firestore.googleapis.com/v1/projects/polytrack-052/databases/(default)/documents';
const HASH = /^[a-f0-9]{64}$/, ID = /^[dw]_\d{8}$/;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const demand = (ok, message) => {if (!ok) throw Error('Archive replay repair: ' + message);};
const relative = t => `event-replays/${t.periodId}/${t.accountId}.json`;
const documentPath = t => `/${ARCHIVE_REPAIR_COLLECTION}/${t.periodId}_${t.accountId}`;
function targets(value) {
  demand(Array.isArray(value) && value.length === 12, 'exact 12-target preparation plan required');
  const result = value.map(t => {
    demand(ID.test(t?.periodId || '') && HASH.test(t.accountId || '') && HASH.test(t.trackId || '') &&
      Number.isSafeInteger(t.timeMs) && t.timeMs > 0 && t.timeMs <= 300000, 'invalid target');
    return {periodId:t.periodId, accountId:t.accountId, trackId:t.trackId, timeMs:t.timeMs};
  });
  demand(new Set(result.map(relative)).size === 12, 'duplicate target');
  return result.sort((a,b) => relative(a).localeCompare(relative(b)));
}
async function safeFile(root, name, limit = 2 * 1024 * 1024) {
  const file = path.join(root, name), stat = await fs.lstat(file);
  demand(stat.isFile() && !stat.isSymbolicLink() && stat.size <= limit, 'unsafe input file');
  demand((await fs.realpath(file)).startsWith(root + path.sep), 'input escaped staging');
  const bytes = await fs.readFile(file); demand(bytes.length <= limit, 'oversized input');
  return {bytes, value:JSON.parse(bytes.toString('utf8'))};
}
async function exists(file) {
  return fs.lstat(file).then(() => true, e => {if(e.code === 'ENOENT') return false; throw e;});
}

// No credential discovery, OAuth, query, batchGet, write, or retry capability.
export function createArchiveReplayRepairReader({targets:planned, access, fetchImpl = fetch, now = Date.now} = {}) {
  const allow = new Set(targets(planned).map(documentPath)), used = new Set();
  demand(typeof access === 'string' && access.length > 0, 'parent-provided access capability required');
  let stopped = false;
  const db = createFirestoreCaller({base:BASE, access, mode:'scheduled', maxReadRetries:0,
    documentReadLimit:12, documentWriteLimit:1, fetchImpl:async (url, options) => {
      demand(!stopped && now() >= ARCHIVE_REPAIR_NOT_BEFORE, 'transport stopped or before reset');
      demand(options.method === 'GET' && options.body === undefined && allow.has(url.slice(BASE.length)) &&
        url === BASE + url.slice(BASE.length), 'request outside exact GET allowlist');
      demand(!used.has(url) && used.size < 12, 'duplicate or excess GET');
      used.add(url);
      try {
        const response = await fetchImpl(url, {...options, redirect:'error'});
        if (!response.ok) stopped = true;
        return response;
      } catch(error) {stopped = true; throw error;}
    }});
  return Object.freeze({getDocument:async (collection, id) => {
    const resource = '/' + collection + '/' + id;
    demand(!stopped && allow.has(resource), 'document outside exact allowlist');
    try {
      const doc = await db.call(resource);
      demand(doc && doc.name === BASE.slice('https://firestore.googleapis.com/v1/'.length) + resource,
        'missing or mismatched retained document');
      return decode({mapValue:{fields:doc.fields || {}}});
    } catch(error) {stopped = true; throw error;}
  }, accounting:() => ({backendReads:db.requests(), backendWrites:db.writeAttempts(),
    documentBudget:db.documentBudget(), stopped})});
}

export async function prepareLocalArchiveReplayRepair({directory, planFile, planSha256, maxDocuments = 12} = {}) {
  demand(maxDocuments === 12 && HASH.test(planSha256 || '') && path.isAbsolute(planFile || ''), 'invalid plan boundary');
  demand(path.isAbsolute(directory || ''), 'absolute staging directory required');
  const stat = await fs.lstat(directory); demand(stat.isDirectory() && !stat.isSymbolicLink(), 'unsafe staging directory');
  const root = await fs.realpath(directory);
  const planStat = await fs.lstat(planFile);
  demand(planStat.isFile() && !planStat.isSymbolicLink() && planStat.size <= 65536, 'unsafe preparation plan');
  const bytes = await fs.readFile(planFile); demand(bytes.length <= 65536 && sha(bytes) === planSha256, 'plan fingerprint mismatch');
  const plan = JSON.parse(bytes.toString('utf8'));
  demand(plan.schemaVersion === 1, 'invalid plan schema');
  const planned = targets(plan.targets), original = await safeFile(root, 'manifest.json');
  demand(original.value.schemaVersion === 1 && original.value.events && typeof original.value.events === 'object', 'invalid manifest');
  const boards = new Map(), missing = [];
  const allowed = new Set(planned.map(relative));
  const eventRecords = Object.entries(original.value.events);
  demand(eventRecords.length <= 1024, 'board limit');
  let missingCount = 0;
  for (const [id, record] of eventRecords) {
    demand(/^[A-Za-z0-9_-]{1,64}$/.test(id) && record?.path === `events/${id}.json`, 'invalid event path');
    const saved = await safeFile(root,record.path), board = saved.value;
    if (board.archived !== true) continue;
    demand(board.id === id && board.period?.id === id && Array.isArray(board.entries) && board.entries.length <= 2000,
      'invalid archived board');
    boards.set(id,saved);
    for (const entry of board.entries) {
      demand(HASH.test(entry?.accountId || ''), 'invalid archived account');
      const name = relative({periodId:id,accountId:entry.accountId});
      if (await exists(path.join(root,name))) continue;
      demand(++missingCount <= 12 && allowed.has(name), 'missing archived target outside preparation plan');
    }
  }
  for (const t of planned) {
    if (!boards.has(t.periodId)) {
      const record = original.value.events[t.periodId];
      demand(record?.path === `events/${t.periodId}.json`, 'missing exact staged board');
      boards.set(t.periodId, await safeFile(root, record.path));
    }
    const board = boards.get(t.periodId).value;
    demand(board.id === t.periodId && board.archived === true && board.period?.id === t.periodId &&
      board.period.trackId === t.trackId && Array.isArray(board.entries), 'not an exact archived board');
    const rows = board.entries.filter(e => e.accountId === t.accountId);
    demand(rows.length === 1 && rows[0].timeMs === t.timeMs && rows[0].pending !== true &&
      rows[0].verified !== false && rows[0].physicsVerified !== false && rows[0].replayIntegrityVerified !== false &&
      (!rows[0].verificationStatus || rows[0].verificationStatus === 'verified'), 'board target drift');
    if (!await exists(path.join(root, relative(t)))) missing.push({...t, entry:rows[0], period:board.period});
  }
  return {schemaVersion:1, directory:root, planFile, planSha256, targets:planned, missing,
    manifestSha256:sha(original.bytes), boards:Object.fromEntries([...boards].map(([id,b]) => [id,sha(b.bytes)]))};
}

function checkPeriodBinding(raw, period) {
  demand(typeof raw === 'string' && raw.length < 16384, 'missing retained periodBinding');
  const p = JSON.parse(raw), normalized = {...eventPeriod(p), engineDigest:p.engineDigest};
  delete normalized.scoringVersion; delete normalized.storageVersion;
  demand(p.scoreVersion === EVENT_VERSION && compatibleEventEngine(p.engineDigest) &&
    p.verifierVersion === VERIFIER_VERSION && raw === JSON.stringify(normalized), 'invalid retained periodBinding formula');
  for (const key of ['id','trackId','startsAt','endsAt','graceMs','targetMs','maxRp','kind'])
    demand(p[key] === period[key], 'retained periodBinding differs from board: ' + key);
}

// Manifest replacement is the visibility/commit point. Rollback removes only
// this invocation's newly created files, never existing archive data.
export async function repairLocalArchiveReplays({directory, planFile, planSha256, maxDocuments = 12,
  getDocument, now = Date.now} = {}) {
  const report = {planned:12, attempted:0, recovered:0, backendReads:0, backendWrites:0, staged:false, files:[]};
  const created = [];
  try {
    const receipt = await prepareLocalArchiveReplayRepair({directory, planFile, planSha256, maxDocuments});
    report.receipt = receipt;
    demand(now() >= ARCHIVE_REPAIR_NOT_BEFORE, 'before Nov 6 00:05 PST reset');
    demand(typeof getDocument === 'function', 'injected getDocument capability required');
    const original = await safeFile(receipt.directory, 'manifest.json'), copies = [];
    for (const t of receipt.missing) {
      report.attempted++; report.backendReads++;
      const retained = await getDocument(ARCHIVE_REPAIR_COLLECTION, `${t.periodId}_${t.accountId}`);
      demand(retained && Number.isSafeInteger(retained.verifiedAt) && retained.verifiedAt > 0, 'missing retained verifiedAt');
      demand((retained.frames === undefined || retained.frames === retained.timeMs) && retained.verified !== false &&
        (!retained.verificationStatus || retained.verificationStatus === 'verified') && retained.eventRpEligible !== false,
      'contradictory retained proof');
      checkPeriodBinding(retained.periodBinding, t.period);
      for (const key of ['submittedAt','verifiedAt','runCreatedAt','pbAt','createdAt'])
        if (Object.hasOwn(t.entry,key)) demand(retained[key] === t.entry[key], 'bound date mismatch');
      // Mirror the existing retained replay endpoint envelope, never modify a row
      // or add a verification verdict to the saved public payload.
      const replay = publicEventReplayBackup({...retained, frames:retained.timeMs,
        verificationStatus:'verified', verified:true, eventRpEligible:true},
      {periodId:t.periodId, trackId:t.trackId, entry:t.entry});
      const structure = await validatePublicReplayForPublication(replay.replay, replay.frames);
      demand(structure.indexedPlaybackWithinBudget && structure.inflatedBytes <= 30015 &&
        structure.transitions <= 10000 && structure.maxChannelTransitions <= 4096, 'replay structure exceeds publication limits');
      copies.push({name:relative(t), replay}); report.recovered++;
    }
    const current = await prepareLocalArchiveReplayRepair({directory, planFile, planSha256, maxDocuments});
    demand(isDeepStrictEqual(current, receipt), 'staging changed during reads');
    if (!copies.length) return report;
    const manifest = original.value; manifest.eventReplays = {...manifest.eventReplays};
    for (const copy of copies) {
      let folder = receipt.directory;
      for (const part of copy.name.split('/').slice(0,-1)) {
        folder = path.join(folder,part); await fs.mkdir(folder).catch(e => {if(e.code !== 'EEXIST') throw e;});
        const s = await fs.lstat(folder);
        demand(s.isDirectory() && !s.isSymbolicLink() && (await fs.realpath(folder)).startsWith(receipt.directory + path.sep), 'unsafe output directory');
      }
      const file = path.join(receipt.directory,copy.name), temporary = file + '.' + randomUUID() + '.tmp';
      demand(!await exists(file), 'output appeared during repair');
      await fs.writeFile(temporary,JSON.stringify(copy.replay) + '\n',{flag:'wx',mode:0o600});
      created.push(temporary);
      // Hard-link is atomic and cannot replace an existing file, unlike rename.
      await fs.link(temporary,file);
      created.push(file);
      await fs.unlink(temporary); created.splice(created.indexOf(temporary),1);
      const r = copy.replay;
      manifest.eventReplays[copy.name] = {path:copy.name,periodId:r.periodId,accountId:r.accountId,timeMs:r.timeMs,replayHash:r.replayHash};
      report.files.push(copy.name);
    }
    demand(sha((await safeFile(receipt.directory,'manifest.json')).bytes) === receipt.manifestSha256, 'manifest changed during commit');
    for (const [id, hash] of Object.entries(receipt.boards))
      demand(sha((await safeFile(receipt.directory,`events/${id}.json`)).bytes) === hash, 'board changed during commit');
    const coverageBoards=[];
    for(const record of Object.values(manifest.events))coverageBoards.push((await safeFile(receipt.directory,record.path)).value);
    manifest.replayCoverage=await eventReplayCoverage(coverageBoards,async name=>(await safeFile(receipt.directory,name,70*1024)).value);
    const tempManifest = path.join(receipt.directory,'.archive-repair-' + randomUUID() + '.tmp');
    await fs.writeFile(tempManifest,JSON.stringify(manifest) + '\n',{flag:'wx',mode:0o600});
    created.push(tempManifest);
    await fs.rename(tempManifest,path.join(receipt.directory,'manifest.json'));
    report.staged = true; return report;
  } catch(error) {
    const rollbackErrors = [];
    for (const file of created.reverse()) await fs.unlink(file).catch(e => {if(e.code !== 'ENOENT') rollbackErrors.push(e.code);});
    report.rollbackErrors = rollbackErrors;
    error.accounting = report; throw error;
  }
}
