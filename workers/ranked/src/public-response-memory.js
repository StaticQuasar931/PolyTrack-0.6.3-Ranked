import {createPublicReadMemory} from './public-read-memory.js';

const memories = new WeakMap();

function memoryFor(env) {
  const owner = env.__FIRESTORE_ROOT_ENV || env;
  let memory = memories.get(owner);
  if (!memory) {
    memory = createPublicReadMemory();
    memories.set(owner, memory);
  }
  return memory;
}

export function recallPublicResponse(env, key, now = Date.now()) {
  const saved = memoryFor(env).get(key, now);
  if (!saved) return null;
  const {body, headers, expiresAt} = JSON.parse(saved);
  const remaining = Math.max(0, Math.floor((expiresAt - now) / 1000));
  // A memory hit must not restart the original browser/CDN freshness window.
  headers['cache-control'] = headers['cache-control'].replace(/max-age=\d+/, 'max-age=' + remaining);
  return new Response(body, {status: 200, headers});
}

export async function rememberPublicResponse(env, key, response, now = Date.now()) {
  if (response.status !== 200) return;
  const ttl = Number(/(?:^|[,\s])max-age=(\d+)/.exec(response.headers.get('Cache-Control') || '')?.[1]);
  if (!Number.isSafeInteger(ttl) || ttl <= 0) return;
  const body = await response.clone().text();
  memoryFor(env).put(key, JSON.stringify({body, headers: Object.fromEntries(response.headers),
    expiresAt: now + ttl * 1000}), ttl, now);
}
