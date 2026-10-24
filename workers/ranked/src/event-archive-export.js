import {createEventService, EVENT_COLLECTIONS as C, EventError, publicEventPeriod} from './events.js';
import {eventDecode} from './events-store.js';
import {publicEventPage} from './event-public-projection.js';
import {PUBLIC_MANIFEST_COLLECTION, PUBLIC_PAGE_COLLECTION, publicationManifestId, publicationPageId} from './paged-publication.js';

export const ARCHIVE_EXPORT_PREFIX = '/v1/events/admin/archive-export';
export const ARCHIVE_EXPORT_READ_LIMIT = 6;
const fail = (code, status = 400) => {throw new EventError(code, status);};
const uint = value => Number.isSafeInteger(value) && value >= 0;

function selection(url) {
  const suffix = url.pathname.slice(ARCHIVE_EXPORT_PREFIX.length);
  const month = /^\/archives\/(\d{4}(?:0[1-9]|1[0-2]))$/.exec(suffix);
  const event = /^\/([A-Za-z0-9_-]{1,64})\/(snapshot(?:\/page)?|track|replays\/[a-f0-9]{64})$/.exec(suffix);
  if (!month && !event) fail('archive_export_not_found', 404);
  const keys = [...url.searchParams.keys()];
  if (event?.[2] === 'snapshot/page') {
    if (keys.length !== 2 || !keys.includes('generation') || !keys.includes('page')) fail('invalid_page');
    const generation = url.searchParams.get('generation'), text = url.searchParams.get('page'), page = Number(text);
    if (!/^[a-f0-9]{64}$/.test(generation || '') || !/^(0|[1-9]\d?)$/.test(text || '')) fail('invalid_page');
    return {id:event[1], resource:'page', generation, page};
  }
  if (keys.length) fail('archive_export_query_not_allowed');
  return month ? {month:month[1]} : {id:event[1], resource:event[2].split('/')[0], accountId:event[2].split('/')[1]};
}

function frozenBoard(value, id, now) {
  if (!value) fail('event_archive_not_found', 404);
  if (value.archived !== true || value.publicationPending === true) fail('event_archive_not_final', 409);
  const p = value.period;
  if (p?.id !== id || value.periodId !== undefined && value.periodId !== id ||
      !uint(value.archivedAt) || value.archivedAt > now || !uint(p?.endsAt) || !uint(p?.graceMs) ||
      value.archivedAt < p.endsAt + p.graceMs || !Array.isArray(value.entries) || value.entries.length > 500)
    fail('event_archive_corrupt', 503);
  return value;
}

function projectedBoard(board) {
  const result = {period:publicEventPeriod(board.period),
    entries:publicEventPage({entries:board.entries}, 'event').entries,
    archived:true, updatedAt:board.archivedAt, pendingPlaybacks:[],
    racerCount:uint(board.racerCount) ? board.racerCount : board.entries.length};
  for (const field of ['sourceRevision','sourceReadTime','sourceComplete','totalEntries','complete'])
    if (board[field] !== undefined) result[field] = board[field];
  if (board.pagination) {
    result.pagination = {};
    for (const field of ['version','generation','pageSize','pageCount','totalEntries','complete'])
      if (board.pagination[field] !== undefined) result.pagination[field] = board.pagination[field];
  }
  return result;
}

