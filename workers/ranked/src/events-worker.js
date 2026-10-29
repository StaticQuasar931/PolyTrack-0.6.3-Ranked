import {createPublicReadMemory} from './public-read-memory.js';
import {publicationPageId} from './paged-publication.js';
import {staticEventRead} from './event-read-policy.js';
import {ARCHIVE_EXPORT_PREFIX, exportEventArchive} from './event-archive-export.js';
import {publishEventCapacity} from './event-publication.js';
import { provisionKodubEvent } from './kodub-event.js';
import { createEventHandler, EventError } from './events.js';
import { eventRuntime, consumeEventInbox, provisionEvent, cleanupEvents } from './events-runtime.js';
import { readPermanentRollingHills, mergePermanentRollingIntoTotals } from './permanent-rolling-hills.js';

function eventPageCacheName(kind,id,generation,page){
  try{publicationPageId(kind,id,generation,page);}catch{throw new EventError('invalid_page');}
  return 'page/'+kind+'/'+id+'/'+generation+'/'+page;
}
const EVENT_CACHE_FILL_LIMIT = 64;
const EVENT_PAGE_MISS_TTL_SECONDS = 10;
const eventCacheFills = new Map();
const eventPublicMemories = new WeakMap();
const eventPageMissMemories = new WeakMap();
const publicCacheMatch=async(cache,key)=>{try{return await cache?.match(key);}catch{return undefined;}};

