import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {fetchPublicBackupJson, PublicBackupDeferredError} from './public-backup-fetch.mjs';

import {mergeFrozenEventCatalog} from './merge-frozen-event-catalog.mjs';
import {createWorkerCaptureFetch} from './worker-capture-fetch.mjs';
import {EVENT_CATALOG_ENDPOINT as endpoint, publicCatalogBackup, clearEventCatalogHandoff, writeEventCatalogHandoff} from './capture-event-catalog.mjs';
export {publicCatalogBackup} from './capture-event-catalog.mjs';

const output = new URL('../events/public-catalog.json', import.meta.url);
const staging = fileURLToPath(new URL('../local-reports/snapshot-staging/', import.meta.url));

export async function syncPublicEventCatalog({fetchImpl = createWorkerCaptureFetch(), outputFile = output, log = console.log,
  catalogHandoff = null, stagingDirectory = staging, now = Date.now} = {}) {
  // A deferred or failed retry must never leave an earlier success eligible for reuse.
  await clearEventCatalogHandoff(catalogHandoff, {stagingDirectory});
  try {
    const fetchedAt = now();
    const rawCatalog = await fetchPublicBackupJson(fetchImpl, endpoint);
    const backup = publicCatalogBackup(rawCatalog);
    if (!backup.periods.length && !backup.archives.length) {
      throw new PublicBackupDeferredError('Empty event catalog; retaining saved assignments');
    }
    const destination = outputFile instanceof URL ? fileURLToPath(outputFile) : path.resolve(outputFile);
    let previous=null;
    try{previous=JSON.parse(await fs.readFile(destination,'utf8'));}
    catch(error){if(error.code!=='ENOENT')throw error;}
    const merged=mergeFrozenEventCatalog(backup,[],previous);
    const temporary = destination + '.' + randomUUID() + '.tmp';
    try {
      await fs.writeFile(temporary, JSON.stringify(merged, null, 2) + '\n', {flag: 'wx'});
      await fs.rename(temporary, destination);
    } finally {
      await fs.unlink(temporary).catch(error => {if (error.code !== 'ENOENT') throw error;});
    }
    if (catalogHandoff) await writeEventCatalogHandoff(catalogHandoff, rawCatalog, {now: fetchedAt, stagingDirectory});
    log('Saved', merged.periods.length, 'live and', merged.archives.length, 'archived event periods');
    return {deferred: false};
  } catch (error) {
    if (!(error instanceof PublicBackupDeferredError)) throw error;
    log('Event catalog sync deferred; existing assignments preserved:', error.status || error.message);
    return {deferred: true, status: error.status};
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await syncPublicEventCatalog();
