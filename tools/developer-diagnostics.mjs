import {serializeDiagnosticReport} from './diagnostic-codec.mjs';
import {normalizeControlUsage} from './control-usage.mjs';
import {summarizeClientUsage} from './diagnostics-usage.mjs';
const finite = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
const positiveInt = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const cleanText = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 100);
const hash = value => /^[a-f0-9]{64}$/.test(value || '');
const publicIdPattern = /^[A-Za-z0-9_-]{1,256}$/;
const numbers = ['activeTimeVersion', 'activeMs', 'simulatedMs', 'sincePbMs', 'attempts', 'finishes', 'pbs', 'restarts', 'restartsSincePb', 'respawns', 'lastPlayedAt', 'lastPbAt', 'trackingStartedAt', 'legacyActiveMs', 'furthestCheckpoint', 'bestMs', 'improvedMs', 'focusedMs', 'pausedMs', 'hiddenMs', 'movingMs', 'longestHuntMs', 'biggestImprovementMs', 'biggestObservedImprovementMs', 'biggestPbImprovementMs', 'trackedBestMs', 'lastObservedFinishMs', 'lastObservedFinishAt', 'motionObservedMs', 'stationaryMs', 'progressingMs', 'idleMs', 'unobservedGapMs', 'observationVersion', 'observedStartedAt'];
const resultNumbers = ['timeMs', 'rank', 'fieldSize', 'weight', 'cachedAt', 'snapshotCapturedAt'];
const settingNames = new Set(['music', 'sound', 'showFps', 'showGhost', 'cameraShake', 'sensitivity', 'volume', 'fov', 'renderDistance', 'resolutionScale', 'graphics', 'shadows', 'antialiasing', 'uiTextScale', 'compactTrackPanel', 'plannerCurrentOnly', 'plannerOfficialOnly']);
const insightSources = ['planner', 'profile', 'leaderboard', 'event', 'selection', 'unknown'];

const selectNumbers = (row, fields) => Object.fromEntries(fields.map(key => [key, finite(row?.[key])]));
function roundExportMilliseconds(value,key=''){
 if(typeof value==='number')return key.endsWith('Ms')&&Number.isFinite(value)?Math.round(value):value;
 if(Array.isArray(value))return value.map(item=>roundExportMilliseconds(item));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([name,item])=>[name,roundExportMilliseconds(item,name)]));
 return value;
}
// A previous storage loader confused epoch dates with capped durations.
// Do not substitute a last-played/PB date for a finish whose date was lost.
const recentPracticeFinishes = row => (Array.isArray(row?.recentFinishes) ? row.recentFinishes : []).slice(-8)
 .filter(run => run && Number.isFinite(run.timeMs) && run.timeMs > 0 && run.timeMs <= 315576000000)
 .map(run => ({ at: Number.isFinite(run.at) && run.at >= 0 && run.at <= Date.now() && run.at !== 315576000000 ? run.at : 0, timeMs: run.timeMs, practiceMs: Math.min(315576000000, finite(run.practiceMs)), timingNote: run.timingNote === true }));
const opaqueId = value => typeof value === 'string' && value.length <= 256 && publicIdPattern.test(value) ? value : '';
const sanitizeResult = row => ({
 trackId: hash(row?.trackId) ? row.trackId : '',
 ...Object.fromEntries(resultNumbers.map(key => [key, key === 'rank' || key === 'fieldSize' ? positiveInt(row?.[key]) : key === 'weight' ? (typeof row?.weight === 'number' && Number.isFinite(row.weight) ? row.weight : null) : finite(row?.[key])])),
 runVerified: typeof row?.runVerified === 'boolean' ? row.runVerified : null,
 integrityVerified: typeof row?.integrityVerified === 'boolean' ? row.integrityVerified : null,
 local: row?.local === true,
 placementKnown: positiveInt(row?.rank) !== null && positiveInt(row?.fieldSize) !== null && Number(row.fieldSize) >= Number(row.rank)
});

