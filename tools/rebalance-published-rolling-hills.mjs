import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadTrustedPublishedEventTotalsBaseline, assertTrustedPublishedEventTotalsBaseline} from './published-event-totals-baseline.mjs';
import {decodeSnapshot, MAX_DECODED_BYTES, MAX_FILE_BYTES} from './snapshot-package.mjs';
import {buildEventRpHighlights} from './event-rp-highlights.mjs';
import {PERMANENT_ROLLING_HILLS as R, permanentRollingHillsRp, permanentResultEligible,
  ROLLING_HILLS_SCORING_FORMULA} from '../workers/ranked/src/permanent-rolling-hills.js';

const OLD = 'rolling-hills-live-verified-v1';
const trustedCohorts = new WeakSet();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const uint = n => Number.isSafeInteger(n) && n >= 0;
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const demand = (ok, reason) => {if (!ok) throw Error('published_rolling_rebalance_' + reason);};
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const freeze = value => {if (value && typeof value === 'object') {Object.values(value).forEach(freeze); Object.freeze(value);} return value;};

function validateCohort(baseline, rolling) {
  assertTrustedPublishedEventTotalsBaseline(baseline);
  const totals = baseline.totals, source = rolling?.capturedNativeSource;
  demand(rolling?.id === R.id && rolling.kind === 'permanent' && rolling.trackId === R.trackId &&
    rolling.scoreVersion === OLD && rolling.maxRp === 1001 && rolling.targetPolicy === 'live-fastest-physics-verified' &&
    rolling.complete === true && rolling.sourceComplete !== false && rolling.publicationPending !== true && !rolling.pagination &&
    Array.isArray(rolling.entries) && rolling.entries.length > 0 && rolling.entries.length <= 10000 &&
    rolling.totalEntries === rolling.entries.length && uint(rolling.sourceTotalEntries) && rolling.sourceTotalEntries >= rolling.totalEntries &&
    rolling.sourceCompleteness === 'captured-native-complete' && rolling.contributions?.normalRp === true && rolling.contributions.eventRp === true &&
    uint(rolling.sourceRevision) && rolling.sourceRevision > 0 && uint(rolling.updatedAt) && rolling.updatedAt > 0 &&
    totals.updatedAt === rolling.updatedAt && rolling.updatedAt <= baseline.provenance.publishedAt &&
    uint(rolling.targetMs) && rolling.targetMs > 0 && rolling.targetMs <= 300000, 'unknown_or_incomplete_old_board');
  demand(totals.nativeEventOverlay?.version === 'native-event-overlay-v1' &&
    totals.nativeEventOverlay.source === 'trusted-published-rebase' && source?.kind === 'captured-native-content-v1' &&
    hex(source.sourceHash) && ['canonical-json', 'file-bytes'].includes(source.sourceHashMode) &&
    uint(source.sourceUpdatedAt) && source.sourceUpdatedAt > 0 && source.sourceUpdatedAt <= rolling.updatedAt &&
    (source.sourceBuiltAt === undefined || uint(source.sourceBuiltAt) && source.sourceBuiltAt > 0 && source.sourceBuiltAt <= rolling.updatedAt) &&
    equal(totals.nativeEventOverlay.rollingSource, source), 'capture_cohort_mismatch');
  const rows = [...rolling.entries].sort((a, b) => a.timeMs - b.timeMs || order(a.accountId, b.accountId));
  const byAccount = new Map(); let rank = 0;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (!index || row.timeMs !== rows[index - 1].timeMs) rank = index + 1;
    demand(hex(row.accountId) && !byAccount.has(row.accountId) && row.trackId === R.trackId &&
      uint(row.timeMs) && row.timeMs >= rolling.targetMs && row.timeMs <= 300000 && row.frames === row.timeMs &&
      (row.raceTimeFrames === undefined || row.raceTimeFrames === row.timeMs) &&
      row.physicsVerified === true && row.replayIntegrityVerified === true && row.normalRpEligible === true &&
      permanentResultEligible(row) && hex(row.replayHash) && row.rank === rank &&
      row.rp === Number(1001n * BigInt(rolling.targetMs) / BigInt(row.timeMs)) && row.eventRpContribution === row.rp,
    'invalid_old_verified_result');
    byAccount.set(row.accountId, row);
  }
  demand(rows[0].timeMs === rolling.targetMs, 'target_mismatch');
  const totalsAccounts = new Set();
  for (const row of totals.entries) {
    const saved = byAccount.get(row.accountId), old = saved?.rp ?? 0;
    demand(!totalsAccounts.has(row.accountId) && uint(row.finiteEventRp) && uint(row.permanentRollingHillsRp) &&
      uint(row.rp) && uint(row.events) && row.permanentRollingHillsRp === old && row.rp === row.finiteEventRp + old &&
      (row.rollingHillsEventRpContribution === undefined || row.rollingHillsEventRpContribution === old) &&
      (row.dynamicEventRp === undefined || row.dynamicEventRp === old) &&
      (saved ? row.rollingHillsTimeMs === saved.timeMs && row.rollingHillsEventRpContribution === old :
        row.rollingHillsTimeMs === undefined && row.rollingHillsRunAgeMs === undefined), 'explicit_component_mismatch');
    totalsAccounts.add(row.accountId);
  }
  demand(rows.every(row => totalsAccounts.has(row.accountId)), 'missing_total_account');
  return rows;
}

