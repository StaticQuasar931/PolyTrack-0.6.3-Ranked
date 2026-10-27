const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const patchPath = process.env.POLYTRACK_PATCH_PATH || path.join(__dirname, '..', 'polytrack_062_patch.js');
const source = fs.readFileSync(patchPath, 'utf8');

function extract(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is present`);
  const parameters = source.indexOf('(', start);
  let parameterDepth = 0;
  let body = -1;
  for (let index = parameters; index < source.length; index += 1) {
    if (source[index] === '(') parameterDepth += 1;
    if (source[index] === ')' && --parameterDepth === 0) { body = source.indexOf('{', index); break; }
  }
  let depth = 0;
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

test('Ranked click invokes the guarded panel opener', async () => {
  let opens = 0;
  const context = vm.createContext({ openRankedPanel: () => { opens += 1; return Promise.resolve(); } });
  vm.runInContext(`${extract('handleRankedButtonClick')};`, context);
  let prevented = 0;
  let stopped = 0;
  context.handleRankedButtonClick({ preventDefault: () => { prevented += 1; }, stopPropagation: () => { stopped += 1; } });
  await Promise.resolve();
  assert.equal(opens, 1);
  assert.equal(prevented, 1);
  assert.equal(stopped, 1);
});

test('Ranked panel stays visible and shows retry when opening rejects', async () => {
  const list = { innerHTML: '' };
  const panel = { style: { display: 'none' }, querySelector: selector => selector === '#overallLeaderboardList' ? list : null };
  const logs = [];
  const context = vm.createContext({
    document: { getElementById: id => id === 'overallLeaderboardPanel' ? panel : null },
    ensurePanel: () => {},
    openPanel: async () => { throw new Error('filter render failed'); },
    log: (...args) => logs.push(args)
  });
  vm.runInContext(`${extract('rankedPanelOpenFailed')};${extract('openRankedPanel')};`, context);
  assert.equal(await context.openRankedPanel(), null);
  assert.equal(panel.style.display, 'flex');
  assert.match(list.innerHTML, /Ranked could not finish opening/);
  assert.match(list.innerHTML, /data-rank-retry/);
  assert.match(logs[0].join(' '), /filter render failed/);
});

test('throwing filter adapter is disabled without aborting leaderboard rendering', () => {
  const root = { textContent: '' };
  const logs = [];
  const context = vm.createContext({
    personalFilterRuntime: null,
    rankedFiltersUi: { update: () => { throw new Error('bad saved filter'); } },
    rankedFilterResult: { stale: true },
    rankedFiltersSyncing: false,
    document: { getElementById: id => id === 'overallFilterPanel' ? root : null },
    log: (...args) => logs.push(args)
  });
  vm.runInContext(`${extract('syncRankedFilterRows')};${extract('syncRankedFilterRowsSafely')};`, context);
  assert.equal(context.syncRankedFilterRowsSafely([]), null);
  assert.equal(context.rankedFiltersUi, null);
  assert.equal(context.rankedFilterResult, null);
  assert.equal(context.rankedFiltersSyncing, false);
  assert.equal(root.textContent, 'Saved filters are unavailable.');
  assert.match(logs[0].join(' '), /bad saved filter/);
});

test('reconciliation cannot hide Ranked through Verified-only ancestor text', () => {
  assert.doesNotMatch(source, /function hideVerifiedOnlyToggle\s*\(/);
  assert.doesNotMatch(source, /querySelectorAll\(['"]label,button,div,span['"]\)/);
  assert.doesNotMatch(extract('reconcileUiContents'), /hideVerifiedOnlyToggle/);
  assert.match(source, /function ensureNativeAllRunsDefault\s*\(/);
  assert.match(extract('decorateNativeLeaderboardCosmetics'), /ensureNativeAllRunsDefault\(host\)/);
});

test('permanent Rolling Hills search restoration clears native hidden state',()=>{
 const attributes=new Map([['aria-hidden','true']]);const card={hidden:true,style:{display:'none',removeProperty(name){if(name==='display')this.display='';}},getAttribute:name=>attributes.get(name)||null,removeAttribute:name=>attributes.delete(name)};
 const context=vm.createContext({document:{querySelector:()=>card}});vm.runInContext(`${extract('restorePermanentRollingTrack')};`,context);
 context.restorePermanentRollingTrack();assert.equal(card.hidden,false);assert.equal(card.style.display,'');assert.equal(attributes.has('aria-hidden'),false);
});
test('permanent Rolling Hills survives native search and cached rankings paint before refresh',()=>{
 assert.match(extract('restorePermanentRollingTrack'),/\.sq-featured-events \.sq-permanent-track/);
 assert.match(source,/addEventListener\('input',event=>\{[\s\S]*?\.search-bar-container input[\s\S]*?restorePermanentRollingTrack/);
 const opener=extract('openPanel');
 assert.ok(opener.indexOf('renderEntries(savedEntries,saved)')<opener.indexOf('await withTimeout(pendingEntries'));
});
test('patch UI does not expose scoring formula constants', () => {
  for (const pattern of [/Overall RP is 68%/, /20% diminishing track coverage/, /12% protected all-track depth/, /Official tracks use 1\.6x/, /1\.6x type/, /1\.0x type/, /0\.6x type/, /award 9 for first/, /100 points for each/, /base field weight/, /base multiplier is/]) {
    assert.doesNotMatch(source, pattern);
  }
  assert.match(source, /function rankedPlacementCost\(/);
  assert.match(source, /function rankedTrackWeightParts\(/);
  assert.match(source, /warning\.style\.top = '-32px'/);
});

test('Ranked render callbacks preserve a loading state before the first snapshot arrives',()=>{
 const list={innerHTML:''},panel={setAttribute(){}};
 const context=vm.createContext({document:{getElementById:id=>id==='overallLeaderboardList'?list:id==='overallLeaderboardPanel'?panel:null,querySelectorAll:()=>[]},overallCategory:'overall',overallLoadState:{status:'idle'},overallEntriesCache:[],overallPage:0,sortedOverallEntries:()=>[],syncRankedFilterRowsSafely:()=>null,updateOverallPager(){},tr:()=> 'Loading rankings',escapeHtml:String});
 vm.runInContext(extract('renderEntries'),context);
 for(const status of ['idle','loading']){context.overallLoadState={status};context.renderEntries();assert.match(list.innerHTML,/overall-loading/);assert.doesNotMatch(list.innerHTML,/unavailable|No racers|initializing/);}
 context.overallLoadState={status:'error',message:'offline'};context.renderEntries();assert.match(list.innerHTML,/temporarily unavailable/);
});

test('overall pager jumps directly and clamps first/last through bounded page state',()=>{
 let renders=0;const context=vm.createContext({overallPage:0,OVERALL_PAGE_SIZE:10,currentLeaderboardCount:()=>95,renderEntries:()=>{renders++;},flashOverallPage(){}});
 vm.runInContext(`${extract('jumpOverallPage')};`,context);
 assert.equal(context.jumpOverallPage(7),true);assert.equal(context.overallPage,6);
 assert.equal(context.jumpOverallPage(11),false);assert.equal(context.jumpOverallPage(1.5),false);
 assert.equal(context.jumpOverallPage(1),true);assert.equal(context.overallPage,0);
 assert.equal(context.jumpOverallPage(10),true,'last available page is reachable');
 assert.equal(context.overallPage,9);assert.equal(context.jumpOverallPage(11),false,'out-of-range pages are rejected');
 assert.equal(context.jumpOverallPage(9),true);assert.equal(context.overallPage,8);assert.equal(renders,4);
 assert.match(source,/id="overallFirstPage"[\s\S]*?id="overallPageJump"[\s\S]*?id="overallLastPage"/);
 assert.match(source,/event\.target\?\.id!=='overallPageJump'[\s\S]*?jumpOverallPage\(page\)/);
});

test('best finish uses relative placement and requires a meaningful loaded field weight',()=>{
 const tracks={large:{type:'official',name:'Large field'},small:{type:'community',name:'Small field'},unknown:{type:'custom',name:'Custom Track'}};
 const context=vm.createContext({
  normalizedFinishSamples:entry=>entry.finishes,
  MIN_MEANINGFUL_FINISH_WEIGHT:.2,
  knownFinishWeight:finish=>finish.weight,
  rankedPlacementCost:(rank,field)=>100*(rank-1)/Math.max(1,field-1),
  trackInfo:id=>tracks[id]||{name:'Custom Track'},
  escapeHtml:String
 });
 vm.runInContext(`${extract('rankedPlacementPercent')};${extract('bestTrackMarkup')};`,context);
 assert.ok(context.rankedPlacementPercent({rank:3,fieldSize:200})<context.rankedPlacementPercent({rank:2,fieldSize:5}));
 const summary=context.bestTrackMarkup({finishes:[
  {trackId:'small',rank:2,fieldSize:5,weight:2},
  {trackId:'large',rank:3,fieldSize:200,weight:1}
 ]});
 assert.match(summary,/<b>Best<\/b> #3 of 200/);
 assert.match(summary,/<b>Strongest<\/b>/);
 const ineligible=context.bestTrackMarkup({finishes:[
  {trackId:'small',rank:1,fieldSize:4,weight:1},
  {trackId:'small',rank:1,fieldSize:20,weight:.19}
 ]});
 assert.match(ineligible,/at least 5 racers and a track weight of 0\.2x or higher/);
 assert.doesNotMatch(ineligible,/data-track-id=/);
 const unresolved=context.bestTrackMarkup({finishes:[{trackId:'unknown',rank:1,fieldSize:20,weight:.2}]});
 assert.match(unresolved,/data-track-id="unknown" title="Open Custom Track"/);
 assert.match(unresolved,/<b>Best<\/b> #1 of 20/);
});

test('unloaded extra-track metadata never excludes profile or planner finishes',()=>{
 const opportunity=extract('profileOpportunityCandidates');
 const comparison=extract('profileComparisonRoutes');
 const planner=extract('plannerCategoryAvailability');
 for(const fn of [opportunity,comparison,planner])assert.doesNotMatch(fn,/isKnownRankedTrackId\(/);
 assert.match(source,/const cachedFinishes=cachedProfileFinishes\(entry\.userId,entry\);/);
 const opener=extract('openRankedProfile');
 const loader=extract('loadExtraTracksCatalog');
 assert.match(opener,/loadExtraTracksCatalog\(\)\.then\([\s\S]*?openRankedProfile\(userId\)/);
 assert.match(loader,/fetch\(new URL\('catalog\.json/);
 assert.doesNotMatch(loader,/db\(\)|\.collection\(/);
 assert.match(source,/name:'Custom Track', type:'custom'/);
 assert.match(source,/MIN_MEANINGFUL_FINISH_WEIGHT=\.2/);
});

test('ranked footer uses content-sized event tiles and keeps scope controls in flow',()=>{
 const context=vm.createContext({});vm.runInContext(extract('overallFooterLayoutCss'),context);
 const css=context.overallFooterLayoutCss();
 assert.match(css,/grid-template-columns:minmax\(0,1fr\) minmax\(0,\.95fr\) minmax\(0,1fr\)!important/);
 assert.match(css,/overall-challenge-stack[^}]*grid-template-columns:minmax\(0,1fr\)/);
 assert.match(css,/overall-track-scope:not\(\[hidden\]\)[^}]*position:static!important/);
 assert.match(css,/overall-track-scope\[hidden\][^}]*display:none!important/);
 assert.match(css,/competition-track-name[^}]*width:fit-content!important/);
 assert.match(css,/overall-category-control::after[^}]*content:none!important/);
 assert.match(css,/overall-freshness[^}]*width:min\(100%,360px\)!important/);
 assert.match(css,/overall-help-card[^}]*height:auto!important/);
 assert.match(css,/@media\(max-width:620px\)[\s\S]*overflow-y:auto!important/);
 const footerStyleStart=source.indexOf('rankedPolish.textContent += overallFooterLayoutCss();');
 assert.ok(footerStyleStart>=0);
 assert.ok(source.indexOf('document.head.appendChild(rankedPolish)',footerStyleStart)>footerStyleStart,'footer CSS is installed alongside subsequent scoped styles');
 for(const id of ['overallFirstPage','overallLastPage','overallPageJump'])assert.match(source,new RegExp('id="'+id+'"'));
});

test('ranking info belongs only to the info button and page count is uncluttered',()=>{
 const sync=extract('syncCategorySelect');
 assert.doesNotMatch(sync,/select\.title=|control\.dataset\.tip=/);
 assert.match(sync,/control\.removeAttribute\('data-tip'\)/);
 assert.match(sync,/info\.addEventListener\('pointerenter'/);
 const pager=extract('updateOverallPager');
 assert.match(pager,/status\.setAttribute\('aria-label'/);
 assert.doesNotMatch(pager,/status\.textContent = .*label/);
});

test('specific normalized display-name identities are blocked without catching similar handles',()=>{
 const constantsStart=source.indexOf('  const DEFAULT_NAME_BLOCKLIST');
 const constantsEnd=source.indexOf('  function readProfileMap',constantsStart);
 assert.ok(constantsStart>=0&&constantsEnd>constantsStart);
 const context=vm.createContext({});
 vm.runInContext(`${source.slice(constantsStart,constantsEnd)};${extract('sanitizeDisplayName')};${extract('normalizeNameForCheck')};${extract('moderationDecision')};`,context);
 for(const name of ['Kim Jong Un','K1m J0ng Un','Ngrachio445','Ngr4chi0445','Nigervaan','N1g3rv44n','Stephen Hawking','St3ph3n H4wk1ng'])
   assert.equal(context.moderationDecision(name).reason,'blocked-name-identity',`${name} should normalize to the explicit blocked identity`);
 for(const name of ['BLACKBEAUTY','CheatingMiguel'])assert.equal(context.moderationDecision(name).blocked,false,`${name} remains allowed`);
});

test('info explanation stays in the viewport and accounts for panel transforms',()=>{
 const styles={};let transformed=false;
 const copy={style:{setProperty:(key,value)=>styles[key]=value},getBoundingClientRect:()=>({height:110})};
 const info={getBoundingClientRect:()=>({right:330,top:280})};
 const shell={getBoundingClientRect:()=>({left:40,top:20})};
 const control={querySelector:key=>key==='[data-category-info]'?info:copy,closest:()=>shell};
 const ctx=vm.createContext({window:{innerWidth:360},getComputedStyle:()=>({transform:transformed?'matrix(1,0,0,1,0,0)':'none'})});
 vm.runInContext(extract('positionRankedCategoryDescription'),ctx);
 ctx.positionRankedCategoryDescription(control);assert.equal(styles.width,'336px');assert.equal(styles.left,'12px');assert.equal(styles.top,'160px');
 transformed=true;ctx.positionRankedCategoryDescription(control);assert.equal(styles.left,'-28px');assert.equal(styles.top,'140px');
});

test('footer controls explicitly neutralize legacy flex growth in the column layout',()=>{
 const ctx=vm.createContext({});vm.runInContext(extract('overallFooterLayoutCss'),ctx);const css=ctx.overallFooterLayoutCss();
 const refresh=css.match(/#overallLeaderboardPanel #overallDailyGrid \.overall-freshness\{([^}]+)\}/)[1];
 assert.match(refresh,/flex:0 0 auto!important/);
 assert.match(refresh,/height:auto!important/);
 assert.match(refresh,/font:18px\/1\.25 ForcedSquare,sans-serif!important/);
 const pager=css.match(/#overallLeaderboardPanel #overallDailyGrid \.overall-pager\{([^}]+)\}/)[1];assert.match(pager,/flex:0 0 auto!important/);
 assert.match(css,/competition-result[^}]*text-align:left!important/);
 assert.match(css,/section>small[^}]*border:0!important/);
});

test('compact event captions follow the original horizontal layout and pagination remains bounded',()=>{
 const ctx=vm.createContext({});vm.runInContext(extract('overallFooterLayoutCss'),ctx);const css=ctx.overallFooterLayoutCss();
 const result=css.match(/#overallLeaderboardPanel #overallDailyGrid \.competition-result\{([^}]+)\}/)[1];
 assert.match(result,/align-self:flex-start!important/);assert.match(result,/text-align:left!important/);
 const pager=css.match(/#overallLeaderboardPanel #overallDailyGrid \.overall-pager\{([^}]+)\}/)[1];
 assert.match(pager,/width:fit-content!important/);assert.match(pager,/align-self:center!important/);assert.match(pager,/max-width:100%!important/);
});

test('the three footer groups own visible panel borders and highlight states',()=>{
 const ctx=vm.createContext({});vm.runInContext(extract('overallFooterLayoutCss'),ctx);const css=ctx.overallFooterLayoutCss();
 assert.match(css,/overallDailyGrid>div[^}]*background:#20345f!important;border:1px solid #5776a2!important/);
 assert.match(css,/overall-center-tools[^}]*justify-content:center!important/);
 assert.match(css,/overall-footer-right[^}]*justify-content:center!important/);
 assert.match(css,/aria-pressed="true"[^}]*background:#80def5!important/);
 assert.match(css,/focus-visible[^}]*outline:2px solid/);
});
test('event footer reset labels use local dates without repeating UTC',()=>{
 const fn=extract('resetTimeMarkup');assert.doesNotMatch(fn,/00:00 UTC|Local<\/strong>/);assert.match(fn,/Resets<br>/);
 const events=fs.readFileSync(path.join(__dirname,'..','events','client.mjs'),'utf8');
 const start=events.indexOf("const note=card.querySelector(':scope > small')");const note=events.slice(start,events.indexOf("button.removeAttribute('aria-disabled')",start));
 assert.match(note,/document.createTextNode\('Resets'\)/);assert.doesNotMatch(note,/timeZone:'UTC'/);
});

test('favorite ranking buttons mark the active category for visible highlighting',()=>{
 const ctx=vm.createContext({readJsonStorage:()=>({overall:3,tracks:2}),LEADERBOARD_USAGE_KEY:'usage',LEADERBOARD_LABELS:{overall:'Overall RP',tracks:'Tracks completed'},overallCategory:'overall',escapeHtml:String});
 vm.runInContext(extract('leaderboardArcadeMarkup'),ctx);
 assert.match(ctx.leaderboardArcadeMarkup(),/class="selected" aria-pressed="true" data-leaderboard-shortcut="overall"/);
 ctx.overallCategory='community';assert.match(ctx.leaderboardArcadeMarkup(),/class="selected" aria-pressed="true" data-leaderboard-shortcut="tracks"/);
});

test('favorite rankings form two equal columns with shortcut numbers and usage tooltips',()=>{
 const ctx=vm.createContext({readJsonStorage:()=>({overall:3,tracks:2,playtime:1,average:1}),LEADERBOARD_USAGE_KEY:'usage',LEADERBOARD_LABELS:{overall:'Overall RP',tracks:'Tracks completed',playtime:'Active time',average:'Average place'},overallCategory:'overall',escapeHtml:String});
 vm.runInContext(extract('overallFooterLayoutCss')+';'+extract('leaderboardArcadeMarkup'),ctx);
 const css=ctx.overallFooterLayoutCss();assert.match(css,/leaderboard-arcade>div[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)!important/);
 assert.match(css,/leaderboard-arcade button[^}]*min-height:40px!important/);
 assert.equal((ctx.leaderboardArcadeMarkup().match(/data-leaderboard-shortcut=/g)||[]).length,4);
 assert.match(ctx.leaderboardArcadeMarkup(),/<small aria-hidden="true">3<\/small>/);
 assert.match(ctx.leaderboardArcadeMarkup(),/title="Opened 3 times on this device"/);
 assert.match(ctx.leaderboardArcadeMarkup(),/aria-keyshortcuts="4"/);
});

test('completion scope offers All, Extra only and Without Extra while hiding outside completed tracks',()=>{
 const buttons=['all','extra','no-extra'].map(trackScope=>({dataset:{trackScope},active:false,pressed:'false',classList:{toggle(name,value){if(name==='active')this.owner.active=value;},owner:null},setAttribute(name,value){if(name==='aria-pressed')this.pressed=value;}}));
 buttons.forEach(button=>{button.classList.owner=button;});
 const scope={hidden:false,querySelectorAll:()=>buttons};
 const panel={querySelector:selector=>selector==='#overallTrackScope'?scope:null};
 const context=vm.createContext({overallCompletionScope:'no-extra'});
 vm.runInContext(extract('syncOverallRankingScope')+';'+extract('syncOverallTrackScope'),context);
 context.syncOverallTrackScope(panel,'tracks');assert.equal(scope.hidden,false);assert.deepEqual(buttons.map(button=>button.pressed),['false','false','true']);
 context.syncOverallTrackScope(panel,'overall');assert.equal(scope.hidden,true);assert.deepEqual(buttons.map(button=>button.pressed),['false','false','false']);
 context.overallCompletionScope='all';context.syncOverallTrackScope(panel,'tracks');assert.equal(scope.hidden,false);assert.deepEqual(buttons.map(button=>button.pressed),['true','false','false']);
 assert.match(extract('setOverallCategory'),/syncOverallTrackScope\(panel,selected\)/);
 assert.match(extract('handleRankedFilterChange'),/syncOverallTrackScope\(document\.getElementById\('overallLeaderboardPanel'\),category\)/);
 assert.match(source,/if\(leaderboardShortcut\)\{setOverallCategory\(leaderboardShortcut\.dataset\.leaderboardShortcut\);return;\}/);
});

test('completion scopes exclude Extra exactly once and retain missing-count uncertainty',()=>{
 const context=vm.createContext({overallCompletionScope:'all',PINNED_EXTRA_TRACK_IDS:new Set(['extra']),extraTrackInfoById:new Map()});
 vm.runInContext(extract('completedTrackCount'),context);
 const row={raceCount:24,officialCount:17,communityCount:3,customCount:4,extraCount:3};
 assert.equal(context.completedTrackCount(row),24);
 assert.equal(context.completedTrackCount(row,'extra'),3);
 assert.equal(context.completedTrackCount(row,'no-extra'),21);
 assert.equal(context.completedTrackCount({raceCount:17},'extra'),null);
 assert.equal(context.completedTrackCount({raceCount:17,extraCount:0},'extra'),0);
 assert.equal(context.completedTrackCount({...row,groupResults:[{trackId:'extra'},{trackId:'official'}],raceCount:2},'extra'),1);
});

test('Extra completion labels preserve counts above two without counting them as community',()=>{
 const context=vm.createContext({});vm.runInContext(`${extract('rankedTrackParticipationCounts')};${extract('compactParticipationMeta')};`,context);
 const onlyExtra=context.compactParticipationMeta({officialCount:0,communityCount:0,customCount:4,extraCount:4},4,'tracks');
 assert.match(onlyExtra,/>4 Extra tracks</);assert.doesNotMatch(onlyExtra,/community/);
 const mixed=context.compactParticipationMeta({officialCount:2,communityCount:1,customCount:4,extraCount:3},7,'tracks');
 assert.match(mixed,/1 community/);assert.match(mixed,/3 Extra tracks/);assert.match(mixed,/1 other custom/);
 assert.deepEqual(JSON.parse(JSON.stringify(context.rankedTrackParticipationCounts({customCount:4,extraCount:3}))),{official:0,community:0,extra:3,otherCustom:1});
});

test('footer counts distinguish loaded standings from estimated totals and do not read the cloud',()=>{
 const fn=extract('updateOverallPager');assert.match(fn,/racers shown/);assert.doesNotMatch(fn,/estimated\?'~'/);assert.match(fn,/tracks listed/);assert.doesNotMatch(fn,/fetch\(|db\(|\.collection\(/);
 const cssCtx=vm.createContext({});vm.runInContext(extract('overallFooterLayoutCss'),cssCtx);const css=cssCtx.overallFooterLayoutCss();
 assert.match(css,/overall-category-description[^}]*background:#355181!important/);
 assert.match(css,/section:has\(\.competition-feature-button:hover\)/);
 assert.match(source,/aria-label',\x60Explain \$\{label\}/);
});

test('visible footer totals remain honest for partial, filtered, and track views',()=>{
 const summary={};let count=200;
 const ctx=vm.createContext({document:{getElementById:id=>id==='overallFieldSummary'?summary:null},currentLeaderboardCount:()=>count,OVERALL_PAGE_SIZE:15,overallPage:0,overallCategory:'overall',LEADERBOARD_LABELS:{overall:'Overall RP'},rankedFilterResult:null,rankedFilterSnapshotMeta:{totalEntries:404,totalEntriesExact:false},syncCategorySelect(){}});
 vm.runInContext(extract('updateOverallPager'),ctx);ctx.updateOverallPager();assert.equal(summary.textContent,'200 racers shown');
 ctx.rankedFilterSnapshotMeta.totalEntriesExact=true;ctx.updateOverallPager();assert.equal(summary.textContent,'200 racers shown');
 count=22;ctx.rankedFilterResult={available:true,filter:{category:'overall'},filteredCount:22,sourceCount:200};ctx.updateOverallPager();assert.equal(summary.textContent,'22 racers shown');
 count=51;ctx.overallCategory='topTracks';ctx.updateOverallPager();assert.equal(summary.textContent,'51 tracks listed');
 ctx.overallCategory='events';ctx.updateOverallPager();assert.equal(summary.textContent,'51 racers shown');
});

test('event click targets cover the complete row and dropdown arrows have their own right-aligned graphic',()=>{
 const ctx=vm.createContext({});vm.runInContext(extract('overallFooterLayoutCss'),ctx);const css=ctx.overallFooterLayoutCss();
 assert.match(css,/competition-feature-button::after[^}]*inset:0/);
 assert.match(css,/competition-feature-button[^}]*position:static!important/);
 assert.match(css,/sq-category-chevron[^}]*margin-left:auto!important/);
 assert.match(extract('ensureRankedCategoryPicker'),/aria-hidden="true" focusable="false"/);
});
test('portrait track-selection layout does not override native hidden state',()=>{
 const trackRule=source.match(/\\n\.menu-ui>\.track-selection-ui:not\(\.hidden\):not\(\[hidden\]\)\{([^}]*)\}/);
 const infoRule=source.match(/\\n\s*\.menu-ui>\.track-info-ui:not\(\.hidden\):not\(\[hidden\]\)\{([^}]*)\}/);
 const settingsRule=source.match(/\\n\.menu-ui>\.settings-menu-ui:not\(\.hidden\):not\(\[hidden\]\)\{([^}]*)\}/);
 for(const [rule,name] of [[trackRule,'track selection'],[infoRule,'track info'],[settingsRule,'settings']]){
  assert.ok(rule,`${name} active-state layout is present`);
  assert.match(rule[1],/display:flex(?:;|$)/);
  assert.doesNotMatch(rule[1],/display:flex!important/);
 }
 for(const selector of ['track-selection-ui','track-info-ui','settings-menu-ui'])
  assert.match(source,new RegExp(`body>div:has\\(>\\.menu-ui>\\.${selector}:not\\(\\.hidden\\):not\\(\\[hidden\\]\\)\\)`));
});
test('ranked category popup is bounded and scrollable on short viewports',()=>{
 const position=extract('openRankedCategoryMenu');
 assert.ok(position.includes("menu.style.maxHeight=Math.max(0,innerHeight-16)+'px'"));
 assert.ok(position.includes("menu.style.overflowY='auto'"));
 assert.ok(position.includes("menu.style.overscrollBehavior='contain'"));
 assert.ok(position.indexOf("menu.style.maxHeight=")<position.indexOf('menu.style.top='),'popup is height-bounded before vertical placement');
});

test('manual refresh is bounded while requests are in flight and during failure cooldowns',async()=>{
 let now=1000000,calls=0,finish;const timers=[];
 const ctx=vm.createContext({Date:{now:()=>now},lastRankedManualRefreshAt:0,RANKED_MANUAL_REFRESH_COOLDOWN_MS:120000,rankedManualRefreshFailed:false,rankedRefreshCooldownTimer:0,overallCategory:'overall',overallLoadState:{status:'cache'},snapshotOnlyForNewAccount:()=>false,updateRankedFreshness(){},clearTimeout(){},setTimeout:(fn)=>{timers.push(fn);return timers.length;},writeJsonStorage(){},OVERALL_REBUILD_BACKOFF_KEY:'key',openRankedPanel:()=>{calls++;ctx.overallLoadState.status='loading';return new Promise(resolve=>finish=resolve);}});
 vm.runInContext(extract('requestRankedRefresh'),ctx);
 ctx.requestRankedRefresh();ctx.requestRankedRefresh();assert.equal(calls,1);
 ctx.overallLoadState.status='stale';finish();await new Promise(resolve=>setImmediate(resolve));assert.equal(ctx.rankedManualRefreshFailed,true);
 now+=119999;ctx.requestRankedRefresh();assert.equal(calls,1);
 now+=1;ctx.requestRankedRefresh();assert.equal(calls,2);
});
test('button state preserves snapshot age and identifies a failed static check',()=>{
 const button={dataset:{},setAttribute(){},style:{}};
 const ctx=vm.createContext({document:{getElementById:id=>id==='overallFreshness'?button:null},overallCategory:'overall',overallLoadState:{status:'stale',serverUpdatedAt:1000,checkedAt:2000},rankedManualRefreshFailed:true,Date:{now:()=>10000},lastRankedManualRefreshAt:0,readOverallSnapshotCache:()=>({source:'public-backup',snapshotCapturedAt:3000}),publicSnapshotCapturedAt:9000,publicSnapshotPublishedAt:3000,ageLabel:at=> {assert.equal(at,3000);return '3h ago';},durationLabel:()=> '2m',snapshotOnlyForNewAccount:()=>false,snapshotCaptureLabel:()=> 'Snapshot captured 3h ago',syncSnapshotRefreshControl(){},applyRankedRefreshCooldown(){},
  localOverallReader:null,localOverallState:null});
 vm.runInContext(extract('localCasualIsVisible')+';'+extract('currentLocalCasualResult')+';'+extract('rankedFreshnessText')+'\n'+extract('updateRankedFreshness'),ctx);ctx.updateRankedFreshness();assert.equal(button.dataset.source,'snapshot');assert.equal(button.textContent,'Snapshot package · 3h old · Check failed');
 ctx.overallLoadState.status='snapshot';ctx.rankedManualRefreshFailed=false;ctx.updateRankedFreshness();assert.equal(button.dataset.source,'snapshot');assert.equal(button.textContent,'Snapshot package · 3h old');
});

test('non-track rankings combine community and custom without double-counting Extra',()=>{
 const context=vm.createContext({});vm.runInContext(`${extract('rankedTrackParticipationCounts')};${extract('compactParticipationMeta')};`,context);
 const row={officialCount:16,communityCount:3,customCount:5,extraCount:3};
 for(const category of ['overall','average','skill','playtime','casual','wins']){
   const text=context.compactParticipationMeta(row,24,category);
   assert.equal(text,'<span>16 official</span><span>8 other</span>');
   assert.doesNotMatch(text,/community|Extra|custom/);
 }
 assert.equal(context.compactParticipationMeta({customCount:4,extraCount:4},4),'<span>4 other</span>');
 assert.equal(context.compactParticipationMeta({officialCount:17},17),'<span>17 official</span>');
 assert.ok(source.includes('compactParticipationMeta(row,races,overallCategory)'));
});
