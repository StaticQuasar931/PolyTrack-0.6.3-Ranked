// Digest-bound, atomic companion of the published Overall source snapshot.
import {SOURCE_BUNDLE_MAX_BYTES} from './overall-source-cache.js';
export const SOURCE_PUBLICATION_COLLECTION = '0.6.2_s1_overall_sources';
export const SOURCE_PUBLICATION_PART_BYTES = 700000;
export const SOURCE_PUBLICATION_MAX_PARTS = 4;
const utf8 = new TextEncoder();
const valid = p => p?.version === 1 && p.encoding === 'gzip-base64-v1' &&
  Number.isSafeInteger(p.parts) && p.parts > 0 && p.parts <= SOURCE_PUBLICATION_MAX_PARTS &&
  Number.isSafeInteger(p.rawBytes) && p.rawBytes > 0 && p.rawBytes <= SOURCE_BUNDLE_MAX_BYTES &&
  Number.isSafeInteger(p.encodedBytes) && p.encodedBytes > 0 &&
  p.parts === Math.ceil(p.encodedBytes / SOURCE_PUBLICATION_PART_BYTES);
export const sourcePublicationIds = marker => valid(marker?.publication)
  ? Array.from({length: marker.publication.parts}, (_, i) => 'main_' + i) : [];
export async function prepareSourcePublication(body, marker) {
  if (typeof body !== 'string' || !/^[a-f0-9]{64}$/.test(marker?.digest || '')) return null;
  const rawBytes = utf8.encode(body).length;
  if (!rawBytes || rawBytes > SOURCE_BUNDLE_MAX_BYTES) return null;
  const compressed = new Uint8Array(await new Response(new Blob([body]).stream()
    .pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  let binary = '';
  for (let i = 0; i < compressed.length; i += 0x8000)
    binary += String.fromCharCode(...compressed.subarray(i, i + 0x8000));
  const encoded = btoa(binary);
  const publication = {version: 1, encoding: 'gzip-base64-v1', rawBytes,
    encodedBytes: encoded.length, parts: Math.ceil(encoded.length / SOURCE_PUBLICATION_PART_BYTES)};
  if (!valid(publication)) return null;
  return {marker: {...marker, publication}, documents: sourcePublicationIds({publication}).map((id, part) => ({
    collection: SOURCE_PUBLICATION_COLLECTION, id, unconditional: true,
    data: {version: 1, digest: marker.digest, part,
      bundle: encoded.slice(part * SOURCE_PUBLICATION_PART_BYTES, (part + 1) * SOURCE_PUBLICATION_PART_BYTES)}
  }))};
}
export async function decodeSourcePublication(marker, documents) {
  const ids = sourcePublicationIds(marker), p = marker?.publication;
  if (!ids.length || !(documents instanceof Map) || documents.size !== ids.length) throw Error('OVERALL_SOURCE_PUBLICATION_INVALID');
  const chunks = ids.map((id, part) => {
    const row = documents.get(id)?.data;
    const length = Math.min(SOURCE_PUBLICATION_PART_BYTES, p.encodedBytes - part * SOURCE_PUBLICATION_PART_BYTES);
    if (row?.version !== 1 || row.digest !== marker.digest || row.part !== part ||
        typeof row.bundle !== 'string' || row.bundle.length !== length) throw Error('OVERALL_SOURCE_PUBLICATION_INVALID');
    return row.bundle;
  });
  const compressed = Uint8Array.from(atob(chunks.join('')), c => c.charCodeAt(0));
  const reader = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const inflated = []; let size = 0;
  for (;;) {
    const {done, value} = await reader.read(); if (done) break;
    size += value.length;
    if (size > p.rawBytes) { await reader.cancel(); throw Error('OVERALL_SOURCE_PUBLICATION_INFLATE_LIMIT'); }
    inflated.push(value);
  }
  if (size !== p.rawBytes) throw Error('OVERALL_SOURCE_PUBLICATION_INVALID');
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of inflated) { bytes.set(chunk, offset); offset += chunk.length; }
  // loadOverallSources must still verify the trusted marker's hash and every board binding.
  return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
}