// The caller supplies independent publication pins, not hashes discovered from arbitrary input.
// The existing loader validates all finite boards/residuals and mints the source authority capability.
export async function loadPublishedRollingCohort(options) {
  const baseline = await loadTrustedPublishedEventTotalsBaseline(options);
  const {root} = options, directory = path.join(root, baseline.provenance.currentdir);
  const indexBytes = await fs.readFile(path.join(directory, 'index.json'));
  demand(hash(indexBytes) === options.expectedIndexSha256, 'index_changed');
  const index = JSON.parse(indexBytes), logicalPath = 'events/permanent-rolling-hills.json', record = index.files[logicalPath];
  demand(record && hex(record.sha256) && record.path === record.sha256 + '.bin' &&
    uint(record.decodedBytes) && record.decodedBytes <= MAX_DECODED_BYTES, 'invalid_board_record');
  const file = path.join(directory, record.path), resolved = await fs.realpath(file), base = await fs.realpath(directory);
  demand(path.dirname(resolved) === base && (await fs.stat(file)).size <= MAX_FILE_BYTES, 'unsafe_board_path');
  const encoded = await fs.readFile(file);
  demand(encoded.length <= MAX_FILE_BYTES && hash(encoded) === record.sha256, 'board_hash_mismatch');
  const decoded = Buffer.from(await decodeSnapshot(encoded));
  demand(decoded.length === record.decodedBytes, 'board_length_mismatch');
  const rolling = JSON.parse(decoded.toString('utf8'));
  validateCohort(baseline, rolling);
  demand(hash(await fs.readFile(path.join(root, 'snapshot-current.json'))) === baseline.provenance.pointerSha256 &&
    hash(await fs.readFile(path.join(directory, 'index.json'))) === options.expectedIndexSha256, 'publication_changed');
  const cohort = freeze({baseline, rolling, inputs: {index: {path: path.join(directory, 'index.json'),
    bytes: indexBytes.length, sha256: hash(indexBytes)}, rolling: {logicalPath, path: file, encodedBytes: encoded.length,
    sha256: hash(encoded), decodedBytes: decoded.length, decodedSha256: hash(decoded)},
  totals: {logicalPath: 'event-totals.json', ...index.files['event-totals.json']}}});
  trustedCohorts.add(cohort); return cohort;
}

