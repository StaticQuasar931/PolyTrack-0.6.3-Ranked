import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {computeOverall} from '../workers/ranked/src/index.js';
import {decodeOverallProjectionBundle, decodeProjectionResults} from './overall-projection-bundle.mjs';
import {projectLocalOverall} from './overall-local-projection.mjs';
import {fieldRpComponent, scoreFieldRp} from './field-rp.mjs';
import {buildPlannerScoringSourceFromManifest} from './planner-scoring-source.mjs';
import {summarizeFieldRpTracks, fieldRpBenefitReference, fieldRpPlacementTargets,
  buildFieldRpPlanner, orderFieldRpRoutes} from './field-rp-planner.mjs';

const finish = (trackId, changes = {}) => ({trackId, rank: 10, fieldSize: 250, weight: 4,
  competition: 1, timeMs: 10000, pbAt: 0, ...changes});
const fields = [finish('large', {fieldSize: 2000, weight: 10}), finish('reference'),
  finish('small', {rank: 3, fieldSize: 10, weight: 1})];
const finishes = fields.map(row => ({...row}));
const options = {complete: true, expectedCount: 3, fields, fieldsComplete: true, expectedFieldCount: 3};

test('profile cards compare higher-is-better contributions, not published Overall cost', () => {
  const rows = finishes.map(row => ({...row, score: -999, overallScore: Infinity}));
  const summary = summarizeFieldRpTracks(rows, options);
  assert.equal(summary.known, true);
  assert.equal(summary.best.trackId, 'large');
  assert.equal(summary.positiveDifference.trackId, 'large');
  assert.equal(summary.negativeDifference.trackId, 'small');
  assert.equal(summary.tracks.find(row => row.trackId === 'reference').difference, 0);
  for (const row of summary.tracks) {
    const component = fieldRpComponent(rows.find(f => f.trackId === row.trackId));
    assert.equal(row.overallContribution, component.contribution);
    assert.equal(row.fieldContribution, component.points);
    assert.equal(row.difference, component.points - component.contribution);
  }
  assert.equal(summary.units, 'contribution_points');
});

test('empty, one-sided and tied cards are honest and deterministic; inputs stay unchanged', () => {
  const rows = [finish('z'), finish('a')], before = JSON.stringify(rows);
  const left = summarizeFieldRpTracks(rows, {complete: true, expectedCount: 2});
  const right = summarizeFieldRpTracks([...rows].reverse(), {complete: true, expectedCount: 2});
  assert.deepEqual(left, right);assert.equal(left.best.trackId, 'a');
  assert.equal(left.positiveDifference, null);assert.equal(left.negativeDifference, null);
  assert.equal(JSON.stringify(rows), before);
  const empty = summarizeFieldRpTracks([], {complete: true, expectedCount: 0});
  assert.equal(empty.best, null);assert.equal(empty.points, 0);
  assert.equal(summarizeFieldRpTracks([finishes[0]], {complete: true, expectedCount: 1}).negativeDifference, null);
});

test('missing/partial, duplicate, pending or invalid components fail before filtering', () => {
  for (const [rows, changes] of [[finishes, {complete: false}], [finishes, {expectedCount: 4}],
    [[finishes[0], finishes[0]], {expectedCount: 2}],
    [[finish('bad', {pending: true})], {expectedCount: 1}],
    [[finish('bad', {weight: NaN})], {expectedCount: 1}]]) {
    const summary = summarizeFieldRpTracks(rows, {...options, ...changes, trackIds: []});
    assert.equal(summary.known, false);assert.equal(summary.best, null);
    assert.equal(buildFieldRpPlanner(rows, {...options, ...changes, trackIds: []}).known, false);
  }
  assert.throws(() => summarizeFieldRpTracks(finishes, {...options, trackIds: 'large'}), /filter/);
});

