// An event is entered explicitly. Track identity alone never grants event entry.
export function createEventSession({now=Date.now}={}) {
  let active=null;
  const races=new Map();
  return {
    enter(period,accountId){
      if(!period?.id||!/^[a-f0-9]{64}$/.test(period.trackId)||!/^[a-f0-9]{64}$/.test(accountId)||now()<period.startsAt||now()>=period.endsAt)throw Error('Event is not open for this racer.');
      active=Object.freeze({periodId:period.id,trackId:period.trackId,accountId,endsAt:period.endsAt});races.clear();return active;
    },
    leave(){active=null;races.clear();},
    current(){return active&&now()<active.endsAt?active:null;},
    bind(context){
      if(!active||now()>=active.endsAt||context?.trackId!==active.trackId||context?.accountId!==active.accountId)return false;
      if(races.size>=128)races.delete(races.keys().next().value);
      races.set(context.raceId,active);return true;
    },
    finish(run){
      const entry=races.get(run?.raceId);
      if(!entry||entry!==active||now()>=entry.endsAt||entry.trackId!==run.trackId||entry.accountId!==run.accountId)return null;
      return {...run,periodId:entry.periodId,attemptId:crypto.randomUUID(),endsAt:entry.endsAt};
    }
  };
}
export function keepEventBest(queue,run){
  const key=row=>row.periodId+'_'+row.accountId;
  const old=queue.find(row=>key(row)===key(run));
  if(old&&old.timeMs<=run.timeMs)return queue;
  const next=queue.filter(row=>key(row)!==key(run));
  if(next.length>=64)throw Error('Event upload storage is full. Connect to upload pending event PBs.');
  return [...next,run];
}

// Only called with a finish captured from a positively identified local car.
// Eligibility follows the finish clock, not the menu used to start the race.
export function matchingEventRuns(run,periods,accountId,at=Date.now()){
  if(!run?.raceId||run.accountId!==accountId||!/^[a-f0-9]{64}$/.test(accountId||'')||!/^[a-f0-9]{64}$/.test(run.trackId||'')||!Number.isSafeInteger(at))return [];
  const seen=new Set();
  return (Array.isArray(periods)?periods:[]).filter(period=>{
    if(!period?.id||seen.has(period.id)||period.enabled===false||period.archived||period.kind==='permanent'||period.trackId!==run.trackId||!Number.isSafeInteger(period.startsAt)||!Number.isSafeInteger(period.endsAt)||at<period.startsAt||at>=period.endsAt)return false;
    seen.add(period.id);return true;
  }).map(period=>({...run,periodId:period.id,attemptId:crypto.randomUUID(),finishedAt:at,endsAt:period.endsAt}));
}
