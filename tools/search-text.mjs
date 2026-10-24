// Search-only aliases. Displayed names and saved track identities are unchanged.
export const TRACK_SEARCH_ALIASES = Object.freeze([
  Object.freeze(['B⛶XED IN', 'boxed in']),
  Object.freeze(['Nürburgring Nordschleife', 'nurburgring nordschleife', 'nuerburgring nordschleife']),
  Object.freeze(['AO9-race', 'a09 race']),
  Object.freeze(['AO5', 'a05']),
  Object.freeze(['AO4-acrobatic', 'a04 acrobatic']),
  Object.freeze(['AO3 Race', 'a03 race']),
  Object.freeze(['AO2', 'a02']),
  Object.freeze(['AO1 Race', 'a01 race']),
  Object.freeze(['丂卄卂尺Ҝ', 'shark']),
  Object.freeze(['VØłĐ', 'void', 'vold']),
  Object.freeze(['𐌀𐌕𐌋𐌀𐌍𐌕𐌉𐌔', 'atlantis']),
  Object.freeze(['ѕєαѕση', 'season']),
  Object.freeze(['Wintertide', 'winterrtibe'])
]);
export function normalizeSearchText(value) {
  return String(value??'').normalize('NFKD').replace(/\p{M}/gu,'')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g,'')
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
}
export function searchAliases(value) {
  const text=normalizeSearchText(value);
  return TRACK_SEARCH_ALIASES.find(group=>group.some(alias=>normalizeSearchText(alias)===text))||[];
}
export function searchMatches(query,...values) {
  const tokens=normalizeSearchText(query).split(' ').filter(Boolean);
  if(!tokens.length)return true;
  const text=values.flat(Infinity).filter(value=>value!=null).flatMap(value=>[value,...searchAliases(value)]).map(normalizeSearchText).join(' ');
  return tokens.every(token=>text.includes(token));
}
