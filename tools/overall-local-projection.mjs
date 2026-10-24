// Pure scoring mirror of workers/ranked/src/index.js. Source-parity tests fence drift.
// Never use these presentation projections as public standings or verification proof.
import {EXTRA_TRACK_IDS} from '../workers/ranked/src/extra-track-ids.js';
import {projectCasualRp,readPublishedCasual} from './casual-rp-model.mjs';
const SPECIAL_ROLLING_HILLS_TRACK_ID = 'fb769ac2ea77e8f19a21a9dd3071742f2342bd49c41e4748d7e8c7903d4f0778';

const ALGORITHM_VERSION = 'participation-v8-s1';
const AVERAGE_PLACEMENT_VERSION = 2;
const PROFILE_COSMETICS_VERSION = 7;
const MIN_RANKED_TRACKS = 3;
const PODIUM_MIN_FIELD = 5;
const LEGACY_COMMUNITY_IDS = new Set(['5aafb733c264d51b09beedc7bd7eabb5e65bdded338980fcb14ae5ce36955572']);
const OFFICIAL_IDS = new Set(["5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038","7eac4fee1111152cfba4d3737410264ca0f22c7f5a2211e79f0099589b8b48c0","148826aa16ffaa23dbc453b32cff05e025ddbce1773fc7733cc13d218926515a","93c7363dfea7fb09ca1d23b72cad5df43a30841d41c8ff25fb544c85bb03c7ae","7603aaeffa1989a649dfaa8e1804bed4481b49df233e377687d0669899566e52","c117823cf6788e3247b9ee63a0c091c07352bbe352c650a7790dc6718148c2fa","e4bcaca3a583bb0eb62a700a69d14e89c852f0c5bf740fca76e0519ebdfc9ab1","7239b17057127936907a805b0caa5d8c6f6c97eca9bdabf1a5312dce479629b7","99864b635d1891d22e17eb9267527a07a92c49c0f02893729fa2ded90e3ca0f9","a5341fe706097cff2a3812a3fc0d87399254557328351ae8e5c882700fc1a196","7d134c939df80c676a258266201beedd3b93572d5603f3ff4339ff8679803715","2fe4bd46b0075cc25fc770ce50adbb68447cf493c999635bb272d231811dd264","c20b4ee3cd517ca6cae7e43f047548757287fbd08ba81b97892a3ef520159a34","88647ea04145fbbbb19b55f1590e038fb0378acb2571110f02cb545cc46b0d57","2806030c503abb41a1a26fa9a570888be14296172bb273798ef0ad87a108a2ec","4697ea67b18c3f49b30a3d8884602115536650bc5435c88e3732e64d21a72d33","e5d084e06db4ab71196fea44efeceb23c8561266a78669c324a38f92581fe2db"]);
const COMMUNITY_IDS = new Set(["fb769ac2ea77e8f19a21a9dd3071742f2342bd49c41e4748d7e8c7903d4f0778","387aab2d3400ebf74b5a780d15c911cdc695053b94be3e7ad23f6ae313b2471c","a680fa81e6a4b9dec06b4197833f0a96334a275faf387d495c9c674ffd6b8686","439f1c61263987365996667f99d65f899ec482dfe21c64edcd9a1b1ae5b4a0a9","dc7783fef2a5fbb7a2d75b9c6fdd6a9d600b833d47c6274374ea4388c707517a","f40d385d5e97e00a166a9a05d19789d8f2bf3621a8c1c8919c8bec41ab6347ab","d57a81355f36d5ef0bd2c063d251baf6d28401c275a8b3e3a62e0ae5071a2559","225fad12335dadc12b60bfa1b31369b1026d8a084fd4670583870fb3b71f7ec0","0338f449b9948f06c03ffc2ab3ab6cf551fd08a9f2c09a16156b93ef52dd4411","27c3384de80b1bed23f1ea15316abe62c8cca33e955805f23d461803f6dee8d4","d9bc51ec180bc46558e079c7949ba10b9ade52078c4c145f217a6a8543df2377","5159a8dac6a1f397407a7b5233ad570613531f6609f7dc897490c28c9f2c7a4e","1783b7b6c30e7fddf7ffb7c8a4a8a3b65c1ef6ec317d908d6eb05e6c905a57f6","ddfe00045807e2786552d1e31e1363384c365487180f65d4eff1aa41e334a8e8","4058e3616fbd79b848e70037adde4f12b4413011050aaf1c9d875cdbe2e33d68","2ec74a179c8aba94354e3c6dee2a2920bedd7d84adf4d0a691f4a7453afdb1e8","76e1920a3ca015033a0b21156848def2c248c95d97ccf4aab2312a0302beefe0","81cede50724b1ee0c2ebcef973c37d620680766bd75771c5ae2728b8732c7a66","76269faf38e8726671c05b2b9044f7aa3e66c4313cb4fa5d0fbb23fc8524fe9e","151f12fd3ebc8942f7aaef669024a0fc149bc220f370753efe14d9371acc9c87","f9283607ecec9c89583205cf08715c8f504cc271eec51209bb6fc0cc37ddc915","64bf7efaed2a47dfb03a6b152e3aef637ac251b68a725a28352f3376ff1384d7","520c4f511821ced30b99bceafbb02e6b7531e867126b0756e68d5e157691ef2f","315c9e95c567cce4feca78f5ad6e8d08d0a22dac0d56061af567b43eea3d4fa8","a8913b96daceb5b615fe45aad2bb104e04eb7db140242934657111e1d1f55b89","66f43b2d2a17f3cee05a127040ca409795058510bd3d1ac7eee224512ec532f5","fcbba504800751b0fb404a7cd1c9591befdf688ad5451ab2bc1f3651590cc5fc","9ba44e8eafd0158e7e1f63e7d609db308c53f337b79e86bd0b630225451eef34","b3889905b6df31cbe302e58e975988385607771605bf6e8e8e8e31b3d2dc8aa1","3cd94552b12fb3a8ac45ca3a5e21a882b71b31c788989b396ab382afc69414ac","3125a5f98c3b43cf1e2604e25e8504bffd714ea5843200fa8ddf0b4c58842f16","a2137c20c03ad1848098b47f70417cc0b0bf169010c825dc6fb82f37066808a0","d03b9f7c10c95f40eed389458be51bdf2437febd5673d028da134e59e503c10b","f68a709a296a60f6e6f73a2da670f95aca424be0f2fda5d6b608ece71f339b7c","a1f41dc9e884d5d4b1b6025158d70f0934dc4d892076e6c4b32dc3f3846b882e","b430aad5e481caa4588e30f46352b876b62f1ba0cf7730a15efd026c91a8f32e","95d8f7cbe11053dbdfaeeb2f3c3d8f53f0d45fb6abeb411a74949a4cf52f427f","409f26b9faf55bd0ad748177bf85ebdcfc0ddd572190e7f464f38b4a60587b7e","c1a2c5aef1029d7bbf946f08cd087dd25bad6e019a41694a48a0024c27627dc8","9e53d03f4efe86834c49ce202b528d769d9aa7a6e17732d0fc56440463956a1b","b77ec520a40c4b38d3d7d653b747b1f8627c98709096568db22cd1bfec534ba6","9f827673c4132828009237a03e12ead73eae87504b4708a79c6cc0858212262d","9acd9aef650c4ccc41bb01f72ed44dfaa13f2e4404d2e3466f09cc1adcd9a9c0","62d9989187e4508f7866e7b30aa187ddbee2595df21ff5988d7fec3589f9048d","b36162623435dc90a54f57590d2baa9f2d67a51cb12c393531f4b6d5e5528ebf","74ae56c0f278a19f3b69f3903198c7b9de09981133205856b53bf6bdf8db4211","9f4597449906aa0c2baf9a4737406385c829533e64e9e972b25b4189f4593a54","28b658c7d10eb8b5de6f465e034e87e40f70b37e4534d8c37d1f2af06b5a36d7","470af92ed4c0a6f62028d7dea4dbc7765d1db16a3698d6a0c271be582a20a7c6","a6b990137e404c9ef2cb4399c463acbed8ebfa3bb82ab5315027118604c4ec03","35fe02bf18312713c05528f0b7b8fd15c83dac50bcdcbd373040a16e8bfcc138","18b69f54f119cfb2867abded9a1574f0799a750ef94aa744d9ec8ef6b4d565ae","5ea46b3ae268a0196dcc59dabe88926400b56e29814658bfed06a284f837cefd","ab8e1c13ddf394102be1cb04adcff8411127f1e7140a216d27a94fc19b7d0428","86335d78d1a06d3dc81d80f84b8ac2e8f6359e9a206826e2c36f7d3f4351bea4","a510bbd3341f2992a12db8a3780cb8943b6087538345d58d16602d6129742df0","8cf99166f12cbb56a9df4e022a0e9b8c78973adb929dbf1e265ebb9f99f01163","33d99aad2ad5cef45b1d3afb8735c5229cfd98ac7cc24916e0da7283f7a545ce","5c00f2c90bcf8230183484225d1a417e45b0ad310379acfafd4c8f1dc7345dd7","009fad7fcc215022c6b2dbb2b6de622f07cd88d4930b8e2b6a6b74c1f5de9e44","1ad53694ee3e96aea27afa7b64d5c29d115de88a17b69cf3fe3f5609c52b040b","2ed125037366052871fbb97da6e1bda49cfeb471f6b9c8fa799d520bdb3683e2","f79b1d863d50f9e3b4489988698065c6d775ff3ec90bf91085bad05ad5ec8316","27429a1d1bf05770851e3919af70f47c6cd7a269c67032b084fb4345f6c271ce","f5c327cf09b90e4de8c3c1f9c910dbb7988cf15485d2e4beec3cc03aef408c5c","7451c2128cb96bc28195cf0ca0f83a46c3b55d78d434232d9de085dd1cf0ab36","af6ef508e1f6e47a462a6998b950ef535d1e8a38fe67ead891bf5f2de1346f43","089f2aebcfe4f24d8dda3a8a630172d2bd13793e78c5247adfaa760743a377e1","5e40f730509204c77e9c610839ed43addddbe0f8aa007168447f7fde38583905","191737cc4d1b74949e992d99371e5c7f5fc446a716af571c6e5449b23e9f4558","39bd3fa6c3c769b298c219aee7561af35a6d856bfee14b46b0b48499e7a57ed5"]);
const PROFILE_COSMETIC_OPTIONS = Object.freeze({
  theme: new Set(['classic', 'cyan', 'ocean', 'ice', 'mono', 'sunset', 'neon', 'forest', 'ember', 'crimson', 'podium', 'beta']),
  accent: new Set(['cyan', 'white', 'lime', 'gold', 'orange', 'coral', 'pink', 'violet', 'ice']),
  finish: new Set(['gradient', 'solid', 'split', 'gloss', 'carbon', 'horizon']),
  plate: new Set(['block', 'solid', 'outline', 'notch', 'bar']),
  edge: new Set(['accent', 'wide', 'none', 'double', 'dashed']),
  stage: new Set(['garage', 'slate', 'aqua', 'grid', 'horizon', 'night', 'storm', 'dunes', 'podium', 'sunrise', 'aurora']),
  stageTint: new Set(['natural', 'blue', 'teal', 'gold', 'red', 'pink', 'mono', 'orange', 'violet']),
  stripe: new Set(['standard', 'cyan', 'apex', 'chevron', 'sunset', 'split', 'grid', 'circuit', 'scan', 'blocks', 'gold', 'beta', 'overdrive']),
  emblem: new Set(['none', 'bolt', 'star', 'diamond', 'twinStars', 'flag', 'flame', 'crown', 'target']),
  emblem2: new Set(['none', 'star', 'bolt', 'flag', 'diamond', 'flame', 'crown']),
  emblem3: new Set(['none', 'chevron', 'wings', 'laurel']),
  emblemBackdrop: new Set(['none', 'disc', 'shield', 'hex']),
  stageEffect: new Set(['none', 'speed', 'spark', 'halos']),
  nameFont: new Set(['classic', 'clean', 'racing', 'serif', 'condensed', 'wide', 'mono', 'rounded']),
  nameSize: new Set(['normal', 'large', 'compact']),
  nameWeight: new Set(['regular', 'bold']),
  nameColor: new Set(['default', 'white', 'cyan', 'gold', 'coral', 'mint', 'violet', 'aurora', 'sunset', 'lime', 'ice', 'rose']),
  baseSecondary: new Set(['auto', 'white', 'cyan', 'gold', 'coral', 'mint', 'violet', 'orange', 'ice']),
  title: new Set(['auto', 'none', 'contender', 'pbHunter', 'trackGrinder', 'podiumRegular', 'betaRacer']),
  badge: new Set(['auto', 'member', 'none', 'betaTester'])
});

