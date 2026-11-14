import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {addPurchase,mergeEarnedAndPurchasedEntitlements,SHOP_PROFILE_CATALOG} from '../src/purchased-cosmetic-entitlements.js';
// Saved-rule expression compatibility, NOT a Firestore emulator or live rules test.
// Source: private late-update/live-firestore.rules, read-only; no rules edits.
const rules="    function validProfileCosmetics(cosmetics) {\n      let keys = cosmetics.keys();\n      return cosmetics is map\n        && keys.hasAll(['version', 'theme', 'stage', 'stripe', 'badge'])\n        && keys.hasOnly([\n          'version', 'theme', 'accent', 'finish', 'plate', 'edge',\n          'stage', 'stageTint', 'stageEffect', 'stripe', 'emblem',\n          'emblem2', 'emblem3', 'emblemBackdrop', 'nameFont',\n          'nameSize', 'nameWeight', 'nameColor', 'baseSecondary',\n          'title', 'badge', 'favoriteTrackId', 'overridePodium'\n        ])\n        && cosmetics.version in [1, 2, 3, 4, 5, 6, 7]\n        && text(cosmetics.theme, 1, 32)\n        && text(cosmetics.stage, 1, 32)\n        && text(cosmetics.stripe, 1, 32)\n        && text(cosmetics.badge, 1, 32)\n        && (!('favoriteTrackId' in cosmetics)\n          || cosmetics.favoriteTrackId == ''\n          || text(cosmetics.favoriteTrackId, 8, 80))\n        && (!('overridePodium' in cosmetics)\n          || cosmetics.overridePodium is bool);\n    }\n    function entitledCosmetics(c, accountId) {\n      let path=/databases/$(database)/documents/0.6.2_s1_cosmetic_entitlements/$(accountId);\n      let allowed=exists(path)?get(path).data:{\"theme\":[\"classic\",\"cyan\"],\"accent\":[\"cyan\",\"white\"],\"finish\":[\"gradient\",\"solid\"],\"plate\":[\"block\",\"outline\"],\"edge\":[\"accent\",\"none\"],\"stage\":[\"garage\",\"slate\"],\"stageTint\":[\"natural\",\"blue\"],\"stripe\":[\"standard\",\"cyan\"],\"emblem\":[\"none\",\"bolt\"],\"title\":[\"auto\"],\"badge\":[\"auto\",\"none\"]};\n      return (!('theme' in c) || c.theme in allowed.theme)\n        && (!('accent' in c) || c.accent in allowed.accent)\n        && (!('finish' in c) || c.finish in allowed.finish)\n        && (!('plate' in c) || c.plate in allowed.plate)\n        && (!('edge' in c) || c.edge in allowed.edge)\n        && (!('stage' in c) || c.stage in allowed.stage)\n        && (!('stageTint' in c) || c.stageTint in allowed.stageTint)\n        && (!('stageEffect' in c) || c.stageEffect in allowed.get('stageEffect', ['none']))\n        && (!('stripe' in c) || c.stripe in allowed.stripe)\n        && (!('emblem' in c) || c.emblem in allowed.emblem)\n        && (!('emblem2' in c) || c.emblem2 in allowed.get('emblem2', ['none']))\n        && (!('emblem3' in c) || c.emblem3 in allowed.get('emblem3', ['none']))\n        && (!('emblemBackdrop' in c) || c.emblemBackdrop in allowed.get('emblemBackdrop', ['none']))\n        && (!('nameFont' in c) || c.nameFont in allowed.get('nameFont', ['classic']))\n        && (!('nameSize' in c) || c.nameSize in allowed.get('nameSize', ['normal']))\n        && (!('nameWeight' in c) || c.nameWeight in allowed.get('nameWeight', ['regular']))\n        && (!('nameColor' in c) || c.nameColor in allowed.get('nameColor', ['default']))\n        && (!('baseSecondary' in c) || c.baseSecondary in allowed.get('baseSecondary', ['auto']))\n        && (!('title' in c) || c.title in allowed.title)\n        && (!('badge' in c) || c.badge in allowed.badge);\n    }\n\n";
const deny="match /0.6.2_s1_cosmetic_entitlements/{accountId} {\n      allow read, write: if false;\n    }";

