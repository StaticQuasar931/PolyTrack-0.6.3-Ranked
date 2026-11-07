import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {decodeSnapshot, MAX_FILE_BYTES, MAX_DECODED_BYTES} from './snapshot-package.mjs';

const HEX = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const demand = (condition, message) => {if (!condition) throw Error(message);};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const stable = value => JSON.stringify(canonical(value));
const trustedPublishedBaselines = new WeakSet();
const freeze = value => {
  if (value && typeof value === 'object') {for (const child of Object.values(value)) freeze(child); Object.freeze(value);}
  return value;
};

/** Only the local, independently pinned package loader can mint this capability. */
export function assertTrustedPublishedEventTotalsBaseline(value) {
  demand(trustedPublishedBaselines.has(value), 'Branded trusted published event totals baseline required');
  return value;
}

function exact(value) {
  return value && Array.isArray(value.entries) && value.entries.length <= 10000 &&
    value.complete === true && value.totalEntries === value.entries.length &&
    value.sourceComplete !== false && value.publicationPending !== true &&
    (!value.pagination || value.pagination.hasMore !== true && value.pagination.complete !== false &&
      (value.pagination.totalEntries === undefined || value.pagination.totalEntries === value.entries.length));
}

async function read(directory, relative, limit = MAX_DECODED_BYTES) {
  demand(typeof relative === 'string' && !relative.includes('\\') && !relative.includes(':') &&
    !relative.startsWith('/') && relative.split('/').every(part => part && part !== '.' && part !== '..'),
  'Unsafe baseline path');
  const base = await fs.realpath(directory), file = await fs.realpath(path.join(base, relative));
  const resolved = path.relative(base, file);
  demand(resolved && !resolved.startsWith('..') && !path.isAbsolute(resolved), 'Baseline path escapes directory');
  const stat = await fs.stat(file);
  demand(stat.isFile() && stat.size <= limit, 'Baseline file too large');
  const bytes = await fs.readFile(file);
  demand(bytes.length <= limit, 'Baseline file too large');
  return bytes;
}

function contributions(board, id) {
  demand(board?.id === id && board.period?.id === id && HEX.test(board.period.trackId || '') &&
    Array.isArray(board.entries) && board.entries.length <= 10000, 'Invalid prior/current event board: ' + id);
  const seen = new Set();
  return board.entries.map(row => {
    demand(HEX.test(row.accountId || '') && !seen.has(row.accountId) &&
      integer(row.timeMs) && row.timeMs > 0 && integer(row.rp), 'Invalid event contribution: ' + id);
    seen.add(row.accountId);
    return [row.accountId, row.timeMs, row.rp];
  }).sort((a, b) => stable(a).localeCompare(stable(b)));
}

/** Read-only, offline predecessor loader. The caller must obtain generation and
 * index SHA256 from its trusted publication receipt, NOT from an arbitrary input.
 * root is the trusted publication root; snapshot-current must still name that
 * generation. Hash integrity alone is not publisher authority. Keep this object
 * in-process: serialized or copied objects deliberately lose the trust brand.
 */
