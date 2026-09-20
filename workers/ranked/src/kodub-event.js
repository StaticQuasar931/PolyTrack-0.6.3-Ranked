import { EVENT_COLLECTIONS } from './events.js';

const ROOT = 'https://vps.kodub.com/v6';
const WEEKLY_ROOT = `${ROOT}/trackOfTheWeek`;
const VERSION = '0.6.3';
const WEEK_MS = 7 * 86400000;
const MAX_CLOCK_SKEW_MS = 3600000;
const MAX_TRACK_BYTES = 262144;
const MAX_TIME_MS = 300000;
const HEX = /^[a-f0-9]{64}$/;
const TRACK_CODE = /^PolyTrack[0-9A-Za-z+/_=-]+$/;
const APP_ORIGIN = 'https://app-polytrack.kodub.com';
const APP_REFERER = `${APP_ORIGIN}/`;
const LA_RIVIERA_SOFT_TARGET_MS = 57597;
const LA_RIVIERA_BINDING_ID = 'kodub_la_riviera_57597_v1';

export const KODUB_METADATA_URL = `${WEEKLY_ROOT}?version=${VERSION}`;

function invalid(reason) {
  throw Object.assign(new Error(reason), { code: reason });
}

async function boundedBytes(response, limit) {
  if (!response?.ok || response.redirected) invalid('kodub_upstream_failed');
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > limit) invalid('kodub_payload_too_large');
  if (!response.body?.getReader) invalid('kodub_body_unavailable');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) invalid('kodub_payload_too_large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function fetchBytes(fetcher, url, limit, accept) {
  const response = await fetcher(url, {
    method: 'GET',
    headers: { Accept: accept, Origin: APP_ORIGIN, Referer: APP_REFERER },
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
  });
  return boundedBytes(response, limit);
}

function decodeJson(bytes, reason) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { invalid(reason); }
}

function officialAssetUrl(value, kind) {
  const prefix = `${WEEKLY_ROOT}/${kind}/`;
  if (typeof value !== 'string' || !value.startsWith(prefix) || !HEX.test(value.slice(prefix.length))) {
    invalid('invalid_kodub_asset_url');
  }
  return value;
}

function validateMetadata(payload, now) {
  if (!payload || typeof payload !== 'object' || typeof payload.serverTime !== 'string') invalid('invalid_kodub_metadata');
  const serverTime = Date.parse(payload.serverTime);
  if (!Number.isFinite(serverTime) || Math.abs(serverTime - now) > MAX_CLOCK_SKEW_MS) invalid('invalid_kodub_server_time');
  const current = payload.current;
  if (!current || typeof current !== 'object' || !HEX.test(current.trackId || '') ||
      typeof current.name !== 'string' || !current.name.trim() || current.name.length > 256 ||
      current.author !== null && (typeof current.author !== 'string' || current.author.length > 256) ||
      current.lastModified !== null && !Number.isFinite(Date.parse(current.lastModified)) ||
      ![0, 1, 2].includes(current.environment) || typeof current.endTime !== 'string') {
    invalid('invalid_kodub_metadata');
  }
  const endsAt = Date.parse(current.endTime);
  const startsAt = endsAt - WEEK_MS;
  if (!Number.isSafeInteger(endsAt) || startsAt < 1 || startsAt > now || endsAt <= now || endsAt > now + WEEK_MS + MAX_CLOCK_SKEW_MS) {
    invalid('invalid_kodub_period');
  }
  const trackUrl = officialAssetUrl(current.trackUrl, 'track');
  officialAssetUrl(current.thumbnailUrl, 'image');
  if (current.coverUrl !== null) officialAssetUrl(current.coverUrl, 'image');
  return { current, startsAt, endsAt, trackUrl, trackAssetHash: trackUrl.slice(`${WEEKLY_ROOT}/track/`.length) };
}

