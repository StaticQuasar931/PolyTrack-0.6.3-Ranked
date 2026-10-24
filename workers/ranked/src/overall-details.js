export const OVERALL_DETAILS_VERSION = 1;

const DETAIL_FIELDS = Object.freeze([
  'weightedResults', 'bestTracks', 'opportunityTracks', 'strongestTrack',
  'worstTrack', 'improvementTrack', 'cosmeticUnlocks', 'serverAchievements',
  'betaEntitlement'
]);
const DETAIL_FIELD_SET = new Set(DETAIL_FIELDS);
const MAX_ENTRIES = 200;
const MAX_BUNDLE_BASE64_BYTES = 700_000;
const MAX_INFLATED_BYTES = 4_000_000;
const utf8 = new TextEncoder();
function encodeBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export async function compactOverallEntries(entries) {
  if (!Array.isArray(entries) || entries.length > MAX_ENTRIES) return {entries};
  const users = new Set();
  const detailEntries = [];
  const compactedEntries = [];
  for (const entry of entries) {
    if (!entry || typeof entry.userId !== 'string' || !entry.userId || entry.userId.length > 128 || users.has(entry.userId)) {
      return {entries};
    }
    users.add(entry.userId);
    const details = {};
    const compacted = {...entry};
    for (const field of DETAIL_FIELDS) {
      if (!Object.hasOwn(entry, field)) continue;
      details[field] = entry[field];
      delete compacted[field];
    }
    detailEntries.push({userId: entry.userId, details});
    compactedEntries.push(compacted);
  }
  if (!detailEntries.some(row => Object.keys(row.details).length)) return {entries};

  let compressed;
  try {
    const serialized = JSON.stringify({version: OVERALL_DETAILS_VERSION, entries: detailEntries});
    if (utf8.encode(serialized).length > MAX_INFLATED_BYTES) return {entries};
    const stream = new Blob([serialized])
      .stream().pipeThrough(new CompressionStream('gzip'));
    compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return {entries};
  }
  const entryDetailsBundle = encodeBase64(compressed);
  if (entryDetailsBundle.length > MAX_BUNDLE_BASE64_BYTES) return {entries};
  return {entries: compactedEntries, entryDetailsBundle, entryDetailsVersion: OVERALL_DETAILS_VERSION};
}

export async function compactOverallSnapshot(snapshot) {
  const base = {...snapshot};
  delete base.entryDetailsBundle;
  delete base.entryDetailsVersion;
  const compacted = await compactOverallEntries(snapshot.entries);
  return compacted.entryDetailsBundle
    ? {...base, entries: compacted.entries, entryDetailsBundle: compacted.entryDetailsBundle,
      entryDetailsVersion: compacted.entryDetailsVersion}
    : {...base, entries: compacted.entries};
}

export async function unpackOverallDetails(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) ||
      snapshot.entryDetailsVersion === undefined && snapshot.entryDetailsBundle === undefined) return snapshot;
  if (snapshot.entryDetailsVersion !== OVERALL_DETAILS_VERSION ||
      typeof snapshot.entryDetailsBundle !== 'string' ||
      snapshot.entryDetailsBundle.length === 0 ||
      snapshot.entryDetailsBundle.length > MAX_BUNDLE_BASE64_BYTES ||
      snapshot.entryDetailsBundle.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(snapshot.entryDetailsBundle) ||
      !Array.isArray(snapshot.entries) || snapshot.entries.length > MAX_ENTRIES) {
    throw new Error('OVERALL_DETAILS_INVALID');
  }

  let bytes;
  try {
    const binary = atob(snapshot.entryDetailsBundle);
    bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  } catch {
    throw new Error('OVERALL_DETAILS_INVALID');
  }
  let decoded;
  try {
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
    const chunks = [];
    let length = 0;
    try {
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        length += value.length;
        if (length > MAX_INFLATED_BYTES) {
          await reader.cancel();
          throw new Error('OVERALL_DETAILS_TOO_LARGE');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const plain = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { plain.set(chunk, offset); offset += chunk.length; }
    decoded = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(plain));
  } catch (error) {
    if (error?.message === 'OVERALL_DETAILS_TOO_LARGE') throw error;
    throw new Error('OVERALL_DETAILS_INVALID');
  }

  if (decoded?.version !== OVERALL_DETAILS_VERSION || !Array.isArray(decoded.entries) ||
      decoded.entries.length !== snapshot.entries.length) throw new Error('OVERALL_DETAILS_INVALID');
  const byId = new Map();
  for (const row of decoded.entries) {
    if (!row || typeof row.userId !== 'string' || !row.userId || byId.has(row.userId) ||
        !row.details || typeof row.details !== 'object' || Array.isArray(row.details) ||
        Object.keys(row.details).some(key => !DETAIL_FIELD_SET.has(key))) throw new Error('OVERALL_DETAILS_INVALID');
    byId.set(row.userId, row.details);
  }
  const snapshotUsers = new Set();
  const entries = snapshot.entries.map(entry => {
    if (!entry || typeof entry.userId !== 'string' || !entry.userId || snapshotUsers.has(entry.userId)) {
      throw new Error('OVERALL_DETAILS_INVALID');
    }
    snapshotUsers.add(entry.userId);
    const details = byId.get(entry.userId);
    if (!details) throw new Error('OVERALL_DETAILS_INVALID');
    return {...entry, ...details};
  });
  if (byId.size !== snapshotUsers.size) throw new Error('OVERALL_DETAILS_INVALID');
  const {entryDetailsBundle, entryDetailsVersion, ...expanded} = snapshot;
  return {...expanded, entries};
}
