import { createEventHandler } from './events.js';
import { eventRuntime, consumeEventInbox, provisionEvent, cleanupEvents } from './events-runtime.js';

export function eventWorkerHandler(env, { request, authenticate, origins }) {
  const runtime = eventRuntime(request, { projectId: env.FIREBASE_PROJECT_ID || 'polytrack-052' });
  return createEventHandler({ service: runtime.service, authenticate, allowedOrigins: origins,
    enabled: () => String(env.EVENTS_ENABLED) === 'true',
    allowRequest: async ({ request, ownerUid }) => {
      const limiter = env.EVENT_RATE_LIMITER;
      if (!limiter) return false;
      const key = ownerUid || request.headers.get('CF-Connecting-IP');
      return !!key && (await limiter.limit({ key })).success === true;
    } });
}

export async function eventWorkerMaintenance(env, { request, officialIds, allIds, targetForTrack, at = Date.now(), now = Date.now }) {
  if (String(env.EVENTS_ENABLED) !== 'true') return { disabled: true };
  // Scheduled time selects the work phase; admission and expiry use a live clock.
  const runtime = eventRuntime(request, { projectId: env.FIREBASE_PROJECT_ID || 'polytrack-052', now });
  // One bounded unit per invocation, separate from canonical reconciliation.
  if (Math.floor(at / 60000) % 5 === 0) {
    let capacity;
    try { capacity = JSON.parse(env.EVENT_CAPACITY_JSON); } catch { throw Error('Explicit reviewed event capacity required'); }
    return provisionEvent(runtime, { officialIds,
      allIds, capacity, targetForTrack });
  }
  if ([1, 3].includes(Math.floor(at / 60000) % 5)) {
    const cleanup = await cleanupEvents(runtime);
    if (!cleanup.idle) return cleanup;
  }
  return consumeEventInbox(runtime, { preferRetry: Math.floor(at / 60000) % 2 === 0 });
}