test('next-place and closest useful-place gain agree with the unchanged scorer', () => {
  const plan = buildFieldRpPlanner(finishes, options);
  assert.equal(plan.known, true);
  const baseline = scoreFieldRp(finishes, options).points;
  for (const action of plan.routes) {
    const changed = finishes.map(row => row.trackId === action.trackId ? {...row, rank: action.targetRank} : row);
    const after = scoreFieldRp(changed, options).points;
    assert.ok(Math.abs(after - baseline - action.value) < .0000011);
    assert.ok(action.value > 0 && action.normalizedBenefit > 0 && action.normalizedBenefit <= 1);
    assert.ok(Math.abs(action.baselineScore - action.targetScore - action.value) < 1e-10);
    assert.equal(action.direction, 'higher');
    assert.ok(action.value >= action.maximumGain * .25);
    assert.equal(action.baselineScore, -plan.baselinePoints);
    const nearest = fieldRpPlacementTargets(finishes.find(row => row.trackId === action.trackId), plan);
    assert.equal(nearest.nextPlace.targetRank, action.currentRank - 1);
    assert.equal(action.targetRank, nearest.recommendedPlace.targetRank);
    assert.equal(action.fieldSize, finishes.find(row => row.trackId === action.trackId).fieldSize);
    assert.equal(action.timeMs, 10000); // Original PB only, never a fabricated target time.
    assert.equal(Object.hasOwn(action, 'targetTimeMs'), false);
  }
  const slowStep = finish('tiny', {rank: 10, weight: .001});
  const reference = fieldRpBenefitReference([slowStep], {complete: true, expectedCount: 1});
  const targets = fieldRpPlacementTargets(slowStep, reference);
  assert.ok(targets.nextPlace.value < .0005);
  assert.equal(targets.firstUsefulPlace.targetRank, 8);
  assert.ok(targets.firstUsefulPlace.value > .0005);
  assert.equal(targets.recommendedPlace.targetRank, 7);
});

test('recommendations target meaningful gains while diagnostics retain the nearest useful place', () => {
  const row = finish('deep', {rank: 101, fieldSize: 2000});
  const reference = fieldRpBenefitReference([row], {complete: true, expectedCount: 1});
  const targets = fieldRpPlacementTargets(row, reference);
  assert.equal(targets.nextPlace.targetRank, 100);
  assert.equal(targets.firstUsefulPlace.targetRank, 100);
  assert.equal(targets.recommendedPlace.targetRank, 76);
  assert.equal(targets.recommendedPlace.minimumHelpfulRank, 100);
  assert.ok(targets.recommendedPlace.value >= targets.recommendedPlace.maximumGain * .25);
  assert.equal(fieldRpPlacementTargets(row, {...reference, gainFraction: 0}).recommendedPlace.targetRank, 100);
  for (const gainFraction of [-1, 1.1, NaN, Infinity])
    assert.equal(fieldRpPlacementTargets(row, {...reference, gainFraction}).known, false);
});

test('fixed-field gain survives cancellation at large finite populations and weights', () => {
  const row = finish('wide', {rank: 2, fieldSize: Number.MAX_SAFE_INTEGER, weight: 1e100});
  const reference = fieldRpBenefitReference([row], {complete: true, expectedCount: 1});
  const targets = fieldRpPlacementTargets(row, reference);
  const expected = 100 / (row.fieldSize + 5) * row.weight * fieldRpComponent(row).populationMultiplier;
  assert.equal(targets.nextPlace.value, expected);
  assert.ok(targets.nextPlace.value > 0);
  assert.equal(targets.recommendedPlace.targetRank, 1);
});

test('first-useful threshold is strict and large ranks use bounded monotonic search', () => {
  const row = finish('track', {rank: 20});
  const reference = fieldRpBenefitReference([row], {complete: true, expectedCount: 1});
  const next = fieldRpPlacementTargets(row, reference).nextPlace;
  const strict = fieldRpPlacementTargets(row, {...reference, epsilon: next.value});
  assert.equal(strict.firstUsefulPlace.targetRank, 18);
  const huge = finish('huge', {rank: 1_000_000_000, fieldSize: 1_000_000_000, weight: 10});
  const ref = fieldRpBenefitReference([huge], {complete: true, expectedCount: 1});
  const targets = fieldRpPlacementTargets(huge, ref);
  assert.ok(targets.firstUsefulPlace.targetRank > 1);
  assert.ok(targets.firstUsefulPlace.value > .0005);
  assert.equal(fieldRpPlacementTargets(row, {...reference, epsilon: Infinity}).known, false);
  assert.equal(fieldRpPlacementTargets(row, {benefitReference: 0}).known, false);
});

