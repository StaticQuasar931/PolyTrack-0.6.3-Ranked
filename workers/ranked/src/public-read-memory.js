// Optional per-isolate resilience to edge-cache eviction. Never extends public freshness.
export function createPublicReadMemory({maxEntries=64,maxBytes=2*1024*1024}={}) {
  const rows=new Map(),utf8=new TextEncoder();let size=0;
  const remove=key=>{const row=rows.get(key);if(row){size-=row.bytes;rows.delete(key);}};
  return {
    get(key,now){
      const row=rows.get(key);
      if(!row)return undefined;
      if(!Number.isSafeInteger(now)||now<row.at||now>=row.expiresAt){remove(key);return undefined;}
      rows.delete(key);rows.set(key,row);return row.body;
    },
    put(key,body,ttl,now){
      remove(key);
      if(typeof body!=='string'||!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(ttl)||ttl<=0)return false;
      const bytes=utf8.encode(body).length;
      if(bytes>maxBytes)return false;
      while(rows.size&&(size+bytes>maxBytes||rows.size>=maxEntries))remove(rows.keys().next().value);
      if(maxEntries<1)return false;
      rows.set(key,{body,bytes,at:now,expiresAt:now+ttl*1000});size+=bytes;return true;
    }
  };
}