export async function loadTrustedPublishedEventTotalsBaseline({root, expectedGeneration, expectedIndexSha256} = {}) {
  demand(integer(expectedGeneration) && expectedGeneration > 0 && HEX.test(expectedIndexSha256 || ''),
    'Independent published generation and index SHA256 pins required');
  const pointerBytes = await read(root, 'snapshot-current.json');
  const pointer = JSON.parse(pointerBytes), currentdir = 'public-snapshots' + expectedGeneration;
  demand(pointer?.currentdir === currentdir, 'Pinned generation is not the immediately previous published current snapshot');
  const indexBytes = await read(root, currentdir + '/index.json', 16 * 1024 * 1024);
  demand(sha(indexBytes) === expectedIndexSha256, 'Published index SHA256 mismatch');
  const index = JSON.parse(indexBytes);
  demand(index?.schemaVersion === 1 && index.generation === expectedGeneration && index.encoding === 'gzip-xor-a7-v1' &&
    index.files && typeof index.files === 'object' && !Array.isArray(index.files), 'Invalid trusted snapshot index');
  async function payload(logical) {
    const record = index.files[logical];
    demand(record && HEX.test(record.sha256 || '') && record.path === record.sha256 + '.bin' &&
      integer(record.decodedBytes) && record.decodedBytes <= MAX_DECODED_BYTES, 'Invalid snapshot metadata: ' + logical);
    const encoded = await read(root, currentdir + '/' + record.path, MAX_FILE_BYTES);
    demand(sha(encoded) === record.sha256, 'Snapshot SHA256 mismatch: ' + logical);
    const decoded = Buffer.from(await decodeSnapshot(encoded));
    demand(decoded.length === record.decodedBytes, 'Snapshot decodedBytes mismatch: ' + logical);
    return JSON.parse(decoded.toString('utf8'));
  }
  const totals = await payload('event-totals.json');
  demand(exact(totals) && integer(totals.updatedAt), 'Exact complete prior event totals required');
  const residuals = new Map();
  for (const row of totals.entries) {
    const rolling = row.permanentRollingHillsRp ?? row.rollingHillsEventRpContribution;
    demand(HEX.test(row.accountId || '') && !residuals.has(row.accountId), 'Duplicate or invalid prior totals account');
    demand(integer(row.finiteEventRp) && integer(row.rp) && integer(row.events) && integer(rolling) &&
      row.rp === row.finiteEventRp + rolling &&
      (row.permanentRollingHillsRp === undefined || row.permanentRollingHillsRp === rolling) &&
      (row.rollingHillsEventRpContribution === undefined || row.rollingHillsEventRpContribution === rolling),
    'Inconsistent prior totals components');
    residuals.set(row.accountId, {accountId: row.accountId, rp: row.finiteEventRp, events: row.events});
  }
  const logicalBoards = Object.keys(index.files).filter(key => key.startsWith('events/') && key !== 'events/permanent-rolling-hills.json').sort();
  demand(logicalBoards.length <= 1024, 'Prior event board limit exceeded');
  const boards = [];
  let rowCount = 0;
  for (const logical of logicalBoards) {
    const match = /^events\/([A-Za-z0-9_-]{1,128})\.json$/.exec(logical);
    demand(match, 'Invalid prior event logical path');
    const board = await payload(logical), tuples = contributions(board, match[1]), p = board.period;
    demand(integer(board.updatedAt) && integer(p.startsAt) && integer(p.endsAt) && p.endsAt > p.startsAt &&
      ['daily', 'weekly', 'custom', 'kodub'].includes(p.kind), 'Invalid prior event period');
    rowCount += tuples.length;
    demand(rowCount <= 1000000, 'Prior event contribution limit exceeded');
    // Legacy archives may lack completeness/scoring-version metadata. Their
    // published awards remain known contributions, not freshly rescored awards.
    for (const [accountId, , rp] of tuples) {
      const residual = residuals.get(accountId);
      demand(residual && residual.rp >= rp && residual.events >= 1, 'Prior known contributions exceed totals: ' + accountId);
      residual.rp -= rp; residual.events--;
    }
    boards.push({board, replaceable: exact(board), sha256: index.files[logical].sha256});
  }
  for (const residual of residuals.values()) {
    demand(residual.events > 0 || residual.rp === 0, 'Incoherent historical residual without event count');
  }
  demand(index.publishedAt === undefined || integer(index.publishedAt) && index.publishedAt >= totals.updatedAt &&
    boards.every(({board}) => board.updatedAt <= index.publishedAt), 'Incoherent published snapshot timestamp');
  demand((await read(root, 'snapshot-current.json')).equals(pointerBytes), 'Published current pointer changed during baseline load');
  const result = freeze({kind: 'trusted-published-event-totals-baseline-v1', totals, boards,
    residuals: [...residuals.values()], provenance: {kind: 'hash-pinned-published-current', generation: expectedGeneration,
      currentdir, publishedAt: index.publishedAt ?? null, pointerSha256: sha(pointerBytes), indexSha256: expectedIndexSha256,
      totalsSha256: index.files['event-totals.json'].sha256}});
  trustedPublishedBaselines.add(result);
  return result;
}

/**
 * Offline selection from the caller's trusted published generation 72.
 * Hashes verify package integrity, not publisher authority. No capture is
 * overwritten, and the returned provenance never claims a pristine server source.
 */