function sanitizeInsights(insights) {
 if (!insights || insights.version !== 1) return null;
 const revisions = Array.isArray(insights.revisions) ? insights.revisions.slice(-32).filter(row => Number.isSafeInteger(row?.revision) && row.revision >= 0).map(row => ({ revision: row.revision, firstAt: finite(row.firstAt), lastAt: finite(row.lastAt), visits: finite(row.visits), visibleMs: finite(row.visibleMs) })) : [];
 const tracks = {};
 for (const [id, row] of Object.entries(insights.tracks || {}).filter(([id]) => hash(id)).slice(0, 256)) tracks[id] = { plays: finite(row?.plays), lastAt: finite(row?.lastAt), sources: Object.fromEntries(insightSources.map(source => [source, finite(row?.sources?.[source])])) };
 const transitions = {};
 for (const [key, count] of Object.entries(insights.transitions || {}).filter(([key]) => /^[a-f0-9]{64}:[a-f0-9]{64}$/.test(key)).slice(0, 512)) transitions[key] = finite(count);
 const metrics = {};
 for (const [key, row] of Object.entries(insights.metrics || {}).filter(([key]) => /^[A-Z0-9_-]{1,32}$/.test(key)).slice(0, 32)) metrics[key] = { count: finite(row?.count), totalMs: finite(row?.totalMs), maxMs: finite(row?.maxMs), over5s: finite(row?.over5s), over30s: finite(row?.over30s), averageMs: finite(row?.averageMs), over5sPercent: finite(row?.over5sPercent), over30sPercent: finite(row?.over30sPercent) };
 const actions = Object.fromEntries(Object.entries(insights.actions || {}).filter(([key]) => /^[a-z-]{1,32}$/.test(key)).slice(0, 32).map(([key, value]) => [key, finite(value)]));
 return { version: 1, scope: 'This browser device; navigation and version observations may span local racer profiles', startedAt: finite(insights.startedAt), latencyCapMs: insights.latencyCapMs === 30000 ? 30000 : null, revisions, tracks, transitions, metrics, actions, controls:normalizeControlUsage(insights.controls) };
}

function practiceEvidence(row){
 const p=row?.firstPlacement,h=row?.hunt;
 return {firstPlacement:p&&Number.isSafeInteger(p.rank)&&p.rank>0&&Number.isSafeInteger(p.total)&&p.total>=p.rank&&p.exact===true&&p.complete===true&&p.authoritative===true?{...selectNumbers(p,['rank','total','at','timeMs','finishedAt']),exact:true,complete:true,authoritative:true}:null,
 hunt:h?selectNumbers(h,['startedAt','lastMovingAt','movingMs']):null};
}
function summarizePractice(practice) {
 const rows = Array.isArray(practice) ? practice.slice(0, 256) : [];
 return {
  activeMs: rows.reduce((sum, row) => sum + finite(row.activeMs), 0),
  starts: rows.reduce((sum, row) => sum + finite(row.attempts), 0),
  finishes: rows.reduce((sum, row) => sum + finite(row.finishes), 0),
  resets: rows.reduce((sum, row) => sum + finite(row.restarts) + finite(row.respawns), 0),
  tracksNeverFinished: rows.filter(row => finite(row.attempts) > 0 && finite(row.finishes) === 0).length,
  timingNotes: rows.reduce((sum, row) => sum + (Array.isArray(row.recentFinishes) ? row.recentFinishes.filter(run => run?.timingNote === true).length : 0), 0)
 };
}

