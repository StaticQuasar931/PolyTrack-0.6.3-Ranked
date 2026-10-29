import crypto from 'node:crypto';
export function encode(value){if(value===null)return {nullValue:null};if(value instanceof Date)return {timestampValue:value.toISOString()};if(Array.isArray(value))return {arrayValue:{values:value.map(encode)}};if(typeof value==='object')return {mapValue:{fields:Object.fromEntries(Object.entries(value).map(([k,v])=>[k,encode(v)]))}};if(typeof value==='boolean')return {booleanValue:value};if(typeof value==='number'){if(!Number.isFinite(value))throw Error('Invalid number');return Number.isInteger(value)?{integerValue:String(value)}:{doubleValue:value};}return {stringValue:String(value)};}
export function decode(v){if('nullValue'in v)return null;if('mapValue'in v)return Object.fromEntries(Object.entries(v.mapValue.fields||{}).map(([k,x])=>[k,decode(x)]));if('arrayValue'in v)return (v.arrayValue.values||[]).map(decode);if('integerValue'in v)return Number(v.integerValue);if('doubleValue'in v)return v.doubleValue;if('booleanValue'in v)return v.booleanValue;if('timestampValue'in v)return new Date(v.timestampValue);return v.stringValue??null;}
export async function firestoreFailure(response) {
  const error = new Error('Firestore request failed: ' + response.status);
  error.status = response.status;
  const body = await response.json().catch(() => null);
  const apiError = Array.isArray(body) ? body.find(item => item?.error && typeof item.error === 'object')?.error : body?.error;
  const code = typeof apiError?.status === 'string' && /^[A-Z0-9_]{1,64}$/.test(apiError.status) ? apiError.status : null;
  if (code) error.code = code;
  return error;
}

export const MAX_READ_RETRIES = 2;
export const MAX_RETRY_AFTER_MS = 2000;

function validateMode(mode) {
  if (mode !== 'manual' && mode !== 'scheduled') throw Error('Invalid Firestore quota mode');
  return mode;
}

export function firestoreQuotaMode(env = process.env) {
  return validateMode(env.VERIFIER_FIRESTORE_MODE ?? 'manual');
}

export function boundedRetryAfter(response, now = Date.now()) {
  const value = response.headers?.get?.('Retry-After');
  if (value == null || value.trim() === '') return null;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  if (!Number.isFinite(delay)) return null;
  if (delay > MAX_RETRY_AFTER_MS) return null;
  return Math.max(0, delay);
}

