import {createCanonicalRetainedTrack,MANUAL_CANONICAL_READ_LIMIT} from './canonical-retained-track.mjs';
import {applyLedgerToBoard,ledgerBinding,ledgerKey,ledgerDisposition} from './native-verification-ledger.mjs';

// A bounded read capability only. No database writer or raw document is returned.
export function createCanonicalRetentionCapture({ledger,policy,credential,readLimit,readCanonical,manualRecovery=false,quarantineChanged=false}={}){
 if(!Number.isSafeInteger(readLimit)||readLimit<2||readLimit>2000||typeof manualRecovery!=='boolean'||manualRecovery&&readLimit!==1000||!ledger||!/^[a-f0-9]{64}$/.test(ledger.manifestHash||'')||!Array.isArray(ledger.entries))throw Error('Invalid canonical retention capture');
 const maxDocuments=Math.min(manualRecovery?MANUAL_CANONICAL_READ_LIMIT:32,readLimit-1),proofs=new Map(ledger.entries.map(entry=>[entry.key,entry]));
 let database;
 const connection=()=>{
  if(typeof credential!=='string'||!credential)throw Error('Canonical retention credential unavailable');
  return database||=import('./verifier/firestore.mjs').then(({connect})=>connect(credential,{env:{},mode:'scheduled',documentReadLimit:maxDocuments,documentWriteLimit:1,maxReadRetries:0}));
 };
 const read=readCanonical||(async(accountId,trackId)=>{
  const db=await connection(),document=await db.get('0.6.2_race_results',accountId+'_'+trackId);
  if(db.writeAttempts()!==0)throw Error('Canonical retention forbids writes');
  return document;
 });
 return createCanonicalRetainedTrack({maxDocuments,manualRecovery,quarantineChanged,readCanonical:read,
   ...(manualRecovery&&!readCanonical?{readCanonicalBatch:async(accounts,trackId)=>{
     const db=await connection(),{decode}=await import('./verifier/firestore.mjs');
     const names=accounts.map(id=>'projects/polytrack-052/databases/(default)/documents/0.6.2_race_results/'+id+'_'+trackId);
     const raw=await db.call(':batchGet',{documents:names});
     if(db.writeAttempts()!==0||!Array.isArray(raw)||raw.length!==names.length)throw Error('Invalid canonical batch read');
     const byName=new Map(),requested=new Set(names);
     for(const item of raw){
       const name=item.found?.name??item.missing;
       if(!requested.has(name)||byName.has(name))throw Error('Invalid canonical batch document identity');
       const doc=item.found;
       byName.set(name,doc?{...doc,data:decode({mapValue:{fields:doc.fields||{}}})}:null);
     }
     return names.map(name=>byName.get(name));
   }}:{}),
   confirmProof:(row,source)=>{
     if(!policy)return row.nativeLedgerManifestHash===ledger.manifestHash;
     const binding=ledgerBinding(row,'normal');
     // Use the canonical replay and current policy, not a manifest stamp on the old board.
     const fresh={...source,...binding};
     const checked=applyLedgerToBoard({board:{trackId:row.trackId,entries:[row]},ledger,policy,
       canonicalRows:[fresh],recordings:[fresh],lane:'normal'});
     return checked.report.verified===1&&checked.board.entries[0]?.nativeLedgerKey===row.nativeLedgerKey;
   },
   proofAllowed:row=>{
  try{
   const key=ledgerKey(ledgerBinding(row,'normal')),proof=proofs.get(key);
   return row.nativeLedgerKey===key&&(row.nativeLedgerManifestHash===ledger.manifestHash||policy&&/^[a-f0-9]{64}$/.test(row.nativeLedgerManifestHash||''))&&!!proof&&ledgerDisposition(proof)==='verified';
  }catch{return false;}
 }});
}
