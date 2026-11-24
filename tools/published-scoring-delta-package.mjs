import {PRIVATE_SNAPSHOT_INDEX_BYTES, readPrivateSnapshotIndex} from './private-snapshot-index.mjs';
import {promises as fs, constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {loadPublishedRollingCohort, proposePublishedRollingRebalance} from './rebalance-published-rolling-hills.mjs';
import {encodeSnapshot, decodeSnapshot, buildSnapshotLookupShards, MAX_FILE_BYTES, MAX_DECODED_BYTES} from './snapshot-package.mjs';
import {buildSnapshotBootstrapIndex, buildSnapshotFastIndex} from './track-snapshot-paging.mjs';

export const SCORING_DELTA_PATHS = Object.freeze(['event-totals.json', 'events/permanent-rolling-hills.json', 'manifest.json']);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value) + '\n');
const demand = (ok, reason) => {if (!ok) throw Error('scoring_delta_' + reason);};
const inside = (child, parent) => {const rel = path.relative(parent, child); return !rel || !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel);};
const validRecord = record => record && /^[a-f0-9]{64}$/.test(record.sha256) && record.path === record.sha256 + '.bin' &&
  Number.isSafeInteger(record.decodedBytes) && record.decodedBytes >= 0 && record.decodedBytes <= MAX_DECODED_BYTES;
const validLogical = logical => typeof logical === 'string' && /^[A-Za-z0-9._/-]+$/.test(logical) &&
  logical.split('/').every(part => part && part !== '.' && part !== '..');
async function each(items, work) {
  let cursor = 0;
  const results = await Promise.allSettled(Array.from({length: Math.min(16, items.length)}, async () => {
    while (cursor < items.length) {const item = items[cursor++]; await work(item);}
  }));
  const failure = results.find(result => result.status === 'rejected'); if (failure) throw failure.reason;
}
function metadataFiles(index) {
  const output = new Map([['index.json', json(index)], ['bootstrap-index.json', json(buildSnapshotBootstrapIndex(index))],
    ['bootstrap-fast.json', json(buildSnapshotFastIndex(index))]]);
  for (const [bucket, shard] of buildSnapshotLookupShards(index)) output.set('lookup-shards/' + bucket + '.json', json(shard));
  return output;
}

// Validate exact directory contents and unchanged record identity without decoding any unchanged payload.
export async function validateScoringDeltaDirectory({directory, sourceIndex, index}) {
  demand(index.generation === sourceIndex.generation + 1 && index.encoding === sourceIndex.encoding && index.lookupShardsVersion === 1, 'generation');
  const oldKeys = Object.keys(sourceIndex.files).sort(), keys = Object.keys(index.files).sort();
  demand(JSON.stringify(oldKeys) === JSON.stringify(keys), 'logical_inventory_changed');
  const changed = keys.filter(key => JSON.stringify(index.files[key]) !== JSON.stringify(sourceIndex.files[key]));
  demand(JSON.stringify(changed) === JSON.stringify([...SCORING_DELTA_PATHS].sort()), 'patch_allowlist');
  const expected = new Map(), metadata = metadataFiles(index);
  for (const [logical, record] of Object.entries(index.files)) {
    demand(validLogical(logical) && validRecord(record), 'unsafe_record');
    expected.set(record.path, {sha256: record.sha256});
  }
  for (const [name, data] of metadata) expected.set(name, {sha256: sha(data)});
  const seen = new Set();
  async function inventory(current, prefix = '') {
    for (const item of await fs.readdir(current, {withFileTypes: true})) {
      const name = prefix + item.name, file = path.join(current, item.name), stat = await fs.lstat(file);
      demand(!stat.isSymbolicLink(), 'candidate_link');
      if (stat.isDirectory()) {demand(name === 'lookup-shards', 'extraneous_directory'); await inventory(file, name + '/');}
      else {demand(stat.isFile() && stat.nlink === 1 && expected.has(name) && stat.size <= (name==='index.json'?PRIVATE_SNAPSHOT_INDEX_BYTES:MAX_FILE_BYTES), 'extraneous_or_linked_file'); seen.add(name);}
    }
  }
  await inventory(directory); demand(seen.size === expected.size, 'missing_file');
  await each([...expected], async ([name, record]) => {
    const file = path.join(directory, name), before = await fs.lstat(file), data = await fs.readFile(file), after = await fs.lstat(file);
    demand(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && after.nlink === 1 &&
      before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && sha(data) === record.sha256, 'candidate_hash_changed');
  });
  return {logicalFiles: keys.length, physicalFiles: expected.size, changedLogicalPaths: changed,
    unchangedLogicalFiles: keys.length - changed.length, allLinksOne: true, allEncodedHashesVerified: true};
}

