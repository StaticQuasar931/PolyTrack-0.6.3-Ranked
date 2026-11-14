/** Staged visual designs only. Not a catalog, unlock policy, or entitlement list.
 * Prices are the requested future display prices. Parent integration must add
 * canonical items and validated client/Worker options before anything is sold.
 * Card artwork is original, fixed, decorative SVG. No generated or remote assets.
 */
const design = (itemId,slot,value,label,price,description,base,detail,fontNote='') => Object.freeze({
  itemId,slot,value,label,price,description,fontNote,
  className:`cosmetic-${slot.replace(/[A-Z]/g,c=>'-'+c.toLowerCase())}-${value}`,
  art:Object.freeze({base,detail,description})
});
export const PROFILE_SHOP_EXPANDED_DESIGNS = Object.freeze([
  design('profile-petrol','theme','petrol','Petrol',16,
    'Deep petrol teal with a blue-black lower panel and pale sea-glass highlights.',
    '<path fill="#163e48" d="M0 0H320V88H0Z"/><path fill="#102631" d="M0 57L320 23V88H0Z"/><path fill="#285763" d="M0 0H85L0 51Z"/><path fill="#b3ddd8" d="M20 20H27V68H20Z"/><path fill="#e7f2ef" d="M50 28H188V35H50ZM50 45H138V50H50Z"/>',
    '<path fill="none" stroke="#6faaa9" d="M210 58H294M240 66H294"/><path fill="#6faaa9" d="M280 14H300V18H280Z"/>'),
  design('profile-navy-secondary','baseSecondary','navy','Midnight Navy',20,
    'A quiet midnight-blue secondary color, paired with a lighter neutral primary in this sample.',
    '<path fill="#485e72" d="M0 0H320V88H0Z"/><path fill="#142b46" d="M160 0H320V88H160Z"/><path fill="#dce9ee" d="M22 26H125V33H22ZM22 45H98V50H22Z"/><path fill="#91aec8" d="M190 26H293V33H190ZM190 45H266V50H190Z"/>',
    '<path fill="none" stroke="#a9becc" d="M160 12V76"/><path fill="#91aec8" d="M275 65H293V69H275Z"/>'),
  design('profile-rail','edge','rail','Pit Rail',32,
    'A cool machined ridge edge: one restrained rail on the existing nameplate border.',
    '<path fill="#1b3046" d="M0 0H320V88H0Z"/><path fill="#bacbd2" d="M12 9H18V79H12Z"/><path fill="#506977" d="M18 9H24V79H18Z"/><path fill="#e7eff1" d="M24 9H27V79H24Z"/><path fill="#dce9ee" d="M48 29H202V36H48ZM48 47H151V52H48Z"/>',
    '<path fill="#233a4a" d="M15 17H20V22H15ZM15 66H20V71H15Z"/><path fill="none" stroke="#617e8c" d="M48 69H294"/>'),
  design('profile-rally-lines','stripe','rally-lines','Rally Lines',36,
    'Three straight rally lanes confined to the far edge, with an open central name area.',
    '<path fill="none" stroke="#d9e8e3" stroke-width="10" d="M235 -8V96"/><path fill="none" stroke="#d9a77e" stroke-width="5" d="M252 -8V96"/><path fill="none" stroke="#749eaa" stroke-width="10" d="M269 -8V96"/>',
    '<path fill="none" stroke="#e9efeb" stroke-width="1" stroke-opacity=".65" d="M220 6V27M220 36V57M220 66V82"/>'),
  design('profile-book-serif','nameFont','book','Book Serif',45,
    'Upright book typography for racer names. Uses installed OS fonts, not a bundled game font.',
    '<path fill="#1b3046" d="M0 0H320V88H0Z"/><text x="22" y="56" font-family="Palatino Linotype,Palatino,Georgia,serif" font-size="34" fill="#edf1e9">Racer Aa</text>',
    '<path fill="none" stroke="#aab7bb" d="M23 67H292"/><path fill="#d9a77e" d="M281 18H294V21H281Z"/>',
    'OS font fallback: Palatino Linotype, Palatino, Georgia, serif. Appearance depends on installed fonts.'),
  design('profile-copper-ink','nameColor','copper','Copper Ink',24,
    'Warm, light copper lettering designed to stay legible on dark profile panels.',
    '<path fill="#1b3046" d="M0 0H320V88H0Z"/><text x="22" y="55" font-family="ForcedSquare,sans-serif" font-size="30" fill="#efba91">RACER</text><path fill="#efba91" d="M264 23H294V53H264Z"/>',
    '<path fill="none" stroke="#b67c55" d="M23 67H294"/><path fill="#f7d4b6" d="M264 23H294V28H264Z"/>')
]);
const rally = density => {
  const item=PROFILE_SHOP_EXPANDED_DESIGNS.find(item=>item.slot==='stripe');
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 88">${item.art.base}${density==='low'?'':item.art.detail}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
};
const rallyNormal=rally('normal'),rallyLow=rally('low');
export const PROFILE_SHOP_EXPANDED_CSS = `/* Staged cosmetic paint only; does not add shop choices or ownership. */
.cosmetic-theme-petrol,.leaderboard-ui>.container>button.main.sq-racer-cosmetic.cosmetic-theme-petrol{--cosmetic-a:#163e48;--cosmetic-b:#102631;--profile-a:#163e48;--profile-b:#102631;--profile-accent:#b3ddd8}
:is(.overall-entry,.overall-profile-card,.profile-cosmetic-choice,.showcase-row,.sq-racer-cosmetic).cosmetic-base-secondary-navy,.leaderboard-ui>.container>button.main.sq-racer-cosmetic.cosmetic-base-secondary-navy{--cosmetic-b:#142b46;--profile-b:#142b46}
.cosmetic-edge-rail{--edge-width:8px;--edge-style:ridge}
.leaderboard-ui>.container>button.main.sq-racer-cosmetic.cosmetic-edge-rail{border-left:var(--edge-width) var(--edge-style) var(--fx-accent,#bacbd2)!important}
.cosmetic-stripe-rally-lines{--sq-stripe-art:${rallyNormal};--sq-stripe-size:100% 100%;--profile-pattern:${rallyNormal};--profile-pattern-size:100% 100%}
.cosmetic-name-font-book :is(.name-preview,.overall-name-main,.profile-preview-stage>span>b,.profile-identity h3,.showcase-row span b),.leaderboard-ui .cosmetic-name-font-book .name{font-family:'Palatino Linotype',Palatino,Georgia,serif!important;font-style:normal!important;letter-spacing:0}
.cosmetic-name-color-copper{--name-ink:#efba91}
.profile-cosmetic-choice.cosmetic-theme-petrol .profile-cosmetic-preview{background:linear-gradient(145deg,#163e48,#102631)!important}
.profile-cosmetic-choice.cosmetic-edge-rail .profile-cosmetic-preview{border-left:8px ridge #bacbd2}
.profile-cosmetic-choice.cosmetic-stripe-rally-lines .profile-cosmetic-preview i{background:${rallyNormal} center/100% 100% no-repeat #1b3046}
:is([data-profile-art-density="low"],.sq-plain-racer-themes) .cosmetic-stripe-rally-lines,.cosmetic-stripe-rally-lines[data-profile-art-density="low"]{--sq-stripe-art:${rallyLow};--profile-pattern:${rallyLow}}
:is([data-profile-art-density="low"],.sq-plain-racer-themes) .profile-cosmetic-choice.cosmetic-stripe-rally-lines .profile-cosmetic-preview i,.profile-cosmetic-choice.cosmetic-stripe-rally-lines[data-profile-art-density="low"] .profile-cosmetic-preview i{background-image:${rallyLow}}
`;
