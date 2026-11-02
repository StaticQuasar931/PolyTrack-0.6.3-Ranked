import {createPublicReadMemory} from './public-read-memory.js';

const memories = new WeakMap();

export function publicResponseCacheScope(env) {
  const owner = env.__FIRESTORE_ROOT_ENV || env;
  let memory = memories.get(owner);
  if (!memory) {
    memory = {responses: createPublicReadMemory(), pending: new Map()};
    memories.set(owner, memory);
  }
  return memory;
}

export function clearPublicResponseMemory(env) {
  memories.delete(env.__FIRESTORE_ROOT_ENV || env);
}

export function recallPublicResponse(env, key, now = Date.now()) {
  const saved = publicResponseCacheScope(env).responses.get(key, now);
  if (!saved) return null;
  const {body, headers, expiresAt, status} = JSON.parse(saved);
  const remaining = Math.max(0, Math.floor((expiresAt - now) / 1000));
  // A memory hit must not restart the original browser/CDN freshness window.
  headers['cache-control'] = headers['cache-control'].replace(/max-age=\d+/, 'max-age=' + remaining);
  return new Response(body, {status, headers});
}

export async function rememberPublicResponse(env, key, response, now = Date.now(), scope = publicResponseCacheScope(env)) {
  if (![200, 404].includes(response.status) || response.headers.has('Set-Cookie')) return;
  const control = response.headers.get('Cache-Control') || '';
  if (/(?:^|[,\s])(?:private|no-store)(?:[,\s]|$)/i.test(control)) return;
  let ttl = Number(/(?:^|[,\s])max-age=(\d+)/.exec(response.headers.get('Cache-Control') || '')?.[1]);
  if (!Number.isSafeInteger(ttl) || ttl <= 0) return;
  const body = await response.clone().text();
  const headers = Object.fromEntries(response.headers);
  if (response.status === 404) {
    // Only the public snapshot absence sentinel is safe to share, never arbitrary errors.
    if (!/(?:^|[,\s])public(?:[,\s]|$)/i.test(control) || body.length > 1024) return;
    let value;try { value = JSON.parse(body); } catch { return; }
    if (!value || Array.isArray(value) || Object.keys(value).length !== 1 || value.error !== 'snapshot_not_ready') return;
    ttl = Math.min(ttl, 10);
    headers['cache-control'] = control.replace(/max-age=\d+/, 'max-age=' + ttl);
  }
  // A completed publication retires this scope, including its in-flight misses.
  if (scope !== publicResponseCacheScope(env)) return;
  scope.responses.put(key, JSON.stringify({body, headers, status: response.status,
    expiresAt: now + ttl * 1000}), ttl, now);
}
