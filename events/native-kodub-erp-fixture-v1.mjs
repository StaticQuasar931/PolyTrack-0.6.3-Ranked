// Frozen-shape synthetic v1 data, independent of published snapshot packages and the wall clock.
export function createKodubErpFixtureV1(){
  const hash=value=>value.toString(16).padStart(64,'0');
  const publishedAt=Date.UTC(2026,10,6,12);
  const period={id:'kodub_synthetic_v1',kind:'kodub',trackId:hash(900),startsAt:publishedAt-86400000,
    endsAt:publishedAt+6*86400000,maxRp:700};
  const names=['goymoblie','BatManHatesTaxes','daybreakslider','cinderdrift'];
  const entries=Array.from({length:22},(_,i)=>({accountId:hash(i+1),trackId:period.trackId,periodId:period.id,
    name:i<18?'Synthetic Racer '+(i+1):names[i-18],rank:i+1,timeMs:51459+i*1000,rp:489-i*7,
    replayHash:hash(100+i),physicsVerified:true,replayIntegrityVerified:true,runVerified:true,integrityVerified:true,
    verified:true,eventRpEligible:true,pending:false,verificationStatus:'verified',pbAt:publishedAt-3600000}));
  const eventBoard={period,entries,updatedAt:publishedAt,complete:true};
  const normalBoard={trackId:period.trackId,entries:entries.map((entry,i)=>{
    const {rp,periodId,eventRpEligible,...row}=entry;
    return {...row,userId:row.accountId,timeMs:i<18?row.timeMs:row.timeMs-258,
      replayHash:i<18?row.replayHash:hash(500+i)};
  })};
  return {version:1,publishedAt,eventBoard,normalBoard};
}
