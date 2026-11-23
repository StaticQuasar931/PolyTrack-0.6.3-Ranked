import {CAR_COSMETIC_CATALOG,normalizeCarSelection,normalizeStickerLayout,stickerPositionsConflict} from './car-cosmetics-catalog.mjs?v=workshop-shared-1';

export const WORKSHOP_STYLE_MAX=384;
export const WORKSHOP_STYLE_COLLECTION='0.6.3_workshop_styles';
const defaults=CAR_COSMETIC_CATALOG.defaults;

// Store only equipped choices. Deliberately omit entitlement, rank and medal data.
export function encodeWorkshopStyle(value){
 const normalized=normalizeCarSelection(value),result={};
 for(const key of Object.keys(defaults))if(normalized[key]!==defaults[key])result[key]=normalized[key];
 if(result.sticker)result.stickerLayout=normalizeStickerLayout(normalized.stickerLayout);
 if(normalized.extraSticker&&!stickerPositionsConflict(normalized))result.extraSticker=normalized.extraSticker;
 return Object.keys(result).length?JSON.stringify(result):'';
}
export function readWorkshopStyle(value){
 if(typeof value!=='string'||value.length>WORKSHOP_STYLE_MAX)return undefined;
 if(value==='')return '';
 try{
  const data=JSON.parse(value);
  if(!data||Array.isArray(data)||typeof data!=='object')return undefined;
  const canonical=encodeWorkshopStyle(data);
  return canonical===value?canonical:undefined;
 }catch{return undefined;}
}
export function workshopThumbnailSelection(value,profile){
 if(!value||readWorkshopStyle(value)!==value)return null;
 const selection=JSON.parse(value);
 if(selection.accessory==='crown'){
  const tier=['gold','silver','bronze'].find(t=>Number.isSafeInteger(profile?.medals?.[t])&&profile.medals[t]>0);
  if(tier)selection.crownTier=tier;
  else delete selection.accessory;
 }
 const rank=profile?.rank;
 if(Number.isSafeInteger(rank)&&rank>0&&profile.provisional!==true)selection.overallRank=rank;
 else {
  if(selection.sticker==='rank-number')delete selection.sticker;
  if(selection.extraSticker?.id==='rank-number')delete selection.extraSticker;
 }
 return selection;
}
