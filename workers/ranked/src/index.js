import { eventWorkerHandler, eventWorkerMaintenance } from './events-worker.js';
import {packPlannerResults, plannerDocumentBytes, PLANNER_BUNDLE_VERSION, PLANNER_PUBLICATION_VERSION} from './planner-results.js';
export {packPlannerResults} from './planner-results.js';
import { VERIFICATION_BOOTSTRAP_ID, VERIFICATION_BOOTSTRAP_BATCH, bootstrapSlots, VERIFICATION_COLLECTION, verificationSchedule, verificationKey, hasAcceptedVerifiedProof, verifiedVerdict, verifiedTargetMs, pendingSlot } from './verification.js';
const FIREBASE_JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const FIREBASE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PROJECT_ID = 'polytrack-052';
const ALGORITHM_VERSION = 'participation-v8-s1';
const TRACK_SCHEMA_VERSION = 5;
const AVERAGE_PLACEMENT_VERSION = 2;
const DERIVED_METRICS_VERSION = 2;
const INTEGRITY_STATE_VERSION = 1;
const PROFILE_COSMETICS_VERSION = 4;
const MIN_RANKED_TRACKS = 3;
const PODIUM_MIN_FIELD = 5;
const OVERALL_LIMIT = 200;
const TRACK_LIMIT = 500;
const REBUILD_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_REPLAY_LENGTH = 10000;
const MIGRATION_TRACK_BATCH = 4;
const MIGRATION_BADGE_BATCH = 25;
const MIGRATION_VERSION = 4;
const RECONCILE_RESULT_BATCH = 50;
const RECONCILE_TRACK_BATCH = 4;
const COLLECTIONS = Object.freeze({
  raceResults: '0.6.2_race_results',
  profiles: '0.6.2_profiles_public',
  betaTrack: '0.6.2_leaderboards_track',
  track: '0.6.2_s1_leaderboards_track',
  overall: '0.6.2_s1_leaderboards_overall',
  badges: '0.6.2_s1_badges',
  meta: '0.6.2_s1_release_meta',
  jobs: '0.6.2_s1_worker_jobs',
  cosmeticJobs: '0.6.2_s1_cosmetic_jobs'
});
const PROFILE_COSMETIC_OPTIONS = Object.freeze({
  theme: new Set(['classic', 'cyan', 'ocean', 'ice', 'mono', 'sunset', 'neon', 'forest', 'ember', 'crimson', 'podium', 'beta']),
  accent: new Set(['cyan', 'white', 'lime', 'gold', 'orange', 'coral', 'pink', 'violet', 'ice']),
  finish: new Set(['gradient', 'solid', 'split', 'gloss', 'carbon', 'horizon']),
  plate: new Set(['block', 'solid', 'outline', 'notch', 'bar']),
  edge: new Set(['accent', 'wide', 'none', 'double', 'dashed']),
  stage: new Set(['garage', 'slate', 'aqua', 'grid', 'horizon', 'night', 'storm', 'dunes', 'podium']),
  stageTint: new Set(['natural', 'blue', 'teal', 'gold', 'red', 'pink', 'mono']),
  stripe: new Set(['standard', 'cyan', 'apex', 'chevron', 'sunset', 'split', 'grid', 'circuit', 'scan', 'blocks', 'gold', 'beta']),
  emblem: new Set(['none', 'bolt', 'star', 'diamond', 'twinStars', 'flag', 'flame', 'crown']),
  title: new Set(['auto', 'none', 'contender', 'pbHunter', 'trackGrinder', 'podiumRegular', 'betaRacer']),
  badge: new Set(['auto', 'member', 'none', 'betaTester'])
});

export function sanitizeProfileCosmetics(value) {
  const source = value && typeof value === 'object' ? value : {};
  const legacy = Number(source.version || 0) < PROFILE_COSMETICS_VERSION;
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
    title: PROFILE_COSMETIC_OPTIONS.title.has(source.title) ? source.title : 'auto',
    badge: legacy ? 'auto' : (PROFILE_COSMETIC_OPTIONS.badge.has(source.badge) ? source.badge : 'auto'),
    favoriteTrackId: OFFICIAL_IDS.has(safeText(source.favoriteTrackId, 80)) || COMMUNITY_IDS.has(safeText(source.favoriteTrackId, 80)) || LEGACY_COMMUNITY_IDS.has(safeText(source.favoriteTrackId, 80)) ? safeText(source.favoriteTrackId, 80) : '',
    overridePodium: source.overridePodium === true
  };
}

export function profileCosmeticsUnlocked(cosmetics, entry = {}, betaTester = false) {
  const value = sanitizeProfileCosmetics(cosmetics);
  const tracks = Math.max(0, Number(entry.raceCount || 0));
  const rank = Math.max(0, Number(entry.rank || 0));
  const podium = rank > 0 && rank <= 3;
  const allowed = {
    theme: new Set(['classic', 'cyan', 'ocean', 'ice', 'mono']),
    accent: new Set(['cyan', 'white', 'lime', 'gold', 'orange']),
    finish: new Set(['gradient', 'solid', 'split']),
    plate: new Set(['block', 'solid', 'outline']),
    edge: new Set(['accent', 'wide', 'none']),
    stage: new Set(['garage', 'slate', 'aqua']),
    stageTint: new Set(['natural', 'blue', 'teal']),
    stripe: new Set(['standard', 'cyan', 'apex']),
    emblem: new Set(['none', 'bolt', 'star', 'diamond']),
    title: new Set(['auto', 'none']),
    badge: new Set(['auto', 'member', 'none'])
  };
  if (tracks >= 3) { allowed.theme.add('sunset'); allowed.theme.add('neon'); allowed.accent.add('coral'); allowed.accent.add('pink'); allowed.finish.add('gloss'); allowed.plate.add('notch'); allowed.edge.add('double'); allowed.stage.add('grid'); allowed.stage.add('horizon'); allowed.stage.add('dunes'); allowed.stageTint.add('gold'); allowed.stageTint.add('red'); allowed.stripe.add('sunset'); allowed.stripe.add('chevron'); allowed.stripe.add('split'); allowed.emblem.add('flag'); allowed.title.add('contender'); allowed.title.add('pbHunter'); }
  if (tracks >= 8) { allowed.theme.add('forest'); allowed.theme.add('ember'); allowed.theme.add('crimson'); allowed.accent.add('violet'); allowed.accent.add('ice'); allowed.finish.add('carbon'); allowed.plate.add('bar'); allowed.edge.add('dashed'); allowed.stage.add('night'); allowed.stage.add('storm'); allowed.stageTint.add('pink'); allowed.stageTint.add('mono'); allowed.stripe.add('grid'); allowed.stripe.add('circuit'); allowed.stripe.add('scan'); allowed.stripe.add('blocks'); allowed.emblem.add('flame'); allowed.emblem.add('twinStars'); allowed.title.add('trackGrinder'); }
  if (podium) { allowed.theme.add('podium'); allowed.finish.add('horizon'); allowed.stage.add('podium'); allowed.stripe.add('gold'); allowed.emblem.add('crown'); allowed.title.add('podiumRegular'); }
  if (betaTester) { allowed.theme.add('beta'); allowed.stripe.add('beta'); allowed.badge.add('betaTester'); allowed.title.add('betaRacer'); }
  return allowed.theme.has(value.theme) && allowed.accent.has(value.accent) && allowed.finish.has(value.finish) && allowed.plate.has(value.plate) && allowed.edge.has(value.edge) && allowed.stage.has(value.stage) && allowed.stageTint.has(value.stageTint) && allowed.stripe.has(value.stripe) && allowed.emblem.has(value.emblem) && allowed.title.has(value.title) && allowed.badge.has(value.badge);
}
function cosmeticEntitlement(entry={},beta=false){
  const defaults=sanitizeProfileCosmetics({});
  return Object.fromEntries(Object.entries(PROFILE_COSMETIC_OPTIONS).map(([kind,values])=>[kind,[...values].filter(value=>profileCosmeticsUnlocked({...defaults,[kind]:value},entry,beta))]));
}

