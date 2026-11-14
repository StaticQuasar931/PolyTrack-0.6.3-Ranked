// W-only original profile art. Prices are earned points, not money.
// Catalog data alone never proves ownership or enables the disabled wallet.
export const PROFILE_SHOP_CATALOG_VERSION=2;
const item=(id,label,price,slot,value)=>Object.freeze({id,label,price,kind:'profile-cosmetic',
  grants:Object.freeze([Object.freeze({slot,value})])});
export const PROFILE_SHOP_CATALOG=Object.freeze([
  item('profile-pitlane-ticket','Pitlane Ticket',20,'plate','pitlane-ticket'),
  item('profile-apex-observatory','Apex Observatory',30,'stage','apex-observatory'),
  item('profile-vector-ribbon','Vector Ribbon',50,'stripe','vector-ribbon')
]);
