// BEGIN GENERATED RELEASE HISTORY
const historyData = {
  "schemaVersion": 1,
  "current": {
    "number": 372,
    "version": "0.6.3",
    "revision": 316,
    "notes": [
      "Locked cosmetic previews now keep their preview-only warning and Exit preview button visible.",
      "Keyboard focus returns to your selected item when you exit a preview."
    ]
  },
  "entries": [
    {
      "number": 371,
      "title": "Racer hub, local friends and Field RP routes",
      "commit": "3e6888ba97990fdbba6712e6fe737fb57fe9f5f7",
      "committedAt": "2026-11-14T06:55:14.000Z",
      "notes": [
        "Achievements and Racer Studio share a full-screen hub, with more goals and locked-item previews.",
        "Save local friends and find friendly PB challenges using saved snapshot data.",
        "Field RP now includes track contributions and next-move advice. Profiles have clearer track filters and counts.",
        "Right-click Update available to snooze reminders. Extra Tracks picks and menus are clearer."
      ]
    },
    {
      "number": 370,
      "title": "Achievements, track discovery and full snapshot preparation",
      "commit": "7cd4e5a09305f777f09b2f0aa99dabf21e2c416a",
      "committedAt": "2026-11-14T05:29:57.000Z",
      "notes": [
        "Explore Achievements to find your next cosmetic unlock, with a clearer Racer Studio.",
        "Extra Tracks has simpler controls, featured picks and easier random-track filters.",
        "Help checks for updates when opened. Event badges and track menus are more consistent.",
        "Try Field RP, an experimental ranking where busier tracks count more, and filter Average place by track type."
      ]
    },
    {
      "number": null,
      "title": "Polish achievements, track discovery and rankings; prepare bounded full catch-up",
      "commit": "4e9327c1bd70c1c7ab300c79dc8563d64f7178f5",
      "committedAt": "2026-11-14T05:28:48.000Z",
      "notes": []
    },
    {
      "number": 368,
      "title": "Complete compact snapshot recovery contract coverage",
      "commit": "27bea27ccee08fcfe98e471dd767c6a570089e98",
      "committedAt": "2026-11-14T04:03:21.000Z",
      "notes": [
        "Completes snapshot recovery checks while keeping saved replay files and retry history intact."
      ]
    },
    {
      "number": 367,
      "title": "Complete driving-state deployment regression coverage",
      "commit": "3446f00081658adcfa1489800d5aa91d81774449",
      "committedAt": "2026-11-14T03:53:42.000Z",
      "notes": [
        "Improves checks used before publishing updates and preparing overnight snapshots."
      ]
    },
    {
      "number": 366,
      "title": "Coalesce PB uploads, add random previews and prepare local capture",
      "commit": "aafbb59833b3884ee94577cfe96a2a9326955c74",
      "committedAt": "2026-11-14T03:46:23.000Z",
      "notes": [
        "Saves repeated personal-best improvements locally while driving, then uploads your best when you leave the track.",
        "Adds random Extra Track previews with saved filters and right-click quick picking.",
        "Fixes oversized snapshot progress files and local capture sign-in timing."
      ]
    },
    {
      "number": 365,
      "title": "Reconcile cached boards with exact existing canonical replay proofs",
      "commit": "fbe8ad03abc7aef2d2d95a4e573c03ab30c8d3c3",
      "committedAt": "2026-11-12T09:33:22.000Z",
      "notes": [
        "Improves snapshot recovery when cached leaderboards are behind, without dropping confirmed saved results."
      ]
    },
    {
      "number": 364,
      "title": "Fix event proof display and preserve legacy capture budgets",
      "commit": "e4c454b38c7e748d18b35de2643ecee73913197f",
      "committedAt": "2026-11-12T09:02:50.000Z",
      "notes": [
        "Fixes event badges hidden by an older display flag after successful replay checks.",
        "Fixes a hosted snapshot compatibility check."
      ]
    },
    {
      "number": 363,
      "title": "Recheck stale snapshot sources without dropping saved racers",
      "commit": "c296b7a618a3e1f4bfd334787bd2747932dbfe1e",
      "committedAt": "2026-11-12T08:53:30.000Z",
      "notes": [
        "Improves snapshot updates without dropping saved racers."
      ]
    },
    {
      "number": 362,
      "title": "Refresh verified flags by snapshot generation and show event place totals",
      "commit": "87710c959c10455de64d6927b71bce1350580c4f",
      "committedAt": "2026-11-12T08:37:07.000Z",
      "notes": [
        "Verified-only leaderboards refresh after replay checks, including on devices with older cached results.",
        "Weekly and daily track cards show your place as 1/255 when the full field is known."
      ]
    },
    {
      "number": 361,
      "title": "Restore hosted snapshot integrity checks for paged boards",
      "commit": "1b98a0a2e3c13bce86869067a7a0ed78346fa91f",
      "committedAt": "2026-11-12T08:14:37.000Z",
      "notes": [
        "Restores hosted snapshot checks for the optimized leaderboard format."
      ]
    },
    {
      "number": 360,
      "title": "Publish 6451 verified replays and refreshed standings",
      "commit": "8de02a4a75b239bb3eeb46e2301099cb296d14ca",
      "committedAt": "2026-11-12T07:48:36.000Z",
      "notes": [
        "6,451 more saved runs now have verified replays.",
        "Leaderboards, rankings and racer profiles reflect the newly verified results."
      ]
    },
    {
      "number": 359,
      "title": "Compact ranking inputs without dropping verified results",
      "commit": "b0844d9e5761698011acf70b4a40ef3a56259e86",
      "committedAt": "2026-11-12T07:26:36.000Z",
      "notes": [
        "Improves local ranking estimates for larger verified leaderboards."
      ]
    },
    {
      "number": 358,
      "title": "Show update notes during loading and expand replay review capacity",
      "commit": "438f79dd457a190d483051dfe751ad32c3f9a856",
      "committedAt": "2026-11-09T08:34:47.000Z",
      "notes": [
        "Update notes appear during loading, even on fast or cached starts.",
        "Improves replay-review capacity for growing leaderboards."
      ]
    },
    {
      "number": 357,
      "title": "Finish large leaderboard updates and reduce redundant verification",
      "commit": "f7415f77481937697a809b7d1d59e1e76dfe2d1a",
      "committedAt": "2026-11-09T07:58:05.000Z",
      "notes": [
        "Large leaderboard updates can finish without restarting.",
        "Reduces redundant cloud verification work."
      ]
    },
    {
      "number": 356,
      "title": "Restore missing racers and verify 1024 more runs",
      "commit": "b530a931c5c74f78f17dfaa4a4352406317dd95e",
      "committedAt": "2026-11-09T07:48:01.000Z",
      "notes": [
        "Restored missing racers in the rankings, including the full Summer 1 field.",
        "Added 1,024 newly verified runs while keeping previously verified results and replay checks."
      ]
    },
    {
      "number": 355,
      "title": "Stream replay review within bounded track memory",
      "commit": "200f9da37696b9be214c9477938deb769ca52aa8",
      "committedAt": "2026-11-09T06:32:09.000Z",
      "notes": [
        "Replay verification can handle larger snapshots without keeping every replay in memory.",
        "Existing replay, clone-review and safety checks remain in place."
      ]
    },
    {
      "number": 354,
      "title": "Preserve racer coverage and streamline offline checks",
      "commit": "1b0809f74590e1b174f53a955015ca1983535bb6",
      "committedAt": "2026-11-09T05:59:46.000Z",
      "notes": [
        "Safer snapshot updates check that known racers have not disappeared.",
        "Replay checks reuse track evidence more efficiently without skipping verification."
      ]
    },
    {
      "number": 353,
      "title": "Show update notes while the game loads",
      "commit": "59321d1a4b7631ce2483fefdad5739844d30e64e",
      "committedAt": "2026-11-09T05:50:59.000Z",
      "notes": [
        "Read update notes while the game loads, instead of waiting for the main menu.",
        "Update notes stay out of the way during races."
      ]
    },
    {
      "number": 352,
      "title": "Keep downloaded rankings out of save storage",
      "commit": "1b98d649dfc7734536e4ea29b317ee2b5b940692",
      "committedAt": "2026-11-09T05:15:51.000Z",
      "notes": [
        "More room for saves: downloaded rankings now use separate local cache storage.",
        "Keeps personal saves, replays and older-version save formats unchanged."
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
