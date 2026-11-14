/** Visual-only original profile art. No ownership, awards, equip or automatic I/O.
 * The canonical shop catalog is owned separately; prices here are presentation only.
 * Load profile-shop-art.css after the existing cosmetic styles.
 */
import {PROFILE_SHOP_CATALOG} from './profile-shop-catalog.mjs';

export const PROFILE_SHOP_DESIGNS = Object.freeze(PROFILE_SHOP_CATALOG.map(item => {
  const {slot, value} = item.grants[0];
  return Object.freeze({itemId:item.id, slot, value, label:item.label, price:item.price});
}));

const ART = Object.freeze({
  'profile-pitlane-ticket': Object.freeze({
    description:'An ink-blue pit ticket with cut corners and a warm timing-line edge.',
    base:'<path fill="#14263b" stroke="#edc889" stroke-width="2" d="M12 12H298L308 22V66L298 76H12L2 66V22Z"/><path fill="#edc889" d="M12 12H18V76H12L2 66V22Z"/>',
    detail:'<path fill="none" stroke="#edc889" stroke-opacity=".55" d="M279 24V34M279 40V48M279 54V64M28 24H62M28 64H62"/>'
  }),
  'profile-apex-observatory': Object.freeze({
    description:'A still mountain observatory above an angular circuit, behind the profile car.',
    base:'<path fill="#152c3d" d="M0 0H320V88H0Z"/><circle cx="249" cy="21" r="11" fill="#edc889"/><path fill="#345568" d="M0 63L55 21L100 55L158 12L228 64L273 38L320 69V88H0Z"/><path fill="#9abebc" d="M129 33L158 12L181 31L160 25L148 33L142 27Z"/><path fill="#0c2130" d="M0 76L75 59L129 74L203 60L320 78V88H0Z"/>',
    detail:'<path fill="none" stroke="#edc889" stroke-width="1.5" stroke-opacity=".6" d="M20 86L79 69H118L140 79H210L232 70H275L303 86"/><path fill="none" stroke="#b8d8d2" stroke-opacity=".6" d="M269 53V43H283V53M266 43L276 36L286 43Z"/>'
  }),
  'profile-vector-ribbon': Object.freeze({
    description:'Two open racing ribbons at the far edge, leaving the racer name clear.',
    base:'<path fill="none" stroke="#8ed2d3" stroke-width="7" stroke-opacity=".7" d="M222 -8L188 24L216 49L180 96"/><path fill="none" stroke="#edc889" stroke-width="3" stroke-opacity=".8" d="M247 -8L213 24L241 49L205 96"/>',
    detail:'<path fill="none" stroke="#8ed2d3" stroke-width="1" stroke-opacity=".4" d="M265 8L251 22M182 63L168 81"/>'
  })
});

export const PROFILE_SHOP_ART = Object.freeze(PROFILE_SHOP_DESIGNS.map(design => Object.freeze({
  ...design, className:`cosmetic-${design.slot}-${design.value}`, description:ART[design.itemId].description
})));

export function getProfileShopDesign(itemId) {
  return PROFILE_SHOP_DESIGNS.find(item => item.itemId === itemId) ?? null;
}

export function profileShopArt(kind, id) {
  return PROFILE_SHOP_ART.find(item => item.slot === kind && item.value === id) ?? null;
}

/** Decorative fixed markup only. Host supplies a text label and preview/ownership state. */
export function renderProfileShopArt(itemId, {density='normal'}={}) {
  if (!['normal','low'].includes(density)) throw TypeError('Unsupported profile art density');
  const item = PROFILE_SHOP_ART.find(value => value.itemId === itemId);
  if (!item) return '';
  const art = ART[itemId];
  return `<svg xmlns="http://www.w3.org/2000/svg" class="profile-shop-art profile-shop-art-${item.slot}" viewBox="0 0 320 88" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false" data-profile-art-density="${density}">${art.base}${density==='normal'?art.detail:''}</svg>`;
}

const image = (itemId, density='normal') => `url("data:image/svg+xml,${encodeURIComponent(renderProfileShopArt(itemId,{density}))}")`;
const scene = image('profile-apex-observatory');
const sceneLow = image('profile-apex-observatory','low');
const ribbon = image('profile-vector-ribbon');
const ribbonLow = image('profile-vector-ribbon','low');

// CSS owns no pseudo-element layout: the established renderers consume these variables.
export const PROFILE_SHOP_ART_CSS = `/* Original profile art only. No car geometry, account state or ownership authority. */
.profile-shop-art{display:block;width:100%;height:100%;pointer-events:none;user-select:none;overflow:hidden}
.cosmetic-plate-pitlane-ticket{--plate-bg:linear-gradient(90deg,#edc889 0 4px,#14263b 4px 100%);--plate-shadow:inset 0 0 0 1px #edc889;--plate-clip:polygon(7px 0,calc(100% - 7px) 0,100% 7px,100% calc(100% - 7px),calc(100% - 7px) 100%,7px 100%,0 calc(100% - 7px),0 7px)}
.cosmetic-plate-pitlane-ticket :is(.overall-rank,.showcase-row>strong,.np-preview>b),.cosmetic-plate-pitlane-ticket.np-preview>b{color:#f6e4c5!important}
.leaderboard-ui button.main.cosmetic-plate-pitlane-ticket .position{background:var(--plate-bg);box-shadow:var(--plate-shadow);clip-path:var(--plate-clip);color:#f6e4c5!important}
.cosmetic-stage-apex-observatory{--stage-bg:${scene} center/cover no-repeat #152c3d;--stage-fx:none}
.cosmetic-stripe-vector-ribbon{--sq-stripe-art:${ribbon};--sq-stripe-size:100% 100%;--profile-pattern:${ribbon};--profile-pattern-size:100% 100%}
.profile-cosmetic-choice.cosmetic-stripe-vector-ribbon .profile-cosmetic-preview i{background:${ribbon} center/cover no-repeat #14263b}
.profile-cosmetic-choice.cosmetic-plate-pitlane-ticket .np-preview>b{background:var(--plate-bg);box-shadow:var(--plate-shadow);clip-path:var(--plate-clip)}
:is([data-profile-art-density="low"],.sq-plain-racer-themes) .cosmetic-stage-apex-observatory,.cosmetic-stage-apex-observatory[data-profile-art-density="low"]{--stage-bg:${sceneLow} center/cover no-repeat #152c3d;--stage-fx:none}
:is([data-profile-art-density="low"],.sq-plain-racer-themes) .cosmetic-stripe-vector-ribbon,.cosmetic-stripe-vector-ribbon[data-profile-art-density="low"]{--sq-stripe-art:${ribbonLow};--profile-pattern:${ribbonLow}}
@media(prefers-reduced-motion:reduce){.profile-shop-art{animation:none!important;transition:none!important}}
`;