// Explicit operator capture only. This adapter exposes no transaction/write API
// to Firestore and memoizes exact document reads within one bounded request.
export async function exportEventArchive(incoming, env, {request, origins, now = Date.now}) {
  const origin = incoming.headers.get('Origin') || '';
  const headers = {'Content-Type':'application/json', 'Cache-Control':'private, no-store', Vary:'Origin'};
  let reads = 0;
  const respond = (status, body) => new Response(JSON.stringify(body), {status,
    headers:{...headers, 'X-Archive-Document-Reads':String(reads)}});
  try {
    if (!origins.has(origin)) fail('origin_not_allowed', 403);
    headers['Access-Control-Allow-Origin'] = origin;
    if (incoming.method !== 'GET') {headers.Allow = 'GET'; fail('method_not_allowed', 405);}
    if (!env.ADMIN_REBUILD_TOKEN || incoming.headers.get('X-Admin-Token') !== env.ADMIN_REBUILD_TOKEN)
      fail('admin_required', 403);
    if (String(env.EVENTS_ENABLED) !== 'true') fail('events_disabled', 503);
    const target = selection(new URL(incoming.url));
    if (!env.EVENT_RATE_LIMITER || (await env.EVENT_RATE_LIMITER.limit({key:'admin-archive-export'})).success !== true) {
      headers['Retry-After'] = '60'; fail('archive_export_rate_limited', 429);
    }
    const rootPath = C.history + '/' + target.id;
    const allowed = new Set(target.month ? [C.public + '/archive_' + target.month] : [rootPath]);
    if (target.resource === 'page') {
      allowed.add(PUBLIC_MANIFEST_COLLECTION + '/' + publicationManifestId('event', target.id, target.generation));
      allowed.add(PUBLIC_PAGE_COLLECTION + '/' + publicationPageId('event', target.id, target.generation, target.page));
    } else if (target.resource === 'track') allowed.add(C.archiveTracks + '/' + target.id);
    else if (target.resource === 'replays') {
      for (const path of [C.replays+'/'+target.id+'_'+target.accountId, C.periods+'/'+target.id,
        C.archives+'/'+target.id, C.pbs+'/'+target.id+'_'+target.accountId]) allowed.add(path);
    }
    const documents = new Map();
    const get = async path => {
      if (!allowed.has(path)) fail('archive_export_scope', 503);
      if (!documents.has(path)) {
        if (reads >= ARCHIVE_EXPORT_READ_LIMIT) fail('archive_export_read_budget', 503);
        reads++;
        const document = await request('/' + path);
        documents.set(path, document ? eventDecode({mapValue:{fields:document.fields || {}}}) : null);
      }
      return structuredClone(documents.get(path));
    };
    const service = createEventService({store:{transaction:fn=>fn({get})}, now});
    let value;
    if (target.month) {
      const month = await get(C.public + '/archive_' + target.month);
      if (!month) fail('event_archive_not_found', 404);
      if (!Array.isArray(month.periods) || month.periods.length > 120 || !uint(month.updatedAt)) fail('event_archive_corrupt', 503);
      value = {month:target.month, updatedAt:month.updatedAt, periods:month.periods.map(publicEventPeriod)};
    } else {
      const board = frozenBoard(await get(rootPath), target.id, now());
      if (target.resource === 'snapshot') value = projectedBoard(board);
      else if (target.resource === 'page') {
        const pagination = board.pagination;
        if (pagination?.generation !== target.generation || pagination.complete !== true ||
            !uint(pagination.pageCount) || pagination.pageCount > 100 || target.page >= pagination.pageCount)
          fail('archive_generation_mismatch', 409);
        value = await service.publicPage('event', target.id, target.generation, target.page);
        for (const field of ['generation','pageSize','pageCount','totalEntries'])
          if (value[field] !== pagination[field]) fail('archive_generation_mismatch', 409);
        if (value.page !== target.page) fail('archive_generation_mismatch', 409);
      } else if (target.resource === 'track') {
        value = await service.archivedTrack(target.id);
        if (value.trackId !== board.period.trackId) fail('event_archive_binding_mismatch', 503);
      } else {
        value = await service.replay(target.id, target.accountId);
        if (value.trackId !== board.period.trackId) fail('event_archive_binding_mismatch', 503);
      }
    }
    if (new TextEncoder().encode(JSON.stringify(value)).length > 2 * 1024 * 1024) fail('archive_export_too_large', 503);
    return respond(200, value);
  } catch (error) {
    return respond(error instanceof EventError ? error.status : 503,
      {error:error instanceof EventError ? error.code : 'archive_export_unavailable'});
  }
}
