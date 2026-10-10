import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {EXTRA_TRACK_IDS} from '../workers/ranked/src/extra-track-ids.js';

const root = path.resolve(import.meta.dirname, '..');
export function checkExtraVerification(catalog, registry, pins, readCode) {
  const failures = [], seen = new Set(), ranked = new Set();
  for (const entry of catalog) {
    if (!/^[a-f0-9]{64}$/.test(entry.trackId || '') || seen.has(entry.trackId)) {
      failures.push(`Invalid or duplicate Extra track ID: ${entry.id}`); continue;
    }
    seen.add(entry.trackId);
    if (entry.ranked === false) {
      if (registry.has(entry.trackId)) failures.push(`Unranked challenge is in Ranked registry: ${entry.id}`);
      continue;
    }
    ranked.add(entry.trackId);
    if (!registry.has(entry.trackId)) failures.push(`Missing Worker Extra registry ID: ${entry.id}`);
    if (!/^extra-tracks\/track-data\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.track$/.test(entry.trackPath || '')) {
      failures.push(`Unsafe trusted track path: ${entry.id}`); continue;
    }
    try {
      const bytes = readCode(entry.trackPath).replace(/\r\n?/g, '\n');
      const hash = crypto.createHash('sha256').update(bytes).digest('hex');
      if (pins[entry.trackPath] !== hash) failures.push(`Trusted code pin needs review: ${entry.id}`);
    } catch { failures.push(`Missing trusted track asset: ${entry.id}`); }
  }
  for (const id of registry) if (!ranked.has(id)) failures.push(`Worker Extra ID absent from ranked catalog: ${id}`);
  return failures;
}

export function checkRepositoryExtraVerification() {
  return checkExtraVerification(JSON.parse(fs.readFileSync(path.join(root, 'extra-tracks/catalog.json'), 'utf8')),
    EXTRA_TRACK_IDS, JSON.parse(fs.readFileSync(path.join(root, 'tools/verifier/engine-manifest.json'), 'utf8')).tracks,
    name => fs.readFileSync(path.join(root, name), 'utf8'));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = checkRepositoryExtraVerification();
  if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
  else console.log('Extra catalog, Worker registry and trusted code pins match. Deploy the matching Worker whenever registry IDs change.');
}
