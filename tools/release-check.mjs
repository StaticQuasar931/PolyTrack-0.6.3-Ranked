import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const failures = [];
const required = ['index.html', 'manifest.json', 'robots.txt', 'sitemap.xml', 'main.bundle.js', 'polytrack_062_patch.js', 'polytrack_physics.wasm', 'simulation_worker.bundle.js', 'events/client.mjs', 'events/session.mjs', 'events/native-binding.mjs', 'events/native-finish.mjs', 'events/weekly-native.mjs', 'events/events.css'];
for (const file of required) if (!existsSync(join(root, file))) failures.push(`Missing required file: ${file}`);

for (const file of ['polytrack_062_patch.js', 'main.bundle.js', 'simulation_worker.bundle.js', 'events/client.mjs', 'events/session.mjs', 'events/native-binding.mjs', 'events/native-finish.mjs', 'events/weekly-native.mjs']) {
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
const derivedFallbackIndex = patchSource.indexOf("d.collection(COLLECTIONS.leaderboardsTrack).doc(safeTrackId)");
const canonicalFallbackIndex = patchSource.indexOf('fetchCanonicalTrackEntries(safeTrackId,500,', derivedFallbackIndex);
if (derivedFallbackIndex < 0 || canonicalFallbackIndex < derivedFallbackIndex) failures.push('Blocked edge fallback reads canonical PB documents before the one-read derived snapshot.');

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