const LEGACY_COMMUNITY_IDS = new Set(['5aafb733c264d51b09beedc7bd7eabb5e65bdded338980fcb14ae5ce36955572']);
const OFFICIAL_IDS = new Set(["5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038","7eac4fee1111152cfba4d3737410264ca0f22c7f5a2211e79f0099589b8b48c0","148826aa16ffaa23dbc453b32cff05e025ddbce1773fc7733cc13d218926515a","93c7363dfea7fb09ca1d23b72cad5df43a30841d41c8ff25fb544c85bb03c7ae","7603aaeffa1989a649dfaa8e1804bed4481b49df233e377687d0669899566e52","c117823cf6788e3247b9ee63a0c091c07352bbe352c650a7790dc6718148c2fa","e4bcaca3a583bb0eb62a700a69d14e89c852f0c5bf740fca76e0519ebdfc9ab1","7239b17057127936907a805b0caa5d8c6f6c97eca9bdabf1a5312dce479629b7","99864b635d1891d22e17eb9267527a07a92c49c0f02893729fa2ded90e3ca0f9","a5341fe706097cff2a3812a3fc0d87399254557328351ae8e5c882700fc1a196","7d134c939df80c676a258266201beedd3b93572d5603f3ff4339ff8679803715","2fe4bd46b0075cc25fc770ce50adbb68447cf493c999635bb272d231811dd264","c20b4ee3cd517ca6cae7e43f047548757287fbd08ba81b97892a3ef520159a34","88647ea04145fbbbb19b55f1590e038fb0378acb2571110f02cb545cc46b0d57","2806030c503abb41a1a26fa9a570888be14296172bb273798ef0ad87a108a2ec","4697ea67b18c3f49b30a3d8884602115536650bc5435c88e3732e64d21a72d33","e5d084e06db4ab71196fea44efeceb23c8561266a78669c324a38f92581fe2db"]);
const COMMUNITY_IDS = new Set(["fb769ac2ea77e8f19a21a9dd3071742f2342bd49c41e4748d7e8c7903d4f0778","387aab2d3400ebf74b5a780d15c911cdc695053b94be3e7ad23f6ae313b2471c","a680fa81e6a4b9dec06b4197833f0a96334a275faf387d495c9c674ffd6b8686","439f1c61263987365996667f99d65f899ec482dfe21c64edcd9a1b1ae5b4a0a9","dc7783fef2a5fbb7a2d75b9c6fdd6a9d600b833d47c6274374ea4388c707517a","f40d385d5e97e00a166a9a05d19789d8f2bf3621a8c1c8919c8bec41ab6347ab","d57a81355f36d5ef0bd2c063d251baf6d28401c275a8b3e3a62e0ae5071a2559","225fad12335dadc12b60bfa1b31369b1026d8a084fd4670583870fb3b71f7ec0","0338f449b9948f06c03ffc2ab3ab6cf551fd08a9f2c09a16156b93ef52dd4411","27c3384de80b1bed23f1ea15316abe62c8cca33e955805f23d461803f6dee8d4","d9bc51ec180bc46558e079c7949ba10b9ade52078c4c145f217a6a8543df2377","5159a8dac6a1f397407a7b5233ad570613531f6609f7dc897490c28c9f2c7a4e","1783b7b6c30e7fddf7ffb7c8a4a8a3b65c1ef6ec317d908d6eb05e6c905a57f6","ddfe00045807e2786552d1e31e1363384c365487180f65d4eff1aa41e334a8e8","4058e3616fbd79b848e70037adde4f12b4413011050aaf1c9d875cdbe2e33d68","2ec74a179c8aba94354e3c6dee2a2920bedd7d84adf4d0a691f4a7453afdb1e8","76e1920a3ca015033a0b21156848def2c248c95d97ccf4aab2312a0302beefe0","81cede50724b1ee0c2ebcef973c37d620680766bd75771c5ae2728b8732c7a66","76269faf38e8726671c05b2b9044f7aa3e66c4313cb4fa5d0fbb23fc8524fe9e","151f12fd3ebc8942f7aaef669024a0fc149bc220f370753efe14d9371acc9c87","f9283607ecec9c89583205cf08715c8f504cc271eec51209bb6fc0cc37ddc915","64bf7efaed2a47dfb03a6b152e3aef637ac251b68a725a28352f3376ff1384d7","520c4f511821ced30b99bceafbb02e6b7531e867126b0756e68d5e157691ef2f","315c9e95c567cce4feca78f5ad6e8d08d0a22dac0d56061af567b43eea3d4fa8","a8913b96daceb5b615fe45aad2bb104e04eb7db140242934657111e1d1f55b89","66f43b2d2a17f3cee05a127040ca409795058510bd3d1ac7eee224512ec532f5","fcbba504800751b0fb404a7cd1c9591befdf688ad5451ab2bc1f3651590cc5fc","9ba44e8eafd0158e7e1f63e7d609db308c53f337b79e86bd0b630225451eef34","b3889905b6df31cbe302e58e975988385607771605bf6e8e8e8e31b3d2dc8aa1","3cd94552b12fb3a8ac45ca3a5e21a882b71b31c788989b396ab382afc69414ac","3125a5f98c3b43cf1e2604e25e8504bffd714ea5843200fa8ddf0b4c58842f16","a2137c20c03ad1848098b47f70417cc0b0bf169010c825dc6fb82f37066808a0","d03b9f7c10c95f40eed389458be51bdf2437febd5673d028da134e59e503c10b","f68a709a296a60f6e6f73a2da670f95aca424be0f2fda5d6b608ece71f339b7c","a1f41dc9e884d5d4b1b6025158d70f0934dc4d892076e6c4b32dc3f3846b882e","b430aad5e481caa4588e30f46352b876b62f1ba0cf7730a15efd026c91a8f32e","95d8f7cbe11053dbdfaeeb2f3c3d8f53f0d45fb6abeb411a74949a4cf52f427f","409f26b9faf55bd0ad748177bf85ebdcfc0ddd572190e7f464f38b4a60587b7e","c1a2c5aef1029d7bbf946f08cd087dd25bad6e019a41694a48a0024c27627dc8","9e53d03f4efe86834c49ce202b528d769d9aa7a6e17732d0fc56440463956a1b","b77ec520a40c4b38d3d7d653b747b1f8627c98709096568db22cd1bfec534ba6","9f827673c4132828009237a03e12ead73eae87504b4708a79c6cc0858212262d","9acd9aef650c4ccc41bb01f72ed44dfaa13f2e4404d2e3466f09cc1adcd9a9c0","62d9989187e4508f7866e7b30aa187ddbee2595df21ff5988d7fec3589f9048d","b36162623435dc90a54f57590d2baa9f2d67a51cb12c393531f4b6d5e5528ebf","74ae56c0f278a19f3b69f3903198c7b9de09981133205856b53bf6bdf8db4211","9f4597449906aa0c2baf9a4737406385c829533e64e9e972b25b4189f4593a54","28b658c7d10eb8b5de6f465e034e87e40f70b37e4534d8c37d1f2af06b5a36d7","470af92ed4c0a6f62028d7dea4dbc7765d1db16a3698d6a0c271be582a20a7c6","a6b990137e404c9ef2cb4399c463acbed8ebfa3bb82ab5315027118604c4ec03","35fe02bf18312713c05528f0b7b8fd15c83dac50bcdcbd373040a16e8bfcc138","18b69f54f119cfb2867abded9a1574f0799a750ef94aa744d9ec8ef6b4d565ae","5ea46b3ae268a0196dcc59dabe88926400b56e29814658bfed06a284f837cefd","ab8e1c13ddf394102be1cb04adcff8411127f1e7140a216d27a94fc19b7d0428","86335d78d1a06d3dc81d80f84b8ac2e8f6359e9a206826e2c36f7d3f4351bea4","a510bbd3341f2992a12db8a3780cb8943b6087538345d58d16602d6129742df0","8cf99166f12cbb56a9df4e022a0e9b8c78973adb929dbf1e265ebb9f99f01163","33d99aad2ad5cef45b1d3afb8735c5229cfd98ac7cc24916e0da7283f7a545ce","5c00f2c90bcf8230183484225d1a417e45b0ad310379acfafd4c8f1dc7345dd7","009fad7fcc215022c6b2dbb2b6de622f07cd88d4930b8e2b6a6b74c1f5de9e44","1ad53694ee3e96aea27afa7b64d5c29d115de88a17b69cf3fe3f5609c52b040b","2ed125037366052871fbb97da6e1bda49cfeb471f6b9c8fa799d520bdb3683e2","f79b1d863d50f9e3b4489988698065c6d775ff3ec90bf91085bad05ad5ec8316","27429a1d1bf05770851e3919af70f47c6cd7a269c67032b084fb4345f6c271ce","f5c327cf09b90e4de8c3c1f9c910dbb7988cf15485d2e4beec3cc03aef408c5c","7451c2128cb96bc28195cf0ca0f83a46c3b55d78d434232d9de085dd1cf0ab36","af6ef508e1f6e47a462a6998b950ef535d1e8a38fe67ead891bf5f2de1346f43","089f2aebcfe4f24d8dda3a8a630172d2bd13793e78c5247adfaa760743a377e1","5e40f730509204c77e9c610839ed43addddbe0f8aa007168447f7fde38583905","191737cc4d1b74949e992d99371e5c7f5fc446a716af571c6e5449b23e9f4558","39bd3fa6c3c769b298c219aee7561af35a6d856bfee14b46b0b48499e7a57ed5"]);
let firebaseJwks = { keys: [], expiresAt: 0 };
let serviceToken = { value: '', expiresAt: 0 };

function allowedOrigins(env) {
  return new Set(String(env.ALLOWED_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean));
}

