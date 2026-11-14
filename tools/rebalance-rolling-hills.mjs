import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {PERMANENT_ROLLING_HILLS as R, derivePermanentRollingHills,
  mergePermanentRollingIntoTotals, permanentResultEligible, ROLLING_HILLS_SCORING_FORMULA} from '../workers/ranked/src/permanent-rolling-hills.js';

export const INPUT_FORMAT = 'rolling-hills-rebalance-input-v1';
export const SOURCE_VERSION = 'rolling-hills-live-verified-v1';
const uint = n => Number.isSafeInteger(n) && n >= 0;
const account = id => typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(id);
const demand = (ok, reason) => { if (!ok) throw Error(`rolling_rebalance_${reason}`); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function complete(board) {
  return board?.complete === true && board.sourceComplete !== false && board.publicationPending !== true &&
    Array.isArray(board.entries) && board.entries.length <= 1000000 && board.totalEntries === board.entries.length &&
    (!board.pagination || board.pagination.hasMore === false && board.pagination.totalEntries === board.entries.length);
}

// Only saved verified finite PB awards are summed. Their scoring policy is never changed.
export function proposeRollingHillsRebalance(input) {
  demand(input?.format === INPUT_FORMAT && input.sourceScoreVersion === SOURCE_VERSION, 'unknown_source_version');
  const {rollingSnapshot, finiteResults, totals} = input;
  demand(complete(finiteResults) && complete(totals), 'incomplete_sources');
  demand(typeof finiteResults.sourceReadTime === 'string' && Number.isFinite(Date.parse(finiteResults.sourceReadTime)) &&
    finiteResults.sourceReadTime === totals.sourceReadTime, 'mixed_source_read_time');
  const component = totals.dynamicComponents?.permanentRollingHills;
  demand(component?.status === 'complete' && component.scoreVersion === SOURCE_VERSION &&
    component.id === R.id && component.trackId === R.trackId && component.maxRp === 1001 &&
    component.sourceRevision === rollingSnapshot?.sourceRevision && component.updatedAt === rollingSnapshot?.updatedAt,
  'mixed_rolling_source');
  const rolling = derivePermanentRollingHills(rollingSnapshot);
  demand(component.targetMs === rolling.targetMs && component.targetPolicy === rolling.targetPolicy, 'mixed_rolling_target');
  const finite = new Map(), seenResults = new Set();
  for (const row of finiteResults.entries) {
    demand(account(row?.accountId) && typeof row.periodId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(row.periodId) &&
      row.periodId !== R.id && uint(row.rp) && permanentResultEligible(row) &&
      row.physicsVerified === true && row.replayIntegrityVerified === true, 'invalid_finite_result');
    const key = row.periodId + '/' + row.accountId;
    demand(!seenResults.has(key), 'duplicate_finite_result'); seenResults.add(key);
    const prior = finite.get(row.accountId) || {accountId: row.accountId, rp: 0, events: 0};
    prior.rp += row.rp; prior.events++;
    demand(uint(prior.rp), 'overflow'); finite.set(row.accountId, prior);
  }
  const priorRows = new Map();
  for (const row of totals.entries) {
    demand(account(row?.accountId) && uint(row.rp) && uint(row.events) && !priorRows.has(row.accountId), 'invalid_prior_total');
    priorRows.set(row.accountId, row);
    if (!finite.has(row.accountId)) finite.set(row.accountId, {accountId: row.accountId, rp: 0, events: 0});
  }
  const oldRolling = new Map(rolling.entries.map(row => [row.accountId,
    Number(1001n * BigInt(rolling.targetMs) / BigInt(row.timeMs))]));
  const accounts = new Set([...finite.keys(), ...oldRolling.keys()]);
  demand(accounts.size === priorRows.size, 'prior_account_coverage');
  for (const id of accounts) {
    const prior = priorRows.get(id), saved = finite.get(id) || {rp: 0, events: 0}, oldRp = oldRolling.get(id) || 0;
    demand(prior && prior.rp === saved.rp + oldRp && prior.events === saved.events &&
      ['finiteEventRp'].every(key => prior[key] === undefined || prior[key] === saved.rp) &&
      ['permanentRollingHillsRp', 'dynamicEventRp', 'rollingHillsEventRpContribution'].every(key => prior[key] === undefined || prior[key] === oldRp),
    'prior_total_mismatch');
  }
  const entries = [...finite.values()].map(row => {
    const prior = priorRows.get(row.accountId);
    const identity = Object.fromEntries(['name', 'countryCode', 'carStyle'].filter(key => prior?.[key] !== undefined)
      .map(key => [key, prior[key]]));
    return {...identity, ...row};
  });
  const nextTotals = mergePermanentRollingIntoTotals({...totals, entries, totalEntries: entries.length}, rolling);
  // Immutable publication descriptors and derived highlights belong to the old bytes.
  for (const key of ['pagination', 'generation', 'signature', 'builtAt', 'publicationPending', 'nativeEventOverlay']) delete nextTotals[key];
  demand(nextTotals.entries.every(row => uint(row.rp)), 'overflow');
  const changes = nextTotals.entries.map(row => ({accountId: row.accountId, before: priorRows.get(row.accountId).rp,
    after: row.rp, delta: row.rp - priorRows.get(row.accountId).rp, finiteEventRp: row.finiteEventRp,
    rollingBefore: oldRolling.get(row.accountId) || 0, rollingAfter: row.permanentRollingHillsRp}))
    .sort((a, b) => compare(a.accountId, b.accountId));
  return {format: 'rolling-hills-rebalance-proposal-v1', sourceScoreVersion: SOURCE_VERSION,
    targetScoreVersion: R.scoreVersion, scoringFormula: ROLLING_HILLS_SCORING_FORMULA,
    sourceRevision: rolling.sourceRevision, sourceSignature: rolling.sourceSignature,
    sourceReadTime: totals.sourceReadTime, rolling, totals: nextTotals, changes};
}

export async function runRebalanceCli(args) {
  demand(args.length === 6 && args[0] === '--input' && args[2] === '--expect-sha256' && args[4] === '--out',
    'usage: --input INPUT.json --expect-sha256 SHA256 --out NEW_DIRECTORY');
  const inputPath = path.resolve(args[1]), output = path.resolve(args[5]);
  const bytes = await fs.readFile(inputPath);
  demand(bytes.length <= 64 * 1024 * 1024, 'input_too_large');
  const inputSha256 = digest(bytes);
  demand(/^[a-f0-9]{64}$/.test(args[3]) && args[3] === inputSha256, 'input_digest_mismatch');
  const proposal = proposeRollingHillsRebalance(JSON.parse(bytes.toString('utf8')));
  const outputs = {'proposal.json': jsonBytes(proposal), 'rolling.json': jsonBytes(proposal.rolling), 'totals.json': jsonBytes(proposal.totals)};
  const receipt = {format: 'rolling-hills-rebalance-receipt-v1', input: {path: inputPath, bytes: bytes.length, sha256: inputSha256},
    sourceScoreVersion: SOURCE_VERSION, targetScoreVersion: R.scoreVersion, scoringFormula: ROLLING_HILLS_SCORING_FORMULA,
    sourceRevision: proposal.sourceRevision,
    sourceSignature: proposal.sourceSignature, sourceReadTime: proposal.sourceReadTime,
    outputs: Object.fromEntries(Object.entries(outputs).map(([name, data]) => [name, {bytes: data.length, sha256: digest(data)}])),
    accounts: proposal.changes.length, changedAccounts: proposal.changes.filter(row => row.delta !== 0).length,
    databaseWrites: 0, publicationPerformed: false};
  // An existing directory is refused, so a proposal cannot overwrite saved inputs or a prior receipt.
  await fs.mkdir(output);
  for (const [name, data] of Object.entries(outputs)) await fs.writeFile(path.join(output, name), data, {flag: 'wx'});
  await fs.writeFile(path.join(output, 'receipt.json'), jsonBytes(receipt), {flag: 'wx'});
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await runRebalanceCli(process.argv.slice(2)))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
