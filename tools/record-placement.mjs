const BADGE_ATTRIBUTE = 'data-record-placement';
const HOST_CLASS = 'sq-record-placement-host';
const STYLE_ID = 'sqRecordPlacementStyle';

export const RECORD_PLACEMENT_SETTINGS = Object.freeze({
  enabled: 'polytrack-0.6.2-pb-podiums',
  policy: 'polytrack-0.6.2-pb-podiums-verified-only'
});

const AUTHORITATIVE_SOURCES = new Set(['edge', 'firestore-snapshot', 'canonical-firestore']);

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function accountIdOf(row) {
  if (!row || typeof row !== 'object') return '';
  const accountId = String(row.accountId || '').trim();
  const userId = String(row.userId || '').trim();
  if (accountId && userId && accountId !== userId) return '';
  const value = accountId || userId;
  return value && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value) ? value : '';
}

function revisionOf(snapshot) {
  const revision = Math.max(Number(snapshot?.revision || 0), Number(snapshot?.sourceRevision || 0));
  return Number.isSafeInteger(revision) && revision > 0 ? revision : 0;
}

function timeOf(row) {
  const value = Number(row?.timeMs);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function resultIsExcluded(row) {
  const statuses = [row?.status, row?.runStatus, row?.validationState, row?.verificationStatus]
    .map(value => String(value || '').trim().toLowerCase())
    .filter(Boolean);
  return statuses.some(status => status === 'rejected' || status === 'unavailable' || status.startsWith('unavailable_'));
}

function normalizeTracks(value) {
  const input = typeof value === 'function' ? value() : value;
  if (input instanceof Map) {
    return Array.from(input, ([id, track]) => ({ ...(track || {}), id: String(track?.id || id || '') }));
  }
  if (Array.isArray(input)) return input.map(track => ({ ...(track || {}), id: String(track?.id || '') }));
  if (input && typeof input === 'object') {
    return Object.entries(input).map(([id, track]) => ({ ...(track || {}), id: String(track?.id || id || '') }));
  }
  return [];
}

function snapshotAt(snapshots, trackId) {
  if (snapshots instanceof Map) return snapshots.get(trackId);
  return snapshots && typeof snapshots === 'object' ? snapshots[trackId] : undefined;
}

function normalizePolicy(value) {
  return value === 'verified' ? 'verified' : 'all';
}

export function readRecordPlacementSettings(storage = globalThis.localStorage) {
  let enabled = true;
  let policy = 'all';
  try {
    enabled = storage?.getItem(RECORD_PLACEMENT_SETTINGS.enabled) !== '0';
    policy = storage?.getItem(RECORD_PLACEMENT_SETTINGS.policy) === '1' ? 'verified' : 'all';
  } catch {}
  return { enabled, policy };
}

export function preparePolyTrackCachedSnapshot(snapshot, options = {}) {
  const expectedAlgorithmVersion = String(options.algorithmVersion || '');
  const minimumSchemaVersion = Number(options.schemaVersion || 5);
  const source = String(snapshot?.source || '');
  const entries = Array.isArray(snapshot?.entries) ? snapshot.entries : [];
  const declaredSize = snapshot?.totalEntries ?? snapshot?.fieldSize ?? snapshot?.entryCount;
  const declaredSizeMatches = declaredSize != null && (
    Number.isSafeInteger(Number(declaredSize)) && Number(declaredSize) === entries.length
  );
  const trusted = Boolean(
    snapshot &&
    Array.isArray(snapshot.entries) &&
    AUTHORITATIVE_SOURCES.has(source) &&
    snapshot.complete === true &&
    snapshot.bestEffort !== true &&
    revisionOf(snapshot) > 0 &&
    Number.isFinite(Number(snapshot.fetchedAt)) && Number(snapshot.fetchedAt) > 0 &&
    Number.isFinite(Number(snapshot.checkedAt)) && Number(snapshot.checkedAt) > 0 &&
    Number(snapshot.schemaVersion || 0) >= minimumSchemaVersion &&
    declaredSizeMatches &&
    (!expectedAlgorithmVersion || snapshot.algorithmVersion === expectedAlgorithmVersion)
  );
  return {
    ...(snapshot && typeof snapshot === 'object' ? snapshot : {}),
    entries,
    totalEntries: entries.length,
    authoritative: trusted,
    complete: trusted
  };
}

export function normalizeAuthoritativeSnapshot(snapshot, trackId, options = {}) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const revision = revisionOf(snapshot);
  if (!revision || snapshot.authoritative !== true || snapshot.complete !== true) return null;
  if (!Array.isArray(snapshot.entries)) return null;
  if (options.expectedAlgorithmVersion && snapshot.algorithmVersion !== options.expectedAlgorithmVersion) return null;
  if (Number(options.minSchemaVersion || 0) > Number(snapshot.schemaVersion || 0)) return null;
  const source = String(snapshot.source || '');
  if (source && (!AUTHORITATIVE_SOURCES.has(source) || /local|fallback|pending/i.test(source))) return null;
  const expectedSize = snapshot.totalEntries ?? snapshot.fieldSize ?? snapshot.entryCount;
  if (expectedSize == null || !Number.isSafeInteger(Number(expectedSize)) || Number(expectedSize) !== snapshot.entries.length) return null;

  const ids = new Set();
  const rows = [];
  for (const row of snapshot.entries) {
    const accountId = accountIdOf(row);
    const timeMs = timeOf(row);
    if (!accountId || !timeMs || ids.has(accountId) || row.localPending === true) return null;
    if (row.trackId != null && String(row.trackId) !== String(trackId)) return null;
    ids.add(accountId);
    if (resultIsExcluded(row)) continue;
    rows.push(Object.freeze({ accountId, timeMs, runVerified: row.runVerified === true }));
  }
  rows.sort((a, b) => a.timeMs - b.timeMs || a.accountId.localeCompare(b.accountId));
  return Object.freeze({
    trackId: String(trackId),
    revision,
    algorithmVersion: String(snapshot.algorithmVersion || ''),
    rows: Object.freeze(rows)
  });
}

