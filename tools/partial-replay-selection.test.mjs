import test from 'node:test';
import assert from 'node:assert/strict';
import {createPartialReplaySelection} from './partial-replay-selection.mjs';

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return {resolve, promise}; };
const rows = () => [1, 2, 3].map(recordingId => ({recordingId, nickname: 'Racer ' + recordingId, isSelf: recordingId === 3}));
function fixture(options = {}) {
  let selected = options.rows || rows(), account = 'account', track = 'track', revision = 1, live = true, clock = 0, calls = 0, prompts = 0, launches = 0;
  const reads = [], validations = [], writes = [], messages = [];
  const selection = {trackId: () => track, accountId: () => account, get: () => selected.map(row => ({...row})), set(value) { writes.push(value); selected = value; }};
  const api = createPartialReplaySelection({
    readRecordings: async (ids, context) => { calls++; reads.push({ids, context}); return options.read ? options.read(ids) : ids.map(id => id === 2 ? null : {recording: 'recording-' + id, frames: id * 100}); },
    validateRecording: async (payload, row, context) => { validations.push({payload, row, context}); return options.validate ? options.validate(payload, row) : true; },
    confirm: async data => { prompts++; return options.confirm ? options.confirm(data) : true; },
    status: (message, error) => messages.push({message, error}), now: () => clock, timeoutMs: options.timeoutMs || 200
  });
  const run = (mode = 'play') => { const version = revision; return api.run({selection, revision: version, isCurrent: () => live && revision === version, mode, invokeNative: () => { launches++; }}); };
  return {api, run, reads, validations, writes, messages, get selected() { return selected; }, get calls() { return calls; }, get prompts() { return prompts; }, get launches() { return launches; },
    reset: () => { selected = rows(); }, clock: value => { clock = value; }, change: what => {
      if (what === 'account') account += '2'; else if (what === 'track') track += '2'; else if (what === 'revision') revision++;
      else if (what === 'selection') selected[0] = {...selected[0], nickname: 'Changed'}; else if (what === 'navigation') live = false; else api.invalidate();
    }};
}

