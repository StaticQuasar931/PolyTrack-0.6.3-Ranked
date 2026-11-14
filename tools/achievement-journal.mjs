/** Parent integration: load achievement-journal.css once; render into a host, then bind.
 * cosmetics is PROFILE_COSMETIC_OPTIONS unchanged ({kind: [[id,label,requirement]]}).
 * progress.confirmed is an authoritative current profile entry, never a local merge.
 * progress.local contains exact supplied counts only: pbCount, verifiedTracks,
 * extraCount (distinct saved ranked Extra PBs), totalPlaytimeMs (visible game time),
 * trackWins, eventParticipations, practiceFinishes. Missing/invalid means unknown.
 * No data collection, publication, unlock mutation, network, or storage discovery.
 * Re-render + rebind on profile updates; dispose the previous binding first.
 */
const {buildAchievementGoals} = await import(new URL('./achievement-model.mjs' + new URL(import.meta.url).search,import.meta.url).href);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const exact = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const families = ['titles','style','discovery','events','practice'];
const labels = {titles:'Titles',style:'Style',discovery:'Discovery',events:'Events',practice:'Practice',daily:'Daily'};
const rewardCategories = {theme:'Theme',accent:'Accent',finish:'Finish',stage:'Background',stageTint:'Background color',stageEffect:'Background effect',plate:'Nameplate',edge:'Border',stripe:'Stripe',emblem:'Emblem',emblem2:'Second emblem',emblem3:'Third emblem',emblemBackdrop:'Emblem background',nameFont:'Name font',nameSize:'Name size',nameWeight:'Name weight',nameColor:'Name color',baseSecondary:'Secondary color',title:'Title',badge:'Badge'};
const plural = (count,one,many = one + 's') => count === 1 ? one : many;
const filters = ['next','earned','all'];
const preferenceKey = 'polytrack:achievement-journal:filter:v1';
const paths = {
  all:'M8 3h8v7a4 4 0 0 1-8 0V3ZM8 5H4v3a4 4 0 0 0 4 4m8-7h4v3a4 4 0 0 1-4 4m-4 2v5m-4 2h8m-6-2h4',
  titles:'M4 7l4 3 4-6 4 6 4-3-3 11H7L4 7Zm3 14h10',
  style:'M12 3a9 9 0 0 0 0 18h1a2 2 0 0 0 1-4 2 2 0 0 1 1-4h3a3 3 0 0 0 3-3c0-4-4-7-9-7ZM7 7h.01M5 12h.01M9 17h.01M12 6h.01M17 8h.01',
  discovery:'M3 5l6-2 6 2 6-2v16l-6 2-6-2-6 2V5Zm6-2v16m6-14v16',
  events:'M5 21V3h14v10H5m0-5h14M10 3v10m5-10v10',
  practice:'M9 2h6m-3 0v3m6 1 2-2M12 5a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm0 3v5l3 2',
  daily:'M7 2v4m10-4v4M4 4h16v17H4V4Zm0 6h16m-12 4h2m4 0h2m-8 4h2m4 0h2'
};
const icon = family => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" data-aj-icon="${family}"><path d="${paths[family] ?? paths.all}"/>${family === 'events' ? '<path fill="currentColor" stroke="none" d="M5 3h5v5H5zM15 3h4v5h-4zM10 8h5v5h-5z"/>' : ''}</svg>`;
const amount = (value, metric) => metric === 'totalPlaytimeMs' ? `${Math.round(value / 36000) / 100}h` : metric === 'pbTimeSavedMs' ? `${value / 1000}s` : String(value);