function responseHeaders(origin, env) {
  const headers = new Headers({
    'Cache-Control': 'no-store, max-age=0',
    'Content-Type': 'application/json; charset=utf-8',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff'
  });
  if (allowedOrigins(env).has(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Admin-Token');
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set('Access-Control-Max-Age', '600');
    headers.set('Vary', 'Origin');
  }
  return headers;
}

function json(origin, env, status, body, cacheControl = '') {
  const headers = responseHeaders(origin, env);
  if (cacheControl) headers.set('Cache-Control', cacheControl);
  return new Response(JSON.stringify(body), { status, headers });
}

function base64UrlBytes(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function base64Url(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlJson(value) {
  return JSON.parse(new TextDecoder().decode(base64UrlBytes(value)));
}

async function getFirebaseJwk(kid) {
  if (firebaseJwks.expiresAt <= Date.now() || !firebaseJwks.keys.some((key) => key.kid === kid)) {
    const response = await fetch(FIREBASE_JWKS_URL, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('AUTH_KEYS_UNAVAILABLE');
    const payload = await response.json();
    const keys = Array.isArray(payload?.keys) ? payload.keys.filter((key) => key?.kty === 'RSA') : [];
    if (!keys.length) throw new Error('AUTH_KEYS_INVALID');
    const maxAge = Math.max(300, Math.min(21600, Number((response.headers.get('Cache-Control') || '').match(/max-age=(\d+)/i)?.[1]) || 3600));
    firebaseJwks = { keys, expiresAt: Date.now() + maxAge * 1000 };
  }
  const key = firebaseJwks.keys.find((candidate) => candidate.kid === kid);
  if (!key) throw new Error('AUTH_KEY_UNKNOWN');
  return key;
}

export async function verifyFirebaseUser(request, env) {
  if (env.__TEST_UID) return String(env.__TEST_UID);
  const match = (request.headers.get('Authorization') || '').match(/^Bearer\s+([^\s]+)$/i);
  if (!match) throw new Error('AUTH_REQUIRED');
  const parts = match[1].split('.');
  if (parts.length !== 3) throw new Error('AUTH_INVALID');
  const header = base64UrlJson(parts[0]);
  const payload = base64UrlJson(parts[1]);
  if (header.alg !== 'RS256' || !header.kid) throw new Error('AUTH_INVALID');
  const jwk = await getFirebaseJwk(header.kid);
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64UrlBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  const projectId = String(env.FIREBASE_PROJECT_ID || PROJECT_ID);
  const now = Math.floor(Date.now() / 1000);
  if (!valid || payload.aud !== projectId || payload.iss !== `https://securetoken.google.com/${projectId}` || !payload.sub || payload.sub.length > 128 || payload.exp <= now - 30 || payload.iat > now + 30) throw new Error('AUTH_INVALID');
  return String(payload.sub);
}

function pemToBytes(value) {
  const normalized = String(value || '').replace(/\\n/g, '\n').replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
  if (!normalized) throw new Error('SERVICE_ACCOUNT_MISSING');
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function serviceAccessToken(env) {
  if (env.__TEST_ACCESS_TOKEN) return String(env.__TEST_ACCESS_TOKEN);
  if (serviceToken.value && serviceToken.expiresAt > Date.now() + 60000) return serviceToken.value;
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64Url(JSON.stringify({
    iss: String(env.FIREBASE_CLIENT_EMAIL || ''),
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: FIREBASE_TOKEN_URL,
    iat: now,
    exp: now + 3600
  }));
  const key = await crypto.subtle.importKey('pkcs8', pemToBytes(env.FIREBASE_PRIVATE_KEY), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claim}`));
  const assertion = `${header}.${claim}.${base64Url(new Uint8Array(signature))}`;
  const response = await fetch(FIREBASE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
  });
  if (!response.ok) throw new Error('SERVICE_AUTH_FAILED');
  const payload = await response.json();
  serviceToken = { value: String(payload.access_token || ''), expiresAt: Date.now() + Math.max(300, Number(payload.expires_in || 3600) - 60) * 1000 };
  if (!serviceToken.value) throw new Error('SERVICE_AUTH_INVALID');
  return serviceToken.value;
}

function documentBase(env) {
  const project = encodeURIComponent(String(env.FIREBASE_PROJECT_ID || PROJECT_ID));
  return `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;
}

function encodeValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (typeof value === 'object' && typeof value.__firestoreTimestamp==='string') return {timestampValue:value.__firestoreTimestamp};
  if (typeof value === 'object') return { mapValue: { fields: encodeFields(value) } };
  return { stringValue: String(value) };
}

function encodeFields(value) {
  return Object.fromEntries(Object.entries(value || {}).filter(([, field]) => field !== undefined).map(([key, field]) => [key, encodeValue(field)]));
}

function decodeValue(value) {
  if (!value || typeof value !== 'object') return null;
  if ('nullValue' in value) return null;
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('booleanValue' in value) return Boolean(value.booleanValue);
  if ('timestampValue' in value) return {__firestoreTimestamp:value.timestampValue};
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in value) return decodeFields(value.mapValue.fields || {});
  return null;
}

function decodeFields(fields) {
  return Object.fromEntries(Object.entries(fields || {}).map(([key, value]) => [key, decodeValue(value)]));
}

async function firestoreRequest(env, path, init = {}) {
  if (typeof env.__TEST_FIRESTORE === 'function') return env.__TEST_FIRESTORE(path, init);
  const token = await serviceAccessToken(env);
  const response = await fetch(`${documentBase(env)}${path}`, {
    ...init,
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) }
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`FIRESTORE_${response.status}`);
  if (response.status === 204) return null;
  return response.json();
}

async function readDocument(env, collection, id) {
  const payload = await firestoreRequest(env, `/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`);
  return payload ? { id, data: decodeFields(payload.fields || {}), updateTime: payload.updateTime || '' } : null;
}

async function writeDocument(env, collection, id, data, updateTime = '') {
  if(updateTime){
    const result=await commitDocuments(env,[{collection,id,data,prior:{updateTime}}]);
    return {updateTime:result?.writeResults?.[0]?.updateTime||''};
  }
  return firestoreRequest(env, '/' + encodeURIComponent(collection) + '/' + encodeURIComponent(id), {
    method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({fields:encodeFields(data)})
  });
}

// Snapshot and dirty metadata must commit together; conflicts are retried by the caller/job.
async function commitDocuments(env, documents) {
  return firestoreRequest(env, ':commit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({writes: documents.map(({collection,id,data,prior,unconditional=false}) => ({
      update: {name: documentBase(env).replace('https://firestore.googleapis.com/v1/','') + '/' + collection + '/' + id, fields: encodeFields(data)},
      ...(unconditional ? {} : {currentDocument: prior ? {updateTime: prior.updateTime} : {exists: false}})
    }))})
  });
}

async function runQuery(env, collection, where = null, limit = 500) {
  const structuredQuery = { from: [{ collectionId: collection }], limit };
  if (where) structuredQuery.where = { fieldFilter: { field: { fieldPath: where.field }, op: where.op || 'EQUAL', value: encodeValue(where.value) } };
  const payload = await firestoreRequest(env, ':runQuery', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery })
  });
  return (Array.isArray(payload) ? payload : []).flatMap((item) => item.document ? [{
    id: decodeURIComponent(String(item.document.name || '').split('/').pop()),
    data: decodeFields(item.document.fields || {}),
    updateTime: item.document.updateTime || ''
  }] : []);
}

async function runChangedResultsQuery(env, timestamp, limit, afterId = '', legacy = false) {
  const reference = id => ({referenceValue:documentBase(env).replace('https://firestore.googleapis.com/v1/','')+'/'+COLLECTIONS.raceResults+'/'+id});
  const structuredQuery = {
    from:[{collectionId:COLLECTIONS.raceResults}], limit,
    ...(legacy ? {} : {where:{fieldFilter:{field:{fieldPath:'ingestedAt'},op:'GREATER_THAN_OR_EQUAL',value:{timestampValue:timestamp}}}}),
    orderBy: legacy ? [{field:{fieldPath:'__name__'},direction:'ASCENDING'}] : [{field:{fieldPath:'ingestedAt'},direction:'ASCENDING'},{field:{fieldPath:'__name__'},direction:'ASCENDING'}],
    ...(afterId ? {startAt:{before:false,values:legacy?[reference(afterId)]:[{timestampValue:timestamp},reference(afterId)]}} : {})
  };
  const payload=await firestoreRequest(env,':runQuery',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({structuredQuery})});
  return (Array.isArray(payload)?payload:[]).flatMap(item=>item.document?[{id:decodeURIComponent(item.document.name.split('/').pop()),data:decodeFields(item.document.fields||{}),ingestedAt:item.document.fields?.ingestedAt?.timestampValue||'',updateTime:item.document.updateTime||''}]:[]);
}

function safeText(value, max) {
  return String(value || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, max);
}

function raceTime(row) {
  const time = Math.round(Number(row?.timeMs || 0));
  return Number.isFinite(time) && time > 0 && time <= 36000000 ? time : 0;
}

function structurallyValidResult(row, expectedTrackId = '') {
  const trackId = safeText(row?.trackId, 80);
  const accountId = safeText(row?.accountId || row?.userId, 128);
  const frames = Math.round(Number(row?.raceTimeFrames || row?.frames || 0));
  const replay = typeof row?.replay === 'string' ? row.replay : '';
  const replayHash = safeText(row?.replayHash, 128);
  return Boolean(
    accountId &&
    trackId &&
    (!expectedTrackId || trackId === expectedTrackId) &&
    raceTime(row) > 0 &&
    Number.isSafeInteger(frames) && frames > 0 && frames <= 4000000 &&
    replay.length > 0 && replay.length < MAX_REPLAY_LENGTH &&
    (!replayHash || /^[0-9a-f]{32,128}$/i.test(replayHash))
  );
}

async function replayIntegrityValid(row) {
  if (!structurallyValidResult(row)) return false;
  const expected = safeText(row?.replayHash, 128).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) return false;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(row.replay || '')));
  const actual = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return actual === expected;
}