function validateLeaderboard(payload) {
  if (!payload || typeof payload !== 'object' || !Number.isSafeInteger(payload.total) || payload.total < 1 ||
      !Array.isArray(payload.entries) || payload.entries.length !== 1) invalid('invalid_kodub_leaderboard');
  const entry = payload.entries[0];
  if (!entry || typeof entry !== 'object' || !Number.isSafeInteger(entry.frames) || entry.frames < 1 ||
      entry.frames > MAX_TIME_MS || entry.verifiedState !== 1) {
    invalid('invalid_kodub_verified_target');
  }
  return entry.frames;
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function softTargetBinding(periodId, trackId, trackCodeHash, officialEndTime) {
  return Object.freeze({ periodId, trackId, trackCodeHash, officialEndTime, targetMs: LA_RIVIERA_SOFT_TARGET_MS });
}

function sameSoftTargetBinding(left, right) {
  return left?.periodId === right.periodId && left.trackId === right.trackId &&
    left.trackCodeHash === right.trackCodeHash && left.officialEndTime === right.officialEndTime &&
    left.targetMs === LA_RIVIERA_SOFT_TARGET_MS;
}

async function readSoftTargetBinding(runtime) {
  const binding = await runtime.store.transaction(tx => tx.get(`${EVENT_COLLECTIONS.softTargets}/${LA_RIVIERA_BINDING_ID}`));
  if (!binding) return null;
  if (!HEX.test(binding.trackId || '') || !HEX.test(binding.trackCodeHash || '') ||
      !/^kodub_\d+$/.test(binding.periodId || '') || !Number.isSafeInteger(binding.officialEndTime) ||
      binding.periodId !== `kodub_${binding.officialEndTime}` || binding.targetMs !== LA_RIVIERA_SOFT_TARGET_MS) {
    invalid('kodub_soft_target_binding_corrupt');
  }
  return Object.freeze({ ...binding });
}

async function claimSoftTargetBinding(runtime, binding) {
  await runtime.store.transaction(async tx => {
    const target = `${EVENT_COLLECTIONS.softTargets}/${LA_RIVIERA_BINDING_ID}`;
    const existing = await tx.get(target);
    if (existing) {
      if (!sameSoftTargetBinding(existing, binding)) invalid('kodub_soft_target_binding_conflict');
      return;
    }
    await tx.create(target, binding);
  });
}

async function readExistingPeriod(runtime, id, trackId, endsAt) {
  const existing = await runtime.store.transaction(tx => tx.get(`${EVENT_COLLECTIONS.periods}/${id}`));
  if (!existing) return null;
  const kodub = existing.kodub;
  if (existing.id !== id || existing.kind !== 'kodub' || existing.trackId !== trackId || existing.endsAt !== endsAt ||
      !kodub || kodub.source !== 'kodub-v6-track-of-the-week' || kodub.officialEndTime !== endsAt ||
      (!kodub.privateSoftScoring && kodub.officialFastestVerifiedMs !== existing.targetMs ||
        kodub.privateSoftScoring === true && (kodub.name !== 'La Riviera' || existing.targetMs !== LA_RIVIERA_SOFT_TARGET_MS ||
          !sameSoftTargetBinding(kodub.privateSoftScoringBinding, softTargetBinding(id, trackId, kodub.trackCodeHash, endsAt)))) ||
      !HEX.test(kodub.trackCodeHash || '') ||
      typeof kodub.trackCode !== 'string' || !TRACK_CODE.test(kodub.trackCode) ||
      kodub.trackCodeHash !== kodub.officialTrackAssetHash) {
    invalid('kodub_existing_period_mismatch');
  }
  if (await sha256(kodub.trackCode) !== kodub.trackCodeHash) invalid('kodub_existing_period_mismatch');
  return Object.freeze({ ...existing, kodub: Object.freeze({ ...kodub }) });
}

export async function provisionKodubEvent(runtime, { capacity, fetch: fetcher = fetch } = {}) {
  if (typeof runtime?.service?.createPeriod !== 'function' || typeof runtime?.now !== 'function' ||
      typeof runtime?.store?.transaction !== 'function' || typeof fetcher !== 'function' ||
      !capacity || typeof capacity !== 'object') invalid('kodub_dependencies_required');
  const now = runtime.now();
  if (!Number.isSafeInteger(now) || now < 1) invalid('invalid_kodub_clock');

  const metadata = validateMetadata(decodeJson(
    await fetchBytes(fetcher, KODUB_METADATA_URL, 16384, 'application/json'), 'invalid_kodub_metadata'
  ), now);
  const { current, startsAt, endsAt, trackAssetHash } = metadata;
  const id = `kodub_${endsAt}`;
  const existing = await readExistingPeriod(runtime, id, current.trackId, endsAt);
  if (existing) {
    if (existing.kodub.privateSoftScoring === true) await claimSoftTargetBinding(runtime, existing.kodub.privateSoftScoringBinding);
    return { created: null, existing: id, period: existing };
  }
  const trackAsset = `${metadata.trackUrl}?version=${VERSION}`;
  const leaderboardUrl = `${ROOT}/leaderboard?version=${VERSION}&trackId=${current.trackId}&skip=0&amount=1&onlyVerified=true`;
  const trackBytes = await fetchBytes(fetcher, trackAsset, MAX_TRACK_BYTES, 'text/plain');
  let trackCode;
  try { trackCode = new TextDecoder('utf-8', { fatal: true }).decode(trackBytes); }
  catch { invalid('invalid_kodub_track_code'); }
  if (trackCode.length < 32 || !TRACK_CODE.test(trackCode)) invalid('invalid_kodub_track_code');
  const trackCodeHash = await sha256(trackCode);
  if (trackCodeHash !== trackAssetHash) invalid('kodub_track_asset_hash_mismatch');
  const officialFastestVerifiedMs = validateLeaderboard(decodeJson(
    await fetchBytes(fetcher, leaderboardUrl, 16384, 'application/json'), 'invalid_kodub_leaderboard'
  ));
  // The title is only a one-time discovery fallback. Once claimed, all future
  // decisions bind to this exact immutable period/track/content identity.
  const candidateBinding = softTargetBinding(id, current.trackId, trackCodeHash, endsAt);
  const titleCandidate = current.name === 'La Riviera' && current.author === 'Kodub';
  const claimedBinding = titleCandidate ? await readSoftTargetBinding(runtime) : null;
  const privateSoftScoring = titleCandidate &&
    (!claimedBinding || sameSoftTargetBinding(claimedBinding, candidateBinding));
  const targetMs = privateSoftScoring ? LA_RIVIERA_SOFT_TARGET_MS : officialFastestVerifiedMs;

  const kodub = Object.freeze({
    source: 'kodub-v6-track-of-the-week',
    trackCode,
    trackCodeHash,
    officialTrackAssetHash: trackAssetHash,
    officialEndTime: endsAt,
    officialFastestVerifiedMs,
    name: current.name,
    author: current.author,
    lastModified: current.lastModified,
    environment: current.environment,
    ...(privateSoftScoring ? { privateSoftScoring: true, privateSoftScoringBinding: candidateBinding } : {}),
  });
  const period = Object.freeze({
    id,
    enabled: true,
    kind: 'kodub',
    trackId: current.trackId,
    startsAt,
    endsAt,
    graceMs: 86400000,
    targetMs,
    maxRp: 700,
    eligibility: 'best-submitted-during-period',
    capacity: Object.freeze({ ...capacity }),
    kodub,
  });
  await runtime.service.createPeriod(period, { currentUtc: true });
  if (privateSoftScoring) await claimSoftTargetBinding(runtime, candidateBinding);
  return { created: period.id, period };
}

export const _internals = { boundedBytes, validateMetadata, validateLeaderboard, readExistingPeriod };
