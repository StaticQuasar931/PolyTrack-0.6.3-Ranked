import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {encodeNativeCarStyle, decodeNativeCarStyle} from '../src/native-car-style.js';
import {SHOP_CATALOG} from '../src/currency-wallet.js';

test('all proposed preset fields round trip against the actual native CarStyle class', () => {
  const source = fs.readFileSync(new URL('../../../main.bundle.js', import.meta.url), 'utf8');
  const start = source.indexOf('8724:(e,t,n)=>{'), end = source.indexOf('},8734:', start);
  assert.ok(start > 0 && end > start);
  const exports = {};
  const require = id => {
    if (id === 1635) return {gn: (object, map) => map.get(object), GG: (object, map, value) => map.set(object, value)};
    if (id === 4922) return {};
    if (id === 6551) return {l: bytes => Buffer.from(bytes).toString('base64url'),
      D: text => new Uint8Array(Buffer.from(text, 'base64url'))};
    throw Error('Unexpected native dependency ' + id);
  };
  require.d = (target, getters) => Object.defineProperties(target,
    Object.fromEntries(Object.entries(getters).map(([key, get]) => [key, {get}])));
  const factory = vm.runInNewContext('(' + source.slice(start + '8724:'.length, end + 1) + ')');
  factory({}, exports, require);
  const NativeStyle = exports.A;
  assert.equal(NativeStyle.patterns.length, 16); assert.equal(NativeStyle.rims.length, 12);
  assert.equal(NativeStyle.exhausts.length, 8); assert.equal(NativeStyle.binaryLength, 16);
  for (const item of SHOP_CATALOG) {
    const wire = encodeNativeCarStyle(item.style), decoded = NativeStyle.deserializeSafe(wire);
    assert.equal(decoded.serialize(), wire);
    for (const [field, value] of Object.entries(item.style)) assert.equal(decoded[field], value);
    assert.deepEqual(decodeNativeCarStyle(wire), item.style);
  }
});

test('codec rejects non-native fields, invalid enum/color values and noncanonical wire values', () => {
  const style = SHOP_CATALOG[0].style;
  for (const change of [{pattern: 16}, {rims: 12}, {exhaust: 8}, {primaryHex: -1}, {rimsHex: 0x1000000},
    {pattern: 0.5}, {decal: 'custom'}, {qualityTier: 'high'}, {accessory: 'hat'}]) {
    assert.throws(() => encodeNativeCarStyle({...style, ...change}), /invalid_native_style/);
  }
  for (const wire of ['', 'invalid', encodeNativeCarStyle(style) + '=', '______________________']) {
    assert.throws(() => decodeNativeCarStyle(wire), /invalid_native_style/);
  }
});
