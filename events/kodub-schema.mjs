export const KODUB_ROOT = 'https://vps.kodub.com/v6/trackOfTheWeek';
export const WEEK_MS = 7 * 86400000;
export function validateWeekly(value, now = Date.now()) {
  const c = value?.current;
  if (c === null) return null;
  if (!c || !/^[a-f0-9]{64}$/.test(c.trackId) || typeof c.name !== 'string' || !c.name.trim() || c.name.length > 256 ||
      (c.author !== null && (typeof c.author !== 'string' || c.author.length > 256)) || ![0,1,2].includes(c.environment) ||
      !Number.isFinite(Date.parse(c.endTime)) || (c.lastModified !== null && !Number.isFinite(Date.parse(c.lastModified)))) throw Error('Invalid Kodub metadata');
  if (Date.parse(c.endTime) <= now) return null;
  if (Date.parse(c.endTime) > now + WEEK_MS + 3600000) throw Error('Invalid Kodub end time');
  return {trackId:c.trackId,name:c.name,author:c.author,lastModified:c.lastModified,environment:c.environment,
    endTime:c.endTime,trackUrl:c.trackUrl,thumbnailUrl:c.thumbnailUrl,coverUrl:c.coverUrl};
}
export function assetPath(url, type) {
  const prefix = KODUB_ROOT + '/' + type + '/';
  if (typeof url !== 'string' || !url.startsWith(prefix) || !/^[a-f0-9]{64}$/.test(url.slice(prefix.length))) throw Error('Invalid Kodub asset URL');
  return type + '/' + url.slice(prefix.length);
}
export async function boundedBytes(response, limit) {
  if (!response.ok || Number(response.headers.get('content-length')) > limit) throw Error('Kodub download failed');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) { const {done,value} = await reader.read(); if (done) break;
      size += value.length; if (size > limit) throw Error('Kodub download too large'); chunks.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length; }
  return bytes;
}
export function validateAsset(bytes, type) {
  if (type === 'track') {
    const text = new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    if (!/^PolyTrack[0-9A-Za-z+/_=-]+$/.test(text) || text.length < 32) throw Error('Invalid Kodub track');
  } else {
    const text = new TextDecoder().decode(bytes.slice(0,12));
    if (text.slice(0,4) !== 'RIFF' || text.slice(8,12) !== 'WEBP') throw Error('Invalid Kodub image');
  }
  return bytes;
}

