import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createEventService, EVENT_COLLECTIONS as C, EVENT_LIMITS as L} from '../src/events.js';
import {consumeEventInbox, eventWork, EVENT_INBOX_RETRY_MAX_MS} from '../src/events-runtime.js';
import {eventEncode} from '../src/events-store.js';

const accountId = 'b'.repeat(64), trackId = 'a'.repeat(64), inboxId = 'backoff_' + accountId;
const inboxPath = C.inbox + '/' + inboxId, retryPath = C.retries + '/' + inboxId;
const queuePath = C.queues + '/backoff', statusPath = C.receipts + '/' + inboxId;
const period = {id:'backoff', enabled:true, trackId, startsAt:1000, endsAt:86401000,
  graceMs:3600000, targetMs:10000, maxRp:100, eligibility:'best-submitted-during-period',
  capacity:{policyVersion:'test', entrants:200, admissionsPerPeriod:2048,
    replayBytesPerPeriod:8388608, minIntervalMs:1000, verificationsPerDay:128}};

// Real admission service, in-memory transactional storage, and only the two existing limit-one queries.
async function fixture(kind = 'queue') {
  const data = new Map(), queries = [], gets = [], transactions = [], costs = {reads:0, writes:0};
  let now = 0, submissions = 0;
  const store = {async transaction(fn) {
    const copy = structuredClone(data), reads = new Set(), writes = new Set();
    const write = (key, value, mode) => {
      assert.ok(mode === 'create' || reads.has(key), 'write requires prior read');
      assert.ok(!writes.has(key)); writes.add(key); assert.ok(writes.size <= 16);
      if (mode === 'create') assert.ok(!copy.has(key));
      if (mode === 'delete') copy.delete(key);
      else copy.set(key, structuredClone(mode === 'patch' ? {...copy.get(key), ...value} : value));
    };
    const result = await fn({get:async key => {
      assert.equal(writes.size, 0); assert.ok(reads.size < 16 || reads.has(key));
      if (!reads.has(key)) costs.reads++;
      reads.add(key); return structuredClone(copy.get(key) || null);
    }, create:(k,v) => write(k,v,'create'), set:(k,v) => write(k,v,'set'),
    patch:(k,v) => write(k,v,'patch'), delete:k => write(k,null,'delete')});
    costs.writes += writes.size;
    transactions.push({reads:[...reads], writes:[...writes]});
    data.clear(); for (const [key,value] of copy) data.set(key,value);
    return result;
  }};
  const service = createEventService({store, now:() => now,
    hash:value => createHash('sha256').update(value).digest('hex')});
  data.set(C.profiles + '/' + accountId, {accountId, ownerUid:'owner', name:'Racer'});
  await service.bindOwner('owner', accountId);
  await service.createPeriod(period);
  now = 2000;
  data.set(inboxPath, {periodId:period.id, accountId, ownerUid:'owner', trackId,
    attemptId:'first', replay:'AAAA', timeMs:20402, frames:20402, carStyle:'',
    receivedAt:{__firestoreTimestamp:new Date(now).toISOString()}});
  const wire = key => ({name:'projects/test-project/databases/(default)/documents/' + key,
    fields:eventEncode(data.get(key)).mapValue.fields});
  const runtime = {store, now:() => now, service:{async consumeInbox(row) {
    submissions++; return service.consumeInbox(row);
  }}, request:async (path, init) => {
    if (path !== ':runQuery') {
      gets.push(path); costs.reads++;
      assert.ok([C.cursors + '/scan', inboxPath, C.catalog + '/main', queuePath].includes(path.slice(1)), 'no new point reads');
      return data.has(path.slice(1)) ? wire(path.slice(1)) : null;
    }
    const query = JSON.parse(init.body).structuredQuery;
    queries.push(query); assert.equal(query.limit, 1, 'no widened scans');
    const collection = query.from[0].collectionId;
    assert.ok([C.inbox, C.retries].includes(collection), 'no new collection scans');
    let rows = [...data.keys()].filter(key => key.startsWith(collection + '/'));
    if (collection === C.inbox) {
      rows.sort((a,b) => data.get(a).receivedAt.__firestoreTimestamp.localeCompare(data.get(b).receivedAt.__firestoreTimestamp) || a.localeCompare(b));
      if (query.startAt) rows = rows.filter(key => {
        const at = data.get(key).receivedAt.__firestoreTimestamp, after = query.startAt.values;
        return at > after[0].timestampValue || at === after[0].timestampValue && wire(key).name > after[1].referenceValue;
      });
    } else {
      assert.equal(query.where.fieldFilter.field.fieldPath, 'notBefore');
      assert.equal(query.where.fieldFilter.op, 'LESS_THAN_OR_EQUAL');
      assert.equal(Number(query.where.fieldFilter.value.integerValue), now);
      rows = rows.filter(key => data.get(key).notBefore <= now).sort((a,b) => data.get(a).notBefore - data.get(b).notBefore);
    }
    costs.reads++; return rows.slice(0,1).map(key => ({document:wire(key)}));
  }};
  const pressure = enabled => {
    const queue = data.get(queuePath);
    queue.slots = enabled && kind === 'queue' ? Array.from({length:L.queued}, () => ({notBefore:Infinity})) : [];
    queue.replayBytes = enabled && kind === 'replay' ? period.capacity.replayBytesPerPeriod : 0;
  };
  pressure(true); costs.reads = costs.writes = 0;
  return {data, runtime, service, costs, queries, gets, transactions, pressure, now:() => now, time:at => {now=at;},
    submissions:() => submissions, retry:() => data.get(retryPath),
    run:options => consumeEventInbox(runtime, options)};
}

