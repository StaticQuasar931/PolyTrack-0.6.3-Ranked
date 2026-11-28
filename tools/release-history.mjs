// BEGIN GENERATED RELEASE HISTORY
const historyData = {
  "schemaVersion": 1,
  "current": {
    "number": 503,
    "version": "0.6.3",
    "revision": 420,
    "notes": [
      "Ranked replay verification uses its reviewed engine, independently of the game renderer. The live standings are unchanged."
    ]
  },
  "entries": [
    {
      "number": 502,
      "title": "Ranked snapshot workflow repairs",
      "commit": "8ed13f524021274a83e2bf726610e90be0df82ad",
      "committedAt": "2026-11-28T09:14:30.000Z",
      "notes": [
        "Maintenance update for ranked snapshot publishing and replay verification."
      ]
    },
    {
      "number": null,
      "title": "Keep regression coverage for pending canonical retention",
      "commit": "be6cfb6348f15abc727d7cf5bb8fbf9cc58479ee",
      "committedAt": "2026-11-28T09:09:18.000Z",
      "notes": []
    },
    {
      "number": null,
      "title": "Keep exact canonical pending results without granting proof",
      "commit": "189896b88aef8f7899e7a04b8cef3883f5e4ce8c",
      "committedAt": "2026-11-28T09:06:08.000Z",
      "notes": []
    },
    {
      "number": null,
      "title": "Pin the offline engine independently of the released renderer",
      "commit": "e5810811112fbfceee412f620bf7354f5f052087",
      "committedAt": "2026-11-28T08:49:42.000Z",
      "notes": []
    },
    {
      "number": 498,
      "title": "Polish Extra Tracks browsing",
      "commit": "599b0056f841e3f0b5004a2d78e6d7b1c98e4b4b",
      "committedAt": "2026-11-28T05:46:25.000Z",
      "notes": [
        "Builder Program now opens in a centered popup and returns focus to More when dismissed.",
        "Random and Quick Pick sit together, and Export My Picks is easier to spot.",
        "Featured Picks show a compact track card with a square preview."
      ]
    },
    {
      "number": 496,
      "title": "Center the first-launch update notice",
      "commit": "27a71624a058cc403d77dd76e8b345f7c5dce183",
      "committedAt": "2026-11-28T00:49:26.000Z",
      "notes": [
        "Release notes appear centered on first launch while the game starts in the background.",
        "Dismiss the notice once to skip it until the next release."
      ]
    },
    {
      "number": 495,
      "title": "Speed up game startup and add save-safe Retry",
      "commit": "253815215438f4c5abd9d18e0507b7e9a9656f2e",
      "committedAt": "2026-11-28T00:34:00.000Z",
      "notes": [
        "The game reaches Play faster on startup and refresh.",
        "The installed update notice no longer blocks the game.",
        "GitHub Pages offers a save-safe Retry if a startup script fails. Google Sites may require reloading the page."
      ]
    },
    {
      "number": 492,
      "title": "Restore time at rank",
      "commit": "8b51f8deb8f6c18235b32ec6986d769083eca7b7",
      "committedAt": "2026-11-25T22:52:32.000Z",
      "notes": [
        "Overall Rankings shows how long a racer has held their saved position again.",
        "Top % keeps last-place finishes below other ranked results and shows shorter percentages."
      ]
    },
    {
      "number": 491,
      "title": "Align Track Breakdown on tablets",
      "commit": "d6de1dcfacb4b14bc636d615dae3fc00b7c1ebbd",
      "committedAt": "2026-11-25T22:39:00.000Z",
      "notes": [
        "Track Breakdown keeps all six sorting options in one row and aligns results on tablets and Chromebooks."
      ]
    },
    {
      "number": 490,
      "title": "Verify saved replays by track",
      "commit": "7b5eec80a8ba1b134d68f690a82346b89ece7ea5",
      "committedAt": "2026-11-25T22:35:28.000Z",
      "notes": [
        "Sort profile results by Top % from the same row as the other sort options.",
        "Active playtime now shows a shorter hover label with the total in hours.",
        "Replay verification can continue when a different track reaches its comparison limit."
      ]
    },
    {
      "number": 488,
      "title": "Refresh ranked leaderboards",
      "commit": "8a0aae434a347bc8d550ecb9298b92f6082917a8",
      "committedAt": "2026-11-24T10:36:18.000Z",
      "notes": [
        "Ranked leaderboards now include newly saved race times.",
        "Corrected Rolling Hills Racer event standings so verified Event RP matches the replay."
      ]
    },
    {
      "number": null,
      "title": "Sync public ranked snapshots",
      "commit": "4b70447e285d20ab7b2651b172dba981eeed2e52",
      "committedAt": "2026-11-24T10:29:00.000Z",
      "notes": []
    },
    {
      "number": 486,
      "title": "Find and open tracks by keyboard",
      "commit": "f5e4c5a0cd27d2bbe923a3d4045b7d98c3ff79dc",
      "committedAt": "2026-11-24T06:23:36.000Z",
      "notes": [
        "Find Community Tracks by typing a name or RHR, then press Enter. Use 1-9 to open a track, ? to pick from this list, or ! to pick from all loaded tracks.",
        "Switch Community versions with Shift+Left or Shift+Right. Discovery has a quick keyboard tutorial."
      ]
    },
    {
      "number": 485,
      "title": "Sort track results by Top %",
      "commit": "118a8ad2f8384d6264f8bce8af12c3a74feb29c0",
      "committedAt": "2026-11-24T06:04:46.000Z",
      "notes": [
        "Sort Track Breakdown by Top % to compare your best finishes across fields of different sizes."
      ]
    },
    {
      "number": 484,
      "title": "Improve landscape rankings and track previews",
      "commit": "9ece953e8a3d77456f736919499bac491e9abcbb",
      "committedAt": "2026-11-24T05:25:21.000Z",
      "notes": [
        "Rankings show more rows in landscape. The More button on compact rankings now explains what it opens to screen readers.",
        "Track previews can warm again after a temporary failure, without hammering the connection."
      ]
    },
    {
      "number": 483,
      "title": "Preserve event standings during normal replay verification",
      "commit": "f417384c5cd3a45512d803a5ce78659ae21a425e",
      "committedAt": "2026-11-24T05:14:39.000Z",
      "notes": [
        "Improved Summer One replay verification so it can update without changing other event standings."
      ]
    },
    {
      "number": 481,
      "title": "Show your saved Workshop styles immediately",
      "commit": "f88a0d1c8cca6157140f92d713490eba5a3ad244",
      "committedAt": "2026-11-23T01:57:56.000Z",
      "notes": [
        "Your saved Workshop changes show up on your car previews right away, even before the next rankings update."
      ]
    },
    {
      "number": 480,
      "title": "Show saved Workshop styles on ranked car previews",
      "commit": "8cdc65135a71f217e01d0bae5b612ae544f83e40",
      "committedAt": "2026-11-23T01:40:56.000Z",
      "notes": [
        "Save your Workshop setup to show it on your car in Ranked Racers and racer profiles after the next snapshot."
      ]
    },
    {
      "number": 479,
      "title": "Fix Achievements and Style Shop loading",
      "commit": "b28723eb581f74f07378e41e21e6b2cb6f1d7eab",
      "committedAt": "2026-11-23T01:09:50.000Z",
      "notes": [
        "Fixed Achievements and the Style Shop not opening after an update.",
        "Paid styles in Racer Studio now open their exact Shop listing. The live preview leaves more room for your racer details."
      ]
    },
    {
      "number": 478,
      "title": "Expand achievements and the Style Shop",
      "commit": "03ef3fa07b6fc022caf8652743fc33b733604677",
      "committedAt": "2026-11-23T00:53:15.000Z",
      "notes": [
        "Achievements now show 44 tiers, including new rewards for Ranked Extra finishes, personal bests, and verified wins. The Style Shop has eight new items, and live previews have more room."
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
