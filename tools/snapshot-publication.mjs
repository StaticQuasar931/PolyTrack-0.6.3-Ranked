const maximum=8640000000000000;
export function parseSnapshotPublication(text){
 if(typeof text!=='string'||text.length>512)return null;
 try{const row=JSON.parse(text);if(!Number.isSafeInteger(row?.generation)||row.generation<1||!Number.isSafeInteger(row.publishedAt)||row.publishedAt<1||row.publishedAt>maximum||row.sourceCommit!==undefined&&!/^[a-f0-9]{40}$/.test(row.sourceCommit))return null;
 return {generation:row.generation,publishedAt:row.publishedAt,...(row.sourceCommit?{sourceCommit:row.sourceCommit}:{})};}catch{return null;}
}
export function readSnapshotPublicationMeta(document){return parseSnapshotPublication(document?.querySelector?.('meta[name="polytrack-snapshot-publication"]')?.content);}
export function snapshotPublicationTime(publication,baseUrl,index,now=Date.now()){
 const record=parseSnapshotPublication(JSON.stringify(publication));if(!record)return 0;
 let generation;try{generation=Number(/public-snapshots([1-9]\d*)\/$/.exec(new URL(baseUrl).pathname)?.[1]);}catch{return 0;}
 return generation===record.generation&&index?.generation===generation&&record.publishedAt<=now+300000?record.publishedAt:0;
}
