import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {decodeSnapshot, MAX_DECODED_BYTES} from './snapshot-package.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const LIMIT = 64 * 1024 * 1024;
const GAP = 7 * 86400000;
const ID = /^[a-f0-9]{64}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const demand = (ok, message) => { if (!ok) throw Error(message); };
const positive = n => Number.isSafeInteger(n) && n > 0;
const directoryValid = value => /^public-snapshots[1-9][0-9]*$/.test(value || '');

export async function readOverall(read, directory) {
  demand(directoryValid(directory), 'Invalid snapshot directory');
  const indexBytes = await read(directory + '/index.json');
  demand(indexBytes.length <= LIMIT, 'Oversized index');
  const index = JSON.parse(indexBytes);
  demand(index.schemaVersion === 1 && index.encoding === 'gzip-xor-a7-v1' &&
    index.generation === Number(directory.slice(16)) && index.files, 'Invalid snapshot index');
  const payload = async logical => {
    const entry = index.files[logical];
    demand(entry && /^[a-f0-9]{64}\.bin$/.test(entry.path || '') && ID.test(entry.sha256 || '') &&
      positive(entry.decodedBytes) && entry.decodedBytes <= LIMIT, 'Invalid payload descriptor: ' + logical);
    const encoded = await read(directory + '/' + entry.path);
    demand(encoded.length <= LIMIT && hash(encoded) === entry.sha256, 'Payload SHA256 mismatch: ' + logical);
    // The shared decoder deliberately caps modern pages at 2 MiB. Older monoliths
    // use the identical codec but need their own bounded decompression ceiling.
    const decoded = entry.decodedBytes <= MAX_DECODED_BYTES ? Buffer.from(await decodeSnapshot(encoded)) :
      gunzipSync(Buffer.from(encoded).map(byte => byte ^ 0xa7), {maxOutputLength: entry.decodedBytes});
    demand(decoded.length === entry.decodedBytes, 'Decoded size mismatch: ' + logical);
    return JSON.parse(decoded);
  };
  let board, source;
  if (Object.hasOwn(index.files, 'overall.json')) {
    board = await payload('overall.json'); source = 'monolith';
  } else {
    const manifest = await payload('overall-manifest.json');
    demand(manifest.kind === 'overall-manifest' && manifest.complete === true &&
      manifest.sourceComplete === true && manifest.ranksExact === true && manifest.totalEntriesExact === true &&
      Array.isArray(manifest.pageBounds) && Number.isSafeInteger(manifest.pageCount) &&
      manifest.pageCount >= 0 && manifest.pageCount <= 10000 &&
      manifest.pageBounds.length === manifest.pageCount && manifest.totalEntries === manifest.publishedEntries,
    'Incomplete overall page manifest');
    const entries = [];
    for (const [i, bound] of manifest.pageBounds.entries()) {
      demand(bound.pageNumber === i + 1 && bound.path === `overall-pages/${i + 1}.json` &&
        bound.offset === entries.length && positive(bound.count), 'Invalid overall page bound');
      const page = await payload(bound.path);
      demand(page.kind === 'overall-page' && page.pageNumber === i + 1 && page.offset === entries.length &&
        page.sourceComplete === true && page.ranksExact === true && page.totalEntriesExact === true &&
        page.algorithmVersion === manifest.algorithmVersion && page.schemaVersion === manifest.schemaVersion &&
        page.revision === manifest.revision && page.sourceRevision === manifest.sourceRevision &&
        page.totalEntries === manifest.totalEntries && page.publishedEntries === manifest.publishedEntries &&
        page.pageCount === manifest.pageCount && Array.isArray(page.entries) &&
        page.entries.length === bound.count && page.count === bound.count, 'Invalid overall page: ' + bound.path);
      entries.push(...page.entries);
    }
    board = {...manifest.boardMetadata, ...manifest, entries}; source = 'pages';
  }
  demand(Array.isArray(board.entries) && board.complete === true &&
    board.sourceComplete !== false && board.ranksExact !== false && board.totalEntriesExact !== false &&
    board.totalEntries === board.entries.length, 'Incomplete overall observation');
  const identities = new Set(), ranks = new Set();
  for (const row of board.entries) {
    const id = row?.accountId || row?.userId;
    demand(ID.test(id || '') && (!row.accountId || !row.userId || row.accountId === row.userId) &&
      !identities.has(id), 'Invalid or duplicate overall identity');
    identities.add(id);
    if (row.provisional === true) continue;
    demand(positive(row.rank) && (row.globalRank == null || row.globalRank === row.rank) &&
      !ranks.has(row.rank), 'Invalid or duplicate overall rank');
    ranks.add(row.rank);
  }
  const model = JSON.stringify([board.seasonId ?? board.season?.id ??
    (typeof board.season === 'string' || typeof board.season === 'number' ? board.season : null)]);
  demand(typeof board.algorithmVersion === 'string' && board.algorithmVersion.length > 0, 'Missing overall model');
  return {directory, indexHash: hash(indexBytes), publishedAt: index.publishedAt, board, model,
    rankingModel: board.algorithmVersion, source};
}