/** Presentation adapter. Proposed points never enter this view or cosmetic policy. */
export function buildAchievementJournalModel(options = {}) {
  const base = buildAchievementProgress(options);
  if (!base.milestones.length && ![...Object.values(options.progress?.confirmed ?? {}),...Object.values(options.progress?.local ?? {})].some(value => exact(value) !== null)) return base;
  const retained = base.milestones.filter(item => item.source === 'catalog' || item.metric === 'totalPlaytimeMs');
  const nextIds = base.nextIds.filter(id => retained.some(item => item.id === id));
  const lanes = buildAchievementGoals({confirmed:options.progress?.confirmed,local:options.progress?.local});
  for (const lane of lanes) {
    for (const tier of lane.tiers) {
      const source = tier.status === 'device' ? 'local' : lane.confirmedValue !== null ? 'confirmed' : lane.source === 'device' ? 'local' : 'unknown';
      const value = tier.status === 'device' ? lane.localValue : lane.value;
      const goal = `${lane.title}: ${lane.unit === 'milliseconds' ? tier.target / 1000 + 's' : tier.target}`;
      retained.push({id:tier.id,laneId:lane.id,laneTitle:lane.title,family:lane.family,metric:lane.metric,target:tier.target,value,localValue:lane.localValue,source,goal,description:lane.description,navigate:lane.navigate,earned:tier.status === 'confirmed' || tier.status === 'device',rewards:[],ratio:value === null ? 0 : Math.min(1,value / tier.target)});
    }
    if (lane.nextTierId) nextIds.push(lane.nextTierId);
  }
  const ids = [...families,'daily'];
  const branches = ids.map(id => ({id,label:labels[id],milestones:retained.filter(item => item.family === id)})).filter(branch => branch.milestones.length);
  return {branches,milestones:retained,nextIds,counts:{earned:retained.filter(item => item.earned).length,total:retained.length,confirmed:retained.filter(item => item.earned && item.source !== 'local').length,local:retained.filter(item => item.earned && item.source === 'local').length}};
}

function requirementInfo(requirement) {
  if (typeof requirement === 'number' && exact(requirement) !== null) return {metric:'raceCount',target:requirement,goal:`Finish ${requirement} ranked ${plural(requirement,'track')}`};
  const match = /^(pb|wins|playtime|extra):(\d+)$/.exec(String(requirement));
  if (match) {
    const target = Number(match[2]);
    if (exact(target) === null) return null;
    const metric = {pb:'pbCount',wins:'trackWins',playtime:'totalPlaytimeMs',extra:'extraCount'}[match[1]];
    const goal = {pb:`Set ${target} personal ${plural(target,'best')}`,wins:`Earn ${target} verified first-place ${plural(target,'finish','finishes')}`,playtime:`${amount(target,metric)} active playtime`,extra:`Finish ${target} ranked Extra ${plural(target,'Track')}`}[match[1]];
    return {metric,target,goal};
  }
  if (requirement === 'podium') return {metric:'podium',target:1,goal:'Hold an Overall top 3 place'};
  if (requirement === 'beta') return {metric:'beta',target:1,goal:'Ranked beta award'};
  if (typeof requirement === 'string' && requirement.startsWith('unlock:')) {
    const id = requirement.slice(7), target = {'emblem:target':1,'stripe:overdrive':3}[id];
    return {metric:'unlock',target:target ?? 1,unlockId:id,goal:target ? `Tie or beat StaticQuasar931 on ${target} distinct official or Rolling Hills ${plural(target,'track')}. Both times must be verified.` : 'Earn this special cosmetic award'};
  }
  return null;
}

function confirmedValue(info, confirmed) {
  if (info.metric === 'podium') {
    const rank = exact(confirmed.rank);
    return rank === null ? null : rank > 0 && rank <= 3 ? 1 : 0;
  }
  if (info.metric === 'beta') return typeof confirmed.badges?.betaTester === 'boolean' ? Number(confirmed.badges.betaTester) : null;
  if (info.metric === 'unlock') {
    const count = exact(confirmed.serverAchievements?.beatOwner?.count);
    return Array.isArray(confirmed.cosmeticUnlocks) && confirmed.cosmeticUnlocks.includes(info.unlockId) ? Math.max(count ?? 0,info.target) : count;
  }
  return exact(confirmed[info.metric]);
}