function placementFromNormalized(snapshot, accountId, policy) {
  const id = String(accountId || '').trim();
  if (!id || !snapshot?.rows?.length) return null;
  const rows = normalizePolicy(policy) === 'verified'
    ? snapshot.rows.filter(row => row.runVerified)
    : snapshot.rows;
  const ownRow = rows.find(row => row.accountId === id);
  if (!ownRow) return null;
  const rank = 1 + rows.filter(row => row.timeMs < ownRow.timeMs).length;
  const fieldSize = rows.length;
  const podium = rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : 'placed';
  return Object.freeze({
    trackId: snapshot.trackId,
    accountId: id,
    rank,
    fieldSize,
    timeMs: ownRow.timeMs,
    label: `${rank}/${fieldSize}`,
    podium,
    verified: ownRow.runVerified,
    revision: snapshot.revision
  });
}

export function parseDisplayedRecordTime(value) {
  const text = String(value || '').trim();
  if (!text || /\bno\s+record\b/i.test(text)) return null;
  const match = text.match(/(?:^|\s)(\d+):([0-5]\d)\.(\d{1,3})(?=\s|$)/);
  if (!match) return null;
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  const milliseconds = Number(match[3].padEnd(3, '0'));
  const total = (minutes * 60 + seconds) * 1000 + milliseconds;
  return Number.isSafeInteger(total) && total > 0 ? total : null;
}

function displayedRecordText(record) {
  if (record?.childNodes) {
    return Array.from(record.childNodes)
      .filter(node => !(node?.nodeType === 1 && node.hasAttribute?.(BADGE_ATTRIBUTE)))
      .map(node => node?.textContent || '')
      .join(' ');
  }
  return String(record?.textContent || '');
}

export function computeRecordPlacement({ snapshot, trackId, accountId, policy = 'all', ...options }) {
  const normalized = normalizeAuthoritativeSnapshot(snapshot, trackId, options);
  return placementFromNormalized(normalized, accountId, policy);
}