function safeText(value, max) {
  return String(value || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, max);
}

function raceTime(row) {
  const time = Math.round(Number(row?.timeMs || 0));
  return Number.isFinite(time) && time > 0 && time <= 36000000 ? time : 0;
}

function trackType(trackId) {
  return trackId === SPECIAL_ROLLING_HILLS_TRACK_ID ? 'permanent' :
    OFFICIAL_IDS.has(trackId) ? 'official' : (COMMUNITY_IDS.has(trackId) || LEGACY_COMMUNITY_IDS.has(trackId)) ? 'community' : 'custom';
}

function median(values, fallback = 0) {
  const clean = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return fallback;
  const middle = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
}

function competition(entries) {
  const times = entries.map((entry) => raceTime(entry)).filter(Boolean).sort((a, b) => a - b);
  if (times.length < 3) return { relativeGap: 0, boost: 1 };
  const middle = median(times, 1);
  const gaps = times.slice(1).map((time, index) => Math.min(0.25, (time - times[index]) / Math.max(1, middle)));
  const relativeGap = median(gaps, 0);
  return { relativeGap, boost: 0.9 + 0.2 / (1 + 8 * relativeGap) };
}

function trackWeightParts(trackId, fieldSize, competitionBoost = 1) {
  const type = EXTRA_TRACK_IDS.has(trackId) ? 'extra' : trackType(trackId);
  const field = Math.max(0, Number(fieldSize || 0));
  const base = type === 'official' || type === 'permanent' ? 1.6 : type === 'community' ? 1 : 0.6;
  const popularity = field < 2 ? 0 : 0.56 * Math.log2(field) * (field - 1) / (field + 8);
  const competitionFactor = Math.max(0.85, Math.min(1.15, Number(competitionBoost || 1)));
  const weight = base * popularity * competitionFactor;
  return { type, field, base, popularity, competition: competitionFactor, finalWeight: weight };
}

