import {EVENT_COLLECTIONS as C} from '../../workers/ranked/src/events.js';

// Observe successful transaction returns, not write proposals or failed/unknown commits.
export function observeEventStore(store,recordOutcome) {
  return {...store,transaction:async callback=>{
    let observations=[];
    const value=await store.transaction(async tx=>{
      observations=[];
      const runs=new Map();
      return callback({...tx,get:async name=>{
        const row=await tx.get(name);if(name.startsWith(C.runs+'/')&&row)runs.set(name,row);return row;
      },patch:async(name,data)=>{
        const result=await tx.patch(name,data),run=runs.get(name);
        if(run&&data.proof&&typeof data.status==='string')observations.push({run,data});
        return result;
      }});
    });
    for(const {run,data}of observations)recordOutcome(run,{status:data.status,reason:data.proof.reason},
      {lane:'event',periodId:run.periodId,completed:true});
    return value;
  }};
}
