import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {trackMenuReadContract} from './track-menu-read-contract.mjs';
import {checkRepositoryExtraVerification} from './extra-verification-check.mjs';
import {buildNamePolicy} from './build-name-policy.mjs';
import {validateEnginePin} from './verifier/run.mjs';
import {privatePublicationPaths} from './publication-privacy.mjs';

import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {snapshot} from './verifier/assets.cjs';
import {reviewedWatchUiBaseline} from './verifier/watch-ui-review.mjs';
import {PLAYBACK_ENGINE_PIN} from './playback-engine-pin.mjs';
import {sameHashMap} from './verifier/engine-pin.cjs';
import {VERIFIER_ENGINE_DIGEST,VERIFICATION_BOOTSTRAP_ID} from '../workers/ranked/src/verification.js';
const root = resolve(import.meta.dirname, '..');
const failures = [];
const tracked = spawnSync('git', ['ls-files', '-z', '--', 'docs/security', 'workers/ranked/test/quota-rules-candidate.test.js', '*.rules', '*.rules.*', '*firebase-config.local*', '*service-account*', '*serviceAccount*', '*firebase-adminsdk*', '*service_account*', '*credentials*.json', '.env*', '**/.env*', '.dev.vars*', '**/.dev.vars*', '*.pem', '*.p12', '*.key'], {cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024});
if (tracked.status !== 0) failures.push('Cannot verify tracked publication files. Run release checks from a Git checkout.');
else for (const file of privatePublicationPaths(tracked.stdout.split('\0').filter(Boolean))) failures.push('Private file remains tracked: ' + file);
try { await validateEnginePin(); }
catch (error) { failures.push('Verifier engine pin: ' + error.message); }