for (const kind of ['queue','replay']) {
  test(`${kind} capacity: exponential delays cap, waiting payload survives, and no new scans`, async () => {
    const f = await fixture(kind), original = structuredClone(f.data.get(inboxPath));
    for (let attempt = 1; attempt <= 20; attempt++) {
      const at = f.now(), before = {...f.costs}, queries = f.queries.length;
      const result = await f.run();
      assert.equal(result.status, `event_${kind}_capacity`); assert.equal(result.retry, true);
      const expected = Math.min(60000 * 2 ** Math.min(attempt-1,4), EVENT_INBOX_RETRY_MAX_MS);
      assert.equal(f.retry().notBefore, at + expected);
      assert.equal(f.retry().attempts, Math.min(attempt,16));
      assert.deepEqual(f.data.get(inboxPath), original);
      assert.equal(f.data.get(statusPath).status, 'waiting');
      assert.equal(f.data.has(C.cursors + '/' + inboxId), false, 'not terminally consumed');
      assert.equal(f.costs.reads - before.reads, attempt === 1 ? 18 : 19);
      assert.equal(f.costs.writes - before.writes, attempt === 1 ? 3 : 2);
      assert.equal(f.queries.length - queries, attempt === 1 ? 1 : 2);
      f.time(at + expected - 1);
      const submitted = f.submissions(), writes = f.costs.writes, reads = f.costs.reads;
      assert.deepEqual(await f.run({preferRetry:true}), {consumed:0});
      assert.equal(f.submissions(), submitted); assert.equal(f.costs.writes, writes);
      assert.equal(f.costs.reads - reads, 3, 'cooling poll is cursor plus two bounded queries');
      f.time(at + expected);
    }
  });

  test(`${kind} capacity recovers during grace, admits once, and clears retry state`, async () => {
    const f = await fixture(kind);
    for (let i=0;i<4;i++) {await f.run(); f.time(f.retry().notBefore);}
    const inbox = structuredClone(f.data.get(inboxPath));
    f.pressure(false); f.time(period.endsAt + 1);
    const result = await f.run();
    assert.equal(result.status, 'waiting'); assert.equal(result.duplicate, false);
    assert.equal(f.retry(), undefined);
    assert.deepEqual(f.data.get(inboxPath), inbox);
    assert.equal(f.data.get(queuePath).admitted, 1);
    assert.equal(f.data.get(queuePath).slots.length, 1);
    assert.equal(f.data.get(C.runs + '/' + result.runId).receivedAt, 2000);
    assert.deepEqual(await f.run(), {consumed:0});
    assert.equal((await f.service.consumeInbox(inbox)).duplicate, true);
    assert.equal(f.data.get(queuePath).admitted, 1);
  });

  test(`${kind} capacity retry is clamped to expiry and terminally rejected there`, async () => {
    const f = await fixture(kind), deadline = period.endsAt + period.graceMs;
    for (let i=0;i<5;i++) {await f.run(); f.time(f.retry().notBefore);}
    f.time(deadline - 30000);
    assert.equal((await f.run()).retry, true);
    assert.equal(f.retry().notBefore, deadline);
    const original = structuredClone(f.data.get(inboxPath));
    f.pressure(false); f.time(deadline);
    const result = await f.run();
    assert.equal(result.status, 'inbox_receipt_expired'); assert.equal(result.rejected, true);
    assert.equal(f.retry(), undefined);
    assert.equal(f.data.get(statusPath).status, 'rejected');
    assert.equal(f.data.get(C.cursors + '/' + inboxId).status, 'inbox_receipt_expired');
    assert.equal(f.data.get(queuePath).admitted, 0);
    assert.deepEqual(f.data.get(inboxPath), original);
    assert.deepEqual(await f.run(), {consumed:0});
  });
}