test('wins, zero awards, impossible thresholds and unknown fields produce no invented routes', () => {
  const winner = finish('winner', {rank: 1});
  const ref = fieldRpBenefitReference([winner], {complete: true, expectedCount: 1});
  assert.equal(fieldRpPlacementTargets(winner, ref).nextPlace, null);
  assert.equal(fieldRpPlacementTargets(finishes[0], {benefitReference: 10000, epsilon: 10000}).firstUsefulPlace, null);
  const zero = finish('zero', {weight: 0});
  assert.equal(fieldRpPlacementTargets(zero, {benefitReference: 0}).firstUsefulPlace, null);
  for (const changes of [{fieldsComplete: false}, {expectedFieldCount: 4},
    {fields: fields.slice(1), expectedFieldCount: 2},
    {fields: [fields[0], fields[0], fields[2]]},
    {fields: fields.map((row, i) => i ? row : {...row, weight: 9})},
    {fields: fields.map((row, i) => i ? row : {...row, fieldSize: 2001})}])
    assert.equal(buildFieldRpPlanner(finishes, {...options, ...changes}).known, false);
});

test('global reference is stable across filtering, ordering, pagination and profile subsets', () => {
  const all = buildFieldRpPlanner(finishes, options);
  const subset = buildFieldRpPlanner(finishes, {...options, trackIds: ['small']});
  assert.equal(subset.benefitReference, all.benefitReference);
  assert.deepEqual(subset.routes[0], all.routes.find(row => row.trackId === 'small'));
  const other = buildFieldRpPlanner([finishes[2]], {...options, expectedCount: 1});
  assert.equal(other.benefitReference, all.benefitReference);
  for (const sort of ['impact', 'practice', 'ease', 'training', 'benefit-ease']) {
    const enriched = all.routes.map((row, index) => ({...row, ease: {effortScore: index}, practice: {factor: 1 + index / 10}}));
    const sorted = orderFieldRpRoutes(enriched, {sort});
    assert.equal(orderFieldRpRoutes(enriched, {sort, limit: 1})[0].benefitReference, all.benefitReference);
    assert.deepEqual(orderFieldRpRoutes([...enriched].reverse(), {sort}), sorted);
    for (const row of sorted) assert.equal(row.benefitReference, all.benefitReference);
  }
  assert.equal(buildFieldRpPlanner(finishes, {...options, trackIds: []}).routes.length, 0);
  assert.throws(() => orderFieldRpRoutes([{...all.routes[0], benefitReference: 0}]), /route/);
  assert.throws(() => orderFieldRpRoutes(all.routes, {limit: -1}), /ordering/);
});

test('all five sort policies use raw Field gains and the same global benefit reference', () => {
  const routes = [
    {trackId: 'a', value: 100, effort: 9, factor: 1},
    {trackId: 'b', value: 40, effort: 2, factor: 4},
    {trackId: 'c', value: 10, effort: 0, factor: 2}
  ].map(({effort, factor, ...row}) => ({...row, metric: 'field', benefitReference: 1000,
    normalizedBenefit: row.value / 1000, ease: {effortScore: effort}, practice: {factor}}));
  for (const [sort, expected] of Object.entries({impact: ['a', 'b', 'c'], practice: ['b', 'a', 'c'],
    ease: ['c', 'b', 'a'], training: ['b', 'c', 'a'], 'benefit-ease': ['c', 'b', 'a']})) {
    const ordered = orderFieldRpRoutes(routes, {sort});
    assert.deepEqual(ordered.map(row => row.trackId), expected);
    assert.equal(orderFieldRpRoutes(routes.slice(1), {sort})[0].benefitReference, 1000);
    assert.deepEqual(orderFieldRpRoutes(routes, {sort, limit: 1}), ordered.slice(0, 1));
    for (const row of ordered) assert.equal(row.normalizedBenefit, row.value / 1000);
  }
  assert.throws(() => orderFieldRpRoutes(routes.map((row, i) => i ? row : {...row, benefitReference: 999})), /mixed/);
});

function frozenPublication() {
  const root = new URL('../', import.meta.url);
  const folder = /<meta name="polytrack-snapshot" content="([^"]+)"/.exec(fs.readFileSync(new URL('index.html', root), 'utf8'))[1];
  const dir = new URL(folder, root), index = JSON.parse(fs.readFileSync(new URL('index.json', dir)));
  const read = key => JSON.parse(gunzipSync(fs.readFileSync(new URL(index.files[key].path, dir)).map(value => value ^ 0xa7)));
  return {read};
}

test('frozen complete scoring index supplies exact fields and real profile components offline', async () => {
  const {read} = frozenPublication();
  const source = await buildPlannerScoringSourceFromManifest(read('overall-manifest.json'), read('overall-results.json'));
  const id = [...source.profiles.keys()][0], profile = source.profiles.get(id);
  const plan = buildFieldRpPlanner(profile, {complete: true, expectedCount: profile.length,
    fields: source.fields, fieldsComplete: true, expectedFieldCount: source.fields.length});
  assert.equal(plan.known, true);assert.ok(plan.benefitReference > 0);
  assert.equal(plan.baselinePoints, scoreFieldRp(profile, {complete: true, expectedCount: profile.length}).points);
  for (const row of plan.routes) assert.ok(row.value > 0 && row.value <= plan.benefitReference);
});

