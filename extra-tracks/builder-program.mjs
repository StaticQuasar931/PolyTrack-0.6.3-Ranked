// Offline reviewed-data utilities only. No receipt signer, network access, or backend is provided.
export const BUILDER_PUBLIC_CONTACTS = Object.freeze({
  discordUrl: 'https://discord.gg/jW2az4AQUH',
  emailAddress: 'StaticQuasar931Games@gmail.com',
  emailUrl: 'mailto:StaticQuasar931Games@gmail.com',
});
export const EMPTY_BUILDER_CREDITS = Object.freeze({schemaVersion: 1,
  creators: Object.freeze([]), credits: Object.freeze([])});

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const BLOCKED = new Set(['__proto__', 'prototype', 'constructor']);
const BINDING_FIELDS = ['accountId', 'trackId', 'codeHash', 'timeMs', 'frames', 'uploadId', 'replayHash'];
const MAX_ROWS = 10000, MAX_RECEIPT_AGE = 7 * 86400000;
const plain = value => value !== null && typeof value === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const demand = (condition, message) => {if (!condition) throw new TypeError(message);};
const integer = value => Number.isSafeInteger(value) && value > 0;
const identifier = value => typeof value === 'string' && ID.test(value) && !BLOCKED.has(value);
const hash = value => typeof value === 'string' && HASH.test(value);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function shape(value, required, optional = []) {
  demand(plain(value) && required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key)), 'Unexpected or missing ledger field');
}
function rows(value, max = MAX_ROWS) {
  demand(Array.isArray(value) && value.length <= max, 'Ledger rows exceed bounds');
}
function score(value) {return Number.isInteger(value) && value >= 1 && value <= 10;}
function scores(row) {
  demand((row.quality === null || score(row.quality)) && (row.difficulty === null || score(row.difficulty)) &&
    (row.quality !== null || row.difficulty !== null), 'Supply quality or difficulty from 1 to 10');
}
function binding(value) {
  shape(value, BINDING_FIELDS);
  demand(hash(value.accountId) && hash(value.trackId) && hash(value.codeHash) && hash(value.replayHash) &&
    integer(value.timeMs) && integer(value.frames) && integer(value.uploadId), 'Invalid exact run binding');
}
function sameBinding(a, b) {return BINDING_FIELDS.every(key => a[key] === b[key]);}

// The caller must supply a trusted reviewed ledger, not author/submission claims.
export function validateReviewedCredits(data) {
  shape(data, ['schemaVersion', 'creators', 'credits']);
  demand(data.schemaVersion === 1, 'Unsupported builder credits schema');
  rows(data.creators, 1000);rows(data.credits);
  const creators = new Map(), tracks = new Map(), credits = new Map();
  for (const creator of data.creators) {
    shape(creator, ['creatorId', 'name']);
    demand(identifier(creator.creatorId) && !creators.has(creator.creatorId), 'Invalid or duplicate creator ID');
    demand(typeof creator.name === 'string' && creator.name === creator.name.trim() && creator.name.length >= 1 &&
      creator.name.length <= 80 && !/[<>\u0000-\u001f\u007f]/.test(creator.name), 'Invalid reviewed creator name');
    creators.set(creator.creatorId, {...creator});
  }
  for (const credit of data.credits) {
    shape(credit, ['creatorId', 'canonicalTrackId', 'codeHash', 'review']);
    shape(credit.review, ['status', 'reviewerId', 'evidenceId']);
    demand(creators.has(credit.creatorId) && hash(credit.canonicalTrackId) && hash(credit.codeHash), 'Unbound creator credit');
    demand(credit.review.status === 'approved' && identifier(credit.review.reviewerId) && hash(credit.review.evidenceId),
      'Creator credit requires explicit approval and evidence');
    demand(!tracks.has(credit.canonicalTrackId) || tracks.get(credit.canonicalTrackId) === credit.codeHash,
      'Conflicting canonical track code');
    tracks.set(credit.canonicalTrackId, credit.codeHash);
    const key = credit.creatorId + ':' + credit.canonicalTrackId;
    if (!credits.has(key)) credits.set(key, {...credit, review: {...credit.review}});
  }
  return {schemaVersion: 1, creators: [...creators.values()].sort((a, b) => compare(a.creatorId, b.creatorId)),
    credits: [...credits.values()].sort((a, b) => compare(a.creatorId, b.creatorId) || compare(a.canonicalTrackId, b.canonicalTrackId))};
}

export function buildCreatorStandings(data) {
  const ledger = validateReviewedCredits(data), tracks = new Map();
  for (const credit of ledger.credits) {
    if (!tracks.has(credit.creatorId)) tracks.set(credit.creatorId, new Set());
    tracks.get(credit.creatorId).add(credit.canonicalTrackId);
  }
  const standings = ledger.creators.filter(creator => tracks.has(creator.creatorId)).map(creator => ({...creator,
    trackCount: tracks.get(creator.creatorId).size, canonicalTrackIds: [...tracks.get(creator.creatorId)].sort()}))
    .sort((a, b) => b.trackCount - a.trackCount || compare(a.creatorId, b.creatorId));
  return standings.map((creator, index) => ({...creator,
    rank: index && standings[index - 1].trackCount === creator.trackCount
      ? standings.findIndex(row => row.trackCount === creator.trackCount) + 1 : index + 1}));
}