export function createFirestoreCaller({base, access, fetchImpl = fetch,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), maxReadRetries = MAX_READ_RETRIES, mode = 'manual'}) {
  validateMode(mode);
  if (!Number.isInteger(maxReadRetries) || maxReadRetries < 0 || maxReadRetries > MAX_READ_RETRIES) {
    throw Error('Invalid Firestore read retry limit');
  }
  let requests = 0, returnedDocuments = 0, queryCount = 0, emptyQueryMinimumReads = 0, estimatedDocumentReads = 0;
  let failedRequests = 0, unknownReadOutcomes = 0, commitAttempts = 0, writeAttempts = 0, unknownCommitOutcomes = 0;
  let quotaFailure = null;
  const call = async (path, body, {onRetry} = {}) => {
    if (quotaFailure) throw quotaFailure;
    const safeRead = (!body && !String(path).startsWith(':')) || path === ':runQuery' || path === ':batchGet';
    for (let retry = 0; ; retry++) {
      if (quotaFailure) throw quotaFailure;
      if (retry > 0) onRetry?.();
      // Serialize before charging: local validation failures are not transport attempts.
      const options = {
        method: body ? 'POST' : 'GET',
        headers: {authorization: 'Bearer ' + access, 'content-type': 'application/json'},
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000)
      };
      requests++;
      if (path === ':commit') {
        commitAttempts++;
        writeAttempts += Array.isArray(body?.writes) ? body.writes.length : 0;
      }
      let response;
      try { response = await fetchImpl(base + path, options); }
      catch (error) {
        failedRequests++;
        if (safeRead) unknownReadOutcomes++;
        if (path === ':commit') unknownCommitOutcomes++;
        throw error;
      }
      if (!response.ok) {
        failedRequests++;
        if ([408, 500, 502, 503, 504].includes(response.status)) {
          if (safeRead) unknownReadOutcomes++;
          if (path === ':commit') unknownCommitOutcomes++;
        }
      }
      if (mode === 'scheduled' && response.status === 429) {
        // Latch before reading an error body: no read, write, rollback or retry
        // may probe an exhausted database again in this invocation.
        quotaFailure = Object.assign(new Error('Firestore request failed: 429'), {
          status: 429, code: safeRead ? 'FIRESTORE_READ_THROTTLED' : 'FIRESTORE_COMMIT_THROTTLED', deferred: true
        });
        const delay = boundedRetryAfter(response);
        if (delay !== null) quotaFailure.retryAfterMs = delay;
        throw quotaFailure;
      }
      if (response.status === 404) {
        if (!body && !String(path).startsWith(':')) estimatedDocumentReads++;
        return null;
      }
      if (response.ok) {
        let result;
        try { result = await response.json(); }
        catch {
          failedRequests++;
          if (safeRead) unknownReadOutcomes++;
          if (path === ':commit') unknownCommitOutcomes++;
          throw Error('Firestore response decoding failed');
        }
        if (path === ':commit' && (!Array.isArray(result?.writeResults) || !Array.isArray(body?.writes) ||
            result.writeResults.length !== body.writes.length)) unknownCommitOutcomes++;
        const validReadShape = path === ':runQuery'
          ? Array.isArray(result) && result.every(row => row && !row.error && (row.document || typeof row.readTime === 'string'))
          : path === ':batchGet'
            ? Array.isArray(result) && result.every(row => row && !row.error && (row.found || typeof row.missing === 'string')) &&
              (!Array.isArray(body?.documents) || result.length === body.documents.length)
            : result && typeof result.name === 'string';
        if (safeRead && !validReadShape) {
          failedRequests++;
          unknownReadOutcomes++;
          return result;
        }
        if (path === ':runQuery' && Array.isArray(result)) {
          const count = result.filter(row => row?.document).length;
          returnedDocuments += count;
          queryCount++;
          if (!count) emptyQueryMinimumReads++;
          estimatedDocumentReads += Math.max(1, count);
        } else if (path === ':batchGet' && Array.isArray(result)) {
          const count = result.filter(row => row?.found).length;
          const foundOrMissing = result.filter(row => row?.found || row?.missing).length;
          returnedDocuments += count;
          estimatedDocumentReads += foundOrMissing;
        } else if (!body && !String(path).startsWith(':')) {
          estimatedDocumentReads++;
          if (result?.name) returnedDocuments++;
        }
        return result;
      }
      if (response.status === 429 && safeRead) {
        const retryAfter = boundedRetryAfter(response);
        const retryHeader = response.headers?.get?.('Retry-After');
        const rawDelay = retryHeader == null ? null : Number.isFinite(Number(retryHeader))
          ? Number(retryHeader) * 1000 : Date.parse(retryHeader) - Date.now();
        if ((retryHeader != null && Number.isFinite(rawDelay) && rawDelay > MAX_RETRY_AFTER_MS) || retry >= maxReadRetries) {
          const error = await firestoreFailure(response);
          error.code = 'FIRESTORE_READ_THROTTLED';
          error.deferred = true;
          if (Number.isFinite(rawDelay)) error.retryAfterMs = rawDelay;
          throw error;
        }
        await sleep(retryAfter ?? [250, 500][retry]);
        continue;
      }
      const error = await firestoreFailure(response);
      if (response.status === 429 && path === ':commit') {
        error.code = 'FIRESTORE_COMMIT_THROTTLED';
        error.deferred = true;
      }
      throw error;
    }
  };
  return {call, requests: () => requests, returnedDocuments: () => returnedDocuments,
    queryCount: () => queryCount, emptyQueryMinimumReads: () => emptyQueryMinimumReads,
    estimatedDocumentReads: () => estimatedDocumentReads, httpRequests: () => requests,
    failedRequests: () => failedRequests, unknownReadOutcomes: () => unknownReadOutcomes,
    commitAttempts: () => commitAttempts, writeAttempts: () => writeAttempts,
    unknownCommitOutcomes: () => unknownCommitOutcomes};
}

export async function connect(raw, {mode = firestoreQuotaMode()} = {}){
 validateMode(mode);
 const credentials=JSON.parse(raw);if(credentials.project_id!=='polytrack-052')throw Error('Unexpected Firebase project');
 const b=x=>Buffer.from(JSON.stringify(x)).toString('base64url'),now=Math.floor(Date.now()/1000);
 const unsigned=b({alg:'RS256',typ:'JWT'})+'.'+b({iss:credentials.client_email,scope:'https://www.googleapis.com/auth/datastore',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+1800});
 const sig=crypto.sign('RSA-SHA256',Buffer.from(unsigned),credentials.private_key).toString('base64url');
 const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:unsigned+'.'+sig}),signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error('Firebase authentication failed: '+r.status);
 const access=(await r.json()).access_token,base='https://firestore.googleapis.com/v1/projects/polytrack-052/databases/(default)/documents';
 const firestore = createFirestoreCaller({base, access, mode});
 return {...firestore,get:async(collection,id)=>{const d=await firestore.call('/'+collection+'/'+encodeURIComponent(id));return d?{...d,data:decode({mapValue:{fields:d.fields||{}}})}:null;},write:(collection,id,data,prior)=>({update:{name:base.replace('https://firestore.googleapis.com/v1/','')+'/'+collection+'/'+id,fields:encode(data).mapValue.fields},currentDocument:prior?.updateTime?{updateTime:prior.updateTime}:{exists:false}})};
}
