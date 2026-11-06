import {createReadStream} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const scopes=new Set(['event_maintenance','queue_repair','canonical_reconcile','overall_publication',
 'identity_maintenance','pb_notify','profile','background_profile','admin','scheduled',
 'snapshot_overall','snapshot_track','events','kodub_weekly','extra_tracks','other','unknown']);
const metric=()=>({operations:0,knownReads:0,knownWrites:0,knownDeletes:0,
 unknownReadOperations:0,unknownWriteOperations:0,unknownDeleteOperations:0});
const add=(row,value)=>{
 row.operations++;
 for(const [field,target,unknown] of [['documentReadEstimate','knownReads','unknownReadOperations'],
  ['writeEstimate','knownWrites','unknownWriteOperations'],['deleteEstimate','knownDeletes','unknownDeleteOperations']]){
  const n=value[field];if(Number.isSafeInteger(n)&&n>=0&&n<=1000000)row[target]+=n;else row[unknown]++;
 }
};

// Consume ordinary Wrangler tail output in memory; never retain request headers,
// URLs, account IDs, document paths, replay data, or raw exception messages.
export function createCloudCostAudit({maxEventChars=2*1024*1024}={}){
 if(!Number.isSafeInteger(maxEventChars)||maxEventChars<64||maxEventChars>8*1024*1024)throw Error('Invalid event bound');
 const total=metric(),byScope=new Map(),byCollection=new Map();
 let invocations=0,scheduled=0,failedInvocations=0,withoutOperationRecords=0,malformed=0,oversized=0;
 let depth=0,quoted=false,escaped=false,buffer='',discard=false;
 const accept=event=>{
  if(!event||typeof event!=='object'||!Array.isArray(event.logs)){malformed++;return;}
  invocations++;scheduled+=typeof event.event?.cron==='string'?1:0;
  failedInvocations+=event.outcome&&event.outcome!=='ok'?1:0;
  let recorded=0;
  for(const log of event.logs){
   // Request/background summary logs overlap these operation records. Never add both.
   if(log?.message?.[0]!=='Ranked Firestore operation')continue;
   let value;try{value=typeof log.message[1]==='string'?JSON.parse(log.message[1]):log.message[1];}catch{malformed++;continue;}
   if(!value||value.schemaVersion!==1){malformed++;continue;}
   recorded++;add(total,value);
   const scope=scopes.has(value.scope)?value.scope:'unknown';
   if(!byScope.has(scope))byScope.set(scope,metric());add(byScope.get(scope),value);
   for(const [name,cost] of Object.entries(value.collections||{})){
    const key=/^0\.6\.2_[A-Za-z0-9_.-]{1,100}$/.test(name)?name:'other';
    if(!byCollection.has(key))byCollection.set(key,{knownReads:0,unknownReadOperations:0,knownWrites:0,knownDeletes:0,unknownWriteOperations:0,unknownDeleteOperations:0});
    const row=byCollection.get(key);if(Number.isSafeInteger(cost)&&cost>=0&&cost<=1000000)row.knownReads+=cost;else row.unknownReadOperations++;
   }
   for(const [name,cost] of Object.entries(value.writeCollections||{})){
    const key=/^0\.6\.2_[A-Za-z0-9_.-]{1,100}$/.test(name)?name:'other';
    if(!byCollection.has(key))byCollection.set(key,{knownReads:0,unknownReadOperations:0,knownWrites:0,knownDeletes:0,unknownWriteOperations:0,unknownDeleteOperations:0});
    const row=byCollection.get(key);
    for(const [field,known,unknown] of [['writes','knownWrites','unknownWriteOperations'],['deletes','knownDeletes','unknownDeleteOperations']]){
     const n=cost?.[field];if(Number.isSafeInteger(n)&&n>=0&&n<=1000000)row[known]+=n;else row[unknown]++;
    }
   }
  }
  if(!recorded)withoutOperationRecords++;
 };
 return {
  push(chunk){for(const c of String(chunk)){
   if(!depth){if(c!=='{')continue;depth=1;buffer='{';quoted=false;escaped=false;discard=false;continue;}
   if(!discard){buffer+=c;if(buffer.length>maxEventChars){discard=true;buffer='';oversized++;}}
   if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;}
   else if(c==='"')quoted=true;else if(c==='{')depth++;else if(c==='}')depth--;
   if(!depth&&!discard){try{accept(JSON.parse(buffer));}catch{malformed++;}buffer='';}
  }},
  result(){return {schemaVersion:1,billingEstimateOnly:true,
   coverage:'Worker transports in this log sample only; excludes client SDK, rules/index charges, other deployments, and unsampled logs. Unknown costs are not zero.',
   invocations,scheduled,failedInvocations,withoutOperationRecords,incompleteEvent:depth>0,malformed,oversized,
   total:{...total},byScope:Object.fromEntries([...byScope].sort()),byCollection:Object.fromEntries([...byCollection].sort())};}
 };
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);
 if(args.length>1){console.error('Usage: node tools/cloud-cost-audit.mjs [local-wrangler-log.jsonl]');process.exitCode=1;}
 else{
  const audit=createCloudCostAudit(),input=args.length?createReadStream(args[0],{encoding:'utf8'}):process.stdin;
  input.setEncoding('utf8');let emitted=false;
  const report=()=>{if(!emitted){emitted=true;console.log(JSON.stringify(audit.result(),null,2));}};
  input.on('data',chunk=>audit.push(chunk));input.on('end',report);
  input.on('error',()=>{console.error('Could not read local audit input.');process.exitCode=1;});
  process.on('SIGINT',()=>{report();process.exit(0);});
 }
}
