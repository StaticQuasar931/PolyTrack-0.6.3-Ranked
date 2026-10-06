import { provisionKodubEvent } from './kodub-event.js';
import { createEventHandler, EventError } from './events.js';
import { eventRuntime, consumeEventInbox, provisionEvent, cleanupEvents } from './events-runtime.js';
import { readPermanentRollingHills, mergePermanentRollingIntoTotals } from './permanent-rolling-hills.js';

const EVENT_CACHE_FILL_LIMIT = 64;
const eventCacheFills = new Map();

export function eventWorkerHandler(env, { request, authenticate, origins, context = {} }) {
  const runtime = eventRuntime(request, { projectId: env.FIREBASE_PROJECT_ID || 'polytrack-052' });
  const enabled = () => String(env.EVENTS_ENABLED) === 'true';
  const cachedHits = new WeakMap();
  const admittedRequests = new WeakSet();
  const cacheKeyFor = incoming => {
    const url = new URL(incoming.url);
    if (incoming.method !== 'GET') return null;
    let name = null;
    if (url.pathname === '/v1/events/catalog' || url.pathname === '/v1/events/current') name = 'catalog';
    else if (url.pathname === '/v1/events/totals') name = 'totals';
    else if (url.pathname === '/v1/events/permanent-rolling-hills/snapshot') name = 'permanent-rolling-hills';
    else {
      const archive = /^\/v1\/events\/archives\/(\d{6})$/.exec(url.pathname);
      const snapshot = /^\/v1\/events\/([A-Za-z0-9_-]{1,64})\/snapshot$/.exec(url.pathname);
      if (archive) name = 'archive/' + archive[1];
      else if (snapshot) name = 'snapshot/' + encodeURIComponent(snapshot[1]);
    }
    if (!name) return null;
    const keyUrl = new URL('/__event_public_cache/' + encodeURIComponent(env.FIREBASE_PROJECT_ID || 'polytrack-052') + '/' + name, url);
    return new Request(keyUrl.toString());
  };
  const allowRequest = async ({ request: incoming, ownerUid, forceOrigin = false }) => {
    if (!forceOrigin && incoming.method === 'GET' && ownerUid == null) {
      const key = cacheKeyFor(incoming), cache = typeof caches !== 'undefined' ? caches.default : null;
      if (key && cache) {
        const hit = await cache.match(key);
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
    const cachedPublic = async (name, ttl, load) => {
      const cache = typeof caches !== 'undefined' ? caches.default : null;
      const keyUrl = new URL('/__event_public_cache/' + encodeURIComponent(env.FIREBASE_PROJECT_ID || 'polytrack-052') + '/' + name, url);
      const key = new Request(keyUrl.toString());
      const hit = cachedHits.get(incoming)?.get(key.url) || cache && await cache.match(key);
      if (hit) return hit.json();
      const staleKey = new Request(keyUrl.toString() + '?stale=1');
      const stale = name === 'catalog' && cache ? await cache.match(staleKey) : null;
      try {
        const fill = async () => {
          if (!admittedRequests.has(incoming) && !await allowRequest({ request: incoming, ownerUid: null, forceOrigin: true })) {
            throw new EventError('event_ingress_limit', 429);
          }
          const value = await load();
          if (cache) {
            const body = JSON.stringify(value);
            const writes = [cache.put(key, new Response(body, { headers: { 'Cache-Control': 'public, max-age=' + ttl } }))];
            if (name === 'catalog') writes.push(cache.put(staleKey, new Response(body, { headers: { 'Cache-Control': 'public, max-age=86400' } })));
            const put = Promise.all(writes);
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
      catalog: () => cachedPublic('catalog', 120, () => runtime.service.catalog()),
      totals: () => cachedPublic('totals', 20, () => runtime.service.totals()),
      archiveMonth: month => cachedPublic('archive/' + month, 300, () => runtime.service.archiveMonth(month)),
      snapshot: id => cachedPublic('snapshot/' + encodeURIComponent(id), 15, () => runtime.service.snapshot(id)) };
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
      try { return new Response(JSON.stringify(await cachedPublic('permanent-rolling-hills', 20, () => readPermanentRollingHills(request))), { status: 200, headers }); }
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
    try {
      const rolling = await cachedPublic('permanent-rolling-hills', 20, () => readPermanentRollingHills(request));
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
  // Scheduled time selects the work phase; admission and expiry use a live clock.
  const runtime = eventRuntime(request, { projectId: env.FIREBASE_PROJECT_ID || 'polytrack-052', now });
  // One bounded unit per invocation, separate from canonical reconciliation.
  if (Math.floor(at / 60000) % 5 === 0) {
    let capacity;
    try { capacity = JSON.parse(env.EVENT_CAPACITY_JSON); } catch { throw Error('Explicit reviewed event capacity required'); }
    const regular=await provisionEvent(runtime, { officialIds, allIds, capacity, targetForTrack });
    // Upstream failure must never prevent our own daily and weekly maintenance.
    try{return {...regular,kodub:await provisionKodubEvent(runtime,{capacity,fetch:fetcher})};}
    catch(error){return {...regular,kodub:{unavailable:true,reason:String(error.message).slice(0,120)}};}
  }
  // One bounded cleanup page per five-minute window is enough; keep the other
  // maintenance minute available for inbox intake without rereading the catalog.
  if (Math.floor(at / 60000) % 5 === 1) {
    const cleanup = await cleanupEvents(runtime);
    if (!cleanup.idle) return cleanup;
  }
  return consumeEventInbox(runtime, { preferRetry: Math.floor(at / 60000) % 2 === 0 });
}
