import {createCanonicalRetainedTrack} from './canonical-retained-track.mjs';
import {ledgerBinding,ledgerKey,ledgerDisposition} from './native-verification-ledger.mjs';

// A bounded read capability only. No database writer or raw document is returned.
export function createCanonicalRetentionCapture({ledger,credential,readLimit,readCanonical}={}){
 if(!Number.isSafeInteger(readLimit)||readLimit<2||readLimit>2000||!ledger||!/^[a-f0-9]{64}$/.test(ledger.manifestHash||'')||!Array.isArray(ledger.entries))throw Error('Invalid canonical retention capture');
 const maxDocuments=Math.min(32,readLimit-1),proofs=new Map(ledger.entries.map(entry=>[entry.key,entry]));
 let database;
 const read=readCanonical||(async(accountId,trackId)=>{
  if(typeof credential!=='string'||!credential)throw Error('Canonical retention credential unavailable');
  database||=import('./verifier/firestore.mjs').then(({connect})=>connect(credential,{env:{},mode:'scheduled',documentReadLimit:maxDocuments,documentWriteLimit:1,maxReadRetries:0}));
  const db=await database,document=await db.get('0.6.2_race_results',accountId+'_'+trackId);
  if(db.writeAttempts()!==0)throw Error('Canonical retention forbids writes');
  return document;
 });
 return createCanonicalRetainedTrack({maxDocuments,readCanonical:read,proofAllowed:row=>{
  try{
   const key=ledgerKey(ledgerBinding(row,'normal')),proof=proofs.get(key);
   return row.nativeLedgerKey===key&&row.nativeLedgerManifestHash===ledger.manifestHash&&!!proof&&ledgerDisposition(proof)==='verified';
  }catch{return false;}
 }});
}