export async function buildPublishedScoringDeltaPackage(options) {
  demand(options && Object.keys(options).every(key => ['sourceRoot','outputRoot','expectedGeneration','expectedIndexSha256','now'].includes(key)), 'unsupported_option');
  const {sourceRoot, expectedGeneration, expectedIndexSha256, now = Date.now} = options;
  const source = await fs.realpath(sourceRoot), output = path.resolve(options.outputRoot);
  const parent = await fs.realpath(path.dirname(output));
  demand(parent.toLowerCase() === path.dirname(output).toLowerCase() && !inside(output, source) && !inside(source, output), 'overlapping_or_linked_roots');
  const cohort = await loadPublishedRollingCohort({root: source, expectedGeneration, expectedIndexSha256});
  const proposal = proposePublishedRollingRebalance(cohort), sourceDirectory = path.join(source, cohort.baseline.provenance.currentdir);
  const indexBytes = await readPrivateSnapshotIndex(path.resolve(sourceDirectory,'index.json'));
  demand(sha(indexBytes) === expectedIndexSha256, 'source_index_hash');
  const sourceIndex = JSON.parse(indexBytes);
  demand(Object.keys(sourceIndex.files).length <= 100000 && sourceIndex.encoding === 'gzip-xor-a7-v1', 'source_index_schema');
  for (const [logical, record] of Object.entries(sourceIndex.files)) demand(validLogical(logical) && validRecord(record), 'source_record');
  demand(!Object.keys(sourceIndex.files).some(key => /^(?:event-totals[/.]|erp[/-])/.test(key) && key !== 'event-totals.json'), 'unsupported_derived_erp_view');
  const manifestRecord = sourceIndex.files['manifest.json']; demand(validRecord(manifestRecord), 'manifest_missing');
  const manifestPath = path.join(sourceDirectory, manifestRecord.path), manifestStat = await fs.lstat(manifestPath);
  demand(manifestStat.isFile() && !manifestStat.isSymbolicLink() && manifestStat.nlink === 1 && manifestStat.size <= MAX_FILE_BYTES, 'manifest_link_or_size');
  const manifestEncoded = await fs.readFile(manifestPath);
  demand(sha(manifestEncoded) === manifestRecord.sha256, 'manifest_hash');
  const manifestDecoded = Buffer.from(await decodeSnapshot(manifestEncoded));
  demand(manifestDecoded.length === manifestRecord.decodedBytes, 'manifest_length');
  const manifest = JSON.parse(manifestDecoded);
  const logical = 'events/permanent-rolling-hills.json';
  demand(manifest.schemaVersion === 1 && manifest.events?.[proposal.rolling.id]?.path === logical &&
    manifest.permanentRollingHills?.path === logical && manifest.nativeVerificationLedger?.manifestHash &&
    manifest.nativeVerificationLedger?.policyFingerprint, 'manifest_cohort');
  const rollingBytes = Buffer.from(JSON.stringify(proposal.rolling)), totalsBytes = Buffer.from(JSON.stringify(proposal.totals));
  const record = {...manifest.events[proposal.rolling.id], path: logical, updatedAt: proposal.rolling.updatedAt,
    sha256: sha(rollingBytes), scoreVersion: proposal.targetScoreVersion, maxRp: proposal.rolling.maxRp};
  manifest.events[proposal.rolling.id] = record;
  manifest.permanentRollingHills = {...manifest.permanentRollingHills, ...record};
  manifest.publishedScoringDelta = {kind: 'published-rolling-cohort-rebalance-v1', sourceGeneration: expectedGeneration,
    sourceIndexSha256: expectedIndexSha256, sourceTotalsSha256: cohort.baseline.provenance.totalsSha256,
    sourceRollingSha256: cohort.inputs.rolling.sha256, sourceScoreVersion: proposal.sourceScoreVersion,
    targetScoreVersion: proposal.targetScoreVersion, scoringFormula: proposal.scoringFormula,
    totalsDecodedSha256: sha(totalsBytes), rollingDecodedSha256: sha(rollingBytes), freshSourceCapture: false, newVerification: false};
  const patches = new Map([[logical, proposal.rolling], ['event-totals.json', proposal.totals], ['manifest.json', manifest]]);
  const index = {...sourceIndex, generation: expectedGeneration + 1, publishedAt: now(), files: {...sourceIndex.files}};
  demand(Number.isSafeInteger(index.publishedAt) && index.publishedAt >= sourceIndex.publishedAt, 'candidate_time');
  const encodedPatches = new Map();
  for (const [name, value] of patches) {
    const data = Buffer.from(JSON.stringify(value)); demand(data.length <= MAX_DECODED_BYTES, 'patch_too_large');
    const encoded = await encodeSnapshot(value), digest = sha(encoded);
    index.files[name] = {path: digest + '.bin', sha256: digest, decodedBytes: data.length};
    encodedPatches.set(digest + '.bin', encoded);
  }
  // Fail before creating output if encoded JSON format differs from the existing codec.
  for (const [name, encoded] of encodedPatches) {
    const decoded = Buffer.from(await decodeSnapshot(encoded));
    const record = Object.values(index.files).find(item => item.path === name);
    demand(decoded.length === record.decodedBytes, 'codec_length');
  }
  const metadata = metadataFiles(index);
  demand(metadata.get('index.json').length <= PRIVATE_SNAPSHOT_INDEX_BYTES && metadata.get('bootstrap-index.json').length <= MAX_DECODED_BYTES, 'metadata_too_large');
  await fs.mkdir(output);
  const directory = path.join(output, 'public-snapshots' + index.generation); await fs.mkdir(directory);
  const paths = [...new Set(Object.values(index.files).map(record => record.path))];
  await each(paths, async name => {
    const destination = path.join(directory, name);
    if (encodedPatches.has(name)) await fs.writeFile(destination, encodedPatches.get(name), {flag: 'wx'});
    else {
      const from = path.join(sourceDirectory, name), before = await fs.lstat(from);
      demand(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= MAX_FILE_BYTES, 'source_link_or_size');
      await fs.copyFile(from, destination, constants.COPYFILE_EXCL);
      const after = await fs.lstat(from);
      demand(after.ino === before.ino && after.size === before.size && after.mtimeMs === before.mtimeMs && !after.isSymbolicLink(), 'source_changed');
    }
  });
  await fs.mkdir(path.join(directory, 'lookup-shards'));
  for (const [name, data] of metadata) await fs.writeFile(path.join(directory, name), data, {flag: 'wx'});
  const validation = await validateScoringDeltaDirectory({directory, sourceIndex, index});
  demand(sha(await fs.readFile(path.join(sourceDirectory, 'index.json'))) === expectedIndexSha256 &&
    sha(await fs.readFile(path.join(source, 'snapshot-current.json'))) === cohort.baseline.provenance.pointerSha256, 'source_cohort_changed');
  const receipt = {format: 'published-scoring-delta-package-receipt-v1', unpublished: true, source: cohort.baseline.provenance,
    candidate: {generation: index.generation, directory, indexSha256: sha(metadata.get('index.json'))},
    targetScoreVersion: proposal.targetScoreVersion, scoringFormula: proposal.scoringFormula, validation,
    patches: Object.fromEntries(SCORING_DELTA_PATHS.map(key => [key, {before: sourceIndex.files[key], after: index.files[key]}])),
    encodedPayloadsReused: paths.length - encodedPatches.size, encodedPayloadsGenerated: encodedPatches.size,
    omittedMonolithsPreserved: !index.files['overall.json'], pointerWritten: false,
    databaseReads: 0, databaseWrites: 0, nativeDispatched: 0, publicationPerformed: false};
  await fs.writeFile(path.join(output, 'build-receipt.json'), json(receipt), {flag: 'wx'});
  return receipt;
}
