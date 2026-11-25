import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {advanceHistory, advancePublishedRankArtifact, readOverall, buildOverallRankHistory} from './build-overall-rank-history.mjs';

const ID = 'a'.repeat(64), OTHER = 'b'.repeat(64), COMMIT = 'c'.repeat(40);
const NOW = 1700001000000, OLD = NOW - 10000;
const observation = (rank = 1, at = OLD, extra = {}) => ({at, model: '[null]', rankingModel: 'v1',
  board: {entries: [{userId: ID, rank, rankSince: 1}]}, ...extra});

function pack(generation, values, publishedAt = NOW - 1000) {
  const directory = 'public-snapshots' + generation, files = {}, blobs = new Map();
  for (const [logical, value] of Object.entries(values)) {
    const decoded = Buffer.from(JSON.stringify(value)), encoded = gzipSync(decoded).map(byte => byte ^ 167);
    const sha256 = createHash('sha256').update(encoded).digest('hex');
    files[logical] = {path: sha256 + '.bin', sha256, decodedBytes: decoded.length};
    blobs.set(directory + '/' + sha256 + '.bin', encoded);
  }
  const index = {schemaVersion: 1, generation, encoding: 'gzip-xor-a7-v1', publishedAt, files};
  const refresh = () => blobs.set(directory + '/index.json', Buffer.from(JSON.stringify(index)));
  refresh();
  return {directory, index, blobs, refresh, read: async name => {
    if (!blobs.has(name)) throw Error('Unavailable fixture payload: ' + name);
    return blobs.get(name);
  }};
}
const board = (rank = 1, extra = {}) => ({schemaVersion: 6, algorithmVersion: 'v1', complete: true,
  totalEntries: 1, entries: [{userId: ID, rank, rankSince: 1}], ...extra});

test('same position survives formula migration, not season/gap/position changes', () => {
  const a = observation(), state = advanceHistory(new Map(), a, null);
  const b = observation(1, OLD + 1, {rankingModel: 'v2'});
  const retained = advanceHistory(state, b, a).get(ID);
  assert.equal(retained.since, OLD); assert.equal(retained.count, 2);
  for (const changed of [observation(2, OLD + 1), observation(1, OLD + 1, {model: '["new-season"]'}),
    observation(1, OLD + 7 * 86400000 + 1), observation(1, OLD - 1)]) {
    assert.equal(advanceHistory(state, changed, a).get(ID).count, 1);
  }
  assert.equal(advanceHistory(state, observation(1, OLD + 7 * 86400000), a).get(ID).count, 2);
  assert.equal(retained.since > 1, true, 'raw rankSince is ignored');
});

test('A to B to A, absence, provisional status and invalid capture break continuity', () => {
  const a = observation(), initial = advanceHistory(new Map(), a, null), b = observation(2, OLD + 1);
  const changed = advanceHistory(initial, b, a);
  assert.equal(advanceHistory(changed, observation(1, OLD + 2), b).get(ID).since, OLD + 2);
  for (const entries of [[], [{userId: OTHER, rank: 1}], [{userId: ID, rank: 1, provisional: true}]]) {
    const absent = observation(1, OLD + 1, {board: {entries}});
    assert.equal(advanceHistory(advanceHistory(initial, absent, a), observation(1, OLD + 2), absent).get(ID).count, 1);
  }
  assert.equal(advanceHistory(new Map(), observation(1, OLD + 2), null).get(ID).since, OLD + 2);
});

test('hash/size checks and bounded legacy monoliths', async () => {
  let p = pack(88, {'overall.json': board(1, {padding: 'x'.repeat(3 * 1024 * 1024)})});
  assert.equal((await readOverall(p.read, p.directory)).source, 'monolith');
  p.index.files['overall.json'].sha256 = 'f'.repeat(64); p.refresh();
  await assert.rejects(readOverall(p.read, p.directory), /SHA256/);
  p = pack(88, {'overall.json': board()}); p.index.files['overall.json'].decodedBytes++; p.refresh();
  await assert.rejects(readOverall(p.read, p.directory), /size/);
  p = pack(88, {'overall.json': board(1, {complete: false})});
  await assert.rejects(readOverall(p.read, p.directory), /Incomplete/);
});

test('full pages required and mixed revisions rejected', async () => {
  const metadata = {schemaVersion: 6, algorithmVersion: 'v1', revision: 1, sourceRevision: 1,
    sourceComplete: true, ranksExact: true, totalEntriesExact: true, totalEntries: 1, publishedEntries: 1, pageCount: 1};
  const manifest = {...metadata, kind: 'overall-manifest', complete: true,
    pageBounds: [{pageNumber: 1, path: 'overall-pages/1.json', offset: 0, count: 1}]};
  const page = {...metadata, kind: 'overall-page', pageNumber: 1, offset: 0, count: 1, entries: board().entries};
  let p = pack(88, {'overall-manifest.json': manifest, 'overall-pages/1.json': page});
  assert.equal((await readOverall(p.read, p.directory)).source, 'pages');
  p = pack(88, {'overall-manifest.json': manifest, 'overall-pages/1.json': {...page, revision: 2}});
  await assert.rejects(readOverall(p.read, p.directory), /Invalid overall page/);
  p = pack(88, {'overall-manifest.json': manifest});
  await assert.rejects(readOverall(p.read, p.directory), /descriptor/);
});

