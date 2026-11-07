// BEGIN GENERATED RELEASE HISTORY
const historyData = {
  "schemaVersion": 1,
  "current": {
    "number": 307,
    "version": "0.6.3",
    "revision": 264,
    "notes": [
      "Fixed route planning for profiles that were only partly loaded.",
      "Kodub weekly leaderboards now show published Event RP alongside the right run."
    ]
  },
  "entries": [
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
    },
    {
      "number": 297,
      "title": "Harden snapshot recovery and prepare exact replay repairs",
      "commit": "999777064f2b9ab1c24c1c307bef0ac810e2dc5c",
      "committedAt": "2026-11-06T02:47:24.000Z",
      "notes": [
        "Snapshot updates keep recovered replay files instead of downloading them again.",
        "Incomplete replay data can no longer slip through the publication checks.",
        "Interrupted snapshot work now keeps safer recovery checkpoints."
      ]
    },
    {
      "number": 295,
      "title": "Stop duplicate cloud work and reuse captured replay data",
      "commit": "73e745f0f9fe38664be35dad781f84d32f71fca5",
      "committedAt": "2026-11-05T23:03:35.000Z",
      "notes": [
        "Fixed repeated cosmetic uploads when device storage is full.",
        "Duplicate PB submissions now share their upload work.",
        "Snapshot updates reuse more existing replay and leaderboard data."
      ]
    },
    {
      "number": 294,
      "title": "Reduce cloud rebuild reads and prepare guarded local snapshots",
      "commit": "375e2b0309dc2283dcd1ed94e63196ca26b3fc25",
      "committedAt": "2026-11-05T22:27:17.000Z",
      "notes": [
        "Busy leaderboards update in batches without unnecessary restarts.",
        "Ranking updates reuse unchanged track data.",
        "Safer replay checks and automatic ranking updates."
      ]
    },
    {
      "number": 293,
      "title": "Avoid repeated leaderboard rebuilds and share cloud work budgets",
      "commit": "5fd47ac0f63176e4cfcc513bb47ac16904642897",
      "committedAt": "2026-11-05T20:41:30.000Z",
      "notes": [
        "Smoother leaderboard updates while racers change their look.",
        "Racer Studio skips outdated drafts when you make another change.",
        "More efficient automatic ranking updates."
      ]
    },
    {
      "number": 292,
      "title": "Require complete replay files and preserve bounded capture recovery",
      "commit": "f1e88968f013b2adfa411cafce762f21ff5eee80",
      "committedAt": "2026-11-05T19:01:17.000Z",
      "notes": [
        "Ranking updates now check that every listed run has its replay.",
        "Safer automatic ranking updates and recovery."
      ]
    },
    {
      "number": 291,
      "title": "Publish verified Snapshot 72 and restore reader browser checks",
      "commit": "7972090350b6fc211bbef006a9ccd8a27b6ff22e",
      "committedAt": "2026-11-05T17:22:10.000Z",
      "notes": [
        "Updated saved rankings with 103 more replay checks.",
        "Current Kodub event standings now include 20 verified racers."
      ]
    },
    {
      "number": 290,
      "title": "Admit proven event runs from captured empty live standings",
      "commit": "a9e2607cc1fcc0b686350b973e503608a4d10239",
      "committedAt": "2026-11-05T16:41:49.000Z",
      "notes": [
        "Verified event runs can appear before an event's first server publication.",
        "Partial standings and runs without replay proof stay protected."
      ]
    },
    {
      "number": 289,
      "title": "Scope trusted replay assets to each native verification batch",
      "commit": "28abdd5d4f13dba87594356d2bd0b249ba9faf42",
      "committedAt": "2026-11-05T16:03:19.000Z",
      "notes": [
        "Fixed replay checks failing when a batch included different tracks.",
        "Track files stay consistent across Windows and hosted updates."
      ]
    },
    {
      "number": 288,
      "title": "Defer missing canonical replays without blocking valid snapshot checks",
      "commit": "9e4a378891e1e39f9606f5add515b12b2e67eeb9",
      "committedAt": "2026-11-05T15:37:45.000Z",
      "notes": [
        "Missing replay files no longer block checks of available saved runs.",
        "Runs without replay evidence stay unverified."
      ]
    },
    {
      "number": 287,
      "title": "Align capture preflight contracts with encrypted recovery",
      "commit": "92e16c1c9ea818b4e0c58f0319c40558a6167a4d",
      "committedAt": "2026-11-05T15:14:09.000Z",
      "notes": [
        "Snapshot update checks now cover the encrypted recovery path.",
        "Existing saved results remain in place if an update cannot finish."
      ]
    },
    {
      "number": 286,
      "title": "Preserve encrypted capture recovery with a smaller retry budget",
      "commit": "9aadac9dfaa66c09502c04cb30b4623aad11b890",
      "committedAt": "2026-11-05T14:59:00.000Z",
      "notes": [
        "Snapshot updates can recover saved replay data if processing is interrupted.",
        "The replacement update uses a smaller replay-fetch budget."
      ]
    },
    {
      "number": 285,
      "title": "Retire stale canonical replay inputs without weakening native checks",
      "commit": "a711fba99e0d4cd44455f0c21bf37369f02755a0",
      "committedAt": "2026-11-05T14:13:38.000Z",
      "notes": [
        "Snapshot updates handle changed PB replay data more safely.",
        "Unavailable replays stay unverified instead of blocking valid saved results."
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
