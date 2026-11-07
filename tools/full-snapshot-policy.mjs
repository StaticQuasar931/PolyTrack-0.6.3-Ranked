export function fullSnapshotPolicy(receipt){
 const value=receipt?.fullSnapshotPolicy;
 if(value?.version!==1||value.authorized!==true||value.canonicalMode!=='full'||![10000,20000].includes(value.canonicalDocumentLimit)||value.profileDocumentLimit!==2000||value.trackCheckLimit!==512||value.eventReplayLimit!==256||!Number.isSafeInteger(value.publishedBaseline?.generation)||value.publishedBaseline.generation<1||!/^[a-f0-9]{64}$/.test(value.publishedBaseline.indexSha256||''))throw Error('Explicit tested full snapshot policy and published baseline pins required');
 return structuredClone(value);
}
export function readOnlySnapshotQueryDb(db){
 if(!db||typeof db.call!=='function')throw Error('Read-only snapshot database required');
 return {call:(route,body,options)=>{
  const from=body?.structuredQuery?.from;
  if(route!==':runQuery'||!Array.isArray(from)||from.length!==1||from[0].allDescendants||!['0.6.2_race_results','0.6.2_profiles_public'].includes(from[0].collectionId)||!Number.isSafeInteger(body.structuredQuery.limit)||body.structuredQuery.limit<1||body.structuredQuery.limit>100||body.structuredQuery.offset!==undefined)throw Error('Full capture forbids writes and unbounded queries');
  return db.call(route,body,options);
 }};
}