/** Pure model. Local milestones never mark a catalog reward as unlocked. */
export function buildAchievementProgress({progress = {}, cosmetics = {}} = {}) {
  const confirmed = progress.confirmed ?? {}, local = progress.local ?? {}, grouped = new Map();
  for (const [kind, options] of Object.entries(cosmetics)) {
    if (!Array.isArray(options)) continue;
    for (const option of options) {
      if (!Array.isArray(option) || option.length < 3) continue;
      const [id,label,requirement] = option, info = requirementInfo(requirement);
      if (!info || requirement === 0 || ['auto','none'].includes(id)) continue;
      const family = kind === 'title' ? 'titles' : info.metric === 'extraCount' ? 'discovery' : 'style';
      const key = `${family}:${requirement}`;
      if (!grouped.has(key)) {
        const value = confirmedValue(info, confirmed), localValue = exact(local[info.metric]);
        const earned = info.metric === 'unlock' ? Array.isArray(confirmed.cosmeticUnlocks) && confirmed.cosmeticUnlocks.includes(info.unlockId) : value !== null && value >= info.target;
        grouped.set(key, {id:key,family,...info,requirement,value,localValue,earned,rewards:[],source:'catalog'});
      }
      grouped.get(key).rewards.push({kind,id:String(id),label:String(label)});
    }
  }
  const definitions = [
    ['practice','pbCount','Personal bests',[1,10,25,50]],
    ['practice','verifiedTracks','Verified tracks',[1,5,10,25]],
    ['practice','totalPlaytimeMs','Active playtime',[3600000,18000000,36000000]],
    ['practice','practiceFinishes','Practice finishes',[1,10,50,100]],
    ['discovery','extraCount','Ranked Extra finishes',[1,3,10,25]],
    ['events','eventParticipations','Event participations',[1,5,10,25]],
    ['events','trackWins','Verified track wins',[1,5,10,25]]
  ];
  for (const [family,metric,label,tiers] of definitions) {
    const value = exact(local[metric]);
    if (value === null) continue;
    for (const target of tiers) {
      const goal = metric === 'totalPlaytimeMs' ? `${amount(target,metric)} active playtime` : `${target} ${plural(target,{pbCount:'personal best',verifiedTracks:'verified track',practiceFinishes:'practice finish',extraCount:'ranked Extra Track',eventParticipations:'event participation',trackWins:'verified track win'}[metric] ?? label,metric === 'practiceFinishes' ? 'practice finishes' : undefined)}`;
      grouped.set(`local:${metric}:${target}`, {id:`local:${metric}:${target}`,family,metric,target,value,localValue:value,goal,earned:value >= target,rewards:[],source:'local'});
    }
  }
  const milestones = [...grouped.values()].map(item => ({...item,ratio:item.value === null ? 0 : Math.min(1,item.value / item.target)}));
  const branches = families.map(id => ({id,label:labels[id],milestones:milestones.filter(item => item.family === id)})).filter(branch => branch.milestones.length);
  // Next is the first unearned tier of each requirement lane, not every locked item.
  const nextIds = new Set();
  for (const branch of branches) {
    const lanes = new Map();
    for (const item of branch.milestones.filter(item => !item.earned && item.metric !== 'beta')) {
      const lane = `${item.source}:${item.metric}`;
      if (!lanes.has(lane) || lanes.get(lane).target > item.target) lanes.set(lane,item);
    }
    for (const item of lanes.values()) nextIds.add(item.id);
  }
  return {branches,milestones,nextIds:[...nextIds],counts:{earned:milestones.filter(item => item.earned).length,total:milestones.length,confirmed:milestones.filter(item => item.earned && item.source === 'catalog').length,local:milestones.filter(item => item.earned && item.source === 'local').length}};
}

