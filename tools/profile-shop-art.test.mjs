import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PROFILE_SHOP_CATALOG} from './profile-shop-catalog.mjs';
import {PROFILE_SHOP_DESIGNS, PROFILE_SHOP_ART, PROFILE_SHOP_ART_CSS,
  getProfileShopDesign, profileShopArt, renderProfileShopArt} from './profile-shop-art.mjs';

test('original art maps exactly to canonical fixed grants and display prices', () => {
  assert.equal(PROFILE_SHOP_DESIGNS.length,3);
  assert.deepEqual(PROFILE_SHOP_DESIGNS.map(item => [item.itemId,item.slot,item.value,item.price]),[
    ['profile-pitlane-ticket','plate','pitlane-ticket',20],
    ['profile-apex-observatory','stage','apex-observatory',30],
    ['profile-vector-ribbon','stripe','vector-ribbon',50]
  ]);
  for (const item of PROFILE_SHOP_CATALOG) {
    const design=getProfileShopDesign(item.id);
    assert.deepEqual({slot:design.slot,value:design.value},item.grants[0]);
    assert.equal(design.price,item.price);assert.equal(design.label,item.label);
    assert.equal(Object.isFrozen(design),true);
    assert.equal(profileShopArt(design.slot,design.value).className,`cosmetic-${design.slot}-${design.value}`);
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
    if(item.slot!=='plate')assert(!/<text\b/i.test(normal));
    assert.equal(normal,renderProfileShopArt(item.itemId));
  }
  assert.equal(images.size,3);
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
