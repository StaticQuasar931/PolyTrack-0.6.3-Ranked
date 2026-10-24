export const PUBLIC_PAGE_SIZE = 100;
export const PUBLIC_PAGE_COLLECTION = '0.6.2_s1_public_pages';
export const PUBLIC_MANIFEST_COLLECTION = '0.6.2_s1_public_manifests';
export const PUBLIC_PAGE_BYTES = 800000;

export async function contentHash(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
export function publicationPageId(kind, id, generation, page) {
  if (!['track','overall','event','event_totals'].includes(kind) || !/^[A-Za-z0-9_-]{1,80}$/.test(id) ||
      !/^[a-f0-9]{64}$/.test(generation) || !Number.isSafeInteger(page) || page < 0) throw Error('INVALID_PUBLIC_PAGE');
  return `${kind}_${id}_${generation}_${page}`;
}
export function publicationManifestId(kind,id,generation) { return publicationPageId(kind,id,generation,0); }
export async function decodePublicationPage(data) {
  if(!data?.pageBundle)return data;
  if(data.pageEncoding!=='gzip-base64-json-v1'||typeof data.pageBundle!=='string'||data.pageBundle.length>PUBLIC_PAGE_BYTES)throw Error('PUBLIC_PAGE_ENCODING_INVALID');
  const bytes=Uint8Array.from(atob(data.pageBundle),c=>c.charCodeAt(0));
  const reader=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks=[];let size=0;
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>16000000){await reader.cancel();throw Error('PUBLIC_PAGE_INFLATE_BUDGET');}chunks.push(value);}
  const inflated=new Uint8Array(size);let offset=0;for(const chunk of chunks){inflated.set(chunk,offset);offset+=chunk.length;}
  const parsed=JSON.parse(new TextDecoder().decode(inflated));
  for(const field of ['generation','page','pageSize','pageCount','totalEntries','sourceRevision','sourceComplete'])if(parsed[field]!==data[field])throw Error('PUBLIC_PAGE_ENVELOPE_MISMATCH');
  return parsed;
}
export async function preparePublicationPages(kind, id, entries, metadata = {}) {
  // Hash the whole ordered field, never a display prefix. Identical retries reuse pages.
  const generation = await contentHash({kind, id, entries, metadata});
  const pageCount = Math.ceil(entries.length / PUBLIC_PAGE_SIZE);
  const pagination = {version:1, generation, pageSize:PUBLIC_PAGE_SIZE, pageCount, totalEntries:entries.length, complete:true};
  const documents = [];
  for (let page = 0; page < pageCount; page++) {
    let data = {...metadata, ...pagination, page, entries:entries.slice(page * PUBLIC_PAGE_SIZE, (page + 1) * PUBLIC_PAGE_SIZE)};
    const serialized=JSON.stringify(data);
    if(new TextEncoder().encode(serialized).length>300000){
      const bytes=new Uint8Array(await new Response(new Blob([serialized]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
      let binary='';for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));
      data={...metadata,...pagination,page,pageEncoding:'gzip-base64-json-v1',pageBundle:btoa(binary)};
    }
    if (new TextEncoder().encode(JSON.stringify(data)).length > PUBLIC_PAGE_BYTES) throw Error('PUBLIC_PAGE_BYTE_BUDGET');
    documents.push({collection:PUBLIC_PAGE_COLLECTION, id:publicationPageId(kind, id, generation, page), data, unconditional:true});
  }
  return {pagination, documents};
}
export async function loadPublicationEntries(snapshot, kind, id, read) {
  const p = snapshot?.pagination;
  if (!p) return snapshot?.entries || [];
  if (p.version !== 1 || p.complete !== true || p.pageSize !== PUBLIC_PAGE_SIZE ||
      !Number.isSafeInteger(p.totalEntries) || p.totalEntries < 0 || p.pageCount !== Math.ceil(p.totalEntries / PUBLIC_PAGE_SIZE)) throw Error('PUBLIC_MANIFEST_INVALID');
  const entries = [];
  for (let page = 0; page < p.pageCount; page++) {
    const document = await read(PUBLIC_PAGE_COLLECTION, publicationPageId(kind, id, p.generation, page));
    const data = await decodePublicationPage(document?.data);
    const expected = Math.min(PUBLIC_PAGE_SIZE, p.totalEntries - page * PUBLIC_PAGE_SIZE);
    if (!data || data.generation !== p.generation || data.page !== page || data.pageCount !== p.pageCount ||
        data.totalEntries !== p.totalEntries || data.complete !== true || !Array.isArray(data.entries) || data.entries.length !== expected) throw Error('PUBLIC_PAGE_INCOMPLETE');
    entries.push(...data.entries);
  }
  return entries;
}
