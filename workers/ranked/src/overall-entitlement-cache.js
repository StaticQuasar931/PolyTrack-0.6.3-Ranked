// Private canonical-payload companion. Only the release-meta CAS authorizes reuse.
// Privileged edits may remain unseen until the six-hour audit, but canonical writes
// also require document CAS. This cache does not change grant/revocation semantics.
import {prepareSourcePublication, decodeSourcePublication, sourcePublicationIds} from './overall-source-publication.js';

export const ENTITLEMENT_COLLECTION = '0.6.2_s1_cosmetic_entitlements';
export const ENTITLEMENT_CACHE_COLLECTION = '0.6.2_s1_overall_entitlements';
export const ENTITLEMENT_AUDIT_MS = 6 * 60 * 60 * 1000;
export const ENTITLEMENT_MAX_ACCOUNTS = 20000;
export const ENTITLEMENT_READ_BATCH = 500;
export const ENTITLEMENT_JOURNAL_MAX_IDS = 512;
export const ENTITLEMENT_JOURNAL_MAX_BYTES = 64 * 1024;
const utf8 = new TextEncoder();
const plain = value => value !== null && typeof value === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const uint = value => Number.isSafeInteger(value) && value >= 0;
const idValid = id => typeof id === 'string' && id.match(/^[A-Za-z0-9_.:-]{1,128}$/)?.[0] === id &&
  id !== '.' && id !== '..';
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = code => { throw Error('OVERALL_ENTITLEMENT_' + code); };
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export async function entitlementPolicyKey(value) {
  return digest(JSON.stringify(canonical(value)));
}
async function digest(body) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(body)))]
    .map(value => value.toString(16).padStart(2, '0')).join('');
}
export function entitlementEpoch(meta) {
  const epoch = meta?.entitlementEpoch ?? 0;
  if (!uint(epoch) || epoch >= Number.MAX_SAFE_INTEGER) fail('EPOCH_INVALID');
  return epoch;
}
// A baseline may lag only across a complete digest-bound journal, never an epoch gap.
function journalIds(meta) {
  const marker = meta.entitlementBundle, epoch = entitlementEpoch(meta);
  if (!plain(marker) || marker.ready !== true || !uint(marker.epoch) || marker.epoch > epoch || !hex(marker.digest)) return null;
  const journal = meta.entitlementInvalidations;
  if (marker.epoch === epoch) return journal == null ? [] : null;
  if (!plain(journal) || journal.version !== 1 || journal.baseEpoch !== marker.epoch ||
      journal.baseDigest !== marker.digest || journal.throughEpoch !== epoch ||
      !Array.isArray(journal.accountIds) || !journal.accountIds.length ||
      journal.accountIds.length > ENTITLEMENT_JOURNAL_MAX_IDS ||
      utf8.encode(JSON.stringify(journal)).length > ENTITLEMENT_JOURNAL_MAX_BYTES) return null;
  let previous = '';
  for (const id of journal.accountIds) {
    if (!idValid(id) || id <= previous) return null;
    previous = id;
  }
  return journal.accountIds;
}
export function invalidateEntitlements(meta, accountIds) {
  const epoch = entitlementEpoch(meta) + 1, previous = journalIds(meta);
  if (previous && Array.isArray(accountIds) && accountIds.length && accountIds.every(idValid)) {
    const journal = {version: 1, baseEpoch: meta.entitlementBundle.epoch,
      baseDigest: meta.entitlementBundle.digest, throughEpoch: epoch,
      accountIds: [...new Set([...previous, ...accountIds])].sort()};
    if (journal.accountIds.length <= ENTITLEMENT_JOURNAL_MAX_IDS &&
        utf8.encode(JSON.stringify(journal)).length <= ENTITLEMENT_JOURNAL_MAX_BYTES) {
      return {...meta, entitlementEpoch: epoch, entitlementInvalidations: journal, dirty: true};
    }
  }
  return {...meta, entitlementEpoch: epoch, entitlementInvalidations: null,
    entitlementBundle: {version: 1, ready: false}, dirty: true};
}
export function entitlementAuditDue(meta, now, force = false) {
  const at = meta?.entitlementAuditedAt;
  return force || !uint(now) || !uint(at) || at > now || now - at >= ENTITLEMENT_AUDIT_MS;
}
export function entitlementChanged(meta, policyKey) {
  return entitlementEpoch(meta) !== (meta.entitlementBuiltEpoch ?? 0) ||
    typeof meta.entitlementPolicyKey === 'string' && meta.entitlementPolicyKey !== policyKey;
}
export function entitlementMarkerValid(marker, {scope, policyKey, epoch, auditedAt}) {
  return plain(marker) && marker.version === 1 && marker.ready === true && marker.scope === scope &&
    marker.policyKey === policyKey && hex(policyKey) && marker.epoch === epoch && uint(epoch) &&
    marker.auditedAt === auditedAt && uint(auditedAt) && hex(marker.digest) &&
    uint(marker.count) && marker.count <= ENTITLEMENT_MAX_ACCOUNTS && sourcePublicationIds(marker).length > 0;
}
function validateRows(rows, count) {
  if (!Array.isArray(rows) || rows.length !== count || count > ENTITLEMENT_MAX_ACCOUNTS) fail('ROWS_INVALID');
  const documents = new Map();
  let previous = '';
  for (const row of rows) {
    if (!plain(row) || !idValid(row.id) || row.id <= previous ||
        !plain(row.data) || typeof row.updateTime !== 'string' || row.updateTime.length > 128) fail('ROW_INVALID');
    previous = row.id;
    documents.set(row.id, row);
  }
  return documents;
}
export async function prepareEntitlementPublication(documents, {scope, policyKey, epoch, auditedAt}) {
  if (!(documents instanceof Map) || documents.size > ENTITLEMENT_MAX_ACCOUNTS) return null;
  const rows = [...documents].map(([id, document]) => ({id, data: document.data, updateTime: document.updateTime || ''}))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  validateRows(rows, rows.length);
  const body = JSON.stringify(canonical({version: 1, scope, policyKey, epoch, auditedAt, rows}));
  const marker = {version: 1, ready: true, scope, policyKey, epoch, auditedAt, count: rows.length, digest: await digest(body)};
  const publication = await prepareSourcePublication(body, marker);
  if (!publication) return null;
  return {...publication, documents: publication.documents.map(document => ({...document, collection: ENTITLEMENT_CACHE_COLLECTION}))};
}
export async function decodeEntitlementPublication(marker, documents, binding) {
  if (!entitlementMarkerValid(marker, binding)) fail('BINDING_INVALID');
  const body = await decodeSourcePublication(marker, documents);
  if (await digest(body) !== marker.digest) fail('DIGEST_INVALID');
  const value = JSON.parse(body);
  if (!plain(value) || value.version !== 1 || value.scope !== binding.scope || value.policyKey !== binding.policyKey ||
      value.epoch !== binding.epoch || value.auditedAt !== binding.auditedAt) fail('BODY_BINDING_INVALID');
  return validateRows(value.rows, marker.count);
}
export async function loadOverallEntitlements({meta, accountIds, scope, policyKey, now, force = false,
  readPublished, readCanonical, beforeRecovery = async () => {}}) {
  if (!Array.isArray(accountIds) || new Set(accountIds).size !== accountIds.length) fail('ACCOUNT_BOUND');
  if (!accountIds.every(idValid)) throw Error('INVALID_DOCUMENT_ID');
  const changed = journalIds(meta);
  const binding = {scope, policyKey, epoch: meta.entitlementBundle?.epoch, auditedAt: meta.entitlementAuditedAt};
  let cached = null;
  const auditDue = entitlementAuditDue(meta, now, force);
  if (!auditDue && changed !== null && entitlementMarkerValid(meta.entitlementBundle, binding)) {
    // Network/quota errors are not evidence of corruption and must not cause a full scan.
    const published = await readPublished(sourcePublicationIds(meta.entitlementBundle));
    try { cached = await decodeEntitlementPublication(meta.entitlementBundle, published, binding); }
    catch { await beforeRecovery(); }
  }
  const invalidated = new Set(changed || []);
  const ids = cached ? accountIds.filter(id => invalidated.has(id) || !cached.has(id)) : accountIds;
  const documents = new Map(accountIds.filter(id => cached?.has(id) && !invalidated.has(id)).map(id => [id, cached.get(id)]));
  for (let offset = 0; offset < ids.length; offset += ENTITLEMENT_READ_BATCH) {
    const batch = ids.slice(offset, offset + ENTITLEMENT_READ_BATCH);
    const found = await readCanonical(batch);
    if (!(found instanceof Map)) fail('CANONICAL_INVALID');
    for (const [id, document] of found) {
      if (!batch.includes(id) || document?.id !== id || !plain(document.data)) fail('CANONICAL_IDENTITY');
      documents.set(id, document);
    }
  }
  return {documents, canonicalReads: ids.length, reused: cached !== null,
    auditedAt: cached ? meta.entitlementAuditedAt : now};
}

