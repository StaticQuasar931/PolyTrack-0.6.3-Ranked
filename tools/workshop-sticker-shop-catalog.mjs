// Additive catalog-v2 offers; the Worker must explicitly advertise these items.
const sticker=(value,label,price)=>Object.freeze({id:'workshop-sticker-'+value,label,price,
  kind:'workshop-sticker',grants:Object.freeze([Object.freeze({slot:'sticker',value})])});
export const WORKSHOP_STICKER_SHOP_CATALOG=Object.freeze([
  sticker('solar-flare','Solar Flare',28),
  sticker('tide-mark','Tide Mark',36),
  sticker('hazard-band','Hazard Band',18),
  sticker('vector-wing','Vector Wing',48)
]);
export const workshopStickerOffer=({category,id})=>category==='sticker'
  ? WORKSHOP_STICKER_SHOP_CATALOG.find(item=>item.grants[0].value===id) : undefined;
