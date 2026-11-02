import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {readEmbeddedTrackMetadata} from './sync-code-metadata.mjs';

const defaultRoot = new URL('../', import.meta.url);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export async function buildKodubArchive({write = false, root = defaultRoot} = {}) {
  const read = async name => JSON.parse(await fs.readFile(new URL(name, root), 'utf8'));
  const selections = await read('events/kodub/selections.json');
  const trusted = await read('events/kodub/trusted-tracks.json');
  const catalog = await read('extra-tracks/catalog.json');
  const added = [];
  for (const selection of selections) {
    const trust = trusted.find(row => row.trackId === selection.trackId && row.assetPath === selection.trackUrl);
    if (!trust || !/^[a-f0-9]{64}$/.test(trust.trackId) || !/^[a-f0-9]{64}$/.test(trust.codeHash) ||
        trust.assetPath !== 'assets/' + trust.codeHash + '.track' || !Number.isFinite(Date.parse(selection.endTime))) throw Error('Untrusted or undated weekly selection');
    const bytes = await fs.readFile(new URL('events/kodub/' + trust.assetPath, root));
    if (!bytes.length || bytes.length > 262144 || digest(bytes) !== trust.codeHash) throw Error('Weekly track hash mismatch');
    const metadata = readEmbeddedTrackMetadata(bytes.toString('utf8'));
    if (metadata.codeName !== selection.name || metadata.codeAuthor !== selection.author) throw Error('Weekly attribution mismatch');
    if (metadata.codeModifiedAt !== selection.lastModified) throw Error('Weekly modification date mismatch');
    if (added.some(entry => entry.trackId === selection.trackId)) throw Error('Repeated weekly identity needs explicit date reconciliation');
    const id = 'kodub-' + selection.trackId;
    const trackPath = 'events/kodub/' + trust.assetPath;
    if (!/^assets\/[a-f0-9]{64}\.webp$/.test(selection.thumbnailUrl || '')) throw Error('Invalid weekly thumbnail');
    const image = await fs.readFile(new URL('events/kodub/' + selection.thumbnailUrl, root));
    if (digest(image) !== selection.thumbnailUrl.slice(7, -5)) throw Error('Weekly image hash mismatch');
    const entry = {id, trackId: selection.trackId, name: selection.name, author: selection.author,
      source: 'Kodub weekly', sourceUrl: 'https://www.kodub.com/apps/polytrack',
      tags: ['kodub-weekly'], tier: 'Community', archiveImport: true, trackPath,
      thumbnailUrl: 'events/kodub/' + selection.thumbnailUrl,
      description: 'Official Kodub weekly selection. Captured weekly end: ' + selection.endTime + '. Start date not asserted.',
      weeklyEndsAt: selection.endTime, dateProvenance: 'events/kodub/selections.json',
      codeHash: trust.codeHash, ...metadata, sizeBytes: bytes.length, category: 'Kodub weekly'};
    const existing = catalog.find(row => row.trackId === entry.trackId);
    if (existing && existing.id !== id) throw Error('Weekly identity already exists: ' + existing.id);
    added.push(entry);
  }
  const next = [...catalog.filter(row => !added.some(entry => entry.id === row.id)), ...added];
  if (write) {
    const temporary = new URL('extra-tracks/catalog.json.tmp', root);
    try {
      await fs.writeFile(temporary, JSON.stringify(next, null, 2) + '\n');
      await fs.rename(temporary, new URL('extra-tracks/catalog.json', root));
    } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  } else if (JSON.stringify(next) !== JSON.stringify(catalog)) throw Error('Kodub Extra Tracks catalog needs rebuilding');
  return added;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log('Verified ' + (await buildKodubArchive({write: process.argv.includes('--write')})).length + ' Kodub weekly tracks.');
}
