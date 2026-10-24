import {createPrivateKey, sign} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

const OAUTH = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/datastore';
const BASE = 'https://firestore.googleapis.com/v1/projects/polytrack-052/databases/(default)/documents';
const DOCUMENTS = 'projects/polytrack-052/databases/(default)/documents/';
// Deliberately mirror the existing exporter's read projections, not private documents.
const PROFILE_FIELDS = ['name', 'nickname', 'countryCode', 'profileCosmetics', 'accountCreatedAt',
  'totalPlaytimeMs', 'pbCount', 'latestPbAt', 'updatedAt', 'carStyle', 'carColors', '__name__'];
const RACE_FIELDS = ['accountId', 'trackId', 'name', 'nickname', 'countryCode', 'timeMs', 'frames',
  'raceTimeFrames', 'uploadId', 'verified', 'verifiedState', 'createdAt', 'pbAt', 'updatedAt', 'carStyle',
  'replay', 'replayHash'];
const RACE_NAME = new RegExp('^' + DOCUMENTS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '0\\.6\\.2_race_results/[a-f0-9]{64}_[a-f0-9]{64}$');

function profileCursor(name) {
  const prefix = DOCUMENTS + '0.6.2_profiles_public/';
  if (typeof name !== 'string' || !name.startsWith(prefix)) return false;
  const id = name.slice(prefix.length);
  // The exporter skips invalid account IDs, but must still page past their documents.
  return id.length > 0 && Buffer.byteLength(id) <= 1500 && !id.includes('/') && !['.', '..'].includes(id);
}

function validateRequest(url, options) {
  const denied = () => {throw Error('Snapshot export request outside authorized read boundary');};
  if (typeof url !== 'string' || ![BASE + ':runQuery', BASE + ':batchGet'].includes(url) ||
      options?.method !== 'POST' || typeof options.body !== 'string' || Buffer.byteLength(options.body) > 65536) denied();
  let body;
  try { body = JSON.parse(options.body); } catch { denied(); }
  const headers = new Headers(options.headers);
  if ([...headers].some(([key, value]) => key !== 'content-type' || value !== 'application/json')) denied();
  if (url.endsWith(':runQuery')) {
    const query = body?.structuredQuery;
    if (!Number.isSafeInteger(query?.limit) || query.limit < 1 || query.limit > 100) denied();
    const expected = {structuredQuery: {from: [{collectionId: '0.6.2_profiles_public'}],
      select: {fields: PROFILE_FIELDS.map(fieldPath => ({fieldPath}))},
      orderBy: [{field: {fieldPath: '__name__'}, direction: 'ASCENDING'}], limit: query.limit}};
    if (query.startAt !== undefined) {
      const cursor = query.startAt?.values?.[0]?.referenceValue;
      if (!profileCursor(cursor)) denied();
      expected.structuredQuery.startAt = {values: [{referenceValue: cursor}], before: false};
    }
    if (!isDeepStrictEqual(body, expected)) denied();
  } else {
    if (!Array.isArray(body?.documents) || body.documents.length < 1 || body.documents.length > 20 ||
        body.documents.some(name => typeof name !== 'string' || !RACE_NAME.test(name)) ||
        new Set(body.documents).size !== body.documents.length ||
        !isDeepStrictEqual(body, {documents: body.documents, mask: {fieldPaths: RACE_FIELDS}})) denied();
  }
}

function safeTransportError(error) {
  // Never propagate transport diagnostics that could contain headers or assertions.
  if (['AbortError', 'TimeoutError'].includes(error?.name)) return new DOMException('Snapshot export request interrupted', error.name);
  if (error instanceof TypeError && ['fetch failed', 'terminated'].includes(error.message)) return new TypeError(error.message);
  return Error('Snapshot export transport failed');
}

export function createSnapshotExportFetch({fetchImpl = fetch, oauthFetch = fetchImpl,
  serviceAccount = process.env.FIREBASE_VERIFIER_SERVICE_ACCOUNT, now = Date.now} = {}) {
  let account, key, token, expiresAt = 0, pending;
  async function issue() {
    if (!serviceAccount) throw Error('Snapshot export authentication required: FIREBASE_VERIFIER_SERVICE_ACCOUNT is missing; use --offline for local packaging');
    try {
      if (!account) {
        account = typeof serviceAccount === 'string' ? JSON.parse(serviceAccount) : serviceAccount;
        if (account?.type !== 'service_account' || account.project_id !== 'polytrack-052' ||
            typeof account.client_email !== 'string' || !/^[a-zA-Z0-9._-]+@polytrack-052\.iam\.gserviceaccount\.com$/.test(account.client_email) ||
            typeof account.private_key !== 'string') throw Error();
        key = createPrivateKey(account.private_key);
        if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048) throw Error();
      }
      if (!key) throw Error();
    } catch { throw Error('Invalid snapshot export service-account credential'); }
    const issuedAt = Math.floor(now() / 1000);
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = encode({alg: 'RS256', typ: 'JWT'}) + '.' + encode({iss: account.client_email,
      scope: SCOPE, aud: OAUTH, iat: issuedAt, exp: issuedAt + 3600});
    let assertion;
    try { assertion = unsigned + '.' + sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url'); }
    catch { throw Error('Snapshot export credential signing failed'); }
    let response, payload;
    try {
      response = await oauthFetch(OAUTH, {method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
        headers: {'content-type': 'application/x-www-form-urlencoded'},
        body: new URLSearchParams({grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion}).toString()});
      if (!response?.ok) throw Error();
      const text = await response.text();
      if (Buffer.byteLength(text) > 16384) throw Error();
      payload = JSON.parse(text);
      if (payload.token_type !== 'Bearer' || typeof payload.access_token !== 'string' ||
          !/^[A-Za-z0-9._~+/-]{1,8192}={0,2}$/.test(payload.access_token) ||
          !Number.isSafeInteger(payload.expires_in) || payload.expires_in <= 60 || payload.expires_in > 3600) throw Error();
    } catch { throw Error('Snapshot export OAuth authentication failed; no public fallback attempted'); }
    token = payload.access_token;
    expiresAt = issuedAt * 1000 + payload.expires_in * 1000;
  }
  return async (url, options) => {
    validateRequest(url, options);
    const body = options.body, signal = options.signal ?? AbortSignal.timeout(12000);
    const headers = new Headers(options.headers);
    if (!token || now() >= expiresAt - 60000) {
      pending ||= issue().finally(() => {pending = undefined;});
      await pending;
    }
    headers.set('authorization', 'Bearer ' + token);
    let response;
    try {
      // Construct options explicitly. No caller credentials, redirect mode, or URL can escape.
      response = await fetchImpl(url, {method: 'POST', body, headers, redirect: 'error', signal});
    } catch (error) { throw safeTransportError(error); }
    if ([401, 403].includes(response.status)) {
      token = undefined; expiresAt = 0;
      throw Error('Snapshot export authentication required or read permission denied (' + response.status + '); no public fallback attempted');
    }
    return {ok: response.ok, status: response.status, text: async () => {
      try { return await response.text(); } catch (error) { throw safeTransportError(error); }
    }};
  };
}
