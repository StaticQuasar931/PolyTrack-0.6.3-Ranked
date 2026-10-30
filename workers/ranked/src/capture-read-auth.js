export const CAPTURE_HEADER_NAME = 'X-PolyTrack-Capture';
export const CAPTURE_AUDIENCE = 'polytrack-private-capture-v1';
const ORIGIN = 'https://polytrack-ranked-worker.staticquasar931.workers.dev';
const MAX_TOKEN = 6144, MAX_JWKS = 16384, MAX_KEYS = 4;
const REFRESH_COOLDOWN = 30000, FETCH_TIMEOUT = 3000;
const kidPattern = /^[A-Za-z0-9_-]{1,128}$/;
const emailPattern = /^[A-Za-z0-9._-]{1,128}@[A-Za-z0-9.-]{1,128}\.iam\.gserviceaccount\.com$/;

function allowedPath(path) {
  if (/[^A-Za-z0-9/_-]/.test(path) || path.includes('//') || path.endsWith('/')) return false;
  if (path.split('/').includes('admin')) return false;
  return ['/v1/status', '/v1/capture-auth', '/v1/extra-tracks/unranked', '/v1/kodub-weekly'].includes(path) ||
    /^\/v1\/snapshot\/(overall|track)(\/page)?$/.test(path) ||
    /^\/v1\/events\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(path);
}

// Classify by route, not Origin: even a foreign-host request must encounter the gate.
export function isCaptureReadRoute(request) {
  // The parent router trims trailing slashes; classify those aliases before verification rejects them.
  try { return request.method === 'GET' && allowedPath(new URL(request.url).pathname.replace(/\/+$/, '')); }
  catch { return false; }
}

function bytes(segment) {
  if (!/^[A-Za-z0-9_-]+$/.test(segment) || segment.length % 4 === 1) throw Error();
  const decoded = atob(segment.replace(/-/g, '+').replace(/_/g, '/'));
  const value = Uint8Array.from(decoded, character => character.charCodeAt(0));
  const canonical = btoa(String.fromCharCode(...value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  if (canonical !== segment) throw Error();
  return value;
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const decode = value => JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes(value)));

async function boundedJson(response) {
  if (!response.ok || response.status !== 200 || response.redirected ||
      response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw Error();
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_JWKS)) throw Error();
  const reader = response.body?.getReader();
  if (!reader) throw Error();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JWKS) throw Error();
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(joined));
}

// One verifier owns one issuer, four keys, one in-flight refresh, and no per-kid map.
export function createCaptureReadVerifier({fetchImpl = (...args) => globalThis.fetch(...args),
  now = Date.now, cryptoImpl = globalThis.crypto} = {}) {
  let state;
  async function refresh(issuer, at) {
    const controller = new AbortController();
    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(Error()); }, FETCH_TIMEOUT);
      });
      const result = await Promise.race([timeout, (async () => {
        const response = await fetchImpl('https://www.googleapis.com/service_accounts/v1/jwk/' + encodeURIComponent(issuer),
          // Workers supports manual/follow, not Fetch's error redirect mode.
          // boundedJson rejects redirects; no credentials are sent to this fixed URL.
          {method: 'GET', redirect: 'manual', signal: controller.signal});
        const body = await boundedJson(response);
        if (!object(body) || !Array.isArray(body.keys) || !body.keys.length || body.keys.length > MAX_KEYS) throw Error();
        const keys = new Map();
        for (const jwk of body.keys) {
          if (!object(jwk) || typeof jwk.kid !== 'string' || !kidPattern.test(jwk.kid) || keys.has(jwk.kid) || jwk.kty !== 'RSA' ||
              jwk.alg !== undefined && jwk.alg !== 'RS256' || jwk.use !== undefined && jwk.use !== 'sig' ||
              typeof jwk.n !== 'string' || jwk.n.length > 684 || jwk.e !== 'AQAB' || jwk.d !== undefined) throw Error();
          const modulus = bytes(jwk.n);
          if (modulus.length < 256 || modulus.length > 512 || !(modulus[0] & 128)) throw Error();
          const key = await cryptoImpl.subtle.importKey('jwk', {kty: 'RSA', n: jwk.n, e: jwk.e},
            {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'}, false, ['verify']);
          keys.set(jwk.kid, key);
        }
        const maxAge = /(?:^|,)\s*max-age=(\d+)(?:\s*,|\s*$)/i.exec(response.headers.get('cache-control') || '');
        const ttl = Math.min(3600, maxAge ? Number(maxAge[1]) : 300) * 1000;
        return {keys, expiresAt: at + ttl};
      })()]);
      // Commit only after the bounded operation wins; a timed-out fetch cannot replace keys later.
      state.keys = result.keys;
      state.expiresAt = result.expiresAt;
    } catch { /* Failed refreshes leave only unexpired, previously verified keys usable. */ }
    finally { clearTimeout(timer); }
  }

  return async function verify(request, env = {}) {
    try {
      if (request.method !== 'GET') return false;
      const url = new URL(request.url);
      if (url.origin !== ORIGIN || url.username || url.password || url.hash ||
          url.pathname.length + url.search.length > 2048 || !allowedPath(url.pathname)) return false;
      const token = request.headers.get(CAPTURE_HEADER_NAME);
      if (typeof token !== 'string' || token.length < 32 || token.length > MAX_TOKEN) return false;
      const parts = token.split('.');
      if (parts.length !== 3 || parts[0].length > 512 || parts[1].length > 4096) return false;
      const header = decode(parts[0]), claims = decode(parts[1]);
      const issuer = env.CAPTURE_SERVICE_ACCOUNT_EMAIL || env.FIREBASE_CLIENT_EMAIL;
      const at = now(), seconds = Math.floor(at / 1000);
      if (typeof issuer !== 'string' || !emailPattern.test(issuer) || !Number.isSafeInteger(at) ||
          !object(header) || Object.keys(header).length !== 3 || header.alg !== 'RS256' || header.typ !== 'JWT' ||
          typeof header.kid !== 'string' || !kidPattern.test(header.kid) ||
          !object(claims) || Object.keys(claims).length !== 6 || claims.iss !== issuer || claims.aud !== CAPTURE_AUDIENCE ||
          claims.method !== 'GET' || claims.path !== url.pathname + url.search ||
          !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) ||
          claims.iat < 0 || claims.iat > seconds || claims.exp <= seconds || claims.exp <= claims.iat || claims.exp - claims.iat > 60) return false;
      const signature = bytes(parts[2]);
      if (signature.length < 256 || signature.length > 512) return false;
      if (state && state.issuer !== issuer) return false;
      state ||= {issuer, keys: new Map(), expiresAt: 0, nextRefreshAt: 0, pending: null};
      let key = at < state.expiresAt ? state.keys.get(header.kid) : null;
      if (!key) {
        if (!state.pending && at >= state.nextRefreshAt) {
          state.nextRefreshAt = at + REFRESH_COOLDOWN;
          state.pending = refresh(issuer, at).finally(() => { state.pending = null; });
        }
        if (state.pending) await state.pending;
        key = now() < state.expiresAt ? state.keys.get(header.kid) : null;
      }
      if (!key || claims.exp <= Math.floor(now() / 1000)) return false;
      const valid = await cryptoImpl.subtle.verify('RSASSA-PKCS1-v1_5', key, signature,
        new TextEncoder().encode(parts[0] + '.' + parts[1]));
      return valid && claims.exp > Math.floor(now() / 1000);
    } catch { return false; }
  };
}

export const verifyCaptureRead = createCaptureReadVerifier();
