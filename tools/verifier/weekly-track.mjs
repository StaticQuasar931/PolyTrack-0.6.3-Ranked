import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const TRACK_ID = /^[a-f0-9]{64}$/;
const TRACK_HASH_PATH = /^assets\/([a-f0-9]{64})\.track$/;
const MAX_TRACK_BYTES = 262144;
const MAX_REGISTRY_BYTES = 128 * 1024;
const MAX_REGISTRY_ENTRIES = 520;
const MAX_CATALOG_BYTES = 1024 * 1024;
const MAX_CATALOG_ENTRIES = 1024;

function readBounded(file, maximum) {
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum) throw Error('trusted_source_size_limit');
    const buffer = Buffer.alloc(maximum + 1);
    let size = 0, count;
    while (size < buffer.length && (count = fs.readSync(fd, buffer, size, buffer.length - size, null))) size += count;
    if (size > maximum) throw Error('trusted_source_size_limit');
    return buffer.subarray(0, size);
  } finally { fs.closeSync(fd); }
}

function readTrack(directory, assetPath) {
  const match = TRACK_HASH_PATH.exec(assetPath || '');
  if (!match) return null;
  const codeBytes = readBounded(path.join(directory, assetPath), MAX_TRACK_BYTES);
  if (!codeBytes.length || codeBytes.length > MAX_TRACK_BYTES ||
      crypto.createHash('sha256').update(codeBytes).digest('hex') !== match[1]) return null;
  return new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(codeBytes);
}

export function loadWeeklyTrustedTrack(root, jobs) {
  const trackIds = new Set((Array.isArray(jobs) ? jobs : []).map(job => String(job?.trackId || '')));
  const tracks = new Map();
  if (!trackIds.size) return [];
  const directory = path.resolve(root, 'events', 'kodub');
  const add = entry => {
    if (!TRACK_ID.test(entry?.trackId || '') || !trackIds.has(entry.trackId) ||
        !TRACK_HASH_PATH.test(entry?.assetPath || '') ||
        entry.assetPath !== `assets/${entry.codeHash}.track` || tracks.has(entry.trackId)) return;
    try {
      const code = readTrack(directory, entry.assetPath);
      if (code) tracks.set(entry.trackId, {trackId: entry.trackId, code, codeHash: entry.codeHash});
    } catch { /* A bad asset must not hide other independently pinned bindings. */ }
  };
  try {
    const current = JSON.parse(readBounded(path.join(directory, 'current.json'), MAX_REGISTRY_BYTES).toString('utf8')).current;
    if (TRACK_ID.test(current?.trackId || '') && trackIds.has(current.trackId)) {
      const code = readTrack(directory, current.trackUrl);
      const match = TRACK_HASH_PATH.exec(current.trackUrl || '');
      if (code && match) tracks.set(current.trackId, {trackId: current.trackId, code, codeHash: match[1]});
    }
  } catch {
    // The registry may still contain independently checked archived tracks.
  }
  try {
    const registry = JSON.parse(readBounded(path.join(directory, 'trusted-tracks.json'), MAX_REGISTRY_BYTES).toString('utf8'));
    if (Array.isArray(registry) && registry.length <= MAX_REGISTRY_ENTRIES) registry.forEach(add);
  } catch {}
  try {
    // Reviewed catalog aliases retain exact captured bytes if a registry row was omitted.
    // Never admit arbitrary catalog paths, unranked challenges or replay-provided code.
    const catalog = JSON.parse(readBounded(path.join(root, 'extra-tracks/catalog.json'), MAX_CATALOG_BYTES).toString('utf8'));
    if (Array.isArray(catalog) && catalog.length <= MAX_CATALOG_ENTRIES) for (const entry of catalog) {
      if (entry?.archiveImport !== true || entry.ranked === false || entry.unranked === true || entry.importOnly === true ||
          !TRACK_ID.test(entry.codeHash || '') || entry.trackPath !== `events/kodub/assets/${entry.codeHash}.track`) continue;
      add({...entry, assetPath: `assets/${entry.codeHash}.track`});
    }
  } catch {}
  return [...tracks.values()];
}
