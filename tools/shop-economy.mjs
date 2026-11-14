/** REVIEW/SIMULATION ONLY. No automatic awards, wallet, proof validation or IO.
 * Scenario counters are hypothetical inputs, NEVER authoritative earning proof.
 * Current milestones count the server-recorded casual ledger; this does NOT
 * establish that every recorded finish was strictly physics-verified.
 * Import existing constants without creating a service or touching backend state.
 */
import {CURRENCY_REWARDS, SHOP_CATALOG} from '../workers/ranked/src/currency-wallet.js';

export const CURRENT_REWARDS = Object.freeze({...CURRENCY_REWARDS});
export const PRICES = Object.freeze(SHOP_CATALOG.map(({id, label, price}) => Object.freeze({id, label, price})));
export const MILESTONES = Object.freeze([1, 5, 20].map(tracks =>
  Object.freeze({serverRecordedTracks: tracks, rewardId: `tracks-${tracks}`, credits: CURRENT_REWARDS[`tracks-${tracks}`]})));
export const DRAFT = Object.freeze({label: 'UNIMPLEMENTED weekly participation proposal', login: 0,
  participation: 20, participationsPerWeek: 3, optionalPerformancePerWeek: 4,
  recurringWeeklyCap: 64, milestones: 'unchanged 1/5/20-track awards'});
const whole = (value, max = 1000000) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const requireWhole = (value, name, max) => {if (!whole(value, max)) throw Error(`invalid_${name}`);};

export function milestoneCredits(serverRecordedTracks) {
  requireWhole(serverRecordedTracks, 'server_recorded_tracks', 89);
  return MILESTONES.reduce((sum, item) => sum + (serverRecordedTracks >= item.serverRecordedTracks ? item.credits : 0), 0);
}

/** Independent target from zero spending. Milestones assumed eligible and
 * unclaimed; loginDaysNeeded=0 means milestone credit alone covers the price,
 * NOT an automatic grant. At least one explicit claim visit is still needed.
 */
export function currentAffordability(price, {serverRecordedTracks = 0, bankedCredits = 0} = {}) {
  requireWhole(price, 'price'); requireWhole(bankedCredits, 'banked_credits');
  const milestones = milestoneCredits(serverRecordedTracks);
  const shortfall = Math.max(0, price - bankedCredits - milestones);
  const loginDaysNeeded = Math.ceil(shortfall / CURRENT_REWARDS.login);
  return {price, eligibleUnclaimedMilestones: milestones, shortfall, loginDaysNeeded,
    minimumClaimVisits: price <= bankedCredits ? 0 : Math.max(1, loginDaysNeeded)};
}

export const SCENARIOS = Object.freeze([
  Object.freeze({id: 'login-only', label: 'No timed play; login effort unmodeled', weekdays: Object.freeze([0, 1, 2, 3, 4, 5, 6]),
    minutes: 0, initialServerRecordedTracks: 0, newServerRecordedTracksPerSession: 0, participationsPerSession: 0, performance: false}),
  Object.freeze({id: 'new', label: 'New: Mon/Wed/Fri, 10 min', weekdays: Object.freeze([0, 2, 4]),
    minutes: 10, initialServerRecordedTracks: 0, newServerRecordedTracksPerSession: 1, participationsPerSession: 1, performance: false}),
  Object.freeze({id: 'casual', label: 'Casual: Mon/Wed/Fri, 10 min; 5 prior server-recorded tracks', weekdays: Object.freeze([0, 2, 4]),
    minutes: 10, initialServerRecordedTracks: 5, newServerRecordedTracksPerSession: 1, participationsPerSession: 1, performance: false}),
  Object.freeze({id: 'advanced', label: 'Advanced: daily, 90 min; 20 prior server-recorded tracks', weekdays: Object.freeze([0, 1, 2, 3, 4, 5, 6]),
    minutes: 90, initialServerRecordedTracks: 20, newServerRecordedTracksPerSession: 3, participationsPerSession: 3, performance: true}),
  Object.freeze({id: 'daily', label: 'Daily: 30 min; starts with no recorded tracks', weekdays: Object.freeze([0, 1, 2, 3, 4, 5, 6]),
    minutes: 30, initialServerRecordedTracks: 0, newServerRecordedTracksPerSession: 2, participationsPerSession: 2, performance: false})
]);

