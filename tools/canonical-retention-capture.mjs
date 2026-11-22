import {createCanonicalRetainedTrack} from './canonical-retained-track.mjs';
import {applyLedgerToBoard,ledgerBinding,ledgerKey,ledgerDisposition} from './native-verification-ledger.mjs';

// A bounded read capability only. No database writer or raw document is returned.
export function createCanonicalRetentionCapture({ledger,policy,credential,readLimit,readCanonical,manualRecovery=false}={}){
 if(!Number.isSafeInteger(readLimit)||readLimit<2||readLimit>2000||typeof manualRecovery!=='boolean'||manualRecovery&&readLimit!==1000||!ledger||!/^[a-f0-9]{64}$/.test(ledger.manifestHash||'')||!Array.isArray(ledger.entries))throw Error('Invalid canonical retention capture');
 const maxDocuments=Math.min(manualRecovery?512:32,readLimit-1),proofs=new Map(ledger.entries.map(entry=>[entry.key,entry]));
 let database;
 const read=readCanonical||(async(accountId,trackId)=>{
  if(typeof credential!=='string'||!credential)throw Error('Canonical retention credential unavailable');
  database||=import('./verifier/firestore.mjs').then(({connect})=>connect(credential,{env:{},mode:'scheduled',documentReadLimit:maxDocuments,documentWriteLimit:1,maxReadRetries:0}));
  const db=await database,document=await db.get('0.6.2_race_results',accountId+'_'+trackId);
  if(db.writeAttempts()!==0)throw Error('Canonical retention forbids writes');
  return document;
 });
 return createCanonicalRetainedTrack({maxDocuments,manualRecovery,readCanonical:read,
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
