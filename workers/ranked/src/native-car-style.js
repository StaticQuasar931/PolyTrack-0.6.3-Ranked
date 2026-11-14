// Native CarStyle v0 wire contract. No renderer, physics or recording changes.
export const NATIVE_STYLE_FIELDS = Object.freeze(['pattern', 'rims', 'exhaust',
  'primaryHex', 'secondaryHex', 'frameHex', 'rimsHex']);
const limits = [15, 11, 7, 0xffffff, 0xffffff, 0xffffff, 0xffffff];
export function encodeNativeCarStyle(style) {
  if (!style || Object.keys(style).length !== NATIVE_STYLE_FIELDS.length ||
      Object.keys(style).some(key => !NATIVE_STYLE_FIELDS.includes(key))) throw Error('invalid_native_style');
  const values = NATIVE_STYLE_FIELDS.map((key, index) => {
    const value = style[key];
    if (!Number.isSafeInteger(value) || value < 0 || value > limits[index]) throw Error('invalid_native_style');
    return value;
  });
  const bytes = new Uint8Array(16);
  bytes.set(values.slice(0, 3), 1);
  for (let index = 3; index < values.length; index++) {
    const offset = 4 + (index - 3) * 3, value = values[index];
    bytes.set([value & 255, (value >> 8) & 255, (value >> 16) & 255], offset);
  }
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
export function decodeNativeCarStyle(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(value)) throw Error('invalid_native_style');
  const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '=='), char => char.charCodeAt(0));
  if (bytes.length !== 16 || bytes[0] !== 0) throw Error('invalid_native_style');
  const values = [...bytes.slice(1, 4)];
  for (let offset = 4; offset < 16; offset += 3) values.push(bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16);
  const style = Object.fromEntries(NATIVE_STYLE_FIELDS.map((key, index) => [key, values[index]]));
  if (encodeNativeCarStyle(style) !== value) throw Error('invalid_native_style');
  return style;
}
