// W-only original profile art. Prices are earned points, not money.
// Catalog data alone never proves ownership or enables the disabled wallet.
export const PROFILE_SHOP_CATALOG_VERSION=2;
const item=(id,label,price,slot,value)=>Object.freeze({id,label,price,kind:'profile-cosmetic',
  grants:Object.freeze([Object.freeze({slot,value})])});
export const PROFILE_SHOP_CATALOG=Object.freeze([
  item('profile-pitlane-ticket','Pitlane Ticket',20,'plate','pitlane-ticket'),
  item('profile-apex-observatory','Apex Observatory',30,'stage','apex-observatory'),
  item('profile-vector-ribbon','Vector Ribbon',50,'stripe','vector-ribbon'),
  item('profile-petrol','Petrol',16,'theme','petrol'),
  item('profile-navy-secondary','Midnight Navy',20,'baseSecondary','navy'),
  item('profile-rail','Pit Rail',32,'edge','rail'),
  item('profile-rally-lines','Rally Lines',36,'stripe','rally-lines'),
  item('profile-book-serif','Book Serif',45,'nameFont','book'),
  item('profile-copper-ink','Copper Ink',24,'nameColor','copper')
]);