function trackType(trackId) {
  return OFFICIAL_IDS.has(trackId) ? 'official' : (COMMUNITY_IDS.has(trackId) || LEGACY_COMMUNITY_IDS.has(trackId)) ? 'community' : 'custom';
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

export function trackWeightParts(trackId, fieldSize, competitionBoost = 1) {
  const type = trackType(trackId);
  const field = Math.max(0, Number(fieldSize || 0));
  const base = type === 'official' ? 1.6 : type === 'community' ? 1 : 0.6;
  const popularity = field < 2 ? 0 : 0.56 * Math.log2(field) * (field - 1) / (field + 8);
  const competitionFactor = Math.max(0.85, Math.min(1.15, Number(competitionBoost || 1)));
  return { type, field, base, popularity, competition: competitionFactor, finalWeight: base * popularity * competitionFactor };
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

function betaCutoff(env) {
  return Math.max(0, Number(env.BETA_CUTOFF_MS || 0));
}

export function computeTrackEntries(rows, trackId, env = {}, verdicts = {}) {
  const best = new Map();
  for (const row of rows) {
    const accountId = safeText(row.accountId || row.userId, 128);
    const timeMs = raceTime(row);
    if (!accountId || !timeMs || !structurallyValidResult(row, trackId)) continue;
    const previous = best.get(accountId);
    if (previous && previous.timeMs <= timeMs) continue;
    best.set(accountId, {
      accountId,
      userId: accountId,
      trackId,
      name: safeText(row.nickname || row.name || 'Racer', 24) || 'Racer',
      nickname: safeText(row.nickname || row.name || 'Racer', 24) || 'Racer',
      countryCode: safeText(row.countryCode, 8).toUpperCase(),
      timeMs,
      frames: Math.max(1, Number(row.frames || row.raceTimeFrames || timeMs)),
      raceTimeFrames: Math.max(1, Number(row.raceTimeFrames || row.frames || timeMs)),
      replayHash: safeText(row.replayHash, 128) || null,
      uploadId: Number.isSafeInteger(Number(row.uploadId)) && Number(row.uploadId) > 0 ? Number(row.uploadId) : null,
      id: Number.isSafeInteger(Number(row.uploadId)) && Number(row.uploadId) > 0 ? Number(row.uploadId) : null,
      carId: safeText(row.carId, 64) || null,
      carColors: safeText(row.carColors, 64) || null,
      carStyle: safeText(row.carStyle, 256),
      profileCosmetics: sanitizeProfileCosmetics(row.profileCosmetics),
      pbCount: Math.max(0, Number(row.pbCount || 0)),
      totalPlaytimeMs: Math.max(0, Number(row.totalPlaytimeMs || 0)),
      pbAt: Math.max(0, Number(row.pbAt || row.createdAt || 0)),
      createdAt: Math.max(0, Number(row.pbAt || row.createdAt || 0)),
      accountCreatedAt: Math.max(0, Number(row.accountCreatedAt || row.createdAt || 0)),
      verified: verifiedVerdict(row, verdicts[accountId]),
      runVerified: verifiedVerdict(row, verdicts[accountId]),
      verifiedState: verifiedVerdict(row, verdicts[accountId]) ? 1 : 0,
      integrityVerified: row.integrityVerified === true,
      validationState: row.integrityVerified === true ? 'integrity' : 'pending',
      betaTester: betaCutoff(env) > 0 && Number(row.createdAt || 0) > 0 && Number(row.createdAt) <= betaCutoff(env)
    });
  }
  return rankTrustedTrackEntries([...best.values()], trackId);
}

function rankTrustedTrackEntries(rows, trackId) {
  const entries = [...rows].sort((a, b) => a.timeMs - b.timeMs || a.accountId.localeCompare(b.accountId)).slice(0, TRACK_LIMIT);
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

async function persistTrackSnapshot(env, trackId, entries, prior = null) {
  const signatureInput = entries.map((entry) => [
    entry.accountId,
    entry.timeMs,
    entry.pbAt,
    entry.uploadId || '',
    entry.replayHash || '',
    entry.integrityVerified === true ? 1 : 0,
    entry.runVerified === true ? 1 : 0,
    entry.name || '',
    entry.countryCode || '',
    entry.carId || '',
    entry.carColors || '',
    entry.carStyle || '',
    JSON.stringify(entry.profileCosmetics || {})
  ].join(':')).join('|');
  const signature = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(signatureInput)).then((bytes) => base64Url(new Uint8Array(bytes)));
  if (trackSnapshotIsCurrent(prior?.data, signature)) return { changed: false, entries, revision: Number(prior.data.revision || 0) };
  const revision = Math.max(0, Number(prior?.data?.revision || 0)) + 1;
  const now = Date.now();
  const metaDoc = await readDocument(env, COLLECTIONS.meta, 'current');
  const meta = metaDoc?.data || {};
  await commitDocuments(env, [
    {collection:COLLECTIONS.track,id:trackId,prior,data:{trackId,entries,updatedAt:now,builtAt:now,schemaVersion:TRACK_SCHEMA_VERSION,algorithmVersion:ALGORITHM_VERSION,revision,sourceRevision:revision,signature}},
    {collection:COLLECTIONS.meta,id:'current',prior:metaDoc,data:{...meta,algorithmVersion:ALGORITHM_VERSION,schemaVersion:TRACK_SCHEMA_VERSION,dirty:true,revision:Math.max(Number(meta.revision||0)+1,revision),builtRevision:Number(meta.builtRevision||0),lastPbAt:now,updatedAt:now,rankedWritesEnabled:String(env.RANKED_WRITES_ENABLED)!=='false',multiplayerEnabled:String(env.MULTIPLAYER_ENABLED)!=='false'}}
  ]);
  return { changed: true, entries, revision };
}

export function trackSnapshotIsCurrent(snapshot, signature) {
  return snapshot?.signature === signature
    && snapshot.algorithmVersion === ALGORITHM_VERSION
    && Number(snapshot.schemaVersion || 0) >= TRACK_SCHEMA_VERSION;
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

export function computeOverall(trackDocuments, priorEntries = [], betaTesterIds = new Set(), {includePlannerResults = false} = {}) {
  const users = new Map();
  for (const board of trackDocuments) {
    const trackId = safeText(board.trackId, 80);
    const entries = rankTrustedTrackEntries((Array.isArray(board.entries) ? board.entries : []).filter((entry) => entry.integrityVerified === true), trackId);
    if (!trackId || entries.length < 2) continue;
    for (const entry of entries) {
      const accountId = safeText(entry.accountId || entry.userId, 128);
      if (!accountId) continue;
      const rank = Number(entry.rank || 0);
      const fieldSize = entries.length;
      const weight = Number(entry.weight || 0);
      if (!rank || weight <= 0) continue;
      const cost = placementCost(rank, fieldSize);
      const user = users.get(accountId) || { userId: accountId, finishes: [], officialCount: 0, communityCount: 0, customCount: 0, pbCount: 0, totalPlaytimeMs: 0, accountCreatedAt: 0, latestPbAt: 0, betaTester: false };
      Object.assign(user, {
        name: entry.name || user.name || 'Racer', countryCode: entry.countryCode || user.countryCode || '', carId: entry.carId || user.carId || null,
        carColors: entry.carColors || user.carColors || null, carStyle: entry.carStyle || user.carStyle || '', profileCosmetics: sanitizeProfileCosmetics(entry.profileCosmetics || user.profileCosmetics)
      });
      user.pbCount = Math.max(user.pbCount, Number(entry.pbCount || 0));
      user.totalPlaytimeMs = Math.max(user.totalPlaytimeMs, Number(entry.totalPlaytimeMs || 0));
      user.latestPbAt = Math.max(user.latestPbAt, Number(entry.pbAt || 0));
      const created = Number(entry.accountCreatedAt || entry.createdAt || 0);
      if (created) user.accountCreatedAt = user.accountCreatedAt ? Math.min(user.accountCreatedAt, created) : created;
      user.betaTester ||= entry.betaTester === true || betaTesterIds.has(accountId);
      const type = trackType(trackId);
      user[`${type}Count`] += 1;
      user.finishes.push({ trackId, rank, fieldSize, weight, placementCost: cost, contribution: Math.max(0, (100 - cost) * weight), improvementValue: cost * weight, timeMs: raceTime(entry), pbAt: Number(entry.pbAt || 0), type, competition: Number(entry.competition || 1) });
      users.set(accountId, user);
    }
  }
  const rows = [...users.values()].map((user) => {
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
      userId: user.userId, name: safeText(user.name, 24), countryCode: safeText(user.countryCode, 8).toUpperCase(), carId: user.carId, carColors: user.carColors, carStyle: user.carStyle, profileCosmetics: sanitizeProfileCosmetics(user.profileCosmetics),
      accountCreatedAt: user.accountCreatedAt, latestPbAt: user.latestPbAt, totalPlaytimeMs: user.totalPlaytimeMs, score, raceCount: played, eligibleTrackCount: played,
      provisional: played < MIN_RANKED_TRACKS, totalTracks: OFFICIAL_IDS.size + COMMUNITY_IDS.size + LEGACY_COMMUNITY_IDS.size, officialCount: user.officialCount, communityCount: user.communityCount, customCount: user.customCount,
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
  }).sort((a, b) => Number(a.provisional) - Number(b.provisional) || a.score - b.score || b.raceCount - a.raceCount || a.userId.localeCompare(b.userId)).slice(0, OVERALL_LIMIT);
  const prior = new Map((priorEntries || []).map((entry) => [entry.userId, entry]));
  const now = Date.now();
  let ranked = 0;
  return rows.map((row) => {
    const rank = row.provisional ? 0 : ++ranked;
    const previous = prior.get(row.userId);
    const changed = previous && Number(previous.rank) > 0 && rank > 0 ? Number(previous.rank) - rank : 0;
    return { ...row, rank, movement: changed, movementAt: changed ? now : Number(previous?.movementAt || 0), rankSince: previous && Number(previous.rank) === rank ? Number(previous.rankSince || now) : now, scoreDelta: previous ? Number(row.score - Number(previous.score || 0)) : 0 };
  });
}

async function prepareVerification(env, trackId, rows, complete = false) {
  // One queue document per track avoids a verification read per racer on every PB.
  const prior=await readDocument(env,VERIFICATION_COLLECTION,trackId);
  const slots=Object.assign(Object.create(null),prior?.data?.slots||{});let changed=false;
  if(complete){const present=new Set(rows.map(row=>safeText(row.accountId||row.userId,128)));for(const id of Object.keys(slots))if(!present.has(id)){delete slots[id];changed=true;}}
  for(const row of rows){
    if(!structurallyValidResult(row,trackId))continue;
    const id=safeText(row.accountId||row.userId,128);
    if(slots[id]?.reason==='canonical_missing'||slots[id]?.key!==verificationKey(row)&&!hasAcceptedVerifiedProof(row,slots[id])){slots[id]=pendingSlot(row);changed=true;}
  }
  if(Object.keys(slots).length>TRACK_LIMIT)throw new Error('VERIFICATION_TRACK_CAP');
  if(changed)await commitDocuments(env,[{collection:VERIFICATION_COLLECTION,id:trackId,prior,data:{trackId,slots,...verificationSchedule(slots),updatedAt:Date.now()}}]);
  return slots;
}

export async function rebuildTrack(env, trackId, identityOverride = null) {
  const prior = await readDocument(env, COLLECTIONS.track, trackId);
  const candidates = (await runQuery(env, COLLECTIONS.raceResults, { field: 'trackId', value: trackId }, TRACK_LIMIT + 1)).map((document) => document.data);
  if(candidates.length > TRACK_LIMIT) throw new Error('TRACK_CAP_REQUIRES_PAGINATION');
  const integrity = await Promise.all(candidates.map((row) => replayIntegrityValid(row)));
  const rows = candidates.map((row, index) => ({ ...row, integrityVerified: integrity[index], validationState: integrity[index] ? 'integrity' : 'pending' }));
  if (identityOverride?.accountId) {
    for (const row of rows) {
      if (safeText(row.accountId, 128) !== identityOverride.accountId) continue;
      row.name = identityOverride.name;
      row.nickname = identityOverride.name;
      row.countryCode = identityOverride.countryCode;
      row.carId = identityOverride.carId;
      row.carColors = identityOverride.carColors;
      row.carStyle = identityOverride.carStyle;
      row.profileCosmetics = identityOverride.profileCosmetics;
    }
  }
  const verdicts=await prepareVerification(env,trackId,rows,true);
  const entries = computeTrackEntries(rows, trackId, env, verdicts);
  return persistTrackSnapshot(env, trackId, entries, prior);
}

export async function mergeCanonicalResultIntoTrack(env, trackId, canonicalResult, integrityVerified = false) {
  const prior = await readDocument(env, COLLECTIONS.track, trackId);
  if (!prior || prior.data?.algorithmVersion !== ALGORITHM_VERSION || !Array.isArray(prior.data?.entries)) return rebuildTrack(env, trackId);
  let normalized = computeTrackEntries([{ ...canonicalResult, integrityVerified, validationState: integrityVerified ? 'integrity' : 'pending' }], trackId, env)[0];
  if (!normalized) throw new Error('Canonical PB failed structural validation');
  const existing=prior.data.entries.find(row=>safeText(row.accountId||row.userId,128)===normalized.accountId);
  // Equal PB repair must use current canonical data, not a delayed notification payload.
  if(existing && Number(existing.timeMs)===normalized.timeMs && Number(existing.uploadId||0)===Number(normalized.uploadId||0) &&
    (existing.replayHash!==normalized.replayHash || (existing.integrityVerified===true)!==(normalized.integrityVerified===true)))return rebuildTrack(env,trackId);
  if(existing && (Number(existing.timeMs)<normalized.timeMs || (Number(existing.timeMs)===normalized.timeMs && Number(existing.uploadId||0)>=Number(normalized.uploadId||0)))) {
    if (Number(existing.timeMs) === normalized.timeMs && Number(existing.uploadId || 0) === Number(normalized.uploadId || 0)) {
      await prepareVerification(env, trackId, [canonicalResult]);
    }
    return {changed:false,entries:prior.data.entries,revision:Number(prior.data.revision||0)};
  }
  const verdicts=await prepareVerification(env,trackId,[canonicalResult]);
  normalized=computeTrackEntries([{...canonicalResult,integrityVerified}],trackId,env,verdicts)[0];
  const entries = rankTrustedTrackEntries([
    ...prior.data.entries.filter((entry) => safeText(entry.accountId || entry.userId, 128) !== normalized.accountId),
    normalized
  ], trackId);
  return persistTrackSnapshot(env, trackId, entries, prior);
}

export async function bootstrapSnapshotVerification(env) {
  const prior = await readDocument(env, COLLECTIONS.jobs, VERIFICATION_BOOTSTRAP_ID);
  const job = prior?.data || {};
  if (job.complete === true) return { scanned: 0, complete: true };
  const structuredQuery = {
    from: [{ collectionId: COLLECTIONS.track }],
    orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
    limit: VERIFICATION_BOOTSTRAP_BATCH,
    ...(job.cursor ? { startAt: { before: false, values: [{ referenceValue: job.cursor }] } } : {})
  };
  const response = await firestoreRequest(env, ':runQuery', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery })
  });
  const boards = (response || []).filter(item => item.document).map(item => item.document);
  const writes = [];
  for (const board of boards) {
    const trackId = decodeURIComponent(board.name.split('/').pop());
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(trackId)) throw Error('INVALID_BOOTSTRAP_TRACK');
    const data = decodeFields(board.fields || {});
    if (!Array.isArray(data.entries) || data.entries.length > TRACK_LIMIT) throw Error('INVALID_BOOTSTRAP_BOARD');
    const queue = await readDocument(env, VERIFICATION_COLLECTION, trackId);
    const slots = bootstrapSlots(trackId, data.entries, queue?.data?.slots);
    writes.push({ collection: VERIFICATION_COLLECTION, id: trackId, prior: queue,
      data: { ...queue?.data, trackId, slots, ...verificationSchedule(slots), updatedAt: Date.now() } });
  }
  const complete = boards.length < VERIFICATION_BOOTSTRAP_BATCH;
  writes.push({ collection: COLLECTIONS.jobs, id: VERIFICATION_BOOTSTRAP_ID, prior,
    data: { ...job, cursor: boards.at(-1)?.name || job.cursor || '', complete,
      processed: Number(job.processed || 0) + boards.length, updatedAt: Date.now() } });
  // Queue merges and cursor advancement succeed together, or the same page retries.
  await commitDocuments(env, writes);
  return { scanned: boards.length, complete };
}

