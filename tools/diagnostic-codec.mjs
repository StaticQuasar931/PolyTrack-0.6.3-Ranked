// Local JSON packing, not encryption. Apply privacy filtering before encoding.
export const COMPACT_SCHEMA = 'polytrack-developer-diagnostics-compact';
export const CODEC_LIMITS = Object.freeze({inputBytes: 8 * 1024 * 1024, outputBytes: 16 * 1024 * 1024, nodes: 200000, depth: 64, dictionary: 50000, shapes: 10000});
const utf8 = new TextEncoder();
const bytes = text => utf8.encode(text).length;
const fail = message => { throw new Error('Diagnostics codec: ' + message); };
function limits(options = {}) {
 const result = {...CODEC_LIMITS};
 for (const key of Object.keys(options)) {
  if (!Object.hasOwn(result, key) || !Number.isSafeInteger(options[key]) || options[key] < 1 || options[key] > result[key]) fail('invalid limit');
  result[key] = options[key];
 }
 return result;
}
function budget(cap) {
 let nodes = 0, size = 0;
 return {visit(depth) { if (++nodes > cap.nodes || depth > cap.depth) fail('node/depth limit exceeded'); },
  add(n) { if ((size += n) > cap.outputBytes) fail('output limit exceeded'); }};
}
const primitive = value => value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0));
const jsonSize = value => bytes(JSON.stringify(value));
const define = (target, key, value) => Object.defineProperty(target, key, {value, enumerable: true, writable: true, configurable: true});

// Tags: [0,string index], [1,shape index,...field values], [2,...array values], [3] negative zero.
// Shapes retain ordered keys; dictionary references never point to other nodes.
export function encodeDiagnosticReport(report, options) {
 const cap = limits(options), meter = budget(cap), strings = [], shapes = [];
 const stringIds = new Map(), shapeIds = new Map(), ancestors = new Set();
 const intern = value => {
  if (!stringIds.has(value)) {
   if (strings.length >= cap.dictionary) fail('dictionary limit exceeded');
   stringIds.set(value, strings.length); strings.push(value);
  }
  return stringIds.get(value);
 };
 function pack(value, depth) {
  meter.visit(depth);
  if (Object.is(value, -0)) { meter.add(1); return [3]; }
  if (primitive(value)) { meter.add(jsonSize(value)); return value; }
  if (typeof value === 'string') { meter.add(jsonSize(value)); return [0, intern(value)]; }
  if (!value || typeof value !== 'object' || ancestors.has(value)) fail('expected acyclic JSON data');
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
   meter.add(2 + Math.max(0, value.length - 1));
   result = [2];
   for (let i = 0; i < value.length; i++) {
    if (!Object.hasOwn(value, i)) fail('sparse array');
    result.push(pack(value[i], depth + 1));
   }
  } else {
   if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('expected plain JSON object');
   const keys = Object.keys(value), fields = [];
   meter.add(2 + Math.max(0, keys.length - 1));
   for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!Object.hasOwn(descriptor, 'value')) fail('accessor is not JSON data');
    meter.add(jsonSize(key) + 1); fields.push(intern(key));
   }
   const signature = JSON.stringify(fields);
   if (!shapeIds.has(signature)) {
    if (shapes.length >= cap.shapes) fail('shape limit exceeded');
    shapeIds.set(signature, shapes.length); shapes.push(fields);
   }
   result = [1, shapeIds.get(signature)];
   for (const key of keys) result.push(pack(value[key], depth + 1));
  }
  ancestors.delete(value);
  return result;
 }
 const data = pack(report, 0);
 const text = JSON.stringify({schema: COMPACT_SCHEMA, version: 1, strings, shapes, data});
 if (bytes(text) > cap.inputBytes) fail('input limit exceeded');
 return text;
}

export function decodeDiagnosticReport(text, options) {
 const cap = limits(options);
 if (typeof text !== 'string' || text.length > cap.inputBytes || bytes(text) > cap.inputBytes) fail('input limit exceeded');
 let wire;
 try { wire = JSON.parse(text); } catch { fail('invalid JSON'); }
 const meter = budget(cap);
 if (wire?.schema !== COMPACT_SCHEMA) {
  if (wire?.schema !== 'polytrack-developer-diagnostics-v1') fail('unknown schema');
  // Legacy input uses the same resource budget, without rebuilding or sanitizing it.
  function validate(value, depth) {
   meter.visit(depth);
   if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) fail('invalid number');
    meter.add(jsonSize(value)); return;
   }
   const entries = Object.entries(value);
   meter.add(2 + Math.max(0, entries.length - 1));
   for (const [key, item] of entries) {
    if (!Array.isArray(value)) meter.add(jsonSize(key) + 1);
    validate(item, depth + 1);
   }
  }
  validate(wire, 0); return wire;
 }
 if (wire.version !== 1) fail('unsupported version');
 if (Object.keys(wire).sort().join(',') !== 'data,schema,shapes,strings,version') fail('invalid envelope');
 const {strings, shapes, data} = wire;
 if (!Array.isArray(strings) || strings.length > cap.dictionary || !strings.every(value => typeof value === 'string')) fail('invalid dictionary');
 if (!Array.isArray(shapes) || shapes.length > cap.shapes) fail('invalid shapes');
 const index = value => Number.isSafeInteger(value) && value >= 0 && value < strings.length;
 const stringSizes = strings.map(jsonSize);
 for (const shape of shapes) {
  if (!Array.isArray(shape) || shape.length > cap.nodes || !shape.every(index) || new Set(shape.map(i => strings[i])).size !== shape.length) fail('invalid shape keys');
 }
 function unpack(value, depth) {
  meter.visit(depth);
  if (primitive(value)) { meter.add(jsonSize(value)); return value; }
  if (!Array.isArray(value)) fail('invalid node');
  if (value[0] === 3 && value.length === 1) { meter.add(1); return -0; }
  if (value[0] === 0) {
   if (value.length !== 2 || !index(value[1])) fail('invalid string reference');
   meter.add(stringSizes[value[1]]); return strings[value[1]];
  }
  if (value[0] === 2) {
   meter.add(2 + Math.max(0, value.length - 2));
   const result = [];
   for (let i = 1; i < value.length; i++) result.push(unpack(value[i], depth + 1));
   return result;
  }
  if (value[0] === 1) {
   const shape = Number.isSafeInteger(value[1]) && value[1] >= 0 ? shapes[value[1]] : null;
   if (!shape || value.length !== shape.length + 2) fail('invalid object reference/arity');
   meter.add(2 + Math.max(0, shape.length - 1));
   const result = {};
   for (let i = 0; i < shape.length; i++) {
    meter.add(stringSizes[shape[i]] + 1);
    define(result, strings[shape[i]], unpack(value[i + 2], depth + 1));
   }
   return result;
  }
  fail('unknown node tag');
 }
 return unpack(data, 0);
}

export function serializeDiagnosticReport(report, {format = 'compact', limits: cap} = {}) {
 if (format === 'compact') return encodeDiagnosticReport(report, cap);
 if (format !== 'json') fail('unknown format');
 // Validate the same data domain and limits even when packing is not requested.
 encodeDiagnosticReport(report, cap);
 const text = JSON.stringify(report);
 if (bytes(text) > limits(cap).inputBytes) fail('input limit exceeded');
 return text;
}