export function createRecordPlacementModel(options = {}) {
  const highestRevision = new Map();
  const invalidatedThrough = new Map();
  const accepted = new Map();

  function invalidate(trackIds, throughRevision) {
    const ids = trackIds == null
      ? new Set([...highestRevision.keys(), ...accepted.keys()])
      : new Set((Array.isArray(trackIds) || trackIds instanceof Set ? trackIds : [trackIds]).map(String));
    for (const id of ids) {
      const through = Number.isSafeInteger(Number(throughRevision)) && Number(throughRevision) > 0
        ? Number(throughRevision)
        : Number(highestRevision.get(id) || 0);
      invalidatedThrough.set(id, Math.max(Number(invalidatedThrough.get(id) || 0), through));
      accepted.delete(id);
    }
  }

  function update({ tracks, snapshots, accountId, policy = 'all' }) {
    const placements = new Map();
    for (const track of normalizeTracks(tracks)) {
      const trackId = String(track.id || '');
      if (!trackId) continue;
      const raw = snapshotAt(snapshots, trackId);
      if (raw == null) {
        if (accepted.has(trackId)) invalidate(trackId);
        continue;
      }

      const revision = revisionOf(raw);
      const highest = Number(highestRevision.get(trackId) || 0);
      if (revision && revision < highest) {
        const placement = placementFromNormalized(accepted.get(trackId), accountId, policy);
        if (placement) placements.set(trackId, placement);
        continue;
      }
      if (revision) highestRevision.set(trackId, Math.max(highest, revision));

      const normalized = normalizeAuthoritativeSnapshot(raw, trackId, options);
      const floor = Number(invalidatedThrough.get(trackId) || 0);
      if (!normalized || normalized.revision <= floor) {
        accepted.delete(trackId);
        continue;
      }
      accepted.set(trackId, normalized);
      const placement = placementFromNormalized(normalized, accountId, policy);
      if (placement) placements.set(trackId, placement);
    }
    return placements;
  }

  return Object.freeze({ update, invalidate });
}

