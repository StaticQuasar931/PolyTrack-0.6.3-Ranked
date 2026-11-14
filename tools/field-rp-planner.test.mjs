import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {gunzipSync} from 'node:zlib';
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
    assert.equal(action.direction, 'higher');assert.equal(action.targetRank, action.currentRank - 1);
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

test('frozen complete scoring index supplies exact fields and real profile components offline', async () => {
  const root = new URL('../', import.meta.url);
  const folder = /<meta name="polytrack-snapshot" content="([^"]+)"/.exec(fs.readFileSync(new URL('index.html', root), 'utf8'))[1];
  const dir = new URL(folder, root), index = JSON.parse(fs.readFileSync(new URL('index.json', dir)));
  const read = key => JSON.parse(gunzipSync(fs.readFileSync(new URL(index.files[key].path, dir)).map(value => value ^ 0xa7)));
  const source = await buildPlannerScoringSourceFromManifest(read('overall-manifest.json'), read('overall-results.json'));
  const id = [...source.profiles.keys()][0], profile = source.profiles.get(id);
  const plan = buildFieldRpPlanner(profile, {complete: true, expectedCount: profile.length,
    fields: source.fields, fieldsComplete: true, expectedFieldCount: source.fields.length});
  assert.equal(plan.known, true);assert.ok(plan.benefitReference > 0);
  assert.equal(plan.baselinePoints, scoreFieldRp(profile, {complete: true, expectedCount: profile.length}).points);
  for (const row of plan.routes) assert.ok(row.value > 0 && row.value <= plan.benefitReference);
});