function compile(expression,args,scope){return vm.runInNewContext('(('+args.join(',')+')=>('+expression+'))',scope);}
const validExpression=rules.slice(rules.indexOf('return cosmetics is map')+7,rules.indexOf(';',rules.indexOf('return cosmetics is map')))
 .replace('cosmetics is map','isMap(cosmetics)').replace(/cosmetics\.version in (\[[^\]]+\])/,'$1.includes(cosmetics.version)')
 .replace('cosmetics.overridePodium is bool',"typeof cosmetics.overridePodium === 'boolean'");
const text=(value,min,max)=>typeof value==='string'&&value.length>=min&&value.length<=max;
const valid=compile(validExpression,['cosmetics','keys'],{text,isMap:v=>!!v&&typeof v==='object'&&!Array.isArray(v)});
const membership=rules.slice(rules.indexOf('return (!(\'theme\' in c)')+7,rules.indexOf(';',rules.indexOf('return (!(\'theme\' in c)')))
 .replace(/c\.(\w+) in (allowed\.get\('[^']+', \[[^\]]*\]\)|allowed\.\w+)/g,'$2.includes(c.$1)');
const member=compile(membership,['c','allowed'],{});
const validate=value=>valid(value,{hasAll:required=>required.every(k=>Object.hasOwn(value,k)),hasOnly:allowed=>Object.keys(value).every(k=>allowed.includes(k))});
const entitled=(value,allowance)=>member(value,{...allowance,get:(key,fallback)=>Object.hasOwn(allowance,key)?allowance[key]:fallback});
const accountId='a'.repeat(64),ownerUid='owner',binding={accountId,ownerUid},at=1700000000000;
const design=(version=7)=>({version,theme:'classic',accent:'cyan',finish:'solid',plate:'block',edge:'none',stage:'garage',stageTint:'natural',stripe:'standard',emblem:'none',title:'auto',badge:'auto',favoriteTrackId:'',overridePodium:false});
for(const version of [1,2,3,4,5,6,7])test('saved-rule current/legacy version'+version+' authorizes only purchased union',()=>{
 for(const item of SHOP_PROFILE_CATALOG){const {slot,value}=item.grants[0],cosmetics={...design(version),[slot]:value},purchased=addPurchase(null,item.id,at,binding);
 assert.equal(validate(cosmetics),true);assert.equal(entitled(cosmetics,purchased),true);
 const fresh=addPurchase(null,item.id,at,binding);delete fresh.purchased;fresh[slot]=fresh[slot].filter(v=>v!==value);
 assert.equal(entitled(cosmetics,fresh),false);
 const rebuilt=mergeEarnedAndPurchasedEntitlements(fresh,purchased,binding);assert.equal(entitled(cosmetics,rebuilt),true);}
});
test('three ownership grants survive rebuild together without enabling beta badge or arbitrary fields',()=>{
 let allowance=null;for(const item of SHOP_PROFILE_CATALOG)allowance=addPurchase(allowance,item.id,at,binding);
 const full=design();for(const item of SHOP_PROFILE_CATALOG)full[item.grants[0].slot]=item.grants[0].value;
 assert.equal(validate(full),true);assert.equal(entitled(full,allowance),true);
 assert.equal(entitled({...full,badge:'betaTester'},allowance),false);
 for(const injection of [{purchased:{version:1}},{serverIssued:{achievements:{}}},{balance:999},{ownedItemIds:['all']}])assert.equal(validate({...full,...injection}),false);
});
test('saved entitlement rules remain deny-all and use ordinary slot membership, not a purchased bypass',()=>{
 assert.match(deny,/allow read, write: if false/);
 for(const slot of ['plate','stage','stripe'])assert.ok(rules.includes('c.'+slot+' in allowed.'+slot));
 assert.equal(/purchased|wallet|inventory|request\.auth/.test(rules),false);
});
