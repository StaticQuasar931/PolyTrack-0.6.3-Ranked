import {readPrivateSnapshotIndex} from './private-snapshot-index.mjs';
import fs from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';import {hydrateStaging} from './update-public-snapshot.mjs';import {prepareNativeSnapshotCapture} from './native-snapshot-phase.mjs';
export async function preparePublishedNativeBaseline({root,publishedBaseline,hydrate=hydrateStaging,prepare=prepareNativeSnapshotCapture}){
 const {generation,indexSha256}=publishedBaseline||{};if(!path.isAbsolute(root||'')||!Number.isSafeInteger(generation)||generation<1||!/^[a-f0-9]{64}$/.test(indexSha256||''))throw Error('Pinned published proof baseline required');
 const verify=async()=>{const pointer=JSON.parse(await fs.readFile(path.join(root,'snapshot-current.json'),'utf8'));const bytes=await readPrivateSnapshotIndex(path.join(root,'public-snapshots'+generation,'index.json'));if(pointer.currentdir!=='public-snapshots'+generation||createHash('sha256').update(bytes).digest('hex')!==indexSha256)throw Error('Published proof baseline changed');};
 await verify();const parent=path.join(root,'local-reports');await fs.mkdir(parent,{recursive:true});const stat=await fs.lstat(parent);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Unsafe published proof baseline parent');
 const directory=await fs.mkdtemp(path.join(parent,'published-native-baseline-'));await hydrate(root,directory);await verify();
 return prepare({root,directory});
}
