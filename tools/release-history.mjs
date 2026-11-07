// BEGIN GENERATED RELEASE HISTORY
const historyData = {
  "schemaVersion": 1,
  "current": {
    "number": 319,
    "version": "0.6.3",
    "revision": 267,
    "notes": [
      "Updated saved personal bests, rankings and profile data.",
      "Kept earlier event results paired with their saved replays.",
      "Some recent runs are still waiting for verification."
    ]
  },
  "entries": [
    {
      "number": 318,
      "title": "Refresh public ranked snapshot with captured PBs and profiles",
      "commit": "4f86fe80e81014534b467b6406f13d5cdcd81539",
      "committedAt": "2026-11-07T18:27:00.000Z",
      "notes": []
    },
    {
      "number": 317,
      "title": "Preserve exact pending replay files when retaining published event rows",
      "commit": "b08c81b0c79505235230f23d3375f107d26b6e6f",
      "committedAt": "2026-11-07T18:08:09.000Z",
      "notes": []
    },
    {
      "number": 316,
      "title": "Repair canonical board metadata and publish saved data without new verification",
      "commit": "e11d4db3592ecc1d5964948a98884cc7a158e3c2",
      "committedAt": "2026-11-07T17:51:52.000Z",
      "notes": []
    },
    {
      "number": 315,
      "title": "Resume saved full captures offline with exclusive verification guards",
      "commit": "6875804d5f0d5bf8f8b89db6c6e7cc6c394c46dd",
      "committedAt": "2026-11-07T17:08:44.000Z",
      "notes": []
    },
    {
      "number": 314,
      "title": "Support full catch-up encrypted recovery checkpoints",
      "commit": "f9011194f790d8b1789d8632a5d72c57ebdb72a8",
      "committedAt": "2026-11-07T10:13:36.000Z",
      "notes": []
    },
    {
      "number": 313,
      "title": "Recover complete captured PB pages without another database scan",
      "commit": "4f13ff93a261a8a0dd348660440a8adf55cbe401",
      "committedAt": "2026-11-07T09:51:38.000Z",
      "notes": []
    },
    {
      "number": 312,
      "title": "Prepare retained proofs from the pinned published baseline",
      "commit": "8b28442932979460aa7dc369501a7b4b3f88e745",
      "committedAt": "2026-11-07T09:15:54.000Z",
      "notes": []
    },
    {
      "number": 311,
      "title": "Reuse captured sources for approved full PB catch-up",
      "commit": "edadececd50f85dc8595edee0a90541ed1c03458",
      "committedAt": "2026-11-07T09:06:01.000Z",
      "notes": []
    },
    {
      "number": 310,
      "title": "Pace full captures within existing Worker safeguards",
      "commit": "d67fcc28564974a252265559b424cf467192e1ec",
      "committedAt": "2026-11-07T08:17:14.000Z",
      "notes": []
    },
    {
      "number": 309,
      "title": "Safely reconcile new PBs and recover brief package locks",
      "commit": "91d46dcedeb92c8a5a7ea84bb0fc7915a4548c8d",
      "committedAt": "2026-11-07T06:03:58.000Z",
      "notes": [
        "Improved snapshot recovery when a newer PB arrives before its cached replay.",
        "Kept earlier verification tied to the exact run it approved.",
        "Improved overnight update reliability."
      ]
    },
    {
      "number": 308,
      "title": "Reduce cloud rebuild costs and prepare complete snapshot capture",
      "commit": "ad6a5e63f12e1bb8fb81fa96a5c7472d93382b77",
      "committedAt": "2026-11-07T05:22:20.000Z",
      "notes": [
        "Improved cloud sync and reduced repeated work for saved runs.",
        "Improved snapshot update checks and kept event scores consistent."
      ]
    },
    {
      "number": 307,
      "title": "Fix profile route planning and Kodub Event RP display",
      "commit": "8c8d85fee1247c8e95dccf1d265a7d8d73de25d7",
      "committedAt": "2026-11-07T05:00:56.000Z",
      "notes": [
        "Fixed route planning for profiles that were only partly loaded.",
        "Kodub weekly leaderboards now show published Event RP alongside the right run."
      ]
    },
    {
      "number": 305,
      "title": "Compact snapshot lookup downloads without dropping replays",
      "commit": "34180c99103f0da28ffc616609eb8a45f0283e9b",
      "committedAt": "2026-11-06T14:42:15.000Z",
      "notes": [
        "Fresh snapshot downloads are smaller, with all saved replays retained.",
        "Improved profile and replay lookup loading."
      ]
    },
    {
      "number": 304,
      "title": "Publish refreshed Snapshot 74 with verified replay coverage",
      "commit": "5aba11535cc5040ecbfb7b84557f6d4969c555e8",
      "committedAt": "2026-11-06T14:21:14.000Z",
      "notes": [
        "Fresh rankings, profiles and event standings.",
        "New personal bests and saved replays are synchronized.",
        "Old archived finishes show when a replay is unavailable.",
        "Fixed safe playback of compact long recordings."
      ]
    },
    {
      "number": 303,
      "title": "Reconcile newer PBs and preserve coherent Event RP baselines",
      "commit": "efca578b6c331e544a79ab3f85b9f625d7e2c223",
      "committedAt": "2026-11-06T13:34:38.000Z",
      "notes": [
        "Fixed newer personal bests being paired with old snapshot times.",
        "Kept Event RP calculations consistent with published standings.",
        "Old archived finishes clearly show when a replay is unavailable."
      ]
    },
    {
      "number": 302,
      "title": "Prepare bounded snapshot catch-up with honest legacy replay labels",
      "commit": "01e51ba5ba4b5f969fcf817158a0872b4c680fe8",
      "committedAt": "2026-11-06T13:14:33.000Z",
      "notes": [
        "Refreshing saved rankings and event replays.",
        "Old archived finishes clearly show when a replay is unavailable."
      ]
    },
    {
      "number": 301,
      "title": "Restore Kodub native button bounce",
      "commit": "5859d5c1a20ec130ec7b8d889e303007cf409ddf",
      "committedAt": "2026-11-06T06:26:16.000Z",
      "notes": [
        "Restored Kodub's original bouncy button entrance.",
        "Kept the synchronized Ranked button timing."
      ]
    },
    {
      "number": 300,
      "title": "Synchronize home button entrances and remove delayed Ranked reveal",
      "commit": "2e46b3df40199c5192a1eb8cdd1ccd832f0c12d3",
      "committedAt": "2026-11-06T05:36:32.000Z",
      "notes": [
        "Fixed the Ranked button appearing late when returning to the menu.",
        "Home buttons now follow the same entrance timing."
      ]
    },
    {
      "number": 299,
      "title": "Fix delayed update notices and bound blocked profile retries",
      "commit": "66a547ac30f5a60bf3da5137c82bf289b31e2b4d",
      "committedAt": "2026-11-06T05:07:06.000Z",
      "notes": [
        "Update alerts appear sooner when you return to a menu.",
        "Clearer snapshot status and navigation labels.",
        "Improved weekly-track thumbnail layout.",
        "Fixed profile updates getting stuck behind other updates."
      ]
    },
    {
      "number": 298,
      "title": "Reduce obsolete profile reads and align owned cloud access",
      "commit": "58ccdc1c357d0bd7a2ac9e9c188f1a25f8cb0c7e",
      "committedAt": "2026-11-06T03:56:37.000Z",
      "notes": [
        "Improved cloud compatibility across supported Google Sites embeds.",
        "Reduced repeat profile-update work.",
        "Added privacy-safe connection counters to help diagnose upload problems.",
        "Unofficial copies using this update keep saves local."
      ]
    }
  ],
  "coverage": {
    "limit": 20,
    "olderOmitted": true
  }
};
// END GENERATED RELEASE HISTORY