function extraWeightCap(boards) {
  let strongest = 0;
  for (const board of boards) {
    if (EXTRA_TRACK_IDS.has(board?.trackId)) continue;
    for (const entry of Array.isArray(board?.entries) ? board.entries : []) {
      if (entry.integrityVerified !== true || entry.runVerified !== true) continue;
      const weight = Number(entry.weight || 0);
      if (Number.isFinite(weight) && weight > strongest) strongest = weight;
    }
  }
  return strongest > 0 ? strongest / 5 : 0.2;
}

function placementCost(rank, fieldSize) {
  const field = Math.max(0, Number(fieldSize || 0));
  const place = Math.max(1, Math.min(field, Number(rank || field) || field));
  if (field < 2) return 50;
  const raw = 100 * (place - 1) / (field - 1);
  const confidence = (field - 1) / (field + 5);
  return 50 + confidence * (raw - 50);
}

function rankTitle(score, tracks) {
  if (tracks < MIN_RANKED_TRACKS) return 'Provisional';
  const bands = [['Apex',18,20],['Elite',26,15],['Diamond',36,12],['Platinum',48,10],['Gold',62,7],['Silver',78,5],['Bronze',101,3]];
  let lower = 0;
  for (const [name, upper, minimumTracks] of bands) {
    if (score <= upper && tracks >= minimumTracks) {
      const progress = (score - lower) / Math.max(1, upper - lower);
      const division = progress < 1 / 3 ? 'I' : progress < 2 / 3 ? 'II' : 'III';
      const breadth = tracks >= 20 ? ' Marathon' : tracks >= 12 ? ' Veteran' : tracks >= 8 ? ' Challenger' : '';
      return `${name} ${division}${breadth}`;
    }
    lower = upper;
  }
  return 'Bronze III';
}

function sanitizeProfileCosmetics(value) {
  const source = value && typeof value === 'object' ? value : {};
  const legacy = Number(source.version || 0) < 2;
  const emblem2 = PROFILE_COSMETIC_OPTIONS.emblem2.has(source.emblem2) ? source.emblem2 : 'none';
  const nameFont = PROFILE_COSMETIC_OPTIONS.nameFont.has(source.nameFont) ? source.nameFont : 'classic';
  const nameSize = PROFILE_COSMETIC_OPTIONS.nameSize.has(source.nameSize) ? source.nameSize : 'normal';
  const nameWeight = PROFILE_COSMETIC_OPTIONS.nameWeight.has(source.nameWeight) ? source.nameWeight : 'regular';
  const nameColor = PROFILE_COSMETIC_OPTIONS.nameColor.has(source.nameColor) ? source.nameColor : 'default';
  const baseSecondary = PROFILE_COSMETIC_OPTIONS.baseSecondary.has(source.baseSecondary) ? source.baseSecondary : 'auto';
  return {
    version: PROFILE_COSMETICS_VERSION,
    theme: PROFILE_COSMETIC_OPTIONS.theme.has(source.theme) ? source.theme : 'classic',
    accent: PROFILE_COSMETIC_OPTIONS.accent.has(source.accent) ? source.accent : 'cyan',
    finish: PROFILE_COSMETIC_OPTIONS.finish.has(source.finish) ? source.finish : 'gradient',
    plate: PROFILE_COSMETIC_OPTIONS.plate.has(source.plate) ? source.plate : 'block',
    edge: PROFILE_COSMETIC_OPTIONS.edge.has(source.edge) ? source.edge : 'accent',
    stage: PROFILE_COSMETIC_OPTIONS.stage.has(source.stage) ? source.stage : 'garage',
    stageTint: PROFILE_COSMETIC_OPTIONS.stageTint.has(source.stageTint) ? source.stageTint : 'natural',
    stripe: PROFILE_COSMETIC_OPTIONS.stripe.has(source.stripe) ? source.stripe : 'standard',
    emblem: PROFILE_COSMETIC_OPTIONS.emblem.has(source.emblem) ? source.emblem : 'none',
    ...(emblem2 === 'none' ? {} : { emblem2 }),
    ...(PROFILE_COSMETIC_OPTIONS.emblem3.has(source.emblem3) && source.emblem3 !== 'none' ? { emblem3: source.emblem3 } : {}),
    ...(PROFILE_COSMETIC_OPTIONS.emblemBackdrop.has(source.emblemBackdrop) && source.emblemBackdrop !== 'none' ? { emblemBackdrop: source.emblemBackdrop } : {}),
    ...(PROFILE_COSMETIC_OPTIONS.stageEffect.has(source.stageEffect) && source.stageEffect !== 'none' ? { stageEffect: source.stageEffect } : {}),
    ...(nameFont === 'classic' ? {} : { nameFont }),
    ...(nameSize === 'normal' ? {} : { nameSize }),
    ...(nameWeight === 'regular' ? {} : { nameWeight }),
    ...(nameColor === 'default' ? {} : { nameColor }),
    ...(baseSecondary === 'auto' ? {} : { baseSecondary }),
    title: PROFILE_COSMETIC_OPTIONS.title.has(source.title) ? source.title : 'auto',
    badge: legacy ? 'auto' : (PROFILE_COSMETIC_OPTIONS.badge.has(source.badge) ? source.badge : 'auto'),
    favoriteTrackId: OFFICIAL_IDS.has(safeText(source.favoriteTrackId, 80)) || COMMUNITY_IDS.has(safeText(source.favoriteTrackId, 80)) || LEGACY_COMMUNITY_IDS.has(safeText(source.favoriteTrackId, 80)) ? safeText(source.favoriteTrackId, 80) : '',
    overridePodium: source.overridePodium === true
  };
}