export async function reconcileCanonicalChanges(env) {
  // New namespace discards any cursor poisoned by legacy client-clock timestamps.
  const jobId='canonical_reconcile_v2';
  const document=await readDocument(env,COLLECTIONS.jobs,jobId);
  const job=document?.data||{};
  const timestamp=typeof job.cursorIngestedAt==='string'?job.cursorIngestedAt:'1970-01-01T00:00:00.000000000Z';
  const queued=new Set((job.pendingTrackIds||[]).map(id=>safeText(id,80)).filter(Boolean));
  const capacity=Math.max(0,200-queued.size);
  const budget=Math.min(RECONCILE_RESULT_BATCH,Math.floor(capacity/2));
  const changed=budget?await runChangedResultsQuery(env,timestamp,budget,safeText(job.cursorDocumentId,256)):[];
  const legacy=budget&&!job.backfillComplete?await runChangedResultsQuery(env,timestamp,budget,safeText(job.backfillDocumentId,256),true):[];
  for(const row of [...changed,...legacy])if(structurallyValidResult(row.data,row.data.trackId))queued.add(safeText(row.data.trackId,80));
  let rebuilt=0;
  for(const id of [...queued].slice(0,RECONCILE_TRACK_BATCH)){
    try{await rebuildTrack(env,id);queued.delete(id);rebuilt++;}
    catch(error){queued.delete(id);queued.add(id);console.error('Canonical track reconciliation failed',id,String(error?.message||error));}
  }
  if(document&&!changed.length&&!legacy.length&&!queued.size&&!rebuilt&&job.backfillComplete)return {scanned:0,rebuilt:0,pending:0,unchanged:true};
  await commitDocuments(env,[{collection:COLLECTIONS.jobs,id:jobId,prior:document,data:{
    cursorIngestedAt:changed.length?changed.at(-1).ingestedAt:timestamp,
    cursorDocumentId:changed.length?changed.at(-1).id:safeText(job.cursorDocumentId,256),
    backfillDocumentId:legacy.length?legacy.at(-1).id:safeText(job.backfillDocumentId,256),
    backfillComplete:Boolean(job.backfillComplete||(budget&&legacy.length<budget)),
    pendingTrackIds:[...queued],lastScanAt:Date.now(),schemaVersion:2
  }}]);
  return {scanned:changed.length+legacy.length,rebuilt,pending:queued.size};
}

