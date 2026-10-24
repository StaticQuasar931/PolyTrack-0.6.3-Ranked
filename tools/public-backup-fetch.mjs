export class PublicBackupDeferredError extends Error {
  constructor(reason, status = null) {
    super(reason);
    this.name = 'PublicBackupDeferredError';
    this.status = status;
  }
}

export async function fetchPublicBackupJson(fetchImpl, url, {optional = false, maxBytes = 2 * 1024 * 1024} = {}) {
  let response;
  try {
    response = await fetchImpl(url, {headers: {Origin: 'https://staticquasar931.github.io', Accept: 'application/json'},
      signal: AbortSignal.timeout(12000)});
  } catch {
    throw new PublicBackupDeferredError('Public backup network request unavailable');
  }
  if (optional && response.status === 404) return null;
  if ([408, 429, 500, 502, 503, 504].includes(response.status)) {
    throw new PublicBackupDeferredError('Public backup service temporarily unavailable', response.status);
  }
  if (!response.ok) throw Error(`Public snapshot endpoint failed: ${response.status}`);
  if (Number(response.headers.get('content-length') || 0) > maxBytes) throw Error('Public snapshot response exceeds size limit');
  let text;
  try { text = await response.text(); }
  catch { throw new PublicBackupDeferredError('Public backup response interrupted'); }
  if (Buffer.byteLength(text) > maxBytes) throw Error('Public snapshot response exceeds size limit');
  try { return JSON.parse(text); } catch { throw Error('Invalid public snapshot JSON'); }
}
