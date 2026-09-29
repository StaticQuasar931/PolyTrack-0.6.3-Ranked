import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const endpoint = 'https://polytrack-ranked-worker.staticquasar931.workers.dev/v1/events/catalog';
const output = new URL('../events/public-catalog.json', import.meta.url);

export function publicCatalogBackup(value) {
  if (!value || !Array.isArray(value.periods) || !Array.isArray(value.archives) || value.periods.length > 160 || value.archives.length > 160) throw Error('Invalid public event catalog');
  for (const period of [...value.periods, ...value.archives]) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(period?.id || '') || !/^[a-f0-9]{64}$/.test(period?.trackId || '') || !Number.isSafeInteger(period?.startsAt) || !Number.isSafeInteger(period?.endsAt) || period.endsAt <= period.startsAt) throw Error('Invalid public event period');
  }
  return { periods: value.periods, archives: value.archives };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const response = await fetch(endpoint, { headers: { Origin: 'https://staticquasar931.github.io', Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (response.status === 429 || response.status === 503) console.log('Event catalog sync deferred:', response.status);
  else {
    if (!response.ok) throw Error('Public event catalog unavailable: ' + response.status);
    const backup = publicCatalogBackup(await response.json());
    await fs.writeFile(output, JSON.stringify(backup, null, 2) + '\n');
    console.log('Saved', backup.periods.length, 'live and', backup.archives.length, 'archived event periods');
  }
}