async function mapConcurrent(values, concurrency, mapper) {
  const output = new Array(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      output[index] = await mapper(values[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

export async function rebuildOverall(env, force = false) {
  const metaDoc = await readDocument(env, COLLECTIONS.meta, 'current');
  const meta = metaDoc?.data || {};
  const now = Date.now();
  const metricsOutdated = Number(meta.plannerPublicationVersion || 0) < PLANNER_PUBLICATION_VERSION || Number(meta.plannerBundleVersion || 0) < PLANNER_BUNDLE_VERSION || Number(meta.cosmeticEntitlementVersion||0)<2 || Number(meta.averagePlacementVersion || 0) < AVERAGE_PLACEMENT_VERSION || Number(meta.derivedMetricsVersion || 0) < DERIVED_METRICS_VERSION;
  if (!force && !metricsOutdated && (!meta.dirty || now - Number(meta.lastOverallBuildAt || 0) < REBUILD_COOLDOWN_MS)) return { rebuilt: false, reason: meta.dirty ? 'cooldown' : 'clean', revision: Number(meta.builtRevision || 0) };
  const boards = (await runQuery(env, COLLECTIONS.track, null, 100)).map((document) => document.data);
  const priorDoc = await readDocument(env, COLLECTIONS.overall, 'main');
  const prior = priorDoc?.data || {};
  const migration = (await readDocument(env, COLLECTIONS.jobs, 'release_migration'))?.data || {};
  const betaTesterIds = new Set([...(migration.awardedBadgeIds || []),...(migration.pendingBadges || [])].map((value) => safeText(value, 128)).filter(Boolean));
  const computedEntries = computeOverall(boards, prior.entries || [], betaTesterIds, {includePlannerResults: true});
  const entries = computedEntries.map(({resultSamples, ...entry}) => entry);
  const trackSummaries = boards.map((board) => ({...board,entries:rankTrustedTrackEntries((Array.isArray(board.entries)?board.entries:[]).filter((entry)=>entry.integrityVerified===true),safeText(board.trackId,80))})).filter((board) => board.entries.length >= 2).map((board) => {
    const leader = board.entries[0] || {};
    return {
      trackId: safeText(board.trackId, 80),
      type: trackType(board.trackId),
      fieldSize: board.entries.length,
      weight: Number(leader.weight || 0),
      recordMs: raceTime(leader),
      updatedAt: Number(board.updatedAt || board.builtAt || now),
      leader: {
        accountId: safeText(leader.accountId || leader.userId, 128),
        name: safeText(leader.name || leader.nickname || 'Racer', 24),
        countryCode: safeText(leader.countryCode, 8).toUpperCase(),
        carStyle: safeText(leader.carStyle, 256),
        timeMs: raceTime(leader),
        rank: 1
      }
    };
  }).filter((summary) => summary.trackId).sort((a, b) => b.weight - a.weight || b.fieldSize - a.fieldSize || a.trackId.localeCompare(b.trackId));
  const priorById=new Map((prior.entries||[]).map(row=>[row.userId,row]));
  const entitlementWrites=[];
  for(const row of entries){
    const allowance=cosmeticEntitlement(row,betaTesterIds.has(row.userId));
    const old=priorById.get(row.userId);
    if(Number(meta.cosmeticEntitlementVersion||0)<2||!old||JSON.stringify(allowance)!==JSON.stringify(cosmeticEntitlement(old,old.badges?.betaTester===true)))entitlementWrites.push({collection:'0.6.2_s1_cosmetic_entitlements',id:row.userId,data:allowance,unconditional:true});
  }
  const revision = Number(meta.revision || 0);
  const snapshot = { entries, trackSummaries, updatedAt: now, builtAt: now, seededBy: 'polytrack-ranked-worker', revision, builtRevision: revision, sourceRevision: revision, algorithmVersion: ALGORITHM_VERSION, schemaVersion: TRACK_SCHEMA_VERSION, averagePlacementVersion: AVERAGE_PLACEMENT_VERSION, derivedMetricsVersion: DERIVED_METRICS_VERSION, entryLimit: OVERALL_LIMIT, trackLimit: TRACK_LIMIT };
  const packed = await packPlannerResults(computedEntries, snapshot, {boardCount: boards.length, boardLimit: 100});
  const resultWrites = [];
  if (packed.resultBundleStatus === 'sidecar') {
    const {resultBundle, ...metadata} = packed;
    Object.assign(snapshot, metadata, {resultBundleLocation: 'main_results'});
    const sidecar = {...packed, resultBundleStatus: 'complete', sourceRevision: snapshot.sourceRevision,
      builtRevision: snapshot.builtRevision, updatedAt: snapshot.updatedAt, algorithmVersion: snapshot.algorithmVersion};
    // The guarded main/meta writes protect this sidecar in the same atomic commit, without another read.
    resultWrites.push({collection: COLLECTIONS.overall, id: 'main_results', data: sidecar, unconditional: true});
  } else {
    Object.assign(snapshot, packed);
  }
  if (plannerDocumentBytes(snapshot) >= 1048576) throw Error('OVERALL_DOCUMENT_CAP');
  await commitDocuments(env,[...entitlementWrites,...resultWrites,{collection:COLLECTIONS.overall,id:'main',prior:priorDoc,data: snapshot},{collection:COLLECTIONS.meta,id:'current',prior:metaDoc,data: { ...meta, plannerPublicationVersion:PLANNER_PUBLICATION_VERSION, plannerBundleVersion:PLANNER_BUNDLE_VERSION, cosmeticEntitlementVersion:2, dirty: false, revision, builtRevision: revision, lastOverallBuildAt: now, updatedAt: now, algorithmVersion: ALGORITHM_VERSION, schemaVersion: TRACK_SCHEMA_VERSION, averagePlacementVersion: AVERAGE_PLACEMENT_VERSION, derivedMetricsVersion: DERIVED_METRICS_VERSION, rankedWritesEnabled: String(env.RANKED_WRITES_ENABLED) !== 'false', multiplayerEnabled: String(env.MULTIPLAYER_ENABLED) !== 'false' }}]);
  return { rebuilt: true, revision, racers: entries.length, tracks: trackSummaries.length };
}

async function notifyProfile(request, env, context, uid, body) {
  const accountId = safeText(body.accountId, 128);
  if (!accountId) return json(request.headers.get('Origin') || '', env, 400, { error: 'invalid_account_id' });
  const profile = await readDocument(env, COLLECTIONS.profiles, accountId);
  if (!profile || profile.data.ownerUid !== uid || safeText(profile.data.accountId, 128) !== accountId) {
    return json(request.headers.get('Origin') || '', env, 403, { error: 'profile_not_owned' });
  }
  const results = await runQuery(env, COLLECTIONS.raceResults, { field: 'accountId', value: accountId }, 100);
  const identity = {
    accountId,
    name: safeText(profile.data.nickname || profile.data.name || 'Racer', 24) || 'Racer',
    countryCode: safeText(profile.data.countryCode, 8).toUpperCase(),
    carId: safeText(profile.data.carId, 64) || null,
    carColors: safeText(profile.data.carColors, 64) || null,
    carStyle: safeText(profile.data.carStyle, 256),
    profileCosmetics: sanitizeProfileCosmetics(profile.data.profileCosmetics)
  };
  const trackIds = [...new Set(results.map((result) => safeText(result.data.trackId, 80)).filter(Boolean))].slice(0, 100);
  const signature = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(identity))).then((bytes) => base64Url(new Uint8Array(bytes)));
  const jobId = `profile_${accountId}`;
  const existingDoc=await readDocument(env,COLLECTIONS.jobs,jobId);
  const existing=existingDoc?.data||{};
  if (existing.signature === signature && (!Array.isArray(existing.pendingTrackIds) || existing.pendingTrackIds.length === 0)) {
    return json(request.headers.get('Origin') || '', env, 200, { accepted: true, accountId, queued: 0, unchanged: true });
  }
  const pendingTrackIds = existing.signature === signature
    ? [...new Set([...(existing.pendingTrackIds || []), ...trackIds])]
    : trackIds;
  const written=await writeDocument(env, COLLECTIONS.jobs, jobId, { kind: 'profile', active: pendingTrackIds.length > 0, accountId, identity, signature, pendingTrackIds, createdAt: Number(existing.createdAt || Date.now()), updatedAt: Date.now() },existingDoc?.updateTime||'');
  const task = processProfileJob(env, jobId, { kind: 'profile', active: true, accountId, identity, signature, pendingTrackIds },written?.updateTime||'');
  if (context.waitUntil) context.waitUntil(task.catch((error) => console.error('Deferred profile job failed', String(error?.message || error))));
  return json(request.headers.get('Origin') || '', env, 202, { accepted: true, accountId, queued: pendingTrackIds.length });
}

async function updateProfileCosmetics(request, env, context, uid, body) {
  const origin = request.headers.get('Origin') || '';
  const accountId = safeText(body.accountId, 128);
  if (!accountId) return json(origin, env, 400, { error: 'invalid_account_id' });
  const profile = await readDocument(env, COLLECTIONS.profiles, accountId);
  if (!profile || profile.data.ownerUid !== uid || safeText(profile.data.accountId, 128) !== accountId) {
    return json(origin, env, 403, { error: 'profile_not_owned' });
  }
  const cosmetics = sanitizeProfileCosmetics(body.cosmetics);
  if(profile.data.cosmeticsSyncedAt && JSON.stringify(cosmetics)!==JSON.stringify(sanitizeProfileCosmetics(profile.data.profileCosmetics)))return json(origin,env,409,{error:'cosmetics_superseded'});
  const [overall, badge] = await Promise.all([
    readDocument(env, COLLECTIONS.overall, 'main'),
    readDocument(env, COLLECTIONS.badges, accountId)
  ]);
  const entry = (Array.isArray(overall?.data?.entries) ? overall.data.entries : []).find((row) => safeText(row.userId || row.accountId, 128) === accountId) || {};
  const betaTester = badge?.data?.betaTester === true || entry?.badges?.betaTester === true;
  if (!profileCosmeticsUnlocked(cosmetics, entry, betaTester)) return json(origin, env, 403, { error: 'cosmetic_locked' });
  await writeDocument(env, COLLECTIONS.profiles, accountId, { ...profile.data, profileCosmetics: cosmetics, updatedAt: Date.now() }, profile.updateTime);
  if (overall?.data && Array.isArray(overall.data.entries)) {
    const entries = overall.data.entries.map((row) => safeText(row.userId || row.accountId, 128) === accountId ? { ...row, profileCosmetics: cosmetics } : row);
    await writeDocument(env, COLLECTIONS.overall, 'main', { ...overall.data, entries, identityUpdatedAt: Date.now() }, overall.updateTime);
  }
  return notifyProfile(request, env, context, uid, { accountId });
}

async function processProfileJob(env, jobId, job, updateTime='') {
  const pending = Array.isArray(job.pendingTrackIds) ? job.pendingTrackIds.map((value) => safeText(value, 80)).filter(Boolean) : [];
  const batch = pending.slice(0, 3);
  let changed = 0;
  for (const trackId of batch) if ((await rebuildTrack(env, trackId, job.identity)).changed) changed += 1;
  const remaining = pending.slice(batch.length);
  await writeDocument(env, COLLECTIONS.jobs, jobId, { ...job, active: remaining.length > 0, pendingTrackIds: remaining, processed: Math.max(0, Number(job.processed || 0)) + batch.length, changed: Math.max(0, Number(job.changed || 0)) + changed, updatedAt: Date.now(), completedAt: remaining.length ? 0 : Date.now() },updateTime);
  if (changed) await rebuildOverall(env, false);
  return { checked: batch.length, changed, remaining: remaining.length };
}

async function processProfileJobs(env) {
  const jobs = await runQuery(env, COLLECTIONS.jobs, { field: 'active', value: true }, 5);
  for (const job of jobs.slice(0,1)) {
    if (job.data.kind !== 'profile') continue;
    if (!Array.isArray(job.data.pendingTrackIds) || !job.data.pendingTrackIds.length) continue;
    await processProfileJob(env, job.id, job.data,job.updateTime);
  }
}

async function processCosmeticJobs(env) {
  const jobs = await runQuery(env, COLLECTIONS.cosmeticJobs, { field: 'active', value: true }, 1);
  for (const job of jobs) {
    const accountId = safeText(job.data.accountId, 128);
    const ownerUid = safeText(job.data.ownerUid, 128);
    const profile = accountId ? await readDocument(env, COLLECTIONS.profiles, accountId) : null;
    if (!profile || profile.data.ownerUid !== ownerUid || safeText(profile.data.accountId, 128) !== accountId) {
      await writeDocument(env, COLLECTIONS.cosmeticJobs, job.id, { ...job.data, active: false, error: 'profile_not_owned', completedAt: Date.now() },job.updateTime);
      continue;
    }
    // A delayed job must not restore a design superseded by a direct profile save.
    if (JSON.stringify(sanitizeProfileCosmetics(profile.data.profileCosmetics)) !== JSON.stringify(sanitizeProfileCosmetics(job.data.cosmetics))) {
      await writeDocument(env, COLLECTIONS.cosmeticJobs, job.id, { ...job.data, active: false, error: 'superseded', completedAt: Date.now() },job.updateTime);
      continue;
    }
    const cosmetics = sanitizeProfileCosmetics(job.data.cosmetics);
    const [overall, badge] = await Promise.all([
      readDocument(env, COLLECTIONS.overall, 'main'),
      readDocument(env, COLLECTIONS.badges, accountId)
    ]);
    const entry = (Array.isArray(overall?.data?.entries) ? overall.data.entries : []).find((row) => safeText(row.userId || row.accountId, 128) === accountId) || {};
    const betaTester = badge?.data?.betaTester === true || entry?.badges?.betaTester === true;
    if (!profileCosmeticsUnlocked(cosmetics, entry, betaTester)) {
      await writeDocument(env, COLLECTIONS.cosmeticJobs, job.id, { ...job.data, active: false, error: 'cosmetic_locked', completedAt: Date.now() },job.updateTime);
      continue;
    }
    await writeDocument(env, COLLECTIONS.profiles, accountId, { ...profile.data, profileCosmetics: cosmetics, updatedAt: Math.max(Number(profile.data.updatedAt || 0), Number(job.data.updatedAt || 0)) }, profile.updateTime);
    if (overall?.data && Array.isArray(overall.data.entries)) {
      const entries = overall.data.entries.map((row) => safeText(row.userId || row.accountId, 128) === accountId ? { ...row, profileCosmetics: cosmetics } : row);
      await writeDocument(env, COLLECTIONS.overall, 'main', { ...overall.data, entries, identityUpdatedAt: Date.now() }, overall.updateTime);
    }
    const deferred = [];
    const origin = [...allowedOrigins(env)][0] || '';
    await notifyProfile(new Request('https://polytrack-ranked.internal/v1/profile/notify', { headers: { Origin: origin } }), env, { waitUntil(task) { deferred.push(task); } }, ownerUid, { accountId });
    await Promise.allSettled(deferred);
    await writeDocument(env, COLLECTIONS.cosmeticJobs, job.id, { ...job.data, active: false, completedAt: Date.now(), error: '' },job.updateTime);
  }
}

async function createMigrationJob(env, prior = null) {
  const [betaBoards, canonicalResults] = await Promise.all([
    runQuery(env, COLLECTIONS.betaTrack, null, 100),
    runQuery(env, COLLECTIONS.raceResults, null, 1000)
  ]);
  const trackIds = [...new Set([
    ...betaBoards.map((board) => safeText(board.data.trackId || board.id, 80)),
    ...canonicalResults.map((result) => safeText(result.data.trackId, 80))
  ].filter(Boolean))].sort();
  const cutoff=betaCutoff(env);
  const betaCandidateIds=[...new Set(betaBoards.flatMap((board)=>Array.isArray(board.data.entries)?board.data.entries:[]).filter((entry)=>{
    const timestamp=Number(entry.pbAt||entry.createdAt||entry.timestamp||0);
    return safeText(entry.accountId||entry.userId,128)&&timestamp>0&&timestamp<=cutoff;
  }).map((entry)=>safeText(entry.accountId||entry.userId,128)))];
  const previouslyAwarded = Array.isArray(prior?.awardedBadgeIds) ? prior.awardedBadgeIds.map((value) => safeText(value, 128)).filter(Boolean) : [];
  const job = { kind: 'migration', migrationVersion: MIGRATION_VERSION, pendingTrackIds: trackIds, betaCandidateIds, pendingBadges: [], awardedBadgeIds: previouslyAwarded, processedTracks: 0, awardedBadges: previouslyAwarded.length, createdAt: Date.now(), updatedAt: Date.now(), completedAt: 0 };
  await writeDocument(env, COLLECTIONS.jobs, 'release_migration', job);
  return processMigrationJob(env, job);
}

async function resumeOrCreateMigration(env) {
  const existing = (await readDocument(env, COLLECTIONS.jobs, 'release_migration'))?.data;
  if (existing?.kind === 'migration' && Number(existing.completedAt || 0) === 0) return processMigrationJob(env, existing);
  if (existing?.kind === 'migration' && Number(existing.completedAt || 0) > 0 && Number(existing.migrationVersion || 0) >= MIGRATION_VERSION) {
    return { active: false, tracksRemaining: 0, badgesRemaining: 0, processedTracks: Number(existing.processedTracks || 0), awardedBadges: Number(existing.awardedBadges || 0), migrationVersion: MIGRATION_VERSION };
  }
  return createMigrationJob(env, existing);
}

async function processMigrationJob(env, supplied = null) {
  const job = supplied || (await readDocument(env, COLLECTIONS.jobs, 'release_migration'))?.data;
  if (!job || job.kind !== 'migration' || Number(job.completedAt || 0) > 0) return { active: false };
  const pendingTracks = Array.isArray(job.pendingTrackIds) ? job.pendingTrackIds : [];
  const candidates = new Set(Array.isArray(job.betaCandidateIds) ? job.betaCandidateIds.map((value) => safeText(value, 128)).filter(Boolean) : []);
  const pendingBadges = new Set(Array.isArray(job.pendingBadges) ? job.pendingBadges.map((value) => safeText(value, 128)).filter(Boolean) : []);
  const awardedBadgeIds = new Set(Array.isArray(job.awardedBadgeIds) ? job.awardedBadgeIds.map((value) => safeText(value, 128)).filter(Boolean) : []);
  const batch = pendingTracks.slice(0, MIGRATION_TRACK_BATCH);
  const rebuiltTracks = await mapConcurrent(batch, 3, (trackId) => rebuildTrack(env, trackId));
  let processedTracks = 0;
  for (const result of rebuiltTracks) {
    for (const entry of result.entries) if ((entry.betaTester || candidates.has(entry.accountId)) && !awardedBadgeIds.has(entry.accountId)) pendingBadges.add(entry.accountId);
    processedTracks += 1;
  }
  const remainingTracks = pendingTracks.slice(processedTracks);
  let awardedBadges = 0;
  if (!remainingTracks.length) {
    const badgeWrites=[];
    for (const accountId of [...pendingBadges].slice(0, MIGRATION_BADGE_BATCH)) {
      badgeWrites.push({collection:COLLECTIONS.badges,id:accountId,data:{accountId,betaTester:true,awardedAt:Date.now(),cutoffAt:betaCutoff(env),source:'release-migration'},unconditional:true});
      pendingBadges.delete(accountId);
      awardedBadgeIds.add(accountId);
      awardedBadges += 1;
    }
    if(badgeWrites.length)await commitDocuments(env,badgeWrites);
  }
  const complete = !remainingTracks.length && pendingBadges.size === 0;
  const next = { ...job, migrationVersion: MIGRATION_VERSION, pendingTrackIds: remainingTracks, pendingBadges: [...pendingBadges], awardedBadgeIds: [...awardedBadgeIds], processedTracks: Math.max(0, Number(job.processedTracks || 0)) + processedTracks, awardedBadges: Math.max(0, Number(job.awardedBadges || 0)) + awardedBadges, updatedAt: Date.now(), completedAt: complete ? Date.now() : 0 };
  await writeDocument(env, COLLECTIONS.jobs, 'release_migration', next);
  if (processedTracks || complete) await rebuildOverall(env, complete);
  return { active: !complete, tracksRemaining: remainingTracks.length, badgesRemaining: pendingBadges.size, processedTracks: next.processedTracks, awardedBadges: next.awardedBadges, migrationVersion: MIGRATION_VERSION };
}

async function requestBody(request) {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > 2048) throw new Error('BODY_TOO_LARGE');
  const text = await request.text();
  if (new TextEncoder().encode(text).length > 2048) throw new Error('BODY_TOO_LARGE');
  return text ? JSON.parse(text) : {};
}

async function publicSnapshot(request, env, context, origin, collection, id) {
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheUrl = new URL(request.url);
  cacheUrl.searchParams.set('__origin', origin);
  cacheUrl.searchParams.set('__schema', String(TRACK_SCHEMA_VERSION));
  cacheUrl.searchParams.set('__algorithm', ALGORITHM_VERSION);
  cacheUrl.searchParams.set('__averagePlacement', String(AVERAGE_PLACEMENT_VERSION));
  cacheUrl.searchParams.set('__integrityState', String(INTEGRITY_STATE_VERSION));
  const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
  if (cache) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }
  const snapshot = await readDocument(env, collection, id);
  if (!snapshot) return json(origin, env, 404, { error: 'snapshot_not_ready' }, 'public, max-age=10, stale-while-revalidate=60');
  const data = collection === COLLECTIONS.track && Array.isArray(snapshot.data.entries)
    ? {
        ...snapshot.data,
        integrityStateVersion: INTEGRITY_STATE_VERSION,
        entries: snapshot.data.entries.map((entry) => ({
          ...entry,
          verifiedState: entry.runVerified === true ? 1 : 0,
        })),
      }
    : snapshot.data;
  const response = json(origin, env, 200, data, 'public, max-age=10, stale-while-revalidate=20');
  if (cache && context.waitUntil) context.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

export async function handleRequest(request, env, context = {}) {
  const origin = request.headers.get('Origin') || '';
  if (!allowedOrigins(env).has(origin)) return json(origin, env, 403, { error: 'origin_not_allowed' });
  const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
  if (path.startsWith('/v1/events/')) return eventWorkerHandler(env, {
    request: (path, init) => firestoreRequest(env, path, init),
    authenticate: request => verifyFirebaseUser(request, env), origins: allowedOrigins(env)
  })(request);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders(origin, env) });
  if (request.method === 'GET' && path === '/v1/status') {
    const meta = (await readDocument(env, COLLECTIONS.meta, 'current').catch(() => null))?.data || {};
    return json(origin, env, 200, { service: 'polytrack-ranked', algorithmVersion: ALGORITHM_VERSION, schemaVersion: TRACK_SCHEMA_VERSION, averagePlacementVersion: AVERAGE_PLACEMENT_VERSION, derivedMetricsVersion: Number(meta.derivedMetricsVersion || 0), currentDerivedMetricsVersion: DERIVED_METRICS_VERSION, rankedWritesEnabled: String(env.RANKED_WRITES_ENABLED) !== 'false', multiplayerEnabled: String(env.MULTIPLAYER_ENABLED) !== 'false', revision: Number(meta.revision || 0), builtRevision: Number(meta.builtRevision || 0), dirty: meta.dirty === true, pendingRevisions: Math.max(0, Number(meta.revision || 0) - Number(meta.builtRevision || 0)), updatedAt: Number(meta.updatedAt || 0) });
  }
  if (request.method === 'GET' && path === '/v1/snapshot/overall') return publicSnapshot(request, env, context, origin, COLLECTIONS.overall, 'main');
  if (request.method === 'GET' && path === '/v1/snapshot/track') {
    const trackId = safeText(new URL(request.url).searchParams.get('trackId'), 80);
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(trackId)) return json(origin, env, 400, { error: 'invalid_track_id' });
    return publicSnapshot(request, env, context, origin, COLLECTIONS.track, trackId);
  }
  if (request.method !== 'POST') return json(origin, env, 404, { error: 'not_found' });
  if (path === '/v1/admin/rebuild') {
    if (!env.ADMIN_REBUILD_TOKEN || request.headers.get('X-Admin-Token') !== env.ADMIN_REBUILD_TOKEN) return json(origin, env, 403, { error: 'admin_required' });
    const result = await rebuildOverall(env, true);
    return json(origin, env, 200, result);
  }
  if (path === '/v1/admin/migrate') {
    if (!env.ADMIN_REBUILD_TOKEN || request.headers.get('X-Admin-Token') !== env.ADMIN_REBUILD_TOKEN) return json(origin, env, 403, { error: 'admin_required' });
    const result = await resumeOrCreateMigration(env);
    return json(origin, env, 202, result);
  }
  if (path === '/v1/admin/reconcile') {
    if (!env.ADMIN_REBUILD_TOKEN || request.headers.get('X-Admin-Token') !== env.ADMIN_REBUILD_TOKEN) return json(origin, env, 403, { error: 'admin_required' });
    const bootstrap = await bootstrapSnapshotVerification(env);
    const reconciliation = await reconcileCanonicalChanges(env);
    const overall = await rebuildOverall(env, false);
    return json(origin, env, 200, { bootstrap, reconciliation, overall });
  }
  if (path !== '/v1/pb/notify' && path !== '/v1/profile/notify' && path !== '/v1/profile/cosmetics') return json(origin, env, 404, { error: 'not_found' });
  if (String(env.RANKED_WRITES_ENABLED) === 'false') return json(origin, env, 503, { error: 'ranked_writes_disabled' });
  let uid;
  try { uid = await verifyFirebaseUser(request, env); } catch { return json(origin, env, 401, { error: 'authentication_failed' }); }
  if (env.PB_NOTIFY_RATE_LIMITER && !(await env.PB_NOTIFY_RATE_LIMITER.limit({ key: uid })).success) return json(origin, env, 429, { error: 'rate_limited', retryAfterSeconds: 60 });
  let body;
  try { body = await requestBody(request); } catch { return json(origin, env, 400, { error: 'invalid_request' }); }
  if (path === '/v1/profile/cosmetics') return updateProfileCosmetics(request, env, context, uid, body);
  if (path === '/v1/profile/notify') return notifyProfile(request, env, context, uid, body);
  const resultId = safeText(body.resultId, 220);
  if (!/^[A-Za-z0-9_.:-]{3,220}$/.test(resultId)) return json(origin, env, 400, { error: 'invalid_result_id' });
  const result = await readDocument(env, COLLECTIONS.raceResults, resultId);
  if (!result || result.data.ownerUid !== uid || resultId !== `${result.data.accountId}_${result.data.trackId}`) return json(origin, env, 403, { error: 'result_not_owned' });
  if (!structurallyValidResult(result.data)) return json(origin, env, 422, { error: 'result_failed_structural_validation' });
  const integrityVerified = await replayIntegrityValid(result.data);
  const trackId = safeText(result.data.trackId, 80);
  const rebuilt = await mergeCanonicalResultIntoTrack(env, trackId, result.data, integrityVerified);
  if (rebuilt.changed && context.waitUntil) context.waitUntil(rebuildOverall(env, false).catch((error) => console.error('Deferred overall rebuild failed', String(error?.message || error))));
  return json(origin, env, 200, { accepted: true, changed: rebuilt.changed, trackId, revision: rebuilt.revision, overallPending: rebuilt.changed, integrityVerified, validationState: integrityVerified ? 'integrity' : 'pending' });
}