export async function fenceEntitlementWrites(writes, previous, readCanonical) {
  const priors = new Map(previous);
  // Atomically published new payloads cannot know their own commit updateTime.
  // Read only those that need another change, and never bless a different payload.
  const ids = writes.filter(write => priors.has(write.id) && !priors.get(write.id).updateTime).map(write => write.id);
  for (let offset = 0; offset < ids.length; offset += ENTITLEMENT_READ_BATCH) {
    const batch = ids.slice(offset, offset + ENTITLEMENT_READ_BATCH);
    const found = await readCanonical(batch);
    if (!(found instanceof Map)) fail('CANONICAL_INVALID');
    for (const [id, document] of found) {
      if (!batch.includes(id) || document?.id !== id || !plain(document.data)) fail('CANONICAL_IDENTITY');
    }
    const changed = batch.filter(id => !found.has(id) ||
      JSON.stringify(canonical(found.get(id).data)) !== JSON.stringify(canonical(priors.get(id).data)));
    if (changed.length) {
      const error = Error('OVERALL_ENTITLEMENT_PAYLOAD_CHANGED');
      error.entitlementConflictIds = changed;
      throw error;
    }
    for (const id of batch) {
      const document = found.get(id);
      if (typeof document.updateTime !== 'string' || !document.updateTime) fail('VERSION_MISSING');
      priors.set(id, document);
    }
  }
  return {canonicalReads: ids.length, writes: writes.map(write => ({
    collection: ENTITLEMENT_COLLECTION, id: write.id, data: write.data,
    prior: priors.has(write.id) ? {updateTime: priors.get(write.id).updateTime} : null
  }))};
}

export function captureEntitlementCommitTimes(documents, writes, committed, expectedWrites) {
  const results = committed?.writeResults;
  const version = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
  if (!(documents instanceof Map) || !writes.length || !uint(expectedWrites) || expectedWrites <= writes.length ||
      !Array.isArray(results) || results.length !== expectedWrites || !version(results.at(-1)?.updateTime) ||
      new Set(writes.map(write => write.id)).size !== writes.length) return '';
  // Callers put canonical writes first and metadata last in the same atomic commit.
  if (writes.some((write, i) => write.collection !== ENTITLEMENT_COLLECTION || !documents.has(write.id) ||
      !version(results[i]?.updateTime))) return '';
  for (let i = 0; i < writes.length; i++) {
    const write = writes[i];
    documents.set(write.id, {id: write.id, data: write.data, updateTime: results[i].updateTime});
  }
  return results.at(-1).updateTime;
}