/** Monday-relative UTC calendar; no clock access. All prices are independent
 * affordability targets, never three sequential purchases. No currency is spent.
 * Existing progress assumes eligible unclaimed milestones, NOT seeded currency.
 */
export function simulate(scenario, {model = 'current', horizonDays = 365} = {}) {
  if (!['current', 'draft'].includes(model)) throw Error('invalid_model');
  requireWhole(horizonDays, 'horizon', 3660);
  if (!scenario || !Array.isArray(scenario.weekdays) || scenario.weekdays.length < 1 ||
      new Set(scenario.weekdays).size !== scenario.weekdays.length ||
      !scenario.weekdays.every(day => whole(day, 6))) throw Error('invalid_weekdays');
  for (const key of ['minutes', 'newServerRecordedTracksPerSession', 'participationsPerSession']) requireWhole(scenario[key], key);
  requireWhole(scenario.initialServerRecordedTracks, 'initial_server_recorded_tracks', 89);
  if (typeof scenario.performance !== 'boolean') throw Error('invalid_performance');
  const claimed = new Set(), weeks = new Map(), targets = {}, ledger = [];
  let earned = 0, sessions = 0, tracks = scenario.initialServerRecordedTracks;
  for (let day = 0; day < horizonDays; day++) {
    if (!scenario.weekdays.includes(day % 7)) continue;
    sessions++;
    tracks = Math.min(89, tracks + scenario.newServerRecordedTracksPerSession);
    let milestoneAward = 0;
    for (const milestone of MILESTONES) {
      if (tracks >= milestone.serverRecordedTracks && !claimed.has(milestone.rewardId)) {
        claimed.add(milestone.rewardId); milestoneAward += milestone.credits;
      }
    }
    const week = Math.floor(day / 7), state = weeks.get(week) || {participations: 0, performance: false};
    let participationAward = 0, performanceAward = 0;
    const loginAward = model === 'current' ? CURRENT_REWARDS.login : DRAFT.login;
    if (model === 'draft') {
      const count = Math.min(scenario.participationsPerSession, DRAFT.participationsPerWeek - state.participations);
      state.participations += count; participationAward = count * DRAFT.participation;
      if (scenario.performance && scenario.participationsPerSession > 0 && !state.performance) {
        state.performance = true; performanceAward = DRAFT.optionalPerformancePerWeek;
      }
    }
    weeks.set(week, state);
    earned += loginAward + participationAward + performanceAward + milestoneAward;
    ledger.push({calendarDay: day + 1, week: week + 1, loginAward, participationAward, performanceAward,
      milestoneAward, earned, serverRecordedTracks: tracks});
    for (const item of PRICES) if (!targets[item.id] && earned >= item.price) {
      targets[item.id] = {calendarDay: day + 1, activeDays: sessions, fullSessionMinutes: sessions * scenario.minutes, earned};
    }
  }
  return {model, synthetic: true, priceTargets: 'independent, no spending', horizonDays, sessions,
    fullSessionMinutes: sessions * scenario.minutes, earned, targets, ledger};
}

export function review({horizonDays = 90} = {}) {
  return {reviewOnly: true, observedPlayerStats: false, currentRewards: CURRENT_REWARDS, prices: PRICES,
    affordability: [0, 1, 5, 20].map(serverRecordedTracks => ({serverRecordedTracks,
      items: PRICES.map(item => ({id: item.id, ...currentAffordability(item.price, {serverRecordedTracks})}))})),
    draft: DRAFT,
    scenarios: SCENARIOS.map(scenario => ({id: scenario.id, assumptions: scenario,
      current: simulate(scenario, {horizonDays}), draft: simulate(scenario, {model: 'draft', horizonDays})})),
    limitations: ['All inputs are invented scenarios, not observed player statistics.',
      'Current serverRecordedTracks counts the server-recorded casual ledger, not a guarantee of strict physics verification.',
      'Login-only effort is not measured; no credit-per-minute comparison is inferred.',
      'After lifetime milestones, current continued play adds zero currency beyond login.',
      'Draft participation/performance need new authoritative replay-safe evidence and atomic dedupe; not implemented.',
      'Draft has no consecutive-day requirement; three participation proofs may occur on one day.',
      'Prices buy proposed saved stock-style presets, not exclusive new assets or quality tiers.',
      'Wallet activation and all deployed source/runbook/readiness state remain untouched.']};
}

