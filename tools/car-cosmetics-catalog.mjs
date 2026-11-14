/** Visual definitions only. No prices, purchases, ownership, network or engine code. */
const freeze=value=>{if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;};
export const CAR_COSMETIC_CATALOG=freeze({version:1,defaults:{accessory:'none',finish:'original',emblem:'none',front:'none'},
 finishes:[{id:'original',label:'Original',roughness:null,metalness:null,emissive:0},{id:'satin',label:'Satin',roughness:.76,metalness:.06,emissive:0},{id:'metallic',label:'Brushed metal',roughness:.24,metalness:.48,emissive:0},{id:'neon',label:'Neon paint',roughness:.4,metalness:.05,emissive:.34}],
 emblems:[{id:'none',label:'None'},{id:'chevron',label:'Nose chevron'},{id:'diamond',label:'Nose diamond'}],
 fronts:[{id:'none',label:'None'},{id:'splitter',label:'Front blade'},{id:'lamps',label:'Rally lamps'}],
 accessories:[{id:'none',label:'None'},{id:'fin',label:'Aero fin'},{id:'beacon',label:'Rally beacon'},{id:'aerial',label:'Radio aerial'},{id:'roofbox',label:'Touring box'},{id:'crown',label:'Podium crown'},{id:'halo',label:'Neon rail'}],
 paints:[{id:'mint',name:'Mint Rally',colors:[0x167d70,0xeafff7,0x171d23,0xc6e6d8]},{id:'ember',name:'Ember Circuit',colors:[0xa63f27,0xffdf9a,0x25201e,0xe8a742]},{id:'night',name:'Night Signal',colors:[0x17334e,0x7ee7ff,0x151e2b,0xd7e6ed]}]
});
export const FREE_WORKSHOP_KEYS=Object.freeze(['accessory:none','accessory:fin','accessory:beacon','accessory:aerial','accessory:roofbox','accessory:crown','accessory:halo','finish:original','finish:satin','finish:metallic','finish:neon','emblem:none','emblem:chevron','emblem:diamond','front:none','front:splitter','front:lamps']);
export const isFreeWorkshopChoice=({category,id})=>FREE_WORKSHOP_KEYS.includes(category+':'+id);
const groups={accessory:'accessories',finish:'finishes',emblem:'emblems',front:'fronts'};
export const validCarSelection=value=>!!value&&Object.entries(groups).every(([key,list])=>CAR_COSMETIC_CATALOG[list].some(item=>item.id===value[key]));
export const normalizeCarSelection=value=>Object.fromEntries(Object.entries(groups).map(([key,list])=>[key,CAR_COSMETIC_CATALOG[list].some(item=>item.id===value?.[key])?value[key]:CAR_COSMETIC_CATALOG.defaults[key]]));
export function authorizeCarSelection(value,accountId,canEquip){
 const selection=normalizeCarSelection(value);
 for(const key of Object.keys(groups)){
  if(selection[key]===CAR_COSMETIC_CATALOG.defaults[key])continue;
  let allowed=isFreeWorkshopChoice({category:key,id:selection[key]});
  if(typeof canEquip==='function'){try{allowed=canEquip({accountId,category:key,id:selection[key]})===true;}catch{allowed=false;}}
  if(!allowed)selection[key]=CAR_COSMETIC_CATALOG.defaults[key];
 }
 return selection;
}
export const carSelectionAllowed=(selection,accountId,canEquip)=>validCarSelection(selection)&&JSON.stringify(authorizeCarSelection(selection,accountId,canEquip))===JSON.stringify(normalizeCarSelection(selection));