export function validateEditorialScores(values, data) {
  const ledger = validateReviewedCredits(data), eligible = new Set(ledger.credits.map(row => row.canonicalTrackId));
  rows(values);const seen = new Set();
  return values.map(row => {
    shape(row, ['canonicalTrackId', 'reviewerId', 'quality', 'difficulty']);scores(row);
    const key = row.reviewerId + ':' + row.canonicalTrackId;
    demand(identifier(row.reviewerId) && eligible.has(row.canonicalTrackId) && !seen.has(key), 'Invalid or duplicate editorial score');
    seen.add(key);return {...row};
  }).sort((a, b) => compare(a.canonicalTrackId, b.canonicalTrackId) || compare(a.reviewerId, b.reviewerId));
}

// These synchronous adapters are a TRUST BOUNDARY. They must verify authentic ownership
// receipts and resolve independently approved native evidence outside this public module.
// Never implement them as identity functions over player-provided JSON or snapshot flags.
export function validatePlayerVotes(values, data, trust = {}) {
  const ledger = validateReviewedCredits(data), eligible = new Map(ledger.credits.map(row => [row.canonicalTrackId, row.codeHash]));
  rows(values);if (!values.length) return [];
  demand(plain(trust) && typeof trust.verifyOwnershipReceipt === 'function' && typeof trust.findApprovedProof === 'function' &&
    Array.isArray(trust.allowedEngineDigests) && trust.allowedEngineDigests.length > 0 && trust.allowedEngineDigests.length <= 16 &&
    trust.allowedEngineDigests.every(hash) && typeof trust.verifierVersion === 'string' &&
    trust.verifierVersion.length > 0 && trust.verifierVersion.length <= 80 && integer(trust.now), 'Trusted vote verification adapters required');
  const accepted = new Map();
  for (const vote of values) {
    shape(vote, ['accountId', 'canonicalTrackId', 'quality', 'difficulty', 'receipt']);scores(vote);
    demand(hash(vote.accountId) && eligible.has(vote.canonicalTrackId) && typeof vote.receipt === 'string' &&
      vote.receipt.length >= 1 && vote.receipt.length <= 2048, 'Invalid player vote');
    const receipt = trust.verifyOwnershipReceipt(vote.receipt);
    demand(plain(receipt) && receipt.purpose === 'builder-rating-draft' && hash(receipt.receiptId) &&
      receipt.accountId === vote.accountId && receipt.canonicalTrackId === vote.canonicalTrackId &&
      receipt.quality === vote.quality && receipt.difficulty === vote.difficulty && integer(receipt.issuedAt) &&
      integer(receipt.expiresAt) && receipt.issuedAt <= trust.now && receipt.expiresAt > trust.now &&
      receipt.expiresAt > receipt.issuedAt && receipt.expiresAt - receipt.issuedAt <= MAX_RECEIPT_AGE,
    'Ownership receipt does not authorize this exact vote');
    binding(receipt.binding);
    demand(receipt.binding.accountId === vote.accountId && receipt.binding.trackId === vote.canonicalTrackId &&
      receipt.binding.codeHash === eligible.get(vote.canonicalTrackId), 'Receipt is bound to a different account or track');
    const proof = trust.findApprovedProof({...receipt.binding});
    demand(plain(proof) && proof.authority === 'native-verifier' && proof.status === 'verified' &&
      hash(proof.proofId) && trust.allowedEngineDigests.includes(proof.engineDigest) && proof.verifierVersion === trust.verifierVersion &&
      !proof.needsReview && !proof.reviewHold && !proof.excluded && !proof.held && !proof.rejected,
    'Independent approved native proof required');
    binding(proof.binding);demand(sameBinding(receipt.binding, proof.binding), 'Native proof binding differs');
    const row = {accountId: vote.accountId, canonicalTrackId: vote.canonicalTrackId, quality: vote.quality,
      difficulty: vote.difficulty, receiptId: receipt.receiptId, issuedAt: receipt.issuedAt, proofId: proof.proofId};
    const key = row.accountId + ':' + row.canonicalTrackId, previous = accepted.get(key);
    if (previous && previous.receiptId === row.receiptId) {
      demand(JSON.stringify(previous) === JSON.stringify(row), 'Conflicting repeated receipt');continue;
    }
    demand(!previous || previous.issuedAt !== row.issuedAt, 'Conflicting player votes require review');
    if (!previous || row.issuedAt > previous.issuedAt) accepted.set(key, row);
  }
  return [...accepted.values()].sort((a, b) => compare(a.canonicalTrackId, b.canonicalTrackId) || compare(a.accountId, b.accountId));
}

function summarize(rows) {
  const mean = field => {const scores = rows.map(row => row[field]).filter(score);
    return {value: scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : null, count: scores.length};};
  return {quality: mean('quality'), difficulty: mean('difficulty')};
}
export function summarizeBuilderRatings(data, opinions = {}, trust = {}) {
  shape(opinions, [], ['editorialScores', 'playerVotes']);
  const ledger = validateReviewedCredits(data);
  const editorial = validateEditorialScores(opinions.editorialScores ?? [], ledger);
  const players = validatePlayerVotes(opinions.playerVotes ?? [], ledger, trust);
  return [...new Set(ledger.credits.map(row => row.canonicalTrackId))].sort().map(canonicalTrackId => ({canonicalTrackId,
    editorial: summarize(editorial.filter(row => row.canonicalTrackId === canonicalTrackId)),
    players: summarize(players.filter(row => row.canonicalTrackId === canonicalTrackId))}));
}
