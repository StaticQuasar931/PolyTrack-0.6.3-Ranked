import {KODUB_ROOT,validateWeekly,assetPath,boundedBytes,validateAsset} from '../../../events/kodub-schema.mjs';

// Fixed upstream and strict paths: this is not a general URL proxy. No credentials are forwarded.
export async function kodubWeekly(request, headers, context = {}, dependencies = {}) {
  const fetcher = dependencies.fetch || fetch;
  const cache = dependencies.cache ?? globalThis.caches?.default;
  const path = new URL(request.url).pathname;
  const match = /^\/v1\/kodub-weekly\/(track|image)\/([a-f0-9]{64})$/.exec(path);
  const metadata = path === '/v1/kodub-weekly';
  if (request.method !== 'GET' || (!metadata && !match)) return new Response(null,{status:404,headers});
  const cacheUrl=new URL(path,request.url);
  cacheUrl.searchParams.set('origin',request.headers.get('Origin') || '');
  const key = new Request(cacheUrl);
  const hit = await cache?.match(key);
  if (hit) return hit;
  try {
    const upstream = await fetcher(KODUB_ROOT + (metadata ? '' : '/' + match[1] + '/' + match[2]) + '?version=0.6.3', {
      headers:{Accept:metadata?'application/json':'*/*',Origin:'https://app-polytrack.kodub.com',Referer:'https://app-polytrack.kodub.com/'},
      redirect:'manual',signal:AbortSignal.timeout(8000)
    });
    if (!upstream.ok) throw Error('upstream_http_'+upstream.status);
    const bytes = await boundedBytes(upstream,metadata?16384:2*1024*1024);
    let body, type, ttl;
    if (metadata) {
      const current = validateWeekly(JSON.parse(new TextDecoder().decode(bytes)));
      if (current) for (const [field,kind] of [['trackUrl','track'],['thumbnailUrl','image'],['coverUrl','image']]) {
        if (field === 'coverUrl' && current[field] === null) continue;
        current[field] = new URL('/v1/kodub-weekly/' + assetPath(current[field],kind),request.url).href;
      }
      body = JSON.stringify({serverTime:new Date().toISOString(),current}); type = 'application/json; charset=utf-8';
      ttl = current ? Math.max(1,Math.min(60,Math.floor((Date.parse(current.endTime)-Date.now())/1000))) : 30;
    } else {
      body = validateAsset(bytes,match[1]); type = match[1] === 'track' ? 'text/plain; charset=utf-8' : 'image/webp'; ttl = 86400;
    }
    const out = new Headers(headers); out.set('Content-Type',type); out.set('Cache-Control','public, max-age='+ttl);
    const response = new Response(body,{headers:out});
    if (cache && context.waitUntil) context.waitUntil(cache.put(key,response.clone()));
    return response;
  } catch (error) {
    console.warn('Kodub mirror failed:',error.message);
    const out = new Headers(headers); out.set('Cache-Control','no-store');
    return new Response(JSON.stringify({error:'kodub_unavailable'}),{status:502,headers:out});
  }
}




