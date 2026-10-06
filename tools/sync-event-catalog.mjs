import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {fetchPublicBackupJson, PublicBackupDeferredError} from './public-backup-fetch.mjs';

const endpoint = 'https://polytrack-ranked-worker.staticquasar931.workers.dev/v1/events/catalog';
const output = new URL('../events/public-catalog.json', import.meta.url);

export function publicCatalogBackup(value) {
  if (!value || !Array.isArray(value.periods) || !Array.isArray(value.archives) || value.periods.length > 160 || value.archives.length > 160) throw Error('Invalid public event catalog');
  for (const period of [...value.periods, ...value.archives]) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(period?.id || '') || !/^[a-f0-9]{64}$/.test(period?.trackId || '') || !Number.isSafeInteger(period?.startsAt) || !Number.isSafeInteger(period?.endsAt) || period.endsAt <= period.startsAt) throw Error('Invalid public event period');
  }
  return { periods: value.periods, archives: value.archives };
}

export async function syncPublicEventCatalog({fetchImpl = fetch, outputFile = output, log = console.log} = {}) {
  try {
    const backup = publicCatalogBackup(await fetchPublicBackupJson(fetchImpl, endpoint));
    if (!backup.periods.length && !backup.archives.length) {
      throw new PublicBackupDeferredError('Empty event catalog; retaining saved assignments');
    }
    const destination = outputFile instanceof URL ? fileURLToPath(outputFile) : path.resolve(outputFile);
    const temporary = destination + '.' + randomUUID() + '.tmp';
    try {
      await fs.writeFile(temporary, JSON.stringify(backup, null, 2) + '\n', {flag: 'wx'});
      await fs.rename(temporary, destination);
    } finally {
      await fs.unlink(temporary).catch(error => {if (error.code !== 'ENOENT') throw error;});
    }
    log('Saved', backup.periods.length, 'live and', backup.archives.length, 'archived event periods');
    return {deferred: false};
  } catch (error) {
    if (!(error instanceof PublicBackupDeferredError)) throw error;
    log('Event catalog sync deferred; existing assignments preserved:', error.status || error.message);
    return {deferred: true, status: error.status};
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await syncPublicEventCatalog();