test('one hour of minute-by-minute polling bounds admission work without removing queued receipts', async () => {
  const f = await fixture(), start = f.now(), original = structuredClone(f.data.get(inboxPath));
  const attemptedMinutes = [];
  for (let minute=0;minute<60;minute++) {
    f.time(start + minute*60000);
    if ((await f.run()).consumed) attemptedMinutes.push(minute);
  }
  assert.deepEqual(attemptedMinutes, [0,1,3,7,15,30,45]);
  // Fixed-one-minute policy: first intake 19R/3W, then 59 due retries at 21R/2W.
  assert.deepEqual(f.costs, {reads:291, writes:15});
  assert.equal(304 - f.costs.reads, 13, 'Release 225 used the same delays but read unused bookkeeping documents');
  assert.equal(19 + 59*21 - f.costs.reads, 967);
  assert.equal(3 + 59*2 - f.costs.writes, 106);
  assert.equal(f.queries.length, 119, 'poll query count is unchanged');
  assert.deepEqual(f.data.get(inboxPath), original);
  assert.equal(f.retry().notBefore, start + 60*60000);
});

for (const retry of [false,true]) {
  test(`${retry ? 'retry' : 'fresh'} successful intake skips only unused bookkeeping reads`, async () => {
    const f = await fixture();
    if (retry) {await f.run(); f.time(f.retry().notBefore);}
    f.pressure(false);
    const scanBefore = structuredClone(f.data.get(C.cursors + '/scan'));
    const queryStart = f.queries.length;
    const result = await f.run({preferRetry:retry});
    assert.equal(result.status, 'waiting'); assert.equal(result.duplicate, false);
    assert.deepEqual(f.transactions.at(-1).reads, retry ? [retryPath] : [C.cursors + '/scan',retryPath]);
    assert.deepEqual(f.queries.slice(queryStart).map(q=>q.from[0].collectionId), [retry ? C.retries : C.inbox]);
    assert.equal(f.data.get(queuePath).admitted, 1);
    assert.equal(f.data.get(queuePath).slots.length, 1);
    assert.equal(f.data.get(C.runs + '/' + result.runId).status, 'waiting', 'intake does not award unverified scores');
    assert.equal(f.data.get(statusPath).attemptId, 'first');
    assert.equal(f.retry(), undefined);
    if (retry) assert.deepEqual(f.data.get(C.cursors + '/scan'), scanBefore, 'retry cannot advance fresh cursor');
    else assert.equal(f.data.get(C.cursors + '/scan').receivedAt.__firestoreTimestamp,
      f.data.get(inboxPath).receivedAt.__firestoreTimestamp);
  });
}

test('retry-priority capacity failure saves the discarded fresh query and unused cursor/receipt reads', async () => {
  const f = await fixture(); await f.run(); f.time(f.retry().notBefore);
  const before = {...f.costs}, queryStart = f.queries.length;
  assert.equal((await f.run({preferRetry:true})).retry, true);
  assert.equal(f.costs.reads-before.reads, 18, 'Release 225 used 21 reads for the same failed retry');
  assert.equal(f.costs.writes-before.writes, 2);
  assert.deepEqual(f.queries.slice(queryStart).map(q=>q.from[0].collectionId), [C.retries]);
  assert.deepEqual(f.transactions.at(-1).reads, [statusPath,retryPath,inboxPath]);
  assert.equal(f.retry().notBefore, f.now()+120000);
  assert.equal(f.data.get(statusPath).status, 'waiting');
});