const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const hash = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const finishedNotes = notes => Array.isArray(notes) && notes.length > 0 && notes.length <= 20 &&
  notes.every(note => typeof note === 'string' && note.trim() && note.length <= 2000 && !/\b(?:TODO|TBD|placeholder)\b/i.test(note));
function freezeHistory(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object' && !Object.isFrozen(child)) freezeHistory(child);
  return Object.freeze(value);
}
export const RELEASE_HISTORY = freezeHistory(historyData);

function canonicalTime(value) {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time > 0 && new Date(time).toISOString() === value ? time : null;
}
function currentReference(info) {
  if (!positiveInteger(info?.number) || !positiveInteger(info?.revision) || typeof info.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(info.version) || !finishedNotes(info.notes)) throw Error('Current release needs real central identities and finished notes.');
  return {number:info.number, version:info.version, revision:info.revision, notes:[...info.notes]};
}
export function selectReleaseHistory(release, history = RELEASE_HISTORY) {
  let current;
  try { current = currentReference(release); } catch { return {matches:false, entries:[], olderOmitted:false}; }
  const valid = history?.schemaVersion === 1 && JSON.stringify(history.current) === JSON.stringify(current) &&
    Array.isArray(history.entries) && history.entries.length <= 20 && history.coverage &&
    Number.isSafeInteger(history.coverage.limit) && history.coverage.limit >= 1 && history.coverage.limit <= 20 &&
    typeof history.coverage.olderOmitted === 'boolean' && history.entries.length <= history.coverage.limit && history.entries.every(entry => hash(entry?.commit) &&
      canonicalTime(entry.committedAt ?? entry.preparedAt) !== null && (entry.number === null || positiveInteger(entry.number)) &&
      typeof entry.title === 'string' && entry.title.length <= 500 && Array.isArray(entry.notes) &&
      (entry.notes.length === 0 || finishedNotes(entry.notes))) && new Set(history.entries.map(entry => entry.commit)).size === history.entries.length;
  return valid ? {matches:true, entries:history.entries, olderOmitted:history.coverage.olderOmitted} : {matches:false, entries:[], olderOmitted:false};
}

