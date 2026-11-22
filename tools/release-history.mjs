// BEGIN GENERATED RELEASE HISTORY
const historyData = {
  "schemaVersion": 1,
  "current": {
    "number": 472,
    "version": "0.6.3",
    "revision": 400,
    "notes": [
      "Beat the Owner is now a challenge in the Style path. The goal details are shorter, and you can still open previews of eligible tracks."
    ]
  },
  "entries": [
    {
      "number": 471,
      "title": "Clarify snapshot updates and Workshop placement",
      "commit": "af594bb425c00cc081ade831bb225c6a04298a2d",
      "committedAt": "2026-11-22T23:43:34.000Z",
      "notes": [
        "The update button now pops into view, and snapshot notices tell you how many racers, tracks, and race times are new. Selecting Center or Flat rear for a sticker now turns the Workshop camera to that area."
      ]
    },
    {
      "number": 470,
      "title": "Show new results in snapshot updates",
      "commit": "ffa847fb09168dd377ea6d40f41538a77546686e",
      "committedAt": "2026-11-22T23:13:39.000Z",
      "notes": [
        "Snapshot notices show the new racers, track boards, and playable results since the previous snapshot."
      ]
    },
    {
      "number": 469,
      "title": "Announce new ranking snapshots in game",
      "commit": "318b85f721a635cfe51154702750dc30fe57b6d7",
      "committedAt": "2026-11-22T22:59:14.000Z",
      "notes": [
        "Ranking snapshots now have their own update screen with the racer, track board, and playable result counts."
      ]
    },
    {
      "number": 467,
      "title": "Restore published replays before ranking updates",
      "commit": "5a4700961193e431744d768436713e5b25deca31",
      "committedAt": "2026-11-22T22:30:33.000Z",
      "notes": [
        "Rankings keep playable results and no longer wait for new runs whose replay files are missing."
      ]
    },
    {
      "number": 466,
      "title": "Publish rankings while pending previews wait",
      "commit": "5cd0a7e2f6a7d992d18e402d39d33706acf75acd",
      "committedAt": "2026-11-22T22:10:08.000Z",
      "notes": [
        "New rankings can publish while unavailable replay previews wait for their own checks."
      ]
    },
    {
      "number": 465,
      "title": "Keep published ranking boards during refresh",
      "commit": "6b7a37372f6ec85f36351e7d0701fb089109fe43",
      "committedAt": "2026-11-22T21:43:55.000Z",
      "notes": [
        "Ranking updates keep the last published track results visible while a newer board is being checked."
      ]
    },
    {
      "number": 464,
      "title": "Batch ranking snapshot reconciliation",
      "commit": "434f0cca7422723fe96e9d69f2af955635729347",
      "committedAt": "2026-11-22T21:30:13.000Z",
      "notes": [
        "Ranking snapshots can reconcile track results in batches, so changed replays take less time to process."
      ]
    },
    {
      "number": 463,
      "title": "Prioritize required boards for ranking updates",
      "commit": "ea9df45304641f0057ec34a20807a29116caf165",
      "committedAt": "2026-11-22T21:22:25.000Z",
      "notes": [
        "Rankings updates prioritize the track boards needed for Overall rankings."
      ]
    },
    {
      "number": 462,
      "title": "Keep saved Workshop styles on personal replays",
      "commit": "2dbf15c499575e2488485b70f0c81178716a93b7",
      "committedAt": "2026-11-22T21:11:00.000Z",
      "notes": [
        "Your saved Workshop paint and stickers now follow your car into personal replays, including older event replays."
      ]
    },
    {
      "number": null,
      "title": "Quarantine only changed recordings in routine snapshots",
      "commit": "34bdf455af31be91c6fe239c35f314b29f597495",
      "committedAt": "2026-11-22T21:10:19.000Z",
      "notes": []
    },
    {
      "number": null,
      "title": "Omit invalidated boards from routine snapshot publication",
      "commit": "be70049f3cc9015d37d039a4ca5e422e0e5e6106",
      "committedAt": "2026-11-22T20:59:24.000Z",
      "notes": []
    },
    {
      "number": null,
      "title": "Defer changed recordings without blocking snapshot capture",
      "commit": "12635079b96deee2611598acac81d6a39e63df41",
      "committedAt": "2026-11-22T20:48:11.000Z",
      "notes": []
    },
    {
      "number": 457,
      "title": "Refresh Kodub rollover and compact snapshot history",
      "commit": "b1d639c572cd6fb62e00235362c761576de69803",
      "committedAt": "2026-11-22T20:33:43.000Z",
      "notes": [
        "The Kodub weekly card can switch tracks and artwork without reloading, even before the static files catch up.",
        "Official and Community podium rankings show the actual top podium finishes in that scope."
      ]
    },
    {
      "number": 456,
      "title": "Bound manual canonical recovery reads",
      "commit": "8928058369578971e0722124c2a88ac04b3e1bdc",
      "committedAt": "2026-11-22T20:12:13.000Z",
      "notes": [
        "Manual snapshot recovery can reconcile more previously published runs without raising scheduled read limits."
      ]
    },
    {
      "number": 455,
      "title": "Preserve newer canonical leaderboard coverage",
      "commit": "c9652de45c8d9fbf374ae4ab3f43b9973b9f5717",
      "committedAt": "2026-11-22T20:03:28.000Z",
      "notes": [
        "A verified full-scan leaderboard is preserved when an older source only repeats part of it. Newer and changed results still go through the existing checks."
      ]
    },
    {
      "number": 454,
      "title": "Revalidate exact retained snapshot proofs",
      "commit": "3e4ed7a0df26608587a954d57ae6f5dd03b6f85f",
      "committedAt": "2026-11-22T19:51:59.000Z",
      "notes": [
        "Snapshot recovery can retain an older verified result when its exact current run and replay still match the approved proof."
      ]
    },
    {
      "number": 453,
      "title": "Compact event estimates and add Workshop sticker placements",
      "commit": "457607d815d59b9b6356b1260ae3d4e7397d5b46",
      "committedAt": "2026-11-22T19:44:09.000Z",
      "notes": [
        "Event score estimates now use a compact tilde, and estimated placements keep their color without the extra label.",
        "Garage Workshop adds Center and Flat rear sticker placements, and Standard top stickers are larger."
      ]
    },
    {
      "number": 452,
      "title": "Add verified Owner Challenge targets and rewards",
      "commit": "4663f7ab8b75e33626a604a1411925323c831ed7",
      "committedAt": "2026-11-22T04:43:38.000Z",
      "notes": [
        "Owner Challenge has four milestones, with new Workshop rewards at two and five verified tracks.",
        "Open an unfinished Owner Challenge goal for verified rival times and shortcuts to eligible track previews.",
        "Achievements separate earned cosmetic unlocks from Style Coins and keep completed milestones out of Next goals."
      ]
    },
    {
      "number": 451,
      "title": "Add Total RP plates and six Workshop styles",
      "commit": "7161a7781a4cd2cdd6cb1699c8d528d4059ab803",
      "committedAt": "2026-11-22T04:25:16.000Z",
      "notes": [
        "Fit a custom race number or a Total RP rank plate. Neon is brighter, and the hood, front, rear, and underside have improved sticker options.",
        "Find six new Workshop styles in the Shop and browse before syncing your wallet.",
        "Filter podium rankings by track type, find upcoming Achievement goals, and browse a cleaner Extra Tracks menu."
      ]
    },
    {
      "number": 450,
      "title": "Keep the Style Shop compatible across game versions",
      "commit": "df26f867c65737c64bc06d732cc4416618887383",
      "committedAt": "2026-11-22T03:45:22.000Z",
      "notes": [
        "Hazard Band and Vector Wing join the Style Shop. Older game tabs can still use the Shop before updating."
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

/** Only releases with real central notes count; gaps and capture commits do not. */
function publishedReleases(release, history) {
  const selected=selectReleaseHistory(release,history);
  if(!selected.matches)return null;
  const rows=[{number:release.number,commit:hash(release.commit)?release.commit:null,current:true},
    ...selected.entries.filter(entry=>positiveInteger(entry.number)&&finishedNotes(entry.notes))];
  return new Set(rows.map(row=>row.number)).size===rows.length?rows:null;
}
export function findAcknowledgedRelease(release,isAcknowledged,history=RELEASE_HISTORY) {
  const rows=publishedReleases(release,history);
  if(!rows||typeof isAcknowledged!=='function')return null;
  for(const row of rows){try{if(isAcknowledged(row.number)===true)return {number:row.number,commit:row.commit};}catch{}}
  return null;
}
export function missedReleaseUpdates(release,acknowledged,history=RELEASE_HISTORY) {
  const rows=publishedReleases(release,history),unknown={count:null,missedCommits:[],currentMissed:false,baseline:null};
  if(!rows||!positiveInteger(acknowledged?.number)||acknowledged.commit!=null&&!hash(acknowledged.commit))return unknown;
  const index=rows.findIndex(row=>row.number===acknowledged.number&&(!acknowledged.commit||row.commit===acknowledged.commit));
  if(index<0)return unknown; // Outside the public 20: do not guess totals or highlights.
  return {count:index,missedCommits:rows.slice(1,index).map(row=>row.commit),currentMissed:index>0,baseline:{number:rows[index].number,commit:rows[index].commit}};
}
/** Count recorded manual release identities, never subtract Git/revision numbers. */
export function countKnownUpdates(release,isAcknowledged,history=RELEASE_HISTORY) {
  return missedReleaseUpdates(release,findAcknowledgedRelease(release,isAcknowledged,history),history).count;
}
export function releaseArchiveTitle(entry) {
  const text=[entry.displayTitle,...(Array.isArray(entry.notes)?entry.notes:[]),entry.title].find(value=>typeof value==='string'&&value.trim());
  const compact=String(text||'Game improvements').replace(/\s+/g,' ').trim();
  const sentence=compact.split(/(?<=[.!?])\s+/)[0];
  return sentence.length<=88?sentence:sentence.slice(0,85).replace(/\s+\S*$/,'').trimEnd()+'...';
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
  const missed=missedReleaseUpdates(options.release,options.acknowledgedRelease,options.history);
  const missedSet=new Set(missed.missedCommits);
  return {...selected,missed,entries:selected.entries.map(entry => {
    const source = entry.committedAt ? 'committed' : 'prepared', timeLabel = source === 'committed' ? 'Committed' : 'Prepared';
    const now = options.now === undefined ? Date.now() : options.now;
    const time = releaseHistoryTime(entry.committedAt ?? entry.preparedAt, now, source);
    const ageLabel = Number.isFinite(now) && now >= Date.parse(time.dateTime) ? `${timeLabel} ${time.age}` : time.age;
    return {...entry,displayTitle:releaseArchiveTitle(entry),missed:missedSet.has(entry.commit),label:entry.number === null ? 'Recorded update' : `Update ${entry.number}`,timeLabel,time,ageLabel,originalTitle:'Original title: '+entry.title+'\n'+timeLabel+': '+time.local};
  })};
}
export function renderReleaseHistory(options = {}) {
  const model = archiveModel(options); if (!model) return '';
  return `<details class="release-history" data-release-history><summary>Earlier updates</summary><div class="release-history-body"><ol>${model.entries.map(entry => `<li><details data-release-history-entry${entry.missed?' data-release-missed="true" style="border-left:3px solid #7ee7ff;padding-left:10px"':''}><summary title="${escape(entry.originalTitle)}"><strong>${escape(entry.label)}</strong><span>${escape(entry.displayTitle)}</span>${entry.missed?'<small class="release-history-missed">New since you last checked</small>':''}<small>${escape(entry.ageLabel)}</small></summary><p class="release-history-date">${entry.timeLabel} <time datetime="${entry.time.dateTime}">${escape(entry.time.local)}</time></p>${entry.notes.length ? `<ul>${entry.notes.map(note => `<li>${escape(note)}</li>`).join('')}</ul>` : '<p>No recorded notes.</p>'}</details></li>`).join('')}</ol><button class="button" type="button" data-release-history-close>Close archive</button></div></details>`;
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
    const heading = make('summary',`${entry.label}: ${entry.displayTitle}`); heading.title=entry.originalTitle; Object.assign(heading.style,{cursor:'pointer',padding:'8px 0'});
    if(entry.missed){detail.setAttribute('data-release-missed','true');Object.assign(detail.style,{borderLeft:'3px solid #7ee7ff',paddingLeft:'10px'});heading.setAttribute('aria-label',entry.label+': '+entry.displayTitle+'. New since you last checked');}

    const when = make('time',`${entry.ageLabel} (${entry.time.local})`); when.setAttribute('datetime',entry.time.dateTime);
    Object.assign(when.style,{display:'block',fontSize:'18px',color:'#a7d5ff',overflowWrap:'anywhere'});
    detail.append(heading,when);
    if(entry.missed)detail.append(make('small','New since you last checked','release-history-missed'));
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
  let noteOverrides = {};
  try {
    noteOverrides = JSON.parse(readFileSync(resolve(root,'tools/release-note-overrides.json'),'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw Error('Could not load release-note overrides: '+error.message);
  }
  if (!noteOverrides || typeof noteOverrides !== 'object' || Array.isArray(noteOverrides) ||
      Object.entries(noteOverrides).some(([number, override]) => !/^[1-9]\d*$/.test(number) ||
        !override || typeof override !== 'object' || Array.isArray(override) ||
        typeof override.title !== 'string' || !override.title.trim() || override.title.length > 500 ||
        !finishedNotes(override.notes))) throw Error('Invalid release-note overrides.');
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
    const override = row.number === null ? null : noteOverrides[String(row.number)];
    return {number:row.number, title:override?.title ?? (row.number === null ? row.title : row.title.replace(/^\d+\s*[-:]\s*/,'')), commit:row.commit, committedAt:new Date(row.date).toISOString(), notes:override ? [...override.notes] : notes};
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
