import test from 'node:test';
import assert from 'node:assert/strict';
import {finishOrdinal} from './finish-presentation.mjs';

test('finish positions use readable ordinals across complete hundred boundaries', () => {
  const endings = ['th', 'st', 'nd', 'rd', 'th', 'th', 'th', 'th', 'th', 'th'];
  for (let rank = 1; rank <= 323; rank++) {
    const remainder = rank % 100;
    const suffix = [11, 12, 13].includes(remainder) ? 'th' : endings[rank % 10];
    assert.deepEqual(finishOrdinal(rank), {
      number: String(rank), suffix, label: `${rank}${suffix} place`,
    }, `rank ${rank}`);
  }
});

test('large safe finish positions retain every digit without exponent notation', () => {
  for (const [rank, suffix] of [[1003, 'rd'], [10011, 'th'], [1000001, 'st'], [Number.MAX_SAFE_INTEGER, 'st']]) {
    assert.deepEqual(finishOrdinal(rank), {
      number: String(rank), suffix, label: `${rank}${suffix} place`,
    });
  }
});

test('invalid finish positions are rejected without coercion or exceptions', () => {
  for (const value of [
    0, -0, -1, 1.1, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1,
    '3', '', '3rd', null, undefined, true, false, {}, [], [3], 3n, Symbol('rank'),
  ]) {
    assert.equal(finishOrdinal(value), null, `invalid value: ${String(value)}`);
  }
});