/** Count recorded manual commits, never differences between release numbers. */
export function countKnownUpdates(release, isAcknowledged, history = RELEASE_HISTORY) {
  const selected = selectReleaseHistory(release, history);
  if (!selected.matches || typeof isAcknowledged !== 'function') return null;
  const numbers = [release.number, ...selected.entries.map(entry => entry.number)].filter(positiveInteger);
  if (new Set(numbers).size !== numbers.length) return null; // Old acknowledgement keys cannot disambiguate repeated titles.
  for (const [index, entry] of [{number:release.number}, ...selected.entries].entries()) {
    if (!positiveInteger(entry.number)) continue;
    try { if (isAcknowledged(entry.number) === true) return index; } catch { /* Missing/blocked storage is not a first-play measurement. */ }
  }
  return null;
}
export function releaseHistoryTime(committedAt, now = Date.now(), source = 'committed') {
  const at = canonicalTime(committedAt);
  if (at === null) return {age:'Commit time unavailable', local:'', dateTime:''};
  const local = new Date(at).toLocaleString();
  if (!Number.isFinite(now)) return {age:source === 'prepared' ? 'Preparation time unavailable' : 'Commit time unavailable', local, dateTime:committedAt};
  if (now < at) return {age:`Device clock is before ${source === 'prepared' ? 'preparation' : 'commit'} time`, local, dateTime:committedAt};
  const elapsed = now - at, [unit, size] = elapsed >= 86400000 ? ['day',86400000] : elapsed >= 3600000 ? ['hour',3600000] : ['minute',60000];
  const count = Math.floor(elapsed / size);
  return {age:count ? `${count} ${unit}${count === 1 ? '' : 's'} ago` : 'Less than a minute ago', local, dateTime:committedAt};
}
function archiveModel(options) {
  const selected = selectReleaseHistory(options.release, options.history);
  if (!selected.matches || !selected.entries.length) return null;
  return {...selected, entries:selected.entries.map(entry => {
    const source = entry.committedAt ? 'committed' : 'prepared', timeLabel = source === 'committed' ? 'Committed' : 'Prepared';
    const now = options.now === undefined ? Date.now() : options.now;
    const time = releaseHistoryTime(entry.committedAt ?? entry.preparedAt, now, source);
    const ageLabel = Number.isFinite(now) && now >= Date.parse(time.dateTime) ? `${timeLabel} ${time.age}` : time.age;
    return {...entry, label:entry.number === null ? 'Recorded update' : `Update ${entry.number}`, timeLabel, time, ageLabel};
  })};
}
export function renderReleaseHistory(options = {}) {
  const model = archiveModel(options); if (!model) return '';
  return `<details class="release-history" data-release-history><summary>Earlier updates</summary><div class="release-history-body"><ol>${model.entries.map(entry => `<li><details data-release-history-entry><summary title="${escape(entry.timeLabel+': '+entry.time.local)}"><strong>${escape(entry.label)}</strong><span>${escape(entry.title)}</span><small>${escape(entry.ageLabel)}</small></summary><p class="release-history-date">${entry.timeLabel} <time datetime="${entry.time.dateTime}">${escape(entry.time.local)}</time></p>${entry.notes.length ? `<ul>${entry.notes.map(note => `<li>${escape(note)}</li>`).join('')}</ul>` : '<p>No recorded notes.</p>'}</details></li>`).join('')}</ol><button class="button" type="button" data-release-history-close>Close archive</button></div></details>`;
}