function rankTrustedTrackEntries(rows, trackId) {
  const entries = [...rows].sort((a, b) => a.timeMs - b.timeMs || a.accountId.localeCompare(b.accountId));
  const comp = competition(entries);
  const parts = trackWeightParts(trackId, entries.length, comp.boost);
  return entries.map((entry, index) => ({
    ...entry,
    rank: index + 1,
    position: index + 1,
    fieldSize: entries.length,
    weight: Number(parts.finalWeight.toFixed(3)),
    competition: Number(parts.competition.toFixed(3)),
    timingVersion: 2
  }));
}

function finishSummary(finish) {
  return {
    trackId: finish.trackId,
    rank: finish.rank,
    fieldSize: finish.fieldSize,
    weight: finish.weight,
    placementCost: finish.placementCost,
    contribution: finish.contribution,
    improvementValue: finish.improvementValue,
    timeMs: finish.timeMs,
    pbAt: finish.pbAt,
    type: finish.type,
    competition: finish.competition,
    timingVersion: 2
  };
}

function computeOverall(trackDocuments, priorEntries = [], betaTesterIds = new Set(), {includePlannerResults = false} = {}) {
  const users = new Map();
  const prior = new Map((priorEntries || []).map((entry) => [entry.userId, entry]));
  const extraCap = extraWeightCap(trackDocuments);
  for (const board of trackDocuments) {
    const trackId = safeText(board.trackId, 80);
    const entries = rankTrustedTrackEntries((Array.isArray(board.entries) ? board.entries : []).filter((entry) => entry.integrityVerified === true && entry.runVerified === true), trackId);
    if (!trackId || entries.length < 2) continue;
    for (const entry of entries) {
      const accountId = safeText(entry.accountId || entry.userId, 128);
      if (!accountId) continue;
      const rank = Number(entry.rank || 0);
      const fieldSize = entries.length;
      const weight = EXTRA_TRACK_IDS.has(trackId) ? Math.min(extraCap, Number(entry.weight || 0)) : Number(entry.weight || 0);
      if (!rank || weight <= 0) continue;
      const cost = placementCost(rank, fieldSize);
      let user = users.get(accountId);
      if (!user) {
        const previous = prior.get(accountId);
        const previousIdentityAt = Number(previous?.identityUpdatedAt || 0);
        const previousPbAt = Number(previous?.latestPbAt || 0);
        const previousOverlayIsFresh = previousIdentityAt > previousPbAt;
        user = {userId:accountId,finishes:[],officialCount:0,communityCount:0,permanentCount:0,customCount:0,extraCount:0,pbCount:0,totalPlaytimeMs:0,accountCreatedAt:0,latestPbAt:0,
          identitySourceAt:previousOverlayIsFresh?previousIdentityAt:-1,identityFromProfile:previousOverlayIsFresh,identityUpdatedAt:previousOverlayIsFresh?previousIdentityAt:0,
          ...(previousOverlayIsFresh?{name:previous.name,countryCode:previous.countryCode,carId:previous.carId,carColors:previous.carColors,carStyle:previous.carStyle}:{}),
          profileCosmetics:previous?.profileCosmetics,cosmeticsSourceAt:Object.prototype.hasOwnProperty.call(previous||{},'profileCosmetics')?previousIdentityAt:-1,
          betaTester:false,groupCode:'',groupCodeUpdatedAt:0};
      }
      const pbAt = Number(entry.pbAt || entry.createdAt || 0);
      const profileAt = Number(entry.identityUpdatedAt || 0);
      const profileIsFresh = profileAt > pbAt;
      const identityAt = profileIsFresh ? profileAt : pbAt;
      if (identityAt > user.identitySourceAt || identityAt === user.identitySourceAt && !profileIsFresh && user.identityFromProfile) {
        Object.assign(user, {
          name:entry.name||'Racer',countryCode:entry.countryCode||'',carId:entry.carId||null,
          carColors:entry.carColors||null,carStyle:entry.carStyle||'',
          identitySourceAt:identityAt,identityFromProfile:profileIsFresh,identityUpdatedAt:profileIsFresh?profileAt:0
        });
      }
      if (Object.prototype.hasOwnProperty.call(entry,'profileCosmetics') && profileAt >= user.cosmeticsSourceAt) {
        user.profileCosmetics = sanitizeProfileCosmetics(entry.profileCosmetics);
        user.cosmeticsSourceAt = profileAt;
      }
      const groupCodeUpdatedAt = Number(entry.groupCodeUpdatedAt || 0);
      if (typeof entry.groupCode === 'string' && (/^\d{6}$/.test(entry.groupCode) || entry.groupCode === '')
        && (groupCodeUpdatedAt > user.groupCodeUpdatedAt || groupCodeUpdatedAt === user.groupCodeUpdatedAt && groupCodeUpdatedAt > 0)) {
        user.groupCode = entry.groupCode;
        user.groupCodeUpdatedAt = groupCodeUpdatedAt;
      } else if (groupCodeUpdatedAt === 0 && user.groupCodeUpdatedAt === 0 && /^\d{6}$/.test(entry.groupCode || '')) {
        user.groupCode = entry.groupCode;
      }
      user.pbCount = Math.max(user.pbCount, Number(entry.pbCount || 0));
      user.totalPlaytimeMs = Math.max(user.totalPlaytimeMs, Number(entry.totalPlaytimeMs || 0));
      user.latestPbAt = Math.max(user.latestPbAt, Number(entry.pbAt || 0));
        const created = Number(entry.accountCreatedAt || 0);
      if (created) user.accountCreatedAt = user.accountCreatedAt ? Math.min(user.accountCreatedAt, created) : created;
      user.betaTester ||= betaTesterIds.has(accountId) || prior.get(accountId)?.badges?.betaTester === true;
      const type = trackType(trackId);
      user[`${type}Count`] += 1;
      if (EXTRA_TRACK_IDS.has(trackId)) user.extraCount += 1;
      user.finishes.push({ trackId, rank, fieldSize, weight, placementCost: cost, contribution: Math.max(0, (100 - cost) * weight), improvementValue: cost * weight, timeMs: raceTime(entry), pbAt: Number(entry.pbAt || 0), type, competition: Number(entry.competition || 1) });
      users.set(accountId, user);
    }
  }
  const allRows = [...users.values()].map((user) => {
    const played = user.finishes.length;
    const byCost = [...user.finishes].sort((a, b) => a.placementCost - b.placementCost || b.weight - a.weight);
    const bestTen = byCost.slice(0, 10);
    const bestTenWeight = bestTen.reduce((sum, finish) => sum + finish.weight, 0);
    const skillCost = bestTen.reduce((sum, finish) => sum + finish.placementCost * finish.weight, 0) / Math.max(0.0001, bestTenWeight);
    const middle = median(user.finishes.map((finish) => finish.placementCost), 50);
    const ceiling = Math.min(82, middle + 24);
    const allWeight = user.finishes.reduce((sum, finish) => sum + finish.weight, 0);
    const consistencyCost = user.finishes.reduce((sum, finish) => sum + Math.min(ceiling, Math.max(5, finish.placementCost)) * finish.weight, 0) / Math.max(0.0001, allWeight);
    const coverageCost = 100 * Math.exp(-played / 10);
    const byPlace = [...user.finishes].sort((a, b) => a.rank - b.rank || b.fieldSize - a.fieldSize || b.weight - a.weight);
    const byContribution = [...user.finishes].sort((a, b) => b.contribution - a.contribution || a.rank - b.rank);
    const byImprovement = [...user.finishes].filter((finish) => finish.rank > 1).sort((a, b) => b.improvementValue - a.improvementValue);
    const medals = { gold: 0, silver: 0, bronze: 0 };
    const podiumEligible = user.finishes.filter((finish) => finish.fieldSize >= PODIUM_MIN_FIELD && finish.type !== 'custom');
    const competitiveAverageEligible = user.finishes.filter((finish) => finish.fieldSize >= PODIUM_MIN_FIELD && finish.type !== 'custom');
    for (const finish of podiumEligible) if (finish.rank <= 3) medals[finish.rank === 1 ? 'gold' : finish.rank === 2 ? 'silver' : 'bronze'] += 1;
    const score = Math.max(1.000001, 0.68 * skillCost + 0.20 * coverageCost + 0.12 * consistencyCost);
    const primaryBest = byPlace[0] || {};
    const podiums = medals.gold + medals.silver + medals.bronze;
    return {
      userId: user.userId, name: safeText(user.name, 24), countryCode: safeText(user.countryCode, 8).toUpperCase(), carId: user.carId, carColors: user.carColors, carStyle: user.carStyle, profileCosmetics: sanitizeProfileCosmetics(user.profileCosmetics), ...(user.identityUpdatedAt ? {identityUpdatedAt: user.identityUpdatedAt} : {}), ...(user.groupCode ? {groupCode: user.groupCode} : {}), ...(user.groupCodeUpdatedAt ? {groupCodeUpdatedAt: user.groupCodeUpdatedAt} : {}),
      accountCreatedAt: user.accountCreatedAt, latestPbAt: user.latestPbAt, totalPlaytimeMs: user.totalPlaytimeMs, score, raceCount: played, eligibleTrackCount: played,
      provisional: played < MIN_RANKED_TRACKS, totalTracks: OFFICIAL_IDS.size + COMMUNITY_IDS.size + LEGACY_COMMUNITY_IDS.size, officialCount: user.officialCount, communityCount: user.communityCount, customCount: user.customCount, ...(user.extraCount ? { extraCount: user.extraCount } : {}),
      weightedTracks: Number(allWeight.toFixed(3)), skillCost: Number(skillCost.toFixed(3)), coverageCost: Number(coverageCost.toFixed(3)), consistencyCost: Number(consistencyCost.toFixed(3)),
      averageFinish: Number((user.finishes.reduce((sum, finish) => sum + finish.rank, 0) / Math.max(1, played)).toFixed(2)), averageFinishVersion: 2,
      averagePlacement: Number((user.finishes.reduce((sum, finish) => sum + finish.rank, 0) / Math.max(1, played)).toFixed(2)), averagePlacementVersion: AVERAGE_PLACEMENT_VERSION,
      competitiveAveragePlacement: competitiveAverageEligible.length ? Number((competitiveAverageEligible.reduce((sum, finish) => sum + finish.rank, 0) / competitiveAverageEligible.length).toFixed(2)) : null,
      competitiveAverageEligibleTracks: competitiveAverageEligible.length,
      podiumEligibleTracks: podiumEligible.length, podiumRate: podiumEligible.length >= MIN_RANKED_TRACKS ? Number((podiums / podiumEligible.length * 100).toFixed(1)) : 0, trackWins: medals.gold, pbCount: user.pbCount,
      bestTracks: byPlace.slice(0, 2).map(finishSummary), strongestTrack: finishSummary(byContribution[0] || primaryBest), worstTrack: finishSummary([...user.finishes].sort((a, b) => b.rank / b.fieldSize - a.rank / a.fieldSize)[0] || primaryBest),
      improvementTrack: finishSummary(byImprovement[0] || primaryBest), weightedResults: byContribution.slice(0, 2).map(finishSummary), opportunityTracks: byImprovement.slice(0, 3).map(finishSummary),
      medals, bestTrackId: primaryBest.trackId || null, bestTrackRank: primaryBest.rank || 0, bestTrackField: primaryBest.fieldSize || 0, rankTier: rankTitle(score, played), rankModel: ALGORITHM_VERSION,
      ...(includePlannerResults ? {resultSamples: user.finishes} : {}),
      timingVersion: 2, badges: user.betaTester ? { betaTester: true } : null
    };
  }).sort((a, b) => Number(a.provisional) - Number(b.provisional) || a.score - b.score || b.raceCount - a.raceCount || a.userId.localeCompare(b.userId));
  const rows = allRows;
  const now = Date.now();
  let ranked = 0;
  const output = rows.map((row) => {
    const rank = row.provisional ? 0 : ++ranked;
    const previous = prior.get(row.userId);
    const changed = previous && Number(previous.rank) > 0 && rank > 0 ? Number(previous.rank) - rank : 0;
    return { ...row, rank, movement: changed, movementAt: changed ? now : Number(previous?.movementAt || 0), rankSince: previous && Number(previous.rank) === rank ? Number(previous.rankSince || now) : now, scoreDelta: previous ? Number(row.score - Number(previous.score || 0)) : 0 };
  });
  Object.defineProperty(output, 'totalEntries', { value: allRows.length, enumerable: false });
  return output;
}