test('successful retry bookkeeping preserves a concurrently replaced inbox, status and retry', async () => {
  const f = await fixture(); await f.run(); f.time(f.retry().notBefore); f.pressure(false);
  const consume = f.runtime.service.consumeInbox;
  const nextInbox = {...f.data.get(inboxPath), attemptId:'newer', timeMs:10000, frames:10000,
    receivedAt:{__firestoreTimestamp:new Date(f.now()).toISOString()}};
  const nextStatus = {...nextInbox,status:'waiting'}, nextRetry = {...f.retry(),attemptId:'newer',receivedAt:nextInbox.receivedAt};
  f.runtime.service.consumeInbox = async row => {
    const result = await consume(row);
    f.data.set(inboxPath, structuredClone(nextInbox));
    f.data.set(statusPath, structuredClone(nextStatus));
    f.data.set(retryPath, structuredClone(nextRetry));
    return result;
  };
  assert.equal((await f.run({preferRetry:true})).status, 'waiting');
  assert.deepEqual(f.data.get(inboxPath), nextInbox);
  assert.deepEqual(f.data.get(statusPath), nextStatus);
  assert.deepEqual(f.retry(), nextRetry);
  assert.deepEqual(f.transactions.at(-1), {reads:[retryPath],writes:[]});
});

test('legacy or invalid counters restart safely, and oversized counters saturate', async () => {
  for (const attempts of [undefined, -1, 1.5, '8', Number.MAX_SAFE_INTEGER]) {
    const f = await fixture(); await f.run();
    const previous = f.retry();
    if (attempts === undefined) delete previous.attempts; else previous.attempts = attempts;
    f.time(previous.notBefore); const at = f.now(); await f.run();
    assert.equal(f.retry().attempts, attempts === Number.MAX_SAFE_INTEGER ? 16 : 1);
    assert.equal(f.retry().notBefore-at, attempts === Number.MAX_SAFE_INTEGER ? EVENT_INBOX_RETRY_MAX_MS : 60000);
  }
});

test('new attempt or receipt timestamp resets backoff rather than inheriting an older delay', async () => {
  for (const newAttempt of [false, true]) {
    const f = await fixture();
    for (let i=0;i<5;i++) {await f.run(); f.time(f.retry().notBefore);}
    const inbox = f.data.get(inboxPath);
    inbox.receivedAt = {__firestoreTimestamp:new Date(f.now()).toISOString()};
    if (newAttempt) inbox.attemptId = 'replacement';
    await f.run();
    assert.equal(f.retry().attempts, 1); assert.equal(f.retry().notBefore, f.now()+60000);
    assert.equal(f.retry().attemptId, inbox.attemptId);
  }
});

test('replacement during failed admission is not overwritten or marked rejected', async () => {
  const f = await fixture(); await f.run(); f.time(f.retry().notBefore);
  const consume = f.runtime.service.consumeInbox;
  f.runtime.service.consumeInbox = async row => {
    try {return await consume(row);} finally {
      f.data.set(inboxPath, {...row, attemptId:'replacement',
        receivedAt:{__firestoreTimestamp:new Date(f.now()).toISOString()}});
    }
  };
  await f.run();
  assert.equal(f.retry(), undefined);
  assert.equal(f.data.get(inboxPath).attemptId, 'replacement');
  assert.equal(f.data.get(statusPath).status, 'waiting');
  f.runtime.service.consumeInbox = consume;
  await f.run(); assert.equal(f.retry().attemptId, 'replacement'); assert.equal(f.retry().attempts, 1);
});

test('missing inbox cleans up retry without recreating work', async () => {
  const f = await fixture(); await f.run(); f.time(f.retry().notBefore);
  f.data.delete(inboxPath);
  assert.deepEqual(await f.run(), {consumed:1, rejected:true});
  assert.equal(f.retry(), undefined); assert.equal(f.submissions(), 1);
});

test('parent existenceOnly preflight still stops at closing period without scanning queues', async () => {
  const f = await fixture(); f.time(period.endsAt + period.graceMs);
  assert.deepEqual(await eventWork(f.runtime, {existenceOnly:true}),
    {hasWork:true, periodIds:[], inbox:false, archiveId:period.id});
  assert.deepEqual(f.gets, ['/' + C.catalog + '/main']); assert.equal(f.queries.length, 0);
});
