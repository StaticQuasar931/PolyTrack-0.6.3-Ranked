export const MAX_PUBLICATION_COMMAND_CHARS=24000;
export const MAX_PUBLICATION_BATCH_FILES=256;
// Includes argv0, separators and NUL, plus conservative executable-resolution headroom.
const COMMAND_OVERHEAD=1024+'git add --'.length+1;
export function estimatePublicationCommandChars(files){
  return COMMAND_OVERHEAD+files.reduce((size,file)=>size+1+file.length,0);
}

export function publicationAddArgvBatches(files){
  if(!Array.isArray(files))throw Error('Publication path array required');
  const seen=new Set();
  // Eager validation: even a bad final entry must reject before the caller stages anything.
  for(const file of files){
    if(typeof file!=='string'||/\s/.test(file)||! /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(file)||
      file.split('/').some(part=>part==='.'||part==='..'||part.endsWith('.')||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))
      throw Error('Noncanonical publication path');
    const key=file.toLowerCase();
    if(seen.has(key))throw Error('Duplicate publication path');
    seen.add(key);
    if(estimatePublicationCommandChars([file])>MAX_PUBLICATION_COMMAND_CHARS)throw Error('Oversize publication path');
  }
  const batches=[];let batch=[],size=COMMAND_OVERHEAD;
  for(const file of files){
    const cost=1+file.length;
    if(batch.length&&(batch.length===MAX_PUBLICATION_BATCH_FILES||size+cost>MAX_PUBLICATION_COMMAND_CHARS)){
      batches.push(['add','--',...batch]);batch=[];size=COMMAND_OVERHEAD;
    }
    batch.push(file);size+=cost;
  }
  if(batch.length)batches.push(['add','--',...batch]);
  return batches;
}