const bindingKeys = ['algorithmVersion', 'sourceRevision', 'builtRevision', 'updatedAt'];
const sampleKeys = ['trackId', 'rank', 'fieldSize', 'weight', 'competition', 'timeMs', 'pbAt'];
const metricKeys = ['score', 'raceCount', 'weightedTracks', 'skillCost', 'coverageCost', 'consistencyCost', 'officialCount', 'communityCount', 'customCount', 'extraCount'];
const idOf = row => row?.accountId || row?.userId;
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && safeText(value, 128) === value;
const positive = value => Number.isSafeInteger(value) && value > 0;
const sameNumber = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-9;
const fail = (reason, details = {}) => ({status: 'unavailable', reason, ...details,
  localPending: true, calculationExact: false, publicRank: null, projection: null, racers: []});

function uniqueRows(rows) {
  if (!Array.isArray(rows)) return null;
  const seen = new Set();
  for (const row of rows) {
    const id = idOf(row);
    if (!validId(id) || seen.has(id) || row.accountId && row.userId && row.accountId !== row.userId) return null;
    seen.add(id);
  }
  return seen;
}

function completeBoard(board) {
  return (board?.sourceComplete === true || board?.sourceComplete === undefined && board?.complete === true) && (board.totalEntriesExact === true ||
    board.complete === true && board.totalEntriesExact !== false) &&
    Number.isSafeInteger(board.totalEntries) && board.totalEntries >= 0 &&
    Array.isArray(board.entries) && board.entries.length === board.totalEntries;
}

