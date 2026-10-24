import {readKodubPracticeTrack} from '../tools/kodub-practice-track.mjs';
const HASH = /^[a-f0-9]{64}$/;

async function savedBytes(url, fetcher, limit) {
  const response = await fetcher(url, { cache: 'default', redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok || Number(response.headers.get('content-length')) > limit) throw Error('Saved archive asset is unavailable.');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw Error('Saved archive asset is too large.');
      chunks.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

// Only packaged, content-addressed assets. Never query a Worker or the live feed.
export async function readSavedArchiveTrack(period, { baseUrl = import.meta.url, fetcher = fetch, decode, isCurrent = () => true } = {}) {
  if (!HASH.test(period?.trackId || '')) throw Error('Archived track identity is missing.');
  const base = new URL('./kodub/', baseUrl);
  const bytes = await savedBytes(new URL('trusted-tracks.json', base), fetcher, 256 * 1024);
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!Array.isArray(manifest) || manifest.length > 520) throw Error('Saved track manifest is invalid.');
  const asset = manifest.find(row => row?.trackId === period.trackId && HASH.test(row.codeHash || '') && row.assetPath === `assets/${row.codeHash}.track`);
  if (!asset) throw Error('This historical track code was not saved locally. Its standings remain available; practice needs an archival capture.');
  return readKodubPracticeTrack({id:period.trackId,codeHash:asset.codeHash,trackUrl:new URL(asset.assetPath,base).href},
    {fetcher,decode,baseUrl,isCurrent});
}