export function eventWorkerHandler(env, { request, authenticate, origins, context = {}, now = Date.now }) {
  const runtime = eventRuntime(request, { projectId: env.FIREBASE_PROJECT_ID || 'polytrack-052', now });
  const enabled = () => String(env.EVENTS_ENABLED) === 'true';
  const memoryOwner=env.__FIRESTORE_ROOT_ENV||env;
  let memory=eventPublicMemories.get(memoryOwner);
  if(!memory){memory=createPublicReadMemory();eventPublicMemories.set(memoryOwner,memory);}
  let pageMisses=eventPageMissMemories.get(memoryOwner);
  if(!pageMisses){pageMisses=createPublicReadMemory({maxEntries:64,maxBytes:16384});eventPageMissMemories.set(memoryOwner,pageMisses);}
  const cachedHits = new WeakMap();
  const admittedRequests = new WeakSet();
  const cacheKeyFor = incoming => {
    const url = new URL(incoming.url);
    if (incoming.method !== 'GET') return null;
    let name = null;
    const pageMatch=/^\/v1\/events\/(totals|[A-Za-z0-9_-]{1,64}\/snapshot)\/page$/.exec(url.pathname);
    if(pageMatch){try{if(!/^\d+$/.test(url.searchParams.get('page')||''))return null;name=eventPageCacheName(pageMatch[1]==='totals'?'event_totals':'event',pageMatch[1]==='totals'?'main':pageMatch[1].split('/')[0],url.searchParams.get('generation'),Number(url.searchParams.get('page')));}catch{return null;}}
    if(name){}
    else if (url.pathname === '/v1/events/catalog' || url.pathname === '/v1/events/current') name = 'catalog';
    else if (url.pathname === '/v1/events/totals') name = 'totals';
    else if (url.pathname === '/v1/events/permanent-rolling-hills/snapshot') name = 'permanent-rolling-hills';
    else {
      const archive = /^\/v1\/events\/archives\/(\d{6})$/.exec(url.pathname);
      const snapshot = /^\/v1\/events\/([A-Za-z0-9_-]{1,64})\/snapshot$/.exec(url.pathname);
      if (archive) name = 'archive/' + archive[1];
      else if (snapshot) name = 'snapshot/' + encodeURIComponent(snapshot[1]);
      else {
        const recording = /^\/v1\/events\/([A-Za-z0-9_-]{1,64})\/(replays|playbacks)\/([a-f0-9]{64})$/.exec(url.pathname);
        if (recording) name = recording[2] + '/' + recording[1] + '/' + recording[3];
      }
    }
    if (!name) return null;
    const keyUrl = new URL('/__event_public_cache/' + encodeURIComponent(env.FIREBASE_PROJECT_ID || 'polytrack-052') + '/' + name, url);
    return new Request(keyUrl.toString());
  };
  const allowRequest = async ({ request: incoming, ownerUid, forceOrigin = false }) => {
    if (!forceOrigin && incoming.method === 'GET' && ownerUid == null) {
      const key = cacheKeyFor(incoming), cache = typeof caches !== 'undefined' ? caches.default : null;
      if (key && cache) {
        const hit = await publicCacheMatch(cache,key);
        if (hit) {
          let hits = cachedHits.get(incoming);
          if (!hits) cachedHits.set(incoming, hits = new Map());
          hits.set(key.url, hit);
          return true;
        }
      }
      if (key) return true;
    }
    if (admittedRequests.has(incoming)) return true;
    const limiter = env.EVENT_RATE_LIMITER;
    if (!limiter) return false;
    const key = ownerUid || incoming.headers.get('CF-Connecting-IP');
    const admitted = !!key && (await limiter.limit({ key })).success === true;
    if (admitted) admittedRequests.add(incoming);
    return admitted;
  };
  return async incoming => {
    const url = new URL(incoming.url);
    if (url.pathname === ARCHIVE_EXPORT_PREFIX || url.pathname.startsWith(ARCHIVE_EXPORT_PREFIX + '/'))
      return exportEventArchive(incoming, env, {request, origins, now});
    // Before authentication, rate limits, cache hits, or any database lookup.
    // Missing static archives must remain missing, never become paid fallbacks.
    const archived = incoming.method === 'GET' && staticEventRead(url.pathname, now());
    if (archived) {
      const origin = incoming.headers.get('Origin') || '';
      const headers = {'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin'};
      if (!origins.has(origin)) return new Response(JSON.stringify({error:'origin_not_allowed'}), {status:403, headers});
      headers['Access-Control-Allow-Origin'] = origin;
      if (!enabled()) return new Response(JSON.stringify({error:'events_disabled'}), {status:503, headers});
      return new Response(JSON.stringify({error:'event_archive_static_only', snapshotOnly:true,
        snapshotPointer:'snapshot-current.json', ...archived}), {status:410, headers});
    }
    const cachedPublic = async (name, ttl, load) => {
      const cache = typeof caches !== 'undefined' ? caches.default : null;
      const keyUrl = new URL('/__event_public_cache/' + encodeURIComponent(env.FIREBASE_PROJECT_ID || 'polytrack-052') + '/' + name, url);
      const key = new Request(keyUrl.toString());
      const remembered=memory.get(key.url,now());
      if(remembered!==undefined)return JSON.parse(remembered);
      const hit = cachedHits.get(incoming)?.get(key.url) || cache && await publicCacheMatch(cache,key);
      // A Cache API hit has an unknown original expiry. Do not renew it in memory.
      if (hit) return hit.json();
      const isPage=name.startsWith('page/');
      if(isPage&&pageMisses.get(key.url,now())!==undefined)throw new EventError('snapshot_not_ready',404);
      const staleKey = new Request(keyUrl.toString() + '?stale=1');
      const stale = name === 'catalog' && cache ? await publicCacheMatch(cache,staleKey) : null;
      try {
        const fill = async () => {
          if (!admittedRequests.has(incoming) && !await allowRequest({ request: incoming, ownerUid: null, forceOrigin: true })) {
            throw new EventError('event_ingress_limit', 429);
          }
          const loadedAt=now();
          let value;
          try { value = await load(); }
          catch(error) {
            // Only confirmed public-page absence is reusable; never cache auth or transport failures.
            if(isPage&&error instanceof EventError&&error.status===404&&error.code==='snapshot_not_ready')
              pageMisses.put(key.url,'missing',EVENT_PAGE_MISS_TTL_SECONDS,loadedAt);
            throw error;
          }
          const body = JSON.stringify(value);
          memory.put(key.url,body,ttl,loadedAt);
          if (cache) {
            const writes = [cache.put(key, new Response(body, { headers: { 'Cache-Control': 'public, max-age=' + ttl } }))];
            if (name === 'catalog') writes.push(cache.put(staleKey, new Response(body, { headers: { 'Cache-Control': 'public, max-age=86400' } })));
            const put = Promise.all(writes).catch(() => {});
            if (context.waitUntil) context.waitUntil(put);
            await put;
          }
          return value;
        };
        let pending = eventCacheFills.get(key.url);
        if (!pending) {
          if (eventCacheFills.size >= EVENT_CACHE_FILL_LIMIT) {
            const error = Error('event_cache_busy'); error.code = 'event_cache_busy'; throw error;
          }
          pending = Promise.resolve().then(fill);
          eventCacheFills.set(key.url, pending);
          pending.finally(() => { if (eventCacheFills.get(key.url) === pending) eventCacheFills.delete(key.url); }).catch(() => {});
        }
        return await pending;
      } catch (error) {
        if (error.code === 'event_ingress_limit') throw error;
        if (stale) return stale.json();
        throw error;
      }
    };
    const service = { ...runtime.service,
      publicPage:(kind,id,generation,page)=>cachedPublic(eventPageCacheName(kind,id,generation,page),86400,()=>runtime.service.publicPage(kind,id,generation,page)),
      catalog: () => cachedPublic('catalog', 300, () => runtime.service.catalog()),
      totals: () => cachedPublic('totals', 120, () => runtime.service.totals()),
      replay: (id, accountId) => cachedPublic('replays/' + id + '/' + accountId, 60, () => runtime.service.replay(id, accountId)),
      playback: (id, runId) => cachedPublic('playbacks/' + id + '/' + runId, 60, () => runtime.service.playback(id, runId)),
      snapshot: id => cachedPublic('snapshot/' + encodeURIComponent(id), 60, () => runtime.service.snapshot(id)) };
    const events = createEventHandler({ service, authenticate, allowedOrigins: origins, enabled, allowRequest });
    if (incoming.method === 'GET' && url.pathname === '/v1/events/permanent-rolling-hills/snapshot') {
      const origin = incoming.headers.get('Origin') || '';
      const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin' };
      if (origins.has(origin)) headers['Access-Control-Allow-Origin'] = origin;
      if (!origins.has(origin)) return new Response(JSON.stringify({ error: 'origin_not_allowed' }), { status: 403, headers });
      if (!enabled()) return new Response(JSON.stringify({ error: 'events_disabled' }), { status: 503, headers });
      if (!await allowRequest({ request: incoming, ownerUid: null })) {
        headers['Retry-After'] = '60';
        return new Response(JSON.stringify({ error: 'event_ingress_limit' }), { status: 429, headers });
      }
      try { return new Response(JSON.stringify(await cachedPublic('permanent-rolling-hills', 120, () => readPermanentRollingHills(request))), { status: 200, headers }); }
      catch (error) {
        if (error.code === 'event_ingress_limit') {
          headers['Retry-After'] = '60';
          return new Response(JSON.stringify({ error: 'event_ingress_limit' }), { status: 429, headers });
        }
        return new Response(JSON.stringify({ error: 'permanent_rolling_hills_unavailable' }), { status: 503, headers });
      }
    }
    const response = await events(incoming);
    if (incoming.method !== 'GET' || url.pathname !== '/v1/events/totals' || response.status !== 200) return response;
    const finite = await response.json();
    if(finite.dynamicComponents)return new Response(JSON.stringify(finite),{status:200,headers:response.headers});
    try {
      const rolling = await cachedPublic('permanent-rolling-hills', 120, () => readPermanentRollingHills(request));
      return new Response(JSON.stringify(mergePermanentRollingIntoTotals(finite, rolling)), { status: 200, headers: response.headers });
    } catch {
      return new Response(JSON.stringify({ ...finite, eventRpComplete: false,
        dynamicComponents: { permanentRollingHills: { status: 'unavailable' } } }), { status: 200, headers: response.headers });
    }
  };
}

