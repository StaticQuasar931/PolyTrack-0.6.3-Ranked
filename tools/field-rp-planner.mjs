import {fieldRpComponent, scoreFieldRp} from './field-rp.mjs';
import {plannerBenefitEaseScore} from './planner-route-model.mjs';

const compareId = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const unavailable = reason => ({known: false, reason});
// Exact fixed-field slope. Subtracting two large totals can erase a small gain.
const placementGain = (component, places) =>
  (100 / (component.fieldSize + 5)) * component.weight * component.populationMultiplier * places;

/** Profile cards compare like-for-like contribution points, NEVER published Overall score.
 * Complete results are validated before an optional track filter is applied.
 * Positive/negative refer to population reweighting, not movement over time.
 */
export function summarizeFieldRpTracks(finishes, options = {}) {
  const score = scoreFieldRp(finishes, options);
  if (!score.known) return {...unavailable(score.reason), best: null, positiveDifference: null, negativeDifference: null, tracks: []};
  const tracks = score.components.map(row => ({...row,
    overallContribution: row.contribution, fieldContribution: row.points,
    difference: row.points - row.contribution}));
  const greatest = (rows, value) => [...rows].sort((a, b) => value(b) - value(a) || compareId(a.trackId, b.trackId))[0] || null;
  return {known: true, reason: 'complete_scoring_contributions', points: score.points,
    contributionTotal: score.contributionTotal, trackCount: tracks.length, tracks,
    best: greatest(tracks, row => row.fieldContribution),
    positiveDifference: greatest(tracks.filter(row => row.difference > 0), row => row.difference),
    negativeDifference: greatest(tracks.filter(row => row.difference < 0), row => -row.difference),
    units: 'contribution_points', differenceMeaning: 'field_minus_overall_contribution_not_historical_movement'};
}

/** One complete publication-wide reference, not a maximum of loaded/filtered routes.
 * Reference = largest last-to-first Field point gain at the published n and weight.
 * Obtain fields from buildPlannerScoringSourceFromManifest, before filtering.
 */
export function fieldRpBenefitReference(fields, {complete = false, expectedCount} = {}) {
  if (complete !== true || !Array.isArray(fields) || !Number.isSafeInteger(expectedCount) ||
      expectedCount < 0 || fields.length !== expectedCount) return unavailable('incomplete_scoring_fields');
  const seen = new Set();
  let benefitReference = 0;
  for (const field of fields) {
    const first = fieldRpComponent({...field, rank: 1});
    const last = fieldRpComponent({...field, rank: field?.fieldSize});
    if (!first || !last || seen.has(first.trackId)) return unavailable('invalid_or_duplicate_scoring_field');
    seen.add(first.trackId);
    const gain = placementGain(first, first.fieldSize - 1);
    if (!Number.isFinite(gain) || gain < 0) return unavailable('invalid_scoring_field_gain');
    benefitReference = Math.max(benefitReference, gain);
  }
  return {known: true, benefitReference, fieldCount: fields.length,
    referenceKind: 'complete_publication_maximum_last_to_first_field_gain'};
}

/** Frozen-field placement counterfactual. No invented PB time, population or weight.
 * nextPlace can have negligible gain; firstUsefulPlace is the closest better rank
 * whose contribution gain is STRICTLY greater than epsilon (default .0005 points).
 * recommendedPlace also reaches 25% of the available gain, matching Overall routes.
 * Binary searches are bounded and valid for this monotonic fixed-field metric.
 */
