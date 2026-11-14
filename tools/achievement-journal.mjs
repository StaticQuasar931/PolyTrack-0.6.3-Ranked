/** Parent integration: load achievement-journal.css once; render into a host, then bind.
 * cosmetics is PROFILE_COSMETIC_OPTIONS unchanged ({kind: [[id,label,requirement]]}).
 * progress.confirmed is an authoritative current profile entry, never a local merge.
 * progress.local contains exact supplied counts only: pbCount, verifiedTracks,
 * extraCount (distinct saved ranked Extra PBs), totalPlaytimeMs (visible game time),
 * trackWins, eventParticipations, practiceFinishes. Missing/invalid means unknown.
 * No data collection, publication, unlock mutation, network, or storage discovery.
 * Re-render + rebind on profile updates; dispose the previous binding first.
 */
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const exact = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const families = ['titles','style','discovery','events','practice'];
const labels = {titles:'Titles',style:'Style',discovery:'Discovery',events:'Events',practice:'Practice'};
const rewardCategories = {theme:'Theme',accent:'Accent',finish:'Finish',stage:'Background',stageTint:'Background color',stageEffect:'Background effect',plate:'Nameplate',edge:'Border',stripe:'Stripe',emblem:'Emblem',emblem2:'Second emblem',emblem3:'Third emblem',emblemBackdrop:'Emblem background',nameFont:'Name font',nameSize:'Name size',nameWeight:'Name weight',nameColor:'Name color',baseSecondary:'Secondary color',title:'Title',badge:'Badge'};
const plural = (count,one,many = one + 's') => count === 1 ? one : many;
const filters = ['next','earned','all'];
const preferenceKey = 'polytrack:achievement-journal:filter:v1';
const paths = {titles:'M5 19h14M7 16 4 6l5 4 3-7 3 7 5-4-3 10Z',style:'m12 3 9 9-9 9-9-9 9-9Zm0 5 4 4-4 4-4-4 4-4Z',discovery:'M3 5h7l4 14h7M10 5l4 14M4 12h16',events:'M5 21V3h14l-3 4 3 4H5',practice:'M12 4a8 8 0 1 1-7 4M3 3v6h6M12 7v5l3 2'};
const icon = family => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="${paths[family]}"/></svg>`;
const amount = (value, metric) => metric === 'totalPlaytimeMs' ? `${Math.round(value / 36000) / 100}h` : String(value);

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
    return {metric:'unlock',target:target ?? 1,unlockId:id,goal:target ? `Beat StaticQuasar931 on ${target} distinct official or Rolling Hills ${plural(target,'track')}. Both times must be verified.` : 'Earn this special cosmetic award'};
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

function detail(item) {
  const rewardText = item.rewards.length ? item.rewards.map(reward => `${reward.label} (${rewardCategories[reward.kind] ?? 'Style'})`).join(', ') : 'Personal milestone';
  const status = item.source === 'local' ? 'Saved on this device' : item.earned ? 'Confirmed' : item.localValue !== null && item.localValue >= item.target ? 'Waiting for confirmation' : item.value === null ? 'Progress unavailable' : 'In progress';
  return `<p class="aj-kicker">${esc(status)}</p><h3>${esc(item.goal)}</h3><p>${esc(rewardText)}</p>${item.metric === 'beta' ? '<p>Awarded during the Ranked beta.</p>' : ''}${item.source === 'catalog' && item.localValue !== null ? `<p class="aj-local">Saved on this device: ${esc(amount(item.localValue,item.metric))}</p>` : ''}${item.rewards.length ? `<div class="aj-rewards">${item.rewards.map((reward,index) => `<button type="button" data-aj-try="${index}">View reward: ${esc(reward.label)}</button>`).join('')}</div>` : ''}<button type="button" data-aj-navigate="${item.family}">Explore ${esc(labels[item.family])}</button>`;
}

let serial = 0;
/** HTML fragment, not a modal. Parent owns dialog/focus trap and CSS loading.
 * options: {progress, cosmetics, filter:'next'|'earned'|'all', selectedId, idPrefix}.
 * Count badge is journal-only and must not be used as a published profile badge.
 */
export function renderAchievementJournal(options = {}) {
  const model = buildAchievementProgress(options), filter = filters.includes(options.filter) ? options.filter : 'next';
  const prefix = String(options.idPrefix ?? `aj-${++serial}`), selected = model.milestones.find(item => item.id === options.selectedId) ?? model.milestones.find(item => model.nextIds.includes(item.id)) ?? model.milestones[0];
  return `<section class="aj" data-aj-root aria-labelledby="${esc(prefix)}-title"><header class="aj-head"><div><p class="aj-kicker">Earn styles as you race.</p><h2 id="${esc(prefix)}-title">Achievements</h2></div><button type="button" data-aj-close aria-label="Close achievements">Close</button></header><div class="aj-summary"><strong>${model.counts.earned}<span> / ${model.counts.total}</span></strong><div>Your progress<p>${model.counts.confirmed} Confirmed / ${model.counts.local} Saved on this device</p></div></div><p class="aj-notice">Cosmetics become available when your progress is confirmed.</p><div class="aj-filters" role="group" aria-label="Show milestones">${filters.map(value => `<button type="button" data-aj-filter="${value}" aria-pressed="${filter === value}">${value === 'next' ? 'Next goals' : value === 'earned' ? 'Earned' : 'All tiers'}</button>`).join('')}</div><div class="aj-layout"><div class="aj-tree">${model.branches.map(branch => `<section class="aj-branch" aria-label="${branch.label}"><header>${icon(branch.id)}<h3>${branch.label}</h3><span>${branch.milestones.filter(item => item.earned).length}/${branch.milestones.length}</span></header>${branch.milestones.some(item => item.source === 'local') ? '<p class="aj-node-reward">Personal milestones are saved on this device and have no cosmetic rewards.</p>' : ''}<ol>${branch.milestones.map(item => `<li data-aj-node="${esc(item.id)}" data-aj-earned="${item.earned}" data-aj-next="${model.nextIds.includes(item.id)}" ${filter === 'earned' && !item.earned || filter === 'next' && !model.nextIds.includes(item.id) ? 'hidden' : ''}><button type="button" data-aj-select="${esc(item.id)}" data-aj-rewards="${esc(JSON.stringify(item.rewards))}" data-aj-requirement="${esc(JSON.stringify(item.requirement ?? null))}" aria-pressed="${item === selected}"><span class="aj-node-top"><span>${item.source === 'local' ? 'Saved on this device' : 'Cosmetic goal'}</span><span>${item.earned ? 'EARNED' : item.value === null ? 'Progress unavailable' : 'In progress'}</span></span><strong>${esc(item.goal)}</strong><span class="aj-progress"><progress max="${item.target}" value="${item.value === null ? 0 : Math.min(item.value,item.target)}" aria-label="${esc(item.goal)}"></progress><span>${item.value === null ? 'Not yet available' : esc(amount(item.value,item.metric))} / ${esc(amount(item.target,item.metric))}</span></span><span class="aj-node-reward">${item.rewards.length ? `${item.rewards.length} cosmetic choice${item.rewards.length === 1 ? '' : 's'}` : 'Personal milestone'}</span><template>${detail(item)}</template></button></li>`).join('')}</ol><p class="aj-branch-empty" hidden>No milestones match this filter.</p></section>`).join('')}${!model.milestones.length ? '<p class="aj-empty">No progress yet. Your achievements will appear here as you race.</p>' : ''}</div><aside class="aj-detail" aria-label="Selected milestone"><div data-aj-detail>${selected ? detail(selected) : '<p>Select a milestone when profile data is available.</p>'}</div></aside></div><p class="aj-footer" role="status" data-aj-status>${model.milestones.length} achievements</p></section>`;
}

/** Callbacks: onTryCosmetic({kind,id,label,requirement,confirmed,previewOnly:true}),
 * onNavigate(family), onClose(). storage optional getItem/setItem stores only filter.
 * Returns cleanup(). Bind to the fragment's root or its containing host.
 */
export function bindAchievementJournal(root, {onTryCosmetic,onNavigate,onClose,storage} = {}) {
  const journal = root.matches?.('[data-aj-root]') ? root : root.querySelector('[data-aj-root]');
  if (!journal) return () => {};
  const nodes = [...journal.querySelectorAll('[data-aj-node]')];
  let selected = journal.querySelector('[data-aj-select][aria-pressed="true"]');
  const layout = journal.querySelector('.aj-layout'), panel = journal.querySelector('.aj-detail');
  const phone = journal.ownerDocument.defaultView.matchMedia('(max-width:660px)');
  const placeDetail = () => {
    if (phone.matches && selected) selected.closest('li').append(panel);
    else layout.append(panel);
  };
  function applyFilter(value, persist = false) {
    if (!filters.includes(value)) return;
    for (const button of journal.querySelectorAll('[data-aj-filter]')) button.setAttribute('aria-pressed',String(button.dataset.ajFilter === value));
    for (const node of nodes) {
      node.hidden = value === 'earned' ? node.dataset.ajEarned !== 'true' : value === 'next' ? node.dataset.ajNext !== 'true' : false;
    }
    for (const branch of journal.querySelectorAll('.aj-branch')) branch.querySelector('.aj-branch-empty').hidden = [...branch.querySelectorAll('[data-aj-node]')].some(node => !node.hidden);
    if (!selected || selected.closest('li').hidden) {
      const first = nodes.find(node => !node.hidden)?.querySelector('[data-aj-select]');
      if (first) select(first);
      else {
        selected?.setAttribute('aria-pressed','false'); selected = null;
        journal.querySelector('[data-aj-detail]').textContent = 'No milestones match this filter. Try All tiers.';
        placeDetail();
      }
    }
    if (persist) { try { storage?.setItem?.(preferenceKey,value); } catch {} }
    journal.querySelector('[data-aj-status]').textContent = `${nodes.filter(node => !node.hidden).length} achievements shown`;
  }
  function select(button) {
    selected?.setAttribute('aria-pressed','false'); selected = button; selected.setAttribute('aria-pressed','true');
    journal.querySelector('[data-aj-detail]').innerHTML = button.querySelector('template').innerHTML;
    placeDetail();
  }
  const click = event => {
    const button = event.target.closest('button');
    if (!button || !journal.contains(button)) return;
    if (button.hasAttribute('data-aj-filter')) applyFilter(button.dataset.ajFilter,true);
    else if (button.hasAttribute('data-aj-select')) select(button);
    else if (button.hasAttribute('data-aj-close')) onClose?.();
    else if (button.hasAttribute('data-aj-navigate')) onNavigate?.(button.dataset.ajNavigate);
    else if (button.hasAttribute('data-aj-try') && selected) {
      const reward = JSON.parse(selected.dataset.ajRewards)[Number(button.dataset.ajTry)];
      if (reward) onTryCosmetic?.({...reward,requirement:JSON.parse(selected.dataset.ajRequirement),confirmed:selected.closest('li').dataset.ajEarned === 'true',previewOnly:true});
    }
  };
  const keydown = event => {
    if (event.key === 'Escape' && onClose) { event.preventDefault(); event.stopPropagation(); onClose(); }
    if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key) || !event.target.matches('[data-aj-select]')) return;
    const visible = nodes.filter(node => !node.hidden).map(node => node.querySelector('[data-aj-select]'));
    const index = visible.indexOf(event.target), next = event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length;
    event.preventDefault(); event.stopPropagation(); visible[next]?.focus();
  };
  journal.addEventListener('click',click); journal.addEventListener('keydown',keydown);
  phone.addEventListener('change',placeDetail);
  let initial = journal.querySelector('[data-aj-filter][aria-pressed="true"]').dataset.ajFilter;
  try { const saved = storage?.getItem?.(preferenceKey); if (filters.includes(saved)) initial = saved; } catch {}
  applyFilter(initial);
  placeDetail();
  return () => { journal.removeEventListener('click',click); journal.removeEventListener('keydown',keydown); phone.removeEventListener('change',placeDetail); };
}