export async function eventWorkerMaintenance(env, { request, officialIds, allIds, targetForTrack, fetch: fetcher = fetch,
  at = Date.now(), now = Date.now }) {
  if (String(env.EVENTS_ENABLED) !== 'true') return { disabled: true };
  if (!Number.isSafeInteger(at) || at < 0) return { idle: true, reason: 'invalid_schedule' };
  const minute = Math.floor(at / 60000), phase = minute % 5;
  // Provisioning is not a minute-by-minute work signal. Skip before any I/O.
  if (phase === 0 && minute % 15 !== 0) return { idle: true, reason: 'provision_cadence' };
  // Scheduled time selects the work phase; admission and expiry use a live clock.
  const runtime = eventRuntime(request, { projectId: env.FIREBASE_PROJECT_ID || 'polytrack-052', now });
  // One bounded unit per invocation, separate from canonical reconciliation.
  if (phase === 0) {
    let capacity;
    try { capacity = JSON.parse(env.EVENT_CAPACITY_JSON); } catch { throw Error('Explicit reviewed event capacity required'); }
    const regular=await provisionEvent(runtime, { officialIds, allIds, capacity, targetForTrack });
    // Upstream failure must never prevent our own daily and weekly maintenance.
    try{return {...regular,kodub:await provisionKodubEvent(runtime,{capacity,fetch:fetcher})};}
    catch(error){return {...regular,kodub:{unavailable:true,reason:String(error.message).slice(0,120)}};}
  }
  // Keep cleanup throughput at one bounded page per five minutes. An idle
  // catalog does not justify unconditional inbox/retry queries in this phase.
  if (phase === 1) {
    const cleanup = await cleanupEvents(runtime);
    if (!cleanup.idle) return cleanup;
  }
  if([2,4].includes(phase)){
    const publication=await publishEventCapacity(runtime);if(!publication.idle)return publication;
  }
  return consumeEventInbox(runtime, { preferRetry: minute % 2 === 0, recentActivityOnly: phase !== 3 });
}
