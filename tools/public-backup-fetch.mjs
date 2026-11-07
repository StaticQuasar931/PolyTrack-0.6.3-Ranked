import {CAPTURE_READ_PACER} from './capture-read-pacing.mjs';
export class PublicBackupDeferredError extends Error {
  constructor(reason, status = null) {
    super(reason);
    this.name = 'PublicBackupDeferredError';
    this.status = status;
  }
}

export async function fetchPublicBackupJson(fetchImpl, url, {optional = false, maxBytes = 2 * 1024 * 1024} = {}) {
  let response;
  // Admission waits happen before the per-request HTTP timeout starts.
  const finish=await fetchImpl[CAPTURE_READ_PACER]?.reserve(url);
  try {
    response = await fetchImpl(url, {headers: {Origin: 'https://staticquasar931.github.io', Accept: 'application/json'},
      signal: AbortSignal.timeout(12000)});
  } catch {
    throw new PublicBackupDeferredError('Public backup network request unavailable');
  }finally{finish?.(response?.status);}
  if (optional && response.status === 404) return null;
  if ([408, 429, 500, 502, 503, 504].includes(response.status)) {
    let reason='Public backup service temporarily unavailable';
    try{const reader=response.body?.getReader();let bytes=0,text='';if(reader)try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>4096){await reader.cancel();throw Error('error body too large');}text+=new TextDecoder().decode(part.value);}}finally{reader.releaseLock();}
      const code=JSON.parse(text).error;if(['rate_limited','event_ingress_limit','quota_exceeded','resource_exhausted'].includes(code))reason+=' ('+code+')';
    }catch{}
    throw new PublicBackupDeferredError(reason, response.status);
  }
  if (!response.ok) throw Error(`Public snapshot endpoint failed: ${response.status}`);
  if (Number(response.headers.get('content-length') || 0) > maxBytes) throw Error('Public snapshot response exceeds size limit');
  let text;
  try { text = await response.text(); }
  catch { throw new PublicBackupDeferredError('Public backup response interrupted'); }
  if (Buffer.byteLength(text) > maxBytes) throw Error('Public snapshot response exceeds size limit');
  try { return JSON.parse(text); } catch { throw Error('Invalid public snapshot JSON'); }
}
