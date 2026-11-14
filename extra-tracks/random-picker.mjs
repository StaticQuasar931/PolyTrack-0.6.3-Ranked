export const PICKER_PREFS_KEY = 'sq-extra-tracks:random-picker:v1';
const defaults = {pool:'catalog', level:'', difficulty:'', rating:'', localRating:'', played:'any', imported:'any'};
export function normalizePickerPrefs(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const result = {...defaults};
  for (const key of Object.keys(defaults)) {
    const choices = key === 'pool' ? ['catalog', 'filtered'] : ['played', 'imported'].includes(key) ? ['any', 'yes', 'no'] : ['', 'unknown', ...Array.from({length:10}, (_, i) => String(i+1))];
    if (Object.hasOwn(input, key) && choices.includes(input[key])) result[key] = input[key];
  }
  return result;
}
export function readPickerPrefs(storage, fallback = null) {
  try { const raw = storage?.getItem(PICKER_PREFS_KEY); return normalizePickerPrefs(typeof raw === 'string' && raw.length <= 1024 ? JSON.parse(raw) : fallback); }
  catch { return normalizePickerPrefs(fallback); }
}
export function savePickerPrefs(storage, value) {
  try { if (!storage?.setItem) return false; storage.setItem(PICKER_PREFS_KEY, JSON.stringify(normalizePickerPrefs(value))); return true; }
  catch { return false; }
}
const score = value => typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 10 ? value : null;
function matchesScore(value, filter, minimum = false) {
  const known = score(value);
  return !filter || (filter === 'unknown' ? known === null : known !== null && (minimum ? known >= Number(filter) : Math.round(known) === Number(filter)));
}
const scoreBest = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
export function eligibleRecords(records, prefs) {
  const p = normalizePickerPrefs(prefs);
  return records.filter(record => matchesScore(record.level, p.level) && matchesScore(record.published?.difficulty, p.difficulty)
    && matchesScore(record.published?.quality, p.rating, true) && matchesScore(record.rating, p.localRating)
    && (p.played === 'any' || record.finishKnown === true && (p.played === 'yes' ? scoreBest(record.best) : record.best === null))
    && (p.imported === 'any' || record.importKnown === true && record.loaded === (p.imported === 'yes')));
}
export function chooseUniform(records, random = Math.random) {
  if (!records.length) return null;
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) throw new RangeError('Random value must be in [0, 1)');
  return records[Math.floor(value * records.length)];
}
