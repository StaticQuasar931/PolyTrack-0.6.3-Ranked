import { provisionKodubEvent } from './kodub-event.js';
import { createEventHandler } from './events.js';
import { eventRuntime, consumeEventInbox, provisionEvent, cleanupEvents } from './events-runtime.js';
import { readPermanentRollingHills, mergePermanentRollingIntoTotals } from './permanent-rolling-hills.js';

export function eventWorkerHandler(env, { request, authenticate, origins }) {
  const runtime = eventRuntime(request, { projectId: env.FIREBASE_PROJECT_ID || 'polytrack-052' });
  const enabled = () => String(env.EVENTS_ENABLED) === 'true';
  const allowRequest = async ({ request: incoming, ownerUid }) => {
    const limiter = env.EVENT_RATE_LIMITER;
    if (!limiter) return false;
    const key = ownerUid || incoming.headers.get('CF-Connecting-IP');
    return !!key && (await limiter.limit({ key })).success === true;
  };
  const events = createEventHandler({ service: runtime.service, authenticate, allowedOrigins: origins, enabled, allowRequest });
  return async incoming => {
    const url = new URL(incoming.url);
    if (incoming.method === 'GET' && url.pathname === '/v1/events/permanent-rolling-hills/snapshot') {
      const origin = incoming.headers.get('Origin') || '';
      const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin' };
      if (origins.has(origin)) headers['Access-Control-Allow-Origin'] = origin;
      if (!origins.has(origin)) return new Response(JSON.stringify({ error: 'origin_not_allowed' }), { status: 403, headers });
      if (!enabled()) return new Response(JSON.stringify({ error: 'events_disabled' }), { status: 503, headers });
      if (!await allowRequest({ request: incoming, ownerUid: null })) return new Response(JSON.stringify({ error: 'event_ingress_limit' }), { status: 429, headers });
      try { return new Response(JSON.stringify(await readPermanentRollingHills(request)), { status: 200, headers }); }
      catch { return new Response(JSON.stringify({ error: 'permanent_rolling_hills_unavailable' }), { status: 503, headers }); }
    }
    const response = await events(incoming);
    if (incoming.method !== 'GET' || url.pathname !== '/v1/events/totals' || response.status !== 200) return response;
    const finite = await response.json();
    try {
      const rolling = await readPermanentRollingHills(request);
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
  if ([1, 3].includes(Math.floor(at / 60000) % 5)) {
    const cleanup = await cleanupEvents(runtime);
    if (!cleanup.idle) return cleanup;
  }
  return consumeEventInbox(runtime, { preferRetry: Math.floor(at / 60000) % 2 === 0 });
}
