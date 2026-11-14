import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PROFILE_SHOP_CATALOG} from './profile-shop-catalog.mjs';
import {PROFILE_SHOP_DESIGNS, PROFILE_SHOP_ART, PROFILE_SHOP_ART_CSS,
  getProfileShopDesign, profileShopArt, renderProfileShopArt} from './profile-shop-art.mjs';

const originalIds=new Set(['profile-pitlane-ticket','profile-apex-observatory','profile-vector-ribbon']);

test('original art maps exactly to canonical fixed grants and display prices', () => {
  assert.equal(PROFILE_SHOP_DESIGNS.length,PROFILE_SHOP_CATALOG.length);
  assert.deepEqual(PROFILE_SHOP_DESIGNS.filter(item=>originalIds.has(item.itemId)).map(item => [item.itemId,item.slot,item.value,item.price]),[
    ['profile-pitlane-ticket','plate','pitlane-ticket',20],
    ['profile-apex-observatory','stage','apex-observatory',30],
    ['profile-vector-ribbon','stripe','vector-ribbon',50]
  ]);
  for (const item of PROFILE_SHOP_CATALOG) {
    const design=getProfileShopDesign(item.id);
    assert.deepEqual({slot:design.slot,value:design.value},item.grants[0]);
    assert.equal(design.price,item.price);assert.equal(design.label,item.label);
    assert.equal(Object.isFrozen(design),true);
    assert.equal(profileShopArt(design.slot,design.value).className,`cosmetic-${design.slot.replace(/[A-Z]/g,c=>'-'+c.toLowerCase())}-${design.value}`);
  }
  assert(Object.isFrozen(PROFILE_SHOP_DESIGNS));assert(Object.isFrozen(PROFILE_SHOP_ART));
  assert.throws(()=>{PROFILE_SHOP_DESIGNS[0].price=0;},TypeError);
});

test('art has no authority, native presets or caller-controlled markup', () => {
  for (const input of ['__proto__','constructor','<script>alert(1)</script>','profile-vector-ribbon" onload="x',null,{},'pitlane-ticket']) {
    assert.equal(getProfileShopDesign(input),null);
    assert.equal(renderProfileShopArt(input),'');
  }
  assert.equal(profileShopArt('car','pitlane-ticket'),null);
  assert.equal(profileShopArt('plate','vector-ribbon'),null);
  for (const item of PROFILE_SHOP_ART) {
    assert(Object.isFrozen(item));
    for (const key of ['owned','unlocked','requirement','balance','accountId','equip']) assert(!Object.hasOwn(item,key));
  }
});

test('static decorative SVGs are distinct, bounded and simpler at low density', () => {
  const images=new Set();
  for (const item of PROFILE_SHOP_ART) {
    const normal=renderProfileShopArt(item.itemId),low=renderProfileShopArt(item.itemId,{density:'low'});
    images.add(normal);assert(normal.startsWith('<svg '));assert(normal.endsWith('</svg>'));
    assert(normal.includes('aria-hidden="true"'));assert(normal.includes('focusable="false"'));
    assert(low.length<normal.length);assert(low.includes('data-profile-art-density="low"'));
    assert(Buffer.byteLength(normal)<2500);
    assert(!/<(?:script|foreignObject|image|filter|animate|set)\b|\bon\w+=|\b(?:href|id)=/i.test(normal));
    if(!['plate','nameFont','nameColor'].includes(item.slot))assert(!/<text\b/i.test(normal));
    assert.equal(normal,renderProfileShopArt(item.itemId));
  }
  assert.equal(images.size,PROFILE_SHOP_ART.length);
  assert.throws(()=>renderProfileShopArt('profile-vector-ribbon',{density:'low" onload="x'}),TypeError);
});