function rewardPreview(reward,index) {
  const kind = String(reward.kind), dash = kind.replace(/[A-Z]/g,letter => '-' + letter.toLowerCase());
  const text = ['nameFont','nameColor','nameSize','nameWeight','title','badge'].includes(kind);
  return `<button type="button" class="aj-reward profile-cosmetic-choice cosmetic-${esc(dash)}-${esc(reward.id)}" data-aj-try="${index}" aria-label="View reward: ${esc(reward.label)}"><span class="aj-reward-swatch" aria-hidden="true"><span class="profile-cosmetic-preview ${text ? 'name-preview' : ''}">${text ? 'RACER' : '<i></i>'}</span></span><span class="aj-reward-category">${esc(rewardCategories[kind] ?? 'Style')}</span><span class="aj-reward-label">View reward: ${esc(reward.label)}</span></button>`;
}

function detail(item) {
  const rewardText = item.rewards.length ? `${item.rewards.length} ${plural(item.rewards.length,'reward')}` : 'Personal milestone';
  const status = item.source === 'local' ? 'Saved on this device' : item.earned ? 'Confirmed' : item.source === 'unknown' ? 'Not tracked yet' : 'In progress';
  return `<div class="aj-inspector-info"><p class="aj-kicker">${esc(status)}</p><h3>${esc(item.goal)}</h3><p class="aj-detail-rewardtext">${esc(rewardText)}</p>${item.description ? `<details class="aj-more"><summary>How it counts</summary><p>${esc(item.description)}</p></details>` : ''}${item.metric === 'beta' ? '<p>Awarded during the Ranked beta.</p>' : ''}${item.source === 'catalog' && item.localValue !== null && item.localValue !== undefined ? `<p class="aj-local">Saved on this device: ${esc(amount(item.localValue,item.metric))}</p>` : ''}<button type="button" class="aj-explore" data-aj-navigate="${esc(item.navigate ?? item.family)}">Explore ${esc(labels[item.family] ?? item.family)}</button></div><div class="aj-inspector-rewards">${item.rewards.length ? `<div class="aj-rewards">${item.rewards.map(rewardPreview).join('')}</div><p class="aj-preview-note">View a reward in Racer Studio.</p>` : '<p class="aj-personal-note">A milestone for your own progress. No cosmetic reward.</p>'}</div>`;
}

let serial = 0;
/** HTML fragment. embedded:true uses the hub's header. Optional model or buildModel
 * accepts the same {branches,milestones,nextIds,counts} pure contract as the builder.
 * The host owns publication, modal lifecycle, and authoritative cosmetic checks.
 */
