// BEGIN GENERATED RELEASE HISTORY
const historyData = {
  "schemaVersion": 1,
  "current": {
    "number": 351,
    "version": "0.6.3",
    "revision": 295,
    "notes": [
      "Updated saved Summer 1 PBs and recovered completed replay checks.",
      "Keeps older event replay history when a faster run replaces it."
    ]
  },
  "entries": [
    {
      "number": 350,
      "title": "Validate event totals before offline verification",
      "commit": "ff08d4038764f82f279470cf4332c501d854a7c0",
      "committedAt": "2026-11-09T03:24:09.000Z",
      "notes": [
        "Snapshot updates keep the last published event totals when the cloud copy is older.",
        "Checks event data before replay verification to avoid wasted work."
      ]
    },
    {
      "number": 349,
      "title": "Review saved verification proofs before new physics jobs",
      "commit": "d25834479e3470f74b681361b5fcdd374bd51c0d",
      "committedAt": "2026-11-09T03:00:40.000Z",
      "notes": [
        "Verification checks saved records first so older approvals are not skipped.",
        "Saved progress can be rechecked without replaying runs again."
      ]
    },
    {
      "number": 348,
      "title": "Retain authenticated native boards across snapshot refreshes",
      "commit": "84ad291122462b55707f79f3aebddd5bab249e2d",
      "committedAt": "2026-11-09T02:35:05.000Z",
      "notes": [
        "Fixed snapshot refreshes discarding valid saved track boards.",
        "Reuses checked replay data without extra cloud reads."
      ]
    },
    {
      "number": 347,
      "title": "Align snapshot recovery artifact safety checks",
      "commit": "4a1a370c8f9b94bc4d4a79fd9560c588f08f56de",
      "committedAt": "2026-11-09T02:05:05.000Z",
      "notes": [
        "Updated snapshot safety checks for encrypted verification progress."
      ]
    },
    {
      "number": 346,
      "title": "Recognize terminated Linux fixture processes in snapshot tests",
      "commit": "c95b3915bc989dc7d56ef0d0afd5bcd3dd674984",
      "committedAt": "2026-11-09T01:59:42.000Z",
      "notes": [
        "Fixed Linux process checks blocking automatic snapshot updates."
      ]
    },
    {
      "number": 345,
      "title": "Fix Linux snapshot preflight process test",
      "commit": "e1476d6d93a731688e356f28d25c62afd8762cfb",
      "committedAt": "2026-11-09T01:55:05.000Z",
      "notes": [
        "Fixed a cross-platform test blocking automatic snapshot updates."
      ]
    },
    {
      "number": 344,
      "title": "Refine route estimates and verify captured replays offline",
      "commit": "6a5de3ad22306381afca4062ab551cfbea78ed04",
      "committedAt": "2026-11-09T01:50:11.000Z",
      "notes": [
        "More precise route comparisons and clearer local PB estimates.",
        "Snapshot updates now verify saved replays offline and keep recovery progress."
      ]
    },
    {
      "number": 343,
      "title": "Retry profile saves after schema compatibility repair",
      "commit": "67dd6683e5716c95fb0f74bf5929199588035940",
      "committedAt": "2026-11-09T01:26:01.000Z",
      "notes": [
        "Fixed cloud rules rejecting PBs and Studio saves on existing profiles.",
        "Removed misleading sign-in warnings and retry old blocked PBs once."
      ]
    },
    {
      "number": 342,
      "title": "Repair Studio defaults and saved PB notification recovery",
      "commit": "3bb77e252bd41c6a87692453c878210691d4589d",
      "committedAt": "2026-11-09T01:07:03.000Z",
      "notes": [
        "Fixed fresh-account Studio defaults and clearer design publishing messages.",
        "Saved PB notifications retry safely after a connection failure.",
        "Cloud sign-in recovery preserves your racer and local PBs."
      ]
    },
    {
      "number": 341,
      "title": "Build route plans from compact scoring snapshots",
      "commit": "cd4f3ad6f8a28ffd0d46d84acd4cd82251245f4a",
      "committedAt": "2026-11-09T00:29:35.000Z",
      "notes": [
        "Route plans use the full scoring snapshot without loading every leaderboard page.",
        "Clearer targets, better route sorting, and benefits that match your filters."
      ]
    },
    {
      "number": 340,
      "title": "Test fresh-account saves against deployed naming rules",
      "commit": "341bc54ebb9d6131c8b34663d518609ada3c22b2",
      "committedAt": "2026-11-08T23:44:56.000Z",
      "notes": [
        "Better release checks for fresh-account cloud saves."
      ]
    },
    {
      "number": 339,
      "title": "Speed cached standings and protect cloud sign-in recovery",
      "commit": "51ea2228cc2246af353f96a08a919315f198edcd",
      "committedAt": "2026-11-08T23:32:35.000Z",
      "notes": [
        "Faster cached track standings without flashing old names.",
        "Saves no longer wait for a leaderboard download.",
        "Clearer cloud-permission diagnostics and safer sign-in recovery handling."
      ]
    },
    {
      "number": 337,
      "title": "Polish medal tiles and next-podium targets",
      "commit": "ca8e2764c48c8a464ab40acc1fce369a6539f6db",
      "committedAt": "2026-11-08T23:04:00.000Z",
      "notes": [
        "Cleaner medal counts and next-podium targets below your car."
      ]
    },
    {
      "number": 336,
      "title": "Fix saved PB reconciliation and restore under-car podium cards",
      "commit": "bf840b8ff6d349c2139e4fb4536202c4c75e731f",
      "committedAt": "2026-11-08T22:40:54.000Z",
      "notes": [
        "Saved PB syncing handles confirmations and connection failures more reliably.",
        "Podium cards sit below your car again."
      ]
    },
    {
      "number": 335,
      "title": "Keep podium targets compact across screen sizes",
      "commit": "91e0ad24af5c5de2bd83eb8de86db48d733dce7d",
      "committedAt": "2026-11-08T07:24:19.000Z",
      "notes": [
        "Podium targets keep their compact layout on smaller screens."
      ]
    },
    {
      "number": 334,
      "title": "Repair route scoring and streamline event and practice controls",
      "commit": "5d504aeaceb159c9f3f01ed403e4c65baf20d045",
      "committedAt": "2026-11-08T07:20:37.000Z",
      "notes": [
        "Route plans now use complete saved scoring results.",
        "Event replays load when you choose Play or Watch.",
        "Clearer event points, compact practice suggestions and row-wide history details."
      ]
    },
    {
      "number": 333,
      "title": "Skip cleanup probes for successfully saved snapshot files",
      "commit": "fdd135c42094b62232e33b8a163add95274127cf",
      "committedAt": "2026-11-08T06:04:38.000Z",
      "notes": [
        "Large snapshot updates now skip unnecessary cleanup work."
      ]
    },
    {
      "number": 332,
      "title": "Preserve completed replay checks and streamline snapshot preparation",
      "commit": "13da4f48cb48ecf68527eb1b92f36c07513b627d",
      "committedAt": "2026-11-08T05:19:41.000Z",
      "notes": [
        "Completed replay checks are saved earlier, reducing the risk of losing results during packaging.",
        "Snapshot preparation now stages files in fewer safe batches."
      ]
    },
    {
      "number": 330,
      "title": "Fail fast on missing or changed offline verifier dependencies",
      "commit": "4b0754292b02769f25d3d5d4cb5da3a313b8c258",
      "committedAt": "2026-11-08T04:13:28.000Z",
      "notes": [
        "Replay checks now catch missing or changed browser dependencies before starting."
      ]
    },
    {
      "number": 329,
      "title": "Repair stuck PB uploads and event highlights and pack verification batches",
      "commit": "830a61697e3e0e3c6237249975279576d0aa7511",
      "committedAt": "2026-11-08T03:58:17.000Z",
      "notes": [
        "Fixed PB uploads getting stuck after replay recovery or a large local track history.",
        "Event rankings retain saved event highlights and validate their point totals.",
        "Replay verification shares more browser launches while keeping its existing safety limits."
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