test('Pitlane Ticket card shows a fixed native sample but real plate CSS never contains rank/name artwork',()=>{
  for(const density of ['normal','low']){
    const art=renderProfileShopArt('profile-pitlane-ticket',{density});
    assert.match(art,/preserveAspectRatio="xMidYMid meet"/);assert.match(art,/data-profile-art-sample="true"/);
    assert.match(art,/font-family="ForcedSquare,monospace"/);assert.match(art,/>#7<\/text>/);assert.match(art,/>RACER<\/text>/);
    assert.equal((art.match(/<text\b/g)||[]).length,2);
  }
  assert.doesNotMatch(PROFILE_SHOP_ART_CSS,/>\s*RACER\s*<|%3Ctext|data-profile-art-sample/i);
  const plate=PROFILE_SHOP_ART_CSS.match(/\.cosmetic-plate-pitlane-ticket\{([^}]+)\}/)[1];
  assert.match(plate,/--plate-bg:linear-gradient/);assert.doesNotMatch(plate,/url\(|content\s*:/);
});

test('CSS artifact matches exported renderer and preserves existing geometry and public hooks', async () => {
  assert.equal(await fs.readFile(new URL('./profile-shop-art.css',import.meta.url),'utf8'),PROFILE_SHOP_ART_CSS);
  for (const item of PROFILE_SHOP_ART) assert(PROFILE_SHOP_ART_CSS.includes('.'+item.className));
  for (const variable of ['--plate-bg','--plate-shadow','--plate-clip','--stage-bg','--stage-fx','--sq-stripe-art','--sq-stripe-size','--profile-pattern','--profile-pattern-size']) assert(PROFILE_SHOP_ART_CSS.includes(variable));
  assert(PROFILE_SHOP_ART_CSS.includes('.sq-plain-racer-themes'));
  assert(PROFILE_SHOP_ART_CSS.includes('prefers-reduced-motion:reduce'));
  assert(!/(?:transform|filter|content|z-index|position)\s*:|@keyframes|https?:|!\s*important[^}]*car/i.test(PROFILE_SHOP_ART_CSS));
  assert(Buffer.byteLength(PROFILE_SHOP_ART_CSS)<18000);
});

test('Apex Observatory retains its summit building and circuit at both static densities', () => {
  const normal = renderProfileShopArt('profile-apex-observatory');
  const low = renderProfileShopArt('profile-apex-observatory',{density:'low'});
  for (const art of [normal,low]) {
    assert.match(art,/M251 49V36H278V49Z/);
    assert.match(art,/M248 36L252 28L260 24/);
    assert.match(art,/stroke-width="8" stroke-linejoin="bevel"/);
    assert.doesNotMatch(art,/<animate|<filter|<image|<script|href=|onload=/i);
  }
  assert.match(normal,/M264 24V17L273 12/);
  assert.doesNotMatch(low,/M264 24V17L273 12/);
});

import {createHash} from 'node:crypto';
import {PROFILE_SHOP_EXPANDED_DESIGNS,PROFILE_SHOP_EXPANDED_CSS} from './profile-shop-expanded-designs.mjs';

test('six visual designs keep exact typed metadata and defer all registration to the canonical catalog',()=>{
  assert.deepEqual(PROFILE_SHOP_EXPANDED_DESIGNS.map(x=>[x.slot,x.value,x.price]),[
    ['theme','petrol',16],['baseSecondary','navy',20],['edge','rail',32],['stripe','rally-lines',36],['nameFont','book',45],['nameColor','copper',24]
  ]);
  assert(Object.isFrozen(PROFILE_SHOP_EXPANDED_DESIGNS));
  for(const item of PROFILE_SHOP_EXPANDED_DESIGNS){
    assert(Object.isFrozen(item)&&Object.isFrozen(item.art));
    const registered=PROFILE_SHOP_CATALOG.find(x=>x.id===item.itemId);
    if(registered){
      assert.deepEqual(registered.grants,[{slot:item.slot,value:item.value}]);
      assert.equal(registered.price,item.price);assert.equal(registered.label,item.label);
      assert.equal(getProfileShopDesign(item.itemId).price,item.price);
      assert.equal(profileShopArt(item.slot,item.value).className,item.className);
    }else{assert.equal(getProfileShopDesign(item.itemId),null);assert.equal(profileShopArt(item.slot,item.value),null);}
    assert.equal(item.className,`cosmetic-${item.slot.replace(/[A-Z]/g,c=>'-'+c.toLowerCase())}-${item.value}`);
    assert(PROFILE_SHOP_EXPANDED_CSS.includes('.'+item.className));
    for(const key of ['owned','unlocked','equip','balance','requirement'])assert(!Object.hasOwn(item,key));
  }
});

