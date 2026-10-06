const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.join(__dirname, '../polytrack_062_patch.js'), 'utf8');
const start = source.indexOf('  function withTimeout(');
const end = source.indexOf('  async function expandRankedResults(', start);
assert.ok(start >= 0 && end > start);

function makeContext() {
  const timers = new Map();
  const cleared = [];
  let nextId = 0;
  const context = {
    Promise,
    setTimeout(callback, delay) {
      const id = ++nextId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      cleared.push(id);
      timers.delete(id);
    }
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return { context, timers, cleared };
}

test('withTimeout clears its deadline after the request settles first', async () => {
  const { context, timers, cleared } = makeContext();
  assert.equal(await context.withTimeout(Promise.resolve('ready'), 5000, 'late'), 'ready');
  assert.equal(timers.size, 0);
  assert.deepEqual(cleared, [1]);
});

test('withTimeout clears its deadline after the deadline rejects', async () => {
  const { context, timers, cleared } = makeContext();
  const result = context.withTimeout(new Promise(() => {}), 5000, 'deadline');
  timers.get(1).callback();
  await assert.rejects(result, /deadline/);
  assert.equal(timers.size, 0);
  assert.deepEqual(cleared, [1]);
});
