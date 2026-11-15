// BEGIN GENERATED RELEASE HISTORY
const historyData = {
  "schemaVersion": 1,
  "current": {
    "number": 403,
    "version": "0.6.3",
    "revision": 345,
    "notes": [
      "Fixed the empty strip above Kodub weekly artwork: its width now follows the image ratio while reserving room for the details.",
      "Weekly cards retain the same height as other event cards. Artwork stays uncropped, with centered letterboxing when needed.",
      "The compact weekly personal-best icon now matches its text size. Browser checks cover seven screen sizes and four image ratios."
    ]
  },
  "entries": [
    {
      "number": 402,
      "title": "Fix offline history publication contract tests",
      "commit": "1cf396bc54495fef6ba07c4c470cd5e1c086134f",
      "committedAt": "2026-11-15T22:43:22.000Z",
      "notes": [
        "Corrected the publication test harness to distinguish offline rank-history building from push failures.",
        "Added a fail-closed test proving that a failed rank-history build cannot commit, push or report publication success.",
        "Retains release 401 rank-history, Kodub card-height and dependency-ignore fixes. No snapshot capture, physics or Firebase changes."
      ]
    },
    {
      "number": 401,
      "title": "Fix observed rank history and event card sizing",
      "commit": "6f27e4fac65bf518c6157fb969812680a8882f31",
      "committedAt": "2026-11-15T22:30:20.000Z",
      "notes": [
        "Overall RP rank durations now use consecutive saved snapshot observations instead of reset rebuild timestamps.",
        "Rank history is compact, cached per snapshot and shared by rankings and racer profiles; local projected rank changes do not inherit old tenure.",
        "Kodub Track of the Week matches the other event card heights while fitting the full artwork horizontally.",
        "Installed dependencies are excluded from source changes. Existing snapshots, replay proofs and player saves are preserved.",
        "Release auditing now validates the exact release-394 geometry addition separately from the unchanged historical proof-review chain."
      ]
    },
    {
      "number": 400,
      "title": "Publish completed priority proofs and remove audit staging I/O",
      "commit": "4dff530e9ab1bd8c95e1d451c9e4ebdaf87ddd28",
      "committedAt": "2026-11-15T05:51:10.000Z",
      "notes": [
        "Published 63 further completed replay proofs: 34 Rolling Hills and29 Magician's Residence normal runs.",
        "The selected Rolling Hills backlog is complete for this saved capture; three slow Magician's Residence replays remain unverified after CPU deadlines.",
        "Previously published proofs and event results are preserved;offline verification uses no Firebase calls.",
        "Publication audits validate in memory with bounded reads, avoiding temporary replay-file trees."
      ]
    },
    {
      "number": 399,
      "title": "Decouple offline normal verification from historical event reprojection",
      "commit": "21e6be555d14794e40e50b4a65980d0e54c2cc53",
      "committedAt": "2026-11-15T05:22:43.000Z",
      "notes": [
        "Offline normal-track verification can retain published event results instead of reprocessing unrelated historical events.",
        "The new scope admits only normal-run proofs, preserving event data, previous witnesses and review checks.",
        "No Firebase calls or automatic retries are added."
      ]
    },
    {
      "number": 398,
      "title": "Fix Studio preview saves and clarify car cosmetic choices",
      "commit": "36b45bbe6913f90738f64d01e94ddf8abd484527",
      "committedAt": "2026-11-15T05:13:15.000Z",
      "notes": [
        "Studio keeps the selected backdrop and real car preview; saved drafts survive delayed controls.",
        "Shop sits beside Achievements and Racer Studio; favorite text no longer enters the car renderer.",
        "Front and rear accessories can be combined; Podium crown requires a confirmed podium.",
        "Workshop names locked selections and their requirements; two-color neon and metal finishes are clearer."
      ]
    },
    {
      "number": 397,
      "title": "Publish Kodub event proofs and streamline offline verification",
      "commit": "f107fcc97bf79de5e6bf72d008eac795d7d228ba",
      "committedAt": "2026-11-15T04:51:56.000Z",
      "notes": [
        "Published 93 additional native replay proofs, including the remaining selected Kodub event runs.",
        "Weekly spotlight artwork uses the card height and flexible horizontal space without cropping.",
        "Achievements distinguish goal groups, cosmetic unlocks and coin milestones; Shop adds sorting.",
        "Clearer playtime precision and update-click attribution; longer read-only GitHub verification is available."
      ]
    },
    {
      "number": 396,
      "title": "Publish saved replay proofs and prepare offline Linux verification",
      "commit": "f099e5e6d259bfaeb5da4c6e099c11b03587defc",
      "committedAt": "2026-11-15T03:12:59.000Z",
      "notes": [
        "Published 19 additional saved-replay verifications; earlier proofs are preserved.",
        "Prepared read-only GitHub verification for the remaining selected Kodub and Rolling Hills runs.",
        "Snapshot compression now stays consistent across Windows and Linux."
      ]
    },
    {
      "number": 395,
      "title": "Polish car workshop Studio previews and automatic rewards",
      "commit": "b4c0d40479b8e33602dc58c1783c4d02a88a4752",
      "committedAt": "2026-11-15T02:08:48.000Z",
      "notes": [
        "Car finishes preserve both paint colors; accessories fit the car more closely.",
        "Shop synchronizes eligible rewards automatically, with limited repeat checks.",
        "Live previews, Undo and Restore saved work more consistently.",
        "Completed the saved-replay setup for the next offline event verification pass."
      ]
    },
    {
      "number": 394,
      "title": "Enable source-bound offline Kodub and Rolling Hills verification",
      "commit": "7685e42f93986d59adc3cfbf7e3270d13a82450b",
      "committedAt": "2026-11-15T02:01:33.000Z",
      "notes": [
        "Prepared targeted offline checks for Magician's Residence and Rolling Hills Racer.",
        "Earlier published proofs stay intact; new runs still require their own replay checks."
      ]
    },
    {
      "number": 393,
      "title": "Clarify event previews and stabilize profile navigation",
      "commit": "75649ddd74448b0fe0fb6b258dc56af0043eaf82",
      "committedAt": "2026-11-15T01:40:51.000Z",
      "notes": [
        "Clearer event names, cached placements and Rolling Hills ERP tooltips.",
        "Stable Achievements, Racer Studio and Shop shortcuts while menus load.",
        "Local PBs can show a podium target without claiming confirmed medals."
      ]
    },
    {
      "number": 392,
      "title": "Publish 66 offline event verifications and preserve prior results",
      "commit": "60922970ed7d31bbf2866e179a1c0374ae43a51b",
      "committedAt": "2026-11-15T00:49:08.000Z",
      "notes": [
        "Added verification for 66 saved event runs without another cloud capture.",
        "Preserved all existing normal-track results and earlier verification proofs."
      ]
    },
    {
      "number": 391,
      "title": "Make native verification test fixtures portable on GitHub",
      "commit": "1c515ef2bb54df5756d77fed366f9ca099a6e129",
      "committedAt": "2026-11-15T00:02:44.000Z",
      "notes": [
        "Fixed a Windows-only test path that blocked offline verification on GitHub."
      ]
    },
    {
      "number": 390,
      "title": "Real car workshop achievement bonuses and offline event verification",
      "commit": "ff504eeab1276dda9893901363e2d0cfeede3ddc",
      "committedAt": "2026-11-14T23:56:19.000Z",
      "notes": [
        "Real car finishes, front emblems and accessories, with a clearer Garage workshop.",
        "Sharper shop previews and claimable bonuses for eligible cosmetic achievements.",
        "Clearer Event RP filters, run tooltips and a simpler rankings menu.",
        "Offline event replay verification now builds an audited update from saved files."
      ]
    },
    {
      "number": 389,
      "title": "Fix coalesced PB uploads milestone claims and event PB previews",
      "commit": "8cb1f3338690a5d46621b0213094efbd9e58373b",
      "committedAt": "2026-11-14T23:25:08.000Z",
      "notes": [
        "Fixed uploads after several personal bests in one track session.",
        "Fixed milestone claims getting stuck after earning newer rewards.",
        "Event personal-best times stay visible when returning to Daily, Weekly, or Kodub tracks."
      ]
    },
    {
      "number": 388,
      "title": "Scope CDN publication to current snapshot files",
      "commit": "8aa96636bbbba17260771086c75691195365f8ce",
      "committedAt": "2026-11-14T22:46:45.000Z",
      "notes": [
        "More reliable delivery of the latest update and snapshot files."
      ]
    },
    {
      "number": 387,
      "title": "Style Coins rewards and pace-based Rolling Hills scoring",
      "commit": "91c54039a2ac23adf5b05e5bd4a84d23f9fde895",
      "committedAt": "2026-11-14T22:38:32.000Z",
      "notes": [
        "Clearer achievement rewards, Style Coins milestones, and a personalized shop preview.",
        "Favorite-track previews and cleaner Racer Studio controls.",
        "Rolling Hills Event RP now rewards both placement and pace, including past results.",
        "Safer loading for your recent local replays."
      ]
    },
    {
      "number": 386,
      "title": "Garage safety and reliable local replay loading",
      "commit": "5e47f1ef8805f183b418e1c0c6d5b890ed465f87",
      "committedAt": "2026-11-14T21:50:20.000Z",
      "notes": [
        "Protection against accidental closing, and smoother Garage navigation.",
        "Roof accessories now sit on the car, with six choices in the bottom-tab workshop.",
        "More reliable local PB replays and snapshot-based route suggestions."
      ]
    },
    {
      "number": 385,
      "title": "Readable car workshop controls on phones",
      "commit": "603fb3ea7e4092f09faac228a218f4d03ec0095d",
      "committedAt": "2026-11-14T21:15:06.000Z",
      "notes": [
        "Readable car workshop controls on phones and smaller screens.",
        "Collapse the workshop while viewing your car; native Save dialogs stay clear."
      ]
    },
    {
      "number": 384,
      "title": "Car workshop and expanded Studio style shop",
      "commit": "cbf4cb672be59c5df47cf2b1379c0a278d5fbf0b",
      "committedAt": "2026-11-14T21:07:07.000Z",
      "notes": [
        "Customize your car in Garage with starter paint palettes and roof accessories.",
        "Browse nine profile designs in the Style shop inside Racer Studio.",
        "Clearer Token prices, more profile styles, and local car appearance saves."
      ]
    },
    {
      "number": 383,
      "title": "Clearer achievements and reversible Studio previews",
      "commit": "a45906a9d2deaa0564dbbc8bb5132bcbdaf39f10",
      "committedAt": "2026-11-14T20:11:07.000Z",
      "notes": [
        "Clearer, larger achievement goals without profile patterns.",
        "Combine cosmetic previews, undo changes, and see unsaved edits.",
        "Cleaner profile layout and a redesigned Apex Observatory backdrop."
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