function decodeSamples(row, resultTracks) {
  if (Array.isArray(row.resultSamples)) return row.resultSamples;
  if (!Array.isArray(resultTracks) || typeof row.resultData !== 'string') return null;
  try {
    const tuples = JSON.parse(row.resultData);
    if (!Array.isArray(tuples)) return null;
    return tuples.map(tuple => {
      if (!Array.isArray(tuple) || tuple.length !== 7 || !Number.isInteger(tuple[0]) || tuple[0] < 0 || tuple[0] >= resultTracks.length) throw Error('Invalid result tuple');
      return Object.fromEntries(sampleKeys.map((key, index) => [key, index ? tuple[index] : resultTracks[tuple[0]]]));
    });
  } catch { return null; }
}

function sameSamples(expected, actual) {
  if (!Array.isArray(actual) || expected.length !== actual.length) return false;
  const byTrack = new Map(actual.map(row => [row?.trackId, row]));
  return byTrack.size === actual.length && expected.every(row => {
    const other = byTrack.get(row.trackId);
    return other && sampleKeys.every(key => key === 'trackId' ? row[key] === other[key] : sameNumber(row[key], other[key]));
  });
}

function present(row,casualProjection=null) {
  if (!row) return null;
  // Deliberately omit identities, cosmetics, badges, verification flags and public rank.
  return {userId: row.userId, score: row.score, projectedRank: row.rank || null,
    provisional: row.provisional, raceCount: row.raceCount, weightedTracks: row.weightedTracks,
    skillCost: row.skillCost, coverageCost: row.coverageCost, consistencyCost: row.consistencyCost,
    officialCount: row.officialCount, communityCount: row.communityCount, customCount: row.customCount,
    extraCount: row.extraCount || 0, averagePlacement: row.averagePlacement,
    trackResults: row.resultSamples.map(({rank, ...sample}) => ({...sample, projectedRank: rank})),
    casualProjection,
    localPending: true, publicRank: null};
}

/**
 * Calculate a presentation-only counterfactual over one complete static generation.
 * `overall` is the fully assembled published board; `results` is its decoded planner
 * sidecar (resultSamples or resultData/resultTracks). Both retain original metadata.
 * Stamp generation on each input only after the static reader validates its source.
 * `tracks` includes ALL resultBoardCount source boards, including singleton/empty boards.
 * `acceptedPbs` contains THIS account's confirmed submission receipts, not local saves:
 * {accountId, trackId, timeMs, accepted:true, acceptedAt, generation}.
 * Receipt fields are a caller contract, never authentication or verification evidence.
 */
