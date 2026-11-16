const demand=(ok,message)=>{if(!ok)throw Error('Fresh count quote: '+message);};

// Firestore aggregation timestamps belong to the result, not the printed count.
export function aggregationCount(response){
 demand(Array.isArray(response)&&response.length===1,'one aggregate result required');
 const row=response[0],result=row?.result;
 demand(result&&(!row.readTime||!result.readTime||row.readTime===result.readTime),'conflicting readTime');
 const readTime=result.readTime||row.readTime,fields=Object.values(result.aggregateFields||{});
 demand(typeof readTime==='string'&&Number.isFinite(Date.parse(readTime))&&fields.length===1,'exact server readTime required');
 const raw=fields[0]?.integerValue;
 demand(typeof raw==='string'&&/^(0|[1-9][0-9]*)$/.test(raw)&&Number.isSafeInteger(Number(raw)),'integer count required');
 return {count:Number(raw),readTime};
}

export function freshCountQuote({receipt,now=Date.now()}={}){
 const q=receipt?.sourceCountQuote,baseline=receipt?.fullSnapshotPolicy?.publishedBaseline;
 demand(q?.version===1&&q.sourceCommit===receipt.testedCommit&&q.baseline?.generation===baseline?.generation&&
   q.baseline?.indexSha256===baseline?.indexSha256,'source/baseline mismatch');
 demand(q.canonicalCollection==='0.6.2_race_results'&&q.profileCollection==='0.6.2_profiles_public'&&
   Number.isSafeInteger(q.profileSince)&&q.profileSince>0,'collection/profile watermark mismatch');
 const canonical=aggregationCount(q.canonicalResponse),profiles=aggregationCount(q.profileResponse);
 demand(canonical.readTime===profiles.readTime&&q.profileQueryReadTime===canonical.readTime,'counts must share the exact canonical query point');
 demand(Date.parse(canonical.readTime)<=now&&now-Date.parse(canonical.readTime)<=10*60000,'count point is stale/future');
 demand(canonical.count<receipt.fullSnapshotPolicy.canonicalDocumentLimit&&profiles.count<receipt.fullSnapshotPolicy.profileDocumentLimit,
   'full scan requires terminal-query space below unchanged policy caps');
 const minimumPreflight=Math.max(27,Math.max(1,Math.ceil(canonical.count/1000))+Math.max(1,Math.ceil(profiles.count/1000)));
 demand(Number.isSafeInteger(q.preflightReadReservations)&&q.preflightReadReservations>=minimumPreflight&&q.preflightReadReservations<=1000&&
   /^[a-f0-9]{64}$/.test(q.evidence?.sha256||''),'preflight cost and hash-pinned raw evidence required');
 const queries=Math.floor(canonical.count/100)+1+Math.floor(profiles.count/100)+1;
 // 100-slot query reservations, one index-charge allowance/query, diagnostic,
 // Overall107, retention32, archive12 and cold-cache Worker bound2878.
 const plannedReadReservations=queries*101+1+107+32+12+2878+q.preflightReadReservations;
 return Object.freeze({readTime:canonical.readTime,canonicalCount:canonical.count,profileCount:profiles.count,
   profileSince:q.profileSince,preflightReadReservations:q.preflightReadReservations,plannedReadReservations});
}