function ensureStyle(document) {
  if (!document?.head || document.getElementById(STYLE_ID)) return false;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.${HOST_CLASS}{display:flex!important;align-items:center!important;justify-content:center!important;gap:.38em!important;text-align:center!important}
[${BADGE_ATTRIBUTE}]{display:inline-flex;align-items:center;justify-content:center;min-width:2.65em;padding:.08em .35em;border:1px solid rgba(255,255,255,.34);background:#263b73;color:#f4f8ff;font:700 .78em/1.2 ForcedSquare,Arial,sans-serif;letter-spacing:.02em;box-shadow:0 1px 3px rgba(0,0,0,.28);pointer-events:none}
[${BADGE_ATTRIBUTE}].gold{background:#8a6818;color:#fff2a4;border-color:#ffe27a}
[${BADGE_ATTRIBUTE}].silver{background:#66748a;color:#f1f6ff;border-color:#dce8ff}
[${BADGE_ATTRIBUTE}].bronze{background:#7b4d31;color:#ffd0aa;border-color:#ffb77e}
`;
  document.head.appendChild(style);
  return true;
}

function clearDom(document) {
  document?.querySelectorAll?.(`[${BADGE_ATTRIBUTE}]`).forEach(node => node.remove());
  document?.querySelectorAll?.(`.${HOST_CLASS}`).forEach(node => node.classList.remove(HOST_CLASS));
}

function renderDom(document, tracks, placements, options) {
  if (!document?.querySelectorAll) return;
  const byName = new Map(tracks.filter(track => track.id && track.name).map(track => [String(track.name).trim().toLowerCase(), track.id]));
  const titles = document.querySelectorAll(options.titleSelector || '.track-title p');
  const retained = new Set();
  for (const title of titles) {
    const trackId = options.resolveTrackId
      ? String(options.resolveTrackId(title, tracks) || '')
      : String(byName.get(String(title.textContent || '').trim().toLowerCase()) || '');
    const record = options.findRecordElement
      ? options.findRecordElement(title, trackId)
      : title.closest?.('button')?.querySelector?.('.record,.personal-best');
    if (!record) continue;
    const placement = placements.get(trackId);
    let badge = record.querySelector?.(`[${BADGE_ATTRIBUTE}]`) || null;
    const displayedTime = options.readDisplayedTime
      ? options.readDisplayedTime(record, trackId)
      : parseDisplayedRecordTime(displayedRecordText(record));
    if (!placement || !Number.isSafeInteger(Number(displayedTime)) || Number(displayedTime) !== placement.timeMs) {
      badge?.remove();
      record.classList.remove(HOST_CLASS);
      continue;
    }
    const signature = `${placement.trackId}|${placement.accountId}|${placement.timeMs}|${placement.revision}|${placement.rank}|${placement.fieldSize}|${Number(placement.verified)}`;
    if (badge?.dataset?.signature === signature) {
      retained.add(badge);
      continue;
    }
    if (!badge) {
      badge = document.createElement('span');
      badge.setAttribute(BADGE_ATTRIBUTE, '');
      record.appendChild(badge);
    }
    badge.dataset.signature = signature;
    badge.className = `sq-record-placement ${placement.podium}`;
    badge.textContent = placement.label;
    badge.title = `#${placement.rank} of ${placement.fieldSize} ranked drivers${placement.verified ? ' (verified)' : ''}`;
    badge.setAttribute('aria-label', badge.title);
    record.classList.add(HOST_CLASS);
    retained.add(badge);
  }
  document.querySelectorAll(`[${BADGE_ATTRIBUTE}]`).forEach(badge => {
    if (retained.has(badge)) return;
    const host = badge.parentElement;
    badge.remove();
    host?.classList?.remove(HOST_CLASS);
  });
}

function resolveValue(input, key, fallback) {
  if (own(input, key)) return input[key];
  return typeof fallback === 'function' ? fallback() : fallback;
}

export function installRecordPlacement(options = {}) {
  const document = options.document ?? globalThis.document;
  const model = createRecordPlacementModel(options);
  const addedStyle = options.render ? false : ensureStyle(document);
  let destroyed = false;
  let lastState = null;

  function render(placements, state) {
    if (options.render) options.render(placements, state);
    else renderDom(document, state.tracks, placements, options);
  }

  function update(input = {}) {
    if (destroyed) return new Map();
    const tracks = normalizeTracks(resolveValue(input, 'tracks', options.tracks || options.readTracks));
    const rawSnapshots = resolveValue(input, 'snapshots', options.readSnapshots) || {};
    const snapshots = new Map();
    for (const track of tracks) {
      const raw = snapshotAt(rawSnapshots, track.id);
      snapshots.set(track.id, options.prepareSnapshot ? options.prepareSnapshot(raw, track.id) : raw);
    }
    const storedSettings = readRecordPlacementSettings(options.storage);
    const bridgeSettings = typeof options.readSettings === 'function' ? options.readSettings() || {} : {};
    const settings = { ...storedSettings, ...bridgeSettings, ...(input.settings || {}) };
    if (own(input, 'enabled')) settings.enabled = input.enabled;
    if (own(input, 'policy')) settings.policy = input.policy;
    settings.enabled = settings.enabled !== false;
    settings.policy = normalizePolicy(settings.policy);
    const accountId = String(resolveValue(input, 'accountId', options.readAccountId) || '').trim();
    lastState = { tracks, snapshots, accountId, policy: settings.policy };
    const placements = settings.enabled ? model.update(lastState) : new Map();
    render(placements, { ...lastState, settings });
    return placements;
  }

  function invalidate(trackIds, throughRevision) {
    if (destroyed) return new Map();
    model.invalidate(trackIds, throughRevision);
    const placements = lastState ? model.update(lastState) : new Map();
    if (lastState) render(placements, { ...lastState, settings: { enabled: true, policy: lastState.policy } });
    else clearDom(document);
    return placements;
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    clearDom(document);
    if (addedStyle) document.getElementById(STYLE_ID)?.remove();
  }

  const api = Object.freeze({ update, invalidate, destroy });
  if (options.autoUpdate !== false) update();
  return api;
}
