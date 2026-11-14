import {buildPlannerScoringSourceFromManifest} from './planner-scoring-source.mjs';

export const FIELD_RP_MODEL = Object.freeze({
  label: 'Field RP (experimental)', version: 'field-rp-v1',
  referencePopulation: 250, exponent: 1.5, maxRelativeBoost: 2
});
const compareId = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const id = value => typeof value === 'string' && value.length > 0;
const round = value => Number(value.toFixed(6));
function selection(value) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.some(item => !id(item))) throw Error('Invalid Field RP filter');
  return new Set(value);
}

/** Published scoring components only, never normal-board ranks or cached summary samples.
 * Equal published placements get equal points. Do not re-rank ties here.
 * The published weight already contains log population, type and competition factors.
 */
export function fieldRpComponent(finish) {
  if (!id(finish?.trackId) || !Number.isSafeInteger(finish.rank) || finish.rank < 1 ||
      !Number.isSafeInteger(finish.fieldSize) || finish.fieldSize < Math.max(2, finish.rank) ||
      !Number.isFinite(finish.weight) || finish.weight < 0 ||
      ['local', 'localPending', 'pending'].some(key => finish[key] === true) ||
      ['complete', 'sourceComplete', 'ranksExact', 'totalEntriesExact', 'runVerified', 'integrityVerified']
        .some(key => finish[key] === false)) return null;
  const {rank, fieldSize: n, weight} = finish;
  // Algebraically identical to Overall's confidence-shrunk placement cost.
  const placementCost = 50 + (n - 1) / (n + 5) * (100 * (rank - 1) / (n - 1) - 50);
  const contribution = Math.max(0, (100 - placementCost) * weight);
  const populationMultiplier = Math.min(FIELD_RP_MODEL.maxRelativeBoost,
    (Math.log1p(n) / Math.log1p(FIELD_RP_MODEL.referencePopulation)) ** FIELD_RP_MODEL.exponent);
  const points = contribution * populationMultiplier;
  if (![contribution, points].every(Number.isFinite)) return null;
  return {trackId: finish.trackId, rank, fieldSize: n, weight, placementCost,
    contribution, populationMultiplier, fieldWeight: weight * populationMultiplier, points};
}

/** Complete per-profile finishes, e.g. planner source.profiles.get(userId).
 * Missing coverage makes the entire profile unavailable, not an invented zero score.
 * Filters apply AFTER coverage validation; [] selects nothing, omitted selects all.
 */
export function scoreFieldRp(finishes, {complete = false, expectedCount, trackIds} = {}) {
  const selected = selection(trackIds);
  const unavailable = reason => ({known: false, points: null, components: [], reason});
  if (complete !== true || !Array.isArray(finishes) || !Number.isSafeInteger(expectedCount) ||
      expectedCount < 0 || finishes.length !== expectedCount) return unavailable('missing_coverage');
  const seen = new Set(), components = [];
  for (const finish of finishes) {
    const component = fieldRpComponent(finish);
    if (!component || seen.has(component.trackId)) return unavailable('invalid_or_duplicate_component');
    seen.add(component.trackId);
    if (!selected || selected.has(component.trackId)) components.push(component);
  }
  components.sort((a, b) => compareId(a.trackId, b.trackId));
  const points = components.reduce((sum, row) => sum + row.points, 0);
  if (!Number.isFinite(points)) return unavailable('score_overflow');
  return {known: true, points: round(points), trackCount: components.length, components,
    contributionTotal: round(components.reduce((sum, row) => sum + row.contribution, 0)),
    reason: 'experimental_snapshot_only'};
}

/** Bound manifest + complete compact bundle. Pure local decoding, no IO or Firebase.
 * Only return a ranking if the existing planner validator accepts the entire source.
 * User and track filters do not change the original scoring field/populations.
 */
export async function buildFieldRpRanking(manifest, packed, {trackIds, userIds} = {}) {
  selection(trackIds);
  const users = selection(userIds);
  const source = await buildPlannerScoringSourceFromManifest(manifest, packed);
  const entries = [], excluded = [];
  for (const [userId, finishes] of source.profiles) {
    if (users && !users.has(userId)) continue;
    const score = scoreFieldRp(finishes, {complete: true, expectedCount: finishes.length, trackIds});
    if (!score.known) excluded.push({userId, reason: score.reason});
    else if (!score.trackCount) excluded.push({userId, reason: 'no_selected_results'});
    else entries.push({userId, points: score.points, contributionTotal: score.contributionTotal,
      trackCount: score.trackCount});
  }
  entries.sort((a, b) => b.points - a.points || compareId(a.userId, b.userId));
  let rank = 0;
  entries.forEach((row, index) => {
    if (!index || row.points !== entries[index - 1].points) rank = index + 1;
    row.rank = rank;
  });
  excluded.sort((a, b) => compareId(a.userId, b.userId));
  return {model: FIELD_RP_MODEL, experimental: true, published: false,
    sourceRevision: packed.sourceRevision, updatedAt: packed.updatedAt,
    entries, excluded};
}
