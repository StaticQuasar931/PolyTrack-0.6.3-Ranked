'use strict';
const {LIMITS} = require('./replay.cjs');
const reviewed = require('./track-geometry.json');
const byName = new Map(reviewed.tracks.map(track => [track.name, track]));

function geometryDecision(track, engineDigest) {
  const {parts, spanX, spanZ} = track.geometry;
  if (!Number.isSafeInteger(parts) || parts < 0 || !Number.isFinite(spanX) || !Number.isFinite(spanZ) ||
      spanX < 0 || spanZ < 0 || spanX > LIMITS.trackSpan || spanZ > LIMITS.trackSpan) {
    return {reason: 'track_geometry_limit', geometryPolicy: 'rejected'};
  }
  if (parts <= LIMITS.trackParts) return {reason: null, geometryPolicy: 'default'};
  const pinned = byName.get(track.name);
  // Exceptions are exact reviewed artifacts, never a raised cap for unknown geometry.
  if (engineDigest === reviewed.engineDigest && pinned && pinned.hash === track.hash && pinned.id === track.id &&
      pinned.parts === parts && pinned.spanX === spanX && pinned.spanZ === spanZ) {
    return {reason: null, geometryPolicy: 'reviewed-pinned'};
  }
  return {reason: 'track_geometry_limit', geometryPolicy: 'rejected'};
}

module.exports = {geometryDecision};