export function projectScopedSnapshot({accountId,generation,overall,tracks}={}) {
  const unavailable=reason=>({status:'unavailable',kind:'scoped-snapshot-v1',reason,generation,
    calculationExact:false,scopedCalculationExact:false,overallProjection:false,projection:null,publicRank:null,localPending:false});
  if(!validId(accountId)||!positive(generation)||overall?.generation!==generation)return unavailable('scoped_generation_mismatch');
  if(overall.algorithmVersion!==ALGORITHM_VERSION||overall.schemaVersion!==6||!positive(overall.sourceRevision)||!positive(overall.updatedAt)||!completeBoard(overall)||!uniqueRows(overall.entries))return unavailable('scoped_invalid_overall_directory');
  const catalog=overall.trackCatalog;
  if(!Array.isArray(catalog)||catalog.length>512||!Array.isArray(tracks)||tracks.length!==catalog.length||
    catalog.some(row=>!validId(row?.trackId))||new Set(catalog.map(row=>row.trackId)).size!==catalog.length)return unavailable('scoped_incomplete_catalog');
  const expected=new Set(catalog.map(row=>row.trackId)),seen=new Set(),boards=[],sources=[];
  for(const board of tracks){
    if(!board||!expected.has(board.trackId)||seen.has(board.trackId))return unavailable('scoped_missing_or_duplicate_board');
    if(board.generation!==generation)return unavailable('scoped_mixed_generation');
    if(board.algorithmVersion!==ALGORITHM_VERSION||board.schemaVersion!==6||!positive(board.sourceRevision)||
      !Number.isSafeInteger(board.updatedAt)||board.updatedAt<0||!completeBoard(board)||!uniqueRows(board.entries))return unavailable('scoped_invalid_board_source');
    if(board.entries.some(row=>!positive(row.timeMs)||row.timeMs>36000000||
      typeof row.runVerified!=='boolean'||typeof row.integrityVerified!=='boolean'||
      !Number.isSafeInteger(row.pbAt)||row.pbAt<0||row.trackId&&row.trackId!==board.trackId))return unavailable('scoped_invalid_board_rows');
    seen.add(board.trackId);
    const trusted=board.entries.filter(row=>row.runVerified===true&&row.integrityVerified===true)
      .map(row=>({...row,accountId:idOf(row)}));
    // Same canonical ordering, competition and weight functions as Overall's
    // isolated mirror; only verified captured rows enter this calculation.
    const entries=rankTrustedTrackEntries(trusted,board.trackId);
    boards.push({...board,complete:true,sourceComplete:true,totalEntriesExact:true,totalEntries:entries.length,entries});
    sources.push({trackId:board.trackId,sourceRevision:board.sourceRevision,updatedAt:board.updatedAt,
      capturedAt:board.capturedAt??null,snapshotCapturedAt:board._snapshotCapturedAt??null});
  }
  const prior=new Map(overall.entries.map(row=>[idOf(row),row]));
  const population=new Set([...prior.keys(),...boards.flatMap(board=>board.entries.map(idOf))]);
  const extraCap=extraWeightCap(boards);
  const eligible=[...OFFICIAL_IDS,...COMMUNITY_IDS,...LEGACY_COMMUNITY_IDS];
  const official=[...OFFICIAL_IDS,SPECIAL_ROLLING_HILLS_TRACK_ID];
  const casualRacers=[];
  for(const userId of population){
    const casualProjection=projectCasualRp({accountId:userId,boards,eligibleTrackIds:eligible,
      officialTrackIds:official,extraTrackIds:[...EXTRA_TRACK_IDS],priorEntry:prior.get(userId),sourceComplete:true});
    const trackResults=[];
    for(const board of boards){
      if(board.entries.length<2)continue;
      const row=board.entries.find(row=>row.accountId===userId);if(!row)continue;
      const weight=EXTRA_TRACK_IDS.has(board.trackId)?Math.min(extraCap,row.weight):row.weight;
      if(weight<=0)continue;
      trackResults.push({trackId:board.trackId,projectedRank:row.rank,fieldSize:board.entries.length,weight,timeMs:row.timeMs});
    }
    casualRacers.push({userId,raceCount:trackResults.length,trackResults,
      casualProjection:{...casualProjection,localPending:false,captureRecalculated:true,
        reason:casualProjection.known?'captured_boards_not_overall_projection':casualProjection.reason,
        historicalLedgerAvailable:typeof prior.get(userId)?.serverAchievements?.casual?.ledger==='string'}});
  }
  return {status:'scoped-snapshot',kind:'scoped-snapshot-v1',generation,accountId,
    calculationExact:false,scopedCalculationExact:true,overallProjection:false,projection:null,publicRank:null,
    localPending:false,acceptedPbsApplied:false,
    label:'Captured track-board recalculation; captured separately from Overall RP. Pending PBs are not included.',
    overallSourceRevision:overall.sourceRevision,overallUpdatedAt:overall.updatedAt,
    boardCount:boards.length,sourceMetadata:sources,casualRacers};
}


