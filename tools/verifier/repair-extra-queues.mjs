import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {connect, decode} from './firestore.mjs';
import {EXTRA_TRACK_IDS} from '../../workers/ranked/src/extra-track-ids.js';
import {VERIFICATION_COLLECTION as CORE, EXTRA_VERIFICATION_COLLECTION as EXTRA, verificationSchedule} from '../../workers/ranked/src/verification.js';

export async function repairExtraQueues(db, {apply=false, limit=150, backup, now=Date.now()}={}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 150) throw Error('INVALID_REPAIR_LIMIT');
  if (apply && typeof backup !== 'function') throw Error('BACKUP_REQUIRED');
  const rows = await db.call(':runQuery', {structuredQuery:{from:[{collectionId:CORE}],limit}});
  if (!Array.isArray(rows)) throw Error('INVALID_QUEUE_RESPONSE');
  const documents = rows.filter(row=>row.document).map(row=>row.document);
  // Refuse a potentially truncated discovery: never report complete repair from a sample.
  if (documents.length === limit) throw Error('REPAIR_SCAN_TRUNCATED');
  const result = {scanned:documents.length,misrouted:0,slots:0,moved:0,tracks:[]};
  for (const source of documents) {
    const core = decode({mapValue:{fields:source.fields||{}}});
    if (!EXTRA_TRACK_IDS.has(core.trackId)) continue;
    if (source.name.split('/').at(-2) !== CORE || source.name.split('/').at(-1) !== core.trackId) throw Error('EXTRA_QUEUE_ID_MISMATCH');
    if (typeof source.updateTime !== 'string' || !source.updateTime) throw Error('QUEUE_VERSION_REQUIRED');
    if (!core.slots || typeof core.slots!=='object' || Array.isArray(core.slots)) throw Error('INVALID_QUEUE_SLOTS');
    const target = await db.get(EXTRA,core.trackId);
    if (target && (target.data.trackId !== core.trackId || !target.data.slots || typeof target.data.slots!=='object' || Array.isArray(target.data.slots))) throw Error('INVALID_EXTRA_QUEUE');
    const slots = {...core.slots};
    for (const [accountId,slot] of Object.entries(target?.data.slots||{})) {
      if (Object.hasOwn(slots,accountId)) throw Error('EXTRA_QUEUE_SLOT_CONFLICT');
      slots[accountId]=slot;
    }
    result.misrouted++;result.slots+=Object.keys(core.slots).length;result.tracks.push(core.trackId);
    if (!apply) continue;
    await backup({source,target});
    const data = {...core,...target?.data,trackId:core.trackId,slots,...verificationSchedule(slots,now),updatedAt:now};
    // One atomic compare-and-swap creates/updates the destination and removes only its old copy.
    await db.call(':commit',{writes:[db.write(EXTRA,core.trackId,data,target),
      {delete:source.name,currentDocument:{updateTime:source.updateTime}}]});
    result.moved++;
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), apply=args.includes('--apply');
  const value = flag=>args[args.indexOf(flag)+1];
  const raw=process.env.FIREBASE_VERIFIER_SERVICE_ACCOUNT || (args.includes('--credentials')?fs.readFileSync(value('--credentials'),'utf8'):null);
  if (!raw) throw Error('FIREBASE_VERIFIER_SERVICE_ACCOUNT_REQUIRED');
  let backup;
  if (apply) {
    if (!args.includes('--backup-dir')) throw Error('PRIVATE_BACKUP_DIRECTORY_REQUIRED');
    const directory=path.resolve(value('--backup-dir')),root=path.resolve(fileURLToPath(new URL('../..',import.meta.url)));
    if(directory===root || directory.startsWith(root+path.sep))throw Error('BACKUP_MUST_BE_OUTSIDE_PUBLIC_REPOSITORY');
    fs.mkdirSync(directory,{recursive:true});
    backup=async record=>fs.writeFileSync(path.join(directory,record.source.name.split('/').at(-1)+'.json'),JSON.stringify(record,null,2),{flag:'wx'});
  }
  console.log(JSON.stringify(await repairExtraQueues(await connect(raw),{apply,backup}),null,2));
}