test('mixed results wait for explicit consent, preserve positional names and self flag', async () => {
  const answer = deferred(); let offered;
  const f = fixture({confirm: value => { offered = value; return answer.promise; }});
  const run = f.run();
  while (!offered) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.launches, 0); assert.equal(f.writes.length, 0);
  assert.deepEqual(offered.ready.map(item => item.row.recordingId), [1, 3]);
  assert.deepEqual(offered.failed.map(item => item.row.recordingId), [2]);
  answer.resolve(true); assert.equal(await run, 'launched');
  assert.deepEqual(f.selected, [rows()[0], rows()[2]]); assert.equal(f.launches, 1);
  assert.deepEqual(f.validations.map(({payload, row}) => [payload.frames, row.nickname]), [[100, 'Racer 1'], [300, 'Racer 3'], [100, 'Racer 1'], [300, 'Racer 3']]);
});
test('cancel is not consent, leaves selection untouched, and cached failures are not re-read', async () => {
  const f = fixture({confirm: () => false});
  assert.equal(await f.run(), 'declined'); assert.equal(await f.run(), 'declined');
  assert.equal(f.calls, 1); assert.equal(f.prompts, 2); assert.deepEqual(f.selected, rows()); assert.equal(f.launches, 0);
  assert.equal(f.validations.length, 4, 'cache hits still validate live playback eligibility');
});
test('all failed never offers Continue, never empties selection, never launches or retries immediately', async () => {
  const f = fixture({read: ids => ids.map(() => null)});
  for (let i = 0; i < 3; i++) assert.equal(await f.run(), 'all-failed');
  assert.equal(f.prompts, 0); assert.equal(f.calls, 1); assert.equal(f.launches, 0); assert.deepEqual(f.selected, rows());
  assert.match(f.messages.at(-1).message, /No selected replay/);
});
test('validation rejection and false validation are failures, not a bypass', async () => {
  for (const validate of [() => { throw Error('engine mismatch'); }, () => false, () => undefined]) {
    const f = fixture({read: ids => ids.map(id => ({recording: String(id)})), validate});
    assert.equal(await f.run(), 'all-failed'); assert.equal(await f.run(), 'all-failed');
    assert.equal(f.validations.length, 3); assert.equal(f.calls, 1); assert.equal(f.launches, 0);
  }
});
for (const stage of ['load', 'validate', 'prompt']) for (const change of ['account', 'track', 'revision', 'selection', 'navigation', 'invalidate']) {
  test(`${change} during ${stage} cannot commit or launch`, async () => {
    const gate = deferred(); let entered = false;
    const stop = async value => { entered = true; await gate.promise; return value; };
    const f = fixture({
      read: stage === 'load' ? ids => stop(ids.map(id => id === 2 ? null : {recording: String(id)})) : undefined,
      validate: stage === 'validate' ? () => stop(true) : undefined,
      confirm: stage === 'prompt' ? () => stop(true) : undefined
    });
    const run = f.run(); while (!entered) await new Promise(resolve => setImmediate(resolve));
    f.change(change); gate.resolve(); assert.equal(await run, 'cancelled'); assert.equal(f.writes.length, 0); assert.equal(f.launches, 0);
  });
}
test('account, track, generation cache separation; failures expire only after cooldown', async () => {
  const f = fixture({confirm: () => false}); await f.run(); await f.run(); assert.equal(f.calls, 1);
  for (const change of ['account', 'track', 'revision']) { f.change(change); await f.run(); }
  assert.equal(f.calls, 4); f.clock(60001); await f.run(); assert.equal(f.calls, 5);
});
test('overlapping clicks coalesce reads and only newest request can launch', async () => {
  const gate = deferred(); const f = fixture({read: ids => gate.promise.then(() => ids.map(id => ({recording: String(id)})))});
  const old = f.run(), next = f.run(); gate.resolve();
  assert.equal(await old, 'cancelled'); assert.equal(await next, 'launched'); assert.equal(f.calls, 1); assert.equal(f.launches, 1);
});
test('Watch keeps working groups of three through ten intact, and skips failures only with consent', async () => {
  const mixed = fixture(); assert.equal(await mixed.run('watch'), 'launched'); assert.equal(mixed.selected.length, 2);
  for (const count of [3, 10]) {
    const selected = Array.from({length: count}, (_, i) => ({recordingId: i + 1, nickname: 'Racer ' + i, isSelf: false}));
    const valid = fixture({rows: selected, read: ids => ids.map(id => ({recording: String(id)}))});
    assert.equal(await valid.run('watch'), 'launched'); assert.equal(valid.prompts, 0); assert.equal(valid.launches, 1); assert.equal(valid.writes.length, 0);
    assert.deepEqual(valid.selected, selected);
    assert.equal(await valid.run('play'), 'launched'); assert.equal(valid.calls, 1);
  }
});

test('more than ten selected replays fail before any loading or launch', async () => {
  const f = fixture({rows: Array.from({length: 11}, (_, i) => ({recordingId: i + 1, nickname: 'Racer', isSelf: false}))});
  assert.equal(await f.run('watch'), 'error'); assert.equal(f.calls, 0); assert.equal(f.launches, 0);
});

test('Watch consent is action-specific and a changed engine after consent leaves selection intact', async () => {
  let accepted=false;
  const f=fixture({confirm: options=>{assert.equal(options.mode,'watch');accepted=true;return true;},validate:()=>!accepted});
  assert.equal(await f.run('watch'),'error');
  assert.equal(f.prompts,1);assert.equal(f.launches,0);assert.equal(f.writes.length,0);assert.deepEqual(f.selected,rows());
});

test('Watch Cancel preserves every selected replay, including unavailable ones', async () => {
  const f=fixture({confirm:()=>false});
  assert.equal(await f.run('watch'),'declined');assert.deepEqual(f.selected,rows());
  assert.equal(f.launches,0);assert.equal(f.writes.length,0);
});
test('bad batch shape and rejected requests fail closed and are cached', async () => {
  for (const read of [() => [], () => null, () => { throw Error('offline'); }]) {
    const f = fixture({read}); assert.equal(await f.run(), 'all-failed'); await f.run(); assert.equal(f.calls, 1); assert.equal(f.launches, 0);
  }
});
test('hung reads time out without retry loops or launch', async () => {
  const f = fixture({read: () => new Promise(() => {}), timeoutMs: 10});
  assert.equal(await f.run(), 'all-failed'); assert.equal(await f.run(), 'all-failed'); assert.equal(f.calls, 1);
});
test('reader, validation and chooser are mandatory, and consent must be exactly true', async () => {
  assert.throws(() => createPartialReplaySelection({readRecordings() {}, confirm() {}}));
  const f = fixture({confirm: () => 'yes'}); assert.equal(await f.run(), 'declined'); assert.equal(f.launches, 0);
});