/** Native DOM version for the installed notice; no history fetch or HTML execution. */
export function createReleaseHistory(document, options = {}) {
  const model = archiveModel(options); if (!model) return null;
  const make = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
  const root = make('details', undefined, 'release-history'); root.setAttribute('data-release-history','');
  const summary = make('summary', 'Earlier updates'), body = make('div',undefined,'release-history-body');
  Object.assign(root.style,{margin:'12px 0', borderTop:'1px solid #6389bf', fontSize:'clamp(18px, 4dvh, 20px)'});
  Object.assign(summary.style,{cursor:'pointer', padding:'10px 0', color:'#a7d5ff'});
  const list = make('ol'); Object.assign(list.style,{listStyle:'none',padding:'0',margin:'8px 0',maxHeight:'min(42dvh, 360px)',overflow:'auto'});
  for (const entry of model.entries) {
    const item = make('li'), detail = make('details'); detail.setAttribute('data-release-history-entry','');
    const heading = make('summary',`${entry.label}: ${entry.title}`); heading.title = entry.timeLabel+': '+entry.time.local; Object.assign(heading.style,{cursor:'pointer',padding:'8px 0'});
    const when = make('time',`${entry.ageLabel} (${entry.time.local})`); when.setAttribute('datetime',entry.time.dateTime);
    Object.assign(when.style,{display:'block',fontSize:'18px',color:'#a7d5ff',overflowWrap:'anywhere'});
    detail.append(heading,when);
    if (entry.notes.length) { const notes = make('ul'); for (const note of entry.notes) notes.append(make('li',note)); detail.append(notes); }
    else detail.append(make('p','No recorded notes.'));
    item.append(detail); list.append(item);
  }
  const close = make('button','Close archive','button'); close.type = 'button'; close.setAttribute('data-release-history-close','');
  Object.assign(close.style,{minHeight:'44px',borderRadius:'0',clipPath:'polygon(8px 0, 100% 0, calc(100% - 8px) 100%, 0 100%)',border:'1px solid #6389bf',padding:'8px 12px',background:'var(--button-color, #112052)',color:'inherit',font:'inherit',cursor:'pointer'});
  body.append(list,close); root.append(summary,body); return root;
}
export function bindReleaseHistory(root) {
  if (!root) return {collapse:()=>false, dispose:()=>{}};
  const close = detail => { detail.open = false; detail.querySelector?.('summary')?.focus({preventScroll:true}); };
  const collapse = event => {
    if (event?.key !== 'Escape' || !root.open || !root.contains(event.target)) return false;
    const entry = event.target.closest?.('[data-release-history-entry]');
    close(entry?.open && root.contains(entry) ? entry : root);
    event.preventDefault(); event.stopPropagation(); return true;
  };
  const click = event => { if (event.target.closest?.('[data-release-history-close]') && root.contains(event.target)) { close(root); event.preventDefault(); } };
  root.addEventListener('click',click); root.addEventListener('keydown',collapse);
  return {collapse, dispose() { root.removeEventListener('click',click); root.removeEventListener('keydown',collapse); }};
}

/** Offline builder. Prior entries always come from committed Git objects; the
 * current central release is a separate reference, so pre/postcommit output agrees.
 */
