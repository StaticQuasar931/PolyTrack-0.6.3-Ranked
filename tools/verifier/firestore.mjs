import crypto from 'node:crypto';
export function encode(value){if(value===null)return {nullValue:null};if(value instanceof Date)return {timestampValue:value.toISOString()};if(Array.isArray(value))return {arrayValue:{values:value.map(encode)}};if(typeof value==='object')return {mapValue:{fields:Object.fromEntries(Object.entries(value).map(([k,v])=>[k,encode(v)]))}};if(typeof value==='boolean')return {booleanValue:value};if(typeof value==='number'){if(!Number.isFinite(value))throw Error('Invalid number');return Number.isInteger(value)?{integerValue:String(value)}:{doubleValue:value};}return {stringValue:String(value)};}
export function decode(v){if('nullValue'in v)return null;if('mapValue'in v)return Object.fromEntries(Object.entries(v.mapValue.fields||{}).map(([k,x])=>[k,decode(x)]));if('arrayValue'in v)return (v.arrayValue.values||[]).map(decode);if('integerValue'in v)return Number(v.integerValue);if('doubleValue'in v)return v.doubleValue;if('booleanValue'in v)return v.booleanValue;if('timestampValue'in v)return new Date(v.timestampValue);return v.stringValue??null;}
export async function firestoreFailure(response) {
  const error = new Error('Firestore request failed: ' + response.status);
  error.status = response.status;
  const body = await response.json().catch(() => null);
  const code = body?.error?.status;
  if (['ABORTED', 'FAILED_PRECONDITION', 'ALREADY_EXISTS'].includes(code)) error.code = code;
  return error;
}

export const MAX_READ_RETRIES = 2;
export const MAX_RETRY_AFTER_MS = 2000;

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
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), maxReadRetries = MAX_READ_RETRIES}) {
  if (!Number.isInteger(maxReadRetries) || maxReadRetries < 0 || maxReadRetries > MAX_READ_RETRIES) {
    throw Error('Invalid Firestore read retry limit');
  }
  let requests = 0;
  const call = async (path, body, {onRetry} = {}) => {
    const safeRead = (!body && !String(path).startsWith(':')) || path === ':runQuery' || path === ':batchGet';
    for (let retry = 0; ; retry++) {
      if (retry > 0) onRetry?.();
      requests++;
      const response = await fetchImpl(base + path, {
        method: body ? 'POST' : 'GET',
        headers: {authorization: 'Bearer ' + access, 'content-type': 'application/json'},
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000)
      });
      if (response.status === 404) return null;
      if (response.ok) return response.json();
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
  return {call, requests: () => requests};
}

export async function connect(raw){
 const credentials=JSON.parse(raw);if(credentials.project_id!=='polytrack-052')throw Error('Unexpected Firebase project');
 const b=x=>Buffer.from(JSON.stringify(x)).toString('base64url'),now=Math.floor(Date.now()/1000);
 const unsigned=b({alg:'RS256',typ:'JWT'})+'.'+b({iss:credentials.client_email,scope:'https://www.googleapis.com/auth/datastore',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+1800});
 const sig=crypto.sign('RSA-SHA256',Buffer.from(unsigned),credentials.private_key).toString('base64url');
 const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:unsigned+'.'+sig}),signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error('Firebase authentication failed: '+r.status);
 const access=(await r.json()).access_token,base='https://firestore.googleapis.com/v1/projects/polytrack-052/databases/(default)/documents';
 const firestore = createFirestoreCaller({base, access});
 return {call:firestore.call,get:async(collection,id)=>{const d=await firestore.call('/'+collection+'/'+encodeURIComponent(id));return d?{...d,data:decode({mapValue:{fields:d.fields||{}}})}:null;},write:(collection,id,data,prior)=>({update:{name:base.replace('https://firestore.googleapis.com/v1/','')+'/'+collection+'/'+id,fields:encode(data).mapValue.fields},currentDocument:prior?.updateTime?{updateTime:prior.updateTime}:{exists:false}}),requests:firestore.requests};
}