// Pure proposal: no source acquisition, publication, DB access or invented finite results.
export function proposePublishedRollingRebalance(cohort) {
  demand(trustedCohorts.has(cohort), 'trusted_cohort_required');
  const {baseline, rolling: oldRolling, inputs} = cohort;
  const sourceRows = validateCohort(baseline, oldRolling);
  const rolling = {...structuredClone(oldRolling), scoreVersion: R.scoreVersion, maxRp: R.maxRp,
    entries: sourceRows.map(row => {
      const rp = permanentRollingHillsRp(row.rank, oldRolling.targetMs, row.timeMs);
      return {...row, rp, eventRpContribution: rp};
    })};
  const newAwards = new Map(rolling.entries.map(row => [row.accountId, row.rp]));
  const changes = [], rows = baseline.totals.entries.map(saved => {
    const row = structuredClone(saved), rp = newAwards.get(row.accountId) ?? 0;
    row.rp = row.finiteEventRp + rp; demand(uint(row.rp), 'total_overflow');
    row.permanentRollingHillsRp = rp;
    for (const key of ['rollingHillsEventRpContribution', 'dynamicEventRp']) if (Object.hasOwn(row, key)) row[key] = rp;
    delete row.eventHighlights;
    changes.push({accountId: row.accountId, before: saved.rp, after: row.rp, delta: row.rp - saved.rp,
      finiteEventRp: row.finiteEventRp, events: row.events, rollingBefore: saved.permanentRollingHillsRp, rollingAfter: rp});
    return row;
  }).sort((a, b) => b.rp - a.rp || order(a.accountId, b.accountId));
  let rank = 0;
  rows.forEach((row, i) => {if (!i || row.rp !== rows[i - 1].rp) rank = i + 1; row.rank = rank;});
  const highlights = buildEventRpHighlights({totalsRows: rows, boards: [...baseline.boards.map(item => item.board), rolling]});
  for (const row of rows) if (highlights.get(row.accountId)?.length) row.eventHighlights = highlights.get(row.accountId);
  const totals = {updatedAt: baseline.totals.updatedAt, complete: true, totalEntries: rows.length, entries: rows};
  return {format: 'published-rolling-cohort-rebalance-proposal-v1', unpublished: true,
    sourceScoreVersion: OLD, targetScoreVersion: R.scoreVersion, scoringFormula: ROLLING_HILLS_SCORING_FORMULA,
    provenance: baseline.provenance, inputs,
    sourceScope: {rollingVerified: sourceRows.length, rollingSourceTotal: oldRolling.sourceTotalEntries,
      totalsAccounts: rows.length, finiteOnly: rows.length - sourceRows.length,
      preservedHistoricalResidualAccounts: baseline.residuals.filter(row => row.rp || row.events).length,
      finiteHistoryReconstructed: false, nativeProofsCreated: false, oldCaptureSource: oldRolling.capturedNativeSource},
    rolling, totals, changes: changes.sort((a, b) => order(a.accountId, b.accountId))};
}

export async function runPublishedRollingCli(args) {
  demand(args.length === 8 && args[0] === '--root' && args[2] === '--generation' && args[4] === '--index-sha256' && args[6] === '--out',
    'usage: --root ROOT --generation N --index-sha256 INDEPENDENT_HASH --out NEW_DIRECTORY');
  const root = path.resolve(args[1]), output = path.resolve(args[7]);
  const cohort = await loadPublishedRollingCohort({root, expectedGeneration: Number(args[3]), expectedIndexSha256: args[5]});
  const proposal = proposePublishedRollingRebalance(cohort);
  const files = {'proposal.json': bytes(proposal), 'rolling.json': bytes(proposal.rolling), 'totals.json': bytes(proposal.totals)};
  const receipt = {format: 'published-rolling-cohort-rebalance-receipt-v1', unpublished: true, provenance: proposal.provenance,
    inputs: proposal.inputs, sourceScope: proposal.sourceScope, sourceScoreVersion: OLD, targetScoreVersion: R.scoreVersion,
    scoringFormula: ROLLING_HILLS_SCORING_FORMULA,
    outputs: Object.fromEntries(Object.entries(files).map(([key, data]) => [key, {bytes: data.length, sha256: hash(data)}])),
    changes: {increased: proposal.changes.filter(row => row.delta > 0).length, decreased: proposal.changes.filter(row => row.delta < 0).length,
      unchanged: proposal.changes.filter(row => row.delta === 0).length}, databaseReads: 0, databaseWrites: 0, publicationPerformed: false};
  await fs.mkdir(output);
  for (const [name, data] of Object.entries(files)) await fs.writeFile(path.join(output, name), data, {flag: 'wx'});
  await fs.writeFile(path.join(output, 'receipt.json'), bytes(receipt), {flag: 'wx'});
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {console.log(JSON.stringify(await runPublishedRollingCli(process.argv.slice(2))));}
  catch (error) {console.error(error.message); process.exitCode = 1;}
}