// Each tuple describes consecutive publication observations, never exact tenure.
export function advanceHistory(previous, observation, previousObservation) {
  const next = new Map();
  const continuous = previousObservation && observation.model === previousObservation.model &&
    observation.at >= previousObservation.at && observation.at - previousObservation.at <= GAP;
  for (const row of observation.board.entries) {
    if (row.provisional === true) continue;
    const id = row.accountId || row.userId, prior = continuous ? previous.get(id) : null;
    const model = JSON.stringify([observation.model, row.seasonId ?? null]);
    next.set(id, prior && prior.rank === row.rank && prior.model === model ?
      {...prior, count: prior.count + 1} : {rank: row.rank, since: observation.at, count: 1, model});
  }
  return next;
}

export async function buildOverallRankHistory({root = ROOT, report, now = Date.now(), gitRead} = {}) {
  root = path.resolve(root);
  demand(positive(now), 'Invalid build timestamp');
  if (report) {
    report = path.resolve(report);
    const relative = path.relative(root, report);
    demand(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative), 'Report must be outside repository');
    await fs.access(path.dirname(report));
  }
  const git = gitRead || (args => execFileSync('git', ['--no-optional-locks', '-C', root, ...args],
    {maxBuffer: LIMIT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
      env: {...process.env, GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0'}}));
  const show = (commit, name) => {
    try { return git(['show', `${commit}:${name}`]); }
    catch { throw Error(`Unavailable Git payload: ${commit}:${name}`); }
  };
  const head = git(['rev-parse', 'HEAD']).toString().trim();
  const log = git(['log', '--first-parent', '--reverse', '--format=%H %ct', head, '--', 'snapshot-current.json'])
    .toString().trim().split('\n').filter(Boolean);
  demand(log.length > 0 && log.length <= 10000, 'Invalid or excessive publication history');
  let state = new Map(), previous = null, final = null, observations = 0, coverageStart = null, lastGitAt = 0;
  const invalid = [], boundaries = [], modelChanges = [], counts = {monolith: 0, pages: 0, working: 0};
  const accept = observation => {
    demand(positive(observation.at) && observation.at <= now, 'Invalid or future publication timestamp');
    if (previous && observation.rankingModel !== previous.rankingModel)
      modelChanges.push({at: observation.at, from: previous.rankingModel, to: observation.rankingModel, resetsPosition: false});
    if (previous && (observation.at < previous.at || observation.at - previous.at > GAP || observation.model !== previous.model)) {
      boundaries.push({commit: observation.commit, at: observation.at, reason: observation.at < previous.at ?
        'nonmonotonic-publication-time' : observation.model !== previous.model ? 'season-boundary' : 'gap-over-seven-days'});
      state = new Map(); previous = null;
    }
    state = advanceHistory(state, observation, previous); previous = observation; final = observation;
    observations++; coverageStart ??= observation.at; counts[observation.source]++;
  };
  const shallow = git(['rev-parse', '--is-shallow-repository']).toString().trim() === 'true';
  if (shallow) {
    const base = JSON.parse(show(head, 'tools/overall-rank-history.json'));
    const headPointer = JSON.parse(show(head, 'snapshot-current.json'));
    const baseline = await readOverall(name => show(head, name), headPointer.currentdir);
    demand(base.schemaVersion === 1 && base.directory === headPointer.currentdir && positive(base.observedAt) &&
      base.observedAt <= now && positive(base.coverageStart) && base.coverageStart <= base.observedAt &&
      positive(base.observations) && base.rows && typeof base.rows === 'object' && !Array.isArray(base.rows),
    'Shallow history needs a valid committed artifact paired with HEAD');
    const ranked = baseline.board.entries.filter(row => row.provisional !== true);
    demand(Object.keys(base.rows).length === ranked.length, 'Shallow base ranked coverage mismatch');
    for (const row of ranked) {
      const id = row.accountId || row.userId, tuple = base.rows[id];
      demand(Array.isArray(tuple) && tuple.length === 3 && tuple[0] === row.rank && positive(tuple[1]) &&
        tuple[1] >= base.coverageStart && tuple[1] <= base.observedAt && positive(tuple[2]) && tuple[2] <= base.observations,
      'Shallow base rank or observation mismatch: ' + id);
      state.set(id, {rank: tuple[0], since: tuple[1], count: tuple[2], model: JSON.stringify([baseline.model, row.seasonId ?? null])});
    }
    previous = final = {...baseline, at: base.observedAt, commit: head};
    observations = base.observations; coverageStart = base.coverageStart; lastGitAt = base.observedAt;
  }
  for (const line of shallow ? [] : log) {
    const [commit, seconds] = line.trim().split(/\s+/), at = Number(seconds) * 1000;
    if (positive(at)) lastGitAt = Math.max(lastGitAt, at);
    try {
      const pointer = JSON.parse(show(commit, 'snapshot-current.json'));
      accept({...await readOverall(name => show(commit, name), pointer.currentdir), commit, at});
    } catch (error) {
      invalid.push({commit, at, reason: error.message});
      state = new Map(); previous = null; final = null;
    }
  }
  const workingPointerBytes = await fs.readFile(path.join(root, 'snapshot-current.json'));
  const pointer = JSON.parse(workingPointerBytes);
  demand(directoryValid(pointer.currentdir), 'Invalid working pointer');
  const workingIndexBytes = await fs.readFile(path.join(root, pointer.currentdir, 'index.json'));
  const headPointer = JSON.parse(show(head, 'snapshot-current.json'));
  const differs = headPointer.currentdir !== pointer.currentdir ||
    hash(show(head, headPointer.currentdir + '/index.json')) !== hash(workingIndexBytes);
  if (differs) {
    const working = await readOverall(name => fs.readFile(path.join(root, name)), pointer.currentdir);
    const published = working.publishedAt;
    const at = positive(published) && published <= now && published >= lastGitAt ? published : now;
    accept({...working, commit: 'working-tree', at}); counts.working++;
  }
  demand(final && final.directory === pointer.currentdir && final.indexHash === hash(workingIndexBytes),
    'Latest package unavailable or invalid; refusing stale history');
  demand((await fs.readFile(path.join(root, 'snapshot-current.json'))).equals(workingPointerBytes) &&
    (await fs.readFile(path.join(root, pointer.currentdir, 'index.json'))).equals(workingIndexBytes), 'Working package changed during build');
  const rows = Object.fromEntries([...state].sort(([a], [b]) => a.localeCompare(b))
    .map(([id, value]) => [id, [value.rank, value.since, value.count]]));
  const artifact = {schemaVersion: 1, directory: final.directory, observedAt: final.at, rows, observations, coverageStart};
  const bytes = Buffer.from(JSON.stringify(artifact) + '\n');
  demand(bytes.length <= 1024 * 1024, 'History artifact exceeds static UI 1 MiB limit');
  const summary = {schemaVersion: 1, semantics: 'Consecutive observed rank, not exact tenure; raw rankSince ignored',
    head, directory: final.directory, latestObservedAt: final.at, observedAt: artifact.observedAt,
    coverageStart, observations, attemptedGitObservations: shallow ? 0 : log.length, incrementalShallowBase: shallow, rows: state.size, bytes: bytes.length,
    recoveredRows: [...state.values()].filter(row => row.count > 1).length, counts, invalid, boundaries, modelChanges,
    top10: [...state].sort(([, a], [, b]) => a.rank - b.rank).slice(0, 10)
      .map(([accountId, row]) => ({accountId, rank: row.rank, since: row.since,
        observedSince: new Date(row.since).toISOString(), count: row.count}))};
  await fs.writeFile(path.join(root, 'tools/overall-rank-history.json'), bytes);
  if (report) await fs.writeFile(report, JSON.stringify(summary, null, 2) + '\n');
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  demand(args.length === 0 || args.length === 2 && args[0] === '--report',
    'Usage: node tools/build-overall-rank-history.mjs [--report <private-path.json>]');
  const summary = await buildOverallRankHistory({report: args[1]});
  console.log(JSON.stringify(summary));
}
