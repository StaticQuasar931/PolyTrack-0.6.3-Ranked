import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const TRACK_ID = /^[a-f0-9]{64}$/;
const TRACK_HASH_PATH = /^assets\/([a-f0-9]{64})\.track$/;
const MAX_TRACK_BYTES = 262144;

export function loadWeeklyTrustedTrack(root, jobs) {
  const trackIds = new Set((Array.isArray(jobs) ? jobs : []).map(job => String(job?.trackId || '')));
  try {
    const directory = path.resolve(root, 'events', 'kodub');
    const current = JSON.parse(fs.readFileSync(path.join(directory, 'current.json'), 'utf8')).current;
    if (!TRACK_ID.test(current?.trackId || '') || !trackIds.has(current.trackId)) return [];
    const match = TRACK_HASH_PATH.exec(current.trackUrl || '');
    if (!match) return [];
    const codeBytes = fs.readFileSync(path.join(directory, 'assets', match[1] + '.track'));
    if (!codeBytes.length || codeBytes.length > MAX_TRACK_BYTES ||
        crypto.createHash('sha256').update(codeBytes).digest('hex') !== match[1]) return [];
    const code = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(codeBytes);
    return [{trackId: current.trackId, code, codeHash: match[1]}];
  } catch {
    return [];
  }
}
