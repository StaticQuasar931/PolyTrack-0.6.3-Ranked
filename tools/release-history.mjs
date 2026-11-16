// BEGIN GENERATED RELEASE HISTORY
const historyData = {
  "schemaVersion": 1,
  "current": {
    "number": 432,
    "version": "0.6.3",
    "revision": 370,
    "notes": [
      "Expanded saved-replay checks to help keep race results and leaderboards fair."
    ]
  },
  "entries": [
    {
      "number": 431,
      "title": "Add bounded two-engine offline verification option",
      "commit": "126a97c902f1c6ff0b6f015d7f7b33464d7c168b",
      "committedAt": "2026-11-16T10:43:32.000Z",
      "notes": [
        "Published more verified race results and added an optional two-at-a-time replay check for future verification runs."
      ]
    },
    {
      "number": 429,
      "title": "Reuse native replay validators and remove idle rendering",
      "commit": "0b93d557512180ae324b6a97f7506a8e5b6720df",
      "committedAt": "2026-11-16T10:19:58.000Z",
      "notes": [
        "Reduced repeated replay-verifier startup work while preserving exact physics checks and existing verified results."
      ]
    },
    {
      "number": 428,
      "title": "Speed up snapshot packaging and verification checkpoints",
      "commit": "c8c04331a3a8431467f74a84e401d5ae4d149058",
      "committedAt": "2026-11-16T09:30:50.000Z",
      "notes": [
        "Reduced snapshot preparation, packaging and verification checkpoint overhead while keeping replay checks unchanged."
      ]
    },
    {
      "number": 427,
      "title": "Simplify event points and verification tooltips",
      "commit": "3815ee4738be55222aa0212ce3b19efb21b92ebd",
      "committedAt": "2026-11-16T08:41:09.000Z",
      "notes": [
        "Simplified event verification tooltips: run date, verification status and ERP earned.",
        "Kept unverified ERP estimates clearly separate from awarded points."
      ]
    },
    {
      "number": 426,
      "title": "Align weekly details and keep Rolling Hills points in tooltips",
      "commit": "e8762bf6bb027f14566cf147dfc3a96265030aca",
      "committedAt": "2026-11-16T08:27:34.000Z",
      "notes": [
        "Left-aligned the Kodub weekly card and added breathing room between your time and placement.",
        "Rolling Hills verification tooltips now keep the run date, verification status and earned Event RP together."
      ]
    },
    {
      "number": 425,
      "title": "Restore the weekly card and extend offline verification",
      "commit": "1598fdd1bbde28c9496b6ff11ce7fb7c2241ad16",
      "committedAt": "2026-11-16T07:48:40.000Z",
      "notes": [
        "Restored the Kodub weekly card with a full uncropped image, larger countdown and clearer personal-best spacing.",
        "Made the Rolling Hills Racer reward and no-reset message easier to read."
      ]
    },
    {
      "number": 423,
      "title": "Fix live Kodub card spacing and title wrapping",
      "commit": "59228252ce017ea0b313354db1a23032781a8754",
      "committedAt": "2026-11-16T07:02:27.000Z",
      "notes": [
        "Fixed oversized gaps in the Kodub weekly card and improved title wrapping without resizing the artwork."
      ]
    },
    {
      "number": 422,
      "title": "Balance weekly card spacing without changing its size",
      "commit": "11beae7f971b486b6387314118da2586c54494d2",
      "committedAt": "2026-11-16T06:37:53.000Z",
      "notes": [
        "The Kodub weekly card has balanced spacing and clearer groups for track details, timing and rewards."
      ]
    },
    {
      "number": 421,
      "title": "Restore wider Kodub card and verify text fits",
      "commit": "4c13ab627886bae81aa696722743004506ec6648",
      "committedAt": "2026-11-16T06:12:34.000Z",
      "notes": [
        "Restored the wider Kodub weekly card so the title and event details have room to fit."
      ]
    },
    {
      "number": 420,
      "title": "Highlight recent movement and restore weekly card proportions",
      "commit": "fccb3dcd229ef0dd9647dfcc4d9778e3738b58d6",
      "committedAt": "2026-11-16T05:58:34.000Z",
      "notes": [
        "Recent rank movements stand out in color for 24 hours; rank duration stays small and gray.",
        "The Kodub weekly card uses its earlier width proportions without shrinking or cropping the artwork."
      ]
    },
    {
      "number": 419,
      "title": "Refine rank duration and restore event card layout",
      "commit": "227c2f5550f21af557b24ac987e2eded79db97ba",
      "committedAt": "2026-11-16T05:43:12.000Z",
      "notes": [
        "Rank time is smaller and clearer; movement arrows disappear after three days.",
        "Event cards restore Rolling Hills to the middle, improve weekly artwork spacing, and remove duplicate dividers."
      ]
    },
    {
      "number": 418,
      "title": "Keep installed update history consistent",
      "commit": "db12d95c493c58644c59f34680c98b42319a8b06",
      "committedAt": "2026-11-16T05:25:41.000Z",
      "notes": [
        "Update history now matches the installed game version."
      ]
    },
    {
      "number": null,
      "title": "Synchronize generated release-history module",
      "commit": "1bbcf1a9b6f7fb4a93186943c1a08c68f8186b5e",
      "committedAt": "2026-11-16T05:24:27.000Z",
      "notes": []
    },
    {
      "number": 416,
      "title": "Sync release archive and test native Garage startup readiness",
      "commit": "25342283b51390fa076d2b6cc88c592b5a48ba0b",
      "committedAt": "2026-11-16T05:23:09.000Z",
      "notes": [
        "Earlier update notes now stay in sync with the current release."
      ]
    },
    {
      "number": 415,
      "title": "Clarify rankings and event cards and preserve offline verification sources",
      "commit": "0d504b8072349ef8af7242cf8ab7ee0f03503dbd",
      "committedAt": "2026-11-16T05:21:58.000Z",
      "notes": [
        "Rankings now skip empty scores, use clearer rank-time labels, and make Field RP easier to read.",
        "Top Tracks adds a Non-official view for community and extra tracks.",
        "Event cards have clearer spacing and uncropped weekly artwork.",
        "New snapshot data can now appear through Update available."
      ]
    },
    {
      "number": 414,
      "title": "Enable reviewed Uplink replay verification and refresh weekly fallback",
      "commit": "5cc13313ac7c8e965ca25b7b1bd32cfe012644c0",
      "committedAt": "2026-11-16T04:44:50.000Z",
      "notes": [
        "The current Kodub weekly track is up to date and ready for replay verification."
      ]
    },
    {
      "number": 413,
      "title": "Fix saved verification targets and clarify rank duration",
      "commit": "6aad63fda0334db0c58e0b8bdf6f149f355753b8",
      "committedAt": "2026-11-16T04:33:49.000Z",
      "notes": [
        "Rank durations now say at rank, and replay verification prioritizes more visible results."
      ]
    },
    {
      "number": 411,
      "title": "Keep captured event observation times accurate",
      "commit": "e9008e8f6446550292bf95f8a49c141acd5d26f7",
      "committedAt": "2026-11-16T03:13:34.000Z",
      "notes": [
        "Event previews stay consistent when snapshot captures take longer."
      ]
    },
    {
      "number": 410,
      "title": "Preserve audited verification proofs after catalog updates",
      "commit": "bf565987d28a2862d740288dc4fb80b060bf51e7",
      "committedAt": "2026-11-16T02:59:07.000Z",
      "notes": [
        "Previously verified runs stay recognized after track catalog updates."
      ]
    },
    {
      "number": 409,
      "title": "Faster snapshot completion and extended offline verification",
      "commit": "7b820d1709ead569b18d5f0dc8d30c98117e5d40",
      "committedAt": "2026-11-16T01:56:19.000Z",
      "notes": [
        "Maintenance for verified leaderboards and event standings."
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
