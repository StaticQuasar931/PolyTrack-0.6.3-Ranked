export const CANONICAL_CLIENT_URL = 'https://staticquasar931.github.io/PolyTrack-0.6.3-Ranked/';
export const CLIENT_REVISION_HEADER = 'X-PolyTrack-Revision';

// Compatibility only: a caller can forge both Origin and revision outside a browser.
export function clientAccessPolicy(request, env) {
  const rawFloor = String(env.MIN_CLIENT_REVISION ?? '').trim();
  if (!rawFloor || rawFloor === '0') return null;
  const floor = Number(rawFloor);
  const missing = String(env.MISSING_CLIENT_REVISION_POLICY ?? 'allow');
  if (!/^[1-9][0-9]*$/.test(rawFloor) || !Number.isSafeInteger(floor) || !['allow', 'reject'].includes(missing)) {
    return {status: 503, error: 'client_policy_unavailable', canonicalUrl: CANONICAL_CLIENT_URL};
  }
  const raw = request.headers.get(CLIENT_REVISION_HEADER);
  if (raw === null && missing === 'allow') return null;
  const revision = raw === null ? null : Number(raw);
  if (raw === null || !/^(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(revision) || revision < floor) {
    return {status: 426, error: raw === null ? 'client_revision_required' : !Number.isSafeInteger(revision) || !/^(0|[1-9][0-9]*)$/.test(raw) ? 'invalid_client_revision' : 'client_update_required', minimumRevision: floor, canonicalUrl: CANONICAL_CLIENT_URL};
  }
  return null;
}

// One IP budget shared across ranked write routes, not reset by UID/path rotation.
export async function admitWriteBurst(request, env) {
  const limiter = env.WRITE_IP_RATE_LIMITER;
  if (!limiter) return String(env.WRITE_IP_RATE_LIMIT_REQUIRED) === 'true' ? 'unavailable' : 'allowed';
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) return 'unavailable';
  try {
    const result = await limiter.limit({key: `ranked-write:${ip}`});
    if (result?.success === true) return 'allowed';
    return result?.success === false ? 'limited' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}