export function projectLocalOverall({accountId, generation, overall, results, tracks, acceptedPbs = []} = {}) {
  if (!validId(accountId)) return fail('invalid_account');
  if (!(typeof generation === 'string' && generation.length || positive(generation))) return fail('invalid_generation');
  if (overall?.generation !== generation || results?.generation !== generation) return fail('generation_mismatch');
  if (overall.algorithmVersion !== ALGORITHM_VERSION || overall.schemaVersion !== 6) return fail('unsupported_model');
  if (!bindingKeys.every(key => overall[key] === results[key]) || !positive(overall.sourceRevision) || !positive(overall.updatedAt) || !positive(overall.builtRevision)) return fail('result_binding_mismatch');
  if (!completeBoard(overall) || !uniqueRows(overall.entries)) return fail('incomplete_overall');
  if (results.resultBundleComplete !== true || results.resultBoardLimitReached !== false ||
      !Number.isSafeInteger(results.resultBoardCount) || results.resultBoardCount < 0 ||
      !Array.isArray(tracks) || tracks.length !== results.resultBoardCount) return fail('incomplete_track_catalog');
  const catalog = new Map();
  if (!Array.isArray(overall.trackCatalog) || overall.trackCatalog.length !== tracks.length) return fail('incomplete_track_bindings');
  for (const item of overall.trackCatalog) {
    if (!validId(item?.trackId) || catalog.has(item.trackId) || !Number.isSafeInteger(item.updatedAt) || item.updatedAt < 0) return fail('invalid_track_bindings');
    catalog.set(item.trackId, item.updatedAt);
  }
  const resultUsers = uniqueRows(results.entries);
  const publishedUsers = new Set(overall.entries.map(idOf));
  if (!resultUsers || [...resultUsers].some(id => !publishedUsers.has(id))) return fail('invalid_results');
  const boards = [], byTrack = new Map();
  for (const board of tracks) {
    const trackId = board?.trackId;
    if (!validId(trackId) || trackId.length > 80 || byTrack.has(trackId)) return fail('invalid_track_catalog');
    if (board.generation !== generation) return fail('generation_mismatch', {trackId});
    if (!catalog.has(trackId) || catalog.get(trackId) !== (board.updatedAt ?? board.builtAt ?? 0)) return fail('track_binding_mismatch', {trackId});
    if (board.algorithmVersion !== ALGORITHM_VERSION || board.schemaVersion !== 6 || !positive(board.sourceRevision)) return fail('unsupported_track', {trackId});
    if (!completeBoard(board) || !uniqueRows(board.entries)) return fail('incomplete_track', {trackId});
    if (board.entries.some(row => !positive(row.timeMs) || row.timeMs > 36000000 ||
        typeof row.runVerified !== 'boolean' || typeof row.integrityVerified !== 'boolean' ||
        !Number.isSafeInteger(row.pbAt) || row.pbAt < 0 || row.trackId && row.trackId !== trackId)) return fail('invalid_track_rows', {trackId});
    const entries = board.entries.map(row => ({...row, accountId: idOf(row)}));
    const reranked = rankTrustedTrackEntries(entries, trackId);
    const weights = new Map(reranked.map(row => [row.accountId, row.weight]));
    if (entries.some(row => !sameNumber(row.weight, weights.get(row.accountId)))) return fail('track_weight_mismatch', {trackId});
    const copy = {...board, entries};
    boards.push(copy); byTrack.set(trackId, copy);
  }
  const baseline = computeOverall(boards, overall.entries, new Set(), {includePlannerResults: true});
  const publicById = new Map(overall.entries.map(row => [idOf(row), row]));
  const resultById = new Map(results.entries.map(row => [idOf(row), row]));
  if (baseline.length !== overall.entries.length || baseline.some(row => {
    const published = publicById.get(row.userId);
    return !published || metricKeys.some(key => !sameNumber(row[key] ?? 0, published[key] ?? 0)) ||
      row.rank !== published.rank || row.provisional !== published.provisional ||
      resultById.has(row.userId) && !sameSamples(row.resultSamples, decodeSamples(resultById.get(row.userId), results.resultTracks));
  })) return fail('baseline_mismatch');

  const casualOptions={eligibleTrackIds:[...OFFICIAL_IDS,...COMMUNITY_IDS,...LEGACY_COMMUNITY_IDS],
    officialTrackIds:[...OFFICIAL_IDS,SPECIAL_ROLLING_HILLS_TRACK_ID],extraTrackIds:[...EXTRA_TRACK_IDS],sourceComplete:true};
  const casualBaseline=new Map(baseline.map(row=>{
    const prior=publicById.get(row.userId);
    const state=projectCasualRp({...casualOptions,accountId:row.userId,boards,priorEntry:prior});
    const published=readPublishedCasual(prior);
    const matches=!published.known||state.known&&state.casualRp===published.value&&state.casualCompletionCount===published.count;
    return [row.userId,{state,matches}];
  }));
  const casualFor=row=>casualBaseline.get(row.userId)?.matches===false
    ?{known:false,casualRp:null,officialCasualRp:null,casualCompletionCount:null,officialCasualCompletionCount:null,reason:'baseline_casual_mismatch'}
    :projectCasualRp({...casualOptions,accountId:row.userId,
      boards:boards.map(board=>({...board,totalEntries:board.entries.length})),priorEntry:publicById.get(row.userId)});
  if (!Array.isArray(acceptedPbs)) return fail('invalid_receipts');
  const best = new Map();
  for (const receipt of acceptedPbs) {
    if (receipt?.accountId !== accountId) return fail('receipt_account_mismatch');
    if (receipt.generation !== generation) return fail('receipt_generation_mismatch');
    if (receipt.deleted === true || receipt.operation && receipt.operation !== 'pb') return fail('unsupported_receipt_operation');
    if (receipt.accepted !== true || !positive(receipt.acceptedAt) || !positive(receipt.timeMs) || receipt.timeMs > 36000000) return fail('unconfirmed_receipt');
    if (!byTrack.has(receipt.trackId)) return fail('missing_accepted_track', {trackId: receipt.trackId});
    const prior = best.get(receipt.trackId);
    if (!prior || receipt.timeMs < prior.timeMs || receipt.timeMs === prior.timeMs && receipt.acceptedAt > prior.acceptedAt) best.set(receipt.trackId, receipt);
  }
  const changedTracks = [];
  for (const [trackId, receipt] of best) {
    const board = byTrack.get(trackId);
    const previous = board.entries.find(row => row.accountId === accountId);
    if (previous && (previous.timeMs < receipt.timeMs || previous.timeMs === receipt.timeMs &&
        previous.runVerified === true && previous.integrityVerified === true)) continue;
    // Only the isolated calculation assumes eventual verification. No hypothetical
    // trusted rows leave this helper or reach the canonical/public caches.
    const entry = {...previous, accountId, userId: accountId, trackId, timeMs: receipt.timeMs,
      pbAt: receipt.acceptedAt, runVerified: true, integrityVerified: true};
    board.entries = rankTrustedTrackEntries([...board.entries.filter(row => row.accountId !== accountId), entry], trackId);
    changedTracks.push(trackId);
  }
  if (!changedTracks.length) return {status: 'unchanged', generation, calculationExact: true,
    localPending: false, publicRank: null, projection: null, racers: [], changedTracks: [],
    casualRacers:baseline.map(row=>({userId:row.userId,raceCount:row.raceCount,
      trackResults:row.resultSamples.map(({rank,...sample})=>({...sample,projectedRank:rank})),
      casualProjection:casualFor(row)}))};
  const calculated = computeOverall(boards, overall.entries, new Set(), {includePlannerResults: true});
  const racers = calculated.map(row=>present(row,casualFor(row)));
  return {status: 'projected', generation, sourceRevision: overall.sourceRevision,
    label: 'Snapshot + local recalculation', assumption: 'Accepted PBs eventually pass verification; other snapshot rows stay unchanged.',
    calculationExact: true, localPending: true, publicRank: null, changedTracks: changedTracks.sort(),
    projection: racers.find(row => row.userId === accountId) || null, racers};
}
