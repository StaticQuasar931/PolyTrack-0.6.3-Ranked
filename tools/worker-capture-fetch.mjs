import {createPrivateKey, sign} from 'node:crypto';

export const CAPTURE_HEADER_NAME = 'X-PolyTrack-Capture';
export const CAPTURE_AUDIENCE = 'polytrack-private-capture-v1';
const ORIGIN = 'https://polytrack-ranked-worker.staticquasar931.workers.dev';
const emailPattern = /^[A-Za-z0-9._-]{1,128}@[A-Za-z0-9.-]{1,128}\.iam\.gserviceaccount\.com$/;

function allowedPath(path) {
  if (/[^A-Za-z0-9/_-]/.test(path) || path.includes('//') || path.endsWith('/')) return false;
  if (path.split('/').includes('admin')) return false;
  return ['/v1/status', '/v1/capture-auth', '/v1/extra-tracks/unranked', '/v1/kodub-weekly'].includes(path) ||
    /^\/v1\/snapshot\/(overall|track)(\/page)?$/.test(path) ||
    /^\/v1\/events\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(path);
}

function adminArchive(url, headers) {
  const match = /^\/v1\/events\/admin\/archive-export\/(?:archives\/(\d{4}(?:0[1-9]|1[0-2]))|[A-Za-z0-9_-]{1,64}\/(snapshot(?:\/page)?|track|replays\/[a-f0-9]{64}))$/.exec(url.pathname);
  const admin = headers.get('X-Admin-Token');
  if (!match || !admin || admin.trim() !== admin || admin.length > 4096) return false;
  if (match[2] !== 'snapshot/page') return url.search === '';
  const keys = [...url.searchParams.keys()];
  return keys.length === 2 && keys.includes('generation') && keys.includes('page') &&
    /^[a-f0-9]{64}$/.test(url.searchParams.get('generation') || '') && /^(0|[1-9]\d?)$/.test(url.searchParams.get('page') || '');
}

function validate(input, options) {
  const request = typeof Request !== 'undefined' && input instanceof Request ? input : null;
  const url = new URL(request ? request.url : input);
  const method = options.method ?? request?.method ?? 'GET';
  if (method !== 'GET' || url.origin !== ORIGIN || url.username || url.password || url.hash ||
      url.pathname.length + url.search.length > 2048 ||
      options.body != null || request?.body != null) throw Error('Worker capture URL or method outside authorized read boundary');
  const headers = new Headers(options.headers ?? request?.headers);
  if (headers.has(CAPTURE_HEADER_NAME)) throw Error('Caller-supplied Worker capture authentication is not allowed');
  const route = adminArchive(url, headers) ? 'admin-archive' : allowedPath(url.pathname) ? 'capture' : 'denied';
  if (route === 'denied') throw Error('Worker capture URL or method outside authorized read boundary');
  return {url, headers, route, signal: options.signal ?? request?.signal ?? AbortSignal.timeout(12000)};
}

export function classifyWorkerCaptureRequest(input, options = {}) {
  try { return validate(input, options).route; }
  catch { return 'denied'; }
}

function safeTransportError(error) {
  if (['AbortError', 'TimeoutError'].includes(error?.name)) return new DOMException('Worker capture request interrupted', error.name);
  return Error('Worker capture transport failed');
}

export function createWorkerCaptureFetch({fetchImpl = globalThis.fetch,
  serviceAccount = process.env.FIREBASE_VERIFIER_SERVICE_ACCOUNT, now = Date.now} = {}) {
  let account, key;
  function credential() {
    if (key) return;
    if (!serviceAccount) throw Error('Worker capture authentication requires FIREBASE_VERIFIER_SERVICE_ACCOUNT');
    try {
      account = typeof serviceAccount === 'string' ? JSON.parse(serviceAccount) : {...serviceAccount};
      if (account?.type !== 'service_account' || typeof account.client_email !== 'string' || !emailPattern.test(account.client_email) ||
          typeof account.private_key_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(account.private_key_id) ||
          typeof account.private_key !== 'string') throw Error();
      key = createPrivateKey(account.private_key);
      if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048 ||
          key.asymmetricKeyDetails.modulusLength > 4096 || key.asymmetricKeyDetails.publicExponent !== 65537n) throw Error();
      account = {client_email: account.client_email, private_key_id: account.private_key_id};
    } catch { key = undefined; throw Error('Invalid Worker capture service-account credential'); }
  }
  return async (input, options = {}) => {
    // Validate the destination before touching credentials or constructing a token.
    const {url, headers, route, signal} = validate(input, options);
    if (route === 'capture') {
      credential();
      const at = now();
      if (!Number.isSafeInteger(at) || at < 0) throw Error('Invalid Worker capture signing time');
      const iat = Math.floor(at / 1000);
      const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
      const unsigned = encode({alg: 'RS256', typ: 'JWT', kid: account.private_key_id}) + '.' +
        encode({iss: account.client_email, aud: CAPTURE_AUDIENCE, method: 'GET', path: url.pathname + url.search, iat, exp: iat + 60});
      let signature;
      try { signature = sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url'); }
      catch { throw Error('Worker capture credential signing failed'); }
      headers.set(CAPTURE_HEADER_NAME, unsigned + '.' + signature);
    }
    try {
      const response = await fetchImpl(url.href, {method: 'GET', headers, signal, redirect: 'error', credentials: 'omit'});
      if (response.redirected || response.status >= 300 && response.status < 400) throw Error();
      return response;
    } catch (error) { throw safeTransportError(error); }
  };
}

// Parent tools must leave their fetchImpl default undefined when using this resolver.
// An explicitly injected fixture is returned unchanged, even if it equals global fetch.
export function resolveWorkerCaptureFetch(fetchImpl, options = {}) {
  if (fetchImpl !== undefined) {
    if (typeof fetchImpl !== 'function') throw Error('Invalid injected capture fetch');
    return fetchImpl;
  }
  return createWorkerCaptureFetch(options);
}
