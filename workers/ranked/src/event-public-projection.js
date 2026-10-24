import {safePublicName} from './public-name-policy.js';

const string=(value,max)=>typeof value==='string'?value.replace(/[<>\u0000-\u001f]/g,'').slice(0,max):'';
const int=value=>Number.isSafeInteger(value)&&value>=0;
const account=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const carStyle=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,256}$/.test(value)?value:'';
export function publicEventTotal(row) {
  if(!row||!account(row.accountId)||!int(row.rp))throw Error('EVENT_PUBLIC_TOTAL_INVALID');
  const output={accountId:row.accountId,name:safePublicName(row.name||'Racer',row.accountId),rp:row.rp,events:int(row.events)?row.events:0};
  if(int(row.rank)&&row.rank>0)output.rank=row.rank;
  if(carStyle(row.carStyle))output.carStyle=carStyle(row.carStyle);
  if(row.countryCode)output.countryCode=string(row.countryCode,8).toUpperCase();
  for(const field of ['finiteEventRp','permanentRollingHillsRp','dynamicEventRp','rollingHillsTimeMs','rollingHillsRunAgeMs','rollingHillsEventRpContribution'])if(int(row[field]))output[field]=row[field];
  return output;
}
function publicEventFinish(row) {
  if(!row||!account(row.accountId)||!int(row.timeMs)||row.timeMs<1||!int(row.rp)||!int(row.rank)||row.rank<1)throw Error('EVENT_PUBLIC_FINISH_INVALID');
  return {accountId:row.accountId,name:safePublicName(row.name||'Racer',row.accountId),timeMs:row.timeMs,rp:row.rp,rank:row.rank,
    carStyle:carStyle(row.carStyle),...(int(row.submittedAt)?{submittedAt:row.submittedAt}:{})};
}
export function publicEventPage(data,kind) {
  if(!data||!Array.isArray(data.entries))throw Error('EVENT_PUBLIC_PAGE_INVALID');
  const output={};
  for(const field of ['version','generation','pageSize','pageCount','totalEntries','complete','page','sourceRevision','sourceReadTime','sourceComplete','eventRpComplete'])if(data[field]!==undefined)output[field]=data[field];
  const rolling=data.dynamicComponents?.permanentRollingHills;
  if(rolling){
    const component={status:rolling.status==='complete'?'complete':'unavailable'};
    for(const field of ['id','trackId','scoreVersion','targetPolicy'])if(typeof rolling[field]==='string')component[field]=string(rolling[field],128);
    for(const field of ['targetMs','maxRp','sourceRevision','updatedAt'])if(int(rolling[field]))component[field]=rolling[field];
    output.dynamicComponents={permanentRollingHills:component};
  }
  output.entries=data.entries.map(kind==='event_totals'?publicEventTotal:publicEventFinish);
  return output;
}
