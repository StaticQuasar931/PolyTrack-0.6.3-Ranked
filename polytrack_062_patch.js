(function(){
  const VERSION = '0.6.3';
  const FIREBASE_CONFIG = window.POLYTRACK_FIREBASE_CONFIG || {
    apiKey: 'AIzaSyBuo9FHpZUl3Y7JO7G-akgmO-5li7RAb5s',
    authDomain: 'polytrack-052.firebaseapp.com',
    projectId: 'polytrack-052',
    storageBucket: 'polytrack-052.firebasestorage.app',
    messagingSenderId: '1000092276003',
    appId: '1:1000092276003:web:dbde7b8770d345f1ea6896',
    measurementId: 'G-QLJD8PH59N'
  };
  const MARKER = '0.6.3-ranked-patch-v1';
  const COLLECTIONS = Object.freeze({
    raceResults: '0.6.2_race_results',
    profilesPublic: '0.6.2_profiles_public',
    carPreviews: '0.6.2_car_previews',
    // Beta aggregate collections stay read-only. Season 1 is rebuilt only by the Ranked Worker.
    leaderboardsTrack: '0.6.2_s1_leaderboards_track',
    leaderboardsOverall: '0.6.2_s1_leaderboards_overall',
    releaseMeta: '0.6.2_s1_release_meta',
    badges: '0.6.2_s1_badges',
    system: '0.6.2_system',
    multiplayerInvites: '0.6.2_multiplayer_invites',
    multiplayerSessions: '0.6.2_multiplayer_sessions',
    multiplayerMessages: '0.6.2_multiplayer_messages',
    moderationNames: '0.6.2_moderation_names',
    dailyStreaks: '0.6.2_daily_streaks',
    adminCode: '0.6.2_admin_code',
    adminSessions: '0.6.2_admin_sessions',
    adminAudit: '0.6.2_admin_audit',
    moderators: '0.6.2_moderators'
  });

  const eventsModuleUrl=new URL('./events/client.mjs',document.currentScript?.src||location.href).href;
  const rankedFiltersModuleUrl=new URL('../tools/ranked-filters.mjs',eventsModuleUrl).href;
  let eventUi=null,eventUiPromise=null,eventQueueChecked=false,eventModuleRetryAt=0;
  let pendingEventLaunch=null;
  let nativeWeeklySelection=null,kodubAdapter=null;
  async function nativeWeeklyFeed(){
    kodubAdapter=await import(new URL('./kodub-weekly.mjs',eventsModuleUrl).href);
    await ensureEventUi();
    const response=await kodubAdapter.loadKodubWeekly({baseUrl:eventsModuleUrl,brokerUrl:rankedBrokerUrl()});
    nativeWeeklySelection=response.current;
    return response;
  }
  window.__pt062PrepareEventRace=function(trackId,multiplayer){
    const pending=pendingEventLaunch;if(!pending)return false;
    pendingEventLaunch=null;
    if(multiplayer!=null||pending.context.trackId!==trackId||pending.context.accountId!==activeRankedAccountId()||Date.now()>=pending.context.endsAt||!pending.isCurrent())throw Error('Event launch context changed');
    return {ownGhost:pending.context.ownGhost||null,opponents:pending.context.opponents||[]};
  };
  window.__pt062ResumeEventRace=(trackId,invokeNative)=>eventUi?.resumeRace(trackId,invokeNative)||false;
  function startEventRace(context,invokeNative,isCurrent){
    if(context.ownGhost&&window.__pt062NativeEventGhostVersion!==1)throw Error('Reload the game to use your event PB ghost.');
    if(window.__pt062NativeEventLaunchVersion!==1||typeof invokeNative!=='function'||typeof isCurrent!=='function')throw Error('Native event launch is unavailable');
    if(!isCurrent()||context.accountId!==activeRankedAccountId()||Date.now()>=context.endsAt)throw Error('Event launch context changed');
    if(pendingEventLaunch){if(pendingEventLaunch.isCurrent())throw Error('An event launch is already pending');pendingEventLaunch=null;}
    const pending=pendingEventLaunch={context:{...context},isCurrent};
    try{invokeNative();}catch(error){if(pendingEventLaunch===pending)pendingEventLaunch=null;throw error;}
  }
  async function eventCloudRead(path,collection,id){
    if(rankedEdgeAvailable()){
      try{const response=await fetch(rankedBrokerUrl()+path,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(8000)});
        if(!response.headers.get('content-type')?.includes('application/json'))throw Error('Event service unavailable');
        if(!response.ok){const error=Error('Event service unavailable');error.serviceResponse=true;throw error;}
        return await response.json();
      }catch(error){if(!error.serviceResponse)markRankedEdgeUnavailable(error.message);}
    }
    const database=await db();const snapshot=await database.collection(collection).doc(id).get();
    if(!snapshot.exists)throw Error('Event data unavailable');return snapshot.data();
  }
  async function ensureEventUi(){
    if(eventUi)return eventUi;if(eventUiPromise)return eventUiPromise;
    eventUiPromise=import(eventsModuleUrl).then(({installEvents})=>{
      if(!document.querySelector('link[data-event-css]')){const link=document.createElement('link');link.rel='stylesheet';link.href=new URL('./events.css',eventsModuleUrl).href;link.dataset.eventCss='';document.head.append(link);}
      eventUi=installEvents({supportsEventGhost:()=>window.__pt062NativeEventGhostVersion===1,trackInfo,displayName:canonicalDisplayName,thumbnail:trackThumbnailMarkup,formatTime:formatRaceTime,accountId:activeRankedAccountId,require:__pt062WebpackRequire,ready:db,openTrack:id=>{if(id===nativeWeeklySelection?.trackId){const button=document.querySelector('.sq-kodub-weekly > button');if(!button)throw Error('Weekly track is unavailable');button.click();}else focusTrackFromRanked(id,{event:true});},startEventRace,watchEvent:(context,ghosts)=>{const root=document.querySelector('.track-info-ui'),watch=root?.__pt062EventWatch;if(!watch||watch.version!==1||watch.trackId!==context.trackId||activeRankedAccountId()!==context.accountId||Date.now()>=context.endsAt)throw Error('Event replay context changed');watch.open(ghosts);},openRankedEvents:()=>window.__pt062OpenRankedEvents?.(),
        readCatalog:()=>eventCloudRead('/v1/events/catalog','0.6.2_event_public','catalog'),
        readSnapshot:id=>eventCloudRead('/v1/events/'+encodeURIComponent(id)+'/snapshot','0.6.2_event_public',id),
        readReplay:async(periodId,accountId,runId=null)=>{
          if(!/^[A-Za-z0-9_-]{1,64}$/.test(periodId)||!/^[a-f0-9]{64}$/.test(accountId))throw Error('Invalid replay identity');
          if(runId!==null&&!/^[a-f0-9]{64}$/.test(runId))throw Error('Invalid recording identity');
          const response=await fetch(rankedBrokerUrl()+'/v1/events/'+encodeURIComponent(periodId)+(runId?'/playbacks/'+runId:'/replays/'+accountId),{headers:{Accept:'application/json'},signal:AbortSignal.timeout(8000)});
          if(!response.ok)throw Error('Replay unavailable. Older event recordings may not have been retained.');
          if(Number(response.headers.get('content-length'))>70000)throw Error('Replay response too large');
          const text=await response.text();if(text.length>70000)throw Error('Replay response too large');return JSON.parse(text);
        },
        readArchivedTrack:async period=>{
          if(!/^[A-Za-z0-9_-]{1,64}$/.test(period.id)||Date.now()<period.endsAt)throw Error('Only closed event tracks can be imported.');
          const response=await fetch(rankedBrokerUrl()+'/v1/events/'+encodeURIComponent(period.id)+'/track',{signal:AbortSignal.timeout(8000)});
          if(!response.ok||Number(response.headers.get('content-length'))>550000)throw Error('Archived track is unavailable.');
          const raw=await response.text();if(raw.length>550000)throw Error('Archived track is too large.');
          const asset=JSON.parse(raw);
          if(asset.periodId!==period.id||asset.trackId!==period.trackId||asset.archived!==true||asset.scoringDisabled!==true||typeof asset.trackCode!=='string'||asset.trackCode.length>524288||!/^PolyTrack[0-9A-Za-z+/_=-]+$/.test(asset.trackCode))throw Error('Archived track identity changed.');
          const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(asset.trackCode));
          if([...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('')!==asset.trackCodeHash)throw Error('Archived track integrity failed.');
          return asset.trackCode;
        },
        importTrackCode:code=>{
          eventUi?.leave();
          const button=[...document.querySelectorAll('.track-selection-ui button')].find(node=>isElementVisible(node)&&node.querySelector('img[src*="import.svg"]'));
          if(!button)throw Error('Open Community tracks, then return to Archives to import this track.');
          button.click();
          const field=[...document.querySelectorAll('textarea')].find(node=>!node.readOnly&&isElementVisible(node));
          if(!field)throw Error('Native track importer is unavailable.');
          field.value=code;field.dispatchEvent(new Event('input',{bubbles:true}));field.focus();
        },
        readPermanent:async()=>{const response=await fetch(rankedBrokerUrl()+'/v1/events/permanent-rolling-hills/snapshot',{headers:{Accept:'application/json'},signal:AbortSignal.timeout(8000)});if(!response.ok)throw Error('Permanent event standings unavailable');return response.json();},
        readTotals:()=>eventCloudRead('/v1/events/totals','0.6.2_event_public','totals'),
        readArchiveMonth:async month=>{if(!/^\d{4}-\d{2}$/.test(month))throw Error('Invalid archive month');const database=await db();const result=await database.collection('0.6.2_event_public').doc('archive_'+month.replace('-','')).get();return result.exists?result.data():{periods:[]};},
        readOwnStatus:async(periodId,accountId)=>{if(!/^[a-f0-9]{64}$/.test(accountId))return null;const database=await db();const result=await database.collection('0.6.2_event_receipts').doc(periodId+'_'+accountId).get();return result.exists?result.data():null;},
        submit:async run=>{
          const database=await db();const user=window.firebase?.auth?.().currentUser;if(!user)throw Error('Sign-in unavailable');
          if(activeRankedAccountId()!==run.accountId)throw Error('Racer changed');
          const input={accountId:run.accountId,trackId:run.trackId,attemptId:run.attemptId,timeMs:run.timeMs,frames:run.frames,replay:run.replay,carStyle:run.carStyle};
          if(rankedEdgeAvailable())try{
            const token=await user.getIdToken();const response=await fetch(rankedBrokerUrl()+'/v1/events/'+encodeURIComponent(run.periodId)+'/runs',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(10000)});
            if(!response.headers.get('content-type')?.includes('application/json'))throw Error('Event submission unavailable');
            if(!response.ok){const error=Error('Event submission unavailable');error.serviceResponse=true;throw error;}return await response.json();
          }catch(error){if(!error.serviceResponse)markRankedEdgeUnavailable(error.message);}
          const inbox=database.collection('0.6.2_event_inbox').doc(run.periodId+'_'+run.accountId);
          try{await inbox.set({...input,periodId:run.periodId,ownerUid:user.uid,receivedAt:window.firebase.firestore.FieldValue.serverTimestamp()});}
          catch(error){
            // A lost acknowledgement or another tab may already have saved an equal/faster PB.
            if(error?.code!=='permission-denied')throw error;
            const existing=await inbox.get();const value=existing.exists?existing.data():null;
            if(!value||value.ownerUid!==user.uid||value.accountId!==run.accountId||value.trackId!==run.trackId||value.periodId!==run.periodId||!Number.isFinite(value.timeMs)||value.timeMs>run.timeMs||typeof value.replay!=='string'||!value.replay)throw error;
          }
          return {status:'waiting'};
        }
      });return eventUi;
    }).catch(error=>{eventUiPromise=null;throw error;});return eventUiPromise;
  }
  function ensureEventEntry(){
    return withoutUiFeedback(ensureEventEntryContents);
  }
  function ensureEventEntryContents(){
    if(!eventQueueChecked){eventQueueChecked=true;try{if(JSON.parse(localStorage.getItem('polytrack-062-events-v1-queue')||'[]').length)void ensureEventUi().then(ui=>ui.flush()).catch(()=>{setTimeout(()=>{eventQueueChecked=false;},60000);});}catch{}}
    const nav=document.querySelector('.track-selection-ui .community-track-versions');
    const group=eventUi?.featuredSection?.();
    if(group)kodubAdapter?.combineKodubCard(document,group,nativeWeeklySelection);
    const ranked=document.getElementById('overallLeaderboardPanel');
    if((nav&&isElementVisible(nav)||ranked&&isElementVisible(ranked))&&!eventUi&&!eventUiPromise&&Date.now()>=eventModuleRetryAt){eventModuleRetryAt=Date.now()+60000;void ensureEventUi().then(ui=>ui.tick()).catch(()=>{});}
    eventUi?.tick();
  }

  function __pt062WebpackRequire(){
    try {
      if (window.__polytrackWebpackRequire062) return window.__polytrackWebpackRequire062;
      const chunkArray = self.webpackChunk = self.webpackChunk || [];
      const probeId = 'polytrack-062-probe-' + Date.now();
      chunkArray.push([[probeId], {}, function(require){ window.__polytrackWebpackRequire062 = require; }]);
      return window.__polytrackWebpackRequire062 || null;
    } catch {
      return null;
    }
  }

  function __pt062CarStyleClass(){
    try {
      if (window.__polytrackCarStyleClass062) return window.__polytrackCarStyleClass062;
      const req = __pt062WebpackRequire();
      const CarStyle = req && req(8724) && req(8724).A;
      if (CarStyle) window.__polytrackCarStyleClass062 = CarStyle;
      return CarStyle || null;
    } catch {
      return null;
    }
  }

  function __pt062Renderer(){
    try {
      if (window.__polytrackRenderCarThumb062) return window.__polytrackRenderCarThumb062;
      const req = __pt062WebpackRequire();
      const render = req && req(3787) && req(3787).F;
      if (typeof render === 'function') {
        window.__polytrackRenderCarThumb062 = render;
        return render;
      }
    } catch {}
    return null;
  }

  function __pt062NormalizeStyle(v){
    return String(v || '').trim().slice(0, 256);
  }

  function getDefaultCarStyle(){
    const stored = __pt062NormalizeStyle(localStorage.getItem('polytrack-0.6.2-last-active-car-style') || '');
    if (stored) return stored;
    try {
      const CarStyle = __pt062CarStyleClass();
      const serialized = CarStyle?.default?.().serialize?.() || '';
      if (serialized) localStorage.setItem('polytrack-0.6.2-last-active-car-style', serialized);
      return serialized;
    } catch {
      return '';
    }
  }

  async function sha256Hex(value){
    const bytes = new TextEncoder().encode(String(value || ''));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (byte)=>byte.toString(16).padStart(2, '0')).join('');
  }

  async function accountIdFromPayload(payload, fallback=''){
    const explicitHash = String(payload?.userTokenHash || payload?.tokenHash || '').trim();
    if (explicitHash) return explicitHash.slice(0, 128);
    const token = String(payload?.userToken || payload?.token || '').trim();
    if (token) return (await sha256Hex(token)).slice(0, 128);
    return String(payload?.accountId || payload?.userId || fallback || guestAccountId).slice(0, 128);
  }

  function __pt062RememberStyle(userId, style){
    const uid = String(userId || '').trim();
    const serialized = __pt062NormalizeStyle(style);
    if (!uid || !serialized) return;
    const store = window.__polytrackCarStyleByUser062 = window.__polytrackCarStyleByUser062 || {};
    store[uid] = serialized;
  }

  function __pt062GetRememberedStyle(userId){
    const uid = String(userId || '').trim();
    if (!uid) return '';
    const store = window.__polytrackCarStyleByUser062 || {};
    return __pt062NormalizeStyle(store[uid] || '');
  }

  function __pt062ColorIdToStyle(colorId){
    try {
      const CarStyle = __pt062CarStyleClass();
      if (!CarStyle) return null;
      const cleaned = String(colorId || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
      const padded = (cleaned + 'ffffff8ec7ff28346a212b58').slice(0, 24);
      const p = parseInt(padded.slice(0, 6), 16);
      const s = parseInt(padded.slice(6, 12), 16);
      const f = parseInt(padded.slice(12, 18), 16);
      const r = parseInt(padded.slice(18, 24), 16);
      return new CarStyle(CarStyle.defaultPattern || 0, CarStyle.defaultRims || 0, CarStyle.defaultExhaust || 0, p, s, f, r);
    } catch {
      return null;
    }
  }

  function __pt062ResolveStyle(primaryArg, secondaryArg){
    const CarStyle = __pt062CarStyleClass();
    if (!CarStyle) return null;
    const serializedPrimary = __pt062NormalizeStyle(primaryArg);
    const isLegacyColorId = /^[0-9a-fA-F]{24}$/.test(serializedPrimary);
    if (serializedPrimary && !isLegacyColorId && typeof CarStyle.deserializeSafe === 'function') {
      try { return CarStyle.deserializeSafe(serializedPrimary); } catch {}
    }
    const secondary = String(secondaryArg || '');
    if (secondary.startsWith('u.')) {
      const remembered = __pt062GetRememberedStyle(secondary.slice(2));
      if (remembered && typeof CarStyle.deserializeSafe === 'function') {
        try { return CarStyle.deserializeSafe(remembered); } catch {}
      }
    }
    return __pt062ColorIdToStyle(primaryArg);
  }

  window.BT = async function(primaryArg, secondaryArg){
    const style = __pt062ResolveStyle(primaryArg, secondaryArg);
    const render = __pt062Renderer();
    if (!style || !render) return '';
    try {
      return await render(style, { addCancelCallback(){} }, null);
    } catch {
      return '';
    }
  };

const q0='7f2a',q1='b19e',q2='d44c',q3='9a01';
  const p0='c3e7',p1='8a14';

  let firestorePromise = null;
  let rankingsSpawnedOnce = window.__polytrackRankingsAnimated === true;
  let rankingsButtonRef = null;
  let localUploadCounter = Number(localStorage.getItem('polytrack-0.6.2-upload-counter') || '0') || 0;
  let nativeMenuButtonsAnimating = false;
  let lastRankedSpawnAt = 0;
  let mainButtonsWereVisible = false;
  let mainButtonsShownAt = 0;
  let rankedSpawnTimer = 0;
  const GUEST_ID_KEY = 'polytrack-0.6.2-guest-account-id';
  function randomGuestSuffix(){
    try {
      if (window.crypto?.getRandomValues) {
        const buf = new Uint8Array(8);
        window.crypto.getRandomValues(buf);
        return Array.from(buf, (b)=>b.toString(16).padStart(2,'0')).join('');
      }
    } catch {}
    return Math.random().toString(36).slice(2, 12);
  }
  function getOrCreateGuestAccountId(){
    const existing = localStorage.getItem(GUEST_ID_KEY);
    if (existing && /^[a-zA-Z0-9_.:-]{6,128}$/.test(existing)) return existing;
    const created = `guest-${Date.now().toString(36)}-${randomGuestSuffix()}`.slice(0, 128);
    localStorage.setItem(GUEST_ID_KEY, created);
    return created;
  }
  const guestAccountId = getOrCreateGuestAccountId();
  const PROFILE_MAP_KEY = 'polytrack-0.6.2-profile-id-map-v1';
  const LAST_ACTIVE_NAME_KEY = 'polytrack-0.6.2-last-active-name';
  const LAST_ACTIVE_COLORS_KEY = 'polytrack-0.6.2-last-active-colors';
  const LAST_ACTIVE_CAR_ID_KEY = 'polytrack-0.6.2-last-active-car-id';
  const PROFILE_NAME_WORD_A = ['swift','neon','alpha','turbo','sonic','pixel','nova','lucky','sunny','frost','ember','quantum','crystal','midnight','solar','lunar','hyper','ultra','aero','rapid','vivid','thunder','cosmic','silver','golden','shadow','arc','vector','iron','onyx','starlit','cobalt','ripple','granite','jungle','desert','arctic','magenta','scarlet','violet','teal','sable','amber','jade','ivory','obsidian','cinder','stellar','orbital','zen','rogue','prime','apex','summit','embered','misty','horizon','aurora','glitch','byte','laser','prism','halo','north','south','east','west','tempo','axle','torque','nitro','clutch','summoner','phantom','eclipse','cyclone','monsoon','titan','pegasus','raven','falcon','lynx','otter','comfy','bouncy','cheery','zippy','daring','brisk','fuzzy','mellow','witty','snappy'];
  const PROFILE_NAME_WORD_B = ['racer','drift','pulse','track','echo','comet','storm','shift','vault','spark','dash','glide','runner','rocket','flare','nexus','voyage','blaze','orbit','flux','drive','streak','zenith','quartz','radar','pilot','charger','phantom','matrix','engine','jumper','hopper','sprinter','raider','seeker','keeper','walker','slider','cruiser','strider','booster','chaser','panther','falcon','otter','fox','rhino','yak','wizard','knight','samurai','sage','ranger','captain','doctor','baron','duke','rookie','veteran','legend','maverick','stomper','breaker','spirit','beacon','anchor','vector','module','kernel','vortex','quasar','galaxy','planet','meteor','asteroid','volcano','tsunami','whirl','tempest','charge','vertex','pixel','bit','byte','gear','piston','engineer','driver','rider','climber','surfer','skater','sniper','ace'];
  const DEFAULT_NAME_BLOCKLIST = ["admin","moderator","owner","staff","support","system","dev","developer","verified","helper","official","security","abuse","abuser","anal","anus","arse","arsehole","ass","assbag","assclown","assface","assfuck","assfucker","asshat","asshole","assholes","asslicker","asswipe","ballsack","bastard","bastards","beaner","bitch","bitches","bitchy","blowjob","blowjobs","bollock","bollocks","boner","boob","boobs","booty","brothel","bullshit","buttfuck","butthole","cameltoe","chink","clit","clitoris","cock","cocks","coon","crap","cum","cumming","cunt","cunts","dick","dicks","dildo","dildos","dipshit","doggystyle","douche","douchebag","dyke","fag","faggot","faggots","feck","fellatio","fingerbang","fuck","fucked","fucker","fuckers","fuckface","fucking","fuckoff","fuckwit","fuk","gangbang","gaylord","genitals","gook","handjob","hardcore","hentai","hitler","hoe","hoes","horny","incest","jackass","jerkoff","jizz","kike","kkk","kunt","lesbo","lesbian","loli","masturbate","masturbation","milf","motherfucker","motherfucking","muff","nazi","nazism","negro","nigga","nigger","niggers","nipple","nipples","nutjob","orgasm","orgy","pedo","pedophile","penis","piss","pissed","pisser","playboy","poon","poop","porn","porno","pornhub","prostitute","pussy","queef","queer","raped","raper","rapist","rape","retard","rimjob","scrotum","sex","sexy","shit","shits","shitty","shota","sissy","skank","slut","sluts","smegma","spic","spunk","strapon","suck","sucks","testicle","threesome","tit","tits","titties","titty","tranny","twat","vag","vagina","vibrator","virgin","voyeur","wank","wanker","whore","whores","wtf","xxx","xrated","yaoi","zoophile","zoophilia","alqaeda","isis","terrorist","swastika","1488","molest","molester","underage","childporn","cp","suicide","killyourself","kys","racist","racism","whitepower","wetback","spick","gimp","cripple","idiot","moron","stupid","dumbass","shithead","cumshot","cumslut","deepthroat","fisting","gangrape","gfy","goatse","groomer","hooker","hotsex","humping","jackoff","motherfucker","nutsack","pecker","peehole","peeing","pussylicking","rectum","scat","semen","sexcam","sexchat","sexworker","shemale","slapper","sodomize","sodomy","tard","teabagging","towelhead","tubgirl","unclefucker","upskirt","urethra","urine","vulva","wigger","willy","yid"];
  const MODERN_HIGH_RISK_TERMS = ['gooning','gooner','goonette','edging','edgeplay','gyatt','gyat','onlyfans','ofans','discordmod','heilhitler','gasjews','killall','kms','killyourself','kys','unaliveyourself','csam','cporn','childlover','minorlover','lolicon','shotacon'];
  const COMPACT_SEVERE_TERMS = ['nigger','niggre','nigre','nigga','faggot','chink','kike','spic','wetback','beaner','coon','gook','tranny','fuck','bitch','cunt','rape','rapist','pedophile','molester','childporn','csam','killyourself','whitepower','heilhitler','pornhub','onlyfans','gooning','masterbait','masterbaiting','masterofbaiting'];
  const RESERVED_NAME_TERMS = ['admin','administrator','moderator','modteam','owner','staff','support','system','developer','devteam','verified','official','staticquasar931'];

  function readProfileMap(){
    try {
      const raw = localStorage.getItem(PROFILE_MAP_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return {
        byName: parsed?.byName && typeof parsed.byName === 'object' ? parsed.byName : {},
        bySignature: parsed?.bySignature && typeof parsed.bySignature === 'object' ? parsed.bySignature : {}
      };
    } catch { return { byName:{}, bySignature:{} }; }
  }

  function writeProfileMap(map){
    try { localStorage.setItem(PROFILE_MAP_KEY, JSON.stringify(map)); } catch {}
  }

  function normalizedNameKey(value){
    return String(value || '').trim().toLowerCase().slice(0, 40);
  }

  function makeProfileSignature(payload){
    const colors = String(payload?.carColors || payload?.CarColors || '').trim();
    const carId = String(payload?.car || payload?.carId || payload?.carName || '').trim();
    const sig = [colors, carId].filter(Boolean).join('|').slice(0, 120);
    return sig || '';
  }

  function makeGeneratedProfileId(){
    return `guest-${Date.now().toString(36)}-${randomGuestSuffix()}`.slice(0, 128);
  }

  function makeRandomCarColors(){
    const rand = ()=>Math.floor(Math.random()*256).toString(16).padStart(2,'0');
    return `${rand()}${rand()}${rand()}${rand()}${rand()}${rand()}${rand()}${rand()}${rand()}${rand()}${rand()}${rand()}`.slice(0,24);
  }
  function getOrCreateInitialCarColors(){
    const existing = String(localStorage.getItem(LAST_ACTIVE_COLORS_KEY) || '').replace(/[^0-9a-fA-F]/g,'').slice(0,24);
    if (existing.length >= 24) return existing;
    const created = makeRandomCarColors();
    try { localStorage.setItem(LAST_ACTIVE_COLORS_KEY, created); } catch {}
    return created;
  }

  function resolveProfileAccountId(payload, suggestedId){
    const suggested = String(suggestedId || '').slice(0, 128);
    const signature = makeProfileSignature(payload);
    const map = readProfileMap();
    if (suggested) {
      if (signature) {
        map.bySignature[signature] = suggested;
        writeProfileMap(map);
      }
      return suggested;
    }
    if (signature && map.bySignature[signature]) return map.bySignature[signature];
    const generated = makeGeneratedProfileId();
    if (signature) {
      map.bySignature[signature] = generated;
      writeProfileMap(map);
    }
    return generated;
  }

  const BRAND_FP = `${q0}${q1}${q2}${q3}`;
  const WARN_FP = `${p0}${p1}`;
  const OFFICIAL_TRACK_COUNT = 17;
  const COMMUNITY_TRACK_COUNT = 72; // 71 current tracks plus retained legacy Asguardia.
  const TOTAL_TRACKS = OFFICIAL_TRACK_COUNT + COMMUNITY_TRACK_COUNT;
  const TRACK_CACHE_SCHEMA = 5;
  const TRACK_CATALOG = new Map([{"id":"5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038","name":"Summer 1","type":"official","trackUrl":"tracks/official/summer1.track","thumbnail":"tracks/official/thumbnails/summer1.png","environment":0},{"id":"7eac4fee1111152cfba4d3737410264ca0f22c7f5a2211e79f0099589b8b48c0","name":"Summer 2","type":"official","trackUrl":"tracks/official/summer2.track","thumbnail":"tracks/official/thumbnails/summer2.png","environment":0},{"id":"148826aa16ffaa23dbc453b32cff05e025ddbce1773fc7733cc13d218926515a","name":"Summer 3","type":"official","trackUrl":"tracks/official/summer3.track","thumbnail":"tracks/official/thumbnails/summer3.png","environment":0},{"id":"93c7363dfea7fb09ca1d23b72cad5df43a30841d41c8ff25fb544c85bb03c7ae","name":"Summer 4","type":"official","trackUrl":"tracks/official/summer4.track","thumbnail":"tracks/official/thumbnails/summer4.png","environment":0},{"id":"7603aaeffa1989a649dfaa8e1804bed4481b49df233e377687d0669899566e52","name":"Summer 5","type":"official","trackUrl":"tracks/official/summer5.track","thumbnail":"tracks/official/thumbnails/summer5.png","environment":0},{"id":"c117823cf6788e3247b9ee63a0c091c07352bbe352c650a7790dc6718148c2fa","name":"Summer 6","type":"official","trackUrl":"tracks/official/summer6.track","thumbnail":"tracks/official/thumbnails/summer6.png","environment":0},{"id":"e4bcaca3a583bb0eb62a700a69d14e89c852f0c5bf740fca76e0519ebdfc9ab1","name":"Summer 7","type":"official","trackUrl":"tracks/official/summer7.track","thumbnail":"tracks/official/thumbnails/summer7.png","environment":0},{"id":"7239b17057127936907a805b0caa5d8c6f6c97eca9bdabf1a5312dce479629b7","name":"Winter 1","type":"official","trackUrl":"tracks/official/winter1.track","thumbnail":"tracks/official/thumbnails/winter1.png","environment":1},{"id":"99864b635d1891d22e17eb9267527a07a92c49c0f02893729fa2ded90e3ca0f9","name":"Winter 2","type":"official","trackUrl":"tracks/official/winter2.track","thumbnail":"tracks/official/thumbnails/winter2.png","environment":1},{"id":"a5341fe706097cff2a3812a3fc0d87399254557328351ae8e5c882700fc1a196","name":"Winter 3","type":"official","trackUrl":"tracks/official/winter3.track","thumbnail":"tracks/official/thumbnails/winter3.png","environment":1},{"id":"7d134c939df80c676a258266201beedd3b93572d5603f3ff4339ff8679803715","name":"Winter 4","type":"official","trackUrl":"tracks/official/winter4.track","thumbnail":"tracks/official/thumbnails/winter4.png","environment":1},{"id":"2fe4bd46b0075cc25fc770ce50adbb68447cf493c999635bb272d231811dd264","name":"Winter 5","type":"official","trackUrl":"tracks/official/winter5.track","thumbnail":"tracks/official/thumbnails/winter5.png","environment":1},{"id":"c20b4ee3cd517ca6cae7e43f047548757287fbd08ba81b97892a3ef520159a34","name":"Desert 1","type":"official","trackUrl":"tracks/official/desert1.track","thumbnail":"tracks/official/thumbnails/desert1.png","environment":2},{"id":"88647ea04145fbbbb19b55f1590e038fb0378acb2571110f02cb545cc46b0d57","name":"Desert 2","type":"official","trackUrl":"tracks/official/desert2.track","thumbnail":"tracks/official/thumbnails/desert2.png","environment":2},{"id":"2806030c503abb41a1a26fa9a570888be14296172bb273798ef0ad87a108a2ec","name":"Desert 3","type":"official","trackUrl":"tracks/official/desert3.track","thumbnail":"tracks/official/thumbnails/desert3.png","environment":2},{"id":"4697ea67b18c3f49b30a3d8884602115536650bc5435c88e3732e64d21a72d33","name":"Desert 4","type":"official","trackUrl":"tracks/official/desert4.track","thumbnail":"tracks/official/thumbnails/desert4.png","environment":2},{"id":"e5d084e06db4ab71196fea44efeceb23c8561266a78669c324a38f92581fe2db","name":"Desert 5","type":"official","trackUrl":"tracks/official/desert5.track","thumbnail":"tracks/official/thumbnails/desert5.png","environment":2},{"id":"fb769ac2ea77e8f19a21a9dd3071742f2342bd49c41e4748d7e8c7903d4f0778","name":"Rolling Hills Racer","type":"community","trackUrl":"tracks/community/rolling_hills_racer.track","thumbnail":"tracks/community/thumbnails/rolling_hills_racer.png","environment":0},{"id":"387aab2d3400ebf74b5a780d15c911cdc695053b94be3e7ad23f6ae313b2471c","name":"La Infinita","type":"community","trackUrl":"tracks/community/la_infinita.track","thumbnail":"tracks/community/thumbnails/la_infinita.png","environment":1},{"id":"a680fa81e6a4b9dec06b4197833f0a96334a275faf387d495c9c674ffd6b8686","name":"Oyasumi","type":"community","trackUrl":"tracks/community/oyasumi.track","thumbnail":"tracks/community/thumbnails/oyasumi.png","environment":0},{"id":"439f1c61263987365996667f99d65f899ec482dfe21c64edcd9a1b1ae5b4a0a9","name":"Zenith","type":"community","trackUrl":"tracks/community/zenith.track","thumbnail":"tracks/community/thumbnails/zenith.png","environment":0},{"id":"dc7783fef2a5fbb7a2d75b9c6fdd6a9d600b833d47c6274374ea4388c707517a","name":"𝔚𝔦𝔫𝔱𝔢𝔯𝔱𝔦𝔡𝔢","type":"community","trackUrl":"tracks/community/wintertide.track","thumbnail":"tracks/community/thumbnails/wintertide.png","environment":1},{"id":"f40d385d5e97e00a166a9a05d19789d8f2bf3621a8c1c8919c8bec41ab6347ab","name":"The CrossFades","type":"community","trackUrl":"tracks/community/the_crossfades.track","thumbnail":"tracks/community/thumbnails/the_crossfades.png","environment":0},{"id":"d57a81355f36d5ef0bd2c063d251baf6d28401c275a8b3e3a62e0ae5071a2559","name":"Out of Bounds","type":"community","trackUrl":"tracks/community/out_of_bounds.track","thumbnail":"tracks/community/thumbnails/out_of_bounds.png","environment":0},{"id":"225fad12335dadc12b60bfa1b31369b1026d8a084fd4670583870fb3b71f7ec0","name":"Solaris","type":"community","trackUrl":"tracks/community/solaris.track","thumbnail":"tracks/community/thumbnails/solaris.png","environment":2},{"id":"0338f449b9948f06c03ffc2ab3ab6cf551fd08a9f2c09a16156b93ef52dd4411","name":"݁˖.˚ Evanescent Bliss. ݁₊˚ .","type":"community","trackUrl":"tracks/community/evanescent_bliss.track","thumbnail":"tracks/community/thumbnails/evanescent_bliss.png","environment":0},{"id":"27c3384de80b1bed23f1ea15316abe62c8cca33e955805f23d461803f6dee8d4","name":"𐌀𐌕𐌋𐌀𐌍𐌕𐌉𐌔","type":"community","trackUrl":"tracks/community/atlantis.track","thumbnail":"tracks/community/thumbnails/atlantis.png","environment":0},{"id":"d9bc51ec180bc46558e079c7949ba10b9ade52078c4c145f217a6a8543df2377","name":"Tucks Factory","type":"community","trackUrl":"tracks/community/tucks_factory.track","thumbnail":"tracks/community/thumbnails/tucks_factory.png","environment":0},{"id":"5159a8dac6a1f397407a7b5233ad570613531f6609f7dc897490c28c9f2c7a4e","name":"Apostle","type":"community","trackUrl":"tracks/community/apostle.track","thumbnail":"tracks/community/thumbnails/apostle.png","environment":2},{"id":"1783b7b6c30e7fddf7ffb7c8a4a8a3b65c1ef6ec317d908d6eb05e6c905a57f6","name":"Stardust","type":"community","trackUrl":"tracks/community/stardust.track","thumbnail":"tracks/community/thumbnails/stardust.png","environment":0},{"id":"ddfe00045807e2786552d1e31e1363384c365487180f65d4eff1aa41e334a8e8","name":"Overclocked","type":"community","trackUrl":"tracks/community/overclocked.track","thumbnail":"tracks/community/thumbnails/overclocked.png","environment":0},{"id":"4058e3616fbd79b848e70037adde4f12b4413011050aaf1c9d875cdbe2e33d68","name":"Amberbound","type":"community","trackUrl":"tracks/community/amberbound.track","thumbnail":"tracks/community/thumbnails/amberbound.png","environment":0},{"id":"2ec74a179c8aba94354e3c6dee2a2920bedd7d84adf4d0a691f4a7453afdb1e8","name":"The Eldritch Estate","type":"community","trackUrl":"tracks/community/the_eldritch_estate.track","thumbnail":"tracks/community/thumbnails/the_eldritch_estate.png","environment":0},{"id":"76e1920a3ca015033a0b21156848def2c248c95d97ccf4aab2312a0302beefe0","name":"Star Bound","type":"community","trackUrl":"tracks/community/star_bound.track","thumbnail":"tracks/community/thumbnails/star_bound.png","environment":2},{"id":"81cede50724b1ee0c2ebcef973c37d620680766bd75771c5ae2728b8732c7a66","name":"Natsu","type":"community","trackUrl":"tracks/community/natsu.track","thumbnail":"tracks/community/thumbnails/natsu.png","environment":0},{"id":"76269faf38e8726671c05b2b9044f7aa3e66c4313cb4fa5d0fbb23fc8524fe9e","name":"Lenore","type":"community","trackUrl":"tracks/community/lenore.track","thumbnail":"tracks/community/thumbnails/lenore.png","environment":0},{"id":"151f12fd3ebc8942f7aaef669024a0fc149bc220f370753efe14d9371acc9c87","name":"sandy lanes II","type":"community","trackUrl":"tracks/community/sandy_lanes_ii.track","thumbnail":"tracks/community/thumbnails/sandy_lanes_ii.png","environment":2},{"id":"f9283607ecec9c89583205cf08715c8f504cc271eec51209bb6fc0cc37ddc915","name":"Planet 97","type":"community","trackUrl":"tracks/community/planet_97.track","thumbnail":"tracks/community/thumbnails/planet_97.png","environment":0},{"id":"64bf7efaed2a47dfb03a6b152e3aef637ac251b68a725a28352f3376ff1384d7","name":"Marvelous Marble","type":"community","trackUrl":"tracks/community/marvelous_marble.track","thumbnail":"tracks/community/thumbnails/marvelous_marble.png","environment":0},{"id":"520c4f511821ced30b99bceafbb02e6b7531e867126b0756e68d5e157691ef2f","name":"Arx Lucida","type":"community","trackUrl":"tracks/community/arx_lucida.track","thumbnail":"tracks/community/thumbnails/arx_lucida.png","environment":0},{"id":"315c9e95c567cce4feca78f5ad6e8d08d0a22dac0d56061af567b43eea3d4fa8","name":"Koselig","type":"community","trackUrl":"tracks/community/koselig.track","thumbnail":"tracks/community/thumbnails/koselig.png","environment":1},{"id":"a8913b96daceb5b615fe45aad2bb104e04eb7db140242934657111e1d1f55b89","name":"Sky Bound","type":"community","trackUrl":"tracks/community/sky_bound.track","thumbnail":"tracks/community/thumbnails/sky_bound.png","environment":0},{"id":"66f43b2d2a17f3cee05a127040ca409795058510bd3d1ac7eee224512ec532f5","name":"ShardMir","type":"community","trackUrl":"tracks/community/shardmir.track","thumbnail":"tracks/community/thumbnails/shardmir.png","environment":2},{"id":"fcbba504800751b0fb404a7cd1c9591befdf688ad5451ab2bc1f3651590cc5fc","name":"𝔖𝔱𝔢𝔦𝔫𝔴𝔞𝔩𝔩𝔟𝔲𝔯𝔤","type":"community","trackUrl":"tracks/community/steinwallburg.track","thumbnail":"tracks/community/thumbnails/steinwallburg.png","environment":0},{"id":"9ba44e8eafd0158e7e1f63e7d609db308c53f337b79e86bd0b630225451eef34","name":"𝕻𝖆𝖗𝖆𝖉𝖎𝖘𝖊 𝕻𝖆𝖑𝖆𝖈𝖊","type":"community","trackUrl":"tracks/community/paradise_palace.track","thumbnail":"tracks/community/thumbnails/paradise_palace.png","environment":0},{"id":"b3889905b6df31cbe302e58e975988385607771605bf6e8e8e8e31b3d2dc8aa1","name":"Sunken Glyphs","type":"community","trackUrl":"tracks/community/sunken_glyphs.track","thumbnail":"tracks/community/thumbnails/sunken_glyphs.png","environment":0},{"id":"3cd94552b12fb3a8ac45ca3a5e21a882b71b31c788989b396ab382afc69414ac","name":"Grimspyre","type":"community","trackUrl":"tracks/community/grimspyre.track","thumbnail":"tracks/community/thumbnails/grimspyre.png","environment":0},{"id":"3125a5f98c3b43cf1e2604e25e8504bffd714ea5843200fa8ddf0b4c58842f16","name":"Magenta Mines","type":"community","trackUrl":"tracks/community/magenta_mines.track","thumbnail":"tracks/community/thumbnails/magenta_mines.png","environment":0},{"id":"a2137c20c03ad1848098b47f70417cc0b0bf169010c825dc6fb82f37066808a0","name":"Cruising Altitude","type":"community","trackUrl":"tracks/community/cruising_altitude.track","thumbnail":"tracks/community/thumbnails/cruising_altitude.png","environment":1},{"id":"d03b9f7c10c95f40eed389458be51bdf2437febd5673d028da134e59e503c10b","name":"Termite Terror","type":"community","trackUrl":"tracks/community/termite_terror.track","thumbnail":"tracks/community/thumbnails/termite_terror.png","environment":2},{"id":"f68a709a296a60f6e6f73a2da670f95aca424be0f2fda5d6b608ece71f339b7c","name":"4 seasons","type":"community","trackUrl":"tracks/community/4_seasons.track","thumbnail":"tracks/community/thumbnails/4_seasons.png","environment":1},{"id":"a1f41dc9e884d5d4b1b6025158d70f0934dc4d892076e6c4b32dc3f3846b882e","name":"Lost at sea","type":"community","trackUrl":"tracks/community/lost_at_sea.track","thumbnail":"tracks/community/thumbnails/lost_at_sea.png","environment":0},{"id":"b430aad5e481caa4588e30f46352b876b62f1ba0cf7730a15efd026c91a8f32e","name":"Frosted Fjords 寒い","type":"community","trackUrl":"tracks/community/frosted_fjords.track","thumbnail":"tracks/community/thumbnails/frosted_fjords.png","environment":1},{"id":"95d8f7cbe11053dbdfaeeb2f3c3d8f53f0d45fb6abeb411a74949a4cf52f427f","name":"〜✧〜Ḽevitation〜✧〜","type":"community","trackUrl":"tracks/community/levitation.track","thumbnail":"tracks/community/thumbnails/levitation.png","environment":0},{"id":"409f26b9faf55bd0ad748177bf85ebdcfc0ddd572190e7f464f38b4a60587b7e","name":"Frozen Ramparts","type":"community","trackUrl":"tracks/community/frozen_ramparts.track","thumbnail":"tracks/community/thumbnails/frozen_ramparts.png","environment":1},{"id":"c1a2c5aef1029d7bbf946f08cd087dd25bad6e019a41694a48a0024c27627dc8","name":"Tangled Cliffs","type":"community","trackUrl":"tracks/community/tangled_cliffs.track","thumbnail":"tracks/community/thumbnails/tangled_cliffs.png","environment":0},{"id":"9e53d03f4efe86834c49ce202b528d769d9aa7a6e17732d0fc56440463956a1b","name":"Sludge Pipe Circuit","type":"community","trackUrl":"tracks/community/sludge_pipe_circuit.track","thumbnail":"tracks/community/thumbnails/sludge_pipe_circuit.png","environment":0},{"id":"b77ec520a40c4b38d3d7d653b747b1f8627c98709096568db22cd1bfec534ba6","name":"Zealot","type":"community","trackUrl":"tracks/community/zealot.track","thumbnail":"tracks/community/thumbnails/zealot.png","environment":1},{"id":"9f827673c4132828009237a03e12ead73eae87504b4708a79c6cc0858212262d","name":"Shrouded Oasis","type":"community","trackUrl":"tracks/community/shrouded_oasis.track","thumbnail":"tracks/community/thumbnails/shrouded_oasis.png","environment":2},{"id":"9acd9aef650c4ccc41bb01f72ed44dfaa13f2e4404d2e3466f09cc1adcd9a9c0","name":"⚙︎Cogware⚙︎","type":"community","trackUrl":"tracks/community/cogware.track","thumbnail":"tracks/community/thumbnails/cogware.png","environment":0},{"id":"62d9989187e4508f7866e7b30aa187ddbee2595df21ff5988d7fec3589f9048d","name":"Land of the Rising Sun","type":"community","trackUrl":"tracks/community/land_of_the_rising_sun.track","thumbnail":"tracks/community/thumbnails/land_of_the_rising_sun.png","environment":0},{"id":"b36162623435dc90a54f57590d2baa9f2d67a51cb12c393531f4b6d5e5528ebf","name":"Midas Metropolis","type":"community","trackUrl":"tracks/community/midas_metropolis.track","thumbnail":"tracks/community/thumbnails/midas_metropolis.png","environment":2},{"id":"74ae56c0f278a19f3b69f3903198c7b9de09981133205856b53bf6bdf8db4211","name":"Frozen In Time","type":"community","trackUrl":"tracks/community/frozen_in_time.track","thumbnail":"tracks/community/thumbnails/frozen_in_time.png","environment":1},{"id":"9f4597449906aa0c2baf9a4737406385c829533e64e9e972b25b4189f4593a54","name":"Winterfell","type":"community","trackUrl":"tracks/community/winterfell.track","thumbnail":"tracks/community/thumbnails/winterfell.png","environment":1},{"id":"28b658c7d10eb8b5de6f465e034e87e40f70b37e4534d8c37d1f2af06b5a36d7","name":"Launch Control","type":"community","trackUrl":"tracks/community/launch_control.track","thumbnail":"tracks/community/thumbnails/launch_control.png","environment":0},{"id":"470af92ed4c0a6f62028d7dea4dbc7765d1db16a3698d6a0c271be582a20a7c6","name":"Fractured Shores","type":"community","trackUrl":"tracks/community/fractured_shores.track","thumbnail":"tracks/community/thumbnails/fractured_shores.png","environment":0},{"id":"a6b990137e404c9ef2cb4399c463acbed8ebfa3bb82ab5315027118604c4ec03","name":"Starry Tropisx","type":"community","trackUrl":"tracks/community/starry_tropisx.track","thumbnail":"tracks/community/thumbnails/starry_tropisx.png","environment":2},{"id":"35fe02bf18312713c05528f0b7b8fd15c83dac50bcdcbd373040a16e8bfcc138","name":"Flying Dreams","type":"community","trackUrl":"tracks/community/flying_dreams.track","thumbnail":"tracks/community/thumbnails/flying_dreams.png","environment":0},{"id":"18b69f54f119cfb2867abded9a1574f0799a750ef94aa744d9ec8ef6b4d565ae","name":"Ghost City","type":"community","trackUrl":"tracks/community/ghost_city.track","thumbnail":"tracks/community/thumbnails/ghost_city.png","environment":0},{"id":"5ea46b3ae268a0196dcc59dabe88926400b56e29814658bfed06a284f837cefd","name":"MOS ESPA","type":"community","trackUrl":"tracks/community/mos_espa.track","thumbnail":"tracks/community/thumbnails/mos_espa.png","environment":0},{"id":"ab8e1c13ddf394102be1cb04adcff8411127f1e7140a216d27a94fc19b7d0428","name":"Joenail Jones","type":"community","trackUrl":"tracks/community/joenail_jones.track","thumbnail":"tracks/community/thumbnails/joenail_jones.png","environment":2},{"id":"86335d78d1a06d3dc81d80f84b8ac2e8f6359e9a206826e2c36f7d3f4351bea4","name":"Anubis","type":"community","trackUrl":"tracks/community/anubis.track","thumbnail":"tracks/community/thumbnails/anubis.png","environment":2},{"id":"a510bbd3341f2992a12db8a3780cb8943b6087538345d58d16602d6129742df0","name":"Natsujō","type":"community","trackUrl":"tracks/community/natsujo.track","thumbnail":"tracks/community/thumbnails/natsujo.png","environment":0},{"id":"8cf99166f12cbb56a9df4e022a0e9b8c78973adb929dbf1e265ebb9f99f01163","name":"Arabica","type":"community","trackUrl":"tracks/community/arabica.track","thumbnail":"tracks/community/thumbnails/arabica.png","environment":2},{"id":"33d99aad2ad5cef45b1d3afb8735c5229cfd98ac7cc24916e0da7283f7a545ce","name":"Hyperion's Sanctuary","type":"community","trackUrl":"tracks/community/hyperions_sanctuary.track","thumbnail":"tracks/community/thumbnails/hyperions_sanctuary.png","environment":1},{"id":"5c00f2c90bcf8230183484225d1a417e45b0ad310379acfafd4c8f1dc7345dd7","name":"Winter Hollow","type":"community","trackUrl":"tracks/community/winter_hollow.track","thumbnail":"tracks/community/thumbnails/winter_hollow.png","environment":1},{"id":"009fad7fcc215022c6b2dbb2b6de622f07cd88d4930b8e2b6a6b74c1f5de9e44","name":"Clay temples","type":"community","trackUrl":"tracks/community/clay_temples.track","thumbnail":"tracks/community/thumbnails/clay_temples.png","environment":2},{"id":"1ad53694ee3e96aea27afa7b64d5c29d115de88a17b69cf3fe3f5609c52b040b","name":"Las Calles","type":"community","trackUrl":"tracks/community/las_calles.track","thumbnail":"tracks/community/thumbnails/las_calles.png","environment":2},{"id":"2ed125037366052871fbb97da6e1bda49cfeb471f6b9c8fa799d520bdb3683e2","name":"DESERT STALLION","type":"community","trackUrl":"tracks/community/desert_stallion.track","thumbnail":"tracks/community/thumbnails/desert_stallion.png","environment":2},{"id":"f79b1d863d50f9e3b4489988698065c6d775ff3ec90bf91085bad05ad5ec8316","name":"Last Remnant","type":"community","trackUrl":"tracks/community/last_remnant.track","thumbnail":"tracks/community/thumbnails/last_remnant.png","environment":2},{"id":"27429a1d1bf05770851e3919af70f47c6cd7a269c67032b084fb4345f6c271ce","name":"lu muvimento","type":"community","trackUrl":"tracks/community/lu_muvimento.track","thumbnail":"tracks/community/thumbnails/lu_muvimento.png","environment":0},{"id":"f5c327cf09b90e4de8c3c1f9c910dbb7988cf15485d2e4beec3cc03aef408c5c","name":"90*RESET","type":"community","trackUrl":"tracks/community/90_reset.track","thumbnail":"tracks/community/thumbnails/90_reset.png","environment":0},{"id":"7451c2128cb96bc28195cf0ca0f83a46c3b55d78d434232d9de085dd1cf0ab36","name":"Opal Palace - Repolished","type":"community","trackUrl":"tracks/community/opal_palace_ii.track","thumbnail":"tracks/community/thumbnails/opal_palace_ii.png","environment":1},{"id":"af6ef508e1f6e47a462a6998b950ef535d1e8a38fe67ead891bf5f2de1346f43","name":"Re : Akina","type":"community","trackUrl":"tracks/community/re_akina.track","thumbnail":"tracks/community/thumbnails/re_akina.png","environment":0},{"id":"089f2aebcfe4f24d8dda3a8a630172d2bd13793e78c5247adfaa760743a377e1","name":"Sandline Ultimatum","type":"community","trackUrl":"tracks/community/sandline_ultimatum.track","thumbnail":"tracks/community/thumbnails/sandline_ultimatum.png","environment":2},{"id":"5e40f730509204c77e9c610839ed43addddbe0f8aa007168447f7fde38583905","name":"Malformations","type":"community","trackUrl":"tracks/community/malformations.track","thumbnail":"tracks/community/thumbnails/malformations.png","environment":2},{"id":"191737cc4d1b74949e992d99371e5c7f5fc446a716af571c6e5449b23e9f4558","name":"Snow Park","type":"community","trackUrl":"tracks/community/snow_park.track","thumbnail":"tracks/community/thumbnails/snow_park.png","environment":1},{"id":"39bd3fa6c3c769b298c219aee7561af35a6d856bfee14b46b0b48499e7a57ed5","name":"concrete jungle","type":"community","trackUrl":"tracks/community/concrete_jungle.track","thumbnail":"tracks/community/thumbnails/concrete_jungle.png","environment":0}]
.map((track)=>[track.id, Object.freeze(track)]));
  const LEGACY_TRACK_CATALOG = new Map([["5aafb733c264d51b09beedc7bd7eabb5e65bdded338980fcb14ae5ce36955572",{"id":"5aafb733c264d51b09beedc7bd7eabb5e65bdded338980fcb14ae5ce36955572","name":"Asguardia (legacy)","type":"community","retired":true,"thumbnail":"tracks/community/thumbnails/asguardia.png"}]]);
  function trackInfo(trackId){
    return TRACK_CATALOG.get(String(trackId || '')) || LEGACY_TRACK_CATALOG.get(String(trackId || '')) || { id:String(trackId || ''), name:'Custom Track', type:'custom' };
  }
  const LOG_PREFIX='[polytrack-data-0.6.2]';
  const log=(type,msg,data)=>{
    if(/\[NET10[012]\]/.test(msg))return;
    const rec={ts:Date.now(),type,msg,data:data||null};
    const arr=window.__polytrackDataLog||[]; arr.push(rec); if(arr.length>200) arr.shift(); window.__polytrackDataLog=arr;
    const fn=type==='error'?console.error:type==='warn'?console.warn:console.info; fn(LOG_PREFIX,msg,data||'');
  };

  const OVERALL_CACHE_KEY = 'polytrack-0.6.2-s1-overall-snapshot-v5';
  const OVERALL_BETA_CACHE_KEY = 'polytrack-0.6.2-overall-snapshot-v4';
  const OVERALL_LEGACY_CACHE_KEY = 'polytrack-0.6.2-overall-snapshot-v3';
  const OVERALL_REBUILD_BACKOFF_KEY = 'polytrack-0.6.2-overall-rebuild-backoff';
  const OVERALL_PB_DIRTY_KEY = 'polytrack-0.6.2-ranked-pb-dirty-v1';
  const TRACK_CACHE_KEY = 'polytrack-0.6.2-s1-track-snapshots-v4';
  const TRACK_LEGACY_CACHE_KEY = 'polytrack-0.6.2-track-snapshots-v3';
  const RANKED_NOTIFY_QUEUE_KEY = 'polytrack-0.6.2-s1-ranked-notify-queue-v1';
  const STREAK_LEADER_CACHE_KEY = 'polytrack-0.6.2-streak-leader-v2';
  // Snapshots never expire. This only controls when another cloud check is allowed.
  const OVERALL_REFRESH_CHECK_MS = 2 * 60 * 1000;
  const OVERALL_REBUILD_MIN_AGE_MS = 15 * 60 * 1000;
  const TRACK_REFRESH_MS = 2 * 60 * 1000;
  const RANKED_EDGE_BACKOFF_MS = 5 * 60 * 1000;
  const RANKED_EDGE_STATE_KEY = 'polytrack-0.6.2-ranked-edge-state-v1';
  const MODERATION_REFRESH_MS = 10 * 60 * 1000;
  let currentTrackLoadState = null;
  let trackLoadGeneration = 0;
  let trackOverlayCache = null;
  let rankedEdgeState = (()=>{
    try {
      const value=JSON.parse(sessionStorage.getItem(RANKED_EDGE_STATE_KEY)||'null');
      return value&&Number(value.retryAt||0)>Date.now()?value:{retryAt:0,reason:''};
    } catch { return {retryAt:0,reason:''}; }
  })();
  function rankedEdgeAvailable(){return Number(rankedEdgeState.retryAt||0)<=Date.now();}
  function markRankedEdgeUnavailable(reason){
    const wasAvailable=rankedEdgeAvailable();
    rankedEdgeState={retryAt:Date.now()+RANKED_EDGE_BACKOFF_MS,reason:String(reason||'network unavailable').slice(0,120)};
    try{sessionStorage.setItem(RANKED_EDGE_STATE_KEY,JSON.stringify(rankedEdgeState));}catch{}
    if(wasAvailable)log('warn','[RANKED403] Ranked edge unavailable; using direct Firestore recovery',{retryInMinutes:5,reason:rankedEdgeState.reason});
  }
  function clearRankedEdgeFailure(){
    rankedEdgeState={retryAt:0,reason:''};
    try{sessionStorage.removeItem(RANKED_EDGE_STATE_KEY);}catch{}
  }
  const jsonStorageCache=new Map();
  function readJsonStorage(key, fallback=null){
    try {
      const raw=localStorage.getItem(key);
      if(raw===null||raw==='')return fallback;
      const hit=jsonStorageCache.get(key);
      if(hit&&hit.raw===raw)return hit.value ?? fallback;
      const value=JSON.parse(raw);
      jsonStorageCache.set(key,{raw,value});
      return value ?? fallback;
    } catch { return fallback; }
  }
  function writeJsonStorage(key, value){
    try { const raw=JSON.stringify(value); localStorage.setItem(key,raw); jsonStorageCache.set(key,{raw,value}); return true; } catch { return false; }
  }
  function readOverallSnapshotCache(){
    const cached = readJsonStorage(OVERALL_CACHE_KEY,null) || readJsonStorage(OVERALL_BETA_CACHE_KEY,null) || readJsonStorage(OVERALL_LEGACY_CACHE_KEY,null);
    if (!cached || !Array.isArray(cached.entries) || !cached.entries.length) return null;
    return {...cached,entries:normalizeEntries(cached.entries)};
  }
  function writeOverallSnapshotCache(entries,meta={}){
    const normalized = normalizeEntries(entries || []);
    if (!normalized.length) return;
    const prior=readJsonStorage(OVERALL_CACHE_KEY,null)||{};
    const trackSummaries=Array.isArray(meta.trackSummaries)?meta.trackSummaries.slice(0,TOTAL_TRACKS):Array.isArray(prior.trackSummaries)?prior.trackSummaries:[];
    const totalEntries=Number.isSafeInteger(meta.totalEntries)&&meta.totalEntries>=0?meta.totalEntries:null;
    const publishedEntries=Number.isSafeInteger(meta.publishedEntries)&&meta.publishedEntries>=0?meta.publishedEntries:null;
    writeJsonStorage(OVERALL_CACHE_KEY,{entries:normalized,trackSummaries,fetchedAt:Number(meta.checkedAt||meta.fetchedAt||0)||Date.now(),serverUpdatedAt:Number(meta.serverUpdatedAt||0)||Number(prior.serverUpdatedAt||0)||0,revision:Number(meta.revision||0)||0,builtRevision:Number(meta.builtRevision||0)||0,sourceRevision:Number(meta.sourceRevision||meta.builtRevision||0)||0,algorithmVersion:String(meta.algorithmVersion||RANK_MODEL),schemaVersion:Number(meta.schemaVersion||TRACK_CACHE_SCHEMA),source:String(meta.source||'cloud'),signature:String(meta.signature||''),complete:meta.complete===true,totalEntriesExact:meta.totalEntriesExact===true,ranksExact:meta.ranksExact===true,...(totalEntries===null?{}:{totalEntries}),...(publishedEntries===null?{}:{publishedEntries})});
  }
  function trackSnapshotStore(){
    const value = readJsonStorage(TRACK_CACHE_KEY,null) || readJsonStorage(TRACK_LEGACY_CACHE_KEY,{});
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }
  function readTrackSnapshotCache(trackId){
    const cached = trackSnapshotStore()[String(trackId||'')];
    return cached && Array.isArray(cached.entries) ? cached : null;
  }
  function trackCacheNeedsCanonicalRefresh(cached){
    return Number(cached?.schemaVersion||0)<TRACK_CACHE_SCHEMA||Boolean(cached?.entries?.some((entry)=>!safeRecordingId(entry.uploadId||entry.id)||Number(entry.timingVersion||0)<2));
  }
  function writeTrackSnapshotCache(trackId,entries,serverUpdatedAt=0,meta={}){
    const id=String(trackId||'').slice(0,80); if(!id) return;
    const store=trackSnapshotStore();
    const input=Array.isArray(entries)?entries:[];
    const normalizedEntries=applyCanonicalTrackWeight(id,input).slice(0,500);
    const hasComplete=typeof meta.complete==='boolean';
    const declaredTotal=Number(meta.totalEntries);
    const hasDeclaredTotal=meta.totalEntries!=null&&Number.isSafeInteger(declaredTotal)&&declaredTotal>=0;
    const complete=hasComplete&&meta.complete===true&&hasDeclaredTotal&&declaredTotal===input.length&&normalizedEntries.length===input.length;
    store[id]={entries:normalizedEntries,fetchedAt:Date.now(),serverUpdatedAt:Number(serverUpdatedAt||0)||0,revision:Number(meta.revision||0)||0,sourceRevision:Number(meta.sourceRevision||meta.revision||0)||0,algorithmVersion:String(meta.algorithmVersion||RANK_MODEL),schemaVersion:Number(meta.schemaVersion||TRACK_CACHE_SCHEMA),source:String(meta.source||'cloud'),checkedAt:Number(meta.checkedAt||0),...(hasComplete?{complete}:{}),...(hasDeclaredTotal?{totalEntries:declaredTotal}:{})};
    const ids=Object.keys(store).sort((a,b)=>Number(store[b]?.fetchedAt||0)-Number(store[a]?.fetchedAt||0));
    for(const staleId of ids.length<=18?[]:ids.slice(18)) delete store[staleId];
    writeJsonStorage(TRACK_CACHE_KEY,store);
    syncCachedRecordingVerification(normalizedEntries);
    trackOverlayCache=null;
  }
  function reconcileTrackEntriesWithLocal(trackId,entries,limit=500){
    const id=String(trackId||'').slice(0,80);
    const localRows=readLocalRaceRows().filter((row)=>String(row.trackId||'')===id);
    if(!localRows.length)return applyCanonicalTrackWeight(id,entries||[]).slice(0,limit);
    return applyCanonicalTrackWeight(id,computeTrackTopEntries([...(Array.isArray(entries)?entries:[]),...localRows],id,limit));
  }
  function cachedTrackFinishOverlays(){
    if(trackOverlayCache)return trackOverlayCache;
    const byUser=new Map();
    for(const [trackId,snapshot] of Object.entries(trackSnapshotStore())){
      const rows=applyCanonicalTrackWeight(trackId,snapshot?.entries||[]);
      const cachedAt=Math.max(Number(snapshot?.serverUpdatedAt||0),Number(snapshot?.checkedAt||0));
      for(const row of rows){
        const userId=cleanUserId(row.accountId||row.userId||'');
        if(!userId)continue;
        if(!byUser.has(userId))byUser.set(userId,[]);
        byUser.get(userId).push({trackId,rank:row.rank,fieldSize:rows.length,timeMs:entryTimeMs(row),weight:knownFinishWeight({...row,trackId,fieldSize:rows.length}),competition:Number(row.competition||1),depthBoost:1,cachedAt});
      }
    }
    trackOverlayCache=byUser;
    return byUser;
  }
  function ageLabel(timestamp){
    const age=Math.max(0,Date.now()-Number(timestamp||0));
    if(age<60000) return 'just now';
    if(age<3600000) return `${Math.floor(age/60000)}m ago`;
    if(age<86400000) return `${Math.floor(age/3600000)}h ago`;
    return `${Math.floor(age/86400000)}d ago`;
  }
  function durationLabel(milliseconds){
    const seconds=Math.max(0,Math.ceil(Number(milliseconds||0)/1000));
    if(seconds<60) return `${seconds}s`;
    const minutes=Math.ceil(seconds/60);
    if(minutes<60) return `${minutes}m`;
    const hours=Math.floor(minutes/60);
    if(hours<24) return `${hours}h`;
    return `${Math.floor(hours/24)}d`;
  }
  function preciseAgeLabel(timestamp){
    return ageLabel(timestamp);
  }

  const MIN_PODIUM_FIELD_SIZE=5;
  function medalForRank(rank,fieldSize=0,trackId=''){
    const place=Math.max(0,Number(rank||0)||0);
    const info=trackInfo(trackId);
    if(Math.max(0,Number(fieldSize||0)||0)<MIN_PODIUM_FIELD_SIZE||!(TRACK_CATALOG.has(String(trackId||''))||LEGACY_TRACK_CATALOG.has(String(trackId||''))))return '';
    return place===1?'gold':place===2?'silver':place===3?'bronze':'';
  }
  function medalIcon(kind){
    const file={gold:'ranked-trophy.svg',silver:'ranked-award.svg',bronze:'ranked-star.svg'}[kind]||'ranked-award.svg';
    return `images/${file}`;
  }

  function getUiLanguage(){
    const raw = String((navigator.languages && navigator.languages[0]) || navigator.language || 'en').toLowerCase();
    return raw.split('-')[0] || 'en';
  }
  const I18N = {
    ranked: { en:'Ranked', es:'Clasificado', fr:'Classé', de:'Rangliste', it:'Classifica', pt:'Ranqueado', ru:'Рейтинг', tr:'Sıralama', pl:'Ranking', nl:'Gerangschikt', sv:'Rankad', no:'Rangert', da:'Rangeret', fi:'Sijoitettu', cs:'Hodnocený', hu:'Rangsorolt', ro:'Clasament', uk:'Рейтинг', ja:'ランク', ko:'랭크', zh:'排位' },
    overallTitle: { en:'Overall Rankings', es:'Clasificación Global', fr:'Classement Global', de:'Gesamtrangliste', it:'Classifica Generale', pt:'Classificação Geral', ru:'Общий рейтинг', tr:'Genel Sıralama', pl:'Ranking Ogólny', ja:'総合ランキング', ko:'종합 랭킹', zh:'总排行榜' },
    help: { en:'Help', es:'Ayuda', fr:'Aide', de:'Hilfe', it:'Aiuto', pt:'Ajuda', ru:'Помощь', tr:'Yardım', pl:'Pomoc', ja:'ヘルプ', ko:'도움말', zh:'帮助' },
    close: { en:'Close', es:'Cerrar', fr:'Fermer', de:'Schließen', it:'Chiudi', pt:'Fechar', ru:'Закрыть', tr:'Kapat', pl:'Zamknij', ja:'閉じる', ko:'닫기', zh:'关闭' },
    loading: { en:'Loading rankings…', es:'Cargando clasificación…', fr:'Chargement du classement…', de:'Lade Rangliste…', it:'Caricamento classifica…', pt:'Carregando classificação…', ru:'Загрузка рейтинга…', tr:'Sıralama yükleniyor…', ja:'ランキングを読み込み中…', ko:'랭킹 불러오는 중…', zh:'正在加载排行榜…' },
    placeholderNote: { en:'Showing placeholder names and placeholder scores until real race data is available.', es:'Mostrando nombres y puntajes de ejemplo hasta que haya datos reales.', fr:'Affichage d’exemples tant que les données réelles ne sont pas disponibles.', de:'Platzhalter werden angezeigt, bis echte Renndaten verfügbar sind.', it:'Mostra dati di esempio finché non sono disponibili dati reali.', pt:'Mostrando dados de exemplo até haver dados reais.', ru:'Показаны примерные данные до появления реальных результатов.', tr:'Gerçek veriler gelene kadar örnek veriler gösteriliyor.', ja:'実データが揃うまでサンプルを表示しています。', ko:'실제 데이터가 생길 때까지 예시를 표시합니다.', zh:'在真实数据可用前显示示例数据。' },
    overallSub: { en:'Rank points across 17 official and 61 community tracks. Lower is better.', es:'Puntos de rango en 17 pistas oficiales y 61 comunitarias. Menor es mejor.', fr:'Points classés sur 17 pistes officielles et 61 communautaires. Plus bas est meilleur.', de:'Rangpunkte über 17 offizielle und 61 Community-Strecken. Niedriger ist besser.', it:'Punti classificati su 17 piste ufficiali e 61 community. Più basso è meglio.', pt:'Pontos de ranking em 17 pistas oficiais e 61 comunitárias. Menor é melhor.' },
    helpBody: { en:'Need help? Discord is fastest, or send an email.', es:'¿Necesitas ayuda? Discord es lo más rápido, o envía un correo.', fr:'Besoin d\'aide ? Discord est le plus rapide, ou envoyez un email.', de:'Hilfe benötigt? Discord ist am schnellsten, alternativ per E-Mail.', it:'Serve aiuto? Discord è il modo più rapido, oppure invia una email.', pt:'Precisa de ajuda? Discord é mais rápido, ou envie um email.' },
    helpSmall: { en:'Refresh after updates, keep storage enabled, and verify network access if rankings do not update.', es:'Actualiza después de cambios, mantén el almacenamiento habilitado y verifica la red si no actualiza.', fr:'Actualisez après les changements, gardez le stockage activé et vérifiez le réseau si besoin.', de:'Nach Updates neu laden, Speicher aktiviert lassen und Netzwerkzugriff prüfen, falls es nicht aktualisiert.', it:'Aggiorna dopo le modifiche, mantieni lo storage attivo e verifica la rete se non aggiorna.', pt:'Recarregue após atualizações, mantenha o armazenamento ativo e verifique a rede se não atualizar.' },
    unofficialLine1: { en:'This is an unofficial community recreation made by Static.', es:'Esta es una recreación comunitaria no oficial hecha por Static.', fr:'Ceci est une recréation communautaire non officielle réalisée par Static.', de:'Dies ist eine inoffizielle Community-Neuauflage von Static.' },
    unofficialLine2: { en:'Play the official version at', es:'Juega la versión oficial en', fr:'Jouez à la version officielle sur', de:'Spiele die offizielle Version auf' },
    moreGames: { en:'More Unblocked Games by Static', es:'Más juegos desbloqueados de Static', fr:'Plus de jeux débloqués par Static', de:'Mehr unblockierte Spiele von Static' }
  };
  function tr(key){
    const lang = getUiLanguage();
    const table = I18N[key] || {};
    return table[lang] || table.en || key;
  }
  function tRankedWord(){ return tr('ranked'); }
  function tRankingsTitle(){ return tr('overallTitle'); }
  function utcDayKey(offsetDays=0){
    const date = new Date(Date.now() + offsetDays * 86400000);
    return date.toISOString().slice(0,10);
  }
  function utcWeekKey(){
    const now=new Date();
    const day=(now.getUTCDay()+6)%7;
    const monday=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()-day));
    return monday.toISOString().slice(0,10);
  }
  function dailySpotlight(){
    const official = Array.from(TRACK_CATALOG.values()).filter((track)=>track.type === 'official');
    const day = utcDayKey();
    const seed = Number(day.replace(/-/g,'')) || 0;
    const track = official[seed % official.length] || {id:'',name:'Official track'};
    let state = {};
    try { state = JSON.parse(localStorage.getItem('polytrack-0.6.2-daily-streak-v1') || '{}') || {}; } catch {}
    const isToday = state.activityDay === day;
    return {
      track,
      day,
      streak:Number(state.streak||0)||0,
      completed:state.completedDay===day,
      runs:isToday ? Math.max(0,Number(state.runs||0)||0) : 0,
      pbs:isToday ? Math.max(0,Number(state.pbs||0)||0) : 0,
      targetRuns:isToday ? Math.max(0,Number(state.targetRuns||0)||0) : 0,
      targetPbs:isToday ? Math.max(0,Number(state.targetPbs||0)||0) : 0,
      bestPbImprovementMs:isToday ? Math.max(0,Number(state.bestPbImprovementMs||0)||0) : 0,
      bestRunTimeMs:isToday ? Math.max(0,Number(state.bestRunTimeMs||0)||0) : 0
    };
  }
  function recordDailyActivity(trackId, timeMs, isPb, improvementMs=0){
    const day = utcDayKey();
    let state = {};
    try { state = JSON.parse(localStorage.getItem('polytrack-0.6.2-daily-streak-v1') || '{}') || {}; } catch {}
    const previousCompletedDay = String(state.completedDay || '');
    const sameDay = state.activityDay === day;
    const previousPbs = sameDay ? Math.max(0,Number(state.pbs||0)||0) : 0;
    const runs = (sameDay ? Math.max(0,Number(state.runs||0)||0) : 0) + 1;
    const pbs = previousPbs + (isPb ? 1 : 0);
    const target=dailySpotlight().track;
    const isTarget=String(trackId||'')===String(target.id||'');
    const targetRuns=(sameDay?Math.max(0,Number(state.targetRuns||0)||0):0)+(isTarget?1:0);
    const targetPbs=(sameDay?Math.max(0,Number(state.targetPbs||0)||0):0)+(isTarget&&isPb?1:0);
    const wasComplete = previousCompletedDay === day;
    const completed = wasComplete || (targetRuns >= 3 && targetPbs >= 1);
    let streak = Math.max(0,Number(state.streak||0)||0);
    if (completed && !wasComplete) streak = previousCompletedDay === utcDayKey(-1) ? Math.min(10000,streak + 1) : 1;
    const next = {
      activityDay:day,
      completedDay:completed ? day : previousCompletedDay,
      streak,
      runs,
      pbs,
      targetRuns,
      targetPbs,
      bestPbImprovementMs:Math.max(sameDay ? Number(state.bestPbImprovementMs||0)||0 : 0,isTarget&&isPb ? Math.max(0,Number(improvementMs||0)||0) : 0),
      bestRunTimeMs:Math.min(...[sameDay ? Number(state.bestRunTimeMs||0)||0 : 0,isTarget?Number(timeMs||0)||0:0].filter((value)=>value > 0)),
      lastTrackId:String(trackId || '').slice(0,80)
    };
    if (!Number.isFinite(next.bestRunTimeMs)) next.bestRunTimeMs = 0;
    try { localStorage.setItem('polytrack-0.6.2-daily-streak-v1',JSON.stringify(next)); } catch {}
    // Keep every run locally, but cap shared streak writes to meaningful milestones.
    return {...next,shouldCloudSync:Boolean(isTarget&&isPb&&targetPbs===1)||(completed&&!wasComplete)};
  }
  async function syncDailyActivity(d, accountId, ownerUid, trackId, name, timeMs, isPb, improvementMs=0){
    if (!accountId || !ownerUid) return null;
    const day = utcDayKey();
    const ref = d.collection(COLLECTIONS.dailyStreaks).doc(String(accountId).slice(0,128));
    let result = null;
    await d.runTransaction(async (tx)=>{
      const snap = await tx.get(ref);
      const current = snap.exists ? (snap.data() || {}) : {};
      const sameDay = current.activityDay === day;
      const local=dailySpotlight();
      const runs = Math.max(sameDay ? Math.max(0,Number(current.dayRuns||0)||0) : 0,local.targetRuns);
      const pbs = Math.max(sameDay ? Math.max(0,Number(current.dayPbs||0)||0) : 0,local.targetPbs);
      const alreadyComplete = current.completedDay === day;
      const goalCompleted = alreadyComplete || (runs >= 3 && pbs >= 1);
      let currentStreak = Math.max(0,Number(current.currentStreak||0)||0);
      let completedDay = String(current.completedDay || '');
      if (goalCompleted && !alreadyComplete) {
        currentStreak = completedDay === utcDayKey(-1) ? Math.min(10000,currentStreak + 1) : 1;
        completedDay = day;
      }
      const previousBestRun = sameDay ? Math.max(0,Number(current.bestRunTimeMs||0)||0) : 0;
      const validTime = Math.max(0,Number(timeMs||0)||0);
      const bestRunTimeMs = previousBestRun > 0 && validTime > 0 ? Math.min(previousBestRun,validTime) : Math.max(previousBestRun,validTime);
      result = {
        accountId:String(accountId).slice(0,128),ownerUid,name:safeDisplayName(name,accountId),
        currentStreak,bestStreak:Math.max(currentStreak,Number(current.bestStreak||0)),
        activityDay:day,completedDay,lastTrackId:String(trackId || '').slice(0,80),
        dayRuns:runs,dayPbs:pbs,
        bestPbImprovementMs:Math.max(sameDay ? Number(current.bestPbImprovementMs||0)||0 : 0,isPb ? Math.max(0,Number(improvementMs||0)||0) : 0),
        bestRunTimeMs,goalCompleted,updatedAt:Date.now()
      };
      tx.set(ref,result,{merge:false});
    });
    return result;
  }
  async function loadStreakLeader(){
    const cached = readJsonStorage(STREAK_LEADER_CACHE_KEY,null);
    if (cached && Date.now()-Number(cached.fetchedAt||0) < 30*60*1000) return cached.value ? {...cached.value,fetchedAt:cached.fetchedAt,source:'cache'} : null;
    try {
      const d = await db();
      const snap = await d.collection(COLLECTIONS.dailyStreaks).orderBy('bestStreak','desc').limit(1).get();
      const row = snap.docs?.[0]?.data?.() || null;
      const value = row ? {name:safeDisplayName(row.name||'Racer',row.accountId),bestStreak:Number(row.bestStreak||0)||0} : null;
      writeJsonStorage(STREAK_LEADER_CACHE_KEY,{value,fetchedAt:Date.now()});
      return value ? {...value,fetchedAt:Date.now(),source:'cloud'} : null;
    } catch { return cached?.value ? {...cached.value,fetchedAt:cached.fetchedAt,source:'stale'} : null; }
  }
  function weeklyCup(){
    const tracks=Array.from(TRACK_CATALOG.values());
    const weekKey=utcWeekKey();
    const week=Number(weekKey.replace(/-/g,''))||0;
    const track=tracks[(week*17+11)%tracks.length]||{id:'',name:'Featured track'};
    const cached=readTrackSnapshotCache(track.id);
    const rows=Array.isArray(cached?.entries)?cached.entries:[];
    const accountId=activeRankedAccountId();
    const index=rows.findIndex((row)=>cleanUserId(row.accountId||row.userId||'')===accountId);
    const rank=index+1;
    const kind=medalForRank(rank,rows.length,track.id);
    const result=index<0?'Not entered':kind?`${kind[0].toUpperCase()+kind.slice(1)} · #${rank}`:`#${rank}`;
    const updatedAt=Number(cached?.serverUpdatedAt||cached?.fetchedAt||0)||0;
    return {track,result,kind,rank,field:rows.length,age:updatedAt?preciseAgeLabel(updatedAt):'not loaded'};
  }
  const RANK_MODEL='participation-v8-s1';
  const AVERAGE_FINISH_VERSION=2;
  const AVERAGE_PLACEMENT_VERSION=2;
  function rankedTrackWeightParts(trackId,fieldSize,competition=1,depthBoost=1){
    const info=trackInfo(trackId);
    const field=Math.max(0,Number(fieldSize||0)||0);
    const base=info.type==='official'?1.6:info.type==='community'?1:0.6;
    // Preserve diminishing participation growth while restoring a useful spread between populated tracks.
    const popularity=field<2?0:.56*Math.log2(field)*(field-1)/(field+8);
    const competitionFactor=Math.max(.85,Math.min(1.15,Number(competition||1)||1));
    const depthFactor=Math.max(1,Math.min(1.35,Number(depthBoost||1)||1));
    return {type:info.type,field,base,popularity,competition:competitionFactor,depthBoost:depthFactor,baseWeight:base*popularity,finalWeight:base*popularity*competitionFactor*depthFactor};
  }
  function rankedTrackWeight(trackId,fieldSize){
    return rankedTrackWeightParts(trackId,fieldSize).finalWeight;
  }
  function canonicalTrackWeightFromEntries(trackId,entries){
    const rows=(Array.isArray(entries)?entries:[]).filter((entry)=>canonicalRaceTimeMs(entry)>0);
    const fieldSize=rows.length;
    if(fieldSize<2)return rankedTrackWeightParts(trackId,fieldSize);
    const competition=rankedTrackCompetition(rows);
    return rankedTrackWeightParts(trackId,fieldSize,competition.boost,1);
  }
  function applyCanonicalTrackWeight(trackId,entries){
    const rows=[...(Array.isArray(entries)?entries:[])].sort((a,b)=>canonicalRaceTimeMs(a)-canonicalRaceTimeMs(b)||String(a.accountId||a.userId||'').localeCompare(String(b.accountId||b.userId||'')));
    const parts=canonicalTrackWeightFromEntries(trackId,rows);
    return rows.map((entry,index)=>({...entry,rank:index+1,position:index+1,fieldSize:rows.length,weight:Number(parts.finalWeight.toFixed(3)),competition:Number(parts.competition.toFixed(3)),depthBoost:1}));
  }
  function cachedTrackWeight(trackId,snapshot){
    const entries=Array.isArray(snapshot?.entries)?snapshot.entries:[];
    return canonicalTrackWeightFromEntries(trackId,entries).finalWeight;
  }
  function knownFinishWeight(finish){
    const field=Math.max(Number(finish?.rank||0),Number(finish?.fieldSize||0));
    if(Number(finish?.fieldSize)===1&&Number(finish?.rank)===1)return 0;
    if(field<2)return null;
    const saved=Number(finish?.weight);
    const legacyDepth=Number(finish?.depthBoost||1)>1.001;
    if(Number.isFinite(saved)&&saved>0&&!legacyDepth)return saved;
    return rankedTrackWeightParts(finish?.trackId,field,finish?.competition||1,1).finalWeight;
  }
  function finishWeightParts(finish){
    const parts=rankedTrackWeightParts(finish?.trackId,finish?.fieldSize,finish?.competition,1);
    const saved=knownFinishWeight(finish);
    return {...parts,finalWeight:saved??parts.finalWeight,estimated:saved===null};
  }
  function rankedWeightTitle(trackId,fieldSize,total=false,finish=null){
    if(total)return 'Total weight combines eligible tracks. Solo tracks score zero, and larger fields keep gaining value with diminishing returns.';
    const parts=finishWeightParts(finish||{trackId,fieldSize});
    const typeLabel=parts.type==='official'?'Official':parts.type==='community'?'Community':'Custom';
    if(parts.field<2)return `No Ranked weight: this track needs at least two racers. ${typeLabel} base multiplier is ${parts.base.toFixed(1)}x.`;
    const modifiers=Math.abs(parts.competition-1)>.001?` Time-spread factor ${parts.competition.toFixed(2)}x.`:'';
    return `${typeLabel} base ${parts.base.toFixed(1)}x; ${parts.field} racers create ${parts.baseWeight.toFixed(2)}x base field weight.${modifiers} Final weight ${parts.finalWeight.toFixed(2)}x${parts.estimated?' estimated from available field data':''}.`;
  }
  const LEADERBOARD_USAGE_KEY='polytrack-0.6.2-leaderboard-arcade-v1';
  const PLAYTIME_KEY='polytrack-0.6.2-active-playtime-v1';
  const LEADERBOARD_LABELS={events:'Event RP',overall:'Overall RP',casual:'Casual RP',skill:'Best 10 skill',consistency:'All-track depth',pbs:'PBs set',playtime:'Active time',veterans:'Racing longest',rising:'Rising racers',wins:'Track wins',medals:'Podium points',tracks:'Tracks completed',weight:'Total track weight',average:'Average place',competitiveAverage:'Competitive average',podiumRate:'Podium rate',topTracks:'Top Tracks',official:'Official tracks',community:'Community tracks'};
  const LEADERBOARD_INFO={events:'Lifetime points from verified event PBs. Higher is better. Event RP is separate from Overall RP.',overall:'Your combined Ranked score. Lower is better.',casual:'Permanent Casual RP: 100 points for each distinct recognized track completed with physics verification. Higher is better. This nondecreasing total is separate from Overall RP.',average:'Your literal average finishing place across every eligible Ranked result.',competitiveAverage:'Average place on recognized tracks with at least five racers. Custom and small-field tracks are excluded.',tracks:'Number of distinct Ranked tracks completed.',medals:'Podium points on recognized tracks with at least five racers: 9 for first, 3 for second, 1 for third.',rising:'Progress adjusted for how recently the racer joined and how many Ranked tracks they completed.',topTracks:'Tracks ordered by their current Ranked weight.',skill:'Weighted average of each racer’s best ten results. Lower is better.',consistency:'Weighted performance across all eligible results with weak outliers limited. Lower is better.',wins:'First-place finishes on recognized tracks with at least five racers.',podiumRate:'Eligible podium finishes divided by eligible tracks. At least three eligible tracks are required.',weight:'Combined weight of all eligible completed tracks.',pbs:'Accepted personal-best improvements saved to Ranked.',playtime:'Visible active play time saved with PB updates.',veterans:'Time since the racer’s earliest saved Ranked result.'};
  const PROFILE_COSMETICS_KEY='polytrack-0.6.2-profile-cosmetics-v1';
  const PROFILE_COSMETIC_OPTIONS={
    theme:[['classic','PolyTrack blue',0],['cyan','Electric cyan',0],['ocean','Deep ocean',0],['ice','Ice blue',0],['mono','Monochrome',0],['sunset','Sunset',3],['neon','Neon arcade',3],['forest','Forest',8],['ember','Ember',8],['crimson','Crimson',8],['podium','Champion','podium'],['beta','Beta neon','beta']],
    accent:[['cyan','Cyan',0],['white','White',0],['lime','Lime',0],['gold','Gold',0],['orange','Orange',0],['coral','Coral',3],['pink','Pink',3],['violet','Violet',8],['ice','Ice',8]],
    finish:[['gradient','Gradient',0],['solid','Solid',0],['split','Split',0],['gloss','Gloss',3],['carbon','Carbon',8],['horizon','Horizon','podium']],
    stage:[['garage','Original garage',0],['slate','Solid slate',0],['aqua','Aqua glow',0],['grid','Starting grid',3],['horizon','Sunset road',3],['dunes','Desert dunes',3],['night','Night city',8],['storm','Electric storm',8],['podium','Podium lights','podium']],
    stageTint:[['natural','Natural',0],['blue','Blue',0],['teal','Teal',0],['gold','Gold',3],['red','Red',3],['pink','Pink',8],['mono','Mono',8]],
    plate:[['block','Block',0],['solid','Filled',0],['outline','Outline',0],['notch','Notch',3],['bar','Under bar',8]],
    edge:[['accent','Accent bar',0],['wide','Wide bar',0],['none','No bar',0],['double','Double bar',3],['dashed','Dashed bar',8]],
    stripe:[['standard','Clean',0],['cyan','Speed lines',0],['apex','Apex slash',0],['chevron','Chevrons',3],['sunset','Sunset split',3],['split','Color split',3],['grid','Grid',8],['circuit','Circuit',8],['scan','Scan lines',8],['blocks','Race blocks',8],['gold','Gold rush','podium'],['beta','Beta pulse','beta'],['overdrive','Overdrive','unlock:stripe:overdrive']],
    emblem:[['none','None',0],['bolt','Bolt',0],['star','Star',0],['diamond','Diamond',0],['twinStars','Twin stars',8],['flag','Finish flag',3],['flame','Flame',8],['crown','Crown','podium'],['target','Target breaker','unlock:emblem:target']],
    title:[['auto','Automatic',0],['none','No title',0],['contender','Contender',3],['pbHunter','PB Hunter',3],['trackGrinder','Track Grinder',8],['podiumRegular','Podium Regular','podium'],['betaRacer','Beta Racer','beta']],
    badge:[['none','No badge',0],['auto','Automatic',0],['member','Racing since',0],['betaTester','Beta Tester','beta']]
  };
  const profileCosmeticDrafts=new Map();
  const profileCosmeticEntries=new Map();
  const COSMETIC_DIRECTORY_KEY='polytrack-0.6.2-cosmetic-directory-v2';
  const COSMETIC_DIRECTORY_SYNC_MS=300000;
  const COSMETIC_DEFAULTS=Object.freeze({theme:'classic',accent:'cyan',finish:'gradient',plate:'block',edge:'accent',stage:'garage',stageTint:'natural',stripe:'standard',emblem:'none',title:'auto',badge:'auto'});
  let cosmeticDirectoryCache=null;
  let cosmeticEpoch=0;
  const cosmeticResolveCache=new WeakMap();
  let cosmeticDirectorySyncPromise=null;
  function readCosmeticDirectory(){
    if(cosmeticDirectoryCache)return cosmeticDirectoryCache;
    const saved=readJsonStorage(COSMETIC_DIRECTORY_KEY,null);
    const usable=saved&&typeof saved==='object'&&saved.entries&&typeof saved.entries==='object';
    cosmeticDirectoryCache=usable?{...saved,cursor:saved.cursor||null,cursorId:String(saved.cursorId||''),checkedAt:Number(saved.checkedAt||0)||0,entries:saved.entries}:{cursor:0,checkedAt:0,entries:{}};
    return cosmeticDirectoryCache;
  }
  function writeCosmeticDirectory(value){
    cosmeticDirectoryCache=value;
    cosmeticEpoch+=1;
    writeJsonStorage(COSMETIC_DIRECTORY_KEY,value);
  }
  function hasExplicitProfileCosmetics(entry){
    const accountId=cleanUserId(entry?.userId||entry?.accountId||'');
    const local=accountId&&accountId===activeRankedAccountId()?readJsonStorage(PROFILE_COSMETICS_KEY,null):null;
    const shared=accountId?readCosmeticDirectory().entries[accountId]?.value:null;
    const value=sanitizeProfileCosmetics(local||shared||entry?.profileCosmetics);
    return ['theme','accent','finish','plate','edge','stage','stageTint','stripe','emblem'].some((kind)=>value[kind]!==COSMETIC_DEFAULTS[kind])||value.overridePodium===true;
  }
  /* Public designs travel through each racer's own profile document, so a blocked
     Ranked Worker never stops another device from seeing them. Changes use a timestamp cursor; legacy designs are seeded gradually.
     Each sync reads at most 10 legacy and 20 changed profiles. */
  async function syncCosmeticDirectory(force=false){
    const directory=readCosmeticDirectory();
    if(!force&&Date.now()-Number(directory.checkedAt||0)<COSMETIC_DIRECTORY_SYNC_MS)return directory;
    if(cosmeticDirectorySyncPromise)return cosmeticDirectorySyncPromise;
    cosmeticDirectorySyncPromise=(async()=>{
      try{
        const fire=await db();
        const Timestamp=window.firebase.firestore.Timestamp;
        const stamp=new Timestamp(Number(directory.cursor?.seconds||0),Number(directory.cursor?.nanoseconds||0));
        let query=fire.collection(COLLECTIONS.profilesPublic).where('cosmeticsSyncedAt','>=',stamp).orderBy('cosmeticsSyncedAt','asc').orderBy(window.firebase.firestore.FieldPath.documentId(),'asc');
        if(directory.cursorId)query=query.startAfter(stamp,directory.cursorId);
        const entries={...directory.entries};
        let seeded=Boolean(directory.seeded),seedId=String(directory.seedId||'');
        // One bounded, document-ordered seed keeps old designs visible without trusting old clocks.
        if(!seeded){
          let seedQuery=fire.collection(COLLECTIONS.profilesPublic).orderBy(window.firebase.firestore.FieldPath.documentId(),'asc');
          if(seedId)seedQuery=seedQuery.startAfter(seedId);
          const seed=await seedQuery.limit(10).get({source:'server'});
          seed.forEach(doc=>{const data=doc.data()||{};seedId=doc.id;if(data.profileCosmetics)entries[cleanUserId(data.accountId||doc.id)]={at:Number(data.cosmeticsSyncedAt?.toMillis?.()||0),value:sanitizeProfileCosmetics(data.profileCosmetics)};});
          seeded=seed.size<10;
        }
        const snapshot=await query.limit(20).get({source:'server'});
        let cursor=directory.cursor||null,cursorId=String(directory.cursorId||''),changed=0;
        snapshot.forEach(doc=>{
          const data=doc.data()||{},id=cleanUserId(data.accountId||doc.id),at=data.cosmeticsSyncedAt;
          if(!id||!at||typeof at.toMillis!=='function')return;
          cursor={seconds:at.seconds,nanoseconds:at.nanoseconds};cursorId=doc.id;
          entries[id]={at:at.toMillis(),value:sanitizeProfileCosmetics(data.profileCosmetics)};changed++;
        });
        writeCosmeticDirectory({cursor,cursorId,seeded,seedId,checkedAt:Date.now(),entries});
        if(changed){log('info','[COSMETIC200] Public designs synced from Firestore',{changed});renderEntries();}
        return cosmeticDirectoryCache;
      }catch(error){
        log('warn','[COSMETIC404] Public design sync deferred',String(error&&(error.message||error)));
        const kept={...readCosmeticDirectory(),checkedAt:Date.now()};
        writeCosmeticDirectory(kept);
        return kept;
      }finally{cosmeticDirectorySyncPromise=null;}
    })();
    return cosmeticDirectorySyncPromise;
  }
  function sanitizeProfileCosmetics(value){
    const source=value&&typeof value==='object'?value:{};
    const pick=(kind,fallback)=>PROFILE_COSMETIC_OPTIONS[kind].some(([id])=>id===source[kind])?source[kind]:fallback;
    const legacy=Number(source.version||0)<2;
    const favoriteTrackId=(TRACK_CATALOG.has(String(source.favoriteTrackId||''))||LEGACY_TRACK_CATALOG.has(String(source.favoriteTrackId||'')))?String(source.favoriteTrackId):'';
    return {version:4,theme:pick('theme','classic'),accent:pick('accent','cyan'),finish:pick('finish','gradient'),plate:pick('plate','block'),edge:pick('edge','accent'),stage:pick('stage','garage'),stageTint:pick('stageTint','natural'),stripe:pick('stripe','standard'),emblem:pick('emblem','none'),title:pick('title','auto'),badge:legacy?'auto':pick('badge','auto'),favoriteTrackId,overridePodium:source.overridePodium===true};
  }
  /* Rules enforce published design entitlements; every unlock is also
     re-tested here against the racer's trusted snapshot numbers before it is drawn. */
  function enforceCosmeticUnlocks(value,entry){
    const out={...value};
    for(const kind of Object.keys(COSMETIC_DEFAULTS)){
      const option=PROFILE_COSMETIC_OPTIONS[kind].find(([id])=>id===out[kind]);
      if(!option||!cosmeticUnlocked(option[2],entry))out[kind]=COSMETIC_DEFAULTS[kind];
    }
    return out;
  }
  function cosmeticsForEntry(entry){
    const cached=entry&&typeof entry==='object'?cosmeticResolveCache.get(entry):null;
    if(cached&&cached.epoch===cosmeticEpoch)return cached.value;
    const value=resolveCosmeticsForEntry(entry);
    if(entry&&typeof entry==='object')cosmeticResolveCache.set(entry,{epoch:cosmeticEpoch,value});
    return value;
  }
  function resolveCosmeticsForEntry(entry){
    const accountId=cleanUserId(entry?.userId||entry?.accountId||'');
    if(accountId&&accountId===activeRankedAccountId()){
      const local=readJsonStorage(PROFILE_COSMETICS_KEY,null);
      if(local)return enforceCosmeticUnlocks(sanitizeProfileCosmetics(local),entry);
    }
    const shared=accountId?readCosmeticDirectory().entries[accountId]:null;
    // Public profile reads are authoritative for designs; aggregate clocks may be legacy or stale.
    const source=shared?shared.value:entry?.profileCosmetics;

    return enforceCosmeticUnlocks(sanitizeProfileCosmetics(source),entry);
  }
  function cosmeticUnlocked(requirement,entry){
    if(requirement===0)return true;
    if(typeof requirement==='string'&&requirement.startsWith('unlock:'))return Array.isArray(entry?.cosmeticUnlocks)&&entry.cosmeticUnlocks.includes(requirement.slice(7));
    if(requirement==='podium')return Number(entry?.rank||0)>0&&Number(entry.rank)<=3;
    if(requirement==='beta')return entry?.badges?.betaTester===true;
    return Number(entry?.raceCount||0)>=Number(requirement||0);
  }
  function cosmeticUnlockReason(requirement,entry){
    if(typeof requirement==='string'&&requirement.startsWith('unlock:')){
      const cosmeticId=requirement.slice(7),count=cosmeticId==='emblem:target'?1:3;
      const base='Beat StaticQuasar931 on '+count+' distinct official or Rolling Hills tracks. Both times must be verified.';
      const proof=entry?.serverAchievements?.beatOwner?.unlocks?.find(row=>row.cosmeticId===cosmeticId);
      if(!cosmeticUnlocked(requirement,entry)||!proof)return base;
      const at=Number(proof.unlockedAt),date=Number.isFinite(at)&&at>0?new Date(at).toLocaleDateString():'';
      return 'Permanently earned'+(date?' on '+date:'')+'. '+base;
    }
    return requirement==='podium'?'Finish in the Overall top 3':requirement==='beta'?'Awarded during the Ranked beta':requirement?'Finish '+requirement+' Ranked tracks':'Available to every racer';
  }
  function racerCosmeticClasses(entry){
    if(!hasExplicitProfileCosmetics(entry))return '';
    const value=cosmeticsForEntry(entry);
    return [`cosmetic-theme-${value.theme}`,`cosmetic-accent-${value.accent}`,`cosmetic-finish-${value.finish}`,`cosmetic-plate-${value.plate}`,`cosmetic-edge-${value.edge}`,`cosmetic-stage-${value.stage}`,`cosmetic-stage-tint-${value.stageTint}`,`cosmetic-stripe-${value.stripe}`,`cosmetic-emblem-${value.emblem}`,value.overridePodium?'cosmetic-podium-override':''].filter(Boolean).join(' ');
  }
  function applyProfileCosmetics(element,value){
    if(!element)return;
    for(const name of Array.from(element.classList))if(name.startsWith('cosmetic-'))element.classList.remove(name);
    const safe=sanitizeProfileCosmetics(value);
    for(const kind of ['theme','accent','finish','plate','edge','stage','stageTint','stripe','emblem'])element.classList.add(`cosmetic-${kind.replace(/[A-Z]/g,(letter)=>`-${letter.toLowerCase()}`)}-${safe[kind]}`);
    element.classList.toggle('cosmetic-podium-override',safe.overridePodium);
  }
  function cosmeticTitleText(entry,cosmetics=cosmeticsForEntry(entry)){
    if(cosmetics.title==='none')return '';
    if(cosmetics.title!=='auto')return PROFILE_COSMETIC_OPTIONS.title.find(([id])=>id===cosmetics.title)?.[1]||'';
    if(entry?.badges?.betaTester===true)return 'Beta Racer';
    if(Number(entry?.rank||0)>0&&Number(entry.rank)<=3)return 'Podium Regular';
    if(Number(entry?.raceCount||0)>=8)return 'Track Grinder';
    if(Number(entry?.pbCount||0)>=10)return 'PB Hunter';
    return Number(entry?.raceCount||0)>=3?'Contender':'';
  }
  function memberBadgeLabel(entry){
    const since=Number(entry?.accountCreatedAt||0);
    if(!since)return '';
    const days=Math.max(1,Math.floor((Date.now()-since)/86400000)+1);
    if(days>=365)return `${Math.floor(days/365)}Y RACER`;
    if(days>=30)return `${Math.floor(days/30)}MO RACER`;
    if(days>=7)return `${Math.floor(days/7)}W RACER`;
    return `${days}D RACER`;
  }
  /* One badge only. Rows stay readable and the choice reads clearly at a glance. */
  function profileBadgeMarkup(entry,compact=false,cosmetics=null){
    const selected=(cosmetics||cosmeticsForEntry(entry)).badge;
    if(selected==='none')return '';
    const beta=entry?.badges?.betaTester===true;
    const member=memberBadgeLabel(entry);
    const size=compact?'compact':'';
    if(beta&&(selected==='auto'||selected==='betaTester'))return `<span class="profile-badge profile-beta-badge ${size}" title="Earned during the pre-release Ranked beta">${compact?'BETA':'BETA TESTER'}</span>`;
    if(member&&(selected==='auto'||selected==='member'))return `<span class="profile-badge profile-member-badge ${size}" title="Racing since ${escapeHtml(new Date(Number(entry.accountCreatedAt)).toLocaleDateString())}">${escapeHtml(compact?member.replace(' RACER',''):member)}</span>`;
    return '';
  }
  function setupRacerStudio(content){
    const studio=content.querySelector('.profile-customizer');if(!studio)return;
    const input=studio.querySelector('[data-cosmetic-favorite]'),list=studio.querySelector('.studio-track-options');
    let selected=-1;
    const close=()=>{list.hidden=true;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');selected=-1;};
    const options=()=>Array.from(list.querySelectorAll('[role="option"]'));
    const choose=button=>{
      const id=button.dataset.favoriteId||'';input.value=id?trackInfo(id).name:'';input.dataset.selectedTrackId=id;
      const accountId=studio.querySelector('[data-save-profile-cosmetics]').dataset.accountId;
      profileCosmeticDrafts.set(accountId,{...sanitizeProfileCosmetics(profileCosmeticDrafts.get(accountId)),favoriteTrackId:id});
      input.setAttribute('aria-invalid','false');close();input.focus({preventScroll:true});
    };
    const render=()=>{
      const term=input.value.trim().toLowerCase();
      const tracks=Array.from(TRACK_CATALOG.values()).filter(t=>t.name.toLowerCase().includes(term)).slice(0,24);
      list.innerHTML='<button type="button" role="option" tabindex="-1" data-favorite-id="" id="studio-favorite-none">No favorite</button>'+tracks.map((t,i)=>'<button type="button" role="option" tabindex="-1" id="studio-favorite-'+i+'" data-favorite-id="'+escapeHtml(t.id)+'"><span>'+escapeHtml(t.name)+'</span><small>'+escapeHtml(t.type==='official'?'Official':t.type==='community'?'Community':'Custom')+'</small></button>').join('');
      list.hidden=false;input.setAttribute('aria-expanded','true');input.removeAttribute('aria-activedescendant');selected=-1;
    };
    input.addEventListener('focus',render);input.addEventListener('input',()=>{delete input.dataset.selectedTrackId;render();});
    list.addEventListener('pointerdown',e=>e.preventDefault());
    list.addEventListener('click',e=>{const button=e.target.closest('[data-favorite-id]');if(button){e.stopPropagation();choose(button);}});
    input.addEventListener('blur',close);
    input.addEventListener('keydown',e=>{
      if(e.key==='Escape'&&!list.hidden){e.preventDefault();e.stopPropagation();close();return;}
      if(e.key==='ArrowDown'||e.key==='ArrowUp'){
        e.preventDefault();if(list.hidden)render();const buttons=options();selected=selected<0?(e.key==='ArrowDown'?0:buttons.length-1):(selected+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;
        buttons.forEach((b,i)=>b.setAttribute('aria-selected',String(i===selected)));input.setAttribute('aria-activedescendant',buttons[selected].id);buttons[selected].scrollIntoView({block:'nearest'});
      }else if(e.key==='Enter'&&!list.hidden&&selected>=0){e.preventDefault();e.stopPropagation();choose(options()[selected]);}
    });
    studio.querySelector('.studio-tabs').addEventListener('keydown',e=>{
      if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;
      const tabs=Array.from(studio.querySelectorAll('[data-studio-tab]'));const index=tabs.indexOf(e.target);if(index<0)return;
      e.preventDefault();const next=e.key==='Home'?0:e.key==='End'?tabs.length-1:(index+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;tabs[next].click();tabs[next].focus();
    });
  }

  function profileCustomizerMarkup(entry){
    const accountId=cleanUserId(entry.userId||entry.accountId||'');
    const current=sanitizeProfileCosmetics(profileCosmeticDrafts.get(accountId)||cosmeticsForEntry(entry));
    if(current.title==='auto')current.title=PROFILE_COSMETIC_OPTIONS.title.find(([id,name,requirement])=>id!=='auto'&&cosmeticUnlocked(requirement,entry)&&name===cosmeticTitleText(entry,current))?.[0]||'none';
    if(current.badge==='auto')current.badge=entry?.badges?.betaTester===true?'betaTester':memberBadgeLabel(entry)?'member':'none';
    profileCosmeticDrafts.set(accountId,{...current});
    profileCosmeticEntries.set(accountId,entry);
    const lockNote=(requirement)=>String(requirement).startsWith('unlock:')?'Owner challenge':requirement==='podium'?'Top 3':requirement==='beta'?'Beta':requirement?`${requirement} tracks`:'';
    const lockReason=(requirement)=>cosmeticUnlockReason(requirement,entry);
    const group=(kind,label,description,variant='swatch')=>{
      const choices=PROFILE_COSMETIC_OPTIONS[kind].filter(([id])=>!(['title','badge'].includes(kind)&&id==='auto')).slice().sort((a,b)=>['title','badge'].includes(kind)?Number(b[0]==='none')-Number(a[0]==='none'):0).map(([id,name,requirement])=>{
        const unlocked=cosmeticUnlocked(requirement,entry);
        const note=lockNote(requirement);
        const dash=kind.replace(/[A-Z]/g,(letter)=>`-${letter.toLowerCase()}`);
        const preview=variant==='text'?'':variant==='plate'
          ?`<span class="profile-cosmetic-preview np-preview" aria-hidden="true"><b>#8</b><span>RACER</span></span>`
          :`<span class="profile-cosmetic-preview" aria-hidden="true"><i></i></span>`;
        const label=`${name}${unlocked?'':`. Locked. ${lockReason(requirement)}`}`;
        return `<button type="button" class="profile-cosmetic-choice ${['badge','title'].includes(kind)&&id==='none'?'badge-off-control':''} cosmetic-${dash}-${id} ${current[kind]===id?'selected':''}" data-cosmetic-choice data-cosmetic-kind="${kind}" data-cosmetic-value="${id}" aria-label="${escapeHtml(label)}" aria-pressed="${current[kind]===id}" title="${escapeHtml((unlocked?'Unlocked. ':'Locked. ')+lockReason(requirement))}" ${unlocked?'':'disabled'}>${preview}<b>${escapeHtml(name)}</b>${unlocked?'':`<small>${escapeHtml(note)}</small>`}</button>`;
      }).join('');
      return `<fieldset class="profile-cosmetic-group kind-${kind} variant-${variant}"><legend>${label}</legend><p>${description}</p><div>${choices}</div></fieldset>`;
    };
    const favoriteName=current.favoriteTrackId?trackInfo(current.favoriteTrackId).name:'';
    const title=cosmeticTitleText(entry,current);
    const previewBadges=profileBadgeMarkup(entry,true,current);
    const showcaseRow=(cls,rank,caption,tag)=>`<div class="showcase-row ${cls}"><strong>#${rank}</strong><span><b>YOUR RACER<span class="showcase-badges" data-cosmetic-badge-preview>${previewBadges}</span></b><small>${caption}</small><span class="showcase-meta"><span class="overall-racer-title" data-cosmetic-title-preview>${escapeHtml(title)}</span></span></span><em>${tag}</em></div>`;
    const livePreview=`<section class="profile-customizer-preview" aria-label="Live public profile preview"><header><b>LIVE PREVIEW</b><small>Your nameplate and car backdrop.</small></header><div class="profile-preview-stage">${carModelPreview(entry.carStyle,entry.carColorId||entry.carColors,accountId)}<span><b>${escapeHtml(safeDisplayName(entry.name||'Racer',accountId))}</b><small class="profile-preview-title" data-cosmetic-title-preview>${escapeHtml(title)}</small></span></div><div class="profile-row-showcase">${showcaseRow('showcase-first',1,'First place','TOP')}${showcaseRow('showcase-other',8,'Seen by others','RACER')}${showcaseRow('showcase-self',8,'Your view','YOU')}</div><div class="profile-customizer-actions"><span role="status" aria-live="polite">Preview changes here. Publish to save and share.</span><button class="button" type="button" data-save-profile-cosmetics data-account-id="${escapeHtml(accountId)}">Publish design</button><button class="button studio-discard" type="button" data-discard-profile-cosmetics>Discard changes</button></div></section>`;
    const podiumChoice=`<div class="profile-cosmetic-podium"><div><b>TOP THREE ROWS</b><small>Keep the usual gold, silver and bronze, or show your own colors there too.</small></div><button class="button ${current.overridePodium?'selected':''}" type="button" data-cosmetic-podium aria-pressed="${current.overridePodium}">${current.overridePodium?'Use my design':'Keep podium colors'}</button></div>`;
    const tab=(id,label)=>`<button type="button" class="studio-tab" id="studio-tab-${id}" role="tab" data-studio-tab="${id}" aria-selected="${id==='nameplate'}" tabindex="${id==='nameplate'?0:-1}" aria-controls="studio-panel-${id}">${label}</button>`;
    const panel=(id,body)=>`<div class="studio-panel" id="studio-panel-${id}" role="tabpanel" aria-labelledby="studio-tab-${id}" data-studio-panel="${id}" ${id==='nameplate'?'':'hidden'}>${body}</div>`;
    const nameplate=group('theme','BASE COLORS','The two colors your row is built from.')
      +group('accent','ACCENT','Borders, marks, titles and emblems take this color.')
      +group('finish','FINISH','How the two base colors blend.','plate')
      +group('stripe','PATTERN','A racing pattern layered over the finish.')
      +group('emblem','EMBLEM','A mark behind your name. Twin stars unlock after eight Ranked tracks.')
      +group('plate','PLACE BLOCK','How the position number at the start of your row is drawn.','plate')
      +group('edge','EDGE BAR','The bar down the leading edge of your row.','plate');
    const car=group('stage','CAR BACKDROP','The scene behind your car thumbnail.')
      +group('stageTint','BACKDROP COLOR','Retints the scene. Your car is never moved or recolored.');
    const identity=group('title','TITLE','Choose an earned title, or hide it.','text')
      +group('badge','BADGE','One badge, shown beside your name.','text')
      +`<fieldset class="profile-cosmetic-group kind-extras variant-text"><legend>EXTRAS</legend><p>Shown on your public profile.</p><div class="profile-extras-grid"><label class="profile-favorite-track"><span><b>FAVORITE TRACK</b><small>Type to search. Shown as a shortcut on your profile.</small></span><input type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="sqFavoriteTrackList" data-cosmetic-favorite value="${escapeHtml(favoriteName)}" placeholder="No favorite" aria-label="Favorite track, type to search" autocomplete="off" spellcheck="false"><div id="sqFavoriteTrackList" class="studio-track-options" role="listbox" aria-label="Favorite tracks" hidden></div></label>${podiumChoice}</div></fieldset>`;
    return `<details class="profile-customizer"><summary><span><b>RACER STUDIO</b><small>Design the leaderboard row and profile everyone else sees</small></span><em class="studio-open-label" aria-hidden="true">Edit</em></summary><div class="profile-customizer-body">${livePreview}<div class="profile-customizer-controls"><div class="studio-tabs" role="tablist" aria-label="Studio sections">${tab('nameplate','NAMEPLATE')}${tab('car','CAR')}${tab('identity','IDENTITY')}</div>${panel('nameplate',nameplate)}${panel('car',car)}${panel('identity',identity)}</div></div></details>`;
  }
  let playtimeVisibleAt=document.visibilityState==='visible'?Date.now():0;
  function commitVisiblePlaytime(){
    if(!playtimeVisibleAt)return Math.max(0,Number(localStorage.getItem(PLAYTIME_KEY)||0)||0);
    const now=Date.now();
    const elapsed=Math.max(0,Math.min(120000,now-playtimeVisibleAt));
    const total=Math.min(315576000000,Math.max(0,Number(localStorage.getItem(PLAYTIME_KEY)||0)||0)+elapsed);
    try{localStorage.setItem(PLAYTIME_KEY,String(Math.round(total)));}catch{}
    playtimeVisibleAt=now;
    return total;
  }
  function currentPlaytimeMs(){return document.visibilityState==='visible'?commitVisiblePlaytime():Math.max(0,Number(localStorage.getItem(PLAYTIME_KEY)||0)||0);}
  document.addEventListener('visibilitychange',()=>{
    if(document.visibilityState==='visible')playtimeVisibleAt=Date.now();
    else{commitVisiblePlaytime();playtimeVisibleAt=0;}
  });
  window.addEventListener('pagehide',commitVisiblePlaytime);
  setInterval(()=>{if(document.visibilityState==='visible')commitVisiblePlaytime();},30000);
  function recordLeaderboardUse(category){
    const usage=readJsonStorage(LEADERBOARD_USAGE_KEY,{})||{};
    usage[category]=Math.max(0,Number(usage[category]||0)||0)+1;
    writeJsonStorage(LEADERBOARD_USAGE_KEY,usage);
  }
  function refreshLeaderboardArcade(){
    const current=document.querySelector('#overallDailyGrid .leaderboard-arcade');
    if(current)current.outerHTML=leaderboardArcadeMarkup();
  }
  function leaderboardArcadeMarkup(){
    const usage=readJsonStorage(LEADERBOARD_USAGE_KEY,{overall:1})||{overall:1};
    const rows=Object.entries(usage).filter(([key])=>LEADERBOARD_LABELS[key]&&!['official','community'].includes(key)).sort((a,b)=>b[1]-a[1]).slice(0,4);
    return `<div class="leaderboard-arcade" title="Your most-viewed leaderboards are stored only on this device"><span>YOUR FAVORITES</span><div>${rows.map(([key,count])=>`<button type="button" data-leaderboard-shortcut="${escapeHtml(key)}">${escapeHtml(LEADERBOARD_LABELS[key])}<small>${count}</small></button>`).join('')}</div></div>`;
  }

  const MIN_RANKED_TRACKS=3;
  function rankedPlacementCost(rank,fieldSize){
    const field=Math.max(0,Number(fieldSize||0)||0);
    const place=Math.max(1,Math.min(field,Number(rank||field)||field));
    if(field<2)return 50;
    const raw=100*(place-1)/(field-1);
    const confidence=(field-1)/(field+5);
    return 50+confidence*(raw-50);
  }
  function medianNumber(values,fallback=0){
    const clean=(values||[]).map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
    if(!clean.length)return fallback;
    const middle=Math.floor(clean.length/2);
    return clean.length%2?clean[middle]:(clean[middle-1]+clean[middle])/2;
  }
  function rankedTrackCompetition(entries){
    const times=(entries||[]).map((entry)=>Number(entry.timeMs||0)).filter((value)=>value>0).sort((a,b)=>a-b);
    if(times.length<3)return {relativeGap:0,boost:1};
    const middleTime=medianNumber(times,1);
    const gaps=[];
    for(let index=1;index<times.length;index++)gaps.push(Math.min(.25,(times[index]-times[index-1])/Math.max(1,middleTime)));
    const relativeGap=medianNumber(gaps,0);
    const closeness=1/(1+8*relativeGap);
    return {relativeGap,boost:.9+.2*closeness};
  }
  function rankedTitle(score,tracks){
    if(tracks<MIN_RANKED_TRACKS)return 'Provisional';
    const bands=[['Apex',18,20],['Elite',26,15],['Diamond',36,12],['Platinum',48,10],['Gold',62,7],['Silver',78,5],['Bronze',101,3]];
    let lower=0;
    for(const [name,upper,minimumTracks] of bands){
      if(score<=upper&&tracks>=minimumTracks){
        const progress=(score-lower)/Math.max(1,upper-lower);
        const division=progress<1/3?'I':progress<2/3?'II':'III';
        const breadth=tracks>=20?' Marathon':tracks>=12?' Veteran':tracks>=8?' Challenger':'';
        return `${name} ${division}${breadth}`;
      }
      lower=upper;
    }
    return 'Bronze III';
  }
  function resetTimeMarkup(weekly,now=Date.now()){
    const date=new Date(now);const next=Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate()+1);
    const instant=weekly?next+((8-new Date(next).getUTCDay())%7)*86400000:next;
    const local=new Intl.DateTimeFormat(undefined,{weekday:'long',hour:'numeric',minute:'2-digit'}).format(instant);
    return 'Changes '+(weekly?'Monday ':'')+'00:00 UTC<br><strong class="competition-local-reset">'+escapeHtml(local)+' Local</strong>';
  }
  function dailySpotlightMarkup(){
    const daily = dailySpotlight();
    const weekly=weeklyCup();
    const runProgress = `${Math.min(3,daily.targetRuns)}/3 finishes`;
    const pbProgress = `${Math.min(1,daily.targetPbs)}/1 PB`;
    const improvement = daily.bestPbImprovementMs > 0 ? ` · best gain ${(daily.bestPbImprovementMs/1000).toFixed(3)}s` : '';
    const streakWord=daily.streak===1?'day':'days';
    const weeklyResult=weekly.result&&weekly.result!=='Not entered'?`${weekly.result}${weekly.field?` of ${weekly.field}`:''}`:'Not entered';
    const challenge=(kind,kicker,track,result,note)=>`<section class="${kind}" aria-label="${escapeHtml(kicker)}: ${escapeHtml(track.name)}"><button class="competition-feature-button" type="button" data-track-id="${escapeHtml(track.id)}" aria-label="Play ${escapeHtml(track.name)}. ${escapeHtml(kicker)}"><span class="competition-feature-image" aria-hidden="true">${trackThumbnailMarkup(track.id)}</span><span class="competition-feature-copy"><span class="competition-kicker">${escapeHtml(kicker)}</span><strong class="competition-track-name">${escapeHtml(track.name)}</strong><span class="competition-result">${result}</span></span></button><small>${note}</small></section>`;
    return `<footer class="overall-competition" id="overallDailyGrid"><div class="overall-challenge-stack">${challenge('weekly-cup','FEATURED THIS WEEK',weekly.track,escapeHtml(weeklyResult),resetTimeMarkup(true))}${challenge('daily-card',"TODAY'S TARGET",daily.track,daily.completed?'Goal complete':`${runProgress} · ${pbProgress}${improvement}`,`${daily.streak} ${streakWord} streak · ${resetTimeMarkup(false)}`)}</div><div class="overall-center-tools"><nav class="overall-pager" aria-label="Ranked leaderboard pages"><button id="overallPrevPage" class="overall-page-button" type="button" aria-label="Previous ranked page">&#8249;</button><span id="overallPageStatus" class="overall-page-status" aria-live="polite">Page 1</span><button id="overallNextPage" class="overall-page-button" type="button" aria-label="Next ranked page">&#8250;</button></nav><button id="overallFreshness" class="overall-freshness" type="button" aria-label="Ranked data status. Select to request a cloud refresh.">Checking ranked data</button></div><div class="overall-footer-right"><div class="overall-category-control"><label class="overall-category-select"><span>RANK BY</span><select id="overallCategorySelect" aria-label="Choose a Ranked leaderboard"><optgroup label="Main rankings"><option value="overall">Overall RP</option><option value="casual">Casual RP</option><option value="average">Average place</option><option value="competitiveAverage">Competitive average</option><option value="tracks">Tracks completed</option><option value="medals">Podium points</option><option value="rising">Rising racers</option><option value="topTracks">Top Tracks</option></optgroup><optgroup label="More..."><option value="skill">Best 10 skill</option><option value="consistency">All-track depth</option><option value="wins">Track wins</option><option value="podiumRate">Podium rate</option><option value="weight">Total track weight</option><option value="pbs">PBs set</option><option value="playtime">Active time</option><option value="veterans">Racing longest</option></optgroup></select></label></div><div id="overallTrackScope" class="overall-track-scope" hidden aria-label="Filter completed tracks by type"><button class="active" type="button" data-track-scope="all" aria-pressed="true">All</button><button type="button" data-track-scope="official" aria-pressed="false">Official</button><button type="button" data-track-scope="community" aria-pressed="false">Community</button></div>${leaderboardArcadeMarkup()}</div></footer>`;
  }
  function normalizeCarColorId(colors){
    const fallback = 'ffffff8ec7ff28346a212b58';
    const cleaned = String(colors || '').replace(/[^0-9a-fA-F]/g,'').toLowerCase();
    return (cleaned + fallback).slice(0, 24);
  }
  function cleanCarId(value){
    return String(value || '').replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 64);
  }
  function cleanUserId(value){
    return String(value || '').replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 128);
  }
  function extractCarId(record){
    if (!record || typeof record !== 'object') return '';
    return cleanCarId(
      record.carId ||
      record.car ||
      record.carName ||
      record.carModel ||
      record.vehicleId ||
      record.vehicle ||
      record.selectedCar ||
      record.CarId ||
      ''
    );
  }
  function normalizeThumbResult(value){
    if (typeof value === 'string') return value;
    if (value && typeof value.src === 'string') return value.src;
    if (value && typeof value.url === 'string') return value.url;
    if (value && typeof value.dataUrl === 'string') return value.dataUrl;
    return '';
  }
  function carModelPreview(carStyle, carColorId, userId=''){
    const renderArg = __pt062NormalizeStyle(carStyle || __pt062GetRememberedStyle(userId) || normalizeCarColorId(carColorId || ''));
    const safeUserId = cleanUserId(userId);
    return `<span class="overall-car-model image-container" data-renderarg="${escapeHtml(renderArg)}" data-userid="${safeUserId}" title="Saved car for ${safeUserId}"><img class="show" src="images/car_thumbnail_placeholder.png" alt="Loading car"/><img alt="${safeUserId}'s car"/></span>`;
  }
  const overallCarRenderCache = new Map();
  function getCarThumbRenderer(){
    if (typeof window.BT === 'function') return window.BT;
    if (typeof BT === 'function') return BT;
    return null;
  }
  function hydrateOverallCarModels(root, attempt=0){
    if (!root) return;
    const renderThumb = getCarThumbRenderer();
    if (!renderThumb) {
      if (attempt < 40) setTimeout(()=>hydrateOverallCarModels(root, attempt + 1), 125);
      return;
    }
    const nodes = Array.from(root.querySelectorAll('.overall-car-model.image-container'));
    nodes.forEach((node)=>{
      const userId = cleanUserId(node.dataset.userid || '');
      const renderArg = __pt062NormalizeStyle(node.dataset.renderarg || __pt062GetRememberedStyle(userId) || normalizeCarColorId(''));
      const key = renderArg;
      const imgs = node.querySelectorAll('img');
      const placeholder = imgs[0];
      const rendered = imgs[1];
      if (!placeholder || !rendered) return;
      node.dataset.renderKey = key;
      const cached = overallCarRenderCache.get(key);
      if (cached) {
        rendered.src = cached;
        placeholder.classList.remove('show');
        rendered.classList.add('show');
        return;
      }
      Promise.resolve()
        .then(()=>renderThumb(renderArg, userId ? `u.${userId}` : ''))
        .then((out)=>normalizeThumbResult(out))
        .then((src)=>{
          if ((!src || typeof src !== 'string') && userId) {
            return Promise.resolve(renderThumb(__pt062GetRememberedStyle(userId) || renderArg,'')).then((fallback)=>normalizeThumbResult(fallback));
          }
          return src;
        })
        .then((src)=>{
          if (!src || node.dataset.renderKey !== key) {
            if (attempt < 40) setTimeout(()=>hydrateOverallCarModels(root, attempt + 1), 125);
            return;
          }
          overallCarRenderCache.set(key, src);
          rendered.src = src;
          placeholder.classList.remove('show');
          rendered.classList.add('show');
        })
        .catch(()=>{
          if (attempt < 40) setTimeout(()=>hydrateOverallCarModels(root, attempt + 1), 125);
        });
    });
  }


  function isLocalApiCapableHost(){
    const host = String(window.location.hostname || '').toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local');
  }

  function safePositiveInt(value, fallback=1){
    const n = Number(value);
    return Number.isSafeInteger(n) && n >= 1 ? n : fallback;
  }
  function escapeHtml(value){
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  const REPLAY_FIELD_RE = /(replay|recording|ghost)/i;
  function normalizeReplayPayloadString(value){
    const src = String(value || '');
    if (!src) return '';
    if (src.includes(' ') && !src.includes('\n') && /^[A-Za-z0-9+/=_\-\s]+$/.test(src)) {
      return src.replace(/ /g, '+');
    }
    return src;
  }
  function parseFormEncodedPayload(text){
    const out = {};
    const body = String(text || '');
    if (!body) return out;
    for (const pair of body.split('&')) {
      if (!pair) continue;
      const eqIdx = pair.indexOf('=');
      const rawKey = eqIdx >= 0 ? pair.slice(0, eqIdx) : pair;
      const rawVal = eqIdx >= 0 ? pair.slice(eqIdx + 1) : '';
      let key = rawKey;
      try { key = decodeURIComponent(rawKey.replace(/\+/g, '%20')); } catch {}
      const preservePlus = REPLAY_FIELD_RE.test(key);
      const prepared = preservePlus ? rawVal.replace(/\+/g, '%2B') : rawVal.replace(/\+/g, '%20');
      let val = rawVal;
      try { val = decodeURIComponent(prepared); } catch {}
      out[key] = preservePlus ? normalizeReplayPayloadString(val) : val;
    }
    return out;
  }

  const RECORDING_STORE_KEY = 'polytrack-0.6.2-recording-store-v1';
  function safeRecordingId(value){
    const n = Number(value);
    return Number.isSafeInteger(n) && n >= 1 ? n : null;
  }
  function canonicalRaceTimeMs(row, migrateSummary=false){
    const direct=Math.max(0,Number(row?.timeMs||row?.recordTimeMs||0)||0);
    const raw=Math.max(0,Number(row?.time?.numberOfFrames||row?.numberOfFrames||row?.frames||row?.raceTimeFrames||0)||0);
    const timingVersion=Math.max(0,Number(row?.timingVersion||0)||0);
    if(timingVersion>=2)return Math.round(direct||raw);
    if(raw>0){
      const oldConversion=raw*1000/60;
      if(direct>0&&Math.abs(direct-raw)<=Math.max(2,raw*.001))return Math.round(direct);
      if(direct>0&&Math.abs(direct-oldConversion)<=Math.max(2,oldConversion*.001))return Math.round(raw);
      return Math.round(raw);
    }
    if(direct>0&&migrateSummary)return Math.round(direct*60/1000);
    return Math.round(direct);
  }
  function hashToSafeInt(input){
    const src = String(input || '');
    let h = 2166136261;
    for (let i = 0; i < src.length; i++) {
      h ^= src.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return Math.abs(h >>> 0) % 2147483000 + 1;
  }
  function buildRecordingId(row, fallbackRank){
    const replayData = normalizeReplayPayloadString(String(row?.replay || row?.recording || row?.replayData || ''));
    const explicitId = safeRecordingId(row?.uploadId || row?.id);
    if (explicitId) return explicitId;
    return hashToSafeInt(`${row?.accountId||''}|${row?.trackId||''}|${row?.createdAt||fallbackRank||0}|${row?.replayHash||replayData||''}`);
  }
  function writeRecordingStore(id, payload){
    if (!id || !payload) return;
    try {
      const raw = localStorage.getItem(RECORDING_STORE_KEY);
      const data = raw ? JSON.parse(raw) : {};
      data[String(id)] = {
        recording: normalizeReplayPayloadString(String(payload.recording || payload.replay || payload.replayData || '')),
        frames: safePositiveInt(payload.frames || payload.numberOfFrames || payload.raceTimeFrames || 1, 1),
        verifiedState: Number.isFinite(Number(payload.verifiedState)) ? Number(payload.verifiedState) : 0,
        carColors: String(payload.carColors || payload.CarColors || 'ffffff8ec7ff28346a212b58').slice(0, 64),
        carId: cleanCarId(payload.carId || payload.car || payload.carName || ''),
        carStyle: __pt062NormalizeStyle(payload.carStyle || getDefaultCarStyle()),
        updatedAt: Date.now()
      };
      const keys = Object.keys(data);
      if (keys.length > 800) {
        keys.sort((a,b)=>Number(data[b]?.updatedAt||0)-Number(data[a]?.updatedAt||0));
        for (const k of keys.slice(800)) delete data[k];
      }
      localStorage.setItem(RECORDING_STORE_KEY, JSON.stringify(data));
    } catch {}
  }
  function readRecordingStore(ids){
    try {
      const raw = localStorage.getItem(RECORDING_STORE_KEY);
      const data = raw ? JSON.parse(raw) : {};
      return ids.map((id)=>{
        const rec = data[String(id)];
        if (!rec || typeof rec.recording !== 'string' || !rec.recording) return null;
        return {
          recording: normalizeReplayPayloadString(rec.recording),
          verifiedState: Number.isFinite(Number(rec.verifiedState)) ? Number(rec.verifiedState) : 0,
          frames: safePositiveInt(rec.frames, 1),
          carColors: String(rec.carColors || 'ffffff8ec7ff28346a212b58').slice(0, 64),
          carId: cleanCarId(rec.carId || '') || null,
          carStyle: __pt062NormalizeStyle(rec.carStyle || getDefaultCarStyle())
        };
      });
    } catch {
      return ids.map(()=>null);
    }
  }
  function cachedNativeRecording(row){
    if(!row)return null;
    return {
      recording:normalizeReplayPayloadString(row.recording),
      verifiedState:Number(row.verifiedState)||0,
      frames:safePositiveInt(row.frames,1),
      carStyle:__pt062NormalizeStyle(row.carStyle||getDefaultCarStyle())
    };
  }
  async function readNativeRecordings(ids){
    const fromLocal=readRecordingStore(ids);
    const resolved=fromLocal.map(cachedNativeRecording);
    const missingIds=ids.filter((_id,index)=>!resolved[index]);
    if(!missingIds.length)return resolved;
    try {
      const d=await db();
      const chunks=[];
      for(let index=0;index<missingIds.length;index+=30)chunks.push(missingIds.slice(index,index+30));
      const snapshots=await Promise.all(chunks.map(chunk=>d.collection(COLLECTIONS.raceResults).where('uploadId','in',chunk).get()));
      const cloudRows=new Map();
      for(const snapshot of snapshots){
        for(const doc of snapshot.docs||[]){
          const row=doc.data()||{};
          const id=safeRecordingId(row.uploadId||row.id);
          if(id&&!cloudRows.has(id))cloudRows.set(id,row);
        }
      }
      return ids.map((id,index)=>{
        if(resolved[index])return resolved[index];
        const row=cloudRows.get(id)||null;
        if(!row||!String(row.replay||''))return null;
        return {
          recording:normalizeReplayPayloadString(String(row.replay||'')),
          verifiedState:row.runVerified===true?1:0,
          frames:safePositiveInt(row.frames||row.raceTimeFrames||canonicalRaceTimeMs(row)||1,1),
          carColors:normalizeCarColorId(row.carColors||''),
          carId:cleanCarId(row.carId||'')||null,
          carStyle:__pt062NormalizeStyle(row.carStyle||getDefaultCarStyle())
        };
      });
    } catch (error) {
      log('warn','[FB407] recordings lookup failed',String(error&&(error.message||error)));
      return resolved;
    }
  }

  const LOCAL_RACE_STORE_KEY = 'polytrack-0.6.2-local-race-results-v1';
  const LOCAL_PB_RECONCILE_STATE_KEY = 'polytrack-0.6.2-local-pb-reconcile-v1';
  let localPbReconcilePromise = null;
  let localPbReconcileTimer = 0;
  function readLocalRaceRows(){
    try {
      const raw = localStorage.getItem(LOCAL_RACE_STORE_KEY);
      const rows = raw ? JSON.parse(raw) : [];
      return Array.isArray(rows) ? rows : [];
    } catch { return []; }
  }
  function writeLocalRaceRows(rows){
    try {
      const bestByTrackAndUser = new Map();
      for (const row of Array.isArray(rows) ? rows : []) {
        const accountId=cleanUserId(row?.accountId||row?.userId||'');
        const trackId=String(row?.trackId||'').slice(0,80);
        const timeMs=canonicalRaceTimeMs(row);
        if(!accountId||!trackId||timeMs<=0)continue;
        const key=`${accountId}|${trackId}`;
        const current=bestByTrackAndUser.get(key);
        const currentMs=canonicalRaceTimeMs(current);
        const hasReplay=Boolean(normalizeReplayPayloadString(row?.replay||row?.recording||''));
        const currentHasReplay=Boolean(normalizeReplayPayloadString(current?.replay||current?.recording||''));
        if(!current||timeMs<currentMs||(timeMs===currentMs&&hasReplay&&!currentHasReplay))bestByTrackAndUser.set(key,{...row,accountId,userId:accountId,trackId,timeMs});
      }
      const canonical=Array.from(bestByTrackAndUser.values()).sort((a,b)=>Number(b.updatedAt||b.pbAt||b.createdAt||0)-Number(a.updatedAt||a.pbAt||a.createdAt||0));
      localStorage.setItem(LOCAL_RACE_STORE_KEY, JSON.stringify(canonical.slice(0, 5000)));
    } catch {}
  }
  function syncCachedRecordingVerification(entries){
    try{
      const raw=localStorage.getItem(RECORDING_STORE_KEY);
      if(!raw)return;
      const data=JSON.parse(raw)||{};
      let changed=false;
      for(const entry of entries||[]){
        const id=safeRecordingId(entry?.uploadId||entry?.id);
        if(!id||!data[String(id)])continue;
        const next=entry?.runVerified===true?1:0;
        if(Number(data[String(id)].verifiedState||0)===next)continue;
        data[String(id)].verifiedState=next;
        data[String(id)].updatedAt=Date.now();
        changed=true;
      }
      if(changed)localStorage.setItem(RECORDING_STORE_KEY,JSON.stringify(data));
    }catch{}
  }
  function addLocalRaceRow(row){
    writeLocalRaceRows([row,...readLocalRaceRows()]);
  }

  function enrichLegacyLeaderboardEntries(entries){
    if (!Array.isArray(entries)) return [];
    return entries.map((entry, idx)=>{
      const rank = safePositiveInt(entry?.rank || entry?.position || idx + 1, idx + 1);
      const elapsedMs = canonicalRaceTimeMs(entry);
      const frames = safePositiveInt(entry?.time?.numberOfFrames || entry?.frames || entry?.raceTimeFrames || elapsedMs || 1, 1);
      const userId = String(entry?.userId || entry?.accountId || entry?.id || `user-${rank}`);
      const recordingId = buildRecordingId(entry, rank);
      const safeName = String(entry?.nickname || entry?.name || getLastKnownName(userId) || 'Guest').slice(0, 24);
      const carStyle = __pt062NormalizeStyle(entry?.carStyle || __pt062GetRememberedStyle(userId) || entry?.carColorId || entry?.carColors || '');
      const createdAt = pbTimestamp(entry) || Date.now();
      return {
        ...entry,
        id: safeRecordingId(entry?.id) || recordingId,
        uploadId: safeRecordingId(entry?.uploadId || entry?.id) || recordingId,
        userId,
        accountId: userId,
        name: safeName,
        nickname: safeName,
        countryCode: typeof entry?.countryCode === 'string' ? entry.countryCode.slice(0, 8) : null,
        carColors: normalizeCarColorId(entry?.carColors || 'ffffff8ec7ff28346a212b58'),
        carColorId: normalizeCarColorId(entry?.carColorId || entry?.carColors || 'ffffff8ec7ff28346a212b58'),
        carId: extractCarId(entry),
        carStyle,
        verifiedState: entry?.runVerified === true ? 1 : 0,
        integrityVerified: entry?.integrityVerified === true,
        validationState: entry?.integrityVerified === true ? 'integrity' : String(entry?.validationState || 'pending').slice(0,24),
        rank,
        position: rank,
        frames,
        time: new Date(Number.isFinite(createdAt) ? createdAt : Date.now()).toISOString(),
        date: new Date(Number.isFinite(createdAt) ? createdAt : Date.now()).toISOString(),
        timestamp: createdAt,
        pbAt: createdAt,
        timingVersion: 2,
        timeMs: elapsedMs || frames
      };
    });
  }

  let lastMirrorSig = '';
  let lastMirrorAt = 0;

  function sanitizeDisplayName(value){
    const n = String(value || '').normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
    return n || 'Guest';
  }

  function normalizeNameForCheck(v){
    const confusables={
      'а':'a','в':'b','с':'c','е':'e','н':'h','і':'i','ј':'j','к':'k','м':'m','о':'o','р':'p','ѕ':'s','т':'t','у':'y','х':'x',
      'α':'a','β':'b','ε':'e','ι':'i','κ':'k','ο':'o','ρ':'p','τ':'t','υ':'y','χ':'x'
    };
    return Array.from(String(v || '').normalize('NFKD').toLowerCase().replace(/[\u0300-\u036f]/g,''),(char)=>confusables[char]||char).join('')
      .replace(/[@4]/g,'a').replace(/[8]/g,'b').replace(/[3]/g,'e')
      .replace(/[1!|]/g,'i').replace(/[0]/g,'o').replace(/[5$]/g,'s')
      .replace(/[7+]/g,'t').replace(/[^a-z0-9Ѐ-ӿ぀-ヿ一-鿿]+/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  function moderationDecision(value){
    const clean = sanitizeDisplayName(value);
    const normalized = normalizeNameForCheck(clean);
    const tokens = normalized.split(' ').filter(Boolean);
    const compact = tokens.join('');
    const sourceLooksObfuscated = /[^a-zA-Z\s]/.test(clean) || tokens.length > 1;
    const terms = DEFAULT_NAME_BLOCKLIST.concat(MODERN_HIGH_RISK_TERMS).map(normalizeNameForCheck).filter(Boolean);
    for (const reserved of RESERVED_NAME_TERMS) {
      if (compact === normalizeNameForCheck(reserved).replace(/ /g,'')) return {blocked:true,reason:'reserved-name',clean};
    }
    for (const term of terms) {
      const termTokens = term.split(' ');
      if (termTokens.length > 1 && normalized.includes(term)) return {blocked:true,reason:'unsafe-phrase',clean};
      if (termTokens.length === 1 && tokens.includes(term)) return {blocked:true,reason:'unsafe-word',clean};
    }
    for (const term of COMPACT_SEVERE_TERMS) {
      const needle = normalizeNameForCheck(term).replace(/ /g,'');
      if (needle.length >= 4 && compact.includes(needle) && (sourceLooksObfuscated || compact === needle || compact.startsWith(needle) || compact.endsWith(needle))) {
        return {blocked:true,reason:'obfuscated-unsafe-word',clean};
      }
    }
    return {blocked:false,reason:'',clean};
  }

  function makeFallbackName(seed){
    const hash = Math.abs(Array.from(String(seed || Date.now())).reduce((acc, ch)=>((acc * 33) ^ ch.charCodeAt(0)) >>> 0, 5381));
    const a = PROFILE_NAME_WORD_A[hash % PROFILE_NAME_WORD_A.length];
    const b = PROFILE_NAME_WORD_B[(Math.floor(hash / 13)) % PROFILE_NAME_WORD_B.length];
    return `${a}${b}`.slice(0, 24);
  }

  function getOrCreateDefaultDisplayName(accountId=guestAccountId){
    const existing = sanitizeDisplayName(localStorage.getItem(LAST_ACTIVE_NAME_KEY) || '');
    if (existing && existing.toLowerCase() !== 'guest') return existing;
    const generated = makeFallbackName(accountId) || 'RookieRacer';
    try { localStorage.setItem(LAST_ACTIVE_NAME_KEY,generated); } catch {}
    return generated;
  }

  async function enforceSafeDisplayName(value, accountId=''){
    const decision = moderationDecision(value);
    if (!decision.blocked) return decision.clean;
    log('warn','[MOD100] Unsafe display name replaced',{accountId,reason:decision.reason});
    return makeFallbackName(accountId || decision.clean) || 'Guest';
  }

  function safeDisplayName(value, accountId=''){
    const decision = moderationDecision(value);
    return decision.blocked ? (makeFallbackName(accountId || decision.clean) || 'Guest') : decision.clean;
  }

  const manualModerationCache = new Map();
  async function resolveManualNameOverride(d, accountId, fallbackName){
    const id = String(accountId || '').slice(0,128);
    const cached = manualModerationCache.get(id);
    if (cached && cached.expiresAt > Date.now()) return cached.name || fallbackName;
    try {
      const snap = await d.collection(COLLECTIONS.moderationNames).doc(id).get();
      const data = snap.exists ? (snap.data() || {}) : {};
      const name = data.active === true ? (sanitizeDisplayName(data.replacement) || fallbackName) : fallbackName;
      manualModerationCache.set(id,{name,expiresAt:Date.now()+MODERATION_REFRESH_MS});
      return name;
    } catch {
      manualModerationCache.set(id,{name:fallbackName,expiresAt:Date.now()+30000});
      return fallbackName;
    }
  }

  function getLastKnownName(accountId){
    try {
      const raw = localStorage.getItem('polytrack-0.6.2-profile-last-names-v1');
      const map = raw ? JSON.parse(raw) : {};
      return String(map?.[accountId] || '').slice(0,24);
    } catch { return ''; }
  }

  function setLastKnownName(accountId, name){
    try {
      const raw = localStorage.getItem('polytrack-0.6.2-profile-last-names-v1');
      const map = raw ? JSON.parse(raw) : {};
      map[accountId] = safeDisplayName(name,accountId);
      localStorage.setItem('polytrack-0.6.2-profile-last-names-v1', JSON.stringify(map));
    } catch {}
  }

  function migrateUnsafeLocalNames(){
    const migrationKey='polytrack-0.6.2-name-safety-v3';
    try {
      if(localStorage.getItem(migrationKey)==='1')return;
      const storageKey='polytrack-0.6.2-profile-last-names-v1';
      const map=JSON.parse(localStorage.getItem(storageKey)||'{}');
      if(map&&typeof map==='object'&&!Array.isArray(map)){
        for(const [accountId,name] of Object.entries(map))map[accountId]=safeDisplayName(name,accountId);
        localStorage.setItem(storageKey,JSON.stringify(map));
      }
      const active=localStorage.getItem(LAST_ACTIVE_NAME_KEY);
      if(active)localStorage.setItem(LAST_ACTIVE_NAME_KEY,safeDisplayName(active,guestAccountId));
      localStorage.setItem(migrationKey,'1');
    } catch {}
  }

  function canonicalDisplayName(accountId, embeddedName=''){
    const id=String(accountId||'').slice(0,128);
    const live=Array.isArray(overallEntriesCache)
      ? overallEntriesCache.find((entry)=>String(entry.userId||entry.accountId||'')===id)
      : null;
    const cached=readOverallSnapshotCache()?.entries?.find((entry)=>String(entry.userId||entry.accountId||'')===id);
    const name=safeDisplayName(live?.name||live?.nickname||getLastKnownName(id)||cached?.name||cached?.nickname||embeddedName||'Guest',id);
    if(id)setLastKnownName(id,name);
    return name;
  }

  const sdkScriptLoads=new Map();
  let firebaseRetryAt=0;
  function loadScript(src){
    if(sdkScriptLoads.has(src))return sdkScriptLoads.get(src);
    const promise=new Promise((resolve,reject)=>{
      let script=document.querySelector('script[data-ext-src="'+src+'"]');
      if(script?.dataset.loaded==='1'){resolve();return;}
      if(script)script.remove();
      script=document.createElement('script');
      script.async=true;script.src=src;script.dataset.extSrc=src;
      const timer=setTimeout(()=>finish(new Error('Firebase SDK load timed out')),15000);
      function finish(error){
        clearTimeout(timer);script.onload=null;script.onerror=null;
        if(error){script.remove();reject(error);}else{script.dataset.loaded='1';resolve();}
      }
      script.onload=()=>finish();
      script.onerror=()=>finish(new Error('Firebase SDK unavailable'));
      document.head.appendChild(script);
    });
    sdkScriptLoads.set(src,promise);
    promise.catch(()=>{if(sdkScriptLoads.get(src)===promise)sdkScriptLoads.delete(src);});
    return promise;
  }

  async function resolveFirebaseConfig(){
    if (window.__polytrackFirebaseConfig) return window.__polytrackFirebaseConfig;
    if (window.POLYTRACK_FIREBASE_CONFIG && window.POLYTRACK_FIREBASE_CONFIG.projectId) {
      window.__polytrackFirebaseConfig = window.POLYTRACK_FIREBASE_CONFIG;
      return window.__polytrackFirebaseConfig;
    }
    window.__polytrackFirebaseConfig = FIREBASE_CONFIG;
    return window.__polytrackFirebaseConfig;
  }

  const cloudOwnerConflicts=new Map();
  async function waitForInitialAuth(auth){
    if(typeof auth.authStateReady==='function'){await auth.authStateReady();return;}
    await new Promise((resolve,reject)=>{
      let unsubscribe;let finished=false;
      const finish=(error)=>{if(finished)return;finished=true;clearTimeout(timer);unsubscribe?.();error?reject(error):resolve();};
      const timer=setTimeout(()=>finish(new Error('Cloud sign-in is still loading. Try again shortly.')),15000);
      unsubscribe=auth.onAuthStateChanged(()=>finish(),error=>finish(error));
      if(finished)unsubscribe?.();
    });
  }
  function assertCloudOwner(accountId,ownerUid,...documents){
    if(!documents.some(doc=>doc?.ownerUid&&doc.ownerUid!==ownerUid))return;
    cloudOwnerConflicts.set(accountId,ownerUid);
    const error=new Error('This racer belongs to another cloud sign-in. Local runs are safe. Use the original browser profile or contact support for account recovery.');
    error.code='account-session-conflict';throw error;
  }
  function showCloudOwnerConflict(){
    if(document.getElementById('polytrackCloudAccountNotice'))return;
    const notice=document.createElement('div');notice.id='polytrackCloudAccountNotice';notice.setAttribute('role','status');
    notice.style.cssText='position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:30000;width:min(620px,calc(100vw - 24px));box-sizing:border-box;padding:12px;background:#332818;color:#fff1cc;border:2px solid #ffd28c;font:16px/1.4 sans-serif;pointer-events:auto';
    const copy=document.createElement('span');copy.textContent='Cloud account mismatch. Your runs are saved on this device, but cannot upload under this sign-in. Use the original browser profile or ask support for recovery.';
    const close=document.createElement('button');close.type='button';close.textContent='Dismiss';close.style.cssText='margin-left:12px;min-height:36px';close.onclick=()=>notice.remove();notice.append(copy,close);document.body.appendChild(notice);
  }
  async function db(){
    if (firestorePromise) return firestorePromise;
    if(Date.now()<firebaseRetryAt)throw new Error("Firebase reconnect cooling down");
    firestorePromise = (async ()=>{
      await loadScript('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
      await loadScript('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js');
      await loadScript('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js');
      const cfg = await resolveFirebaseConfig();
      const app = window.firebase.apps?.length ? window.firebase.app() : window.firebase.initializeApp(cfg);
      if (window.firebase?.auth) {
        const auth = app.auth();
        await waitForInitialAuth(auth);
        if (!auth.currentUser) {
          try {
            await auth.signInAnonymously();
            log('info','[FB100] Signed in anonymously for Firestore access');
          } catch (error) {
            log('warn','Anonymous auth unavailable; enable Firebase Anonymous Auth for cloud writes', String(error && (error.message || error)));
          }
        }
      }
      const fire = app.firestore();
      try {
        fire.settings({ experimentalAutoDetectLongPolling: true, useFetchStreams: false, merge: true });
      } catch {}
      return fire;
    })().catch(error=>{
      firestorePromise=null;
      firebaseRetryAt=Date.now()+30000;
      throw error;
    });
    return firestorePromise;
  }

  async function ensureFirestoreBootstrap(){
    try {
      await db();
      log('info','[FB101] Firestore bootstrap ready');
    } catch (error) {
      const msg = String(error && (error.message || error));
      if (/Missing or insufficient permissions/i.test(msg)) {
        log('error','Firestore bootstrap denied by security rules (enable anonymous auth + publish compatible Firestore rules)', msg);
      } else {
        log('error','Firestore bootstrap failed', msg);
      }
    }
  }

  function ensureStyles(){
    if (document.getElementById('polytrack-ext-style')) return;
    const style = document.createElement('style');
    style.id = 'polytrack-ext-style';
    style.textContent = "#overallLeaderboardPanel{--rank-bg:#263874;--rank-surface:#354b8b;--rank-surface-2:#1b2859;--rank-blue:#a7d5ff;--rank-cyan:#7ee7ff;--rank-columns:94px minmax(360px,1.45fr) minmax(280px,1fr) minmax(220px,.72fr);--rank-gap:14px;display:none;position:fixed;inset:0;z-index:10001;background:rgba(10,15,36,.82);backdrop-filter:blur(7px);padding:8px;overflow:hidden;color:var(--text-color,#fff);font-family:ForcedSquare,Arial,sans-serif}.overall-shell{width:min(1500px,calc(100vw - 12px));height:min(1040px,calc(100vh - 8px));margin:auto;display:flex;flex-direction:column;overflow:hidden;position:relative;background:var(--rank-bg);clip-path:polygon(16px 0,calc(100% - 16px) 0,100% 16px,100% calc(100% - 16px),calc(100% - 16px) 100%,16px 100%,0 calc(100% - 16px),0 16px);box-shadow:0 24px 80px rgba(0,0,0,.58);animation:rankPanelIn .32s cubic-bezier(.16,.78,.2,1) both}.overall-top{display:flex;justify-content:space-between;align-items:center;padding:22px 28px 14px;background:linear-gradient(90deg,#263a7b 0%,#1d2c61 65%,#17234f 100%);border-bottom:4px solid var(--rank-blue);position:relative;z-index:2}.overall-title-group{display:flex;align-items:center;gap:16px;min-width:0}.overall-top h2{margin:0;font-size:clamp(36px,4vw,58px);font-weight:normal;line-height:.95;color:#fff;letter-spacing:.5px;text-shadow:3px 3px 0 rgba(0,0,0,.22)}.overall-beta{padding:7px 12px;background:#fff;color:#22346d;font-size:15px;line-height:1;clip-path:polygon(7px 0,100% 0,calc(100% - 7px) 100%,0 100%);white-space:nowrap}.overall-actions{display:flex;gap:10px;flex:0 0 auto}.overall-action-btn{min-width:104px;font-size:20px;line-height:34px;cursor:pointer;transition:transform .12s ease,filter .12s ease}.overall-action-btn:hover,.overall-action-btn:focus-visible{transform:translateY(-2px);filter:brightness(1.12)}#overallFindMeBtn{background:var(--rank-cyan)!important;color:#10214b!important;box-shadow:inset 0 -3px 0 rgba(12,37,75,.28)}.overall-sub{margin:0;padding:13px 28px 12px;background:var(--rank-surface-2);color:rgba(246,250,255,.9);font-size:19px;line-height:1.3}.overall-sub strong{color:var(--rank-cyan);font-weight:normal}.overall-freshness{display:flex;align-items:center;gap:8px;min-height:27px;padding:4px 28px;background:#111a3b;color:#a7d5ff;font-size:13px;letter-spacing:.4px}.overall-freshness::before{content:'';width:8px;height:8px;background:#65ee94;border-radius:50%}.overall-freshness.is-stale{color:#ffd182}.overall-freshness.is-stale::before{background:#ffbd5d}.overall-freshness.is-pending::before{background:#7ee7ff}.overall-opportunities{display:flex;align-items:center;gap:12px;min-height:34px;padding:5px 28px;background:#182552;color:rgba(226,239,255,.78);font-size:13px;overflow:hidden}.overall-opportunities strong{color:#7ee7ff;font-weight:normal;white-space:nowrap}.overall-opportunity{padding:3px 8px;background:#273c78;white-space:nowrap;clip-path:polygon(4px 0,100% 0,calc(100% - 4px) 100%,0 100%)}.overall-daily{display:flex;align-items:center;gap:13px;min-height:38px;padding:8px 24px;background:#17234f;border-top:3px solid #5374b6;color:rgba(239,247,255,.78);font-size:14px}.overall-daily-label{padding:4px 8px;background:#7ee7ff;color:#162651;font-size:12px;letter-spacing:.8px}.overall-daily strong{font-size:18px;color:#fff;font-weight:normal}.overall-daily span:last-child{margin-left:auto;color:#a7d5ff}.overall-columns{display:grid;grid-template-columns:var(--rank-columns);gap:var(--rank-gap);padding:9px 38px 8px 14px;background:#121b3f;color:rgba(224,238,255,.74);font-size:14px;text-transform:uppercase;letter-spacing:1.05px}.overall-columns span:first-child{text-align:center}.overall-columns span:last-child{text-align:center}#overallLeaderboardList{padding:10px 14px 12px;display:flex;flex-direction:column;gap:8px;overflow-y:auto;overflow-x:hidden;flex:1;background:linear-gradient(180deg,#203168,#17234e);scrollbar-color:#6a89c7 #142047}.overall-pager{display:flex;align-items:center;justify-content:center;gap:12px;min-height:48px;padding:6px 18px;background:#121b3f;border-top:2px solid rgba(126,231,255,.24)}.overall-pager .button{min-width:92px;font-size:16px}.overall-page-status{min-width:170px;text-align:center;color:#dcecff;font-size:15px;letter-spacing:.5px}#overallHelpPopup{display:none;position:absolute;inset:0;background:rgba(8,12,31,.9);backdrop-filter:blur(5px);align-items:center;justify-content:center;padding:24px;z-index:4}.overall-help-card{width:min(1120px,calc(100% - 24px));max-height:min(880px,calc(100vh - 30px));overflow:auto;background:#30447f;clip-path:polygon(16px 0,calc(100% - 16px) 0,100% 16px,100% calc(100% - 16px),calc(100% - 16px) 100%,16px 100%,0 calc(100% - 16px),0 16px);box-shadow:0 18px 60px rgba(0,0,0,.45)}.overall-help-head{padding:22px 26px 16px;border-bottom:4px solid var(--rank-blue);background:#1c2959}.overall-help-card h3{margin:0;font-size:38px;color:#fff;font-weight:normal}.overall-help-content{padding:22px 26px}.overall-help-card p{margin:0 0 16px;font-size:22px;color:rgba(255,255,255,.94);line-height:1.45}.overall-help-card .small{font-size:17px;color:rgba(255,255,255,.66)}.overall-help-note{padding:14px 16px;background:#18234e;border-left:5px solid var(--rank-cyan)}.overall-help-actions{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-top:20px}.overall-discord-cta{display:inline-flex;align-items:center;gap:10px;padding:9px 15px;color:#fff;text-decoration:none;font-size:18px;transition:filter .15s ease,transform .15s ease}.overall-discord-cta:hover{filter:brightness(1.12);transform:translateY(-2px)}.overall-discord-cta img{width:25px;height:25px}#overallHelpClose{cursor:pointer;min-width:100px}.overall-entry{position:relative;display:grid;grid-template-columns:var(--rank-columns);gap:var(--rank-gap);align-items:center;min-height:108px;padding:0 24px 0 0;background:var(--rank-surface);clip-path:polygon(8px 0,calc(100% - 8px) 0,100% 8px,100% calc(100% - 8px),calc(100% - 8px) 100%,8px 100%,0 calc(100% - 8px),0 8px);opacity:0;transform:translateX(-34px);animation:overallEntryIn .38s cubic-bezier(.16,.78,.2,1) forwards;transition:filter .14s ease,transform .14s ease}.overall-entry::after{content:'';position:absolute;left:0;bottom:0;width:0;height:4px;background:var(--rank-cyan);animation:rankLineIn .45s ease-out forwards;animation-delay:inherit}.overall-entry:hover{filter:brightness(1.08);transform:translateX(3px)}.overall-entry.is-self{background:linear-gradient(90deg,#315d78 0%,#3d568e 50%,#2d437e 100%);box-shadow:inset 0 0 0 3px #7ee7ff,0 0 22px rgba(126,231,255,.38)}.overall-entry.is-self.rank-self-focus{animation:overallEntryIn .25s ease-out forwards,selfRankPulse .8s ease-out 1}.overall-entry.top-1{min-height:122px;background:linear-gradient(90deg,#8a6a18 0%,#5d522f 40%,#303b68 100%);box-shadow:inset 0 0 0 1px rgba(255,226,122,.42)}.overall-entry.top-2{background:linear-gradient(90deg,#68758b 0%,#495775 42%,#2b3967 100%);box-shadow:inset 0 0 0 1px rgba(225,235,255,.3)}.overall-entry.top-3{background:linear-gradient(90deg,#7c4d31 0%,#56434a 42%,#2b3967 100%);box-shadow:inset 0 0 0 1px rgba(224,145,92,.34)}.overall-entry.top-1::after{background:#ffe27a;height:5px}.overall-entry.top-2::after{background:#dce8ff}.overall-entry.top-3::after{background:#ffb77e}.overall-rank{align-self:stretch;display:flex;align-items:center;justify-content:center;width:94px;background:rgba(7,12,34,.26);font-size:36px;color:var(--rank-blue);letter-spacing:.5px}.overall-entry.top-1 .overall-rank{font-size:50px;color:#fff1a5}.overall-entry.top-2 .overall-rank{color:#ecf3ff}.overall-entry.top-3 .overall-rank{color:#ffc295}.overall-car-model{width:124px;height:100px;display:inline-flex;align-items:center;justify-content:center;margin-right:14px;vertical-align:middle;overflow:hidden;position:relative;flex:0 0 auto;background:rgba(0,0,0,.14);clip-path:polygon(0 0,100% 0,calc(100% - 9px) 100%,0 100%)}.overall-entry.top-1 .overall-car-model{height:112px;width:138px}.overall-car-model > img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;object-position:center;opacity:0;filter:none!important;transition:opacity .24s ease,transform .24s ease;transform:scale(.94)}.overall-car-model > img.show{opacity:1;transform:scale(1.08)}.overall-name{font-size:30px;white-space:normal;overflow:hidden;display:flex;align-items:center;min-width:0;color:#fff}.overall-name-label{display:flex;flex-direction:column;gap:5px;min-width:0}.overall-name-main{line-height:1.05;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center;gap:8px}.overall-flag{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:32px;height:22px;background:#1b2859;clip-path:polygon(4px 0,100% 0,calc(100% - 4px) 100%,0 100%);overflow:hidden}.overall-flag img{width:100%;height:100%;object-fit:cover}.overall-you-tag{flex:0 0 auto;padding:5px 9px;background:linear-gradient(180deg,#a9f3ff,#62dff8);color:#061329;font-size:11px;line-height:1;font-weight:900;letter-spacing:1px;clip-path:polygon(5px 0,100% 0,calc(100% - 5px) 100%,0 100%);box-shadow:0 0 12px rgba(126,231,255,.45)}.overall-name-hint{font-size:13px;color:rgba(226,239,255,.66);text-transform:uppercase;letter-spacing:.9px}.overall-racer-meta{color:rgba(185,215,255,.68);font-size:12px;letter-spacing:.5px}.overall-mid{min-width:0;text-align:left;display:flex;flex-direction:column;gap:7px}.overall-move{font-size:20px}.overall-move.up{color:#78ff9a}.overall-move.down{color:#ff8c8c}.overall-move.flat{color:rgba(230,240,255,.55)}.overall-best{font-size:16px;color:rgba(238,246,255,.86);line-height:1.25}.overall-best-line{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.overall-best-line+ .overall-best-line{margin-top:3px;color:rgba(206,226,255,.67);font-size:13px}.overall-stats{text-align:center;min-width:0}.overall-score{font-size:37px;color:#fff;line-height:1}.overall-score-unit{font-size:14px;color:var(--rank-cyan);letter-spacing:1px;margin-top:3px}.overall-races{font-size:15px;color:rgba(215,236,255,.76);margin-top:5px}.overall-loading{margin:auto;width:min(520px,calc(100% - 30px));padding:30px 26px;text-align:center;background:#26366f;clip-path:polygon(10px 0,calc(100% - 10px) 0,100% 10px,100% calc(100% - 10px),calc(100% - 10px) 100%,10px 100%,0 calc(100% - 10px),0 10px)}.overall-loading strong{display:block;font-size:28px;font-weight:normal;color:#fff}.overall-loading span{display:block;margin-top:8px;color:var(--rank-cyan);font-size:16px}.overall-loading-bar{height:5px;margin-top:18px;background:#121b3f;overflow:hidden}.overall-loading-bar::after{content:'';display:block;width:38%;height:100%;background:var(--rank-cyan);animation:rankLoading 1.05s ease-in-out infinite}.overall-empty{margin:auto;width:min(650px,calc(100% - 40px));padding:42px 34px;display:flex;flex-direction:column;gap:12px;text-align:center;font-size:20px;color:rgba(239,247,255,.8);background:#2b407c;clip-path:polygon(12px 0,calc(100% - 12px) 0,100% 12px,100% calc(100% - 12px),calc(100% - 12px) 100%,12px 100%,0 calc(100% - 12px),0 12px)}.overall-empty strong{font-size:34px;color:#fff;font-weight:normal}.overall-empty .button{align-self:center;margin-top:8px;min-width:150px}#injectedRankingsBtn{animation:none!important;will-change:transform,opacity,filter;position:relative;opacity:1;pointer-events:auto!important}#injectedRankingsBtn.ranked-waiting{opacity:0;pointer-events:none!important}#injectedRankingsBtn.ranked-ready{opacity:1;pointer-events:auto!important}#injectedRankingsBtn.button-spawn{animation:rankedButtonSpawn .42s cubic-bezier(.2,.72,.25,1) both!important}#injectedRankingsBtn.button-spawn img{animation:rankedIconPop .42s cubic-bezier(.2,.72,.25,1) both}.sq-has-hotkey{position:relative}.sq-hotkey-hint{position:absolute;right:5px;top:5px;z-index:3;min-width:19px;height:19px;padding:0 4px;display:flex;align-items:center;justify-content:center;background:#f0f6ff;color:#253768;clip-path:polygon(3px 0,100% 0,calc(100% - 3px) 100%,0 100%);font:11px/19px ForcedSquare,Arial,sans-serif;letter-spacing:.2px;pointer-events:none}#sqRankedSettings{position:relative;margin:0 0 14px;padding:0 0 10px;border-bottom:3px solid var(--text-color);color:var(--text-color);font-family:ForcedSquare,Arial,sans-serif}#sqRankedSettings>h2{margin:10px;padding:4px;font-size:24px;font-weight:normal;border-bottom:2px solid var(--text-color)}.sq-settings-note{margin:8px 15px;color:rgba(235,244,255,.72);font-size:16px}.sq-setting-row{margin:10px;display:flex}.sq-setting-row>p{display:inline-block;margin:10px;min-width:0;flex-grow:1;font-size:25px}.sq-setting-row>.button-wrapper{display:flex;justify-content:end}.sq-setting-row .button{height:48px;min-width:150px}.sq-setting-secret{display:grid!important;grid-template-columns:minmax(0,1fr) minmax(220px,.8fr);gap:5px 14px}.sq-secret-controls{display:flex;align-items:center;gap:7px}.sq-secret-controls input{width:100%;min-width:0;padding:10px 12px;background:#111a3d;border:2px solid rgba(126,231,255,.45);color:#fff;font:18px ForcedSquare,Arial,sans-serif}.sq-secret-controls input:focus{outline:2px solid #7ee7ff;outline-offset:2px}.sq-secret-controls .button{min-width:78px!important}.sq-setting-secret .sq-backup-validation{grid-column:2;margin:0;color:#9fdaf0;font-size:13px;line-height:1.25}.sq-moderator-tools{display:grid;grid-template-columns:1.2fr 1fr 1fr auto;gap:7px;margin:13px 10px 0;padding-top:12px;border-top:1px solid rgba(255,255,255,.16)}.sq-moderator-tools strong,.sq-mod-status{grid-column:1/-1}.sq-moderator-tools input{min-width:0;padding:7px 9px;background:#111a3d;border:1px solid rgba(142,199,255,.45);color:#fff;font:inherit}.sq-mod-save{font-size:14px}.sq-mod-status{font-size:13px;color:#78e4ff}.sq-mod-challenge{position:fixed;inset:0;z-index:12000;display:flex;align-items:center;justify-content:center;background:rgba(8,12,30,.88)}.sq-mod-card{width:min(430px,calc(100vw - 30px));padding:24px;background:#2b407c;clip-path:polygon(12px 0,calc(100% - 12px) 0,100% 12px,100% calc(100% - 12px),calc(100% - 12px) 100%,12px 100%,0 calc(100% - 12px),0 12px);text-align:center}.sq-mod-card>strong{font-size:28px}.sq-mod-card>p{font-size:15px;color:rgba(240,247,255,.72)}.sq-mod-entry{margin:14px 0;font-size:25px;color:#7ee7ff;letter-spacing:3px}.sq-mod-keypad{display:grid;grid-template-columns:repeat(3,1fr);gap:7px}.sq-mod-keypad .button{min-width:0}.sq-mod-challenge-status{display:block;margin-top:12px;color:#ffd27e;font-size:14px}.sq-hide-lobby-extras #staticMenu{display:none!important}.sq-reduced-effects .staticFunPill,.sq-reduced-effects .staticFunText,.sq-reduced-effects .staticFunChar{animation:none!important}.sq-reduced-effects #injectedRankingsBtn.button-spawn{animation-duration:.01ms!important}.sq-hide-racer-codes .overall-racer-code{display:none!important}@media (max-width:1100px){#overallLeaderboardPanel{--rank-columns:80px minmax(300px,1.5fr) minmax(170px,.8fr) minmax(170px,.7fr)}.overall-rank{width:80px}.overall-car-model{width:108px;height:88px}.overall-name{font-size:25px}.overall-score{font-size:30px}}@media (max-width:760px){#overallLeaderboardPanel{padding:0;--rank-columns:62px 1fr auto}.overall-shell{width:100vw;height:100vh;clip-path:none}.overall-top{padding:16px 14px 11px}.overall-title-group{gap:8px}.overall-beta{display:none}.overall-actions{gap:5px}.overall-action-btn{min-width:70px;font-size:15px}.overall-sub{padding:10px 14px;font-size:15px}.overall-daily{padding:7px 12px;gap:7px}.overall-daily span:last-child{display:none}.overall-columns{display:none}#overallLeaderboardList{padding:7px}.overall-entry{grid-template-columns:62px 1fr auto;grid-template-areas:'rank name stats' 'rank mid stats';min-height:94px;padding-right:12px;gap:7px}.overall-rank{grid-area:rank;width:62px}.overall-name{grid-area:name;font-size:20px}.overall-mid{grid-area:mid}.overall-stats{grid-area:stats}.overall-car-model{width:76px;height:78px;margin-right:8px}.overall-entry.top-1 .overall-car-model{width:82px;height:86px}.overall-score{font-size:24px}.overall-races,.overall-best{font-size:12px}.overall-move{font-size:15px}.overall-pager{gap:6px}.overall-pager .button{min-width:70px;font-size:14px}.overall-page-status{min-width:110px;font-size:13px}.sq-moderator-tools{grid-template-columns:1fr}.overall-help-card p{font-size:18px}.overall-help-content{padding:18px}}@media (max-width:760px){.overall-top{flex-wrap:wrap}.overall-freshness{order:3;flex-basis:100%;max-width:none}.overall-summary{align-items:stretch;flex-direction:column;padding:7px 10px}.overall-sub{padding:0}.overall-categories{justify-content:center}.overall-opportunities{grid-template-columns:1fr;padding:5px 9px}.overall-insight{font-size:11px}.overall-daily{flex-wrap:wrap}.weekly-cup{order:3;width:100%}.profile-head{flex-direction:column;padding-right:70px}.profile-head h3{font-size:28px}.profile-results{grid-template-columns:1fr}.overall-profile-card{max-height:calc(100vh - 20px);overflow:auto}.ranked-testing-notice{bottom:8px;font-size:12px}}@media (prefers-reduced-motion:reduce){.overall-shell,.overall-entry,#injectedRankingsBtn.button-spawn,#injectedRankingsBtn.button-spawn img{animation-duration:.01ms!important;animation-delay:0s!important}}.menu-ui .info,.menu .info{position:fixed!important;left:50%!important;right:auto!important;bottom:8px!important;width:min(900px,calc(100vw - 150px))!important;transform:translateX(-50%)!important;text-align:center!important;pointer-events:none!important;user-select:text!important;overflow:visible!important}.menu-ui .info a,.menu .info a{pointer-events:auto}.staticFunPill{display:inline-block;cursor:pointer;user-select:none;font-family:ForcedSquare,Arial,sans-serif;font-size:19px;font-weight:normal;letter-spacing:.8px;text-decoration:none;padding:3px 10px;margin:4px auto!important;border:0!important;background:transparent!important;clip-path:none!important;text-shadow:0 0 10px rgba(110,235,255,.3);position:relative;z-index:5;overflow:visible!important;filter:drop-shadow(0 0 6px rgba(0,225,255,.18));transition:transform .16s ease,filter .16s ease}.staticFunText,.staticFunChar{overflow:visible!important}.staticFunHover:hover{transform:scale(1.035);filter:brightness(1.2) drop-shadow(0 0 12px rgba(0,255,255,.38))}.ranked-testing-notice{position:fixed;left:50%;top:12px;bottom:auto;z-index:11000;width:min(760px,calc(100vw - 32px));translate:-50% 0;display:flex;align-items:center;gap:12px;padding:9px 12px 9px 16px;background:rgba(25,40,86,.96);color:#eaf4ff;border-bottom:3px solid #7ee7ff;box-shadow:0 10px 28px rgba(0,0,0,.32);font-size:13px;line-height:1.25;animation:rankPanelIn .25s ease-out both}.ranked-testing-notice strong{color:#7ee7ff;font-weight:normal}.ranked-testing-notice .button{margin-left:auto;min-width:82px;flex:0 0 auto}.overall-top{gap:14px;padding-top:16px;padding-bottom:12px}.overall-title-group{flex:0 1 auto}.overall-freshness{flex:1 1 330px;max-width:560px;min-width:190px;min-height:32px;padding:6px 11px;background:rgba(8,16,42,.52);clip-path:polygon(6px 0,100% 0,calc(100% - 6px) 100%,0 100%);font-size:12px;line-height:1.15}.overall-freshness.is-loading::before{background:#7ee7ff;animation:staticGlowPulse 1s infinite}.overall-summary{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 22px;background:#1b2859}.overall-sub{padding:0;background:transparent;font-size:16px}.overall-categories{display:flex;gap:5px;flex:0 0 auto}.overall-categories button{border:0;padding:6px 11px;background:#2b3f7b;color:#c8daf5;font-family:inherit;cursor:pointer}.overall-categories button.active{background:#7ee7ff;color:#10214b}.overall-opportunities{min-height:42px;padding:6px 22px;display:grid;grid-template-columns:1fr 1fr;gap:8px;background:#152047}.overall-insight{display:flex;gap:8px;min-width:0;padding:5px 9px;background:#21346c;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.overall-insight b{color:#7ee7ff;font-weight:normal}.overall-insight.personal{background:#24486b}.overall-entry{min-height:102px;cursor:pointer}.overall-entry.top-1{background:linear-gradient(90deg,#8b6a16 0%,#65562b 38%,#303b68 100%)}.overall-entry.top-2{background:linear-gradient(90deg,#75849b 0%,#53627b 40%,#2d3b68 100%)}.overall-entry.top-3{background:linear-gradient(90deg,#70442d 0%,#564044 40%,#2d3b68 100%)}.overall-flag{width:29px;height:19px;background:transparent;clip-path:none;border:1px solid rgba(255,255,255,.38);border-radius:2px}.overall-flag img{object-fit:contain;background:transparent}.overall-best-line b{color:#9feaff;font-weight:normal}.overall-best-line.muted{color:rgba(206,226,255,.55);font-size:13px}.weekly-cup{padding:4px 8px;background:#253a75}.weekly-cup b{color:#7ee7ff;font-weight:normal}.overall-daily{font-size:13px;gap:9px;padding:6px 18px}.overall-daily strong{font-size:16px}.overall-profile-card{position:relative;width:min(920px,calc(100% - 28px));padding:24px;background:#2d437e;clip-path:polygon(14px 0,calc(100% - 14px) 0,100% 14px,100% calc(100% - 14px),calc(100% - 14px) 100%,14px 100%,0 calc(100% - 14px),0 14px);box-shadow:0 20px 70px rgba(0,0,0,.5)}#overallProfilePopup{display:none;position:absolute;inset:0;z-index:5;align-items:center;justify-content:center;background:rgba(7,12,30,.9);backdrop-filter:blur(5px)}#overallProfileClose{position:absolute;right:18px;top:16px}.profile-head{display:flex;justify-content:space-between;gap:18px;padding:4px 95px 18px 0;border-bottom:3px solid #7ee7ff}.profile-kicker{font-size:12px;color:#7ee7ff;letter-spacing:1.4px}.profile-head h3{display:flex;align-items:center;gap:9px;margin:5px 0;font-size:38px;font-weight:normal}.profile-head p{margin:0;color:#c5d9f5}.profile-medals{display:flex;gap:6px;align-items:center}.profile-medals span{padding:7px 9px;color:#10182e}.profile-medals .gold{background:#e1b94c}.profile-medals .silver{background:#c7d0dc}.profile-medals .bronze{background:#bc7950}.profile-results{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:14px}.profile-result{display:flex;flex-direction:column;gap:5px;padding:14px;background:#1d2d62}.profile-result b{color:#7ee7ff;font-weight:normal}.profile-result span{font-size:20px}.profile-result small{color:#b9cce9}.profile-result.muted{opacity:.65}.profile-target{display:flex;flex-direction:column;gap:5px;margin-top:10px;padding:14px;background:#203c65;border-left:5px solid #7ee7ff}.profile-target b{color:#7ee7ff;font-weight:normal}.profile-disclaimer{margin:12px 0 0;color:rgba(223,237,255,.6);font-size:13px}.staticFunText{display:inline-block;white-space:nowrap;perspective:600px;animation:staticFloat 2.2s ease-in-out infinite}.staticFunChar{display:inline-block;will-change:transform,filter;transform-style:preserve-3d;animation:staticWave 1.6s ease-in-out infinite;background:linear-gradient(90deg,#66f,#6ff,#6f6,#ff6,#f6f,#66f);background-size:300% 100%;background-position:0% 50%;-webkit-background-clip:text;background-clip:text;color:transparent;animation-name:staticWave,staticSheen;animation-duration:1.6s,2.4s;animation-timing-function:ease-in-out,ease-in-out;animation-iteration-count:infinite,infinite}#polytrackHelpPanel{display:none;position:fixed;z-index:10002;right:18px;top:18px;max-width:380px;background:rgba(17,22,45,.96);border:1px solid rgba(255,255,255,.2);padding:14px 14px 10px;box-shadow:0 10px 30px rgba(0,0,0,.45)}#polytrackHelpPanel h3{margin:0 0 8px;font-size:24px;color:#9ad0ff;font-weight:normal}#polytrackHelpPanel p{margin:0 0 8px;font-size:16px;line-height:1.3;color:rgba(255,255,255,.86)}#polytrackHelpPanel .help-small{font-size:14px;color:rgba(255,255,255,.62)}#polytrackHelpPanel a{color:#b7e2ff}#polytrackHelpClose{margin-top:4px;border:1px solid rgba(255,255,255,.24);background:rgba(255,255,255,.08);color:#fff;padding:5px 10px;cursor:pointer}.polytrack-track-freshness{position:fixed;left:14px;bottom:14px;top:auto;z-index:9998;max-width:min(520px,calc(100vw - 28px));padding:7px 12px;background:#253a75;border-left:4px solid #7ee7ff;color:#dcecff;font-size:12px;letter-spacing:.3px;pointer-events:none;clip-path:polygon(0 0,100% 0,calc(100% - 7px) 100%,0 100%);box-shadow:0 8px 24px rgba(0,0,0,.3)}.polytrack-track-freshness.is-stale{border-left-color:#ffbd5d;color:#ffe0a4}#overallLeaderboardPanel{padding:2px;--rank-columns:88px minmax(390px,1.5fr) minmax(300px,1fr) minmax(190px,.62fr)}.overall-shell{width:min(1540px,calc(100vw - 6px));height:calc(100vh - 4px)}.overall-top{padding:13px 20px 10px}.overall-freshness{appearance:none;border:0;color:inherit;text-align:left;cursor:pointer;transition:filter .15s ease}.overall-freshness:hover{filter:brightness(1.2)}.overall-summary{justify-content:center;padding:5px 14px}.overall-categories{flex-wrap:wrap;justify-content:center}.overall-categories button{min-width:92px}.overall-entry{min-height:94px}.overall-entry.top-1{min-height:108px}.overall-racer-meta{display:flex;align-items:center;gap:7px}.row-medals,.profile-medals{display:inline-flex;align-items:center;gap:5px}.row-medals>span,.profile-medals>span{display:inline-flex;align-items:center;gap:4px}.row-medals img{width:14px;height:14px}.row-medals .gold{color:#ffe27a}.row-medals .silver{color:#e4edff}.row-medals .bronze{color:#ffc095}.overall-flag{width:38px;height:26px;border:0;background:transparent;box-shadow:0 0 0 1px rgba(255,255,255,.24);clip-path:none}.overall-flag img{width:100%;height:100%;object-fit:contain;image-rendering:auto}.overall-score-unit{font-size:12px}.competition-kicker{font-size:11px;color:#7ee7ff;letter-spacing:1.5px}.overall-competition section>span:not(.competition-kicker){font-size:15px}.weekly-cup{position:relative;background:linear-gradient(100deg,#5d4a1d,#2e447b)!important;border-left:5px solid #ffe27a}.weekly-medal-key{display:flex;gap:12px;margin-top:8px}.weekly-medal-key span{display:inline-flex;align-items:center;gap:4px;font-size:11px}.weekly-medal-key img{width:18px;height:18px}.weekly-medal-key .gold{color:#ffe27a}.weekly-medal-key .silver{color:#e4edff}.weekly-medal-key .bronze{color:#ffc095}.daily-card{border-left:5px solid #7ee7ff}.overall-competition .overall-pager{display:grid;grid-template-columns:1fr 1fr;align-content:center;gap:7px;min-height:0;padding:10px 12px;background:#1b2859;border:0}.overall-competition .overall-page-status{grid-column:1/-1;grid-row:1;min-width:0}.overall-competition .overall-pager .button{grid-row:2;min-width:0}.sq-weekly-track{position:relative!important;box-shadow:inset 0 0 0 4px #ffe27a,0 0 24px rgba(255,218,92,.5)!important;filter:brightness(1.08)}.sq-weekly-track::after{content:'WEEKLY CUP';position:absolute;right:8px;top:8px;padding:4px 7px;background:#ffe27a;color:#15204a;font:11px ForcedSquare,Arial,sans-serif;letter-spacing:.8px;z-index:4}.overall-profile-card{width:min(1120px,calc(100% - 24px));height:min(900px,calc(100vh - 20px));padding:24px 26px;overflow:auto}.profile-hero{display:grid;grid-template-columns:260px 1fr;gap:22px;align-items:center;padding:4px 80px 18px 0;border-bottom:3px solid #7ee7ff}.profile-hero>.overall-car-model{width:260px;height:180px;margin:0;background:#19285a}.profile-identity h3{display:flex;align-items:center;gap:10px;margin:4px 0 10px;font-size:44px;font-weight:normal}.profile-stat-strip{display:grid;grid-template-columns:repeat(4,minmax(95px,1fr));gap:7px;margin:8px 0}.profile-stat-strip span{display:flex;flex-direction:column;padding:9px 11px;background:#1b2c61;color:#bdd2ef;font-size:12px}.profile-stat-strip b{font-size:26px;color:#fff;font-weight:normal}.profile-medals{margin-top:10px}.profile-medals>span{padding:7px 10px;background:#1b2c61}.profile-medals img{width:22px;height:22px}.profile-medals .gold{color:#ffe27a}.profile-medals .silver{color:#e4edff}.profile-medals .bronze{color:#ffc095}.profile-no-medals{margin:10px 0 0;color:#b9cce8}.profile-results{grid-template-columns:repeat(3,1fr);gap:10px}.profile-result{min-height:80px}.profile-target{font-size:17px}.profile-track-history{margin-top:14px;padding:14px;background:#172554}.profile-track-history header{display:flex;justify-content:space-between;align-items:end;gap:12px;border-bottom:1px solid rgba(126,231,255,.28);padding-bottom:9px}.profile-track-history h4{margin:3px 0 0;font-size:24px;font-weight:normal}.profile-track-history header>span{color:#aabfdd;font-size:13px}.profile-track-list{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:9px}.profile-track-row{display:grid;grid-template-columns:1fr 92px 112px;align-items:center;gap:8px;padding:9px 11px;background:#20356e}.profile-track-row span{display:flex;flex-direction:column;min-width:0}.profile-track-row b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:normal;color:#fff}.profile-track-row small{color:#9fb6d6}.profile-track-row strong{text-align:center;color:#7ee7ff;font-weight:normal}.profile-track-row time{text-align:right;color:#dcecff}.profile-track-empty{padding:18px;color:#aabfdd}.overall-help-card{position:absolute;left:0;top:0;bottom:0;width:min(540px,calc(100vw - 24px));max-height:none;overflow:auto;padding:0;background:#253a75;clip-path:polygon(0 0,calc(100% - 16px) 0,100% 16px,100% 100%,0 100%);box-shadow:18px 0 70px rgba(0,0,0,.52);animation:guideSlideIn .28s ease-out both}.overall-help-head{padding:28px 28px 16px;background:#192755;border-bottom:4px solid #7ee7ff}.overall-help-head span{color:#7ee7ff;font-size:12px;letter-spacing:1.5px}.overall-help-head h3{margin:5px 0 0;font-size:36px;font-weight:normal}.overall-help-content{padding:22px 28px}.overall-help-content section{margin-bottom:14px;padding:12px 14px;background:#1d3068}.overall-help-content section>b{font-size:20px;color:#fff;font-weight:normal}.overall-help-content section p{margin:5px 0 0;font-size:16px}.overall-help-note{border-left:5px solid #ffe27a!important;background:#3d4167!important;padding:12px 14px!important}.overall-help-actions{justify-content:flex-start}.overall-help-content a{color:#9feaff}@keyframes guideSlideIn{from{transform:translateX(-40px);opacity:0}to{transform:translateX(0);opacity:1}}.gold img{filter:sepia(1) saturate(4) hue-rotate(350deg) brightness(1.35)}.silver img{filter:brightness(1.7) saturate(.3)}.bronze img{filter:sepia(1) saturate(2.5) hue-rotate(335deg) brightness(1.05)}@media(max-width:900px){.overall-competition .overall-pager{grid-column:1/-1}.profile-hero{grid-template-columns:190px 1fr}.profile-hero>.overall-car-model{width:190px;height:145px}.profile-track-list{grid-template-columns:1fr}}@media(max-width:620px){.menu-ui .info,.menu .info{width:calc(100vw - 30px)!important}.overall-competition .overall-pager{grid-column:auto}.profile-hero{grid-template-columns:1fr;padding-right:50px}.profile-hero>.overall-car-model{width:100%;height:150px}.profile-stat-strip{grid-template-columns:1fr 1fr}.profile-identity h3{font-size:30px}.profile-track-row{grid-template-columns:1fr 70px}.profile-track-row time{display:none}}.profile-result.no-track{grid-template-columns:1fr;cursor:default}@media(max-width:900px){.overall-top{flex-wrap:wrap}.overall-freshness{order:3;flex-basis:100%;max-width:none}.overall-competition .overall-pager{grid-row:1}.profile-hero{grid-template-columns:220px 1fr}.profile-hero>.overall-car-model{width:220px;height:160px}.profile-stat-strip{grid-template-columns:repeat(3,1fr)}.profile-track-row{grid-template-columns:70px 1fr 90px 95px}.profile-track-row .profile-track-medal{display:none!important}.profile-track-row time{display:none}}@media(max-width:620px){.overall-top h2{font-size:30px}.overall-track-scope{width:100%;justify-content:center}.profile-hero{grid-template-columns:1fr}.profile-stat-strip{grid-template-columns:1fr 1fr}.profile-results{grid-template-columns:1fr}.profile-track-row{grid-template-columns:60px 1fr 80px}.profile-track-row strong{font-size:15px}.profile-track-row>.profile-track-medal,.profile-track-row time{display:none!important}}.overall-summary{min-height:44px}.overall-track-scope{display:flex;align-items:center;gap:4px}.overall-track-scope[hidden]{display:none}.overall-track-scope>span{margin-right:4px;color:#9fb7d8;font-size:12px}.overall-track-scope button{padding:7px 12px;border:0;background:#253b76;color:#d7e6fa;font:14px ForcedSquare,Arial,sans-serif;cursor:pointer}.overall-track-scope button.active{background:#7ee7ff;color:#101d40}.overall-flag{width:31px!important;height:21px!important;border:0!important;border-radius:0!important;box-shadow:none!important;background:transparent!important;overflow:visible!important}.overall-flag img{display:block;width:100%!important;height:100%!important;object-fit:contain!important;background:transparent!important;box-shadow:none!important;filter:none!important}.overall-move{display:inline-flex;align-items:center;align-self:flex-start;padding:3px 7px;background:rgba(6,14,38,.32);font-size:16px!important;white-space:nowrap}.overall-move.flat{background:transparent;padding-left:0}.overall-score-unit{max-width:150px;margin-inline:auto}.overall-entry[aria-label] .overall-score-unit[title]{cursor:help}.overall-competition section>span:not(.competition-kicker){grid-column:3;grid-row:1;font-size:13px!important;white-space:nowrap}.overall-competition .overall-pager{grid-column:2;display:grid!important;grid-template-columns:1fr auto 1fr!important;align-items:center!important;gap:6px!important;padding:7px!important}.overall-competition .overall-page-status{grid-column:2!important;grid-row:1!important;min-width:135px!important;font-size:13px;white-space:nowrap}.overall-competition .overall-pager .button{grid-row:1!important;min-width:105px!important;height:38px;padding:5px 9px;font-size:14px}.overall-competition .overall-pager .button:first-child{grid-column:1}.overall-competition .overall-pager .button:last-child{grid-column:3}.weekly-cup{border-left:4px solid #e8c85f!important;background:linear-gradient(100deg,#493f24,#263b72)!important}.daily-card{border-left:4px solid #7ee7ff!important}.sq-weekly-track{position:relative!important;box-shadow:none!important;filter:none!important}.sq-weekly-track::after{display:none!important}.sq-weekly-track .track-title p::after{content:'  FEATURED';color:#e8c85f;font-size:.6em;letter-spacing:.7px}.sq-weekly-track .track-title{box-shadow:inset 4px 0 #e8c85f}.overall-profile-card{width:min(1240px,calc(100% - 18px))!important;height:min(930px,calc(100vh - 12px))!important;padding:22px 24px!important}.profile-hero{grid-template-columns:280px minmax(0,1fr)!important;gap:24px!important}.profile-hero>.overall-car-model{width:280px!important;height:176px!important}.profile-identity h3{font-size:42px!important}.profile-stat-strip{grid-template-columns:repeat(6,minmax(90px,1fr))!important}.profile-stat-strip span{padding:8px 10px!important}.profile-stat-strip b{font-size:23px!important}.profile-medals{gap:5px!important}.profile-medals>span{padding:5px 8px!important;font-size:13px}.profile-medals img{width:18px!important;height:18px!important}.profile-results{grid-template-columns:repeat(3,minmax(0,1fr))!important}.profile-result{display:grid!important;grid-template-columns:112px minmax(0,1fr) 68px!important;align-items:center;gap:10px;min-height:90px!important;padding:8px!important;border:0;color:inherit;text-align:left;font:inherit;cursor:pointer}.profile-result:hover,.profile-track-row:hover{filter:brightness(1.13)}.profile-result .profile-track-thumb{width:112px;height:68px;object-fit:cover;object-position:center;display:block!important}.profile-result>div{min-width:0}.profile-result>div span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:19px}.profile-result-weight{display:flex;flex-direction:column;align-items:center;color:#7ee7ff;font-size:18px;font-weight:normal}.profile-result-weight small{font-size:9px;letter-spacing:.8px;color:#9db6d7}.profile-target span strong{color:#fff;font-weight:normal}.profile-track-history{padding:11px 12px!important}.profile-track-history header{padding-bottom:6px!important}.profile-track-history h4{font-size:22px!important}.profile-track-head{display:grid;grid-template-columns:minmax(260px,1fr) 110px 90px 100px 112px;gap:8px;padding:4px 10px;color:#7899c4;font-size:10px;letter-spacing:1px;text-transform:uppercase}.profile-track-head span:first-child{padding-left:82px}.profile-track-list{grid-template-columns:1fr!important;gap:4px!important;margin-top:3px!important}.profile-track-row{grid-template-columns:72px minmax(180px,1fr) 110px 90px 100px 112px!important;gap:8px!important;padding:6px 10px!important;min-height:66px;border:0;color:inherit;text-align:left;font:inherit;cursor:pointer}.profile-track-visual{display:block!important}.profile-track-thumb{width:72px;height:48px;object-fit:cover;object-position:center;display:block}.profile-track-name{gap:2px}.profile-track-name b{font-size:17px}.profile-track-weight{align-items:center!important;text-align:center}.profile-track-weight b{color:#7ee7ff!important;font-size:17px}.profile-track-weight small{font-size:10px!important}.profile-track-medal{display:inline-flex!important;flex-direction:row!important;align-items:center;justify-content:center;gap:4px;font-size:11px;text-transform:capitalize}.profile-track-medal img{width:18px;height:18px}.profile-track-medal.empty{color:#6f88aa}.profile-track-row>strong,.profile-track-row>time{text-align:right!important}.overall-freshness.is-stale{background:#513926!important;color:#ffe1a3!important;border-left:4px solid #ffb95c}.overall-freshness.is-stale[data-old='true']{background:#6a3029!important;color:#fff1df!important;box-shadow:0 0 18px rgba(255,113,85,.28)}@media(max-width:1000px){.overall-competition .overall-pager{grid-column:1;grid-row:1}.profile-stat-strip{grid-template-columns:repeat(3,1fr)!important}.profile-track-head{display:none}.profile-track-row{grid-template-columns:64px minmax(140px,1fr) 90px 90px!important}.profile-track-row>.profile-track-medal,.profile-track-row>time{display:none!important}}@media(max-width:620px){.profile-hero{grid-template-columns:1fr!important}.profile-hero>.overall-car-model{width:100%!important;height:145px!important}.profile-results{grid-template-columns:1fr!important}.profile-result{grid-template-columns:92px minmax(0,1fr) 60px!important}.profile-result .profile-track-thumb{width:92px;height:58px}.profile-track-row{grid-template-columns:56px minmax(120px,1fr) 78px!important}.profile-track-row>strong{display:none}.profile-track-thumb{width:56px;height:38px}}.overall-top{justify-content:space-between}.overall-racer-meta{flex-wrap:wrap;gap:4px 8px!important;margin-top:5px;font-size:14px!important;line-height:1.1}.overall-racer-meta>span:not(.row-medals){padding-right:8px;border-right:1px solid rgba(202,222,248,.25)}.overall-racer-meta>.overall-weight-chip{padding:3px 7px!important;border:1px solid rgba(126,231,255,.38)!important;background:rgba(17,43,79,.72);color:#8ff1ff;font-size:14px}.row-medals{padding-left:1px}.row-medals>span{font-size:14px}.row-medals .gold{color:#ffe381}.row-medals .silver{color:#edf4ff}.row-medals .bronze{color:#ffb786}.overall-best-line{cursor:pointer}.overall-best-line em{margin-left:5px;color:#8ff1ff;font-size:13px;font-style:normal}.overall-move{padding:0!important;background:transparent!important;font-size:19px!important;font-weight:normal;text-shadow:0 2px 7px rgba(0,0,0,.45)}.overall-move.up{color:#77f3aa}.overall-move.down{color:#ff8b86}.overall-move.flat{color:#91a5c4;font-size:13px!important;text-shadow:none}.overall-footer-tools{grid-column:1/-1;display:grid;grid-template-columns:auto auto minmax(300px,1fr);align-items:center;gap:8px;padding:7px 9px;background:#182754}.overall-footer-tools .overall-freshness{max-width:none;min-height:36px;padding:7px 12px;background:#111d43;font-size:13px}.overall-footer-tools .overall-track-scope{justify-content:center}.profile-results{grid-template-columns:repeat(2,minmax(0,1fr))!important}.profile-result .profile-track-thumb,.profile-track-thumb{object-fit:contain!important;background:#14234f}.profile-result{min-height:104px!important}.profile-result>div span{font-size:21px}.profile-track-head{grid-template-columns:minmax(0,1fr) 110px 150px 112px!important;padding-left:92px!important}.profile-track-head button{border:0;background:transparent;color:#8ca7ca;font:11px ForcedSquare,Arial,sans-serif;text-align:left;text-transform:uppercase;letter-spacing:.8px;cursor:pointer}.profile-track-head button.active,.profile-track-head button:hover{color:#8ff1ff}.profile-track-row{grid-template-columns:72px minmax(180px,1fr) 110px 150px 112px!important}.profile-track-result{display:grid!important;grid-template-columns:24px 1fr;grid-template-rows:auto auto;align-items:center}.profile-track-result img{grid-row:1/3;width:21px;height:21px}.profile-track-result b{color:#e8f2ff!important}.profile-track-result.gold b{color:#ffe381!important}.profile-track-result.silver b{color:#edf4ff!important}.profile-track-result.bronze b{color:#ffb786!important}.profile-target{font-size:18px}.profile-inline-track{border:0;padding:0;background:transparent;color:#8ff1ff;font:inherit;cursor:pointer}.profile-inline-track:hover{text-decoration:underline}.profile-medals .gold{color:#ffe381!important}.profile-medals .silver{color:#edf4ff!important}.profile-medals .bronze{color:#ffb786!important}@media(max-width:1000px){.overall-footer-tools{grid-template-columns:1fr}.profile-track-row{grid-template-columns:64px minmax(140px,1fr) 90px 130px!important}.profile-track-row time{display:none}.profile-track-head{display:none}}@media(max-width:620px){.overall-racer-meta{font-size:12px!important}.overall-footer-tools{padding:6px}.overall-footer-tools .overall-freshness{font-size:12px}.profile-track-row{grid-template-columns:56px minmax(120px,1fr) 108px!important}.profile-track-row .profile-track-weight{display:none!important}.profile-track-result{display:grid!important}.profile-result>div span{font-size:18px}}.sq-weekly-title{position:relative;background:linear-gradient(90deg,#8a6a18,#d4aa37)!important;color:#fff!important;box-shadow:inset 0 -4px 0 #fff1a5,0 0 0 2px rgba(255,226,122,.32);transform-origin:center;transition:transform .16s ease,filter .16s ease,box-shadow .16s ease}.button:hover .sq-weekly-title,.sq-weekly-title:hover{transform:translateY(-2px) scale(1.015);filter:brightness(1.12);box-shadow:inset 0 -4px 0 #fff8c8,0 5px 14px rgba(255,205,75,.34)}.sq-hide-pb-podiums .sq-pb-medal{display:none!important}.personal-best.sq-pb-podium{position:relative;padding-right:50px!important}.personal-best.sq-pb-podium.gold{color:#ffe381!important;text-shadow:0 1px 6px rgba(255,213,86,.35)}.personal-best.sq-pb-podium.silver{color:#edf4ff!important}.personal-best.sq-pb-podium.bronze{color:#ffb786!important}.sq-pb-medal{position:absolute;right:7px;top:50%;transform:translateY(-50%);display:inline-flex;align-items:center;gap:3px;padding:3px 5px;background:#17234f;font-size:12px}.sq-pb-medal img{width:17px;height:17px}.overall-best-line em,.overall-weight-chip,.profile-result-weight>span,.profile-track-weight>b{display:inline-flex!important;align-items:center;justify-content:center;padding:3px 7px!important;border:1px solid rgba(126,231,255,.42)!important;background:#132550!important;color:#8ff1ff!important;line-height:1!important}.overall-best-line em{margin-left:7px!important}.overall-entry.is-self{background:linear-gradient(90deg,#17647a 0%,#286d8f 48%,#244d7f 100%)!important;box-shadow:inset 0 0 0 4px #8ff1ff,0 0 26px rgba(75,229,255,.48)!important}.profile-identity .overall-you-tag{padding:7px 12px;font-size:14px;box-shadow:0 0 17px rgba(126,231,255,.65)}.overall-competition .weekly-cup{border-left:0!important;border-bottom-color:#e8c85f!important;background:#313961!important}.overall-competition .daily-card{border-left:0!important;border-bottom-color:#7ee7ff!important}.overall-competition .overall-pager{min-height:58px!important;padding:6px 9px!important;background:#192858!important}.overall-competition .overall-pager .button{min-width:48px!important;width:48px;height:40px;font-size:25px!important;line-height:30px}.overall-competition .overall-page-status{min-width:150px!important;font-size:15px!important}.overall-footer-tools{grid-template-columns:minmax(260px,320px) auto minmax(330px,1fr)!important;gap:7px!important;padding:7px 9px!important;background:#101a3d!important;border-top:1px solid rgba(126,231,255,.24)}.overall-footer-tools .overall-freshness{min-height:40px!important;background:#192858!important;font-size:14px!important}.profile-stat-strip{grid-template-columns:repeat(3,minmax(150px,1fr))!important;gap:8px!important}.profile-stat-strip span{min-height:58px;justify-content:center;font-size:13px!important}.profile-stat-strip b{font-size:21px!important;white-space:normal!important}.profile-results{gap:8px!important}.profile-result{grid-template-columns:96px minmax(0,1fr) 76px!important;min-height:98px!important}.profile-result .profile-track-thumb{width:96px!important;height:64px!important;object-fit:contain!important;image-rendering:auto!important}.profile-track-thumb{object-fit:contain!important;image-rendering:auto!important}.profile-track-history{margin-top:10px!important}.profile-track-row{min-height:60px!important}.profile-track-name b{font-size:18px!important}.profile-track-row time{font-size:16px}.profile-track-head button{font-size:12px!important}.profile-track-head button.active{background:rgba(126,231,255,.1);box-shadow:inset 0 -2px #7ee7ff}.sq-compact-ranked .overall-racer-meta,.sq-compact-ranked .overall-best-line+ .overall-best-line{display:none!important}#overallHelpPopup{background:transparent!important;backdrop-filter:none!important;justify-content:flex-start!important;padding:0!important;pointer-events:none}.overall-help-card{pointer-events:auto;width:min(560px,calc(100vw - 18px))!important;background:#253a75!important}.overall-help-head h3{font-size:40px!important}.overall-help-content section>b{font-size:22px!important;font-weight:700!important}.overall-help-content section p{font-size:18px!important;line-height:1.35}.overall-help-content>p{font-size:17px!important}.polytrack-track-freshness{max-width:min(650px,calc(100vw - 28px))!important;padding:9px 14px!important;font-size:15px!important;line-height:1.25}.polytrack-track-freshness.is-stale{font-weight:700}@media(max-width:900px){.overall-footer-tools{grid-template-columns:1fr!important}.profile-stat-strip{grid-template-columns:repeat(2,minmax(130px,1fr))!important}}@media(max-width:620px){.profile-stat-strip{grid-template-columns:1fr 1fr!important}.profile-stat-strip b{font-size:17px!important}.overall-help-card{width:calc(100vw - 8px)!important}.overall-help-content section p{font-size:17px!important}}.sq-settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 12px;margin:8px 10px 0}.sq-settings-grid .sq-setting-row{margin:0;min-height:68px;padding:7px 9px;background:rgba(22,38,83,.5);align-items:center}.sq-settings-grid .sq-setting-row>p{font-size:19px;line-height:1.08}.sq-settings-grid .sq-setting-row .button{min-width:112px}.sq-settings-grid .sq-setting-secret,.sq-settings-grid .sq-setting-range{grid-column:1/-1}.overall-entry.is-self.top-1{background:linear-gradient(90deg,#8a6a18 0%,#5d522f 40%,#303b68 100%)!important}.overall-entry.is-self.top-2{background:linear-gradient(90deg,#68758b 0%,#495775 42%,#2b3967 100%)!important}.overall-entry.is-self.top-3{background:linear-gradient(90deg,#7c4d31 0%,#56434a 42%,#2b3967 100%)!important}.overall-entry.is-self.top-1,.overall-entry.is-self.top-2,.overall-entry.is-self.top-3{box-shadow:inset 0 0 0 4px #8ff1ff,0 0 26px rgba(75,229,255,.48)!important}.overall-you-tag{padding:5px 9px!important;background:#8ff1ff!important;color:#0c2147!important;font-size:13px!important;font-weight:700!important;letter-spacing:1px;box-shadow:0 0 13px rgba(126,231,255,.72)}.overall-racer-meta{font-size:15px!important}.overall-weight-chip,.overall-best-line em{font-size:16px!important;font-weight:700!important}.overall-score{font-size:35px!important}.overall-best-line{font-size:15px!important}.overall-footer-tools{grid-template-columns:minmax(280px,1fr) auto minmax(280px,1fr)!important}.overall-footer-tools .overall-freshness{grid-column:1;text-align:left!important}.overall-footer-tools .overall-track-scope{grid-column:3;justify-self:end}.profile-track-thumb{object-fit:contain!important;object-position:center!important;filter:none!important;transform:none!important}.profile-trend{display:flex;align-items:center;gap:10px;margin-top:8px;color:#bcd0ed;font-size:12px}.profile-rank-trend{display:flex;align-items:end;gap:3px;height:56px;padding:3px 6px;background:#142451}.profile-rank-trend i{display:block;width:8px;min-height:8px;background:#7ee7ff}.profile-trend-empty{color:#91a8c9}.profile-medals>span{background:#12234f!important;font-weight:700}.profile-medals .gold{color:#ffe381!important}.profile-medals .silver{color:#f5f8ff!important}.profile-medals .bronze{color:#ffc09b!important}.polytrack-track-freshness{display:flex;flex-direction:column;gap:2px}.polytrack-track-freshness strong{font-weight:700}.polytrack-track-freshness span{font-size:.82em;color:#a9c8ea}.record.sq-pb-podium{position:relative;padding-right:50px!important}.record.sq-pb-podium.gold{color:#ffe381!important}.record.sq-pb-podium.silver{color:#edf4ff!important}.record.sq-pb-podium.bronze{color:#ffb786!important}@media(max-width:900px){.overall-shell{width:100vw!important}.overall-entry{grid-template-columns:68px minmax(0,1fr) minmax(180px,.8fr) 145px!important;padding-right:10px}.overall-car-model{width:88px!important}.overall-footer-tools{grid-template-columns:1fr 1fr!important}.overall-footer-tools .overall-freshness{grid-column:1/-1;grid-row:2}.overall-footer-tools .overall-track-scope{grid-column:2;grid-row:1;justify-self:end}.overall-competition .overall-pager{grid-column:1/-1!important;grid-row:1}.sq-settings-grid{grid-template-columns:1fr}.profile-result .profile-track-thumb{width:78px!important;height:58px!important}.profile-result{grid-template-columns:78px minmax(0,1fr) 72px!important}}@media(max-width:620px){.overall-entry{grid-template-columns:56px minmax(0,1fr) 106px!important;grid-template-areas:'rank name stats' 'rank mid stats'}.overall-mid{max-width:none}.overall-best-line:nth-child(2){display:none}.overall-score{font-size:25px!important}.overall-score-unit{font-size:10px!important}.overall-competition .overall-pager{grid-column:1/-1!important}.overall-competition section>span:not(.competition-kicker){font-size:11px!important}.overall-footer-tools{grid-template-columns:1fr!important}.overall-footer-tools .overall-track-scope,.overall-footer-tools .overall-freshness{grid-column:1!important;justify-self:stretch!important}.overall-footer-tools .overall-track-scope{grid-row:2}.overall-footer-tools .overall-freshness{grid-row:3}.sq-settings-grid .sq-setting-row>p{font-size:17px}.profile-trend{align-items:flex-start;flex-direction:column}.profile-rank-trend{width:100%}.polytrack-track-freshness{font-size:13px!important}}.overall-footer-right{display:grid;grid-template-columns:1fr;grid-template-rows:auto auto auto;gap:5px;align-content:center;padding:7px 9px;background:#101a3d;border-top:1px solid rgba(126,231,255,.24)}.overall-footer-right .overall-track-scope{grid-row:2;justify-content:center}.overall-footer-right .overall-freshness{grid-row:3;max-width:none;min-height:38px;padding:7px 10px;background:#192858;font-size:calc(14px * var(--sq-ui-scale,1));text-align:center}.overall-pager{align-self:center}.profile-stat-strip span{min-height:72px!important;padding:10px 12px!important;font-size:calc(14px * var(--sq-ui-scale,1))!important;line-height:1.18}.profile-stat-strip b{font-size:calc(25px * var(--sq-ui-scale,1))!important}.profile-achievement-row{display:flex;align-items:center;justify-content:space-between;gap:14px;margin:9px 0;padding:9px 13px;background:#162858;border-left:4px solid #7ee7ff;color:#bcd0ed;font-size:calc(16px * var(--sq-ui-scale,1))}.profile-achievement-row .profile-medals{margin:0!important;gap:9px!important}.profile-achievement-row .profile-medals>span{padding:8px 12px!important;font-size:calc(16px * var(--sq-ui-scale,1))}.profile-achievement-row .profile-medals img{width:26px!important;height:26px!important}.profile-track-image-frame{position:relative;display:flex!important;align-items:center;justify-content:center;width:82px;height:82px;overflow:hidden;background:#14234f;box-shadow:inset 0 0 0 1px rgba(126,231,255,.2)}.profile-track-placeholder{position:absolute!important;inset:auto!important;color:#6f88aa;font-size:9px;letter-spacing:.8px}.profile-track-image-frame .profile-track-thumb{position:relative;width:100%!important;height:100%!important;object-fit:contain!important;object-position:center!important;background:#14234f}.profile-result{grid-template-columns:92px minmax(0,1fr) 76px!important}.profile-result>.profile-track-image-frame{width:88px;height:88px}.profile-track-row{grid-template-columns:88px minmax(180px,1fr) 110px 150px 112px!important;min-height:92px!important}.profile-track-row .profile-track-image-frame{width:82px;height:82px}.polytrack-track-freshness{padding:12px 17px!important;min-width:290px;font-size:calc(16px * var(--sq-ui-scale,1))!important}.polytrack-track-freshness strong{font-size:calc(19px * var(--sq-ui-scale,1))}.polytrack-track-freshness span{font-size:calc(16px * var(--sq-ui-scale,1))!important}.sq-settings-grid{gap:10px 14px!important;margin:12px!important}.sq-settings-grid .sq-setting-row{min-height:82px!important;padding:10px 13px!important}.sq-settings-grid .sq-setting-row>p{font-size:calc(20px * var(--sq-ui-scale,1))!important}.sq-setting-range{display:grid!important;grid-template-columns:minmax(0,1fr) minmax(180px,.8fr);gap:14px}.sq-range-controls{display:flex;align-items:center;gap:10px}.sq-range-controls input{width:100%;accent-color:#7ee7ff}.sq-range-controls output{min-width:48px;color:#8ff1ff;font-size:18px}.row-medal-denominator{border:0!important;color:#b9cce8}.overall-entry[data-category='medals'] .overall-best-line,#overallLeaderboardPanel[data-category='medals'] .overall-best-line{font-size:17px!important}.overall-name-main{font-size:calc(27px * var(--sq-ui-scale,1))!important}.overall-best-line{font-size:calc(15px * var(--sq-ui-scale,1))!important}.overall-score{font-size:calc(35px * var(--sq-ui-scale,1))!important}.profile-identity h3{font-size:calc(42px * var(--sq-ui-scale,1))!important}@media(max-width:900px){.overall-pager{grid-column:2!important;grid-row:1!important}.overall-footer-right{grid-column:1/-1;grid-template-columns:1fr 1fr}.overall-footer-right .overall-track-scope{grid-column:2;grid-row:1}.overall-footer-right .overall-freshness{grid-column:1/-1;grid-row:2}.profile-track-row{grid-template-columns:76px minmax(140px,1fr) 90px 130px!important}.profile-track-image-frame{width:70px!important;height:70px!important}}@media(max-width:620px){.overall-pager,.overall-footer-right{grid-column:1!important}.overall-pager{grid-row:auto!important}.overall-footer-right{grid-template-columns:1fr}.overall-footer-right .overall-track-scope,.overall-footer-right .overall-freshness{grid-column:1;grid-row:auto}.profile-achievement-row{align-items:flex-start;flex-direction:column}.profile-track-row{grid-template-columns:62px minmax(110px,1fr) 104px!important}.profile-track-image-frame{width:56px!important;height:56px!important}.sq-setting-range{grid-template-columns:1fr}.polytrack-track-freshness{min-width:0;font-size:14px!important}.polytrack-track-freshness strong{font-size:17px}.polytrack-track-freshness span{font-size:14px!important}}.overall-freshness.is-old-change:not(.is-stale){background:#463d22!important;color:#ffe7a3!important;border-left:4px solid #ffd16f}.overall-pager{grid-template-columns:58px minmax(180px,1fr) 58px!important;gap:9px!important;padding:9px 12px!important}.overall-pager .button{width:58px!important;min-width:58px!important;height:44px!important;background:#304b8d!important;color:#fff!important;clip-path:polygon(7px 0,100% 0,calc(100% - 7px) 100%,0 100%)}.overall-pager .button:hover:not(:disabled){background:#7ee7ff!important;color:#10214b!important}.overall-pager .button:disabled{background:#17244f!important;color:#667da6!important}.overall-page-status{min-width:0!important;padding:10px 8px;background:#111d43;color:#eff7ff!important;font-size:16px!important}.sq-pb-ranked{position:relative;padding-right:50px!important}.sq-pb-medal.placed{background:#183162!important;color:#9feaff!important;border:1px solid rgba(126,231,255,.4)}@media(max-width:620px){.overall-pager{grid-template-columns:48px minmax(120px,1fr) 48px!important}.overall-pager .button{width:48px!important;min-width:48px!important}.overall-page-status{font-size:13px!important}}.overall-footer-right .overall-freshness{min-height:46px!important;padding:9px 13px!important;font-size:calc(16px * var(--sq-ui-scale,1))!important;line-height:1.25}.overall-profile-card{width:min(1380px,calc(100% - 12px))!important;height:min(960px,calc(100vh - 8px))!important}.profile-stat-strip.profile-stat-rich{grid-template-columns:repeat(4,minmax(145px,1fr))!important}.profile-stat-rich span{min-height:68px!important}.profile-stat-rich b{overflow-wrap:break-word}.profile-track-history{min-height:300px}.profile-track-empty{display:flex;flex-direction:column;gap:7px;min-height:130px;justify-content:center;padding:22px!important;background:#1c3066;color:#bcd0ed}.profile-track-empty strong{color:#fff;font-size:20px}.profile-track-row{grid-template-columns:104px minmax(210px,1fr) 120px 165px 120px!important;min-height:108px!important}.profile-track-row .profile-track-image-frame{width:96px!important;height:92px!important}.profile-track-image-frame{padding:7px;box-sizing:border-box}.profile-track-image-frame .profile-track-thumb{background:transparent!important}.profile-track-image-frame.is-silhouette .profile-track-thumb{image-rendering:pixelated!important;object-fit:contain!important;padding:8%;box-sizing:border-box}.profile-track-image-frame.is-artwork .profile-track-thumb{image-rendering:auto!important;object-fit:contain!important}.profile-track-name small+small{margin-top:5px;color:#8ff1ff;font-size:12px}.overall-track-entry .profile-track-image-frame{flex:0 0 auto;width:104px!important;height:86px!important;margin-right:12px}.overall-track-entry .overall-name{align-items:center}.ranked-testing-notice a{color:#8ff1ff;font-weight:700}.overall-empty.compact{margin-bottom:7px;padding:10px 14px}.overall-empty.compact strong{font-size:18px}@media(max-width:1000px){.profile-stat-strip.profile-stat-rich{grid-template-columns:repeat(3,minmax(130px,1fr))!important}.profile-track-row{grid-template-columns:84px minmax(150px,1fr) 100px 145px!important}.profile-track-row .profile-track-image-frame{width:76px!important;height:72px!important}}@media(max-width:620px){.profile-stat-strip.profile-stat-rich{grid-template-columns:1fr 1fr!important}.profile-stat-rich span{min-height:62px!important}.profile-track-row{grid-template-columns:68px minmax(120px,1fr) 108px!important;min-height:82px!important}.profile-track-row .profile-track-image-frame{width:62px!important;height:62px!important}.overall-track-entry .profile-track-image-frame{width:68px!important;height:62px!important;margin-right:7px}.overall-footer-right .overall-freshness{font-size:14px!important}}.overall-center-tools{display:grid;grid-template-rows:1fr auto;gap:6px;min-width:0}.overall-center-tools .overall-pager{grid-column:auto!important;grid-row:auto!important}.overall-center-tools .overall-freshness{width:100%;max-width:none!important;min-height:36px!important;box-sizing:border-box;justify-content:center;text-align:center!important}.overall-footer-right{display:grid;grid-template-columns:1fr auto;grid-template-rows:auto 1fr;gap:7px;padding:9px 10px;background:linear-gradient(120deg,#192957,#21366f);min-width:0}.overall-track-scope{grid-column:1/-1;justify-content:center}.leaderboard-arcade{grid-column:1/-1;display:flex;align-items:center;gap:8px;min-width:0}.leaderboard-arcade>span{flex:0 0 auto;color:#7ee7ff;font-size:10px;letter-spacing:1px}.leaderboard-arcade>div{display:flex;gap:4px;min-width:0;overflow:hidden}.leaderboard-arcade button{display:inline-flex;align-items:center;gap:5px;min-width:0;padding:5px 7px;border:0;background:#2d4686;color:#eaf4ff;font:11px ForcedSquare,Arial,sans-serif;white-space:nowrap;cursor:pointer}.leaderboard-arcade button:hover{background:#4564a8}.leaderboard-arcade small{padding:1px 4px;background:#12204a;color:#8ff1ff}.overall-provisional-tag{padding:3px 6px;background:#5b4c2c;color:#ffe4a0;font-size:10px;letter-spacing:.7px}.overall-entry.is-provisional{opacity:.82}.medal-text-gold{color:#ffe381!important}.medal-text-silver{color:#f4f7ff!important}.medal-text-bronze{color:#ffb786!important}.overall-track-entry{min-height:118px!important}.overall-track-entry .overall-name-main{font-size:31px!important}.overall-track-entry .overall-mid{gap:9px}.overall-track-entry .overall-best-line{font-size:17px!important}.overall-track-entry .overall-score{font-size:40px!important}.profile-track-placeholder.is-mystery{position:absolute!important;inset:0!important;display:flex!important;align-items:center;justify-content:center;color:#7ee7ff!important;font-size:52px!important;text-shadow:0 0 18px rgba(126,231,255,.48);background:radial-gradient(circle,#27427d 0,#14234f 68%);z-index:0}.profile-track-image-frame.is-custom{background:linear-gradient(135deg,#111d42,#253c76)!important}.profile-track-image-frame .profile-track-thumb{z-index:1}.profile-track-image-frame:not(.is-custom):not(:has(img)){background:#14234f!important}.profile-guide{margin-top:12px;background:#17285a;border-left:5px solid #7ee7ff}.profile-guide-body{padding:14px;background:#13234e}.profile-guide-body>header{display:flex;align-items:end;justify-content:space-between;gap:12px;padding-bottom:10px;border-bottom:2px solid rgba(126,231,255,.25)}.profile-guide-body h4{margin:3px 0 0;font-size:27px;font-weight:normal}.profile-guide-body h5{margin:0;font-size:21px;font-weight:normal;color:#fff}.profile-guide-body section{margin-top:12px;padding:12px;background:#1b3066}.profile-guide-body section>p{margin:4px 0 10px;color:#aebfda;font-size:13px}.profile-guide-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px}.profile-guide-grid.compact{grid-template-columns:1fr}.profile-guide-track{display:grid;grid-template-columns:76px minmax(0,1fr) 78px;align-items:center;gap:9px;min-height:84px;padding:7px;border:0;background:#253f7c;color:inherit;text-align:left;font:inherit;cursor:pointer}.profile-guide-track:hover{filter:brightness(1.14)}.profile-guide-image .profile-track-image-frame{width:72px!important;height:68px!important}.profile-guide-copy{display:flex;flex-direction:column;gap:3px;min-width:0}.profile-guide-copy b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#b9d3f2;font-weight:normal}.profile-guide-copy strong{color:#fff}.profile-guide-copy small{color:#9fb6d5;font-size:11px}.profile-helpfulness{display:flex;flex-direction:column;align-items:center;gap:3px}.profile-helpfulness>b{color:#7ff2ad;font-size:20px;font-weight:normal}.profile-helpfulness small{font-size:8px;color:#a9bfdc}.profile-helpfulness i{display:block;width:58px;height:4px;background:#11204a}.profile-helpfulness em{display:block;height:100%;background:linear-gradient(90deg,#75dfff,#7ff2ad)}.profile-guide-columns{display:grid;grid-template-columns:1fr 1fr;gap:10px}.profile-goal-ladder ol{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin:9px 0 0;padding:0;list-style:none}.profile-goal-ladder li{padding:9px;background:#243f7d;color:#c9daf0}.profile-goal-ladder li b{color:#8ff1ff}.profile-guide-empty{padding:12px!important;background:#20386f;color:#b8cae4!important}.profile-stat-rich span{font-size:14px!important}.profile-stat-rich b{font-size:27px!important}.profile-achievement-row{font-size:15px}.polytrack-track-freshness{left:max(10px,env(safe-area-inset-left))!important;bottom:max(10px,env(safe-area-inset-bottom))!important;max-width:min(470px,calc(100vw - 20px))!important;box-sizing:border-box}@media(max-width:1400px){#overallLeaderboardPanel{--rank-columns:76px minmax(350px,1.35fr) minmax(270px,.92fr) minmax(165px,.55fr)}.overall-rank{width:76px}.overall-car-model{width:106px;height:88px}.overall-name-main{font-size:24px!important}.overall-track-entry .overall-name-main{font-size:27px!important}.profile-stat-strip.profile-stat-rich{grid-template-columns:repeat(4,minmax(125px,1fr))!important}}@media(max-height:820px) and (min-width:901px){.overall-top{padding-top:10px!important;padding-bottom:7px!important}.overall-top h2{font-size:38px}.overall-entry{min-height:86px!important}.overall-entry.top-1,.overall-track-entry{min-height:96px!important}.leaderboard-arcade button{padding:3px 6px}.overall-center-tools .overall-freshness{min-height:30px!important;font-size:12px!important}}@media(max-width:900px){.overall-center-tools{grid-column:2}.overall-footer-right{grid-column:1/-1}.profile-guide-grid{grid-template-columns:1fr 1fr}.profile-goal-ladder ol{grid-template-columns:1fr}.profile-track-placeholder.is-mystery{font-size:38px!important}}@media(max-width:620px){#overallLeaderboardPanel{--rank-columns:54px minmax(0,1fr) 92px}.overall-shell{overflow-x:hidden}.overall-entry{grid-template-columns:54px minmax(0,1fr) 92px!important;grid-template-rows:auto auto!important;grid-template-areas:'rank name stats' 'rank mid stats'!important;min-height:108px!important;padding:5px 7px 5px 0!important;column-gap:5px!important}.overall-rank{grid-area:rank!important;width:54px!important;font-size:28px!important}.overall-name{grid-area:name!important;min-width:0!important;font-size:18px!important}.overall-car-model,.overall-entry.top-1 .overall-car-model{flex:0 0 auto;width:58px!important;height:54px!important;margin-right:6px!important}.overall-name-main{font-size:19px!important}.overall-racer-meta{gap:3px 5px!important;margin-top:2px!important;font-size:10px!important}.overall-racer-meta>span:not(.row-medals){padding-right:5px}.row-medals{display:none!important}.overall-mid{grid-area:mid!important;min-width:0!important;gap:2px!important}.overall-move{font-size:12px!important;white-space:nowrap}.overall-best{min-width:0;font-size:10px!important}.overall-best-line{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.overall-best-line:nth-child(n+2){display:none}.overall-stats{grid-area:stats!important;min-width:88px!important}.overall-score{font-size:27px!important}.overall-score-unit{font-size:9px!important}.overall-competition>*{min-width:0!important;max-width:100%!important;box-sizing:border-box}.overall-center-tools,.overall-footer-right{grid-column:1}.weekly-cup,.daily-card{order:initial!important}.leaderboard-arcade{display:none}.profile-results{grid-template-columns:1fr!important}.profile-result{grid-template-columns:76px minmax(0,1fr) 68px!important;min-height:94px!important}.profile-result>.profile-track-image-frame{width:70px!important;height:70px!important}.profile-result>div span{font-size:18px!important}.profile-result>div small{font-size:12px}.profile-result-weight{min-width:58px}.profile-guide-columns{grid-template-columns:1fr}.profile-guide-grid{grid-template-columns:1fr}.profile-guide-track{grid-template-columns:62px minmax(0,1fr) 68px}.profile-guide-image .profile-track-image-frame{width:58px!important;height:56px!important}.profile-guide-body>header{align-items:start;flex-direction:column}.profile-stat-rich b{font-size:21px!important}.polytrack-track-freshness{font-size:13px!important;padding:8px 10px!important}.polytrack-track-freshness strong{font-size:15px!important}}/* Final Ranked layout: one predictable footer and profile hierarchy. */\n      .overall-competition{display:grid!important;grid-template-columns:minmax(300px,1fr) minmax(390px,.9fr) minmax(320px,1fr)!important;gap:10px!important;align-items:stretch!important;width:100%!important;max-width:100%!important;box-sizing:border-box!important;padding:9px 14px!important;background:#0d1738!important;border-top:2px solid rgba(126,231,255,.3)!important}.overall-competition .weekly-cup{background:#31375c!important;border-left-color:#e8c85f!important}.overall-competition .daily-card{border-left-color:#7ee7ff!important}.competition-kicker{grid-column:1!important;grid-row:1!important;font-size:12px!important}.competition-track-name{grid-column:2!important;grid-row:1/3!important;min-width:0;min-height:40px;padding:4px 8px;border:0;background:transparent;color:#fff;font:22px ForcedSquare,Arial,sans-serif;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}.competition-track-name:hover,.competition-track-name:focus-visible{background:rgba(126,231,255,.13);color:#9feaff;outline:2px solid #7ee7ff;outline-offset:-2px}.competition-result{grid-column:3!important;grid-row:1!important;font-size:14px!important;white-space:nowrap}.overall-center-tools{display:grid!important;grid-template-rows:auto auto!important;align-content:center!important;gap:7px!important;min-width:0;padding:8px 10px;background:#172653!important}.overall-pager{display:grid!important;grid-template-columns:54px minmax(0,1fr) 54px!important;align-items:center!important;justify-content:center!important;gap:8px!important;width:100%!important;min-height:48px!important;padding:0!important;background:transparent!important;border:0!important}.overall-page-button{display:flex;align-items:center;justify-content:center;width:54px;min-width:54px;height:46px;border:1px solid rgba(126,231,255,.35);border-radius:2px;background:#2e4a8b;color:#fff;font:30px ForcedSquare,Arial,sans-serif;line-height:1;cursor:pointer}.overall-page-button:hover:not(:disabled),.overall-page-button:focus-visible{background:#7ee7ff;color:#10214b;outline:2px solid #fff;outline-offset:2px}.overall-page-button:disabled{background:#111d41;color:#536a94;cursor:default}.overall-page-status{display:flex!important;align-items:center;justify-content:center;min-width:0!important;min-height:46px!important;padding:6px 12px!important;background:#101d43!important;color:#f2f7ff!important;font-size:17px!important;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.overall-center-tools .overall-freshness{display:flex;align-items:center;justify-content:center;width:100%!important;max-width:none!important;min-height:38px!important;padding:7px 10px!important;border:1px solid rgba(126,231,255,.25)!important;border-left:4px solid #7ee7ff!important;border-radius:2px;background:#111e44!important;font-size:14px!important;line-height:1.2;text-align:center!important;cursor:pointer}.overall-center-tools .overall-freshness:hover,.overall-center-tools .overall-freshness:focus-visible{filter:brightness(1.18);outline:2px solid #7ee7ff;outline-offset:2px}.overall-footer-right{display:grid!important;grid-template-rows:auto auto auto!important;grid-template-columns:1fr!important;align-content:center!important;gap:7px!important;min-width:0;padding:8px 10px!important;background:#172653!important;border:0!important}.overall-track-scope{min-height:38px;justify-content:center!important}.overall-track-scope button{min-height:38px;min-width:82px}.leaderboard-arcade{justify-content:center!important}.leaderboard-arcade button{min-height:32px}.overall-entry.after-podium{position:relative;margin-top:9px}.overall-entry.after-podium::before{content:'';position:absolute;left:1.5%;right:1.5%;top:-6px;height:2px;background:linear-gradient(90deg,transparent,rgba(126,231,255,.48),transparent)}.overall-entry.has-missing-value .overall-stats{opacity:.58}.overall-entry.has-missing-value .overall-score{color:#9aaac2!important}.overall-profile-card{box-sizing:border-box!important;overflow-x:hidden!important}#overallProfileClose{z-index:8}.profile-hero{grid-template-columns:300px minmax(0,1fr)!important;align-items:start!important}.profile-car-column{display:flex;flex-direction:column;gap:10px;min-width:0}.profile-car-column>.overall-car-model{width:300px!important;height:184px!important;margin:0!important;background:#172653}.profile-car-column .profile-achievement-row{align-items:stretch!important;flex-direction:column!important;margin:0!important;font-size:16px!important}.profile-car-column .profile-achievement-row>span:last-child{text-align:center}.profile-car-column .profile-medals{display:grid!important;grid-template-columns:repeat(3,1fr)!important;width:100%}.profile-car-column .profile-medals>span{justify-content:center!important;min-height:40px}.profile-stat-primary{display:grid!important;grid-template-columns:repeat(4,minmax(125px,1fr))!important;gap:8px!important}.profile-stat-primary span,.profile-stat-secondary span{min-height:72px!important;padding:10px 12px!important;font-size:15px!important}.profile-stat-primary b,.profile-stat-secondary b{font-size:27px!important}.profile-more-stats{margin-top:9px;background:#152653;border-left:4px solid #5374b6}.profile-more-stats>summary{display:flex;align-items:center;justify-content:space-between;min-height:44px;padding:7px 13px;color:#dbeaff;font-size:16px;cursor:pointer;list-style:none}.profile-more-stats>summary::after{content:'+';color:#7ee7ff;font-size:24px}.profile-more-stats[open]>summary::after{content:'−'}.profile-more-stats>summary:hover{background:#203873}.profile-stat-secondary{display:grid!important;grid-template-columns:repeat(3,minmax(135px,1fr))!important;gap:8px!important;padding:0 9px 9px}.profile-results{grid-template-columns:repeat(3,minmax(0,1fr))!important;gap:9px!important}.profile-result{min-height:106px!important}.profile-result.no-track{display:flex!important;grid-template-columns:1fr!important;align-items:center!important}.profile-result.no-track>div{display:flex;flex-direction:column;gap:5px}.profile-result.no-track span{color:#dbe8fa!important}.profile-guide-body{padding:17px!important}.profile-guide-body h4{font-size:30px!important}.profile-guide-body h5{font-size:23px!important}.profile-guide-body section>p{font-size:15px!important}.profile-guide-grid,.profile-guide-grid.compact{grid-template-columns:repeat(3,minmax(0,1fr))!important;gap:9px!important}.profile-guide-track{grid-template-columns:82px minmax(0,1fr) 82px!important;min-height:100px!important;padding:9px!important}.profile-guide-image .profile-track-image-frame{width:78px!important;height:76px!important}.profile-guide-copy b{font-size:16px!important}.profile-guide-copy small{font-size:13px!important;line-height:1.25}.guide-placement{color:#d9e9ff!important}.guide-weight{display:inline-flex;padding:2px 5px;border:1px solid rgba(126,231,255,.42);background:#132550;color:#8ff1ff}.profile-helpfulness>b{font-size:22px!important}.profile-helpfulness small{font-size:10px!important}.profile-helpfulness i{width:64px!important;height:6px!important;border-radius:3px;overflow:hidden}.profile-goal-ladder li{font-size:16px;line-height:1.4}.profile-goal-ladder .profile-inline-track{color:#9feaff!important;font-weight:700!important}@media(max-width:1100px){.overall-center-tools{grid-column:2}.overall-footer-right{grid-column:1/-1;grid-template-columns:minmax(260px,1fr) auto!important;grid-template-rows:auto auto!important}.overall-footer-right .overall-track-scope{grid-column:2;grid-row:1}.overall-footer-right .leaderboard-arcade{grid-column:1/-1;grid-row:2}.profile-hero{grid-template-columns:250px minmax(0,1fr)!important}.profile-car-column>.overall-car-model{width:250px!important}.profile-stat-primary{grid-template-columns:repeat(2,minmax(125px,1fr))!important}.profile-guide-grid,.profile-guide-grid.compact{grid-template-columns:repeat(2,minmax(0,1fr))!important}}.overall-center-tools,.overall-footer-right,.overall-pager{box-sizing:border-box!important}.competition-track-name,.overall-center-tools .overall-freshness,.overall-track-scope button,.leaderboard-arcade button{min-height:44px!important}.profile-guide-grid:has(>.profile-guide-track:only-child){grid-template-columns:minmax(0,620px)!important}.profile-guide-copy b{font-size:18px!important}.profile-guide-copy small{font-size:15px!important}.profile-guide-body section>p{font-size:16px!important;line-height:1.35}.profile-helpfulness small{font-size:11px!important}@media(max-width:700px){.overall-shell{width:100%!important;max-width:100%!important}.overall-center-tools,.overall-footer-right{grid-column:1!important}.overall-footer-right{grid-template-columns:1fr!important}.overall-footer-right .overall-track-scope,.overall-footer-right .leaderboard-arcade{grid-column:1!important;grid-row:auto!important}.competition-result{grid-column:1/3!important;grid-row:3!important}.overall-page-status{font-size:14px!important}.overall-profile-card{width:calc(100% - 4px)!important;padding:14px!important}#overallProfileClose{right:7px!important;top:7px!important;min-width:74px!important}.profile-hero{grid-template-columns:1fr!important;padding-right:0!important}.profile-car-column{padding-top:34px}.profile-car-column>.overall-car-model{width:100%!important;height:160px!important}.profile-stat-primary,.profile-stat-secondary{grid-template-columns:1fr 1fr!important}.profile-results{grid-template-columns:1fr!important}.profile-guide-grid,.profile-guide-grid.compact,.profile-guide-grid:has(>.profile-guide-track:only-child){grid-template-columns:1fr!important}.profile-guide-track{grid-template-columns:72px minmax(0,1fr) 72px!important}.leaderboard-arcade{display:none!important}}/* Ranked v6 presentation: stable weights,true average finish,and one clear route list. */\n      .overall-competition section{grid-template-columns:minmax(0,1fr) auto!important;grid-template-rows:auto auto!important;column-gap:12px!important}.competition-track-main{grid-column:1;grid-row:1;display:flex;align-items:center;gap:12px;min-width:0}.competition-kicker{flex:0 0 auto!important;grid-column:auto!important;grid-row:auto!important}.competition-track-name{grid-column:auto!important;grid-row:auto!important;flex:1 1 auto;min-width:0!important;min-height:44px!important;padding:3px 8px!important;font-size:21px!important}.competition-result{grid-column:2!important;grid-row:1!important;align-self:center;padding:5px 8px;background:rgba(9,18,46,.42);color:#eff8ff;font-size:14px!important}.profile-car-column .profile-achievement-row{display:grid!important;grid-template-columns:1fr!important;gap:8px!important;padding:11px!important;overflow:visible!important}.profile-achievement-label{color:#8feeff;font-size:12px;letter-spacing:1px}.profile-achievement-medals{min-width:0;overflow:visible}.profile-achievement-medals .profile-medals{display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr))!important;gap:6px!important;width:100%!important;margin:0!important}.profile-achievement-medals .profile-medals>span{display:flex!important;min-width:0!important;min-height:52px!important;padding:7px 5px!important;gap:5px!important;justify-content:center!important;white-space:nowrap;font-size:14px!important;box-sizing:border-box!important}.profile-achievement-medals .profile-medals img{flex:0 0 auto;width:23px!important;height:23px!important}.profile-achievement-medals .profile-no-medals{margin:0!important;padding:12px;background:#11214b;text-align:center}.profile-ranked-count{display:flex;align-items:center;justify-content:center;min-height:38px;padding:6px 9px;background:#10214b;color:#dceaff;font-size:17px!important;text-align:center}.profile-stat-primary{grid-template-columns:repeat(3,minmax(150px,1fr))!important}.profile-stat-primary span{min-height:88px!important;border-bottom:3px solid #5374b6}.profile-stat-primary span:nth-child(1),.profile-stat-primary span:nth-child(2),.profile-stat-primary span:nth-child(3){border-bottom-color:#7ee7ff}.profile-stat-primary b{font-size:31px!important}.profile-stat-secondary{grid-template-columns:repeat(4,minmax(135px,1fr))!important;padding:4px 10px 11px!important}.profile-stat-secondary span{min-height:78px!important}.profile-more-stats[open]>summary{background:#203873;color:#fff}.profile-results{margin-top:12px!important}.profile-result{border-left:4px solid #5374b6!important}.profile-result:hover,.profile-result:focus-visible{border-left-color:#7ee7ff!important;outline:2px solid #7ee7ff;outline-offset:-2px}.profile-guide-body section{padding:15px!important}.profile-guide-grid{align-items:stretch}.profile-guide-track{min-height:116px!important;border-left:4px solid #5374b6!important}.profile-guide-track.kind-start{border-left-color:#7ee7ff!important}.profile-guide-track.kind-improve,.profile-guide-track.kind-chase{border-left-color:#79f0ad!important}.profile-guide-track.kind-defend,.profile-guide-track.kind-carry{border-left-color:#ffd574!important}.profile-guide-copy b{font-size:19px!important}.profile-guide-copy small{font-size:15px!important}.profile-helpfulness>b{font-size:25px!important}.profile-helpfulness small{font-size:10px!important;letter-spacing:.6px}.profile-helpfulness i{height:8px!important}.profile-route-strengths{background:#252f5a!important}.profile-goal-ladder li{border-left:4px solid #7ee7ff;min-height:58px}.profile-track-weight small{display:block;line-height:1.15}@media(max-width:1100px){.competition-track-main{align-items:flex-start;flex-direction:column;gap:2px}.profile-stat-primary{grid-template-columns:repeat(3,minmax(125px,1fr))!important}.profile-stat-secondary{grid-template-columns:repeat(3,minmax(125px,1fr))!important}}@media(max-width:700px){.competition-track-main{grid-column:1/3;grid-row:1;align-items:center;flex-direction:row}.competition-track-name{font-size:19px!important}.competition-result{grid-column:1/3!important;grid-row:2!important;justify-self:stretch;text-align:center}.profile-stat-primary,.profile-stat-secondary{grid-template-columns:1fr 1fr!important}.profile-stat-primary span{min-height:78px!important}.profile-stat-primary b{font-size:24px!important}.profile-achievement-medals .profile-medals>span{font-size:12px!important}.profile-guide-copy b{font-size:17px!important}.profile-guide-copy small{font-size:14px!important}}.sq-track-leaderboard-loading .leaderboard-ui>.container>button.main{visibility:hidden!important}.sq-track-leaderboard-loading .leaderboard-ui>.container::after{content:'Loading track leaderboard';display:block;margin:18px auto;padding:12px 18px;width:max-content;max-width:80%;background:#172653;border-left:4px solid #7ee7ff;color:#eaf7ff;font:18px ForcedSquare,Arial,sans-serif}.polytrack-track-freshness.is-loading{border-left-color:#7ee7ff}.profile-result.is-null{opacity:.72;border-left-color:#71809c!important}.profile-achievement-medals{display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr))!important;gap:6px!important}.profile-achievement-medals .profile-medal-card{display:grid!important;grid-template-columns:30px 1fr!important;grid-template-rows:auto auto!important;align-items:center!important;column-gap:6px!important;min-width:0!important;min-height:58px!important;padding:7px!important;background:#10214b}.profile-medal-card img{grid-row:1/3;width:27px!important;height:27px!important}.profile-medal-card b{font-size:19px}.profile-medal-card small{font-size:10px;letter-spacing:.6px}.profile-medal-card.gold b{color:#ffe381}.profile-medal-card.silver b{color:#f4f7ff}.profile-medal-card.bronze b{color:#ffb786}.track-type-label{display:inline-flex!important;align-items:center;padding:2px 6px;border-left:3px solid #7ee7ff;background:#142654;color:#dceaff;text-transform:capitalize}.track-type-label.official,.track-type-official{--track-type-color:#ffd26c}.track-type-label.community,.track-type-community{--track-type-color:#72e7b4}.track-type-label.custom,.track-type-custom{--track-type-color:#d0a5ff}.track-type-label.official,.track-type-label.community,.track-type-label.custom{border-left-color:var(--track-type-color)}.profile-track-row[class*='track-type-']{border-left:3px solid var(--track-type-color,#7ee7ff)}.profile-track-row time{display:flex;flex-direction:column;gap:4px}.profile-track-row time small{color:#9fb7d8;font-size:10px;line-height:1.15}.overall-center-tools{align-content:center}.leaderboard-arcade>div{flex:1}.leaderboard-arcade button{flex:1;justify-content:center}.profile-beta-badge{padding:5px 8px;background:#ffd26c;color:#17224a;font-size:12px;letter-spacing:1px}.profile-beta-badge.compact{padding:2px 5px;font-size:9px;line-height:1;border-radius:3px;white-space:nowrap}.overall-track-you{display:inline-flex;padding:2px 6px;background:#7ee7ff;color:#10214b;font-size:.86em;letter-spacing:.6px;box-shadow:0 0 10px rgba(126,231,255,.28)}.overall-track-entry .overall-best-line:nth-child(2){color:#dcecff}.profile-track-row{grid-template-columns:96px minmax(180px,1fr) 110px 150px 124px!important;min-height:82px!important;padding:7px 11px!important;border-left:0!important;box-shadow:inset 3px 0 0 var(--track-type-color,#7ee7ff)}.profile-track-row .profile-track-image-frame{width:92px!important;height:66px!important;background:#101f48}.profile-track-row .profile-track-thumb{width:92px!important;height:66px!important;object-fit:contain!important;image-rendering:auto}.profile-track-row .track-type-label{display:inline-flex!important;width:max-content;padding:0!important;border:0!important;background:transparent!important;color:var(--track-type-color,#9fb7d8)!important;font-size:12px!important;letter-spacing:.5px}.profile-track-row .profile-track-name b{font-size:19px!important}.profile-track-row time{font-size:16px!important}.profile-track-row time small{font-size:12px!important;color:#bdd2ee!important}.profile-track-head{grid-template-columns:minmax(0,1fr) 110px 150px 124px!important;padding-left:116px!important}.sq-multiplayer-relay{position:absolute;left:50%;bottom:16px;z-index:8;width:min(1020px,calc(100vw - 28px));box-sizing:border-box;padding:16px 18px;transform:translateX(-50%);background:linear-gradient(115deg,#101f47,#1b3268 72%,#17365f);color:#eaf5ff;font-family:ForcedSquare,Arial,sans-serif;border:1px solid rgba(126,231,255,.26);border-left:6px solid #7ee7ff;clip-path:polygon(12px 0,100% 0,calc(100% - 12px) 100%,0 100%);box-shadow:0 16px 42px rgba(0,0,0,.46)}.sq-multiplayer-relay[hidden],.sq-multiplayer-route-body[hidden],.sq-multiplayer-backup-drawer[hidden]{display:none!important}.sq-multiplayer-relay.is-collapsed{width:min(720px,calc(100vw - 28px));padding:10px 13px}.sq-multiplayer-relay-head{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:12px}.sq-multiplayer-relay-head>div{display:flex;flex-direction:column;gap:2px;min-width:0}.sq-multiplayer-kicker{color:#7ee7ff;font-size:11px;letter-spacing:1.4px}.sq-multiplayer-relay-head strong{font-size:24px;font-weight:normal;color:#fff;line-height:1.05}.sq-multiplayer-status{padding:7px 10px;background:#243b78;border-left:4px solid #7ee7ff;color:#d7efff;font-size:14px;white-space:nowrap}.sq-multiplayer-status.is-backup{border-color:#ffd56e;color:#ffe7a8}.sq-multiplayer-status.is-direct{border-color:#98a9c8;color:#ced8e9}.sq-multiplayer-collapse{min-height:38px;padding:7px 12px;border:1px solid rgba(126,231,255,.32);background:#20396f;color:#fff;font:14px ForcedSquare,Arial,sans-serif;cursor:pointer}.sq-multiplayer-collapse:hover,.sq-multiplayer-collapse:focus-visible{background:#7ee7ff;color:#10214b;outline:2px solid #fff;outline-offset:2px}.sq-multiplayer-intro{margin:10px 0 8px;color:#c3d7ee;font-size:15px}.sq-multiplayer-paths{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.sq-multiplayer-path{display:grid;grid-template-columns:34px minmax(0,1fr);grid-template-rows:auto auto;align-items:start;gap:2px 9px;min-width:0;min-height:100px;box-sizing:border-box;padding:11px 12px;background:#1b3168;border:0;border-top:4px solid #536fae;color:inherit;text-align:left;font-family:inherit}.sq-multiplayer-path.is-automatic:first-child{border-color:#77e6b0}.sq-multiplayer-path.is-automatic:nth-child(2){border-color:#7ee7ff}.sq-multiplayer-backup-toggle{border-color:#ffd56e;cursor:pointer}.sq-multiplayer-backup-toggle:hover,.sq-multiplayer-backup-toggle:focus-visible,.sq-multiplayer-backup-toggle.is-open{background:#2c4175;outline:2px solid #ffd56e;outline-offset:-2px}.sq-route-number{grid-column:1;grid-row:1/3;display:flex!important;align-items:center;justify-content:center;width:32px;height:32px;background:#0e1d43!important;color:#fff!important;font-size:20px!important}.sq-multiplayer-path>div{grid-column:2;grid-row:1}.sq-multiplayer-path b{display:block;margin-bottom:4px;font-size:18px;font-weight:normal;color:#fff}.sq-multiplayer-path div>span{display:block;color:#c2d3e9;font-size:13px;line-height:1.3}.sq-multiplayer-path em{grid-column:2;grid-row:2;align-self:end;width:max-content;margin-top:7px;padding:3px 6px;background:#10224c;color:#8ff1ff;font-size:10px;font-style:normal;letter-spacing:1px}.sq-multiplayer-backup-toggle em{color:#ffe49a}.sq-multiplayer-backup-drawer{display:grid;grid-template-columns:minmax(220px,.75fr) minmax(0,1.25fr);align-items:center;gap:14px;margin-top:9px;padding:11px 12px;background:#222f58;border-left:4px solid #ffd56e}.sq-multiplayer-backup-drawer>div:first-child{display:flex;flex-direction:column;gap:3px}.sq-multiplayer-backup-drawer b{font-size:17px;font-weight:normal;color:#fff}.sq-multiplayer-backup-drawer span{color:#b9cbe5;font-size:12px;line-height:1.25}.sq-multiplayer-code{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:7px}.sq-multiplayer-code input{min-width:0;padding:9px 10px;background:#0f1d43;border:2px solid #385594;color:#fff;font:16px ForcedSquare,Arial,sans-serif}.sq-multiplayer-code input:focus{outline:2px solid #7ee7ff;outline-offset:1px}.sq-multiplayer-code .button{display:flex!important;align-items:center;justify-content:center;min-width:86px;height:42px;font-size:15px}.sq-multiplayer-discord{padding:0 12px;color:#fff!important;text-decoration:none;background:#354d8d}.sq-multiplayer-note{margin:8px 2px 0;color:#9fb5d2;font-size:12px;line-height:1.25}@media(max-width:760px){.sq-multiplayer-relay,.sq-multiplayer-relay.is-collapsed{bottom:6px;width:calc(100vw - 10px);max-height:calc(100vh - 12px);overflow:auto;padding:11px 10px;border-left-width:4px;clip-path:none}.sq-multiplayer-relay-head{grid-template-columns:minmax(0,1fr) auto;gap:7px}.sq-multiplayer-relay-head strong{font-size:19px}.sq-multiplayer-kicker{font-size:9px}.sq-multiplayer-status{grid-column:1;padding:5px 7px;width:max-content;font-size:11px}.sq-multiplayer-collapse{grid-column:2;grid-row:1/3;min-height:42px;padding:6px 9px;font-size:12px}.sq-multiplayer-intro{margin:8px 0 6px;font-size:13px}.sq-multiplayer-paths{grid-template-columns:1fr;gap:5px}.sq-multiplayer-path{grid-template-columns:30px minmax(0,1fr) auto;grid-template-rows:auto;min-height:0;padding:8px 9px;border-top-width:3px}.sq-route-number{grid-column:1;grid-row:1;width:28px;height:28px;font-size:17px!important}.sq-multiplayer-path>div{grid-column:2;grid-row:1}.sq-multiplayer-path b{font-size:16px}.sq-multiplayer-path div>span{font-size:12px}.sq-multiplayer-path em{grid-column:3;grid-row:1;align-self:start;margin:0;font-size:8px}.sq-multiplayer-backup-drawer{grid-template-columns:1fr;gap:8px;padding:9px}.sq-multiplayer-code{grid-template-columns:minmax(0,1fr) auto}.sq-multiplayer-discord{grid-column:1/-1;min-height:38px}.sq-multiplayer-note{font-size:10px}}.sq-multiplayer-relay{position:fixed!important;top:auto!important;bottom:max(10px,env(safe-area-inset-bottom))!important;z-index:10000!important;max-height:calc(100dvh - 20px);overflow:auto;pointer-events:auto}.sq-multiplayer-intro b{color:#fff;font-weight:normal}.sq-multiplayer-code{grid-template-columns:minmax(180px,1fr) auto auto auto}.sq-multiplayer-reveal{min-width:68px!important;background:#263f77!important}.sq-multiplayer-backup-toggle .sq-backup-state{color:#ffd978}.sq-multiplayer-relay.has-backup-code .sq-multiplayer-backup-toggle{border-top-color:#79efad;background:#203c70}.sq-multiplayer-relay.has-backup-code .sq-backup-state{color:#79efad}.sq-backup-copy{display:flex;flex-direction:column;gap:3px}.sq-backup-copy .sq-multiplayer-kicker{color:#ffd978}.sq-backup-copy b{font-size:17px}.sq-multiplayer-backup-drawer>.sq-backup-validation{grid-column:2;margin:0;color:#9fdaf0;font-size:12px;line-height:1.25}.sq-multiplayer-code input::placeholder{color:#8399bb}.sq-multiplayer-code input:focus-visible,.sq-multiplayer-code .button:focus-visible{outline:2px solid #fff!important;outline-offset:2px!important}@media(max-width:760px){.sq-multiplayer-relay,.sq-multiplayer-relay.is-collapsed{position:fixed!important;bottom:max(5px,env(safe-area-inset-bottom))!important;max-height:calc(100dvh - 10px)!important}.sq-multiplayer-code{grid-template-columns:minmax(0,1fr) auto auto!important}.sq-multiplayer-discord{grid-column:1/-1!important}.sq-multiplayer-backup-drawer>.sq-backup-validation{grid-column:1}.sq-multiplayer-path div>span{line-height:1.25}.sq-multiplayer-note{padding-bottom:2px}}@media(max-width:430px){.sq-multiplayer-code{grid-template-columns:minmax(0,1fr) auto!important}.sq-multiplayer-save{grid-column:1/2}.sq-multiplayer-discord{grid-column:2!important}.sq-multiplayer-relay-head strong{font-size:18px}.sq-multiplayer-intro{font-size:12px}.sq-multiplayer-path b{font-size:15px}.sq-multiplayer-path div>span{font-size:11px}}@media(max-width:700px){#overallLeaderboardPanel{padding:0!important}.overall-shell{width:100vw!important;height:100dvh!important;clip-path:none!important}.overall-top{display:grid!important;grid-template-columns:minmax(0,1fr) auto!important;gap:8px!important;padding:11px 10px 8px!important}.overall-top h2{font-size:32px!important}.overall-title-group{min-width:0}.overall-actions{display:grid!important;grid-template-columns:repeat(2,minmax(68px,1fr));gap:5px!important}.overall-action-btn{min-width:0!important;min-height:40px!important;padding:6px 8px!important;font-size:13px!important}.overall-sub{padding:7px 10px!important;font-size:12px!important;line-height:1.25}.overall-summary{padding:5px 8px!important;font-size:11px!important}#overallLeaderboardList{min-height:180px;padding:5px!important;overscroll-behavior:contain}.overall-entry{min-height:100px!important}.overall-footer-right{order:1!important;display:grid!important;grid-template-columns:1fr!important;gap:6px!important;padding:8px!important}.overall-track-scope{grid-column:1!important;grid-row:auto!important;display:grid!important;grid-template-columns:repeat(3,1fr);width:100%}.overall-track-scope button{min-width:0!important}.competition-track-main{align-items:flex-start!important;flex-direction:column!important;gap:1px!important}.competition-track-name{width:100%;font-size:17px!important}.competition-result{font-size:12px!important}.overall-center-tools{order:3!important;display:grid!important;gap:6px!important;padding:8px!important}.overall-pager{grid-template-columns:48px minmax(0,1fr) 48px!important;gap:6px!important}.overall-page-button{width:48px!important;min-width:48px!important;height:44px!important}.overall-page-status{min-height:44px!important;font-size:14px!important}.overall-center-tools .overall-freshness{min-height:42px!important;font-size:12px!important}.overall-profile-card{max-height:100dvh!important}.profile-track-history{padding:8px!important}.profile-track-row{grid-template-columns:64px minmax(0,1fr) 96px!important;min-height:72px!important;padding:6px!important}.profile-track-row .profile-track-image-frame,.profile-track-row .profile-track-thumb{width:60px!important;height:48px!important}.profile-track-row .profile-track-name b{font-size:16px!important}.profile-track-row time{font-size:13px!important}}@media(max-width:460px){.overall-top{grid-template-columns:1fr!important}.overall-actions{grid-template-columns:repeat(4,1fr)!important}.overall-action-btn{font-size:11px!important}.overall-entry{grid-template-columns:48px minmax(0,1fr) 82px!important}.overall-rank{width:48px!important;font-size:25px!important}.overall-car-model,.overall-entry.top-1 .overall-car-model{width:50px!important;height:48px!important}.overall-name-main{font-size:17px!important}.overall-score{font-size:23px!important}.overall-stats{min-width:78px!important}.sq-multiplayer-path div>span{font-size:11px}.sq-multiplayer-path em{display:none}.sq-multiplayer-path{grid-template-columns:28px minmax(0,1fr)}}@media(max-width:1000px){.profile-track-row{grid-template-columns:82px minmax(150px,1fr) 100px 130px!important}.profile-track-row .profile-track-image-frame,.profile-track-row .profile-track-thumb{width:78px!important;height:58px!important}}@media(max-width:900px){.overall-columns{display:none!important}}@media(max-width:620px){.profile-track-row{grid-template-columns:68px minmax(120px,1fr) 112px!important}.profile-track-row .profile-track-image-frame,.profile-track-row .profile-track-thumb{width:64px!important;height:52px!important}.profile-track-row .profile-track-name b{font-size:17px!important}.menu-ui>.button-bar{min-height:160px!important;align-items:center!important;padding-bottom:14px!important}.menu-ui>.button-bar>.button{min-height:136px!important;padding:24px 26px!important;font-size:32px!important}}.sq-settings-grid .sq-setting-wide{grid-column:1/-1!important}.sq-setting-secret.is-verified{background:rgba(25,78,73,.62)!important;box-shadow:inset 5px 0 #79efad}.sq-setting-secret.is-verified .sq-backup-validation{color:#9ff4bf!important}.sq-setting-secret.is-verified .button{background:#276b60!important;color:#fff!important}.overall-best-line b,.profile-guide b,.profile-result b,.profile-customizer b{font-weight:700!important}.overall-entry.cosmetic-theme-cyan:not(.top-1):not(.top-2):not(.top-3){background:linear-gradient(90deg,#164b68,#263f76)!important}.overall-entry.cosmetic-theme-sunset:not(.top-1):not(.top-2):not(.top-3){background:linear-gradient(90deg,#71473d,#3c3d6d)!important}.overall-entry.cosmetic-theme-forest:not(.top-1):not(.top-2):not(.top-3){background:linear-gradient(90deg,#285448,#2c3e68)!important}.overall-entry.cosmetic-theme-podium:not(.top-1):not(.top-2):not(.top-3){background:linear-gradient(90deg,#715d25,#3c416d)!important}.overall-entry.cosmetic-theme-beta:not(.top-1):not(.top-2):not(.top-3){background:linear-gradient(90deg,#5c3972,#245578)!important}.overall-profile-card.cosmetic-theme-cyan{background:linear-gradient(145deg,#244f78,#24366e)!important}.overall-profile-card.cosmetic-theme-sunset{background:linear-gradient(145deg,#70483f,#303b75)!important}.overall-profile-card.cosmetic-theme-forest{background:linear-gradient(145deg,#285348,#29396d)!important}.overall-profile-card.cosmetic-theme-podium{background:linear-gradient(145deg,#6e5b29,#343b70)!important}.overall-profile-card.cosmetic-theme-beta{background:linear-gradient(145deg,#5d3b76,#285373)!important}.sq-plain-racer-themes .overall-entry[class*='cosmetic-']{border-right-color:transparent!important}.sq-plain-racer-themes .overall-entry[class*='cosmetic-theme-']:not(.top-1):not(.top-2):not(.top-3){background:#2d3b68!important}.sq-plain-racer-themes .overall-profile-card[class*='cosmetic-theme-']{background:#2d437e!important}.sq-plain-racer-themes .overall-profile-card[class*='cosmetic-stage-'] .profile-car-column>.overall-car-model{background:#172653!important}.profile-customizer{margin-top:12px;background:#142653;border-left:5px solid #7ee7ff}.profile-customizer>summary{display:flex;align-items:center;justify-content:space-between;min-height:46px;padding:8px 14px;color:#fff;font-size:18px;cursor:pointer;list-style:none}.profile-customizer>summary::after{content:'+';color:#7ee7ff;font-size:25px}.profile-customizer[open]>summary::after{content:'−'}.profile-customizer-body{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;padding:12px;background:#10204a}.profile-customizer-body>p,.profile-customizer-actions{grid-column:1/-1}.profile-customizer-body>p{margin:0;color:#b9cde8;font-size:14px}.profile-cosmetic-group{min-width:0;margin:0;padding:9px;border:1px solid rgba(126,231,255,.2)}.profile-cosmetic-group legend{padding:0 6px;color:#8feeff;font-size:11px;letter-spacing:1px}.profile-cosmetic-group>div{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}.profile-cosmetic-choice{display:grid;grid-template-columns:20px minmax(0,1fr);grid-template-rows:auto auto;align-items:center;min-height:48px;padding:6px;border:1px solid transparent;background:#1f376f;color:#fff;text-align:left;font:inherit;cursor:pointer}.profile-cosmetic-choice i{grid-row:1/3;width:16px;height:30px;background:#7ee7ff}.profile-cosmetic-choice b{font-size:13px}.profile-cosmetic-choice small{color:#9eb4d2;font-size:9px}.profile-cosmetic-choice.selected{border-color:#fff;background:#31528f}.profile-cosmetic-choice:disabled{opacity:.42;cursor:not-allowed}.profile-cosmetic-choice.cosmetic-theme-sunset i{background:#ff9a65}.profile-cosmetic-choice.cosmetic-theme-forest i{background:#6fd4a3}.profile-cosmetic-choice.cosmetic-theme-podium i,.profile-cosmetic-choice.cosmetic-stage-podium i{background:#ffd56e}.profile-cosmetic-choice.cosmetic-theme-beta i{background:#ff82d9}.profile-cosmetic-choice.cosmetic-stage-night i{background:#182652}.profile-customizer-actions{display:flex;align-items:center;justify-content:flex-end;gap:12px}.profile-customizer-actions span{margin-right:auto;color:#9ff4bf}.profile-customizer-actions .button{min-width:130px}.profile-beta-badge{font-weight:700!important}.overall-entry.cosmetic-theme-classic{--cosmetic-a:#2d3b68;--cosmetic-b:#1a2958;--cosmetic-glow:#7ee7ff}.overall-entry.cosmetic-theme-cyan{--cosmetic-a:#086782;--cosmetic-b:#263d78;--cosmetic-glow:#7ef5ff}.overall-entry.cosmetic-theme-ocean{--cosmetic-a:#075b79;--cosmetic-b:#0b315f;--cosmetic-glow:#5fe8d0}.overall-entry.cosmetic-theme-sunset{--cosmetic-a:#a34f32;--cosmetic-b:#44366f;--cosmetic-glow:#ffbd73}.overall-entry.cosmetic-theme-forest{--cosmetic-a:#176549;--cosmetic-b:#203963;--cosmetic-glow:#79efad}.overall-entry.cosmetic-theme-ember{--cosmetic-a:#9b2f25;--cosmetic-b:#512951;--cosmetic-glow:#ff9d5d}.overall-entry.cosmetic-theme-podium{--cosmetic-a:#9a761b;--cosmetic-b:#3d396a;--cosmetic-glow:#ffe27a}.overall-entry.cosmetic-theme-beta{--cosmetic-a:#92377f;--cosmetic-b:#175f86;--cosmetic-glow:#ff82d9}.overall-entry[class*='cosmetic-theme-']:not(.top-1):not(.top-2):not(.top-3),.overall-entry.cosmetic-podium-override[class*='cosmetic-theme-']{background:linear-gradient(104deg,var(--cosmetic-a),var(--cosmetic-b) 72%)!important;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--cosmetic-glow) 42%,transparent),inset 0 0 30px rgba(0,0,0,.18)!important}.overall-profile-card[class*='cosmetic-theme-']{--profile-a:#2d437e;--profile-b:#172953;--profile-accent:#7ee7ff;background:linear-gradient(145deg,var(--profile-a),var(--profile-b))!important;border:1px solid color-mix(in srgb,var(--profile-accent) 45%,transparent)}.overall-profile-card.cosmetic-theme-cyan{--profile-a:#116b87;--profile-b:#283778;--profile-accent:#7ef5ff}.overall-profile-card.cosmetic-theme-ocean{--profile-a:#08627c;--profile-b:#102c58;--profile-accent:#5fe8d0}.overall-profile-card.cosmetic-theme-sunset{--profile-a:#9a4d39;--profile-b:#39346e;--profile-accent:#ffbd73}.overall-profile-card.cosmetic-theme-forest{--profile-a:#22654c;--profile-b:#25345f;--profile-accent:#79efad}.overall-profile-card.cosmetic-theme-ember{--profile-a:#8f352c;--profile-b:#43294f;--profile-accent:#ff9d5d}.overall-profile-card.cosmetic-theme-podium{--profile-a:#806724;--profile-b:#303765;--profile-accent:#ffe27a}.overall-profile-card.cosmetic-theme-beta{--profile-a:#7d3d82;--profile-b:#1e5278;--profile-accent:#ff82d9}.overall-profile-card[class*='cosmetic-theme-'] .profile-hero,.overall-profile-card[class*='cosmetic-theme-'] .profile-customizer{border-color:var(--profile-accent)}.overall-profile-card[class*='cosmetic-theme-'] .profile-kicker{color:var(--profile-accent)}.profile-customizer{margin-top:16px;border-left-width:7px;box-shadow:0 8px 24px rgba(4,10,29,.25)}.profile-customizer>summary{min-height:58px;padding:10px 16px;background:linear-gradient(100deg,rgba(126,231,255,.16),transparent);gap:14px}.profile-customizer>summary>span{display:flex;flex-direction:column;gap:3px}.profile-customizer>summary b{font-size:18px;letter-spacing:.8px}.profile-customizer>summary small{color:#b9cde8;font-size:12px}.profile-customizer>summary>em{margin-left:auto;padding:7px 10px;background:#7ee7ff;color:#10214b;font-size:12px;font-style:normal}.profile-customizer>summary::after{margin-left:0}.profile-customizer-intro{grid-column:1/-1;display:flex;align-items:center;gap:12px;padding:11px 13px;background:#1b3570;border-left:4px solid #7ee7ff}.profile-customizer-intro b{font-size:18px;color:#fff}.profile-customizer-intro span{color:#c6daf2;font-size:13px}.profile-cosmetic-group{padding:12px;background:rgba(9,21,53,.35);border:1px solid rgba(126,231,255,.28)}.profile-cosmetic-group>p{min-height:30px;margin:0 0 9px;color:#b9cde8;font-size:12px;line-height:1.25}.profile-cosmetic-group legend{font-size:12px;font-weight:700}.profile-cosmetic-group>div{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.profile-cosmetic-choice{grid-template-columns:74px minmax(0,1fr);min-height:62px;padding:7px;background:#1b3268}.profile-cosmetic-preview{grid-row:1/3;position:relative;width:66px;height:42px;overflow:hidden;background:linear-gradient(105deg,#2f467e,#182958);clip-path:polygon(5px 0,100% 0,calc(100% - 5px) 100%,0 100%)}.profile-cosmetic-preview i{position:absolute;inset:0;width:auto;height:auto;background:linear-gradient(105deg,transparent 20%,#7ee7ff 21% 25%,transparent 26% 55%,rgba(126,231,255,.35) 56% 66%,transparent 67%)}.profile-cosmetic-choice b{font-size:14px}.profile-cosmetic-choice small{font-size:10px}.profile-cosmetic-choice.selected{border-color:#fff;background:#315795;box-shadow:0 0 0 2px rgba(126,231,255,.25)}.profile-cosmetic-choice:disabled{filter:grayscale(.45)}.profile-cosmetic-choice.cosmetic-theme-sunset .profile-cosmetic-preview{background:linear-gradient(105deg,#af5237,#42346f)}.profile-cosmetic-choice.cosmetic-theme-forest .profile-cosmetic-preview{background:linear-gradient(105deg,#19694b,#24345e)}.profile-cosmetic-choice.cosmetic-theme-ember .profile-cosmetic-preview{background:linear-gradient(105deg,#a63828,#482748)}.profile-cosmetic-choice.cosmetic-theme-ocean .profile-cosmetic-preview{background:linear-gradient(105deg,#08728a,#10325f)}.profile-cosmetic-choice.cosmetic-theme-podium .profile-cosmetic-preview{background:linear-gradient(105deg,#a47c1d,#3d396a)}.profile-cosmetic-choice.cosmetic-theme-beta .profile-cosmetic-preview{background:linear-gradient(105deg,#a23b8d,#176588)}.profile-cosmetic-podium{grid-column:1/-1;display:flex;align-items:center;gap:14px;padding:11px 13px;background:#1a2f64;border-left:4px solid #ffe27a}.profile-cosmetic-podium>div{display:flex;flex-direction:column;gap:3px}.profile-cosmetic-podium small{color:#b9cde8;font-size:12px}.profile-cosmetic-podium .button{margin-left:auto;min-width:180px}.profile-cosmetic-podium .button.selected{background:#ffe27a!important;color:#17234d!important}.profile-customizer-actions{min-height:52px;padding-top:4px}.profile-customizer-actions .button{min-width:190px;background:#7ee7ff!important;color:#10214b!important}.sq-plain-racer-themes .overall-entry[class*='cosmetic-theme-']{background:var(--rank-surface)!important;box-shadow:none!important}.sq-plain-racer-themes .overall-profile-card[class*='cosmetic-theme-']{--profile-a:#2d437e;--profile-b:#2d437e;--profile-accent:#7ee7ff}.sq-plain-racer-themes .overall-profile-card[class*='cosmetic-stage-'] .overall-car-model{background:#172653!important}.leaderboard-ui>.container>button.main.sq-racer-cosmetic{--cosmetic-a:#2d3b68;--cosmetic-b:#192958;--cosmetic-glow:#7ee7ff;position:relative;isolation:isolate;overflow:hidden}.leaderboard-ui>.container>button.main.sq-racer-cosmetic>*{position:relative;z-index:2}.leaderboard-ui>.container>button.main.sq-racer-cosmetic::before{content:'';position:absolute;z-index:1;inset:0;pointer-events:none;opacity:.72}.leaderboard-ui>.container>button.main.sq-racer-cosmetic.cosmetic-theme-cyan{--cosmetic-a:#086782;--cosmetic-b:#263d78;--cosmetic-glow:#7ef5ff}.leaderboard-ui>.container>button.main.sq-racer-cosmetic.cosmetic-theme-ocean{--cosmetic-a:#075b79;--cosmetic-b:#0b315f;--cosmetic-glow:#5fe8d0}.leaderboard-ui>.container>button.main.sq-racer-cosmetic.cosmetic-theme-sunset{--cosmetic-a:#a34f32;--cosmetic-b:#44366f;--cosmetic-glow:#ffbd73}.leaderboard-ui>.container>button.main.sq-racer-cosmetic.cosmetic-theme-forest{--cosmetic-a:#176549;--cosmetic-b:#203963;--cosmetic-glow:#79efad}.leaderboard-ui>.container>button.main.sq-racer-cosmetic.cosmetic-theme-ember{--cosmetic-a:#9b2f25;--cosmetic-b:#512951;--cosmetic-glow:#ff9d5d}.leaderboard-ui>.container>button.main.sq-racer-cosmetic.cosmetic-theme-podium{--cosmetic-a:#9a761b;--cosmetic-b:#3d396a;--cosmetic-glow:#ffe27a}.leaderboard-ui>.container>button.main.sq-racer-cosmetic.cosmetic-theme-beta{--cosmetic-a:#92377f;--cosmetic-b:#175f86;--cosmetic-glow:#ff82d9}.leaderboard-ui>.container>button.main.sq-racer-cosmetic:not(.sq-racer-top),.leaderboard-ui>.container>button.main.sq-racer-cosmetic.cosmetic-podium-override{background:linear-gradient(104deg,var(--cosmetic-a),var(--cosmetic-b) 72%)!important}.sq-plain-racer-themes .leaderboard-ui>.container>button.main.sq-racer-cosmetic{background:revert-layer!important}.sq-plain-racer-themes .leaderboard-ui>.container>button.main.sq-racer-cosmetic::before{display:none!important}@media(max-width:700px){.profile-customizer-body{grid-template-columns:1fr}.profile-cosmetic-group>div{grid-template-columns:repeat(2,minmax(0,1fr))}.profile-cosmetic-choice{grid-template-columns:56px minmax(0,1fr)}.profile-cosmetic-preview{width:49px}.profile-cosmetic-podium{align-items:flex-start;flex-direction:column}.profile-cosmetic-podium .button{width:100%;margin:0}.sq-setting-secret{grid-template-columns:1fr!important}.sq-setting-secret .sq-secret-controls,.sq-setting-secret .sq-backup-validation{grid-column:1!important}}.profile-cosmetic-group.kind-stripe{grid-column:1/-1}.profile-cosmetic-group.kind-stripe>div{grid-template-columns:repeat(2,minmax(0,1fr))}.profile-cosmetic-group.kind-stripe .profile-cosmetic-choice{grid-template-columns:126px minmax(0,1fr);min-height:78px}@media(max-width:700px){.profile-cosmetic-group.kind-stripe>div{grid-template-columns:1fr}.profile-cosmetic-group.kind-stripe .profile-cosmetic-choice{grid-template-columns:110px minmax(0,1fr)}}.overall-entry.cosmetic-theme-ice{--cosmetic-a:#3b86a8;--cosmetic-b:#274989;--cosmetic-glow:#d8fbff}.overall-entry.cosmetic-theme-mono{--cosmetic-a:#555e70;--cosmetic-b:#20293d;--cosmetic-glow:#f4f7ff}.overall-entry.cosmetic-theme-neon{--cosmetic-a:#036f71;--cosmetic-b:#7a245f;--cosmetic-glow:#6dffda}.overall-entry.cosmetic-theme-crimson{--cosmetic-a:#a51f3f;--cosmetic-b:#3f234c;--cosmetic-glow:#ff8aa0}.overall-profile-card.cosmetic-theme-ice{--profile-a:#4c91ad;--profile-b:#29437e;--profile-accent:#d8fbff}.overall-profile-card.cosmetic-theme-mono{--profile-a:#535d70;--profile-b:#20293d;--profile-accent:#f4f7ff}.overall-profile-card.cosmetic-theme-neon{--profile-a:#087776;--profile-b:#74265f;--profile-accent:#6dffda}.overall-profile-card.cosmetic-theme-crimson{--profile-a:#941f3c;--profile-b:#3d244c;--profile-accent:#ff8aa0}.leaderboard-ui>.container>button.main.sq-racer-cosmetic.cosmetic-theme-ice{--cosmetic-a:#3b86a8;--cosmetic-b:#274989;--cosmetic-glow:#d8fbff}.leaderboard-ui>.container>button.main.sq-racer-cosmetic.cosmetic-theme-mono{--cosmetic-a:#555e70;--cosmetic-b:#20293d;--cosmetic-glow:#f4f7ff}.leaderboard-ui>.container>button.main.sq-racer-cosmetic.cosmetic-theme-neon{--cosmetic-a:#036f71;--cosmetic-b:#7a245f;--cosmetic-glow:#6dffda}.leaderboard-ui>.container>button.main.sq-racer-cosmetic.cosmetic-theme-crimson{--cosmetic-a:#a51f3f;--cosmetic-b:#3f234c;--cosmetic-glow:#ff8aa0}.profile-row-showcase{--show-a:var(--profile-a,#2d437e);--show-b:var(--profile-b,#172953);--show-accent:var(--profile-accent,#7ee7ff);grid-column:1/-1;display:grid;gap:7px;padding:12px;border:1px solid color-mix(in srgb,var(--show-accent) 46%,#263a70);background:#0e1a3c}.profile-row-showcase header{display:flex;align-items:end;justify-content:space-between;gap:12px}.profile-row-showcase header b{color:var(--show-accent);font-size:17px}.profile-row-showcase header small{color:#c2d3eb;font-size:12px}.showcase-row{position:relative;isolation:isolate;display:grid;grid-template-columns:58px minmax(0,1fr) auto;align-items:center;min-height:48px;padding:5px 12px;overflow:hidden;border-left:6px solid var(--show-accent);background:linear-gradient(104deg,var(--show-a),var(--show-b) 72%);color:#fff;box-shadow:inset 0 0 0 1px rgba(255,255,255,.15)}.showcase-row>*{position:relative;z-index:2}.showcase-row>strong{font-size:22px}.showcase-row>span{display:flex;flex-direction:column;gap:2px}.showcase-row>span>b{font-size:17px;letter-spacing:.3px}.showcase-row>span>small{color:#d7e4f6;font-size:11px}.showcase-row>em{padding:4px 7px;border:1px solid currentColor;color:var(--show-accent);font-size:11px;font-style:normal}.showcase-row::before{content:'';position:absolute;z-index:1;inset:0;opacity:.82}.showcase-first{--show-a:#a67a18;--show-b:#4c3919;--show-accent:#ffe27a}.showcase-self{outline:2px solid #9ff5ff;outline-offset:-2px}.showcase-self>em{background:#b8f7ff;color:#12355c}.cosmetic-podium-override .showcase-first{--show-a:var(--profile-a,#2d437e);--show-b:var(--profile-b,#172953);--show-accent:var(--profile-accent,#7ee7ff)}.profile-cosmetic-group.kind-stripe .profile-cosmetic-choice{grid-template-columns:60px minmax(0,1fr);min-height:64px}.profile-cosmetic-choice.cosmetic-theme-ice .profile-cosmetic-preview{background:linear-gradient(105deg,#5aa8c0,#304d94)}.profile-cosmetic-choice.cosmetic-theme-mono .profile-cosmetic-preview{background:linear-gradient(105deg,#667080,#222b3e)}.profile-cosmetic-choice.cosmetic-theme-neon .profile-cosmetic-preview{background:linear-gradient(105deg,#078780,#8b2868)}.profile-cosmetic-choice.cosmetic-theme-crimson .profile-cosmetic-preview{background:linear-gradient(105deg,#b52445,#472652)}.leaderboard-ui .verified-state{display:inline-flex!important;align-items:center;gap:6px;min-height:24px;padding:3px 7px!important;border:2px solid currentColor!important;border-radius:2px!important}.leaderboard-ui .verified-state .sq-integrity-label{font-size:11px!important;font-weight:700;letter-spacing:.7px}.leaderboard-ui .verified-state.verified{color:#72f0a4!important;background:rgba(19,91,56,.28)!important}.leaderboard-ui .verified-state.pending{color:#ffd166!important;background:repeating-linear-gradient(135deg,rgba(126,82,10,.34) 0 6px,rgba(75,51,12,.2) 6px 12px)!important;border-style:dashed!important}.leaderboard-ui .verified-state img{width:18px!important;height:18px!important}.leaderboard-ui .verified-state.pending img{width:20px!important;height:20px!important}@media(max-width:700px){.profile-row-showcase header{align-items:flex-start;flex-direction:column;gap:3px}.showcase-row{grid-template-columns:42px minmax(0,1fr) auto;padding:5px 8px}.showcase-row>span>b{font-size:15px}.showcase-row>em{font-size:9px}}/* Racer Studio v3: shared variables keep every public preview and leaderboard surface consistent. */\n      .cosmetic-accent-cyan{--profile-accent:#7ee7ff;--cosmetic-glow:#7ee7ff;--show-accent:#7ee7ff}.cosmetic-accent-white{--profile-accent:#f4f7ff;--cosmetic-glow:#f4f7ff;--show-accent:#f4f7ff}.cosmetic-accent-lime{--profile-accent:#9ff58d;--cosmetic-glow:#9ff58d;--show-accent:#9ff58d}.cosmetic-accent-gold{--profile-accent:#ffd56e;--cosmetic-glow:#ffd56e;--show-accent:#ffd56e}.cosmetic-accent-orange{--profile-accent:#ff9a55;--cosmetic-glow:#ff9a55;--show-accent:#ff9a55}.cosmetic-accent-coral{--profile-accent:#ff7f76;--cosmetic-glow:#ff7f76;--show-accent:#ff7f76}.cosmetic-accent-pink{--profile-accent:#ff82d9;--cosmetic-glow:#ff82d9;--show-accent:#ff82d9}.cosmetic-accent-violet{--profile-accent:#b9a0ff;--cosmetic-glow:#b9a0ff;--show-accent:#b9a0ff}.cosmetic-accent-ice{--profile-accent:#d8fbff;--cosmetic-glow:#d8fbff;--show-accent:#d8fbff}.overall-entry .overall-name,.leaderboard-ui button.main .name{position:relative}.overall-entry[class*='cosmetic-emblem-'] .overall-name::before,.leaderboard-ui button.main[class*='cosmetic-emblem-'] .name::before{position:absolute;right:2%;top:50%;z-index:0;transform:translateY(-50%);color:var(--cosmetic-glow,#7ee7ff);font:46px/1 ForcedSquare,Arial,sans-serif;opacity:.13;pointer-events:none}.cosmetic-emblem-bolt .overall-name::before,.leaderboard-ui .cosmetic-emblem-bolt .name::before,.cosmetic-emblem-bolt .showcase-row::after{content:'⚡'}.cosmetic-emblem-star .overall-name::before,.leaderboard-ui .cosmetic-emblem-star .name::before,.cosmetic-emblem-star .showcase-row::after{content:'★'}.cosmetic-emblem-flag .overall-name::before,.leaderboard-ui .cosmetic-emblem-flag .name::before,.cosmetic-emblem-flag .showcase-row::after{content:'⚑'}.cosmetic-emblem-flame .overall-name::before,.leaderboard-ui .cosmetic-emblem-flame .name::before,.cosmetic-emblem-flame .showcase-row::after{content:'▲'}.cosmetic-emblem-crown .overall-name::before,.leaderboard-ui .cosmetic-emblem-crown .name::before,.cosmetic-emblem-crown .showcase-row::after{content:'♛'}.showcase-row::after{position:absolute;right:12%;top:50%;z-index:1;transform:translateY(-50%);color:var(--show-accent);font:38px/1 ForcedSquare,Arial,sans-serif;opacity:.14}.overall-racer-title,.profile-racer-title{display:inline-flex;padding:2px 6px;border:1px solid var(--cosmetic-glow,var(--profile-accent,#7ee7ff));color:var(--cosmetic-glow,var(--profile-accent,#9feaff));font-size:11px;letter-spacing:.7px}.profile-identity-extras{display:flex;flex-wrap:wrap;align-items:center;gap:7px;margin:-3px 0 10px}.profile-favorite-chip{min-height:30px;padding:4px 9px;border:1px solid color-mix(in srgb,var(--profile-accent,#7ee7ff) 55%,transparent);background:#142653;color:#fff;font:13px ForcedSquare,Arial,sans-serif;cursor:pointer}.profile-favorite-chip:hover,.profile-favorite-chip:focus-visible{background:var(--profile-accent,#7ee7ff);color:#10204a;outline:2px solid #fff}.overall-profile-card[class*='cosmetic-']{border-left:7px solid var(--profile-accent,#7ee7ff)}.profile-member-badge{display:inline-flex;padding:5px 8px;background:#6fe0b1;color:#102f36;font-size:12px;font-weight:700;letter-spacing:.8px}.profile-member-badge.compact{padding:2px 5px;font-size:9px;line-height:1;border-radius:3px;white-space:nowrap}.profile-customizer{border-left-color:var(--profile-accent,#7ee7ff)!important}.profile-customizer-body{grid-template-columns:minmax(310px,.8fr) minmax(0,1.55fr)!important;align-items:start}.profile-customizer-intro,.profile-customizer-actions{grid-column:1/-1}.profile-customizer-preview{position:sticky;top:8px;display:grid;gap:9px;min-width:0;padding:12px;background:#0c1838;border:1px solid color-mix(in srgb,var(--profile-accent,#7ee7ff) 48%,#263a70)}.profile-customizer-preview header{display:flex;justify-content:space-between;align-items:end;gap:8px}.profile-customizer-preview header b{color:var(--profile-accent,#7ee7ff);font-size:18px}.profile-customizer-preview header small{color:#b9cde8;font-size:12px}.profile-preview-stage{position:relative;display:grid;grid-template-columns:150px minmax(0,1fr);align-items:center;gap:10px;min-height:112px;padding:8px;background:#172653;overflow:hidden}.profile-preview-stage>.overall-car-model{width:150px!important;height:96px!important;margin:0!important}.profile-preview-stage>span{position:relative;z-index:3;display:flex;flex-direction:column}.profile-preview-stage>span b{font-size:20px}.profile-preview-stage>span small{color:var(--profile-accent,#9feaff);font-size:13px}.profile-row-showcase{padding:0!important;border:0!important;background:transparent!important}.profile-customizer-controls{display:grid;grid-template-columns:1fr 1fr;gap:10px;min-width:0}.profile-customizer-controls .profile-cosmetic-group{background:#132655}.profile-cosmetic-group>p{min-height:31px;margin:0 0 7px;color:#b9cde8;font-size:12px;line-height:1.25}.profile-cosmetic-preview{position:relative;display:block;width:48px;height:36px;overflow:hidden;background:linear-gradient(105deg,#344b82,#1a2b5c);border:1px solid rgba(255,255,255,.22)}.profile-cosmetic-preview i{position:absolute!important;inset:0!important;width:auto!important;height:auto!important;background:transparent}.profile-cosmetic-choice{grid-template-columns:54px minmax(0,1fr)!important;min-height:60px!important}.profile-cosmetic-choice.selected{border-color:var(--profile-accent,#fff)!important;box-shadow:inset 4px 0 0 var(--profile-accent,#7ee7ff)}.profile-cosmetic-choice[class*='cosmetic-accent-'] .profile-cosmetic-preview{background:var(--choice-accent,#7ee7ff)!important}.cosmetic-accent-white .profile-cosmetic-preview{--choice-accent:#f4f7ff}.cosmetic-accent-lime .profile-cosmetic-preview{--choice-accent:#9ff58d}.cosmetic-accent-gold .profile-cosmetic-preview{--choice-accent:#ffd56e}.cosmetic-accent-orange .profile-cosmetic-preview{--choice-accent:#ff9a55}.cosmetic-accent-coral .profile-cosmetic-preview{--choice-accent:#ff7f76}.cosmetic-accent-pink .profile-cosmetic-preview{--choice-accent:#ff82d9}.cosmetic-accent-violet .profile-cosmetic-preview{--choice-accent:#b9a0ff}.cosmetic-accent-ice .profile-cosmetic-preview{--choice-accent:#d8fbff}.profile-cosmetic-choice.cosmetic-stage-tint-blue{--choice-tint:#247ee8}.profile-cosmetic-choice.cosmetic-stage-tint-teal{--choice-tint:#00a99b}.profile-cosmetic-choice.cosmetic-stage-tint-gold{--choice-tint:#e5a928}.profile-cosmetic-choice.cosmetic-stage-tint-red{--choice-tint:#d62d46}.profile-cosmetic-choice.cosmetic-stage-tint-pink{--choice-tint:#df4dab}.profile-cosmetic-choice.cosmetic-stage-tint-mono{--choice-tint:#8a92a1}.profile-cosmetic-choice[class*='cosmetic-emblem-'] .profile-cosmetic-preview::after{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#eaf7ff;font-size:25px}.profile-cosmetic-choice.cosmetic-emblem-bolt .profile-cosmetic-preview::after{content:'⚡'}.profile-cosmetic-choice.cosmetic-emblem-star .profile-cosmetic-preview::after{content:'★'}.profile-cosmetic-choice.cosmetic-emblem-flag .profile-cosmetic-preview::after{content:'⚑'}.profile-cosmetic-choice.cosmetic-emblem-flame .profile-cosmetic-preview::after{content:'▲'}.profile-cosmetic-choice.cosmetic-emblem-crown .profile-cosmetic-preview::after{content:'♛'}.profile-favorite-track{grid-column:1/-1;display:grid;grid-template-columns:minmax(170px,.7fr) minmax(220px,1.3fr);align-items:center;gap:12px;padding:11px 13px;background:#1a2f64;border-left:4px solid var(--profile-accent,#7ee7ff);color:#fff}.profile-favorite-track>span{display:flex;flex-direction:column;gap:3px}.profile-favorite-track small{color:#b9cde8}.profile-favorite-track select{min-width:0;height:42px;padding:0 10px;background:#0f1d44;border:1px solid rgba(126,231,255,.5);color:#fff;font:15px ForcedSquare,Arial,sans-serif}.cosmetic-stage-tint-blue .overall-car-model::before,.cosmetic-stage-tint-teal .overall-car-model::before,.cosmetic-stage-tint-gold .overall-car-model::before,.cosmetic-stage-tint-red .overall-car-model::before,.cosmetic-stage-tint-pink .overall-car-model::before,.cosmetic-stage-tint-mono .overall-car-model::before{content:'';position:absolute;inset:0;z-index:1;pointer-events:none;mix-blend-mode:color;opacity:.5}.cosmetic-stage-tint-blue .overall-car-model::before{background:#247ee8}.cosmetic-stage-tint-teal .overall-car-model::before{background:#00a99b}.cosmetic-stage-tint-gold .overall-car-model::before{background:#e5a928}.cosmetic-stage-tint-red .overall-car-model::before{background:#d62d46}.cosmetic-stage-tint-pink .overall-car-model::before{background:#df4dab}.cosmetic-stage-tint-mono .overall-car-model::before{background:#8a92a1;mix-blend-mode:saturation;opacity:1}.overall-car-model{isolation:isolate}.overall-car-model>img{z-index:2}.profile-customizer-preview .overall-car-model>img,.profile-car-column>.overall-car-model>img{z-index:2}.leaderboard-ui .verified-state.verified .sq-integrity-label{display:none}@media(max-width:1000px){.profile-customizer-body{grid-template-columns:1fr!important}.profile-customizer-preview{position:relative;top:auto}.profile-customizer-controls{grid-template-columns:1fr 1fr}}@media(max-width:700px){.profile-customizer-controls{grid-template-columns:1fr}.profile-customizer-preview header{align-items:flex-start;flex-direction:column}.profile-preview-stage{grid-template-columns:120px minmax(0,1fr)}.profile-preview-stage>.overall-car-model{width:120px!important;height:82px!important}.profile-favorite-track{grid-template-columns:1fr}.profile-customizer-actions{align-items:stretch;flex-direction:column}.profile-customizer-actions .button{width:100%}}@keyframes staticGlowPulse{0%{box-shadow:0 0 0 rgba(255,255,255,0.0),0 0 10px rgba(0,255,255,0.12)}50%{box-shadow:0 0 14px rgba(255,255,255,0.18),0 0 22px rgba(255,0,255,0.18)}100%{box-shadow:0 0 0 rgba(255,255,255,0.0),0 0 10px rgba(0,255,255,0.12)}}@keyframes rankLoading{0%{transform:translateX(-130%)}55%{transform:translateX(120%)}100%{transform:translateX(310%)}}@keyframes staticSheen{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}@keyframes staticFloat{0%{transform:translateY(0) scale(1)}50%{transform:translateY(-1px) scale(1.01)}100%{transform:translateY(0) scale(1)}}@keyframes staticWave{0%{transform:translateZ(0) rotateY(0deg)}50%{transform:translateZ(14px) rotateY(10deg)}100%{transform:translateZ(0) rotateY(0deg)}}@keyframes rankPanelIn{from{opacity:0;transform:translateY(24px) scale(.975)}to{opacity:1;transform:translateY(0) scale(1)}}@keyframes overallEntryIn{to{opacity:1;transform:translateX(0)}}@keyframes rankLineIn{to{width:100%}}@keyframes selfRankPulse{0%,100%{filter:brightness(1)}45%{filter:brightness(1.35)}}@keyframes rankedButtonSpawn{0%{opacity:0;transform:translateY(24px) scale(.94);filter:brightness(1.35)}62%{opacity:1;transform:translateY(-3px) scale(1.015);filter:brightness(1.1)}100%{opacity:1;transform:translateY(0) scale(1);filter:brightness(1)}}@keyframes rankedIconPop{0%,24%{transform:scale(.45);opacity:0}68%{transform:scale(1.16);opacity:1}100%{transform:scale(1);opacity:1}}/* Racer Studio v3 corrections. Accent owns every highlight,so it stays independent of the base colors. */\n      .cosmetic-accent-cyan.cosmetic-accent-cyan{--profile-accent:#7ee7ff;--cosmetic-glow:#7ee7ff;--show-accent:#7ee7ff}.cosmetic-accent-white.cosmetic-accent-white{--profile-accent:#f4f7ff;--cosmetic-glow:#f4f7ff;--show-accent:#f4f7ff}.cosmetic-accent-lime.cosmetic-accent-lime{--profile-accent:#9ff58d;--cosmetic-glow:#9ff58d;--show-accent:#9ff58d}.cosmetic-accent-gold.cosmetic-accent-gold{--profile-accent:#ffd56e;--cosmetic-glow:#ffd56e;--show-accent:#ffd56e}.cosmetic-accent-orange.cosmetic-accent-orange{--profile-accent:#ff9a55;--cosmetic-glow:#ff9a55;--show-accent:#ff9a55}.cosmetic-accent-coral.cosmetic-accent-coral{--profile-accent:#ff7f76;--cosmetic-glow:#ff7f76;--show-accent:#ff7f76}.cosmetic-accent-pink.cosmetic-accent-pink{--profile-accent:#ff82d9;--cosmetic-glow:#ff82d9;--show-accent:#ff82d9}.cosmetic-accent-violet.cosmetic-accent-violet{--profile-accent:#b9a0ff;--cosmetic-glow:#b9a0ff;--show-accent:#b9a0ff}.cosmetic-accent-ice.cosmetic-accent-ice{--profile-accent:#d8fbff;--cosmetic-glow:#d8fbff;--show-accent:#d8fbff}.profile-row-showcase{--show-accent:var(--profile-accent,#7ee7ff)}/* Mini previews that used to fall back to the generic chip now show the layer they actually set. */\n      .profile-cosmetic-choice.cosmetic-theme-classic .profile-cosmetic-preview{background:linear-gradient(105deg,#2d3b68,#1a2958)}.profile-cosmetic-choice.cosmetic-theme-cyan .profile-cosmetic-preview{background:linear-gradient(105deg,#086782,#263d78)}/* Racer title and displayed badge are text,so those groups drop the color chip entirely. */\n      .profile-cosmetic-group.kind-title .profile-cosmetic-choice,.profile-cosmetic-group.kind-badge .profile-cosmetic-choice{grid-template-columns:minmax(0,1fr)!important}/* Long racer names and option labels wrap instead of being cut off in narrow columns. */\n      .profile-cosmetic-choice>b,.profile-cosmetic-choice>small{min-width:0;overflow-wrap:break-word}.profile-preview-stage>span{min-width:0}.profile-preview-stage>span>b,.profile-preview-stage>span>small{min-width:0;overflow-wrap:break-word}.showcase-row>span,.showcase-row>span>b{min-width:0;overflow-wrap:break-word}/* Accent swatches must describe their own option,not the card's current accent. */\n      .profile-cosmetic-choice.cosmetic-accent-cyan .profile-cosmetic-preview{--choice-accent:#7ee7ff}.profile-cosmetic-choice.cosmetic-accent-white .profile-cosmetic-preview{--choice-accent:#f4f7ff}.profile-cosmetic-choice.cosmetic-accent-lime .profile-cosmetic-preview{--choice-accent:#9ff58d}.profile-cosmetic-choice.cosmetic-accent-gold .profile-cosmetic-preview{--choice-accent:#ffd56e}.profile-cosmetic-choice.cosmetic-accent-orange .profile-cosmetic-preview{--choice-accent:#ff9a55}.profile-cosmetic-choice.cosmetic-accent-coral .profile-cosmetic-preview{--choice-accent:#ff7f76}.profile-cosmetic-choice.cosmetic-accent-pink .profile-cosmetic-preview{--choice-accent:#ff82d9}.profile-cosmetic-choice.cosmetic-accent-violet .profile-cosmetic-preview{--choice-accent:#b9a0ff}.profile-cosmetic-choice.cosmetic-accent-ice .profile-cosmetic-preview{--choice-accent:#d8fbff}/* One option per row on phones so names such as Monochrome are never split mid-word. */\n      @media(max-width:460px){.profile-cosmetic-group>div{grid-template-columns:minmax(0,1fr)!important}}.overall-racer-title:empty,.profile-racer-title:empty,.showcase-badges:empty,.showcase-meta:empty{display:none}.showcase-row>span>b{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.showcase-badges{display:inline-flex;align-items:center;gap:4px}.showcase-meta{display:flex;align-items:center;flex-wrap:wrap;gap:4px}.showcase-row .overall-racer-title{border-color:var(--show-accent);color:var(--show-accent)}.profile-preview-title:empty{display:none}/* Plain racer themes must flatten every v3 layer,not only the base colors and pattern. */\n      .sq-plain-racer-themes [class*='cosmetic-emblem-'] .overall-name::before,.sq-plain-racer-themes .leaderboard-ui [class*='cosmetic-emblem-'] .name::before{display:none!important}.sq-plain-racer-themes [class*='cosmetic-stage-tint-'] .overall-car-model::before{display:none!important}.sq-plain-racer-themes .overall-entry[class*='cosmetic-stage-'] .overall-car-model,.sq-plain-racer-themes .leaderboard-ui button.main[class*='cosmetic-stage-'] .overall-car-model{background:#172653!important}.sq-plain-racer-themes .overall-entry[class*='cosmetic-stage-'] .overall-car-model::after,.sq-plain-racer-themes .leaderboard-ui button.main[class*='cosmetic-stage-'] .overall-car-model::after{display:none!important}.sq-plain-racer-themes .overall-entry.cosmetic-podium-override[class*='cosmetic-finish-']{background:#2d3b68!important}/* A kept gold first place still shows the racer's accent on its pattern,emblem and title,exactly like the real row. */\n      .overall-profile-card:not(.cosmetic-podium-override) .showcase-first{--show-accent:var(--profile-accent,#7ee7ff);border-left-color:#ffe27a}.overall-profile-card:not(.cosmetic-podium-override) .showcase-first>em{color:#ffe27a}/* Studio controls use the same white keyboard ring as the rest of the Ranked panel. */\n      .profile-customizer>summary:focus-visible,.profile-cosmetic-choice:focus-visible,.profile-favorite-track select:focus-visible,[data-cosmetic-podium]:focus-visible,[data-save-profile-cosmetics]:focus-visible{outline:2px solid #fff;outline-offset:2px}/* ============ Racer Studio v4 ============================================\n         Every nameplate layer is declared once as a custom property. Because custom\n         properties resolve from the nearest ancestor that sets them,a swatch inside\n         the studio shows its own option while inheriting the rest of the live design,so a preview cannot drift from the row it describes. */\n      [class*='cosmetic-accent-']{--fx-accent:var(--profile-accent,#7ee7ff)}.cosmetic-finish-gradient{--row-finish:linear-gradient(104deg,var(--cosmetic-a,var(--profile-a,#2d437e)),var(--cosmetic-b,var(--profile-b,#172953)) 72%)}.cosmetic-finish-solid{--row-finish:var(--cosmetic-a,var(--profile-a,#2d437e))}.cosmetic-finish-split{--row-finish:linear-gradient(110deg,var(--cosmetic-a,var(--profile-a,#2d437e)) 0 48%,var(--cosmetic-b,var(--profile-b,#172953)) 49%)}.cosmetic-finish-gloss{--row-finish:linear-gradient(165deg,rgba(255,255,255,.22) 0 18%,transparent 19%),linear-gradient(104deg,var(--cosmetic-a,var(--profile-a,#2d437e)),var(--cosmetic-b,var(--profile-b,#172953)) 72%)}.cosmetic-finish-carbon{--row-finish:linear-gradient(45deg,rgba(255,255,255,.06) 25%,transparent 25% 75%,rgba(255,255,255,.06) 75%),linear-gradient(135deg,rgba(0,0,0,.13) 25%,transparent 25% 75%,rgba(0,0,0,.13) 75%),linear-gradient(104deg,var(--cosmetic-a,var(--profile-a,#2d437e)),var(--cosmetic-b,var(--profile-b,#172953)));--row-finish-size:12px 12px,12px 12px,auto}.cosmetic-finish-horizon{--row-finish:linear-gradient(180deg,var(--cosmetic-a,var(--profile-a,#2d437e)) 0 45%,color-mix(in srgb,var(--fx-accent,#7ee7ff) 45%,transparent) 46% 50%,var(--cosmetic-b,var(--profile-b,#172953)) 51%)}.overall-entry[class*='cosmetic-finish-']:not(.top-1):not(.top-2):not(.top-3),.overall-entry[class*='cosmetic-finish-'].cosmetic-podium-override,.leaderboard-ui>.container>button.main.sq-racer-cosmetic[class*='cosmetic-finish-']:not(.sq-racer-top),.leaderboard-ui>.container>button.main.sq-racer-cosmetic[class*='cosmetic-finish-'].cosmetic-podium-override,[class*='cosmetic-finish-'] .showcase-row:not(.showcase-first),[class*='cosmetic-finish-'].cosmetic-podium-override .showcase-row,.np-preview{background:var(--row-finish,linear-gradient(104deg,var(--cosmetic-a,var(--profile-a,#2d437e)),var(--cosmetic-b,var(--profile-b,#172953)) 72%))!important;background-size:var(--row-finish-size,auto)!important}/* Place block and edge bar stack on top of the colors without extra markup. */\n      .cosmetic-plate-block{--plate-bg:rgba(7,12,34,.26);--plate-shadow:none;--plate-clip:none}.cosmetic-plate-solid{--plate-bg:var(--fx-accent,#7ee7ff);--plate-shadow:none;--plate-clip:none}.cosmetic-plate-outline{--plate-bg:transparent;--plate-shadow:inset 0 0 0 2px var(--fx-accent,#7ee7ff);--plate-clip:none}.cosmetic-plate-notch{--plate-bg:color-mix(in srgb,var(--fx-accent,#7ee7ff) 22%,transparent);--plate-shadow:none;--plate-clip:polygon(0 0,100% 0,calc(100% - 14px) 100%,0 100%)}.cosmetic-plate-bar{--plate-bg:transparent;--plate-shadow:inset 0 -6px 0 var(--fx-accent,#7ee7ff);--plate-clip:none}.overall-entry[class*='cosmetic-plate-'] .overall-rank,[class*='cosmetic-plate-'] .showcase-row>strong,.np-preview>b{background:var(--plate-bg,rgba(7,12,34,.26));box-shadow:var(--plate-shadow,none);clip-path:var(--plate-clip,none)}.cosmetic-plate-solid .overall-rank,.cosmetic-plate-solid .showcase-row>strong,.cosmetic-plate-solid .np-preview>b{color:#0b1730!important}.cosmetic-edge-accent{--edge-width:6px;--edge-style:solid}.cosmetic-edge-wide{--edge-width:13px;--edge-style:solid}.cosmetic-edge-none{--edge-width:0px;--edge-style:solid}.cosmetic-edge-double{--edge-width:9px;--edge-style:double}.cosmetic-edge-dashed{--edge-width:7px;--edge-style:dashed}.overall-entry[class*='cosmetic-edge-'],[class*='cosmetic-edge-'] .showcase-row,.np-preview{border-left:var(--edge-width,6px) var(--edge-style,solid) var(--fx-accent,#7ee7ff)}/* Studio shell */\n      .profile-customizer-body{grid-template-columns:minmax(300px,360px) minmax(0,1fr);gap:12px;align-items:start}.studio-tabs{position:sticky;top:0;z-index:5;display:flex;gap:4px;padding-bottom:8px;background:#10204a}.studio-tab{flex:1;min-height:40px;padding:6px 8px;border:1px solid rgba(126,231,255,.26);background:#16295a;color:#c3d9f4;font:13px ForcedSquare,Arial,sans-serif;letter-spacing:1.2px;cursor:pointer;clip-path:polygon(0 0,100% 0,calc(100% - 8px) 100%,0 100%)}.studio-tab[aria-selected='true']{border-color:transparent;background:var(--fx-accent,#7ee7ff);color:#0b1730}.studio-tab:focus-visible{outline:2px solid #fff;outline-offset:2px}.studio-panel{display:grid;gap:10px}.studio-panel[hidden]{display:none}.profile-cosmetic-group{padding:8px 9px 10px}.profile-cosmetic-group>p{margin:0 0 7px;color:#a9c2e2;font-size:11px;line-height:1.3}.profile-cosmetic-group>div{gap:5px}.profile-cosmetic-choice{position:relative;min-height:auto!important;padding:5px!important;gap:4px}.profile-cosmetic-choice>b{font-size:11px;line-height:1.15}.profile-cosmetic-choice>small{color:#ffcf7a;font-size:9px;line-height:1.1}/* Dense swatch grid: the name is the label,the note appears only when locked. */\n      .variant-swatch>div{grid-template-columns:repeat(auto-fill,minmax(78px,1fr))!important}.variant-swatch .profile-cosmetic-choice{grid-template-columns:minmax(0,1fr)!important;grid-template-rows:auto auto auto}.variant-swatch .profile-cosmetic-preview{width:100%!important;height:32px!important;grid-row:auto!important}.variant-plate>div{grid-template-columns:repeat(auto-fill,minmax(168px,1fr))!important}.variant-plate .profile-cosmetic-choice{grid-template-columns:minmax(0,1fr)!important;grid-template-rows:auto auto auto}.variant-text>div{grid-template-columns:repeat(auto-fill,minmax(120px,1fr))!important}.variant-text .profile-cosmetic-choice{grid-template-columns:minmax(0,1fr)!important;min-height:40px!important;align-content:center}/* The pattern and finish swatches are miniature nameplates,not abstract chips. */\n      .np-preview{position:relative;isolation:isolate;display:block!important;width:100%!important;height:40px!important;overflow:hidden;grid-row:auto!important;clip-path:polygon(0 0,100% 0,calc(100% - 6px) 100%,0 100%)}.np-preview::before{content:'';position:absolute;z-index:1;inset:0;opacity:.85}.np-preview{display:grid!important;grid-template-columns:34px minmax(0,1fr);align-items:stretch}.np-preview>b{position:relative;z-index:3;display:flex;align-items:center;justify-content:center;color:#dbe9ff;font-size:12px}.np-preview>span{position:relative;z-index:3;display:flex;align-items:center;padding:5px 8px;color:#fff;font-size:11px;letter-spacing:.7px}.profile-cosmetic-choice.selected .np-preview{box-shadow:inset 0 0 0 2px #fff}.profile-extras-grid{display:grid!important;grid-template-columns:minmax(0,1fr)!important;gap:9px}.profile-favorite-track input{min-height:40px;padding:6px 9px;border:1px solid rgba(126,231,255,.34);background:#16295a;color:#fff;font:14px ForcedSquare,Arial,sans-serif}.profile-favorite-track input[aria-invalid='true']{border-color:#ff9a55}.profile-favorite-track input:focus-visible{outline:2px solid #fff;outline-offset:2px}/* One badge,large enough to read on a row. */\n      .profile-badge{display:inline-flex;align-items:center;padding:4px 9px;font-weight:700;letter-spacing:1px;line-height:1;clip-path:polygon(0 0,100% 0,calc(100% - 5px) 100%,0 100%)}.profile-badge.compact{padding:3px 8px;font-size:11px;letter-spacing:.9px}.profile-beta-badge{background:#ffd26c;color:#17224a}.profile-member-badge{background:#6fe0b1;color:#0f2f36}/* Per-track rows carry the same flag,badge and title as the Overall list. */\n      .sq-track-identity{display:inline-flex;align-items:center;gap:6px;margin-left:8px;vertical-align:middle}.sq-track-identity .overall-flag img{width:22px;height:16px}.sq-track-identity .overall-racer-title{font-size:10px}.sq-plain-racer-themes .sq-track-identity .overall-racer-title{display:none}/* The controls column is a single stack now that the tabs do the splitting. */\n      .profile-customizer-controls{grid-template-columns:minmax(0,1fr)!important;gap:10px!important;align-content:start}.profile-customizer-body{grid-template-columns:minmax(340px,400px) minmax(0,1fr)!important;align-items:start!important}@media(max-width:900px){.profile-customizer-body{grid-template-columns:minmax(0,1fr)!important}}.profile-customizer-preview{position:sticky;top:8px;align-self:start}.profile-preview-stage>span b{font-size:17px;letter-spacing:.3px}.profile-preview-stage{grid-template-columns:118px minmax(0,1fr)}.profile-preview-stage>.overall-car-model{width:118px!important;height:80px!important}.showcase-row{grid-template-columns:46px minmax(0,1fr) auto;padding:6px 9px}.showcase-row>strong{font-size:19px}.showcase-row>span>b{font-size:14px}.showcase-row>span>small{font-size:10px}.profile-customizer-actions{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:9px;align-items:center;margin-top:9px}.profile-customizer-actions [role='status']{color:#b9cde8;font-size:12px;line-height:1.25}.profile-customizer-actions .button{min-height:44px;padding:8px 16px;font-size:15px;letter-spacing:.8px}.profile-cosmetic-podium .button{min-height:44px;padding:8px 14px}.profile-cosmetic-podium{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center}/* ---- Car backdrops -------------------------------------------------\n         Seen mostly at 50-124px behind a car,so these are soft vertical gradients with\n         any detail kept low contrast and away from the centre. A hard horizon band reads\n         as a line drawn through the car at that size. Each scene is two custom properties,so the studio swatch,profile card and every leaderboard row draw the same thing,and the car is never moved,scaled or recolored. */\n      .cosmetic-stage-garage{--stage-bg:linear-gradient(180deg,#212e5c,#111935);--stage-fx:radial-gradient(70% 48% at 50% 104%,rgba(126,231,255,.20),transparent 72%)}.cosmetic-stage-slate{--stage-bg:linear-gradient(180deg,#5a688c,#2c3552);--stage-fx:radial-gradient(72% 50% at 50% 104%,rgba(255,255,255,.14),transparent 74%)}.cosmetic-stage-aqua{--stage-bg:linear-gradient(180deg,#1e7ba0,#0b2c4f);--stage-fx:radial-gradient(64% 46% at 26% -8%,rgba(150,244,255,.34),transparent 70%)}.cosmetic-stage-grid{--stage-bg:linear-gradient(180deg,#2f4f8c,#141d3f);--stage-fx:repeating-linear-gradient(90deg,transparent 0 13px,rgba(255,255,255,.10) 13px 18px,transparent 18px 34px)}.cosmetic-stage-horizon{--stage-bg:linear-gradient(180deg,#f0946a,#a3608a 46%,#2a2350);--stage-fx:radial-gradient(34% 26% at 50% 34%,rgba(255,232,168,.55),transparent 72%)}.cosmetic-stage-night{--stage-bg:linear-gradient(180deg,#152549,#060c22);--stage-fx:radial-gradient(circle at 16% 17%,rgba(255,239,160,.85) 0 1.3px,transparent 2px),radial-gradient(circle at 74% 12%,rgba(160,232,255,.8) 0 1.3px,transparent 2px),radial-gradient(circle at 88% 27%,rgba(255,255,255,.7) 0 1px,transparent 1.6px),radial-gradient(circle at 34% 9%,rgba(255,255,255,.55) 0 1px,transparent 1.6px)}.cosmetic-stage-storm{--stage-bg:linear-gradient(180deg,#313c6b,#0f1530);--stage-fx:radial-gradient(56% 42% at 76% 12%,rgba(154,242,255,.30),transparent 70%)}.cosmetic-stage-dunes{--stage-bg:linear-gradient(180deg,#83c9de 0%,#8fb9a8 34%,#e6b565 56%,#a55f36 100%);--stage-fx:radial-gradient(88% 44% at 24% 104%,rgba(255,231,178,.40),transparent 72%)}.cosmetic-stage-podium{--stage-bg:linear-gradient(180deg,#333a78,#14183a);--stage-fx:radial-gradient(48% 62% at 50% -14%,rgba(255,238,160,.42),transparent 72%)}.overall-car-model{background:var(--stage-bg,linear-gradient(145deg,#1d2a55,#111c3c))!important}.overall-car-model::after{content:'';position:absolute;inset:0;z-index:0;background:var(--stage-fx,none);pointer-events:none}/* Scene swatches read the same two properties,so they cannot drift. */\n      .kind-stage .profile-cosmetic-preview,.kind-stageTint .profile-cosmetic-preview{position:relative;overflow:hidden;background:var(--stage-bg,linear-gradient(145deg,#1d2a55,#111c3c))!important}.kind-stage .profile-cosmetic-preview::after,.kind-stageTint .profile-cosmetic-preview::after{content:'';position:absolute;inset:0;background:var(--stage-fx,none)}.profile-cosmetic-choice[class*='cosmetic-stage-tint-'] .profile-cosmetic-preview::before{content:'';position:absolute;z-index:1;inset:0;background:var(--choice-tint,transparent);mix-blend-mode:color;opacity:.72}.profile-cosmetic-choice.cosmetic-stage-tint-blue .profile-cosmetic-preview{--choice-tint:#247ee8}.profile-cosmetic-choice.cosmetic-stage-tint-teal .profile-cosmetic-preview{--choice-tint:#00a99b}.profile-cosmetic-choice.cosmetic-stage-tint-gold .profile-cosmetic-preview{--choice-tint:#e5a928}.profile-cosmetic-choice.cosmetic-stage-tint-red .profile-cosmetic-preview{--choice-tint:#d62d46}.profile-cosmetic-choice.cosmetic-stage-tint-pink .profile-cosmetic-preview{--choice-tint:#df4dab}.profile-cosmetic-choice.cosmetic-stage-tint-mono .profile-cosmetic-preview::before{background:#8a92a1;mix-blend-mode:saturation;opacity:1}.sq-plain-racer-themes .overall-car-model{background:#172653!important}.sq-plain-racer-themes .overall-car-model::after{display:none!important}\n      .cosmetic-emblem-diamond .overall-name::before,.leaderboard-ui .cosmetic-emblem-diamond .name::before,.cosmetic-emblem-diamond .showcase-row::after,.profile-cosmetic-choice.cosmetic-emblem-diamond .profile-cosmetic-preview::after{content:'\\25C6'}\n      .cosmetic-emblem-twinStars .overall-name::before,.leaderboard-ui .cosmetic-emblem-twinStars .name::before,.cosmetic-emblem-twinStars .showcase-row::after,.profile-cosmetic-choice.cosmetic-emblem-twin-stars .profile-cosmetic-preview::after,.profile-cosmetic-choice.cosmetic-emblem-twinStars .profile-cosmetic-preview::after{content:'\\2605\\2009\\2605';font-size:24px}\n      .kind-badge .badge-off-control{grid-column:1/-1;min-height:44px!important;border-style:dashed!important;background:#152342!important;color:#d5deef!important}\n      .kind-badge .badge-off-control.selected{border-style:solid!important;border-color:#d5deef!important}\n      .sq-track-submit{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;padding:10px 14px;background:#172953;border-left:3px solid #7ee7ff;font:15px/1.4 ForcedSquare,Arial,sans-serif;color:#e9f4ff}\n      .sq-track-submit a{color:#9eefff;text-decoration:underline;text-underline-offset:3px;min-height:32px;display:inline-flex;align-items:center}\n/* ---- Ranked leaderboard picker --------------------------------------\n         One control. Specialist boards sit on a submenu that opens on hover or\n         keyboard focus{position:relative;display:block}/* A full-width badge no longer gets sliced off the end of a long name. */\n      .overall-name-main{flex-wrap:wrap;align-items:center;row-gap:3px;column-gap:6px}.overall-name-main .profile-badge{flex:0 0 auto}/* Favorite track: a labelled search field,not a bare box bolted to a label. */\n      .profile-favorite-track{display:grid!important;grid-template-columns:minmax(0,1fr)!important;gap:6px;align-items:stretch}.profile-favorite-track>span{display:block}.profile-favorite-track>span>b{display:block;color:#8feeff;font-size:11px;letter-spacing:1.1px}.profile-favorite-track>span>small{display:block;margin-top:2px;color:#a9c2e2;font-size:11px}.profile-favorite-track input{width:100%;min-height:44px;padding:8px 12px;border:1px solid rgba(126,231,255,.34);border-left:4px solid var(--fx-accent,#7ee7ff);background:#16295a;color:#fff;font:15px ForcedSquare,Arial,sans-serif;letter-spacing:.4px;clip-path:polygon(0 0,100% 0,calc(100% - 8px) 100%,0 100%)}.profile-favorite-track input::placeholder{color:#7f96bb}.profile-favorite-track input:focus{border-color:var(--fx-accent,#7ee7ff);background:#1b3168;outline:none}.profile-favorite-track input:focus-visible{outline:2px solid #fff;outline-offset:2px}.profile-favorite-track input[aria-invalid='true']{border-left-color:#ff9a55}/* One selection colour across the studio,driven by the racer's own accent. */\n      .profile-cosmetic-choice.selected{border-color:var(--fx-accent,#7ee7ff);background:#20386f}.variant-text .profile-cosmetic-choice.selected{background:var(--fx-accent,#7ee7ff);color:#0b1730}.variant-text .profile-cosmetic-choice{border:1px solid rgba(126,231,255,.18)}/* The footer wrapped onto a second row and took 42% of the panel. On screens\n         wide enough for three real columns it sits on one row and the list keeps the\n         space; narrower screens keep the stacked layout,which they need. */\n      @media(min-width:1400px){\n        .overall-competition>.overall-footer-right{grid-column:3!important;grid-row:1!important}\n        .overall-competition>.overall-center-tools{grid-column:2!important;grid-row:1!important}\n      }\n      /* Restored: the nameplate patterns and the RANK BY select as they were before\n         this session's rework. The studio pattern swatches read the same rules. */\n      .overall-entry[class*='cosmetic-stripe-']{border-right:5px solid transparent}\n      .overall-entry.cosmetic-stripe-cyan{border-right-color:#7ee7ff}\n      .overall-entry.cosmetic-stripe-sunset{border-right-color:#ff9a65}\n      .overall-entry.cosmetic-stripe-gold{border-right-color:#ffd56e}\n      .overall-entry.cosmetic-stripe-beta{border-right-color:#ff82d9}\n      .profile-cosmetic-choice.cosmetic-stripe-sunset i{background:#ff9a65}\n      .profile-cosmetic-choice.cosmetic-stripe-gold i{background:#ffd56e}\n      .profile-cosmetic-choice.cosmetic-stripe-beta i{background:#ff82d9}\n      .overall-entry{--cosmetic-a:#283b70;--cosmetic-b:#172850;--cosmetic-glow:#7ee7ff}\n      .overall-entry[class*='cosmetic-stripe-']{isolation:isolate;overflow:hidden;border-right:0}\n      .overall-entry[class*='cosmetic-stripe-']>*{position:relative;z-index:2}\n      .overall-entry[class*='cosmetic-stripe-']::before{content:'';position:absolute;z-index:1;inset:0;pointer-events:none;opacity:.82}\n      .overall-entry.cosmetic-stripe-standard::before{background:linear-gradient(90deg,transparent 68%,color-mix(in srgb,var(--cosmetic-glow) 16%,transparent))}\n      .overall-entry.cosmetic-stripe-cyan::before{background:repeating-linear-gradient(112deg,transparent 0 32px,color-mix(in srgb,var(--cosmetic-glow) 30%,transparent) 33px 37px,transparent 38px 58px)}\n      .overall-entry.cosmetic-stripe-chevron::before{background:linear-gradient(135deg,transparent 0 74%,color-mix(in srgb,var(--cosmetic-glow) 30%,transparent) 74% 78%,transparent 78%),repeating-linear-gradient(135deg,transparent 0 32px,color-mix(in srgb,var(--cosmetic-glow) 18%,transparent) 33px 43px,transparent 44px 65px)}\n      .overall-entry.cosmetic-stripe-sunset::before{background:linear-gradient(100deg,transparent 0 36%,rgba(255,206,111,.23) 36% 39%,transparent 39% 56%,rgba(255,112,92,.3) 56% 60%,transparent 60%)}\n      .overall-entry.cosmetic-stripe-grid::before{background:linear-gradient(color-mix(in srgb,var(--cosmetic-glow) 18%,transparent) 1px,transparent 1px),linear-gradient(90deg,color-mix(in srgb,var(--cosmetic-glow) 18%,transparent) 1px,transparent 1px);background-size:25px 25px;mask-image:linear-gradient(90deg,transparent,#000 25%,#000)}\n      .overall-entry.cosmetic-stripe-circuit::before{background:radial-gradient(circle at 72% 30%,var(--cosmetic-glow) 0 3px,transparent 4px),radial-gradient(circle at 88% 72%,var(--cosmetic-glow) 0 3px,transparent 4px),linear-gradient(90deg,transparent 60%,color-mix(in srgb,var(--cosmetic-glow) 40%,transparent) 60% 60.5%,transparent 60.5%),linear-gradient(155deg,transparent 73%,color-mix(in srgb,var(--cosmetic-glow) 35%,transparent) 73% 74%,transparent 74%)}\n      .overall-entry.cosmetic-stripe-gold::before{background:linear-gradient(110deg,transparent 0 56%,rgba(255,238,146,.42) 56% 59%,transparent 59% 68%,rgba(255,200,62,.28) 68% 75%,transparent 75%)}\n      .overall-entry.cosmetic-stripe-beta::before{background:repeating-linear-gradient(125deg,transparent 0 34px,rgba(255,130,217,.3) 35px 43px,rgba(126,231,255,.24) 44px 52px,transparent 53px 80px)}\n      .profile-cosmetic-choice.cosmetic-stripe-gold .profile-cosmetic-preview{background:linear-gradient(105deg,#a47c1d,#3d396a)}\n      .profile-cosmetic-choice.cosmetic-stripe-beta .profile-cosmetic-preview{background:linear-gradient(105deg,#a23b8d,#176588)}\n      .profile-cosmetic-choice.cosmetic-stripe-chevron .profile-cosmetic-preview i{background:repeating-linear-gradient(135deg,transparent 0 10px,rgba(126,231,255,.65) 11px 15px,transparent 16px 24px)}\n      .profile-cosmetic-choice.cosmetic-stripe-grid .profile-cosmetic-preview i{background:linear-gradient(rgba(126,231,255,.5) 1px,transparent 1px),linear-gradient(90deg,rgba(126,231,255,.5) 1px,transparent 1px);background-size:10px 10px}\n      .profile-cosmetic-choice.cosmetic-stripe-circuit .profile-cosmetic-preview i{background:radial-gradient(circle at 70% 25%,#7ee7ff 0 2px,transparent 3px),linear-gradient(160deg,transparent 55%,#7ee7ff 56% 59%,transparent 60%)}\n      .sq-reduced-effects .overall-entry.cosmetic-stripe-beta::before{animation:none!important}\n      .sq-plain-racer-themes .overall-entry[class*='cosmetic-stripe-']::before{display:none!important}\n      .leaderboard-ui>.container>button.main.sq-racer-cosmetic.cosmetic-stripe-cyan::before{background:repeating-linear-gradient(112deg,transparent 0 32px,color-mix(in srgb,var(--cosmetic-glow) 30%,transparent) 33px 37px,transparent 38px 58px)}\n      .leaderboard-ui>.container>button.main.sq-racer-cosmetic.cosmetic-stripe-chevron::before{background:repeating-linear-gradient(135deg,transparent 0 28px,color-mix(in srgb,var(--cosmetic-glow) 22%,transparent) 29px 40px,transparent 41px 62px)}\n      .leaderboard-ui>.container>button.main.sq-racer-cosmetic.cosmetic-stripe-sunset::before{background:linear-gradient(100deg,transparent 0 36%,rgba(255,206,111,.25) 36% 40%,transparent 40% 58%,rgba(255,112,92,.3) 58% 63%,transparent 63%)}\n      .leaderboard-ui>.container>button.main.sq-racer-cosmetic.cosmetic-stripe-grid::before{background:linear-gradient(color-mix(in srgb,var(--cosmetic-glow) 18%,transparent) 1px,transparent 1px),linear-gradient(90deg,color-mix(in srgb,var(--cosmetic-glow) 18%,transparent) 1px,transparent 1px);background-size:24px 24px}\n      .leaderboard-ui>.container>button.main.sq-racer-cosmetic.cosmetic-stripe-circuit::before{background:radial-gradient(circle at 72% 30%,var(--cosmetic-glow) 0 3px,transparent 4px),radial-gradient(circle at 88% 72%,var(--cosmetic-glow) 0 3px,transparent 4px),linear-gradient(155deg,transparent 72%,color-mix(in srgb,var(--cosmetic-glow) 35%,transparent) 73% 74%,transparent 75%)}\n      .leaderboard-ui>.container>button.main.sq-racer-cosmetic.cosmetic-stripe-gold::before{background:linear-gradient(110deg,transparent 0 55%,rgba(255,238,146,.45) 56% 60%,transparent 61% 69%,rgba(255,200,62,.3) 70% 77%,transparent 78%)}\n      .leaderboard-ui>.container>button.main.sq-racer-cosmetic.cosmetic-stripe-beta::before{background:repeating-linear-gradient(125deg,transparent 0 34px,rgba(255,130,217,.32) 35px 43px,rgba(126,231,255,.26) 44px 52px,transparent 53px 80px)}\n      .profile-cosmetic-choice.cosmetic-stripe-cyan .profile-row-preview i{background:repeating-linear-gradient(112deg,transparent 0 20px,rgba(126,245,255,.32) 21px 24px,transparent 25px 38px),var(--row-base)}\n      .profile-cosmetic-choice.cosmetic-stripe-chevron .profile-row-preview i{background:repeating-linear-gradient(135deg,transparent 0 14px,rgba(126,231,255,.34) 15px 21px,transparent 22px 31px),var(--row-base)}\n      .profile-cosmetic-choice.cosmetic-stripe-sunset .profile-row-preview i{background:linear-gradient(100deg,transparent 0 34%,rgba(255,205,111,.38) 35% 42%,transparent 43% 60%,rgba(255,108,88,.4) 61% 70%,transparent 71%),var(--row-base)}\n      .profile-cosmetic-choice.cosmetic-stripe-grid .profile-row-preview i{background:linear-gradient(rgba(126,231,255,.22) 1px,transparent 1px),linear-gradient(90deg,rgba(126,231,255,.22) 1px,transparent 1px),var(--row-base);background-size:10px 10px,10px 10px,auto}\n      .profile-cosmetic-choice.cosmetic-stripe-circuit .profile-row-preview i{background:radial-gradient(circle at 74% 25%,#7ee7ff 0 2px,transparent 3px),linear-gradient(158deg,transparent 60%,rgba(126,231,255,.38) 61% 64%,transparent 65%),var(--row-base)}\n      .profile-cosmetic-choice.cosmetic-stripe-gold .profile-row-preview i{background:linear-gradient(110deg,transparent 0 45%,rgba(255,238,146,.5) 46% 53%,transparent 54% 64%,rgba(255,200,62,.36) 65% 76%,transparent 77%),var(--row-base)}\n      .profile-cosmetic-choice.cosmetic-stripe-beta .profile-row-preview i{background:repeating-linear-gradient(125deg,transparent 0 17px,rgba(255,130,217,.36) 18px 24px,rgba(126,231,255,.3) 25px 31px,transparent 32px 45px),var(--row-base)}\n      .overall-entry.cosmetic-stripe-apex::before,.leaderboard-ui>.container>button.main.sq-racer-cosmetic.cosmetic-stripe-apex::before{background:linear-gradient(118deg,transparent 0 58%,color-mix(in srgb,var(--cosmetic-glow) 52%,transparent) 59% 63%,transparent 64%),linear-gradient(118deg,transparent 0 72%,color-mix(in srgb,var(--cosmetic-glow) 28%,transparent) 73% 76%,transparent 77%)}\n      .overall-entry.cosmetic-stripe-split::before,.leaderboard-ui>.container>button.main.sq-racer-cosmetic.cosmetic-stripe-split::before{background:linear-gradient(105deg,transparent 0 47%,color-mix(in srgb,var(--cosmetic-glow) 42%,transparent) 48% 52%,rgba(255,255,255,.08) 53% 70%,transparent 71%)}\n      .overall-entry.cosmetic-stripe-scan::before,.leaderboard-ui>.container>button.main.sq-racer-cosmetic.cosmetic-stripe-scan::before{background:repeating-linear-gradient(0deg,transparent 0 5px,color-mix(in srgb,var(--cosmetic-glow) 22%,transparent) 6px 7px)}\n      .overall-entry.cosmetic-stripe-blocks::before,.leaderboard-ui>.container>button.main.sq-racer-cosmetic.cosmetic-stripe-blocks::before{background:linear-gradient(90deg,transparent 0 54%,color-mix(in srgb,var(--cosmetic-glow) 22%,transparent) 54% 64%,transparent 64% 68%,color-mix(in srgb,var(--cosmetic-glow) 34%,transparent) 68% 81%,transparent 81%)}\n      .cosmetic-stripe-cyan .showcase-row::before{background:repeating-linear-gradient(112deg,transparent 0 32px,color-mix(in srgb,var(--show-accent) 30%,transparent) 33px 37px,transparent 38px 58px)}\n      .cosmetic-stripe-apex .showcase-row::before{background:linear-gradient(118deg,transparent 0 58%,color-mix(in srgb,var(--show-accent) 52%,transparent) 59% 63%,transparent 64%),linear-gradient(118deg,transparent 0 72%,color-mix(in srgb,var(--show-accent) 28%,transparent) 73% 76%,transparent 77%)}\n      .cosmetic-stripe-chevron .showcase-row::before{background:repeating-linear-gradient(135deg,transparent 0 28px,color-mix(in srgb,var(--show-accent) 25%,transparent) 29px 40px,transparent 41px 62px)}\n      .cosmetic-stripe-sunset .showcase-row::before{background:linear-gradient(100deg,transparent 0 36%,rgba(255,206,111,.34) 36% 40%,transparent 40% 58%,rgba(255,112,92,.38) 58% 63%,transparent 63%)}\n      .cosmetic-stripe-split .showcase-row::before{background:linear-gradient(105deg,transparent 0 47%,color-mix(in srgb,var(--show-accent) 42%,transparent) 48% 52%,rgba(255,255,255,.08) 53% 70%,transparent 71%)}\n      .cosmetic-stripe-grid .showcase-row::before{background:linear-gradient(color-mix(in srgb,var(--show-accent) 18%,transparent) 1px,transparent 1px),linear-gradient(90deg,color-mix(in srgb,var(--show-accent) 18%,transparent) 1px,transparent 1px);background-size:22px 22px}\n      .cosmetic-stripe-circuit .showcase-row::before{background:radial-gradient(circle at 72% 30%,var(--show-accent) 0 3px,transparent 4px),linear-gradient(155deg,transparent 72%,color-mix(in srgb,var(--show-accent) 38%,transparent) 73% 74%,transparent 75%)}\n      .cosmetic-stripe-scan .showcase-row::before{background:repeating-linear-gradient(0deg,transparent 0 5px,color-mix(in srgb,var(--show-accent) 22%,transparent) 6px 7px)}\n      .cosmetic-stripe-blocks .showcase-row::before{background:linear-gradient(90deg,transparent 0 54%,color-mix(in srgb,var(--show-accent) 22%,transparent) 54% 64%,transparent 64% 68%,color-mix(in srgb,var(--show-accent) 34%,transparent) 68% 81%,transparent 81%)}\n      .cosmetic-stripe-gold .showcase-row::before{background:linear-gradient(110deg,transparent 0 55%,rgba(255,238,146,.48) 56% 60%,transparent 61% 69%,rgba(255,200,62,.34) 70% 77%,transparent 78%)}\n      .cosmetic-stripe-beta .showcase-row::before{background:repeating-linear-gradient(125deg,transparent 0 34px,rgba(255,130,217,.36) 35px 43px,rgba(126,231,255,.3) 44px 52px,transparent 53px 80px)}\n      .profile-cosmetic-choice.cosmetic-stripe-apex .profile-cosmetic-preview i{background:linear-gradient(118deg,transparent 0 51%,#8cefff 52% 60%,transparent 61%)}\n      .profile-cosmetic-choice.cosmetic-stripe-split .profile-cosmetic-preview i{background:linear-gradient(105deg,transparent 0 43%,#8cefff 44% 53%,rgba(255,255,255,.18) 54% 72%,transparent 73%)}\n      .profile-cosmetic-choice.cosmetic-stripe-scan .profile-cosmetic-preview i{background:repeating-linear-gradient(0deg,transparent 0 5px,rgba(126,231,255,.7) 6px 7px)}\n      .profile-cosmetic-choice.cosmetic-stripe-blocks .profile-cosmetic-preview i{background:linear-gradient(90deg,transparent 0 35%,rgba(126,231,255,.45) 36% 55%,transparent 56% 63%,rgba(126,231,255,.7) 64% 85%,transparent 86%)}\n      .overall-profile-card[class*='cosmetic-stripe-'] .profile-hero{background-image:var(--profile-pattern,none);background-size:var(--profile-pattern-size,auto)}\n      .overall-profile-card.cosmetic-stripe-cyan{--profile-pattern:repeating-linear-gradient(112deg,transparent 0 46px,color-mix(in srgb,var(--profile-accent) 15%,transparent) 47px 52px,transparent 53px 82px)}\n      .overall-profile-card.cosmetic-stripe-apex{--profile-pattern:linear-gradient(118deg,transparent 0 68%,color-mix(in srgb,var(--profile-accent) 24%,transparent) 69% 72%,transparent 73%)}\n      .overall-profile-card.cosmetic-stripe-chevron{--profile-pattern:repeating-linear-gradient(135deg,transparent 0 38px,color-mix(in srgb,var(--profile-accent) 14%,transparent) 39px 52px,transparent 53px 78px)}\n      .overall-profile-card.cosmetic-stripe-grid{--profile-pattern:linear-gradient(color-mix(in srgb,var(--profile-accent) 10%,transparent) 1px,transparent 1px),linear-gradient(90deg,color-mix(in srgb,var(--profile-accent) 10%,transparent) 1px,transparent 1px);--profile-pattern-size:28px 28px}\n      .overall-profile-card.cosmetic-stripe-circuit{--profile-pattern:radial-gradient(circle at 72% 30%,color-mix(in srgb,var(--profile-accent) 40%,transparent) 0 4px,transparent 5px),linear-gradient(155deg,transparent 72%,color-mix(in srgb,var(--profile-accent) 18%,transparent) 73% 74%,transparent 75%)}\n      .overall-profile-card.cosmetic-stripe-scan{--profile-pattern:repeating-linear-gradient(0deg,transparent 0 7px,color-mix(in srgb,var(--profile-accent) 10%,transparent) 8px 9px)}\n      .overall-profile-card.cosmetic-stripe-blocks{--profile-pattern:linear-gradient(90deg,transparent 0 52%,color-mix(in srgb,var(--profile-accent) 15%,transparent) 53% 65%,transparent 66% 70%,color-mix(in srgb,var(--profile-accent) 22%,transparent) 71% 84%,transparent 85%)}\n      @media(max-width:620px){.overall-category-select select{min-width:150px}}\n      .overall-category-select{display:inline-flex;align-items:center;gap:10px;padding:5px 6px 5px 12px;background:#22366f;color:#9feaff;font-size:13px;letter-spacing:.7px}\n      .overall-category-select select{min-width:190px;height:34px;padding:0 34px 0 11px;border:1px solid rgba(126,231,255,.45);border-radius:0;background:#111c45;color:#fff;font:16px ForcedSquare,Arial,sans-serif;cursor:pointer}\n      @media(max-width:620px){.overall-category-select{width:100%;justify-content:space-between}}\n      @media(max-width:620px){.overall-category-select select{min-width:0;flex:1}}\n      .overall-footer-tools .overall-category-select{min-width:290px}\n      @media(max-width:1000px){.overall-footer-tools .overall-category-select{min-width:0}}\n      @media(max-width:620px){.overall-footer-tools .overall-category-select{width:100%}}\n      .overall-footer-tools .overall-category-select{min-width:0!important;background:#1b2d61}\n      .overall-footer-tools .overall-category-select{grid-column:2;justify-self:center;min-width:310px!important}\n      .overall-category-select span{font-weight:700}\n      .overall-category-select select{font-size:17px!important}\n      @media(max-width:900px){.overall-footer-tools .overall-category-select{grid-column:1;grid-row:1;min-width:0!important;width:100%}}\n      @media(max-width:620px){.overall-footer-tools .overall-category-select{grid-column:1!important;justify-self:stretch!important}}\n      @media(max-width:620px){.overall-footer-tools .overall-category-select{grid-row:1}}\n      .overall-footer-right .overall-category-select{grid-row:1;width:100%;justify-content:space-between;background:#1b2d61}\n      .overall-footer-right .overall-category-select select{flex:1;min-width:0}\n      @media(max-width:900px){.overall-footer-right .overall-category-select{grid-column:1;grid-row:1}}\n      @media(max-width:620px){.overall-footer-right .overall-category-select{grid-column:1;grid-row:auto}}\n      .overall-category-select{grid-column:1/-1;display:grid!important;grid-template-columns:auto 1fr!important;padding:7px 8px 7px 13px!important}\n      .overall-category-select>span{font-size:15px;letter-spacing:1.2px}\n      .overall-category-select select{width:100%;min-width:0!important;height:42px!important;font-size:19px!important}\n      @media(max-height:820px) and (min-width:901px){.overall-category-select select{height:36px!important}}\n      @media(max-width:620px){.overall-category-select select{font-size:16px!important}}\n      .overall-category-select{display:grid!important;grid-template-columns:auto minmax(0,1fr)!important;align-items:center!important;gap:10px!important;width:100%!important;min-width:0!important;padding:7px 8px 7px 12px!important;border:1px solid rgba(126,231,255,.28);border-radius:2px;background:#1d3269!important}\n      .overall-category-select>span{font-size:14px!important;white-space:nowrap}\n      .overall-category-select select{width:100%!important;min-width:0!important;height:42px!important;padding:0 36px 0 12px!important;border:1px solid rgba(126,231,255,.45)!important;border-radius:2px!important;background:#0f1d44!important;color:#fff!important;font-size:18px!important}\n      .overall-category-select select:focus{outline:2px solid #7ee7ff;outline-offset:2px}\n      @media(max-width:1100px){.overall-footer-right .overall-category-select{grid-column:1;grid-row:1}}\n      .overall-category-select{box-sizing:border-box!important}\n      @media(max-width:700px){.overall-footer-right .overall-category-select{grid-column:1!important;grid-row:auto!important}}\n      @media(max-width:700px){.overall-category-select{grid-column:1!important;grid-row:auto!important;grid-template-columns:82px minmax(0,1fr)!important;min-height:48px!important}}\n      @media(max-width:700px){.overall-category-select>span{font-size:12px!important}}\n      @media(max-width:700px){.overall-category-select select{height:40px!important;font-size:16px!important}}\n      .overall-category-control{display:grid;grid-template-columns:minmax(0,1fr) 44px;gap:7px;align-items:stretch}\n      @media(max-width:1100px){.overall-footer-right .overall-category-control{grid-column:1;grid-row:1}}\n      @media(max-width:700px){.overall-footer-right .overall-category-control{grid-column:1!important;grid-row:auto!important;grid-template-columns:minmax(0,1fr) 44px}}\n      .overall-category-control{position:relative;grid-template-columns:minmax(0,1fr)!important;gap:0!important}\n      .overall-category-select select{padding-right:54px!important}\n      .cosmetic-stripe-cyan .np-preview::before{background:repeating-linear-gradient(112deg,transparent 0 22px,color-mix(in srgb,var(--fx-accent,#7ee7ff) 30%,transparent) 23px 26px,transparent 27px 40px)}\n      /* Picker only: Clean and Speed lines shared one blank chip, so the two were\n         indistinguishable in the list. Rows are untouched by this. */\n      .profile-cosmetic-choice.cosmetic-stripe-cyan .profile-cosmetic-preview i{background:repeating-linear-gradient(112deg,transparent 0 7px,rgba(126,231,255,.7) 8px 11px,transparent 12px 19px)}\n\n      .overall-category-control{position:relative}\n      .overall-category-control::after{content:attr(data-tip);position:absolute;z-index:40;right:0;bottom:calc(100% + 8px);box-sizing:border-box;width:min(340px,78vw);padding:10px 12px;border:1px solid #7ee7ff;background:#0d193c;color:#fff;font:13px/1.35 ForcedSquare,Arial,sans-serif;text-align:left;opacity:0;transform:translateY(6px);transition:opacity .14s ease,transform .14s ease;pointer-events:none}\n      .overall-category-control:hover::after,.overall-category-control:focus-within::after{opacity:1;transform:translateY(0)}\n\n    ";
    style.textContent += ".overall-help-card{background:#1d2c5c!important;backdrop-filter:none!important}.overall-help-actions{position:sticky;bottom:0;background:#1d2c5c;padding:10px!important;z-index:4}" ;
    style.textContent += "/* RC menu readability: scoped to custom menus, not driving HUD or game geometry. */\n#overallTrackScope[hidden],.studio-panel[hidden],.studio-track-options[hidden],.sq-category-submenu[hidden]{display:none!important}\n.profile-dialog-toolbar{position:sticky;top:-22px;z-index:15;display:flex;align-items:center;justify-content:space-between;gap:12px;margin:-22px -24px 18px;padding:10px 18px;background:#172650;border-bottom:2px solid #628dc0}\n.profile-dialog-toolbar>span{color:#b8dafa;font-size:18px;letter-spacing:.6px}\n#overallProfileClose{position:static!important;min-height:44px!important;min-width:90px!important;margin:0!important;font-size:20px!important}\n.profile-customizer>summary{min-height:64px!important;padding:14px 16px!important;gap:16px}\n.profile-customizer>summary b{font-size:23px!important}.profile-customizer>summary small{font-size:14px!important;line-height:1.4}\n.profile-customizer[open] .studio-open-label{font-size:0}.profile-customizer[open] .studio-open-label:after{content:'Close';font-size:13px}\n.profile-cosmetic-group>div{grid-template-columns:repeat(auto-fill,minmax(108px,1fr))!important;gap:8px!important}\n.profile-cosmetic-group.variant-text>div{grid-template-columns:repeat(auto-fill,minmax(145px,1fr))!important}\n.profile-cosmetic-group legend{font-size:18px!important}.profile-cosmetic-group>p{font:14px/1.45 'Trebuchet MS',sans-serif!important;color:#cad9ee!important;margin:5px 0 12px!important}\n.profile-cosmetic-choice{min-height:88px!important;padding:9px!important;gap:8px!important;border:1px solid #476396!important;border-radius:2px}\n.profile-cosmetic-choice>b{font:700 14px/1.25 'Trebuchet MS',sans-serif!important}.profile-cosmetic-choice>small{font:12px/1.2 'Trebuchet MS',sans-serif!important}\n.profile-cosmetic-choice .profile-cosmetic-preview{min-height:38px!important}.profile-cosmetic-choice:disabled{opacity:.62!important}.profile-cosmetic-choice.selected{outline:2px solid #7ee7ff;outline-offset:-2px}\n.profile-cosmetic-choice:focus-visible,.studio-tab:focus-visible,.profile-favorite-track input:focus-visible{outline:3px solid #fff!important;outline-offset:2px}\n.variant-text .profile-cosmetic-choice{min-height:52px!important}.profile-cosmetic-podium .button{font-size:17px!important;white-space:normal!important;line-height:1.25!important;min-height:48px!important}\n.profile-customizer-actions [role='status']{font:14px/1.4 'Trebuchet MS',sans-serif!important}.profile-customizer-actions{grid-template-columns:1fr!important}.profile-customizer-actions .button{width:100%;font-size:18px!important}\n.profile-preview-stage{min-height:96px!important}.showcase-row{min-height:60px!important}.showcase-row>span>b{font-size:16px!important}.showcase-row>span>small{font:12px/1.3 'Trebuchet MS',sans-serif!important}\n.studio-tabs{gap:6px!important}.studio-tab{min-height:48px!important;font-size:15px!important}\n.profile-favorite-track{position:relative}.profile-favorite-track input{width:100%;box-sizing:border-box;min-height:48px!important;font:17px/1.4 'Trebuchet MS',sans-serif!important}\n.studio-track-options{position:relative;z-index:5;width:100%;max-height:240px;overflow:auto;box-sizing:border-box;border:1px solid #86ccec;background:#14264e;margin-top:4px;scrollbar-color:#709ccd #14264e}\n.studio-track-options button{width:100%;min-height:44px;display:flex;align-items:center;justify-content:space-between;gap:10px;border:0;border-bottom:1px solid #354b72;padding:9px 12px;background:transparent;color:#fff;text-align:left;font:16px/1.3 'Trebuchet MS',sans-serif}\n.studio-track-options button small{font-size:12px;color:#adcce8}.studio-track-options button:hover,.studio-track-options button[aria-selected='true']{background:#2d5485;color:#fff}\n#overallProfilePopup .profile-stat-primary b{font-size:clamp(23px,2vw,32px)!important;line-height:1.2!important;overflow-wrap:anywhere}.profile-stat-primary span{min-width:0!important}\n.overall-help-content p{line-height:1.5!important}.overall-entry:focus-visible{outline:3px solid #fff;outline-offset:-3px}\n@media(max-width:900px){.profile-customizer-preview{position:static!important}.profile-customizer-body{gap:16px!important}.profile-customizer-preview .profile-preview-stage{padding:8px!important}.profile-customizer-preview{padding:10px!important}.profile-preview-stage>span b{font-size:18px!important}}\n@media(max-width:600px){\n.profile-dialog-toolbar{top:-14px;margin:-14px -14px 12px;padding:8px 12px}.profile-dialog-toolbar>span{font-size:16px}\n.profile-customizer-body{padding:10px!important}.profile-cosmetic-group{padding:10px!important}.profile-cosmetic-group>div{grid-template-columns:repeat(2,minmax(0,1fr))!important}.profile-cosmetic-group.variant-text>div{grid-template-columns:repeat(2,minmax(0,1fr))!important}\n.profile-cosmetic-choice>b{font-size:14px!important}.profile-customizer>summary small{font:13px/1.35 'Trebuchet MS',sans-serif!important}.profile-preview-stage{min-height:80px!important}.profile-customizer-preview header small{font:12px/1.3 'Trebuchet MS',sans-serif!important}.competition-track-main{flex-direction:column!important;align-items:flex-start!important;gap:2px!important}.competition-kicker{font-size:10px!important}.competition-track-name{font-size:16px!important;min-height:44px!important;padding:4px 0!important;white-space:normal!important;text-align:left!important}.competition-result{font:11px/1.3 'Trebuchet MS',sans-serif!important;white-space:normal!important}\n.overall-page-status{font-size:13px!important;min-width:0!important}.overall-freshness{font:12px/1.35 'Trebuchet MS',sans-serif!important;min-height:44px!important}.overall-pager{padding:4px!important;gap:8px!important}.overall-page-button{width:44px!important;min-width:44px!important;min-height:44px!important}\n}\n@media(max-height:500px){.overall-top{padding:8px 14px!important}.overall-top h2{font-size:27px!important}.overall-action-btn{min-height:40px!important;font-size:16px!important}.profile-customizer-preview{position:static!important}}\n@media(prefers-reduced-motion:reduce){.overall-entry,.overall-shell{animation:none!important;opacity:1!important;transform:none!important}.profile-cosmetic-choice,.overall-car-model>img{transition:none!important}}\r\n";
    style.textContent += "@media(max-width:600px){\n.profile-customizer-preview .profile-preview-stage{min-height:64px!important;padding:4px!important}.profile-customizer-preview .profile-preview-stage .overall-car-model{width:64px!important;height:64px!important;min-width:64px!important}\n.profile-customizer-preview header{margin-bottom:6px!important}.profile-customizer-preview header small{display:none!important}\n.profile-row-showcase{gap:4px!important;margin:6px 0!important}.profile-row-showcase .showcase-row{min-height:40px!important;padding:4px 6px!important;grid-template-columns:30px minmax(0,1fr) 42px!important}\n.profile-row-showcase .showcase-row>span>b{font-size:13px!important}.profile-row-showcase .showcase-row>span>small{font-size:11px!important}.profile-row-showcase .showcase-meta,.profile-row-showcase .showcase-badges{display:none!important}\n.profile-customizer-actions{gap:6px!important;margin-top:6px!important}.profile-customizer-actions [role=status]{font-size:12px!important}.profile-customizer-actions .button{min-height:44px!important}\n.track-info-ui>.side-panel>.thumbnail{min-width:0!important;min-height:0!important;box-sizing:border-box!important;padding:0!important;border:0!important;width:72px!important;height:72px!important}\n.track-info-ui .leaderboard-ui button.main .verified-state{width:100%!important;min-width:0!important;box-sizing:border-box!important;padding:3px!important;white-space:normal!important;flex-wrap:wrap!important;height:auto!important;max-height:none!important;line-height:1.3!important}\n.track-info-ui .leaderboard-ui button.main .sq-integrity-label{flex:none!important;font:700 11px/1.2 'Trebuchet MS',sans-serif!important}\n}\r\n";
    style.textContent += "@media(max-width:600px){}\nhtml:has(#overallLeaderboardPanel[style*=\"display: flex\"]),body:has(#overallLeaderboardPanel[style*=\"display: flex\"]){overflow-x:hidden!important}\r\n";
    style.textContent += "@media(max-width:800px){\nbody>div:has(>.menu-ui>.settings-menu-ui){transform:none!important;width:100%!important;height:100%!important}\n.menu-ui>.settings-menu-ui{position:fixed!important;inset:0!important;width:100%!important;max-width:100vw!important;height:100dvh!important;min-width:0!important;transform:none!important;margin:0!important;box-sizing:border-box!important;display:flex!important;flex-direction:column!important}\n.settings-menu-ui>h2{font-size:28px!important;flex:none;margin:0!important;padding:12px!important}\n.settings-menu-ui>.container{flex:1 1 auto!important;min-height:0!important;width:100%!important;box-sizing:border-box!important;margin:0!important;padding:10px!important;overflow:auto!important}\n.settings-menu-ui>.button-wrapper{flex:0 0 auto!important;position:static!important;display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr))!important;width:100%!important;box-sizing:border-box!important;padding:8px!important;gap:6px!important;margin:0!important}\n.settings-menu-ui>.button-wrapper>.button{position:static!important;width:100%!important;min-width:0!important;margin:0!important;padding:8px 4px!important;font-size:18px!important;min-height:44px!important;transform:none!important}.settings-menu-ui>.button-wrapper .button-icon{width:18px!important;height:18px!important}\n.settings-menu-ui .setting{min-width:0!important;box-sizing:border-box!important;gap:8px!important;flex-wrap:wrap!important}.settings-menu-ui .setting>p{min-width:0!important;font-size:17px!important}.settings-menu-ui .setting>.button-wrapper{min-width:0!important;display:flex!important;flex-wrap:wrap!important;gap:4px!important}.settings-menu-ui .setting .button{font-size:18px!important;padding:7px!important;min-height:40px!important;margin:0!important}\n#sqRankedSettings .sq-settings-grid{grid-template-columns:1fr!important;gap:6px!important}#sqRankedSettings .sq-setting-row{grid-column:auto!important;min-height:66px!important;padding:10px!important;display:flex!important;align-items:center!important;justify-content:space-between!important}#sqRankedSettings .sq-setting-row>p{flex:1;min-width:100px!important;margin:0!important}#sqRankedSettings .sq-setting-secret{display:block!important}#sqRankedSettings .sq-secret-controls{display:flex!important;gap:6px!important}#sqRankedSettings input{min-width:0!important;max-width:100%!important}#sqRankedSettings .sq-settings-note{font:14px/1.4 'Trebuchet MS',sans-serif!important}\n}\r\n";
    style.textContent += "body>div:has(.multiplayer-ui>.join:not(.hidden)),body>div:has(.multiplayer-ui>.host:not(.hidden)){transform:none!important;width:100%!important;height:100%!important}\n.multiplayer-ui:has(>.join:not(.hidden),>.host:not(.hidden)){position:fixed!important;inset:0!important;width:100%!important;height:100dvh!important;box-sizing:border-box!important;display:flex!important;flex-direction:column!important;align-items:center!important;gap:16px!important;padding:24px 16px!important;overflow:auto!important;background:#202e58;transform:none!important;z-index:100}\n.multiplayer-ui>.join:not(.hidden),.multiplayer-ui>.host:not(.hidden){position:relative!important;inset:auto!important;transform:none!important;width:min(760px,100%)!important;min-width:0!important;height:auto!important;flex:0 0 auto!important;margin:0!important;padding-bottom:0!important;box-sizing:border-box!important}\n.multiplayer-ui>.join>.main-box,.multiplayer-ui>.host>.main-box{position:relative!important;inset:auto!important;transform:none!important;width:100%!important;min-width:0!important;height:auto!important;box-sizing:border-box!important;margin:0!important}\n.multiplayer-ui>.sq-multiplayer-relay,.multiplayer-ui>.sq-multiplayer-relay.is-collapsed{position:relative!important;inset:auto!important;transform:none!important;width:min(760px,100%)!important;max-height:none!important;flex:0 0 auto!important;margin:0!important;clip-path:none!important;box-shadow:none!important}\n.multiplayer-ui .buttons{display:flex!important;gap:8px!important;position:static!important;padding:12px!important;box-sizing:border-box!important}.multiplayer-ui .buttons>.button{position:static!important;min-height:44px!important;flex:1!important;font-size:23px!important;margin:0!important;transform:none!important}.multiplayer-ui .buttons img{width:22px!important;height:22px!important}\n.sq-multiplayer-path>div>span,.sq-multiplayer-intro,.sq-multiplayer-note{font:14px/1.4 'Trebuchet MS',sans-serif!important}.sq-multiplayer-path>div>b{font-size:19px!important}\n@media(max-width:600px){.multiplayer-ui:has(>.join:not(.hidden),>.host:not(.hidden)){padding:8px!important;gap:8px!important}.multiplayer-ui .main-box>h2{font-size:24px!important;white-space:normal!important;margin:0!important;padding:12px!important}.multiplayer-ui .invite-code-container{margin:12px!important;width:auto!important}.multiplayer-ui .invite-code{width:100%!important;box-sizing:border-box!important;min-width:0!important;font-size:24px!important;padding:10px!important}.multiplayer-ui .experimental-warning{font-size:15px!important;padding:8px 12px!important;margin:0!important}.multiplayer-ui .experimental-warning img{width:20px!important;height:20px!important}.multiplayer-ui .buttons>.button{font-size:19px!important;min-width:0!important;padding:8px!important}.sq-multiplayer-relay .sq-multiplayer-path{padding:10px!important}.sq-multiplayer-relay .sq-multiplayer-path>div>span{font-size:13px!important}.multiplayer-ui .game-mode-container,.multiplayer-ui .maximum-players-container{padding:10px!important;margin:0!important}.multiplayer-ui .track-button{max-width:calc(100% - 20px)!important;margin:10px!important;box-sizing:border-box!important}}\r\n";
    style.textContent += ".studio-discard{background:#263963!important;color:#cbdff8!important;font-size:15px!important}\n@media(max-height:500px) and (min-width:600px){#overallDailyGrid .overall-arcade{display:none!important}#overallDailyGrid .overall-center-tools,#overallDailyGrid .overall-footer-right{grid-row:1!important;margin:0!important}#overallDailyGrid .overall-center-tools{grid-column:1!important}#overallDailyGrid .overall-footer-right{grid-column:2!important}#overallDailyGrid .overall-pager{padding:2px!important}#overallDailyGrid .overall-freshness{padding:4px!important;min-height:28px!important;font-size:12px!important}.overall-entry{min-height:82px!important;padding-top:5px!important;padding-bottom:5px!important}.overall-entry .overall-car-model{height:64px!important;width:64px!important}.overall-entry .overall-best-line{font-size:14px!important}.overall-entry .overall-rank{font-size:27px!important}}\r\n";
    style.textContent += "body:has(#overallLeaderboardPanel[style*=\"display: flex\"]) .menu-ui{contain:paint!important;overflow:hidden!important;max-width:100vw!important}\n.profile-customizer-actions .studio-discard{background:#263963!important;color:#cbdff8!important;font-size:15px!important;border:1px solid #617798!important}\n@media(max-height:500px) and (min-width:600px){#overallDailyGrid .leaderboard-arcade{display:none!important}#overallDailyGrid .overall-center-tools{display:grid!important;grid-template-rows:44px 32px!important;min-height:0!important;padding:3px!important;gap:3px!important}#overallDailyGrid .overall-pager{min-height:0!important;height:44px!important;margin:0!important;padding:0!important}#overallDailyGrid .overall-page-button{height:40px!important;min-height:40px!important}#overallDailyGrid .overall-page-status{font-size:14px!important;line-height:1.2!important;padding:3px!important}#overallDailyGrid .overall-freshness{box-sizing:border-box!important;height:32px!important;min-height:0!important;margin:0!important;white-space:normal!important;line-height:1.2!important;font:12px/1.2 'Trebuchet MS',sans-serif!important;padding:3px!important}#overallDailyGrid .overall-footer-right{align-self:center!important}.overall-entry .overall-car-model{min-height:64px!important;min-width:64px!important}}\n.multiplayer-ui .invite-code{transform:none!important;max-width:100%!important}\r\n";
    style.textContent += ".profile-route-priorities:has(.profile-guide-empty)>p{display:none}.profile-route-priorities:has(.profile-guide-empty) .profile-guide-grid{display:block!important}.profile-guide-empty{font:14px/1.4 \"Trebuchet MS\",sans-serif!important;margin:8px 0 0!important;padding:10px!important;max-width:none!important}";
    style.textContent += "\n      .profile-guide-track{font-family:ForcedSquare,Arial,sans-serif!important;min-height:112px}.profile-guide-copy>b{font-size:22px!important}.profile-guide-copy small{font-size:17px!important}\n      .profile-helpfulness{min-width:84px;display:flex;flex-direction:column;gap:5px;color:#a1edff}.profile-helpfulness>b{font-size:28px!important}.profile-helpfulness>small{font-size:12px!important}\n      #overallProfilePopup .profile-helpfulness .route-benefit-bar{display:block;height:6px;width:100%;background:linear-gradient(to right,#7ee7ff var(--benefit),#17234f var(--benefit))}\n      .kind-badge .badge-off-control,.kind-title .badge-off-control{grid-column:auto!important;min-height:48px!important;border:2px dashed #91a5cd!important;background:#152342!important;color:#d5deef!important}\n      .kind-badge .badge-off-control.selected,.kind-title .badge-off-control.selected{border-style:solid!important;outline:2px solid #d5deef;outline-offset:2px}\n      @media(max-width:640px){.profile-guide-track{grid-template-columns:56px minmax(0,1fr) 68px!important}.profile-helpfulness{min-width:0}}\n";
    style.textContent += ".competition-local-reset{color:#b5e7ff}@media(max-height:800px) and (min-width:700px){}";
    style.textContent += "#overallProfilePopup .profile-helpfulness b{font:28px/1.1 ForcedSquare,Arial,sans-serif!important}@media(max-width:700px){}";
    style.textContent += "#overallDailyGrid .competition-local-reset{font-size:14px!important;line-height:1.2!important}#overallDailyGrid .competition-kicker{font-size:10px!important;line-height:1.2!important;max-width:none!important}@media(min-width:1000px){}";
    style.textContent += "/* One owner for featured cards and the collapsed planner. Existing game palette and font retained. */\n#overallProfilePopup .profile-track-row.is-null{background:#29354e;border-color:#68788e;color:#d3dae6}#overallProfilePopup .profile-track-row.is-null .profile-track-visual{opacity:.65}\n\n#overallProfilePopup .profile-guide-grid>.profile-guide-track:only-child{grid-column:1/-1}\n@media(min-width:701px){#overallProfilePopup .profile-guide>summary:has(>.route-preview-item:first-child:nth-last-child(2)){grid-template-columns:minmax(0,1fr) 104px!important}#overallProfilePopup .profile-guide>summary:has(>.route-preview-item:first-child:nth-last-child(3)){grid-template-columns:repeat(2,minmax(0,1fr)) 104px!important}}\n#overallLeaderboardPanel #overallDailyGrid {\n  display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr))!important;\n  grid-template-rows:minmax(0,1fr)!important;gap:12px!important;align-items:stretch!important;\n  box-sizing:border-box!important;width:100%!important;height:calc(144px * var(--sq-ui-scale,1))!important;min-height:0!important;max-height:calc(144px * var(--sq-ui-scale,1))!important;\n  flex:0 0 calc(144px * var(--sq-ui-scale,1))!important;padding:10px 14px!important;overflow:visible!important;\n  background:#142149;border-top:1px solid #5876a8;\n}\n#overallDailyGrid .overall-challenge-stack {\n  display:grid!important;grid-template-columns:minmax(0,1fr)!important;grid-template-rows:repeat(2,minmax(0,1fr))!important;\n  grid-column:1!important;grid-row:1!important;gap:8px!important;min-width:0;order:0!important;\n}\n#overallDailyGrid .overall-challenge-stack>section {\n  display:grid!important;grid-template-columns:minmax(0,1fr) 105px!important;align-items:center!important;\n  box-sizing:border-box;min-width:0!important;min-height:0!important;margin:0!important;padding:5px!important;\n  gap:6px!important;grid-column:auto!important;grid-row:auto!important;background:#203363;border:1px solid #5774a8;\n}\n#overallDailyGrid .competition-feature-button {\n  display:grid!important;grid-template-columns:44px minmax(0,1fr)!important;gap:8px!important;align-items:center!important;\n  width:100%;min-width:0;min-height:44px!important;margin:0!important;padding:0!important;\n  color:#fff;background:transparent!important;border:0!important;text-align:left;cursor:pointer;font:inherit;clip-path:none!important;\n}\n#overallDailyGrid .overall-challenge-stack>section:hover {background:#2c457b;border-color:#a8f0ff}\n#overallDailyGrid .competition-feature-button:hover .competition-track-name {color:#a8f0ff!important}\n#overallDailyGrid .competition-feature-button:focus-visible {outline:2px solid #a8f0ff;outline-offset:4px}\n#overallDailyGrid .competition-feature-image {\n  display:grid!important;place-items:center;position:relative!important;width:44px!important;height:44px!important;\n  min-width:0;overflow:hidden;background:#14244c;border:1px solid #425c8e;\n}\n#overallDailyGrid .competition-feature-image img {\n  position:static!important;width:100%!important;height:100%!important;max-width:100%!important;object-fit:contain!important;transform:none!important;\n}\n#overallDailyGrid .competition-feature-copy {display:flex!important;flex-direction:column!important;align-items:flex-start!important;min-width:0!important;gap:3px!important}\n#overallDailyGrid .competition-kicker {font:calc(12px * var(--sq-ui-scale,1))/1.2 ForcedSquare,sans-serif!important;letter-spacing:.06em;max-width:none!important;color:#91dfff;white-space:normal!important}\n#overallDailyGrid .competition-track-name {display:block!important;min-height:0!important;width:auto!important;max-width:100%;padding:0!important;margin:0!important;background:none!important;font:calc(18px * var(--sq-ui-scale,1))/1.2 ForcedSquare,sans-serif!important;color:#fff;overflow-wrap:anywhere;white-space:normal!important}\n#overallDailyGrid .competition-result {display:block!important;grid-column:auto!important;grid-row:auto!important;margin:0!important;padding:0!important;background:none!important;font:calc(14px * var(--sq-ui-scale,1))/1.25 ForcedSquare,sans-serif!important;color:#c4d8f4;white-space:normal!important;text-align:left!important;align-self:flex-start!important}\n#overallDailyGrid .overall-challenge-stack>section>small {display:block!important;grid-column:auto!important;grid-row:auto!important;border-top:0;border-left:1px solid #5875a5;padding:0 0 0 8px!important;margin:0!important;text-align:left!important;font:calc(11px * var(--sq-ui-scale,1))/1.25 ForcedSquare,sans-serif!important;color:#adbfdb;white-space:normal!important}\n#overallDailyGrid .competition-local-reset {font:calc(12px * var(--sq-ui-scale,1))/1.3 ForcedSquare,sans-serif!important;color:#d2edff}\n#overallDailyGrid .overall-center-tools {grid-column:2!important;grid-row:1!important;align-self:center!important;min-width:0!important;margin:0!important}\n#overallDailyGrid .overall-footer-right {grid-column:3!important;grid-row:1!important;align-self:center!important;min-width:0!important;margin:0!important}\n#overallProfilePopup .profile-guide {border:2px solid #8ddfff;box-shadow:0 0 0 4px #101d40;background:#172953}\n#overallProfilePopup .profile-guide>summary {\n  display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr)) 104px!important;grid-auto-rows:minmax(104px,auto)!important;\n  align-items:stretch!important;gap:8px!important;padding:10px!important;list-style:none;cursor:pointer;\n}\n#overallProfilePopup .profile-guide>summary::-webkit-details-marker {display:none}\n#overallProfilePopup .profile-guide>summary:focus-visible {outline:3px solid #a8f0ff;outline-offset:3px}\n#overallProfilePopup .route-preview-item {\n  display:flex!important;flex-direction:row!important;align-items:center!important;justify-content:flex-start!important;\n  min-width:0!important;min-height:104px!important;box-sizing:border-box;padding:10px!important;gap:10px;\n  background:#203663;border:1px solid #5475a8;border-top:2px solid #8ddfff;\n}\n#overallProfilePopup .route-preview-image {position:relative!important;display:grid!important;place-items:center;width:52px!important;height:56px!important;flex:0 0 52px!important;overflow:hidden;background:#14244c;border:1px solid #425c8e}\n#overallProfilePopup .route-preview-image img {position:static!important;width:100%!important;height:100%!important;object-fit:contain!important;transform:none!important}\n#overallProfilePopup .route-preview-copy {display:flex!important;flex-direction:column!important;align-items:flex-start!important;gap:4px;min-width:0!important;text-align:left}\n#overallProfilePopup .route-preview-copy>b {font:calc(11px * var(--sq-ui-scale,1))/1.2 ForcedSquare,sans-serif!important;text-transform:uppercase;letter-spacing:.03em;color:#95deff}\n#overallProfilePopup .route-preview-copy strong {font:calc(19px * var(--sq-ui-scale,1))/1.2 ForcedSquare,sans-serif!important;color:#fff;overflow-wrap:anywhere}\n#overallProfilePopup .route-preview-copy small {display:block;margin:0!important;font:calc(14px * var(--sq-ui-scale,1))/1.25 ForcedSquare,sans-serif!important;color:#bfd2ee}\n#overallProfilePopup .route-preview-copy .guide-weight {font-size:calc(12px * var(--sq-ui-scale,1))!important;padding:0!important;border:0!important;background:none!important;color:#9ed4e8}\n#overallProfilePopup .profile-guide>summary .route-open-label {\n  display:flex!important;align-items:center!important;justify-content:center!important;align-self:stretch!important;justify-self:stretch!important;\n  box-sizing:border-box;grid-column:auto!important;grid-row:auto!important;min-height:104px!important;padding:12px!important;margin:0!important;\n  background:#8be5fb!important;border:1px solid #b6f1ff;color:#11294b!important;font:calc(17px * var(--sq-ui-scale,1))/1.25 ForcedSquare,sans-serif!important;font-style:normal;text-align:center;white-space:normal!important;\n}\n#overallProfilePopup .profile-guide[open]>summary .route-open-label {font-size:0!important;background:#ffd783!important;border-color:#ffe7b1}\n#overallProfilePopup .profile-guide[open]>summary .route-open-label:after {content:'Close plan';font:calc(17px * var(--sq-ui-scale,1))/1.25 ForcedSquare,sans-serif}\n@media(max-width:1100px) {\n  #overallLeaderboardPanel #overallDailyGrid {grid-template-columns:minmax(0,1fr) minmax(0,1fr)!important;grid-template-rows:auto auto!important;height:auto!important;min-height:0!important;max-height:36dvh!important;flex:0 0 auto!important;overflow-y:auto!important;gap:8px!important}\n  #overallDailyGrid .overall-challenge-stack {grid-column:1/-1!important;grid-row:2!important}\n  #overallDailyGrid .overall-center-tools {grid-column:1!important;grid-row:1!important}\n  #overallDailyGrid .overall-footer-right {grid-column:2!important;grid-row:1!important}\n  #overallProfilePopup .profile-guide>summary {grid-template-columns:repeat(3,minmax(0,1fr)) 86px!important}\n  #overallProfilePopup .route-preview-image {width:40px!important;height:48px!important;flex-basis:40px!important}\n  #overallProfilePopup .route-preview-item {padding:8px!important;gap:7px}\n  #overallProfilePopup .route-preview-copy strong {font-size:calc(17px * var(--sq-ui-scale,1))!important}\n}\n@media(max-width:700px) {\n  #overallProfilePopup .profile-guide>summary {grid-template-columns:repeat(2,minmax(0,1fr))!important;grid-auto-rows:minmax(104px,auto)!important;padding:8px!important}\n  #overallDailyGrid .competition-track-name {font-size:calc(16px * var(--sq-ui-scale,1))!important}\n}\n@media(max-width:430px) {\n  #overallLeaderboardPanel #overallDailyGrid {padding:8px!important;max-height:38dvh!important}\n  #overallDailyGrid .overall-challenge-stack {grid-template-columns:1fr!important}\n  #overallDailyGrid .competition-feature-button {grid-template-columns:40px minmax(0,1fr)!important;min-height:48px!important}\n  #overallDailyGrid .competition-feature-image {width:40px!important;height:40px!important}\n  #overallProfilePopup .profile-guide>summary {grid-template-columns:minmax(0,1fr)!important;grid-auto-rows:minmax(80px,auto)!important}\n  #overallProfilePopup .route-preview-item,#overallProfilePopup .profile-guide>summary .route-open-label {min-height:80px!important}\n  #overallProfilePopup .route-preview-copy {display:grid!important;grid-template-columns:minmax(0,1fr) auto!important;column-gap:10px}\n  #overallProfilePopup .route-preview-copy>b,#overallProfilePopup .route-preview-copy strong {grid-column:1/-1}\n}\n@media(max-height:500px) and (min-width:600px) {\n  #overallLeaderboardPanel #overallDailyGrid {height:96px!important;max-height:96px!important;flex-basis:96px!important;grid-template-columns:1fr 1fr!important;grid-template-rows:1fr!important;padding:5px!important}\n  #overallDailyGrid .overall-challenge-stack {display:none!important}\n  #overallDailyGrid .overall-center-tools {grid-column:1!important;grid-row:1!important}\n  #overallDailyGrid .overall-footer-right {grid-column:2!important;grid-row:1!important}\n}\n\n#overallProfilePopup .profile-guide-body{border-top:3px solid #8ddfff;padding:16px!important;background:#13254f}\n#overallProfilePopup .profile-guide-body>header{border-bottom:3px solid #8ddfff;padding-bottom:14px;margin-bottom:16px}\n#overallProfilePopup .profile-guide-track{border:2px solid #7298ce!important;border-left:5px solid #8ddfff!important;background:#253e73!important;box-shadow:0 3px 0 #0a1737}\n#overallProfilePopup .profile-guide-copy>b{font-size:calc(21px * var(--sq-ui-scale,1))!important;color:#fff!important}\n#overallProfilePopup .profile-guide h4{font-size:calc(24px * var(--sq-ui-scale,1));line-height:1.45}\n#overallProfilePopup .planner-rival-name{display:inline;padding:2px 8px;background:#93e6ff;color:#10264b;border-bottom:3px solid #fff;font-weight:900;box-decoration-break:clone;-webkit-box-decoration-break:clone}\n@media(max-width:430px){#overallDailyGrid .overall-challenge-stack>section{grid-template-columns:minmax(0,1fr) 108px!important}}\n\n#overallDailyGrid .competition-feature-image .profile-track-image-frame{position:static!important;width:100%!important;height:100%!important;min-height:0!important;padding:0!important;display:grid!important;place-items:center}\n\n@media(max-width:600px){#overallLeaderboardPanel #overallDailyGrid{grid-template-columns:minmax(0,1fr)!important;grid-template-rows:auto auto auto!important}#overallDailyGrid .overall-center-tools{grid-column:1!important;grid-row:1!important;width:100%!important}#overallDailyGrid .overall-footer-right{grid-column:1!important;grid-row:2!important;width:100%!important}#overallDailyGrid .overall-challenge-stack{grid-column:1!important;grid-row:3!important}#overallDailyGrid .overall-category-control{width:100%!important;min-width:0!important}#overallDailyGrid .overall-category-select{min-width:0!important;flex:1}#overallDailyGrid .sq-category-trigger{white-space:nowrap!important}#overallDailyGrid .overall-page-status{min-width:0!important}}\n\n#overallDailyGrid .overall-center-tools,#overallDailyGrid .overall-footer-right{box-sizing:border-box;width:100%!important;padding:0 8px!important;justify-content:center}\n#overallProfilePopup .profile-guide-metric{display:inline-flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 12px 8px 0}\n#overallProfilePopup .guide-ease{color:#cbeeff;font-size:14px;line-height:1.3}\n\n#overallProfilePopup .profile-guide-body>header .profile-kicker{display:block;margin-bottom:8px}\n\n@media(max-width:600px){#overallDailyGrid .leaderboard-arcade{display:none!important}#overallDailyGrid .overall-center-tools{display:grid!important;grid-template-rows:44px 30px!important;gap:4px!important;padding:0!important}#overallDailyGrid .overall-pager{height:44px!important;min-height:44px!important;padding:0!important;margin:0!important}#overallDailyGrid .overall-page-button{height:40px!important;min-height:40px!important}#overallDailyGrid .overall-freshness{height:30px!important;min-height:30px!important;margin:0!important;padding:3px 8px!important;white-space:normal!important;font-size:12px!important;line-height:1.2!important}#overallDailyGrid .overall-category-control{min-height:44px!important;padding:3px!important}#overallDailyGrid .overall-footer-right{padding:0!important}#overallDailyGrid .sq-category-trigger{min-height:40px!important;padding:6px!important}}\n";
    document.head.appendChild(style);
    const rankedPolish=document.createElement('style');
    rankedPolish.id='polytrack-ranked-polish-v1';
    rankedPolish.textContent="\n      /* One restrained pattern system across Overall, track rows and studio previews. */\n      .cosmetic-stripe-standard{--sq-stripe-art:linear-gradient(90deg,transparent 0 76%,color-mix(in srgb,var(--fx-accent,#7ee7ff) 16%,transparent) 100%)}\n      .cosmetic-stripe-cyan{--sq-stripe-art:repeating-linear-gradient(112deg,transparent 0 42px,color-mix(in srgb,var(--fx-accent,#7ee7ff) 36%,transparent) 43px 47px,transparent 48px 72px)}\n      .cosmetic-stripe-apex{--sq-stripe-art:linear-gradient(118deg,transparent 0 61%,color-mix(in srgb,var(--fx-accent,#7ee7ff) 52%,transparent) 62% 65%,transparent 66%),linear-gradient(118deg,transparent 0 74%,color-mix(in srgb,var(--fx-accent,#7ee7ff) 25%,transparent) 75% 77%,transparent 78%)}\n      .cosmetic-stripe-chevron{--sq-stripe-art:repeating-linear-gradient(135deg,transparent 0 42px,color-mix(in srgb,var(--fx-accent,#7ee7ff) 31%,transparent) 43px 50px,transparent 51px 74px)}\n      .cosmetic-stripe-sunset{--sq-stripe-art:linear-gradient(102deg,transparent 0 44%,rgba(255,210,119,.30) 45% 48%,transparent 49% 64%,rgba(255,112,92,.34) 65% 69%,transparent 70%)}\n      .cosmetic-stripe-split{--sq-stripe-art:linear-gradient(106deg,transparent 0 52%,color-mix(in srgb,var(--fx-accent,#7ee7ff) 40%,transparent) 53% 56%,rgba(255,255,255,.07) 57% 72%,transparent 73%)}\n      .cosmetic-stripe-grid{--sq-stripe-art:linear-gradient(color-mix(in srgb,var(--fx-accent,#7ee7ff) 15%,transparent) 1px,transparent 1px),linear-gradient(90deg,color-mix(in srgb,var(--fx-accent,#7ee7ff) 15%,transparent) 1px,transparent 1px);--sq-stripe-size:28px 28px}\n      .cosmetic-stripe-circuit{--sq-stripe-art:radial-gradient(circle at 73% 31%,var(--fx-accent,#7ee7ff) 0 2px,transparent 3px),radial-gradient(circle at 88% 70%,var(--fx-accent,#7ee7ff) 0 2px,transparent 3px),linear-gradient(90deg,transparent 59%,color-mix(in srgb,var(--fx-accent,#7ee7ff) 32%,transparent) 60% 60.5%,transparent 61%),linear-gradient(154deg,transparent 73%,color-mix(in srgb,var(--fx-accent,#7ee7ff) 28%,transparent) 74% 75%,transparent 76%)}\n      .cosmetic-stripe-scan{--sq-stripe-art:repeating-linear-gradient(0deg,transparent 0 7px,color-mix(in srgb,var(--fx-accent,#7ee7ff) 17%,transparent) 8px 9px)}\n      .cosmetic-stripe-blocks{--sq-stripe-art:linear-gradient(90deg,transparent 0 55%,color-mix(in srgb,var(--fx-accent,#7ee7ff) 22%,transparent) 56% 66%,transparent 67% 71%,color-mix(in srgb,var(--fx-accent,#7ee7ff) 34%,transparent) 72% 84%,transparent 85%)}\n      .cosmetic-stripe-gold{--sq-stripe-art:linear-gradient(110deg,transparent 0 57%,rgba(255,238,146,.42) 58% 61%,transparent 62% 70%,rgba(255,200,62,.30) 71% 77%,transparent 78%)}\n      .cosmetic-stripe-beta{--sq-stripe-art:repeating-linear-gradient(125deg,transparent 0 44px,rgba(255,130,217,.30) 45px 50px,rgba(126,231,255,.24) 51px 56px,transparent 57px 84px)}\n      .overall-entry[class*='cosmetic-stripe-']::before,\n      .leaderboard-ui>.container>button.main.sq-racer-cosmetic[class*='cosmetic-stripe-']::before{background-image:var(--sq-stripe-art)!important;background-size:var(--sq-stripe-size,auto)!important;opacity:.5!important;mask-image:linear-gradient(90deg,transparent 0,#000 34%,#000 100%)}\n      [class*='cosmetic-stripe-'] .showcase-row::before{background-image:var(--sq-stripe-art)!important;background-size:var(--sq-stripe-size,auto)!important;opacity:.5!important;mask-image:linear-gradient(90deg,transparent 0,#000 28%,#000 100%)}\n      .overall-profile-card[class*='cosmetic-stripe-'] .profile-hero{background-image:var(--sq-stripe-art)!important;background-size:var(--sq-stripe-size,auto)!important;background-position:center}\n      .sq-plain-racer-themes .overall-entry[class*='cosmetic-stripe-']::before,\n      .sq-plain-racer-themes .leaderboard-ui button.main[class*='cosmetic-stripe-']::before{display:none!important}\n\n      /* Compact, balanced footer controls. */\n      .overall-center-tools .overall-pager{display:grid!important;grid-template-columns:48px minmax(0,1fr) 48px!important;gap:8px!important;padding:6px 8px!important}\n      .overall-page-button{width:48px!important;min-width:48px!important;margin:0!important}\n      .overall-page-status{min-width:0!important;text-align:center!important;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n      .overall-center-tools .overall-freshness{justify-content:center!important;padding:6px 10px!important;text-align:center!important;line-height:1.2}\n      .overall-category-control{position:relative;display:grid!important;grid-template-columns:minmax(0,1fr) 34px!important;gap:7px!important;align-items:center;padding:8px!important;background:#172754!important;border-left:4px solid #7ee7ff}\n      .overall-category-select{grid-column:1;display:grid!important;grid-template-columns:auto minmax(0,1fr)!important;align-items:center;gap:9px!important;min-width:0}\n      .overall-category-select>span{font-size:11px!important;white-space:nowrap}\n      .overall-category-select>select{width:100%!important;min-width:0!important;height:40px!important;padding:6px 34px 6px 11px!important;background:#0f1e45!important;border:1px solid #4e6fac!important;color:#fff!important;font-size:16px!important}\n      .overall-category-info{grid-column:2;display:flex;align-items:center;justify-content:center;width:34px;height:34px;padding:0;border:2px solid #7ee7ff;border-radius:50%;background:#203b75;color:#dff9ff;font:20px Georgia,serif;font-weight:700;cursor:pointer}\n      .overall-category-info:hover,.overall-category-info:focus-visible,.overall-category-control.is-explaining .overall-category-info{background:#7ee7ff;color:#10214b;outline:2px solid #fff;outline-offset:2px}\n      .overall-category-description{display:none;position:absolute;right:0;bottom:calc(100% + 7px);z-index:8;width:min(390px,80vw);box-sizing:border-box;padding:10px 12px;background:#0d1939;border:1px solid #7ee7ff;border-left-width:5px;color:#e5f3ff;font-size:13px;line-height:1.35;box-shadow:0 10px 24px rgba(0,0,0,.38)}\n      .overall-category-info:hover+.overall-category-description,.overall-category-info:focus-visible+.overall-category-description,.overall-category-control.is-explaining .overall-category-description{display:block}\n      @media(max-width:1100px){.overall-category-description{position:static;grid-column:1/-1;width:auto;margin-top:1px}}\n      @media(max-width:900px) and (min-width:621px){#overallLeaderboardPanel{--rank-columns:70px minmax(220px,1.15fr) minmax(180px,1fr) 105px!important}.overall-entry{grid-template-columns:var(--rank-columns)!important;grid-template-areas:none!important;min-height:108px!important;padding-right:12px!important;gap:9px!important}.overall-rank{grid-area:auto!important;width:70px!important}.overall-name,.overall-mid,.overall-stats{grid-area:auto!important}.overall-stats{min-width:0!important}.overall-car-model{width:80px!important;height:80px!important;margin-right:8px!important}.overall-entry.top-1 .overall-car-model{width:86px!important;height:88px!important}.overall-name{font-size:20px!important}.overall-racer-meta{font-size:10px!important}}\n      @media(max-width:620px){.overall-category-control{grid-template-columns:minmax(0,1fr) 32px!important}.overall-category-select{grid-template-columns:1fr!important;gap:3px!important}.overall-category-select>select{height:38px!important;font-size:14px!important}.overall-category-info{width:32px;height:32px}.overall-category-description{font-size:12px}.overall-entry{grid-template-columns:62px minmax(0,1fr) auto!important;grid-template-areas:'rank name stats' 'rank mid stats'!important;min-height:104px!important}.overall-entry.top-1{min-height:110px!important}.overall-rank{grid-area:rank!important}.overall-name{grid-area:name!important}.overall-mid{grid-area:mid!important}.overall-stats{grid-area:stats!important}.overall-entry .overall-racer-meta{display:none!important}.overall-entry .overall-best-line+.overall-best-line{display:none!important}.overall-entry .overall-name-main{font-size:18px!important}.overall-entry .overall-name-hint{font-size:10px!important}.overall-entry .overall-mid{gap:3px!important}.overall-entry .overall-best{font-size:11px!important}}\n    ";
    rankedPolish.textContent += "      .overall-category-select select[hidden]{display:none!important}\n      .sq-category-trigger{width:100%;min-height:44px;padding:8px 12px;background:#172653;border:1px solid #7399cf;color:#fff;font:17px ForcedSquare,sans-serif;text-align:left;cursor:pointer}\n      .sq-category-trigger:focus-visible{outline:3px solid #a7e7ff;outline-offset:2px}\n      .sq-category-popup,.sq-category-submenu{box-sizing:border-box;background:#202e65;border:2px solid #89b9eb;box-shadow:0 8px 22px #0008;padding:5px;z-index:13000;max-height:calc(100dvh - 16px);overflow:auto}\n      .sq-category-popup{position:fixed}\n      .sq-category-popup button{display:block;width:100%;min-height:44px;padding:9px 12px;border:0;border-bottom:1px solid #ffffff18;background:transparent;color:#fff;font:17px ForcedSquare,sans-serif;text-align:left;cursor:pointer}\n      .sq-category-popup button:hover,.sq-category-popup button:focus-visible{background:#405798;outline:2px solid #ade7ff;outline-offset:-2px}\n      .sq-category-popup button[aria-checked=true]{background:#9de5ff;color:#172653}\n      .sq-category-submenu[hidden]{display:none}\n      @media(max-width:559px){.sq-category-submenu{border-width:0 0 0 3px;box-shadow:none;margin-top:5px;max-height:35dvh}.sq-category-popup{max-height:75dvh}.sq-category-trigger{font-size:16px}}\n";
    rankedPolish.textContent += "@media(max-width:700px){#overallLeaderboardPanel .overall-competition{max-height:28dvh!important}.profile-customizer-preview{padding:10px!important}.profile-customizer-preview .profile-preview-stage{min-height:64px!important;height:64px!important;margin:5px 0!important}.profile-customizer-preview .profile-preview-stage .overall-car-model{width:64px!important;height:64px!important;min-height:64px!important}.profile-row-showcase{gap:4px!important}.profile-row-showcase>div{min-height:34px!important;padding-top:3px!important;padding-bottom:3px!important}.profile-customizer-actions{display:grid!important;grid-template-columns:minmax(0,1fr) minmax(0,1fr)!important;min-width:0!important;width:100%!important}.profile-customizer-preview{min-width:0!important;width:100%!important;box-sizing:border-box!important}.profile-customizer-actions .button{min-width:0!important;width:100%!important;white-space:normal!important;box-sizing:border-box!important}.profile-customizer-actions>[role=status]{grid-column:1/-1!important}.profile-customizer-actions .button{font-size:14px!important;padding:7px!important;min-height:44px!important}.profile-achievement-medals{font:700 13px/1.3 'Trebuchet MS',sans-serif!important}}";
    rankedPolish.textContent+="\n@media(max-width:700px){\n #overallLeaderboardPanel .overall-competition{max-height:28dvh!important;min-height:0!important;overflow-y:auto!important;flex-shrink:0;gap:6px!important;padding:6px!important}\n #overallLeaderboardPanel .overall-category-select{grid-template-columns:auto minmax(0,1fr)!important;min-height:44px!important;padding:4px 6px!important;gap:6px!important}\n #overallLeaderboardPanel .overall-category-select>span{font-size:12px!important}\n #overallLeaderboardPanel .overall-category-control{padding:0!important;min-height:44px!important}\n #overallLeaderboardPanel .overall-footer-right{padding:0!important;gap:4px!important}\n #overallLeaderboardPanel .overall-pager{min-height:44px!important;padding:2px!important}\n #overallLeaderboardPanel .overall-center-tools{order:2!important}\n #overallLeaderboardPanel .weekly-cup,#overallLeaderboardPanel .daily-card{padding:7px!important;min-width:0!important}\n #overallLeaderboardPanel .competition-track-main{min-width:0!important;gap:4px!important}\n}\n";
    rankedPolish.textContent+="\n.leaderboard-ui button.main .verified-state{box-sizing:border-box!important;right:22px!important;width:max-content!important;max-width:calc(100% - 150px)!important;white-space:nowrap!important}\n.leaderboard-ui button.main .sq-integrity-label{flex-shrink:0;white-space:nowrap}\n.leaderboard-ui button.main .name::before{content:none!important}\n@media(min-width:701px) and (max-width:1100px) and (max-height:850px){#overallLeaderboardPanel .overall-competition{max-height:28dvh!important;min-height:0!important;overflow-y:auto!important}}\n";
    rankedPolish.textContent += "\n      /* Native desktop UI scales as a unit. Only the portrait track screen opts out. */\n      @media(max-width:600px) and (orientation:portrait){\n        body>div:has(>.menu-ui>.track-info-ui){transform:none!important;width:100%!important;height:100%!important}\n        .menu-ui>.track-info-ui{inset:0!important;margin:0!important;width:100%!important;height:100dvh!important;box-sizing:border-box;display:flex!important;flex-direction:column-reverse!important;gap:8px;padding:8px 8px 54px!important;overflow:hidden}\n        .track-info-ui>.side-panel{flex:0 0 auto!important;width:100%!important;height:auto!important;box-sizing:border-box;display:grid!important;grid-template-columns:72px minmax(0,1fr) 80px;gap:5px 8px;padding:6px!important;margin:0!important}\n        .track-info-ui>.side-panel>h2{grid-column:2;grid-row:1;margin:0!important;font-size:24px!important;text-align:left!important}\n        .track-info-ui>.side-panel>.thumbnail{grid-column:1;grid-row:1/4;width:72px!important;height:72px!important;margin:0!important}\n        .track-info-ui>.side-panel>.thumbnail img{width:100%!important;height:100%!important;object-fit:contain}\n        .track-info-ui>.side-panel>.track-author{grid-column:2;grid-row:2;margin:0!important;font-size:14px!important;text-align:left!important}\n        .track-info-ui>.side-panel>.personal-best{grid-column:2;grid-row:3;margin:0!important;font-size:17px!important;display:flex;gap:8px}\n        .track-info-ui>.side-panel>.personal-best *{font-size:17px!important;margin:0!important}\n        .track-info-ui>.side-panel>.watch{grid-column:3;grid-row:1/3}\n        .track-info-ui>.side-panel>.play{grid-column:3;grid-row:3/5}\n        .track-info-ui>.side-panel>.button{position:static!important;min-width:0!important;width:80px!important;min-height:44px!important;height:auto!important;margin:0!important;padding:6px!important;font-size:18px!important;transform:none!important}\n        .track-info-ui>.side-panel>.button img{width:18px!important;height:18px!important}\n        .track-info-ui>.side-panel>.opponents-container{grid-column:1/3;grid-row:4;max-height:56px!important;overflow:auto;font-size:13px!important;margin:0!important}\n        .track-info-ui>.side-panel>.last-modified,.track-info-ui>.side-panel>.divider,.track-info-ui>.side-panel>.personal-best-title,.track-info-ui>.side-panel>.opponents-title{display:none!important}\n        .track-info-ui>.leaderboard-ui{flex:1 1 auto!important;min-height:0!important;width:100%!important;height:auto!important;padding:0!important;margin:0!important}\n        .track-info-ui .leaderboard-ui>h2{font-size:24px!important;margin:2px 0!important}\n        .track-info-ui .leaderboard-ui>h3{font-size:14px!important;margin:0!important}\n        .track-info-ui .leaderboard-ui>.total-players{position:static!important;font-size:14px!important;margin:2px 0!important;text-align:center}\n        .track-info-ui .leaderboard-ui>.container{min-height:0!important;overflow:auto!important;margin:4px 0!important;padding:0!important}\n        .track-info-ui .leaderboard-ui button.main{box-sizing:border-box!important;width:100%!important;min-height:86px!important;height:86px!important;margin:0 0 6px!important;padding:6px!important;display:grid!important;grid-template-columns:64px 86px minmax(0,1fr);gap:5px!important;transform:none!important}\n        .track-info-ui .leaderboard-ui button.main>.image-container{position:relative!important;inset:auto!important;width:64px!important;height:64px!important;margin:0!important}\n        .track-info-ui .leaderboard-ui button.main>.image-container img{width:64px!important;height:64px!important;object-fit:contain!important}\n        .track-info-ui .leaderboard-ui button.main>.checkmark{width:22px!important;height:22px!important;left:4px!important;top:4px!important}\n        .track-info-ui .leaderboard-ui button.main>.left,.track-info-ui .leaderboard-ui button.main>.right{position:static!important;min-width:0!important;width:auto!important;height:auto!important;margin:0!important;display:flex!important;flex-direction:column;justify-content:center;gap:6px!important}\n        .track-info-ui .leaderboard-ui button.main p{font-size:18px!important;margin:0!important;line-height:1.2!important}\n        .track-info-ui .leaderboard-ui button.main .position{font-size:21px!important}\n        .track-info-ui .leaderboard-ui button.main .name-container{position:static!important;width:100%!important;margin:0!important;overflow:hidden!important}\n        .track-info-ui .leaderboard-ui button.main .name{font-size:18px!important;line-height:1.3!important;max-width:100%!important;white-space:nowrap!important}\n        .track-info-ui .leaderboard-ui button.main .verified-state{position:static!important;font-size:12px!important;max-width:100%!important;gap:3px!important}\n        .track-info-ui .leaderboard-ui button.main .verified-state img{width:14px!important;height:14px!important}\n        .track-info-ui .leaderboard-ui button.main .sq-integrity-label{font-size:10px!important;padding:2px!important}\n        .track-info-ui .leaderboard-ui .pages{height:44px!important;margin:0!important;gap:2px!important;display:flex!important;justify-content:center!important}\n        .track-info-ui .leaderboard-ui .pages button{min-width:28px!important;width:auto!important;flex:1;max-width:44px;min-height:44px!important;height:44px!important;padding:2px!important;font-size:18px!important;transform:none!important}\n        .track-info-ui .leaderboard-ui>.button-wrapper{height:44px!important;margin:4px 0 0!important;display:flex!important;gap:6px!important}\n        .track-info-ui .leaderboard-ui>.button-wrapper button{font-size:18px!important;height:44px!important;min-height:44px!important;padding:6px!important;transform:none!important}\n        .track-info-ui .leaderboard-ui>.button-wrapper img{width:20px!important;height:20px!important}\n      }\n";
    rankedPolish.textContent += "@media(max-width:600px) and (orientation:portrait){.track-info-ui .leaderboard-ui button.main p,.track-info-ui .leaderboard-ui button.main .name{padding:0!important}.track-info-ui .leaderboard-ui button.main .name-container{height:auto!important}.track-info-ui .side-panel .thumbnail{overflow:hidden!important}.track-info-ui .side-panel .thumbnail>*{position:static!important;width:72px!important;height:72px!important}.track-info-ui .side-panel .thumbnail .environment{display:none!important}.track-info-ui .side-panel .personal-best img{width:18px!important;height:18px!important}.track-info-ui .side-panel .personal-best{align-items:center!important}.track-info-ui .side-panel .personal-best>div{display:flex!important;align-items:center!important;gap:4px!important}.track-info-ui .side-panel .opponents-container.no-opponents{font:13px sans-serif!important;line-height:1.3!important}}";
    rankedPolish.textContent += "@media(max-width:600px) and (orientation:portrait){.track-info-ui .side-panel .thumbnail{position:relative!important}.track-info-ui .side-panel .thumbnail>img:first-child{position:absolute!important;inset:0!important;transform:none!important;object-fit:contain!important;opacity:1!important}.track-info-ui .side-panel .thumbnail>.share{position:absolute!important;right:0!important;bottom:0!important;top:auto!important;left:auto!important;width:28px!important;height:28px!important;min-height:28px!important;padding:3px!important;transform:none!important}.track-info-ui .side-panel .thumbnail>.share img{width:18px!important;height:18px!important}.track-info-ui .side-panel .opponents-container.no-opponents{font-size:12px!important}}";
    rankedPolish.textContent += "\n.overall-page-status{min-width:0!important;white-space:normal!important;overflow-wrap:anywhere;line-height:1.35!important;text-align:center!important}\n@media(max-width:620px){.profile-car-column{display:grid!important;grid-template-columns:110px minmax(0,1fr)!important;gap:8px!important;align-items:center!important;margin-top:36px!important}.profile-car-column>.overall-car-model{width:110px!important;height:110px!important;min-height:110px!important;margin:0!important}.profile-achievement-row{margin:0!important;padding:6px!important}.profile-achievement-medals{gap:3px!important}.profile-achievement-medals>span{padding:3px!important}.profile-achievement-medals svg,.profile-achievement-medals img{width:22px!important;height:22px!important}.profile-ranked-count{padding:4px!important;font-size:12px!important}.profile-achievement-label{font-size:11px!important}}\n@media(min-width:701px) and (max-width:1100px){#overallLeaderboardPanel .overall-competition{display:grid!important;grid-template-columns:minmax(0,1fr) minmax(0,1fr)!important;gap:6px!important;padding:6px!important}#overallLeaderboardPanel .overall-footer-right{grid-column:2!important;grid-row:1!important;padding:5px!important}#overallLeaderboardPanel .overall-center-tools{grid-column:1!important;grid-row:1!important;padding:5px!important}}\n";
    rankedPolish.textContent += "\n@media(max-width:600px) and (orientation:portrait){\nbody>div:has(>.menu-ui>.track-selection-ui){transform:none!important;width:100%!important;height:100%!important}\n.menu-ui>.track-selection-ui{inset:0!important;width:100%!important;height:100dvh!important;box-sizing:border-box;display:flex!important;flex-direction:column!important;padding:8px!important;margin:0!important}\n.track-selection-ui>.safe-area-left,.track-selection-ui>.safe-area-right{display:none!important}\n.track-selection-ui>.bar{position:static!important;display:grid!important;grid-template-columns:1fr 1fr!important;gap:6px!important;height:auto!important;min-height:98px!important;margin:0!important;padding:0!important}\n.track-selection-ui>.bar>.search-bar-container{grid-row:2;grid-column:1/-1;min-width:0!important;width:100%!important;margin:0!important}\n.track-selection-ui>.bar input{box-sizing:border-box;width:100%!important;height:44px!important;font-size:17px!important;padding:8px!important}\n.track-selection-ui>.bar>.button{min-width:0!important;width:100%!important;height:44px!important;font-size:20px!important;transform:none!important;margin:0!important}\n.track-selection-ui>.bar>.button img{width:20px!important;height:20px!important}\n.track-selection-ui>.category-container{position:static!important;display:flex!important;width:100%!important;height:auto!important;margin:6px 0!important;gap:4px!important}\n.track-selection-ui>.category-container>.button{flex:1;min-width:0!important;width:auto!important;white-space:normal!important;min-height:48px!important;height:auto!important;font-size:17px!important;padding:4px!important;margin:0!important;transform:none!important}\n.track-selection-ui>.tracks-container.open{position:static!important;flex:1;min-height:0!important;width:100%!important;height:auto!important;overflow-y:auto!important;overflow-x:hidden!important;padding:0!important;margin:0!important}\n.track-selection-ui>.tracks-container.open>div:not(.empty){display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:8px!important;margin:0 0 10px!important;padding:0!important}\n.track-selection-ui .group-title{grid-column:1/-1;font-size:24px!important;margin:6px 0!important;padding:0!important}\n.track-selection-ui .track{width:auto!important;height:auto!important;margin:0!important;padding:0!important;min-width:0!important}\n.track-selection-ui .track>.button{box-sizing:border-box!important;width:100%!important;height:174px!important;min-height:174px!important;margin:0!important;padding:32px 6px 26px!important;transform:none!important;position:relative!important;overflow:hidden!important}\n.track-selection-ui .track-title{position:absolute!important;top:4px!important;left:0!important;width:100%!important;height:26px!important;margin:0!important;padding:0!important}\n.track-selection-ui .track-title p{font-size:20px!important;line-height:24px!important;padding:0 4px!important;margin:0!important;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.track-selection-ui .track>.button>img:not(.environment){position:static!important;width:100%!important;height:112px!important;object-fit:contain!important;transform:none!important}\n.track-selection-ui .track>.button>.environment{position:absolute!important;right:6px!important;bottom:28px!important;top:auto!important;left:auto!important;width:22px!important;height:22px!important}\n.track-selection-ui .track .record{position:absolute!important;bottom:5px!important;left:0!important;right:0!important;margin:0!important;padding:0!important;font-size:17px!important;height:22px!important}\n.track-info-ui .side-panel .thumbnail>.share{width:44px!important;height:44px!important;min-height:44px!important;padding:8px!important}\n}\n";
    rankedPolish.textContent += '\n.leaderboard-ui .verified-state.pending{background:#473419!important;border:1px solid #ffc978!important;color:#ffe4b5!important}.leaderboard-ui .verified-state .sq-integrity-label{font-family:Arial,sans-serif;font-weight:700;letter-spacing:.04em}';
    rankedPolish.textContent+='\n#polytrackTrackFreshness{position:fixed!important;left:max(10px,env(safe-area-inset-left))!important;right:auto!important;bottom:max(8px,env(safe-area-inset-bottom))!important;max-width:calc(100vw - 28px)!important;box-sizing:border-box!important;transform:none!important;clip-path:none!important;overflow-wrap:anywhere;pointer-events:none}#polytrackTrackFreshness strong,#polytrackTrackFreshness span{white-space:normal!important}';
    rankedPolish.textContent += '\n.multiplayer-ui:has(>.join:not(.hidden),>.host:not(.hidden)){overflow-x:hidden!important}.multiplayer-ui .invite-code-container{position:relative!important;min-width:0!important}.multiplayer-ui .connecting-text{position:absolute!important;margin:0!important;transform:none!important;left:0!important;right:0!important;width:100%!important;max-width:100%!important;box-sizing:border-box!important;font-size:20px!important;white-space:normal!important;padding:8px!important}.multiplayer-ui .connecting-text .loading-spinner-ui{width:24px!important;height:24px!important;flex-shrink:0}.multiplayer-ui>.join>.error-box{width:100%!important;max-width:100%!important;box-sizing:border-box;overflow-wrap:anywhere}.multiplayer-ui>.join>.error-box p{white-space:normal!important;font-size:16px!important}.sq-multiplayer-intro{margin:8px 0!important}.sq-multiplayer-relay-head strong{font-size:21px!important}@media(max-width:1100px){.sq-multiplayer-backup-drawer{grid-template-columns:minmax(0,1fr)!important}.sq-multiplayer-code{grid-template-columns:minmax(0,1fr) auto auto!important}.sq-multiplayer-discord{grid-column:1/-1!important}}@media(max-width:450px){.sq-multiplayer-code{grid-template-columns:minmax(0,1fr) auto!important}.sq-multiplayer-code input{grid-column:1/-1!important;min-width:0!important}.sq-multiplayer-save{min-width:0!important}}';
    rankedPolish.textContent += ".sq-settings-grid>.sq-setting-row{display:grid!important;grid-template-columns:minmax(0,1fr) minmax(110px,42%)!important;gap:10px!important;box-sizing:border-box!important;min-width:0!important;height:auto!important}.sq-settings-grid>.sq-setting-row>p,.sq-settings-grid>.sq-setting-row>label{margin:0!important;min-width:0!important;white-space:normal!important;font-size:17px!important;line-height:1.3!important;overflow-wrap:anywhere}.sq-settings-grid>.sq-setting-row .button-wrapper{min-width:0!important;width:100%!important;margin:0!important}.sq-settings-grid>.sq-setting-row .button{width:100%!important;min-width:0!important;height:auto!important;min-height:44px!important;font-size:17px!important;white-space:normal!important;padding:8px 14px!important;box-sizing:border-box!important}.sq-rp-precision{width:100%!important;min-width:0!important;box-sizing:border-box!important;font:16px/1.3 ForcedSquare,sans-serif!important;padding:8px 6px!important}.sq-settings-grid>.sq-setting-secret{grid-template-columns:minmax(0,1fr)!important}.sq-setting-range .sq-range-controls{min-width:0!important}.profile-guide-body header small{font:14px/1.4 sans-serif!important}.profile-guide-metric{font-size:18px!important;flex-wrap:wrap}.profile-guide-metric select{font-size:18px!important;max-width:100%!important}.profile-guide-track .guide-placement{font:15px/1.45 sans-serif!important}.profile-guide-grid:has(>.profile-guide-empty){grid-template-columns:1fr!important}.profile-guide-empty{margin:0!important}.multiplayer-ui>.join:not(.hidden),.multiplayer-ui>.host:not(.hidden),.multiplayer-ui>.sq-multiplayer-relay{width:min(620px,100%)!important}@media(max-width:600px){.sq-settings-grid>.sq-setting-row{grid-template-columns:minmax(0,1fr) minmax(100px,42%)!important}.sq-settings-grid>.sq-setting-secret{grid-template-columns:minmax(0,1fr)!important}.profile-guide-body{padding:12px!important}.profile-guide-metric select{width:100%}.profile-guide-body header h4{font-size:24px!important}}";
    rankedPolish.textContent += '\n.sq-rp-precision,.profile-guide-metric select{font:inherit;color:#fff;background:#14254d;border:1px solid #8aaddb;padding:8px;min-height:44px;max-width:100%}.profile-guide-metric{display:flex;align-items:center;gap:10px;margin:8px 0;font-size:16px}.profile-guide-metric select:focus-visible,.sq-rp-precision:focus-visible{outline:2px solid #7ee7ff;outline-offset:2px}';
    rankedPolish.textContent += "\n.multiplayer-ui:has(>.join:not(.hidden),>.host:not(.hidden)){justify-content:safe center!important;background:#28346a!important}.multiplayer-ui .error-box:empty{display:none!important}.multiplayer-ui>.sq-multiplayer-relay{border-left-width:2px!important;background:#202d5b!important}.sq-multiplayer-relay-head .sq-multiplayer-kicker{display:none}.sq-multiplayer-relay-head strong{font-size:18px!important}.multiplayer-ui .invite-code-container input{max-width:100%!important;width:100%!important;box-sizing:border-box!important;min-width:0!important;margin-left:0!important;margin-right:0!important}@media(max-width:600px){}";
    rankedPolish.textContent += ".multiplayer-ui>.sq-multiplayer-relay,.multiplayer-ui>.sq-multiplayer-relay.is-collapsed{width:min(620px,100%)!important}.profile-track-name{min-width:0!important}.profile-track-name b,.profile-track-name small{white-space:normal!important;overflow-wrap:anywhere}.sq-settings-grid>.sq-setting-secret{display:block!important}.sq-setting-secret .sq-secret-controls{margin-top:8px!important}@media(max-width:600px){.profile-track-row{display:grid!important;grid-template-columns:72px minmax(0,1fr) minmax(0,1fr)!important;grid-template-areas:\"image name name\" \"weight result time\"!important;gap:10px!important;height:auto!important;min-height:0!important;padding:12px!important;align-items:start!important}.profile-track-visual{grid-area:image!important;width:72px!important;height:64px!important}.profile-track-name{grid-area:name!important}.profile-track-weight{grid-area:weight!important;display:block!important}.profile-track-result{grid-area:result!important;display:flex!important;flex-wrap:wrap!important;min-width:0!important;gap:4px!important}.profile-track-row>time{grid-area:time!important;min-width:0!important;white-space:normal!important}.profile-track-row>time small{font:11px/1.4 sans-serif!important;white-space:normal!important}.profile-track-result img{width:18px!important;height:18px!important}.profile-track-weight small,.profile-track-result small{font:11px/1.4 sans-serif!important;white-space:normal!important}.profile-track-result b{white-space:normal!important;font-size:15px!important}.sq-setting-secret input{font-size:16px!important;min-width:0!important}.sq-settings-grid>.sq-setting-row{clip-path:none!important}}";
    rankedPolish.textContent += ".profile-guide,.profile-guide button,.profile-guide select,.profile-guide small,.profile-guide p{font-family:ForcedSquare,sans-serif!important}.profile-guide-body{padding:16px!important}.profile-guide-grid{grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:10px!important}.profile-guide-track{display:grid!important;grid-template-columns:88px minmax(0,1fr) 68px!important;gap:12px!important;align-items:center!important;padding:12px!important;min-height:128px!important;height:auto!important;background:#263c76!important;border-left:3px solid #7ee7ff!important}.profile-guide-track.kind-rival{border-left-color:#ffcf70!important}.profile-guide-image{width:88px!important;height:80px!important}.profile-guide-copy{min-width:0!important}.profile-guide-copy>b{font-size:20px!important;line-height:1.3!important}.profile-guide-track .guide-placement,.profile-guide-copy>small{font:16px/1.45 ForcedSquare,sans-serif!important;white-space:normal!important;margin-top:6px!important}.profile-helpfulness>b{font-size:25px!important}.profile-helpfulness>small{font:11px/1.3 ForcedSquare,sans-serif!important;letter-spacing:0!important}.profile-guide-body header small{font:14px/1.4 ForcedSquare,sans-serif!important}.profile-guide-grid:has(>.profile-guide-empty){grid-template-columns:1fr!important}@media(max-width:800px){.profile-guide-grid{grid-template-columns:minmax(0,1fr)!important}}@media(max-width:450px){.profile-guide-track{grid-template-columns:64px minmax(0,1fr)!important;gap:10px!important}.profile-guide-image{width:64px!important;height:64px!important}.profile-helpfulness{grid-column:1/-1!important;display:flex!important;gap:8px!important;align-items:center!important;justify-content:flex-end!important}.profile-helpfulness>b{font-size:18px!important}.profile-guide-copy>b{font-size:18px!important}.profile-guide-track .guide-placement,.profile-guide-copy>small{font-size:15px!important}}";
    rankedPolish.textContent += ".profile-guide-image,.profile-guide-copy{position:static!important;transform:none!important;margin:0!important;padding:0!important;min-width:0!important}.profile-guide-image{overflow:hidden!important}.profile-guide-image img,.profile-guide-image .rank-track-thumb{width:100%!important;height:100%!important;object-fit:contain!important;max-width:100%!important}.profile-guide-copy{width:auto!important;display:block!important}.profile-guide-copy>b,.profile-guide-copy>small{display:block!important}@media(max-width:450px){.profile-guide-image{grid-column:1!important;grid-row:1!important;align-self:start!important}.profile-guide-copy{grid-column:2!important;grid-row:1!important}.profile-helpfulness{grid-row:2!important}.profile-guide-track{align-items:start!important}}";
    rankedPolish.textContent += "@media(max-width:600px){}";
    rankedPolish.textContent += '.multiplayer-ui:has(>.join:not(.hidden),>.host:not(.hidden)){background:transparent!important;justify-content:safe center!important}.multiplayer-ui>.join,.multiplayer-ui>.host{align-self:center!important;margin-inline:auto!important}.multiplayer-ui>.join>.main-box,.multiplayer-ui>.host>.main-box{background:var(--surface-secondary-color)!important}.multiplayer-ui .main-box>h2,.multiplayer-ui .main-box>.buttons{background:var(--surface-color)!important}.competition-local-reset{font-weight:bold;color:#fff}';
    rankedPolish.textContent += 'body.sq-mp-dialog-active .track-selection-ui{visibility:hidden!important;pointer-events:none!important}';
    rankedPolish.textContent += '.multiplayer-ui:has(>.join:not(.hidden),>.host:not(.hidden)){justify-content:flex-start!important}.multiplayer-ui>.join:not(.hidden),.multiplayer-ui>.host:not(.hidden){margin-block:auto!important}.multiplayer-ui>.sq-multiplayer-relay,.multiplayer-ui>.sq-multiplayer-relay.is-collapsed{margin-top:16px!important;margin-bottom:0!important}';
    rankedPolish.textContent += "\n      .cosmetic-emblem-target .overall-name::before,.leaderboard-ui .cosmetic-emblem-target .name::before,.cosmetic-emblem-target .showcase-row::after,.profile-cosmetic-choice.cosmetic-emblem-target .profile-cosmetic-preview::after{content:'\\25CE'}\n      .cosmetic-stripe-overdrive{--sq-stripe-art:repeating-linear-gradient(128deg,transparent 0 30px,var(--fx-accent,#7ee7ff) 31px 34px,transparent 35px 42px);--sq-stripe-size:96px 100%}\n      .profile-cosmetic-choice.cosmetic-stripe-overdrive .profile-cosmetic-preview i{background:repeating-linear-gradient(128deg,#142252 0 16px,#7ee7ff 17px 20px,#142252 21px 27px)}\n";
    document.head.appendChild(rankedPolish);
  }

  function setUnofficialMessage(){
    const warning = document.querySelector('.menu-ui .warning-message, .menu .warning-message');
    if (!warning) return;
    const lang = getUiLanguage();
    const existingLink = warning.querySelector('a[href="https://www.kodub.com/games/polytrack"]');
    const existingText = warning.textContent || '';
    if (warning.dataset.k === WARN_FP && warning.dataset.lang === lang && existingLink && existingText) return;
    warning.dataset.k = WARN_FP;
    warning.dataset.lang = lang;
    warning.className = 'warning-message official-link';
    warning.innerHTML = '';
    const line1 = document.createElement('div');
    line1.textContent = tr('unofficialLine1');
    const line2 = document.createElement('div');
    line2.append(`${tr('unofficialLine2')} `);
    const link = document.createElement('a');
    link.href = 'https://www.kodub.com/games/polytrack';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'kodub.com';
    line2.appendChild(link);
    warning.appendChild(line1);
    warning.appendChild(line2);
  }

  function ensurePersistentInfoBranding(){
    const info = document.querySelector('.menu-ui .info, .menu .info');
    if (!info) return;
    const lang = getUiLanguage();
    if (info.dataset.fp === BRAND_FP && info.dataset.lang === lang && info.querySelector('.staticFunPill')) {
      info.style.display = isStartMenuHotkeyContext() ? '' : 'none';
      return;
    }
    info.dataset.fp = BRAND_FP;
    info.dataset.lang = lang;
    info.innerHTML = '';
    const promo = document.createElement('a');
    promo.href = 'https://sites.google.com/view/staticquasar931/gm3z';
    promo.target = '_blank';
    promo.rel = 'noopener noreferrer';
    promo.setAttribute('aria-label','More Unblocked Games by Static');
    promo.className = 'staticFunHover staticFunPill';
    const label=tr('moreGames');
    const textWrap=document.createElement('span');
    textWrap.className='staticFunText';
    textWrap.style.pointerEvents='none';
    for(let i=0;i<label.length;i++){
      const ch=document.createElement('span');
      ch.className='staticFunChar';
      ch.textContent=label[i]===' '?' ':label[i];
      ch.style.animationDelay=`${(i*0.045).toFixed(3)}s, ${(i*0.035).toFixed(3)}s`;
      ch.style.pointerEvents='none';
      textWrap.appendChild(ch);
    }
    promo.appendChild(textWrap);

    const version = document.createElement('a');
    version.href = 'https://www.kodub.com';
    version.target = '_blank';
    version.rel = 'noopener noreferrer';
    version.textContent = 'kodub.com - Version 0.6.3';

    const credit = document.createElement('a');
    credit.href = 'https://opengameart.org/content/sci-fi-theme-1';
    credit.target = '_blank';
    credit.rel = 'noopener noreferrer';
    credit.textContent = 'OpenGameArt.org "Sci-fi Theme" by Maou (CC-BY 4.0)';


    info.appendChild(promo);
    info.appendChild(version);
    info.appendChild(credit);

    info.style.display = isStartMenuHotkeyContext() ? '' : 'none';
  }

  function ensureStaticDiscordLink(){
    document.querySelectorAll('.static-discord-link').forEach((link)=>link.remove());
  }

  function syncNativeDiscordVisibility(){
    const lobby=isStartMenuHotkeyContext();
    document.querySelectorAll('a.discord-link,a[href*="kodub.com/discord/polytrack"]').forEach((link)=>{
      link.style.display=lobby?'':'none';
    });
  }

  async function syncExactCarPreview(d,accountId,ownerUid,carStyle){
    const safeId=cleanUserId(accountId); const style=__pt062NormalizeStyle(carStyle);
    if(!safeId||!ownerUid||!style)return;
    const signature=`${safeId}|${style}`;
    if(localStorage.getItem('polytrack-0.6.2-car-preview-signature-v1')===signature)return;
    const renderThumb=getCarThumbRenderer(); if(!renderThumb)return;
    try{
      const image=normalizeThumbResult(await renderThumb(style,`admin.${safeId}`));
      if(!/^data:image\/png;base64,/i.test(image)||image.length>180000)return;
      await d.collection(COLLECTIONS.carPreviews).doc(safeId).set({accountId:safeId,ownerUid,carStyle:style,image,updatedAt:Date.now()},{merge:false});
      localStorage.setItem('polytrack-0.6.2-car-preview-signature-v1',signature);
    }catch(error){log('warn','[CAR400] Exact admin car preview was not saved',String(error&&(error.message||error)));}
  }

  function ensureWeeklyTrackHighlight(){
    // Events have separate cards; never decorate the ordinary version of a track.
    document.querySelectorAll('.sq-weekly-title').forEach(title=>title.classList.remove('sq-weekly-title'));
  }
  const recordPlacementModuleUrl=new URL('../tools/record-placement.mjs',eventsModuleUrl).href;
  let recordPlacementUi=null,recordPlacementUiPromise=null,recordPlacementWarningShown=false;
  let recordPlacementOverallKey='',recordPlacementOverallPlacements=null;
  function ensureRecordPlacementUi(){
    if(recordPlacementUi)return Promise.resolve(recordPlacementUi);
    if(!recordPlacementUiPromise){
      recordPlacementUiPromise=import(recordPlacementModuleUrl).then((module)=>{
        recordPlacementUi=module.installRecordPlacement({
          autoUpdate:false,
          document,
          storage:localStorage,
          tracks:()=>TRACK_CATALOG,
          readSnapshots:trackSnapshotStore,
          readAccountId:activeRankedAccountId,
          readAuthoritativePlacements:()=>{
            const accountId=activeRankedAccountId();
            const snapshot=readOverallSnapshotCache();
            if(!accountId||!snapshot){
              recordPlacementOverallKey='';
              recordPlacementOverallPlacements=null;
              return null;
            }
            const key=JSON.stringify([
              accountId,
              snapshot.signature||'',
              Number(snapshot.sourceRevision||0),
              Number(snapshot.builtRevision||0),
              Number(snapshot.revision||0),
              Number(snapshot.serverUpdatedAt||0),
              Number(snapshot.fetchedAt||0)
            ]);
            if(key!==recordPlacementOverallKey){
              recordPlacementOverallKey=key;
              recordPlacementOverallPlacements=module.preparePolyTrackOverallPlacements(
                snapshot,
                accountId,
                {
                  authoritative:true,
                  expectedAlgorithmVersion:RANK_MODEL,
                  minSchemaVersion:TRACK_CACHE_SCHEMA
                }
              );
            }
            return recordPlacementOverallPlacements;
          },
          expectedAlgorithmVersion:RANK_MODEL,
          minSchemaVersion:TRACK_CACHE_SCHEMA,
          prepareSnapshot:(snapshot)=>module.preparePolyTrackCachedSnapshot(snapshot,{algorithmVersion:RANK_MODEL,schemaVersion:TRACK_CACHE_SCHEMA})
        });
        return recordPlacementUi;
      });
    }
    return recordPlacementUiPromise;
  }
  function decoratePersonalBestPodiums(){
    void ensureRecordPlacementUi().then((ui)=>ui.update()).catch((error)=>{
      if(recordPlacementWarningShown)return;
      recordPlacementWarningShown=true;
      log('warn','[RANKED-PLACEMENT] Badge module unavailable',String(error&&(error.message||error)));
    });
  }

  function ensureReturningPlayerNotice(){
    const key='polytrack-0.6.2-ranked-recalculation-notice-v1';
    if(localStorage.getItem(key)==='1' || document.querySelector('.ranked-testing-notice') || !isStartMenuHotkeyContext()) return;
    const returning=readLocalRaceRows().length>0 || Boolean(readOverallSnapshotCache()) || Boolean(localStorage.getItem(RECORDING_STORE_KEY));
    if(!returning) return;
    const notice=document.createElement('div');
    notice.className='ranked-testing-notice';
    notice.innerHTML='<span><strong>Ranked is still being built.</strong> Updates and track changes can move scores when a track receives a new finish. Want your track featured? Submit it in Discord for a chance to join the StaticQuasar931 track tab. Please suggest features and changes in the <a href="https://discord.gg/DP2hM7RRhR" target="_blank" rel="noopener noreferrer">Discord</a> or <a href="https://sites.google.com/view/staticquasar931/google-form?utm_source=polytrack&amp;utm_medium=game&amp;utm_campaign=ranked_feedback" target="_blank" rel="noopener noreferrer">feedback form</a>.</span><button class="button" type="button">Understood</button>';
    notice.querySelector('button').addEventListener('click',()=>{localStorage.setItem(key,'1');notice.remove();});
    document.body.appendChild(notice);
  }

  function applyUiPreferences(){
    const reduced = localStorage.getItem('polytrack-0.6.2-reduced-effects') === '1';
    document.documentElement.classList.toggle('sq-reduced-effects', reduced);
    const showExtras = true;
    const extrasWereHidden = document.documentElement.classList.contains('sq-hide-lobby-extras');
    document.documentElement.classList.toggle('sq-hide-lobby-extras', !showExtras);
    document.documentElement.classList.toggle('sq-hide-racer-codes', localStorage.getItem('polytrack-0.6.2-show-racer-codes') === '0');
    document.documentElement.classList.toggle('sq-hide-pb-podiums', localStorage.getItem('polytrack-0.6.2-pb-podiums') === '0');
    document.documentElement.classList.toggle('sq-compact-ranked', localStorage.getItem('polytrack-0.6.2-compact-ranked') === '1');
    document.documentElement.classList.toggle('sq-plain-racer-themes', localStorage.getItem('polytrack-0.6.2-plain-racer-themes') === '1');
    const fontScale=Math.max(85,Math.min(125,Number(localStorage.getItem('polytrack-0.6.2-ui-font-scale')||100)||100));
    document.documentElement.style.setProperty('--sq-ui-scale',String(fontScale/100));
    if (extrasWereHidden !== !showExtras) window.dispatchEvent(new Event('sq-preferences-changed'));
    recordPlacementUi?.update();
  }

  function settingsToggle(label, storageKey, defaultEnabled=true, inverted=false){
    const row = document.createElement('div');
    row.className = 'setting sq-setting-row';
    const text = document.createElement('p');
    text.textContent = label;
    const wrapper = document.createElement('div');
    wrapper.className = 'button-wrapper';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button';
    const isEnabled = ()=>{
      const stored = localStorage.getItem(storageKey);
      return stored == null ? defaultEnabled : (inverted ? stored !== '1' : stored !== '0');
    };
    const render = ()=>{
      const enabled = isEnabled();
      button.textContent = enabled ? 'Enabled' : 'Disabled';
      button.classList.toggle('selected',enabled);
      button.setAttribute('aria-pressed',String(enabled));
    };
    button.addEventListener('click',(event)=>{
      event.preventDefault();
      event.stopPropagation();
      const next = !isEnabled();
      localStorage.setItem(storageKey,inverted ? (next?'0':'1') : (next?'1':'0'));
      applyUiPreferences();
      render();

    });
    wrapper.appendChild(button);
    row.append(text,wrapper);
    render();
    return row;
  }

  function rpDecimals(){
    try{const value=Number(localStorage.getItem('polytrack-0.6.2-rp-decimals'));return [2,3,4].includes(value)?value:3;}catch{return 3;}
  }
  function formatRp(value){
    return value===null||value===undefined||!Number.isFinite(Number(value))?'N/A':Number(value).toFixed(rpDecimals());
  }
  function settingsRpPrecision(){
    const row=document.createElement('div');row.className='setting sq-setting-row';
    const label=document.createElement('label');label.htmlFor='sqRpDecimals';label.textContent='RP precision';
    const select=document.createElement('select');select.id='sqRpDecimals';select.className='sq-rp-precision';
    select.title='Display precision only. Does not change scores or ordering.';
    for(const value of [2,3,4]){const option=document.createElement('option');option.value=String(value);option.textContent=value+' decimals';select.appendChild(option);}
    select.value=String(rpDecimals());select.addEventListener('change',()=>{localStorage.setItem('polytrack-0.6.2-rp-decimals',select.value);renderEntries();});
    row.append(label,select);return row;
  }
  function settingsRange(label,storageKey,min,max,step,defaultValue){
    const row=document.createElement('div');
    row.className='setting sq-setting-row sq-setting-range sq-setting-wide';
    const text=document.createElement('p');
    text.textContent=label;
    const controls=document.createElement('div');
    controls.className='sq-range-controls';
    const input=document.createElement('input');
    input.type='range'; input.min=String(min); input.max=String(max); input.step=String(step);
    input.value=String(Math.max(min,Math.min(max,Number(localStorage.getItem(storageKey)||defaultValue)||defaultValue)));
    input.setAttribute('aria-label',label);
    const output=document.createElement('output');
    const render=()=>{output.textContent=`${input.value}%`;localStorage.setItem(storageKey,input.value);applyUiPreferences();};
    input.addEventListener('input',render);
    controls.append(input,output); row.append(text,controls); render();
    return row;
  }

  function settingsSecretInput(label,storageKey){
    const row=document.createElement('div');
    row.className='setting sq-setting-row sq-setting-secret sq-setting-wide';
    const text=document.createElement('p');
    text.textContent=label;
    const controls=document.createElement('div');
    controls.className='sq-secret-controls';
    const input=document.createElement('input');
    input.type='password';
    input.autocomplete='off';
    input.spellcheck=false;
    input.maxLength=192;
    input.placeholder='Discord code';
    input.value=localStorage.getItem(storageKey)||'';
    input.setAttribute('aria-label',label);
    const save=document.createElement('button');
    save.type='button';
    save.className='button';
    save.textContent=input.value?'Verified':'Save';
    row.classList.toggle('is-verified',Boolean(input.value));
    save.addEventListener('click',(event)=>{
      event.preventDefault();
      event.stopPropagation();
      if(storageKey==='polytrack-0.6.2-turn-backup-code')saveMultiplayerBackupCode(input,save).then((valid)=>{row.classList.toggle('is-verified',valid&&Boolean(localStorage.getItem(storageKey)));});
      else{
        const value=String(input.value||'').trim().slice(0,64);
        if(value)localStorage.setItem(storageKey,value);
        else localStorage.removeItem(storageKey);
        save.textContent='Saved';
        setTimeout(()=>{if(save.isConnected)save.textContent='Save';},1200);
      }
    });
    if(storageKey==='polytrack-0.6.2-turn-backup-code')input.addEventListener('keydown',(event)=>{if(event.key==='Enter'){event.preventDefault();save.click();}});
    controls.append(input,save);
    row.append(text,controls);
    if(storageKey==='polytrack-0.6.2-turn-backup-code'){
      const status=document.createElement('p');
      status.className='sq-backup-validation';
      status.setAttribute('role','status');
      status.setAttribute('aria-live','polite');
      status.textContent=input.value?'Verified code saved. Discord fallback is ready.':'Optional. Direct and public relay work automatically.';
      row.appendChild(status);
    }
    return row;
  }

  async function currentUserIsModerator(){
    try {
      await db();
      const user = window.firebase.auth().currentUser;
      if (!user) return false;
      const token = await user.getIdTokenResult(true);
      if(token?.claims?.moderator===true) return true;
      const allow=await (await db()).collection(COLLECTIONS.moderators).doc(user.uid).get();
      return allow.exists && allow.data()?.active===true;
    } catch { return false; }
  }

  let adminSessionActive = false;
  let adminSessionExpiresAt = 0;
  function activeModeratorSession(){
    if(adminSessionActive&&adminSessionExpiresAt>Date.now())return true;
    adminSessionActive=false; adminSessionExpiresAt=0;
    document.querySelector('.sq-moderator-tools')?.remove();
    return false;
  }
  async function attachModeratorControls(section){
    if (section.dataset.moderatorChecked === '1') return;
    section.dataset.moderatorChecked = '1';
    if (!activeModeratorSession() || !(await currentUserIsModerator()) || !section.isConnected) return;
    const admin = document.createElement('div');
    admin.className = 'sq-moderator-tools';
    admin.innerHTML = '<strong>Name moderation</strong><input class="sq-mod-id" maxlength="128" placeholder="Paste racer account ID"><input class="sq-mod-name" maxlength="24" placeholder="Replacement name"><input class="sq-mod-reason" maxlength="80" placeholder="Moderator note"><button class="button sq-mod-save" type="button">Apply moderated name</button><span class="sq-mod-status"></span>';
    section.appendChild(admin);
    admin.querySelector('.sq-mod-save').addEventListener('click',async()=>{
      if(!activeModeratorSession()){admin.querySelector('.sq-mod-status').textContent='Moderator access expired. Sign in again.';return;}
      const accountId = cleanUserId(admin.querySelector('.sq-mod-id').value);
      const requested = admin.querySelector('.sq-mod-name').value;
      const reason = String(admin.querySelector('.sq-mod-reason').value || 'manual moderation').trim().slice(0,80);
      const status = admin.querySelector('.sq-mod-status');
      if (!accountId) { status.textContent='Enter a valid racer ID.'; return; }
      const requestedClean = sanitizeDisplayName(requested || makeFallbackName(accountId));
      const isReservedOwnerName = normalizeNameForCheck(requestedClean).replace(/ /g,'') === 'staticquasar931';
      const replacement = isReservedOwnerName ? requestedClean : await enforceSafeDisplayName(requestedClean,accountId);
      status.textContent='Saving...';
      try {
        const d = await db();
        const moderatorUid = window.firebase.auth().currentUser?.uid || '';
        const createdAt = Date.now();
        const batch = d.batch();
        batch.set(d.collection(COLLECTIONS.moderationNames).doc(accountId),{accountId,replacement,active:true,updatedAt:createdAt},{merge:false});
        batch.set(d.collection(COLLECTIONS.adminAudit).doc(),{action:'rename',targetAccountId:accountId,replacement,reason,moderatorUid,createdAt},{merge:false});
        const profileRef = d.collection(COLLECTIONS.profilesPublic).doc(accountId);
        const profileSnap = await profileRef.get();
        if (profileSnap.exists) batch.set(profileRef,{name:replacement,nickname:replacement,updatedAt:createdAt},{merge:true});
        await batch.commit();
        setLastKnownName(accountId,replacement);
        await propagateDisplayName(d,accountId,replacement);
        status.textContent=`Saved as ${replacement}.`;
      } catch (error) {
        status.textContent='Permission denied or Firebase unavailable.';
        log('error','[MOD400] Manual moderation failed',String(error&&(error.message||error)));
      }
    });
  }

  let moderatorSequence = '';
  let moderatorSequenceStage = 0;
  function openModeratorChallenge(section){
    if (!section || section.querySelector('.sq-mod-challenge')) return;
    let entered = '';
    const challenge = document.createElement('div');
    challenge.className = 'sq-mod-challenge';
    challenge.innerHTML = `<div class="sq-mod-card"><strong>Moderator sign-in</strong><p>Enter the private eight-digit admin code. Firebase also requires this account to have the moderator claim. Access expires after ten minutes.</p><div class="sq-mod-entry">_ _ _ _ _ _ _ _</div><div class="sq-mod-keypad">${[1,2,3,4,5,6,7,8,9,'Clear',0,'Close'].map((key)=>`<button type="button" class="button" data-key="${key}">${key}</button>`).join('')}</div><span class="sq-mod-challenge-status"></span></div>`;
    section.appendChild(challenge);
    const entry = challenge.querySelector('.sq-mod-entry');
    const status = challenge.querySelector('.sq-mod-challenge-status');
    challenge.addEventListener('click',async(event)=>{
      const key = event.target.closest?.('[data-key]')?.dataset.key;
      if (key == null) return;
      event.preventDefault();
      event.stopPropagation();
      if (key === 'Close') { challenge.remove(); return; }
      if (key === 'Clear') entered='';
      else if (entered.length < 8) entered += key;
      entry.textContent = Array.from({length:8},(_,index)=>index<entered.length?'●':'_').join(' ');
      if (entered.length === 8) {
        status.textContent='Checking protected Firebase access...';
        try {
          if (!(await currentUserIsModerator())) throw new Error('This Firebase account is not a moderator.');
          const d = await db();
          const uid = window.firebase.auth().currentUser?.uid || '';
          const createdAt = Date.now();
          const codeHash=await sha256Hex(entered);
          entered='';
          await d.collection(COLLECTIONS.adminSessions).doc(uid).set({uid,codeHash,createdAt,expiresAt:createdAt+10*60*1000},{merge:false});
          adminSessionActive = true;
          adminSessionExpiresAt=createdAt+10*60*1000;
          setTimeout(()=>activeModeratorSession(),10*60*1000+250);
          challenge.remove();
          await attachModeratorControls(section);
        } catch (error) {
          entered='';
          entry.textContent='_ _ _ _ _ _ _ _';
          status.textContent=/moderator/i.test(String(error&&(error.message||error)))?'This account does not have moderator access.':'Incorrect code or Firebase denied access.';
        }
      }
    });
  }
  function handleModeratorSequence(event){
    const settings = document.querySelector('.settings-menu-ui');
    if (!settings || !isElementVisible(settings) || event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    const key = String(event.key||'').toLowerCase();
    if (key.length !== 1) return;
    moderatorSequence = (moderatorSequence + key).slice(-12);
    if (moderatorSequenceStage === 0 && moderatorSequence.endsWith('static')) { moderatorSequenceStage=1; moderatorSequence=''; return; }
    if (moderatorSequenceStage === 1 && moderatorSequence.endsWith('931931')) {
      moderatorSequenceStage=0;
      moderatorSequence='';
      openModeratorChallenge(settings.querySelector('#sqRankedSettings'));
    }
  }
  function ensureSettingsEnhancements(){
    const settings = Array.from(document.querySelectorAll('.settings-menu-ui')).find((element)=>element.isConnected);
    const container = settings?.querySelector(':scope > .container');
    if (!settings || !container || container.querySelector('#sqRankedSettings')) return;
    const section = document.createElement('section');
    section.id = 'sqRankedSettings';
    section.innerHTML = '<h2>Static Options</h2><p class="sq-settings-note">Accessibility, lobby, and Ranked display options.</p><div class="sq-settings-grid"></div>';
    const grid=section.querySelector('.sq-settings-grid');
    grid.appendChild(settingsToggle('Menu keyboard shortcuts','polytrack-0.6.2-hotkeys-enabled',true));

    grid.appendChild(settingsToggle('Full menu animations','polytrack-0.6.2-reduced-effects',true,true));

    grid.appendChild(settingsToggle('PB podium colors and places','polytrack-0.6.2-pb-podiums',true));
    grid.appendChild(settingsToggle('Verified placement field only','polytrack-0.6.2-pb-podiums-verified-only',false));

    grid.appendChild(settingsToggle('Expanded Ranked details','polytrack-0.6.2-compact-ranked',true,true));
    grid.appendChild(settingsToggle('Public racer codes in Ranked','polytrack-0.6.2-show-racer-codes',true));
    grid.appendChild(settingsSecretInput('Multiplayer Discord code','polytrack-0.6.2-turn-backup-code'));
    grid.appendChild(settingsRange('UI text size','polytrack-0.6.2-ui-font-scale',85,125,5,100));
    grid.appendChild(settingsToggle('Hide racer designs','polytrack-0.6.2-plain-racer-themes',false));
    grid.appendChild(settingsRpPrecision());
    container.prepend(section);
  }

  function lobbyShortcutButtons(){
    const candidates = Array.from(document.querySelectorAll('.main-buttons-container button,.main-buttons-container a,.menu-ui > .button-bar > button,.menu-ui > .button-bar > a'));
    const visible = candidates.filter((button,index)=>button.id !== 'overallHelpBtn' && button.id !== 'closeOverallLeaderboard' && isElementVisible(button) && candidates.indexOf(button) === index);
    const signature = (button)=>`${button.id||''} ${button.className||''} ${button.getAttribute('aria-label')||''} ${button.getAttribute('title')||''} ${button.textContent||''} ${Array.from(button.querySelectorAll('img')).map((img)=>img.getAttribute('src')||'').join(' ')}`.toLowerCase();
    const garage = visible.find((button)=>/customize|garage|car-menu/.test(signature(button))) || null;
    const ranked = visible.find((button)=>button.id === 'injectedRankingsBtn' || /rank|trophy/.test(signature(button))) || null;
    const rest = visible.filter((button)=>button !== garage && button !== ranked);
    const ordered = garage ? [garage,...rest] : [...rest];
    if (ranked) ordered.splice(Math.min(5,ordered.length),0,ranked);
    return ordered.slice(0,9);
  }

  function buttonShortcutLetter(button){
    const signature = `${button.id||''} ${button.className||''} ${button.getAttribute('aria-label')||''} ${button.getAttribute('title')||''} ${button.textContent||''} ${Array.from(button.querySelectorAll('img')).map((img)=>img.getAttribute('src')||'').join(' ')}`.toLowerCase();
    if (button.id === 'injectedRankingsBtn' || /rank|trophy/.test(signature)) return 'R';
    if (/play\.svg|\bplay\b/.test(signature)) return 'P';
    if (/customize|garage|car-menu/.test(signature)) return 'G';
    if (/settings/.test(signature)) return 'S';
    if (/multiplayer|invite/.test(signature)) return 'M';
    if (/editor/.test(signature)) return 'E';
    if (/community/.test(signature)) return 'C';
    if (/help/.test(signature)) return 'H';
    return '';
  }

  function findLobbyAction(pattern){
    return lobbyShortcutButtons().find((button)=>pattern.test(`${button.id||''} ${button.className||''} ${button.getAttribute('aria-label')||''} ${button.getAttribute('title')||''} ${button.textContent||''} ${Array.from(button.querySelectorAll('img')).map((img)=>img.getAttribute('src')||'').join(' ')}`.toLowerCase())) || null;
  }

  function handleLobbyShortcut(event){
    if (localStorage.getItem('polytrack-0.6.2-hotkeys-enabled') !== '1' || event.defaultPrevented || event.repeat || event.ctrlKey || event.altKey || event.metaKey || !isStartMenuHotkeyContext()) return false;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target?.isContentEditable) return false;
    const key = String(event.key || '').toLowerCase();
    let action = null;
    if (/^[1-9]$/.test(key)) action = lobbyShortcutButtons()[Number(key)-1] || null;
    else if (key === ' ' || key === 'spacebar' || key === 'p') action = findLobbyAction(/play\.svg|\bplay\b/);
    else if (key === 'r') action = document.getElementById('injectedRankingsBtn');
    else if (key === 'g') action = findLobbyAction(/customize|garage|car-menu/);
    else if (key === 's') action = findLobbyAction(/settings/);
    else if (key === 'm') action = findLobbyAction(/multiplayer|invite/);
    else if (key === 'e') action = findLobbyAction(/editor/);
    else if (key === 'c') action = findLobbyAction(/community/);
    else if (key === 'h') action = findLobbyAction(/help/);
    if (!action || !isElementVisible(action)) return false;
    action.click();
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  let overallDialogReturnFocus=null;
  function visibleDialogFocusables(dialog){
    return Array.from(dialog?.querySelectorAll('button:not([disabled]):not([tabindex="-1"]),summary,a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')||[]).filter(isElementVisible);
  }
  function closeRankedDialog(dialog){
    if(!dialog)return;
    dialog.style.display='none';
    const target=overallDialogReturnFocus;
    overallDialogReturnFocus=null;
    if(target?.isConnected)target.focus({preventScroll:true});
  }
  function openRankedDialog(dialog,focusTarget){
    if(!dialog)return;
    if(dialog.style.display==='none'||!isElementVisible(dialog))overallDialogReturnFocus=document.activeElement;
    dialog.style.display='flex';
    requestAnimationFrame(()=>{(focusTarget||visibleDialogFocusables(dialog)[0])?.focus({preventScroll:true});});
  }
  function trapRankedDialogFocus(event,dialog){
    if(event.key!=='Tab'||!dialog||!isElementVisible(dialog))return false;
    const focusables=visibleDialogFocusables(dialog); if(!focusables.length)return false;
    const first=focusables[0]; const last=focusables[focusables.length-1];
    if(event.shiftKey&&document.activeElement===first){last.focus();event.preventDefault();return true;}
    if(!event.shiftKey&&document.activeElement===last){first.focus();event.preventDefault();return true;}
    return false;
  }

  /* Keep the select as an internal state bridge; the accessible popup owns interaction. */
  function ensureRankedCategoryPicker(select,control){
    if(!select||!control)return;
    select.hidden=true;
    select.setAttribute('aria-hidden','true');
    select.tabIndex=-1;
    let trigger=control.querySelector('.sq-category-trigger');
    if(!trigger){
      trigger=document.createElement('button');
      trigger.type='button';
      trigger.className='sq-category-trigger';
      trigger.setAttribute('aria-haspopup','menu');
      trigger.setAttribute('aria-expanded','false');
      select.parentElement.appendChild(trigger);
      trigger.addEventListener('click',()=>openRankedCategoryMenu(trigger));
      trigger.addEventListener('keydown',event=>{
        if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();openRankedCategoryMenu(trigger);}
      });
    }
    trigger.textContent=(LEADERBOARD_LABELS[overallCategory]||'Overall RP')+'  ▾';
    trigger.setAttribute('aria-label','Rank by '+(LEADERBOARD_LABELS[overallCategory]||'Overall RP'));
  }
  let closeRankedCategoryMenu=null;
  function openRankedCategoryMenu(trigger){
    if(closeRankedCategoryMenu){closeRankedCategoryMenu();return;}
    const primary=['overall','casual','average','tracks','medals','topTracks','events'];
    const extras=['skill','competitiveAverage','wins','podiumRate','consistency','rising','pbs','weight','playtime','veterans'];
    const menu=document.createElement('div');
    menu.className='sq-category-popup';
    menu.setAttribute('role','menu');
    menu.setAttribute('aria-label','Rankings');
    const makeItem=key=>{
      const item=document.createElement('button');
      item.type='button';item.dataset.category=key;item.tabIndex=-1;
      item.setAttribute('role','menuitemradio');
      item.setAttribute('aria-checked',String(overallCategory===key));
      item.textContent=key==='events'?'Event RP':LEADERBOARD_LABELS[key]||key;
      item.title=LEADERBOARD_INFO[key]||'';
      item.addEventListener('click',()=>{closeRankedCategoryMenu?.();setOverallCategory(key);});
      return item;
    };
    primary.forEach(key=>menu.appendChild(makeItem(key)));
    const more=document.createElement('button');
    more.type='button';more.tabIndex=-1;more.textContent='More  ›';
    more.setAttribute('role','menuitem');more.setAttribute('aria-haspopup','menu');more.setAttribute('aria-expanded','false');
    menu.appendChild(more);
    const sub=document.createElement('div');sub.className='sq-category-submenu';sub.hidden=true;
    sub.setAttribute('role','menu');sub.setAttribute('aria-label','More rankings');
    extras.forEach(key=>sub.appendChild(makeItem(key)));menu.appendChild(sub);
    const openMore=(focus=false)=>{sub.hidden=false;more.setAttribute('aria-expanded','true');position();if(focus)sub.querySelector('button').focus();};
    more.addEventListener('click',()=>openMore(true));
    more.addEventListener('pointerenter',()=>openMore());
    function position(){
      const r=trigger.getBoundingClientRect();
      const width=Math.min(248,innerWidth-16);
      menu.style.width=width+'px';
      menu.style.left=Math.max(8,Math.min(r.right-width,innerWidth-width-8))+'px';
      menu.style.top=Math.max(8,Math.min(r.top-menu.offsetHeight-8,innerHeight-menu.offsetHeight-8))+'px';
      const m=menu.getBoundingClientRect();
      sub.style.width=width+'px';
      if(innerWidth>=560){sub.style.position='fixed';sub.style.left=(m.left>=width+16?m.left-width-6:Math.min(innerWidth-width-8,m.right+6))+'px';sub.style.top=Math.max(8,Math.min(m.top,innerHeight-sub.offsetHeight-8))+'px';}
      else {sub.style.position='static';sub.style.width='100%';}
    }
    const outside=event=>{if(!menu.contains(event.target)&&!trigger.contains(event.target))close(false);};
    const close=(restore=true)=>{
      menu.remove();trigger.setAttribute('aria-expanded','false');
      document.removeEventListener('pointerdown',outside,true);
      window.removeEventListener('resize',position);
      closeRankedCategoryMenu=null;if(restore&&trigger.isConnected)trigger.focus();
    };
    closeRankedCategoryMenu=close;
    menu.addEventListener('keydown',event=>{
      const group=sub.contains(event.target)?sub:menu;
      const items=Array.from(group.children).filter(x=>x.tagName==='BUTTON');
      const index=items.indexOf(event.target);
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}
      else if(event.key==='Tab'){close(false);}
      else if(event.key==='ArrowRight'&&event.target===more){event.preventDefault();openMore(true);}
      else if(event.key==='ArrowLeft'&&group===sub){event.preventDefault();sub.hidden=true;more.setAttribute('aria-expanded','false');more.focus();position();}
      else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
        event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;items[next]?.focus();
      }
    });
    document.body.appendChild(menu);trigger.setAttribute('aria-expanded','true');
    position();menu.querySelector('button').focus();
    document.addEventListener('pointerdown',outside,true);window.addEventListener('resize',position);
  }

  function syncCategorySelect(root=document){
    const select=root.querySelector('#overallCategorySelect');
    const control=root.querySelector('.overall-category-control');
    const label=LEADERBOARD_LABELS[overallCategory]||'Overall RP';
    const tip=LEADERBOARD_INFO[overallCategory]||'This ranking uses the current complete Ranked snapshot.';
    if(select&&select.value!==overallCategory)select.value=overallCategory;
    if(select)select.title=`${label}. ${tip}`;
    if(control){
      ensureRankedCategoryPicker(select,control);
      control.dataset.tip=tip;
      let info=control.querySelector('[data-category-info]');
      let copy=control.querySelector('.overall-category-description');
      if(!info){
        info=document.createElement('button');
        info.type='button';
        info.className='overall-category-info';
        info.dataset.categoryInfo='';
        info.setAttribute('aria-expanded','false');
        info.textContent='i';
        control.appendChild(info);
      }
      if(!copy){
        copy=document.createElement('span');
        copy.className='overall-category-description';
        copy.setAttribute('role','tooltip');
        control.appendChild(copy);
      }
      if(info){info.title=tip;info.setAttribute('aria-label',`${label}: ${tip}`);}
      if(copy)copy.textContent=tip;
    }
  }
  function setOverallCategory(next){
    const selected=String(next||'overall');
    const panel=document.getElementById('overallLeaderboardPanel');
    if(!panel||selected===overallCategory)return;
    overallCategory=selected;
    if(typeof mirrorRankedFilterCategory==='function')mirrorRankedFilterCategory(selected);
    recordLeaderboardUse(selected);
    refreshLeaderboardArcade();
    const scope=panel.querySelector('#overallTrackScope');
    if(scope)scope.hidden=selected!=='tracks';
    if(selected==='tracks')panel.querySelectorAll('[data-track-scope]').forEach((button)=>{const active=button.dataset.trackScope==='all';button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});
    overallPage=0;
    syncCategorySelect(panel);
    renderEntries();
    updateRankedFreshness();
    if(selected==='events')void fetchEventTotals();
    else if(!overallEntriesCache.length)void openPanel();
  }

  function ensurePanel(){
    if (document.getElementById('overallLeaderboardPanel')) return;
    const panel = document.createElement('div');
    panel.id = 'overallLeaderboardPanel';
    panel.innerHTML = `<div class="overall-shell"><div class="overall-top"><div class="overall-title-group"><h2>${tRankingsTitle()}</h2></div><div class="overall-actions"><button id="overallFindMeBtn" class="button overall-action-btn" type="button">Find me</button><button id="overallHelpBtn" class="button overall-action-btn" type="button">Help</button><button id="closeOverallLeaderboard" class="button overall-action-btn" type="button">${tr('close')}</button></div></div><div id="overallFilterPanel" class="overall-filter-host"></div><div class="overall-columns" aria-hidden="true"><span>Place</span><span>Driver</span><span>Movement & bests</span><span>Score</span></div><div id="overallLeaderboardList"></div>${dailySpotlightMarkup()}<div id="overallProfilePopup"><div class="overall-profile-card" role="dialog" aria-modal="true" aria-label="Racer profile"><div class="profile-dialog-toolbar"><span>Racer profile</span><button id="overallProfileClose" class="button" type="button">Close</button></div><div id="overallProfileContent"></div></div></div><div id="overallHelpPopup"><div class="overall-help-card" role="dialog" aria-modal="true" aria-labelledby="overallHelpTitle"><div class="overall-help-head"><h3 id="overallHelpTitle">How Ranked works</h3></div><div class="overall-help-content"><section><b>Overall RP</b><p>Lower is better. Overall RP is 68% best-ten skill, 20% diminishing track coverage, and 12% protected all-track depth.</p></section><section><b>Track weight</b><p>Every screen uses the same track value: type multiplier, diminishing field size, and the track's time spread. Official tracks use 1.6x, community 1.0x, and custom 0.6x. Solo tracks score zero.</p></section><section><b>Eligibility</b><p>One or two eligible tracks are provisional. Three populated tracks establish a Ranked position.</p></section><section><b>Podium points</b><p>Recognized tracks with at least five drivers award 9 for first, 3 for second, and 1 for third. Podium rate requires three eligible tracks.</p></section><section><b>Run verification</b><p>A checkmark means the replay reproduced its exact finish in the trusted physics engine. Waiting means not approved yet. Automatic review currently covers known tracks up to five minutes; other runs stay saved and waiting.</p></section><section><b>Badges</b><p>Badges such as Beta Tester are issued by the Ranked server and cannot be granted by the browser.</p></section><section><b>Route planner</b><p>Every plan is for you. Your profile shows ways to improve; another profile shows ways to catch that racer or extend your lead.</p></section><section><b>Saved data</b><p>Rankings stay available offline. Red means a cloud refresh failed; “up to date” means the cloud responded and no newer complete snapshot exists.</p></section><aside class="sq-track-submit"><strong>Made a track?</strong><span>Submit it for a chance to be featured in the StaticQuasar931 tab.</span><a href="https://discord.gg/DP2hM7RRhR" target="_blank" rel="noopener noreferrer">Submit on Discord</a></aside><p class="overall-help-note">Saved PBs remain. New track finishes can change positions.</p><p><strong>Please suggest new features and changes.</strong> Join the <a href="https://discord.gg/DP2hM7RRhR" target="_blank" rel="noopener noreferrer">Discord</a> or use the <a href="https://sites.google.com/view/staticquasar931/google-form?utm_source=polytrack&amp;utm_medium=game&amp;utm_campaign=ranked_feedback" target="_blank" rel="noopener noreferrer">feedback form</a>.</p><div class="overall-help-actions"><button id="overallHelpClose" class="button overall-action-btn" type="button">Close help</button></div></div></div></div></div>`;
    document.body.appendChild(panel);
    void ensureRankedFiltersUi();
    panel.addEventListener('click', (event)=>{
      if(!event.target.closest?.('[data-category-info]')){
        const categoryControl=panel.querySelector('.overall-category-control');
        categoryControl?.classList.remove('is-explaining');
        categoryControl?.querySelector('[data-category-info]')?.setAttribute('aria-expanded','false');
      }
      if (event.target === panel) panel.style.display='none';
      if (event.target === panel.querySelector('#overallProfilePopup')) closeRankedDialog(panel.querySelector('#overallProfilePopup'));
      if (event.target === panel.querySelector('#overallHelpPopup')) closeRankedDialog(panel.querySelector('#overallHelpPopup'));
      const publicIdButton=event.target.closest?.('[data-copy-public-id]');
      if(publicIdButton){
        const accountId=cleanUserId(publicIdButton.dataset.copyPublicId);
        if(!/^[a-f0-9]{64}$/.test(accountId))return;
        try{Promise.resolve(navigator.clipboard.writeText(accountId)).then(()=>{publicIdButton.textContent='Public ID copied';},()=>{publicIdButton.textContent='Copy unavailable';publicIdButton.title='Your public ID: '+accountId;});}
        catch{publicIdButton.textContent='Copy unavailable';publicIdButton.title='Your public ID: '+accountId;}
        return;
      }
      const copy = event.target.closest?.('[data-racer-code]');
      if (copy) {
        navigator.clipboard?.writeText(copy.dataset.label || '').then(()=>{ copy.textContent='CODE COPIED'; setTimeout(()=>{ if(copy.isConnected) copy.textContent=copy.dataset.label||'RACER CODE'; },1200); }).catch(()=>{});
      }
      if (event.target.closest?.('[data-rank-retry]')) openPanel(true);
      if (event.target.closest?.('#overallFreshness')) requestRankedRefresh();
      if (event.target.closest?.('#overallPrevPage')) changeOverallPage(-1);
      if (event.target.closest?.('#overallNextPage')) changeOverallPage(1);
      const leaderboardShortcut=event.target.closest?.('[data-leaderboard-shortcut]');
      if(leaderboardShortcut&&leaderboardShortcut.dataset.leaderboardShortcut==='events'){setOverallCategory('events');return;}
      if(leaderboardShortcut){
        overallCategory=String(leaderboardShortcut.dataset.leaderboardShortcut||'overall');
        if(typeof mirrorRankedFilterCategory==='function')mirrorRankedFilterCategory(overallCategory);
        recordLeaderboardUse(overallCategory);
        refreshLeaderboardArcade();
        overallPage=0;
        const select=panel.querySelector('#overallCategorySelect'); if(select)select.value=overallCategory;
        renderEntries();
        return;
      }
      const scope=event.target.closest?.('[data-track-scope]');
      if(scope){
        const value=String(scope.dataset.trackScope||'all');
        overallCategory=value==='official'?'official':value==='community'?'community':'tracks';
        if(typeof mirrorRankedFilterCategory==='function')mirrorRankedFilterCategory(overallCategory);
        panel.querySelectorAll('[data-track-scope]').forEach((button)=>{const active=button===scope;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});
        overallPage=0;
        renderEntries();
      }
      const summaryTrack=event.target.closest?.('[data-summary-track-id]');
      if(summaryTrack?.dataset.summaryTrackId){
        const details=summaryTrack.closest('details');
        if(details?.open){event.preventDefault();event.stopPropagation();focusTrackFromRanked(summaryTrack.dataset.summaryTrackId);return;}
      }
      const cosmeticChoice=event.target.closest?.('[data-cosmetic-choice]');
      if(cosmeticChoice&&!cosmeticChoice.disabled){
        const card=cosmeticChoice.closest('.overall-profile-card');
        const entryId=cleanUserId(card?.querySelector('[data-save-profile-cosmetics]')?.dataset.accountId||'');
        const draft={...sanitizeProfileCosmetics(profileCosmeticDrafts.get(entryId)),[cosmeticChoice.dataset.cosmeticKind]:cosmeticChoice.dataset.cosmeticValue};
        profileCosmeticDrafts.set(entryId,draft);
        cosmeticChoice.parentElement.querySelectorAll('[data-cosmetic-choice]').forEach((choice)=>{const selected=choice===cosmeticChoice;choice.classList.toggle('selected',selected);choice.setAttribute('aria-pressed',String(selected));});
        applyProfileCosmetics(card,draft);
        const studioEntry=profileCosmeticEntries.get(entryId)||{};
        if(cosmeticChoice.dataset.cosmeticKind==='title'){
          const resolved=cosmeticTitleText(studioEntry,draft);
          card.querySelectorAll('[data-cosmetic-title-preview]').forEach((node)=>{node.textContent=resolved;});
        }
        if(cosmeticChoice.dataset.cosmeticKind==='badge'){
          const badges=profileBadgeMarkup(studioEntry,true,draft);
          card.querySelectorAll('[data-cosmetic-badge-preview]').forEach((node)=>{node.innerHTML=badges;});
        }
        return;
      }
      const categoryInfo=event.target.closest?.('[data-category-info]');
      if(categoryInfo){
        const control=categoryInfo.closest('.overall-category-control');
        const open=!control.classList.contains('is-explaining');
        control.classList.toggle('is-explaining',open);
        categoryInfo.setAttribute('aria-expanded',String(open));
        return;
      }
      const studioTab=event.target.closest?.('[data-studio-tab]');
      if(studioTab){
        const controls=studioTab.closest('.profile-customizer-controls');
        const wanted=studioTab.dataset.studioTab;
        controls.querySelectorAll('[data-studio-tab]').forEach((node)=>{node.setAttribute('aria-selected',String(node===studioTab));node.tabIndex=node===studioTab?0:-1;});
        controls.querySelectorAll('[data-studio-panel]').forEach((node)=>{node.hidden=node.dataset.studioPanel!==wanted;});
        return;
      }
      const podiumChoice=event.target.closest?.('[data-cosmetic-podium]');
      if(podiumChoice){
        const card=podiumChoice.closest('.overall-profile-card');
        const entryId=cleanUserId(card?.querySelector('[data-save-profile-cosmetics]')?.dataset.accountId||'');
        const current=sanitizeProfileCosmetics(profileCosmeticDrafts.get(entryId));
        const draft={...current,overridePodium:!current.overridePodium};
        profileCosmeticDrafts.set(entryId,draft);
        podiumChoice.classList.toggle('selected',draft.overridePodium);
        podiumChoice.setAttribute('aria-pressed',String(draft.overridePodium));
        podiumChoice.textContent=draft.overridePodium?'Use my design':'Keep podium colors';
        applyProfileCosmetics(card,draft);
        return;
      }
      const discard=event.target.closest?.('[data-discard-profile-cosmetics]');
      if(discard){const id=discard.closest('.profile-customizer').querySelector('[data-save-profile-cosmetics]').dataset.accountId;profileCosmeticDrafts.delete(id);openRankedProfile(id);const studio=panel.querySelector('.profile-customizer');studio.open=true;studio.scrollIntoView({block:'start'});studio.querySelector('summary').focus();return;}
      const cosmeticSave=event.target.closest?.('[data-save-profile-cosmetics]');
      if(cosmeticSave){
        const actions=cosmeticSave.closest('.profile-customizer-actions');
        saveRankedProfileCosmetics(cosmeticSave.dataset.accountId,actions?.querySelector('[role="status"]'),cosmeticSave);
        return;
      }
      const trackTarget=event.target.closest?.('[data-track-id]');
      if(trackTarget){focusTrackFromRanked(trackTarget.dataset.trackId);return;}
      const profileSortTarget=event.target.closest?.('[data-profile-sort]');
      if(profileSortTarget){
        const nextSort=String(profileSortTarget.dataset.profileSort||'place');
        if(profileSort===nextSort)profileSortDirection*=-1;
        else{
          profileSort=nextSort;
          profileSortDirection=nextSort==='weight'?-1:1;
        }
        openRankedProfile(profileSortTarget.dataset.profileUser||'');
        return;
      }
      const racerRow=event.target.closest?.('.overall-entry[data-userid]');
      if(racerRow) openRankedProfile(racerRow.dataset.userid);
    });
    panel.addEventListener('change',(event)=>{
      if(event.target?.id==='overallCategorySelect'){setOverallCategory(event.target.value);return;}
      if(event.target?.matches?.('[data-cosmetic-favorite]')){
        const card=event.target.closest('.overall-profile-card');
        const entryId=cleanUserId(card?.querySelector('[data-save-profile-cosmetics]')?.dataset.accountId||'');
        const typed=String(event.target.value||'').trim().toLowerCase();
        const matches=Array.from(TRACK_CATALOG.values()).filter((track)=>track.name.toLowerCase()===typed);
        const match=matches.find(track=>track.id===event.target.dataset.selectedTrackId)||(matches.length===1?matches[0]:null);
        if(match)profileCosmeticDrafts.set(entryId,{...sanitizeProfileCosmetics(profileCosmeticDrafts.get(entryId)),favoriteTrackId:match.id});
        event.target.setAttribute('aria-invalid',String(Boolean(typed)&&!match));
        return;
      }
    });
    panel.querySelector('#closeOverallLeaderboard').addEventListener('click', ()=>{ panel.style.display='none'; });
    panel.querySelector('#overallFindMeBtn').addEventListener('click',focusCurrentRacer);
    panel.querySelector('#overallHelpBtn').addEventListener('click', ()=>{
      const pop = panel.querySelector('#overallHelpPopup');
      openRankedDialog(pop,panel.querySelector('#overallHelpClose'));
    });
    panel.querySelector('#overallHelpClose').addEventListener('click', ()=>{
      const pop = panel.querySelector('#overallHelpPopup');
      closeRankedDialog(pop);
      try { localStorage.setItem('polytrack-0.6.2-ranked-guide-seen-v1','1'); } catch {}
    });
    panel.querySelector('#overallProfileClose').addEventListener('click',()=>closeRankedDialog(panel.querySelector('#overallProfilePopup')));
    panel.addEventListener('keydown', (event)=>{
      const profile = panel.querySelector('#overallProfilePopup');
      const help = panel.querySelector('#overallHelpPopup');
      if(trapRankedDialogFocus(event,isElementVisible(profile)?profile:isElementVisible(help)?help:null))return;
      if (event.key === 'Escape') {
        if (isElementVisible(profile)) { closeRankedDialog(profile); event.preventDefault(); return; }
        if (isElementVisible(help)) { closeRankedDialog(help); event.preventDefault(); return; }
        panel.style.display='none';
        event.preventDefault();
      }
      if((event.key==='Enter'||event.key===' ')&&event.target.matches?.('.overall-track-entry[data-track-id]')){event.preventDefault();focusTrackFromRanked(event.target.dataset.trackId);return;}
      if((event.key==='Enter'||event.key===' ')&&event.target.matches?.('.overall-entry[data-userid]')){openRankedProfile(event.target.dataset.userid);event.preventDefault();}
    });
  }

  function normalizedFinishSamples(entry){
    const seen=new Set(); const out=[];
    for(const finish of [...(Array.isArray(entry?.resultSamples)?entry.resultSamples:[]),...(Array.isArray(entry?.bestTracks)?entry.bestTracks:[]),...(Array.isArray(entry?.weightedResults)?entry.weightedResults:[]),...(Array.isArray(entry?.opportunityTracks)?entry.opportunityTracks:[]),entry?.strongestTrack,entry?.worstTrack,entry?.improvementTrack]){
      const normalized=normalizeFinishSummary(finish);
      if(!normalized?.trackId||seen.has(normalized.trackId))continue;
      seen.add(normalized.trackId); out.push(normalized);
    }
    const userId=cleanUserId(entry?.userId||entry?.accountId||'');
    const overallAt=Number(readJsonStorage(OVERALL_CACHE_KEY,{})?.serverUpdatedAt||0)||0;
    for(const overlay of cachedTrackFinishOverlays().get(userId)||[]){
      if(Number(overlay.cachedAt||0)<overallAt)continue;
      const index=out.findIndex((finish)=>finish.trackId===overlay.trackId);
      if(index>=0)out[index]={...out[index],...overlay};
      else out.push(overlay);
    }
    return out;
  }
  function fallbackAverageFinish(entry){
    const explicit=Number(entry?.averageFinish||0)||0;
    if(Number(entry?.averageFinishVersion||0)>=AVERAGE_FINISH_VERSION&&explicit>0)return explicit;
    // Older snapshots stored a normalized RP cost in this field, not an average place.
    return 0;
  }
  function fallbackPodiumRate(entry){
    const explicit=Number(entry?.podiumRate||0)||0;
    if(explicit>0)return Math.min(100,explicit);
    const medals=fallbackMedals(entry);
    const podiums=Number(medals.gold||0)+Number(medals.silver||0)+Number(medals.bronze||0);
    const eligible=Math.max(0,Number(entry?.podiumEligibleTracks||0)||0);
    return eligible>=MIN_RANKED_TRACKS?Math.min(100,podiums/eligible*100):0;
  }
  function fallbackMedals(entry){
    const saved={gold:Math.max(0,Number(entry?.medals?.gold||0)||0),silver:Math.max(0,Number(entry?.medals?.silver||0)||0),bronze:Math.max(0,Number(entry?.medals?.bronze||0)||0)};
    const derived={gold:0,silver:0,bronze:0};
    for(const finish of normalizedFinishSamples(entry)){
      const medal=medalForRank(finish.rank,finish.fieldSize,finish.trackId);
      if(medal)derived[medal]++;
    }
    return {gold:Math.max(saved.gold,derived.gold),silver:Math.max(saved.silver,derived.silver),bronze:Math.max(saved.bronze,derived.bronze)};
  }
  const SERVER_COSMETIC_UNLOCK_IDS=new Set(['emblem:target','stripe:overdrive']);
  function safeServerInteger(value,{positive=false}={}){
    const number=Number(value);
    return Number.isSafeInteger(number)&&number>=(positive?1:0)?number:null;
  }
  function sanitizeServerAchievementProof(value){
    if(!value||typeof value!=='object'||!SERVER_COSMETIC_UNLOCK_IDS.has(value.cosmeticId))return null;
    const expected=value.cosmeticId==='emblem:target'?{id:'beat-owner-1',threshold:1}:{id:'beat-owner-3',threshold:3};
    const trackId=String(value.trackId||'').replace(/[<>\u0000-\u001f]/g,'').trim().slice(0,80);
    const sourceSignature=String(value.sourceSignature||'').replace(/[^A-Za-z0-9_-]/g,'').slice(0,128);
    const sourceRevision=safeServerInteger(value.sourceRevision,{positive:true});
    const sourceUpdatedAt=safeServerInteger(value.sourceUpdatedAt,{positive:true});
    const playerTimeMs=safeServerInteger(value.playerTimeMs,{positive:true});
    const targetTimeMs=safeServerInteger(value.targetTimeMs,{positive:true});
    const unlockedAt=safeServerInteger(value.unlockedAt,{positive:true});
    if(value.id!==expected.id||Number(value.threshold)!==expected.threshold||value.source!=='ranked-track-snapshot'||!trackId||sourceSignature.length<16||!sourceRevision||!sourceUpdatedAt||!playerTimeMs||!targetTimeMs||playerTimeMs>=targetTimeMs||!unlockedAt)return null;
    return {id:expected.id,threshold:expected.threshold,cosmeticId:value.cosmeticId,trackId,source:'ranked-track-snapshot',sourceRevision,sourceUpdatedAt,sourceSignature,playerTimeMs,targetTimeMs,playerPbAt:safeServerInteger(value.playerPbAt)||0,targetPbAt:safeServerInteger(value.targetPbAt)||0,unlockedAt};
  }
  function sanitizeServerAchievements(value){
    const beatOwner=value?.beatOwner;
    if(!beatOwner||typeof beatOwner!=='object')return null;
    const targetAccountId=cleanUserId(beatOwner.targetAccountId);
    const count=safeServerInteger(beatOwner.count);
    if(!/^[a-f0-9]{64}$/.test(targetAccountId)||count===null||count>500)return null;
    const unlocks=[];
    for(const source of Array.isArray(beatOwner.unlocks)?beatOwner.unlocks:[]){
      const proof=sanitizeServerAchievementProof(source);
      if(proof&&!unlocks.some(row=>row.cosmeticId===proof.cosmeticId))unlocks.push(proof);
      if(unlocks.length===2)break;
    }
    return {beatOwner:{targetAccountId,count,unlocks}};
  }
  function normalizeEntries(entries){
    if (!Array.isArray(entries)) return [];
    return entries.map((entry, i) => ({
      rank: entry.rank===0?0:Number(entry.rank || i + 1),
      userId: String(entry.userId || entry.accountId || `overall-${i+1}`),
      name: String(entry.name || 'Unknown'),
      countryCode: typeof entry.countryCode === 'string' ? entry.countryCode.slice(0,8).toUpperCase() : '',
      score: Math.max(1.000001, Number(entry.score ?? entry.averageRank ?? 1.000001) || 1.000001),
      raceCount: Number(entry.raceCount || 0),
      totalTracks: Number(entry.totalTracks || TOTAL_TRACKS) || TOTAL_TRACKS,
      carColors: normalizeCarColorId(entry.carColors || 'ffffff8ec7ff28346a212b58'),
      carId: extractCarId(entry),
      carColorId: normalizeCarColorId(entry.carColors || 'ffffff8ec7ff28346a212b58'),
      bestTrackId: String(entry.bestTrackId || ''),
      bestTrackRank: Number(entry.bestTrackRank || 0) || 0,
      bestTrackField: Number(entry.bestTrackField || 0) || 0,
      bestTracks: (Array.isArray(entry.bestTracks) ? entry.bestTracks : []).slice(0,2).map(normalizeFinishSummary),
      resultSamples: (Array.isArray(entry.resultSamples)?entry.resultSamples:[]).slice(0,500).map(normalizeFinishSummary),
      strongestTrack: normalizeFinishSummary(entry.strongestTrack),
      improvementTrack: normalizeFinishSummary(entry.improvementTrack),
      weightedResults: (Array.isArray(entry.weightedResults) ? entry.weightedResults : []).slice(0,2).map(normalizeFinishSummary),
      opportunityTracks: (Array.isArray(entry.opportunityTracks) ? entry.opportunityTracks : []).slice(0,3).map(normalizeFinishSummary),
      worstTrack: normalizeFinishSummary(entry.worstTrack),
      medals: fallbackMedals(entry),
      officialCount: Number(entry.officialCount || 0) || 0,
      communityCount: Number(entry.communityCount || 0) || 0,
      customCount: Number(entry.customCount || 0) || 0,
      weightedTracks: Number(entry.weightedTracks || 0) || 0,
      skillCost: Math.max(0,Number(entry.skillCost||entry.score||0)||0),
      coverageCost: Math.max(0,Number(entry.coverageCost||0)||0),
      consistencyCost: Math.max(0,Number(entry.consistencyCost||entry.score||0)||0),
      averageFinish: Math.max(0,fallbackAverageFinish(entry)),
      averageFinishVersion: Math.max(0,Number(entry.averageFinishVersion||0)||0),
      averagePlacement: Math.max(0,Number(entry.averagePlacement||0)||0),
      averagePlacementVersion: Math.max(0,Number(entry.averagePlacementVersion||0)||0),
      competitiveAveragePlacement: entry.competitiveAveragePlacement==null?null:Math.max(0,Number(entry.competitiveAveragePlacement)||0),
      competitiveAverageEligibleTracks: Math.max(0,Number(entry.competitiveAverageEligibleTracks||0)||0),
      trackWins: entry.trackWins==null?null:Math.max(0,Number(entry.trackWins)||0),
      podiumEligibleTracks: Math.max(0,Number(entry.podiumEligibleTracks||0)||0),
      podiumRate: Math.max(0,fallbackPodiumRate(entry)),
      pbCount: Math.max(0,Number(entry.pbCount || 0) || 0),
      totalPlaytimeMs: Number.isFinite(entry.totalPlaytimeMs)&&entry.totalPlaytimeMs>=0?entry.totalPlaytimeMs:null,
      daysActive: Number.isSafeInteger(entry.daysActive)&&entry.daysActive>=0?entry.daysActive:null,
      verified: typeof entry.verified==='boolean'?entry.verified:null,
      casualRp: Number.isSafeInteger(entry.casualRp)&&entry.casualRp>=0?entry.casualRp:null,
      casualCompletionCount: Number.isSafeInteger(entry.casualCompletionCount)&&entry.casualCompletionCount>=0?entry.casualCompletionCount:null,
      cosmeticUnlocks: [...new Set((Array.isArray(entry.cosmeticUnlocks)?entry.cosmeticUnlocks:[]).filter(value=>SERVER_COSMETIC_UNLOCK_IDS.has(value)))].slice(0,2),
      serverAchievements: sanitizeServerAchievements(entry.serverAchievements),
      provisional: Boolean(entry.provisional)||Number(entry.raceCount||0)<MIN_RANKED_TRACKS,
      rankTier: String(entry.rankTier||'').slice(0,32),
      movement: Number(entry.movement || 0) || 0,
      movementAt: Number(entry.movementAt || 0) || 0,
      rankSince: Math.max(0,Number(entry.rankSince||0)||0),
      scoreDelta: Number(entry.scoreDelta || 0) || 0,
      accountCreatedAt: Math.max(0,Number(entry.accountCreatedAt||0)||0),
      latestPbAt: Math.max(0,Number(entry.latestPbAt||0)||0),
      badges: entry.badges&&typeof entry.badges==='object'?{betaTester:entry.badges.betaTester===true}:null,
      profileCosmetics: sanitizeProfileCosmetics(entry.profileCosmetics),
      profileAccent: String(entry.profileAccent||'').replace(/[^a-z0-9_-]/gi,'').slice(0,24),
      carStyle: __pt062NormalizeStyle(entry.carStyle || __pt062GetRememberedStyle(entry.userId || entry.accountId) || ''),
      rankModel: String(entry.rankModel || ''),
      timingVersion: Math.max(0,Number(entry.timingVersion||0)||0)
    })).sort((a,b)=>Number(a.provisional)-Number(b.provisional)||(a.rank||Infinity)-(b.rank||Infinity)||a.score-b.score).slice(0, 200);
  }

  function normalizeFinishSummary(finish){
    if(!finish || typeof finish!=='object') return null;
    const trackId=String(finish.trackId||'').slice(0,80);
    if(!trackId) return null;
    return {
      trackId,
      rank:Math.max(0,Number(finish.rank||0)||0),
      fieldSize:Math.max(0,Number(finish.fieldSize||0)||0),
      weight:Math.max(0,Number(finish.weight||0)||0),
      contribution:Math.max(0,Number(finish.contribution||0)||0),
      improvementValue:Math.max(0,Number(finish.improvementValue||0)||0),
      placementCost:Math.max(0,Number(finish.placementCost||rankedPlacementCost(finish.rank,finish.fieldSize))||0),
      competition:Math.max(0,Number(finish.competition||1)||1),
      relativeGap:Math.max(0,Number(finish.relativeGap||0)||0),
      depthBoost:Math.max(0,Number(finish.depthBoost||1)||1),
      timeMs:Math.max(0,Number(finish.timeMs||0)||0),
      pbAt:Math.max(0,Number(finish.pbAt||finish.createdAt||0)||0),
      timingVersion:Math.max(0,Number(finish.timingVersion||0)||0),
      type:String(finish.type||'community')
    };
  }


  function localTrackDisplayEntries(trackId,entries,accountId,hasCompleteField=true){
    if(!hasCompleteField)return [];
    const cloud=Array.isArray(entries)?entries:[];
    if(!accountId)return cloud;
    const mine=cloud.find(row=>String(row.accountId||row.userId||'')===String(accountId));
    let best=mine;let bestMs=canonicalRaceTimeMs(mine)||Infinity;
    for(const row of readLocalRaceRows()){
      if(row.trackId!==trackId||String(row.accountId||row.userId||'')!==String(accountId))continue;
      const ms=canonicalRaceTimeMs(row);
      if(ms>0&&ms<bestMs){best=row;bestMs=ms;}
    }
    if(!best||best===mine)return cloud;
    // This is a viewer-only projection, never a replacement for the cloud snapshot.
    const localId=safeRecordingId(best.uploadId||best.id)||buildRecordingId(best);
    const local={...mine,...best,id:localId,uploadId:localId,accountId,userId:accountId,timeMs:bestMs,frames:Number(best.frames||best.raceTimeFrames||bestMs),raceTimeFrames:Number(best.raceTimeFrames||best.frames||bestMs),runVerified:false,verifiedState:0,integrityVerified:false,localPending:true,cloudTimeMs:canonicalRaceTimeMs(mine)||null};
    return [...cloud.filter(row=>String(row.accountId||row.userId||'')!==String(accountId)),local];
  }
  function visibleTrackEntries(entries,onlyVerified,accountId){
    const sorted=[...(entries||[])].sort((a,b)=>canonicalRaceTimeMs(a)-canonicalRaceTimeMs(b)||String(a.accountId||a.userId||'').localeCompare(String(b.accountId||b.userId||'')));
    const hasVerified=sorted.some(entry=>entry.runVerified===true);
    // A visibility filter must not promote a waiting racer past hidden faster runs.
    return sorted.map((entry,index)=>({...entry,rank:index+1,position:index+1})).filter(entry=>!onlyVerified||!hasVerified||entry.runVerified===true||String(entry.accountId||entry.userId||'')===String(accountId||''));
  }

  function computeTrackTopEntries(rows, trackId, limit=10){
    const bestByUser = new Map();
    for (const row of rows) {
      if (String(row.trackId || '') !== String(trackId || '')) continue;
      const userId = String(row.accountId || row.userId || '').slice(0, 128);
      if (!userId) continue;
      const parsedFrames = safePositiveInt(row.frames || row.raceTimeFrames || row.time?.numberOfFrames || 0, 0);
      const timeMs = canonicalRaceTimeMs(row);
      if (!Number.isFinite(timeMs) || timeMs <= 0) continue;
      const prev = bestByUser.get(userId);
      if (!prev || timeMs < prev.timeMs) {
        const safeName = safeDisplayName(row.nickname || row.name || getLastKnownName(userId) || 'Guest', userId);
        const carStyle = __pt062NormalizeStyle(row.carStyle || __pt062GetRememberedStyle(userId) || row.carColors || '');
        bestByUser.set(userId, {
          accountId: userId,
          userId,
          trackId:String(trackId || '').slice(0,80),
          name: safeName,
          nickname: safeName,
          countryCode: typeof row.countryCode === 'string' ? row.countryCode.slice(0, 8) : null,
          timeMs,
          timingVersion:2,
          raceTimeFrames: Number(row.raceTimeFrames || 0) || null,
          frames: safePositiveInt(parsedFrames || timeMs, 1),
          runVerified: row.runVerified === true,
          verifiedState: row.runVerified === true ? 1 : 0,
          integrityVerified: row.integrityVerified === true,
          validationState: row.integrityVerified === true ? 'integrity' : String(row.validationState||'pending').slice(0,24),
          replayHash: row.replayHash || null,
          uploadId: safeRecordingId(row.uploadId || row.id) || null,
          carId: extractCarId(row) || null,
          carColors: normalizeCarColorId(row.carColors || ''),
          carStyle,
          pbCount:Math.max(0,Number(row.pbCount||0)||0),
          totalPlaytimeMs:Math.max(0,Number(row.totalPlaytimeMs||0)||0),
          createdAt: pbTimestamp(row),
          pbAt: pbTimestamp(row),
          accountCreatedAt: Math.max(0,Number(row.accountCreatedAt||0)||0),
          id: safeRecordingId(row.uploadId || row.id) || buildRecordingId(row, bestByUser.size + 1)
        });
      }
    }
    return Array.from(bestByUser.values())
      .sort((a,b)=>a.timeMs-b.timeMs||a.accountId.localeCompare(b.accountId))
      .slice(0, limit)
      .map((entry, idx)=>({ rank: idx+1, ...entry }));
  }

  async function hydrateDisplayNames(entries){
    const out = enrichLegacyLeaderboardEntries(entries).map((entry)=>({ ...entry, id: safeRecordingId(entry.id) || safeRecordingId(entry.uploadId) || null }));
    for(const entry of out){
      const id=String(entry.userId||entry.accountId||'').slice(0,128);
      const name=safeDisplayName(getLastKnownName(id)||entry.nickname||entry.name||'Guest',id);
      entry.name=name; entry.nickname=name; setLastKnownName(id,name);
    }
    return out;
  }

  function exactPublishedVerification(row, published){
    if(!published||published.runVerified!==true||!row.replayHash)return false;
    return String(row.accountId||row.userId||'')===String(published.accountId||published.userId||'')
      && String(row.trackId||'')===String(published.trackId||'')
      && Number(row.timeMs)===Number(published.timeMs)
      && Number(row.raceTimeFrames||row.frames||0)===Number(published.raceTimeFrames||published.frames||0)
      && String(row.uploadId||'')===String(published.uploadId||'')
      && String(row.replayHash).toLowerCase()===String(published.replayHash||'').toLowerCase();
  }

  async function fetchCanonicalTrackEntries(trackId,limit=500,publishedEntries=[]){
    const d=await db();
    const snapshot=await d.collection(COLLECTIONS.raceResults).where('trackId','==',String(trackId||'').slice(0,80)).limit(Math.min(500,Math.max(1,limit))+1).get();
    if(snapshot.docs.length>Math.min(500,Math.max(1,limit)))throw new Error('Track exceeds recovery limit; retaining complete snapshot');
    const rows=await Promise.all((snapshot.docs||[]).map(async(doc)=>{
      const row={id:doc.id,...(doc.data()||{})};
      const expected=String(row.replayHash||'').toLowerCase();
      const replay=typeof row.replay==='string'?row.replay:'';
      let integrityVerified=false;
      if(replay&&/^[0-9a-f]{64}$/.test(expected)){
        try{integrityVerified=(await sha256Hex(replay))===expected;}catch{}
      }
      const approved=integrityVerified&&publishedEntries.some(entry=>exactPublishedVerification(row,entry));
      return {...row,runVerified:approved,verified:approved,verifiedState:approved?1:0,integrityVerified,validationState:approved?'verified':integrityVerified?'integrity':'pending'};
    }));
    const entries=computeTrackTopEntries(rows,trackId,limit);
    const updatedAt=rows.reduce((latest,row)=>Math.max(latest,Number(row.updatedAt||row.pbAt||row.createdAt||0)||0),0);
    log('info','[FB220] Direct canonical track recovery complete',{trackId,participants:entries.length,pending:entries.filter((entry)=>entry.integrityVerified!==true).length});
    return {entries,updatedAt:updatedAt||Date.now(),builtAt:updatedAt||Date.now(),schemaVersion:TRACK_CACHE_SCHEMA,algorithmVersion:RANK_MODEL,source:'canonical-firestore',fromCache:Boolean(snapshot.metadata?.fromCache)};
  }

  async function getTrackEntries(trackId, limit=10, forceCloud=false){
    let entries = [];
    const safeTrackId = String(trackId || '').slice(0,80);
    const cached = readTrackSnapshotCache(safeTrackId);
    const loadGeneration=++trackLoadGeneration;
    currentTrackLoadState={trackId:safeTrackId,status:'loading',fetchedAt:Number(cached?.serverUpdatedAt||cached?.fetchedAt||0)||0,checkedAt:Number(cached?.fetchedAt||0)||0};
    document.documentElement.classList.add('sq-track-leaderboard-loading');
    setTimeout(updateTrackFreshnessBanner,0);
    const cacheHit = !forceCloud && cached && !trackCacheNeedsCanonicalRefresh(cached) && Date.now()-Number(cached.fetchedAt||0) < TRACK_REFRESH_MS;
    if (cacheHit) {
      entries = applyCanonicalTrackWeight(safeTrackId,cached.entries||[]).slice(0,500);
      currentTrackLoadState={trackId:safeTrackId,status:'cache',fetchedAt:cached.serverUpdatedAt||cached.fetchedAt,checkedAt:cached.fetchedAt,nextRefreshAt:cached.fetchedAt+TRACK_REFRESH_MS};
    }
    try {
      if (!cacheHit || forceCloud) {
        let data=null;
        let source='edge';
        try{data=await fetchRankedSnapshot('track',safeTrackId);}catch{}
        if(!data){
          let derivedSnapshot=null;
          try{
            const d = await db();
            const ref = d.collection(COLLECTIONS.leaderboardsTrack).doc(safeTrackId);
            const doc = await ref.get();
            const candidate=doc.data()||null;
            const usable=Boolean(candidate&&Array.isArray(candidate.entries)&&String(candidate.algorithmVersion||'')===RANK_MODEL&&Number(candidate.schemaVersion||0)>=TRACK_CACHE_SCHEMA);
            if(usable)derivedSnapshot={...candidate,fromCache:Boolean(doc.metadata?.fromCache)};
          }catch(snapshotError){
            log('warn','[FB420] Derived Firestore snapshot unavailable',String(snapshotError&&(snapshotError.message||snapshotError)));
          }
          if(derivedSnapshot&&!forceCloud){
            data=derivedSnapshot;
            source='firestore-snapshot';
          }else{
            try{
              data=await fetchCanonicalTrackEntries(safeTrackId,500,derivedSnapshot?.entries||[]);
              source='canonical-firestore';
            }catch(canonicalError){
              if(!derivedSnapshot)throw canonicalError;
              data=derivedSnapshot;
              source='firestore-snapshot';
              log('warn','[FB421] Canonical PB recovery unavailable; using derived Firestore snapshot',String(canonicalError&&(canonicalError.message||canonicalError)));
            }
          }
        }
        const latest=readTrackSnapshotCache(safeTrackId);
        if(latest?.algorithmVersion===data.algorithmVersion && Number(data.revision)>0 && Number(data.revision)<Number(latest.revision||0))throw new Error('Older track snapshot ignored');
        entries = Array.isArray(data.entries) ? data.entries : [];
        if (Number(data.schemaVersion || 0) < TRACK_CACHE_SCHEMA) {
          entries = computeTrackTopEntries(entries.map((entry)=>({...entry,trackId:safeTrackId})),safeTrackId,500);
          log('info','[CACHE208] Legacy track cache normalized locally',{trackId:safeTrackId,participants:entries.length});
        } else if(entries.some((entry)=>Number(entry.timingVersion||0)<2||canonicalRaceTimeMs(entry)!==Math.round(Number(entry.timeMs||0)||0))){
          entries=computeTrackTopEntries(entries.map((entry)=>({...entry,trackId:safeTrackId})),safeTrackId,500);
          log('info','[CACHE209] Legacy timing normalized locally',{trackId:safeTrackId,participants:entries.length});
        }
        entries=applyCanonicalTrackWeight(safeTrackId,entries).slice(0,500);
        if(data.fromCache)throw new Error('Firestore returned saved data, not a cloud check');
        writeTrackSnapshotCache(safeTrackId,entries,data.updatedAt||Date.now(),{revision:data.revision,sourceRevision:data.sourceRevision,algorithmVersion:data.algorithmVersion,schemaVersion:data.schemaVersion,source,checkedAt:Date.now(),complete:data.complete,totalEntries:data.totalEntries});
        if(loadGeneration===trackLoadGeneration)currentTrackLoadState={trackId:safeTrackId,status:'cloud',fetchedAt:Number(data.updatedAt||0)||Date.now(),checkedAt:Date.now(),nextRefreshAt:Date.now()+TRACK_REFRESH_MS};
      }
    } catch (error) {
      const fallback=readTrackSnapshotCache(safeTrackId)||cached;
      if (fallback) entries=applyCanonicalTrackWeight(safeTrackId,fallback.entries||[]).slice(0,500);
      const localRows = readLocalRaceRows().filter((row)=>String(row.trackId||'')===String(trackId||''));
      if (!entries.length) entries = computeTrackTopEntries(localRows, trackId, Math.max(100, limit));
      log('warn','[CACHE301] Using cached track leaderboard',{trackId:safeTrackId,age:cached?ageLabel(cached.fetchedAt):'local only',reason:String(error&&(error.code||error.message||error))});
      if(loadGeneration===trackLoadGeneration)currentTrackLoadState={trackId:safeTrackId,status:'stale',fetchedAt:fallback?.serverUpdatedAt||fallback?.fetchedAt||Date.now()};
    }
    const ranked = applyCanonicalTrackWeight(safeTrackId,entries).slice(0,500);
    setTimeout(()=>{if(loadGeneration===trackLoadGeneration)document.documentElement.classList.remove('sq-track-leaderboard-loading');},120);
    setTimeout(updateTrackFreshnessBanner,0);
    return enrichLegacyLeaderboardEntries(ranked).map((entry)=>{
      const userId = String(entry.accountId || entry.userId || '');
      const name = canonicalDisplayName(userId,entry.nickname || entry.name || 'Guest');
      return {...entry,name,nickname:name};
    }).slice(0, limit);
  }

  function computeOverallFromRaceRows(rows){
    const bestByTrackAndUser = new Map();
    for (const row of rows) {
      const userId = String(row.accountId || row.userId || '').slice(0, 128);
      const trackId = String(row.trackId || '').slice(0, 80);
      if (!userId || !trackId) continue;
      const timeMs = canonicalRaceTimeMs(row);
      if (!Number.isFinite(timeMs) || timeMs <= 0) continue;
      const key = `${trackId}::${userId}`;
      const prev = bestByTrackAndUser.get(key);
      if (!prev || timeMs < prev.timeMs) {
        bestByTrackAndUser.set(key, {
          userId,
          name: String(row.name || 'Guest').slice(0,24),
          countryCode: typeof row.countryCode === 'string' ? row.countryCode.slice(0,8).toUpperCase() : '',
          trackId,
          timeMs,
          createdAt: pbTimestamp(row),
          pbAt: pbTimestamp(row),
          accountCreatedAt: Math.max(0,Number(row.accountCreatedAt||0)||0),
          id: buildRecordingId(row, bestByTrackAndUser.size + 1),
          carId: extractCarId(row) || null,
          carColors: normalizeCarColorId(row.carColors || ''),
          carStyle: __pt062NormalizeStyle(row.carStyle || __pt062GetRememberedStyle(userId) || ''),
          profileCosmetics:sanitizeProfileCosmetics(row.profileCosmetics),
          pbCount:Math.max(0,Number(row.pbCount||0)||0),
          totalPlaytimeMs:Math.max(0,Number(row.totalPlaytimeMs||0)||0)
        });
      }
    }

    const tracks = new Map();
    for (const row of bestByTrackAndUser.values()) {
      if (!tracks.has(row.trackId)) tracks.set(row.trackId, []);
      tracks.get(row.trackId).push(row);
    }
    const userAgg = new Map();
    for (const [trackId, entries] of tracks.entries()) {
      entries.sort((a,b)=>a.timeMs-b.timeMs);
      const fieldSize = entries.length;
      if(fieldSize<2)continue;
      const info = trackInfo(trackId);
      const competition=rankedTrackCompetition(entries);
      // Track weight must be reproducible from this track alone so every screen shows the same value.
      const depthBoost=1;
      const trackWeight = rankedTrackWeightParts(trackId,fieldSize,competition.boost,depthBoost).finalWeight;
      entries.forEach((entry, idx)=>{
        const rank = idx + 1;
        const placementCost = rankedPlacementCost(rank,fieldSize);
        const cur = userAgg.get(entry.userId) || { userId:entry.userId,name:entry.name,countryCode:entry.countryCode||'',carColors:entry.carColors||null,carId:entry.carId||null,carStyle:entry.carStyle||'',profileCosmetics:sanitizeProfileCosmetics(entry.profileCosmetics),accountCreatedAt:Number(entry.accountCreatedAt||entry.createdAt||0)||0,latestPbAt:0,totalPlaytimeMs:0,weightedCost:0,weightSum:0,tracks:new Set(),officialCount:0,communityCount:0,customCount:0,pbCount:0,finishes:[] };
        cur.name = entry.name || cur.name;
        cur.countryCode = entry.countryCode || cur.countryCode;
        cur.carColors = normalizeCarColorId(entry.carColors || cur.carColors || '');
        cur.carId = entry.carId || cur.carId;
        cur.carStyle = entry.carStyle || cur.carStyle;
        cur.profileCosmetics = sanitizeProfileCosmetics(entry.profileCosmetics || cur.profileCosmetics);
        cur.pbCount = Math.max(cur.pbCount,Math.max(0,Number(entry.pbCount||0)||0));
        cur.totalPlaytimeMs = Math.max(cur.totalPlaytimeMs,Math.max(0,Number(entry.totalPlaytimeMs||0)||0));
        const accountStart=Number(entry.accountCreatedAt||entry.createdAt||0)||0;
        if(accountStart>0)cur.accountCreatedAt=cur.accountCreatedAt?Math.min(cur.accountCreatedAt,accountStart):accountStart;
        cur.latestPbAt=Math.max(cur.latestPbAt,pbTimestamp(entry));
        cur.weightedCost += placementCost * trackWeight;
        cur.weightSum += trackWeight;
        cur.tracks.add(trackId);
        const contribution=Math.max(0,(100-placementCost)*trackWeight);
        const improvementValue=placementCost*trackWeight;
        cur.finishes.push({trackId,rank,fieldSize,weight:Number(trackWeight.toFixed(3)),placementCost:Number(placementCost.toFixed(3)),contribution:Number(contribution.toFixed(3)),improvementValue:Number(improvementValue.toFixed(3)),timeMs:entry.timeMs,pbAt:pbTimestamp(entry),timingVersion:2,type:info.type,competition:Number(competition.boost.toFixed(3)),relativeGap:Number(competition.relativeGap.toFixed(5)),depthBoost:Number(depthBoost.toFixed(3))});
        if (info.type === 'official') cur.officialCount += 1;
        else if (info.type === 'community') cur.communityCount += 1;
        else cur.customCount += 1;
        userAgg.set(entry.userId, cur);
      });
    }

    const out = Array.from(userAgg.values()).map((u)=>{
      const played = u.tracks.size;
      const rankedFinishes=u.finishes.filter((finish)=>Number(finish.fieldSize||0)>=2&&Number(finish.weight||0)>0);
      const byCost=[...rankedFinishes].sort((a,b)=>Number(a.placementCost||50)-Number(b.placementCost||50)||b.weight-a.weight);
      const skillFinishes=byCost.slice(0,10);
      const skillWeight=skillFinishes.reduce((sum,finish)=>sum+finish.weight,0);
      const skillCost=skillFinishes.reduce((sum,finish)=>sum+Number(finish.placementCost||50)*finish.weight,0)/Math.max(.0001,skillWeight);
      const middleCost=medianNumber(rankedFinishes.map((finish)=>finish.placementCost),50);
      const consistencyCeiling=Math.min(82,middleCost+24);
      const consistencyWeight=rankedFinishes.reduce((sum,finish)=>sum+finish.weight,0);
      const consistencyCost=rankedFinishes.reduce((sum,finish)=>sum+Math.min(consistencyCeiling,Math.max(5,Number(finish.placementCost||50)))*finish.weight,0)/Math.max(.0001,consistencyWeight);
      const coverageCost=100*Math.exp(-played/10);
      const byPlace=[...u.finishes].sort((a,b)=>a.rank-b.rank || b.fieldSize-a.fieldSize || b.weight-a.weight || String(a.trackId).localeCompare(String(b.trackId)));
      const byContribution=[...u.finishes].sort((a,b)=>b.contribution-a.contribution || a.rank-b.rank || b.weight-a.weight);
      const byImprovement=[...u.finishes].filter((finish)=>finish.rank>1).sort((a,b)=>b.improvementValue-a.improvementValue || b.fieldSize-a.fieldSize);
      const primaryBest=byPlace[0]||{};
      const strongestTrack=byContribution[0]||primaryBest;
      const improvementTrack=byImprovement[0]||primaryBest;
      const worstTrack=[...u.finishes].sort((a,b)=>(b.rank/Math.max(1,b.fieldSize))-(a.rank/Math.max(1,a.fieldSize))||b.rank-a.rank||b.weight-a.weight)[0]||primaryBest;
      const weightedResults=byContribution.slice(0,2);
      const opportunityTracks=byImprovement.slice(0,3);
      const bestTracks=[primaryBest,...byPlace.filter((finish)=>finish.trackId!==primaryBest.trackId)].slice(0,2);
      const medals={gold:0,silver:0,bronze:0};
      for(const finish of u.finishes){
        const medal=medalForRank(finish.rank,finish.fieldSize,finish.trackId);
        if(medal)medals[medal]++;
      }
      const score = Math.max(1.000001,.68*skillCost+.20*coverageCost+.12*consistencyCost);
      const podiums=medals.gold+medals.silver+medals.bronze;
      const averageFinish=rankedFinishes.length?rankedFinishes.reduce((sum,finish)=>sum+Number(finish.rank||0),0)/rankedFinishes.length:0;
      const averagePlacement=rankedFinishes.length?rankedFinishes.reduce((sum,finish)=>sum+Number(finish.rank||0),0)/rankedFinishes.length:0;
      const podiumEligible=rankedFinishes.filter((finish)=>Number(finish.fieldSize||0)>=5&&(TRACK_CATALOG.has(String(finish.trackId||''))||LEGACY_TRACK_CATALOG.has(String(finish.trackId||''))));
      const competitiveAverage=podiumEligible.length?podiumEligible.reduce((sum,finish)=>sum+Number(finish.rank||0),0)/podiumEligible.length:null;
      const eligiblePodiums=podiumEligible.filter((finish)=>Number(finish.rank||0)<=3).length;
      const podiumRate=podiumEligible.length>=MIN_RANKED_TRACKS?eligiblePodiums/podiumEligible.length*100:0;
      const provisional=played<MIN_RANKED_TRACKS;
      const rankTier=rankedTitle(score,played);
      return {userId:u.userId,name:safeDisplayName(getLastKnownName(u.userId)||u.name,u.userId),countryCode:String(u.countryCode||'').slice(0,8).toUpperCase(),carId:String(u.carId||'').slice(0,64)||null,carColors:normalizeCarColorId(u.carColors||'ffffff8ec7ff28346a212b58'),carColorId:normalizeCarColorId(u.carColors||'ffffff8ec7ff28346a212b58'),carStyle:__pt062NormalizeStyle(u.carStyle||__pt062GetRememberedStyle(u.userId)||''),profileCosmetics:sanitizeProfileCosmetics(u.profileCosmetics),accountCreatedAt:Number(u.accountCreatedAt||0)||0,latestPbAt:Number(u.latestPbAt||0)||0,totalPlaytimeMs:Math.max(0,Number(u.totalPlaytimeMs||0)||0),score,raceCount:played,eligibleTrackCount:played,provisional,totalTracks:TOTAL_TRACKS,officialCount:u.officialCount,communityCount:u.communityCount,customCount:u.customCount,weightedTracks:Number(u.weightSum.toFixed(3)),skillCost:Number(skillCost.toFixed(3)),coverageCost:Number(coverageCost.toFixed(3)),consistencyCost:Number(consistencyCost.toFixed(3)),averageFinish:Number(averageFinish.toFixed(2)),averageFinishVersion:AVERAGE_FINISH_VERSION,averagePlacement:Number(averagePlacement.toFixed(2)),averagePlacementVersion:AVERAGE_PLACEMENT_VERSION,competitiveAveragePlacement:competitiveAverage==null?null:Number(competitiveAverage.toFixed(2)),competitiveAverageEligibleTracks:podiumEligible.length,podiumEligibleTracks:podiumEligible.length,podiumRate:Number(podiumRate.toFixed(1)),trackWins:Number(medals.gold||0),pbCount:Math.max(0,u.pbCount),bestTracks,strongestTrack,worstTrack,improvementTrack,weightedResults,opportunityTracks,medals,bestTrackId:primaryBest.trackId||null,bestTrackRank:Number(primaryBest.rank||0)||0,bestTrackField:Number(primaryBest.fieldSize||0)||0,rankTier,rankModel:RANK_MODEL,timingVersion:2};
    }).sort((a,b)=>Number(a.provisional)-Number(b.provisional)||a.score-b.score || b.raceCount-a.raceCount || String(a.userId).localeCompare(String(b.userId)))
      .slice(0,200)
      .map((row, idx,all)=>({ rank:row.provisional?0:all.slice(0,idx+1).filter((entry)=>!entry.provisional).length, ...row }));
    return out;
  }

  function annotateOverallMovement(entries, signature=''){
    // Season 1 movement timestamps are authoritative and shared. Do not replace them
    // with the time this browser happened to download the snapshot.
    if((entries||[]).some((entry)=>Number(entry?.rankSince||0)>0)){
      return entries.map((entry)=>({...entry,movement:Number(entry.movement||0)||0,scoreDelta:Number(entry.scoreDelta||0)||0,movementAt:Number(entry.movementAt||entry.rankSince||0)||0,rankHistory:Array.isArray(entry.rankHistory)?entry.rankHistory:[]}));
    }
    const key='polytrack-0.6.2-overall-movement-v2';
    const currentSignature=String(signature||entries.map((entry)=>`${entry.userId}:${entry.rank}:${Number(entry.score||0).toFixed(4)}`).join('|'));
    const prior=readJsonStorage(key,{signature:'',ranks:{},scores:{},movements:{},scoreDeltas:{},since:{},history:{}}) || {signature:'',ranks:{},scores:{},movements:{},scoreDeltas:{},since:{},history:{}};
    if(prior.signature===currentSignature){
      return entries.map((entry)=>({...entry,movement:Number(prior.movements?.[entry.userId]||0)||0,scoreDelta:Number(prior.scoreDeltas?.[entry.userId]||0)||0,movementAt:Number(entry.rankSince||prior.since?.[entry.userId]||0)||0,rankHistory:Array.isArray(prior.history?.[entry.userId])?prior.history[entry.userId]:[]}));
    }
    const ranks={}; const scores={}; const movements={}; const scoreDeltas={}; const since={}; const history={}; const now=Date.now();
    for(const entry of entries){
      ranks[entry.userId]=entry.rank;
      scores[entry.userId]=Number(entry.score||0)||0;
      const priorRank=Number(prior.ranks?.[entry.userId]||0)||0;
      const changed=priorRank>0?priorRank-entry.rank:0;
      movements[entry.userId]=changed!==0?changed:(Number(prior.movements?.[entry.userId]||0)||0);
      const priorScore=Number(prior.scores?.[entry.userId]||0)||0;
      scoreDeltas[entry.userId]=priorScore?Number(entry.score||0)-priorScore:(Number(prior.scoreDeltas?.[entry.userId]||0)||0);
      since[entry.userId]=priorRank===0?0:changed!==0?now:(Number(prior.since?.[entry.userId]||0)||0);
      const priorHistory=Array.isArray(prior.history?.[entry.userId])?prior.history[entry.userId]:[];
      history[entry.userId]=[...priorHistory,{rank:entry.rank,at:now}].filter((point,index,array)=>index===array.length-1||Number(point.rank)!==Number(array[index+1]?.rank)).slice(-12);
    }
    writeJsonStorage(key,{signature:currentSignature,ranks,scores,movements,scoreDeltas,since,history,updatedAt:now});
    return entries.map((entry)=>({...entry,movement:Number(movements[entry.userId]||0)||0,scoreDelta:Number(scoreDeltas[entry.userId]||0)||0,movementAt:Number(entry.rankSince||since[entry.userId]||0)||0,rankHistory:history[entry.userId]||[]}));
  }

  function computeOverallFromTrackBoardDocs(boardDocs){
    const rows = [];
    for (const boardDoc of boardDocs || []) {
      const board = typeof boardDoc.data === 'function' ? (boardDoc.data() || {}) : (boardDoc || {});
      const trackId = String(board.trackId || boardDoc.id || '').slice(0,80);
      for (const entry of Array.isArray(board.entries) ? board.entries : []) rows.push({...entry,trackId});
    }
    return computeOverallFromRaceRows(rows);
  }

  function mergeOverallSnapshots(previousEntries, rebuiltEntries){
    const previousByUser = new Map(normalizeEntries(previousEntries || []).map((entry)=>[String(entry.userId),entry]));
    const byUser = new Map();
    for (const entry of normalizeEntries(previousEntries || [])) byUser.set(String(entry.userId),{
      ...entry,
      averageFinish:Number(entry.averageFinishVersion||0)>=AVERAGE_FINISH_VERSION?Number(entry.averageFinish||0):0,
      averageFinishVersion:AVERAGE_FINISH_VERSION,
      averagePlacement:Number(entry.averagePlacementVersion||0)>=AVERAGE_PLACEMENT_VERSION?Number(entry.averagePlacement||0):Number(entry.averageFinish||0),
      averagePlacementVersion:AVERAGE_PLACEMENT_VERSION,
      rankModel:String(entry.rankModel||'legacy-retained')===RANK_MODEL?RANK_MODEL:'legacy-retained'
    });
    for (const entry of normalizeEntries(rebuiltEntries || [])) byUser.set(String(entry.userId),entry);
    return Array.from(byUser.values())
      .sort((a,b)=>Number(Boolean(a.provisional))-Number(Boolean(b.provisional))||Number(a.score||Infinity)-Number(b.score||Infinity) || Number(b.raceCount||0)-Number(a.raceCount||0) || String(a.userId).localeCompare(String(b.userId)))
      .slice(0,200)
      .map((entry,index,all)=>{
        const rank=entry.provisional?0:all.slice(0,index+1).filter((row)=>!row.provisional).length;
        const previous=previousByUser.get(String(entry.userId));
        const rankSince=previous&&Number(previous.rank)===rank?(Number(previous.rankSince||0)||Date.now()):Date.now();
        const movement=previous&&Number(previous.rank)>0&&rank>0?Number(previous.rank)-rank:0;
        const scoreDelta=previous?Number(entry.score||0)-Number(previous.score||0):0;
        return {...entry,rank,rankSince,movement,movementAt:movement?Date.now():(Number(previous?.movementAt||0)||0),scoreDelta,rankModel:String(entry.rankModel||RANK_MODEL)};
      });
  }

  async function hydrateOverallProfiles(entries){
    const out = normalizeEntries(entries || []);
    return out.map((entry)=>({
      ...entry,
      name:safeDisplayName(getLastKnownName(entry.userId)||entry.name||'Guest',entry.userId),
      carColors: normalizeCarColorId(entry.carColors),
      carColorId: normalizeCarColorId(entry.carColors)
    }));
  }

  let overallLoadState = {status:'idle',message:''};
  let overallLoadGeneration = 0;
  let rankedFreshnessTimer = 0;
  let lastRankedManualRefreshAt = 0;
  function withTimeout(promise, milliseconds, message){
    return Promise.race([
      promise,
      new Promise((_,reject)=>setTimeout(()=>reject(new Error(message || 'Timed out')),milliseconds))
    ]);
  }
  async function expandRankedResults(data){
    if(data?.resultBundleVersion!==1||typeof data.resultBundle!=='string'||typeof DecompressionStream==='undefined')return decodeRankedResults(data);
    try{
      if(data.resultBundle.length>1400000)return decodeRankedResults(data);
      const bytes=Uint8Array.from(atob(data.resultBundle),c=>c.charCodeAt(0));
      const reader=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
      const chunks=[];let length=0;
      try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>6000000){await reader.cancel();throw Error('Planner data exceeds limit');}chunks.push(value);}}finally{reader.releaseLock();}
      const plain=new Uint8Array(length);let offset=0;for(const chunk of chunks){plain.set(chunk,offset);offset+=chunk.length;}
      const packed=JSON.parse(new TextDecoder().decode(plain));
      if(!Array.isArray(packed.entries)||packed.entries.length>200||!Array.isArray(packed.resultTracks)||packed.resultTracks.length>500)return decodeRankedResults(data);
      const byId=new Map(packed.entries.map(row=>[row.userId,row.resultData]));
      if(byId.size!==packed.entries.length)return decodeRankedResults(data);
      return decodeRankedResults({resultTracks:packed.resultTracks,entries:(data.entries||[]).map(row=>({...row,resultData:byId.get(row.userId)}))});
    }catch{return decodeRankedResults(data);}
  }
  function decodeRankedResults(data){
    const tracks=Array.isArray(data?.resultTracks)?data.resultTracks:[];
    return (Array.isArray(data?.entries)?data.entries:[]).map(entry=>{
      if(typeof entry.resultData!=='string'||!tracks.length)return entry;
      try{
        const tuples=JSON.parse(entry.resultData);
        if(!Array.isArray(tuples)||tuples.length>500)return entry;
        const seen=new Set();const samples=[];
        for(const tuple of tuples){
          if(!Array.isArray(tuple)||tuple.length!==7) return entry;
          const [index,rank,fieldSize,weight,competition,timeMs,pbAt]=tuple;
          const trackId=tracks[index];
          if(!Number.isInteger(index)||typeof trackId!=='string'||seen.has(trackId)||!Number.isInteger(rank)||rank<1||!Number.isInteger(fieldSize)||fieldSize<rank||fieldSize<2||!Number.isFinite(weight)||weight<=0||!Number.isFinite(competition)||competition<=0||!Number.isFinite(timeMs)||timeMs<=0||!Number.isFinite(pbAt)||pbAt<0)return entry;
          seen.add(trackId);samples.push({trackId,rank,fieldSize,weight,competition,timeMs,pbAt});
        }
        return {...entry,resultSamples:samples};
      }catch{return entry;}
    });
  }
  async function fetchOverallEntries(forceRefresh=false){
    let direct = [];
    const cached = readOverallSnapshotCache();
    overallTrackSummariesCache=Array.isArray(cached?.trackSummaries)?cached.trackSummaries.slice(0,TOTAL_TRACKS):[];
    if (!forceRefresh && cached && Date.now()-Number(cached.fetchedAt||0) < OVERALL_REFRESH_CHECK_MS) {
      overallLoadState={status:'cache',message:'Saved ranked snapshot',fetchedAt:cached.serverUpdatedAt||cached.fetchedAt,serverUpdatedAt:cached.serverUpdatedAt||0,checkedAt:Number(cached.fetchedAt||0),nextRefreshAt:Number(cached.fetchedAt||0)+OVERALL_REFRESH_CHECK_MS,complete:cached.complete===true,totalEntries:cached.totalEntries,totalEntriesExact:cached.totalEntriesExact===true,publishedEntries:cached.publishedEntries,ranksExact:cached.ranksExact===true};
      return annotateOverallMovement(cached.entries,cached.signature);
    }
    overallLoadState = {status:'loading',message:'',fetchedAt:cached?.fetchedAt||0};
    try {
      let data=null;
      let source='edge';
      let fromFirestoreCache=false;
      try{data=await fetchRankedSnapshot('overall');}catch(error){log('warn','[RANKED404] Edge overall snapshot unavailable; trying Firestore',String(error&&(error.message||error)));}
      if(!data){
        const d = await db();
        const snap = await d.collection(COLLECTIONS.leaderboardsOverall).doc('main').get();
        data = snap.data() || {};
        source='firestore';
        fromFirestoreCache=Boolean(snap.metadata?.fromCache);
      }
      if(data.resultBundleLocation==='main_results'&&!data.resultBundle){
        try{
          const sidecar=await (await db()).collection(COLLECTIONS.leaderboardsOverall).doc('main_results').get();
          const detail=sidecar.data()||{};
          if(detail.algorithmVersion===data.algorithmVersion&&['sourceRevision','builtRevision','updatedAt'].every(key=>Number.isFinite(Number(data[key]))&&Number(detail[key])===Number(data[key])))data={...data,resultBundle:detail.resultBundle,resultBundleVersion:detail.resultBundleVersion};
        }catch{ /* The complete leaderboard remains usable without its optional planner payload. */ }
      }
      direct = normalizeEntries(await expandRankedResults(data)).map((entry)=>Number(entry.averagePlacementVersion||0)>=AVERAGE_PLACEMENT_VERSION?entry:{...entry,averagePlacement:Number(entry.averageFinish||0),averagePlacementVersion:AVERAGE_PLACEMENT_VERSION});
      const revision = Math.max(0,Number(data.revision || 0) || 0);
      const builtRevision = Math.max(0,Number(data.builtRevision || 0) || 0);
      const sourceRevision = Math.max(0,Number(data.sourceRevision || revision) || 0);
      const updatedAt = Math.max(0,Number(data.updatedAt || 0) || 0);
      const algorithmVersion=String(data.algorithmVersion||'');
      const schemaVersion=Math.max(0,Number(data.schemaVersion||0)||0);
      const complete=data.complete===true;
      const totalEntries=Number.isSafeInteger(data.totalEntries)&&data.totalEntries>=0?data.totalEntries:null;
      const totalEntriesExact=data.totalEntriesExact===true;
      const publishedEntries=Number.isSafeInteger(data.publishedEntries)&&data.publishedEntries>=0?data.publishedEntries:null;
      const ranksExact=Array.isArray(data.entries)&&data.entries.length===direct.length&&data.entries.every(entry=>Number.isSafeInteger(entry?.rank)&&entry.rank>0);
      const signature = `${algorithmVersion}:${sourceRevision}:${builtRevision}:${updatedAt}`;
      if(cached?.signature===signature){
        const priorById=new Map(cached.entries.map(row=>[row.userId,row]));
        direct=direct.map(row=>{
          const prior=priorById.get(row.userId);
          return prior&&Number(prior.score)===Number(row.score)&&Number(prior.raceCount)===Number(row.raceCount)&&Array.isArray(prior.resultSamples)&&prior.resultSamples.length>=Number(row.raceCount)&&(!Array.isArray(row.resultSamples)||row.resultSamples.length<Number(row.raceCount))?{...row,resultSamples:prior.resultSamples}:row;
        });
      }
      const validDirect = Array.isArray(data.entries) && Array.isArray(data.trackSummaries) && algorithmVersion===RANK_MODEL && schemaVersion>=TRACK_CACHE_SCHEMA && builtRevision>=sourceRevision && direct.every((entry)=>String(entry?.rankModel||'')===RANK_MODEL&&Number(entry?.averageFinishVersion||0)>=AVERAGE_FINISH_VERSION&&Number(entry?.averagePlacementVersion||0)>=AVERAGE_PLACEMENT_VERSION);
      if (fromFirestoreCache) {
        const useDirect=validDirect&&(!cached||updatedAt>Number(cached.serverUpdatedAt||0));
        const fallback=useDirect?direct:(cached?.entries||[]);
        if(useDirect)overallTrackSummariesCache=data.trackSummaries.slice(0,TOTAL_TRACKS);
        if(fallback.length){overallLoadState={status:'stale',message:'Offline ranked snapshot',fetchedAt:useDirect?updatedAt:(cached.serverUpdatedAt||cached.fetchedAt),complete:useDirect?complete:cached?.complete===true,totalEntries:useDirect?totalEntries:cached?.totalEntries,totalEntriesExact:useDirect?totalEntriesExact:cached?.totalEntriesExact===true,publishedEntries:useDirect?publishedEntries:cached?.publishedEntries,ranksExact:useDirect?ranksExact:cached?.ranksExact===true};return annotateOverallMovement(fallback,useDirect?signature:cached.signature);}
        return [];
      }
      if (validDirect && !(cached?.algorithmVersion===algorithmVersion && sourceRevision<Number(cached.sourceRevision||cached.revision||0))) {
        overallTrackSummariesCache=Array.isArray(data.trackSummaries)?data.trackSummaries.slice(0,TOTAL_TRACKS):[];
        writeOverallSnapshotCache(direct,{serverUpdatedAt:updatedAt,revision,builtRevision,sourceRevision,algorithmVersion,schemaVersion,source,signature,trackSummaries:overallTrackSummariesCache,complete,totalEntries,totalEntriesExact,publishedEntries,ranksExact});
        overallLoadState={status:'cloud',message:'Community Ranked snapshot',fetchedAt:updatedAt||Date.now(),serverUpdatedAt:updatedAt||0,checkedAt:Date.now(),nextRefreshAt:Date.now()+OVERALL_REFRESH_CHECK_MS,complete,totalEntries,totalEntriesExact,publishedEntries,ranksExact};
        return annotateOverallMovement(direct,signature);
      }
      if(cached?.entries?.length){
        overallLoadState={status:'stale',message:'Waiting for a current complete snapshot · showing saved rankings',fetchedAt:cached.serverUpdatedAt||cached.fetchedAt,checkedAt:Date.now(),nextRefreshAt:Date.now()+OVERALL_REFRESH_CHECK_MS,complete:cached.complete===true,totalEntries:cached.totalEntries,totalEntriesExact:cached.totalEntriesExact===true,publishedEntries:cached.publishedEntries,ranksExact:cached.ranksExact===true};
        return annotateOverallMovement(cached.entries,cached.signature||'saved');
      }
      overallLoadState={status:'pending',message:'Community Ranked is building its first complete snapshot.'};
      return [];
    } catch (error) {
      if (isLocalApiCapableHost()) {
        try {
          const res = await fetch('/api/overall-leaderboard', { cache: 'no-store' });
          if (res.ok) {
            const data = await res.json();
            const hydrated = await hydrateOverallProfiles(data.entries || []);
            const signature=`api:${Number(data.updatedAt||Date.now())}`;
            overallTrackSummariesCache=Array.isArray(data.trackSummaries)?data.trackSummaries.slice(0,TOTAL_TRACKS):[];
            const apiRanksExact=Array.isArray(data.entries)&&data.entries.length===hydrated.length&&data.entries.every(entry=>Number.isSafeInteger(entry?.rank)&&entry.rank>0);
            writeOverallSnapshotCache(hydrated,{serverUpdatedAt:data.updatedAt||Date.now(),signature,trackSummaries:overallTrackSummariesCache,complete:data.complete===true,totalEntries:data.totalEntries,totalEntriesExact:data.totalEntriesExact===true,publishedEntries:data.publishedEntries,ranksExact:apiRanksExact});
            overallLoadState={status:'cloud',message:'Ranked API snapshot',fetchedAt:Number(data.updatedAt||0)||Date.now(),checkedAt:Date.now(),nextRefreshAt:Date.now()+OVERALL_REFRESH_CHECK_MS,complete:data.complete===true,totalEntries:data.totalEntries,totalEntriesExact:data.totalEntriesExact===true,publishedEntries:data.publishedEntries,ranksExact:apiRanksExact};
            return annotateOverallMovement(hydrated,signature);
          }
        } catch {}
      }
      const fallback=cached?.entries||[];
      if(fallback.length){
        const fallbackTime=cached?.serverUpdatedAt||cached?.fetchedAt||Date.now();
        overallLoadState={status:'stale',message:'Cloud unavailable · showing saved rankings',fetchedAt:fallbackTime,checkedAt:Number(cached?.fetchedAt||0),nextRefreshAt:Date.now()+OVERALL_REFRESH_CHECK_MS,complete:cached?.complete===true,totalEntries:cached?.totalEntries,totalEntriesExact:cached?.totalEntriesExact===true,publishedEntries:cached?.publishedEntries,ranksExact:cached?.ranksExact===true};
        log('warn','[CACHE300] Ranked cloud refresh failed; using durable snapshot',String(error&&(error.code||error.message||error)));
        return annotateOverallMovement(fallback,cached?.signature||'fallback');
      }
      console.warn('Failed to load overall leaderboard:', error);
      overallLoadState={status:'error',message:/permission/i.test(String(error&&(error.message||error)))?'The shared ranked snapshot is not available to this session yet.':'The shared ranked snapshot could not be reached. Check the connection and retry.'};
      return [];
    }
  }

  function movementMarkup(value, movementAt=0, rank=0){
    const movement = Number(value || 0) || 0;
    const held=movementAt?durationLabel(Date.now()-Number(movementAt)):'';
    const shared=held?`Rank held for ${held}. This timestamp is saved with the shared Ranked snapshot.`:'A shared rank duration is not available yet.';
    const duration=movementAt?`<span data-rank-duration="${Math.max(0,Number(movementAt)||0)}">${held} at rank</span>`:'';
    if (movement > 0) return `<span class="overall-move up" title="${shared}">&#9650; Up ${movement}${duration?` · ${duration}`:''}</span>`;
    if (movement < 0) return `<span class="overall-move down" title="${shared}">&#9660; Down ${Math.abs(movement)}${duration?` · ${duration}`:''}</span>`;
    return `<span class="overall-move flat" title="${shared}">${duration||'No recent movement'}</span>`;
  }
  function updateRankDurationLabels(root=document){
    root.querySelectorAll?.('[data-rank-duration]').forEach((el)=>{
      const since=Math.max(0,Number(el.dataset.rankDuration||0)||0);
      if(!since)return;
      const suffix=el.dataset.rankDurationSuffix==='profile'?'':' at rank';
      el.textContent=`${durationLabel(Date.now()-since)}${suffix}`;
    });
  }
  function categoryContextMarkup(entry,races,officialCount,communityCount,medals){
    if(overallCategory==='overall')return movementMarkup(entry?.movement||0,entry?.rankSince||entry?.movementAt||0,entry?.rank||0);
    if(overallCategory==='casual')return `<span class="overall-move flat">${Number.isSafeInteger(entry?.casualCompletionCount)?'Permanent verified total':'Casual total unavailable'}</span>`;
    if(Number(entry?.categoryMovement||0)!==0)return movementMarkup(entry.categoryMovement,0,entry?.categoryRank||0).replace('A shared rank duration is not available yet.','Change since your previous check of this category.');
    if(overallCategory==='playtime')return '';
    const finishes=normalizedFinishSamples(entry).filter((finish)=>Number(finish.rank||0)>0&&Number(finish.fieldSize||0)>=2);
    if((overallCategory==='average'||overallCategory==='competitiveAverage')&&finishes.length){
      const best=Math.min(...finishes.map((finish)=>Number(finish.rank)));
      const worst=Math.max(...finishes.map((finish)=>Number(finish.rank)));
      return `<span class="overall-move flat" title="Best and worst loaded placements">Range #${best} to #${worst}</span>`;
    }
    if(overallCategory==='weight')return `<span class="overall-move flat">${races} weighted track${races===1?'':'s'}</span>`;
    if(overallCategory==='tracks')return `<span class="overall-move flat">${officialCount} official · ${communityCount} community</span>`;
    return '<span class="overall-move flat">No observed change</span>';
  }

  function categoryTrackMarkup(entry){
    if(overallCategory==='casual'){
      const count=Number.isSafeInteger(entry?.casualCompletionCount)?entry.casualCompletionCount:null;
      if(count===null)return '<span class="overall-best-line muted">This saved snapshot predates Casual RP.</span>';
      return `<span class="overall-best-line"><b>${count} distinct track${count===1?'':'s'}</b> with physics-verified completion</span><span class="overall-best-line muted">100 Casual RP per recognized track · never decreases</span>`;
    }
    if(overallCategory==='medals'){
      const podiums=normalizedFinishSamples(entry).filter((finish)=>medalForRank(finish?.rank,finish?.fieldSize,finish?.trackId));
      return podiums.length?podiums.slice(0,2).map((finish)=>{const kind=medalForRank(finish.rank,finish.fieldSize,finish.trackId);const info=trackInfo(finish.trackId);return `<span class="overall-best-line" data-track-id="${escapeHtml(finish.trackId)}"><b class="medal-text-${kind}">${kind[0].toUpperCase()+kind.slice(1)}</b> #${finish.rank} of ${finish.fieldSize} · ${escapeHtml(info.name)}</span>`;}).join(''):'No eligible podiums yet';
    }
    if(overallCategory==='weight'){
      const weighted=normalizedFinishSamples(entry).filter(Boolean).sort((a,b)=>((100-rankedPlacementCost(b.rank,b.fieldSize))*(knownFinishWeight(b)||0))-((100-rankedPlacementCost(a.rank,a.fieldSize))*(knownFinishWeight(a)||0)));
      return weighted.length?weighted.slice(0,2).map((finish,index)=>{const info=trackInfo(finish.trackId);const parts=finishWeightParts(finish);return `<span class="overall-best-line" data-track-id="${escapeHtml(finish.trackId)}" title="${escapeHtml(rankedWeightTitle(finish.trackId,finish.fieldSize,false,finish))}"><b>${index?'Next weight':'Top weight'}</b> ${escapeHtml(info.name)} <em>${parts.finalWeight.toFixed(2)}x</em></span>`;}).join(''):'No weighted tracks yet';
    }
    if(overallCategory==='tracks'||overallCategory==='official'||overallCategory==='community'){
      const wanted=overallCategory==='official'?'official':overallCategory==='community'?'community':'';
      const finishes=normalizedFinishSamples(entry).filter((finish)=>{
        const type=trackInfo(finish.trackId).type;
        return !wanted||(wanted==='community'?type!=='official':type===wanted);
      });
      if(!finishes.length)return '<span class="overall-best-line muted">Track names are not available in this snapshot</span>';
      return finishes.slice(0,2).map((finish,index)=>{const weight=knownFinishWeight(finish);return `<span class="overall-best-line" data-track-id="${escapeHtml(finish.trackId)}"><b>${index?'Also finished':'Includes'}</b> ${escapeHtml(trackInfo(finish.trackId).name)} <em>${weight===null?'N/A':`${weight.toFixed(2)}x`}</em></span>`;}).join('');
    }
    if(overallCategory==='wins'){
      const wins=normalizedFinishSamples(entry).filter((finish)=>medalForRank(finish.rank,finish.fieldSize,finish.trackId)==='gold');
      const total=eligibleWinCount(entry);
      const known=wins.slice(0,2).map((finish)=>`<span class="overall-best-line" data-track-id="${escapeHtml(finish.trackId)}"><b class="medal-text-gold">First place</b> #1 of ${finish.fieldSize} · ${escapeHtml(trackInfo(finish.trackId).name)}</span>`).join('');
      if(known)return `${known}${total>wins.length?`<span class="overall-best-line muted">${total} wins total</span>`:''}`;
      return total?`<span class="overall-best-line muted">${total} eligible win${total===1?'':'s'} · details load as you race</span>`:'<span class="overall-best-line muted">No eligible first-place finishes</span>';
    }
    if(overallCategory==='average'||overallCategory==='competitiveAverage'||overallCategory==='podiumRate'){
      const eligible=normalizedFinishSamples(entry).filter((finish)=>Number(finish.fieldSize||0)>=(overallCategory==='competitiveAverage'?5:2)&&(overallCategory!=='competitiveAverage'||trackInfo(finish.trackId).type!=='custom'));
      const best=eligible.slice().sort((a,b)=>Number(a.rank)-Number(b.rank)||Number(b.fieldSize)-Number(a.fieldSize)||(knownFinishWeight(b)||0)-(knownFinishWeight(a)||0))[0];
      const strongest=eligible.slice().sort((a,b)=>((100-rankedPlacementCost(b.rank,b.fieldSize))*(knownFinishWeight(b)||0))-((100-rankedPlacementCost(a.rank,a.fieldSize))*(knownFinishWeight(a)||0)))[0];
      const savedWorst=Number(entry?.worstTrack?.fieldSize||0)>=2?entry.worstTrack:null;
      const worst=savedWorst||eligible.sort((a,b)=>Number(b.placementCost||rankedPlacementCost(b.rank,b.fieldSize))-Number(a.placementCost||rankedPlacementCost(a.rank,a.fieldSize)))[0];
      const second=strongest?.trackId&&strongest.trackId!==best?.trackId?strongest:worst?.trackId&&worst.trackId!==best?.trackId?worst:null;
      return [best,second].filter(Boolean).map((finish,index)=>{const info=trackInfo(finish.trackId);const label=index?(finish.trackId===worst?.trackId?'Worst finish':'Strongest'):'Best finish';const weight=knownFinishWeight(finish);return `<span class="overall-best-line" data-track-id="${escapeHtml(finish.trackId)}"><b>${label}</b> #${finish.rank} of ${finish.fieldSize} · ${escapeHtml(info.name)} <em>${weight===null?'N/A':`${weight.toFixed(2)}x`}</em></span>`;}).join('')||'No ranked finishes yet';
    }
    if(overallCategory==='pbs'){
      const best=entry?.bestTracks?.[0];
      return best?.trackId?`<span class="overall-best-line" data-track-id="${escapeHtml(best.trackId)}"><b>Best result</b> #${best.rank} of ${best.fieldSize} · ${escapeHtml(trackInfo(best.trackId).name)}</span><span class="overall-best-line muted">Accepted personal-best improvements</span>`:'No accepted PBs yet';
    }
    if(overallCategory==='playtime')return bestTrackMarkup(entry);
    if(overallCategory==='skill')return `<span class="overall-best-line"><b>Scored results</b> Best ${Math.min(10,Number(entry.raceCount||0))} of ${Number(entry.raceCount||0)} ranked tracks</span>${bestTrackMarkup(entry)}`;
    if(overallCategory==='consistency')return `<span class="overall-best-line"><b>All-track depth</b> Weak outliers are limited</span>${bestTrackMarkup(entry)}`;
    if(overallCategory==='improved')return `<span class="overall-best-line"><b>Latest RP change</b> ${Number(entry.scoreDelta||0)<0?`${formatRp(Math.abs(Number(entry.scoreDelta)))} better`:'No saved RP gain'}</span>${bestTrackMarkup(entry)}`;
    if(overallCategory==='rising')return `<span class="overall-best-line"><b>${escapeHtml(entry.rankTier||'Racer')}</b> Racing for ${escapeHtml(entry.accountCreatedAt?durationLabel(Date.now()-Number(entry.accountCreatedAt)):'an unknown time')}</span>${bestTrackMarkup(entry)}`;
    if(overallCategory==='veterans')return `<span class="overall-best-line"><b>Racing since</b> ${escapeHtml(entry.accountCreatedAt?new Date(Number(entry.accountCreatedAt)).toLocaleDateString():'Unknown')}</span>${bestTrackMarkup(entry)}`;
    return bestTrackMarkup(entry);
  }

  function compactParticipationMeta(row,races){
    const official=Math.max(0,Number(row?.officialCount||0)||0);
    const community=Math.max(0,Number(row?.communityCount||0)||0);
    const custom=Math.max(0,Number(row?.customCount||0)||0);
    const nonOfficial=community+custom;
    if(official===races)return `<span>${races} official track${races===1?'':'s'}</span>`;
    if(custom===races)return `<span>${races} custom track${races===1?'':'s'}</span>`;
    if(nonOfficial===races)return `<span>${races} community track${races===1?'':'s'}</span>`;
    const nonOfficialLabel=community>0?'community':'custom';
    return [official?`<span>${official} official</span>`:'',nonOfficial?`<span>${nonOfficial} ${nonOfficialLabel}</span>`:''].filter(Boolean).join('');
  }
  function bestTrackMarkup(entry){
    const samples=normalizedFinishSamples(entry).filter((finish)=>Number(finish.rank||0)>0&&Number(finish.fieldSize||0)>=2);
    const ordered=samples.slice().sort((a,b)=>Number(a.rank)-Number(b.rank)||Number(b.fieldSize)-Number(a.fieldSize)||(knownFinishWeight(b)||0)-(knownFinishWeight(a)||0));
    const best=ordered[0]||(Array.isArray(entry?.bestTracks)&&entry.bestTracks.length?entry.bestTracks[0]:{trackId:entry?.bestTrackId,rank:entry?.bestTrackRank,fieldSize:entry?.bestTrackField});
    const strongest=samples.slice().sort((a,b)=>((100-rankedPlacementCost(b.rank,b.fieldSize))*(knownFinishWeight(b)||0))-((100-rankedPlacementCost(a.rank,a.fieldSize))*(knownFinishWeight(a)||0)))[0]||null;
    const line=(label,finish)=>{const info=trackInfo(finish.trackId);const field=Math.max(Number(finish.rank||0),Number(finish.fieldSize||0)||0);const weight=knownFinishWeight(finish);return `<span class="overall-best-line" data-track-id="${escapeHtml(finish.trackId)}" title="Open ${escapeHtml(info.name)}"><b>${label}</b> #${Number(finish.rank)} of ${field} · ${escapeHtml(info.name)} <em>${weight===null?'N/A':`${weight.toFixed(2)}x`}</em></span>`;};
    if(best?.trackId&&Number(best.rank)>0){
      const alternate=ordered.find((finish)=>finish?.trackId&&finish.trackId!==best.trackId);
      const second=strongest&&strongest.trackId!==best.trackId?line('Strongest',strongest):alternate?line('Next best',alternate):`<span class="overall-best-line muted">Only one ranked track in this profile</span>`;
      return line('Best',best)+second;
    }
    return 'Complete a track to set a best finish';
  }

  function countryFlagMarkup(countryCode){
    const code = String(countryCode || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) return '';
    return `<span class="overall-flag" title="Country: ${code}" aria-label="Country ${code}"><img src="images/countries/${code.toLowerCase()}.svg" alt="${code}" loading="lazy" decoding="async" onerror="this.parentElement.replaceWith(document.createTextNode('${code}'))"></span>`;
  }

  function medalSummaryMarkup(medals,compact=false){
    const rows=[['gold','Gold',Number(medals?.gold||0)],['silver','Silver',Number(medals?.silver||0)],['bronze','Bronze',Number(medals?.bronze||0)]].filter((row)=>row[2]>0);
    if(!rows.length)return '';
    return `<span class="${compact?'row-medals':'profile-medals'}" title="Podiums: first earns 9 points, second 3, and third 1">${rows.map(([kind,label,count])=>`<span class="${kind}" title="${label}: ${kind==='gold'?'first':kind==='silver'?'second':'third'} place finishes"><img src="${medalIcon(kind)}" alt="">${count}${compact?'':` ${label}`}</span>`).join('')}</span>`;
  }
  function profileAchievementMarkup(medals){
    const rows=[['gold','Gold',Number(medals?.gold||0)],['silver','Silver',Number(medals?.silver||0)],['bronze','Bronze',Number(medals?.bronze||0)]].filter((row)=>row[2]>0);
    if(!rows.length)return '<p class="profile-no-medals">No eligible podiums yet</p>';
    return rows.map(([kind,label,count])=>`<span class="profile-medal-card ${kind}" title="${label} podiums on recognized tracks with at least five racers"><img src="${medalIcon(kind)}" alt=""><b>${count}</b><small>${label}</small></span>`).join('');
  }

  function activeRankedAccountId(){
    return cleanUserId(localStorage.getItem('polytrack-0.6.2-active-account-id') || guestAccountId || '');
  }

  function eligibleWinCount(entry){
    if(entry?.trackWins!=null)return Math.max(0,Number(entry.trackWins)||0);
    return normalizedFinishSamples(entry).filter((finish)=>medalForRank(finish.rank,finish.fieldSize,finish.trackId)==='gold').length;
  }
  function largestLoadedField(entry){
    return normalizedFinishSamples(entry).reduce((largest,finish)=>Math.max(largest,Number(finish.fieldSize||0)||0),0);
  }

  function renderEntryRow(entry, index, showTopHint=false){
    const filteredRank=Number.isSafeInteger(entry?.filteredRank)&&entry.filteredRank>0?entry.filteredRank:null;
    const filteredTotal=Number.isSafeInteger(entry?.filteredTotal)&&entry.filteredTotal>=filteredRank?entry.filteredTotal:null;
    const preservedGlobalRank=Number.isSafeInteger(entry?.globalRank)&&entry.globalRank>0?entry.globalRank:null;
    const normalized = normalizeEntries([entry]);
    const row = normalized.length ? normalized[0] : { rank: index + 1, name: 'Guest', score: 1.000001, raceCount: 0, totalTracks: TOTAL_TRACKS, carColorId: normalizeCarColorId('') };
    const rank = filteredRank||Number(row?.rank || index + 1) || (index + 1);
    const score = Number(row?.score || 1.000001) || 1.000001;
    const races = Number(row?.raceCount || 0) || 0;
    const totalTracks = Number(row?.totalTracks || TOTAL_TRACKS) || TOTAL_TRACKS;
    const safeUserId = cleanUserId(row?.userId || row?.accountId || '');
    const safeName = escapeHtml(safeDisplayName(row?.nickname || row?.name || 'Guest',safeUserId));
    const savedCarStyle = __pt062NormalizeStyle(row?.carStyle || __pt062GetRememberedStyle(safeUserId) || '');
    const best = categoryTrackMarkup(row);
    const extra = showTopHint ? '<div style="font-size:13px;color:rgba(225,225,225,.9);margin-top:2px;">This could be you</div>' : '';
    const hintText = extra ? escapeHtml(String(extra).replace(/<[^>]+>/g,'').trim()) : '';
    const officialCount = Number(row?.officialCount || 0) || 0;
    const communityCount = Number(row?.communityCount || 0) || 0;
    const isSelf = safeUserId && safeUserId === activeRankedAccountId();
    const medals=row?.medals||{};
    const move = categoryContextMarkup(row,races,officialCount,communityCount,medals);
    const categoryValues={overall:score,medals:Number(medals.gold||0)*9+Number(medals.silver||0)*3+Number(medals.bronze||0),tracks:races,official:officialCount,community:communityCount,weight:Number(row?.weightedTracks||0),average:Number(row?.averagePlacement||0),competitiveAverage:row?.competitiveAveragePlacement,podiumRate:Number(row?.podiumRate||0),pbs:Number(row?.pbCount||0),playtime:Number(row?.totalPlaytimeMs||0),wins:eligibleWinCount(row),skill:Number(row?.skillCost||0),consistency:Number(row?.consistencyCost||0),improved:improvedRacerScore(row),rising:risingRacerScore(row),veterans:Math.max(0,Date.now()-Number(row?.accountCreatedAt||Date.now())),casual:row?.casualRp};
    const categoryValue=Number(categoryValues[overallCategory]??score);
    const categoryUnits={overall:'RANK POINTS',medals:'PODIUM POINTS',tracks:'TRACKS COMPLETED',official:'OFFICIAL FINISHES',community:'COMMUNITY FINISHES',weight:'TOTAL WEIGHT',average:'AVERAGE PLACE',competitiveAverage:'COMPETITIVE AVG',podiumRate:'PODIUM RATE',pbs:'PERSONAL BESTS',playtime:'ACTIVE TIME',wins:'TRACK WINS',skill:'SKILL RP',consistency:'ALL-TRACK DEPTH',improved:'IMPROVEMENT',rising:'RISING SCORE',veterans:'RANKED AGE',casual:'CASUAL RP'};
    const categoryUnit=categoryUnits[overallCategory]||'RANK POINTS';
    const scoreTitles={overall:LEADERBOARD_INFO.overall,casual:LEADERBOARD_INFO.casual,medals:LEADERBOARD_INFO.medals,weight:rankedWeightTitle('',0,true),average:LEADERBOARD_INFO.average,competitiveAverage:LEADERBOARD_INFO.competitiveAverage,podiumRate:LEADERBOARD_INFO.podiumRate,pbs:LEADERBOARD_INFO.pbs,playtime:LEADERBOARD_INFO.playtime,rising:LEADERBOARD_INFO.rising,wins:LEADERBOARD_INFO.wins,skill:LEADERBOARD_INFO.skill,consistency:LEADERBOARD_INFO.consistency};
    const scoreTitle=scoreTitles[overallCategory]||'Derived from the same complete Ranked snapshot.';
    const missingValue=(overallCategory==='casual'&&(!Number.isSafeInteger(row?.casualRp)||row.casualRp<0||!Number.isSafeInteger(row?.casualCompletionCount)||row.casualCompletionCount<0))||(overallCategory==='average'&&Number(row?.averagePlacementVersion||0)<AVERAGE_PLACEMENT_VERSION)||(overallCategory==='competitiveAverage'&&(!(Number(row?.competitiveAverageEligibleTracks||0)>0)||row?.competitiveAveragePlacement==null))||(overallCategory==='playtime'&&categoryValue<=0);
    const categoryDisplay=missingValue?'N/A':overallCategory==='casual'?String(categoryValue):overallCategory==='veterans'||overallCategory==='playtime'?durationLabel(categoryValue):overallCategory==='average'||overallCategory==='competitiveAverage'?Math.max(0,categoryValue).toFixed(2):['overall','skill','consistency','improved','rising'].includes(overallCategory)?formatRp(categoryValue):overallCategory==='weight'?categoryValue.toFixed(2):overallCategory==='podiumRate'?`${categoryValue.toFixed(1)}%`:String(categoryValue);
    const customCount=Number(row?.customCount||0)||0;
    const participationMeta=compactParticipationMeta(row,races);
    const medalMeta=medalSummaryMarkup(medals,true);
    const racerTitle=cosmeticTitleText(row);
    const titleMeta=racerTitle?`<span class="overall-racer-title">${escapeHtml(racerTitle)}</span>`:'';
    const identityMeta=titleMeta+(overallCategory==='overall'?`${participationMeta}<span class="overall-weight-chip" title="${escapeHtml(rankedWeightTitle('',0,true))}">${Number(row?.weightedTracks||0).toFixed(2)}x</span>`:overallCategory==='casual'?`${Number.isSafeInteger(row?.casualCompletionCount)?`<span>${row.casualCompletionCount} verified track${row.casualCompletionCount===1?'':'s'}</span>`:'<span>Casual data unavailable</span>'}<span>Overall #${preservedGlobalRank||'N/A'}</span>`:overallCategory==='medals'||overallCategory==='wins'?`${medalMeta}<span class="row-medal-denominator">/ ${races} ranked tracks</span>`:overallCategory==='tracks'||overallCategory==='official'||overallCategory==='community'?`${participationMeta}<span>${formatRp(score)} RP</span>`:overallCategory==='weight'?`${participationMeta}<span>${formatRp(score)} RP</span>`:overallCategory==='average'||overallCategory==='competitiveAverage'?`${participationMeta}`:overallCategory==='podiumRate'?`${medalMeta}<span>/ ${races} eligible tracks</span>`:`<span>${formatRp(score)} RP</span>${participationMeta}`);
    const provisional=Boolean(row.provisional)||races<MIN_RANKED_TRACKS;
      const badgeMarkup=profileBadgeMarkup(row,true);
      const visibleRank=overallCategory==='casual'&&missingValue?null:rank;
      const rankMarkup=filteredRank&&filteredTotal?`<span class="overall-rank" title="Filtered place #${filteredRank} of ${filteredTotal}. ${preservedGlobalRank?`Global rank #${preservedGlobalRank}.`:'Global rank unavailable.'}">#${filteredRank}/${filteredTotal}<small>FILTERED${preservedGlobalRank?` · GLOBAL #${preservedGlobalRank}`:''}</small></span>`:`<span class="overall-rank">${visibleRank===null?'N/A':provisional&&!['rising','casual'].includes(overallCategory)?'P':`#${visibleRank}`}</span>`;
      return `<div class="overall-entry ${visibleRank===1?'top-1':visibleRank===2?'top-2':visibleRank===3?'top-3':''} ${visibleRank===4?'after-podium':''} ${isSelf?'is-self':''} ${provisional?'is-provisional':''} ${missingValue?'has-missing-value':''} ${racerCosmeticClasses(row)}" data-userid="${safeUserId}" data-category="${escapeHtml(overallCategory)}" tabindex="0" role="button" aria-label="View ${safeName} ranked profile. ${filteredRank&&filteredTotal?`Filtered place ${filteredRank} of ${filteredTotal}. ${preservedGlobalRank?`Global rank ${preservedGlobalRank}.`:''}`:''} ${escapeHtml(categoryUnit)}: ${escapeHtml(categoryDisplay)}." style="animation-delay:${(index*0.03).toFixed(3)}s">${rankMarkup}<span class="overall-name">${carModelPreview(savedCarStyle,row?.carColorId||row?.carColors,safeUserId)}<span class="overall-name-label"><span class="overall-name-main">${safeName}${countryFlagMarkup(row?.countryCode)}${isSelf?'<span class="overall-you-tag">YOU</span>':''}${badgeMarkup}${provisional?'<span class="overall-provisional-tag">PROVISIONAL</span>':''}</span>${hintText?`<span class="overall-name-hint">${hintText}</span>`:''}<span class="overall-racer-meta">${identityMeta}</span></span></span><div class="overall-mid">${move}<div class="overall-best">${best}</div></div><div class="overall-stats" title="${escapeHtml(scoreTitle)}"><div class="overall-score">${categoryDisplay}</div><div class="overall-score-unit">${categoryUnit}</div></div></div>`;
  }

  const OVERALL_PAGE_SIZE = 15;
  let overallEntriesCache = [];
  let overallTrackSummariesCache = [];
  let overallPage = 0;
  let overallCategory = 'overall';
  let rankedFiltersModule=null,rankedFiltersUi=null,rankedFiltersUiPromise=null,rankedFilterResult=null,rankedFiltersSyncing=false;
  let rankedFilterSnapshotMeta={complete:false,totalEntries:null,publishedEntries:null,totalEntriesExact:false,ranksExact:false};
  const FILTERABLE_RANKED_CATEGORIES=new Set(['overall','average','competitiveAverage','tracks','medals','rising','skill','consistency','wins','podiumRate','weight','pbs','playtime','veterans','official','community','casual']);
  function setRankedFilterSnapshotMeta(meta,entryCount){
    const totalEntries=Number.isSafeInteger(meta?.totalEntries)&&meta.totalEntries>=0?meta.totalEntries:null;
    const publishedEntries=Number.isSafeInteger(meta?.publishedEntries)&&meta.publishedEntries>=0?meta.publishedEntries:null;
    const totalEntriesExact=meta?.totalEntriesExact===true;
    const ranksExact=meta?.ranksExact===true;
    rankedFilterSnapshotMeta={complete:meta?.complete===true&&totalEntriesExact&&ranksExact&&totalEntries===entryCount&&publishedEntries===entryCount,totalEntries,publishedEntries,totalEntriesExact,ranksExact};
  }
  function rankedFilterCompleteness(metric,rows){
    const snapshotComplete=rankedFilterSnapshotMeta.complete===true&&rankedFilterSnapshotMeta.totalEntriesExact===true&&rankedFilterSnapshotMeta.ranksExact===true&&rankedFilterSnapshotMeta.totalEntries===overallEntriesCache.length&&rankedFilterSnapshotMeta.publishedEntries===overallEntriesCache.length;
    if(!snapshotComplete)return false;
    if(metric==='snapshot')return true;
    if(metric.startsWith('category:')){
      const category=metric.slice(9);
      if(category==='casual')return rows.length>0&&rows.every(row=>Number.isSafeInteger(row?.casualRp)&&row.casualRp>=0&&Number.isSafeInteger(row?.casualCompletionCount)&&row.casualCompletionCount>=0);
      return FILTERABLE_RANKED_CATEGORIES.has(category);
    }
    if(metric==='rank')return rankedFilterSnapshotMeta.ranksExact===true&&rows.length>0&&rows.every(row=>Number.isSafeInteger(row?.rank)&&row.rank>0);
    if(metric==='identity')return rows.length>0&&rows.every(row=>Boolean(cleanUserId(row?.userId||row?.accountId||'')));
    if(metric==='wins')return rows.length>0&&rows.every(row=>Number.isSafeInteger(row?.trackWins)&&row.trackWins>=0);
    if(metric==='daysActive')return rows.length>0&&rows.every(row=>Number.isSafeInteger(row?.daysActive??row?.activeDays)&&(row.daysActive??row.activeDays)>=0);
    if(metric==='playtime')return rows.length>0&&rows.every(row=>Number.isFinite(row?.totalPlaytimeMs)&&row.totalPlaytimeMs>=0);
    if(metric==='tracksCompleted')return rows.length>0&&rows.every(row=>Number.isSafeInteger(row?.tracksCompleted??row?.raceCount)&&(row.tracksCompleted??row.raceCount)>=0);
    if(metric==='verification')return rows.length>0&&rows.every(row=>[row?.runVerified,row?.verified,row?.integrityVerified].some(value=>typeof value==='boolean'));
    return false;
  }
  function handleRankedFilterChange(result){
    rankedFilterResult=result;
    if(rankedFiltersSyncing)return;
    if(!result?.available)return;
    const category=result?.filter?.category;
    if(FILTERABLE_RANKED_CATEGORIES.has(category)&&category!==overallCategory){overallCategory=category;recordLeaderboardUse(category);refreshLeaderboardArcade();syncCategorySelect(document);}
    overallPage=0;
    renderEntries();
  }
  function mirrorRankedFilterCategory(category){
    if(!rankedFiltersUi||!FILTERABLE_RANKED_CATEGORIES.has(category))return;
    const current=rankedFiltersUi.getFilter();if(current.category===category)return;
    rankedFiltersSyncing=true;
    try{rankedFilterResult=rankedFiltersUi.setFilter({...current,category});}
    finally{rankedFiltersSyncing=false;}
  }
  function syncRankedFilterRows(rows){
    if(!rankedFiltersUi)return null;
    rankedFiltersSyncing=true;
    try{
      rankedFilterResult=rankedFiltersUi.update(rows);
      return rankedFilterResult;
    }finally{rankedFiltersSyncing=false;}
  }
  function ensureRankedFiltersUi(){
    const root=document.getElementById('overallFilterPanel');
    if(!root||rankedFiltersUi)return Promise.resolve(rankedFiltersUi);
    if(rankedFiltersUiPromise)return rankedFiltersUiPromise;
    rankedFiltersUiPromise=import(rankedFiltersModuleUrl).then(module=>{
      if(!root.isConnected)return null;
      rankedFiltersModule=module;rankedFiltersSyncing=true;
      try{rankedFiltersUi=module.mountRankedFilterPanel({root,rows:sortedOverallEntries(),isComplete:rankedFilterCompleteness,onChange:handleRankedFilterChange});rankedFilterResult=rankedFiltersUi.initialResult;}
      finally{rankedFiltersSyncing=false;}
      renderEntries();return rankedFiltersUi;
    }).catch(error=>{rankedFiltersUiPromise=null;root.textContent='Saved filters are unavailable.';log('warn','[RANKED-FILTERS]',String(error&&(error.message||error)));return null;});
    return rankedFiltersUiPromise;
  }
  const EVENT_TOTALS_CACHE_KEY='polytrack-062-ranked-event-totals-v1';
  let eventTotalsSnapshot=null,eventTotalsRequest=null;
  let eventTotalsState={status:'idle',checkedAt:0};
  function normalizeEventTotals(value){
    if(!value||!Array.isArray(value.entries)||value.entries.length>200||!Number.isSafeInteger(value.updatedAt)||value.updatedAt<0)throw Error('Invalid Event RP snapshot');
    const seen=new Set();
    const metric=(value,integer=false)=>value==null?null:typeof value==='number'&&Number.isFinite(value)&&value>=0&&(!integer||Number.isSafeInteger(value))?value:NaN;
    const optionalInteger=(value,maximum,{positive=false}={})=>Number.isSafeInteger(value)&&value>=(positive?1:0)&&value<=maximum?value:null;
    const entries=value.entries.map(row=>{
      const accountId=cleanUserId(row?.accountId||row?.userId||'');
      if(!accountId||seen.has(accountId))throw Error('Invalid Event RP identity');
      seen.add(accountId);
      const rank=metric(row.rank,true),rp=metric(row.rp),events=metric(row.events,true);
      if([rank,rp,events].some(Number.isNaN)||rank===0)throw Error('Invalid Event RP value');
      return {accountId,userId:accountId,name:typeof row.name==='string'?row.name:'',rank,rp,events,
        rollingHillsRunAgeMs:optionalInteger(row.rollingHillsRunAgeMs,3155760000000),
        rollingHillsEventRpContribution:optionalInteger(row.rollingHillsEventRpContribution,1001),
        permanentRollingHillsRp:optionalInteger(row.permanentRollingHillsRp,1001),
        rollingHillsTimeMs:optionalInteger(row.rollingHillsTimeMs,300000,{positive:true})};
    });
    return {entries,updatedAt:value.updatedAt};
  }
  function savedEventTotals(){
    if(eventTotalsSnapshot)return eventTotalsSnapshot;
    try{eventTotalsSnapshot=normalizeEventTotals(readJsonStorage(EVENT_TOTALS_CACHE_KEY,null));}catch{}
    return eventTotalsSnapshot;
  }
  async function fetchEventTotals(force=false){
    const saved=savedEventTotals();
    if(eventTotalsRequest)return eventTotalsRequest;
    if(!force&&saved&&Date.now()-eventTotalsState.checkedAt<120000)return saved.entries;
    eventTotalsState={...eventTotalsState,status:'loading'};
    if(overallCategory==='events'){renderEntries();updateRankedFreshness();}
    eventTotalsRequest=(async()=>{
      try{
        const next=normalizeEventTotals(await withTimeout(eventCloudRead('/v1/events/totals','0.6.2_event_public','totals'),12000,'Event RP timed out'));
        if(!eventTotalsSnapshot||next.updatedAt>=eventTotalsSnapshot.updatedAt){eventTotalsSnapshot=next;writeJsonStorage(EVENT_TOTALS_CACHE_KEY,next);}
        eventTotalsState={status:next.updatedAt<eventTotalsSnapshot.updatedAt?'stale':'cloud',checkedAt:Date.now()};
      }catch{eventTotalsState={status:savedEventTotals()?'stale':'error',checkedAt:Date.now()};}
      finally{eventTotalsRequest=null;if(overallCategory==='events'){renderEntries();updateRankedFreshness();}}
      return eventTotalsSnapshot?.entries||[];
    })();
    return eventTotalsRequest;
  }
  function sortedEventEntries(){
    const identities=new Map(overallEntriesCache.map(row=>[cleanUserId(row.userId||row.accountId||''),row]));
    return (savedEventTotals()?.entries||[]).map(event=>{
      const identity=identities.get(event.accountId),row={};
      // Overall contributes presentation only, never scores, eligibility or movement.
      for(const key of ['name','nickname','countryCode','carStyle','carColorId','carColors','profileCosmetics','badges'])if(identity?.[key]!=null)row[key]=identity[key];
      return {...row,...event,name:row.name||event.name||'Racer',nickname:row.nickname||row.name||event.name||'Racer'};
    }).sort((a,b)=>(a.rank??Infinity)-(b.rank??Infinity)||(b.rp??-Infinity)-(a.rp??-Infinity)||a.accountId.localeCompare(b.accountId));
  }
  function renderEventEntryRow(row,index){
    const id=cleanUserId(row.accountId),name=escapeHtml(safeDisplayName(row.nickname||row.name,id));
    const rank=row.rank==null?'N/A':'#'+row.rank,rp=row.rp==null?'N/A':formatRp(row.rp);
    const count=row.events==null?'Event count unavailable':`${row.events} event${row.events===1?'':'s'}`;
    const rollingRp=row.rollingHillsEventRpContribution??row.permanentRollingHillsRp;
    const snapshotAt=Number(savedEventTotals()?.updatedAt||0)||0;
    const rollingAge=row.rollingHillsRunAgeMs==null?null:row.rollingHillsRunAgeMs+Math.max(0,Date.now()-snapshotAt);
    const rollingDetails=rollingRp==null&&row.rollingHillsTimeMs==null&&rollingAge==null?'':`<span class="overall-best-line"><b>Rolling Hills</b>${rollingRp==null?'':` +${formatRp(rollingRp)} Event RP`}${row.rollingHillsTimeMs==null?'':` · ${formatRaceTime(row.rollingHillsTimeMs)}`}${rollingAge==null?'':` · run ${durationLabel(rollingAge)} old`}</span>`;
    return `<div class="overall-entry ${row.rank===1?'top-1':row.rank===2?'top-2':row.rank===3?'top-3':''} ${id===activeRankedAccountId()?'is-self':''} ${racerCosmeticClasses(row)}" data-userid="${escapeHtml(id)}" data-category="events" tabindex="0" role="button" aria-label="View ${name} profile. Event RP: ${escapeHtml(rp)}" style="animation-delay:${(index*.03).toFixed(3)}s"><span class="overall-rank">${rank}</span><span class="overall-name">${row.carStyle?carModelPreview(row.carStyle,row.carColorId||row.carColors,id):''}<span class="overall-name-label"><span class="overall-name-main">${name}${countryFlagMarkup(row.countryCode)}${id===activeRankedAccountId()?'<span class="overall-you-tag">YOU</span>':''}${profileBadgeMarkup(row,true)}</span><span class="overall-racer-meta">${count}</span></span></span><div class="overall-mid"><span class="overall-move flat">${count}</span><div class="overall-best">${rollingDetails||'Verified event PBs only'}</div></div><div class="overall-stats"><div class="overall-score">${rp}</div><div class="overall-score-unit">EVENT RP</div></div></div>`;
  }
  function renderEventEntries(listEl){
    const rows=sortedEventEntries();updateOverallPager();
    document.getElementById('overallLeaderboardPanel')?.setAttribute('data-category','events');
    if(!rows.length){
      const known=Boolean(savedEventTotals());
      listEl.innerHTML=`<div class="overall-empty"><strong>${eventTotalsState.status==='loading'?'Loading Event RP':known?'No Event RP earned yet':'Event RP unavailable'}</strong><span>${known?'Only verified event PBs earn points. Try a live event.':'No saved event standings are available. Your local PBs remain saved.'}</span><button class="button" type="button" data-rank-retry>Refresh Event RP</button></div>`;
    }else{
      listEl.innerHTML=rows.slice(overallPage*OVERALL_PAGE_SIZE,(overallPage+1)*OVERALL_PAGE_SIZE).map(renderEventEntryRow).join('');
      hydrateOverallCarModels(listEl);
    }
    listEl.scrollTop=0;
  }
  function updateEventFreshness(el){
    const status=eventTotalsState.status,saved=savedEventTotals(),failed=status==='stale'||status==='error';
    el.className=`overall-freshness ${failed?'is-stale':status==='loading'?'is-loading':''}`;
    el.textContent=`Event RP: ${status==='loading'?'checking cloud':failed?(saved?'cloud failed, saved standings':'cloud failed, no saved standings'):status==='cloud'?'cloud checked':'saved standings'}${saved?' · updated '+ageLabel(saved.updatedAt):''} · click to refresh`;
    el.title='Lifetime Event RP, separate from Overall RP. Saved event standings never expire.';
    el.dataset.old=String(Boolean(saved&&Date.now()-saved.updatedAt>7200000));
  }
  window.__pt062OpenRankedEvents=function(){ensurePanel();overallCategory='events';overallPage=0;return openPanel();};

  function loadedTrackRankingRows(){
    if(overallTrackSummariesCache.length){
      return annotateCategoryRanks(overallTrackSummariesCache.filter((row)=>Number(row.fieldSize||0)>=2).map((row)=>{
        const info=trackInfo(row.trackId);
        return {...row,name:info.name,type:String(row.type||info.type),userId:String(row.trackId||'')};
      }).sort((a,b)=>Number(b.weight||0)-Number(a.weight||0)||Number(b.fieldSize||0)-Number(a.fieldSize||0)||a.name.localeCompare(b.name)),'topTracks');
    }
    const tracks=new Map();
    const snapshotAt=Number(overallLoadState.serverUpdatedAt||overallLoadState.fetchedAt||readOverallSnapshotCache()?.serverUpdatedAt||0)||0;
    for(const entry of overallEntriesCache){
      for(const finish of normalizedFinishSamples(entry)){
        const trackId=String(finish.trackId||''); if(!trackId)continue;
        const info=trackInfo(trackId); const existing=tracks.get(trackId)||{trackId,name:info.name,type:info.type,fieldSize:0,weight:0,leader:null,recordMs:0,updatedAt:snapshotAt};
        existing.fieldSize=Math.max(existing.fieldSize,Number(finish.fieldSize||0)||0);
        existing.weight=Math.max(existing.weight,knownFinishWeight(finish)||0);
        const isBetter=!existing.leader||Number(finish.rank||Infinity)<Number(existing.leader.rank||Infinity)||(Number(finish.rank||Infinity)===Number(existing.leader.rank||Infinity)&&canonicalRaceTimeMs(finish)>0&&canonicalRaceTimeMs(finish)<existing.recordMs);
        if(isBetter){existing.leader={...entry,...finish};existing.recordMs=canonicalRaceTimeMs(finish);}
        tracks.set(trackId,existing);
      }
    }
    const rows=Array.from(tracks.values()).filter((row)=>row.fieldSize>=2).sort((a,b)=>b.weight-a.weight||b.fieldSize-a.fieldSize||a.name.localeCompare(b.name)).map((row)=>({...row,userId:row.trackId}));
    return annotateCategoryRanks(rows,'topTracks');
  }
  function currentLeaderboardCount(){
    if(overallCategory==='topTracks')return loadedTrackRankingRows().length;
    if(rankedFilterResult?.available&&rankedFilterResult.filter?.category===overallCategory)return rankedFilterResult.rows.length;
    return sortedOverallEntries().length;
  }
  function renderTrackRankingRow(row,index){
    const leaderId=cleanUserId(row.leader?.accountId||row.leader?.userId||'');
    const leaderName=escapeHtml(safeDisplayName(row.leader?.nickname||row.leader?.name||'Unknown racer',leaderId));
    const age=row.updatedAt?ageLabel(row.updatedAt):'age unknown';
    const weightParts=finishWeightParts({...row.leader,trackId:row.trackId,fieldSize:row.fieldSize,weight:row.weight});
    const snapshot=readTrackSnapshotCache(row.trackId);
    const activeId=activeRankedAccountId();
    const viewerIndex=(snapshot?.entries||[]).findIndex((entry)=>cleanUserId(entry.accountId||entry.userId||'')===activeId);
    const viewer=viewerIndex>=0?snapshot.entries[viewerIndex]:null;
    const leaderIsViewer=leaderId&&leaderId===activeId;
    const leaderLine=`#1 ${leaderIsViewer?'<span class="overall-track-you">YOU</span>':leaderName} · ${row.recordMs?formatRaceTime(row.recordMs):'time unavailable'}`;
    const matchingBoard=snapshot?.entries?.length===row.fieldSize&&cleanUserId(snapshot.entries[0]?.accountId||snapshot.entries[0]?.userId||'')===leaderId&&entryTimeMs(snapshot.entries[0])===row.recordMs;
    const runnerUp=matchingBoard?snapshot.entries[1]:null;
    const runnerUpLine=runnerUp?'#2 '+escapeHtml(safeDisplayName(runnerUp.name||runnerUp.nickname,runnerUp.accountId||runnerUp.userId))+' · '+formatRaceTime(entryTimeMs(runnerUp)):'Runner-up not loaded';
    const viewerLine=leaderIsViewer?runnerUpLine:viewer?`<span class="overall-track-you">YOU</span> #${viewerIndex+1} of ${snapshot.entries.length} · ${formatRaceTime(entryTimeMs(viewer))}`:'Your result is not loaded on this device';
    const pbDate=pbTimestamp(row.leader)?`PB ${formatLocalPbDate(row.leader)}`:`Track data changed ${age}`;
    return `<div class="overall-entry overall-track-entry track-type-${escapeHtml(row.type)} ${index===0?'top-1':index===1?'top-2':index===2?'top-3':''}" data-track-id="${escapeHtml(row.trackId)}" tabindex="0" role="button" aria-label="Open ${escapeHtml(row.name)}" style="animation-delay:${(index*.03).toFixed(3)}s"><span class="overall-rank">#${index+1}</span><span class="overall-name">${trackThumbnailMarkup(row.trackId)}<span class="overall-name-label"><span class="overall-name-main">${escapeHtml(row.name)}</span><span class="overall-racer-meta"><span class="track-type-label ${escapeHtml(row.type)}">${escapeHtml(row.type)}</span><span>${row.fieldSize} racers</span><span>${weightParts.baseWeight.toFixed(2)}x base field</span></span></span></span><div class="overall-mid">${movementMarkup(row.categoryMovement,row.categorySince,index+1)}<div class="overall-best"><span class="overall-best-line"><b>${leaderLine}</b></span><span class="overall-best-line">${viewerLine}</span><span class="overall-best-line muted">${escapeHtml(pbDate)}</span></div></div><div class="overall-stats" title="${escapeHtml(rankedWeightTitle(row.trackId,row.fieldSize,false,{...row.leader,trackId:row.trackId,fieldSize:row.fieldSize,weight:row.weight}))}"><div class="overall-score">${row.weight.toFixed(2)}x</div><div class="overall-score-unit">FINAL WEIGHT</div></div></div>`;
  }
  function racerAgeDays(entry){
    const created=Math.max(0,Number(entry?.accountCreatedAt||0)||0);
    return created?Math.max(0,(Date.now()-created)/86400000):Infinity;
  }
  function risingRacerScore(entry){
    const days=racerAgeDays(entry);
    if(!Number.isFinite(days))return 0;
    const readiness=Math.min(1,Math.max(0,Number(entry?.raceCount||0))/5);
    return Math.max(0,100-Number(entry?.score||100))*Math.sqrt(3/(days+3))*readiness;
  }
  function improvedRacerScore(entry){
    return Math.max(0,-Number(entry?.scoreDelta||0))*10+Math.max(0,Number(entry?.movement||0));
  }
  function annotateCategoryRanks(rows,category){
    const key=`polytrack-0.6.2-category-ranks-${category}-v1`;
    const previous=readJsonStorage(key,{ranks:{},since:{}})||{ranks:{},since:{}};
    const now=Date.now(); const ranks={}; const since={};
    const output=rows.map((entry,index)=>{
      const id=cleanUserId(entry.userId||entry.accountId||''); const rank=index+1;
      const priorRank=Math.max(0,Number(previous.ranks?.[id]||0)||0);
      const movement=priorRank?priorRank-rank:0;
      ranks[id]=rank;
      since[id]=priorRank===rank?(Number(previous.since?.[id]||0)||now):now;
      return {...entry,categoryRank:rank,categoryMovement:movement,categorySince:since[id]};
    });
    writeJsonStorage(key,{ranks,since,updatedAt:now});
    return output;
  }
  function sortedOverallEntries(){
    if(overallCategory==='events')return sortedEventEntries();
    let rows=[...overallEntriesCache];
    if(['overall','skill','consistency','average','competitiveAverage','podiumRate'].includes(overallCategory))rows=rows.filter((entry)=>!entry.provisional&&Number(entry.raceCount||0)>=MIN_RANKED_TRACKS);
    if(overallCategory==='playtime')rows=rows.filter((entry)=>Number(entry.totalPlaytimeMs||0)>0);
    if(overallCategory==='medals') rows.sort((a,b)=>((b.medals?.gold||0)*9+(b.medals?.silver||0)*3+(b.medals?.bronze||0))-((a.medals?.gold||0)*9+(a.medals?.silver||0)*3+(a.medals?.bronze||0))||Number(b.medals?.gold||0)-Number(a.medals?.gold||0)||Number(b.medals?.silver||0)-Number(a.medals?.silver||0)||a.rank-b.rank);
    else if(overallCategory==='tracks') rows.sort((a,b)=>Number(b.raceCount||0)-Number(a.raceCount||0)||a.rank-b.rank);
    else if(overallCategory==='weight') rows.sort((a,b)=>Number(b.weightedTracks||0)-Number(a.weightedTracks||0)||a.rank-b.rank);
    else if(overallCategory==='official') rows.sort((a,b)=>Number(b.officialCount||0)-Number(a.officialCount||0)||a.rank-b.rank);
    else if(overallCategory==='community') rows.sort((a,b)=>Number(b.communityCount||0)-Number(a.communityCount||0)||a.rank-b.rank);
    else if(overallCategory==='average') rows.sort((a,b)=>((a.averagePlacement!=null&&Number(a.averagePlacement)>0&&Number(a.averagePlacementVersion||0)>=AVERAGE_PLACEMENT_VERSION?Number(a.averagePlacement):Infinity)-(b.averagePlacement!=null&&Number(b.averagePlacement)>0&&Number(b.averagePlacementVersion||0)>=AVERAGE_PLACEMENT_VERSION?Number(b.averagePlacement):Infinity))||Number(b.raceCount||0)-Number(a.raceCount||0)||a.rank-b.rank);
    else if(overallCategory==='competitiveAverage') rows.sort((a,b)=>((a.competitiveAveragePlacement==null?Infinity:Number(a.competitiveAveragePlacement))-(b.competitiveAveragePlacement==null?Infinity:Number(b.competitiveAveragePlacement)))||Number(b.competitiveAverageEligibleTracks||0)-Number(a.competitiveAverageEligibleTracks||0)||a.rank-b.rank);
    else if(overallCategory==='podiumRate') rows.sort((a,b)=>Number(b.podiumRate||0)-Number(a.podiumRate||0)||Number(b.raceCount||0)-Number(a.raceCount||0)||a.rank-b.rank);
    else if(overallCategory==='pbs') rows.sort((a,b)=>Number(b.pbCount||0)-Number(a.pbCount||0)||a.rank-b.rank);
    else if(overallCategory==='playtime') rows.sort((a,b)=>Number(b.totalPlaytimeMs)-Number(a.totalPlaytimeMs)||a.rank-b.rank);
    else if(overallCategory==='wins') rows.sort((a,b)=>eligibleWinCount(b)-eligibleWinCount(a)||Number(b.raceCount||0)-Number(a.raceCount||0)||a.rank-b.rank);
    else if(overallCategory==='skill') rows.sort((a,b)=>(a.skillCost==null?Infinity:Number(a.skillCost))-(b.skillCost==null?Infinity:Number(b.skillCost))||Number(b.raceCount||0)-Number(a.raceCount||0)||a.rank-b.rank);
    else if(overallCategory==='consistency') rows.sort((a,b)=>(a.consistencyCost==null?Infinity:Number(a.consistencyCost))-(b.consistencyCost==null?Infinity:Number(b.consistencyCost))||Number(b.raceCount||0)-Number(a.raceCount||0)||a.rank-b.rank);
    else if(overallCategory==='improved') rows.sort((a,b)=>improvedRacerScore(b)-improvedRacerScore(a)||a.rank-b.rank);
    else if(overallCategory==='rising') rows.sort((a,b)=>risingRacerScore(b)-risingRacerScore(a)||a.rank-b.rank);
    else if(overallCategory==='veterans') rows.sort((a,b)=>Number(a.accountCreatedAt||Infinity)-Number(b.accountCreatedAt||Infinity)||a.rank-b.rank);
    else if(overallCategory==='casual'){
      const known=entry=>Number.isSafeInteger(entry?.casualRp)&&entry.casualRp>=0&&Number.isSafeInteger(entry?.casualCompletionCount)&&entry.casualCompletionCount>=0;
      rows.sort((a,b)=>Number(known(b))-Number(known(a))||(known(a)?b.casualRp-a.casualRp||b.casualCompletionCount-a.casualCompletionCount:0)||a.rank-b.rank);
      let casualRank=0;
      return rows.map(entry=>({...entry,globalRank:entry.rank,categoryRank:known(entry)?++casualRank:null,categoryMovement:0,categorySince:0}));
    }
    else rows.sort((a,b)=>a.rank-b.rank);
    return annotateCategoryRanks(rows,overallCategory);
  }
  function updateOverallPager(){
    const count=currentLeaderboardCount();
    const totalPages = Math.max(1,Math.ceil(count / OVERALL_PAGE_SIZE));
    overallPage = Math.max(0,Math.min(overallPage,totalPages-1));
    const status = document.getElementById('overallPageStatus');
    const previous = document.getElementById('overallPrevPage');
    const next = document.getElementById('overallNextPage');
    const label=LEADERBOARD_LABELS[overallCategory]||'Overall RP';
    const subset=rankedFilterResult?.available&&rankedFilterResult.filter?.category===overallCategory&&rankedFilterResult.filteredCount<rankedFilterResult.sourceCount;
    if (status) status.textContent = `${label} · ${overallPage + 1}/${totalPages} · ${subset?`filtered ${count}/${rankedFilterResult.sourceCount}`:count} ${overallCategory==='topTracks'?'tracks':'racers'}`;
    syncCategorySelect(document);
    if (previous) previous.disabled = overallPage <= 0;
    if (next) next.disabled = overallPage >= totalPages - 1;
  }
  function changeOverallPage(direction){
    const totalPages = Math.max(1,Math.ceil(currentLeaderboardCount() / OVERALL_PAGE_SIZE));
    overallPage = Math.max(0,Math.min(totalPages-1,overallPage + Number(direction || 0)));
    renderEntries();
  }
  function focusCurrentRacer(){
    const accountId = activeRankedAccountId();
    const visible=rankedFilterResult?.available&&rankedFilterResult.filter?.category===overallCategory?rankedFilterResult.rows:sortedOverallEntries();
    const index = visible.findIndex((entry)=>cleanUserId(entry.userId || entry.accountId || '') === accountId);
    const button = document.getElementById('overallFindMeBtn');
    if (index < 0) {
      if (button) { const prior=button.textContent; button.textContent=overallCategory==='events'?'No published Event RP':rankedFilterResult?.available?'Not in filtered results':'No ranked run'; setTimeout(()=>{if(button.isConnected)button.textContent=prior;},1400); }
      return;
    }
    overallPage = Math.floor(index / OVERALL_PAGE_SIZE);
    renderEntries();
    requestAnimationFrame(()=>{
      const row = document.querySelector(`#overallLeaderboardList .overall-entry[data-userid="${CSS.escape(accountId)}"]`);
      if (!row) return;
      row.classList.add('rank-self-focus');
      row.scrollIntoView({behavior:document.documentElement.classList.contains('sq-reduced-effects')?'auto':'smooth',block:'center'});
    });
  }
  function trackThumbnailMarkup(trackId){
    const info=trackInfo(trackId);
    const nativeTitle=[...document.querySelectorAll('.track-title p')].find((node)=>String(node.textContent||'').trim()===info.name);
    const nativeSource=nativeTitle?.closest('button')?.querySelector('img:not(.environment)')?.getAttribute('src')||'';
    const basic=String(info.name||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
    const slug=info.type==='official'?basic.replace(/[^a-z0-9]+/g,''):basic.replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
    const fallback=slug&&info.type!=='custom'?`tracks/${info.type==='official'?'official':'community'}/thumbnails/${slug}.png`:'';
    const source=nativeSource||info.thumbnail||fallback;
    const mystery=info.type==='custom'?'<span class="profile-track-placeholder is-mystery" aria-hidden="true">?</span>':'';
    return `<span class="profile-track-image-frame ${info.type==='official'?'is-silhouette':info.type==='custom'?'is-custom':'is-artwork'}">${mystery}${source?`<img class="profile-track-thumb" src="${escapeHtml(source)}" alt="${escapeHtml(info.name)} thumbnail" loading="lazy" decoding="async" onerror="this.style.display='none'">`:''}</span>`;
  }
  function focusTrackFromRanked(trackId,{event=false}={}){
    if(!event)eventUi?.leave();
    const id=String(trackId||'');
    const info=trackInfo(id);
    const panel=document.getElementById('overallLeaderboardPanel');
    if(panel)panel.style.display='none';
    const play=[...document.querySelectorAll('.main-buttons-container button')].find((button)=>button.textContent.trim()==='Play'&&isElementVisible(button));
    if(play)play.click();
    let attempts=0;
    const reveal=()=>{
      attempts++;
      const title=[...document.querySelectorAll('.track-title p')].find((node)=>node.textContent.trim()===info.name);
      const button=title?.closest('button');
      if(button&&event){button.click();return;}
      if(button){button.click();return;}
      if(attempts<30)setTimeout(reveal,100);
    };
    setTimeout(reveal,120);
  }
  function trackSummaryLine(label,finish,fallback){
    if(!finish?.trackId) return `<div class="profile-result muted no-track" aria-label="${escapeHtml(label)} is not available"><div><b>${label}</b><span>N/A</span><small>${escapeHtml(fallback)}</small></div></div>`;
    const info=trackInfo(finish.trackId);
    const field=Math.max(Number(finish.rank||0),Number(finish.fieldSize||0));
    const weight=knownFinishWeight(finish);
    const result=Number(finish.rank||0)>0?`#${Number(finish.rank)} of ${Math.max(Number(finish.rank||0),Number(finish.fieldSize||0))}`:'Not entered';
    return `<button class="profile-result ${weight===null?'is-null':''}" type="button" data-track-id="${escapeHtml(finish.trackId)}" aria-label="Open ${escapeHtml(info.name)}. ${escapeHtml(result)}. Weight ${weight===null?'not available':weight.toFixed(2)}." title="Open ${escapeHtml(info.name)}. ${escapeHtml(rankedWeightTitle(finish.trackId,field,false,finish))}">${trackThumbnailMarkup(finish.trackId)}<div><b>${label}</b><span>${escapeHtml(info.name)}</span><small>${result}</small></div><strong class="profile-result-weight" title="${escapeHtml(rankedWeightTitle(finish.trackId,field,false,finish))}"><span>${weight===null?'N/A':`${weight.toFixed(2)}x`}</span><small>WEIGHT</small></strong></button>`;
  }
  function formatRaceTime(timeMs){
    const value=Math.max(0,Math.round(Number(timeMs||0)||0));
    const minutes=Math.floor(value/60000);
    const seconds=Math.floor((value%60000)/1000);
    return `${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}.${String(value%1000).padStart(3,'0')}`;
  }
  function pbTimestamp(record){
    const value=Number(record?.pbAt||record?.createdAt||record?.timestamp||0)||0;
    return Number.isFinite(value)&&value>0?value:0;
  }
  function formatLocalPbDate(record,includeTime=true){
    const value=pbTimestamp(record);
    if(!value)return 'PB date unavailable';
    const options=includeTime
      ? {year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}
      : {year:'numeric',month:'short',day:'numeric'};
    return new Date(value).toLocaleString(undefined,options);
  }
  function entryTimeMs(row){
    const value=canonicalRaceTimeMs(row);
    return value>0&&value<=36000000?value:0;
  }
  let profileSort='place';
  let profileSortDirection=1;
  function sortProfileFinishes(rows){
    const sorted=[...(rows||[])];
    const placeRatio=(row)=>Number(row.rank||999999)/Math.max(1,Number(row.fieldSize||0));
    const nullableCompare=(a,b,direction,allowZero=false)=>{
      const aMissing=a===null||a===undefined||!Number.isFinite(Number(a))||(allowZero?Number(a)<0:Number(a)<=0);
      const bMissing=b===null||b===undefined||!Number.isFinite(Number(b))||(allowZero?Number(b)<0:Number(b)<=0);
      if(aMissing!==bMissing)return aMissing?1:-1;
      if(aMissing&&bMissing)return 0;
      return direction*(Number(a)-Number(b));
    };
    if(profileSort==='track')sorted.sort((a,b)=>profileSortDirection*trackInfo(a.trackId).name.localeCompare(trackInfo(b.trackId).name));
    else if(profileSort==='weight')sorted.sort((a,b)=>nullableCompare(knownFinishWeight(a),knownFinishWeight(b),profileSortDirection,true)||placeRatio(a)-placeRatio(b));
    else if(profileSort==='time')sorted.sort((a,b)=>nullableCompare(a.timeMs,b.timeMs,profileSortDirection));
    else sorted.sort((a,b)=>nullableCompare(a.rank,b.rank,profileSortDirection)||profileSortDirection*(placeRatio(a)-placeRatio(b)));
    return sorted;
  }
  function profileSortArrow(key){
    if(profileSort!==key)return '';
    return profileSortDirection>0?' &#9650;':' &#9660;';
  }
  function cachedProfileFinishes(userId,entry){
    const byTrack=new Map();
    const store=trackSnapshotStore();
    for(const [trackId,snapshot] of Object.entries(store)){
      const rows=Array.isArray(snapshot?.entries)?snapshot.entries:[];
      const index=rows.findIndex((row)=>cleanUserId(row.accountId||row.userId||'')===cleanUserId(userId));
      if(index<0)continue;
      const row=rows[index]||{};
      const rank=Math.max(1,Number(row.rank||row.position||index+1)||index+1);
      const fieldSize=Math.max(rank,rows.length);
      byTrack.set(trackId,{trackId,rank,fieldSize,timeMs:entryTimeMs(row),pbAt:pbTimestamp(row),weight:knownFinishWeight({...row,trackId,rank,fieldSize}),cachedAt:Math.max(Number(snapshot.serverUpdatedAt||0),Number(snapshot.checkedAt||0))});
    }
    const overallFreshAt=Number(overallLoadState.serverUpdatedAt||overallLoadState.fetchedAt||readOverallSnapshotCache()?.serverUpdatedAt||readOverallSnapshotCache()?.fetchedAt||0)||0;
    for(const finish of [...(entry?.resultSamples||[]),...(entry?.bestTracks||[]),...(entry?.weightedResults||[]),...(entry?.opportunityTracks||[]),entry?.strongestTrack,entry?.improvementTrack]){
      if(!finish?.trackId)continue;
      const fieldSize=Math.max(Number(finish.rank||0),Number(finish.fieldSize||0));
      const summaryTime=canonicalRaceTimeMs(finish,Number(entry?.timingVersion||0)<2);
      const current=byTrack.get(finish.trackId);
      if(!current||overallFreshAt>=Number(current.cachedAt||0)){
        const localTime=current?.local&&current.timeMs&&(!summaryTime||current.timeMs<summaryTime)?current.timeMs:summaryTime;
        byTrack.set(finish.trackId,{...current,...finish,timeMs:localTime,weight:knownFinishWeight({...finish,fieldSize}),cachedAt:overallFreshAt,local:Boolean(current?.local)});
      }
    }
    if(cleanUserId(userId)===activeRankedAccountId()){
      for(const row of readLocalRaceRows()){
        if(cleanUserId(row.accountId||row.userId||'')!==cleanUserId(userId))continue;
        const trackId=String(row.trackId||'');
        const timeMs=entryTimeMs(row);
        if(!trackId||!timeMs)continue;
        const current=byTrack.get(trackId);
        if(!current)byTrack.set(trackId,{trackId,rank:null,fieldSize:null,timeMs,pbAt:pbTimestamp(row),weight:null,cachedAt:Number(row.createdAt||0)||0,local:true});
        else if(!current.timeMs||timeMs<current.timeMs)byTrack.set(trackId,{...current,timeMs,pbAt:pbTimestamp(row),local:true});
      }
    }
    return sortProfileFinishes(Array.from(byTrack.values()));
  }
  function profileTrackLink(finish,comparison=''){
    if(!finish?.trackId)return '';
    const info=trackInfo(finish.trackId);
    const field=Math.max(Number(finish.rank||0),Number(finish.fieldSize||0));
    const weight=knownFinishWeight(finish);
    return `<button class="profile-inline-track" type="button" data-track-id="${escapeHtml(finish.trackId)}" title="${escapeHtml(`Open ${info.name}. ${comparison} ${rankedWeightTitle(finish.trackId,field,false,finish)}`.trim())}"><strong>${escapeHtml(info.name)}</strong></button>`;
  }
  function profileTrackComparison(finish,entryFinishes,selfFinishes,isSelf=false){
    if(!finish?.trackId)return '';
    const theirs=(entryFinishes||[]).find((row)=>row.trackId===finish.trackId)||finish;
    const yours=(selfFinishes||[]).find((row)=>row.trackId===finish.trackId);
    if(isSelf)return Number(theirs.rank||0)>0?`You: #${theirs.rank} of ${theirs.fieldSize}${theirs.timeMs?` at ${formatRaceTime(theirs.timeMs)}`:''}.`:`Your local PB: ${formatRaceTime(theirs.timeMs)}.`;
    const theirText=Number(theirs.rank||0)>0?`Racer: #${theirs.rank} of ${theirs.fieldSize}${theirs.timeMs?` at ${formatRaceTime(theirs.timeMs)}`:''}.`:'';
    const yourText=yours?(Number(yours.rank||0)>0?` You: #${yours.rank} of ${yours.fieldSize}${yours.timeMs?` at ${formatRaceTime(yours.timeMs)}`:''}.`:` Your local PB: ${formatRaceTime(yours.timeMs)}.`):' You have no loaded result here.';
    return `${theirText}${yourText}`;
  }
  function rankTrendMarkup(entry){
    const history=(Array.isArray(entry?.rankHistory)?entry.rankHistory:[]).slice(-10);
    if(history.length<2)return '<span class="profile-trend-empty">Trend builds as this device observes new Ranked snapshots.</span>';
    const ranks=history.map((point)=>Math.max(1,Number(point.rank||1)));
    const high=Math.max(...ranks),low=Math.min(...ranks),range=Math.max(1,high-low);
    return `<span class="profile-rank-trend" title="Local snapshot history. No Firebase reads are used.">${ranks.map((rank,index)=>`<i style="height:${Math.round(24+(high-rank)/range*30)}px" title="Observed rank #${rank}"></i>`).join('')}</span>`;
  }
  function profileOpportunityCandidates(entry,cachedFinishes,isSelf){
    const completed=new Set((cachedFinishes||[]).filter((finish)=>Number(finish.rank||0)>0).map((finish)=>finish.trackId));
    for(const finish of [...(entry?.bestTracks||[]),...(entry?.weightedResults||[]),...(entry?.opportunityTracks||[]),entry?.strongestTrack,entry?.improvementTrack]){
      if(finish?.trackId&&Number(finish.rank||0)>0)completed.add(finish.trackId);
    }
    if(isSelf){
      for(const row of readLocalRaceRows())if(cleanUserId(row.accountId||row.userId)===activeRankedAccountId()&&String(row.trackId||''))completed.add(String(row.trackId));
    }
    const candidates=(entry?.opportunityTracks||[]).filter((finish)=>finish?.trackId&&Number(finish.rank||0)>1);
    if(isSelf){
      const store=trackSnapshotStore();
      for(const track of TRACK_CATALOG.values()){
        if(completed.has(track.id))continue;
        const fieldSize=Math.max(1,Number(store[track.id]?.entries?.length||0)||1);
        const weight=cachedTrackWeight(track.id,store[track.id]);
        candidates.push({trackId:track.id,rank:0,fieldSize,weight,improvementValue:100*weight,unplayed:true});
      }
    }
    const unique=new Map();
    for(const finish of candidates){
      const current=unique.get(finish.trackId);
      if(!current||Number(finish.improvementValue||finish.weight||0)>Number(current.improvementValue||current.weight||0))unique.set(finish.trackId,finish);
    }
    return Array.from(unique.values()).sort((a,b)=>Number(b.improvementValue||b.weight||0)-Number(a.improvementValue||a.weight||0)||Number(b.fieldSize||0)-Number(a.fieldSize||0));
  }
  function profileComparisonRoutes(viewedFinishes,selfFinishes,defending=false){
    const viewed=new Map((viewedFinishes||[]).filter((finish)=>finish?.trackId).map((finish)=>[finish.trackId,finish]));
    const self=new Map((selfFinishes||[]).filter((finish)=>finish?.trackId).map((finish)=>[finish.trackId,finish]));
    const candidates=[];
    for(const trackId of new Set([...viewed.keys(),...self.keys()])){
      const theirs=viewed.get(trackId); const yours=self.get(trackId);
      const theirRatio=theirs&&Number(theirs.rank||0)>0?Number(theirs.rank)/Math.max(1,Number(theirs.fieldSize||0)):Infinity;
      const yourRatio=yours&&Number(yours.rank||0)>0?Number(yours.rank)/Math.max(1,Number(yours.fieldSize||0)):Infinity;
      const weight=knownFinishWeight(yours)||knownFinishWeight(theirs)||rankedTrackWeight(trackId,Math.max(Number(yours?.fieldSize||0),Number(theirs?.fieldSize||0),1));
      if(defending){
        // To strengthen a lead, prioritize tracks where the lower-ranked rival currently beats you or you have not entered.
        if(!theirs||(yours&&yourRatio<=theirRatio))continue;
        const unplayed=!yours;
        const routeGap=unplayed?2+Math.max(0,1-theirRatio):Math.max(0,yourRatio-theirRatio);
        const routeScore=unplayed?weight*(2+Math.max(0,1-theirRatio)):weight/(.08+routeGap);
        candidates.push({...theirs,weight,routeGap,routeScore,unplayed});
      }else{
        if(!theirs||yourRatio<=theirRatio)continue;
        candidates.push({...theirs,weight,routeGap:Number.isFinite(yourRatio)?yourRatio-theirRatio:2,unplayed:!yours});
      }
    }
    return candidates.sort((a,b)=>defending?Number(b.routeScore||0)-Number(a.routeScore||0)||b.weight-a.weight:Number(b.routeGap||0)-Number(a.routeGap||0)||b.weight-a.weight).slice(0,2);
  }
  const PLANNER_METRICS=Object.freeze({overall:'Overall RP',skill:'Best-ten skill',medals:'Podium points',wins:'Track wins',podiumRate:'Podium rate',weight:'Total track weight',events:'Event RP'});
  let plannerMetric='overall';
  let plannerSort='impact';
  try{if(localStorage.getItem('polytrack-0.6.2-planner-sort')==='ease')plannerSort='ease';}catch{}
  try{const stored=localStorage.getItem('polytrack-0.6.2-planner-metric');if(Object.hasOwn(PLANNER_METRICS,stored))plannerMetric=stored;}catch{}
  function eventPlannerRoutes(accountId,rivalId,at=Date.now()){
    const catalog=readJsonStorage('polytrack-062-events-v1',{});
    const best=readJsonStorage('polytrack-062-events-v1-best',{});
    const routes=[];let dataAvailable=false;
    for(const period of (Array.isArray(catalog?.periods)?catalog.periods:[])){
      if(!period||!['daily','weekly'].includes(period.kind)||!(period.startsAt<=at&&at<period.endsAt)||!Number.isSafeInteger(period.targetMs)||period.targetMs<=0||period.targetMs>300000||!Number.isSafeInteger(period.maxRp)||period.maxRp<=0||period.maxRp>1000)continue;
      const board=readJsonStorage('polytrack-062-events-v1-'+period.id,null);
      if(board?.period?.id!==period.id||board.period.trackId!==period.trackId||board.period.targetMs!==period.targetMs||board.period.maxRp!==period.maxRp||!Array.isArray(board.entries))continue;
      dataAvailable=true;
      const own=board.entries.find(r=>r?.accountId===accountId),rival=board.entries.find(r=>r?.accountId===rivalId);
      const local=best?.[period.id+'_'+accountId];
      const times=[own?.timeMs].filter(n=>Number.isSafeInteger(n)&&n>0);
      const localTime=Number.isSafeInteger(local?.timeMs)&&local.timeMs>0?local.timeMs:null;
      const currentTime=times.length?Math.min(...times):null;
      const score=time=>Math.min(period.maxRp,Math.floor(period.maxRp*period.targetMs/time));
      const currentRp=currentTime?score(currentTime):0;
      if(currentRp>=period.maxRp)continue;
      const targetTime=period.targetMs;
      const gain=period.maxRp-currentRp;
      const minimumTime=Math.min(300000,Math.floor(period.maxRp*period.targetMs/(currentRp+1)));
      routes.push({period,trackId:period.trackId,targetTime,minimumTime,currentTime,localTime,currentRp,gain,rivalRp:Number.isSafeInteger(rival?.timeMs)&&rival.timeMs>0?score(rival.timeMs):null,savedAt:board.updatedAt||0});
    }
    return Object.assign(routes.sort((a,b)=>b.gain-a.gain||a.period.endsAt-b.period.endsAt).slice(0,6),{dataAvailable});
  }
  function eventPlannerMarkup(entry,self,isSelf,routes,availability){
    const rival=isSelf?'Your next event points':`Your event plan against <strong class="planner-rival-name">&quot;${escapeHtml(safeDisplayName(entry.name,entry.userId))}&quot;</strong>`;
    const maximum=Math.max(1,...routes.map(r=>r.gain));
    const card=r=>`<button type="button" class="profile-guide-track" data-planner-event="${escapeHtml(r.period.id)}" data-event-kind="${r.period.kind}" data-event-track="${escapeHtml(r.trackId)}"><span class="profile-guide-image">${trackThumbnailMarkup(r.trackId)}</span><span class="profile-guide-copy"><b>${r.currentTime?'Improve':'Try'} <strong>${escapeHtml(trackInfo(r.trackId).name)}</strong></b><small>Aim for ${formatRaceTime(r.targetTime)} · up to +${r.gain} Event RP</small><small>${r.currentTime?'Verified event PB: '+formatRaceTime(r.currentTime):'No verified event PB yet'}</small>${r.localTime&&(!r.currentTime||r.localTime<r.currentTime)?`<small>Local attempt: ${formatRaceTime(r.localTime)} · not included in points yet</small>`:''}<small>${formatRaceTime(r.minimumTime)} or faster earns more points${r.rivalRp===null?'':' · rival: '+r.rivalRp+' RP'}</small></span><span class="profile-helpfulness" title="Potential Event RP gain relative to the strongest shown event route. Not a success probability."><b>${routeBenefitPercent(r.gain,maximum)}%</b><small>ROUTE BENEFIT</small></span></button>`;
    return `<details class="profile-guide without-carry"><summary>${routes.slice(0,3).map(r=>`<span class="route-preview-item"><span class="route-preview-image">${trackThumbnailMarkup(r.trackId)}</span><span class="route-preview-copy"><b>${r.period.kind} event</b><strong>${escapeHtml(trackInfo(r.trackId).name)}</strong><small>Aim for ${formatRaceTime(r.targetTime)}</small><small>Up to +${r.gain} Event RP</small></span></span>`).join('')||(routes.dataAvailable?'<span>Maximum points reached in loaded events</span>':'<span>Not enough event data</span>')}<em class="route-open-label">Full plan</em></summary><div class="profile-guide-body"><header><div><label class="profile-guide-metric">Improve <select data-planner-metric aria-label="Leaderboard to improve">${Object.entries(PLANNER_METRICS).map(([k,v])=>`<option value="${k}" ${k==='events'?'selected':''} ${availability[k]?'':'disabled title="Not enough information at this time"'}>${v}${availability[k]?'':' (not enough data)'}</option>`).join('')}</select></label><h4>${rival}</h4></div></header><p>Uses saved event standings. Points require run verification. Repeated runs do not stack points.</p><div class="profile-guide-grid">${routes.map(card).join('')||(routes.dataAvailable?'<p>You have reached the points cap in these loaded events. Check the next event for more opportunities.</p>':'<p>Not enough information at this time. Open an active event leaderboard first.</p>')}</div></div></details>`;
  }

  function plannerCategoryAvailability(finishes,summaries){
    const known=(summaries||[]).filter(f=>Number(f.fieldSize)>=2&&Number(f.weight)>0);
    const eligible=(finishes||[]).filter(f=>Number(f.fieldSize)>=2&&Number(f.rank)>0&&Number(f.weight)>0);
    const podium=known.some(f=>Number(f.fieldSize)>=5&&trackInfo(f.trackId).type!=='custom');
    return {overall:eligible.length>0,skill:eligible.length>0,medals:podium,wins:podium,podiumRate:podium,weight:known.length>0};
  }
  function projectedOverallScore(finishes){
    const eligible=(finishes||[]).filter((finish)=>Number(finish.rank||0)>0&&Number(finish.fieldSize||0)>=2).map((finish)=>{
      const fieldSize=Math.max(2,Number(finish.fieldSize||0)||2);
      const rank=Math.max(1,Math.min(fieldSize,Number(finish.rank||1)||1));
      const weight=knownFinishWeight({...finish,rank,fieldSize})||rankedTrackWeight(finish.trackId,fieldSize);
      return {...finish,rank,fieldSize,weight,placementCost:rankedPlacementCost(rank,fieldSize)};
    });
    if(!eligible.length)return null;
    const byCost=eligible.slice().sort((a,b)=>a.placementCost-b.placementCost||b.weight-a.weight);
    const bestTen=byCost.slice(0,10);
    const bestWeight=bestTen.reduce((sum,finish)=>sum+finish.weight,0);
    const skillCost=bestTen.reduce((sum,finish)=>sum+finish.placementCost*finish.weight,0)/Math.max(.0001,bestWeight);
    if(plannerMetric==='skill')return skillCost;
    // Negate higher-is-better metrics so all route comparisons use the same cost convention.
    const podiums=eligible.filter(f=>f.fieldSize>=5&&trackInfo(f.trackId).type!=='custom');
    if(plannerMetric==='medals')return -podiums.reduce((sum,f)=>sum+(f.rank===1?9:f.rank===2?3:f.rank===3?1:0),0);
    if(plannerMetric==='wins')return -podiums.filter(f=>f.rank===1).length;
    if(plannerMetric==='podiumRate')return podiums.length>=3?-100*podiums.filter(f=>f.rank<=3).length/podiums.length:0;
    if(plannerMetric==='weight')return -eligible.reduce((sum,f)=>sum+f.weight,0);
    const allWeight=eligible.reduce((sum,finish)=>sum+finish.weight,0);
    const consistencyCeiling=Math.min(82,medianNumber(eligible.map((finish)=>finish.placementCost),50)+24);
    const depthCost=eligible.reduce((sum,finish)=>sum+Math.min(consistencyCeiling,Math.max(5,finish.placementCost))*finish.weight,0)/Math.max(.0001,allWeight);
    const coverageCost=100*Math.exp(-eligible.length/10);
    return Math.max(1.000001,.68*skillCost+.20*coverageCost+.12*depthCost);
  }
  function projectedFinish(finish,rank,fieldSize){
    const base=rankedTrackWeightParts(finish.trackId,finish.fieldSize,1,1).baseWeight;
    const competition=Number(finish.competition)>0?Number(finish.competition):base>0&&Number(finish.weight)>0?Number(finish.weight)/base:1;
    const weight=rankedTrackWeightParts(finish.trackId,fieldSize,competition,1).finalWeight;
    return {...finish,rank:Math.max(1,Math.min(fieldSize,rank)),fieldSize,weight,competition,depthBoost:1};
  }
  function simulateRecommendation(finishes,finish,rank){
    const baseline=(finishes||[]).filter((row)=>row?.trackId&&Number(row.rank||0)>0&&Number(row.fieldSize||0)>=2);
    const existing=baseline.find((row)=>row.trackId===finish.trackId);
    const fieldSize=Math.max(2,Number(finish.fieldSize||0)+(existing?0:1)||2);
    const projected=projectedFinish(finish,rank,fieldSize);
    return projectedOverallScore([...baseline.filter((row)=>row.trackId!==finish.trackId),projected]);
  }
  function rivalRecommendationAction(yours,theirs,selfEntry,targetEntry,selfFinishes,targetFinishes){
    if(!theirs?.trackId||Number(theirs.rank||0)<1||Number(theirs.fieldSize||0)<2)return null;
    const yourRank=Math.max(0,Number(yours?.rank||0)||0);
    const theirRank=Math.max(1,Number(theirs.rank||1)||1);
    if(yourRank&&yourRank<=theirRank)return null;
    const selfBaseline=(selfFinishes||[]).filter((row)=>row?.trackId&&Number(row.rank||0)>0&&Number(row.fieldSize||0)>=2);
    const targetBaseline=(targetFinishes||[]).filter((row)=>row?.trackId&&Number(row.rank||0)>0&&Number(row.fieldSize||0)>=2);
    if(selfBaseline.length<Number(selfEntry?.raceCount||0)||targetBaseline.length<Number(targetEntry?.raceCount||0))return null;
    const selfBefore=projectedOverallScore(selfBaseline);
    const targetBefore=projectedOverallScore(targetBaseline);
    const selfField=Math.max(2,Number(theirs.fieldSize||0)||2);
    const base=recommendationAction({...theirs,...yours,trackId:theirs.trackId,rank:yourRank,fieldSize:selfField},'rival',selfEntry,selfBaseline);
    if(!base)return null;
    const desiredRank=Math.max(1,Math.min(selfField,theirRank,base.minimumHelpfulRank||base.targetRank));
    const selfAfter=simulateRecommendation(selfBaseline,{...theirs,...yours,trackId:theirs.trackId,rank:yourRank,fieldSize:selfField},desiredRank);
    const targetField=Math.max(2,Number(theirs.fieldSize||0)+(yourRank?0:1));
    const shiftedTarget=projectedFinish(theirs,Math.min(targetField,theirRank+1),targetField);
    const targetAfter=projectedOverallScore([...targetBaseline.filter((row)=>row.trackId!==theirs.trackId),shiftedTarget]);
    const yourGain=selfBefore===null||selfAfter===null?0:selfBefore-selfAfter;
    const rivalLoss=targetBefore===null||targetAfter===null?0:targetAfter-targetBefore;
    if(yourGain<0||yourGain+rivalLoss<=.0005)return null;
    return {...base,targetRank:desiredRank,minimumHelpfulRank:Math.min(theirRank,base.minimumHelpfulRank),value:yourGain+rivalLoss,estimatedGain:yourGain,rivalEstimatedLoss:rivalLoss,rivalRank:theirRank,rivalName:safeDisplayName(targetEntry?.name,targetEntry?.userId),rivalDirection:Number(targetEntry?.rank||Infinity)<Number(selfEntry?.rank||Infinity)?'catch':'pressure',simulationComplete:base.simulationComplete&&targetBaseline.length>=Math.max(0,Number(targetEntry?.raceCount||0)||0)};
  }
  function matchupPersonalAction(action,viewedFinishes){
    const theirs=viewedFinishes.find(row=>row.trackId===action.trackId);
    if(!theirs)return action;
    const before=projectedOverallScore(viewedFinishes);
    const field=Number(theirs.fieldSize)+(action.currentRank?0:1);
    const passes=action.targetRank<=Number(theirs.rank)&&(!action.currentRank||action.currentRank>Number(theirs.rank));
    const changed=projectedFinish(theirs,Number(theirs.rank)+(passes?1:0),field);
    const after=projectedOverallScore(viewedFinishes.map(row=>row.trackId===action.trackId?changed:row));
    if(before===null||after===null)return null;
    const margin=Number(action.estimatedGain)+(after-before);
    return margin>.0005?{...action,value:margin,rivalEstimatedLoss:after-before}:null;
  }
  function maximumKnownTrackWeight(){
    let maximum=0;
    for(const entry of overallEntriesCache)for(const finish of normalizedFinishSamples(entry))maximum=Math.max(maximum,knownFinishWeight(finish)||0);
    for(const [trackId,snapshot] of Object.entries(trackSnapshotStore()))maximum=Math.max(maximum,cachedTrackWeight(trackId,snapshot));
    return Math.max(.01,maximum);
  }
  function recommendationSimulator(finishes,finish){
    const baseline=(finishes||[]).filter(row=>row?.trackId&&Number(row.rank)>0&&Number(row.fieldSize)>=2);
    const field=Math.max(2,Number(finish.fieldSize||0)+(baseline.some(row=>row.trackId===finish.trackId)?0:1));
    const projected=projectedFinish(finish,1,field);
    const weight=knownFinishWeight(projected)||rankedTrackWeight(finish.trackId,field);
    const others=baseline.filter(row=>row.trackId!==finish.trackId).map(row=>{
      const n=Math.max(2,Number(row.fieldSize));const rank=Math.max(1,Math.min(n,Number(row.rank)));
      return {weight:knownFinishWeight({...row,rank,fieldSize:n})||rankedTrackWeight(row.trackId,n),cost:rankedPlacementCost(rank,n),rank,fieldSize:n,eligible:n>=5&&trackInfo(row.trackId).type!=='custom'};
    }).sort((a,b)=>a.cost-b.cost||b.weight-a.weight);
    const fixedWeight=others.reduce((sum,row)=>sum+row.weight,0);
    const podiums=others.filter(row=>row.eligible);
    const eligible=field>=5&&trackInfo(finish.trackId).type!=='custom';
    return rank=>{
      rank=Math.max(1,Math.min(field,rank));
      if(plannerMetric==='weight')return -(fixedWeight+weight);
      if(plannerMetric==='medals')return -(podiums.reduce((sum,row)=>sum+(row.rank===1?9:row.rank===2?3:row.rank===3?1:0),0)+(eligible?(rank===1?9:rank===2?3:rank===3?1:0):0));
      if(plannerMetric==='wins')return -(podiums.filter(row=>row.rank===1).length+(eligible&&rank===1?1:0));
      if(plannerMetric==='podiumRate'){const count=podiums.length+Number(eligible);return count>=3?-100*(podiums.filter(row=>row.rank<=3).length+(eligible&&rank<=3?1:0))/count:0;}
      const candidate={cost:rankedPlacementCost(rank,field),weight};
      const rows=others.slice();let at=0;while(at<rows.length&&(rows[at].cost<candidate.cost||rows[at].cost===candidate.cost&&rows[at].weight>=weight))at++;rows.splice(at,0,candidate);
      let skillWeight=0,skillSum=0;for(let i=0;i<Math.min(10,rows.length);i++){skillWeight+=rows[i].weight;skillSum+=rows[i].cost*rows[i].weight;}
      const skill=skillSum/Math.max(.0001,skillWeight);if(plannerMetric==='skill')return skill;
      const mid=Math.floor(rows.length/2);const median=rows.length%2?rows[mid].cost:(rows[mid-1].cost+rows[mid].cost)/2;
      const ceiling=Math.min(82,median+24);
      const depth=rows.reduce((sum,row)=>sum+Math.min(ceiling,Math.max(5,row.cost))*row.weight,0)/Math.max(.0001,fixedWeight+weight);
      return Math.max(1.000001,.68*skill+.20*100*Math.exp(-rows.length/10)+.12*depth);
    };
  }
  function recommendationAction(finish,kind='improve',entry=null,knownFinishes=[]){
    if(!finish?.trackId)return null;
    const current=Math.max(0,Number(finish.rank||0)||0);
    const field=Math.max(2,Number(finish.fieldSize||0)+(current?0:1)||2);
    const baseline=(knownFinishes||[]).filter((row)=>row?.trackId&&Number(row.rank||0)>0&&Number(row.fieldSize||0)>=2);
    const baselineScore=projectedOverallScore(baseline);
    const fullCoverage=baseline.length>=Math.max(0,Number(entry?.raceCount||0)||0);
    if(kind!=='carry'&&!fullCoverage)return null;
    const scoreAt=typeof recommendationSimulator==='function'?recommendationSimulator(baseline,finish):rank=>simulateRecommendation(baseline,finish,rank);
    const choices=[];
    for(let rank=1;rank<=field;rank++){
      if(current&&rank>=current)continue;
      const score=scoreAt(rank);
      const gain=baselineScore===null||score===null?0:baselineScore-score;
      choices.push({rank,score,gain,helpful:gain>.0005||(kind==='rival'&&baselineScore!==null&&score!==null&&gain>=0)});
    }
    const helpful=choices.filter(row=>row.helpful);
    if(kind!=='carry'&&!helpful.length)return null;
    let helpfulMinimum=0;
    for(const row of choices){if(!row.helpful)break;helpfulMinimum=row.rank;}
    const topGuaranteed=helpfulMinimum>0;
    const best=helpful.slice().sort((a,b)=>b.gain-a.gain||b.rank-a.rank)[0];
    const target=kind==='carry'?current:typeof plannerSort!=='undefined'&&plannerSort==='ease'&&current>1&&kind!=='rival'?helpful[helpful.length-1].rank:best.rank;
    if(!helpfulMinimum)helpfulMinimum=target;
    const weight=knownFinishWeight(projectedFinish(finish,target,field))||rankedTrackWeight(finish.trackId,field);
    const targetScore=scoreAt(target);
    const simulatedGain=baselineScore===null||targetScore===null?0:Math.max(0,baselineScore-targetScore);
    const carryValue=kind==='carry'?Math.max(.001,Number(finish.contribution||0)||weight*(100-rankedPlacementCost(current||field,field))):0;
    const estimatedGain=kind==='carry'?carryValue:simulatedGain;
    return {...finish,currentFieldSize:Number(finish.fieldSize||0),fieldSize:field,currentRank:current,targetRank:target,minimumHelpfulRank:helpfulMinimum,topGuaranteed,weight,value:estimatedGain,estimatedGain,kind,playedBefore:current>0,simulationComplete:fullCoverage,baselineScore,targetScore};
  }
  function helpfulThresholdText(action){
    const minimum=Math.max(1,Number(action?.minimumHelpfulRank||1)||1);
    const current=Math.max(0,Number(action?.currentRank||0)||0);
    if(current===1)return 'Keep #1';
    if(action?.kind==='rival')return `Aim for #${action.targetRank} to improve this matchup`;
    if(current>1)return `Aim for #${action.targetRank}${action.topGuaranteed&&minimum>action.targetRank?`; #${minimum} also helps`:''}`;
    const field=Math.max(minimum,Number(action?.fieldSize||minimum)||minimum);
    if(action?.topGuaranteed===false)return `Aim for #${action.targetRank}`;
    if(minimum>=field)return 'Any finish helps in these standings';
    return minimum===1?'Reach #1':`Top ${minimum} helps in these standings`;
  }
  function routeBenefitPercent(value,maximum){
    if(!Number.isFinite(value)||!Number.isFinite(maximum)||value<=0||maximum<=0)return 0;
    return Math.max(1,Math.min(100,Math.round(100*value/maximum)));
  }
  function worthwhileStart(action,maximumWeight){
    return Number(action?.weight)>=Math.max(.25,Number(maximumWeight||0)*.2);
  }
  function guideTrackCard(action,maxValue,verb='Try'){
    if(!action?.trackId)return '';
    const info=trackInfo(action.trackId);

    const percent=routeBenefitPercent(Number(action.value||0),maxValue);
    const metricLabel=action.kind==='carry'?'STRENGTH':'ROUTE BENEFIT';
    const current=action.currentRank?`Current #${action.currentRank} of ${action.currentFieldSize||action.fieldSize}`:'New track · no result';
    const rivalTarget=Number(action.rivalRank||0)>0?`Pass ${action.rivalName||'rival'} at #${action.rivalRank} · `:'';
    const target=action.currentRank===1?'Keep #1':`${rivalTarget}${helpfulThresholdText(action)}`;
    const freshness=action.cachedAt?ageLabel(action.cachedAt):'snapshot estimate';
    const weightTitle=rankedWeightTitle(action.trackId,action.fieldSize,false,action);
    const metricTitle='Projected benefit relative to the strongest shown route (100%). Not a success probability. Uses the selected leaderboard and loaded standings.';
    return `<button type="button" class="profile-guide-track kind-${escapeHtml(action.kind||'route')}" data-track-id="${escapeHtml(action.trackId)}" aria-label="Open ${escapeHtml(info.name)}. ${escapeHtml(current)}. ${escapeHtml(target)}. ${percent}% relative ${metricLabel.toLowerCase()}." title="Open ${escapeHtml(info.name)}"><span class="profile-guide-image">${trackThumbnailMarkup(action.trackId)}</span><span class="profile-guide-copy"><b>${escapeHtml(verb)} <strong>${escapeHtml(info.name)}</strong></b><small class="guide-placement">${escapeHtml(current)} · ${escapeHtml(target)}</small>${action.ease?.gapMs>=5?`<small class="guide-ease">Time to gain: ${(action.ease.gapMs/1000).toFixed(2)}s</small>`:''}<small><span class="guide-weight" title="${escapeHtml(weightTitle)}">${action.weight.toFixed(2)}x</span> weight · ${escapeHtml(freshness)}</small></span><span class="profile-helpfulness" title="${escapeHtml(metricTitle)}"><b>${percent}%</b><small>${metricLabel}</small><i class="route-benefit-bar" style="--benefit:${percent}%" aria-hidden="true"></i></span></button>`;
  }
  function plannerEase(action,snapshot,accountId){
    if(!action?.currentRank||!Array.isArray(snapshot?.entries))return null;
    const observedAt=Math.max(Number(snapshot.serverUpdatedAt||0),Number(snapshot.checkedAt||0),Number(snapshot.fetchedAt||0));
    if(Number(action.cachedAt||0)>observedAt)return null;
    const rows=snapshot.entries;
    const own=rows.find(row=>String(row.accountId||row.userId||'')===String(accountId));
    const current=Number(own?.timeMs);
    const target=rows.filter(row=>String(row.accountId||row.userId||'')!==String(accountId)).sort((a,b)=>Number(a.timeMs)-Number(b.timeMs))[Math.max(0,Number(action.targetRank)-1)];
    const targetTime=Number(target?.timeMs);
    if(!Number.isFinite(current)||!Number.isFinite(targetTime)||current<=0||targetTime<=0||targetTime>=current)return null;
    const field=rows.map(row=>Number(row.timeMs)).filter(n=>Number.isFinite(n)&&n>0).sort((a,b)=>a-b);
    const gaps=field.slice(1).map((time,i)=>time-field[i]).sort((a,b)=>a-b);
    const middle=Math.floor(gaps.length/2);
    const spacing=field.length>=3?(gaps.length%2?gaps[middle]:(gaps[middle-1]+gaps[middle])/2):null;
    const relativeGap=(current-targetTime)/current;
    // Estimate only: close targets and a less tightly packed field are favored.
    const effortScore=spacing===null?null:relativeGap/Math.max(.005,spacing/current);
    return {gapMs:current-targetTime,relativeGap,targetTime,fieldSpacingMs:spacing,effortScore};
  }
  function orderedPlannerRoutes(rival,personal,limit=6,sort='impact'){
    const compare=(a,b)=>{
      if(sort==='ease'){
        const left=a.ease?(a.ease.effortScore??a.ease.relativeGap/.005):undefined,right=b.ease?(b.ease.effortScore??b.ease.relativeGap/.005):undefined;
        const hasLeft=Number.isFinite(left),hasRight=Number.isFinite(right);
        if(hasLeft!==hasRight)return hasLeft?-1:1;
        if(hasLeft&&left!==right)return left-right;
      }
      return Number(b.value||0)-Number(a.value||0)||Number(b.weight||0)-Number(a.weight||0);
    };
    const unique=new Map();
    for(const action of [...rival,...personal])if(action?.trackId){
      const prior=unique.get(action.trackId);
      if(!prior||compare(action,prior)<0)unique.set(action.trackId,action);
    }
    return [...unique.values()].sort(compare).slice(0,limit);
  }
  function plannerDefenseAllowed(finishes,entry,summaries){
    if(!Array.isArray(summaries)||!summaries.length||finishes.length<Number(entry?.raceCount||0))return false;
    const important=summaries.filter(row=>Number(row.fieldSize)>=2&&Number(row.weight)>0);
    const mine=new Map(finishes.map(row=>[row.trackId,row]));
    return important.length>0&&important.every(row=>Number(mine.get(row.trackId)?.rank)===1);
  }
  const profileGuideCache=new Map();
  async function cachedProfileGuideMarkup(entry,self,isSelf,cachedFinishes,snapshotFinishes,selfFinishes,stillCurrent){
    const trackVersions=Object.entries(trackSnapshotStore()).map(([id,s])=>[id,s.revision,s.sourceRevision,s.serverUpdatedAt,s.checkedAt]);
    const key=JSON.stringify([plannerMetric,plannerSort,isSelf,entry,self,snapshotFinishes,selfFinishes,overallLoadState.revision,overallTrackSummariesCache,trackVersions]);
    const prior=profileGuideCache.get(key);
    if(prior&&Date.now()-prior.at<30000)return prior.markup;
    const markup=await profileGuideMarkup(entry,self,isSelf,cachedFinishes,snapshotFinishes,selfFinishes,stillCurrent);
    if(markup&&stillCurrent()){profileGuideCache.set(key,{at:Date.now(),markup});if(profileGuideCache.size>8)profileGuideCache.delete(profileGuideCache.keys().next().value);}
    return markup;
  }
  async function profileGuideMarkup(entry,self,isSelf,cachedFinishes,snapshotFinishes,selfFinishes,stillCurrent=()=>true){
    let lastYield=Date.now();const yieldUi=async()=>{if(Date.now()-lastYield>=8){await new Promise(resolve=>setTimeout(resolve,0));lastYield=Date.now();}return stillCurrent();};
    if(!isSelf&&!self)return '<p class="profile-guide-empty">Set a Ranked result to build your plan against this racer.</p>';
    const plannerEntry=isSelf?entry:self;
    const eventRoutes=eventPlannerRoutes(plannerEntry.userId||plannerEntry.accountId,isSelf?null:entry.userId||entry.accountId);
    if(plannerMetric==='events')return eventPlannerMarkup(entry,self,isSelf,eventRoutes,{...plannerCategoryAvailability(isSelf?snapshotFinishes:selfFinishes,overallTrackSummariesCache),events:eventRoutes.dataAvailable===true});
    const plannerFinishes=isSelf?snapshotFinishes:selfFinishes;
    const knownResults=new Map();
    for(const finish of (plannerFinishes||[]))if(finish?.trackId&&Number(finish.rank||0)>0)knownResults.set(finish.trackId,{...(knownResults.get(finish.trackId)||{}),...finish});
    const completed=new Set(knownResults.keys());
    const simulationFinishes=Array.from(knownResults.values());
    const rankedRoute=(action)=>Boolean(action&&TRACK_CATALOG.has(String(action.trackId||''))&&Number(action.weight||0)>0&&Number(action.value||0)>.0005);
    const improve=[];
    for(const finish of simulationFinishes){if(!(await yieldUi()))return '';if(Number(finish.rank)>1&&Number(finish.fieldSize)>=2){const action=recommendationAction(finish,'improve',plannerEntry,simulationFinishes);if(rankedRoute(action))improve.push(action);}}
    const store=trackSnapshotStore();
    const starts=[];
    for(const track of TRACK_CATALOG.values()){
      if(!(await yieldUi()))return '';
      if(completed.has(track.id))continue;
      const snapshot=store[track.id];const summary=overallTrackSummariesCache.find(row=>row.trackId===track.id);
      const useSnapshot=Array.isArray(snapshot?.entries)&&(!summary||Number(snapshot.serverUpdatedAt||0)>=Number(summary.updatedAt||overallLoadState.serverUpdatedAt||0));
      const field=Math.max(0,Number(useSnapshot?snapshot.entries.length:summary?.fieldSize||0)||0);
      if(field<2)continue;
      const action=recommendationAction({trackId:track.id,rank:0,fieldSize:field,weight:useSnapshot?cachedTrackWeight(track.id,snapshot):Number(summary?.weight||0),cachedAt:Number(useSnapshot?snapshot.serverUpdatedAt||snapshot.fetchedAt:summary?.updatedAt||overallLoadState.serverUpdatedAt)||0},'start',plannerEntry,simulationFinishes);
      if(rankedRoute(action))starts.push(action);
    }
    const rivalMode=!isSelf&&self;
    const viewedMap=new Map(snapshotFinishes.filter((finish)=>finish?.trackId).map((finish)=>[finish.trackId,finish]));
    const selfMap=new Map(selfFinishes.filter((finish)=>finish?.trackId).map((finish)=>[finish.trackId,finish]));
    const rival=[];
    if(rivalMode){
      for(const trackId of new Set([...viewedMap.keys(),...selfMap.keys()])){
        if(!(await yieldUi()))return '';
        const theirs=viewedMap.get(trackId); const yours=selfMap.get(trackId);
        const action=rivalRecommendationAction(yours,theirs,self,entry,simulationFinishes,snapshotFinishes);
        if(rankedRoute(action))rival.push(action);
      }
    }
    rival.sort((a,b)=>b.value-a.value||b.weight-a.weight);
    // Keep thin fields out of the main plan when better-supported routes exist.
    const maximumWeight=maximumKnownTrackWeight();
    const personal=[...improve,...starts.filter(action=>worthwhileStart(action,maximumWeight))].filter(rankedRoute).sort((a,b)=>b.value-a.value||b.weight-a.weight);
    const matchupPersonal=rivalMode?personal.map(action=>matchupPersonalAction(action,snapshotFinishes)).filter(Boolean):personal;
    const addEase=action=>({...action,ease:plannerEase(action,store[action.trackId],plannerEntry.userId||plannerEntry.accountId)});
    const priority=orderedPlannerRoutes((rivalMode?rival:[]).map(addEase),matchupPersonal.map(addEase),6,plannerSort);
    const allowDefense=plannerMetric==='overall'&&priority.length===0&&plannerDefenseAllowed(simulationFinishes,plannerEntry,overallTrackSummariesCache);
    const priorityIds=new Set(priority.map((action)=>action.trackId));
    const allCarrying=(allowDefense?(plannerFinishes||[]):[]).filter((finish)=>Number(finish.fieldSize||0)>=2).sort((a,b)=>Number(b.contribution||0)-Number(a.contribution||0)).map((finish)=>recommendationAction(finish,'carry',plannerEntry,simulationFinishes)).filter(Boolean);
    const carrying=allCarrying.filter((action)=>!priorityIds.has(action.trackId)).slice(0,3);
    const strongest=allCarrying[0]||null;
    const racerName=escapeHtml(safeDisplayName(entry.name,entry.userId));
    const context=isSelf?`Your next moves`:`Your plan against <strong class="planner-rival-name">&quot;${racerName}&quot;</strong>`;
    const actionVerb=(action)=>action.kind==='start'?'Start':action.kind==='rival'?'Pass them on':action.kind==='carry'?'Protect':'Improve';
    const cards=(rows)=>{const values=rows.filter(Boolean);return values.length?values.map((action)=>guideTrackCard(action,Math.max(...values.map(row=>Number(row.value||0))),actionVerb(action))).join(''):`<p class="profile-guide-empty">${simulationFinishes.filter(f=>Number(f.rank)>0&&Number(f.fieldSize)>=2).length<Number(plannerEntry?.raceCount||0)?'Complete scoring data is not available yet. Refresh Ranked after the next server update.':'No scoring improvement found in these standings. Try another category or refresh the data.'}</p>`;};
    const previewRoutes=(priority.length?priority:carrying).slice(0,3);
    const previewMarkup=previewRoutes.map((action,index)=>`<span class="route-preview-item" data-summary-track-id="${escapeHtml(action.trackId)}"><span class="route-preview-image">${trackThumbnailMarkup(action.trackId)}</span><span class="route-preview-copy"><b>${index===0?'Best next move':'Also try'}</b><strong>${escapeHtml(trackInfo(action.trackId).name)}</strong><small>${action.currentRank?`#${action.currentRank} → #${action.targetRank}`:`New track · aim for #${action.targetRank}`}</small><small class="guide-weight">${action.weight.toFixed(2)}x weight</small></span></span>`).join('');
    const availability={...plannerCategoryAvailability(simulationFinishes,overallTrackSummariesCache),events:eventRoutes.dataAvailable===true};
    const coverageNote=simulationFinishes.length>=Math.max(0,Number(plannerEntry?.raceCount||0)||0)&&(!rivalMode||snapshotFinishes.length>=Math.max(0,Number(entry?.raceCount||0)||0))?'Results loaded':'More results needed';
    return `<details class="profile-guide ${strongest?'':'without-carry'}"><summary aria-label="Open detailed route planner">${previewMarkup||'<span><strong>No helpful move found</strong><small>Refresh Ranked or choose another category.</small></span>'}<em class="route-open-label" aria-hidden="true">Full plan</em></summary><div class="profile-guide-body"><header><div><span class="profile-kicker">YOUR PLAN</span><label class="profile-guide-metric">Improve <select data-planner-metric aria-label="Leaderboard to improve">${Object.entries(PLANNER_METRICS).map(([key,label])=>`<option value="${key}" ${plannerMetric===key?'selected':''} ${availability[key]?'':'disabled title="Not enough information at this time"'}>${label}${availability[key]?'':' (not enough data)'}</option>`).join('')}</select></label><label class="profile-guide-metric">Sort by <select data-planner-sort aria-label="Route order"><option value="impact" ${plannerSort==='impact'?'selected':''}>Biggest benefit</option><option value="ease" ${plannerSort==='ease'?'selected':''}>Ease (estimated)</option></select></label><h4>${context}</h4></div><small>${coverageNote} · ${escapeHtml(overallLoadState.serverUpdatedAt?`snapshot changed ${ageLabel(overallLoadState.serverUpdatedAt)}`:'saved profile data')}</small></header><section class="profile-route-priorities"><p class="route-benefit-key" title="100% is the strongest shown route, not a success probability. Estimated ease compares time to gain and typical field spacing, with unknown times last.">Benefit compares these routes. Ease considers time gaps and field spacing.</p>${plannerMetric==='weight'?'<p>Complete new tracks to add weight.</p>':''}<div class="profile-guide-grid">${cards(priority)}</div></section>${carrying.length?`<section class="profile-route-strengths"><h5>Your other strong contributions</h5><p>Track Strength compares each contribution with your highest-weight loaded track.</p><div class="profile-guide-grid compact">${cards(carrying)}</div></section>`:''}</div></details>`;
  }
  function openRankedProfile(userId){
    const profileContent=document.querySelector('#overallProfileContent');if(profileContent)profileContent.dataset.accountId=cleanUserId(userId);
    const entry=overallEntriesCache.find((row)=>cleanUserId(row.userId||row.accountId||'')===cleanUserId(userId));
    const popup=document.getElementById('overallProfilePopup');
    const content=document.getElementById('overallProfileContent');
    if(!entry&&popup&&content&&overallCategory==='events'){
      content.innerHTML='<div class="overall-empty"><strong>Ranked profile unavailable</strong><span>This racer has Event RP, but no Overall profile is available in the saved Ranked snapshot. No Overall score or track results are inferred.</span></div>';
      openRankedDialog(popup);return;
    }
    if(!entry||!popup||!content)return;
    const profileCard=content.closest('.overall-profile-card');
    const profileScroll=isElementVisible(popup)&&popup.dataset.profileUser===cleanUserId(userId)?profileCard.scrollTop:0;
    const self=overallEntriesCache.find((row)=>cleanUserId(row.userId||row.accountId||'')===activeRankedAccountId());
    const medals=entry.medals||{};
    const gap=self&&entry.userId!==self.userId?Number(self.score||0)-Number(entry.score||0):0;
    const isSelf=cleanUserId(entry.userId)===cleanUserId(self?.userId);
    const cachedFinishes=cachedProfileFinishes(entry.userId,entry);
    const snapshotAt=Number(overallLoadState.serverUpdatedAt||overallLoadState.fetchedAt||0)||0;
    const detailByTrack=new Map(normalizedFinishSamples(entry).map((finish)=>[finish.trackId,finish]));
    for(const finish of cachedFinishes){
      const current=detailByTrack.get(finish.trackId);
      if(!current||Number(finish.cachedAt||0)>=snapshotAt)detailByTrack.set(finish.trackId,{...current,...finish});
    }
    const snapshotFinishes=Array.from(detailByTrack.values());
    const rankedDetails=snapshotFinishes.filter((finish)=>Number(finish.rank||0)>0&&Number(finish.fieldSize||0)>=2);
    const best=rankedDetails.slice().sort((a,b)=>Number(a.rank)-Number(b.rank)||Number(b.fieldSize)-Number(a.fieldSize)||(knownFinishWeight(b)||0)-(knownFinishWeight(a)||0))[0]||null;
    const weightedResults=rankedDetails.slice().map((finish)=>({...finish,contribution:Number(finish.contribution||0)||Math.max(0,(100-rankedPlacementCost(finish.rank,finish.fieldSize))*(knownFinishWeight(finish)||0))})).sort((a,b)=>Number(b.contribution)-Number(a.contribution)||Number(b.fieldSize)-Number(a.fieldSize));
    const opportunities=profileOpportunityCandidates(entry,cachedFinishes,isSelf);
    const selfDetailByTrack=new Map((self?normalizedFinishSamples(self):[]).filter((finish)=>finish?.trackId).map((finish)=>[finish.trackId,finish]));
    if(self){
      for(const finish of cachedProfileFinishes(self.userId,self)){
        const current=selfDetailByTrack.get(finish.trackId);
        if(!current||Number(finish.cachedAt||0)>=snapshotAt)selfDetailByTrack.set(finish.trackId,{...current,...finish});
      }
    }
    const selfSnapshotFinishes=Array.from(selfDetailByTrack.values());
    const comparisonFor=(finish)=>profileTrackComparison(finish,snapshotFinishes,selfSnapshotFinishes,isSelf);
    const targetTitle=isSelf?(Number(entry.rank)===1?'Hold first place':Number(entry.rank)===overallEntriesCache.length?'Start climbing':'Climb the board'):Number(entry.rank)<Number(self?.rank||Infinity)?`Overtake #${entry.rank}`:`Protect your lead over #${entry.rank}`;
    const carStyle=__pt062NormalizeStyle(entry.carStyle||__pt062GetRememberedStyle(entry.userId)||'');
    const trackRows=cachedFinishes.length?cachedFinishes.map((finish)=>{
      const info=trackInfo(finish.trackId);
      const hasPlacement=Number(finish.rank||0)>0&&Number(finish.fieldSize||0)>=Number(finish.rank);
      const kind=hasPlacement?medalForRank(finish.rank,finish.fieldSize,finish.trackId):'';
      const place=hasPlacement?`#${Number(finish.rank)} of ${Math.max(Number(finish.rank),Number(finish.fieldSize||0))}`:'Result not loaded';
      const age=finish.cachedAt?ageLabel(finish.cachedAt):finish.local?'local PB':'saved snapshot';
      const weight=hasPlacement?knownFinishWeight(finish):null;
      const parts=hasPlacement?finishWeightParts(finish):null;
      const impact=weight===null?null:weight===0?0:Number(finish.contribution||0)||Math.max(0,(100-rankedPlacementCost(finish.rank,finish.fieldSize))*weight);
      const typeText=info.type==='official'?'Official · 1.6x type':info.type==='community'?'Community · 1.0x type':'Custom · 0.6x type';
      const weightTitle=hasPlacement?rankedWeightTitle(finish.trackId,finish.fieldSize,false,finish):'Load this track leaderboard to calculate field weight.';
      return `<button class="profile-track-row track-type-${escapeHtml(info.type)} ${hasPlacement?'':'is-null'}" type="button" data-track-id="${escapeHtml(finish.trackId)}" aria-label="Open ${escapeHtml(info.name)}. ${place}. ${weight===null?'Weight not loaded':`Final weight ${weight.toFixed(2)}`}."><span class="profile-track-visual">${trackThumbnailMarkup(finish.trackId)}</span><span class="profile-track-name"><b>${escapeHtml(info.name)}</b><small class="track-type-label ${escapeHtml(info.type)}">${typeText}${hasPlacement?` · ${finish.fieldSize} racers`:''}</small><small>${impact===null?'Contribution not loaded':`${impact.toFixed(1)} contribution index`}</small></span><span class="profile-track-weight" title="${escapeHtml(weightTitle)}"><b>${weight===null?'N/A':`${weight.toFixed(2)}x`}</b><small>${parts?`${parts.baseWeight.toFixed(2)}x base field`:'Weight not loaded'}</small><small>${escapeHtml(finish.cachedAt?'Changed '+age:finish.local?'Local PB':'Saved snapshot')}</small></span><span class="profile-track-result ${kind||''}">${kind?`<img src="${medalIcon(kind)}" alt="${kind} medal">`:''}<b>${place}</b><small>${hasPlacement?`${finish.fieldSize} drivers`:'Open leaderboard to load'}</small></span><time>${finish.timeMs?`${formatRaceTime(finish.timeMs)}${pbTimestamp(finish)?`<small>PB ${escapeHtml(formatLocalPbDate(finish))}</small>`:''}`:'Time not loaded'}</time></button>`;
    }).join(''):'<div class="profile-track-empty"><strong>Track times are not loaded on this device</strong><span>The complete snapshot statistics above are still available. Open track leaderboards to add exact times and full result rows without bulk-reading every track.</span></div>';
    const rankIndex=overallEntriesCache.findIndex((row)=>cleanUserId(row.userId)===cleanUserId(entry.userId));
    const above=rankIndex>0?overallEntriesCache[rankIndex-1]:null;
    const below=rankIndex>=0&&rankIndex<overallEntriesCache.length-1?overallEntriesCache[rankIndex+1]:null;
    const rankTooltip=[above?`Above: #${above.rank} ${safeDisplayName(above.name,above.userId)}`:'No racer above',`This racer: #${entry.rank} ${safeDisplayName(entry.name,entry.userId)}`,below?`Below: #${below.rank} ${safeDisplayName(below.name,below.userId)}`:'No racer below'].join(' | ');
    const loadedNames=cachedFinishes.map((finish)=>trackInfo(finish.trackId).name).slice(0,20);
    const tracksTooltip=loadedNames.length?`Loaded: ${loadedNames.join(', ')}${cachedFinishes.length>20?' and more':''}`:'No track details loaded';
    const localCreated=isSelf?readLocalRaceRows().filter((row)=>cleanUserId(row.accountId||row.userId)===cleanUserId(entry.userId)).reduce((old,row)=>Number(row.createdAt||0)>0?Math.min(old||Infinity,Number(row.createdAt)):old,0):0;
    const accountCreatedAt=Number(entry.accountCreatedAt||0)||localCreated||0;
    const accountSince=accountCreatedAt?new Date(accountCreatedAt).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'}):'Unknown';
    const scoreDelta=Number(entry.scoreDelta||0)||0;
    const scoreChange=scoreDelta<0?`Improved ${formatRp(Math.abs(scoreDelta))} RP`:scoreDelta>0?`Lost ${formatRp(scoreDelta)} RP`:'No saved RP change';
    const participation=`${Number(entry.officialCount||0)} official${Number(entry.communityCount||0)?` · ${Number(entry.communityCount)} community`:''}${Number(entry.customCount||0)?` · ${Number(entry.customCount)} custom`:''}`;
    const uid=escapeHtml(entry.userId);
    const achievements=profileAchievementMarkup(medals);
    const currentRankSince=Math.max(0,Number(entry.rankSince||entry.movementAt||0)||0);
    const currentRankAge=currentRankSince?durationLabel(Date.now()-currentRankSince):'Pending';
    const racingAge=accountCreatedAt?durationLabel(Date.now()-accountCreatedAt):'Not available';
    const allSummaryFinishes=snapshotFinishes;
    const bestPlace=allSummaryFinishes.filter((finish)=>Number(finish.rank||0)>0).sort((a,b)=>a.rank-b.rank||b.fieldSize-a.fieldSize)[0]||null;
    const largestField=allSummaryFinishes.reduce((largest,finish)=>Math.max(largest,Number(finish.fieldSize||0)||0),0);
    const averageFinish=Number(entry.averageFinish||0)>0?Number(entry.averageFinish).toFixed(2):'Not available';
    const podiumRate=Number(entry.podiumRate||0)>0?`${Number(entry.podiumRate).toFixed(1)}%`:'No eligible podiums';
    const pbCount=Number(entry.pbCount||0)>0?String(Number(entry.pbCount)):'Not available';
    const guideWasOpen=isElementVisible(popup)&&popup.dataset.profileUser===cleanUserId(userId)&&content.querySelector('.profile-guide')?.open===true;
    const guideHadFocus=content.querySelector('[data-planner-metric]')===document.activeElement?'[data-planner-metric]':content.querySelector('[data-planner-sort]')===document.activeElement?'[data-planner-sort]':null;
    const guideToken={};content.__guideToken=guideToken;
    const metricAtStart=plannerMetric;
    const sortAtStart=plannerSort;
    const guideMarkup='<div class="profile-guide-pending" role="status">Finding your next improvements from saved standings...</div>';
    const stat=(value,label,title)=>`<span title="${escapeHtml(title)}"><b>${value}</b>${label}</span>`;
    const averagePlacement=Number(entry.averagePlacementVersion||0)>=AVERAGE_PLACEMENT_VERSION&&Number.isFinite(Number(entry.averagePlacement))?Number(entry.averagePlacement).toFixed(2):'Not available';
    const primaryStats=[stat(entry.provisional?'Provisional':`#${entry.rank}`,'Overall RP rank',rankTooltip),stat(formatRp(entry.score),'Overall RP','Lower RP is better.'),stat(escapeHtml(averagePlacement),'Average place','Literal mean finishing place across eligible tracks. Lower is better.'),stat(`${Number(entry.raceCount||0)}/${TOTAL_TRACKS}`,'Ranked tracks',tracksTooltip),stat(formatRp(entry.skillCost??entry.score),'Skill RP','Weighted average of the best ten eligible results. Lower is better.'),stat(escapeHtml(entry.rankTier||'Racer'),'Rank title','Calculated from rating strength and eligible track coverage.')].join('');
    const reportedPlaytime=Number(entry.totalPlaytimeMs||0)>0?durationLabel(Number(entry.totalPlaytimeMs)):'Not reported';
    const latestPbAt=Math.max(Number(entry.latestPbAt||0)||0,...snapshotFinishes.map((finish)=>pbTimestamp(finish)));
    const competitiveAverage=entry.competitiveAveragePlacement!=null&&Number(entry.competitiveAverageEligibleTracks||0)>0?Number(entry.competitiveAveragePlacement).toFixed(2):'Not available';
    const secondaryStats=[stat(formatRp(entry.coverageCost),'Coverage RP','Diminishing coverage cost. More eligible tracks lower this number.'),stat(formatRp(entry.consistencyCost??entry.score),'All-track depth RP','Weak outliers are limited. Lower is better.'),stat(escapeHtml(averageFinish),'Raw average place','Mean finishing place across all scored tracks.'),stat(escapeHtml(competitiveAverage),'Competitive average','Mean place on recognized non-custom tracks with at least five racers.'),stat(escapeHtml(participation),'Participation','Completed track types.'),stat(`${Number(entry.weightedTracks||0).toFixed(2)}x`,'Total weight',rankedWeightTitle('',0,true)),stat(escapeHtml(podiumRate),'Podium rate','Eligible top-three finishes divided by podium-eligible tracks.'),stat(String(eligibleWinCount(entry)),'Track wins',LEADERBOARD_INFO.wins),stat(escapeHtml(pbCount),'PBs set','Accepted personal-best improvements saved to Ranked.'),stat(bestPlace?`#${bestPlace.rank} of ${bestPlace.fieldSize}`:'N/A','Best placement','Best placement present in this complete Ranked snapshot.'),stat(largestField||'N/A','Largest field','Largest loaded competitive field represented in this profile.'),stat(escapeHtml(reportedPlaytime),'Active time','Visible active play time reported on the latest PB write.'),stat(escapeHtml(racingAge),'Racing for',`Earliest saved ranked result: ${accountSince}`),stat(latestPbAt?escapeHtml(formatLocalPbDate({pbAt:latestPbAt},false)):'N/A','Latest PB',latestPbAt?`Recorded in your local time: ${formatLocalPbDate({pbAt:latestPbAt})}`:'No PB timestamp is available.'),stat(escapeHtml(currentRankAge),'At current rank','Shared timestamp from the current complete Ranked snapshot.')].join('');
    const usedResultTracks=new Set();
    const takeUnique=(rows)=>{const found=(rows||[]).find((finish)=>finish?.trackId&&!usedResultTracks.has(finish.trackId));if(found)usedResultTracks.add(found.trackId);return found||null;};
    const bestCard=takeUnique([best]);
    const strongestWeighted=weightedResults[0]||null;
    const nextWeighted=weightedResults.find((finish)=>finish?.trackId!==bestCard?.trackId)||null;
    const duplicateCarries=strongestWeighted?.trackId===bestCard?.trackId&&(!nextWeighted||Number(strongestWeighted.contribution||0)>=Number(nextWeighted.contribution||0)*1.25);
    const weightedCard=duplicateCarries?strongestWeighted:takeUnique(weightedResults);
    if(weightedCard?.trackId)usedResultTracks.add(weightedCard.trackId);
    const largestFieldCard=takeUnique(rankedDetails.slice().sort((a,b)=>Number(b.fieldSize)-Number(a.fieldSize)||(knownFinishWeight(b)||0)-(knownFinishWeight(a)||0)));
    const opportunityCard=takeUnique(opportunities);
    const nextOpportunityCard=takeUnique(opportunities);
    const needsWorkCard=takeUnique(rankedDetails.filter((finish)=>Number(finish.rank)>1&&TRACK_CATALOG.has(String(finish?.trackId||''))&&trackInfo(finish.trackId).type!=='custom'&&Number(knownFinishWeight(finish)||0)>0&&Number(finish.contribution||Math.max(0,(100-rankedPlacementCost(finish.rank,finish.fieldSize))*Number(knownFinishWeight(finish)||0)))>0).sort((a,b)=>(Number(b.rank)/Number(b.fieldSize))-(Number(a.rank)/Number(a.fieldSize))||(knownFinishWeight(b)||0)-(knownFinishWeight(a)||0)));
    const resultCardData=[['Best finish',bestCard,'No ranked finish'],[duplicateCarries?'Best finish + strongest':'Strongest weighted',weightedCard,'No separate weighted result'],['Largest field',largestFieldCard,'No separate field result'],['Best opportunity',opportunityCard,'No separate target yet'],['Next opportunity',nextOpportunityCard,'More loaded tracks unlock another route'],['Needs work',needsWorkCard,'No scored result needs attention']];
    resultCardData.sort((a,b)=>Number(Boolean(b[1]?.trackId))-Number(Boolean(a[1]?.trackId)));
    const resultCards=resultCardData.map((card)=>trackSummaryLine(card[0],card[1],card[2])).join('');
    const profileBadges=profileBadgeMarkup(entry,false);
    const profileCosmetics=cosmeticsForEntry(entry);
    const profileTitle=cosmeticTitleText(entry,profileCosmetics);
    const favoriteTrack=profileCosmetics.favoriteTrackId?trackInfo(profileCosmetics.favoriteTrackId):null;
    const profileIdentityExtras=`<button type="button" class="button" data-copy-public-id="${uid}">Copy public ID</button>${profileTitle?`<span class="profile-racer-title">${escapeHtml(profileTitle)}</span>`:''}${favoriteTrack?`<button type="button" class="profile-favorite-chip" data-track-id="${escapeHtml(favoriteTrack.id)}" aria-label="Open favorite track ${escapeHtml(favoriteTrack.name)}">Favorite · ${escapeHtml(favoriteTrack.name)}</button>`:''}`;
    content.innerHTML=`<div class="profile-hero"><div class="profile-car-column">${carModelPreview(carStyle,entry.carColorId||entry.carColors,entry.userId)}<div class="profile-achievement-row"><span class="profile-achievement-label">ELIGIBLE PODIUMS</span><div class="profile-achievement-medals">${achievements}</div><span class="profile-ranked-count">${Number(entry.raceCount||0)} ranked track${Number(entry.raceCount||0)===1?'':'s'}</span></div></div><div class="profile-identity"><span class="profile-kicker">RANKED PROFILE</span><h3>${escapeHtml(safeDisplayName(entry.name||'Guest',entry.userId))}${countryFlagMarkup(entry.countryCode)}${isSelf?'<span class="overall-you-tag">YOU</span>':''}</h3><div class="profile-identity-extras">${profileIdentityExtras}${profileBadges}</div><div class="profile-stat-strip profile-stat-primary">${primaryStats}</div><details class="profile-more-stats"><summary>More profile stats</summary><div class="profile-stat-strip profile-stat-secondary">${secondaryStats}</div></details></div></div>${isSelf?profileCustomizerMarkup(entry):''}<div class="profile-results">${resultCards}</div>${guideMarkup}<section class="profile-track-history"><header><div><span class="profile-kicker">TRACK BREAKDOWN</span><h4>Loaded results</h4></div><span>${cachedFinishes.length} loaded on this device · ${Number(entry.raceCount||0)} counted in Ranked</span></header><div class="profile-track-head"><button type="button" data-profile-sort="track" data-profile-user="${uid}" class="${profileSort==='track'?'active':''}" aria-label="Sort by track name">Track${profileSortArrow('track')}</button><button type="button" data-profile-sort="weight" data-profile-user="${uid}" class="${profileSort==='weight'?'active':''}" aria-label="Sort by track weight">Weight & age${profileSortArrow('weight')}</button><button type="button" data-profile-sort="place" data-profile-user="${uid}" class="${profileSort==='place'?'active':''}" aria-label="Sort by finishing result">Result${profileSortArrow('place')}</button><button type="button" data-profile-sort="time" data-profile-user="${uid}" class="${profileSort==='time'?'active':''}" aria-label="Sort by personal best time">Time${profileSortArrow('time')}</button></div><div class="profile-track-list">${trackRows}</div></section><p class="profile-disclaimer">If a track leaderboard has not been loaded, its time may not be listed.</p>`;
    applyProfileCosmetics(content.closest('.overall-profile-card'),profileCosmeticDrafts.get(cleanUserId(entry.userId||entry.accountId||''))||cosmeticsForEntry(entry));
    setupRacerStudio(content);
    openRankedDialog(popup,popup.querySelector('#overallProfileClose'));
    popup.dataset.profileUser=cleanUserId(userId);
    profileCard.scrollTop=profileScroll;
    hydrateOverallCarModels(content);
    const stillCurrent=()=>content.__guideToken===guideToken&&plannerMetric===metricAtStart&&plannerSort===sortAtStart&&popup.dataset.profileUser===cleanUserId(userId)&&isElementVisible(popup);
    cachedProfileGuideMarkup(entry,self,isSelf,cachedFinishes,snapshotFinishes,selfSnapshotFinishes,stillCurrent).then(markup=>{
      if(!stillCurrent()||!markup)return;
      const pending=content.querySelector('.profile-guide-pending');if(!pending)return;pending.outerHTML=markup;
      const guide=content.querySelector('.profile-guide');if(guide&&guideWasOpen)guide.open=true;
      if(guideHadFocus)guide?.querySelector(guideHadFocus)?.focus({preventScroll:true});
    }).catch(()=>{if(stillCurrent()){const pending=content.querySelector('.profile-guide-pending');if(pending)pending.textContent='Route calculation unavailable. Reopen this profile to retry.';}});
  }
  function renderEntries(entries,snapshotMeta){
    const listEl = document.getElementById('overallLeaderboardList');
    if (!listEl) return;
    if (Array.isArray(entries)) { overallEntriesCache = entries; setRankedFilterSnapshotMeta(snapshotMeta,entries.length); if(overallCategory!=='events')overallPage = 0; }
    const filterRoot=document.getElementById('overallFilterPanel');
    if(filterRoot)filterRoot.hidden=overallCategory==='events'||overallCategory==='topTracks';
    const columnLabels=document.querySelectorAll('#overallLeaderboardPanel .overall-columns span');
    const labels=overallCategory==='events'?['Place','Driver','Events','Event RP']:overallCategory==='topTracks'?['Place','Track','Leader & record','Weight']:['Place','Driver','Movement & bests','Score'];
    columnLabels.forEach((column,index)=>{column.textContent=labels[index]||'';});
    const findMe=document.getElementById('overallFindMeBtn'); if(findMe)findMe.disabled=overallCategory==='topTracks';
    if(overallCategory==='events'){renderEventEntries(listEl);return;}
    if(overallCategory==='topTracks'){
      const tracks=loadedTrackRankingRows();
      updateOverallPager();
      if(!tracks.length){listEl.innerHTML='<div class="overall-empty"><strong>Top Tracks is not ready</strong><span>No populated track data is available in this snapshot yet.</span></div>';return;}
      const start=overallPage*OVERALL_PAGE_SIZE;
      listEl.innerHTML=tracks.slice(start,start+OVERALL_PAGE_SIZE).map((row,index)=>renderTrackRankingRow(row,start+index)).join('');
      listEl.scrollTop=0;
      return;
    }
    const baseEntries = sortedOverallEntries();
    const filterResult=syncRankedFilterRows(baseEntries);
    if(filterResult?.available&&FILTERABLE_RANKED_CATEGORIES.has(filterResult.filter?.category)&&filterResult.filter.category!==overallCategory){
      overallCategory=filterResult.filter.category;recordLeaderboardUse(overallCategory);refreshLeaderboardArcade();syncCategorySelect(document);overallPage=0;renderEntries();return;
    }
    const allEntries = filterResult?.available?filterResult.rows:baseEntries;
    document.getElementById('overallLeaderboardPanel')?.setAttribute('data-category',overallCategory);
    updateOverallPager();
    if (!allEntries.length){
      const connected = overallLoadState.status === 'empty-cloud';
      listEl.innerHTML = `<div class="overall-empty"><strong>${connected?'Community Ranked is initializing':'Community Ranked is temporarily unavailable'}</strong><span>${connected?'No complete production snapshot exists yet.':`The cloud refresh did not return a complete snapshot${overallLoadState.message?`: ${escapeHtml(overallLoadState.message)}`:'.'}`}</span><span>Your local PBs remain saved. No local record is discarded when Ranked is offline.</span><button class="button" type="button" data-rank-retry>Retry</button></div>`;
      return;
    }
    const start = overallPage * OVERALL_PAGE_SIZE;
    listEl.innerHTML = allEntries.slice(start,start+OVERALL_PAGE_SIZE).map((entry,index)=>renderEntryRow(entry.filteredRank?entry:{...entry,rank:entry.categoryRank},index,false)).join('');
    listEl.scrollTop = 0;
    hydrateOverallCarModels(listEl);
  }

  function updateRankedFreshness(){
    const el=document.getElementById('overallFreshness'); if(!el) return;
    if(overallCategory==='events'){updateEventFreshness(el);return;}
    const status=String(overallLoadState.status||'');
    const snapshotAt=Number(overallLoadState.serverUpdatedAt||overallLoadState.fetchedAt||0)||0;
    const checkedAt=Number(overallLoadState.checkedAt||0)||0;
    const isOld=Boolean(snapshotAt&&Date.now()-snapshotAt>2*60*60*1000);
    const failed=status==='stale'||status==='error';
    el.className=`overall-freshness ${failed?'is-stale':status==='pending'?'is-pending':status==='loading'?'is-loading':''} ${isOld?'is-old-change':''}`;
    el.dataset.old=String(isOld);
    const parts=[];
    if(status==='loading')parts.push(snapshotAt?`Saved snapshot ${ageLabel(snapshotAt)}`:'No saved snapshot','checking cloud now');
    else if(failed)parts.push('STALE SAVED DATA',snapshotAt?`${ageLabel(snapshotAt)}`:'age unknown','cloud refresh failed');
    else if(status==='cloud'||status==='pending')parts.push(`Cloud checked ${checkedAt?ageLabel(checkedAt):'just now'}`,snapshotAt?`changed ${ageLabel(snapshotAt)}`:'change time unavailable');
    else parts.push('Saved snapshot',snapshotAt?`changed ${ageLabel(snapshotAt)}`:'change time unavailable');
    const wait=isOld?0:Math.max(0,120000-(Date.now()-lastRankedManualRefreshAt));
    const automaticWait=Math.max(0,Number(overallLoadState.nextRefreshAt||0)-Date.now());
    if(status==='loading'){}
    else if(wait>0&&!failed)parts.push(`next check in ${durationLabel(wait)}`);
    else if(automaticWait>0&&status==='cache')parts.push(`refresh in ${durationLabel(automaticWait)}`);
    else parts.push('click to refresh');
    el.textContent=parts.join(' · ');
    el.title=`${String(overallLoadState.message||'Select to request a fresh ranked snapshot.')} Rankings are rendered from one complete snapshot. ${checkedAt?`Cloud last checked ${ageLabel(checkedAt)}.`:''}`.trim();
    const streakEl=document.getElementById('overallStreakLeader');
    if(streakEl?.dataset.base&&streakEl.dataset.fetchedAt) streakEl.textContent=`${streakEl.dataset.base} · ${ageLabel(Number(streakEl.dataset.fetchedAt))}`;
  }
  function requestRankedRefresh(){
    if(overallCategory==='events')return fetchEventTotals(true);
    const snapshotAge=Date.now()-Number(overallLoadState.fetchedAt||0);
    if(snapshotAge<OVERALL_REFRESH_CHECK_MS&&Date.now()-lastRankedManualRefreshAt<120000&&overallLoadState.status!=='stale'&&overallLoadState.status!=='error'){updateRankedFreshness();return;}
    lastRankedManualRefreshAt=Date.now();
    writeJsonStorage(OVERALL_REBUILD_BACKOFF_KEY,0);
    overallLoadState.nextRefreshAt=0;
    openPanel(true);
  }
  function updateWeightedTrackInsights(entries){
    const el=document.getElementById('overallOpportunities'); if(!el) return;
    const byTrack=new Map();
    for(const entry of entries||[]){
      const finishes=Array.isArray(entry.bestTracks)&&entry.bestTracks.length?entry.bestTracks:[{trackId:entry.bestTrackId,fieldSize:entry.bestTrackField}];
      for(const finish of finishes){
        const id=String(finish?.trackId||''); if(!id) continue;
        const info=trackInfo(id); const field=Math.max(1,Number(finish.fieldSize||0)||1);
        const weight=knownFinishWeight(finish)||rankedTrackWeight(finish.trackId,field);
        const current=byTrack.get(id); if(!current||weight>current.weight) byTrack.set(id,{id,name:info.name,field,weight});
      }
    }
    const top=Array.from(byTrack.values()).sort((a,b)=>b.weight-a.weight||b.field-a.field).slice(0,2);
    const self=(entries||[]).find((entry)=>cleanUserId(entry.userId||entry.accountId||'')===activeRankedAccountId());
    const target=self?.improvementTrack?.trackId?trackInfo(self.improvementTrack.trackId):null;
    const general=top.length?top.map((track)=>escapeHtml(track.name)).join(' + '):'Waiting for larger shared fields';
    el.innerHTML=`<span class="overall-insight"><b>Most valuable now</b>${general}</span><span class="overall-insight personal"><b>Your best opportunity</b>${target?escapeHtml(target.name):'Complete a second track for a personal target'}</span>`;
  }

  async function openPanel(forceRefresh=false){
    const panel = document.getElementById('overallLeaderboardPanel');
    const listEl = document.getElementById('overallLeaderboardList');
    if (!panel || !listEl) return;
    if(overallCategory==='events'){
      panel.style.display='flex';
      if(!overallEntriesCache.length)overallEntriesCache=readOverallSnapshotCache()?.entries||[];
      syncCategorySelect(panel);
      const scope=panel.querySelector('#overallTrackScope');if(scope)scope.hidden=true;
      renderEntries();updateRankedFreshness();
      return fetchEventTotals(forceRefresh);
    }
    document.querySelector('.ranked-testing-notice')?.remove();
    const generation = ++overallLoadGeneration;
    const dirtyPb=readJsonStorage(OVERALL_PB_DIRTY_KEY,null);
    const savedBeforeOpen=readOverallSnapshotCache();
    const pbNeedsCheck=Boolean(dirtyPb?.at)&&Date.now()-Number(savedBeforeOpen?.fetchedAt||0)>=OVERALL_REFRESH_CHECK_MS;
    const shouldForceRefresh=forceRefresh||pbNeedsCheck;
    panel.style.display='flex';
    syncCosmeticDirectory(forceRefresh);
    if(!rankedFreshnessTimer) rankedFreshnessTimer=setInterval(()=>{if(panel.style.display!=='none'){updateRankedFreshness();updateRankDurationLabels(panel);}},1000);
    const dailyGrid=panel.querySelector('#overallDailyGrid');
    if(dailyGrid) dailyGrid.outerHTML=dailySpotlightMarkup();
    const trackScope=panel.querySelector('#overallTrackScope');
    const selectedCategory=overallCategory==='official'||overallCategory==='community'?'tracks':overallCategory;
    syncCategorySelect(panel);
    if(trackScope){
      trackScope.hidden=selectedCategory!=='tracks';
      trackScope.querySelectorAll('[data-track-scope]').forEach((button)=>{const active=button.dataset.trackScope===(overallCategory==='official'?'official':overallCategory==='community'?'community':'all');button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});
    }
    const saved=readOverallSnapshotCache();
    if(saved?.entries?.length){
      const savedEntries=annotateOverallMovement(saved.entries,saved.signature);
      renderEntries(savedEntries,saved);
      updateWeightedTrackInsights(savedEntries);
      overallLoadState={status:'loading',message:'Showing saved rankings while checking Firebase',fetchedAt:saved.serverUpdatedAt||saved.fetchedAt,serverUpdatedAt:saved.serverUpdatedAt||0,checkedAt:saved.fetchedAt||0,complete:saved.complete===true,totalEntries:saved.totalEntries,totalEntriesExact:saved.totalEntriesExact===true,publishedEntries:saved.publishedEntries,ranksExact:saved.ranksExact===true};
      updateRankedFreshness();
    } else {
      listEl.innerHTML = `<div class="overall-loading"><strong>${tr('loading')}</strong><span>Checking Firebase for the first ranked snapshot</span><div class="overall-loading-bar"></div></div>`;
    }
    const slowTimer=setTimeout(()=>{
      if(generation===overallLoadGeneration&&panel.style.display!=='none'&&overallLoadState.status==='loading'){
        overallLoadState.message=saved?.entries?.length?'Firebase is taking longer than expected · saved rankings remain available':'Firebase is taking longer than expected';
        updateRankedFreshness();
      }
    },5000);
    try {
      const entries = await withTimeout(fetchOverallEntries(shouldForceRefresh),12000,'Ranked snapshot timed out.');
      clearTimeout(slowTimer);
      if (generation !== overallLoadGeneration) return;
      if(pbNeedsCheck&&overallLoadState.status!=='error'&&overallLoadState.status!=='stale')writeJsonStorage(OVERALL_PB_DIRTY_KEY,null);
      renderEntries(entries,overallLoadState);
      updateRankedFreshness();
      updateWeightedTrackInsights(entries);
    } catch (error) {
      clearTimeout(slowTimer);
      if (generation !== overallLoadGeneration) return;
      overallLoadState=saved?.entries?.length?{status:'stale',message:'Firebase timed out · showing saved rankings',fetchedAt:saved.serverUpdatedAt||saved.fetchedAt,serverUpdatedAt:saved.serverUpdatedAt||0,checkedAt:Date.now(),nextRefreshAt:Date.now()+OVERALL_REFRESH_CHECK_MS,complete:saved.complete===true,totalEntries:saved.totalEntries,totalEntriesExact:saved.totalEntriesExact===true,publishedEntries:saved.publishedEntries,ranksExact:saved.ranksExact===true}:{status:'error',message:'The ranked snapshot took too long to respond. Check the connection and retry.',complete:false,totalEntries:null,totalEntriesExact:false,publishedEntries:null,ranksExact:false};
      if(!saved?.entries?.length)renderEntries([],overallLoadState);
      updateRankedFreshness();
      log('warn','[FB408] Ranked panel load timed out',String(error&&(error.message||error)));
    }
  }

  function nextUploadId(){
    const timeBased = Date.now() * 1000 + Math.floor(Math.random() * 1000);
    localUploadCounter = Math.max(localUploadCounter + 1, timeBased);
    localStorage.setItem('polytrack-0.6.2-upload-counter', String(localUploadCounter));
    return localUploadCounter;
  }

  function parseTarget(target){
    try { return new URL(String(target || ''), window.location.href); }
    catch { return null; }
  }

  function rankedBrokerUrl(){
    const configured=String(window.POLYTRACK_RANKED_BROKER_URL||'').trim();
    if(!configured)return '';
    try{
      const parsed=new URL(configured,window.location.href);
      if(parsed.protocol!=='https:'&&!/^https?:\/\/(localhost|127\.0\.0\.1)(?::\d+)?$/i.test(parsed.origin))return '';
      return parsed.href.replace(/\/+$/,'');
    }catch{return '';}
  }

  async function fetchRankedSnapshot(kind,trackId=''){
    const endpoint=rankedBrokerUrl();
    if(!endpoint)return null;
    if(!rankedEdgeAvailable())return null;
    const path=kind==='overall'?'/v1/snapshot/overall':`/v1/snapshot/track?trackId=${encodeURIComponent(String(trackId||'').slice(0,80))}`;
    try{
      const response=await withTimeout(fetch(`${endpoint}${path}`,{
        headers:{Accept:'application/json'},
        cache:'default',
        credentials:'omit',
        referrerPolicy:'no-referrer'
      }),5000,'Ranked snapshot timed out');
      if(response.status===404)return null;
      const contentType=String(response.headers.get('Content-Type')||'').toLowerCase();
      if(!response.ok)throw new Error(`Ranked snapshot failed (${response.status})`);
      if(!contentType.includes('application/json'))throw new Error('Ranked edge was replaced by a network filter');
      const payload=await response.json();
      clearRankedEdgeFailure();
      return payload&&typeof payload==='object'?payload:null;
    }catch(error){
      markRankedEdgeUnavailable(String(error&&(error.message||error)));
      throw error;
    }
  }

  function rankedNotifyQueue(){
    const value=readJsonStorage(RANKED_NOTIFY_QUEUE_KEY,[]);
    return Array.isArray(value)?value.filter((item)=>item&&typeof item.resultId==='string').slice(-100):[];
  }

  function queueRankedNotification(resultId,trackId,reason='pending'){
    const id=String(resultId||'').slice(0,220); if(!id)return;
    const queue=rankedNotifyQueue().filter((item)=>item.resultId!==id);
    queue.push({resultId:id,trackId:String(trackId||'').slice(0,80),queuedAt:Date.now(),attempts:0,reason:String(reason||'pending').slice(0,80)});
    writeJsonStorage(RANKED_NOTIFY_QUEUE_KEY,queue);
  }

  async function sendRankedNotification(resultId,trackId,{queueOnFailure=true}={}){
    const endpoint=rankedBrokerUrl();
    if(!endpoint){if(queueOnFailure)queueRankedNotification(resultId,trackId,'broker-not-configured');return {accepted:false,queued:true,error:'broker_not_configured'};}
    if(!rankedEdgeAvailable()){
      if(queueOnFailure)queueRankedNotification(resultId,trackId,rankedEdgeState.reason||'edge-backoff');
      return {accepted:false,queued:true,error:'edge_backoff'};
    }
    try{
      const user=window.firebase?.auth?.().currentUser;
      if(!user)throw new Error('Firebase user is not ready');
      const token=await user.getIdToken();
      const response=await fetch(`${endpoint}/v1/pb/notify`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({resultId:String(resultId||'').slice(0,220)}),cache:'no-store'});
      const contentType=String(response.headers.get('Content-Type')||'').toLowerCase();
      if(!contentType.includes('application/json'))throw new Error('Ranked edge was replaced by a network filter');
      let payload={}; try{payload=await response.json();}catch{}
      if(!response.ok||payload.accepted!==true)throw new Error(String(payload.error||`ranked_${response.status}`));
      clearRankedEdgeFailure();
      const queue=rankedNotifyQueue().filter((item)=>item.resultId!==resultId);
      writeJsonStorage(RANKED_NOTIFY_QUEUE_KEY,queue);
      log('info','[RANKED202] Ranked Worker accepted PB',{trackId,changed:Boolean(payload.changed),revision:Number(payload.revision||0)});
      return payload;
    }catch(error){
      markRankedEdgeUnavailable(String(error&&(error.message||error)));
      if(queueOnFailure)queueRankedNotification(resultId,trackId,String(error&&(error.message||error)));
      log('warn','[RANKED402] PB saved; Ranked Worker notification queued',{trackId,reason:String(error&&(error.message||error))});
      return {accepted:false,queued:true,error:String(error&&(error.message||error))};
    }
  }

  async function sendRankedProfileNotification(accountId){
    const endpoint=rankedBrokerUrl();
    const safeId=cleanUserId(accountId);
    if(!endpoint||!safeId)return {accepted:false,disabled:!endpoint};
    if(!rankedEdgeAvailable())return {accepted:false,deferred:true,error:'edge_backoff'};
    try{
      await db();
      const user=window.firebase?.auth?.().currentUser;
      if(!user)throw new Error('Firebase user is not ready');
      const token=await user.getIdToken(false);
      const response=await fetch(`${endpoint}/v1/profile/notify`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({accountId:safeId}),cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer'});
      const contentType=String(response.headers.get('Content-Type')||'').toLowerCase();
      if(!contentType.includes('application/json'))throw new Error('Ranked edge was replaced by a network filter');
      const payload=await response.json().catch(()=>({}));
      if(!response.ok||payload.accepted!==true)throw new Error(String(payload.error||`ranked_profile_${response.status}`));
      clearRankedEdgeFailure();
      writeJsonStorage(OVERALL_PB_DIRTY_KEY,{at:Date.now(),reason:'profile-update'});
      overallLoadState.nextRefreshAt=Date.now();
      return payload;
    }catch(error){
      markRankedEdgeUnavailable(String(error&&(error.message||error)));
      log('warn','[RANKED_PROFILE_400] Ranked identity refresh deferred',String(error&&(error.message||error)));
      return {accepted:false,error:String(error&&(error.message||error))};
    }
  }

  const COSMETIC_PUBLISH_QUEUE_KEY='polytrack-0.6.2-profile-cosmetics-pending-v1';
  let cosmeticPublishPromise=null,cosmeticPublishTimer=0,cosmeticDraftSerial=0;
  function cosmeticPublishBackoff(attempts){
    return [15000,60000,300000,900000,3600000][Math.min(4,Math.max(0,Number(attempts||1)-1))];
  }
  function cosmeticPublishIdentityMatches(item,accountId,ownerUid){
    return Boolean(item&&item.accountId===String(accountId||'')&&item.ownerUid===String(ownerUid||''));
  }
  function cosmeticPublishQueueTransition(state,action,maxAccounts=8){
    const entries={...(state&&state.entries&&typeof state.entries==='object'?state.entries:{})};
    const accountId=String(action?.accountId||action?.item?.accountId||'');
    const current=entries[accountId];
    if(action?.type==='queue'&&accountId&&action.item)entries[accountId]={...action.item,accountId};
    else if(action?.type==='ack'&&current?.draftId===action.draftId)delete entries[accountId];
    else if(action?.type==='failure'&&current?.draftId===action.draftId){
      entries[accountId]={...current,attempts:Math.min(1000,Math.max(0,Number(current.attempts||0))+1),nextAttemptAt:Math.max(0,Number(action.nextAttemptAt||0)||0),lastError:String(action.error||'publish failed').slice(0,160)};
    }
    const limited=Object.entries(entries).sort((a,b)=>Number(b[1]?.queuedAt||0)-Number(a[1]?.queuedAt||0)).slice(0,Math.max(1,Number(maxAccounts)||8));
    return {version:1,entries:Object.fromEntries(limited)};
  }
  function readCosmeticPublishQueue(){
    const saved=readJsonStorage(COSMETIC_PUBLISH_QUEUE_KEY,{version:1,entries:{}})||{version:1,entries:{}};
    const entries={};
    for(const [key,row] of Object.entries(saved.entries&&typeof saved.entries==='object'?saved.entries:{})){
      const accountId=cleanUserId(row?.accountId||key);
      const ownerUid=String(row?.ownerUid||'').trim();
      const draftId=String(row?.draftId||'').slice(0,160);
      if(!accountId||accountId!==cleanUserId(key)||!ownerUid||ownerUid.length>128||/[\u0000-\u001f\u007f]/.test(ownerUid)||!draftId)continue;
      entries[accountId]={accountId,ownerUid,draftId,cosmetics:sanitizeProfileCosmetics(row.cosmetics),queuedAt:Math.max(0,Number(row.queuedAt||0)||0),attempts:Math.min(1000,Math.max(0,Number(row.attempts||0)||0)),nextAttemptAt:Math.max(0,Number(row.nextAttemptAt||0)||0),lastError:String(row.lastError||'').slice(0,160)};
    }
    return {version:1,entries};
  }
  function transitionCosmeticPublishQueue(action){
    const next=cosmeticPublishQueueTransition(readCosmeticPublishQueue(),action);
    return writeJsonStorage(COSMETIC_PUBLISH_QUEUE_KEY,next)?next:null;
  }
  function queueCosmeticPublish(accountId,ownerUid,cosmetics){
    const safeId=cleanUserId(accountId),uid=String(ownerUid||'').trim();
    if(!safeId||safeId!==activeRankedAccountId()||!uid||uid.length>128||/[\u0000-\u001f\u007f]/.test(uid))throw new Error('The active cloud account is not ready.');
    const now=Date.now();
    const random=globalThis.crypto?.randomUUID?.()||Math.random().toString(36).slice(2);
    const item={accountId:safeId,ownerUid:uid,draftId:`${now.toString(36)}-${(++cosmeticDraftSerial).toString(36)}-${random}`,cosmetics:sanitizeProfileCosmetics(cosmetics),queuedAt:now,attempts:0,nextAttemptAt:0,lastError:''};
    const next=transitionCosmeticPublishQueue({type:'queue',accountId:safeId,item});
    if(next?.entries?.[safeId]?.draftId!==item.draftId)throw new Error('Pending design storage is unavailable.');
    return next.entries[safeId];
  }
  function scheduleCosmeticPublishRetry(){
    clearTimeout(cosmeticPublishTimer);cosmeticPublishTimer=0;
    if(globalThis.navigator?.onLine===false)return;
    const accountId=activeRankedAccountId();
    const item=readCosmeticPublishQueue().entries[accountId];
    const uid=window.firebase?.auth?.().currentUser?.uid||'';
    if(!cosmeticPublishIdentityMatches(item,accountId,uid))return;
    const wait=Math.min(3600000,Math.max(0,Number(item.nextAttemptAt||0)-Date.now()));
    cosmeticPublishTimer=setTimeout(()=>{cosmeticPublishTimer=0;flushPendingCosmeticPublishes().catch(()=>{});},wait);
  }
  async function flushPendingCosmeticPublishes({force=false}={}){
    if(cosmeticPublishPromise)return cosmeticPublishPromise;
    let attempted=null;
    cosmeticPublishPromise=(async()=>{
      let outcome={published:false,queued:false,message:'Saved on this device. Publishing is queued.'};
      for(let pass=0;pass<4;pass++){
        const accountId=activeRankedAccountId();
        let item=readCosmeticPublishQueue().entries[accountId];
        if(!item)return outcome;
        if(globalThis.navigator?.onLine===false)return {...outcome,queued:true,offline:true};
        if(!force&&Number(item.nextAttemptAt||0)>Date.now())return {...outcome,queued:true,deferred:true};
        const initialUid=window.firebase?.auth?.().currentUser?.uid||'';
        if(initialUid&&!cosmeticPublishIdentityMatches(item,accountId,initialUid))return {...outcome,queued:true,switched:true};
        attempted=item;
        const fire=await db();
        const user=window.firebase?.auth?.().currentUser;
        item=readCosmeticPublishQueue().entries[accountId];
        if(!user||!cosmeticPublishIdentityMatches(item,activeRankedAccountId(),user.uid)){attempted=null;return {...outcome,queued:true,switched:true};}
        if(!force&&Number(item.nextAttemptAt||0)>Date.now())return {...outcome,queued:true,deferred:true};
        attempted=item;
        const now=Date.now();
        const profileRef=fire.collection('0.6.2_profiles_public').doc(item.accountId);
        await fire.runTransaction(async(tx)=>{
          const currentUser=window.firebase?.auth?.().currentUser;
          if(!currentUser||!cosmeticPublishIdentityMatches(item,activeRankedAccountId(),currentUser.uid)){const error=new Error('Active account changed before publish.');error.code='cosmetic-account-switched';throw error;}
          const previous=await tx.get(profileRef);
          if(!cosmeticPublishIdentityMatches(item,activeRankedAccountId(),window.firebase?.auth?.().currentUser?.uid||'')){const error=new Error('Active account changed before publish.');error.code='cosmetic-account-switched';throw error;}
          assertCloudOwner(item.accountId,item.ownerUid,previous.exists?previous.data():null);
          tx.set(profileRef,{profileCosmetics:item.cosmetics,cosmeticsUpdatedAt:now,cosmeticsSyncedAt:window.firebase.firestore.FieldValue.serverTimestamp(),updatedAt:now},{merge:true});
        });
        const latest=readCosmeticPublishQueue().entries[item.accountId];
        const superseded=Boolean(latest&&latest.draftId!==item.draftId);
        if(!superseded)transitionCosmeticPublishQueue({type:'ack',accountId:item.accountId,draftId:item.draftId});
        attempted=null;
        outcome={published:true,queued:superseded,accountId:item.accountId,message:'Published. Leaderboards refresh shortly.'};
        if(superseded){force=true;continue;}
        const directory=readCosmeticDirectory();
        // Do not move the shared-query cursor to this one local write. Doing so can
        // skip every other racer update between the prior cursor and this timestamp.
        writeCosmeticDirectory({...directory,entries:{...directory.entries,[item.accountId]:{at:now,value:item.cosmetics}}});
        if(cosmeticPublishIdentityMatches(item,activeRankedAccountId(),window.firebase?.auth?.().currentUser?.uid||'')){
          // The public profile is the school-safe path. The Worker job is optional and
          // must never make the public save fail when workers.dev is blocked.
          try{
            await fire.collection('0.6.2_s1_cosmetic_jobs').doc(item.accountId).set({accountId:item.accountId,ownerUid:item.ownerUid,cosmetics:item.cosmetics,active:true,updatedAt:now});
          }catch(jobError){
            log('warn','[COSMETIC202] Public design saved; optional Worker job deferred',String(jobError&&(jobError.message||jobError)));
          }
          const endpoint=rankedBrokerUrl();
          if(endpoint&&rankedEdgeAvailable()){
            try{
              const token=await user.getIdToken(false);
              if(!cosmeticPublishIdentityMatches(item,activeRankedAccountId(),window.firebase?.auth?.().currentUser?.uid||''))return outcome;
              const response=await withTimeout(fetch(`${endpoint}/v1/profile/cosmetics`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({accountId:item.accountId,cosmetics:item.cosmetics}),cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer'}),8000);
              const payload=await response.json().catch(()=>({}));
              if(response.status>=500)throw new Error(String(payload.error||`worker_${response.status}`));
              // A rejection is a completed round trip, so the Worker stays available for other requests.
              clearRankedEdgeFailure();
              if(response.ok&&payload.accepted===true)outcome.message='Published and leaderboards updated.';
              else if(payload.error==='cosmetic_locked')outcome.message='Published. Bonus design access is being refreshed.';
            }catch(error){
              markRankedEdgeUnavailable(String(error&&(error.message||error)));
            }
          }
        }
        if(readCosmeticPublishQueue().entries[item.accountId]){force=true;continue;}
        return outcome;
      }
      return {...outcome,queued:Boolean(readCosmeticPublishQueue().entries[activeRankedAccountId()])};
    })().catch((error)=>{
      if(error?.code==='cosmetic-account-switched')return {published:false,queued:true,switched:true,message:'Saved on this device. Switch back to this racer to retry publishing.'};
      if(attempted){
        const current=readCosmeticPublishQueue().entries[attempted.accountId];
        if(current?.draftId===attempted.draftId){
          const nextAttemptAt=Date.now()+cosmeticPublishBackoff(Number(current.attempts||0)+1);
          transitionCosmeticPublishQueue({type:'failure',accountId:attempted.accountId,draftId:attempted.draftId,nextAttemptAt,error:String(error&&(error.message||error))});
        }
      }
      if(error?.code==='account-session-conflict')showCloudOwnerConflict();
      log('warn','[COSMETIC400] Public design publish queued',String(error&&(error.message||error)));
      return {published:false,queued:Boolean(attempted),error:String(error&&(error.message||error)),message:'Saved on this device. Could not publish yet, it will retry.'};
    });
    try{return await cosmeticPublishPromise;}
    finally{cosmeticPublishPromise=null;attempted=null;scheduleCosmeticPublishRetry();}
  }

  async function saveRankedProfileCosmetics(accountId,status,button){
    const safeId=cleanUserId(accountId);
    const cosmetics=sanitizeProfileCosmetics(profileCosmeticDrafts.get(safeId));
    if(!safeId){if(status)status.textContent='This profile cannot be saved.';return false;}
    if(safeId!==activeRankedAccountId()){if(status)status.textContent='Switch back to this racer before publishing.';return false;}
    if(button){button.disabled=true;button.textContent='Saving...';}
    writeJsonStorage(PROFILE_COSMETICS_KEY,cosmetics);
    cosmeticEpoch+=1;
    const cachedEntry=overallEntriesCache.find((row)=>cleanUserId(row.userId||row.accountId||'')===safeId);
    if(cachedEntry)cachedEntry.profileCosmetics=cosmetics;
    writeJsonStorage(OVERALL_PB_DIRTY_KEY,{at:Date.now(),reason:'profile-cosmetics'});
    if(status)status.textContent='Saved on this device. Publishing...';
    renderEntries();
    try{
      let user=window.firebase?.auth?.().currentUser;
      if(!user){await db();user=window.firebase?.auth?.().currentUser;}
      if(!user)throw new Error('Sign-in is not ready.');
      if(safeId!==activeRankedAccountId())throw new Error('Active account changed before publish.');
      queueCosmeticPublish(safeId,user.uid,cosmetics);
      let result=await flushPendingCosmeticPublishes({force:true});
      let remaining=readCosmeticPublishQueue().entries[safeId];
      if(remaining&&(result.published||result.switched||result.accountId&&result.accountId!==safeId)){
        result=await flushPendingCosmeticPublishes({force:true});
        remaining=readCosmeticPublishQueue().entries[safeId];
      }
      if(remaining){
        if(status)status.textContent=result.message||'Saved on this device. Publishing is queued.';
        if(button)button.textContent='Try again';
        return false;
      }
      if(status)status.textContent=result.message||'Published. Other racers see it next time they open Ranked.';
      if(button)button.textContent='Saved';
      return true;
    }catch(error){
      const queued=Boolean(readCosmeticPublishQueue().entries[safeId]);
      if(status)status.textContent=queued?'Saved on this device. Could not publish yet, it will retry.':`Saved on this device. Publish again when sign-in is ready. (${String(error&&(error.message||error))})`;
      if(button)button.textContent='Try again';
      return false;
    }finally{
      if(button){button.disabled=false;setTimeout(()=>{if(button.isConnected&&button.textContent==='Saved')button.textContent='Publish design';},1400);}
    }
  }

  let rankedQueueFlushPromise=null;
  async function flushRankedNotificationQueue(){
    if(rankedQueueFlushPromise)return rankedQueueFlushPromise;
    rankedQueueFlushPromise=(async()=>{
      const pending=rankedNotifyQueue();
      let sent=0;
      for(const item of pending){
        const result=await sendRankedNotification(item.resultId,item.trackId,{queueOnFailure:false});
        if(!result?.accepted)break;
        sent++;
      }
      return {checked:pending.length,sent,remaining:rankedNotifyQueue().length};
    })();
    try{return await rankedQueueFlushPromise;}finally{rankedQueueFlushPromise=null;}
  }

  window.addEventListener('online',()=>setTimeout(()=>{flushRankedNotificationQueue().catch(()=>{});flushPendingCosmeticPublishes().catch(()=>{});},1200));
  setTimeout(()=>flushPendingCosmeticPublishes().catch(()=>{}),2500);

  function makeUserPayload(profile={}){
    const accountId = String(profile.accountId || localStorage.getItem('polytrack-0.6.2-active-account-id') || guestAccountId);
    const stickyName = safeDisplayName(getOrCreateDefaultDisplayName(accountId),accountId);
    const name = safeDisplayName(profile.nickname || profile.name || stickyName,accountId);
    const carStyle = __pt062NormalizeStyle(profile.carStyle || getDefaultCarStyle());
    return {
      nickname: name,
      countryCode: typeof profile.countryCode === 'string' ? profile.countryCode.slice(0, 8) : null,
      carStyle,
      isVerifier: Boolean(profile.isVerifier)
    };
  }

  function makeLeaderboardPayload(method, entries=[], position=0, previousPosition=0, forcedUploadId=null, forcedUserEntryId=null, forcedUserEntry=null){
    const normalizedEntries = enrichLegacyLeaderboardEntries(entries);
    const isPost = String(method).toUpperCase() === 'POST';
    const fallbackPosition=isPost?1:0;
    const pos = Number.isSafeInteger(Number(position)) && Number(position) > 0 ? Number(position) : fallbackPosition;
    const prevPos = Number.isSafeInteger(Number(previousPosition)) && Number(previousPosition) > 0 ? Number(previousPosition) : pos;
    const displayPos = isPost ? prevPos : pos;
    const resolvedUploadId = isPost ? (safeRecordingId(forcedUploadId) || nextUploadId()) : null;
    const explicitUser = forcedUserEntry && typeof forcedUserEntry === 'object' ? forcedUserEntry : null;
    const sourceUser = explicitUser || normalizedEntries.find((e)=>String(e.accountId||e.userId||'')===String(forcedUserEntryId||'')) || null;
    const base = {
      entries: normalizedEntries,
      total: normalizedEntries.length,
      uploadId: resolvedUploadId,
      previousPosition: prevPos,
      newPosition: pos,
      userEntry: null
    };
    if (sourceUser) {
      const sourceId = safeRecordingId(sourceUser.id) || safeRecordingId(sourceUser.uploadId) || resolvedUploadId;
      base.userEntry = { id: sourceId, position: displayPos, frames: safePositiveInt(sourceUser.frames || sourceUser.raceTimeFrames || 1, 1) };
    }
    return base;
  }

  function shouldMock(urlObj){
    if (!urlObj) return false;
    const path = urlObj.pathname;
    const isLegacyPath = ['/v6/trackOfTheWeek','/trackOfTheWeek','/user','/leaderboard','/leaderboardUserEntry','/recordings','/verifyRecordings','/iceServers','/v6/user','/v6/leaderboard','/v6/leaderboardUserEntry','/v6/recordings','/v6/verifyRecordings','/v6/iceServers'].includes(path);
    if (!isLegacyPath) return false;
    const host = String(urlObj.host || '').toLowerCase();
    if (host === window.location.host.toLowerCase()) return true;
    return host === 'vps.kodub.com' || host.endsWith('.kodub.com') || host === 'kodub.com';
  }

  async function mockPayload(urlObj, method, body){
    const requestMethod = String(method || 'GET').toUpperCase();
    if (urlObj.pathname === '/v6/trackOfTheWeek' || urlObj.pathname === '/trackOfTheWeek') {
      if(requestMethod !== 'GET')throw Error('Weekly track feed is read-only');
      return nativeWeeklyFeed();
    }
    const hinted = parsePayload(body) || {};
    log('info','[NET100] mock request',{path:urlObj.pathname,method:requestMethod});
    if (urlObj.pathname === '/user' || urlObj.pathname === '/v6/user') {
      if (requestMethod === 'POST') {
        log('info','[NET201] /user POST intercepted');
        const accountId = await accountIdFromPayload(hinted, guestAccountId);
        const previousLocalName = sanitizeDisplayName(localStorage.getItem(LAST_ACTIVE_NAME_KEY) || getOrCreateDefaultDisplayName(accountId));
        let safeName = await enforceSafeDisplayName(hinted.nickname || getOrCreateDefaultDisplayName(accountId), accountId);
        const countryCode = typeof hinted.countryCode === 'string' ? hinted.countryCode.slice(0,8) : null;
        const carStyle = __pt062NormalizeStyle(hinted.carStyle || getDefaultCarStyle());
        try {
          localStorage.setItem(LAST_ACTIVE_NAME_KEY, safeName);
          localStorage.setItem('polytrack-0.6.2-last-active-car-style', carStyle);
          localStorage.setItem('polytrack-0.6.2-active-account-id', accountId);
        } catch {}
        setLastKnownName(accountId, safeName);
        __pt062RememberStyle(accountId, carStyle);
        try {
          const d = await db();
          safeName = await resolveManualNameOverride(d,accountId,safeName);
          localStorage.setItem(LAST_ACTIVE_NAME_KEY,safeName);
          setLastKnownName(accountId,safeName);
          const nowTs = Date.now();
          log('info','[FB202] profiles_public.set start',{accountId});
          const ownerUid = window.firebase.auth().currentUser?.uid || '';
          const profileRef=d.collection(COLLECTIONS.profilesPublic).doc(accountId);
          await d.runTransaction(async tx=>{const previous=await tx.get(profileRef);assertCloudOwner(accountId,ownerUid,previous.exists?previous.data():null);tx.set(profileRef,{accountId,ownerUid,name:safeName,nickname:safeName,countryCode,carStyle,isVerifier:false,updatedAt:nowTs},{merge:true});});
          if(previousLocalName!==safeName) await updateOverallIdentity(d,accountId,safeName,countryCode,carStyle);
          log('info','[FB202] profiles_public.set ok',{accountId});
        } catch (err) { if(err?.code==='account-session-conflict')showCloudOwnerConflict();log('warn','[FB402] profiles_public.set failed', String(err && (err.message || err))); }
        return {};
      }
      hinted.userToken = urlObj.searchParams.get('userToken') || '';
      const accountId = await accountIdFromPayload(hinted, guestAccountId);
      try {
        localStorage.setItem('polytrack-0.6.2-active-account-id', accountId);
        scheduleLocalPbCloudReconcile(accountId);
        const d = await db();
        const snap = await d.collection(COLLECTIONS.profilesPublic).doc(accountId).get();
        if (snap.exists) return makeUserPayload(snap.data() || {});
      } catch (error) { log('warn','[FB402] profile lookup failed',String(error && (error.message || error))); }
      return makeUserPayload();
    }
    if (urlObj.pathname === '/leaderboardUserEntry' || urlObj.pathname === '/v6/leaderboardUserEntry') {
      const trackId = String(urlObj.searchParams.get('trackId') || hinted.trackId || '').slice(0,80);
      if (!trackId) return null;
      hinted.userTokenHash = urlObj.searchParams.get('userTokenHash') || hinted.userTokenHash || '';
      const accountId = await accountIdFromPayload(hinted, guestAccountId);
      const onlyVerified=urlObj.searchParams.get('onlyVerified')==='true';
      const loadedEntries = await getTrackEntries(trackId, 500).catch(()=>[]);
      const fullEntries=visibleTrackEntries(localTrackDisplayEntries(trackId,loadedEntries,accountId,Boolean(readTrackSnapshotCache(trackId))),onlyVerified,accountId);
      const mine = fullEntries.find((e)=>String(e.accountId||e.userId||'')===String(accountId||'')) || null;
      if (!mine) return null;
      return { position:safePositiveInt(mine.rank || mine.position, fullEntries.indexOf(mine)+1), frames:safePositiveInt(mine.frames || mine.raceTimeFrames,1), id:safeRecordingId(mine.id || mine.uploadId) || buildRecordingId(mine) };
    }

    if (urlObj.pathname === '/leaderboard' || urlObj.pathname === '/v6/leaderboard') {
      const trackId = String(urlObj.searchParams.get('trackId') || hinted.trackId || '').slice(0,80);
      if (!trackId) return requestMethod === 'POST' ? {uploadId:nextUploadId(),previousPosition:1,newPosition:1} : {total:0,entries:[],userEntry:null};
      const amount = Math.min(100, Number(urlObj.searchParams.get('amount') || 20) || 20);
      const skip = Math.max(0, Number(urlObj.searchParams.get('skip') || 0) || 0);
      if (requestMethod === 'POST') {
        const preEntries = await getTrackEntries(trackId, 500).catch(()=>[]);
        log('info','[NET202] /leaderboard POST intercepted',{trackId});
        const mirrorMeta = await mirrorRaceResult(urlObj.toString(), body);
        const postEntries = mirrorMeta?.leaderboardChanged ? await getTrackEntries(trackId, 500, true).catch(()=>reconcileTrackEntriesWithLocal(trackId,preEntries,500)) : mirrorMeta?.localSaved ? await getTrackEntries(trackId,500).catch(()=>reconcileTrackEntriesWithLocal(trackId,preEntries,500)) : reconcileTrackEntriesWithLocal(trackId,preEntries,500);
        // The native API accepts an upload ID alone when placement is unknown.
        if(!readTrackSnapshotCache(trackId))return safeRecordingId(mirrorMeta?.uploadId)||nextUploadId();
        const oldIndex = preEntries.findIndex((e)=>String(e.accountId||e.userId||'')===String(mirrorMeta?.accountId||''));
        const newIndex = postEntries.findIndex((e)=>String(e.accountId||e.userId||'')===String(mirrorMeta?.accountId||''));
        if(newIndex<0&&oldIndex<0)return safeRecordingId(mirrorMeta?.uploadId)||nextUploadId();
        const safeNewPosition=newIndex>=0?newIndex+1:oldIndex+1;
        return { uploadId:safeRecordingId(mirrorMeta?.uploadId) || nextUploadId(), previousPosition:oldIndex < 0 ? safeNewPosition : oldIndex+1, newPosition:safeNewPosition };
      }
      hinted.userTokenHash = urlObj.searchParams.get('userTokenHash') || hinted.userTokenHash || '';
      const accountId = await accountIdFromPayload(hinted, guestAccountId);
      const onlyVerified=urlObj.searchParams.get('onlyVerified')==='true';
      const loadedEntries = await getTrackEntries(trackId, 500).catch(()=>[]);
      const fullEntries=visibleTrackEntries(localTrackDisplayEntries(trackId,loadedEntries,accountId,Boolean(readTrackSnapshotCache(trackId))),onlyVerified,accountId);
      const mineIndex = fullEntries.findIndex((e)=>String(e.accountId||e.userId||'')===String(accountId||''));
      const page = enrichLegacyLeaderboardEntries(fullEntries.slice(skip,skip+amount));
      const mine = mineIndex < 0 ? null : fullEntries[mineIndex];
      return { total:fullEntries.length, entries:page, userEntry:mine ? {position:mineIndex+1,frames:safePositiveInt(mine.frames||mine.raceTimeFrames,1),id:safeRecordingId(mine.id||mine.uploadId)||buildRecordingId(mine)} : null };
    }

    if (urlObj.pathname === '/recordings' || urlObj.pathname === '/v6/recordings') {
      if (String(method).toUpperCase() === 'POST') {
        const payload = parsePayload(body) || {};
        const recId = safeRecordingId(payload.recordingId || payload.id || payload.uploadId) || nextUploadId();
        const recData = normalizeReplayPayloadString(String(payload.recording || payload.replay || payload.replayData || payload.data || ''));
        const frames = safePositiveInt(payload.frames || payload.numberOfFrames || payload.raceTimeFrames || 1, 1);
        const recColors = String(payload.carColors || payload.CarColors || localStorage.getItem(LAST_ACTIVE_COLORS_KEY) || '').slice(0,64) || null;
        const recCarId = cleanCarId(payload.carId || payload.car || payload.carName || localStorage.getItem(LAST_ACTIVE_CAR_ID_KEY) || '') || null;
        const recCarStyle = String(payload.carStyle || payload.car_style || localStorage.getItem('polytrack-0.6.2-last-active-car-style') || '') || null;
        writeRecordingStore(recId, { recording: recData, frames, verifiedState: Number(payload.verifiedState||0)||0, carColors: recColors || undefined, carId: recCarId || undefined, carStyle: recCarStyle || undefined });
        log('info','[FB211] recordings POST normalized',{recordingId:recId,frames,bytes:recData.length,carColors:recColors,carId:recCarId,carStyle:recCarStyle});
        try {
          const d = await db();
          const q = await d.collection(COLLECTIONS.raceResults).where('uploadId','==',recId).limit(10).get();
          await Promise.all((q.docs||[]).map((doc)=>doc.ref.set({ replay: recData, raceTimeFrames: frames, carColors: recColors || doc.data()?.carColors || null, carId: recCarId || doc.data()?.carId || null, carStyle: recCarStyle || doc.data()?.carStyle || null }, { merge:true })));
          log('info','[FB212] recordings POST upserted',{recordingId:recId,matched:(q.docs||[]).length});
        } catch (error) {
          log('warn','[FB412] recordings POST firestore upsert failed', String(error && (error.message || error)));
        }
        return { success:true, recordingId:recId };
      }
      const rawIds = [...urlObj.searchParams.getAll('ids'),...urlObj.searchParams.getAll('recordingIds')];
      const ids = rawIds.flatMap((value)=>String(value||'').split(',')).map((value)=>safeRecordingId(value)).filter(Boolean);
      return readNativeRecordings(ids);
    }

    if (urlObj.pathname === '/verifyRecordings' || urlObj.pathname === '/v6/verifyRecordings') return {unverifiedRecordings:[],exhaustive:true,estimatedRemaining:0};
    if (urlObj.pathname === '/iceServers' || urlObj.pathname === '/v6/iceServers') return resolveMultiplayerIceServers();

    return { ok: true };
  }

  function parsePayload(raw){
    if (!raw) return null;
    if (typeof raw === 'object' && !(raw instanceof ArrayBuffer) && !(raw instanceof Uint8Array)) {
      if (typeof FormData !== 'undefined' && raw instanceof FormData) {
        const out = {};
        for (const [k,v] of raw.entries()) out[k] = typeof v === 'string' ? v : String(v);
        for (const key of Object.keys(out)) if (REPLAY_FIELD_RE.test(key)) out[key] = normalizeReplayPayloadString(out[key]);
        return out;
      }
      if (raw instanceof URLSearchParams) {
        const out = {};
        for (const [k,v] of raw.entries()) out[k] = REPLAY_FIELD_RE.test(k) ? normalizeReplayPayloadString(v) : v;
        return out;
      }
      const out = { ...raw };
      for (const key of Object.keys(out)) if (REPLAY_FIELD_RE.test(key)) out[key] = normalizeReplayPayloadString(out[key]);
      return out;
    }
    try {
      const decoded = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      if (decoded.includes('=') && !decoded.trim().startsWith('{')) {
        const form = parseFormEncodedPayload(decoded);
        if (Object.keys(form).length) return form;
      }
      const json = JSON.parse(decoded);
      if (json && typeof json === 'object') {
        for (const key of Object.keys(json)) if (REPLAY_FIELD_RE.test(key)) json[key] = normalizeReplayPayloadString(json[key]);
      }
      return json;
    } catch { return null; }
  }

  function localPersonalBestMs(trackId,accountId){
    let best=Infinity;
    for(const row of readLocalRaceRows()){
      if(String(row.trackId||'')!==String(trackId||'')||String(row.accountId||row.userId||'')!==String(accountId||''))continue;
      const value=canonicalRaceTimeMs(row);
      if(value>0)best=Math.min(best,value);
    }
    return Number.isFinite(best)?best:0;
  }

  async function mirrorRaceResult(url, body){
    const payload = parsePayload(body); if (!payload) return null;
    const accountId = await accountIdFromPayload(payload, guestAccountId);
    const trackId = String(payload.trackId || '').slice(0,80);
    let name = sanitizeDisplayName(payload.nickname || localStorage.getItem(LAST_ACTIVE_NAME_KEY) || 'Player');
    const known = getLastKnownName(accountId);
    if ((!name || name === 'Deleted') && known) name = known;
    name = await enforceSafeDisplayName(name, accountId);
    setLastKnownName(accountId, name);
    try { localStorage.setItem('polytrack-0.6.2-active-account-id', accountId); } catch {}
    const frames = safePositiveInt(payload.frames || payload.raceTimeFrames || payload.timeMs, 0);
    const timeMs = Math.max(0,Math.round(Number(payload.timeMs||frames||0)||0));
    const replayData = normalizeReplayPayloadString(payload.recording || '');
    const carStyle = __pt062NormalizeStyle(payload.carStyle || getDefaultCarStyle());
    const countryCode = typeof payload.countryCode === 'string' ? payload.countryCode.slice(0,8) : null;
    const mirrorSig = `${accountId}|${trackId}|${frames}|${replayData.length}`;
    if (mirrorSig === lastMirrorSig && Date.now() - lastMirrorAt < 4000) {
      log('info','Skipped duplicate race mirror',{accountId,trackId,timeMs});
      return {accountId,trackId,uploadId:safeRecordingId(payload.uploadId)||null,timeMs,frames,name,carStyle};
    }
    if (!accountId || !trackId || !replayData || !Number.isSafeInteger(frames) || frames <= 0) {
      log('warn','Skipped race mirror due to invalid payload',{accountId:!!accountId,trackId:!!trackId,timeMs});
      return {accountId,trackId,uploadId:null,timeMs,frames,name,carStyle};
    }
    const createdAt = Date.now();
    let dailyRecorded = false;
    const uploadId = nextUploadId();
    const resultDocId = `${accountId}_${trackId}`;
    const localAccountCreatedAt=readLocalRaceRows().filter((row)=>cleanUserId(row.accountId||row.userId)===accountId).reduce((old,row)=>{const value=Number(row.accountCreatedAt||row.createdAt||0)||0;return value>0?Math.min(old||Infinity,value):old;},0);
    const raceRow = {accountId,ownerUid:'',trackId,name,nickname:name,countryCode,timeMs,replay:replayData,replayHash:await sha256Hex(replayData),carStyle,totalPlaytimeMs:Math.round(currentPlaytimeMs()),raceTimeFrames:frames,frames,uploadId,verified:false,verifiedState:0,pbAt:createdAt,createdAt,accountCreatedAt:localAccountCreatedAt||createdAt,updatedAt:createdAt,source:String(url||'').slice(0,500)};
    __pt062RememberStyle(accountId,carStyle);
    log('info','[FB210] mirror payload normalized',{accountId,trackId,timeMs,frames,uploadId,name,carStyle,hasReplay:true,replayBytes:replayData.length});
    const warmTrack=readTrackSnapshotCache(trackId);
    const warmBest=(warmTrack?.entries||[]).find((entry)=>String(entry.accountId||entry.userId||'')===accountId);
    const warmBestMs=canonicalRaceTimeMs(warmBest);
    const localBestMs=localPersonalBestMs(trackId,accountId);
    const knownBestMs=Math.min(...[warmBestMs,localBestMs].filter((value)=>value>0));
    // Equality can be the game re-submitting the same local PB before it reached Firebase.
    // Only a strictly faster known result proves this submission cannot improve the cloud PB.
    if(Number.isFinite(knownBestMs)&&knownBestMs<timeMs){
      recordDailyActivity(trackId,timeMs,false,0);
      lastMirrorSig=mirrorSig;
      lastMirrorAt=Date.now();
      log('info','[CACHE210] Local PB proves this is not an improvement; skipped Firebase verification',{accountId,trackId,timeMs,currentBestMs:knownBestMs,source:localBestMs>0?'local-race-history':'track-cache',readsSaved:'up to 2'});
      return {accountId,trackId,uploadId:safeRecordingId(warmBest?.id||warmBest?.uploadId)||null,timeMs,frames,name,carStyle,saved:false,cacheVerified:true};
    }
    const priorLocal=readLocalRaceRows().filter((row)=>String(row.accountId||row.userId||'')===accountId&&String(row.trackId||'')===trackId).sort((a,b)=>Number(a.timeMs||Infinity)-Number(b.timeMs||Infinity))[0]||null;
    addLocalRaceRow(raceRow);
    writeRecordingStore(uploadId,{recording:replayData,frames,verifiedState:0,carStyle});
    try {
      const d = await db();
      name = await resolveManualNameOverride(d,accountId,name);
      raceRow.name = name;
      raceRow.nickname = name;
      setLastKnownName(accountId,name);
      const ownerUid = window.firebase.auth().currentUser?.uid || '';
      raceRow.ownerUid = ownerUid;
      const ref = d.collection(COLLECTIONS.raceResults).doc(resultDocId);
      const profileRef = d.collection(COLLECTIONS.profilesPublic).doc(accountId);
      const localPbFloor=new Set(readLocalRaceRows().filter((row)=>cleanUserId(row.accountId||row.userId)===accountId).map((row)=>String(row.trackId||'')).filter(Boolean)).size;
      const overallPbFloor=Number(readOverallSnapshotCache()?.entries?.find((entry)=>cleanUserId(entry.userId||entry.accountId)===accountId)?.raceCount||0)||0;
      let savedRow = raceRow;
      let saved = false;
      let previousBestMs = 0;
      let nextPbCount = 0;
      await d.runTransaction(async (tx)=>{
        const currentSnap = await tx.get(ref);
        const profileSnap = await tx.get(profileRef);
        const current = currentSnap.exists ? (currentSnap.data() || {}) : null;
        assertCloudOwner(accountId,ownerUid,current,profileSnap.exists?profileSnap.data():null);
        previousBestMs = canonicalRaceTimeMs(current);
        if (current && previousBestMs > 0 && previousBestMs <= timeMs) {
          savedRow = current;
          return;
        }
        const profile=profileSnap.exists?(profileSnap.data()||{}):{};
        // Existing profile creation time is immutable. Local history can seed it only once.
        raceRow.accountCreatedAt=profileSnap.exists&&Number(profile.accountCreatedAt||0)>0
          ? Number(profile.accountCreatedAt)
          : Math.min(...[Number(localAccountCreatedAt||0),createdAt].filter((value)=>value>0));
        nextPbCount=profileSnap.exists?(Number.isSafeInteger(profile.pbCount)?Math.min(1000000,profile.pbCount+1):Math.min(79,Math.max(localPbFloor,overallPbFloor,1))):1;
        raceRow.pbCount=nextPbCount;
        raceRow.totalPlaytimeMs=Math.max(raceRow.totalPlaytimeMs,Math.max(0,Number(profile.totalPlaytimeMs||0)||0));
        tx.set(ref,{...raceRow,ingestedAt:window.firebase.firestore.FieldValue.serverTimestamp()},{merge:false});
        tx.set(profileRef,{accountId,ownerUid,name,nickname:name,countryCode,carStyle,isVerifier:false,pbCount:nextPbCount,totalPlaytimeMs:raceRow.totalPlaytimeMs,accountCreatedAt:raceRow.accountCreatedAt,latestPbAt:Math.max(Number(profile.latestPbAt||0),createdAt),updatedAt:Date.now()},{merge:true});
        saved = true;
      });
      // A receipt is written only after Firebase has committed or confirmed this exact PB.
      rememberConfirmedLocalPb(accountId,savedRow);
      const resolvedUploadId = safeRecordingId(savedRow.uploadId) || uploadId;
      if (saved) {
        addLocalRaceRow(raceRow);
        writeRecordingStore(uploadId,{recording:replayData,frames,verifiedState:0,carStyle});
      } else if (savedRow.replay) {
        writeRecordingStore(resolvedUploadId,{recording:savedRow.replay,frames:savedRow.frames||savedRow.raceTimeFrames,verifiedState:savedRow.verifiedState||0,carStyle:savedRow.carStyle});
      }
      const sourceRow={...savedRow,accountId,userId:accountId,trackId,name:safeDisplayName(savedRow.nickname||savedRow.name||name,accountId),nickname:safeDisplayName(savedRow.nickname||savedRow.name||name,accountId),carStyle:__pt062NormalizeStyle(savedRow.carStyle||carStyle)};
      const sourceBestMs=canonicalRaceTimeMs(sourceRow);
      const cachedBeforeRepair=readTrackSnapshotCache(trackId);
      const cachedSourceRow=(cachedBeforeRepair?.entries||[]).find((entry)=>String(entry.accountId||entry.userId||'')===accountId);
      const cachedSourceMs=canonicalRaceTimeMs(cachedSourceRow);
      // Only a demonstrated mismatch needs repair. Equality is not a reason to scan the whole track.
      const leaderboardRepairNeeded=sourceBestMs>0&&cachedSourceMs!==sourceBestMs;
      // The PB is saved separately. Only complete source reads replace shared track snapshots.
      const pbImprovementMs = saved && previousBestMs > timeMs ? previousBestMs - timeMs : 0;
      const dailyActivity = recordDailyActivity(trackId,timeMs,saved,pbImprovementMs);
      dailyRecorded = true;
      lastMirrorSig = mirrorSig;
      lastMirrorAt = Date.now();
      const profileSignature=`${accountId}|${name}|${countryCode||''}|${carStyle}`;
      const priorProfileSignature=localStorage.getItem('polytrack-0.6.2-profile-signature-v1')||'';
      if(saved){
        localStorage.setItem('polytrack-0.6.2-profile-signature-v1',profileSignature);
      }else if(profileSignature!==priorProfileSignature){
        log('info','[FB202] profiles_public.set start',{accountId});
        try {
          await d.collection(COLLECTIONS.profilesPublic).doc(accountId).set({accountId,ownerUid,name,nickname:name,countryCode,carStyle,isVerifier:false,updatedAt:createdAt},{merge:true});
          localStorage.setItem('polytrack-0.6.2-profile-signature-v1',profileSignature);
        } catch (profileError) {
          log('warn','[FB402] Profile update denied; continuing PB sync',String(profileError&&(profileError.message||profileError)));
        }
      }
      const postRaceTasks = [];
      if (dailyActivity?.shouldCloudSync) postRaceTasks.push(syncDailyActivity(d,accountId,ownerUid,trackId,name,timeMs,saved,pbImprovementMs).catch((error)=>log('warn','[STREAK400] Daily activity sync failed',String(error&&(error.message||error)))));
      if (saved || leaderboardRepairNeeded) {
        if(!saved)log('info','[FB205] PB source is current; requesting an authoritative track rebuild',{accountId,trackId,timeMs:sourceBestMs,cachedTimeMs:cachedSourceMs||null});
        postRaceTasks.push(sendRankedNotification(resultDocId,trackId));
      }
      if (saved) {
        postRaceTasks.push(syncExactCarPreview(d,accountId,ownerUid,carStyle));
      }
      await Promise.all(postRaceTasks);
      try {
        localStorage.setItem(LAST_ACTIVE_NAME_KEY, name);
        localStorage.setItem('polytrack-0.6.2-last-active-car-style',carStyle);
      } catch {}
      log('info','[FB299] Race mirrored to Firestore',{accountId,trackId,timeMs,name,uploadId:resolvedUploadId,saved});
      if(saved){
        writeJsonStorage(OVERALL_PB_DIRTY_KEY,{at:Date.now(),trackId});
        overallLoadState.nextRefreshAt=Date.now();
        // PB completion never opens UI. The next explicit Ranked open consumes the dirty flag.
      }
      return {accountId,trackId,uploadId:resolvedUploadId,timeMs,frames,name,carStyle,saved,leaderboardChanged:saved||leaderboardRepairNeeded};

    } catch (error) {
      const localPb=!priorLocal || timeMs<Number(priorLocal.timeMs||Infinity);
      if (!dailyRecorded) recordDailyActivity(trackId,timeMs,localPb,localPb&&priorLocal?Math.max(0,Number(priorLocal.timeMs||0)-timeMs):0);
      addLocalRaceRow(raceRow);
      writeRecordingStore(uploadId,{recording:replayData,frames,verifiedState:0,carStyle});
      const cachedTrack=readTrackSnapshotCache(trackId);
      const localEntries=computeTrackTopEntries([...(cachedTrack?.entries||[]).map((entry)=>({...entry,trackId})),raceRow],trackId,500);
      writeTrackSnapshotCache(trackId,localEntries,cachedTrack?.serverUpdatedAt||0,{source:'local'});
      log('error','[FB499] Race mirror failed; cached locally',{error:String(error&&(error.message||error)),trackId,accountId});
      const permissionBlocked=/permission|insufficient/i.test(String(error&&(error.message||error)));
      if(error?.code==='account-session-conflict')showCloudOwnerConflict();
      else scheduleLocalPbCloudReconcile(accountId,permissionBlocked?600000:15000);
      return {accountId,trackId,uploadId,timeMs,frames,name,carStyle,saved:false,localSaved:true};
    }
  }


  function localBestRowsForAccount(accountId){
    const safeId=cleanUserId(accountId);
    const bestByTrack=new Map();
    for(const row of readLocalRaceRows()){
      if(cleanUserId(row?.accountId||row?.userId||'')!==safeId)continue;
      const trackId=String(row?.trackId||'').slice(0,80);
      const timeMs=canonicalRaceTimeMs(row);
      if(!trackId||timeMs<=0)continue;
      const current=bestByTrack.get(trackId);
      if(!current||timeMs<canonicalRaceTimeMs(current))bestByTrack.set(trackId,{...row,accountId:safeId,userId:safeId,trackId,timeMs});
    }
    return Array.from(bestByTrack.values()).sort((a,b)=>String(a.trackId).localeCompare(String(b.trackId))).slice(0,500);
  }

  function localPbSyncSignature(row){
    return JSON.stringify([String(row.trackId||''),canonicalRaceTimeMs(row),String(row.replayHash||'')]);
  }

  function rememberConfirmedLocalPb(accountId,row){
    const state=readJsonStorage(LOCAL_PB_RECONCILE_STATE_KEY,{})||{};
    const prior=state[accountId]||{};
    const confirmed={...(prior.confirmed||{}),[String(row.trackId)]:localPbSyncSignature(row)};
    state[accountId]={...prior,confirmed};
    writeJsonStorage(LOCAL_PB_RECONCILE_STATE_KEY,state);
  }

  function scheduleLocalPbCloudReconcile(accountId,delay=900){
    const safeId=cleanUserId(accountId);
    if(!safeId)return;
    clearTimeout(localPbReconcileTimer);
    localPbReconcileTimer=setTimeout(()=>reconcileLocalPersonalBestsToCloud(safeId).catch((error)=>log('warn','[SYNC409] Local PB reconciliation failed',String(error&&(error.message||error)))),Math.max(0,delay));
  }

  async function reconcileLocalPersonalBestsToCloud(accountId){
    const safeId=cleanUserId(accountId);
    let localRows=localBestRowsForAccount(safeId);
    if(!safeId||!localRows.length)return {checked:0,uploaded:0,repaired:0};
    const fingerprint=localRows.map((row)=>`${row.trackId}:${canonicalRaceTimeMs(row)}:${String(row.replayHash||'').slice(0,16)}`).join('|');
    const state=readJsonStorage(LOCAL_PB_RECONCILE_STATE_KEY,{})||{};
    if(state[safeId]?.fingerprint===fingerprint)return {checked:localRows.length,uploaded:0,repaired:0,cached:true};
    localRows=localRows.filter(row=>state[safeId]?.confirmed?.[row.trackId]!==localPbSyncSignature(row));
    if(!localRows.length)return {checked:0,uploaded:0,repaired:0,cached:true};
    if(localPbReconcilePromise)return localPbReconcilePromise;
    localPbReconcilePromise=(async()=>{
      const d=await db();
      const uid=window.firebase.auth().currentUser?.uid||'';
      if(cloudOwnerConflicts.get(safeId)===uid)return {checked:0,uploaded:0,repaired:0,accountConflict:true};
      const cloudByTrack=new Map();
      for(const row of localRows){
        const doc=await d.collection(COLLECTIONS.raceResults).doc(safeId+'_'+row.trackId).get({source:'server'});
        if(doc.metadata?.fromCache)throw new Error('PB confirmation requires a server response');
        if(doc.exists){try{assertCloudOwner(safeId,uid,doc.data());}catch(error){showCloudOwnerConflict();return {checked:cloudByTrack.size,uploaded:0,repaired:0,accountConflict:true};}cloudByTrack.set(row.trackId,doc.data()||{});}
      }
      let uploaded=0;
      let repaired=0;
      let adopted=0;
      let failed=0;
      log('info','[SYNC200] Checking saved local PBs against cloud',{accountId:safeId,localTracks:localRows.length,cloudTracks:cloudByTrack.size});
      for(const localRow of localRows){
        const trackId=String(localRow.trackId||'');
        const localMs=canonicalRaceTimeMs(localRow);
        const cloudRow=cloudByTrack.get(trackId)||null;
        const cloudMs=canonicalRaceTimeMs(cloudRow);
        if(cloudMs>0&&cloudMs<localMs){
          addLocalRaceRow({...cloudRow,accountId:safeId,userId:safeId,trackId});
          rememberConfirmedLocalPb(safeId,cloudRow);
          adopted++;
          continue;
        }
        if(!cloudRow||!cloudMs||localMs<cloudMs){
          const stored=readRecordingStore([safeRecordingId(localRow.uploadId||localRow.id)])[0];
          const replay=normalizeReplayPayloadString(localRow.replay||localRow.recording||stored?.recording||'');
          if(!replay){failed++;log('warn','[SYNC404] Saved PB has no replay and cannot be uploaded',{trackId,timeMs:localMs});continue;}
          const result=await mirrorRaceResult('local-pb-reconcile',{...localRow,accountId:safeId,userId:safeId,trackId,timeMs:localMs,frames:safePositiveInt(localRow.frames||localRow.raceTimeFrames||localMs,1),recording:replay,nickname:localRow.nickname||localRow.name||getLastKnownName(safeId)||'Player',carStyle:localRow.carStyle||stored?.carStyle||getDefaultCarStyle()});
          if(result?.saved){
            const authoritative={...localRow,accountId:safeId,userId:safeId,trackId,timeMs:localMs,replay};
            cloudByTrack.set(trackId,authoritative);
            uploaded++;
          } else failed++;
          continue;
        }
        rememberConfirmedLocalPb(safeId,localRow);
        // Equal cloud and local PBs need no reads. The Worker owns aggregate repair,
        // and the production cutover rebuild covers migrated beta records.
      }
      if(!failed){
        const latest=readJsonStorage(LOCAL_PB_RECONCILE_STATE_KEY,{})||{};
        const currentRows=localBestRowsForAccount(safeId);
        const currentFingerprint=currentRows.map(row=>row.trackId+':'+canonicalRaceTimeMs(row)+':'+String(row.replayHash||'').slice(0,16)).join('|');
        latest[safeId]={...(latest[safeId]||{}),fingerprint:currentRows.every(row=>latest[safeId]?.confirmed?.[row.trackId]===localPbSyncSignature(row))?currentFingerprint:null,completedAt:Date.now(),tracks:currentRows.length};
        writeJsonStorage(LOCAL_PB_RECONCILE_STATE_KEY,latest);
      }
      if(uploaded||repaired){
        writeJsonStorage(OVERALL_PB_DIRTY_KEY,{at:Date.now(),reason:'local-pb-reconcile'});
        overallLoadState.nextRefreshAt=Date.now();
      }
      log('info','[SYNC299] Saved local PB reconciliation complete',{accountId:safeId,checked:localRows.length,uploaded,repaired,adopted,failed});
      return {checked:localRows.length,uploaded,repaired,adopted,failed};
    })();
    try{return await localPbReconcilePromise;}
    finally{localPbReconcilePromise=null;}
  }

  function hookLegacyNetworking(){
    const originalFetch = window.fetch.bind(window);
    window.fetch = async function(url, options={}){
      const method = String(options.method || 'GET').toUpperCase();
      const rawUrl = typeof url === 'string' ? url : String(url || '');
      const urlObj = parseTarget(rawUrl);
      if (shouldMock(urlObj)) {
        log('info','[NET101] fetch mock intercept',{url:rawUrl,method});
        const payload = await mockPayload(urlObj, method, options.body);
        return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(url, options);
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, ...rest){
      this.__extMethod = String(method || 'GET').toUpperCase();
      this.__extUrl = String(url || '');
      this.__extUrlObj = parseTarget(this.__extUrl);
      this.__extMock = shouldMock(this.__extUrlObj);
      this.__extMockDynamic = this.__extMock;
      if (this.__extMock && !this.__extMockDynamic) {
        const payload = JSON.stringify(makeUserPayload());
        this.__extBlobUrl = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
        return originalOpen.call(this, 'GET', this.__extBlobUrl, ...rest);
      }
      return originalOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function(body){
      if (this.__extMockDynamic) {
        log('info','[NET102] xhr dynamic mock intercept',{url:this.__extUrl,method:this.__extMethod});
        mockPayload(this.__extUrlObj, this.__extMethod, body).then((payload)=>{
          this.__extBlobUrl = URL.createObjectURL(new Blob([JSON.stringify(payload)], { type: 'application/json' }));
          originalOpen.call(this, 'GET', this.__extBlobUrl, true);
          this.addEventListener('loadend', () => { if (this.__extBlobUrl) URL.revokeObjectURL(this.__extBlobUrl); }, { once: true });
          originalSend.call(this, null);
        }).catch((error)=>{
          log('error','[NET500] Firebase bridge request failed; Kodub fallback blocked',String(error&&(error.message||error)));
          const isLeaderboardPost=this.__extMethod==='POST'&&/\/leaderboard$/.test(this.__extUrlObj?.pathname||'');
          const payload=isLeaderboardPost
            ? {uploadId:nextUploadId(),previousPosition:1,newPosition:1}
            : {ok:false,error:'Firebase bridge request failed'};
          this.__extBlobUrl=URL.createObjectURL(new Blob([JSON.stringify(payload)],{type:'application/json'}));
          originalOpen.call(this,'GET',this.__extBlobUrl,true);
          this.addEventListener('loadend',()=>{if(this.__extBlobUrl)URL.revokeObjectURL(this.__extBlobUrl);},{once:true});
          originalSend.call(this,null);
        });
        return;
      }
      if (this.__extMock) {
        this.addEventListener('loadend', () => { if (this.__extBlobUrl) URL.revokeObjectURL(this.__extBlobUrl); }, { once: true });
        return originalSend.call(this, null);
      }
      return originalSend.call(this, body);
    };
  }
  function triggerRankedButtonSpawn(button){
    if (!button || !button.isConnected) return;
    const now = Date.now();
    if (now - lastRankedSpawnAt < 220) return;
    lastRankedSpawnAt = now;
    window.__polytrackRankingsAnimated = true;
    button.classList.remove('ranked-ready','ranked-waiting');
    button.classList.remove('button-spawn');
    void button.offsetWidth;
    button.classList.add('button-spawn');
    const finish = ()=>{ try { button.classList.remove('button-spawn','ranked-waiting'); button.classList.add('ranked-ready'); } catch {} };
    button.addEventListener('animationend',finish,{once:true});
    setTimeout(finish,560);
  }

  function cssTimeMs(value){
    const first = String(value || '0s').split(',')[0].trim();
    const amount = Number.parseFloat(first) || 0;
    return first.endsWith('ms') ? amount : amount * 1000;
  }
  function scheduleRankedSpawnFallback(button,container){
    if (rankedSpawnTimer) clearTimeout(rankedSpawnTimer);
    const nativeButtons = Array.from(container.querySelectorAll('button.button-image')).filter((el)=>el.id !== 'injectedRankingsBtn');
    const nativeEnd = nativeButtons.reduce((latest,el)=>{
      const style = getComputedStyle(el);
      return Math.max(latest,cssTimeMs(style.animationDelay)+cssTimeMs(style.animationDuration));
    },0);
    const delay = Math.min(460,Math.max(90,nativeEnd>0?nativeEnd+35:150));
    rankedSpawnTimer = setTimeout(()=>{
      rankedSpawnTimer=0;
      if (!rankingsSpawnedOnce && isElementVisible(container) && button.isConnected) {
        rankingsSpawnedOnce=true;
        triggerRankedButtonSpawn(button);
      }
    },delay);
  }

  let rankingsSyncHandle = 0;
  function scheduleRankingsSync(button, container){
    if (rankingsSyncHandle) {
      cancelAnimationFrame(rankingsSyncHandle);
      rankingsSyncHandle = 0;
    }
    const started = Date.now();
    const tick = ()=>{
      if (!button || !button.isConnected || !container || !container.isConnected) { rankingsSyncHandle = 0; return; }
      syncRankingsButtonAnimation(button, container);
      if (Date.now() - started > 2600 || rankingsSpawnedOnce) { rankingsSyncHandle = 0; return; }
      rankingsSyncHandle = requestAnimationFrame(tick);
    };
    rankingsSyncHandle = requestAnimationFrame(tick);
  }

  function syncRankingsButtonAnimation(button, container){
    if (!button || !container) return;
    const containerVisible = isElementVisible(container);
    if (containerVisible && !mainButtonsWereVisible) {
      mainButtonsWereVisible = true;
      mainButtonsShownAt = Date.now();
      nativeMenuButtonsAnimating = false;
      if(!rankingsSpawnedOnce){
        button.classList.remove('ranked-ready','button-spawn');
        button.classList.add('ranked-waiting');
        scheduleRankedSpawnFallback(button,container);
      }else{
        button.classList.remove('ranked-waiting','button-spawn');
        button.classList.add('ranked-ready');
      }
    } else if (!containerVisible) {
      mainButtonsWereVisible = false;
      nativeMenuButtonsAnimating = false;
      if (rankedSpawnTimer) { clearTimeout(rankedSpawnTimer); rankedSpawnTimer=0; }
      button.classList.remove('ranked-waiting','button-spawn');
      button.classList.add('ranked-ready');
      return;
    }
    if (!rankingsSpawnedOnce && !rankedSpawnTimer) scheduleRankedSpawnFallback(button,container);
  }

  function injectRankingsButton(){
    const container = document.querySelector('.main-buttons-container');
    if (!container) return;
    let button = document.getElementById('injectedRankingsBtn') || rankingsButtonRef;
    if (button && button.parentElement !== container) container.appendChild(button);
    if (!button) {
      button = document.createElement('button');
      button.id = 'injectedRankingsBtn';
      button.className = `button button-image ${isElementVisible(container)&&!rankingsSpawnedOnce?'ranked-waiting':'ranked-ready'}`;
      const existing = container.querySelectorAll('button.button-image');
      button.style.animationDelay = '0s';
      container.appendChild(button);
      button.addEventListener('click', (event)=>{ event.preventDefault(); event.stopPropagation(); openPanel(); });
      rankingsButtonRef = button;
      if (isElementVisible(container) && !rankingsSpawnedOnce) scheduleRankedSpawnFallback(button,container);
    }
    const rankedLabel = tRankedWord();
    if (button.dataset.rankedLabel !== rankedLabel || !button.querySelector('img[src="images/trophy.svg"]')) {
      button.dataset.rankedLabel = rankedLabel;
      button.innerHTML = `<img src="images/trophy.svg"><p>${rankedLabel}</p>`;
    }
    button.style.zIndex = '5';
    button.style.order = '6';
    if (container.dataset.rankedAnimationBound !== '1') {
      container.dataset.rankedAnimationBound = '1';
      container.addEventListener('animationstart',()=>{ const ranked=document.getElementById('injectedRankingsBtn'); if(ranked&&!rankingsSpawnedOnce&&!rankedSpawnTimer) scheduleRankedSpawnFallback(ranked,container); },true);
    }
    syncRankingsButtonAnimation(button, container);
    if (isElementVisible(container) && !rankingsSpawnedOnce) scheduleRankingsSync(button, container);
  }

  const MULTIPLAYER_STUN_SERVERS = Object.freeze([
    Object.freeze({urls:'stun:stun.l.google.com:19302'}),
    Object.freeze({urls:'stun:stun1.l.google.com:19302'})
  ]);
  const trackedPeerConnections=new Set();
  function installPeerConnectionRouteReporting(){
    const Native=window.RTCPeerConnection;
    if(typeof Native!=='function'||Native.__polytrackRouteWrapped)return;
    async function report(peer){
      try{
        const stats=await peer.getStats();
        let pair=null;
        stats.forEach((row)=>{
          if(row.type==='transport'&&row.selectedCandidatePairId)pair=stats.get(row.selectedCandidatePairId)||pair;
          if(row.type==='candidate-pair'&&row.state==='succeeded'&&(row.nominated||row.selected))pair=pair||row;
        });
        if(!pair)return;
        const local=stats.get(pair.localCandidateId); const remote=stats.get(pair.remoteCandidateId);
        const relay=local?.candidateType==='relay'||remote?.candidateType==='relay';
        const route=relay?(window.__polytrackMultiplayerNetwork?.mode==='backup'?'discord-relay':'public-relay'):'direct';
        const labels={direct:'Direct connected','public-relay':'Public relay connected','discord-relay':'Discord relay connected'};
        window.__polytrackSelectedConnectionRoute={route,label:labels[route],localCandidateType:local?.candidateType||'',remoteCandidateType:remote?.candidateType||'',protocol:local?.protocol||pair.protocol||'',selectedAt:Date.now()};
        window.dispatchEvent(new CustomEvent('polytrack-connection-route',{detail:window.__polytrackSelectedConnectionRoute}));
        syncMultiplayerRelayPanel();
      }catch{}
    }
    function Wrapped(configuration,...rest){
      window.__polytrackSelectedConnectionRoute=null;
      const peer=new Native(configuration,...rest);
      trackedPeerConnections.add(peer);
      const sync=()=>{
        const active=['new','connecting','connected'].includes(peer.connectionState)||['checking','connected','completed'].includes(peer.iceConnectionState);
        if(!active||peer.connectionState==='closed'||peer.iceConnectionState==='closed')trackedPeerConnections.delete(peer);
        window.__polytrackMultiplayerSessionActive=Array.from(trackedPeerConnections).some((item)=>!['closed','failed'].includes(item.connectionState));
        if(['connected','completed'].includes(peer.iceConnectionState)||peer.connectionState==='connected')setTimeout(()=>report(peer),100);
      };
      peer.addEventListener('connectionstatechange',sync);
      peer.addEventListener('iceconnectionstatechange',sync);
      return peer;
    }
    Wrapped.prototype=Native.prototype;
    Object.setPrototypeOf(Wrapped,Native);
    Wrapped.__polytrackRouteWrapped=true;
    window.RTCPeerConnection=Wrapped;
  }
  installPeerConnectionRouteReporting();
  let multiplayerIceServersPromise = null;
  let multiplayerIceServersRetryAt = 0;
  let multiplayerNetworkMessage = 'Automatic: Direct first, then relay fallback.';
  function normalizeIceServerList(value){
    const rows = Array.isArray(value) ? value : (Array.isArray(value?.iceServers) ? value.iceServers : []);
    return rows.flatMap((row)=>{
      if (!row || typeof row !== 'object') return [];
      const urls = Array.isArray(row.urls)
        ? row.urls.map((url)=>String(url || '').trim()).filter((url)=>/^(stun|turn|turns):/i.test(url)).slice(0,8)
        : String(row.urls || row.url || '').trim();
      if ((Array.isArray(urls) && !urls.length) || (!Array.isArray(urls) && !/^(stun|turn|turns):/i.test(urls))) return [];
      const server = {urls};
      if (typeof row.username === 'string' && row.username.length <= 256) server.username = row.username;
      if (typeof row.credential === 'string' && row.credential.length <= 512) server.credential = row.credential;
      return [server];
    }).slice(0,12);
  }
  function hasTurnServer(servers){
    return servers.some((server)=>{
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      return urls.some((url)=>/^turns?:/i.test(String(url || '')));
    });
  }
  function selectMultiplayerIceServers(configured){
    const expanded=[];
    for(const server of normalizeIceServerList(configured)){
      const urls=Array.isArray(server.urls)?server.urls:[server.urls];
      for(const url of urls){
        const row={urls:String(url||'')};
        if(server.username)row.username=server.username;
        if(server.credential)row.credential=server.credential;
        expanded.push(row);
      }
    }
    if(!expanded.length)return MULTIPLAYER_STUN_SERVERS.map((server)=>({...server}));
    const unique=[];
    const seen=new Set();
    for(const server of expanded){
      const key=String(server.urls||'').toLowerCase();
      if(!key||seen.has(key))continue;
      seen.add(key);unique.push(server);
    }
    const stun=unique.find((server)=>/^stun:/i.test(server.urls))||{...MULTIPLAYER_STUN_SERVERS[0]};
    const turn=unique.filter((server)=>/^turns?:/i.test(server.urls));
    const udp=turn.find((server)=>/^turn:/i.test(server.urls)&&!/transport=tcp/i.test(server.urls));
    const tcp=turn.find((server)=>/^turn:/i.test(server.urls)&&/transport=tcp/i.test(server.urls));
    const tls=turn.find((server)=>/^turns:/i.test(server.urls));
    const selected=[stun,udp,tcp,tls].filter(Boolean);
    for(const server of turn){
      if(selected.length>=4)break;
      if(!selected.some((row)=>row.urls===server.urls))selected.push(server);
    }
    return selected.slice(0,4);
  }
  async function fetchTurnBroker(url,options){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),10000);
    try{return await fetch(url,{...options,signal:controller.signal});}
    finally{clearTimeout(timer);}
  }
  function multiplayerBrokerUrl(){
    return typeof window.POLYTRACK_TURN_BROKER_URL === 'string'
      ? window.POLYTRACK_TURN_BROKER_URL.trim()
      : '';
  }
  async function resolveMultiplayerIceServers(){
    if(multiplayerIceServersPromise&&multiplayerIceServersRetryAt>0&&Date.now()>=multiplayerIceServersRetryAt)multiplayerIceServersPromise=null;
    if (multiplayerIceServersPromise) return multiplayerIceServersPromise;
    multiplayerIceServersPromise = (async()=>{
      let configured = normalizeIceServerList(window.POLYTRACK_ICE_SERVERS || window.POLYTRACK_TURN_CONFIG);
      let relayMode = configured.length ? 'configured' : '';
      const brokerUrl = multiplayerBrokerUrl();
      if (!configured.length && brokerUrl) {
        try {
          await db();
          const user=window.firebase?.auth?.().currentUser;
          if(!user) throw new Error('Firebase authentication is not ready');
          const idToken=await user.getIdToken(false);
          const backupCode=String(localStorage.getItem('polytrack-0.6.2-turn-backup-code')||'').trim().slice(0,192);
          const response = await fetchTurnBroker(brokerUrl,{
            method:'POST',
            cache:'no-store',
            credentials:'omit',
            referrerPolicy:'no-referrer',
            headers:{Accept:'application/json','Content-Type':'application/json',Authorization:`Bearer ${idToken}`},
            body:JSON.stringify(backupCode?{backupCode}:{})
          });
          if (!response.ok) {
            const problem=await response.json().catch(()=>({}));
            if(response.status===503&&problem.backupCodeRequired) throw new Error('Primary relay unavailable; add the Discord backup relay code in Settings');
            if(response.status===429) throw new Error('Relay request limit reached; wait one minute');
            throw new Error(`TURN broker returned ${response.status}`);
          }
          const payload=await response.json();
          configured = normalizeIceServerList(payload);
          relayMode=payload.mode==='backup'?'backup':'primary';
          log('info','[MP312] TURN relay credentials ready',{mode:relayMode,serverCount:configured.length});
        } catch (error) {
          multiplayerIceServersRetryAt=Date.now()+30000;
          setTimeout(()=>{if(multiplayerIceServersRetryAt&&Date.now()>=multiplayerIceServersRetryAt)multiplayerIceServersPromise=null;},30500);
          multiplayerNetworkMessage=String(error&&(error.message||error)) || 'Relay unavailable; direct connections only.';
          log('warn','[MP310] TURN credentials unavailable; direct connections only',String(error&&(error.message||error)));
        }
      }
      const servers = selectMultiplayerIceServers(configured);
      const turnAvailable = hasTurnServer(servers);
      if(turnAvailable)multiplayerIceServersRetryAt=0;
      if(turnAvailable) multiplayerNetworkMessage=relayMode==='backup'?'Discord relay fallback is available. Direct connection is still tried first.':'Public relay fallback is available. Direct connection is still tried first.';
      window.__polytrackMultiplayerNetwork = {turnAvailable,iceServerCount:servers.length,mode:turnAvailable?(relayMode||'relay'):'direct-only',message:multiplayerNetworkMessage};
      syncMultiplayerRelayPanel();
      if (!turnAvailable) log('warn','[MP311] No TURN relay configured; restrictive or cross-network NAT may fail','The secure TURN broker is unavailable or not configured.');
      return servers;
    })();
    return multiplayerIceServersPromise;
  }
  function multiplayerRelayStatus(){
    const selected=window.__polytrackSelectedConnectionRoute;
    if(selected?.label)return {label:selected.label,className:selected.route==='discord-relay'?'is-backup':selected.route==='direct'?'is-direct':'',message:`Selected ICE route: ${selected.route}. ${selected.protocol||''}`.trim()};
    const state=window.__polytrackMultiplayerNetwork;
    if(!state)return {label:'Automatic',className:'',message:multiplayerNetworkMessage};
    if(state.mode==='backup')return {label:'Backup available',className:'is-backup',message:state.message};
    if(state.turnAvailable)return {label:'Fallback available',className:'',message:state.message};
    return {label:'Direct only',className:'is-direct',message:state.message};
  }
  async function saveMultiplayerBackupCode(input,button){
    const value=String(input?.value||'').trim().slice(0,192);
    const prior=String(localStorage.getItem('polytrack-0.6.2-turn-backup-code')||'');
    const status=input?.closest('.sq-multiplayer-backup-drawer, .sq-settings-row')?.querySelector('.sq-backup-validation');
    if(!value){
      localStorage.removeItem('polytrack-0.6.2-turn-backup-code');
      multiplayerIceServersPromise=null;
      window.__polytrackMultiplayerNetwork=null;
      multiplayerNetworkMessage='Backup code removed. Direct and public relay remain available.';
      if(status)status.textContent='Backup code removed.';
      syncMultiplayerRelayPanel();
      if(button){button.textContent='Removed';setTimeout(()=>{if(button.isConnected)button.textContent='Save code';},1100);}
      return true;
    }
    if(button){button.disabled=true;button.textContent='Checking...';}
    if(status)status.textContent='Checking the code securely...';
    try{
      await db();
      const endpoint=multiplayerBrokerUrl();
      const user=window.firebase?.auth?.().currentUser;
      if(!endpoint||!user)throw new Error('Secure code validation is unavailable right now.');
      const token=await user.getIdToken();
      const response=await fetchTurnBroker(endpoint,{method:'POST',mode:'cors',cache:'no-store',referrerPolicy:'no-referrer',headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({backupCode:value,validateBackup:true})});
      const payload=await response.json().catch(()=>({}));
      if(response.status===429)throw new Error('Too many checks. Wait one minute and try again.');
      if(!response.ok)throw new Error('The backup code could not be checked right now.');
      if(payload.valid!==true){
        if(status)status.textContent=prior?'Incorrect code. Your previous valid code is still saved.':'Incorrect code. Nothing was saved.';
        if(button)button.textContent='Invalid code';
        return false;
      }
      localStorage.setItem('polytrack-0.6.2-turn-backup-code',value);
      multiplayerIceServersPromise=null;
      window.__polytrackMultiplayerNetwork=null;
      multiplayerNetworkMessage='Discord code saved. Backup credentials are used if the public relay service is unavailable.';
      if(status)status.textContent='Code verified. Discord backup is enabled.';
      syncMultiplayerRelayPanel();
      if(button)button.textContent='Verified';
      return true;
    }catch(error){
      multiplayerNetworkMessage=String(error&&(error.message||error))||'The backup code could not be checked.';
      if(status)status.textContent=multiplayerNetworkMessage;
      if(button)button.textContent='Try again';
      return false;
    }finally{
      if(button){button.disabled=false;setTimeout(()=>{if(button.isConnected&&!button.disabled)button.textContent='Save code';},1800);}
    }
  }
  function syncMultiplayerRelayPanel(){
    const root=document.querySelector('.multiplayer-ui');
    if(!root||!root.isConnected){document.body.classList.remove('sq-mp-dialog-active');return;}
    let panel=root.querySelector(':scope > .sq-multiplayer-relay');
    if(!panel){
      panel=document.createElement('section');
      panel.className='sq-multiplayer-relay';
      panel.setAttribute('aria-label','Multiplayer connection options');
      panel.innerHTML='<div class="sq-multiplayer-relay-head"><div><span class="sq-multiplayer-kicker">CONNECTION ROUTES</span><strong>Connection options</strong></div><span class="sq-multiplayer-status" role="status"></span><button class="sq-multiplayer-collapse" type="button" aria-expanded="true" aria-controls="sqMultiplayerRouteBody">Hide</button></div><div class="sq-multiplayer-route-body" id="sqMultiplayerRouteBody"><p class="sq-multiplayer-intro"><b>Just host or join.</b> Your browser selects a working route automatically.</p><div class="sq-multiplayer-paths"><div class="sq-multiplayer-path is-automatic"><span class="sq-route-number">1</span><div><b>Direct</b><span>Connects devices directly. Uses no relay quota.</span></div><em>AUTO</em></div><div class="sq-multiplayer-path is-automatic"><span class="sq-route-number">2</span><div><b>Public relay</b><span>Automatic fallback. No code needed.</span></div><em>AUTO</em></div><button class="sq-multiplayer-path sq-multiplayer-backup-toggle" type="button" aria-expanded="false" aria-controls="sqMultiplayerBackupDrawer"><span class="sq-route-number">3</span><div><b>Discord backup</b><span>Save the Discord code to enable backup when the public relay service is unavailable.</span></div><em class="sq-backup-state">SET UP</em></button></div><div class="sq-multiplayer-backup-drawer" id="sqMultiplayerBackupDrawer" hidden><div class="sq-backup-copy"><span class="sq-multiplayer-kicker">ENABLE BACKUP RELAY</span><b>Get the code from Discord, paste it here, then select Save.</b><span>The broker validates it securely. Incorrect codes are never stored.</span></div><div class="sq-multiplayer-code"><input type="password" maxlength="192" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Discord backup relay code" placeholder="Paste Discord code"><button class="button sq-multiplayer-reveal" type="button" aria-label="Show or hide backup code">Show</button><button class="button sq-multiplayer-save" type="button">Save code</button><a class="button sq-multiplayer-discord" href="https://discord.gg/DP2hM7RRhR" target="_blank" rel="noopener noreferrer">Open Discord</a></div><p class="sq-backup-validation" role="status" aria-live="polite"></p></div><p class="sq-multiplayer-note">Direct and relay candidates are evaluated automatically. The status above reports the route that actually connected.</p></div>';
      const input=panel.querySelector('input');
      const button=panel.querySelector('.sq-multiplayer-save');
      const reveal=panel.querySelector('.sq-multiplayer-reveal');
      const collapse=panel.querySelector('.sq-multiplayer-collapse');
      const body=panel.querySelector('.sq-multiplayer-route-body');
      const backupToggle=panel.querySelector('.sq-multiplayer-backup-toggle');
      const backupDrawer=panel.querySelector('.sq-multiplayer-backup-drawer');
      input.value=localStorage.getItem('polytrack-0.6.2-turn-backup-code')||'';
      button.addEventListener('click',(event)=>{event.preventDefault();saveMultiplayerBackupCode(input,button);});
      input.addEventListener('keydown',(event)=>{if(event.key==='Enter'){event.preventDefault();saveMultiplayerBackupCode(input,button);}});
      reveal.addEventListener('click',()=>{
        const showing=input.type==='text';
        input.type=showing?'password':'text';
        reveal.textContent=showing?'Show':'Hide';
        input.focus();
      });
      const setCollapsed=(collapsed)=>{
        panel.classList.toggle('is-collapsed',collapsed);
        body.hidden=collapsed;
        collapse.setAttribute('aria-expanded',String(!collapsed));
        collapse.textContent=collapsed?'Connection help':'Hide';
      };
      setCollapsed(localStorage.getItem('polytrack-0.6.2-multiplayer-route-collapsed')!=='0');
      collapse.addEventListener('click',()=>{
        const collapsed=!panel.classList.contains('is-collapsed');
        setCollapsed(collapsed);
        try{localStorage.setItem('polytrack-0.6.2-multiplayer-route-collapsed',collapsed?'1':'0');}catch{}
      });
      backupToggle.addEventListener('click',()=>{
        const open=backupDrawer.hidden;
        backupDrawer.hidden=!open;
        backupToggle.classList.toggle('is-open',open);
        backupToggle.setAttribute('aria-expanded',String(open));
        if(open)setTimeout(()=>input.focus(),0);
      });
      root.appendChild(panel);
    }
    const status=multiplayerRelayStatus();
    const backupSaved=Boolean(String(localStorage.getItem('polytrack-0.6.2-turn-backup-code')||'').trim());
    panel.classList.toggle('has-backup-code',backupSaved);
    const backupState=panel.querySelector('.sq-backup-state');
    if(backupState)backupState.textContent=backupSaved?'CODE SAVED':'SET UP';
    const activeMultiplayerScreen=root.querySelector(':scope > .join:not(.hidden), :scope > .host:not(.hidden)');
    panel.hidden=!activeMultiplayerScreen;
    document.body.classList.toggle('sq-mp-dialog-active',Boolean(activeMultiplayerScreen&&isElementVisible(root)));
    const statusElement=panel.querySelector('.sq-multiplayer-status');
    statusElement.className=`sq-multiplayer-status ${status.className}`.trim();
    statusElement.textContent=status.label;
    statusElement.title=status.message||status.label;
  }
  function multiplayerCode(){
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    return Array.from(bytes,(value)=>alphabet[value % alphabet.length]).join('');
  }

  class FirebaseSignalingSocket extends EventTarget {
    constructor(url){
      super();
      this.url = String(url || '');
      this.readyState = 0;
      this.bufferedAmount = 0;
      this.extensions = '';
      this.protocol = '';
      this.binaryType = 'blob';
      this.socketId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
      this.role = this.url.includes('/multiplayer/host') ? 'host' : 'join';
      this.session = '';
      this.unsubscribers = [];
      this.seenMessages = new Set();
      this.listeningTargets = new Set();
      this.sessionRefs = new Set();
      this.sendQueue = Promise.resolve();
      this._connect();
    }
    _emit(type,event){
      if((type==='message'||type==='open')&&this.readyState!==1)return;
      try { if (typeof this[`on${type}`] === 'function') this[`on${type}`](event); } catch (error) { setTimeout(()=>{ throw error; }); }
      this.dispatchEvent(event);
    }
    async _connect(){
      try {
        await db();
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this._emit('open',new Event('open'));
      } catch (error) { this._fail(error); }
    }
    async _listen(targetUid){
      if (this.listeningTargets.has(targetUid)) return;
      this.listeningTargets.add(targetUid);
      const d = await db();
      if(this.readyState!==1)return;
      const query = d.collection(COLLECTIONS.multiplayerMessages).where('targetUid','==',targetUid);
      const unsubscribe = query.onSnapshot((snapshot)=>{
        if(this.readyState!==1)return;
        for (const change of snapshot.docChanges()) {
          if (change.type !== 'added' || this.seenMessages.has(change.doc.id)) continue;
          const message = change.doc.data() || {};
          if (Number(message.expiresAt || 0) > 0 && Number(message.expiresAt) < Date.now()) { change.doc.ref.delete().catch(()=>{}); continue; }
          if (String(message.targetSocketId || '') !== this.socketId) continue;
          this.seenMessages.add(change.doc.id);
          if (message.payload?.session) this.sessionRefs.add(String(message.payload.session));
          this._emit('message',new MessageEvent('message',{data:JSON.stringify(message.payload || {})}));
          change.doc.ref.delete().catch(()=>{});
        }
      },(error)=>this._fail(error));
      if(this.readyState!==1)unsubscribe();else this.unsubscribers.push(unsubscribe);
    }
    async _relay(targetSocketId,targetUid,payload){
      const d = await db();
      if(this.readyState!==1)return;
      const senderUid = window.firebase.auth().currentUser?.uid || '';
      const messageRef=await d.collection(COLLECTIONS.multiplayerMessages).add({session:String(payload?.session||''),senderUid,targetUid,targetSocketId,payload,createdAt:Date.now(),expiresAt:Date.now()+2*60*1000});
      if(this.readyState!==1)await messageRef.delete().catch(()=>{});
    }
    async _handleHost(payload){
      const d = await db();
      if(this.readyState!==1)return;
      const uid = window.firebase.auth().currentUser?.uid || '';
      if (payload.type === 'ping') {
        this._emit('message',new MessageEvent('message',{data:JSON.stringify({type:'pong'})}));
        return;
      }
      if (payload.type === 'createInvite') {
        const inviteCode = multiplayerCode();
        const expiresAt = Date.now() + 30 * 60 * 1000;
        const censoredNickname = await enforceSafeDisplayName(payload.nickname || localStorage.getItem(LAST_ACTIVE_NAME_KEY) || 'Guest', uid);
        if(this.readyState!==1)return;
        if (this.inviteRef) this.inviteRef.delete().catch(()=>{});
        this.inviteRef = d.collection(COLLECTIONS.multiplayerInvites).doc(inviteCode);
        await this.inviteRef.set({inviteCode,hostUid:uid,hostSocketId:this.socketId,key:String(payload.key||''),hostNickname:censoredNickname,createdAt:Date.now(),expiresAt});
        if(this.readyState!==1){await this.inviteRef.delete().catch(()=>{});return;}
        await this._listen(uid);
        if(this.readyState!==1)return;
        this._emit('message',new MessageEvent('message',{data:JSON.stringify({type:'createInvite',inviteCode,key:String(payload.key||''),timeoutMilliseconds:30*60*1000,censoredNickname})}));
        return;
      }
      if (!payload.session) return;
      const sessionSnap = await d.collection(COLLECTIONS.multiplayerSessions).doc(String(payload.session)).get();
      if (!sessionSnap.exists) return;
      const session = sessionSnap.data() || {};
      await this._relay(session.joinSocketId,session.joinUid,{...payload,type:payload.type});
    }
    async _handleJoin(payload){
      const d = await db();
      if(this.readyState!==1)return;
      const uid = window.firebase.auth().currentUser?.uid || '';
      if (payload.inviteCode && !this.session) {
        const inviteCode = String(payload.inviteCode).trim().toUpperCase();
        const inviteSnap = await d.collection(COLLECTIONS.multiplayerInvites).doc(inviteCode).get({source:'server'});
        if(this.readyState!==1)return;
        const invite = inviteSnap.exists ? (inviteSnap.data() || {}) : null;
        if (!invite || Number(invite.expiresAt || 0) <= Date.now()) {
          this._emit('message',new MessageEvent('message',{data:JSON.stringify({type:'error',error:'ExpiredInvite'})}));
          this.close(1000,'Invite expired');
          return;
        }
        this.session = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
        this.sessionRefs.add(this.session);
        const createdAt=Date.now();
        const session = {session:this.session,inviteCode,hostUid:invite.hostUid,hostSocketId:invite.hostSocketId,joinUid:uid,joinSocketId:this.socketId,createdAt,expiresAt:createdAt+30*60*1000};
        await d.collection(COLLECTIONS.multiplayerSessions).doc(this.session).set(session);
        if(this.readyState!==1){await d.collection(COLLECTIONS.multiplayerSessions).doc(this.session).delete().catch(()=>{});return;}
        await this._listen(uid);
        const guestName = await enforceSafeDisplayName(payload.nickname||'Guest',uid);
        if(this.readyState!==1)return;
        const iceServers = await resolveMultiplayerIceServers();
        if(this.readyState!==1)return;
        await this._relay(invite.hostSocketId,invite.hostUid,{type:'joinInvite',session:this.session,offer:payload.offer,version:String(payload.version||'0.6.3'),mods:Array.isArray(payload.mods)?payload.mods:[],isModsVanillaCompatible:payload.isModsVanillaCompatible!==false,nickname:guestName,countryCode:typeof payload.countryCode==='string'?payload.countryCode:null,carStyle:__pt062NormalizeStyle(payload.carStyle||getDefaultCarStyle()),iceServers});
        return;
      }
      if (!this.session) return;
      const sessionSnap = await d.collection(COLLECTIONS.multiplayerSessions).doc(this.session).get();
      if (!sessionSnap.exists) return;
      const session = sessionSnap.data() || {};
      await this._relay(session.hostSocketId,session.hostUid,{...payload,type:payload.type||'iceCandidate',session:this.session});
    }
    send(data){
      if (this.readyState !== 1) throw new DOMException('WebSocket is not open','InvalidStateError');
      let payload;
      try { payload = JSON.parse(String(data)); } catch { return; }
      this.sendQueue = this.sendQueue
        .then(()=>this.readyState===1?(this.role === 'host' ? this._handleHost(payload) : this._handleJoin(payload)):undefined)
        .catch((error)=>this._fail(error));
    }
    _fail(error){
      if(this.readyState>=2)return;
      log('error','[MP400] Firebase signaling error',String(error&&(error.message||error)));
      this._emit('error',new Event('error'));
      this.close(1011,'Firebase signaling failed');
    }
    close(code=1000,reason=''){
      if (this.readyState >= 2) return;
      this.readyState = 2;
      for (const unsubscribe of this.unsubscribers.splice(0)) { try { unsubscribe(); } catch {} }
      if (this.inviteRef) this.inviteRef.delete().catch(()=>{});
      db().then((d)=>Promise.all(Array.from(this.sessionRefs,(session)=>d.collection(COLLECTIONS.multiplayerSessions).doc(session).delete().catch(()=>{})))).catch(()=>{});
      this.readyState = 3;
      this._emit('close',new CloseEvent('close',{code,reason,wasClean:code===1000}));
    }
  }
  FirebaseSignalingSocket.CONNECTING=0; FirebaseSignalingSocket.OPEN=1; FirebaseSignalingSocket.CLOSING=2; FirebaseSignalingSocket.CLOSED=3;

  function hookMultiplayerNetworking(){
    const NativeWebSocket = window.WebSocket;
    function PolytrackWebSocket(url,protocols){
      const target = String(url || '').trim();
      const normalized = target.toLowerCase();
      const isKodubMultiplayer = normalized.includes('vps.kodub.com') && (normalized.includes('/multiplayer/host') || normalized.includes('/multiplayer/join'));
      if (isKodubMultiplayer) {
        log('info','[MP100] Firebase multiplayer socket intercepted',{url:target});
        return new FirebaseSignalingSocket(target);
      }
      return protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url,protocols);
    }
    PolytrackWebSocket.prototype = NativeWebSocket.prototype;
    PolytrackWebSocket.CONNECTING=0; PolytrackWebSocket.OPEN=1; PolytrackWebSocket.CLOSING=2; PolytrackWebSocket.CLOSED=3;
    window.WebSocket = PolytrackWebSocket;
  }

  function install(){
    try {
      const migrationKey = 'polytrack-0.6.2-shortcuts-default-on-v2';
      if (localStorage.getItem(migrationKey) !== '1') {
        localStorage.setItem('polytrack-0.6.2-hotkeys-enabled','1');
        localStorage.setItem(migrationKey,'1');
      }
    } catch {}
    migrateUnsafeLocalNames();
    ensureStyles();
    applyUiPreferences();
    ensurePanel();
    hookLegacyNetworking();
    hookMultiplayerNetworking();
    ensureFirestoreBootstrap();
    injectRankingsButton();
    setUnofficialMessage();
    ensurePersistentInfoBranding();
    ensureStaticDiscordLink();
    syncNativeDiscordVisibility();

    ensureSettingsEnhancements();
    syncMultiplayerRelayPanel();
    ensureReturningPlayerNotice();
    ensureWeeklyTrackHighlight();
    decoratePersonalBestPodiums();
    syncIntegrityStateLabels();
  }

  function hideVerifiedOnlyToggle(){
    const candidates = Array.from(document.querySelectorAll('label,button,div,span'));
    for (const el of candidates) {
      const text = (el.textContent || '').trim().toLowerCase();
      if (text === 'verified only' || text.includes('verified only')) {
        el.style.display = 'none';
      }
    }
  }

  function runStatus(entry){
    // A replay checksum is not proof that the race obeyed the game physics.
    if(entry?.localPending===true)return 'local';
    if(entry?.runVerified===true)return 'verified';
    if(entry?.integrityVerified===true)return 'replay';
    return 'unchecked';
  }

  function matchNativeResult(rows,name,time){
    if(!name||!time)return null;
    const matches=rows.filter(row=>safeDisplayName(row.nickname||row.name||'',row.accountId||row.userId)===name&&canonicalRaceTimeMs(row)>0&&formatRaceTime(canonicalRaceTimeMs(row))===time);
    return matches.length===1?matches[0]:null;
  }

  const nativeFilterInitialized=new WeakSet(),nativeFilterScheduled=new WeakSet(),nativeFilterObserved=new WeakSet();
  function ensureNativeAllRunsDefault(host,filter=host?.querySelector?.('button.only-verified'),defer=queueMicrotask,reconcile=()=>requestAnimationFrame(reconcileUI)){
    if(!host||host.classList?.contains('sq-event-board')||!filter||filter.closest?.('.leaderboard-ui')!==host)return false;
    if(!nativeFilterObserved.has(filter)){
      filter.addEventListener('click',event=>{if(event.isTrusted){nativeFilterInitialized.add(filter);nativeFilterScheduled.delete(filter);filter.dataset.sqNativeFilterDefault='user';}},true);
      nativeFilterObserved.add(filter);
    }
    if(nativeFilterInitialized.has(filter)||nativeFilterScheduled.has(filter))return false;
    nativeFilterScheduled.add(filter);filter.dataset.sqNativeFilterDefault='pending';
    defer(()=>{
      nativeFilterScheduled.delete(filter);
      if(nativeFilterInitialized.has(filter)||!filter.isConnected||filter.disabled||filter.closest?.('.leaderboard-ui')!==host||host.classList?.contains('sq-event-board'))return;
      nativeFilterInitialized.add(filter);filter.dataset.sqNativeFilterDefault='all';
      if(!filter.classList?.contains('disabled')){filter.click();reconcile();}
    });
    return true;
  }

  function syncIntegrityStateLabels(){
    for(const state of document.querySelectorAll('.leaderboard-ui .verified-state')){
      const date=Array.from(state.childNodes).filter((node)=>node.nodeType===Node.TEXT_NODE).map((node)=>node.textContent||'').join('').trim();
      let label=state.querySelector('.sq-integrity-label');
      if(!label){label=document.createElement('span');label.className='sq-integrity-label';state.appendChild(label);}
      const status=state.dataset.sqRunStatus||'unchecked';
      state.classList.toggle('verified',status==='verified');
      state.classList.toggle('pending',status!=='verified');
      label.textContent=status==='verified'?'':status==='local'?'LOCAL PB':'WAITING';
      state.title=status==='verified'?'Run verified':status==='local'?'Your local PB. Position estimated from the loaded leaderboard; cloud confirmation pending.':'Waiting for physics review.';
      state.setAttribute('aria-label',(date?date+'. ':'')+state.title);
      const icon=state.querySelector('img');
      if(icon){icon.src=status==='verified'?'images/state_verified.svg':'images/state_pending.svg';icon.hidden=false;}
    }
  }

  function decorateNativeLeaderboardCosmetics(){
    const trackId=String(currentTrackLoadState?.trackId||'');
    if(!trackId)return;
    const host=document.querySelector('.leaderboard-ui');
    if(!host||!isElementVisible(host))return;
    ensureNativeAllRunsDefault(host);
    const buttons=Array.from(host.querySelectorAll(':scope > .container > button.main'));
    if(!buttons.length)return;
    const rows=localTrackDisplayEntries(trackId,readTrackSnapshotCache(trackId)?.entries||[],activeRankedAccountId()).sort((a,b)=>canonicalRaceTimeMs(a)-canonicalRaceTimeMs(b));
    for(const button of buttons){
      for(const name of Array.from(button.classList))if(name==='sq-racer-cosmetic'||name==='sq-racer-top'||name.startsWith('cosmetic-'))button.classList.remove(name);
      const rank=Math.max(0,Number((String(button.querySelector('.position')?.textContent||'').match(/\d+/)||[])[0]||0)||0);
      const visibleName=Array.from(button.querySelector('.name')?.childNodes||[]).filter(node=>node.nodeType===Node.TEXT_NODE).map(node=>node.textContent||'').join('').trim();
      const visibleTime=String(button.querySelector('.left p:not(.position)')?.textContent||'').trim();
      const racer=matchNativeResult(rows,visibleName,visibleTime);
      const integrityState=button.querySelector('.verified-state');
      if(integrityState)integrityState.dataset.sqRunStatus=runStatus(racer);
      if(!racer){button.querySelector('.sq-track-identity')?.remove();continue;}
      const identity=rankedIdentityForRacer(racer);
      const cosmeticClasses=racerCosmeticClasses(identity).split(/\s+/).filter(Boolean);
      button.classList.add('sq-racer-cosmetic',...cosmeticClasses);
      button.classList.toggle('sq-racer-top',rank>0&&rank<=3);
      decorateNativeLeaderboardIdentity(button,identity);
    }
    syncIntegrityStateLabels();
  }

  /* The per-track rows are rendered by the game, so the country flag is
     appended once per row and rebuilt whenever the racer behind the row changes. */
  /* Ranked totals, badges and the Overall place all come from the Overall snapshot so
     a racer's design, badge and title read the same on every leaderboard. The track
     position is deliberately not used here: unlocks follow the Overall standing. */
  let rankedIdentityIndex=null;
  let rankedIdentityIndexSource=null;
  function rankedIdentityRows(){
    if(overallEntriesCache.length)return overallEntriesCache;
    const saved=readOverallSnapshotCache();
    return Array.isArray(saved?.entries)?saved.entries:[];
  }
  function rankedIdentityForRacer(racer){
    const accountId=cleanUserId(racer?.accountId||racer?.userId||'');
    const rows=rankedIdentityRows();
    if(rows!==rankedIdentityIndexSource){
      rankedIdentityIndexSource=rows;
      rankedIdentityIndex=new Map(rows.map((row)=>[cleanUserId(row.userId||row.accountId||''),row]));
    }
    const overallRow=rankedIdentityIndex.get(accountId)||{};
    return {
      ...racer,
      userId:accountId,
      rank:Number(overallRow.rank||0)||0,
      raceCount:Number(overallRow.raceCount||racer?.raceCount||0)||0,
      pbCount:Number(overallRow.pbCount||racer?.pbCount||0)||0,
      badges:overallRow.badges||racer?.badges||null,
      accountCreatedAt:Number(racer?.accountCreatedAt||overallRow.accountCreatedAt||0)||0,
      profileCosmetics:racer?.profileCosmetics||overallRow.profileCosmetics||null
    };
  }
  function decorateNativeLeaderboardIdentity(button,entry){
    const nameEl=button.querySelector('.name');
    if(!nameEl)return;
    const accountId=cleanUserId(entry.userId||entry.accountId||'');
    const signature=[accountId,String(entry.countryCode||'')].join('|');
    let extras=button.querySelector('.sq-track-identity');
    if(extras&&extras.dataset.signature===signature)return;
    if(!extras){
      extras=document.createElement('span');
      extras.className='sq-track-identity';
      nameEl.appendChild(extras);
    }
    extras.dataset.signature=signature;
    extras.innerHTML=countryFlagMarkup(entry.countryCode);
  }

  function reconcileUI(){
    return withoutUiFeedback(reconcileUiContents);
  }
  function reconcileUiContents(){
    ensureEventEntry();
    applyUiPreferences();
    injectRankingsButton();
    setUnofficialMessage();
    ensurePersistentInfoBranding();
    ensureStaticDiscordLink();
    syncNativeDiscordVisibility();

    ensureSettingsEnhancements();
    syncMultiplayerRelayPanel();
    hideVerifiedOnlyToggle();
    syncIntegrityStateLabels();
    decorateNativeLeaderboardCosmetics();
    ensureReturningPlayerNotice();
    ensureWeeklyTrackHighlight();
    updateTrackFreshnessBanner();
  }

  function updateTrackFreshnessBanner(){
    const nativeLeaderboard=document.querySelector('.leaderboard-ui');
    let banner=document.getElementById('polytrackTrackFreshness');
    if(!nativeLeaderboard||!isElementVisible(nativeLeaderboard)||!currentTrackLoadState){if(banner)banner.remove();return;}
    if(!banner){banner=document.createElement('div');banner.id='polytrackTrackFreshness';banner.className='polytrack-track-freshness';document.body.appendChild(banner);}
    const state=currentTrackLoadState;
    banner.className=`polytrack-track-freshness ${state.status==='stale'?'is-stale':state.status==='loading'?'is-loading':''}`;
    const cached=readTrackSnapshotCache(state.trackId);
    const fieldSize=Math.max(0,Number(cached?.entries?.length||0)||0);
    const weight=cachedTrackWeight(state.trackId,cached);
    const snapshotAt=Number(state.fetchedAt||0)||0;
    const checkedAt=Number(state.checkedAt||0)||0;
    const failed=state.status==='stale';
    const snapshotAge=snapshotAt?durationLabel(Date.now()-snapshotAt):'';
    const underMinute=Boolean(snapshotAt&&Date.now()-snapshotAt<60000);
    const recentlyChecked=checkedAt&&Date.now()-checkedAt<TRACK_REFRESH_MS;
    const second=state.status==='loading'?'Loading the selected track':failed?`STALE SAVED DATA · ${snapshotAge?`${snapshotAge} old`:'age unknown'}`:underMinute?`Fresh · changed ${snapshotAt?ageLabel(snapshotAt):'just now'}`:recentlyChecked?`Current · changed ${snapshotAt?ageLabel(snapshotAt):'unknown'}`:state.status==='cloud'?`Cloud data · changed ${snapshotAt?ageLabel(snapshotAt):'unknown'}`:`Saved snapshot · changed ${snapshotAt?ageLabel(snapshotAt):'unknown'}`;
    banner.innerHTML=`<strong>${fieldSize>=2?`${weight.toFixed(2)}x Weight`:'No Ranked weight'} · ${fieldSize} Player${fieldSize===1?'':'s'}</strong><span>${escapeHtml(second)}</span>`;
    banner.title=`${failed?'Cloud refresh failed. ':checkedAt?`Cloud checked ${ageLabel(checkedAt)}. `:''}${rankedWeightTitle(state.trackId,fieldSize,false,cached?.entries?.[0])} Right-click a racer to open their Ranked profile.${state.nextRefreshAt>Date.now()?` Next check in ${durationLabel(state.nextRefreshAt-Date.now())}.`:''}`;
  }


  function isElementVisible(el){
    if (!el || !el.isConnected) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || '1') > 0 && el.getClientRects().length > 0;
  }

  async function updateOverallIdentity(d,accountId,nextName,countryCode,carStyle){
    const safeId=String(accountId||'').slice(0,128); if(!safeId)return;
    const safeName=safeDisplayName(nextName,safeId);
    overallEntriesCache=overallEntriesCache.map((entry)=>String(entry.userId||entry.accountId||'')===safeId?{...entry,name:safeName,nickname:safeName,countryCode:String(countryCode||entry.countryCode||'').slice(0,8),carStyle:__pt062NormalizeStyle(carStyle||entry.carStyle||'')}:entry);
    const cached=readOverallSnapshotCache();
    if(cached?.entries?.length)writeOverallSnapshotCache(cached.entries.map((entry)=>String(entry.userId||entry.accountId||'')===safeId?{...entry,name:safeName,nickname:safeName,countryCode:String(countryCode||entry.countryCode||'').slice(0,8),carStyle:__pt062NormalizeStyle(carStyle||entry.carStyle||'')}:entry),cached);
    if(document.getElementById('overallLeaderboardPanel')?.style.display==='flex')renderEntries();
    await sendRankedProfileNotification(safeId);
    log('info','[PROFILE203] Ranked identity queued for authoritative refresh',{accountId:safeId});
  }

  async function propagateDisplayName(d, accountId, nextName){
    const safeId = String(accountId || '').slice(0,128);
    const safeName = safeDisplayName(nextName, safeId);
    if (!safeId) return;
    overallEntriesCache=overallEntriesCache.map((entry)=>cleanUserId(entry.userId||entry.accountId)===safeId?{...entry,name:safeName,nickname:safeName}:entry);
    const cached=readOverallSnapshotCache();
    if(cached?.entries?.length)writeOverallSnapshotCache(cached.entries.map((entry)=>cleanUserId(entry.userId||entry.accountId)===safeId?{...entry,name:safeName,nickname:safeName}:entry),cached);
    log('info','[MOD201] Display name updated locally; production snapshots remain server-owned',{accountId:safeId});
  }

  function isStartMenuHotkeyContext(){
    const menu = document.querySelector('.menu-ui, .menu');
    if (!isElementVisible(menu)) return false;
    const container = document.querySelector('.main-buttons-container');
    if (!isElementVisible(container)) return false;
    const play = Array.from(container.querySelectorAll('button,a')).find((button)=>/play\.svg|\bplay\b/i.test(`${button.textContent||''} ${Array.from(button.querySelectorAll('img')).map((img)=>img.getAttribute('src')||'').join(' ')}`));
    if (!isElementVisible(play)) return false;
    const rankedPanel = document.getElementById('overallLeaderboardPanel');
    if (rankedPanel && rankedPanel.style.display !== 'none' && isElementVisible(rankedPanel)) return false;
    const profileInputOpen = !!document.querySelector('.profile-menu input:focus, .profile input:focus, input[type="text"]:focus');
    if (profileInputOpen) return false;
    const overlayCandidates = Array.from(document.querySelectorAll('.settings,.settings-menu,.popup,.dialog,[role="dialog"]'));
    if (overlayCandidates.some((el)=>isElementVisible(el))) return false;
    return true;
  }

  async function openNativeTrackRacerProfile(button){
    const trackId=String(currentTrackLoadState?.trackId||''); if(!trackId)return;
    const snapshot=readTrackSnapshotCache(trackId); const rows=[...(snapshot?.entries||[])].sort((a,b)=>canonicalRaceTimeMs(a)-canonicalRaceTimeMs(b));
    const rankText=String(button.querySelector('.position')?.textContent||'');
    const rank=Math.max(0,Number((rankText.match(/\d+/)||[])[0]||0)||0);
    const visibleName=String(button.querySelector('.name')?.textContent||'').trim();
    let racer=rank>0?rows[rank-1]:null;
    if(!racer||visibleName&&safeDisplayName(racer.nickname||racer.name||'',racer.accountId||racer.userId)!==visibleName)racer=rows.find((row)=>safeDisplayName(row.nickname||row.name||'',row.accountId||row.userId)===visibleName)||racer;
    const userId=cleanUserId(racer?.accountId||racer?.userId||''); if(!userId)return;
    await openPanel(false);
    if(overallEntriesCache.some((entry)=>cleanUserId(entry.userId||entry.accountId)===userId))openRankedProfile(userId);
    else{
      const panel=document.getElementById('overallLeaderboardPanel');
      const list=panel?.querySelector('#overallLeaderboardList');
      if(list)list.insertAdjacentHTML('afterbegin',`<div class="overall-empty compact"><strong>${escapeHtml(visibleName||'This racer')} is not in the current Overall snapshot</strong><span>The track result is saved, but the complete Overall rebuild has not included it yet.</span></div>`);
    }
  }

  let uiPassDepth=0;
  const uiObserverOptions={childList:true,subtree:true,attributes:true,attributeOldValue:true,attributeFilter:['class','style']};
  function withoutUiFeedback(action){
    const outer=uiPassDepth++===0;
    if(outer)observer.disconnect();
    try{return action();}finally{if(--uiPassDepth===0)observer.observe(document.body||document.documentElement,uiObserverOptions);}
  }
  let reconcileScheduled = false;
  const RECONCILE_MIN_GAP_MS=120;
  let lastReconcileAt=0;
  let eventFrame=0;
  const observer = new MutationObserver((records) => {
    records=records.filter(record=>record.type==='attributes'?record.oldValue!==record.target.getAttribute(record.attributeName):[...record.addedNodes,...record.removedNodes].some(node=>node.nodeType===1));
    if(!records.length)return;
    if(!eventFrame&&records.some(record=>record.type==='childList'&&record.addedNodes.length)){eventFrame=requestAnimationFrame(()=>{eventFrame=0;ensureEventEntry();});}
    if (reconcileScheduled) return;
    reconcileScheduled = true;
    const wait=Math.max(0,RECONCILE_MIN_GAP_MS-(Date.now()-lastReconcileAt));
    setTimeout(() => {
      reconcileScheduled = false;
      lastReconcileAt = Date.now();
      reconcileUI();
    }, wait);
  });

  function boot(){
    install();
    void ensureEventUi().then(()=>ensureEventEntry()).catch(()=>{});
    observer.observe(document.body || document.documentElement, uiObserverOptions);
    setInterval(()=>{if(document.visibilityState==='visible')reconcileUI();}, 1800);
    setTimeout(()=>db().then(()=>flushRankedNotificationQueue()).catch(()=>{}),2500);
    window.addEventListener('keydown', (event)=>{
      handleModeratorSequence(event);
      if(event.defaultPrevented)return;
      if (event.key === 'Escape') {
        const panel = document.getElementById('overallLeaderboardPanel');
        const help = document.getElementById('overallHelpPopup');
        if (help && help.style.display !== 'none') { help.style.display='none'; event.preventDefault(); return; }
        if (panel && panel.style.display !== 'none') { panel.style.display='none'; event.preventDefault(); return; }
      }
      handleLobbyShortcut(event);
    });
    document.addEventListener('click',async(event)=>{
      const button=event.target.closest?.('[data-planner-event]');if(!button)return;
      event.preventDefault();
      try{const ui=await ensureEventUi();await ui.openEvent({kind:button.dataset.eventKind,trackId:button.dataset.eventTrack});}catch{}
    });
    document.addEventListener('change',(event)=>{
      const sort=event.target.closest?.('[data-planner-sort]');
      if(sort&&['impact','ease'].includes(sort.value)){plannerSort=sort.value;localStorage.setItem('polytrack-0.6.2-planner-sort',plannerSort);const id=document.querySelector('#overallProfileContent')?.dataset.accountId;if(id)openRankedProfile(id);return;}
      const select=event.target.closest?.('[data-planner-metric]');if(!select||!Object.hasOwn(PLANNER_METRICS,select.value))return;
      plannerMetric=select.value;localStorage.setItem('polytrack-0.6.2-planner-metric',plannerMetric);
      const profile=document.querySelector('#overallProfileContent');const accountId=profile?.dataset.accountId;
      if(accountId){openRankedProfile(accountId);const guide=document.querySelector('.profile-guide');if(guide){guide.open=true;guide.scrollIntoView({block:'nearest'});guide.querySelector('[data-planner-metric]')?.focus();}}
    });
    document.addEventListener('contextmenu',(event)=>{
      const summaryTrack=event.target.closest?.('[data-summary-track-id]');
      if(summaryTrack?.dataset.summaryTrackId){event.preventDefault();focusTrackFromRanked(summaryTrack.dataset.summaryTrackId);return;}
      const button=event.target.closest?.('.leaderboard-ui > .container > button.main');
      if(!button)return;
      const trackId=String(currentTrackLoadState?.trackId||'');
      if(!trackId||!readTrackSnapshotCache(trackId)?.entries?.length)return;
      event.preventDefault();
      openNativeTrackRacerProfile(button);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once:true });
  else boot();
})();
/* polytrack-extension-inline-v062-r1 */