try {
 const sha=value=>createHash('sha256').update(value).digest('hex');
 const json=file=>JSON.parse(readFileSync(join(root,file),'utf8'));
 const lf=file=>readFileSync(join(root,file),'utf8').replace(/\r\n?/g,'\n');
 const pin=json('tools/verifier/engine-manifest.json'),indexed=json('tools/verifier/indexed-playback-review.json');
 const actual=snapshot(root);
 assert.equal(actual.engineFingerprint,VERIFIER_ENGINE_DIGEST);assert.equal(pin.engineDigest,VERIFIER_ENGINE_DIGEST);
 assert(sameHashMap(actual.manifest,pin.files));assert(sameHashMap(actual.tracks,pin.tracks));
 const baseline=reviewedWatchUiBaseline(pin),indexedFiles=baseline.files;
 assert.equal(PLAYBACK_ENGINE_PIN.engineDigest,VERIFIER_ENGINE_DIGEST);
 assert.equal(PLAYBACK_ENGINE_PIN.mainSha256,pin.files['main.bundle.js']);
 assert.equal(PLAYBACK_ENGINE_PIN.workerSha256,pin.files['simulation_worker.bundle.js']);
 assert.equal(indexed.currentEngine,baseline.review.previousEngine);
 assert.equal(indexed.currentEngine,'3cb2e59839b5ad85ea34d892e1f10ca7dc04f9d8cec17770fbd843673614a3a0');
 assert.equal(indexed.previousEngine,'7cd54f05e02b66c67133fd856f025c829c21d600d8ef6a9071df62b4fb5905c4');
 assert.equal(indexed.previousReview,'docs/events/opponent-shortcut-ui-engine-review.json');
 assert.equal(sha(lf(indexed.previousReview)),indexed.previousReviewSha256);
 assert.deepEqual(indexed.changedAssets,['simulation_worker.bundle.js']);
 assert.deepEqual(Object.keys(indexed.currentAssets),indexed.changedAssets);assert.deepEqual(Object.keys(indexed.previousAssets),indexed.changedAssets);
 for(const [file,hash]of Object.entries({...indexed.unchangedAssets,...indexed.currentAssets}))assert.equal(indexedFiles[file],hash);
 assert.equal(sha(JSON.stringify(indexedFiles)),indexed.currentEngine);
 const correction=indexed.persistentCapabilityCorrection;assert.equal(correction.currentEngine,indexed.currentEngine);assert.equal(correction.consumerPassed,true);assert.equal(correction.browserClosed,true);assert.equal(correction.serverClosed,true);assert.equal(correction.physicsAndLookupUnchanged,true);
 const worker=lf('simulation_worker.bundle.js');assert.equal(sha(worker),correction.currentWorkerSha256);assert.equal(worker.split(correction.after).length,2);assert.equal(sha(worker.replace(correction.after,correction.before)),correction.priorDraftWorkerSha256);
 assert.equal(sha(indexed.lookupEvidence.indexedExpression),indexed.lookupEvidence.indexedExpressionSha256);assert(worker.includes('ka='+indexed.lookupEvidence.indexedExpression));
 const opponentFiles={...indexedFiles,...indexed.previousAssets};assert.equal(sha(JSON.stringify(opponentFiles)),indexed.previousEngine);
 const opponent=json(indexed.previousReview),native=json('docs/events/native-row-ui-engine-review.json'),replay=json('docs/events/replay-ui-engine-review.json'),historical=json('docs/migration/engine-review.json');
 assert.equal(opponent.currentEngine,indexed.previousEngine);assert.equal(opponent.previousEngine,native.currentEngine);assert.equal(native.previousEngine,replay.currentEngine);assert.equal(replay.previousEngine,historical.engineDigest);
 for(const review of [opponent,native,replay])if(review.previousReviewSha256)assert.equal(sha(lf(review.previousReview)),review.previousReviewSha256);
 assert.deepEqual(opponent.changedAssets,['main.bundle.js']);
 assert.deepEqual(indexed.previousAssets,opponent.unchangedSimulationAssets);
 assert.equal(opponentFiles['main.bundle.js'],opponent.currentMainBundleSha256);
 assert.equal(sha(JSON.stringify({...opponentFiles,'main.bundle.js':opponent.previousMainBundleSha256})),opponent.previousEngine);
 for(const [file,hash]of Object.entries(historical.unchangedPhysicsAssets))assert.equal(pin.files[file],hash);
 assert.equal(sha(JSON.stringify(Object.entries(pin.tracks).sort(([a],[b])=>a<b?-1:a>b?1:0))),indexed.trackPinsSha256);
 assert.equal(indexed.trackPinsSha256,opponent.trackPinsSha256);
 const geometry=json('tools/verifier/track-geometry.json'),spite=json('docs/events/spite-geometry-review.json');
 assert.equal(geometry.engineDigest,VERIFIER_ENGINE_DIGEST);
 assert.equal(spite.engineDigest,indexed.previousEngine);assert.equal(spite.previousReview,indexed.previousReview);assert.equal(spite.previousReviewSha256,indexed.previousReviewSha256);
 assert.equal(sha(JSON.stringify(geometry.tracks)),indexed.geometryRowsSha256);assert.equal(indexed.geometryRowsSha256,spite.currentGeometryRowsSha256);
 const added=new Set(spite.addedTracks.map(row=>row.id));assert.deepEqual(geometry.tracks.filter(row=>added.has(row.id)),spite.addedTracks);
 assert.equal(sha(JSON.stringify(geometry.tracks.filter(row=>!added.has(row.id)))),opponent.geometryRowsSha256);assert.equal(opponent.geometryRowsSha256,spite.previousGeometryRowsSha256);
 assert.equal(sha(lf('tools/verifier/geometry.cjs')),spite.geometryValidatorSha256);
 assert.equal(indexed.historicalBootstrapUnchanged,true);assert.equal(indexed.bootstrapId,VERIFICATION_BOOTSTRAP_ID);
 assert.equal(VERIFICATION_BOOTSTRAP_ID,'verification_snapshot_v3_polytrack-native-bounded-v1_46aba6e247567f5954d412e0988e3d2cd04e9ec154c294bdf3fcaa830d9d12f3');
 assert.equal(indexed.nativeAB.pairCount,11);assert.equal(indexed.nativeAB.pairs.length,11);assert.equal(indexed.nativeAB.browserClosed,true);assert.equal(indexed.nativeAB.serverClosed,true);
 for(const pair of indexed.nativeAB.pairs){assert.equal(pair.equal,true);assert.match(pair.streamSha256,/^[a-f0-9]{64}$/);assert.equal(pair.baseStates,pair.frames);assert.equal(pair.candidateStates,pair.frames);assert.equal(pair.baseBytes,pair.candidateBytes);}
} catch(error) { failures.push('Watch UI / indexed playback immutable review chain: '+error.message); }

try { await buildNamePolicy({check:true}); }
catch (error) { failures.push('Shared name policy: ' + error.message); }
failures.push(...checkRepositoryExtraVerification());
// A conflict-marked or missing snapshot index breaks every snapshot-only account.
try {
  const pointer = JSON.parse(readFileSync(join(root, 'snapshot-current.json'), 'utf8'));
  if (!/^public-snapshots[1-9]\d*$/.test(pointer.currentdir)) throw new Error('Invalid snapshot directory');
  const snapshotIndex = JSON.parse(readFileSync(join(root, pointer.currentdir, 'index.json'), 'utf8'));
  if (snapshotIndex.schemaVersion !== 1 || !snapshotIndex.files || snapshotIndex.generation !== Number(pointer.currentdir.replace('public-snapshots', ''))) throw new Error('Snapshot generation/index mismatch');
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  if (!html.includes('content="./' + pointer.currentdir + '/"')) throw new Error('Website snapshot pointer mismatch');
  for (const item of Object.values(snapshotIndex.files)) {
    if (!/^[a-f0-9]{64}\.bin$/.test(item.path) || !existsSync(join(root, pointer.currentdir, item.path))) throw new Error('Missing or invalid snapshot payload');
  }
} catch (error) { failures.push('Snapshot integrity: ' + error.message); }

