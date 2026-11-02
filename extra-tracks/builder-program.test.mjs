import test from 'node:test';
import assert from 'node:assert/strict';
import {BUILDER_PUBLIC_CONTACTS, EMPTY_BUILDER_CREDITS, validateReviewedCredits, buildCreatorStandings,
  validateEditorialScores, validatePlayerVotes, summarizeBuilderRatings} from './builder-program.mjs';

const h = char => char.repeat(64), track = h('a'), code = h('b'), account = h('c'), engine = h('d');
const copy = value => structuredClone(value);
function ledger() {return {schemaVersion: 1, creators: [{creatorId: 'creator-one', name: 'Synthetic Creator'}], credits: [{
  creatorId: 'creator-one', canonicalTrackId: track, codeHash: code,
  review: {status: 'approved', reviewerId: 'reviewer-one', evidenceId: h('e')}}]};}
function fixture() {
  const binding = {accountId: account, trackId: track, codeHash: code, timeMs: 1000, frames: 1000, uploadId: 1, replayHash: h('f')};
  const vote = {accountId: account, canonicalTrackId: track, quality: 8, difficulty: null, receipt: 'synthetic-receipt'};
  const receipt = {purpose: 'builder-rating-draft', receiptId: h('1'), accountId: account, canonicalTrackId: track,
    quality: 8, difficulty: null, issuedAt: 1000, expiresAt: 3000, binding};
  const proof = {authority: 'native-verifier', status: 'verified', proofId: h('2'), binding: copy(binding),
    engineDigest: engine, verifierVersion: 'synthetic-native-v1'};
  const trust = {verifyOwnershipReceipt: token => token === vote.receipt ? receipt : null,
    findApprovedProof: () => proof, allowedEngineDigests: [engine], verifierVersion: 'synthetic-native-v1', now: 2000};
  return {vote, receipt, proof, trust};
}
test('public contacts are exact and immutable; no seeded credits or opinions exist', () => {
  assert.deepEqual(BUILDER_PUBLIC_CONTACTS, {discordUrl: 'https://discord.gg/jW2az4AQUH',
    emailAddress: 'StaticQuasar931Games@gmail.com', emailUrl: 'mailto:StaticQuasar931Games@gmail.com'});
  assert.ok(Object.isFrozen(BUILDER_PUBLIC_CONTACTS));assert.ok(Object.isFrozen(EMPTY_BUILDER_CREDITS.credits));
  assert.deepEqual(buildCreatorStandings(EMPTY_BUILDER_CREDITS), []);
  assert.deepEqual(summarizeBuilderRatings(EMPTY_BUILDER_CREDITS), []);
});
test('credits require explicit reviewer approval and evidence, never an author claim', () => {
  for (const change of [{status: 'pending'}, {evidenceId: ''}, {reviewerId: ''}]) {
    const data = ledger();Object.assign(data.credits[0].review, change);assert.throws(() => validateReviewedCredits(data));
  }
  for (const data of [{author: 'Synthetic Creator'}, {...ledger(), authorClaim: true}]) assert.throws(() => validateReviewedCredits(data));
  const data = ledger();data.credits[0].creatorId = 'unknown';assert.throws(() => validateReviewedCredits(data));
});
test('standings dedupe canonical tracks per creator and credit coauthors separately', () => {
  const data = ledger();data.credits.push(copy(data.credits[0]));
  data.creators.push({creatorId: 'creator-two', name: 'Synthetic Coauthor'});
  data.credits.push({...copy(data.credits[0]), creatorId: 'creator-two'});
  const result = buildCreatorStandings(data);assert.deepEqual(result.map(row => [row.creatorId, row.trackCount, row.rank]),
    [['creator-one', 1, 1], ['creator-two', 1, 1]]);
});
test('standings use counts, stable ties, and omit uncredited names', () => {
  const data = ledger();data.creators.push({creatorId: 'uncredited', name: 'Not a Claim'});
  data.credits.push({...copy(data.credits[0]), canonicalTrackId: h('3'), codeHash: h('4')});
  assert.deepEqual(buildCreatorStandings(data).map(row => [row.creatorId, row.trackCount]), [['creator-one', 2]]);
});
test('conflicting code identities, duplicate creators, inherited fields and unsafe names fail closed', () => {
  let data = ledger();data.credits.push({...copy(data.credits[0]), codeHash: h('5')});assert.throws(() => validateReviewedCredits(data));
  data = ledger();data.creators.push(copy(data.creators[0]));assert.throws(() => validateReviewedCredits(data));
  data = ledger();data.creators[0].name = '<b>claim</b>';assert.throws(() => validateReviewedCredits(data));
  assert.throws(() => validateReviewedCredits(Object.create(ledger())));
  for (const creatorId of ['__proto__', 'constructor', 'prototype']) {data = ledger();data.creators[0].creatorId = creatorId;assert.throws(() => validateReviewedCredits(data));}
});
test('editorial opinions remain separate from player votes; missing ratings remain null', () => {
  const result = summarizeBuilderRatings(ledger(), {editorialScores: [{canonicalTrackId: track, reviewerId: 'editor', quality: 9, difficulty: null}]});
  assert.deepEqual(result[0].editorial, {quality: {value: 9, count: 1}, difficulty: {value: null, count: 0}});
  assert.deepEqual(result[0].players, {quality: {value: null, count: 0}, difficulty: {value: null, count: 0}});
});
test('editorial duplicates, unknown tracks and coerced scores are rejected', () => {
  const row = {canonicalTrackId: track, reviewerId: 'editor', quality: 9, difficulty: null};
  for (const values of [[row, row], [{...row, canonicalTrackId: h('6')}], [{...row, quality: '9'}], [{...row, quality: 0}]])
    assert.throws(() => validateEditorialScores(values, ledger()));
});
test('public PB and played flags cannot replace independent receipt/proof adapters', () => {
  const f = fixture();assert.throws(() => validatePlayerVotes([f.vote], ledger()));
  assert.throws(() => validatePlayerVotes([{...f.vote, played: true}], ledger(), f.trust));
  f.trust.verifyOwnershipReceipt = () => null;assert.throws(() => validatePlayerVotes([f.vote], ledger(), f.trust));
});
test('exact verified evidence accepts one vote, strips receipt text and dedupes retries', () => {
  const f = fixture(), rows = validatePlayerVotes([f.vote, copy(f.vote)], ledger(), f.trust);
  assert.equal(rows.length, 1);assert.equal(rows[0].quality, 8);assert.equal(rows[0].receipt, undefined);
  assert.equal(summarizeBuilderRatings(ledger(), {playerVotes: [f.vote]}, f.trust)[0].players.quality.count, 1);
});
for (const field of ['accountId', 'trackId', 'codeHash', 'timeMs', 'frames', 'uploadId', 'replayHash']) {
  test('native proof must independently match '+field, () => {
    const f = fixture();f.proof.binding[field] = typeof f.proof.binding[field] === 'number' ? 2 : h('7');
    assert.throws(() => validatePlayerVotes([f.vote], ledger(), f.trust));
  });
}
test('copied account receipt and edited scores do not authorize another vote', () => {
  const f = fixture();
  for (const change of [{accountId: h('8')}, {canonicalTrackId: h('9')}, {quality: 10}, {difficulty: 5}])
    assert.throws(() => validatePlayerVotes([{...f.vote, ...change}], ledger(), f.trust));
});
test('held, excluded, unavailable and wrong-engine proofs cannot vote', () => {
  for (const change of [{status: 'waiting'}, {status: 'unavailable'}, {status: 'mismatch'}, {needsReview: true},
    {reviewHold: true}, {held: true}, {excluded: true}, {rejected: true}, {engineDigest: h('0')}, {verifierVersion: 'other'}, {authority: 'snapshot'}]) {
    const f = fixture();Object.assign(f.proof, change);assert.throws(() => validatePlayerVotes([f.vote], ledger(), f.trust));
  }
});
test('expired, future, excessive-lifetime and asynchronous verification results fail closed', () => {
  for (const change of [{expiresAt: 2000}, {issuedAt: 2001}, {expiresAt: 1000 + 8 * 86400000}, {purpose: 'other'}]) {
    const f = fixture();Object.assign(f.receipt, change);assert.throws(() => validatePlayerVotes([f.vote], ledger(), f.trust));
  }
  const f = fixture();f.trust.verifyOwnershipReceipt = async () => f.receipt;assert.throws(() => validatePlayerVotes([f.vote], ledger(), f.trust));
});
test('newest signed vote wins regardless of order; same-time conflicts need review', () => {
  const f = fixture(), newer = {...f.vote, quality: 10, receipt: 'newer'};
  f.trust.verifyOwnershipReceipt = token => token === 'newer' ? {...f.receipt, quality: 10, receiptId: h('3'), issuedAt: 1500} : f.receipt;
  for (const votes of [[f.vote, newer], [newer, f.vote]]) assert.equal(validatePlayerVotes(votes, ledger(), f.trust)[0].quality, 10);
  f.trust.verifyOwnershipReceipt = token => token === 'newer' ? {...f.receipt, quality: 10, receiptId: h('3')} : f.receipt;
  assert.throws(() => validatePlayerVotes([f.vote, newer], ledger(), f.trust));
});
test('inputs remain untouched and returned credits do not alias their input', () => {
  const data = ledger(), f = fixture(), before = JSON.stringify({data, vote: f.vote, receipt: f.receipt, proof: f.proof});
  const validated = validateReviewedCredits(data);validated.credits[0].review.status = 'changed';
  buildCreatorStandings(data);summarizeBuilderRatings(data, {playerVotes: [f.vote]}, f.trust);
  assert.equal(JSON.stringify({data, vote: f.vote, receipt: f.receipt, proof: f.proof}), before);
});
test('rows and receipt sizes are bounded', () => {
  const data = ledger();data.creators = Array(1001).fill(data.creators[0]);assert.throws(() => validateReviewedCredits(data));
  assert.throws(() => validateEditorialScores(Array(10001).fill({}), ledger()));
  const f = fixture();f.vote.receipt = 'x'.repeat(2049);assert.throws(() => validatePlayerVotes([f.vote], ledger(), f.trust));
});