export function buildDeveloperReport({ practice = [], coverage = null, finishes = [], localResults = [], snapshot = {}, events = [], viewport = {}, publicId = '', includePublicId = false, includeSavedTrackCodes, clientRevision = 156, insights = null, extraTracks = [], settings = null, localData = null } = {}) {
 const rows = Array.isArray(practice) ? practice.slice(0, 256) : [];
 const localRows = Array.isArray(localResults) ? localResults : [];
 const trackRows = Array.isArray(extraTracks) ? extraTracks : [];
 const profileRows = Array.isArray(localData?.profiles) ? localData.profiles : [];
 const localTrackRows = Array.isArray(localData?.tracks) ? localData.tracks : [];
 const localPracticeRows = Array.isArray(localData?.practice) ? localData.practice : [];
 const savedTrackRows = Array.isArray(localData?.savedTracks) ? localData.savedTracks : [];
 const includesLocalData = includePublicId === true || includePublicId?.includePublicId === true;
 // A boolean true keeps the historical full-export API; the dialog passes explicit choices.
 const codeChoice = typeof includeSavedTrackCodes === 'boolean' ? includeSavedTrackCodes :
  typeof includePublicId === 'object' ? includePublicId?.includeSavedTrackCodes === true : includePublicId === true;
 const includesSavedTrackCodes = includesLocalData && codeChoice;
 const sanitizedSettings = settings && typeof settings === 'object' ? Object.fromEntries(Object.entries(settings).filter(([key]) => settingNames.has(key)).filter(([, value]) => typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))).slice(0, settingNames.size)) : null;
 const report={
  schema: 'polytrack-developer-diagnostics-v1', revision: finite(clientRevision), diagnosticsRevision: 158, exportedAt: new Date().toISOString(),
  privacy: { automaticUpload: false, includesPublicId: includesLocalData && (hash(publicId) || profileRows.some(row => opaqueId(row?.publicId || row?.accountId))), includesLocalProfiles: includesLocalData, includesSavedTrackCodes, limitations: 'Client observations are incomplete and untrusted. Timing notes are not cheating verdicts. Practice coverage is partial and does not imply legacy playtime was tracked. Request events are not billed Firebase operations.' },
  ...(includesLocalData && hash(publicId) ? { publicRacerId: publicId } : {}),
  snapshot: { generation: finite(snapshot.generation), capturedAt: finite(snapshot.capturedAt) },
  viewport: {...selectNumbers(viewport, ['width', 'height', 'pixelRatio']),
    ...Object.fromEntries(['clientWidth','clientHeight','visualWidth','visualHeight','visualLeft','visualTop','visualScale','scrollX','scrollY']
      .filter(key=>typeof viewport?.[key]==='number'&&Number.isFinite(viewport[key])&&Math.abs(viewport[key])<=1000000)
      .map(key=>[key,Math.round(viewport[key]*100)/100]))},
  practiceCoverage: coverage ? { version: 2, scope: 'Known reported/device visible-time estimate, not full historical driving coverage', ...selectNumbers(coverage, ['startedAt', 'baselinePlaytimeMs', 'knownPlaytimeMs', 'observedVisibleMs', 'coverageFraction']) } : null,
  practice: rows.map(row => ({ trackId: hash(row.trackId) ? row.trackId : '', trackName: cleanText(row.trackName), ...selectNumbers(row, numbers), ...practiceEvidence(row), resetTimingBuckets: Array.from({ length: 4 }, (_, i) => finite(row.restartBuckets?.[i])), recentFinishes: recentPracticeFinishes(row) })),
  loadedResults: (Array.isArray(finishes) ? finishes : []).slice(0, 256).map(sanitizeResult),
  localResults: localRows.slice(0, 5000).map(sanitizeResult),
  insights: sanitizeInsights(insights),
  firebaseUsage:summarizeClientUsage(insights?.clientUsage),
  savedTrackSummary: { count: finite(localData?.collection?.savedTrackCount ?? savedTrackRows.length), bytes: finite(localData?.collection?.savedTrackBytes ?? savedTrackRows.reduce((sum, row) => sum + (typeof row?.data === 'string' ? new TextEncoder().encode(row.data).length : 0), 0)) },
  extraTracks: trackRows.slice(0, 5000).map(row => ({ trackId: opaqueId(row?.trackId ?? row?.id), name: cleanText(row?.name), author: cleanText(row?.author) })),
  localData: includesLocalData ? {
   profiles: profileRows.map(row => ({ publicId: opaqueId(row?.publicId ?? row?.accountId), name: cleanText(row?.name ?? row?.nickname), carStyle: cleanText(row?.carStyle), countryCode: cleanText(row?.countryCode), carColors: Array.isArray(row?.carColors) ? row.carColors.slice(0, 16).map(value => cleanText(value)) : cleanText(row?.carColors), cosmetics: row?.cosmetics && typeof row.cosmetics === 'object' ? Object.fromEntries(Object.entries(row.cosmetics).filter(([key, value]) => /^[a-zA-Z0-9_-]{1,40}$/.test(key) && !/(token|auth|credential|password|secret|socket|uid|email|replay|connection)/i.test(key) && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')).slice(0, 64).map(([key, value]) => [key, typeof value === 'string' ? cleanText(value) : value])) : null, playtimeMs: finite(row?.playtimeMs), personalBests: (Array.isArray(row?.personalBests) ? row.personalBests : []).map(pb => ({ trackId: opaqueId(pb?.trackId), trackName: cleanText(pb?.trackName), timeMs: finite(pb?.timeMs), frames: finite(pb?.frames), achievedAt: finite(pb?.achievedAt), mode: ['default','undeterministic'].includes(pb?.mode)?pb.mode:'default' })) })),
   collection: localData?.collection?{...selectNumbers(localData.collection,['blockedReads','nativeProfiles','profileCount','pbCount','savedTrackCount','savedTrackBytes']),scope:cleanText(localData.collection.scope)}:null,
   savedTracks: savedTrackRows.map(row => ({ name: cleanText(row?.name), savedAt: finite(row?.savedAt), bytes: finite(row?.bytes ?? (typeof row?.data === 'string' ? new TextEncoder().encode(row.data).length : 0)), ...(includesSavedTrackCodes ? { data: typeof row?.data === 'string' ? row.data : null } : {}) })),
   tracks: localTrackRows.map(row => ({ trackId: opaqueId(row?.trackId ?? row?.id), name: cleanText(row?.name), author: cleanText(row?.author), source: cleanText(row?.source), official: typeof row?.official === 'boolean' ? row.official : null })),
   practice: localPracticeRows.map(row => ({ publicId: opaqueId(row?.publicId), trackId: opaqueId(row?.trackId), trackName: cleanText(row?.trackName), ...selectNumbers(row, numbers), ...practiceEvidence(row), resetTimingBuckets: Array.from({ length: 4 }, (_, i) => finite(row?.restartBuckets?.[i])), recentFinishes: recentPracticeFinishes(row) }))
  } : null,
  truncation: {
   localResults: { omitted: Math.max(0, localRows.length - 5000) },
   extraTracks: { omitted: Math.max(0, trackRows.length - 5000) },
   localProfiles: { omitted: includesLocalData ? 0 : profileRows.length },
   localPersonalBests: { omitted: includesLocalData ? 0 : profileRows.reduce((sum,row)=>sum+(Array.isArray(row?.personalBests)?row.personalBests.length:0),0) },
   localTracks: { omitted: includesLocalData ? 0 : localTrackRows.length },
   localPractice: { omitted: includesLocalData ? 0 : localPracticeRows.length }
  },
  settings: sanitizedSettings,
  practiceSummary: summarizePractice(rows),
  recentEvents: (Array.isArray(events) ? events : []).slice(-80).map(row => ({ category: /^[a-z-]{1,32}$/.test(row?.category) ? row.category : 'application', code: /^[A-Z0-9_-]{1,32}$/.test(row?.code) ? row.code : 'EVENT', durationMs: finite(row?.durationMs), status: finite(row?.status) }))
 };
 const exported=roundExportMilliseconds(report);
 exported.practiceSummary.activeMs=exported.practice.reduce((sum,row)=>sum+row.activeMs,0);
 return exported;
}

export function openDiagnostics({ report, returnFocus = document.activeElement } = {}) {
 document.getElementById('polytrackDeveloperDialog')?.remove();
 const dialog = document.createElement('dialog'); dialog.id = 'polytrackDeveloperDialog'; dialog.className = 'sq-developer-dialog';
 dialog.innerHTML = '<header><h2>Export developer diagnostics</h2><button type="button" data-close aria-label="Close developer diagnostics">Close</button></header><main><p>Copy or download a report. Nothing uploads automatically.</p><label><input type="checkbox" data-public-id checked> Include local profiles, public IDs and PBs</label><details><summary>More export options</summary><p>Saved-track metadata is included. Private track codes are off by default and may reveal tracks.</p><label><input type="checkbox" data-saved-codes disabled> Include saved track codes</label><label><input type="checkbox" data-readable-json> Readable JSON (larger, legacy format)</label><p>Compact JSON is smaller, not encrypted. Developers can decode it. Credentials are excluded.</p></details><p role="status" aria-live="polite" data-status></p></main><footer><button type="button" data-download>Download JSON</button><button type="button" data-copy>Copy JSON</button></footer>';
 const status = dialog.querySelector('[data-status]');
 const profileChoice=dialog.querySelector('[data-public-id]'),codesChoice=dialog.querySelector('[data-saved-codes]');
 codesChoice.disabled=!profileChoice.checked;
 const readableChoice=dialog.querySelector('[data-readable-json]');
 const makeJson = () => serializeDiagnosticReport(report(profileChoice.checked ? {includePublicId:true,includeSavedTrackCodes:codesChoice.checked} : false),{format:readableChoice.checked?'json':'compact'});
 const changed = () => {const button=dialog.querySelector('[data-copy]');button.classList.remove('is-success');button.textContent='Copy JSON';status.textContent='Export options changed. Copy again to update the clipboard.';};
 profileChoice.addEventListener('change',()=>{codesChoice.disabled=!profileChoice.checked;if(codesChoice.disabled)codesChoice.checked=false;changed();});
 codesChoice.addEventListener('change',changed);
 readableChoice.addEventListener('change',changed);
 const close = () => dialog.close();
 dialog.querySelector('[data-close]').addEventListener('click', close);
 dialog.addEventListener('close', () => { dialog.remove(); if (returnFocus?.isConnected && !returnFocus.disabled) returnFocus.focus({ preventScroll: true }); });
 dialog.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation(); });
 dialog.querySelector('[data-copy]').addEventListener('click', async event => {
  const button = event.currentTarget;
  try { await navigator.clipboard.writeText(makeJson()); button.classList.add('is-success'); button.textContent = 'Copied'; status.textContent = 'Copied. Review the JSON before sharing.'; }
  catch { button.classList.remove('is-success'); button.textContent = 'Copy JSON'; status.textContent = 'Copy failed. Use Download JSON instead.'; }
 });
 dialog.querySelector('[data-download]').addEventListener('click', () => {
  try { const blob = new Blob([makeJson()], { type: 'application/json' }), url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = 'polytrack-developer-report-' + new Date().toISOString().slice(0, 10) + '.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000); status.textContent = 'Downloaded. Review the JSON before sharing.'; }
  catch { status.textContent = 'Download failed. Try Copy JSON instead.'; }
 });
 document.body.append(dialog); dialog.showModal();
}

export function openClearPracticeConfirmation({ onConfirm, returnFocus = document.activeElement } = {}) {
 document.getElementById('polytrackClearPracticeDialog')?.remove();
 const dialog = document.createElement('dialog'); dialog.id = 'polytrackClearPracticeDialog'; dialog.className = 'sq-developer-dialog';
 dialog.innerHTML = '<form method="dialog"><header><h2>Clear practice history?</h2><button type="button" data-close aria-label="Close clear practice confirmation">Close</button></header><main><p>This permanently clears local practice history. Type CLEAR to enable confirmation.</p><label for="polytrackClearPracticeInput">Type CLEAR</label><input id="polytrackClearPracticeInput" data-confirmation autocomplete="off"><p role="status" aria-live="polite" data-status></p></main><footer><button type="button" data-cancel>Cancel</button><button type="submit" data-confirm disabled>Clear practice</button></footer></form>';
 const input = dialog.querySelector('[data-confirmation]'), confirm = dialog.querySelector('[data-confirm]'), status = dialog.querySelector('[data-status]');
 const dismiss = () => dialog.close();
 input.addEventListener('input', () => { confirm.disabled = input.value !== 'CLEAR'; status.textContent = confirm.disabled ? 'Confirmation remains disabled until CLEAR is entered exactly.' : ''; });
 dialog.querySelector('[data-close]').addEventListener('click', dismiss); dialog.querySelector('[data-cancel]').addEventListener('click', dismiss);
 dialog.querySelector('form').addEventListener('submit', event => { event.preventDefault(); if (input.value !== 'CLEAR') { confirm.disabled = true; status.textContent = 'Type CLEAR exactly to continue.'; return; } try { onConfirm?.(); status.textContent = 'Practice history cleared.'; dialog.close(); } catch { status.textContent = 'Could not clear practice history. No changes were confirmed.'; } });
 dialog.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation(); });
 dialog.addEventListener('close', () => { dialog.remove(); if (returnFocus?.isConnected && !returnFocus.disabled) returnFocus.focus({ preventScroll: true }); });
 document.body.append(dialog); dialog.showModal(); input.focus();
}