export default {
  fetch(request, env, context) {
    return handleRequest(request, env, context).catch((error) => {
      console.error('Ranked Worker request failed', String(error?.message || error));
      const origin = request.headers.get('Origin') || '';
      return json(origin, env, 503, { error: 'service_unavailable' });
    });
  },
  scheduled(_event, env, context) {
    context.waitUntil((async()=>{
      if (_event.cron === '* * * * *') {
        const community = [...COMMUNITY_IDS];
        // Existing TRACK_CATALOG begins with Rolling Hills, then official tracks.
        return eventWorkerMaintenance(env, {
          request: (path, init) => firestoreRequest(env, path, init),
          officialIds: [...OFFICIAL_IDS], allIds: [community[0], ...OFFICIAL_IDS, ...community.slice(1)],
          at: Number(_event.scheduledTime || Date.now()),
          targetForTrack: async trackId => {
            const snapshot = await readDocument(env, COLLECTIONS.track, trackId);
            if (!snapshot?.data?.entries?.length) return null;
            // Cached public labels can outlive a repin; require the exact current private proof.
            const queue = await readDocument(env, VERIFICATION_COLLECTION, trackId);
            return verifiedTargetMs(snapshot.data.entries, queue?.data?.slots || {});
          }
        });
      }
      // Recovery worst case: bootstrap 7 + reconciliation 28 + overall 5 + cold auth 1 = 41 subrequests.
      // Optional maintenance stays in a separate cron invocation.
      const maintenance=_event.cron==='2-59/5 * * * *';
      const tasks=maintenance?[[processCosmeticJobs,processProfileJobs,resumeOrCreateMigration][Math.floor(Number(_event.scheduledTime||Date.now())/300000)%3]]:[bootstrapSnapshotVerification,reconcileCanonicalChanges];
      for (const task of tasks) {
        try { await task(env); }
        catch (error) { console.error('Scheduled task failed', task.name, String(error?.message || error)); }
      }
      await rebuildOverall(env, false);
    })().catch((error) => console.error('Scheduled Ranked work failed', String(error?.message || error))));
  }
};