export function renderAchievementJournal(options = {}) {
  const model = options.model ?? options.buildModel?.(options) ?? buildAchievementJournalModel(options);
  const filter = filters.includes(options.filter) ? options.filter : 'next';
  const prefix = String(options.idPrefix ?? `aj-${++serial}`);
  const knownNext = model.milestones.filter(item => item.value !== null && !item.earned && model.nextIds.includes(item.id));
  const family = model.branches.some(branch => branch.id === options.family) ? options.family : knownNext.some(item => item.family === 'style') ? 'style' : knownNext[0]?.family ?? model.branches[0]?.id ?? 'all';
  const selected = model.milestones.find(item => item.id === options.selectedId) ?? model.milestones.find(item => item.family === family && model.nextIds.includes(item.id)) ?? model.milestones.find(item => item.family === family) ?? model.milestones[0];
  const familyButton = (id,label,earned,total,known = true) => `<button type="button" data-aj-family="${esc(id)}" data-aj-path-known="${known}" aria-pressed="${id === family}">${icon(paths[id] ? id : 'style')}<span>${esc(label)}</span><small>${earned}/${total}</small></button>`;
  const node = item => `<li data-aj-node="${esc(item.id)}" data-aj-family-id="${esc(item.family)}" data-aj-search="${esc([item.goal,...item.rewards.map(reward => reward.label)].join(' ').toLowerCase())}" data-aj-earned="${item.earned}" data-aj-known="${item.value !== null}" data-aj-next="${model.nextIds.includes(item.id)}"><button type="button" data-aj-select="${esc(item.id)}" data-aj-rewards="${esc(JSON.stringify(item.rewards))}" data-aj-requirement="${esc(JSON.stringify(item.requirement ?? null))}" aria-controls="${esc(prefix)}-detail" aria-pressed="${item === selected}"><span class="aj-node-top"><span>${item.source === 'local' ? 'Saved on this device' : item.rewards.length ? 'Cosmetic goal' : 'Personal milestone'}</span><span>${item.earned ? 'EARNED' : item.value === null ? 'Not tracked yet' : 'In progress'}</span></span><strong>${esc(item.goal)}</strong><span class="aj-progress"><progress max="${item.target}" ${item.value === null ? '' : `value="${Math.min(item.value,item.target)}"`} aria-label="${esc(item.goal)}" aria-valuetext="${item.value === null ? 'Not tracked yet' : `${esc(amount(item.value,item.metric))} of ${esc(amount(item.target,item.metric))}`}"></progress><span>${item.value === null ? 'Not tracked yet' : esc(amount(item.value,item.metric))} / ${esc(amount(item.target,item.metric))}</span></span><span class="aj-node-reward">${item.rewards.length ? `${item.rewards.length} cosmetic choice${item.rewards.length === 1 ? '' : 's'}` : 'Personal milestone'}<span class="aj-mobile-prompt">View details &rsaquo;</span></span><template>${detail(item)}</template></button></li>`;
  let laneSerial = 0;
  const branchHTML = branch => {
    const lanes = new Map();
    for (const item of branch.milestones) {
      const key = item.laneId ?? `${item.source}:${item.metric}`;
      if (!lanes.has(key)) lanes.set(key,[]);
      lanes.get(key).push(item);
    }
    const laneNames = {raceCount:'Ranked finishes',pbCount:'Personal bests',totalPlaytimeMs:'Active playtime',trackWins:'Verified first places',extraCount:'Ranked Extra Tracks',podium:'Overall podium',beta:'Ranked beta',unlock:'Owner challenge'};
    return `<section class="aj-branch" data-aj-branch="${esc(branch.id)}" aria-label="${esc(branch.label)}"><header>${icon(branch.id)}<h3>${esc(branch.label)}</h3><span>${branch.milestones.filter(item => item.earned).length}/${branch.milestones.length}</span></header>${branch.milestones.some(item => !item.rewards.length) ? '<p class="aj-branch-note">Personal goals do not grant cosmetics.</p>' : ''}${[...lanes].map(([key,items])=>{
      const first = items[0], title = first.laneTitle ?? laneNames[first.metric] ?? `${branch.label} goals`, heading = `${prefix}-lane-${++laneSerial}`;
      return `<section class="aj-lane" data-aj-lane="${esc(key)}" aria-labelledby="${esc(heading)}"><header class="aj-lane-head"><span class="aj-lane-mark">${icon(branch.id)}</span><div><p>${items.some(item => item.rewards.length) ? 'COSMETIC REWARDS' : 'PERSONAL GOAL'}</p><h4 id="${esc(heading)}">${esc(title)}</h4></div><span class="aj-lane-count">${items.filter(item=>item.earned).length} / ${items.length} reached</span></header><ol class="aj-tier-list">${items.slice().sort((a,b)=>a.target-b.target).map(node).join('')}</ol></section>`;
    }).join('')}</section>`;
  };
  return `<section class="aj" data-aj-root data-aj-active-family="${esc(family)}" ${options.embedded ? 'data-aj-embedded' : ''} aria-labelledby="${esc(prefix)}-title"><header class="aj-head"><div><p class="aj-kicker">Earn styles as you race.</p><h2 id="${esc(prefix)}-title">Achievements</h2></div><button type="button" data-aj-close aria-label="Close achievements">Close</button></header><div class="aj-summary"><strong>${model.counts.earned}<span> / ${model.counts.total}</span></strong><div>Your progress<p>${model.counts.confirmed} Confirmed / ${model.counts.local} Saved on this device</p></div><p class="aj-notice">Cosmetics become available when your progress is confirmed.</p></div><div class="aj-workspace"><nav class="aj-paths" aria-label="Achievement paths"><p class="aj-kicker">CHOOSE YOUR PATH</p>${familyButton('all','All paths',model.counts.earned,model.counts.total)}${model.branches.map(branch => familyButton(branch.id,branch.label,branch.milestones.filter(item => item.earned).length,branch.milestones.length,branch.milestones.some(item => item.value !== null))).join('')}</nav><div class="aj-content"><div class="aj-tools"><div class="aj-filters" role="group" aria-label="Show milestones">${filters.map(value => `<button type="button" data-aj-filter="${value}" aria-pressed="${filter === value}">${value === 'next' ? 'Next goals' : value === 'earned' ? 'Earned' : 'All tiers'}</button>`).join('')}</div><label class="aj-search"><span class="aj-sr">Find a goal or reward</span><input type="search" data-aj-search-input placeholder="Find a goal or reward" aria-label="Find a goal or reward"></label></div><div class="aj-layout"><div class="aj-tree">${model.branches.map(branchHTML).join('')}<p class="aj-empty-filter" hidden>No goals match. Try another path, filter, or search.</p>${!model.milestones.length ? '<p class="aj-empty">No progress yet. Your achievements will appear here as you race.</p>' : ''}</div><aside class="aj-detail" aria-label="Selected milestone" id="${esc(prefix)}-detail"><div data-aj-detail>${selected ? detail(selected) : '<p>Select a milestone when profile data is available.</p>'}</div></aside></div><p class="aj-footer" role="status" data-aj-status>${model.milestones.length} achievements</p></div></div></section>`;
}

