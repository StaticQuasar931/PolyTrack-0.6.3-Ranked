import {verificationSchedule, verificationKey, pendingSlot, VERIFIER_ENGINE_DIGEST, VERIFIER_VERSION} from '../../workers/ranked/src/verification.js';
export const NEVER = Number.MAX_SAFE_INTEGER;
export function queueState(slots, now = Date.now()) {
  return {slots, ...verificationSchedule(slots, now), updatedAt: now};
}
export function reconciledSlot(slot, canonical) {
  if (!canonical) return {...slot, status: 'unavailable', reason: 'canonical_missing', retryAt: NEVER};
  return verificationKey(canonical) === slot.key ? slot : pendingSlot(canonical);
}
export function completedSlot(slot, result, now = Date.now()) {
  if (!['verified', 'mismatch', 'unavailable'].includes(result.status)) throw Error('Unexpected verifier status');
  if (result.status !== 'unavailable' && result.engineDigest !== VERIFIER_ENGINE_DIGEST) throw Error('Verifier engine pin mismatch');
  const infrastructure = /^(engine_|isolate_|process_|page_error|cpu_|wall_|deadline|native_engine_error)/.test(String(result.reason||''));
  const attempts = Number(slot.attempts || 0) + (infrastructure ? 0 : 1);
  return {...slot, status: result.status, reason: String(result.reason || '').slice(0, 100), engineDigest: String(result.engineDigest || ''), verifierVersion: VERIFIER_VERSION, checkedAt: now, attempts, retryAt: result.status === 'unavailable' ? now + (infrastructure ? 3600000 : attempts < 3 ? 86400000 : 604800000) : NEVER};
}
