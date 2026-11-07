// Shared by the browser reader and publisher; no Node dependencies.
export const SNAPSHOT_CDN_REPOSITORY = 'StaticQuasar931/PolyTrack-0.6.3-Ranked';
export const PAYLOAD_SHARDS_META = 'polytrack-snapshot-payload-shards';
const basePattern = /^https:\/\/cdn\.jsdelivr\.net\/gh\/StaticQuasar931\/PolyTrack-0\.6\.3-Ranked@([a-f0-9]{40})\/(public-snapshots[1-9]\d*)\/$/;

export function snapshotPayloadShard(path, count) {
  if (![2,4].includes(count) || typeof path !== 'string' || path.length !== 68 || !/^[a-f0-9]{64}\.bin$/.test(path)) return null;
  return parseInt(path[0],16) % count;
}

export function parseSnapshotPayloadShards(value) {
  try {
    if (typeof value === 'string') {
      if (value.length > 4096) return null;
      value = JSON.parse(value);
    }
    if (!value || value.schemaVersion !== 1 || typeof value.metadataBase !== 'string' ||
        !Array.isArray(value.payloadBases) || ![2,4].includes(value.payloadBases.length)) return null;
    const metadata = basePattern.exec(value.metadataBase);
    if (!metadata || metadata[0] !== value.metadataBase || Array.from(value.payloadBases).some(base => {
      const match = typeof base === 'string' ? basePattern.exec(base) : null;
      return !match || match[0] !== base || match[2] !== metadata[2];
    }) ||
        new Set([value.metadataBase,...value.payloadBases]).size !== value.payloadBases.length+1) return null;
    return Object.freeze({schemaVersion:1,metadataBase:value.metadataBase,payloadBases:Object.freeze([...value.payloadBases])});
  } catch { return null; }
}

export function documentSnapshotPayloadShards() {
  try {
    if (typeof document === 'undefined') return null;
    const tags = document.querySelectorAll('meta[name="'+PAYLOAD_SHARDS_META+'"]');
    return tags.length === 1 ? parseSnapshotPayloadShards(tags[0].getAttribute('content')) : null;
  } catch { return null; }
}

export function snapshotPayloadBase(mapping, packageBase, path) {
  if (!mapping || mapping.metadataBase !== packageBase) return packageBase;
  const shard = snapshotPayloadShard(path,mapping.payloadBases.length);
  return shard === null ? packageBase : mapping.payloadBases[shard];
}