test('staged manual card SVGs are distinct, bounded, static and simpler at low density',()=>{
  const images=new Set();
  for(const item of PROFILE_SHOP_EXPANDED_DESIGNS){
    const normal=renderProfileShopArt(item.itemId),low=renderProfileShopArt(item.itemId,{density:'low'});
    images.add(normal);assert.match(normal,/aria-hidden="true"/);assert.match(normal,/focusable="false"/);
    assert(low.length<normal.length);assert(Buffer.byteLength(normal)<1800);
    assert.doesNotMatch(normal,/<(?:script|image|foreignObject|filter|animate|set)\b|\bon\w+=|\b(?:href|id)=/i);
    assert.equal(normal,renderProfileShopArt(item.itemId));
    for(const original of PROFILE_SHOP_ART.filter(x=>originalIds.has(x.itemId)))assert.notEqual(normal,renderProfileShopArt(original.itemId));
  }
  assert.equal(images.size,6);
  assert.match(PROFILE_SHOP_EXPANDED_DESIGNS.find(x=>x.slot==='nameFont').fontNote,/OS font fallback: Palatino Linotype, Palatino, Georgia, serif/);
  assert.doesNotMatch(PROFILE_SHOP_EXPANDED_CSS,/@font-face|@keyframes|animation\s*:|transform\s*:|box-shadow\s*:|filter\s*:|position\s*:|https?:/);
});

test('all three release383 original SVGs remain byte-identical at both densities',()=>{
  const expected=[
    ['profile-pitlane-ticket','17831979ba1020167e58cb7d52047347a8458150b04e144695ae9de5f3fc76d1','9ab89cf045a3dd09bb88e5ac22c871f083b0018dc019e1bfb2eccfd6c08f3cf9'],
    ['profile-apex-observatory','d683efc9a01c9d312430c1c48df18b285ab9a3317173ca87172728a8a8ccb70d','57024896ed7ad681cbfdb5684c08c2e0e2860809716910e1b5aa496bee0e61f9'],
    ['profile-vector-ribbon','d568ba90d8a3dd95a09bee34370eeac9eafb70da157bf3420f581ea4d255b021','d4d97190b326c7bbc5c47e881350d9ebf5fdf5901ba8cf929f55a4a417211df7']
  ];
  for(const [id,normal,low] of expected)for(const [density,hash] of [['normal',normal],['low',low]])assert.equal(createHash('sha256').update(renderProfileShopArt(id,{density})).digest('hex'),hash);
});

test('future catalog mapping admits exact supported grants only and skips unknown IDs safely',async()=>{
  let source=await fs.readFile(new URL('./profile-shop-art.mjs',import.meta.url),'utf8');
  const staged=PROFILE_SHOP_EXPANDED_DESIGNS.map(x=>({id:x.itemId,label:x.label,price:x.price,grants:[{slot:x.slot,value:x.value}]}));
  const future=[...PROFILE_SHOP_CATALOG.filter(x=>originalIds.has(x.id)),...staged,{id:'future-unsupported',grants:[{slot:'theme',value:'unknown'}]}];
  source=source.replace("import {PROFILE_SHOP_CATALOG} from './profile-shop-catalog.mjs';",`const PROFILE_SHOP_CATALOG=${JSON.stringify(future)};`)
    .replace("'./profile-shop-expanded-designs.mjs'",JSON.stringify(new URL('./profile-shop-expanded-designs.mjs',import.meta.url).href));
  const api=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  assert.equal(api.PROFILE_SHOP_DESIGNS.length,9);assert.equal(api.getProfileShopDesign('future-unsupported'),null);
  for(const item of PROFILE_SHOP_EXPANDED_DESIGNS){assert.equal(api.profileShopArt(item.slot,item.value).className,item.className);assert.equal(api.renderProfileShopArt(item.itemId),renderProfileShopArt(item.itemId));}
  const wrong=source.replace('"value":"petrol"','"value":"ocean"');
  const rejected=await import('data:text/javascript;base64,'+Buffer.from(wrong).toString('base64'));
  assert.equal(rejected.getProfileShopDesign('profile-petrol'),null);
});
