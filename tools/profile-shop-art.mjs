/** Visual-only original profile art. No ownership, awards, equip or automatic I/O.
 * The canonical shop catalog is owned separately; prices here are presentation only.
 * Load profile-shop-art.css after the existing cosmetic styles.
 */
import {PROFILE_SHOP_CATALOG} from './profile-shop-catalog.mjs';
import {PROFILE_SHOP_EXPANDED_DESIGNS,PROFILE_SHOP_EXPANDED_CSS} from './profile-shop-expanded-designs.mjs';

const ART = Object.freeze({
  ...Object.fromEntries(PROFILE_SHOP_EXPANDED_DESIGNS.map(item=>[item.itemId,item.art])),
  'profile-pitlane-ticket': Object.freeze({
    description:'An ink-blue pit ticket with cut corners and a warm timing-line edge.',
    base:'<path fill="#14263b" stroke="#edc889" stroke-width="2" d="M12 12H298L308 22V66L298 76H12L2 66V22Z"/><path fill="#edc889" d="M12 12H18V76H12L2 66V22Z"/>',
    detail:'<path fill="none" stroke="#edc889" stroke-opacity=".55" d="M279 24V34M279 40V48M279 54V64M28 24H62M28 64H62"/>'
  }),
  'profile-apex-observatory': Object.freeze({
    description:'A still low-poly alpine circuit below a moonlit summit observatory, with a clear central car silhouette.',
    base:'<path fill="#172c48" d="M0 0H320V88H0Z"/><circle cx="267" cy="18" r="10" fill="#f4d79e"/><path fill="#3d5874" d="M0 59L39 24L75 54L123 14L181 66L226 29L278 59L307 35L320 47V88H0Z"/><path fill="#c1d8de" d="M98 35L123 14L146 37L127 29L118 34L113 28Z"/><path fill="#293f56" d="M123 14L181 66L146 53L127 29Z"/><path fill="#213c4b" d="M0 72L53 57L109 76L188 57L252 65L320 54V88H0Z"/><path fill="#426069" d="M226 65L241 48H292L320 61V72L279 66Z"/><path fill="#98b5bc" d="M251 49V36H278V49Z"/><path fill="#d5e1df" d="M248 36L252 28L260 24H269L277 29L281 36Z"/><path fill="#638896" d="M265 25L272 30L274 36H281L277 29L269 24Z"/><path fill="#172c48" d="M257 40H263V49H257ZM269 40H274V45H269Z"/><path fill="#152b3a" d="M0 83L62 71L121 82L202 72L259 79L320 70V88H0Z"/><path fill="none" stroke="#7c9ca9" stroke-width="8" stroke-linejoin="bevel" d="M-6 85L47 75H80L103 84H191L216 75H251L279 85H326"/><path fill="none" stroke="#263c4e" stroke-width="5" stroke-linejoin="bevel" d="M-6 85L47 75H80L103 84H191L216 75H251L279 85H326"/>',
    detail:'<path fill="none" stroke="#edc889" stroke-width="1.5" d="M22 79L38 76M87 78L99 83M202 80L215 76M261 79L273 83"/><path fill="none" stroke="#b8d8d2" d="M264 24V17L273 12M264 17L270 21L277 15L273 12Z"/><path fill="#b8d8d2" d="M24 15H26V17H24ZM192 12H194V14H192ZM297 23H299V25H297Z"/>'
  }),
  'profile-vector-ribbon': Object.freeze({
    description:'Two open racing ribbons at the far edge, leaving the racer name clear.',
    base:'<path fill="none" stroke="#8ed2d3" stroke-width="7" stroke-opacity=".7" d="M222 -8L188 24L216 49L180 96"/><path fill="none" stroke="#edc889" stroke-width="3" stroke-opacity=".8" d="M247 -8L213 24L241 49L205 96"/>',
    detail:'<path fill="none" stroke="#8ed2d3" stroke-width="1" stroke-opacity=".4" d="M265 8L251 22M182 63L168 81"/>'
  })
});

// A catalog entry is drawable only when its exact, single-slot grant is known.
// Unknown future IDs fail closed instead of crashing or borrowing paid artwork.
const knownGrants = [
  {itemId:'profile-pitlane-ticket',slot:'plate',value:'pitlane-ticket'},
  {itemId:'profile-apex-observatory',slot:'stage',value:'apex-observatory'},
  {itemId:'profile-vector-ribbon',slot:'stripe',value:'vector-ribbon'},
  ...PROFILE_SHOP_EXPANDED_DESIGNS
];
export const PROFILE_SHOP_DESIGNS = Object.freeze(PROFILE_SHOP_CATALOG.filter(item=>{
  const known=knownGrants.find(design=>design.itemId===item.id);
  return known && item.grants?.length===1 && item.grants[0]?.slot===known.slot && item.grants[0]?.value===known.value;
}).map(item=>{
  const {slot,value}=item.grants[0];
  return Object.freeze({itemId:item.id,slot,value,label:item.label,price:item.price});
}));

export const PROFILE_SHOP_ART = Object.freeze(PROFILE_SHOP_DESIGNS.map(design => Object.freeze({
  ...design, className:`cosmetic-${design.slot.replace(/[A-Z]/g,c=>'-'+c.toLowerCase())}-${design.value}`, description:ART[design.itemId].description
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
  const item = PROFILE_SHOP_ART.find(value => value.itemId === itemId) ?? PROFILE_SHOP_EXPANDED_DESIGNS.find(value=>value.itemId===itemId);
  if (!item) return '';
  const art = ART[itemId];
  // Card-only example. The real plate background below is a text-free gradient.
  const sample=item.slot==='plate'?'<g data-profile-art-sample="true" font-family="ForcedSquare,monospace"><path stroke="#edc889" stroke-opacity=".6" d="M92 25V63M112 60H244"/><text x="54" y="55" text-anchor="middle" font-size="28" fill="#f6e4c5">#7</text><text x="112" y="51" font-size="22" fill="#eef8ff">RACER</text></g>':'';
  return `<svg xmlns="http://www.w3.org/2000/svg" class="profile-shop-art profile-shop-art-${item.slot}" viewBox="0 0 320 88" preserveAspectRatio="xMidYMid ${item.slot==='plate'?'meet':'slice'}" aria-hidden="true" focusable="false" data-profile-art-density="${density}">${art.base}${sample}${density==='normal'?art.detail:''}</svg>`;
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
` + PROFILE_SHOP_EXPANDED_CSS;
