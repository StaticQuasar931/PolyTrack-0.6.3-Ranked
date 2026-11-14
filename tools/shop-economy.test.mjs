import test from 'node:test';
import assert from 'node:assert/strict';
import {CURRENCY_REWARDS, SHOP_CATALOG} from '../workers/ranked/src/currency-wallet.js';
import {CURRENT_REWARDS, PRICES, MILESTONES, DRAFT, SCENARIOS, milestoneCredits,
  currentAffordability, simulate, review} from './shop-economy.mjs';

test('review uses exact existing backend rewards and immutable prices, no alternate live catalog', () => {
  assert.deepEqual(CURRENT_REWARDS, CURRENCY_REWARDS);
  assert.deepEqual(PRICES, SHOP_CATALOG.map(({id, label, price}) => ({id, label, price})));
  assert.deepEqual(PRICES.map(({id, price}) => ({id, price})), [
    {id: 'profile-pitlane-ticket', price: 20},
    {id: 'profile-apex-observatory', price: 30},
    {id: 'profile-vector-ribbon', price: 50}
  ]);
  assert.equal(CURRENT_REWARDS.login, 8);
  assert.ok(Object.isFrozen(PRICES) && PRICES.every(Object.isFrozen));
  assert.throws(() => {PRICES[0].price = 1;}, TypeError);
});
test('milestone totals are exact, once-per-tier and bounded at 100', () => {
  assert.deepEqual([0, 1, 4, 5, 19, 20, 89].map(milestoneCredits), [0, 20, 20, 50, 50, 100, 100]);
  assert.equal(MILESTONES.reduce((sum, item) => sum + item.credits, 0), 100);
});
test('independent affordability includes login-only and all milestone combinations accurately', () => {
  const days = tracks => PRICES.map(item => currentAffordability(item.price, {serverRecordedTracks: tracks}).loginDaysNeeded);
  assert.deepEqual(days(0), [3, 4, 7]);
  assert.deepEqual(days(1), [0, 2, 4]);
  assert.deepEqual(days(5), [0, 0, 0]);
  assert.deepEqual(days(20), [0, 0, 0]);
  assert.equal(currentAffordability(20, {serverRecordedTracks: 1}).minimumClaimVisits, 1);
  assert.equal(currentAffordability(20, {bankedCredits: 20}).minimumClaimVisits, 0);
  assert.equal(currentAffordability(340, {serverRecordedTracks: 20}).loginDaysNeeded, 30);
});
test('bad numeric inputs, unknown model and malformed weekdays fail rather than invent results', () => {
  for (const value of [-1, 1.5, NaN, Infinity, '20', 90]) assert.throws(() => milestoneCredits(value));
  for (const value of [-1, NaN, '20']) assert.throws(() => currentAffordability(value));
  for (const weekdays of [[], [0, 0], [7], [-1], ['0']]) assert.throws(() => simulate({...SCENARIOS[1], weekdays}));
  assert.throws(() => simulate(SCENARIOS[1], {model: 'live'}), /invalid_model/);
});
test('current login-only affordability is 3/4/7 calendar days; no play reward is invented', () => {
  const result = simulate(SCENARIOS[0], {horizonDays: 90});
  assert.deepEqual(PRICES.map(item => result.targets[item.id].calendarDay), [3, 4, 7]);
  assert.equal(result.earned, 720); assert.equal(result.fullSessionMinutes, 0);
  assert.ok(result.ledger.every(row => row.participationAward === 0 && row.performanceAward === 0));
});
test('current new player earns first cosmetic on first server-recorded track; targets never spend a fake balance', () => {
  const result = simulate(SCENARIOS[1]);
  assert.deepEqual(PRICES.map(item => ({calendarDay: result.targets[item.id].calendarDay,
    earned: result.targets[item.id].earned})), [
    {calendarDay: 1, earned: 28},
    {calendarDay: 3, earned: 36},
    {calendarDay: 8, earned: 52}
  ]);
  assert.equal(result.ledger.reduce((sum, row) => sum + row.milestoneAward, 0), 100);
  assert.equal(result.earned, result.sessions * 8 + 100);
  assert.equal(result.priceTargets, 'independent, no spending');
});
test('current advanced play time/performance has no recurring currency advantage after milestones', () => {
  const advanced = SCENARIOS.find(item => item.id === 'advanced');
  const short = {...advanced, minutes: 1, newServerRecordedTracksPerSession: 0, performance: false};
  const earnings = scenario => simulate(scenario).ledger.map(({earned, loginAward, milestoneAward,
    participationAward, performanceAward}) => ({earned, loginAward, milestoneAward, participationAward, performanceAward}));
  assert.deepEqual(earnings(advanced), earnings(short));
});
test('draft does not pay login-only farming and cannot exceed 64 recurring credits per week', () => {
  const idle = simulate(SCENARIOS[0], {model: 'draft'});
  assert.equal(idle.earned, 0); assert.deepEqual(idle.targets, {});
  for (const scenario of SCENARIOS) {
    const result = simulate(scenario, {model: 'draft'}), totals = new Map();
    for (const row of result.ledger) {
      totals.set(row.week, (totals.get(row.week) || 0) + row.loginAward + row.participationAward + row.performanceAward);
      assert.equal(row.loginAward, 0);
    }
    assert.ok([...totals.values()].every(value => value <= DRAFT.recurringWeeklyCap));
  }
});
test('draft performance is optional, only four per week, never a gate to any item', () => {
  const scenario = {...SCENARIOS[3], performance: false};
  const ordinary = simulate(scenario, {model: 'draft', horizonDays: 90});
  const skilled = simulate({...scenario, performance: true}, {model: 'draft', horizonDays: 90});
  assert.equal(Object.keys(ordinary.targets).length, PRICES.length);
  assert.ok(skilled.earned - ordinary.earned <= Math.ceil(90 / 7) * 4);
});
test('weekly draft allows three participations in one visit; no daily/streak punishment', () => {
  const scenario = {...SCENARIOS[1], weekdays: [0], participationsPerSession: 3, newServerRecordedTracksPerSession: 3};
  const result = simulate(scenario, {model: 'draft', horizonDays: 14});
  assert.deepEqual(result.ledger.map(row => row.participationAward), [60, 60]);
  assert.deepEqual(result.ledger.map(row => row.calendarDay), [1, 8]);
  assert.equal(result.ledger.every(row => row.performanceAward === 0), true);
});
test('new/casual/advanced scenario day targets are stable and explicitly distinct from login-only', () => {
  const targets = model => SCENARIOS.slice(1).map(scenario => {
    const result = simulate(scenario, {model, horizonDays: 90});
    return PRICES.map(item => result.targets[item.id].calendarDay);
  });
  // Current: 8 per visit plus lifetime milestones; targets never spend credits.
  assert.deepEqual(targets('current'), [[1, 3, 8], [1, 1, 1], [1, 1, 1], [1, 2, 3]]);
  // Draft new player: day 1 = 20 milestone + 20 participation; day 3 = 60.
  // Prior-five/20 tracks already cover all prices; daily two participations = 60.
  assert.deepEqual(targets('draft'), [[1, 1, 3], [1, 1, 1], [1, 1, 1], [1, 1, 1]]);
  const draftNew = simulate(SCENARIOS[1], {model: 'draft', horizonDays: 3});
  assert.deepEqual(draftNew.ledger.map(({calendarDay, loginAward, participationAward, milestoneAward, earned}) =>
    ({calendarDay, loginAward, participationAward, milestoneAward, earned})), [
    {calendarDay: 1, loginAward: 0, participationAward: 20, milestoneAward: 20, earned: 40},
    {calendarDay: 3, loginAward: 0, participationAward: 20, milestoneAward: 0, earned: 60}
  ]);
});
test('simulation is deterministic, does not mutate inputs/backend constants and labels scenarios honestly', () => {
  const before = JSON.stringify({SCENARIOS, CURRENCY_REWARDS, SHOP_CATALOG});
  assert.deepEqual(review(), review());
  const result = review();
  assert.equal(result.reviewOnly, true); assert.equal(result.observedPlayerStats, false);
  assert.ok(result.limitations.some(note => note.includes('not a guarantee of strict physics verification')));
  assert.ok(result.scenarios.every(row => row.current.synthetic && row.draft.synthetic));
  assert.equal(JSON.stringify({SCENARIOS, CURRENCY_REWARDS, SHOP_CATALOG}), before);
});

