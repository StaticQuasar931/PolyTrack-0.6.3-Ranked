import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

export const EVENT_CATALOG_ENDPOINT = 'https://polytrack-ranked-worker.staticquasar931.workers.dev/v1/events/catalog';
export const EVENT_CATALOG_HANDOFF_MAX_AGE_MS = 15 * 60000;
const MAX_RAW_BYTES = 2 * 1024 * 1024;
const MAX_ENVELOPE_BYTES = 6 * MAX_RAW_BYTES + 4096;
const hash = text => createHash('sha256').update(text).digest('hex');

export function publicCatalogBackup(value) {
  if (!value || !Array.isArray(value.periods) || !Array.isArray(value.archives) || value.periods.length > 160 || value.archives.length > 160) throw Error('Invalid public event catalog');
  for (const period of [...value.periods, ...value.archives]) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(period?.id || '') || !/^[a-f0-9]{64}$/.test(period?.trackId || '') || !Number.isSafeInteger(period?.startsAt) || !Number.isSafeInteger(period?.endsAt) || period.endsAt <= period.startsAt) throw Error('Invalid public event period');
  }
  return {periods: value.periods, archives: value.archives};
}

function validBinding(binding) {
  return binding && /^[a-f0-9]{40}$/.test(binding.sourceCommit || '') &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(binding.repository || '') &&
    /^[1-9][0-9]*$/.test(binding.runId || '') && /^[1-9][0-9]*$/.test(binding.runAttempt || '') &&
    Number.isSafeInteger(binding.startedAt) && binding.startedAt > 0;
}

export function eventCatalogHandoffFromEnvironment({env = process.env, sourceCommit} = {}) {
  if (!env.EVENT_CATALOG_HANDOFF_FILE) return null;
  return {file: env.EVENT_CATALOG_HANDOFF_FILE, binding: {sourceCommit, repository: env.GITHUB_REPOSITORY,
    runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT, startedAt: Number(env.EVENT_CATALOG_CAPTURE_STARTED_AT)}};
}

function privateFile(file, stagingDirectory) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw Error('Absolute private catalog handoff path required');
  // The public pack recursively collects JSON. Never put a raw envelope in staging,
  // regardless of its extension; .private also prevents accidental JSON collection.
  if (!file.endsWith('.private')) throw Error('Catalog handoff requires a .private file outside staging');
  const relative = path.relative(path.resolve(stagingDirectory), path.resolve(file));
  if (!relative || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
    throw Error('Private catalog handoff must stay outside snapshot staging');
  return file;
}

export async function clearEventCatalogHandoff(handoff, {stagingDirectory} = {}) {
  if (handoff) await fs.unlink(privateFile(handoff.file, stagingDirectory)).catch(error => {if (error.code !== 'ENOENT') throw error;});
}

export async function writeEventCatalogHandoff({file, binding}, rawCatalog, {now = Date.now(), stagingDirectory} = {}) {
  const destination = privateFile(file, stagingDirectory);
  if (!validBinding(binding) || !Number.isSafeInteger(now) || now < binding.startedAt)
    throw Error('Invalid catalog capture binding');
  publicCatalogBackup(rawCatalog);
  if (!rawCatalog.periods.length && !rawCatalog.archives.length) throw Error('Empty catalog cannot establish a handoff');
  const raw = JSON.stringify(rawCatalog);
  if (Buffer.byteLength(raw) > MAX_RAW_BYTES) throw Error('Catalog handoff exceeds size limit');
  const envelope = {schemaVersion: 1, kind: 'raw-event-catalog-capture', endpoint: EVENT_CATALOG_ENDPOINT,
    binding, fetchedAt: now, sha256: hash(raw), raw};
  const temporary = destination + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temporary, JSON.stringify(envelope) + '\n', {flag: 'wx', mode: 0o600});
    await fs.rename(temporary, destination);
  } finally {
    await fs.unlink(temporary).catch(error => {if (error.code !== 'ENOENT') throw error;});
  }
}

export async function readEventCatalogHandoff(handoff, {now = Date.now(), stagingDirectory} = {}) {
  if (!handoff) return null;
  const file = privateFile(handoff.file, stagingDirectory);
  if (!validBinding(handoff.binding) || !Number.isSafeInteger(now)) return null;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > MAX_ENVELOPE_BYTES) return null;
    const bytes = await fs.readFile(file);
    if (bytes.length > MAX_ENVELOPE_BYTES) return null;
    const envelope = JSON.parse(bytes.toString('utf8'));
    if (envelope.schemaVersion !== 1 || envelope.kind !== 'raw-event-catalog-capture' ||
        envelope.endpoint !== EVENT_CATALOG_ENDPOINT || !isDeepStrictEqual(envelope.binding, handoff.binding) ||
        !Number.isSafeInteger(envelope.fetchedAt) || envelope.fetchedAt < handoff.binding.startedAt || envelope.fetchedAt > now ||
        now - handoff.binding.startedAt > EVENT_CATALOG_HANDOFF_MAX_AGE_MS ||
        typeof envelope.raw !== 'string' || Buffer.byteLength(envelope.raw) > MAX_RAW_BYTES || hash(envelope.raw) !== envelope.sha256) return null;
    const raw = JSON.parse(envelope.raw);
    publicCatalogBackup(raw);
    if (!raw.periods.length && !raw.archives.length) return null;
    // Catalog membership and live/archive selection must not straddle a period
    // boundary or UTC day rollover. A handoff is not a new publication revision.
    if (Math.floor(envelope.fetchedAt / 86400000) !== Math.floor(now / 86400000)) return null;
    for (const period of [...raw.periods, ...raw.archives]) {
      const boundaries = [period.startsAt, period.endsAt, period.endsAt + Math.max(0, Number(period.graceMs) || 0)];
      if (boundaries.some(at => envelope.fetchedAt < at && at <= now)) return null;
    }
    return raw;
  } catch (error) {
    if (error.code && error.code !== 'ENOENT') throw error;
    return null;
  }
}
