'use strict';

// Track-map insertion order is not part of the pin; paths and hashes are exact.
function sameHashMap(actual, expected) {
  const map = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!map(actual) || !map(expected)) return false;
  const keys = Object.keys(actual);
  if (keys.length !== Object.keys(expected).length) return false;
  return keys.every(key => Object.hasOwn(expected, key) &&
    typeof actual[key] === 'string' && actual[key].length === 64 && /^[a-f0-9]{64}$/.test(actual[key]) &&
    actual[key] === expected[key]);
}

module.exports = { sameHashMap };
