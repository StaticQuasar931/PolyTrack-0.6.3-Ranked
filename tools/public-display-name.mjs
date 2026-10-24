// Display-only safety filter. It is not an account rename or a guarantee of
// moderation; server moderation and human review remain necessary.
import {moderatePublicName, normalizeNameForCheck} from '../workers/ranked/src/public-name-policy.js';

const PUBLIC_ROLE_TERMS = new Set(['admin','administrator','moderator','modteam','owner','staff','support','system','developer','devteam','dev','verified','official','helper','security','abuse']);

export function publicDisplayName(value) {
  if (typeof value !== 'string') return 'Racer';
  const name = value.normalize('NFKC').replace(/[<>\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 24);
  const folded = name.toLowerCase().replace(/[013457@$]/g, c => ({0:'o',1:'i',3:'e',4:'a',5:'s',7:'t','@':'a','$':'s'}[c]));
  const decision = moderatePublicName(name);
  const nonRoleContent = normalizeNameForCheck(name).split(' ').filter(term => !PUBLIC_ROLE_TERMS.has(term)).join(' ');
  const isRoleOnlyMatch = decision.match && PUBLIC_ROLE_TERMS.has(decision.match.term) && !moderatePublicName(nonRoleContent).blocked;
  if (!name || (decision.blocked && decision.reason !== 'reserved-name' && !isRoleOnlyMatch) || /(?:fuck|shit|nigg|faggot|porn|isass\b|master\s*of\s*baiting|raging\s*alcoholic|https?:|www\.)/i.test(folded)) return 'Racer';
  return name;
}