/** onTryCosmetic({kind,id,label,requirement,confirmed,previewOnly:true}),
 * onNavigate(family), onClose(). Returns cleanup; storage stores only the filter.
 */
export function bindAchievementJournal(root, {onTryCosmetic,onNavigate,onClose,storage} = {}) {
  const journal = root.matches?.('[data-aj-root]') ? root : root.querySelector('[data-aj-root]');
  if (!journal) return () => {};
  const nodes = [...journal.querySelectorAll('[data-aj-node]')];
  let selected = journal.querySelector('[data-aj-select][aria-pressed="true"]');
  let family = journal.dataset.ajActiveFamily, filter = journal.querySelector('[data-aj-filter][aria-pressed="true"]').dataset.ajFilter;
  const layout = journal.querySelector('.aj-layout'), panel = journal.querySelector('.aj-detail');
  const phone = journal.ownerDocument.defaultView.matchMedia('(max-width:660px)');
  let detailOpen = false;
  const placeDetail = () => {
    panel.hidden = !detailOpen || !selected;
    for (const button of journal.querySelectorAll('[data-aj-select]')) {
      button.setAttribute('aria-expanded',String(button === selected && detailOpen));
      button.setAttribute('aria-pressed',String(button === selected && detailOpen));
    }
    if (phone.matches && detailOpen && selected && !selected.closest('li').hidden) selected.closest('li').append(panel);
    else if (!phone.matches && selected && !selected.closest('li').hidden) selected.closest('[data-aj-lane]').append(panel);
    else layout.append(panel);
  };
  function select(button,explicit = false) {
    if (explicit) detailOpen = true;
    selected?.setAttribute('aria-pressed','false'); selected = button; selected.setAttribute('aria-pressed','true');
    journal.querySelector('[data-aj-detail]').innerHTML = button.querySelector('template').innerHTML;
    placeDetail();
  }
  function update(persist = false) {
    const tokens = journal.querySelector('[data-aj-search-input]').value.toLowerCase().trim().split(/\s+/).filter(Boolean);
    for (const button of journal.querySelectorAll('[data-aj-filter]')) button.setAttribute('aria-pressed',String(button.dataset.ajFilter === filter));
    const pathButtons = [...journal.querySelectorAll('button[data-aj-family]')];
    if (filter !== 'all' && pathButtons.some(button => button.dataset.ajFamily === family && button.dataset.ajPathKnown === 'false')) family = 'all';
    for (const button of pathButtons) {
      button.hidden = filter !== 'all' && button.dataset.ajPathKnown === 'false';
      button.setAttribute('aria-pressed',String(button.dataset.ajFamily === family));
    }
    for (const node of nodes) node.hidden = family !== 'all' && node.dataset.ajFamilyId !== family || filter === 'earned' && node.dataset.ajEarned !== 'true' || filter === 'next' && (node.dataset.ajNext !== 'true' || node.dataset.ajKnown !== 'true') || !tokens.every(token => node.dataset.ajSearch.includes(token));
    for (const lane of journal.querySelectorAll('[data-aj-lane]')) {
      const count = [...lane.querySelectorAll('[data-aj-node]')].filter(node => !node.hidden).length;
      lane.hidden = count === 0; lane.dataset.ajSingle = String(count === 1);
    }
    for (const branch of journal.querySelectorAll('[data-aj-branch]')) branch.hidden = ![...branch.querySelectorAll('[data-aj-node]')].some(node => !node.hidden);
    const visible = nodes.filter(node => !node.hidden);
    journal.querySelector('.aj-empty-filter').hidden = visible.length > 0 || nodes.length === 0;
    if (!selected || selected.closest('li').hidden) {
      const first = visible[0]?.querySelector('[data-aj-select]');
      if (first) select(first);
      else {
        selected?.setAttribute('aria-pressed','false'); selected = null;
        journal.querySelector('[data-aj-detail]').textContent = 'No milestones match this filter. Try All tiers.';
      }
    }
    placeDetail();
    if (persist) {try {storage?.setItem?.(preferenceKey,filter);} catch {}}
    journal.querySelector('[data-aj-status]').textContent = `${visible.length} achievements shown`;
  }
  const click = event => {
    const button = event.target.closest('button');
    if (!button || !journal.contains(button)) return;
    if (button.hasAttribute('data-aj-filter')) {filter = button.dataset.ajFilter;detailOpen = false;update(true);}
    else if (button.hasAttribute('data-aj-family')) {family = button.dataset.ajFamily;detailOpen = false;update();}
    else if (button.hasAttribute('data-aj-select')) {
      if (selected === button && detailOpen) {detailOpen = false;placeDetail();}
      else select(button,true);
    }
    else if (button.hasAttribute('data-aj-close')) onClose?.();
    else if (button.hasAttribute('data-aj-navigate')) onNavigate?.(button.dataset.ajNavigate);
    else if (button.hasAttribute('data-aj-try') && selected) {
      const reward = JSON.parse(selected.dataset.ajRewards)[Number(button.dataset.ajTry)];
      if (reward) onTryCosmetic?.({...reward,requirement:JSON.parse(selected.dataset.ajRequirement),confirmed:selected.closest('li').dataset.ajEarned === 'true',previewOnly:true});
    }
  };
  const keydown = event => {
    if (event.key === 'Escape' && onClose) {event.preventDefault();event.stopPropagation();onClose();return;}
    if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key) || !event.target.matches('[data-aj-select]')) return;
    const visible = nodes.filter(node => !node.hidden).map(node => node.querySelector('[data-aj-select]'));
    const index = visible.indexOf(event.target), next = event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length;
    event.preventDefault(); event.stopPropagation(); visible[next]?.focus();
  };
  const input = event => {if (event.target.matches('[data-aj-search-input]')) update();};
  journal.addEventListener('click',click); journal.addEventListener('keydown',keydown); journal.addEventListener('input',input);
  phone.addEventListener('change',placeDetail);
  try {const saved = storage?.getItem?.(preferenceKey);if (filters.includes(saved)) filter = saved;} catch {}
  update();
  return () => {journal.removeEventListener('click',click);journal.removeEventListener('keydown',keydown);journal.removeEventListener('input',input);phone.removeEventListener('change',placeDetail);};
}