export async function buildReleaseHistory({root, limit = 20, precommit = false, runGit, read} = {}) {
  const [{readFileSync}, {spawnSync}, {resolve}, {fileURLToPath}] = await Promise.all([import('node:fs'),import('node:child_process'),import('node:path'),import('node:url')]);
  root ||= fileURLToPath(new URL('../',import.meta.url));
  const git = runGit || ((...args) => { const result = spawnSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:16*1024*1024}); if (result.status !== 0) throw Error('Local history Git read failed: '+args.join(' ')); return result.stdout; });
  read ||= file => readFileSync(resolve(root,file),'utf8');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw Error('History limit must be between 1 and 20.');
  const parseInfo = text => { const match = /const releaseInfo = (\{[\s\S]*?\});/.exec(text); if (!match) throw Error('Missing central release info.'); return JSON.parse(match[1]); };
  const current = currentReference(parseInfo(read('tools/release-info.mjs')));
  const manual = git('log','--format=%H%x00%an%x00%ae%x00%s%x00%cI').trim().split('\n').filter(Boolean).map(line => {
    const [commit,name,email,title,date] = line.split('\0');
    const numberMatch = /^(\d+)\s*[-:]\s*\S/.exec(title || '');
    const number = numberMatch && positiveInteger(Number(numberMatch[1])) ? Number(numberMatch[1]) : null;
    return {commit,name,email,title,number,date};
  }).filter(row => !(row.name === 'github-actions[bot]' && row.email === '41898282+github-actions[bot]@users.noreply.github.com' && ['Sync public ranked snapshots','Sync Kodub weekly fallback'].includes(row.title)));
  if (!manual.length) throw Error('No real manual history found.');
  if (precommit) {
    const count = git('rev-list','--count','HEAD').trim();
    if (!/^[1-9]\d*$/.test(count) || !Number.isSafeInteger(Number(count)+1) || current.number !== Number(count)+1 || current.number === manual[0].number) throw Error('Precommit history requires the actual next Git commit number.');
  } else if (manual[0].number !== current.number) throw Error('Current central release does not match Git HEAD; finalize with --precommit before committing.');
  const earlier = precommit ? manual : manual.slice(1);
  const entries = earlier.slice(0,limit).map(row => {
    if (!hash(row.commit) || !Number.isFinite(Date.parse(row.date))) throw Error('Invalid committed Git history metadata.');
    let notes = [];
    if (git('ls-tree','--name-only',row.commit,'--','tools/release-info.mjs').trim()) {
      const info = parseInfo(git('show',row.commit+':tools/release-info.mjs'));
      if (info.number === row.number && finishedNotes(info.notes)) notes = [...info.notes];
    }
    return {number:row.number, title:row.number === null ? row.title : row.title.replace(/^\d+\s*[-:]\s*/,''), commit:row.commit, committedAt:new Date(row.date).toISOString(), notes};
  });
  return {schemaVersion:1,current,entries,coverage:{limit,olderOmitted:earlier.length>limit}};
}

export async function writeOrCheckReleaseHistory({write = false, ...options} = {}) {
  const [{readFileSync,writeFileSync}, {resolve}, {fileURLToPath}] = await Promise.all([import('node:fs'),import('node:path'),import('node:url')]);
  const root = options.root || fileURLToPath(new URL('../',import.meta.url));
  const value = await buildReleaseHistory({...options,root});
  const json = JSON.stringify(value,null,2)+'\n';
  const modulePath = resolve(root,'tools/release-history.mjs'), jsonPath = resolve(root,'tools/release-history.json');
  const source = readFileSync(modulePath,'utf8').replace(/\r\n?/g,'\n');
  const block = '// BEGIN GENERATED RELEASE HISTORY\nconst historyData = '+JSON.stringify(value,null,2)+';\n// END GENERATED RELEASE HISTORY';
  const next = source.replace(/\/\/ BEGIN GENERATED RELEASE HISTORY[\s\S]*?\/\/ END GENERATED RELEASE HISTORY/,()=>block);
  if (next === source && !source.includes(block)) throw Error('Missing generated history marker.');
  let existing; try { existing = readFileSync(jsonPath,'utf8').replace(/\r\n?/g,'\n'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (write) { if (source !== next) writeFileSync(modulePath,next); if (existing !== json) writeFileSync(jsonPath,json); }
  else if (source !== next || existing !== json) throw Error('Release history is stale. Run node tools/release-history.mjs --write'+(options.precommit?' --precommit':'')+' after finalizing central notes.');
  return value;
}
if (typeof process === 'object' && process.versions?.node && process.argv[1]) {
  const {pathToFileURL} = await import('node:url');
  if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
      const args = process.argv.slice(2);
      if (new Set(args).size !== args.length || args.some(arg => !['--write','--check','--precommit'].includes(arg)) || args.includes('--write') && args.includes('--check')) throw Error('Usage: node tools/release-history.mjs [--write|--check] [--precommit]');
      const history = await writeOrCheckReleaseHistory({write:args.includes('--write'),precommit:args.includes('--precommit')});
      console.log('Release history ready: '+history.entries.length+' earlier manual updates; current '+history.current.number+'.');
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