export async function selectPublishedEventTotalsBaseline({root, directory} = {}) {
  const current = JSON.parse(await read(directory, 'event-totals.json'));
  demand(integer(current?.updatedAt) && !current.nativeEventOverlay, 'Raw backend event totals required');
  const pointer = JSON.parse(await read(root, 'snapshot-current.json'));
  demand(pointer?.currentdir === 'public-snapshots72', 'Expected trusted public-snapshots72 pointer');
  const published = path.join(root, pointer.currentdir);
  const indexBytes = await read(published, 'index.json', 16 * 1024 * 1024);
  const index = JSON.parse(indexBytes);
  demand(index?.schemaVersion === 1 && index.generation === 72 && index.encoding === 'gzip-xor-a7-v1' &&
    index.files && typeof index.files === 'object' && !Array.isArray(index.files), 'Invalid trusted snapshot index');
  async function payload(logical) {
    const record = index.files[logical];
    demand(record && HEX.test(record.sha256 || '') && record.path === record.sha256 + '.bin' &&
      integer(record.decodedBytes) && record.decodedBytes <= MAX_DECODED_BYTES,
    'Invalid snapshot metadata: ' + logical);
    const encoded = await read(published, record.path, MAX_FILE_BYTES);
    demand(sha(encoded) === record.sha256, 'Snapshot SHA256 mismatch: ' + logical);
    const decoded = Buffer.from(await decodeSnapshot(encoded));
    demand(decoded.length === record.decodedBytes, 'Snapshot decodedBytes mismatch: ' + logical);
    return JSON.parse(decoded.toString('utf8'));
  }
  const previous = await payload('event-totals.json');
  demand(integer(previous?.updatedAt), 'Invalid prior totals timestamp');
  if (current.updatedAt >= previous.updatedAt) {
    return {totals: current, report: {selected: 'current-backend', fallback: false}};
  }

  demand(exact(previous), 'Exact complete prior event totals required');
  const totals = new Map();
  for (const row of previous.entries) {
    const rolling = row.permanentRollingHillsRp ?? row.rollingHillsEventRpContribution;
    demand(HEX.test(row.accountId || '') && !totals.has(row.accountId), 'Duplicate or invalid prior totals account');
    demand(integer(row.finiteEventRp) && integer(row.rp) && integer(row.events) && integer(rolling) &&
      row.rp === row.finiteEventRp + rolling &&
      (row.permanentRollingHillsRp === undefined || row.permanentRollingHillsRp === rolling) &&
      (row.rollingHillsEventRpContribution === undefined || row.rollingHillsEventRpContribution === rolling),
    'Inconsistent prior totals components');
    totals.set(row.accountId, row);
  }
  const boards = new Map(), known = new Map();
  for (const logical of Object.keys(index.files).filter(key => key.startsWith('events/')).sort()) {
    if (logical === 'events/permanent-rolling-hills.json') continue;
    const match = /^events\/([A-Za-z0-9_-]{1,128})\.json$/.exec(logical);
    demand(match, 'Invalid prior event logical path');
    const id = match[1], board = await payload(logical), tuples = contributions(board, id);
    boards.set(id, {board, tuples});
    for (const [accountId, , rp] of tuples) {
      const sum = known.get(accountId) || {rp: 0, events: 0};
      sum.rp += rp; sum.events++;
      demand(integer(sum.rp) && integer(sum.events), 'Prior contribution overflow');
      known.set(accountId, sum);
    }
  }
  let exactAccounts = 0, residualAccounts = 0;
  for (const [accountId, sum] of known) {
    const row = totals.get(accountId);
    demand(row && sum.rp <= row.finiteEventRp && sum.events <= row.events,
      'Prior known contributions exceed totals: ' + accountId);
    if (sum.rp === row.finiteEventRp && sum.events === row.events) exactAccounts++;
    else residualAccounts++;
  }

  const manifest = JSON.parse(await read(directory, 'manifest.json'));
  demand(manifest?.events && typeof manifest.events === 'object' && !Array.isArray(manifest.events),
    'Captured event manifest required');
  let matchedBoards = 0, newEmptyBoards = 0, ignoredIncompleteBoards = 0;
  for (const [id, record] of Object.entries(manifest.events)) {
    if (id === 'permanent-rolling-hills') continue;
    demand(ID.test(id) && record?.path === 'events/' + id + '.json', 'Invalid captured event path');
    const board = JSON.parse(await read(directory, record.path));
    if (!exact(board)) {ignoredIncompleteBoards++; continue;}
    demand(!board.nativeEventOverlay, 'Raw captured event board required: ' + id);
    const tuples = contributions(board, id), prior = boards.get(id);
    if (!prior) {
      demand(tuples.length === 0, 'New nonempty scoring baseline: ' + id);
      newEmptyBoards++;
      continue;
    }
    demand(stable(board.period) === stable(prior.board.period) &&
      stable(tuples) === stable(prior.tuples), 'Changed scoring baseline contribution bindings: ' + id);
    matchedBoards++;
  }
  // This is the only path that removes an overlay marker, after all checks.
  const selected = structuredClone(previous);
  delete selected.nativeEventOverlay;
  selected.publishedSnapshotBaseline = {
    generation: index.generation,
    indexSha256: sha(indexBytes),
    totalsSha256: index.files['event-totals.json'].sha256
  };
  return {totals: selected, report: {
    selected: 'trusted-published-snapshot', fallback: true,
    backendUpdatedAt: current.updatedAt, priorUpdatedAt: previous.updatedAt,
    totalAccounts: totals.size, knownAccounts: known.size, exactAccounts, residualAccounts,
    priorBoards: boards.size, matchedBoards, newEmptyBoards, ignoredIncompleteBoards
  }};
}