export function fieldRpPlacementTargets(finish, {epsilon = .0005, benefitReference, gainFraction = .25} = {}) {
  const current = fieldRpComponent(finish);
  if (!current || !Number.isFinite(epsilon) || epsilon < 0 ||
      !Number.isFinite(benefitReference) || benefitReference < 0 ||
      !Number.isFinite(gainFraction) || gainFraction < 0 || gainFraction > 1) return unavailable('invalid_placement_inputs');
  const maximumGain = placementGain(current, current.rank - 1);
  if (maximumGain > benefitReference) return unavailable('undersized_benefit_reference');
  const actionAt = targetRank => {
    const target = fieldRpComponent({...finish, rank: targetRank});
    const value = placementGain(current, current.rank - targetRank);
    if (!Number.isFinite(value) || value < 0) return null;
    return {trackId: finish.trackId, currentRank: current.rank, targetRank,
    fieldSize: current.fieldSize, weight: current.weight, competition: finish.competition,
      timeMs: finish.timeMs, cachedAt: finish.cachedAt,
      currentContribution: current.points, targetContribution: target.points,
      value, estimatedGain: value, benefitReference,
      normalizedBenefit: benefitReference > 0 ? value / benefitReference : 0,
      metric: 'field', kind: 'improve', playedBefore: true, direction: 'higher',
      units: 'field_contribution_points', assumption: 'fixed_published_field_and_weight'};
  };
  const nextPlace = current.rank > 1 ? actionAt(current.rank - 1) : null;
  const first = current.rank > 1 ? actionAt(1) : null;
  if (!first || first.value <= epsilon) return {known: true, nextPlace, firstUsefulPlace: null, recommendedPlace: null};
  const closest = accepts => {
    let low = 1, high = current.rank - 1;
    while (low < high) {
      const middle = low + Math.ceil((high - low) / 2);
      if (accepts(actionAt(middle).value)) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  const minimumHelpfulRank = closest(value => value > epsilon);
  const decorate = rank => ({...actionAt(rank), minimumHelpfulRank, topGuaranteed: true, maximumGain});
  // Match the normal planner's meaningful-target policy, not its loaded-list denominator.
  const recommendedRank = closest(value => value > epsilon && value >= maximumGain * gainFraction);
  return {known: true, nextPlace, firstUsefulPlace: decorate(minimumHelpfulRank),
    recommendedPlace: {...decorate(recommendedRank), gainFraction}};
}

/** Complete profile + complete publication fields -> parent-ready Next Moves rows.
 * Every raw profile component must agree with its published field metadata.
 * Filter/slice ONLY after computing the reference; no normal-board input is used.
 */
export function buildFieldRpPlanner(finishes, {complete = false, expectedCount, fields,
  fieldsComplete = false, expectedFieldCount, trackIds, epsilon = .0005} = {}) {
  if (!Number.isFinite(epsilon) || epsilon < 0) return {...unavailable('invalid_epsilon'), routes: [], opportunities: []};
  const full = summarizeFieldRpTracks(finishes, {complete, expectedCount});
  if (!full.known) return {...unavailable(full.reason), routes: [], opportunities: []};
  const reference = fieldRpBenefitReference(fields, {complete: fieldsComplete, expectedCount: expectedFieldCount});
  if (!reference.known) return {...reference, routes: [], opportunities: []};
  const byTrack = new Map(fields.map(row => [row.trackId, row]));
  for (const row of full.tracks) {
    const field = byTrack.get(row.trackId);
    if (!field || field.fieldSize !== row.fieldSize || field.weight !== row.weight)
      return {...unavailable('profile_field_mismatch'), routes: [], opportunities: []};
  }
  const summary = summarizeFieldRpTracks(finishes, {complete, expectedCount, trackIds});
  const selected = new Set(summary.tracks.map(row => row.trackId));
  const baselinePoints = full.points;
  const opportunities = [], routes = [];
  for (const finish of finishes) {
    if (!selected.has(finish.trackId)) continue;
    const targets = fieldRpPlacementTargets(finish, {epsilon, benefitReference: reference.benefitReference});
    if (!targets.known) return {...targets, routes: [], opportunities: []};
    const decorate = action => action && {...action,
      // Existing planner comparisons minimize cost; only the adapter changes sign.
      baselineScore: -baselinePoints, targetScore: -(baselinePoints + action.value),
      simulationComplete: true};
    const nextPlace = decorate(targets.nextPlace), firstUsefulPlace = decorate(targets.firstUsefulPlace),
      recommendedPlace = decorate(targets.recommendedPlace);
    if ([nextPlace, firstUsefulPlace, recommendedPlace].some(action => action && !Number.isFinite(action.targetScore)))
      return {...unavailable('projection_overflow'), routes: [], opportunities: []};
    opportunities.push({trackId: finish.trackId, nextPlace, firstUsefulPlace, recommendedPlace});
    if (recommendedPlace) routes.push(recommendedPlace);
  }
  opportunities.sort((a, b) => compareId(a.trackId, b.trackId));
  routes.sort((a, b) => b.value - a.value || compareId(a.trackId, b.trackId));
  return {known: true, reason: 'complete_scoring_field_counterfactual', summary,
    baselinePoints: full.points, benefitReference: reference.benefitReference,
    referenceKind: reference.referenceKind, routes, opportunities,
    unplayedTracks: 'unavailable_without_exact_projected_population_and_weight'};
}

/** Use instead of orderPlannerRoutes, which replaces the reference with loaded max.
 * Enrich returned routes with ease/practice first, then order/filter/slice here.
 */
export function orderFieldRpRoutes(routes, {sort = 'impact', limit = 8} = {}) {
  if (!Array.isArray(routes) || !['impact', 'practice', 'ease', 'training', 'benefit-ease'].includes(sort) ||
      !Number.isSafeInteger(limit) || limit < 0) throw Error('Invalid Field RP route ordering');
  const seen = new Set();
  let reference;
  for (const row of routes) {
    if (!row || row.metric !== 'field' || typeof row.trackId !== 'string' || !row.trackId || seen.has(row.trackId) ||
        !Number.isFinite(row.value) || row.value <= 0 || !Number.isFinite(row.benefitReference) || row.benefitReference <= 0 ||
        row.value > row.benefitReference || reference !== undefined && row.benefitReference !== reference)
      throw Error('Invalid or mixed Field RP route');
    reference = row.benefitReference; seen.add(row.trackId);
  }
  const effort = row => Number.isFinite(row.ease?.effortScore) && row.ease.effortScore >= 0 ? row.ease.effortScore : null;
  const practice = row => Number.isFinite(row.practice?.factor) && row.practice.factor > 0 ? row.practice.factor : 1;
  const compare = (a, b) => {
    if (sort === 'practice' || sort === 'training') {
      const delta = sort === 'practice' ? b.value * practice(b) - a.value * practice(a) : practice(b) - practice(a);
      if (delta) return delta;
    }
    if (['ease', 'training', 'benefit-ease'].includes(sort)) {
      const left = effort(a), right = effort(b);
      if ((left === null) !== (right === null)) return left === null ? 1 : -1;
      if (left !== null) {
        const delta = sort === 'benefit-ease'
          ? plannerBenefitEaseScore(b, b.benefitReference) - plannerBenefitEaseScore(a, a.benefitReference)
          : left - right;
        if (delta) return delta;
      }
    }
    return b.value - a.value || compareId(a.trackId, b.trackId);
  };
  return [...routes].sort(compare).slice(0, limit);
}