const required = ['tools/local-insights.mjs', 'tools/practice-profile.mjs', 'tools/developer-diagnostics.mjs', 'tools/practice-history.mjs', 'tools/practice-native.mjs', 'index.html', 'manifest.json', 'robots.txt', 'sitemap.xml', 'main.bundle.js', 'polytrack_062_patch.js', 'polytrack_physics.wasm', 'simulation_worker.bundle.js', 'events/client.mjs', 'events/session.mjs', 'events/native-binding.mjs', 'events/native-finish.mjs', 'events/weekly-native.mjs', 'events/events.css'];
for (const file of required) if (!existsSync(join(root, file))) failures.push(`Missing required file: ${file}`);

for (const file of ['tools/local-insights.mjs', 'tools/practice-profile.mjs', 'tools/developer-diagnostics.mjs', 'tools/practice-history.mjs', 'tools/practice-native.mjs', 'polytrack_062_patch.js', 'main.bundle.js', 'simulation_worker.bundle.js', 'events/client.mjs', 'events/session.mjs', 'events/native-binding.mjs', 'events/native-finish.mjs', 'events/weekly-native.mjs']) {
  if (!existsSync(join(root, file))) continue;
  const check = spawnSync(process.execPath, ['--check', join(root, file)], { encoding: 'utf8' });
  if (check.status !== 0) failures.push(`JavaScript syntax failed for ${file}: ${check.stderr.trim()}`);
}

const patchSource = readFileSync(join(root, 'polytrack_062_patch.js'), 'utf8');
const enrichStart = patchSource.indexOf('function enrichLegacyLeaderboardEntries');
const enrichEnd = patchSource.indexOf('let lastMirrorSig', enrichStart);
const enrichContract = enrichStart >= 0 && enrichEnd > enrichStart ? patchSource.slice(enrichStart, enrichEnd) : '';
if (!/integrityVerified:\s*entry\?\.integrityVerified\s*===\s*true/.test(enrichContract)) failures.push('Leaderboard normalization drops integrity verification state.');
if (!/uploadId:\s*safeRecordingId/.test(enrichContract)) failures.push('Leaderboard normalization drops canonical replay upload IDs.');
if (/newPosition:\s*0\b/.test(patchSource)) failures.push('Leaderboard POST can return an invalid zero position.');
failures.push(...trackMenuReadContract(patchSource));

const html = readFileSync(join(root, 'index.html'), 'utf8');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
if (/user-scalable\s*=\s*no/i.test(html)) failures.push('Browser zoom is disabled in index.html.');
if (!/window\.POLYTRACK_RANKED_BROKER_URL/.test(html)) failures.push('Ranked Worker URL is not configured.');
if (!/creator[^\n]+Kodub/i.test(html)) failures.push('Structured metadata does not credit Kodub as creator.');
if (manifest.orientation === 'landscape') failures.push('PWA is still forced to landscape.');

const relativeReferences = [...html.matchAll(/(?:src|href)=["'](?:\.\/)?([^"'#?]+)["']/gi)].map((match) => match[1]);
for (const reference of relativeReferences) {
  if (/^(?:https?:|data:|mailto:)/i.test(reference)) continue;
  if (!existsSync(join(root, reference))) failures.push(`Missing index asset: ${reference}`);
}

const textExtensions = new Set(['.mjs', '.js', '.html', '.json', '.md', '.txt', '.xml', '.css']);
const secretPatterns = [
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s+[A-Za-z0-9+/=\r\n]{64,}\s+-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'private key'],
  [/apiKey=[a-f0-9]{32,}/i, 'credential URL'],
  [/FIREBASE_PRIVATE_KEY\s*[:=]\s*["'][^-\n]/i, 'Firebase private key'],
  [/ADMIN_REBUILD_TOKEN\s*[:=]\s*["'][^"']+/i, 'admin rebuild token']
];
function walk(directory) {
  for (const name of readdirSync(directory)) {
    if (['.git', 'node_modules', '.firebase'].includes(name)) continue;
    const path = join(directory, name);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path);
    else if (stat.size <= 5_000_000 && textExtensions.has(extname(name).toLowerCase())) {
      const value = readFileSync(path, 'utf8');
      for (const [pattern, label] of secretPatterns) if (pattern.test(value)) failures.push(`Possible ${label} in ${path.slice(root.length + 1)}`);
    }
  }
}
walk(root);

for (const forbidden of ['admin.html', 'admin.js', 'firebase-config.local.json', 'service-account.json']) {
  if (existsSync(join(root, forbidden))) failures.push(`Private file is present: ${forbidden}`);
}

if (process.env.FIRESTORE_RULES_PATH) {
  const rules = readFileSync(process.env.FIRESTORE_RULES_PATH, 'utf8');
  for (const collection of ['0.6.2_s1_leaderboards_track', '0.6.2_s1_leaderboards_overall', '0.6.2_s1_badges', '0.6.2_s1_release_meta', '0.6.2_s1_worker_jobs']) {
    const start = rules.indexOf(`match /${collection}/`);
    const end = start < 0 ? -1 : rules.indexOf('\n    }', start);
    const block = start < 0 || end < 0 ? '' : rules.slice(start, end);
    if (!/allow\s+(?:read,\s*)?write\s*:\s*if\s+false/.test(block)) failures.push(`Production collection is not server-write-only: ${collection}`);
  }
}

if (failures.length) {
  console.error(`Release checks failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('Release checks passed.');
