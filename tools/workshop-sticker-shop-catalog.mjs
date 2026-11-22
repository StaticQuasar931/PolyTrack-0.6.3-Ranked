// Additive catalog-v2 offers; the Worker must explicitly advertise these items.
const sticker=(value,label,price)=>Object.freeze({id:'workshop-sticker-'+value,label,price,
  kind:'workshop-sticker',grants:Object.freeze([Object.freeze({slot:'sticker',value})])});
export const WORKSHOP_STICKER_SHOP_CATALOG=Object.freeze([
  sticker('solar-flare','Solar Flare',28),
  sticker('tide-mark','Tide Mark',36),
  sticker('hazard-band','Hazard Band',18),
  sticker('vector-wing','Vector Wing',48)
]);
const part=(category,value,label,price)=>Object.freeze({id:'workshop-'+category+'-'+value,label,price,kind:'workshop-part',grants:Object.freeze([Object.freeze({slot:'car_'+category,value})])});
export const WORKSHOP_PART_SHOP_CATALOG=Object.freeze([
  part('finish','glasscoat','Glasscoat',34),part('emblem','apex-crest','Apex crest',22),
  part('accessory','pace-light','Pace light',44),part('front','nose-guard','Nose guard',32),
  part('rear','afterburner','Afterburner',46)
]);
const newSticker=sticker('turn-marker','Turn Marker',24);
export const WORKSHOP_SHOP_CATALOG=Object.freeze([...WORKSHOP_STICKER_SHOP_CATALOG,newSticker,...WORKSHOP_PART_SHOP_CATALOG]);
export const isWorkshopShopItem=item=>item?.kind==='workshop-sticker'||item?.kind==='workshop-part';
export const workshopShopCategory=item=>item?.grants?.[0]?.slot?.replace(/^car_/,'');
export const workshopStickerOffer=({category,id})=>WORKSHOP_SHOP_CATALOG.find(item=>workshopShopCategory(item)===category&&item.grants[0].value===id);