async function fixture(t, {shallow = false, broken = false} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'overall-history-test-'));
  // No Git writes, commits, network, or verification: Git reads are injected.
  const saved = pack(87, {'overall.json': board()}, OLD - 1000), source = new Map(saved.blobs);
  source.set('snapshot-current.json', Buffer.from(JSON.stringify({currentdir: saved.directory})));
  source.set('tools/overall-rank-history.json', Buffer.from(JSON.stringify({schemaVersion: 1,
    directory: saved.directory, observedAt: OLD, coverageStart: OLD - 1000, observations: 7,
    rows: {[ID]: [1, OLD - 1000, 7]}})));
  if (broken) source.delete(saved.directory + '/' + saved.index.files['overall.json'].path);
  const gitRead = args => {
    if (args[0] === 'rev-parse') return Buffer.from(args[1] === '--is-shallow-repository' ? String(shallow) : COMMIT);
    if (args[0] === 'log') return Buffer.from(COMMIT + ' ' + OLD / 1000);
    if (args[0] === 'show') {
      const name = args[1].slice(41); if (!source.has(name)) throw Error('Unavailable fixture payload');
      return source.get(name);
    }
    throw Error('Unexpected Git operation');
  };
  await fs.mkdir(path.join(root, 'tools'));
  const working = async (g = 88, extra = {}, at = NOW - 1000) => {
    const p = pack(g, {'overall.json': board(1, extra)}, at);
    await fs.mkdir(path.join(root, p.directory), {recursive: true});
    for (const [name, bytes] of p.blobs) await fs.writeFile(path.join(root, name), bytes);
    await fs.writeFile(path.join(root, 'snapshot-current.json'), JSON.stringify({currentdir: p.directory}));
    return p;
  };
  await working();
  return {root, source, working, run: options => buildOverallRankHistory({root, now: NOW, gitRead, ...options})};
}

test('working pointer appended with exact publication timestamp and bounded compact schema', async t => {
  const f = await fixture(t), report = await f.run();
  const bytes = await fs.readFile(path.join(f.root, 'tools/overall-rank-history.json')), artifact = JSON.parse(bytes);
  assert.equal(artifact.directory, 'public-snapshots88'); assert.equal(artifact.observedAt, NOW - 1000);
  assert.equal(artifact.observedAt, report.latestObservedAt); assert.equal(artifact.rows[ID][2], 2);
  assert.equal(artifact.rows[ID][1], OLD); assert.ok(bytes.length <= 1024 * 1024);
  await f.working(88, {}, null); assert.equal((await f.run()).observedAt, NOW);
});

test('shallow committed base retains tenure without double counting HEAD; same pointer supported', async t => {
  const f = await fixture(t, {shallow: true});
  let report = await f.run(); assert.equal(report.observations, 8); assert.equal(report.top10[0].since, OLD - 1000);
  assert.equal(report.top10[0].count, 8); assert.equal(report.incrementalShallowBase, true);
  await f.working(87, {}, OLD - 1000); report = await f.run();
  assert.equal(report.observations, 7); assert.equal(report.observedAt, OLD);
  await f.working(88, {algorithmVersion: 'v2'}); report = await f.run();
  assert.equal(report.top10[0].count, 8); assert.equal(report.modelChanges.length, 1);
  await f.working(88, {seasonId: 'new-season'}); report = await f.run();
  assert.equal(report.top10[0].count, 1);
});

test('missing historical payload reported, corrupt current fails, invalid shallow base never overwrites', async t => {
  const f = await fixture(t, {broken: true}); let report = await f.run();
  assert.equal(report.invalid.length, 1); assert.equal(report.top10[0].count, 1);
  const p = await f.working(); await fs.writeFile(path.join(f.root, p.directory, p.index.files['overall.json'].path), 'corrupt');
  await assert.rejects(f.run(), /SHA256/);
  const shallow = await fixture(t, {shallow: true}); shallow.source.delete('tools/overall-rank-history.json');
  await assert.rejects(shallow.run(), /Unavailable Git payload/);
  await assert.rejects(fs.access(path.join(shallow.root, 'tools/overall-rank-history.json')));
});
test('incremental artifact checks the baseline board and keeps existing tenure only at an unchanged rank',()=>{
  const a=observation(1,OLD,{directory:'public-snapshots93'});
  const base={schemaVersion:1,directory:a.directory,observedAt:OLD,coverageStart:OLD-100,observations:2,rows:{[ID]:[1,OLD-100,2]}};
  const b=observation(1,NOW,{directory:'public-snapshots94'});
  assert.deepEqual(advancePublishedRankArtifact(base,a,b).rows[ID],[1,OLD-100,3]);
  assert.deepEqual(advancePublishedRankArtifact(base,a,{...b,board:{entries:[{userId:ID,rank:2}]}}).rows[ID],[2,NOW,1]);
  assert.throws(()=>advancePublishedRankArtifact({...base,rows:{[ID]:[3,OLD,2]}},a,b),/does not match/);
  assert.throws(()=>advancePublishedRankArtifact(base,a,a),/newer snapshot/);
});

test('routine incremental mode skips historical reads only with a matching committed baseline',async t=>{
  const f=await fixture(t), options={preferCommittedBaseline:true};
  let report=await f.run(options);
  assert.equal(report.reusedCommittedBaseline,true);
  assert.equal(report.attemptedGitObservations,0);
  assert.equal(report.top10[0].count,8);
  f.source.delete('tools/overall-rank-history.json');
  report=await f.run(options);
  assert.equal(report.reusedCommittedBaseline,false);
  assert.equal(report.attemptedGitObservations,1);
  assert.equal(report.top10[0].count,2);
});