test('saved projection boards match current Worker contributions, local recalculation and global denominators', async () => {
  const {read} = frozenPublication(), manifest = read('overall-manifest.json'), packed = read('overall-results.json');
  const source = await buildPlannerScoringSourceFromManifest(manifest, packed);
  const generation = 'field-planner-offline-test';
  const overall = {...manifest.boardMetadata, generation, entries: []};
  const saved = read('projection-source.json');
  overall.trackCatalog = saved.boards.map(row => ({trackId: row[0], updatedAt: row[2]}));
  const tracks = decodeOverallProjectionBundle(saved, {overall, generation});
  overall.entries = computeOverall(tracks, [], new Set(), {includePlannerResults: true});
  let checked = 0;
  for (const player of overall.entries) for (const finish of player.resultSamples) {
    const component = fieldRpComponent(finish);
    assert.ok(Math.abs(component.contribution - finish.contribution) < 1e-9);
    const published = source.profiles.get(player.userId).find(row => row.trackId === finish.trackId);
    assert.equal(component.points, fieldRpComponent(published).points);
    checked++;
  }
  assert.ok(checked > 1000);
  const player = overall.entries.find(row => row.resultSamples.some(finish => finish.rank > 2));
  const finish = player.resultSamples.find(row => row.rank > 2);
  const result = projectLocalOverall({accountId: player.userId, generation, overall,
    results: {...await decodeProjectionResults(packed), generation}, tracks,
    acceptedPbs: [{accountId: player.userId, generation, trackId: finish.trackId,
      timeMs: 1, accepted: true, acceptedAt: overall.updatedAt + 1}]});
  assert.equal(result.status, 'projected', result.reason);
  assert.equal(result.calculationExact, true);
  const changedTracks = structuredClone(tracks);
  const changedBoard = changedTracks.find(row => row.trackId === finish.trackId);
  const changedRun = changedBoard.entries.find(row => row.accountId === player.userId);
  changedRun.timeMs = 1; changedRun.pbAt = overall.updatedAt + 1;
  const localOracle = computeOverall(changedTracks, overall.entries, new Set(), {includePlannerResults: true});
  const projectedById = new Map(result.racers.map(row => [row.userId, row]));
  for (const racer of localOracle) {
    const projected = projectedById.get(racer.userId);
    assert.equal(projected.score, racer.score);
    const oraclePoints = scoreFieldRp(racer.resultSamples, {complete: true, expectedCount: racer.raceCount});
    const projectedFinishes = projected.trackResults.map(({projectedRank, ...sample}) => ({...sample, rank: projectedRank}));
    assert.equal(scoreFieldRp(projectedFinishes, {complete: true, expectedCount: projected.raceCount}).points, oraclePoints.points);
  }
  // Projection samples are not silently relabelled published finishes by this helper.
  assert.equal(buildFieldRpPlanner(result.projection.trackResults, {complete: true,
    expectedCount: result.projection.raceCount, fields: source.fields, fieldsComplete: true,
    expectedFieldCount: source.fields.length}).known, false);
  const profile = source.profiles.get(player.userId), options = {complete: true, expectedCount: profile.length,
    fields: source.fields, fieldsComplete: true, expectedFieldCount: source.fields.length};
  const plan = buildFieldRpPlanner(profile, options);
  assert.equal(plan.known, true);
  for (const sort of ['impact', 'practice', 'ease', 'training', 'benefit-ease']) {
    const routes = plan.routes.map(row => ({...row, ease: {effortScore: row.currentRank}, practice: {factor: 1.1}}));
    const sorted = orderFieldRpRoutes(routes, {sort});
    assert.deepEqual(orderFieldRpRoutes([...routes].reverse(), {sort}), sorted);
    for (const row of sorted) {
      const filtered = buildFieldRpPlanner(profile, {...options, trackIds: [row.trackId]}).routes[0];
      assert.equal(filtered.value, row.value);
      assert.equal(filtered.benefitReference, plan.benefitReference);
      assert.equal(filtered.baselineScore, -plan.baselinePoints);
      assert.equal(filtered.normalizedBenefit, row.value / plan.benefitReference);
    }
  }
});
